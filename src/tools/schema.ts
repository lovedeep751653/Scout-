import type { JsonSchema } from '../providers/types.ts';

const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);
const ALLOWED_KEYWORDS = new Set([
  'type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'format', 'default', 'title',
]);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

export function validate(value: unknown, schema: JsonSchema, path = 'input'): string[] {
  const errors: string[] = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      return [`${path} must be ${types.join(' or ')}`];
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long (max ${schema.maxLength})`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path} has the wrong format`);
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${path} must be an email address`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(item, schema.items!, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    // Object.hasOwn, not `in` or plain indexing: keys such as "constructor" or
    // "__proto__" must not match inherited object members.
    for (const req of schema.required ?? []) if (!Object.hasOwn(obj, req) || obj[req] === undefined) errors.push(`${path}.${req} is required`);
    for (const [k, v] of Object.entries(obj)) {
      const prop = schema.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
      if (prop) errors.push(...validate(v, prop, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(v, schema.additionalProperties, `${path}.${k}`));
    }
  }
  return errors.slice(0, 10);
}

// Checks a schema sent by an app when it registers a webhook tool.
export function checkToolSchema(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'input_schema must be a JSON object';
  if ((schema as JsonSchema).type !== 'object') return 'input_schema must have "type": "object"';
  if (JSON.stringify(schema).length > 8000) return 'input_schema is too large (max 8 KB)';
  const walk = (s: unknown, depth: number): string | null => {
    if (depth > 6) return 'input_schema is nested too deeply';
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'every schema node must be an object';
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (!ALLOWED_KEYWORDS.has(k)) return `schema keyword "${k}" is not supported`;
      if ((k === 'enum' || k === 'required') && !Array.isArray(v)) return `${k} must be a list`;
      if (k === 'required' && !(v as unknown[]).every((x) => typeof x === 'string')) return 'required must list property names';
      if (['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'].includes(k) && (typeof v !== 'number' || !Number.isFinite(v))) return `${k} must be a number`;
      if (k === 'type') {
        const list = Array.isArray(v) ? v : [v];
        if (!list.every((t) => typeof t === 'string' && TYPES.has(t))) return `unknown type ${JSON.stringify(v)}`;
      }
      if (k === 'pattern') {
        if (typeof v !== 'string' || v.length > 200) return 'pattern must be a short string';
        try {
          new RegExp(v, 'u');
        } catch {
          return 'pattern is not a valid regular expression';
        }
      }
      if (k === 'properties') {
        if (!v || typeof v !== 'object') return 'properties must be an object';
        for (const child of Object.values(v as Record<string, unknown>)) {
          const e = walk(child, depth + 1);
          if (e) return e;
        }
      }
      if ((k === 'items' || (k === 'additionalProperties' && typeof v === 'object')) && v) {
        const e = walk(v, depth + 1);
        if (e) return e;
      }
    }
    return null;
  };
  return walk(schema, 0);
}

export const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
