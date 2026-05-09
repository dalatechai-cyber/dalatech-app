"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt, buildUserPrompt } = require("../lib/prompt");
const { deployToVercel } = require("../lib/deploy");
const { sendClientEmail, sendLeadNotification } = require("../lib/email");

const REQUIRED = [
  "businessName", "industry", "description", "services",
  "style", "fullName", "email", "phone"
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

function validate(body) {
  for (const key of REQUIRED) {
    if (!body[key] || String(body[key]).trim() === "") {
      return `Missing field: ${key}`;
    }
  }
  if (!Array.isArray(body.sections) || body.sections.length === 0) {
    return "Sections must include at least one";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return "Invalid email";
  }
  if (body.logo && body.logo.dataUrl && body.logo.dataUrl.length > 8 * 1024 * 1024) {
    return "Logo too large";
  }
  return null;
}

function extractHtml(text) {
  if (!text) return "";
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.search(/<!doctype\s+html|<html\b/i);
  if (start >= 0) return candidate.slice(start).trim();
  return candidate;
}

async function generateHtml(brief) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    system: buildSystemPrompt(),
    messages: [
      { role: "user", content: buildUserPrompt(brief) }
    ]
  });

  const text = (message.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  const html = extractHtml(text);
  if (!html || !/<html/i.test(html)) {
    throw new Error("Claude did not return valid HTML");
  }
  return html;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return bad(res, 405, "Method not allowed");
  }

  let body;
  try { body = await readJsonBody(req); }
  catch { return bad(res, 400, "Invalid JSON body"); }

  const validationError = validate(body);
  if (validationError) return bad(res, 400, validationError);

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
    logo:           body.logo && body.logo.dataUrl ? body.logo : null
  };

  try {
    const html = await generateHtml(brief);

    const deployment = await deployToVercel({
      projectName: brief.businessName,
      html
    });
    const previewUrl = deployment.url;

    const clientEmailPromise = sendClientEmail({
      to: brief.email,
      businessName: brief.businessName,
      fullName: brief.fullName,
      previewUrl
    }).catch(err => ({ error: err.message }));

    const leadEmailPromise = sendLeadNotification({
      brief,
      previewUrl
    }).catch(err => ({ error: err.message }));

    const [clientResult, leadResult] = await Promise.all([
      clientEmailPromise,
      leadEmailPromise
    ]);

    const warnings = [];
    if (clientResult && clientResult.error) warnings.push(`client email: ${clientResult.error}`);
    if (leadResult && leadResult.error) warnings.push(`lead email: ${leadResult.error}`);

    return res.status(200).json({
      ok: true,
      previewUrl,
      projectName: deployment.projectName,
      warnings: warnings.length ? warnings : undefined
    });
  } catch (err) {
    console.error("generate error:", err);
    return bad(res, 500, err?.message || "Internal error");
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "10mb" }
  }
};
