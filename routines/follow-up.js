"use strict";

// DalaTech follow-up reminder.
//
// Runs once a day at 10:00 Ulaanbaatar time under PM2 cron (see README).
// Reads leads in "sent" status from Upstash; for each one where the demo
// has been sitting for 3+ days without the client choosing a design, sends
// Bilguun a Telegram reminder with the client's contact info and the three
// demo URLs.
//
// This is a reminder only — no email or message is sent to the client.
// Bilguun decides whether to actually follow up by phone or message.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local") });

const { listLeads, STATUS } = require("../lib/leads");
const { sendTelegramReply, envState: telegramEnvState } = require("../lib/telegram");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FOLLOWUP_AFTER_DAYS = 3;

function log(...args) {
  console.log(`[follow-up ${new Date().toISOString()}]`, ...args);
}

function daysSince(iso, now = new Date()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / MS_PER_DAY);
}

// process-lead.js writes previewUrls as an object keyed by variant number
// ("1" / "2" / "3"). Fall back to the legacy single previewUrl field if the
// object is missing — that path only exists on production-build leads, but
// keeping the fallback means a malformed record doesn't break the reminder.
function previewUrlsList(lead) {
  const urls = lead?.previewUrls;
  if (urls && typeof urls === "object") {
    const out = ["1", "2", "3"]
      .map(n => urls[n])
      .filter(u => typeof u === "string" && u.trim().length > 0);
    if (out.length > 0) return out;
  }
  if (typeof lead?.previewUrl === "string" && lead.previewUrl.trim()) {
    return [lead.previewUrl];
  }
  return [];
}

function buildFollowUpMessage(lead, days) {
  const lines = [
    `📞 Дагаж мэдэгдэх — #${lead.id} ${lead.businessName || "—"}`,
    "",
    `Демо илгээснээс хойш ${days} өдөр болж байна.`,
    `Клиент: ${lead.fullName || "—"} (${lead.phone || "—"})`,
    `Имэйл: ${lead.email || "—"}`,
    ""
  ];
  const urls = previewUrlsList(lead);
  if (urls.length > 0) {
    lines.push("Загварын линкүүд:");
    urls.forEach((u, i) => lines.push(`- Загвар ${i + 1}: ${u}`));
    lines.push("");
  }
  lines.push("Утсаар залгах эсвэл мессеж илгээхэд тохиромжтой.");
  return lines.join("\n");
}

function pickFollowUps(leads, now = new Date()) {
  const out = [];
  for (const lead of leads) {
    if (lead?.status !== STATUS.SENT) continue;
    const days = daysSince(lead.sentAt || lead.updatedAt || lead.createdAt, now);
    if (days === null || days < FOLLOWUP_AFTER_DAYS) continue;
    out.push({ lead, days });
  }
  // Longest-waiting client first.
  return out.sort((a, b) => b.days - a.days);
}

async function main() {
  const required = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter(k => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length > 0) {
    log(`FATAL: missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const env = telegramEnvState();
  log("listing leads from Upstash…");
  const leads = await listLeads();
  log(`fetched ${leads.length} leads`);

  const targets = pickFollowUps(leads, new Date());
  log(`found ${targets.length} lead(s) needing follow-up (>= ${FOLLOWUP_AFTER_DAYS} days in SENT)`);

  if (targets.length === 0) {
    log("nothing to send today, exiting clean");
    return;
  }

  for (const { lead, days } of targets) {
    const text = buildFollowUpMessage(lead, days);
    try {
      await sendTelegramReply({ chatId: env.chatId, text });
      log(`reminder sent for #${lead.id} (${days} days)`);
    } catch (err) {
      log(`reminder for #${lead.id} failed: ${err?.message || err}`);
    }
  }
}

main().catch(err => {
  log(`follow-up failed: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});

module.exports = { buildFollowUpMessage, pickFollowUps };
