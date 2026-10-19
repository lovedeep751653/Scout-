import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { resolvePending } from '../agent/actions.ts';
import { isLang } from '../agent/language.ts';
import { AgentInputError, runChat, type AgentDeps, type AgentEvent, type Principal } from '../agent/loop.ts';
import { deleteSession, deleteUserData, exportUserData, getSession, listSessions, loadMessages, setFeedback, visibleMessages } from '../agent/memory.ts';
import { providerNeedsKey } from '../config.ts';
import { deleteLoginLensConnector, getLoginLensConnector, setLoginLensConnector } from '../connectors/loginlens.ts';
import { isPostgresUrl } from '../db/index.ts';
import {
  APP_KEY_PATTERN,
  KeyInputError,
  keyView,
  mintUserToken,
  normalizeOrigin,
  originAllowed,
  rotateKey,
  USER_ID_PATTERN,
  verifyKey,
  verifyUserToken,
  type ApiKey,
  type Scope,
} from '../keys/keys.ts';
import { getCounter, monthKey, RateLimiter } from '../keys/limits.ts';
import { getProject, listProjects, updateProject, type Project } from '../keys/projects.ts';
import { confirmSetup, setupStatus, setupView, setupWindowOpen } from '../keys/setup.ts';
import { audit } from '../security/audit.ts';
import { newId } from '../security/crypto.ts';
import { redactDeep, redactText } from '../security/redact.ts';
import { deleteWebhookTool, listWebhookTools, ToolInputError, upsertWebhookTool } from '../tools/registry.ts';
import { WebhookError } from '../tools/webhook.ts';
import { docsPage, openApiSpec } from './openapi.ts';
import { demoOffPage, demoPage, landingPage, setupPage } from './pages.ts';
import { widgetScript } from './widget.ts';

export interface ServerDeps extends AgentDeps {
  defaultProjectId: string;
  masterSecretSource: 'env' | 'file' | 'generated';
  limiter?: RateLimiter;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

type Caller =
  | { kind: 'app'; key: ApiKey; project: Project }
  | { kind: 'user'; projectId: string; userId: string; project: Project };

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (typeof h === 'string' && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const k = req.headers['x-scout-key'];
  return typeof k === 'string' ? k.trim() : '';
}

function body(req: FastifyRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
}

function query(req: FastifyRequest): Record<string, string> {
  return (req.query ?? {}) as Record<string, string>;
}

export async function buildApp(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, config } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
  const logger =
    config.logLevel === 'silent'
      ? false
      : ({
          level: config.logLevel,
          serializers: {
            req: (req: { method: string; url: string; ip: string }) => ({ method: req.method, url: redactText(req.url.replace(/([?&](?:key|token)=)[^&]+/gi, '$1[REDACTED]')), ip: req.ip }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          hooks: {
            logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
              // Only plain data objects are scrubbed here; request/response objects go
              // through the serializers above (copying them would lose their getters).
              const plain = (a: unknown) => !!a && typeof a === 'object' && Object.getPrototypeOf(a) === Object.prototype && !('req' in (a as object)) && !('res' in (a as object));
              method.apply(this, args.map((a) => (typeof a === 'string' ? redactText(a) : plain(a) ? redactDeep(a) : a)));
            },
          },
        } as unknown as FastifyServerOptions['logger']);
  const app = Fastify({ bodyLimit: 64 * 1024, trustProxy: config.trustProxy, logger });

  // ---------- allowed browser origins ----------
  let originCache: { at: number; list: string[] } = { at: 0, list: [] };
  const allowedOrigins = async (): Promise<string[]> => {
    if (Date.now() - originCache.at < 15_000) return originCache.list;
    const list = new Set<string>();
    const self = normalizeOrigin(config.publicUrl);
    if (self) list.add(self);
    for (const o of config.allowedOrigins) {
      const n = normalizeOrigin(o);
      if (n) list.add(n);
    }
    for (const p of await listProjects(db)) for (const o of p.settings.allowedOrigins ?? []) list.add(o);
    originCache = { at: Date.now(), list: [...list] };
    return originCache.list;
  };
  const resetOrigins = () => {
    originCache = { at: 0, list: [] };
  };

  // Requests from Scout's own pages (setup, demo) are always allowed, even if
  // PUBLIC_URL was not set.
  const sameHost = (origin: string, req: FastifyRequest) => {
    try {
      return !origin.includes('*') && new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    const origin = req.headers.origin;
    if (!origin) return;
    const ok = sameHost(origin, req) || originAllowed(await allowedOrigins(), origin);
    if (ok) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      reply.code(ok ? 204 : 403).send();
      return reply;
    }
    if (!ok && req.url.startsWith('/v1/')) throw new HttpError(403, 'origin_not_allowed', `The website ${origin} is not allowed to use Scout. The app owner can add it to allowed_origins.`);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof AgentInputError) return reply.code(err.code === 'session_not_found' ? 404 : 400).send({ error: { code: err.code, message: err.message } });
    if (err instanceof KeyInputError || err instanceof ToolInputError || err instanceof WebhookError) {
      return reply.code(400).send({ error: { code: 'invalid_input', message: err.message } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    }
    req.log.error({ err: { name: err.name, message: err.message } }, 'request failed');
    return reply.code(500).send({ error: { code: 'server_error', message: 'Something went wrong in Scout. Please try again.' } });
  });

  // ---------- authentication ----------
  const limit = (id: string, max: number, what: string) => {
    const r = limiter.hit(id, max);
    if (!r.allowed) throw new HttpError(429, 'rate_limited', `Too many ${what}. Please wait ${r.retryAfterSec} seconds.`, { 'retry-after': String(r.retryAfterSec) });
  };

  const authFailed = (req: FastifyRequest, message: string): never => {
    limit(`authfail:${req.ip}`, 20, 'failed sign-in attempts');
    throw new HttpError(401, 'unauthorized', message);
  };

  async function authenticate(req: FastifyRequest, scope: Scope, opts: { allowUserToken: boolean }): Promise<Caller> {
    const token = bearer(req);
    if (!token) return authFailed(req, 'Missing credentials. Servers send "Authorization: Bearer <app key>"; the chat window sends a user token.');
    if (token.startsWith('sct_ut_')) {
      if (!opts.allowUserToken) throw new HttpError(403, 'forbidden', 'A user token cannot do this. Use the app key from your server.');
      const u = verifyUserToken(deps.secrets, token);
      if (!u) return authFailed(req, 'This user token is invalid or has expired. Ask the app for a new one.');
      const project = await getProject(db, u.projectId);
      if (!project) return authFailed(req, 'This user token belongs to an app that no longer exists.');
      limit(`ip:${req.ip}`, config.limits.ipRequestsPerMinute, 'requests from your network');
      return { kind: 'user', projectId: u.projectId, userId: u.userId, project };
    }
    if (!APP_KEY_PATTERN.test(token)) return authFailed(req, 'That is not a Scout key.');
    if (req.headers.origin) {
      throw new HttpError(403, 'app_key_in_browser', 'App keys must only be used from your server, never from a browser. Give the browser a user token instead.');
    }
    const check = await verifyKey(db, token);
    if (!check.ok) return authFailed(req, check.reason === 'not_found' ? 'Unknown app key.' : `This app key is ${check.reason}.`);
    if (!check.key.scopes.includes(scope)) throw new HttpError(403, 'missing_scope', `This app key does not have the "${scope}" permission.`);
    limit(`key:${check.key.id}`, check.key.rateLimitPerMin, 'requests for this app key');
    const project = await getProject(db, check.key.projectId);
    if (!project) throw new HttpError(401, 'unauthorized', 'This app key belongs to an app that no longer exists.');
    return { kind: 'app', key: check.key, project };
  }

  function principalFor(caller: Caller, req: FastifyRequest): Principal {
    if (caller.kind === 'user') return { projectId: caller.projectId, userId: caller.userId, keyId: null, keyBudget: 0, via: 'user_token' };
    const raw = body(req).user_id ?? query(req).user_id;
    if (typeof raw !== 'string' || !USER_ID_PATTERN.test(raw)) {
      throw new HttpError(400, 'user_id_required', 'Send user_id: the id of the signed-in user in your app (letters, numbers and _ . : @ + -, max 128).');
    }
    return { projectId: caller.project.id, userId: raw, keyId: caller.key.id, keyBudget: caller.key.monthlyTokenBudget, via: 'app_key' };
  }

  // ---------- public pages ----------
  const aiStatus = () =>
    deps.runtime ? deps.runtime.status() : { state: 'ready' as const, model: deps.provider.model, message: `Using ${deps.provider.name}.`, since: Date.now() };

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(landingPage(config.publicUrl)));

  app.get('/health', async () => {
    let database = 'ok';
    try {
      await db.ping();
    } catch {
      database = 'error';
    }
    const ai = aiStatus();
    const status = database !== 'ok' ? 'degraded' : ai.state === 'ready' ? 'ok' : ai.state === 'error' ? 'degraded' : 'starting';
    return { status, version: config.version, database, ai: { state: ai.state, model: ai.model, ...(ai.percent !== undefined ? { percent: ai.percent } : {}) } };
  });

  app.get('/setup', async (_req, reply) => {
    const view = await setupView(db, deps.secrets);
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'");
    return reply.type('text/html; charset=utf-8').send(setupPage({ view, publicUrl: config.publicUrl, ai: aiStatus(), windowMinutes: config.setupWindowMinutes }));
  });

  app.post('/setup/confirm', async (req) => {
    const origin = req.headers.origin;
    if (origin && origin !== normalizeOrigin(config.publicUrl) && !sameHost(origin, req)) throw new HttpError(403, 'forbidden', 'Confirm setup from the Scout setup page.');
    return { ok: await confirmSetup(db) };
  });

  // ---------- demo with sample data (setup hour, or DEMO_MODE=true) ----------
  const demoAvailable = async () => config.demoMode || (await setupWindowOpen(db));
  app.get('/demo', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    if (!(await demoAvailable())) return reply.code(404).send(demoOffPage());
    const project = await getProject(db, deps.defaultProjectId);
    return reply.send(demoPage(project?.settings.agentName || config.defaultAgentName));
  });

  app.post('/demo/token', async (req, reply) => {
    if (!(await demoAvailable())) throw new HttpError(404, 'demo_off', 'The demo is turned off.');
    const origin = req.headers.origin;
    if (origin && origin !== normalizeOrigin(config.publicUrl) && !sameHost(origin, req)) throw new HttpError(403, 'forbidden', 'The demo token is only for the Scout demo page.');
    limit(`demo-token:${req.ip}`, 10, 'demo requests');
    const cookie = /(?:^|;\s*)scout_demo=([A-Za-z0-9]{16,40})/.exec(req.headers.cookie ?? '')?.[1];
    const visitor = cookie ?? newId('v').slice(2);
    if (!cookie) {
      reply.header('set-cookie', `scout_demo=${visitor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${config.publicUrl.startsWith('https:') ? '; Secure' : ''}`);
    }
    return mintUserToken(deps.secrets, deps.defaultProjectId, `demo:${visitor}`, 900);
  });

  app.get('/favicon.ico', async (_req, reply) => reply.code(204).header('cache-control', 'public, max-age=86400').send());
  app.get('/openapi.json', async () => openApiSpec(config.publicUrl, config.version));
  app.get('/docs', async (_req, reply) => reply.type('text/html; charset=utf-8').send(docsPage(config.publicUrl)));

  app.get('/scout.js', async (_req, reply) =>
    reply.type('application/javascript; charset=utf-8').header('cache-control', 'public, max-age=300').header('access-control-allow-origin', '*').send(widgetScript(config.publicUrl)),
  );

  // ---------- app-key (server) routes ----------
  app.get('/v1/status', async (req) => {
    const c = await authenticate(req, 'chat', { allowUserToken: false });
    if (c.kind !== 'app') throw new HttpError(403, 'forbidden', 'Use the app key.');
    const ai = aiStatus();
    const warnings: Array<{ code: string; message: string }> = [];
    if (ai.state === 'error') warnings.push({ code: 'ai_error', message: `The AI is not working: ${ai.message}` });
    if (ai.state === 'downloading' || ai.state === 'starting' || ai.state === 'loading') warnings.push({ code: 'ai_starting', message: ai.message });
    if (providerNeedsKey(config.primary.provider) && !config.primary.apiKey) {
      warnings.push({ code: 'provider_key_missing', message: `MODEL_PROVIDER=${config.primary.provider} needs SCOUT_MODEL_API_KEY. Or switch back to the free local model (MODEL_PROVIDER=ollama).` });
    }
    if (config.primary.provider === 'mock') warnings.push({ code: 'mock_ai', message: 'Scout is using the built-in test AI (MODEL_PROVIDER=mock). Answers are not real.' });
    if (deps.masterSecretSource !== 'env' && isPostgresUrl(config.databaseUrl)) {
      warnings.push({ code: 'encryption_key_file', message: 'Set SCOUT_ENCRYPTION_KEY in your hosting secrets. Without it, saved secrets cannot be read after the server disk resets.' });
    }
    if (process.env.SPACE_ID && !fs.existsSync('/data') && !config.databaseUrl) {
      warnings.push({ code: 'no_persistent_storage', message: 'This Hugging Face Space has no persistent storage, so chats and settings are lost when it restarts.' });
    }
    const connector = await getLoginLensConnector(db, c.project.id);
    if (!connector) warnings.push({ code: 'loginlens_not_connected', message: 'LoginLens has not registered its data endpoint (PUT /v1/connectors/loginlens), so Scout cannot answer account questions yet.' });
    if (!(c.project.settings.allowedOrigins ?? []).length && config.allowedOrigins.length === 0) {
      warnings.push({ code: 'no_allowed_origins', message: 'No websites are allowed to show the Scout chat window yet (PUT /v1/settings with allowed_origins).' });
    }
    const usage = await getCounter(db, `project:${c.project.id}`, monthKey());
    return {
      project: { id: c.project.id, name: c.project.name },
      app_key: keyView(c.key),
      setup: await setupStatus(db),
      ai: { provider: config.primary.provider, ...ai },
      loginlens_connector: connector ? { url: connector.url } : null,
      usage_this_month: { requests: usage.requests, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
      warnings,
    };
  });

  app.post('/v1/app-key/rotate', async (req) => {
    const c = await authenticate(req, 'keys:rotate', { allowUserToken: false });
    if (c.kind !== 'app') throw new HttpError(403, 'forbidden', 'Use the app key.');
    const rawGrace = body(req).grace_seconds ?? 3600;
    if (typeof rawGrace !== 'number' || !Number.isFinite(rawGrace)) throw new HttpError(400, 'bad_grace', 'grace_seconds must be a number of seconds (0 to 604800).');
    const grace = Math.max(0, Math.min(7 * 86_400, Math.floor(rawGrace)));
    const created = await rotateKey(db, c.key.id, grace * 1000);
    if (!created) throw new HttpError(409, 'cannot_rotate', 'This key cannot be rotated.');
    await audit(db, { projectId: c.project.id, keyId: c.key.id, event: 'app_key_rotated', status: 'ok', detail: { new_key_id: created.key.id, grace_seconds: grace } });
    return { app_key: created.plaintext, key: keyView(created.key), old_key_valid_until: Date.now() + grace * 1000, note: 'Save the new key in your server secrets now. It is shown only once.' };
  });

  app.post('/v1/users/token', async (req) => {
    const c = await authenticate(req, 'users:token', { allowUserToken: false });
    if (c.kind !== 'app') throw new HttpError(403, 'forbidden', 'Use the app key.');
    const b = body(req);
    if (typeof b.user_id !== 'string' || !USER_ID_PATTERN.test(b.user_id)) throw new HttpError(400, 'user_id_required', 'Send user_id: the id of the signed-in user in your app.');
    const ttl = Math.max(60, Math.min(config.userTokenMaxTtlSeconds, Number(b.ttl_seconds ?? 900) || 900));
    const { token, expiresAt } = mintUserToken(deps.secrets, c.project.id, b.user_id, ttl);
    return { token, expires_at: expiresAt };
  });

  const settingsView = (p: Project) => ({
    name: p.name,
    agent_name: p.settings.agentName ?? config.defaultAgentName,
    instructions: p.settings.instructions ?? null,
    welcome_text: p.settings.welcomeText ?? null,
    primary_color: p.settings.primaryColor ?? null,
    accent_color: p.settings.accentColor ?? null,
    position: p.settings.position ?? 'bottom-right',
    mode: p.settings.mode ?? 'floating',
    theme: p.settings.theme ?? 'auto',
    quick_replies: p.settings.quickReplies ?? [],
    disabled_tools: p.settings.disabledTools ?? [],
    enabled_tools: p.settings.enabledTools ?? [],
    allowed_origins: p.settings.allowedOrigins ?? [],
  });

  app.get('/v1/settings', async (req) => {
    const c = await authenticate(req, 'settings', { allowUserToken: false });
    return settingsView(c.project);
  });

  app.put('/v1/settings', async (req) => {
    const c = await authenticate(req, 'settings', { allowUserToken: false });
    const b = body(req);
    const map: Record<string, string> = {
      agent_name: 'agentName',
      instructions: 'instructions',
      welcome_text: 'welcomeText',
      primary_color: 'primaryColor',
      accent_color: 'accentColor',
      position: 'position',
      mode: 'mode',
      theme: 'theme',
      quick_replies: 'quickReplies',
      disabled_tools: 'disabledTools',
      enabled_tools: 'enabledTools',
      allowed_origins: 'allowedOrigins',
    };
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (map[k]) patch[map[k]!] = v;
    const updated = await updateProject(db, c.project.id, { name: typeof b.name === 'string' ? b.name : undefined, settings: patch });
    resetOrigins();
    return settingsView(updated!);
  });

  app.put('/v1/connectors/loginlens', async (req) => {
    const c = await authenticate(req, 'connectors', { allowUserToken: false });
    const url = body(req).url;
    if (typeof url !== 'string') throw new HttpError(400, 'url_required', 'Send url: the address on your LoginLens server that answers Scout tool calls.');
    const r = await setLoginLensConnector(db, deps.secrets, config, c.project.id, url);
    await audit(db, { projectId: c.project.id, keyId: c.kind === 'app' ? c.key.id : null, event: 'connector_set', status: 'ok', detail: { url } });
    return { ...r, note: 'Keep signing_secret on your LoginLens server. Scout signs every call with it (header x-scout-signature).' };
  });

  app.delete('/v1/connectors/loginlens', async (req) => {
    const c = await authenticate(req, 'connectors', { allowUserToken: false });
    return { deleted: await deleteLoginLensConnector(db, c.project.id) };
  });

  app.get('/v1/tools', async (req) => {
    const c = await authenticate(req, 'tools:manage', { allowUserToken: false });
    const all = await deps.registry.forProject(db, c.project, deps.secrets, config);
    return {
      tools: all.map((tl) => ({ name: tl.name, description: tl.description, permission: tl.permission, source: tl.source })),
      webhook_tools: await listWebhookTools(db, c.project.id),
    };
  });

  app.post('/v1/tools', async (req) => {
    const c = await authenticate(req, 'tools:manage', { allowUserToken: false });
    const b = body(req);
    const r = await upsertWebhookTool(db, deps.secrets, config, deps.registry, c.project.id, {
      name: b.name,
      description: b.description,
      input_schema: b.input_schema,
      permission: b.permission,
      url: b.url,
      timeout_ms: b.timeout_ms,
    });
    return { ...r, note: 'Keep signing_secret on your server. It is shown only once.' };
  });

  app.delete('/v1/tools/:name', async (req) => {
    const c = await authenticate(req, 'tools:manage', { allowUserToken: false });
    return { deleted: await deleteWebhookTool(db, c.project.id, (req.params as { name: string }).name) };
  });

  app.get('/v1/users/:user_id/export', async (req) => {
    const c = await authenticate(req, 'data:export', { allowUserToken: false });
    const userId = (req.params as { user_id: string }).user_id;
    if (!USER_ID_PATTERN.test(userId)) throw new HttpError(400, 'bad_user_id', 'That user id is not valid.');
    return exportUserData(db, c.project.id, userId);
  });

  app.delete('/v1/users/:user_id', async (req) => {
    const c = await authenticate(req, 'data:delete', { allowUserToken: false });
    const userId = (req.params as { user_id: string }).user_id;
    if (!USER_ID_PATTERN.test(userId)) throw new HttpError(400, 'bad_user_id', 'That user id is not valid.');
    const r = await deleteUserData(db, c.project.id, userId);
    await audit(db, { projectId: c.project.id, keyId: c.kind === 'app' ? c.key.id : null, event: 'user_data_deleted', status: 'ok', detail: r });
    return { deleted: r };
  });

  // ---------- chat (app key + user_id, or a user token from the chat window) ----------
  app.get('/v1/widget/config', async (req) => {
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const s = settingsView(c.project);
    return {
      agent_name: s.agent_name,
      welcome_text: s.welcome_text,
      primary_color: s.primary_color,
      accent_color: s.accent_color,
      position: s.position,
      mode: s.mode,
      theme: s.theme,
      quick_replies: s.quick_replies,
      ai: { state: aiStatus().state },
    };
  });

  const chatInput = (req: FastifyRequest) => {
    const b = body(req);
    return {
      message: typeof b.message === 'string' ? b.message : '',
      sessionId: typeof b.session_id === 'string' && b.session_id ? b.session_id : undefined,
      language: isLang(b.language) ? b.language : undefined,
    };
  };

  app.post('/v1/chat', async (req) => {
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const who = principalFor(c, req);
    limit(`user:${who.projectId}:${who.userId}`, config.limits.userMessagesPerMinute, 'messages; please slow down');
    const ctrl = new AbortController();
    req.raw.on('close', () => {
      if (req.raw.destroyed && !req.raw.complete) ctrl.abort();
    });
    return runChat(deps, who, chatInput(req), undefined, ctrl.signal);
  });

  app.post('/v1/chat/stream', async (req, reply) => {
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const who = principalFor(c, req);
    limit(`user:${who.projectId}:${who.userId}`, config.limits.userMessagesPerMinute, 'messages; please slow down');
    const input = chatInput(req);
    if (!input.message.trim()) throw new AgentInputError('empty_message', 'Please type a question.');
    const ctrl = new AbortController();
    reply.hijack();
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    for (const [k, v] of Object.entries(reply.getHeaders())) if (typeof v === 'string') headers[k] = v;
    reply.raw.writeHead(200, headers);
    let open = true;
    const send = (event: string, data: unknown) => {
      if (open) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    reply.raw.on('close', () => {
      open = false;
      ctrl.abort();
    });
    const ping = setInterval(() => open && reply.raw.write(': ping\n\n'), 15_000);
    try {
      const result = await runChat(deps, who, input, (e: AgentEvent) => send(e.type, e), ctrl.signal);
      send('done', result);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (!(err instanceof AgentInputError)) req.log.error({ err: { name: e.name, message: e.message } }, 'stream failed');
      send('error', { code: err instanceof AgentInputError ? err.code : 'server_error', message: err instanceof AgentInputError ? err.message : 'Something went wrong in Scout. Please try again.' });
    } finally {
      clearInterval(ping);
      if (open) reply.raw.end();
    }
  });

  app.post('/v1/actions/:id/:decision', async (req) => {
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== 'confirm' && decision !== 'cancel') throw new HttpError(404, 'not_found', 'Use /confirm or /cancel.');
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const who = principalFor(c, req);
    const r = await resolvePending(deps, who, id, decision);
    if (!r.ok) throw new HttpError(r.status === 'not_found' ? 404 : 409, r.status, r.message);
    return r;
  });

  app.get('/v1/sessions', async (req) => {
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const who = principalFor(c, req);
    const n = Number(query(req).limit ?? 20);
    const lim = Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : 20;
    return { sessions: await listSessions(db, who.projectId, who.userId, lim) };
  });

  app.get('/v1/sessions/:id/messages', async (req) => {
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const who = principalFor(c, req);
    const s = await getSession(db, who.projectId, who.userId, (req.params as { id: string }).id);
    if (!s) throw new HttpError(404, 'session_not_found', 'This conversation was not found.');
    return { session: { id: s.id, title: s.title, language: s.language }, messages: visibleMessages(await loadMessages(db, s.id)) };
  });

  app.delete('/v1/sessions/:id', async (req) => {
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const who = principalFor(c, req);
    const ok = await deleteSession(db, who.projectId, who.userId, (req.params as { id: string }).id);
    if (!ok) throw new HttpError(404, 'session_not_found', 'This conversation was not found.');
    return { deleted: true };
  });

  app.post('/v1/messages/:id/feedback', async (req) => {
    const c = await authenticate(req, 'chat', { allowUserToken: true });
    const who = principalFor(c, req);
    const v = body(req).value;
    if (v !== 1 && v !== -1 && v !== null) throw new HttpError(400, 'bad_value', 'value must be 1 (thumbs up), -1 (thumbs down) or null.');
    const ok = await setFeedback(db, who.projectId, who.userId, (req.params as { id: string }).id, v);
    if (!ok) throw new HttpError(404, 'message_not_found', 'That message was not found.');
    return { ok: true };
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'This address does not exist in Scout. See /docs.' } }));
  return app;
}
