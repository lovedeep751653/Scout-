import type { SetupView } from '../keys/setup.ts';
import type { RuntimeStatus } from '../runtime/ollama.ts';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const BASE_CSS = `
:root{--bg:#f6f7fb;--card:#fff;--text:#14161f;--muted:#5b6070;--line:#e3e6ef;--brand:#4f46e5;--ok:#0f8a5f;--warn:#b45309;--bad:#b42318;--code:#f1f3f9}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#171a23;--text:#eef0f6;--muted:#a3a9ba;--line:#2a2f3d;--brand:#8b85ff;--ok:#3ccf91;--warn:#f0a94a;--bad:#ff7a6b;--code:#1f2330}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Devanagari",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.6rem;margin:.2em 0 .4em}h2{font-size:1.1rem;margin:1.4em 0 .4em}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0}
.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
code,.key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);border-radius:8px;padding:2px 6px;word-break:break-all}
.key{display:block;padding:12px;font-size:.95rem;margin:8px 0;user-select:all}
button{font:inherit;border:0;border-radius:12px;padding:12px 16px;background:var(--brand);color:#fff;cursor:pointer;min-height:44px}
button.secondary{background:transparent;color:var(--brand);border:1px solid var(--line)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.bar{height:10px;background:var(--line);border-radius:6px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--brand)}
ol{padding-left:1.2em}li{margin:.3em 0}
`;

function aiBlock(ai: RuntimeStatus): string {
  const cls = ai.state === 'ready' || ai.state === 'disabled' ? 'ok' : ai.state === 'error' ? 'bad' : 'warn';
  const label = { ready: 'Ready', disabled: 'Ready (cloud provider)', starting: 'Starting', downloading: 'Downloading', loading: 'Loading', error: 'Problem' }[ai.state];
  const bar = ai.state === 'downloading' ? `<div class="bar" aria-label="download progress"><i style="width:${ai.percent ?? 0}%"></i></div>` : '';
  return `<div class="card"><h2>AI engine: <span class="${cls}">${label}</span></h2><p class="muted">Model: <code>${esc(ai.model)}</code></p><p>${esc(ai.message)}</p>${bar}</div>`;
}

export function setupPage(p: { view: SetupView; publicUrl: string; ai: RuntimeStatus; windowMinutes: number }): string {
  let keyBlock: string;
  if (p.view.status === 'pending' && p.view.appKey) {
    const mins = Math.max(1, Math.round(((p.view.windowEndsAt ?? Date.now()) - Date.now()) / 60_000));
    keyBlock = `<div class="card">
<h2>Your Scout app key</h2>
<p>This is the key your <b>LoginLens server</b> uses to talk to Scout. It is shown <b>only on this page</b>, for about ${mins} more minutes.</p>
<code class="key" id="k">${esc(p.view.appKey)}</code>
<div class="row"><button id="copy" type="button">Copy key</button><span id="msg" class="muted" role="status"></span></div>
<h2>Give these 2 values to LoginLens</h2>
<p>Put them in your LoginLens hosting <b>secrets / environment variables</b> (never in website code and never in chat):</p>
<p><code>SCOUT_URL</code> = <code>${esc(p.publicUrl)}</code><br><code>SCOUT_APP_KEY</code> = the key above</p>
<p>When you have saved the key, press the button. After that, Scout forgets it and keeps only a scrambled fingerprint.</p>
<button id="done" type="button" class="secondary">I saved the key</button>
</div>
<script>
document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('k').textContent);document.getElementById('msg').textContent='Copied.'}catch(e){document.getElementById('msg').textContent='Press and hold the key to copy it.'}};
document.getElementById('done').onclick=async()=>{if(!confirm('Have you saved the key somewhere safe? It cannot be shown again.'))return;await fetch('/setup/confirm',{method:'POST'});location.reload()};
</script>`;
  } else if (p.view.status === 'claimed' || p.view.status === 'env') {
    keyBlock = `<div class="card"><h2 class="ok">Scout is set up</h2><p>The app key was saved${p.view.status === 'env' ? ' as the SCOUT_APP_KEY hosting secret' : ''}. For safety it is never shown again.</p>
<p class="muted">Lost it? Your LoginLens server can make a new one (POST /v1/app-key/rotate). Or set <code>SCOUT_NEW_APP_KEY=true</code> in your hosting settings, restart Scout, open this page again, then remove that setting.</p></div>`;
  } else {
    keyBlock = `<div class="card"><h2 class="warn">The setup window has closed</h2><p>For safety the app key is only shown for ${p.windowMinutes} minutes after Scout first starts. Restart Scout (your hosting dashboard has a Restart button), then open this page again within ${p.windowMinutes} minutes to get a new key.</p></div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Scout setup</title><style>${BASE_CSS}</style></head>
<body><main><h1>Scout setup</h1><p class="muted">Scout is the AI assistant for LoginLens. It runs a free, open-source AI model on this server, so no AI company key is needed.</p>
${keyBlock}${aiBlock(p.ai)}
<div class="card"><h2>Check that it works</h2><ol><li>Open <a href="/health">/health</a>. It should say <code>"status":"ok"</code> once the AI model has downloaded.</li><li>Read <a href="/docs">/docs</a> for what LoginLens needs to build.</li></ol></div>
</main>${p.ai.state !== 'ready' && p.ai.state !== 'disabled' ? '<script>setTimeout(()=>location.reload(),10000)</script>' : ''}</body></html>`;
}

export function landingPage(publicUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scout</title><style>${BASE_CSS}</style></head>
<body><main><h1>Scout</h1><p>The AI assistant service for LoginLens. Apps talk to it at <code>${esc(publicUrl)}/v1</code>.</p>
<div class="card"><ul><li><a href="/setup">Setup and status</a></li><li><a href="/health">Health check</a></li><li><a href="/docs">API docs</a></li></ul></div></main></body></html>`;
}
