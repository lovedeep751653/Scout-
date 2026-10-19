const EMAIL = /([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sct_(?:pub|sec|ut)_)[A-Za-z0-9._-]{4,}/g, '$1[REDACTED]'],
  [/\b(whsec_)[A-Za-z0-9_-]{4,}/g, '$1[REDACTED]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[GOOGLE_TOKEN]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[GOOGLE_REFRESH_TOKEN]'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, '[GOOGLE_API_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[API_KEY]'],
  [/\bgsk_[A-Za-z0-9]{16,}/g, '[API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT]'],
  [/\b[a-f0-9]{40,}\b/gi, '[HEX_SECRET]'],
];

const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|password|passwd|secret|token|access_token|refresh_token|api_key|apikey|x-scout-key|x-api-key|x-goog-api-key|signing_secret|client_secret|otp|code)$/i;

export function maskEmail(value: string): string {
  return value.replace(EMAIL, '$1***@$2');
}

export function redactText(value: string): string {
  let out = value;
  for (const [re, replacement] of TOKEN_PATTERNS) out = out.replace(re, replacement);
  return maskEmail(out);
}

export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[DEEP]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Finds passwords, OTPs and similar secrets a user may paste into the chat so they are never stored.
const PASSWORD_RE = /(?<![\p{L}\p{N}])(password|passwd|pwd|passcode|पासवर्ड)(\s*(?:is|hai|h|=|:|-)\s*|\s*[:=]\s*)(\S{3,})/giu;
const OTP_AFTER_RE =
  /(?<![\p{L}\p{N}])(otp|one[- ]time (?:password|code)|verification code|security code|login code|2fa code|code|pin|ओटीपी|कोड)(?![\p{L}])([^0-9\n]{0,20}?)(\d{4,8})(?!\d)/giu;
const OTP_BEFORE_RE = /(?<!\d)(\d{4,8})(?!\d)(?=[^0-9\n]{0,20}?(?<![\p{L}])(?:otp|code|pin|ओटीपी|कोड)(?![\p{L}]))/giu;

export interface SanitizedText {
  text: string;
  removedSecrets: boolean;
}

export function stripSecretsFromUserText(input: string): SanitizedText {
  let removed = false;
  let text = input;
  text = text.replace(PASSWORD_RE, (_m, label: string, sep: string) => {
    removed = true;
    return `${label}${sep}[removed]`;
  });
  text = text.replace(OTP_AFTER_RE, (_m, label: string, between: string) => {
    removed = true;
    return `${label}${between}[removed]`;
  });
  text = text.replace(OTP_BEFORE_RE, () => {
    removed = true;
    return '[removed]';
  });
  for (const [re, replacement] of TOKEN_PATTERNS.slice(0, 9)) {
    const next = text.replace(re, replacement);
    if (next !== text) removed = true;
    text = next;
  }
  return { text, removedSecrets: removed };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

export function cleanText(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHARS, '').slice(0, maxLength);
}
