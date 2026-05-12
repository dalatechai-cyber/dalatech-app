"use strict";

// Porkbun API wrapper used by the Telegram DOMAIN command.
//
// Every Porkbun call is a POST against https://api.porkbun.com/api/json/v3
// with `apikey` + `secretapikey` in the JSON body. Endpoints used:
//   POST /domain/checkAndCreateCart/{domain}   availability + price check
//   POST /domain/create                        register a new domain
//   POST /domain/updateNs/{domain}             set nameservers
//
// All public functions return a result object `{ ok, ... }` rather than
// throwing on Porkbun-side errors, so the Telegram handler can render the
// failure to Bilguun instead of dropping it into the generic catch.
// Network/transport failures still throw, since those usually mean a
// missing env var or an outright outage and the caller should surface
// them differently.

const PORKBUN_BASE = "https://api.porkbun.com/api/json/v3";
const PORKBUN_TIMEOUT_MS = Number(process.env.PORKBUN_TIMEOUT_MS) || 20000;

// Vercel's published nameservers. Used by setCustomNameservers so Porkbun
// hands DNS control to Vercel after a purchase, which makes domain + cert
// activation automatic once propagation finishes.
const VERCEL_NS = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];

// Standard alternative TLDs we offer when the requested name is taken. Order
// matters: cheapest first. The .mn entries cover Bilguun's primary market;
// the rest are common safe fallbacks.
const ALT_TLDS = ["com", "net", "co", "online", "site", "center", "shop", "biz"];

// Suffixes appended to the SLD before checking common alts (so "gsauto"
// also tries "gsautocenter", "gsautoshop", etc.).
const ALT_SLD_SUFFIXES = ["center", "shop", "store", "mn", "online", "app"];

function envConfig() {
  const apiKey    = (process.env.PORKBUN_API_KEY    || "").trim();
  const secretKey = (process.env.PORKBUN_SECRET_KEY || "").trim();
  return {
    apiKey,
    secretKey,
    base: PORKBUN_BASE,
    ok: Boolean(apiKey && secretKey)
  };
}

function missingEnvError(cfg) {
  const missing = [];
  if (!cfg.apiKey)    missing.push("PORKBUN_API_KEY");
  if (!cfg.secretKey) missing.push("PORKBUN_SECRET_KEY");
  return new Error(`Porkbun env not configured: missing ${missing.join(", ")}`);
}

// Parse a domain string into { sld, tld }. Same shape as the previous
// Namecheap wrapper for symmetry with the rest of the codebase.
function parseDomain(raw) {
  const domain = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/i.test(domain)) {
    return null;
  }
  const idx = domain.indexOf(".");
  return {
    domain,
    sld: domain.slice(0, idx),
    tld: domain.slice(idx + 1)
  };
}

// Native fetch in Node 18+ does not time out by default. Same wrapper
// pattern lib/leads.js + lib/telegram.js use.
async function porkbunFetch(url, init) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const e = new Error(`fetch timeout after ${PORKBUN_TIMEOUT_MS}ms`);
      e.code = "FETCH_TIMEOUT";
      reject(e);
    }, PORKBUN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Make a Porkbun POST. Returns
//   { ok: true, data }                — Porkbun status === SUCCESS
//   { ok: false, status, message }    — Porkbun status === ERROR
// Both shapes mean the HTTP call landed; transport failures throw.
async function callPorkbun(path, body = {}) {
  const cfg = envConfig();
  if (!cfg.ok) throw missingEnvError(cfg);
  const url = `${cfg.base}${path}`;
  const payload = {
    apikey: cfg.apiKey,
    secretapikey: cfg.secretKey,
    ...body
  };
  const started = Date.now();
  console.log(`[porkbun] -> POST ${path}`);
  let res;
  try {
    res = await porkbunFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Connection": "close"
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error(`[porkbun] <- POST ${path} fetch failed:`, err?.message || err);
    throw err;
  }
  let json = null;
  try { json = await res.json(); } catch {}
  console.log(`[porkbun] <- POST ${path} http=${res.status} status=${json?.status || "?"} ms=${Date.now() - started}`);
  if (!res.ok && !json) {
    throw new Error(`Porkbun ${path} HTTP ${res.status}`);
  }
  const status = String(json?.status || "").toUpperCase();
  if (status === "SUCCESS") {
    return { ok: true, data: json };
  }
  return {
    ok: false,
    status: status || `HTTP_${res.status}`,
    message: json?.message || `Porkbun ${path} returned non-success`
  };
}

// Porkbun returns status=ERROR with a message string for "domain
// unavailable" responses (same channel as transport errors). Map the
// common unavailable phrasings to a clean availability=false signal so
// the caller can distinguish "taken" from "Porkbun is down".
function isUnavailableMessage(message) {
  return /not available|unavailable|already registered|already (?:taken|owned)|in use|registered/i
    .test(String(message || ""));
}

// availability check for a single domain. Returns:
//   { ok: true, domain, available, premium, premiumPrice }
//   { ok: false, error }
async function checkDomainAvailability(domain) {
  const parsed = parseDomain(domain);
  if (!parsed) return { ok: false, error: `invalid domain: ${domain}` };
  let result;
  try {
    result = await callPorkbun(`/domain/checkAndCreateCart/${encodeURIComponent(parsed.domain)}`);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (!result.ok) {
    if (isUnavailableMessage(result.message)) {
      return {
        ok: true,
        domain: parsed.domain,
        available: false,
        premium: false,
        premiumPrice: null
      };
    }
    return { ok: false, error: result.message };
  }
  // Porkbun's checkAndCreateCart returns assorted shapes depending on
  // the TLD. We accept fields at the top level OR nested under `regular`
  // / `additional`. `type === "PREMIUM"` (top or nested) flags a premium
  // SKU; otherwise it's standard.
  const d = result.data || {};
  const type = String(d.type || d.additional?.type || d.regular?.type || "").toUpperCase();
  const premium = type === "PREMIUM";
  const rawPrice =
    d.price ??
    d.regular?.price ??
    d.additional?.price ??
    null;
  const priceNum = Number(rawPrice);
  // Porkbun answers checkAndCreateCart with SUCCESS only for available
  // domains; unavailable ones come back as ERROR (handled above). If an
  // `avail` flag is present we still honour it as a safety belt.
  const explicitAvail = String(d.avail || "").toLowerCase();
  const available = explicitAvail ? explicitAvail === "yes" : true;
  return {
    ok: true,
    domain: parsed.domain,
    available,
    premium,
    premiumPrice: premium && Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null
  };
}

// Generate up to N candidate alternatives and check each one. Porkbun has
// no bulk endpoint, so we fan out concurrently and tolerate per-candidate
// failures (a single transport error must not poison the whole list).
async function suggestAlternatives(domain, { limit = 8 } = {}) {
  const parsed = parseDomain(domain);
  if (!parsed) return { ok: false, error: `invalid domain: ${domain}` };
  const candidates = new Set();
  for (const tld of ALT_TLDS) {
    if (tld === parsed.tld) continue;
    candidates.add(`${parsed.sld}.${tld}`);
    if (candidates.size >= limit) break;
  }
  for (const suffix of ALT_SLD_SUFFIXES) {
    if (parsed.sld.endsWith(suffix)) continue;
    candidates.add(`${parsed.sld}${suffix}.${parsed.tld}`);
    if (candidates.size >= limit) break;
  }
  const list = [...candidates].slice(0, limit);
  const settled = await Promise.all(
    list.map(c => checkDomainAvailability(c).catch(err => ({
      ok: false,
      error: err?.message || String(err),
      domain: c
    })))
  );
  const available = settled
    .filter(r => r.ok && r.available)
    .map(r => ({ domain: r.domain, premium: r.premium, premiumPrice: r.premiumPrice }));
  return { ok: true, candidates: list, available };
}

// Purchase a domain on Porkbun. Porkbun uses account-level WHOIS contacts,
// so no per-request registrant block is required — the API call is just
// `{ apikey, secretapikey, domain, years }`. On success returns
//   { ok: true, domain, transactionId, orderId, chargedAmount }
// Transaction/order/charged fields are best-effort: Porkbun's create
// response sometimes only carries `{ status: "SUCCESS" }`, so callers
// must tolerate nulls.
async function purchaseDomain(domain, { years = 1 } = {}) {
  const parsed = parseDomain(domain);
  if (!parsed) return { ok: false, error: `invalid domain: ${domain}` };

  let result;
  try {
    result = await callPorkbun("/domain/create", {
      domain: parsed.domain,
      years: Number(years) || 1
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (!result.ok) {
    return { ok: false, error: result.message };
  }
  const d = result.data || {};
  const priceNum = Number(d.price ?? d.charged ?? d.amount);
  return {
    ok: true,
    domain: parsed.domain,
    transactionId: d.transactionId || d.transactionID || d.id || null,
    orderId: d.orderId || d.orderID || d.id || null,
    chargedAmount: Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null
  };
}

// Set custom nameservers on an existing domain. Used after purchase to hand
// DNS control to Vercel.
async function setCustomNameservers(domain, nameservers = VERCEL_NS) {
  const parsed = parseDomain(domain);
  if (!parsed) return { ok: false, error: `invalid domain: ${domain}` };
  if (!Array.isArray(nameservers) || nameservers.length === 0) {
    return { ok: false, error: "nameservers must be a non-empty array" };
  }
  let result;
  try {
    result = await callPorkbun(`/domain/updateNs/${encodeURIComponent(parsed.domain)}`, {
      ns: nameservers
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (!result.ok) {
    return { ok: false, error: result.message };
  }
  return { ok: true, domain: parsed.domain, nameservers };
}

module.exports = {
  parseDomain,
  envConfig,
  checkDomainAvailability,
  suggestAlternatives,
  purchaseDomain,
  setCustomNameservers,
  VERCEL_NS
};
