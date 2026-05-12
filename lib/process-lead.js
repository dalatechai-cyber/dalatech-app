"use strict";

// Lead processing split into independent cron stages so each Sonnet
// generation runs inside its own 300s budget.
//
//   STAGE 1 (generate:1)  cron invocation runs claude for variant 1 (minimal),
//                         stores html on the lead, fires deploy:1.
//   STAGE 2 (deploy:1)    cron invocation decorates the html (chatbot + chooser
//                         bar with designNumber=1), deploys to Vercel, records
//                         previewUrls[1], fires generate:2.
//   STAGE 3 (generate:2)  Sonnet for variant 2 (bold). Fires deploy:2.
//   STAGE 4 (deploy:2)    Deploys variant 2. Records previewUrls[2]. Fires
//                         generate:3.
//   STAGE 5 (generate:3)  Sonnet for variant 3 (elegant). Fires deploy:3.
//   STAGE 6 (deploy:3)    Deploys variant 3. Records previewUrls[3]. Fires
//                         send.
//   STAGE 7 (send)        Emails the client with all three URLs.
//
// Each cron invocation gets its own 300s budget so the slowest stage
// (Sonnet 4.6 generation) never starves the others.

const { generateHtml, decorateHtml } = require("./pipeline");
const { deployToVercel } = require("./deploy");
const { sendClientEmail } = require("./email");
const { getLead, updateLead, STATUS } = require("./leads");

const CRON_TARGET_URL = process.env.CRON_TRIGGER_URL || "https://app.dalatech.online/api/cron";
const QSTASH_PUBLISH_BASE = "https://qstash.upstash.io/v2/publish";
const QSTASH_STAGE_DELAY = process.env.QSTASH_STAGE_DELAY || "3s";

// Three demo variants. Each style key maps to a STYLE_GUIDANCE entry in
// lib/prompt.js (minimal, bold, elegant) with its own font pair and design
// direction. Order is fixed: a lead always sees Minimal first, Bold
// second, Elegant third.
const VARIANTS = [
  { n: 1, key: "minimal" },
  { n: 2, key: "bold"    },
  { n: 3, key: "elegant" }
];

function variantByNumber(n) {
  return VARIANTS.find(v => v.n === Number(n)) || null;
}

function briefFromLead(lead, { quality = "demo", variantStyle } = {}) {
  return {
    businessName:   lead.businessName,
    industry:       lead.industry,
    description:    lead.description,
    services:       lead.services,
    primaryColor:   lead.primaryColor,
    secondaryColor: lead.secondaryColor,
    // The client picks a style on the form, but the three-demo experience
    // ignores that — each variant has a fixed style override (minimal /
    // bold / elegant) so the three demos always feel distinct.
    style:          variantStyle || lead.style,
    variantStyle:   variantStyle || null,
    references:     lead.references,
    sections:       lead.sections,
    fullName:       lead.fullName,
    email:          lead.email,
    phone:          lead.phone,
    quality
  };
}

// Parse a stage label.
// Accepts "generate", "deploy", "send" (legacy, defaults variant=1) and
// the new colon/hyphen forms: "generate:2", "deploy-3", etc.
function parseStage(stageRaw) {
  if (typeof stageRaw !== "string") return null;
  const stage = stageRaw.trim().toLowerCase();
  if (!stage) return null;
  const match = stage.match(/^(generate|deploy|send)(?:[:\-_](\d+))?$/);
  if (!match) return null;
  const kind = match[1];
  const variant = kind === "send" ? null : (match[2] ? Number(match[2]) : 1);
  if (variant !== null && (!Number.isFinite(variant) || variant < 1 || variant > VARIANTS.length)) {
    return null;
  }
  return { kind, variant };
}

function stageLabel(kind, variant) {
  if (kind === "send") return "send";
  return `${kind}:${variant}`;
}

// Enqueue the next stage via Upstash QStash. QStash accepts the message and
// then delivers it to /api/cron from its own servers, so the receiving
// invocation looks like an external request to Vercel rather than the
// recursive self-invocation that triggers Vercel's HTTP 508 loop detection
// (which previously killed the chain after a few stages).
//
// Stage info is forwarded to /api/cron via Upstash-Forward-* headers so the
// downstream handler sees the same X-Trigger / X-Stage / X-Lead-Id headers
// it always has. Upstash-Delay spaces stages so two cron invocations for
// the same lead never overlap. Body is intentionally empty.
//
// Retry once on any non-2xx / network error. The runStage handler is
// idempotent (skips if previewUrls[N] is already set), so a duplicate
// QStash delivery cannot double-deploy. If QStash fails entirely, the
// hourly /api/cron safety net (findStuckForStage + resumeStageForLead)
// picks the lead up within ~70 minutes worst case.
async function triggerNextStage(stageRaw, leadId) {
  const qstashToken = (process.env.QSTASH_TOKEN || "").trim();
  if (!qstashToken) {
    console.error(`[process-lead] QSTASH_TOKEN not set; cannot enqueue stage=${stageRaw} lead=#${leadId}. Hourly cron will resume.`);
    return;
  }

  const headers = {
    "Authorization": `Bearer ${qstashToken}`,
    "Content-Type": "application/json",
    "Upstash-Delay": QSTASH_STAGE_DELAY,
    "Upstash-Forward-X-Trigger": "stage",
    "Upstash-Forward-X-Stage": stageRaw,
    "Upstash-Forward-X-Lead-Id": String(leadId)
  };
  if (process.env.CRON_SECRET) {
    headers["Upstash-Forward-Authorization"] = `Bearer ${process.env.CRON_SECRET}`;
  }

  const url = `${QSTASH_PUBLISH_BASE}/${CRON_TARGET_URL}`;

  async function attempt(label, timeoutMs) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: "",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QStash HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    console.log(`[process-lead] qstash enqueued stage=${stageRaw} lead=#${leadId} delay=${QSTASH_STAGE_DELAY}${label}`);
  }

  try {
    await attempt("", 4000);
    return;
  } catch (err) {
    console.warn(`[process-lead] qstash first attempt failed stage=${stageRaw} lead=#${leadId}:`, err?.message || err);
  }

  await new Promise(r => setTimeout(r, 600));
  try {
    await attempt(" (retry)", 6000);
  } catch (err) {
    console.error(`[process-lead] qstash retry failed stage=${stageRaw} lead=#${leadId}:`, err?.message || err);
    // The hourly cron safety net will pick this lead up via findStuckForStage
    // / resumeStageForLead within 70 minutes worst case.
  }
}

// STAGE: generate variant N. Stores html on the lead. Fires deploy:N.
async function processGenerateStage(lead, variantNumber) {
  const variant = variantByNumber(variantNumber);
  if (!variant) {
    const error = `unknown variant ${variantNumber}`;
    console.error(`[process-lead] generate lead=#${lead.id}: ${error}`);
    return { ok: false, leadId: lead.id, stage: `generate:${variantNumber}`, error };
  }

  console.log(`[process-lead] STAGE=generate:${variant.n} (${variant.key}) lead=#${lead.id} business="${lead.businessName}"`);

  await updateLead(lead.id, {
    status: STATUS.GENERATING,
    currentVariant: variant.n,
    lastError: null
  });

  let html;
  try {
    html = await generateHtml(briefFromLead(lead, { variantStyle: variant.key }));
  } catch (err) {
    console.error(`[process-lead] generate:${variant.n} failed lead=#${lead.id}:`, err?.message || err);
    await updateLead(lead.id, {
      status: STATUS.FAILED,
      lastError: `generate:${variant.n}: ${err?.message || String(err)}`
    });
    return { ok: false, leadId: lead.id, stage: `generate:${variant.n}`, error: err?.message || String(err) };
  }

  await updateLead(lead.id, {
    status: STATUS.HTML_READY,
    generatedHtmlCurrent: html,
    currentVariant: variant.n,
    lastError: null
  });
  console.log(`[process-lead] STAGE=generate:${variant.n} ok lead=#${lead.id} htmlLength=${html.length}`);

  await triggerNextStage(stageLabel("deploy", variant.n), lead.id);
  return { ok: true, leadId: lead.id, stage: `generate:${variant.n}` };
}

// STAGE: deploy variant N. Reads stored html, decorates with chooser bar
// (designNumber=N), ships to Vercel, records previewUrls[N], chains to
// the next stage (generate:N+1, or send when N === 3).
async function processDeployStage(lead, variantNumber) {
  const variant = variantByNumber(variantNumber);
  if (!variant) {
    const error = `unknown variant ${variantNumber}`;
    console.error(`[process-lead] deploy lead=#${lead.id}: ${error}`);
    return { ok: false, leadId: lead.id, stage: `deploy:${variantNumber}`, error };
  }

  console.log(`[process-lead] STAGE=deploy:${variant.n} lead=#${lead.id} business="${lead.businessName}"`);

  if (!lead.generatedHtmlCurrent) {
    const error = `no generatedHtmlCurrent for variant ${variant.n}; cannot deploy`;
    console.error(`[process-lead] STAGE=deploy:${variant.n} lead=#${lead.id}: ${error}`);
    await updateLead(lead.id, {
      status: STATUS.FAILED,
      lastError: `deploy:${variant.n}: ${error}`
    });
    return { ok: false, leadId: lead.id, stage: `deploy:${variant.n}`, error };
  }

  await updateLead(lead.id, {
    status: STATUS.DEPLOYING,
    currentVariant: variant.n,
    lastError: null
  });

  const decorated = decorateHtml(lead.generatedHtmlCurrent, {
    brief: briefFromLead(lead, { variantStyle: variant.key }),
    leadId: lead.id,
    designNumber: variant.n
  });

  let deployment;
  try {
    deployment = await deployToVercel({
      projectName: `${lead.businessName} v${variant.n}`,
      html: decorated
    });
  } catch (err) {
    console.error(`[process-lead] deploy:${variant.n} failed lead=#${lead.id}:`, err?.message || err);
    await updateLead(lead.id, {
      status: STATUS.FAILED,
      lastError: `deploy:${variant.n}: ${err?.message || String(err)}`
    });
    return { ok: false, leadId: lead.id, stage: `deploy:${variant.n}`, error: err?.message || String(err) };
  }

  const previewUrls = { ...(lead.previewUrls || {}), [String(variant.n)]: deployment.url };
  // Track the Vercel project name per variant so the cleanup sweep
  // (api/cron.js + lib/deploy.js#deleteVercelProject) can garbage-collect
  // the three demo projects once the lead is approved or older than 7 days.
  const demoProjectNames = {
    ...(lead.demoProjectNames || {}),
    [String(variant.n)]: deployment.projectName
  };
  const isLastVariant = variant.n === VARIANTS.length;

  const patch = {
    previewUrls,
    demoProjectNames,
    generatedHtmlCurrent: null,
    lastError: null
  };
  if (isLastVariant) {
    patch.status = STATUS.READY;
    patch.generatedAt = new Date().toISOString();
    // Keep previewUrl populated for backwards-compatible tooling (chatbot
    // lookup by businessId, manual link sharing, the legacy single-demo
    // notification copy).
    patch.previewUrl = previewUrls["1"] || deployment.url;
  } else {
    // Mid-pipeline: leave status at DEPLOYING. The next generate stage
    // will tick it to GENERATING when it starts.
    patch.status = STATUS.DEPLOYING;
  }

  await updateLead(lead.id, patch);
  console.log(`[process-lead] STAGE=deploy:${variant.n} ok lead=#${lead.id} url=${deployment.url}`);

  const nextStage = isLastVariant ? "send" : stageLabel("generate", variant.n + 1);
  await triggerNextStage(nextStage, lead.id);
  return { ok: true, leadId: lead.id, stage: `deploy:${variant.n}`, previewUrl: deployment.url };
}

// STAGE: send. Honours scheduledSendAt for delayed delivery. Sends one
// email containing all three demo URLs.
async function processSendStage(lead) {
  console.log(`[process-lead] STAGE=send lead=#${lead.id} business="${lead.businessName}"`);

  const urls = collectPreviewUrls(lead);
  if (urls.length < VARIANTS.length) {
    const error = `expected ${VARIANTS.length} previewUrls, found ${urls.length}; cannot send`;
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
      previewUrls: urls,
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

// Stable, ordered array of demo URLs. Strict [1, 2, 3] order so the email
// always labels them consistently.
function collectPreviewUrls(lead) {
  const map = lead?.previewUrls || {};
  const out = [];
  for (const v of VARIANTS) {
    const url = map[String(v.n)];
    if (url) out.push({ designNumber: v.n, key: v.key, url });
  }
  return out;
}

// Idempotency: figure out which stage a stuck/restarted lead should
// resume. Reads previewUrls + status and returns the stage label to fire.
function resumeStageForLead(lead) {
  if (!lead) return null;
  if (lead.status === STATUS.SENT || lead.status === STATUS.CHOSEN) return null;
  const urls = lead.previewUrls || {};
  for (const v of VARIANTS) {
    if (!urls[String(v.n)]) {
      // Variant N not yet deployed. If html is already staged for this
      // variant, resume at deploy:N; otherwise resume at generate:N.
      if (lead.generatedHtmlCurrent && Number(lead.currentVariant) === v.n) {
        return stageLabel("deploy", v.n);
      }
      return stageLabel("generate", v.n);
    }
  }
  // All three deployed but not sent. Resume at send.
  return "send";
}

// Hourly cron safety net: pick up a queued lead and start its chain.
async function processOneGeneration(lead) {
  return processGenerateStage(lead, 1);
}

// Hourly cron safety net: any READY lead whose scheduledSendAt has arrived.
async function processOneSend(lead) {
  return processSendStage(lead);
}

// Dispatched directly by the X-Stage trigger from api/cron.js.
async function runStage(stageRaw, leadId) {
  const parsed = parseStage(stageRaw);
  if (!parsed) return { ok: false, leadId, stage: stageRaw, error: `unknown stage: ${stageRaw}` };

  const lead = await getLead(leadId);
  if (!lead) return { ok: false, leadId, stage: stageRaw, error: "lead not found" };

  if (parsed.kind === "generate") {
    // Idempotency: skip if this variant already has a deployed URL.
    if (lead.previewUrls && lead.previewUrls[String(parsed.variant)]) {
      console.log(`[process-lead] runStage=generate:${parsed.variant} skipping lead=#${leadId} already deployed`);
      const next = resumeStageForLead(lead);
      if (next) await triggerNextStage(next, leadId);
      return { ok: true, leadId, stage: stageRaw, skipped: true };
    }
    return processGenerateStage(lead, parsed.variant);
  }

  if (parsed.kind === "deploy") {
    if (lead.previewUrls && lead.previewUrls[String(parsed.variant)]) {
      console.log(`[process-lead] runStage=deploy:${parsed.variant} skipping lead=#${leadId} already deployed`);
      const next = resumeStageForLead(lead);
      if (next) await triggerNextStage(next, leadId);
      return { ok: true, leadId, stage: stageRaw, skipped: true };
    }
    return processDeployStage(lead, parsed.variant);
  }

  if (parsed.kind === "send") {
    if (lead.status === STATUS.SENT || lead.status === STATUS.CHOSEN) {
      console.log(`[process-lead] runStage=send skipping lead=#${leadId} status=${lead.status}`);
      return { ok: true, leadId, stage: "send", skipped: true };
    }
    return processSendStage(lead);
  }

  return { ok: false, leadId, stage: stageRaw, error: `unknown stage kind: ${parsed.kind}` };
}

// Backwards-compatible entry used by the legacy X-Trigger=generate path:
// starts the chain at generate:1. Subsequent stages run in their own
// cron invocations via triggerNextStage.
async function processLeadEndToEnd(leadId) {
  const lead = await getLead(leadId);
  if (!lead) return { ok: false, leadId, error: "lead not found" };
  if (lead.status !== STATUS.QUEUED) {
    return { ok: true, leadId, skipped: true, status: lead.status };
  }
  return processGenerateStage(lead, 1);
}

module.exports = {
  processGenerateStage,
  processDeployStage,
  processSendStage,
  processOneGeneration,
  processOneSend,
  processLeadEndToEnd,
  runStage,
  triggerNextStage,
  resumeStageForLead,
  parseStage,
  stageLabel,
  VARIANTS
};
