import { esc } from './pages.ts';

type Op = { method: string; path: string; summary: string; auth: 'none' | 'app' | 'app_or_user'; body?: Record<string, unknown>; scope?: string };

const OPS: Op[] = [
  { method: 'get', path: '/health', summary: 'Health check: database and AI engine state (no login).', auth: 'none' },
  { method: 'get', path: '/setup', summary: 'First-start setup page that shows the app key once, plus AI status.', auth: 'none' },
  { method: 'get', path: '/scout.js', summary: 'The embeddable chat widget script.', auth: 'none' },
  { method: 'get', path: '/v1/status', summary: 'Owner status: AI engine, setup, connector, usage and configuration warnings.', auth: 'app', scope: 'chat' },
  { method: 'post', path: '/v1/app-key/rotate', summary: 'Create a new app key; the old one keeps working for grace_seconds.', auth: 'app', scope: 'keys:rotate', body: { grace_seconds: { type: 'integer', example: 3600 } } },
  { method: 'post', path: '/v1/users/token', summary: 'Mint a short-lived user token for the browser chat window.', auth: 'app', scope: 'users:token', body: { user_id: { type: 'string', example: '42' }, ttl_seconds: { type: 'integer', example: 900 } } },
  { method: 'get', path: '/v1/settings', summary: 'Read assistant settings (name, colors, welcome text, allowed origins, tools).', auth: 'app', scope: 'settings' },
  {
    method: 'put',
    path: '/v1/settings',
    summary: 'Change assistant settings. Only the fields you send change.',
    auth: 'app',
    scope: 'settings',
    body: {
      agent_name: { type: 'string' },
      welcome_text: { type: 'string' },
      instructions: { type: 'string' },
      primary_color: { type: 'string', example: '#4f46e5' },
      accent_color: { type: 'string' },
      position: { type: 'string', enum: ['bottom-right', 'bottom-left'] },
      mode: { type: 'string', enum: ['floating', 'inline'] },
      theme: { type: 'string', enum: ['auto', 'light', 'dark'] },
      quick_replies: { type: 'array', items: { type: 'string' } },
      allowed_origins: { type: 'array', items: { type: 'string' }, example: ['https://loginlens.example.com'] },
      enabled_tools: { type: 'array', items: { type: 'string' } },
      disabled_tools: { type: 'array', items: { type: 'string' } },
    },
  },
  { method: 'put', path: '/v1/connectors/loginlens', summary: 'Register the LoginLens data endpoint Scout calls for tool results. Returns signing_secret.', auth: 'app', scope: 'connectors', body: { url: { type: 'string', example: 'https://loginlens.example.com/api/scout-tools' } } },
  { method: 'delete', path: '/v1/connectors/loginlens', summary: 'Remove the LoginLens data endpoint.', auth: 'app', scope: 'connectors' },
  { method: 'get', path: '/v1/tools', summary: 'List the tools Scout can use for this app.', auth: 'app', scope: 'tools:manage' },
  {
    method: 'post',
    path: '/v1/tools',
    summary: 'Register or update a custom webhook tool (HMAC-signed calls, private networks blocked). Returns signing_secret once.',
    auth: 'app',
    scope: 'tools:manage',
    body: { name: { type: 'string' }, description: { type: 'string' }, input_schema: { type: 'object' }, permission: { type: 'string', enum: ['read', 'write_confirm'] }, url: { type: 'string' }, timeout_ms: { type: 'integer' } },
  },
  { method: 'delete', path: '/v1/tools/{name}', summary: 'Delete a custom webhook tool.', auth: 'app', scope: 'tools:manage' },
  { method: 'get', path: '/v1/users/{user_id}/export', summary: 'Export everything Scout stored for one user.', auth: 'app', scope: 'data:export' },
  { method: 'delete', path: '/v1/users/{user_id}', summary: 'Delete everything Scout stored for one user.', auth: 'app', scope: 'data:delete' },
  { method: 'get', path: '/v1/widget/config', summary: 'Settings the chat window needs.', auth: 'app_or_user', scope: 'chat' },
  {
    method: 'post',
    path: '/v1/chat',
    summary: 'Ask Scout a question and get the full answer as JSON.',
    auth: 'app_or_user',
    scope: 'chat',
    body: { message: { type: 'string', example: 'Is my email signed up for Netflix?' }, session_id: { type: 'string' }, user_id: { type: 'string', description: 'Required with an app key; ignored with a user token.' }, language: { type: 'string', enum: ['en', 'hi', 'hinglish'] } },
  },
  {
    method: 'post',
    path: '/v1/chat/stream',
    summary: 'Same as /v1/chat but streams Server-Sent Events: start, queued, delta, tool, card, action, notice, done, error.',
    auth: 'app_or_user',
    scope: 'chat',
    body: { message: { type: 'string' }, session_id: { type: 'string' }, user_id: { type: 'string' }, language: { type: 'string' } },
  },
  { method: 'post', path: '/v1/actions/{id}/confirm', summary: 'Run an action the user confirmed (the only way a write tool ever runs).', auth: 'app_or_user', scope: 'chat', body: { user_id: { type: 'string' } } },
  { method: 'post', path: '/v1/actions/{id}/cancel', summary: 'Cancel a pending action.', auth: 'app_or_user', scope: 'chat', body: { user_id: { type: 'string' } } },
  { method: 'get', path: '/v1/sessions', summary: "List the caller's conversations (add ?user_id= with an app key).", auth: 'app_or_user', scope: 'chat' },
  { method: 'get', path: '/v1/sessions/{id}/messages', summary: 'Messages of one conversation.', auth: 'app_or_user', scope: 'chat' },
  { method: 'delete', path: '/v1/sessions/{id}', summary: 'Delete one conversation.', auth: 'app_or_user', scope: 'chat' },
  { method: 'post', path: '/v1/messages/{id}/feedback', summary: 'Thumbs up (1), down (-1) or clear (null) on an answer.', auth: 'app_or_user', scope: 'chat', body: { value: { type: 'integer', enum: [1, -1], nullable: true }, user_id: { type: 'string' } } },
];

export function openApiSpec(publicUrl: string, version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    (paths[op.path] ??= {})[op.method] = {
      summary: op.summary,
      ...(op.auth === 'none' ? { security: [] } : { security: op.auth === 'app' ? [{ appKey: [] }] : [{ appKey: [] }, { userToken: [] }] }),
      ...(op.scope ? { 'x-scope': op.scope } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: op.body } } } } } : {}),
      responses: {
        '200': { description: 'Success' },
        '400': { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Missing or invalid credentials' },
        '403': { description: 'Not allowed (scope, origin or browser use of an app key)' },
        '429': { description: 'Rate limited; see the Retry-After header' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Scout API', version, description: 'AI agent service for LoginLens. The AI runs locally (no AI API key). See docs/INTEGRATION.md.' },
    servers: [{ url: publicUrl }],
    components: {
      securitySchemes: {
        appKey: { type: 'http', scheme: 'bearer', description: 'App key sct_sec_... (server side only)' },
        userToken: { type: 'http', scheme: 'bearer', description: 'Short-lived user token sct_ut_... from POST /v1/users/token' },
      },
      schemas: { Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } } },
    },
    paths,
  };
}

export function docsPage(publicUrl: string): string {
  const rows = OPS.map(
    (o) =>
      `<tr><td><code>${o.method.toUpperCase()}</code></td><td><code>${esc(o.path)}</code></td><td>${esc(o.summary)}${o.body ? `<br><span class="muted">Body: ${esc(Object.keys(o.body).join(', '))}</span>` : ''}</td><td>${o.auth === 'none' ? 'none' : o.auth === 'app' ? 'app key' : 'app key + user_id, or user token'}${o.scope ? `<br><span class="muted">${esc(o.scope)}</span>` : ''}</td></tr>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scout API</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f7fb;color:#14161f}main{max-width:1000px;margin:0 auto;padding:20px 16px}table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden}td,th{border-bottom:1px solid #e3e6ef;padding:8px;text-align:left;vertical-align:top}code{background:#f1f3f9;padding:1px 5px;border-radius:6px;word-break:break-all}.muted{color:#5b6070;font-size:13px}@media (prefers-color-scheme:dark){body{background:#0f1117;color:#eef0f6}table{background:#171a23}td,th{border-color:#2a2f3d}code{background:#1f2330}.muted{color:#a3a9ba}}</style></head>
<body><main><h1>Scout API</h1><p>Base URL: <code>${esc(publicUrl)}</code>. Machine-readable spec: <a href="/openapi.json">/openapi.json</a>. Errors look like <code>{"error":{"code":"...","message":"..."}}</code>.</p>
<p>Servers send <code>Authorization: Bearer sct_sec_...</code> (the app key). Browsers send a short-lived user token <code>sct_ut_...</code> made by your server with <code>POST /v1/users/token</code>.</p>
<table><thead><tr><th>Method</th><th>Path</th><th>What it does</th><th>Login</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}
