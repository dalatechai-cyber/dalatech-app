"use strict";

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
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildChatbotWidget({ leadId, businessName, primaryColor, secondaryColor, chatEndpoint }) {
  const safeBiz = escapeJsString(businessName || "");
  const safeId = escapeJsString(leadId || "");
  const safeEndpoint = escapeJsString(chatEndpoint || "https://app.dalatech.online/api/chat");
  const primary = primaryColor || "#2563EB";
  const secondary = secondaryColor || "#38BDF8";
  const attrPrimary = escapeHtmlAttr(primary);
  const attrSecondary = escapeHtmlAttr(secondary);

  const css = `
<style id="dt-bot-style" data-dt-bot>
  .dt-bot-root {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;
    color-scheme: light;
    --dt-bot-primary: ${attrPrimary};
    --dt-bot-secondary: ${attrSecondary};
    --dt-bot-surface: #FFFFFF;
    --dt-bot-surface-tint: rgba(0, 0, 0, 0.04);
    --dt-bot-text: #0F172A;
    --dt-bot-muted: #64748B;
    --dt-bot-line: rgba(15, 23, 42, 0.08);
    --dt-bot-ease: cubic-bezier(0.23, 1, 0.32, 1);
  }
  .dt-bot-root * { box-sizing: border-box; }

  .dt-bot-launcher {
    appearance: none;
    border: 0;
    margin: 0;
    padding: 0;
    width: 56px;
    height: 56px;
    border-radius: 999px;
    background: var(--dt-bot-primary);
    color: #FFFFFF;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 18px 36px -16px rgba(15, 23, 42, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.12) inset;
    transition: transform 200ms var(--dt-bot-ease), box-shadow 200ms var(--dt-bot-ease);
  }
  .dt-bot-launcher:hover { transform: translateY(-2px); }
  .dt-bot-launcher:active { transform: scale(0.97); }
  .dt-bot-launcher svg { width: 24px; height: 24px; }

  .dt-bot-panel {
    position: absolute;
    right: 0;
    bottom: 72px;
    width: min(360px, calc(100vw - 32px));
    height: min(560px, calc(100dvh - 120px));
    background: var(--dt-bot-surface);
    color: var(--dt-bot-text);
    border-radius: 20px;
    border: 1px solid var(--dt-bot-line);
    box-shadow: 0 30px 80px -30px rgba(15, 23, 42, 0.45);
    display: none;
    flex-direction: column;
    overflow: hidden;
    transform-origin: bottom right;
    opacity: 0;
    transform: translateY(8px) scale(0.97);
    transition: opacity 200ms var(--dt-bot-ease), transform 200ms var(--dt-bot-ease);
  }
  .dt-bot-panel[data-open="true"] {
    display: flex;
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .dt-bot-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--dt-bot-line);
    background: var(--dt-bot-primary);
    color: #FFFFFF;
  }
  .dt-bot-head-avatar {
    width: 32px;
    height: 32px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: -0.01em;
  }
  .dt-bot-head-text { line-height: 1.25; min-width: 0; }
  .dt-bot-head-name {
    font-weight: 600;
    font-size: 14px;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dt-bot-head-sub {
    font-size: 12px;
    margin: 2px 0 0;
    opacity: 0.85;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dt-bot-head-sub::before {
    content: "";
    width: 6px; height: 6px;
    border-radius: 999px;
    background: #4ADE80;
    box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.25);
  }
  .dt-bot-close {
    margin-left: auto;
    background: rgba(255, 255, 255, 0.16);
    border: 0;
    width: 28px; height: 28px;
    border-radius: 8px;
    color: #FFFFFF;
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background 160ms var(--dt-bot-ease);
  }
  .dt-bot-close:hover { background: rgba(255, 255, 255, 0.26); }
  .dt-bot-close:active { transform: scale(0.95); }

  .dt-bot-log {
    flex: 1;
    padding: 14px;
    overflow-y: auto;
    scroll-behavior: smooth;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--dt-bot-surface);
  }
  .dt-bot-msg {
    max-width: 80%;
    padding: 10px 13px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.5;
    word-wrap: break-word;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 220ms var(--dt-bot-ease), transform 220ms var(--dt-bot-ease);
  }
  .dt-bot-msg[data-in="true"] { opacity: 1; transform: translateY(0); }
  .dt-bot-msg.dt-bot-from-bot {
    align-self: flex-start;
    background: var(--dt-bot-surface-tint);
    color: var(--dt-bot-text);
    border-bottom-left-radius: 6px;
  }
  .dt-bot-msg.dt-bot-from-user {
    align-self: flex-end;
    background: var(--dt-bot-primary);
    color: #FFFFFF;
    border-bottom-right-radius: 6px;
  }
  .dt-bot-msg.dt-bot-typing {
    align-self: flex-start;
    background: var(--dt-bot-surface-tint);
    color: var(--dt-bot-muted);
    display: inline-flex;
    gap: 4px;
    padding: 12px 14px;
  }
  .dt-bot-msg.dt-bot-typing span {
    width: 6px; height: 6px; border-radius: 999px;
    background: currentColor;
    opacity: 0.5;
    animation: dt-bot-blink 1.2s infinite;
  }
  .dt-bot-msg.dt-bot-typing span:nth-child(2) { animation-delay: 0.15s; }
  .dt-bot-msg.dt-bot-typing span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes dt-bot-blink {
    0%, 80%, 100% { opacity: 0.25; }
    40% { opacity: 0.9; }
  }

  .dt-bot-form {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid var(--dt-bot-line);
    background: var(--dt-bot-surface);
  }
  .dt-bot-input {
    flex: 1;
    border: 1px solid var(--dt-bot-line);
    background: var(--dt-bot-surface);
    color: var(--dt-bot-text);
    border-radius: 999px;
    padding: 10px 14px;
    font: inherit;
    font-size: 14px;
    outline: none;
    transition: border-color 160ms var(--dt-bot-ease), box-shadow 160ms var(--dt-bot-ease);
    min-width: 0;
  }
  .dt-bot-input:focus {
    border-color: var(--dt-bot-primary);
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18);
  }
  .dt-bot-send {
    appearance: none;
    border: 0;
    background: var(--dt-bot-primary);
    color: #FFFFFF;
    width: 38px; height: 38px;
    border-radius: 999px;
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: transform 160ms var(--dt-bot-ease), opacity 160ms var(--dt-bot-ease);
  }
  .dt-bot-send:hover { transform: translateY(-1px); }
  .dt-bot-send:active { transform: scale(0.96); }
  .dt-bot-send:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  .dt-bot-footer {
    padding: 8px 14px 10px;
    text-align: center;
    font-size: 11px;
    color: var(--dt-bot-muted);
    border-top: 1px solid var(--dt-bot-line);
    background: var(--dt-bot-surface);
  }
  .dt-bot-footer a {
    color: var(--dt-bot-muted);
    text-decoration: none;
    border-bottom: 1px dashed currentColor;
  }
  .dt-bot-footer a:hover { color: var(--dt-bot-text); }

  @media (prefers-reduced-motion: reduce) {
    .dt-bot-panel,
    .dt-bot-msg,
    .dt-bot-launcher,
    .dt-bot-send,
    .dt-bot-close { transition: opacity 160ms linear; transform: none !important; }
  }
</style>
`.trim();

  const markup = `
<div class="dt-bot-root" id="dt-bot-root" data-dt-bot>
  <div class="dt-bot-panel" id="dt-bot-panel" role="dialog" aria-label="${escapeHtmlAttr(businessName || "Chat")}" aria-hidden="true" data-open="false">
    <div class="dt-bot-head">
      <span class="dt-bot-head-avatar" aria-hidden="true">${escapeHtmlAttr((businessName || "?").trim().slice(0, 1).toUpperCase())}</span>
      <div class="dt-bot-head-text">
        <p class="dt-bot-head-name">${escapeHtmlAttr(businessName || "")}</p>
        <p class="dt-bot-head-sub">Онлайн туслах</p>
      </div>
      <button class="dt-bot-close" id="dt-bot-close" type="button" aria-label="Хаах">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </div>
    <div class="dt-bot-log" id="dt-bot-log" role="log" aria-live="polite"></div>
    <form class="dt-bot-form" id="dt-bot-form" autocomplete="off">
      <input class="dt-bot-input" id="dt-bot-input" type="text" maxlength="500" placeholder="Асуултаа бичээрэй..." aria-label="Зурвас">
      <button class="dt-bot-send" id="dt-bot-send" type="submit" aria-label="Илгээх">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
      </button>
    </form>
    <p class="dt-bot-footer">
      Powered by <a href="https://dalatech.online" target="_blank" rel="noopener">DalaTech.ai</a>
    </p>
  </div>
  <button class="dt-bot-launcher" id="dt-bot-launcher" type="button" aria-label="Чат нээх" aria-expanded="false" aria-controls="dt-bot-panel">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>
    </svg>
  </button>
</div>
`.trim();

  const js = `
<script data-dt-bot>
(function(){
  "use strict";
  var endpoint = '${safeEndpoint}';
  var businessId = '${safeId}';
  var businessName = '${safeBiz}';
  var root = document.getElementById('dt-bot-root');
  if (!root) return;
  var panel = document.getElementById('dt-bot-panel');
  var launcher = document.getElementById('dt-bot-launcher');
  var closeBtn = document.getElementById('dt-bot-close');
  var form = document.getElementById('dt-bot-form');
  var input = document.getElementById('dt-bot-input');
  var sendBtn = document.getElementById('dt-bot-send');
  var log = document.getElementById('dt-bot-log');
  var history = [];
  var greeted = false;

  function escapeHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function addMessage(text, from){
    var div = document.createElement('div');
    div.className = 'dt-bot-msg dt-bot-from-' + (from === 'user' ? 'user' : 'bot');
    div.innerHTML = escapeHtml(text).replace(/\\n/g, '<br>');
    log.appendChild(div);
    requestAnimationFrame(function(){ div.setAttribute('data-in','true'); });
    log.scrollTop = log.scrollHeight;
  }

  function addTyping(){
    var div = document.createElement('div');
    div.className = 'dt-bot-msg dt-bot-typing';
    div.id = 'dt-bot-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    log.appendChild(div);
    requestAnimationFrame(function(){ div.setAttribute('data-in','true'); });
    log.scrollTop = log.scrollHeight;
  }

  function removeTyping(){
    var t = document.getElementById('dt-bot-typing');
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }

  function greet(){
    if (greeted) return;
    greeted = true;
    var name = businessName ? businessName + '-ын' : 'манай';
    addMessage('Сайн байна уу. Би ' + name + ' онлайн туслах. Үнэ, цаг, байршил, үйлчилгээний талаар асуугаарай.', 'bot');
  }

  function openPanel(){
    panel.setAttribute('data-open','true');
    panel.setAttribute('aria-hidden','false');
    launcher.setAttribute('aria-expanded','true');
    greet();
    setTimeout(function(){ try { input.focus(); } catch(_){} }, 220);
  }
  function closePanel(){
    panel.setAttribute('data-open','false');
    panel.setAttribute('aria-hidden','true');
    launcher.setAttribute('aria-expanded','false');
  }

  launcher.addEventListener('click', function(){
    if (panel.getAttribute('data-open') === 'true') closePanel(); else openPanel();
  });
  closeBtn.addEventListener('click', closePanel);

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && panel.getAttribute('data-open') === 'true') closePanel();
  });

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var text = (input.value || '').trim();
    if (!text) return;
    if (text.length > 500) text = text.slice(0, 500);
    addMessage(text, 'user');
    history.push({ role: 'user', content: text });
    input.value = '';
    sendBtn.disabled = true;
    input.disabled = true;
    addTyping();

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId: businessId, message: text, history: history.slice(-12) })
    }).then(function(res){
      return res.json().then(function(data){ return { ok: res.ok, status: res.status, data: data }; });
    }).then(function(result){
      removeTyping();
      if (!result.ok || !result.data || !result.data.reply){
        addMessage('Уучлаарай, түр алдаа гарлаа. Хэсэг хүлээгээд дахин оролдоно уу.', 'bot');
      } else {
        addMessage(result.data.reply, 'bot');
        history.push({ role: 'assistant', content: result.data.reply });
        if (history.length > 20) history = history.slice(-20);
      }
    }).catch(function(){
      removeTyping();
      addMessage('Сүлжээний алдаа. Дахин оролдоно уу.', 'bot');
    }).then(function(){
      sendBtn.disabled = false;
      input.disabled = false;
      try { input.focus(); } catch(_){}
    });
  });
})();
</script>
`.trim();

  return `\n${css}\n${markup}\n${js}\n`;
}

function injectChatbot(html, options) {
  const widget = buildChatbotWidget(options);
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${widget}\n</body>`);
  }
  if (/<\/html\s*>/i.test(html)) {
    return html.replace(/<\/html\s*>/i, `${widget}\n</html>`);
  }
  return `${html}\n${widget}`;
}

module.exports = { buildChatbotWidget, injectChatbot };
