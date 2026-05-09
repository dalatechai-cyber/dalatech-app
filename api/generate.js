"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt, buildUserPrompt } = require("../lib/prompt");
const { deployToVercel } = require("../lib/deploy");
const { sendClientEmail, sendLeadNotification } = require("../lib/email");
const { sendTelegramNotification } = require("../lib/telegram");

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

function buildMailtoUrl({ businessName, fullName, phone, email, previewUrl }) {
  const subject = `Бүрэн вэбсайт захиалах - ${businessName || ""}`;
  const body = [
    `Демо вэбсайт: ${previewUrl}`,
    `Бизнесийн нэр: ${businessName || ""}`,
    `Холбоо барих: ${phone || ""} | ${email || ""}`,
    `Хүсэлт гаргасан: ${fullName || ""}`
  ].join("\n");
  const params = new URLSearchParams({ subject, body });
  return `mailto:bilguunbilly0214@gmail.com?${params.toString()}`;
}

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function injectStickyCta(html, mailtoUrl) {
  const safeHref = escapeHtmlAttr(mailtoUrl);
  const cta = `
<style id="dalatech-cta-style">
  .dalatech-demo-cta {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 99999;
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    background: rgba(13, 20, 48, 0.94);
    color: #F0F4FF;
    border: 1px solid rgba(56, 189, 248, 0.4);
    border-radius: 999px;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.3;
    text-decoration: none;
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    box-shadow: 0 16px 40px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(56,189,248,0.12) inset;
    transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1), border-color 200ms;
    max-width: calc(100vw - 24px);
    white-space: nowrap;
  }
  .dalatech-demo-cta-prompt { color: rgba(240, 244, 255, 0.78); font-weight: 400; }
  .dalatech-demo-cta-arrow { color: #38BDF8; }
  .dalatech-demo-cta-action { font-weight: 600; }
  .dalatech-demo-cta:hover {
    transform: translateX(-50%) translateY(-2px);
    border-color: rgba(56, 189, 248, 0.65);
  }
  .dalatech-demo-cta:active { transform: translateX(-50%) scale(0.97); }
  @media (max-width: 540px) {
    .dalatech-demo-cta { font-size: 12.5px; padding: 11px 16px; gap: 8px; }
    .dalatech-demo-cta-prompt { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dalatech-demo-cta { transition: border-color 200ms; }
    .dalatech-demo-cta:hover { transform: translateX(-50%); }
  }
</style>
<a class="dalatech-demo-cta" href="${safeHref}" target="_blank" rel="noopener">
  <span class="dalatech-demo-cta-prompt">Энэ загварт дуртай юу?</span>
  <span class="dalatech-demo-cta-arrow" aria-hidden="true">→</span>
  <span class="dalatech-demo-cta-action">Бүрэн вэбсайт захиалах</span>
</a>
`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${cta}</body>`);
  }
  return `${html}\n${cta}`;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return bad(res, 405, "Method not allowed");
  }

  // Validate critical env keys up-front so we fail fast with a clear message.
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
    logo:           body.logo && body.logo.dataUrl ? body.logo : null
  };

  // Step 1: Generate HTML with Claude (hard requirement).
  let html;
  try {
    html = await generateHtml(brief);
  } catch (err) {
    console.error("[generate] Claude failed:", err?.message || err);
    return bad(res, 502, "AI generation failed. Please try again.");
  }

  // Step 2: Inject sticky CTA bar into the HTML before the first deploy.
  // We inject before deploy (not after) so we only deploy once.
  const placeholderUrl = "https://dalatech-demo.vercel.app";
  let htmlWithCta = injectStickyCta(html, buildMailtoUrl({
    businessName: brief.businessName,
    fullName:     brief.fullName,
    phone:        brief.phone,
    email:        brief.email,
    previewUrl:   placeholderUrl
  }));

  // Step 3: Deploy to Vercel (hard requirement).
  let deployment;
  try {
    deployment = await deployToVercel({
      projectName: brief.businessName,
      html: htmlWithCta
    });
  } catch (err) {
    console.error("[generate] Vercel deploy failed:", err?.message || err);
    return bad(res, 502, "Deployment failed. Please try again.");
  }
  let previewUrl = deployment.url;

  // Step 4: Re-deploy with the real preview URL substituted into the mailto.
  // This is best-effort; if it fails, the original deploy still works.
  try {
    const realCtaHtml = injectStickyCta(html, buildMailtoUrl({
      businessName: brief.businessName,
      fullName:     brief.fullName,
      phone:        brief.phone,
      email:        brief.email,
      previewUrl
    }));
    const redeploy = await deployToVercel({
      projectName: brief.businessName,
      html: realCtaHtml
    });
    if (redeploy?.url) {
      previewUrl = redeploy.url;
      deployment.url = redeploy.url;
      deployment.projectName = redeploy.projectName;
    }
  } catch (err) {
    console.error("[generate] CTA-aware redeploy failed (continuing with original):", err?.message || err);
  }

  // Step 5/6/7: Notifications. Each runs independently so one failure
  // does not block the others. Failures surface as warnings to the client.
  const warnings = [];

  const clientEmailPromise = sendClientEmail({
    to: brief.email,
    businessName: brief.businessName,
    fullName: brief.fullName,
    previewUrl
  }).catch(err => {
    console.error("[generate] client email failed:", err?.message || err);
    return { error: err?.message || "client email failed" };
  });

  const leadEmailPromise = sendLeadNotification({
    brief,
    previewUrl
  }).catch(err => {
    console.error("[generate] lead email failed:", err?.message || err);
    return { error: err?.message || "lead email failed" };
  });

  const telegramPromise = sendTelegramNotification({
    brief,
    previewUrl
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
