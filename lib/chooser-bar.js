"use strict";

// Sticky DalaTech chooser bar injected into every generated demo.
// Replaces the older "Энэ загварт дуртай юу?" mailto CTA. Each of the three
// demos (variants 1/2/3) shows the same component but with its own design
// number. Clicking "Энэ загварыг сонгох" POSTs to /api/choice and reveals an
// inline confirmation overlay. The bar is rendered with DalaTech's own
// palette (not the demo's brand colors) so the chooser experience stays
// consistent across all three variants.

function escapeJsString(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")
    .replace(/<\/script/gi, "<\\/script");
}

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildChooserBar({ leadId, designNumber, businessName, choiceEndpoint }) {
  const num = Number(designNumber);
  if (!Number.isFinite(num) || num < 1 || num > 9) {
    throw new Error("designNumber must be a small positive integer");
  }
  const safeLead = escapeJsString(leadId || "");
  const safeNum = String(num);
  const safeBizJs = escapeJsString(businessName || "");
  const safeBizText = escapeHtmlText(businessName || "");
  const safeEndpoint = escapeJsString(choiceEndpoint || "https://app.dalatech.online/api/choice");
  const safeIdText = leadId ? `#${escapeHtmlText(String(leadId))}` : "";

  const css = `
<style id="dalatech-chooser-style" data-dt-chooser>
  :root { --dalatech-chooser-height: 68px; }
  body { padding-bottom: var(--dalatech-chooser-height) !important; }
  .dalatech-chooser {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    z-index: 2147483600;
    background: rgba(13, 20, 48, 0.94);
    color: #F0F4FF;
    border-top: 1px solid rgba(56, 189, 248, 0.22);
    box-shadow: 0 -20px 48px -24px rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    transform: translateY(100%);
    opacity: 0;
    transition: transform 320ms cubic-bezier(0.23, 1, 0.32, 1), opacity 320ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  .dalatech-chooser[data-in="true"] { transform: translateY(0); opacity: 1; }
  .dalatech-chooser-inner {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 12px 22px;
    min-height: var(--dalatech-chooser-height);
    max-width: 1180px;
    margin: 0 auto;
  }
  .dalatech-chooser-meta {
    display: inline-flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .dalatech-chooser-tag {
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(240, 244, 255, 0.55);
    font-weight: 600;
  }
  .dalatech-chooser-num {
    font-size: 22px;
    line-height: 1;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: #F0F4FF;
    font-feature-settings: "tnum";
  }
  .dalatech-chooser-divider {
    width: 1px;
    height: 18px;
    background: rgba(240, 244, 255, 0.18);
    display: inline-block;
    align-self: center;
    margin: 0 2px;
  }
  .dalatech-chooser-name {
    font-size: 13px;
    color: rgba(240, 244, 255, 0.72);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    max-width: 100%;
  }
  .dalatech-chooser-cta {
    appearance: none;
    border: 0;
    margin: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 22px;
    border-radius: 999px;
    background: #38BDF8;
    color: #0B1226;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.005em;
    line-height: 1;
    box-shadow: 0 12px 28px -10px rgba(56, 189, 248, 0.55);
    transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background-color 200ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1);
    flex-shrink: 0;
  }
  .dalatech-chooser-cta:hover {
    background: #7DD3FC;
    box-shadow: 0 16px 36px -12px rgba(125, 211, 252, 0.65);
  }
  .dalatech-chooser-cta:active { transform: scale(0.97); }
  .dalatech-chooser-cta:focus-visible { outline: 2px solid #7DD3FC; outline-offset: 3px; }
  .dalatech-chooser-cta:disabled {
    opacity: 0.72;
    cursor: progress;
    transform: none;
  }
  .dalatech-chooser-cta-arrow {
    transform: translateY(0);
    transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  .dalatech-chooser-cta:hover .dalatech-chooser-cta-arrow { transform: translateX(2px); }

  @media (max-width: 640px) {
    .dalatech-chooser-inner { padding: 10px 14px; gap: 10px; min-height: 60px; }
    .dalatech-chooser-name { display: none; }
    .dalatech-chooser-divider { display: none; }
    .dalatech-chooser-cta { padding: 11px 16px; font-size: 13px; }
    .dalatech-chooser-num { font-size: 19px; }
    :root { --dalatech-chooser-height: 60px; }
  }

  /* Lift the chatbot launcher (injected by lib/chatbot-widget.js) above the
     chooser bar so the two never overlap. We override the widget's bottom
     offset here instead of editing the widget module itself. */
  .dt-bot-root { bottom: calc(var(--dalatech-chooser-height) + 16px) !important; }

  .dalatech-confirm {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    background: rgba(5, 10, 24, 0.78);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    /* The hidden HTML attribute on the markup applies via the UA rule
       [hidden] { display: none } at specificity (0,0,1,0), which the
       class selector .dalatech-confirm { display: flex } above ties
       and wins on author-vs-UA precedence. That left an invisible
       full-viewport overlay with z-index 2147483647 swallowing every
       click on the page (lead #005, 2026-05-12). Force-hide via
       visibility + pointer-events so the overlay never intercepts
       clicks until the visitor actually opens it. */
    visibility: hidden;
    pointer-events: none;
    opacity: 0;
    transition: opacity 240ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s linear 240ms;
    color: #F0F4FF;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .dalatech-confirm[data-open="true"] {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transition: opacity 240ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s linear 0s;
  }
  .dalatech-confirm-card {
    width: 100%;
    max-width: 460px;
    background: rgba(13, 20, 48, 0.96);
    border: 1px solid rgba(56, 189, 248, 0.22);
    border-radius: 22px;
    padding: 34px 30px 28px;
    box-shadow: 0 40px 80px -30px rgba(0, 0, 0, 0.65);
    text-align: left;
    transform: scale(0.96) translateY(8px);
    transition: transform 300ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  .dalatech-confirm[data-open="true"] .dalatech-confirm-card { transform: scale(1) translateY(0); }
  .dalatech-confirm-mark {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 700;
    color: #38BDF8;
    margin-bottom: 18px;
  }
  .dalatech-confirm-mark::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #38BDF8;
    box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.18);
  }
  .dalatech-confirm-title {
    margin: 0 0 12px;
    font-size: 22px;
    line-height: 1.25;
    letter-spacing: -0.015em;
    font-weight: 700;
    color: #F0F4FF;
  }
  .dalatech-confirm-body {
    margin: 0 0 14px;
    font-size: 15px;
    line-height: 1.6;
    color: rgba(240, 244, 255, 0.78);
  }
  .dalatech-confirm-sub {
    margin: 0;
    font-size: 12.5px;
    color: rgba(240, 244, 255, 0.5);
    letter-spacing: 0.01em;
  }

  @media (prefers-reduced-motion: reduce) {
    .dalatech-chooser,
    .dalatech-confirm,
    .dalatech-confirm-card,
    .dalatech-chooser-cta,
    .dalatech-chooser-cta-arrow {
      transition: opacity 180ms linear;
      transform: none !important;
    }
  }
</style>
`.trim();

  const markup = `
<aside class="dalatech-chooser" data-dt-chooser data-design-number="${safeNum}" data-lead-id="${escapeHtmlAttr(leadId || "")}" aria-label="DalaTech загвар сонгох">
  <div class="dalatech-chooser-inner">
    <div class="dalatech-chooser-meta">
      <span class="dalatech-chooser-tag">Загвар</span>
      <span class="dalatech-chooser-num">№${safeNum}</span>
      <span class="dalatech-chooser-divider" aria-hidden="true"></span>
      <span class="dalatech-chooser-name">${safeBizText}</span>
    </div>
    <button class="dalatech-chooser-cta" type="button" data-dt-chooser-cta>
      <span class="dalatech-chooser-cta-label">Энэ загварыг сонгох</span>
      <span class="dalatech-chooser-cta-arrow" aria-hidden="true">→</span>
    </button>
  </div>
</aside>
<div class="dalatech-confirm" data-dt-confirm role="dialog" aria-modal="true" aria-labelledby="dalatech-confirm-title" hidden>
  <div class="dalatech-confirm-card">
    <div class="dalatech-confirm-mark">DalaTech</div>
    <h2 class="dalatech-confirm-title" id="dalatech-confirm-title">Танай сонголтыг хүлээн авлаа</h2>
    <p class="dalatech-confirm-body">Та <strong>Загвар №${safeNum}</strong>-г сонголоо. DalaTech-ийн баг танд 24 цагийн дотор холбогдох болно.</p>
    <p class="dalatech-confirm-sub">${safeIdText ? `Захиалга ${safeIdText} · ` : ""}${safeBizText}</p>
  </div>
</div>
`.trim();

  const js = `
<script data-dt-chooser>
(function(){
  "use strict";
  try {
    var endpoint = '${safeEndpoint}';
    var leadId = '${safeLead}';
    var designNumber = ${safeNum};
    var businessName = '${safeBizJs}';
    var bar = document.querySelector('[data-dt-chooser]');
    var cta = document.querySelector('[data-dt-chooser-cta]');
    var confirm = document.querySelector('[data-dt-confirm]');
    if (!bar || !cta || !confirm) return;

    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ bar.setAttribute('data-in','true'); });
    });

    var submitted = false;

    function openConfirm(){
      confirm.hidden = false;
      requestAnimationFrame(function(){ confirm.setAttribute('data-open','true'); });
      document.documentElement.style.overflow = 'hidden';
    }

    cta.addEventListener('click', function(){
      if (submitted) return;
      submitted = true;
      cta.disabled = true;
      cta.classList.add('is-loading');

      var payload = {
        leadId: leadId,
        designNumber: designNumber,
        businessName: businessName,
        pageUrl: (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href : ''
      };

      var done = false;
      function finish(){ if (done) return; done = true; openConfirm(); }

      // Show the confirmation regardless of network result so a flaky
      // connection never leaves the visitor staring at a spinning button.
      // The backend has its own logging + Telegram notification path; if the
      // POST silently fails we'll see it in the server logs.
      var timeout = setTimeout(finish, 4500);

      fetch(endpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function(res){
        clearTimeout(timeout);
        return res.json().catch(function(){ return null; });
      }).then(function(){
        finish();
      }).catch(function(){
        clearTimeout(timeout);
        finish();
      });
    });
  } catch (e) {
    // Never break the demo page.
  }
})();
</script>
`.trim();

  return `\n${css}\n${markup}\n${js}\n`;
}

function injectChooserBar(html, options) {
  const widget = buildChooserBar(options);
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${widget}\n</body>`);
  }
  if (/<\/html\s*>/i.test(html)) {
    return html.replace(/<\/html\s*>/i, `${widget}\n</html>`);
  }
  return `${html}\n${widget}`;
}

module.exports = { buildChooserBar, injectChooserBar };
