"use strict";

// Namecheap API wrapper used by the Telegram DOMAIN command.
//
// Namecheap returns XML, not JSON. We hand-roll a tiny attribute extractor
// rather than pulling in a full XML parser — every response we care about is
// flat: a status on <ApiResponse>, an <Errors>/<Error> block on failure, and
// one or more leaf elements (<DomainCheckResult>, <DomainCreateResult>,
// <DomainDNSSetCustomResult>) whose attributes carry the result.
//
// All calls go through the GET endpoint to keep the request shape simple.
// Set the four NAMECHEAP_* env vars (api key/user/username/client ip) plus
// optionally NAMECHEAP_SANDBOX=1 to point at api.sandbox.namecheap.com.
//
// All public functions return a result object `{ ok, ... }` rather than
// throwing on Namecheap-side errors, so the Telegram handler can render
// the failure to Bilguun instead of dropping it into the generic catch.
// Network/transport failures still throw, since those usually mean a
// missing env var or an outright outage and the caller should surface
// them differently.

const NAMECHEAP_PROD_BASE = "https://api.namecheap.com/xml.response";
const NAMECHEAP_SANDBOX_BASE = "https://api.sandbox.namecheap.com/xml.response";
const NAMECHEAP_TIMEOUT_MS = Number(process.env.NAMECHEAP_TIMEOUT_MS) || 20000;

// Vercel's published nameservers. Used by setVercelNameservers so Namecheap
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
  const apiKey   = (process.env.NAMECHEAP_API_KEY   || "").trim();
  const apiUser  = (process.env.NAMECHEAP_API_USER  || "").trim();
  const userName = (process.env.NAMECHEAP_USERNAME  || "").trim() || apiUser;
  const clientIp = (process.env.NAMECHEAP_CLIENT_IP || "").trim();
  const sandbox  = String(process.env.NAMECHEAP_SANDBOX || "").trim() === "1";
  return {
    apiKey, apiUser, userName, clientIp, sandbox,
    base: sandbox ? NAMECHEAP_SANDBOX_BASE : NAMECHEAP_PROD_BASE,
    ok: Boolean(apiKey && apiUser && clientIp)
  };
}

function missingEnvError(cfg) {
  const missing = [];
  if (!cfg.apiKey)   missing.push("NAMECHEAP_API_KEY");
  if (!cfg.apiUser)  missing.push("NAMECHEAP_API_USER");
  if (!cfg.clientIp) missing.push("NAMECHEAP_CLIENT_IP");
  return new Error(`Namecheap env not configured: missing ${missing.join(", ")}`);
}

// Parse a domain string into { sld, tld }. Handles multi-label TLDs poorly
// on purpose — Namecheap also wants the user to supply the suffix list, and
// for our flow Bilguun always types `something.<single-label-tld>`. If the
// input is not a valid `sld.tld`, returns null.
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
async function namecheapFetch(url) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const e = new Error(`fetch timeout after ${NAMECHEAP_TIMEOUT_MS}ms`);
      e.code = "FETCH_TIMEOUT";
      reject(e);
    }, NAMECHEAP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetch(url, {
        method: "GET",
        headers: { "Connection": "close", "Accept": "application/xml" },
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function callNamecheap(command, params = {}) {
  const cfg = envConfig();
  if (!cfg.ok) throw missingEnvError(cfg);
  const search = new URLSearchParams({
    ApiUser: cfg.apiUser,
    ApiKey:  cfg.apiKey,
    UserName: cfg.userName,
    ClientIp: cfg.clientIp,
    Command: command,
    ...params
  });
  const url = `${cfg.base}?${search.toString()}`;
  // Redact the API key from logs — everything else is safe operational
  // metadata that we want when debugging "the bot says taken but the
  // dashboard says available".
  const safeUrl = url.replace(cfg.apiKey, "***");
  const started = Date.now();
  console.log(`[namecheap] -> ${command} url=${safeUrl}`);
  let res;
  try {
    res = await namecheapFetch(url);
  } catch (err) {
    console.error(`[namecheap] <- ${command} fetch failed:`, err?.message || err);
    throw err;
  }
  const xml = await res.text();
  console.log(`[namecheap] <- ${command} status=${res.status} ms=${Date.now() - started} bytes=${xml.length}`);
  if (!res.ok) {
    throw new Error(`Namecheap ${command} HTTP ${res.status}: ${xml.slice(0, 200)}`);
  }
  return xml;
}

// Pull attributes from the first `<Tag attr1="..." attr2="...">` match for
// each occurrence of the tag. Tolerates single or double quotes and arbitrary
// whitespace. Returns an array of attribute maps.
function extractTagAttributes(xml, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, "gi");
  const results = [];
  for (const m of xml.matchAll(re)) {
    const attrs = {};
    const attrRe = /([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const am of m[1].matchAll(attrRe)) {
      attrs[am[1]] = am[2] != null ? am[2] : am[3];
    }
    results.push(attrs);
  }
  return results;
}

function extractApiStatus(xml) {
  const m = xml.match(/<ApiResponse\b[^>]*Status\s*=\s*"([^"]*)"/i);
  return m ? m[1] : "";
}

function extractErrors(xml) {
  const block = xml.match(/<Errors\b[^>]*>([\s\S]*?)<\/Errors>/i);
  if (!block) return [];
  const out = [];
  for (const m of block[1].matchAll(/<Error\b[^>]*?(?:Number\s*=\s*"([^"]*)")?[^>]*>([\s\S]*?)<\/Error>/gi)) {
    out.push({
      number: m[1] || "",
      message: (m[2] || "").trim()
    });
  }
  return out;
}

function namecheapError(xml, fallback) {
  const errs = extractErrors(xml);
  if (errs.length > 0) {
    return errs.map(e => e.number ? `[${e.number}] ${e.message}` : e.message).join("; ");
  }
  return fallback;
}

// availability check for a single domain. Returns:
//   { ok: true, available: bool, premium: bool, premiumPrice: number|null }
//   { ok: false, error }
async function checkDomainAvailability(domain) {
  const parsed = parseDomain(domain);
  if (!parsed) return { ok: false, error: `invalid domain: ${domain}` };
  let xml;
  try {
    xml = await callNamecheap("namecheap.domains.check", { DomainList: parsed.domain });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (extractApiStatus(xml) !== "OK") {
    return { ok: false, error: namecheapError(xml, "Namecheap returned non-OK status") };
  }
  const results = extractTagAttributes(xml, "DomainCheckResult");
  const row = results.find(r => (r.Domain || "").toLowerCase() === parsed.domain);
  if (!row) return { ok: false, error: "Namecheap did not return a DomainCheckResult row" };
  const available = String(row.Available || "").toLowerCase() === "true";
  const premium = String(row.IsPremiumName || "").toLowerCase() === "true";
  const premiumPriceRaw = Number(row.PremiumRegistrationPrice);
  return {
    ok: true,
    domain: parsed.domain,
    available,
    premium,
    premiumPrice: Number.isFinite(premiumPriceRaw) && premiumPriceRaw > 0 ? premiumPriceRaw : null
  };
}

// Bulk check up to 50 domains (Namecheap's limit) in one call. Returns
//   { ok: true, results: [{ domain, available, premium, premiumPrice }] }
async function checkBulkAvailability(domains) {
  const cleaned = [];
  for (const raw of domains) {
    const p = parseDomain(raw);
    if (p) cleaned.push(p.domain);
  }
  if (cleaned.length === 0) return { ok: true, results: [] };
  const list = cleaned.slice(0, 50).join(",");
  let xml;
  try {
    xml = await callNamecheap("namecheap.domains.check", { DomainList: list });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (extractApiStatus(xml) !== "OK") {
    return { ok: false, error: namecheapError(xml, "Namecheap returned non-OK status") };
  }
  const rows = extractTagAttributes(xml, "DomainCheckResult");
  const results = rows.map(r => {
    const premiumPriceRaw = Number(r.PremiumRegistrationPrice);
    return {
      domain: (r.Domain || "").toLowerCase(),
      available: String(r.Available || "").toLowerCase() === "true",
      premium: String(r.IsPremiumName || "").toLowerCase() === "true",
      premiumPrice: Number.isFinite(premiumPriceRaw) && premiumPriceRaw > 0 ? premiumPriceRaw : null
    };
  });
  return { ok: true, results };
}

// Generate up to N candidate alternatives and bulk-check them. Returns the
// available subset.
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
  const checked = await checkBulkAvailability(list);
  if (!checked.ok) return checked;
  const available = checked.results.filter(r => r.available);
  return { ok: true, candidates: list, available };
}

// Purchase a domain on Namecheap. Registrant info is required by ICANN; we
// pull it from NAMECHEAP_REGISTRANT_* env vars (or NAMECHEAP_DEFAULT_* as a
// fallback) — the four lines configured once for Bilguun's account, reused
// on every purchase. On success returns
//   { ok: true, domain, transactionId, orderId, chargedAmount }
async function purchaseDomain(domain, { years = 1, registrant } = {}) {
  const parsed = parseDomain(domain);
  if (!parsed) return { ok: false, error: `invalid domain: ${domain}` };

  const reg = registrant || defaultRegistrant();
  const missing = ["FirstName", "LastName", "Address1", "City", "StateProvince", "PostalCode", "Country", "Phone", "EmailAddress"]
    .filter(k => !reg[k]);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing registrant fields (set NAMECHEAP_REGISTRANT_${missing.join("/")}): ${missing.join(", ")}`
    };
  }

  // Namecheap requires the same contact info for Registrant, Tech, Admin,
  // and AuxBilling. Build the param block once and spread it under every
  // prefix.
  const params = { DomainName: parsed.domain, Years: String(years) };
  for (const role of ["Registrant", "Tech", "Admin", "AuxBilling"]) {
    for (const [k, v] of Object.entries(reg)) {
      if (v) params[`${role}${k}`] = v;
    }
  }

  let xml;
  try {
    xml = await callNamecheap("namecheap.domains.create", params);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (extractApiStatus(xml) !== "OK") {
    return { ok: false, error: namecheapError(xml, "Namecheap returned non-OK status") };
  }
  const rows = extractTagAttributes(xml, "DomainCreateResult");
  const row = rows.find(r => (r.Domain || "").toLowerCase() === parsed.domain) || rows[0];
  if (!row) return { ok: false, error: "Namecheap did not return a DomainCreateResult row" };
  if (String(row.Registered || "").toLowerCase() !== "true") {
    return { ok: false, error: `Namecheap reported Registered=${row.Registered || "?"}` };
  }
  return {
    ok: true,
    domain: parsed.domain,
    transactionId: row.TransactionID || null,
    orderId: row.OrderID || null,
    chargedAmount: Number(row.ChargedAmount) || null
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
  let xml;
  try {
    xml = await callNamecheap("namecheap.domains.dns.setCustom", {
      SLD: parsed.sld,
      TLD: parsed.tld,
      Nameservers: nameservers.join(",")
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (extractApiStatus(xml) !== "OK") {
    return { ok: false, error: namecheapError(xml, "Namecheap returned non-OK status") };
  }
  const rows = extractTagAttributes(xml, "DomainDNSSetCustomResult");
  const row = rows[0] || {};
  if (String(row.Update || "").toLowerCase() !== "true") {
    return { ok: false, error: `Namecheap reported Update=${row.Update || "?"}` };
  }
  return { ok: true, domain: parsed.domain, nameservers };
}

function defaultRegistrant() {
  const pick = (name) => {
    return (
      process.env[`NAMECHEAP_REGISTRANT_${name.toUpperCase()}`] ||
      process.env[`NAMECHEAP_DEFAULT_${name.toUpperCase()}`] ||
      ""
    ).trim();
  };
  return {
    FirstName:     pick("FirstName"),
    LastName:      pick("LastName"),
    Address1:      pick("Address1"),
    Address2:      pick("Address2"),
    City:          pick("City"),
    StateProvince: pick("StateProvince"),
    PostalCode:    pick("PostalCode"),
    Country:       pick("Country"),
    Phone:         pick("Phone"),
    EmailAddress:  pick("EmailAddress"),
    OrganizationName: pick("OrganizationName")
  };
}

module.exports = {
  parseDomain,
  envConfig,
  checkDomainAvailability,
  checkBulkAvailability,
  suggestAlternatives,
  purchaseDomain,
  setCustomNameservers,
  VERCEL_NS
};
