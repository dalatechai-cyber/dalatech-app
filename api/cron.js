"use strict";

const { processOneGeneration, processOneSend, processLeadEndToEnd } = require("../lib/process-lead");
const { findQueuedForGeneration, findDueForSend, listLeads, STATUS } = require("../lib/leads");

const MAX_GENERATIONS_PER_RUN = 1;
const MAX_SENDS_PER_RUN = 5;

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (typeof auth === "string" && auth === `Bearer ${expected}`) return true;
  const alt = req.headers?.["x-vercel-cron-secret"];
  if (typeof alt === "string" && alt === expected) return true;
  return false;
}

function getTriggerHeader(req) {
  const raw = req.headers?.["x-trigger"] ?? req.headers?.["X-Trigger"];
  return typeof raw === "string" ? raw.toLowerCase() : "";
}

async function findMostRecentQueued() {
  const leads = await listLeads();
  return leads
    .filter(l => l.status === STATUS.QUEUED)
    .sort((a, b) => Number(b.number) - Number(a.number))[0] || null;
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (getTriggerHeader(req) === "generate") {
    const lead = await findMostRecentQueued();
    if (!lead) {
      console.log("[cron] X-Trigger=generate but no queued lead found");
      return res.status(200).json({ ok: true, triggered: "generate", processed: null });
    }
    console.log(`[cron] X-Trigger=generate processing lead=#${lead.id} number=${lead.number}`);
    const result = await processLeadEndToEnd(lead.id);
    if (result?.ok) {
      console.log(`[cron] X-Trigger pipeline ok lead=#${lead.id} skipped=${!!result.skipped}`);
    } else {
      console.error(`[cron] X-Trigger pipeline failed lead=#${lead.id}:`, result?.error);
    }
    return res.status(200).json({
      ok: true,
      triggered: "generate",
      leadId: lead.id,
      result
    });
  }

  const generations = [];
  const sends = [];

  const queued = await findQueuedForGeneration({ limit: MAX_GENERATIONS_PER_RUN });
  for (const lead of queued) {
    const result = await processOneGeneration(lead);
    generations.push(result);
  }

  const due = await findDueForSend({ limit: MAX_SENDS_PER_RUN });
  for (const lead of due) {
    const result = await processOneSend(lead);
    sends.push(result);
  }

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    generations,
    sends
  });
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
