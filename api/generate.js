"use strict";

const { sendLeadNotification } = require("../lib/email");
const { sendTelegramNotification } = require("../lib/telegram");
const { createLead, STATUS, scheduledSendAtIso } = require("../lib/leads");

const CRON_TRIGGER_URL = "https://app.dalatech.online/api/cron";

const REQUIRED = [
  "businessName", "industry", "description", "services",
  "style", "fullName", "email", "phone"
];

const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const ALLOWED_ATTACHMENT_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain"
];

function bad(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function validateBody(body) {
  for (const key of REQUIRED) {
    if (!body[key] || String(body[key]).trim() === "") {
      return { status: 400, message: `Missing field: ${key}` };
    }
  }
  if (!Array.isArray(body.sections) || body.sections.length === 0) {
    return { status: 400, message: "Sections must include at least one" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return { status: 400, message: "Invalid email" };
  }

  if (body.logo) {
    if (typeof body.logo !== "object" || !body.logo.dataUrl) {
      return { status: 400, message: "Invalid logo payload" };
    }
    if (typeof body.logo.size === "number" && body.logo.size > MAX_LOGO_BYTES) {
      return { status: 413, message: "Logo exceeds 5 MB limit" };
    }
    if (body.logo.type && !ALLOWED_LOGO_TYPES.includes(body.logo.type)) {
      return { status: 415, message: "Logo must be PNG, JPEG, or WebP" };
    }
  }

  if (body.attachments) {
    if (!Array.isArray(body.attachments)) {
      return { status: 400, message: "Attachments must be an array" };
    }
    let totalBytes = 0;
    for (const att of body.attachments) {
      if (typeof att !== "object" || !att?.dataUrl) {
        return { status: 400, message: "Invalid attachment payload" };
      }
      if (typeof att.size === "number") {
        if (att.size > MAX_ATTACHMENT_BYTES) {
          return { status: 413, message: `Attachment "${att.name || "file"}" exceeds 10 MB limit` };
        }
        totalBytes += att.size;
      }
      if (att.type && !ALLOWED_ATTACHMENT_TYPES.includes(att.type)) {
        return { status: 415, message: `Attachment type "${att.type}" is not allowed` };
      }
    }
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return { status: 413, message: "Total attachments exceed 25 MB" };
    }
  }

  return null;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return bad(res, 405, "Method not allowed");
  }

  if (!process.env.ANTHROPIC_API_KEY) return bad(res, 500, "Server misconfigured: ANTHROPIC_API_KEY missing");
  if (!process.env.VERCEL_TOKEN) return bad(res, 500, "Server misconfigured: VERCEL_TOKEN missing");

  let body;
  try { body = await readJsonBody(req); }
  catch { return bad(res, 400, "Invalid JSON body"); }

  const validation = validateBody(body);
  if (validation) return bad(res, validation.status, validation.message);

  const brief = {
    businessName:   String(body.businessName).trim().slice(0, 120),
    industry:       String(body.industry).trim().slice(0, 40),
    description:    String(body.description).trim().slice(0, 2000),
    services:       String(body.services).trim().slice(0, 2000),
    primaryColor:   String(body.primaryColor || "#2563EB"),
    secondaryColor: String(body.secondaryColor || "#38BDF8"),
    style:          String(body.style).trim().slice(0, 40),
    references:     String(body.references || "").trim().slice(0, 400),
    sections:       (body.sections || []).map(String),
    fullName:       String(body.fullName).trim().slice(0, 120),
    email:          String(body.email).trim().slice(0, 200),
    phone:          String(body.phone).trim().slice(0, 60)
  };

  const now = new Date();
  const scheduledSendAt = scheduledSendAtIso(now);

  console.log(`[generate] queueing lead business="${brief.businessName}" industry=${brief.industry} email=${brief.email} sendAt=${scheduledSendAt}`);

  let lead;
  try {
    lead = await createLead({
      ...brief,
      status: STATUS.QUEUED,
      scheduledSendAt
    });
  } catch (err) {
    console.error("[generate] lead persistence failed:", err?.message || err);
    return bad(res, 500, "Could not save your submission. Please try again.");
  }

  // Trigger the cron function out-of-band so the long-running generation
  // runs inside its 300-second budget instead of this 30-second function.
  // X-Stage=generate + X-Lead-Id targets THIS lead explicitly (the legacy
  // X-Trigger=generate path looked up "most recent queued" which races when
  // submissions arrive close together). Each downstream stage (deploy,
  // send) gets its own fresh 300s cron invocation via the chain inside
  // lib/process-lead.js, so generation never starves deploy or send.
  const triggerHeaders = {
    "X-Trigger": "stage",
    "X-Stage": "generate",
    "X-Lead-Id": String(lead.id)
  };
  if (process.env.CRON_SECRET) {
    triggerHeaders["Authorization"] = `Bearer ${process.env.CRON_SECRET}`;
  }
  try {
    await fetch(CRON_TRIGGER_URL, {
      method: "POST",
      headers: triggerHeaders,
      signal: AbortSignal.timeout(2500)
    });
    console.log(`[generate] cron stage=generate trigger dispatched lead=#${lead.id}`);
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      console.log(`[generate] cron stage=generate trigger dispatched (no-wait) lead=#${lead.id}`);
    } else {
      console.error(`[generate] cron stage=generate trigger failed lead=#${lead.id}:`, err?.message || err);
    }
  }

  // Notifications MUST be awaited. Earlier versions used
  // `Promise.resolve().then(...)` without await — Vercel froze the function
  // runtime the moment `res.status(...).json(...)` ran, which terminated
  // every in-flight fetch (Telegram + Resend) before it received a response.
  // The logs showed `[telegram] -> sendMessage` and `[email] sending lead
  // notification` but never the response lines, and the next invocation
  // logged `fetch failed` as the orphaned promise rejected.
  //
  // Both calls are fast (sub-second under normal conditions), they fit
  // inside the 30s budget comfortably. allSettled so one failure doesn't
  // block the other.
  const briefForNotify = { ...brief, logo: body.logo ? { name: body.logo.name, type: body.logo.type } : null };
  const noteUrl = "(generating now, ready in ~15 min)";
  const notificationResults = await Promise.allSettled([
    sendTelegramNotification({ brief: briefForNotify, previewUrl: noteUrl, leadId: lead.id }),
    sendLeadNotification({ brief: briefForNotify, previewUrl: noteUrl, leadId: lead.id })
  ]);
  const [telegramResult, emailResult] = notificationResults;
  if (telegramResult.status === "fulfilled") {
    console.log(`[generate] telegram queued-notify ok lead=#${lead.id}`);
  } else {
    console.error(`[generate] telegram queued-notify failed lead=#${lead.id}:`, telegramResult.reason?.message || telegramResult.reason);
  }
  if (emailResult.status === "fulfilled") {
    console.log(`[generate] lead email queued-notify ok lead=#${lead.id}`);
  } else {
    console.error(`[generate] lead email queued-notify failed lead=#${lead.id}:`, emailResult.reason?.message || emailResult.reason);
  }

  return res.status(200).json({
    ok: true,
    queued: true,
    leadId: lead.id,
    scheduledSendAt
  });
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "30mb" }
  }
};
