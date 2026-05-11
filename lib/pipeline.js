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

  return repairTruncatedHtml(candidate.trim());
}

// Anthropic occasionally truncates responses when max_tokens is reached
// mid-document. Lead #004 V3 cut off inside an IntersectionObserver options
// literal, leaving the inline <script> unclosed. The chatbot widget then
// injected its own <style>/<div>/<script> after the unterminated script,
// and the browser parsed the widget's CSS+HTML as JavaScript until it hit
// the widget's own </script>. Result: "Uncaught SyntaxError: Unexpected
// token '<'", page script dead, reveal animations stuck at opacity 0, and
// the chatbot launcher orphaned. This helper closes any tag the model
// failed to close so downstream injection sites can rely on `</body>`
// existing.
function repairTruncatedHtml(html) {
  if (!html) return html;
  let out = html;

  const stripComments = out.replace(/<!--[\s\S]*?-->/g, "");
  const openScripts = (stripComments.match(/<script\b[^>]*>/gi) || []).length;
  const closeScripts = (stripComments.match(/<\/script\s*>/gi) || []).length;
  if (openScripts > closeScripts) {
    out = out + "\n</script>".repeat(openScripts - closeScripts);
  }
  const openStyles = (stripComments.match(/<style\b[^>]*>/gi) || []).length;
  const closeStyles = (stripComments.match(/<\/style\s*>/gi) || []).length;
  if (openStyles > closeStyles) {
    out = out + "\n</style>".repeat(openStyles - closeStyles);
  }

  if (!/<\/body\s*>/i.test(out)) out += "\n</body>";
  if (!/<\/html\s*>/i.test(out)) out += "\n</html>";

  return out;
}

// Defensive safety net for the blank-page bug. Two layers:
//   1. A <style> in <head> hides [data-reveal] only when html.dt-js is set,
//      so if no JavaScript runs at all (e.g. CSP failure), the page is
//      readable.
//   2. A <script> just before </body> acts as a backstop: 1.4 seconds
//      after load, every [data-reveal] that still lacks `is-in` gets it.
//      Working IntersectionObservers fire well within that window for
//      above-fold content; if Claude's site script syntax-errored (lead
//      #004 V3, 2026-05-11), the backstop still uncovers the page.
function ensureFallbackVisibility(html) {
  if (!html) return html;
  const headSafety = `
<style id="dt-safety-style">
  html.dt-js [data-reveal] { opacity: 0; transform: translateY(12px); transition: opacity 600ms cubic-bezier(0.23, 1, 0.32, 1), transform 600ms cubic-bezier(0.23, 1, 0.32, 1); }
  html.dt-js [data-reveal].is-in { opacity: 1; transform: translateY(0); }
  html:not(.dt-js) [data-reveal] { opacity: 1 !important; transform: none !important; }
</style>
<script id="dt-safety-script">
  try { document.documentElement.classList.add('dt-js'); } catch (e) {}
</script>
`;
  const bodySafety = `
<script id="dt-reveal-backstop">
  (function(){
    try {
      var run = function(){
        var els = document.querySelectorAll('[data-reveal]:not(.is-in)');
        for (var i = 0; i < els.length; i++) els[i].classList.add('is-in');
      };
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(run, 1400);
      } else {
        window.addEventListener('load', function(){ setTimeout(run, 1400); });
      }
    } catch (e) {}
  })();
</script>
`;

  let out = html;
  if (/<\/head\s*>/i.test(out)) {
    out = out.replace(/<\/head\s*>/i, `${headSafety}\n</head>`);
  } else {
    out = `${headSafety}\n${out}`;
  }
  if (/<\/body\s*>/i.test(out)) {
    out = out.replace(/<\/body\s*>/i, `${bodySafety}\n</body>`);
  } else {
    out = `${out}\n${bodySafety}`;
  }
  return out;
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
      max_tokens: isProduction ? 40000 : 32000,
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

  if (message.stop_reason === "max_tokens") {
    console.warn(`[pipeline] WARNING: stop_reason=max_tokens for business=${brief.businessName} variant=${brief.variantStyle || brief.style}. HTML will be repaired but quality may be degraded.`);
  }

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
  ensureFallbackVisibility,
  repairTruncatedHtml
};
