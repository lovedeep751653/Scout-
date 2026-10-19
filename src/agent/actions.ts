import { isDemoUser } from '../connectors/loginlens.ts';
import { getProject } from '../keys/projects.ts';
import { resolveAction } from '../tools/registry.ts';
import { isLang, t } from './language.ts';
import type { AgentDeps, Principal } from './loop.ts';
import { appendMessages } from './memory.ts';

export interface ActionOutcome {
  ok: boolean;
  status: 'confirmed' | 'cancelled' | 'not_found' | 'already_done' | 'expired' | 'tool_unavailable' | 'failed';
  message: string;
  result?: unknown;
}

// The only way a write tool ever runs: the user presses Confirm, the app calls this.
export async function resolvePending(deps: AgentDeps, who: Principal, actionId: string, decision: 'confirm' | 'cancel'): Promise<ActionOutcome> {
  const project = await getProject(deps.db, who.projectId);
  if (!project) return { ok: false, status: 'not_found', message: 'This app is not set up in Scout.' };
  const tools = await deps.registry.forProject(deps.db, project, deps.secrets, deps.config, { demo: isDemoUser(who.userId) });
  const r = await resolveAction(
    { db: deps.db, config: deps.config, secrets: deps.secrets, projectId: who.projectId, userId: who.userId, keyId: who.keyId, signal: AbortSignal.timeout(deps.config.toolTimeoutMs + 5000) },
    actionId,
    decision,
    tools,
  );
  if (!r.ok) return { ok: false, status: r.code, message: r.message };
  const s = await deps.db.get<{ language: string | null }>('SELECT language FROM sessions WHERE id = ?', [r.sessionId]);
  const lang = isLang(s?.language) ? s.language : 'en';
  const message = t(r.status === 'confirmed' ? 'action_done' : 'action_cancelled', lang, { summary: r.summary });
  await appendMessages(deps.db, r.sessionId, [{ role: 'assistant', parts: [{ type: 'text', text: message }] }]);
  return { ok: true, status: r.status, message, ...(r.status === 'confirmed' ? { result: r.result } : {}) };
}
