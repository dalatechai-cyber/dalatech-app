"use strict";

// Shared lead processing helpers used by both the hourly cron
// (api/cron.js) and the instant-trigger path in api/generate.js.
// Encapsulates the "generate website then send email" workflow so the
// cron handler stays thin and generate.js can fire the same pipeline
// in the background after a fresh submission.

const { runPipeline } = require("./pipeline");
const { sendClientEmail } = require("./email");
const { getLead, updateLead, STATUS } = require("./leads");

async function processOneGeneration(lead) {
  console.log(`[process-lead] generating for lead=#${lead.id} business="${lead.businessName}"`);
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

  await updateLead(lead.id, { status: STATUS.FINISHING, lastError: null });

  let result;
  try {
    result = await runPipeline({ brief, leadId: lead.id });
  } catch (err) {
    console.error(`[process-lead] generation failed lead=#${lead.id}:`, err?.message || err);
    await updateLead(lead.id, {
      status: STATUS.FAILED,
      lastError: err?.message || String(err)
    });
    return { ok: false, leadId: lead.id, error: err?.message || String(err) };
  }

  await updateLead(lead.id, {
    status: STATUS.READY,
    previewUrl: result.previewUrl,
    projectName: result.deployment?.projectName || null,
    generatedAt: new Date().toISOString(),
    lastError: null
  });

  console.log(`[process-lead] generation ok lead=#${lead.id} url=${result.previewUrl}`);
  return { ok: true, leadId: lead.id, previewUrl: result.previewUrl };
}

async function processOneSend(lead) {
  console.log(`[process-lead] sending scheduled email lead=#${lead.id} business="${lead.businessName}"`);
  try {
    await sendClientEmail({
      to: lead.email,
      businessName: lead.businessName,
      fullName: lead.fullName,
      previewUrl: lead.previewUrl,
      mode: "demo"
    });
  } catch (err) {
    console.error(`[process-lead] send failed lead=#${lead.id}:`, err?.message || err);
    await updateLead(lead.id, { lastError: err?.message || String(err) });
    return { ok: false, leadId: lead.id, error: err?.message || String(err) };
  }

  await updateLead(lead.id, {
    status: STATUS.SENT,
    sentAt: new Date().toISOString(),
    lastError: null
  });

  return { ok: true, leadId: lead.id };
}

// Generates the website, then immediately sends the email if the
// scheduled send time has already arrived (which is the default when
// DEMO_DELAY_HOURS is 0). Otherwise the cron picks up the send later.
async function processLeadEndToEnd(leadId) {
  const initial = await getLead(leadId);
  if (!initial) {
    return { ok: false, leadId, error: "lead not found" };
  }
  if (initial.status !== STATUS.QUEUED) {
    return { ok: true, leadId, skipped: true, status: initial.status };
  }

  const genResult = await processOneGeneration(initial);
  if (!genResult.ok) return genResult;

  const updated = await getLead(leadId);
  if (!updated) return { ok: false, leadId, error: "lead vanished after generation" };

  const dueNow =
    updated.status === STATUS.READY &&
    updated.previewUrl &&
    updated.scheduledSendAt &&
    Date.parse(updated.scheduledSendAt) <= Date.now();

  if (dueNow) {
    return await processOneSend(updated);
  }
  return genResult;
}

module.exports = {
  processOneGeneration,
  processOneSend,
  processLeadEndToEnd
};
