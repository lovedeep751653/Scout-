import { countCard, presenceCard } from '../agent/cards.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { randomBase62, type Secrets } from '../security/crypto.ts';
import { sampleAnswer } from './sample.ts';
import type { ToolDefinition } from '../tools/registry.ts';
import { callWebhook, checkWebhookUrl } from '../tools/webhook.ts';

// LoginLens owns the user data. Scout reads it through ONE signed endpoint on the
// LoginLens server (contract in docs/INTEGRATION.md). The user id always comes from
// Scout's authenticated context, never from the model, so users can't see each other's data.
export const CONNECTOR = 'loginlens';

interface ConnectorRow {
  url: string;
  secret_enc: string;
  enabled: number;
}

// Registering again keeps the same signing secret, so several LoginLens servers (or
// restarts) all agree on it. A new secret is made only on the first registration or
// when `rotate` is set.
export async function setLoginLensConnector(
  db: Db,
  secrets: Secrets,
  config: Config,
  projectId: string,
  url: string,
  rotate = false,
): Promise<{ url: string; signing_secret: string; secret_rotated: boolean }> {
  checkWebhookUrl(url, config.webhookAllowHttp || config.connectorAllowPrivateNetwork, config.connectorAllowPrivateNetwork);
  const purpose = `connector:${projectId}:${CONNECTOR}`;
  const existing = rotate ? undefined : await db.get<{ secret_enc: string }>('SELECT secret_enc FROM connectors WHERE project_id = ? AND name = ?', [projectId, CONNECTOR]);
  let signingSecret = '';
  if (existing) {
    try {
      signingSecret = secrets.decrypt(existing.secret_enc, purpose);
    } catch {
      signingSecret = '';
    }
  }
  const rotated = !signingSecret;
  if (rotated) signingSecret = `whsec_${randomBase62(40)}`;
  const now = Date.now();
  await db.run(
    `INSERT INTO connectors (project_id, name, url, secret_enc, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (project_id, name) DO UPDATE SET url = excluded.url, secret_enc = excluded.secret_enc, enabled = 1, updated_at = excluded.updated_at`,
    [projectId, CONNECTOR, url, secrets.encrypt(signingSecret, purpose), now, now],
  );
  return { url, signing_secret: signingSecret, secret_rotated: rotated };
}

export async function getLoginLensConnector(db: Db, projectId: string): Promise<{ url: string; secretEnc: string } | null> {
  const row = await db.get<ConnectorRow>('SELECT url, secret_enc, enabled FROM connectors WHERE project_id = ? AND name = ?', [projectId, CONNECTOR]);
  return row && Number(row.enabled) === 1 ? { url: row.url, secretEnc: row.secret_enc } : null;
}

export async function deleteLoginLensConnector(db: Db, projectId: string): Promise<boolean> {
  return (await db.run('DELETE FROM connectors WHERE project_id = ? AND name = ?', [projectId, CONNECTOR])).changes > 0;
}

const str = (description: string, maxLength = 200) => ({ type: 'string', description, maxLength });

interface Spec {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  permission?: 'read' | 'write_confirm';
  label: string;
  summarize?: (args: Record<string, unknown>) => string;
  card?: ToolDefinition['card'];
}

const SPECS: Spec[] = [
  {
    name: 'loginlens_overview',
    description: "Summary of the user's connected email accounts: which are connected, when each was last scanned, and totals of services, devices and recent alerts.",
    properties: {},
    label: 'Checking your connected accounts',
  },
  {
    name: 'loginlens_check_service',
    description: "Check if the user's email accounts show signs of an account at one website or app (sign-up, login, receipts). Use for 'Am I signed up / logged in to X?'.",
    properties: { service: str('Service name or domain, e.g. "netflix" or "netflix.com"', 120) },
    required: ['service'],
    label: 'Checking your emails',
    card: (args, data, staleDays) => presenceCard(data, staleDays, Date.now(), typeof args.service === 'string' ? args.service : ''),
  },
  {
    name: 'loginlens_search_services',
    description:
      'List or search the websites and apps found in the user emails. Filters: email account, category, services unused for N months, services linked to more than one email account.',
    properties: {
      query: str('Words to search in service names or domains', 120),
      email: str('Only services for this connected email address', 254),
      category: str('Category such as shopping, social, finance, streaming', 60),
      unused_for_months: { type: 'integer', minimum: 1, maximum: 120, description: 'Only services with no evidence for this many months' },
      linked_to_multiple_accounts: { type: 'boolean', description: 'Only services seen with two or more email accounts' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    label: 'Searching your services',
    card: (args, data, staleDays) => countCard('services', data, typeof args.email === 'string' ? args.email : null, staleDays),
  },
  {
    name: 'loginlens_devices',
    description: 'List devices seen in login and security emails, optionally for one service or one email account. Use for "how many devices".',
    properties: { service: str('Service name or domain', 120), email: str('Connected email address', 254) },
    label: 'Checking your devices',
    card: (args, data, staleDays) =>
      countCard('devices', data, typeof args.service === 'string' ? args.service : typeof args.email === 'string' ? args.email : null, staleDays),
  },
  {
    name: 'loginlens_security_alerts',
    description: 'New-login and security-alert emails, newest first, with service, account, device, location and date.',
    properties: { since_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Only alerts from the last N days (default 30)' } },
    label: 'Checking login alerts',
    card: (_args, data, staleDays) => countCard('alerts', data, null, staleDays),
  },
  {
    name: 'loginlens_evidence',
    description: 'The evidence records (email sender, subject, type, date) behind one service, optionally for one email account.',
    properties: { service: str('Service name or domain', 120), email: str('Connected email address', 254) },
    required: ['service'],
    label: 'Reading the evidence',
  },
  {
    name: 'loginlens_security_review',
    description:
      'Facts for a security review: old unused services, services on several accounts, recent password resets, new-login alerts and devices. Use for "what should I review / fix first".',
    properties: {},
    label: 'Preparing a security review',
  },
  {
    name: 'loginlens_add_note',
    description: 'Add a note or tag to one service in LoginLens. The user must press Confirm.',
    properties: { service: str('Service name or domain', 120), note: str('Short note', 300), tag: str('One short tag, e.g. "unused" or "work"', 40) },
    required: ['service'],
    permission: 'write_confirm',
    label: 'Adding a note',
    summarize: (a) => `Add to ${String(a.service)}${a.tag ? ` the tag "${String(a.tag)}"` : ''}${a.note ? ` the note "${String(a.note)}"` : ''}`,
  },
  {
    name: 'loginlens_rescan',
    description: 'Ask LoginLens to scan the user email accounts again for fresh results. The user must press Confirm.',
    properties: { email: str('Only rescan this connected email address', 254) },
    permission: 'write_confirm',
    label: 'Starting a rescan',
    summarize: (a) => (a.email ? `Rescan ${String(a.email)}` : 'Rescan all connected email accounts'),
  },
];

export const LOGINLENS_TOOL_NAMES = SPECS.map((s) => s.name);

export const isDemoUser = (userId: string) => userId.startsWith('demo:');

export function loginLensTools(connector: { url: string; secretEnc: string } | null, secrets: Secrets, config: Config, projectId: string): ToolDefinition[] {
  return SPECS.map((s) => ({
    name: s.name,
    description: s.description,
    inputSchema: { type: 'object', properties: s.properties as Record<string, never>, ...(s.required ? { required: s.required } : {}), additionalProperties: false },
    permission: s.permission ?? 'read',
    source: 'connector',
    label: s.label,
    summarize: s.summarize,
    card: s.card,
    handler: async (args, ctx) => {
      if (isDemoUser(ctx.userId)) return sampleAnswer(s.name, args);
      if (!connector) throw new Error('LoginLens is not connected to Scout yet, so account data cannot be read.');
      const result = await callWebhook({
        url: connector.url,
        secret: secrets.decrypt(connector.secretEnc, `connector:${projectId}:${CONNECTOR}`),
        payload: {
          tool: s.name,
          arguments: args,
          context: { project_id: ctx.projectId, user_id: ctx.userId, session_id: ctx.sessionId },
          timestamp: Math.floor(Date.now() / 1000),
        },
        timeoutMs: config.webhookTimeoutMs,
        maxResponseBytes: config.webhookMaxResponseBytes,
        allowHttp: config.webhookAllowHttp || config.connectorAllowPrivateNetwork,
        allowPrivateNetwork: config.connectorAllowPrivateNetwork,
      });
      return result.data;
    },
  }));
}
