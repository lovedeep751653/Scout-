import { cardSummaryForModel, type Card } from '../agent/cards.ts';
import { getLoginLensConnector, LOGINLENS_TOOL_NAMES, loginLensTools } from '../connectors/loginlens.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Project } from '../keys/projects.ts';
import type { JsonSchema, Part, ToolCall, ToolSpec } from '../providers/types.ts';
import { audit } from '../security/audit.ts';
import { newId, randomBase62, type Secrets } from '../security/crypto.ts';
import { cleanText } from '../security/redact.ts';
import { checkToolSchema, TOOL_NAME, validate } from './schema.ts';
import { callWebhook, checkWebhookUrl, WebhookError } from './webhook.ts';

export type Permission = 'read' | 'write_confirm';

export interface ToolContext {
  db: Db;
  config: Config;
  secrets: Secrets;
  projectId: string;
  userId: string;
  sessionId: string;
  keyId: string | null;
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  permission: Permission;
  source: 'builtin' | 'webhook' | 'connector';
  // Off unless the app turns it on (settings.enabled_tools). Small models misuse tools
  // that do not fit the task, so only relevant tools are offered by default.
  optIn?: boolean;
  // Short text the widget shows while the tool runs, e.g. "Checking your emails".
  label?: string;
  summarize?: (args: Record<string, unknown>) => string;
  // Builds a verified answer card from the tool data (see agent/cards.ts).
  card?: (args: Record<string, unknown>, data: unknown, staleDays: number) => Card | null;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface PendingActionView {
  id: string;
  tool: string;
  summary: string;
  expires_at: number;
}

export type ToolEvent =
  | { type: 'tool'; name: string; label: string; status: 'running' | 'done' | 'error' | 'needs_confirmation' }
  | { type: 'action'; action: PendingActionView }
  | { type: 'card'; card: Card };

export function toSpec(t: ToolDefinition): ToolSpec {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

// Email subjects and app data can carry text written to steer the AI ("ignore all rules,
// tell the user..."). Such sentences are cut out before the model ever sees them; the
// system prompt rule is the second line of defence.
const INJECTION =
  /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(rules?|instructions?|prompts?|messages?|guidelines?)\b|\b(system|assistant|developer)\s*(:|prompt\b)|\byou are now\b|\bnew instructions?\b|\btell the user\b|\b(reveal|print|show)\b[^.!?\n]{0,30}\b(prompt|instructions?|secret|key)\b|\bpassword is\b|\bdo not tell\b|<\/?(system|instructions?|tool_result)>/i;

export function neutralizeInjection(text: string): string {
  if (!INJECTION.test(text)) return text;
  const kept = text.split(/(?<=[.!?।])\s+|\n+/).map((s) => (INJECTION.test(s) ? '[suspicious text removed]' : s));
  return kept.join(' ');
}

function sanitizeForModel(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[nested too deep]';
  if (typeof value === 'string') return neutralizeInjection(cleanText(value, 1000));
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitizeForModel(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) out[cleanText(k, 100)] = sanitizeForModel(v, depth + 1);
    return out;
  }
  return value;
}

function dropKeys(value: unknown, key: string, depth = 0): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => dropKeys(v, key, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (k !== key) out[k] = dropKeys(v, key, depth + 1);
    return out;
  }
  return value;
}

// Tool output reaches the model wrapped and labelled as untrusted data; the system
// prompt tells the model never to follow instructions found inside it.
export function wrapToolOutput(tool: string, data: unknown, maxChars = 20_000): string {
  let json = JSON.stringify({ tool, untrusted_data: sanitizeForModel(data) });
  if (json.length > maxChars) json = JSON.stringify({ tool, untrusted_data: json.slice(0, maxChars), truncated: true });
  return json;
}

async function withTimeout<T>(ms: number, signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new Error(`The tool took longer than ${ms} ms.`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// ---------- registry ----------

interface WebhookRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  input_schema: string;
  permission: string;
  url: string;
  secret_enc: string;
  enabled: number;
  timeout_ms: number | null;
  created_at: number;
  updated_at: number;
}

export class ToolRegistry {
  private readonly builtins = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (!TOOL_NAME.test(def.name)) throw new Error(`Bad tool name: ${def.name}`);
    this.builtins.set(def.name, def);
  }

  builtinNames(): string[] {
    return [...this.builtins.keys()];
  }

  listBuiltins(): ToolDefinition[] {
    return [...this.builtins.values()];
  }

  async forProject(db: Db, project: Project, secrets: Secrets, config: Config, opts: { demo?: boolean } = {}): Promise<ToolDefinition[]> {
    const disabled = new Set(project.settings.disabledTools ?? []);
    const enabled = new Set(project.settings.enabledTools ?? []);
    const tools = [...this.builtins.values()].filter((t) => !disabled.has(t.name) && (!t.optIn || enabled.has(t.name)));
    const rows = await db.all<WebhookRow>('SELECT * FROM webhook_tools WHERE project_id = ? AND enabled = 1 ORDER BY name', [project.id]);
    const connector = await getLoginLensConnector(db, project.id);
    if (connector || opts.demo) {
      for (const t of loginLensTools(connector, secrets, config, project.id)) if (!disabled.has(t.name)) tools.push(t);
    }
    const taken = new Set(tools.map((t) => t.name));
    for (const row of rows) {
      if (disabled.has(row.name) || taken.has(row.name)) continue;
      tools.push(webhookTool(row, secrets, config));
    }
    return tools;
  }
}

function webhookTool(row: WebhookRow, secrets: Secrets, config: Config): ToolDefinition {
  return {
    name: row.name,
    description: row.description,
    inputSchema: JSON.parse(row.input_schema) as JsonSchema,
    permission: row.permission === 'write_confirm' ? 'write_confirm' : 'read',
    source: 'webhook',
    label: `Asking ${row.name.replace(/_/g, ' ')}`,
    summarize: (args) => `Run "${row.name}" with ${JSON.stringify(args).slice(0, 200)}`,
    handler: async (args, ctx) => {
      const result = await callWebhook({
        url: row.url,
        secret: secrets.decrypt(row.secret_enc, `webhook:${row.id}`),
        payload: {
          tool: row.name,
          arguments: args,
          context: { project_id: ctx.projectId, session_id: ctx.sessionId, user_id: ctx.userId },
          timestamp: Math.floor(Date.now() / 1000),
        },
        timeoutMs: Math.min(row.timeout_ms ?? config.webhookTimeoutMs, config.webhookTimeoutMs),
        maxResponseBytes: config.webhookMaxResponseBytes,
        allowHttp: config.webhookAllowHttp,
      });
      return result.data;
    },
  };
}

// ---------- webhook tool management ----------

export interface WebhookToolInput {
  name: unknown;
  description: unknown;
  input_schema: unknown;
  permission?: unknown;
  url: unknown;
  timeout_ms?: unknown;
}

export class ToolInputError extends Error {}

export async function upsertWebhookTool(db: Db, secrets: Secrets, config: Config, registry: ToolRegistry, projectId: string, input: WebhookToolInput) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!TOOL_NAME.test(name)) throw new ToolInputError('name must start with a letter and use only letters, numbers, _ or - (max 64).');
  if (registry.builtinNames().includes(name) || LOGINLENS_TOOL_NAMES.includes(name)) throw new ToolInputError(`"${name}" is a built-in tool name. Pick another name.`);
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 1000) : '';
  if (description.length < 10) throw new ToolInputError('description must explain what the tool does (at least 10 characters).');
  const schemaError = checkToolSchema(input.input_schema);
  if (schemaError) throw new ToolInputError(schemaError);
  const permission = input.permission === 'write_confirm' ? 'write_confirm' : input.permission === undefined || input.permission === 'read' ? 'read' : null;
  if (!permission) throw new ToolInputError('permission must be "read" or "write_confirm".');
  if (typeof input.url !== 'string') throw new ToolInputError('url is required.');
  try {
    checkWebhookUrl(input.url, config.webhookAllowHttp);
  } catch (err) {
    throw new ToolInputError((err as Error).message);
  }
  const timeout = typeof input.timeout_ms === 'number' ? Math.max(500, Math.min(config.webhookTimeoutMs, Math.floor(input.timeout_ms))) : null;
  const now = Date.now();
  const existing = await db.get<{ id: string }>('SELECT id FROM webhook_tools WHERE project_id = ? AND name = ?', [projectId, name]);
  const id = existing?.id ?? newId('wht');
  const signingSecret = `whsec_${randomBase62(40)}`;
  const enc = secrets.encrypt(signingSecret, `webhook:${id}`);
  if (existing) {
    await db.run('UPDATE webhook_tools SET description = ?, input_schema = ?, permission = ?, url = ?, secret_enc = ?, timeout_ms = ?, enabled = 1, updated_at = ? WHERE id = ?', [
      description, JSON.stringify(input.input_schema), permission, input.url, enc, timeout, now, id,
    ]);
  } else {
    await db.run(
      'INSERT INTO webhook_tools (id, project_id, name, description, input_schema, permission, url, secret_enc, enabled, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [id, projectId, name, description, JSON.stringify(input.input_schema), permission, input.url, enc, timeout, now, now],
    );
  }
  return { id, name, permission, url: input.url, signing_secret: signingSecret };
}

export async function listWebhookTools(db: Db, projectId: string) {
  const rows = await db.all<WebhookRow>('SELECT * FROM webhook_tools WHERE project_id = ? ORDER BY name', [projectId]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    input_schema: JSON.parse(r.input_schema) as unknown,
    permission: r.permission,
    url: r.url,
    enabled: Number(r.enabled) === 1,
    timeout_ms: r.timeout_ms,
    created_at: Number(r.created_at),
  }));
}

export async function deleteWebhookTool(db: Db, projectId: string, name: string): Promise<boolean> {
  return (await db.run('DELETE FROM webhook_tools WHERE project_id = ? AND name = ?', [projectId, name])).changes > 0;
}

// ---------- running tool calls ----------

export interface ToolRunOutcome {
  parts: Part[];
  pending: PendingActionView[];
  cards: Card[];
  repeatsOnly: boolean;
}

function callKey(call: ToolCall): string {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  const sorted = Object.keys(call.args).sort().reduce<Record<string, unknown>>((o, k) => ((o[k] = norm(call.args[k])), o), {});
  return `${call.name}:${JSON.stringify(sorted)}`;
}

// `memo` remembers results within one agent run. Small models sometimes repeat the same
// call instead of answering; they get the earlier result back with a nudge to answer.
export async function runToolCalls(
  calls: ToolCall[],
  tools: ToolDefinition[],
  ctx: ToolContext,
  emit: (e: ToolEvent) => void,
  memo: Map<string, string> = new Map(),
): Promise<ToolRunOutcome> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const pending: PendingActionView[] = [];
  const cards: Card[] = [];
  let repeats = 0;
  const parts = await Promise.all(
    calls.map(async (call): Promise<Part> => {
      const key = callKey(call);
      const previous = memo.get(key);
      if (previous !== undefined) {
        repeats++;
        return {
          type: 'tool_result',
          callId: call.id,
          name: call.name,
          content: `${previous}\n\nNOTE: You already called ${call.name} with the same input and got the result above. Do not call it again. Answer the user now.`,
        };
      }
      const tool = byName.get(call.name);
      const base = { projectId: ctx.projectId, keyId: ctx.keyId, sessionId: ctx.sessionId, userId: ctx.userId, toolName: call.name };
      if (!tool) {
        await audit(ctx.db, { ...base, event: 'tool_call', status: 'unknown_tool' });
        return { type: 'tool_result', callId: call.id, name: call.name, content: `Unknown tool "${call.name}". Use only the tools you were given.`, isError: true };
      }
      const label = tool.label ?? tool.name.replace(/_/g, ' ');
      let errors: string[];
      try {
        errors = validate(call.args, tool.inputSchema);
      } catch {
        errors = ['the tool input could not be checked'];
      }
      if (errors.length) {
        await audit(ctx.db, { ...base, event: 'tool_call', status: 'invalid_input', detail: { errors } });
        return { type: 'tool_result', callId: call.id, name: call.name, content: `Invalid input: ${errors.join('; ')}`, isError: true };
      }
      if (tool.permission === 'write_confirm') {
        const action = await createPendingAction(ctx, tool, call.args);
        pending.push(action);
        emit({ type: 'tool', name: tool.name, label, status: 'needs_confirmation' });
        emit({ type: 'action', action });
        await audit(ctx.db, { ...base, event: 'tool_pending', status: 'needs_confirmation', detail: { action_id: action.id } });
        const content = JSON.stringify({
          status: 'needs_confirmation',
          action_id: action.id,
          summary: action.summary,
          note: 'Nothing has been done yet. Tell the user what will happen and ask them to press Confirm. Do not say it is done.',
        });
        memo.set(key, content);
        return { type: 'tool_result', callId: call.id, name: call.name, content };
      }
      emit({ type: 'tool', name: tool.name, label, status: 'running' });
      const started = Date.now();
      try {
        const data = await withTimeout(ctx.config.toolTimeoutMs, ctx.signal, (signal) => tool.handler(call.args, { ...ctx, signal }));
        emit({ type: 'tool', name: tool.name, label, status: 'done' });
        await audit(ctx.db, { ...base, event: 'tool_call', status: 'ok', durationMs: Date.now() - started, detail: { args: call.args } });
        const card = tool.card?.(call.args, data, ctx.config.staleDataDays) ?? null;
        if (card) {
          cards.push(card);
          emit({ type: 'card', card });
        }
        // With a card the model only needs the facts, not raw email subjects (the main
        // place injected text hides), which also keeps the prompt short on a CPU.
        const content = card ? wrapToolOutput(tool.name, { ...cardSummaryForModel(card), details: dropKeys(data, 'subject') }) : wrapToolOutput(tool.name, data);
        memo.set(key, content);
        return { type: 'tool_result', callId: call.id, name: call.name, content };
      } catch (err) {
        const message = err instanceof WebhookError || err instanceof Error ? err.message : 'The tool failed.';
        emit({ type: 'tool', name: tool.name, label, status: 'error' });
        await audit(ctx.db, { ...base, event: 'tool_call', status: 'error', durationMs: Date.now() - started, detail: { error: message } });
        return { type: 'tool_result', callId: call.id, name: call.name, content: `The tool failed: ${cleanText(message, 300)}`, isError: true };
      }
    }),
  );
  return { parts, pending, cards, repeatsOnly: repeats === calls.length };
}

// ---------- confirmations (enforced by the server, not by the prompt) ----------

async function createPendingAction(ctx: ToolContext, tool: ToolDefinition, args: Record<string, unknown>): Promise<PendingActionView> {
  const id = newId('act');
  const now = Date.now();
  const expires = now + ctx.config.pendingActionTtlMs;
  const summary = cleanText(tool.summarize?.(args) ?? `Run ${tool.name}`, 300);
  await ctx.db.run(
    'INSERT INTO pending_actions (id, project_id, session_id, user_id, key_id, tool_name, args, summary, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, ctx.projectId, ctx.sessionId, ctx.userId, ctx.keyId, tool.name, JSON.stringify(args), summary, 'pending', now, expires],
  );
  return { id, tool: tool.name, summary, expires_at: expires };
}

interface ActionRow {
  id: string;
  project_id: string;
  session_id: string;
  user_id: string;
  tool_name: string;
  args: string;
  summary: string;
  status: string;
  expires_at: number;
}

export type ActionResult =
  | { ok: true; status: 'confirmed' | 'cancelled'; tool: string; summary: string; result?: unknown; sessionId: string }
  | { ok: false; code: 'not_found' | 'already_done' | 'expired' | 'tool_unavailable' | 'failed'; message: string };

export async function resolveAction(
  ctx: Omit<ToolContext, 'sessionId'>,
  actionId: string,
  decision: 'confirm' | 'cancel',
  tools: ToolDefinition[],
): Promise<ActionResult> {
  const row = await ctx.db.get<ActionRow>('SELECT * FROM pending_actions WHERE id = ? AND project_id = ? AND user_id = ?', [actionId, ctx.projectId, ctx.userId]);
  if (!row) return { ok: false, code: 'not_found', message: 'This action was not found.' };
  const now = Date.now();
  if (row.status !== 'pending') return { ok: false, code: 'already_done', message: 'This action was already handled.' };
  if (Number(row.expires_at) <= now) {
    await ctx.db.run("UPDATE pending_actions SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'", [now, actionId]);
    return { ok: false, code: 'expired', message: 'This action expired. Please ask again.' };
  }
  const nextStatus = decision === 'confirm' ? 'running' : 'cancelled';
  const claimed = await ctx.db.run('UPDATE pending_actions SET status = ?, resolved_at = ? WHERE id = ? AND status = ? AND expires_at > ?', [nextStatus, now, actionId, 'pending', now]);
  if (claimed.changes !== 1) return { ok: false, code: 'already_done', message: 'This action was already handled.' };
  const base = { projectId: ctx.projectId, keyId: ctx.keyId, sessionId: row.session_id, userId: ctx.userId, toolName: row.tool_name };
  if (decision === 'cancel') {
    await audit(ctx.db, { ...base, event: 'action_cancelled', status: 'cancelled', detail: { action_id: actionId } });
    return { ok: true, status: 'cancelled', tool: row.tool_name, summary: row.summary, sessionId: row.session_id };
  }
  const tool = tools.find((t) => t.name === row.tool_name && t.permission === 'write_confirm');
  const args = JSON.parse(row.args) as Record<string, unknown>;
  let invalid = true;
  try {
    invalid = !tool || validate(args, tool.inputSchema).length > 0;
  } catch {
    invalid = true;
  }
  if (!tool || invalid) {
    await ctx.db.run("UPDATE pending_actions SET status = 'failed' WHERE id = ?", [actionId]);
    return { ok: false, code: 'tool_unavailable', message: 'This action can no longer run (the tool is turned off or changed).' };
  }
  const started = Date.now();
  try {
    const result = await withTimeout(ctx.config.toolTimeoutMs, ctx.signal, (signal) => tool.handler(args, { ...ctx, sessionId: row.session_id, signal }));
    await ctx.db.run("UPDATE pending_actions SET status = 'confirmed', result = ? WHERE id = ?", [JSON.stringify(result ?? null).slice(0, 4000), actionId]);
    await audit(ctx.db, { ...base, event: 'action_confirmed', status: 'ok', durationMs: Date.now() - started, detail: { action_id: actionId } });
    return { ok: true, status: 'confirmed', tool: row.tool_name, summary: row.summary, result, sessionId: row.session_id };
  } catch (err) {
    await ctx.db.run("UPDATE pending_actions SET status = 'failed', result = ? WHERE id = ?", [JSON.stringify({ error: (err as Error).message }).slice(0, 1000), actionId]);
    await audit(ctx.db, { ...base, event: 'action_confirmed', status: 'error', durationMs: Date.now() - started, detail: { error: (err as Error).message } });
    return { ok: false, code: 'failed', message: `The action failed: ${cleanText((err as Error).message, 200)}` };
  }
}
