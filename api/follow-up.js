"use strict";

// DalaTech follow-up reminder — Vercel cron handler.
//
// Schedule: `0 2 * * *` UTC (declared in vercel.json) = 10:00 Asia/Ulaanbaatar.
// Vercel cron makes an HTTP GET to /api/follow-up with the
// `x-vercel-cron-secret` (or `Authorization: Bearer <CRON_SECRET>`) header.
//
// Cloud-hosted twin of routines/follow-up.js — same SENT-lead filter,
// same 3-day threshold, same Mongolian copy. Sends Bilguun one Telegram
// reminder per qualifying lead. No emails go to the client; Bilguun
// decides whether to call or message them.

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
// ("1" / "2" / "3"). Fall back to the legacy single previewUrl field if
// the object is missing.
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

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (typeof auth === "string" && auth === `Bearer ${expected}`) return true;
  const alt = req.headers?.["x-vercel-cron-secret"];
  if (typeof alt === "string" && alt === expected) return true;
  return false;
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const required = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter(k => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length > 0) {
    const msg = `missing env vars: ${missing.join(", ")}`;
    log(`FATAL: ${msg}`);
    return res.status(500).json({ ok: false, error: msg });
  }

  try {
    log("listing leads from Upstash…");
    const leads = await listLeads();
    log(`fetched ${leads.length} leads`);

    const targets = pickFollowUps(leads, new Date());
    log(`found ${targets.length} lead(s) needing follow-up (>= ${FOLLOWUP_AFTER_DAYS} days in SENT)`);

    if (targets.length === 0) {
      return res.status(200).json({ ok: true, candidates: 0, sent: 0, failed: 0 });
    }

    const env = telegramEnvState();
    let sent = 0;
    const failed = [];
    for (const { lead, days } of targets) {
      const text = buildFollowUpMessage(lead, days);
      try {
        await sendTelegramReply({ chatId: env.chatId, text });
        sent++;
        log(`reminder sent for #${lead.id} (${days} days)`);
      } catch (err) {
        const reason = err?.message || String(err);
        failed.push({ leadId: lead.id, error: reason });
        log(`reminder for #${lead.id} failed: ${reason}`);
      }
    }

    return res.status(200).json({
      ok: true,
      candidates: targets.length,
      sent,
      failed: failed.length,
      errors: failed
    });
  } catch (err) {
    log(`follow-up failed: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.buildFollowUpMessage = buildFollowUpMessage;
module.exports.pickFollowUps = pickFollowUps;
module.exports.config = {
  api: { bodyParser: false }
};
