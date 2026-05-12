"use strict";

function truncate(s, n) {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + "…";
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

async function callTelegram(method, payload) {
  const { token, hasToken } = envState();
  if (!hasToken) {
    const err = new Error("TELEGRAM_BOT_TOKEN is not set");
    err.code = "MISSING_TOKEN";
    throw err;
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  console.log(`[telegram] -> ${method}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[telegram] <- ${method} status=${res.status} ok=${body?.ok}`);
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
  return callTelegram("sendMessage", payload);
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
  buildDesignChoiceMessage,
  parseFinishCommand,
  parseApproveCommand,
  parseChangeCommand,
  extractPhotoUrls,
  envState
};
