/* Scout chat widget. Plain JavaScript, no dependencies.
   Embed: <script src="https://YOUR-SCOUT/scout.js" data-token-url="/api/scout-token" async></script>
   data-token-url: an address on YOUR app's server that returns {"token": "...", "expires_at": 123}
   for the signed-in user (your server gets it from Scout's POST /v1/users/token). */
(function () {
  'use strict';
  if (window.__scoutLoaded) return;
  window.__scoutLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="scout.js"]');
  var BASE = new URL(script.src).origin;
  var opts = {
    tokenUrl: script.getAttribute('data-token-url') || '',
    mode: script.getAttribute('data-mode') || '',
    target: script.getAttribute('data-target') || '',
    position: script.getAttribute('data-position') || '',
    offsetBottom: parseInt(script.getAttribute('data-offset-bottom') || '20', 10),
    lang: script.getAttribute('data-lang') || ''
  };

  var STR = {
    en: { open: 'Open Scout assistant', close: 'Close', placeholder: 'Ask about your accounts…', send: 'Send', newChat: 'New chat', mic: 'Speak', listening: 'Listening…',
      noMic: 'Voice input is not available in this browser. Please type instead.', speak: 'Read aloud', copy: 'Copy', copied: 'Copied', up: 'Helpful', down: 'Not helpful',
      confirm: 'Confirm', cancel: 'Cancel', offline: 'You are offline. Check your internet connection.', signin: 'Please sign in to use Scout.',
      error: 'Something went wrong. Please try again.', thinking: 'Scout is thinking', queued: 'Waiting in line: #', proof: 'Proof' },
    hi: { open: 'Scout सहायक खोलें', close: 'बंद करें', placeholder: 'अपने अकाउंट के बारे में पूछें…', send: 'भेजें', newChat: 'नई चैट', mic: 'बोलें', listening: 'सुन रहा हूँ…',
      noMic: 'इस ब्राउज़र में बोलकर लिखना उपलब्ध नहीं है। कृपया टाइप करें।', speak: 'पढ़कर सुनाएँ', copy: 'कॉपी', copied: 'कॉपी हो गया', up: 'मददगार', down: 'मददगार नहीं',
      confirm: 'पुष्टि करें', cancel: 'रद्द करें', offline: 'आप ऑफ़लाइन हैं। इंटरनेट जाँचें।', signin: 'Scout इस्तेमाल करने के लिए साइन इन करें।',
      error: 'कुछ गड़बड़ हो गई। फिर कोशिश करें।', thinking: 'Scout सोच रहा है', queued: 'लाइन में: #', proof: 'सबूत' }
  };
  var lang = (opts.lang || (navigator.language || 'en')).toLowerCase().indexOf('hi') === 0 ? 'hi' : 'en';
  var S = STR[lang];

  var token = null, tokenExp = 0, config = null, sessionId = null, busy = false, controller = null;
  try { sessionId = sessionStorage.getItem('scout_session'); } catch (e) { sessionId = null; }

  // ---------- DOM (inside Shadow DOM so the host site's CSS never clashes) ----------
  var host = document.createElement('div');
  host.setAttribute('data-scout', '');
  var inline = opts.mode === 'inline' && opts.target && document.querySelector(opts.target);
  (inline || document.body).appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  var css = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Devanagari",sans-serif}',
    '.wrap{--brand:#4f46e5;--accent:#22d3ee;--bg:#ffffff;--panel:#f7f8fc;--text:#13151d;--muted:#5d6374;--line:#e4e7f0;--bot:#ffffff;--me:#4f46e5;--meText:#fff;color:var(--text)}',
    '.wrap.dark{--bg:#12141b;--panel:#0d0f15;--text:#eef0f7;--muted:#a1a7b8;--line:#272b38;--bot:#1a1d27}',
    '.fab{position:fixed;z-index:2147483000;width:60px;height:60px;border-radius:20px;border:0;cursor:pointer;color:#fff;',
    'background:radial-gradient(120% 120% at 20% 10%,var(--accent),var(--brand) 60%);box-shadow:0 10px 30px rgba(79,70,229,.35),inset 0 0 0 1px rgba(255,255,255,.25);',
    'display:grid;place-items:center;transition:transform .18s ease,box-shadow .18s ease}',
    '.fab:hover{transform:translateY(-2px);box-shadow:0 14px 34px rgba(79,70,229,.45)}.fab:focus-visible{outline:3px solid var(--accent);outline-offset:3px}',
    '.fab svg{width:30px;height:30px}.dot{position:absolute;top:8px;right:8px;width:10px;height:10px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px var(--brand)}',
    '.panel{position:fixed;z-index:2147483001;width:min(400px,calc(100vw - 24px));height:min(620px,calc(100vh - 110px));background:var(--bg);border:1px solid var(--line);',
    'border-radius:20px;box-shadow:0 24px 60px rgba(15,17,30,.28);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;transition:opacity .18s,transform .18s}',
    '.panel.open{opacity:1;transform:none;pointer-events:auto}',
    '.inline .panel{position:relative;width:100%;height:560px;opacity:1;transform:none;pointer-events:auto;box-shadow:none}',
    '@media (max-width:520px){.panel{width:calc(100vw - 16px);height:calc(100vh - 96px);left:8px!important;right:8px!important}}',
    '@media (prefers-reduced-motion:reduce){.panel,.fab{transition:none}}',
    'header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line);background:linear-gradient(135deg,rgba(79,70,229,.10),rgba(34,211,238,.08))}',
    '.title{font-weight:650;font-size:15px;flex:1}.status{font-size:12px;color:var(--muted)}',
    '.icon{border:0;background:transparent;color:var(--text);width:36px;height:36px;border-radius:10px;cursor:pointer;display:grid;place-items:center}',
    '.icon:hover{background:var(--line)}.icon svg{width:20px;height:20px}',
    '.log{flex:1;overflow-y:auto;padding:14px;background:var(--panel);display:flex;flex-direction:column;gap:10px}',
    '.msg{max-width:88%;padding:10px 12px;border-radius:16px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}',
    '.bot{align-self:flex-start;background:var(--bot);border:1px solid var(--line);border-top-left-radius:6px}',
    '.me{align-self:flex-end;background:var(--me);color:var(--meText);border-top-right-radius:6px}',
    '.sys{align-self:center;font-size:13px;color:var(--muted);text-align:center;max-width:95%}',
    '.err{align-self:center;font-size:13px;color:#b42318;background:rgba(180,35,24,.08);border-radius:10px;padding:8px 10px}',
    '.card{border:1px solid var(--line);border-left:4px solid var(--brand);border-radius:12px;padding:10px 12px;background:var(--bg);font-size:14px;white-space:pre-wrap}',
    '.card.yes{border-left-color:#16a34a}.card.no{border-left-color:#d97706}',
    '.tools{display:flex;gap:4px;margin-top:6px}.tools .icon{width:30px;height:30px}.tools svg{width:16px;height:16px}',
    '.action{border:1px dashed var(--brand);border-radius:12px;padding:10px;background:var(--bg);font-size:14px}',
    '.action .row{display:flex;gap:8px;margin-top:8px}',
    '.btn{border:0;border-radius:10px;padding:9px 14px;font-size:14px;cursor:pointer;background:var(--brand);color:#fff;min-height:40px}.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}',
    '.sendb{display:grid;place-items:center;min-width:46px}.sendb svg{width:20px;height:20px}.md p{margin:0 0 6px}.md ul{margin:4px 0 6px;padding-left:18px}.md li{margin:2px 0}',
    '.chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 8px;background:var(--panel)}',
    '.chip{border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:999px;padding:7px 12px;font-size:13px;cursor:pointer}',
    'form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);background:var(--bg)}',
    'textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:14px;padding:10px 12px;font-size:15px;background:var(--panel);color:var(--text);max-height:120px;min-height:44px}',
    'textarea:focus{outline:2px solid var(--brand);outline-offset:0}',
    '.typing{display:inline-flex;gap:4px}.typing i{width:7px;height:7px;border-radius:50%;background:var(--muted);animation:b 1s infinite}',
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes b{0%,80%,100%{opacity:.25}40%{opacity:1}}'
  ].join('');

  var ICON = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/><path d="M8.5 11.2l1.7 1.7 3.4-3.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>',
    speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9a4 4 0 010 6"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 012 2v4h5a2 2 0 012 2.3l-1.2 7A2 2 0 0116.8 20H7"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 13V4H4v9zM7 13l4 8a2 2 0 002-2v-4h5a2 2 0 002-2.3l-1.2-7A2 2 0 0016.8 4H7"/></svg>'
  };

  root.innerHTML = '<style>' + css + '</style>' +
    '<div class="wrap' + (inline ? ' inline' : '') + '">' +
    (inline ? '' : '<button class="fab" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="' + S.open + '">' + ICON.logo + '<span class="dot" hidden></span></button>') +
    '<section class="panel" role="dialog" aria-modal="false" aria-label="Scout">' +
    '<header><div><div class="title">Scout</div><div class="status" aria-live="polite"></div></div>' +
    '<button class="icon new" type="button" aria-label="' + S.newChat + '" title="' + S.newChat + '">' + ICON.plus + '</button>' +
    (inline ? '' : '<button class="icon x" type="button" aria-label="' + S.close + '" title="' + S.close + '">' + ICON.close + '</button>') + '</header>' +
    '<div class="log" role="log" aria-live="polite"></div><div class="chips"></div>' +
    '<form><textarea rows="1" maxlength="2000" aria-label="' + S.placeholder + '" placeholder="' + S.placeholder + '"></textarea>' +
    '<button class="icon mic" type="button" aria-label="' + S.mic + '" title="' + S.mic + '">' + ICON.mic + '</button>' +
    '<button class="btn sendb" type="submit" aria-label="' + S.send + '">' + ICON.send + '</button></form></section></div>';

  var $ = function (sel) { return root.querySelector(sel); };
  var wrap = $('.wrap'), fab = $('.fab'), panel = $('.panel'), log = $('.log'), chips = $('.chips'), form = $('form'), input = $('textarea'), statusEl = $('.status');

  function applyTheme() {
    var t = (config && config.theme) || 'auto';
    var dark = t === 'dark' || (t === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    wrap.classList.toggle('dark', !!dark);
    if (config && config.primary_color) wrap.style.setProperty('--brand', config.primary_color), wrap.style.setProperty('--me', config.primary_color);
    if (config && config.accent_color) wrap.style.setProperty('--accent', config.accent_color);
    var pos = opts.position || (config && config.position) || 'bottom-right';
    var side = pos === 'bottom-left' ? 'left' : 'right';
    if (fab) { fab.style[side] = '20px'; fab.style.bottom = opts.offsetBottom + 'px'; }
    if (!inline) { panel.style[side] = '16px'; panel.style.bottom = (opts.offsetBottom + 72) + 'px'; }
  }
  applyTheme();

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // Tiny, safe formatter for the AI's text: **bold** and "- " / "* " bullet lines.
  // It only creates DOM nodes (never innerHTML), so text from the AI cannot inject HTML.
  function inline(parent, text) {
    var parts = String(text).split(/(\*\*[^*]+\*\*)/g);
    parts.forEach(function (part) {
      var m = /^\*\*([^*]+)\*\*$/.exec(part);
      if (m) parent.appendChild(el('b', null, m[1])); else if (part) parent.appendChild(document.createTextNode(part.replace(/\*\*/g, '')));
    });
  }
  function rich(text) {
    var box = el('div', 'md'); var list = null;
    String(text).split('\n').forEach(function (line) {
      var b = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (b) { if (!list) { list = el('ul'); box.appendChild(list); } var li = el('li'); inline(li, b[1]); list.appendChild(li); return; }
      list = null;
      if (line.trim()) { var para = el('p'); inline(para, line); box.appendChild(para); }
    });
    return box;
  }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function sys(text, cls) { var e = el('div', cls || 'sys', text); log.appendChild(e); scroll(); return e; }

  // ---------- auth: a short-lived user token from the host app's own server ----------
  function getToken() {
    if (token && Date.now() < tokenExp - 30000) return Promise.resolve(token);
    if (!opts.tokenUrl) return Promise.reject(new Error('signin'));
    return fetch(opts.tokenUrl, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { if (!r.ok) throw new Error('signin'); return r.json(); })
      .then(function (d) { token = d.token; tokenExp = d.expires_at || Date.now() + 600000; return token; });
  }

  function api(path, init) {
    return getToken().then(function (t) {
      init = init || {};
      init.headers = Object.assign({ authorization: 'Bearer ' + t, 'content-type': 'application/json' }, init.headers || {});
      return fetch(BASE + path, init);
    });
  }

  function loadConfig() {
    return api('/v1/widget/config').then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      if (!c) return;
      config = c;
      $('.title').textContent = c.agent_name || 'Scout';
      applyTheme();
      setStatus();
      if (!log.children.length) {
        sys(c.welcome_text || (lang === 'hi' ? 'नमस्ते! अपने ईमेल अकाउंट, सेवाओं या डिवाइस के बारे में पूछें।' : 'Hi! Ask me which websites and apps your email accounts are linked to.'));
        renderChips(c.quick_replies && c.quick_replies.length ? c.quick_replies : (lang === 'hi' ? ['मेरे कितने डिवाइस हैं?', 'हाल की लॉगिन चेतावनियाँ', 'मुझे पहले क्या ठीक करना चाहिए?'] : ['How many devices do I have?', 'Any new login alerts?', 'What should I fix first?']));
      }
    }).catch(function (e) { if (e.message === 'signin') sys(S.signin, 'err'); });
  }

  function setStatus(text) {
    if (text) { statusEl.textContent = text; return; }
    var st = config && config.ai && config.ai.state;
    statusEl.textContent = st && st !== 'ready' && st !== 'disabled' ? (lang === 'hi' ? 'AI तैयार हो रहा है…' : 'AI is getting ready…') : '';
  }

  function renderChips(list) {
    chips.innerHTML = '';
    (list || []).slice(0, 6).forEach(function (q) {
      var b = el('button', 'chip', q); b.type = 'button';
      b.onclick = function () { send(q); };
      chips.appendChild(b);
    });
  }

  // ---------- rendering ----------
  function renderCard(card) {
    var c = el('div', 'card ' + (card.type === 'presence' ? (card.answer === 'yes' ? 'yes' : 'no') : ''));
    c.setAttribute('role', 'note');
    return c;
  }

  function botTools(bubble, getText, messageId) {
    var bar = el('div', 'tools');
    function iconBtn(svg, label, fn) { var b = el('button', 'icon'); b.type = 'button'; b.innerHTML = svg; b.setAttribute('aria-label', label); b.title = label; b.onclick = fn; bar.appendChild(b); return b; }
    iconBtn(ICON.copy, S.copy, function () { if (navigator.clipboard) navigator.clipboard.writeText(getText()).then(function () { setStatus(S.copied); setTimeout(function () { setStatus(); }, 1500); }); });
    if ('speechSynthesis' in window) iconBtn(ICON.speak, S.speak, function () { var u = new SpeechSynthesisUtterance(getText()); u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN'; speechSynthesis.cancel(); speechSynthesis.speak(u); });
    if (messageId) {
      var up = iconBtn(ICON.up, S.up, function () { feedback(messageId, 1, up, down); });
      var down = iconBtn(ICON.down, S.down, function () { feedback(messageId, -1, down, up); });
    }
    bubble.appendChild(bar);
  }

  function feedback(id, value, on, off) {
    api('/v1/messages/' + encodeURIComponent(id) + '/feedback', { method: 'POST', body: JSON.stringify({ value: value }) }).then(function (r) {
      if (r.ok) { on.style.color = 'var(--brand)'; off.style.color = ''; }
    }).catch(function () {});
  }

  function actionBox(a) {
    var box = el('div', 'action');
    box.appendChild(el('div', null, a.summary));
    var row = el('div', 'row');
    var ok = el('button', 'btn', S.confirm); ok.type = 'button';
    var no = el('button', 'btn ghost', S.cancel); no.type = 'button';
    function decide(d) {
      ok.disabled = no.disabled = true;
      api('/v1/actions/' + encodeURIComponent(a.id) + '/' + d, { method: 'POST', body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (res) { row.remove(); box.appendChild(el('div', 'sys', res.message || (res.error && res.error.message) || S.error)); })
        .catch(function () { ok.disabled = no.disabled = false; sys(S.error, 'err'); });
    }
    ok.onclick = function () { decide('confirm'); };
    no.onclick = function () { decide('cancel'); };
    row.appendChild(ok); row.appendChild(no); box.appendChild(row);
    log.appendChild(box); scroll();
  }

  // ---------- sending (streamed over SSE through fetch) ----------
  function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    if (!navigator.onLine) { sys(S.offline, 'err'); return; }
    busy = true; chips.innerHTML = '';
    log.appendChild(el('div', 'msg me', text)); scroll();
    var bubble = el('div', 'msg bot'); var typing = el('span', 'typing'); typing.innerHTML = '<i></i><i></i><i></i>';
    typing.setAttribute('aria-label', S.thinking); bubble.appendChild(typing); log.appendChild(bubble); scroll();
    var body = el('div'); var cardsBox = el('div'); var textNode = el('div');
    var streamed = '';
    controller = new AbortController();
    api('/v1/chat/stream', { method: 'POST', body: JSON.stringify({ message: text, session_id: sessionId || undefined, language: undefined }), signal: controller.signal })
      .then(function (r) {
        if (!r.ok || !r.body) return r.json().then(function (j) { throw new Error((j.error && j.error.message) || S.error); });
        var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = '';
        function handle(evName, data) {
          if (evName === 'start') { sessionId = data.session_id; try { sessionStorage.setItem('scout_session', sessionId); } catch (e) {} }
          else if (evName === 'queued') setStatus(S.queued + data.position);
          else if (evName === 'delta') { if (typing.parentNode) { typing.remove(); bubble.appendChild(cardsBox); bubble.appendChild(textNode); } streamed += data.text; textNode.textContent = streamed; scroll(); }
          else if (evName === 'tool') setStatus(data.status === 'running' ? data.label + '…' : '');
          else if (evName === 'card') { if (typing.parentNode) { typing.remove(); bubble.appendChild(cardsBox); bubble.appendChild(textNode); } }
          else if (evName === 'done') {
            if (typing.parentNode) typing.remove();
            bubble.innerHTML = '';
            var reply = data.reply || '';
            (data.card_texts || []).forEach(function (txt, i) { var c = renderCard((data.cards || [])[i] || {}); c.textContent = txt; bubble.appendChild(c); });
            if (data.text) bubble.appendChild(rich(data.text));
            botTools(bubble, function () { return reply; }, data.message_id);
            (data.pending_actions || []).forEach(actionBox);
            setStatus();
          } else if (evName === 'error') { bubble.remove(); sys(data.message || S.error, 'err'); }
        }
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              var chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
              var ev = 'message', data = '';
              chunk.split('\n').forEach(function (line) { if (line.indexOf('event: ') === 0) ev = line.slice(7); else if (line.indexOf('data: ') === 0) data += line.slice(6); });
              if (data) { try { handle(ev, JSON.parse(data)); } catch (e) {} }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        bubble.remove();
        if (e.name === 'AbortError') return;
        sys(e.message === 'signin' ? S.signin : (!navigator.onLine ? S.offline : (e.message || S.error)), 'err');
      })
      .then(function () { busy = false; setStatus(); input.focus(); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); var v = input.value; input.value = ''; autosize(); send(v); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); } });
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; }
  input.addEventListener('input', autosize);

  $('.new').onclick = function () {
    if (controller) controller.abort();
    sessionId = null; try { sessionStorage.removeItem('scout_session'); } catch (e) {}
    log.innerHTML = ''; busy = false; loadConfig();
  };

  // Voice input with the browser's own speech recognition; a clear message if missing.
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('.mic').onclick = function () {
    if (!Rec) { sys(S.noMic); return; }
    var rec = new Rec(); rec.lang = lang === 'hi' ? 'hi-IN' : 'en-IN'; rec.interimResults = false; rec.maxAlternatives = 1;
    setStatus(S.listening);
    rec.onresult = function (ev) { input.value = (input.value + ' ' + ev.results[0][0].transcript).trim(); autosize(); input.focus(); };
    rec.onerror = function () { sys(S.noMic); };
    rec.onend = function () { setStatus(); };
    rec.start();
  };

  var loaded = false;
  function openPanel() {
    panel.classList.add('open');
    if (fab) fab.setAttribute('aria-expanded', 'true');
    if (!loaded) { loaded = true; loadConfig(); }
    setTimeout(function () { input.focus(); }, 50);
  }
  function closePanel() {
    panel.classList.remove('open');
    if (fab) { fab.setAttribute('aria-expanded', 'false'); fab.focus(); }
  }
  if (fab) fab.onclick = function () { panel.classList.contains('open') ? closePanel() : openPanel(); };
  var x = $('.x'); if (x) x.onclick = closePanel;
  root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !inline) closePanel(); });
  if (inline) openPanel();
  window.addEventListener('offline', function () { setStatus(S.offline); });
  window.addEventListener('online', function () { setStatus(); });

  window.Scout = { open: openPanel, close: function () { if (!inline) closePanel(); }, ask: function (q) { openPanel(); send(q); } };
})();
