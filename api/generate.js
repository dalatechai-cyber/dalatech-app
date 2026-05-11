"use strict";

const { runPipeline } = require("../lib/pipeline");
const { sendClientEmail, sendLeadNotification } = require("../lib/email");
const { sendTelegramNotification } = require("../lib/telegram");
const { createLead } = require("../lib/leads");

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
    phone:          String(body.phone).trim().slice(0, 60),
    logo:           body.logo && body.logo.dataUrl ? body.logo : null,
    quality:        "demo"
  };

  console.log(`[generate] new request business="${brief.businessName}" industry=${brief.industry} email=${brief.email}`);

  let pipelineResult;
  try {
    pipelineResult = await runPipeline({ brief });
  } catch (err) {
    console.error("[generate] pipeline failed:", err?.message || err);
    const msg = err?.message || "";
    if (msg.includes("Claude") || msg.includes("HTML")) return bad(res, 502, "AI generation failed. Please try again.");
    if (msg.includes("Vercel")) return bad(res, 502, "Deployment failed. Please try again.");
    return bad(res, 502, "Pipeline failed. Please try again.");
  }

  const { previewUrl, deployment } = pipelineResult;

  let lead = null;
  try {
    lead = createLead({
      businessName: brief.businessName,
      industry: brief.industry,
      description: brief.description,
      services: brief.services,
      primaryColor: brief.primaryColor,
      secondaryColor: brief.secondaryColor,
      style: brief.style,
      references: brief.references,
      sections: brief.sections,
      fullName: brief.fullName,
      email: brief.email,
      phone: brief.phone,
      previewUrl,
      projectName: deployment.projectName
    });
    console.log(`[generate] persisted lead #${lead.id}`);
  } catch (err) {
    console.error("[generate] lead persistence failed:", err?.message || err);
  }

  const leadId = lead?.id || null;
  const warnings = [];

  const clientEmailPromise = sendClientEmail({
    to: brief.email,
    businessName: brief.businessName,
    fullName: brief.fullName,
    previewUrl,
    mode: "demo"
  }).then(r => {
    console.log("[generate] client email ok");
    return r;
  }).catch(err => {
    console.error("[generate] client email failed:", err?.message || err);
    return { error: err?.message || "client email failed" };
  });

  const leadEmailPromise = sendLeadNotification({
    brief,
    previewUrl,
    leadId
  }).then(r => {
    console.log("[generate] lead email ok");
    return r;
  }).catch(err => {
    console.error("[generate] lead email failed:", err?.message || err);
    return { error: err?.message || "lead email failed" };
  });

  const telegramPromise = sendTelegramNotification({
    brief,
    previewUrl,
    leadId
  }).then(r => {
    console.log(`[generate] telegram ok leadId=#${leadId || "?"}`);
    return r;
  }).catch(err => {
    console.error("[generate] telegram failed:", err?.message || err);
    return { error: err?.message || "telegram failed" };
  });

  const [clientResult, leadResult, telegramResult] = await Promise.all([
    clientEmailPromise,
    leadEmailPromise,
    telegramPromise
  ]);

  if (clientResult && clientResult.error) warnings.push(`client email: ${clientResult.error}`);
  if (leadResult && leadResult.error) warnings.push(`lead email: ${leadResult.error}`);
  if (telegramResult && telegramResult.error) warnings.push(`telegram: ${telegramResult.error}`);

  return res.status(200).json({
    ok: true,
    previewUrl,
    projectName: deployment.projectName,
    leadId,
    warnings: warnings.length ? warnings : undefined
  });
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "30mb" }
  }
};
