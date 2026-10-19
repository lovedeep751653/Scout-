import type { Db } from '../db/index.ts';
import { newId } from '../security/crypto.ts';

export interface ProjectSettings {
  agentName?: string;
  instructions?: string;
  welcomeText?: string;
  primaryColor?: string;
  accentColor?: string;
  position?: 'bottom-right' | 'bottom-left';
  mode?: 'floating' | 'inline';
  theme?: 'auto' | 'light' | 'dark';
  quickReplies?: string[];
  disabledTools?: string[];
  answerStyle?: 'evidence' | 'plain';
  alertEmail?: string;
}

export interface Project {
  id: string;
  name: string;
  settings: ProjectSettings;
  createdAt: number;
  updatedAt: number;
}

interface ProjectRow {
  id: string;
  name: string;
  settings: string;
  created_at: number;
  updated_at: number;
}

function toProject(r: ProjectRow): Project {
  let settings: ProjectSettings = {};
  try {
    settings = JSON.parse(r.settings) as ProjectSettings;
  } catch {
    settings = {};
  }
  return { id: r.id, name: r.name, settings, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

export function sanitizeSettings(input: Record<string, unknown>, base: ProjectSettings = {}): ProjectSettings {
  const out: ProjectSettings = { ...base };
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  if ('agentName' in input) out.agentName = s(input.agentName, 40) || undefined;
  if ('instructions' in input) out.instructions = s(input.instructions, 2000) || undefined;
  if ('welcomeText' in input) out.welcomeText = s(input.welcomeText, 300) || undefined;
  for (const k of ['primaryColor', 'accentColor'] as const) {
    if (k in input) {
      const c = s(input[k], 7);
      out[k] = c && COLOR.test(c) ? c : undefined;
    }
  }
  if ('position' in input) out.position = input.position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
  if ('mode' in input) out.mode = input.mode === 'inline' ? 'inline' : 'floating';
  if ('theme' in input) out.theme = input.theme === 'light' || input.theme === 'dark' ? input.theme : 'auto';
  if ('answerStyle' in input) out.answerStyle = input.answerStyle === 'plain' ? 'plain' : 'evidence';
  if ('quickReplies' in input && Array.isArray(input.quickReplies)) {
    out.quickReplies = input.quickReplies.map((q) => s(q, 80)).filter((q): q is string => !!q).slice(0, 6);
  }
  if ('disabledTools' in input && Array.isArray(input.disabledTools)) {
    out.disabledTools = input.disabledTools.map((q) => s(q, 64)).filter((q): q is string => !!q).slice(0, 100);
  }
  if ('alertEmail' in input) out.alertEmail = s(input.alertEmail, 200) || undefined;
  return out;
}

export async function createProject(db: Db, name: string, settings: ProjectSettings = {}): Promise<Project> {
  const now = Date.now();
  const id = newId('prj');
  const cleanName = name.trim().slice(0, 80) || 'My App';
  await db.run('INSERT INTO projects (id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, cleanName, JSON.stringify(settings), now, now]);
  return { id, name: cleanName, settings, createdAt: now, updatedAt: now };
}

export async function getProject(db: Db, id: string): Promise<Project | undefined> {
  const row = await db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
  return row ? toProject(row) : undefined;
}

export async function listProjects(db: Db): Promise<Project[]> {
  return (await db.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at')).map(toProject);
}

export async function updateProject(db: Db, id: string, patch: { name?: string; settings?: Record<string, unknown> }): Promise<Project | undefined> {
  const current = await getProject(db, id);
  if (!current) return undefined;
  const name = patch.name?.trim().slice(0, 80) || current.name;
  const settings = patch.settings ? sanitizeSettings(patch.settings, current.settings) : current.settings;
  await db.run('UPDATE projects SET name = ?, settings = ?, updated_at = ? WHERE id = ?', [name, JSON.stringify(settings), Date.now(), id]);
  return { ...current, name, settings, updatedAt: Date.now() };
}

export async function deleteProject(db: Db, id: string): Promise<boolean> {
  return (await db.run('DELETE FROM projects WHERE id = ?', [id])).changes > 0;
}
