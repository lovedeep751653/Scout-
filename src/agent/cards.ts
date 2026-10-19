import type { Lang } from './language.ts';

// Answer cards are built by Scout from tool data, never written by the model, so the
// one-line answer and its proof cannot be invented. The model only adds commentary.
export interface EvidenceItem {
  account: string;
  kind: string;
  date: string;
  device?: string;
  location?: string;
  url?: string;
}

export interface PresenceCard {
  type: 'presence';
  service: string;
  answer: 'yes' | 'not_found';
  // True when the user has no connected email accounts, so nothing could be checked.
  noAccounts: boolean;
  count: number;
  proof: EvidenceItem[];
  confidence: 'high' | 'medium' | 'low';
  lastEvidence: string | null;
  checkedAt: string | null;
  stale: boolean;
}

export interface CountCard {
  type: 'count';
  what: 'devices' | 'services' | 'alerts';
  scope: string | null;
  count: number;
  checkedAt: string | null;
  stale: boolean;
}

export type Card = PresenceCard | CountCard;

const STRONG = new Set(['welcome', 'verify', 'new_login', 'security_alert', 'receipt', 'password_reset']);
const YEAR_MS = 365 * 24 * 3600 * 1000;

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function validDate(v: unknown): string | null {
  const s = str(v, 40);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
}

export function isStale(checkedAt: string | null, staleDays: number, now = Date.now()): boolean {
  if (!checkedAt) return true;
  return now - Date.parse(checkedAt) > staleDays * 24 * 3600 * 1000;
}

// Expects the LoginLens check_service contract (see docs/INTEGRATION.md).
export function presenceCard(data: unknown, staleDays: number, now = Date.now(), askedService = ''): PresenceCard | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const accounts = Array.isArray(d.accounts) ? d.accounts : null;
  if (!accounts) return null;
  const proof: EvidenceItem[] = [];
  let withEvidence = 0;
  for (const a of accounts.slice(0, 50)) {
    if (!a || typeof a !== 'object') continue;
    const acc = a as Record<string, unknown>;
    const evidence = Array.isArray(acc.evidence) ? acc.evidence : [];
    let counted = false;
    for (const e of evidence.slice(0, 200)) {
      if (!e || typeof e !== 'object') continue;
      const ev = e as Record<string, unknown>;
      const date = validDate(ev.date);
      if (!date) continue;
      if (!counted) {
        withEvidence++;
        counted = true;
      }
      proof.push({
        account: str(acc.email, 254),
        kind: str(ev.kind, 40) || 'other',
        date,
        ...(str(ev.device) ? { device: str(ev.device) } : {}),
        ...(str(ev.location) ? { location: str(ev.location) } : {}),
        ...(str(ev.record_url, 500).startsWith('http') ? { url: str(ev.record_url, 500) } : {}),
      });
    }
  }
  proof.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const checkedAt = validDate(d.data_checked_at);
  const stale = isStale(checkedAt, staleDays, now);
  const lastEvidence = proof[0]?.date ?? null;
  let confidence: PresenceCard['confidence'];
  const connected = typeof d.connected_accounts === 'number' ? d.connected_accounts : accounts.length;
  if (proof.length === 0) {
    confidence = stale || connected === 0 ? 'low' : 'medium';
  } else {
    const strong = proof.filter((p) => STRONG.has(p.kind));
    const recentStrong = strong.some((p) => now - Date.parse(p.date) < YEAR_MS);
    confidence = recentStrong || strong.length >= 2 ? 'high' : strong.length === 1 || proof.length >= 2 ? 'medium' : 'low';
  }
  return {
    type: 'presence',
    service: str(d.service, 200) || askedService.slice(0, 200) || 'this service',
    answer: proof.length > 0 ? 'yes' : 'not_found',
    noAccounts: proof.length === 0 && connected === 0,
    count: withEvidence,
    proof: proof.slice(0, 3),
    confidence,
    lastEvidence,
    checkedAt,
    stale,
  };
}

export function countCard(what: CountCard['what'], data: unknown, scope: string | null, staleDays: number, now = Date.now()): CountCard | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const list = d[what];
  const count = typeof d.total === 'number' ? d.total : Array.isArray(list) ? list.length : null;
  if (count === null || !Number.isFinite(count) || count < 0) return null;
  const checkedAt = validDate(d.data_checked_at);
  return { type: 'count', what, scope, count: Math.floor(count), checkedAt, stale: isStale(checkedAt, staleDays, now) };
}

// ---------- rendering ----------

const KIND: Record<string, Record<Lang, string>> = {
  welcome: { en: 'welcome email', hi: 'स्वागत ईमेल', hinglish: 'welcome email' },
  verify: { en: 'verification email', hi: 'सत्यापन ईमेल', hinglish: 'verification email' },
  password_reset: { en: 'password reset email', hi: 'पासवर्ड रीसेट ईमेल', hinglish: 'password reset email' },
  receipt: { en: 'receipt', hi: 'रसीद', hinglish: 'receipt' },
  subscription: { en: 'subscription email', hi: 'सदस्यता ईमेल', hinglish: 'subscription email' },
  new_login: { en: 'new sign-in alert', hi: 'नए लॉगिन की सूचना', hinglish: 'naye login ka alert' },
  security_alert: { en: 'security alert', hi: 'सुरक्षा चेतावनी', hinglish: 'security alert' },
  other: { en: 'email', hi: 'ईमेल', hinglish: 'email' },
};

const L = {
  yes: { en: 'Yes', hi: 'हाँ', hinglish: 'Haan' },
  notFound: { en: 'No — not found in your emails', hi: 'नहीं — आपके ईमेल में नहीं मिला', hinglish: 'Nahi — aapke emails mein nahi mila' },
  account: { en: ['account', 'accounts'], hi: ['अकाउंट', 'अकाउंट'], hinglish: ['account', 'accounts'] },
  proof: { en: 'Proof', hi: 'सबूत', hinglish: 'Saboot' },
  confidence: { en: 'Confidence', hi: 'भरोसा', hinglish: 'Bharosa' },
  level: {
    high: { en: 'High', hi: 'उच्च', hinglish: 'High' },
    medium: { en: 'Medium', hi: 'मध्यम', hinglish: 'Medium' },
    low: { en: 'Low', hi: 'कम', hinglish: 'Low' },
  },
  last: { en: 'Last evidence', hi: 'आखिरी सबूत', hinglish: 'Aakhri saboot' },
  none: { en: 'none', hi: 'कोई नहीं', hinglish: 'koi nahi' },
  basis: {
    en: 'Based on emails only; the service itself was not checked.',
    hi: 'यह सिर्फ़ ईमेल पर आधारित है; सेवा से सीधे जाँच नहीं की गई।',
    hinglish: 'Yeh sirf emails par based hai; service ko seedha check nahi kiya gaya.',
  },
  noAccounts: {
    en: 'No email accounts are connected yet, so nothing could be checked. Connect an email account in LoginLens first.',
    hi: 'अभी कोई ईमेल अकाउंट जुड़ा नहीं है, इसलिए कुछ जाँचा नहीं जा सका। पहले LoginLens में ईमेल अकाउंट जोड़ें।',
    hinglish: 'Abhi koi email account connected nahi hai, isliye kuch check nahi ho saka. Pehle LoginLens mein email account connect karein.',
  },
  neverScanned: {
    en: 'Note: your emails have not been scanned yet.',
    hi: 'ध्यान दें: आपके ईमेल अभी तक स्कैन नहीं हुए हैं।',
    hinglish: 'Dhyan dein: aapke emails abhi tak scan nahi hue hain.',
  },
  stale: {
    en: 'Note: your email data was last checked {when}. Ask for a rescan to get fresh results.',
    hi: 'ध्यान दें: आपका ईमेल डेटा आखिरी बार {when} को जाँचा गया था। ताज़ा नतीजों के लिए फिर से स्कैन करवाएँ।',
    hinglish: 'Dhyan dein: aapka email data aakhri baar {when} ko check hua tha. Fresh results ke liye rescan karwaiye.',
  },
  never: { en: 'never', hi: 'कभी नहीं', hinglish: 'kabhi nahi' },
  found: {
    devices: { en: ['device found', 'devices found'], hi: ['डिवाइस मिला', 'डिवाइस मिले'], hinglish: ['device mila', 'devices mile'] },
    services: { en: ['service found', 'services found'], hi: ['सेवा मिली', 'सेवाएँ मिलीं'], hinglish: ['service mili', 'services mili'] },
    alerts: { en: ['alert found', 'alerts found'], hi: ['चेतावनी मिली', 'चेतावनियाँ मिलीं'], hinglish: ['alert mila', 'alerts mile'] },
  },
  for: { en: 'for', hi: 'के लिए', hinglish: 'ke liye' },
};

export function formatDate(iso: string | null, lang: Lang): string {
  if (!iso) return L.never[lang];
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function renderCard(card: Card, lang: Lang): string {
  const lines: string[] = [];
  if (card.type === 'presence' && card.noAccounts) return L.noAccounts[lang];
  if (card.type === 'presence') {
    if (card.answer === 'yes') {
      const word = L.account[lang][card.count === 1 ? 0 : 1];
      lines.push(`${L.yes[lang]} — ${card.count} ${word} (${card.service})`);
      lines.push(`${L.proof[lang]}:`);
      for (const p of card.proof) {
        const kind = (KIND[p.kind] ?? KIND.other!)[lang];
        lines.push(`• ${[p.account, kind, formatDate(p.date, lang), p.device, p.location].filter(Boolean).join(' · ')}`);
      }
    } else {
      lines.push(`${L.notFound[lang]} (${card.service})`);
    }
    lines.push(`${L.confidence[lang]}: ${L.level[card.confidence][lang]} · ${L.last[lang]}: ${card.lastEvidence ? formatDate(card.lastEvidence, lang) : L.none[lang]}`);
    lines.push(L.basis[lang]);
  } else {
    const word = L.found[card.what][lang][card.count === 1 ? 0 : 1];
    lines.push(card.scope ? (lang === 'en' ? `${card.count} ${word} ${L.for.en} ${card.scope}` : `${card.scope} ${L.for[lang]}: ${card.count} ${word}`) : `${card.count} ${word}`);
  }
  if (card.stale) lines.push(card.checkedAt ? L.stale[lang].replace('{when}', formatDate(card.checkedAt, lang)) : L.neverScanned[lang]);
  return lines.join('\n');
}

// The line given to the model so its commentary matches the card.
export function cardSummaryForModel(card: Card): Record<string, unknown> {
  if (card.type === 'presence') {
    return {
      answer_card_shown_to_user: card.answer === 'yes' ? `Yes, ${card.count} account(s) at ${card.service}` : `Not found in the user's emails (${card.service})`,
      confidence: card.confidence,
      last_evidence: card.lastEvidence,
      data_is_stale: card.stale,
    };
  }
  return { answer_card_shown_to_user: `${card.count} ${card.what}${card.scope ? ` for ${card.scope}` : ''}`, data_is_stale: card.stale };
}

const NEGATIVE_START = /^\W*(no\b|not found|nahi|nahin|नहीं|कोई नहीं|none\b|0 )/i;
const POSITIVE_START = /^\W*(yes\b|haan\b|han\b|हाँ|हां)/i;

// True when the model's first line contradicts the verified card.
export function contradictsCard(text: string, card: Card): boolean {
  const first = text.trim().split('\n')[0] ?? '';
  if (card.type !== 'presence') return false;
  return card.answer === 'yes' ? NEGATIVE_START.test(first) : POSITIVE_START.test(first);
}
