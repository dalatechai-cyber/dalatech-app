"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt, buildUserPrompt } = require("./prompt");
const { deployToVercel } = require("./deploy");

function extractHtml(text) {
  if (!text) return "";
  let candidate = text.trim();

  // Strip a single surrounding markdown fence if present.
  const fence = candidate.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  // Find the start of the HTML document.
  const startMatch = candidate.match(/<!doctype\s+html|<html\b/i);
  if (startMatch && startMatch.index !== undefined && startMatch.index > 0) {
    candidate = candidate.slice(startMatch.index);
  }

  // Trim anything after </html>. This is the critical fix: Claude often
  // appends trailing commentary, CSS snippets, or sign-offs that the browser
  // would render as visible text after the document closes.
  const endIdx = candidate.search(/<\/html\s*>/i);
  if (endIdx >= 0) {
    const tagMatch = candidate.slice(endIdx).match(/<\/html\s*>/i);
    const tagLen = tagMatch ? tagMatch[0].length : "</html>".length;
    candidate = candidate.slice(0, endIdx + tagLen);
  }

  return candidate.trim();
}

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  return `mailto:dalatech.ai@gmail.com?${params.toString()}`;
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
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${cta}\n</body>`);
  }
  if (/<\/html\s*>/i.test(html)) {
    return html.replace(/<\/html\s*>/i, `${cta}\n</html>`);
  }
  return `${html}\n${cta}`;
}

async function generateHtml(brief) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const isProduction = brief.quality === "production";
  const client = new Anthropic({ apiKey });
  console.log(`[pipeline] generateHtml quality=${brief.quality || "demo"} business=${brief.businessName}`);

  const message = await client.messages.create(
    {
      model: "claude-sonnet-4-6",
      max_tokens: isProduction ? 32000 : 16000,
      system: buildSystemPrompt(),
      messages: [
        { role: "user", content: buildUserPrompt(brief) }
      ]
    },
    { timeout: isProduction ? 480000 : 240000 }
  );

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

async function runPipeline({ brief, previewUrlPlaceholder }) {
  const placeholder = previewUrlPlaceholder || "https://dalatech-demo.vercel.app";

  const html = await generateHtml(brief);

  const ctaHtml = injectStickyCta(html, buildMailtoUrl({
    businessName: brief.businessName,
    fullName:     brief.fullName,
    phone:        brief.phone,
    email:        brief.email,
    previewUrl:   placeholder
  }));

  const deployment = await deployToVercel({
    projectName: brief.businessName,
    html: ctaHtml
  });

  let previewUrl = deployment.url;

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
    console.error("[pipeline] CTA-aware redeploy failed (continuing with original):", err?.message || err);
  }

  return { html, previewUrl, deployment };
}

module.exports = {
  runPipeline,
  generateHtml,
  injectStickyCta,
  buildMailtoUrl,
  extractHtml
};
