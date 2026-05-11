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

function parseFinishCommand(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^#?(\d{1,4})\s+finish\s*$/i);
  if (!match) return null;
  return { id: match[1].padStart(3, "0") };
}

module.exports = {
  sendTelegramNotification,
  sendTelegramConfirmation,
  sendTelegramReply,
  buildLeadMessage,
  parseFinishCommand,
  envState
};
