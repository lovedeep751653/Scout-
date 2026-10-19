import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { checkUsageLimits, dayKey, getCounter, recordUsage, userSubject, QueueFullError, type ChatQueue } from '../keys/limits.ts';
import { isDemoUser } from '../connectors/loginlens.ts';
import { getProject } from '../keys/projects.ts';
import { costMicroUsd, priceFor } from '../providers/pricing.ts';
import { ProviderError, type GenerateResult, type Message, type ModelProvider, type Part, type Usage } from '../providers/types.ts';
import type { RuntimeStatus } from '../runtime/ollama.ts';
import type { Secrets } from '../security/crypto.ts';
import { cleanText, stripSecretsFromUserText } from '../security/redact.ts';
import { runToolCalls, toSpec, type PendingActionView, type ToolContext, type ToolEvent, type ToolRegistry } from '../tools/registry.ts';
import { renderCard, type Card } from './cards.ts';
import { detectLanguage, t, type Lang } from './language.ts';
import { appendMessages, createSession, getSession, loadMessages, summarize, summaryCut, toMessage, touchSession } from './memory.ts';
import { buildSystemPrompt } from './prompt.ts';


const DEMO_MAX_WAITING = 2;
export interface Principal {
  projectId: string;
  userId: string;
  keyId: string | null;
  keyBudget: number;
  via: 'app_key' | 'user_token';
}

export interface AgentDeps {
  db: Db;
  config: Config;
  secrets: Secrets;
  registry: ToolRegistry;
  provider: ModelProvider;
  runtime: { readonly ready: boolean; status(): RuntimeStatus } | null;
  queue: ChatQueue;
  log: { warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}

export interface ChatInput {
  message: string;
  sessionId?: string;
  language?: Lang;
}

export type AgentEvent =
  | { type: 'start'; session_id: string; language: Lang }
  | { type: 'queued'; position: number }
  | { type: 'delta'; text: string }
  | { type: 'notice'; code: string; message: string }
  | ToolEvent;

export type StopReason = 'limit' | 'not_ready' | 'busy' | 'timeout' | 'max_steps' | 'refusal' | 'ai_error' | 'setup' | null;

export interface ChatResult {
  session_id: string | null;
  message_id: string | null;
  reply: string;
  // `reply` split for chat windows: verified card texts, then notices and commentary.
  card_texts: string[];
  text: string;
  language: Lang;
  cards: Card[];
  pending_actions: PendingActionView[];
  usage: { input_tokens: number; output_tokens: number };
  stopped: StopReason;
  tools_used: string[];
}

export class AgentInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const NEGATIVE = /(not found|no account|not signed up|isn't signed|is not signed|don't have|do not have|nahi mila|nahi hai|koi account nahi|नहीं मिला|नहीं है|कोई अकाउंट नहीं)/i;
const POSITIVE = /(you have an account|you are signed up|aapka account hai|aapke paas .{0,30}account hai|आपका .{0,30}अकाउंट है|आपके पास .{0,30}अकाउंट है)/i;

// Small models sometimes contradict the verified card in their commentary; those
// sentences are removed so the user never sees two different answers.
export function filterCommentary(text: string, cards: Card[]): string {
  const presence = cards.filter((c) => c.type === 'presence');
  if (presence.length === 0 || !text.trim()) return text.trim();
  const yes = presence.some((c) => c.type === 'presence' && c.answer === 'yes');
  const no = presence.some((c) => c.type === 'presence' && c.answer === 'not_found');
  if (yes && no) return text.trim();
  const pieces = text.split(/(?<=[.!?।])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const startsNo = /^(no|nahi|nahin|नहीं)(?![\p{L}\p{M}\p{N}])/iu;
  const startsYes = /^(yes|haan|han|हाँ|हां)(?![\p{L}\p{M}\p{N}])/iu;
  const kept = pieces.filter((s) => (yes ? !NEGATIVE.test(s) && !startsNo.test(s) : !POSITIVE.test(s) && !startsYes.test(s)));
  return kept.join(' ').trim();
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?।])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// Drops sentences that mention a number or date found nowhere in the tool data, the
// cards or the user's message. Small models sometimes invent dates and counts.
export function groundNumbers(text: string, grounding: string): string {
  const known = new Set(grounding.replace(/T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, ' ').match(/\d{2,}/g) ?? []);
  const norm = (n: string) => n.replace(/^0+(?=\d)/, '');
  const knownNorm = new Set([...known].map(norm));
  return sentences(text)
    .filter((s) => (s.match(/\d{2,}/g) ?? []).every((n) => known.has(n) || knownNorm.has(norm(n))))
    .join(' ');
}

export function limitSentences(text: string, max: number, maxChars: number): string {
  let out = '';
  for (const s of sentences(text).slice(0, max)) {
    if ((out + ' ' + s).trim().length > maxChars) break;
    out = (out + ' ' + s).trim();
  }
  return out;
}

function friendlyProviderError(err: ProviderError, lang: Lang): { code: StopReason; text: string } {
  switch (err.kind) {
    case 'rate_limit':
      return { code: 'busy', text: t('busy', lang) };
    case 'timeout':
      return { code: 'timeout', text: t('timeout', lang) };
    case 'auth':
    case 'not_found':
    case 'bad_request':
      return { code: 'setup', text: t('setup_problem', lang) };
    default:
      return { code: 'ai_error', text: t('ai_down', lang) };
  }
}

function emptyResult(lang: Lang, sessionId: string | null, reply: string, stopped: StopReason): ChatResult {
  return { session_id: sessionId, message_id: null, reply, card_texts: [], text: reply, language: lang, cards: [], pending_actions: [], usage: { input_tokens: 0, output_tokens: 0 }, stopped, tools_used: [] };
}

export async function runChat(deps: AgentDeps, who: Principal, input: ChatInput, emit: (e: AgentEvent) => void = () => {}, signal?: AbortSignal): Promise<ChatResult> {
  const { db, config } = deps;
  const raw = typeof input.message === 'string' ? cleanText(input.message, config.maxMessageChars + 1).trim() : '';
  if (!raw) throw new AgentInputError('empty_message', 'Please type a question.');
  if (raw.length > config.maxMessageChars) throw new AgentInputError('message_too_long', `Please keep your message under ${config.maxMessageChars} characters.`);
  const lang: Lang = input.language ?? detectLanguage(raw);
  const project = await getProject(db, who.projectId);
  if (!project) throw new AgentInputError('project_not_found', 'This app is not set up in Scout.');

  let session = input.sessionId ? await getSession(db, who.projectId, who.userId, input.sessionId) : undefined;
  if (input.sessionId && !session) throw new AgentInputError('session_not_found', 'This conversation was not found. Start a new chat.');

  const subject = userSubject(who.projectId, who.userId);
  const demo = isDemoUser(who.userId);
  if (demo && (await getCounter(db, `demo:${who.projectId}`, dayKey())).requests >= config.demoDailyMessages) {
    return emptyResult(lang, session?.id ?? null, t('busy', lang), 'limit');
  }
  const breach = await checkUsageLimits(db, { userSubject: subject, keyId: who.keyId, keyBudget: who.keyBudget }, config.limits);
  if (breach) {
    const key = breach === 'daily_messages' ? 'daily_limit' : breach === 'monthly_tokens' ? 'monthly_limit' : 'key_budget';
    return emptyResult(lang, session?.id ?? null, t(key, lang), 'limit');
  }
  if (deps.runtime && !deps.runtime.ready) {
    const st = deps.runtime.status();
    const text = st.state === 'downloading' ? t('downloading', lang, { percent: st.percent ?? 0 }) : st.state === 'error' ? t('ai_down', lang) : t('not_ready', lang);
    return emptyResult(lang, session?.id ?? null, text, 'not_ready');
  }

  const deadline = AbortSignal.timeout(config.agentTimeoutMs);
  const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // Demo visitors may use only a small part of the waiting line, so real users keep their place.
  if (demo && deps.queue.length >= DEMO_MAX_WAITING) return emptyResult(lang, session?.id ?? null, t('queue_full', lang), 'busy');
  let release: () => void;
  try {
    release = await deps.queue.enter(runSignal, (position) => emit({ type: 'queued', position }));
  } catch (err) {
    if (err instanceof QueueFullError) return emptyResult(lang, session?.id ?? null, t('queue_full', lang), 'busy');
    return emptyResult(lang, session?.id ?? null, t('timeout', lang), 'timeout');
  }

  try {
    const clean = stripSecretsFromUserText(raw);
    if (!session) session = await createSession(db, { projectId: who.projectId, userId: who.userId, keyId: who.keyId, title: clean.text, language: lang });
    emit({ type: 'start', session_id: session.id, language: lang });

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const price = priceFor(deps.provider.model, { inputPerM: config.priceInputPerM, outputPerM: config.priceOutputPerM });
    const account = async (u: Usage) => {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      await recordUsage(db, { projectId: who.projectId, userSubject: subject, keyId: who.keyId }, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costMicroUsd: costMicroUsd(u, price) });
    };
    await recordUsage(db, { projectId: who.projectId, userSubject: subject, keyId: who.keyId }, { requests: 1 });
    if (demo) await recordUsage(db, { projectId: who.projectId, userSubject: `demo:${who.projectId}`, keyId: null }, { requests: 1 });

    // Memory: older turns are folded into a short summary once the chat gets long.
    let history = await loadMessages(db, session.id, session.summaryUpto);
    let summaryText = session.summary;
    const cut = summaryCut(history, config);
    if (cut > 0) {
      try {
        const s = await summarize(deps.provider, summaryText, history.slice(0, cut), runSignal);
        await account(s.usage);
        summaryText = s.summary;
        const upto = history[cut - 1]!.seq;
        await touchSession(db, session.id, { summary: summaryText, summaryUpto: upto });
        history = history.slice(cut);
      } catch (err) {
        deps.log.warn({ err: (err as Error).message }, 'summary failed; keeping full history');
      }
    }

    const tools = await deps.registry.forProject(db, project, deps.secrets, config, { demo });
    const specs = tools.map(toSpec);
    const system = buildSystemPrompt({
      agentName: project.settings.agentName || config.defaultAgentName,
      projectName: project.name,
      instructions: project.settings.instructions,
      lang,
      today: new Date().toISOString().slice(0, 10),
      summary: summaryText,
      hasLoginLensTools: tools.some((tl) => tl.name.startsWith('loginlens_')),
      demo,
    });

    const userMsg: Message = { role: 'user', parts: [{ type: 'text', text: clean.text }] };
    const working: Message[] = [...history.map(toMessage), userMsg];
    const fresh: Message[] = [userMsg];
    const cards: Card[] = [];
    const pending: PendingActionView[] = [];
    const used = new Set<string>();
    const memo = new Map<string, string>();
    const commentary: string[] = [];
    const grounding: string[] = [clean.text];
    let streamedAny = false;
    let stopped: StopReason = null;
    let lastAssistant: Message | null = null;
    let forceAnswer = false;
    const notices: string[] = [];
    if (clean.removedSecrets) {
      notices.push(t('secrets_removed', lang));
      emit({ type: 'notice', code: 'secrets_removed', message: t('secrets_removed', lang) });
    }

    const ctx: ToolContext = { db, config, secrets: deps.secrets, projectId: who.projectId, userId: who.userId, sessionId: session.id, keyId: who.keyId, signal: runSignal };

    for (let step = 0; step < config.agentMaxSteps; step++) {
      const last = step === config.agentMaxSteps - 1;
      if (who.keyBudget > 0 && step > 0) {
        const b = await checkUsageLimits(db, { userSubject: subject, keyId: who.keyId, keyBudget: who.keyBudget }, { userMessagesPerDay: Number.MAX_SAFE_INTEGER, userMonthlyTokens: 0 });
        if (b === 'key_budget') {
          notices.push(t('key_budget', lang));
          stopped = 'limit';
          break;
        }
      }
      let result: GenerateResult | null = null;
      let stepText = '';
      // After a card is shown, commentary is held back and checked before the user sees it.
      const holdText = cards.length > 0;
      try {
        const request = {
          system,
          messages: working,
          tools: specs,
          toolChoice: (last || forceAnswer ? 'none' : 'auto') as 'none' | 'auto',
          // After a card only a sentence or two of commentary is used, so stop early.
          ...(holdText ? { maxTokens: 300 } : {}),
          signal: runSignal,
        };
        for await (const ev of deps.provider.stream(request)) {
          if (ev.type === 'text') {
            stepText += ev.text;
            if (!holdText) {
              if (streamedAny && stepText === ev.text) emit({ type: 'delta', text: '\n\n' });
              emit({ type: 'delta', text: ev.text });
            }
          } else result = ev.result;
        }
      } catch (err) {
        if (deadline.aborted) {
          stopped = 'timeout';
          notices.push(t('timeout', lang));
        } else if (signal?.aborted) {
          stopped = 'timeout';
        } else {
          const pe = err instanceof ProviderError ? err : new ProviderError('server', deps.provider.name, (err as Error).message);
          deps.log.error({ kind: pe.kind, provider: pe.provider, status: pe.status, msg: pe.message }, 'model call failed');
          const f = friendlyProviderError(pe, lang);
          stopped = f.code;
          notices.push(f.text);
        }
        break;
      }
      if (!result) break;
      if (stepText && !holdText) streamedAny = true;
      await account(result.usage);
      working.push(result.message);
      fresh.push(result.message);
      lastAssistant = result.message;
      if (result.text.trim()) commentary.push(result.text.trim());

      if (result.stopReason === 'refusal') {
        if (!result.text.trim()) notices.push(t('refusal', lang));
        stopped = 'refusal';
        break;
      }
      if (result.toolCalls.length === 0) break;

      // Tool calls that will not run still get results, so the stored history stays valid.
      if (result.stopReason === 'max_tokens' || last) {
        const skipped: Message = {
          role: 'user',
          parts: result.toolCalls.map((c) => ({ type: 'tool_result', callId: c.id, name: c.name, content: 'Not run: step limit reached.', isError: true })),
        };
        working.push(skipped);
        fresh.push(skipped);
        if (last) {
          stopped = 'max_steps';
          if (cards.length === 0) notices.push(t('max_steps', lang));
        }
        break;
      }
      for (const c of result.toolCalls) used.add(c.name);
      const outcome = await runToolCalls(result.toolCalls, tools, ctx, emit, memo);
      for (const p of outcome.parts) if (p.type === 'tool_result') grounding.push(p.content);
      cards.push(...outcome.cards);
      pending.push(...outcome.pending);
      const resultMsg: Message = { role: 'user', parts: outcome.parts };
      working.push(resultMsg);
      fresh.push(resultMsg);
      forceAnswer = outcome.repeatsOnly;
    }

    // The reply the user sees: verified cards first, then the model's checked commentary.
    const cardTexts = cards.map((c) => renderCard(c, lang));
    grounding.push(...cardTexts);
    // Yes/No cards already hold the full answer and proof, so commentary stays short.
    // Count cards only hold a number, so the model's list is the useful part.
    // When the only data came from a Yes/No check, the card says everything (answer,
    // proof, confidence, date); small models' extra sentences mostly repeat or blur it.
    const hasPresence = cards.some((c) => c.type === 'presence');
    const cardTools = new Set(tools.filter((tl) => tl.card).map((tl) => tl.name));
    const onlyCheckTools = used.size > 0 && [...used].every((n) => cardTools.has(n)) && cards.every((c) => c.type === 'presence');
    let talk = cards.length ? filterCommentary(commentary.slice(-1).join('\n\n'), cards) : commentary.join('\n\n');
    if (hasPresence) talk = onlyCheckTools ? '' : limitSentences(talk, 2, 360);
    if (used.size > 0 && talk) talk = groundNumbers(talk, grounding.join('\n'));
    if (cards.length && talk) emit({ type: 'delta', text: `${streamedAny ? '\n\n' : ''}${talk}` });
    const text = [notices.join('\n\n'), talk].filter(Boolean).join('\n\n');
    const reply = [notices.join('\n\n'), ...cardTexts, talk].filter(Boolean).join('\n\n') || t('error', lang);

    const finalParts: Part[] = [{ type: 'text', text: reply, ...(cards.length ? { meta: { cards: JSON.stringify(cards) } } : {}) }];
    if (lastAssistant && lastAssistant.parts.every((p) => p.type !== 'tool_call')) {
      lastAssistant.parts = [...lastAssistant.parts.filter((p) => p.type === 'provider_raw'), ...finalParts];
    } else {
      fresh.push({ role: 'assistant', parts: finalParts });
    }
    const ids = await appendMessages(db, session.id, fresh);
    await touchSession(db, session.id, { language: lang });
    return {
      session_id: session.id,
      message_id: ids[ids.length - 1] ?? null,
      reply,
      card_texts: cardTexts,
      text: cardTexts.length || text ? text : reply,
      language: lang,
      cards,
      pending_actions: pending,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
      stopped,
      tools_used: [...used],
    };
  } finally {
    release();
  }
}
