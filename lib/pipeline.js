"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt, buildUserPrompt } = require("./prompt");
const { deployToVercel } = require("./deploy");
const { injectChatbot } = require("./chatbot-widget");
const { injectChooserBar } = require("./chooser-bar");

function extractHtml(text) {
  if (!text) return "";
  let candidate = text.trim();

  const fence = candidate.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  const startMatch = candidate.match(/<!doctype\s+html|<html\b/i);
  if (startMatch && startMatch.index !== undefined && startMatch.index > 0) {
    candidate = candidate.slice(startMatch.index);
  }

  const endIdx = candidate.search(/<\/html\s*>/i);
  if (endIdx >= 0) {
    const tagMatch = candidate.slice(endIdx).match(/<\/html\s*>/i);
    const tagLen = tagMatch ? tagMatch[0].length : "</html>".length;
    candidate = candidate.slice(0, endIdx + tagLen);
  }

  return candidate.trim();
}

// Defensive safety net for the blank-page bug. If Claude's inline
// IntersectionObserver throws, [data-reveal] elements would stay invisible
// forever. We invert the pattern: reveals are visible by default, and only
// hidden once a `dt-js` class is added to <html> by a tiny try/catch script.
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

async function generateHtml(brief) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const isProduction = brief.quality === "production";
  const client = new Anthropic({ apiKey });
  console.log(`[pipeline] generateHtml quality=${brief.quality || "demo"} variant=${brief.variantStyle || brief.style} business=${brief.businessName} model=claude-sonnet-4-6`);

  // Sonnet 4.6 in its own 300s cron invocation. 280s timeout gives Sonnet
  // room for an animation-rich, copy-rich, full-document response.
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
// chatbot widget, and the sticky DalaTech chooser bar. Pure transform.
//
// designNumber (1 | 2 | 3) labels which of the three demo variants this HTML
// represents. It surfaces in the chooser bar UI and is sent to /api/choice
// when the visitor picks this design.
function decorateHtml(html, { brief, leadId, designNumber, skipChatbot } = {}) {
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

  const choiceEndpoint = process.env.CHOICE_ENDPOINT_URL || "https://app.dalatech.online/api/choice";
  out = injectChooserBar(out, {
    leadId: leadId || null,
    designNumber: designNumber || 1,
    businessName: brief.businessName,
    choiceEndpoint
  });

  return out;
}

// Used by the Telegram production-finish flow (a single 300s invocation
// that runs both stages inline). The production flow produces one final
// website, not a demo set, so designNumber defaults to 1.
async function runPipeline({ brief, leadId, skipChatbot, designNumber }) {
  const html = await generateHtml(brief);
  const decorated = decorateHtml(html, {
    brief,
    leadId,
    skipChatbot,
    designNumber: designNumber || 1
  });
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
  extractHtml,
  ensureFallbackVisibility
};
