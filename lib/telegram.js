"use strict";

function truncate(s, n) {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + "…";
}

// Render the message Bilguun sees once a production preview is live.
// Spells out APPROVE / CHANGE so he never has to remember the syntax.
// Shared between the Telegram webhook (bare-finish-on-AWAITING_REVIEW
// resend) and the cron stage that finishes the production build.
function buildPreviewReadyText({ leadId, businessName, previewUrl, iteration }) {
  const lines = [
    `✅ #${leadId} (${businessName}) урьдчилсан хувилбар бэлэн боллоо.`,
    "",
    `🌐 ${previewUrl}`,
    ""
  ];
  if (iteration > 1) {
    lines.push(`🔁 Засвар №${iteration} оруулсан.`);
    lines.push("");
  }
  lines.push(
    "Дараагийн алхам:",
    "",
    `   ✅ APPROVE #${leadId}`,
    "      Сайт бэлэн, домэйн холболт эхлэх.",
    "",
    `   ✏️ CHANGE #${leadId} [юу засах вэ]`,
    `      Жишээ: CHANGE #${leadId} hero-г илүү тод болго, FAQ хэсгийг хас.`,
    "      Хэдэн ч удаа явуулж болно. Засвар бүрд өмнөх бүх засварууд хэвээр үлдэнэ."
  );
  return lines.join("\n");
}

function buildLeadMessage({ brief, previewUrl, leadId }) {
  const id = leadId ? `#${leadId}` : "#???";
  const lines = [
    `🔔 Шинэ захиалга ${id}`,
    "",
    `👤 ${brief.fullName || "—"}`,
    `🏢 ${brief.businessName || "—"} (${brief.industry || "—"})`,
    `📧 ${brief.email || "—"}`,
    `📱 ${brief.phone || "—"}`,
    `🌐 Демо: ${previewUrl || "—"}`,
    `📝 ${truncate(brief.description, 220)}`,
    "",
    "──────────────────",
    "Бүрэн вэбсайт барих бол:",
    leadId ? `#${leadId} finish` : "#??? finish"
  ];
  return lines.join("\n");
}

function envState() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  return {
    token,
    chatId,
    hasToken: token.length > 0,
    hasChatId: chatId.length > 0,
    tokenPreview: token ? `${token.slice(0, 6)}…(${token.length} chars)` : "MISSING",
    chatIdPreview: chatId || "MISSING"
  };
}

// Same stale-keep-alive concern as Upstash in lib/leads.js: a bare
// `await fetch(...)` to api.telegram.org can sit on a dead socket from
// undici's connection pool for the rest of the 300s lambda budget. Wrap
// every Telegram call in a Promise.race timeout and force `Connection:
// close` so each invocation gets a fresh socket. Without this, the error
// reply path itself hangs whenever Upstash already timed out.
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS) || 10000;

async function telegramFetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const e = new Error(`fetch timeout after ${timeoutMs}ms`);
      e.code = "FETCH_TIMEOUT";
      reject(e);
    }, timeoutMs);
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

async function callTelegram(method, payload) {
  const { token, hasToken } = envState();
  if (!hasToken) {
    const err = new Error("TELEGRAM_BOT_TOKEN is not set");
    err.code = "MISSING_TOKEN";
    throw err;
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const started = Date.now();
  console.log(`[telegram] -> ${method}`);
  let res;
  try {
    res = await telegramFetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connection": "close"
      },
      body: JSON.stringify(payload)
    }, TELEGRAM_TIMEOUT_MS);
  } catch (err) {
    const ms = Date.now() - started;
    const reason = err?.code === "FETCH_TIMEOUT"
      ? `timeout after ${ms}ms (limit ${TELEGRAM_TIMEOUT_MS}ms)`
      : (err?.message || String(err));
    console.error(`[telegram] <- ${method} fetch failed: ${reason}`);
    const wrapped = new Error(`Telegram ${method} failed: ${reason}`);
    wrapped.code = err?.code === "FETCH_TIMEOUT" ? "TELEGRAM_TIMEOUT" : "TELEGRAM_FETCH_ERROR";
    throw wrapped;
  }
  const body = await res.json().catch(() => ({}));
  console.log(`[telegram] <- ${method} status=${res.status} ok=${body?.ok} ms=${Date.now() - started}`);
  if (!res.ok || body?.ok === false) {
    const message = body?.description || `Telegram API ${method} failed (${res.status})`;
    const err = new Error(message);
    err.code = "API_ERROR";
    err.status = res.status;
    err.responseBody = body;
    throw err;
  }
  return body;
}

async function sendTelegramNotification({ brief, previewUrl, leadId }) {
  const env = envState();
  console.log(`[telegram] sendTelegramNotification leadId=${leadId || "none"} token=${env.tokenPreview} chatId=${env.chatIdPreview}`);
  if (!env.hasToken || !env.hasChatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set");
  }
  const text = buildLeadMessage({ brief, previewUrl, leadId });
  const body = await callTelegram("sendMessage", {
    chat_id: env.chatId,
    text,
    disable_web_page_preview: false
  });
  return { ok: true, telegram: body };
}

async function sendTelegramReply({ chatId, text, replyToMessageId }) {
  const env = envState();
  console.log(`[telegram] sendTelegramReply chatId=${chatId} replyTo=${replyToMessageId || "none"} token=${env.tokenPreview}`);
  if (!env.hasToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const payload = { chat_id: chatId, text };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  try {
    return await callTelegram("sendMessage", payload);
  } catch (err) {
    // Telegram refuses to thread a reply when the original message was
    // deleted, was sent by another bot, or never existed (synthetic test
    // payloads, stale retries). Retry without reply_to_message_id so the
    // message still gets delivered.
    const desc = String(err?.responseBody?.description || err?.message || "");
    if (replyToMessageId && /message to be replied not found/i.test(desc)) {
      console.warn(`[telegram] reply_to_message_id ${replyToMessageId} stale, retrying as plain message`);
      return await callTelegram("sendMessage", { chat_id: chatId, text });
    }
    throw err;
  }
}

async function sendTelegramConfirmation({ leadId, finalUrl }) {
  const env = envState();
  if (!env.hasToken || !env.hasChatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set");
  }
  const text = `✅ #${leadId} бэлэн боллоо: ${finalUrl}`;
  return callTelegram("sendMessage", {
    chat_id: env.chatId,
    text,
    disable_web_page_preview: false
  });
}

function buildDesignChoiceMessage({ leadId, designNumber, businessName, fullName, phone, email }) {
  const id = leadId ? `#${leadId}` : "#???";
  const lines = [
    "🎨 Загвар сонгогдлоо!",
    "",
    `${id} ${businessName || "—"}`,
    `Загвар: №${designNumber}`,
    `📱 ${phone || "—"}`,
    `📧 ${email || "—"}`,
    `👤 ${fullName || "—"}`
  ];
  return lines.join("\n");
}

async function sendDesignChoiceNotification({ leadId, designNumber, businessName, fullName, phone, email }) {
  const env = envState();
  if (!env.hasToken || !env.hasChatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set");
  }
  const text = buildDesignChoiceMessage({ leadId, designNumber, businessName, fullName, phone, email });
  console.log(`[telegram] sendDesignChoiceNotification leadId=${leadId} design=${designNumber}`);
  const body = await callTelegram("sendMessage", {
    chat_id: env.chatId,
    text,
    disable_web_page_preview: true
  });
  return { ok: true, telegram: body };
}

// Pull every http(s) URL pointing at an image asset out of free-form text.
// Bilguun pastes photo URLs from Drive, Imgur, Telegram CDN, or direct
// hosting straight into the Telegram message, so the matcher is permissive:
// any URL with a recognised image extension OR with one of the common photo-
// host substrings counts as a usable photo URL.
function extractPhotoUrls(text) {
  if (typeof text !== "string" || !text) return [];
  const out = new Set();
  const re = /https?:\/\/[^\s<>"')]+/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    if (/\.(jpg|jpeg|png|webp|gif|avif|heic)(\?.*)?$/i.test(raw) ||
        /(drive\.google\.com|googleusercontent\.com|imgur\.com|cloudinary\.com|cdn\.|images?\.|photos?\.|i\.redd\.it|unsplash\.com|pexels\.com)/i.test(raw)) {
      out.add(raw);
    }
  }
  return [...out];
}

// Returns { id, extras: { raw, notes, photos } } | null. Everything Bilguun
// types after `#NNN finish` becomes the extras body so the prompt builder
// can pass it to Sonnet as the highest-priority client brief content.
function parseFinishCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  // Anchor on the leading `#NNN finish`, allow any free-form body after.
  const m = trimmed.match(/^#?(\d{1,4})\s+finish\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const id = m[1].padStart(3, "0");
  const extrasRaw = (m[2] || "").trim();
  return {
    id,
    extras: {
      raw: extrasRaw,
      notes: extrasRaw,
      photos: extractPhotoUrls(extrasRaw)
    }
  };
}

// `APPROVE #005`, `approve #5`, `#005 approve`, `#5 approved`. Case
// insensitive. APPROVE confirms the production preview is good enough to
// flip to a real domain.
function parseApproveCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  let m = trimmed.match(/^approved?\s+#?(\d{1,4})\b\s*$/i);
  if (!m) m = trimmed.match(/^#?(\d{1,4})\s+approved?\b\s*$/i);
  if (!m) return null;
  return { id: m[1].padStart(3, "0") };
}

// `DOMAIN #005 new gsauto.mn` / `DOMAIN #5 existing gsauto.mn` /
// `#005 domain new ...`. Returns { id, path: "new"|"existing", domain } | null.
// The domain string is lowercased and `https://` / trailing slashes stripped
// so Bilguun can paste a URL and it still works.
function parseDomainCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  let m = trimmed.match(/^domain\s+#?(\d{1,4})\s+(new|existing)\s+(\S+)\s*$/i);
  if (!m) m = trimmed.match(/^#?(\d{1,4})\s+domain\s+(new|existing)\s+(\S+)\s*$/i);
  if (!m) return null;
  const domain = String(m[3] || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    .trim();
  if (!domain || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/i.test(domain)) {
    return null;
  }
  return {
    id: m[1].padStart(3, "0"),
    path: m[2].toLowerCase(),
    domain
  };
}

// Path A success: domain purchased and Vercel nameservers set.
function buildDomainPurchasedMessage({ domain }) {
  return [
    `✅ ${domain} худалдаж авлаа. Vercel DNS автоматаар тохируулагдлаа.`,
    "24-48 цагт идэвхжинэ. Мэдэгдэнэ."
  ].join(" ");
}

// Path A failure: requested domain is taken. `alternatives` is an array of
// `{ domain, premium, premiumPrice }` from Namecheap.
function buildDomainTakenMessage({ leadId, domain, alternatives }) {
  const lines = [`❌ ${domain} боломжгүй байна.`];
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    lines.push("", "Дараах домэйнууд боломжтой:");
    for (const alt of alternatives.slice(0, 6)) {
      const price = alt.premium && alt.premiumPrice
        ? ` — $${alt.premiumPrice.toFixed(2)}/жил (premium)`
        : "";
      lines.push(`   ${alt.domain}${price}`);
    }
    const firstAlt = alternatives[0].domain;
    lines.push("", `Сонгохдоо: DOMAIN #${leadId} new ${firstAlt}`);
  } else {
    lines.push("", `Өөр нэр оруулна уу: DOMAIN #${leadId} new <new-name>`);
  }
  return lines.join("\n");
}

// Path B handoff: DNS instructions Bilguun forwards to the client. Vercel
// also returns exact records via getVercelDomainConfig, but the canonical
// apex IP / CNAME target are stable so we hardcode them and only inject
// the lead's number + business name.
function buildDomainPathBMessage({ leadId, businessName, domain }) {
  return [
    `🌐 #${leadId} ${businessName || domain} — DNS тохиргоо`,
    "",
    "Клиентэд дараах тохиргоог хийлгэнэ үү:",
    "",
    "Тэдний домэйн бүртгэл рүү нэвтрэн:",
    "",
    "   CNAME  www   cname.vercel-dns.com",
    "   A      @     76.76.21.21",
    "",
    "Эсвэл nameserver солих бол:",
    "   ns1.vercel-dns.com",
    "   ns2.vercel-dns.com",
    "",
    `Домэйн: ${domain}`,
    "",
    "Тохиргоо хийсний дараа 24-48 цагт идэвхжинэ. Бэлэн болмогц мэдэгдэнэ."
  ].join("\n");
}

// Hourly cron sends this once Vercel reports the domain live.
function buildDomainLiveMessage({ domain }) {
  return [
    `✅ ${domain} амжилттай холбогдлоо!`,
    `Сайт: https://${domain}`
  ].join("\n");
}

// After 72h still pending, a single warning so Bilguun can chase the client
// (or revisit the registrar config).
function buildDomainWarningMessage({ leadId, domain, hoursPending }) {
  return [
    `⚠️ #${leadId} ${domain} — ${hoursPending} цагийн дараа ч идэвхжээгүй байна.`,
    "",
    "Шалгах зүйлс:",
    "   • Клиент DNS тохиргоог хийсэн үү?",
    "   • Nameserver эсвэл A/CNAME бичлэг зөв үү?",
    "   • Vercel дашбоард дээр домэйн зөв холбогдсон уу?",
    "",
    "Цаг хугацаа дуусаагүй бол түр хүлээнэ үү (.mn зэрэг TLD-д 72+ цаг шаардагдаж болно)."
  ].join("\n");
}

// `CHANGE #005 ...feedback...` or `#005 change ...feedback...`. The feedback
// body is what tells the next regeneration what to fix. An empty feedback
// returns `{ id, feedback: "" }` so the webhook can prompt Bilguun to
// describe the change instead of silently regenerating with no instructions.
function parseChangeCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  let m = trimmed.match(/^change\s+#?(\d{1,4})\b\s*([\s\S]*)$/i);
  if (!m) m = trimmed.match(/^#?(\d{1,4})\s+change\b\s*([\s\S]*)$/i);
  if (!m) return null;
  return { id: m[1].padStart(3, "0"), feedback: (m[2] || "").trim() };
}

module.exports = {
  sendTelegramNotification,
  sendTelegramConfirmation,
  sendTelegramReply,
  sendDesignChoiceNotification,
  buildLeadMessage,
  buildPreviewReadyText,
  buildDesignChoiceMessage,
  parseFinishCommand,
  parseApproveCommand,
  parseChangeCommand,
  parseDomainCommand,
  buildDomainPurchasedMessage,
  buildDomainTakenMessage,
  buildDomainPathBMessage,
  buildDomainLiveMessage,
  buildDomainWarningMessage,
  extractPhotoUrls,
  envState
};
