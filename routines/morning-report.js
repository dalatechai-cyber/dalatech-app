"use strict";

// DalaTech morning report.
//
// Runs once a day at 09:00 Ulaanbaatar time under PM2 cron (see README).
// Reads every lead from Upstash, classifies them by status, and sends a
// single Telegram message that tells Bilguun what needs his attention
// today. The script is fire-once: PM2 starts it on the cron tick, it sends
// one message, and exits.
//
// All env vars come from .env.local at the project root.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local") });

const { listLeads, STATUS } = require("../lib/leads");
const { sendTelegramReply, envState: telegramEnvState } = require("../lib/telegram");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Categories used in the report. The display order here is the order in
// which they appear in the message body.
const CATEGORIES = [
  { key: "new_today",       label: "Шинэ хүсэлт (өнөөдөр)" },
  { key: "preparing",       label: "Демо бэлдэж байна"     },
  { key: "demo_sent",       label: "Демо илгээгдсэн"       },
  { key: "design_chosen",   label: "Загвар сонгосон"       },
  { key: "awaiting_review", label: "Хянахаар хүлээж байна" },
  { key: "domain_pending",  label: "Домэйн тохируулж байна" },
  { key: "done",            label: "Амжилттай дууссан"     }
];

function log(...args) {
  console.log(`[morning-report ${new Date().toISOString()}]`, ...args);
}

// Returns YYYY/MM/DD in Asia/Ulaanbaatar (UTC+8, no DST).
function ulaanbaatarDateString(now = new Date()) {
  const ub = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = ub.getUTCFullYear();
  const m = String(ub.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ub.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

// True if `iso` is in the same Asia/Ulaanbaatar calendar day as `now`.
function isUlaanbaatarToday(iso, now = new Date()) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return ulaanbaatarDateString(new Date(t)) === ulaanbaatarDateString(now);
}

function daysSince(iso, now = new Date()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / MS_PER_DAY);
}

function categorize(lead) {
  const status = lead?.status;
  if (status === STATUS.QUEUED) return "new_today";
  if (
    status === STATUS.GENERATING ||
    status === STATUS.HTML_READY ||
    status === STATUS.DEPLOYING ||
    status === STATUS.READY_TO_FINISH ||
    status === STATUS.FINISHING ||
    status === STATUS.CHANGING
  ) {
    return "preparing";
  }
  if (status === STATUS.READY || status === STATUS.SENT) return "demo_sent";
  if (status === STATUS.CHOSEN) return "design_chosen";
  if (status === STATUS.AWAITING_REVIEW) return "awaiting_review";
  if (status === STATUS.APPROVED || status === STATUS.DOMAIN_PENDING) return "domain_pending";
  if (status === STATUS.DOMAIN_LIVE || status === STATUS.FINISHED) return "done";
  return null;
}

function buildReport(leads, now = new Date()) {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c.key, 0]));
  const buckets = Object.fromEntries(CATEGORIES.map(c => [c.key, []]));

  let newToday = 0;
  for (const lead of leads) {
    const cat = categorize(lead);
    if (cat) {
      counts[cat]++;
      buckets[cat].push(lead);
    }
    if (isUlaanbaatarToday(lead?.createdAt, now)) newToday++;
  }
  // "new_today" in the header is specifically *created today*, independent
  // of the categorize() bucket — override the count.
  counts.new_today = newToday;

  const total = leads.length;
  const dateStr = ulaanbaatarDateString(now);

  const lines = [
    `🌅 DalaTech өдрийн тайлан — ${dateStr}`,
    "",
    `📊 НИЙТ ХЭРЭГЛЭГЧ: ${total}`
  ];

  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    const prefix = i === CATEGORIES.length - 1 ? "└" : "├";
    const suffix = cat.key === "awaiting_review" ? "  ← needs APPROVE/CHANGE" : "";
    lines.push(`${prefix} ${cat.label}: ${counts[cat.key]}${suffix}`);
  }

  // Urgent: anything that has been waiting on Bilguun for >= 2 days.
  const urgent = [];

  for (const lead of buckets.awaiting_review) {
    const days = daysSince(lead.updatedAt || lead.finishedAt || lead.createdAt, now);
    if (days !== null && days >= 2) {
      urgent.push({
        days,
        text: [
          `- #${lead.id} ${lead.businessName || "—"} — ХЯНАХ хүлээж байна (${days} өдөр)`,
          `  → APPROVE #${lead.id} эсвэл CHANGE #${lead.id} илгээнэ үү`
        ].join("\n")
      });
    }
  }

  for (const lead of buckets.domain_pending) {
    if (lead.status !== STATUS.DOMAIN_PENDING) continue;
    const startedAt = lead?.domainConnect?.startedAt || lead.updatedAt || lead.createdAt;
    const days = daysSince(startedAt, now);
    if (days !== null && days >= 3) {
      const domain = lead?.domainConnect?.domain || "—";
      urgent.push({
        days,
        text: [
          `- #${lead.id} ${lead.businessName || domain} — Домэйн ${days} өдөр болж байна`,
          `  → DNS тохиргоо шалгах хэрэгтэй`
        ].join("\n")
      });
    }
  }

  if (urgent.length > 0) {
    lines.push("", "⚡ ЯАРАЛТАЙ (таны анхаарал шаарддаг):");
    urgent
      .sort((a, b) => b.days - a.days)
      .forEach(u => lines.push(u.text));
  }

  // Demo sent and idle for 3+ days — client has not chosen yet.
  const stale = [];
  for (const lead of buckets.demo_sent) {
    if (lead.status !== STATUS.SENT) continue;
    const days = daysSince(lead.sentAt || lead.updatedAt || lead.createdAt, now);
    if (days !== null && days >= 3) {
      stale.push({
        days,
        text: `- #${lead.id} ${lead.businessName || "—"} — демо ${days} өдрийн өмнө илгээсэн\n  → Дагаж мэдэгдэх хэрэгтэй`
      });
    }
  }
  if (stale.length > 0) {
    lines.push("", "📬 ХАРИУ ӨГӨӨГҮЙ (3+ өдөр):");
    stale
      .sort((a, b) => b.days - a.days)
      .forEach(s => lines.push(s.text));
  }

  if (urgent.length === 0 && stale.length === 0) {
    lines.push(
      "",
      "✅ ӨНӨӨДӨР ХИЙХ ЗҮЙЛГҮЙ БОЛ — системд бүх зүйл",
      "   ажиллаж байна."
    );
  }

  return lines.join("\n");
}

async function main() {
  const required = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter(k => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length > 0) {
    log(`FATAL: missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  log("listing leads from Upstash…");
  const leads = await listLeads();
  log(`fetched ${leads.length} leads`);

  const text = buildReport(leads, new Date());
  console.log("\n--- REPORT ---\n" + text + "\n--- END REPORT ---\n");

  const env = telegramEnvState();
  await sendTelegramReply({ chatId: env.chatId, text });
  log("morning report sent");
}

main().catch(err => {
  log(`morning-report failed: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});

module.exports = { buildReport, categorize, ulaanbaatarDateString };
