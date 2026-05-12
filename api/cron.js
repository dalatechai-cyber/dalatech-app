"use strict";

const {
  processOneGeneration,
  processOneSend,
  processLeadEndToEnd,
  runStage,
  resumeStageForLead
} = require("../lib/process-lead");
const {
  findQueuedForGeneration,
  findDueForSend,
  findStuckForStage,
  findLeadsForDemoCleanup,
  listLeads,
  updateLead,
  STATUS
} = require("../lib/leads");
const { deleteVercelProject } = require("../lib/deploy");

const MAX_GENERATIONS_PER_RUN = 1;
const MAX_SENDS_PER_RUN = 5;
// Weekly demo cleanup. The cron fires hourly; the sweep filters leads to
// "older than 7 days" so the same hour-based schedule covers it. Cap how
// many we touch per run to keep latency predictable on the 300s budget
// (each delete is one Vercel API round-trip, ~1-3s).
const DEMO_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEMO_CLEANUP_LIMIT_PER_RUN = 5;

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (typeof auth === "string" && auth === `Bearer ${expected}`) return true;
  const alt = req.headers?.["x-vercel-cron-secret"];
  if (typeof alt === "string" && alt === expected) return true;
  return false;
}

function headerValue(req, name) {
  const raw = req.headers?.[name] ?? req.headers?.[name.toUpperCase()];
  return typeof raw === "string" ? raw : "";
}

function getTriggerHeader(req) {
  return headerValue(req, "x-trigger").toLowerCase();
}

async function findMostRecentQueued() {
  const leads = await listLeads();
  return leads
    .filter(l => l.status === STATUS.QUEUED)
    .sort((a, b) => Number(b.number) - Number(a.number))[0] || null;
}

// Resolve the resume stage for a stuck lead. The three-variant pipeline
// uses stage labels like "generate:2" / "deploy:3" / "send"; the helper
// reads previewUrls + status to figure out where the chain stalled.
function stageForStuckLead(lead) {
  return resumeStageForLead(lead);
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const trigger = getTriggerHeader(req);

  // Staged trigger: the previous stage fired this invocation with X-Stage
  // and X-Lead-Id. Each stage runs inside its own 300s cron budget.
  if (trigger === "stage") {
    const stage = headerValue(req, "x-stage").toLowerCase();
    const leadId = headerValue(req, "x-lead-id");
    if (!stage || !leadId) {
      console.error(`[cron] X-Trigger=stage missing X-Stage=${stage} or X-Lead-Id=${leadId}`);
      return res.status(400).json({ ok: false, error: "X-Stage and X-Lead-Id are required for staged trigger" });
    }
    console.log(`[cron] X-Trigger=stage stage=${stage} lead=#${leadId}`);
    const result = await runStage(stage, leadId);
    if (result?.ok) {
      console.log(`[cron] stage ok stage=${stage} lead=#${leadId} skipped=${!!result.skipped}`);
    } else {
      console.error(`[cron] stage failed stage=${stage} lead=#${leadId}:`, result?.error);
    }
    return res.status(200).json({ ok: true, triggered: "stage", stage, leadId, result });
  }

  // Legacy trigger from api/generate.js. Starts the staged chain at
  // "generate" — that stage's completion will self-trigger the next stage.
  if (trigger === "generate") {
    const lead = await findMostRecentQueued();
    if (!lead) {
      console.log("[cron] X-Trigger=generate but no queued lead found");
      return res.status(200).json({ ok: true, triggered: "generate", processed: null });
    }
    console.log(`[cron] X-Trigger=generate starting chain lead=#${lead.id} number=${lead.number}`);
    const result = await processLeadEndToEnd(lead.id);
    if (result?.ok) {
      console.log(`[cron] X-Trigger=generate chain started lead=#${lead.id} skipped=${!!result.skipped}`);
    } else {
      console.error(`[cron] X-Trigger=generate chain failed lead=#${lead.id}:`, result?.error);
    }
    return res.status(200).json({ ok: true, triggered: "generate", leadId: lead.id, result });
  }

  // Hourly cron / manual GET: safety net only. Pick up newly-queued leads
  // and re-trigger any lead stuck mid-chain. Each lead's processing happens
  // in its own staged trigger so this loop only needs to fire once.
  const generations = [];
  const stageResumes = [];
  const sends = [];

  const queued = await findQueuedForGeneration({ limit: MAX_GENERATIONS_PER_RUN });
  for (const lead of queued) {
    const result = await processOneGeneration(lead);
    generations.push(result);
  }

  // Resume leads stuck >10min in intermediate states (e.g. a stage trigger
  // never arrived, or generation crashed before chaining).
  const stuck = await findStuckForStage({ limit: 3 });
  for (const lead of stuck) {
    const stage = stageForStuckLead(lead);
    if (!stage) continue;
    console.log(`[cron] resuming stuck lead=#${lead.id} status=${lead.status} → stage=${stage}`);
    const result = await runStage(stage, lead.id);
    stageResumes.push(result);
  }

  const due = await findDueForSend({ limit: MAX_SENDS_PER_RUN });
  for (const lead of due) {
    const result = await processOneSend(lead);
    sends.push(result);
  }

  // Weekly demo-project cleanup sweep. Garbage-collects the three Vercel
  // demo projects for every lead that is sent/chosen/approved, has been
  // alive >7 days, and still has its demo project names recorded. The
  // approve flow in api/telegram.js handles fast cleanup at approval time;
  // this sweep covers leads that never reach #NNN finish (sent / chosen
  // only), so demos for inactive leads can never accumulate.
  const cleanups = [];
  try {
    const cleanable = await findLeadsForDemoCleanup({
      olderThanMs: DEMO_CLEANUP_AGE_MS,
      limit: DEMO_CLEANUP_LIMIT_PER_RUN
    });
    for (const lead of cleanable) {
      const summary = await sweepDemoProjects(lead);
      cleanups.push(summary);
    }
  } catch (err) {
    console.error("[cron] demo cleanup sweep error:", err?.message || err);
  }

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    generations,
    stageResumes,
    sends,
    cleanups
  });
}

// Delete all Vercel demo projects associated with a single lead, then
// mark the lead with the cleanup outcome. Matches the inline approve-time
// cleanup in api/telegram.js but is reached via the hourly cron instead.
async function sweepDemoProjects(lead) {
  const map = lead?.demoProjectNames || {};
  const slots = Object.keys(map).sort();
  const summary = {
    leadId: lead.id,
    status: lead.status,
    attempted: 0,
    deleted: 0,
    alreadyGone: 0,
    failed: []
  };
  for (const slot of slots) {
    const name = map[slot];
    if (!name) continue;
    summary.attempted += 1;
    try {
      const out = await deleteVercelProject(name);
      if (out.ok && out.alreadyGone) {
        summary.alreadyGone += 1;
        console.log(`[cron] sweep #${lead.id} demo project ${name} (slot ${slot}) already gone`);
      } else if (out.ok) {
        summary.deleted += 1;
        console.log(`[cron] sweep #${lead.id} demo project ${name} (slot ${slot}) deleted (${out.status})`);
      } else {
        summary.failed.push({ slot, name, error: out.error || `HTTP ${out.status}` });
        console.warn(`[cron] sweep #${lead.id} demo project ${name} (slot ${slot}) delete failed:`, out.error);
      }
    } catch (err) {
      summary.failed.push({ slot, name, error: err?.message || String(err) });
      console.error(`[cron] sweep #${lead.id} demo project ${name} delete threw:`, err?.message || err);
    }
  }
  const fullySucceeded = summary.attempted > 0 && summary.failed.length === 0;
  try {
    await updateLead(lead.id, {
      demoDeleted: fullySucceeded,
      demoCleanupAt: new Date().toISOString(),
      demoCleanupSummary: summary
    });
  } catch (err) {
    console.error(`[cron] sweep #${lead.id} updateLead failed:`, err?.message || err);
  }
  return summary;
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
