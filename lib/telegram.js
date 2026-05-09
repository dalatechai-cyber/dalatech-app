"use strict";

function truncate(s, n) {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + "…";
}

function buildLeadMessage({ brief, previewUrl }) {
  const lines = [
    "🔔 Шинэ демо хүсэлт!",
    `👤 ${brief.fullName || "—"}`,
    `🏢 ${brief.businessName || "—"} (${brief.industry || "—"})`,
    `📧 ${brief.email || "—"}`,
    `📱 ${brief.phone || "—"}`,
    `🌐 Демо: ${previewUrl || "—"}`,
    `📝 ${truncate(brief.description, 100)}`
  ];
  return lines.join("\n");
}

async function sendTelegramNotification({ brief, previewUrl }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set");
  }

  const text = buildLeadMessage({ brief, previewUrl });
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false
    })
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    const message = payload?.description || `Telegram API failed (${res.status})`;
    throw new Error(message);
  }
  return { ok: true };
}

module.exports = { sendTelegramNotification, buildLeadMessage };
