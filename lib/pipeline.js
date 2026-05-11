"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt, buildUserPrompt } = require("./prompt");
const { deployToVercel } = require("./deploy");
const { reviewAndFixHtml } = require("./quality-review");
const { injectChatbot } = require("./chatbot-widget");

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

// Defensive safety net for Problem 1 (blank-page bug).
// If Claude's inline IntersectionObserver script throws (a malformed SVG path,
// a syntax error elsewhere, or a missing element), every [data-reveal] element
// stays at opacity: 0 forever and the page renders blank white. We invert the
// pattern: reveal elements are visible by default, and only hidden when the
// `dt-js` class is on <html>. A tiny try/catch script adds that class; if it
// fails the class never gets added and content stays visible.
function ensureFallbackVisibility(html) {
  if (!html) return html;
  const safety = `
<style id="dt-safety-style">
  html.dt-js [data-reveal] { opacity: 0; transform: translateY(12px); transition: opacity 600ms cubic-bezier(0.23, 1, 0.32, 1), transform 600ms cubic-bezier(0.23, 1, 0.32, 1); }
  html.dt-js [data-reveal].is-in { opacity: 1; transform: translateY(0); }
  html:not(.dt-js) [data-reveal] { opacity: 1 !important; transform: none !important; }
</style>
<script id="dt-safety-script">
  try { document.documentElement.classList.add('dt-js'); } catch (e) {}
</script>
`;
  if (/<\/head\s*>/i.test(html)) {
    return html.replace(/<\/head\s*>/i, `${safety}\n</head>`);
  }
  return `${safety}\n${html}`;
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

function escapeJsString(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, "\\n")
    .replace(/<\/script/gi, "<\\/script");
}

// Build the sticky "Order full website" CTA. The mailto href is composed on
// the client at click time from window.location.href, so a single deploy
// produces a CTA that references its own URL. This eliminates the previous
// double-deploy step (placeholder deploy, then redeploy with the real URL
// baked in) and gives the deploy stage its full time budget.
function injectStickyCta(html, brief) {
  const { businessName, fullName, phone, email } = brief || {};
  const jsBiz = escapeJsString(businessName);
  const jsName = escapeJsString(fullName);
  const jsPhone = escapeJsString(phone);
  const jsEmail = escapeJsString(email);
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
    transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1), border-color 200ms cubic-bezier(0.23, 1, 0.32, 1);
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
<a class="dalatech-demo-cta" id="dalatech-demo-cta" href="mailto:dalatech.ai@gmail.com" target="_blank" rel="noopener" data-dt-cta>
  <span class="dalatech-demo-cta-prompt">Энэ загварт дуртай юу?</span>
  <span class="dalatech-demo-cta-arrow" aria-hidden="true">→</span>
  <span class="dalatech-demo-cta-action">Бүрэн вэбсайт захиалах</span>
</a>
<script id="dalatech-cta-script" data-dt-cta>
(function(){
  try {
    var biz = '${jsBiz}';
    var fn = '${jsName}';
    var phone = '${jsPhone}';
    var email = '${jsEmail}';
    function build() {
      var url = (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href : '';
      var subject = 'Бүрэн вэбсайт захиалах - ' + biz;
      var body = 'Демо вэбсайт: ' + url + '\\n' +
                 'Бизнесийн нэр: ' + biz + '\\n' +
                 'Холбоо барих: ' + phone + ' | ' + email + '\\n' +
                 'Хүсэлт гаргасан: ' + fn;
      return 'mailto:dalatech.ai@gmail.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    }
    var el = document.getElementById('dalatech-demo-cta');
    if (el) {
      el.setAttribute('href', build());
      el.addEventListener('click', function(){ el.setAttribute('href', build()); }, true);
    }
  } catch (e) {}
})();
</script>
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
  console.log(`[pipeline] generateHtml quality=${brief.quality || "demo"} business=${brief.businessName} model=claude-sonnet-4-6`);

  // Sonnet 4.6 is the quality bar the brief requires. Generation now runs in
  // its own cron invocation (300s budget), so we give the API call up to
  // 280s and let Sonnet take the time it needs to produce a real,
  // animation-rich, copy-rich page.
  const message = await client.messages.create(
    {
      model: "claude-sonnet-4-6",
      max_tokens: isProduction ? 32000 : 24000,
      system: buildSystemPrompt(),
      messages: [
        { role: "user", content: buildUserPrompt(brief) }
      ]
    },
    { timeout: isProduction ? 480000 : 280000 }
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

// Wrap a raw generated HTML document with the safety reveal styles, the
// chatbot widget, and the sticky CTA. Pure transform: no network calls.
function decorateHtml(html, { brief, leadId, skipChatbot } = {}) {
  let out = ensureFallbackVisibility(html);

  if (!skipChatbot) {
    const chatEndpoint = process.env.CHAT_ENDPOINT_URL || "https://app.dalatech.online/api/chat";
    out = injectChatbot(out, {
      leadId: leadId || null,
      businessName: brief.businessName,
      primaryColor: brief.primaryColor,
      secondaryColor: brief.secondaryColor,
      chatEndpoint
    });
  }

  out = injectStickyCta(out, {
    businessName: brief.businessName,
    fullName: brief.fullName,
    phone: brief.phone,
    email: brief.email
  });

  return out;
}

// Used by the Telegram production-finish flow (a single 300s invocation that
// runs both stages inline). The hourly cron and the staged trigger from
// api/generate.js use the split processGenerateStage / processDeployStage
// helpers in lib/process-lead.js instead.
async function runPipeline({ brief, leadId, skipChatbot }) {
  const html = await generateHtml(brief);
  const decorated = decorateHtml(html, { brief, leadId, skipChatbot });
  const deployment = await deployToVercel({
    projectName: brief.businessName,
    html: decorated
  });
  return { html, previewUrl: deployment.url, deployment };
}

module.exports = {
  runPipeline,
  generateHtml,
  decorateHtml,
  injectStickyCta,
  buildMailtoUrl,
  extractHtml,
  ensureFallbackVisibility
};
