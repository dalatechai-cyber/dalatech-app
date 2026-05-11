"use strict";

// Lead processing split into independent stages so generation and deployment
// never compete for the same function time budget.
//
//   STAGE 1 (generate)  api/generate.js receives the form, persists the lead,
//                       fires an X-Stage=generate trigger to /api/cron.
//   STAGE 2 (cron gen)  cron invocation runs claude generation only, stores
//                       the raw HTML on the lead, fires X-Stage=deploy.
//   STAGE 3 (cron dep)  cron invocation pulls the HTML, decorates it with
//                       chatbot + CTA, deploys to Vercel, fires X-Stage=send.
//   STAGE 4 (cron snd)  cron invocation sends the client email.
//
// Each cron invocation gets its own 300s budget, so the slowest stage
// (generation with claude-sonnet-4-6) can take as long as it needs without
// starving deploy or notification.

const { generateHtml, decorateHtml } = require("./pipeline");
const { deployToVercel } = require("./deploy");
const { sendClientEmail } = require("./email");
const { getLead, updateLead, STATUS } = require("./leads");

const CRON_TRIGGER_URL = process.env.CRON_TRIGGER_URL || "https://app.dalatech.online/api/cron";

function briefFromLead(lead, { quality = "demo" } = {}) {
  return {
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
    quality
  };
}

// Fire-and-forget POST to /api/cron with the next stage. We wait briefly so
// the outbound request reaches Vercel before this function is frozen; the
// receiving cron invocation runs in its own context with its own 300s.
async function triggerNextStage(stage, leadId) {
  const headers = {
    "X-Trigger": "stage",
    "X-Stage": stage,
    "X-Lead-Id": String(leadId)
  };
  if (process.env.CRON_SECRET) {
    headers["Authorization"] = `Bearer ${process.env.CRON_SECRET}`;
  }
  try {
    await fetch(CRON_TRIGGER_URL, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(2500)
    });
    console.log(`[process-lead] triggered next stage=${stage} lead=#${leadId}`);
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      console.log(`[process-lead] triggered next stage=${stage} lead=#${leadId} (no-wait)`);
      return;
    }
    console.error(`[process-lead] trigger failed stage=${stage} lead=#${leadId}:`, err?.message || err);
  }
}

// STAGE: generate HTML only. Stores the raw HTML on the lead. The deploy
// stage will read it, decorate, and ship to Vercel.
async function processGenerateStage(lead) {
  console.log(`[process-lead] STAGE=generate lead=#${lead.id} business="${lead.businessName}"`);

  await updateLead(lead.id, { status: STATUS.GENERATING, lastError: null });

  let html;
  try {
    html = await generateHtml(briefFromLead(lead));
  } catch (err) {
    console.error(`[process-lead] generate failed lead=#${lead.id}:`, err?.message || err);
    await updateLead(lead.id, {
      status: STATUS.FAILED,
      lastError: `generate: ${err?.message || String(err)}`
    });
    return { ok: false, leadId: lead.id, stage: "generate", error: err?.message || String(err) };
  }

  await updateLead(lead.id, {
    status: STATUS.HTML_READY,
    generatedHtml: html,
    lastError: null
  });
  console.log(`[process-lead] STAGE=generate ok lead=#${lead.id} htmlLength=${html.length}`);

  await triggerNextStage("deploy", lead.id);
  return { ok: true, leadId: lead.id, stage: "generate" };
}

// STAGE: deploy. Reads the stored HTML, injects chatbot + CTA, ships to
// Vercel, records the previewUrl, then triggers the send stage.
async function processDeployStage(lead) {
  console.log(`[process-lead] STAGE=deploy lead=#${lead.id} business="${lead.businessName}"`);

  if (!lead.generatedHtml) {
    const error = "no generatedHtml on lead; cannot deploy";
    console.error(`[process-lead] STAGE=deploy lead=#${lead.id}: ${error}`);
    await updateLead(lead.id, { status: STATUS.FAILED, lastError: `deploy: ${error}` });
    return { ok: false, leadId: lead.id, stage: "deploy", error };
  }

  await updateLead(lead.id, { status: STATUS.DEPLOYING, lastError: null });

  const decorated = decorateHtml(lead.generatedHtml, {
    brief: briefFromLead(lead),
    leadId: lead.id
  });

  let deployment;
  try {
    deployment = await deployToVercel({
      projectName: lead.businessName,
      html: decorated
    });
  } catch (err) {
    console.error(`[process-lead] deploy failed lead=#${lead.id}:`, err?.message || err);
    await updateLead(lead.id, {
      status: STATUS.FAILED,
      lastError: `deploy: ${err?.message || String(err)}`
    });
    return { ok: false, leadId: lead.id, stage: "deploy", error: err?.message || String(err) };
  }

  await updateLead(lead.id, {
    status: STATUS.READY,
    previewUrl: deployment.url,
    projectName: deployment.projectName || null,
    generatedAt: new Date().toISOString(),
    generatedHtml: null,
    lastError: null
  });
  console.log(`[process-lead] STAGE=deploy ok lead=#${lead.id} url=${deployment.url}`);

  await triggerNextStage("send", lead.id);
  return { ok: true, leadId: lead.id, stage: "deploy", previewUrl: deployment.url };
}

// STAGE: send. Honours scheduledSendAt — if the lead is scheduled for the
// future, the hourly cron picks it up later.
async function processSendStage(lead) {
  console.log(`[process-lead] STAGE=send lead=#${lead.id} business="${lead.businessName}"`);

  if (!lead.previewUrl) {
    const error = "no previewUrl on lead; cannot send";
    console.error(`[process-lead] STAGE=send lead=#${lead.id}: ${error}`);
    return { ok: false, leadId: lead.id, stage: "send", error };
  }

  if (lead.scheduledSendAt && Date.parse(lead.scheduledSendAt) > Date.now()) {
    console.log(`[process-lead] STAGE=send deferred lead=#${lead.id} until=${lead.scheduledSendAt}`);
    return { ok: true, leadId: lead.id, stage: "send", deferred: true };
  }

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
    await updateLead(lead.id, { lastError: `send: ${err?.message || String(err)}` });
    return { ok: false, leadId: lead.id, stage: "send", error: err?.message || String(err) };
  }

  await updateLead(lead.id, {
    status: STATUS.SENT,
    sentAt: new Date().toISOString(),
    lastError: null
  });
  console.log(`[process-lead] STAGE=send ok lead=#${lead.id}`);
  return { ok: true, leadId: lead.id, stage: "send" };
}

// Hourly cron safety net: pick up a queued lead and start its chain.
async function processOneGeneration(lead) {
  return processGenerateStage(lead);
}

// Hourly cron safety net: any READY lead whose scheduledSendAt has arrived.
async function processOneSend(lead) {
  return processSendStage(lead);
}

// Dispatched directly by the X-Stage trigger from api/cron.js.
async function runStage(stage, leadId) {
  const lead = await getLead(leadId);
  if (!lead) return { ok: false, leadId, stage, error: "lead not found" };

  if (stage === "generate") {
    // Idempotency: only start generation from QUEUED or GENERATING (a
    // mid-stage retry). Anything further along means another invocation
    // already moved past this stage.
    if (lead.status !== STATUS.QUEUED && lead.status !== STATUS.GENERATING) {
      console.log(`[process-lead] runStage=generate skipping lead=#${leadId} status=${lead.status}`);
      return { ok: true, leadId, stage, skipped: true, status: lead.status };
    }
    return processGenerateStage(lead);
  }

  if (stage === "deploy") {
    if (lead.status === STATUS.READY || lead.status === STATUS.SENT) {
      console.log(`[process-lead] runStage=deploy skipping lead=#${leadId} status=${lead.status}`);
      return { ok: true, leadId, stage, skipped: true, status: lead.status };
    }
    return processDeployStage(lead);
  }

  if (stage === "send") {
    if (lead.status === STATUS.SENT) {
      console.log(`[process-lead] runStage=send skipping lead=#${leadId} already sent`);
      return { ok: true, leadId, stage, skipped: true };
    }
    return processSendStage(lead);
  }

  return { ok: false, leadId, stage, error: `unknown stage: ${stage}` };
}

// Backwards-compatible entry used by the legacy X-Trigger=generate path:
// starts the chain at the generate stage. Subsequent stages run in their own
// cron invocations via triggerNextStage.
async function processLeadEndToEnd(leadId) {
  const lead = await getLead(leadId);
  if (!lead) return { ok: false, leadId, error: "lead not found" };
  if (lead.status !== STATUS.QUEUED) {
    return { ok: true, leadId, skipped: true, status: lead.status };
  }
  return processGenerateStage(lead);
}

module.exports = {
  processGenerateStage,
  processDeployStage,
  processSendStage,
  processOneGeneration,
  processOneSend,
  processLeadEndToEnd,
  runStage,
  triggerNextStage
};
