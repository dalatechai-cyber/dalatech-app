"use strict";

const { processOneGeneration, processOneSend } = require("../lib/process-lead");
const { findQueuedForGeneration, findDueForSend } = require("../lib/leads");

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

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
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
