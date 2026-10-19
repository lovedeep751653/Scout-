import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let cached: string | null = null;

export function widgetScript(_publicUrl: string): string {
  if (cached === null) cached = fs.readFileSync(path.join(here, '..', '..', 'public', 'scout.js'), 'utf8');
  return cached;
}
