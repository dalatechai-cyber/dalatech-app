"use strict";

const { runPipeline } = require("../lib/pipeline");
const { sendClientEmail } = require("../lib/email");
const {
  findQueuedForGeneration,
  findDueForSend,
  updateLead,
  STATUS
} = require("../lib/leads");

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

async function processOneGeneration(lead) {
  console.log(`[cron] generating for lead=#${lead.id} business="${lead.businessName}"`);
  const brief = {
    businessName:   lead.businessName,
    industry:       lead.industry,
    description:    lead.description,
    services:       lead.services,
    primaryColor:   lead.primaryColor,
    secondaryColor: lead.secondaryColor,
    style:          lead.style,
    references:     lead.references,
    sections:       lead.sections,
    fullName:       lead.fullName,
    email:          lead.email,
    phone:          lead.phone,
    quality:        "demo"
  };

  updateLead(lead.id, { status: STATUS.FINISHING, lastError: null });

  let result;
  try {
    result = await runPipeline({ brief, leadId: lead.id });
  } catch (err) {
    console.error(`[cron] generation failed lead=#${lead.id}:`, err?.message || err);
    updateLead(lead.id, {
      status: STATUS.FAILED,
      lastError: err?.message || String(err)
    });
    return { ok: false, leadId: lead.id, error: err?.message || String(err) };
  }

  updateLead(lead.id, {
    status: STATUS.READY,
    previewUrl: result.previewUrl,
    projectName: result.deployment?.projectName || null,
    generatedAt: new Date().toISOString(),
    lastError: null
  });

  console.log(`[cron] generation ok lead=#${lead.id} url=${result.previewUrl}`);
  return { ok: true, leadId: lead.id, previewUrl: result.previewUrl };
}

async function processOneSend(lead) {
  console.log(`[cron] sending scheduled email lead=#${lead.id} business="${lead.businessName}"`);
  try {
    await sendClientEmail({
      to: lead.email,
      businessName: lead.businessName,
      fullName: lead.fullName,
      previewUrl: lead.previewUrl,
      mode: "demo"
    });
  } catch (err) {
    console.error(`[cron] send failed lead=#${lead.id}:`, err?.message || err);
    updateLead(lead.id, { lastError: err?.message || String(err) });
    return { ok: false, leadId: lead.id, error: err?.message || String(err) };
  }

  updateLead(lead.id, {
    status: STATUS.SENT,
    sentAt: new Date().toISOString(),
    lastError: null
  });

  return { ok: true, leadId: lead.id };
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

  const queued = findQueuedForGeneration({ limit: MAX_GENERATIONS_PER_RUN });
  for (const lead of queued) {
    const result = await processOneGeneration(lead);
    generations.push(result);
  }

  const due = findDueForSend({ limit: MAX_SENDS_PER_RUN });
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
