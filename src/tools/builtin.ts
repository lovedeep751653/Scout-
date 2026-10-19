import { newId } from '../security/crypto.ts';
import { stripSecretsFromUserText } from '../security/redact.ts';
import type { ToolDefinition, ToolRegistry } from './registry.ts';

export const currentDatetime: ToolDefinition = {
  name: 'current_datetime',
  description: 'Get the current date and time (UTC and India time). Use it for questions about today, dates or how long ago something happened.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permission: 'read',
  source: 'builtin',
  optIn: true,
  label: 'Checking the date',
  handler: async () => {
    const now = new Date();
    return {
      utc: now.toISOString(),
      india: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' }),
    };
  },
};

export const rememberNote: ToolDefinition = {
  name: 'remember_note',
  description: 'Save a short note the user asked you to remember (for example a preference). Needs the user to press Confirm. Never save passwords, OTPs or codes.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 500, description: 'The note, in the user words.' } },
    required: ['text'],
    additionalProperties: false,
  },
  permission: 'write_confirm',
  source: 'builtin',
  optIn: true,
  label: 'Saving a note',
  summarize: (args) => `Save this note: "${String(args.text)}"`,
  handler: async (args, ctx) => {
    const clean = stripSecretsFromUserText(String(args.text));
    if (clean.removedSecrets) throw new Error('That note looks like it contains a password or code, so it was not saved.');
    const id = newId('note');
    await ctx.db.run('INSERT INTO user_notes (id, project_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)', [id, ctx.projectId, ctx.userId, clean.text, Date.now()]);
    return { saved: true, id };
  },
};

export const listNotes: ToolDefinition = {
  name: 'list_notes',
  description: 'List the notes this user asked you to remember earlier.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permission: 'read',
  source: 'builtin',
  optIn: true,
  label: 'Reading your notes',
  handler: async (_args, ctx) => {
    const rows = await ctx.db.all<{ text: string; created_at: number }>(
      'SELECT text, created_at FROM user_notes WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50',
      [ctx.projectId, ctx.userId],
    );
    return { notes: rows.map((r) => ({ text: r.text, saved_at: new Date(Number(r.created_at)).toISOString() })) };
  },
};

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(currentDatetime);
  registry.register(rememberNote);
  registry.register(listNotes);
}
