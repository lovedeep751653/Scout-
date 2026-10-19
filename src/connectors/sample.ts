// Made-up sample data for the /demo page, so Scout can be tried before LoginLens is
// connected. Every answer is marked sample_data: true and is never shown to real users.
const DAY = 86_400_000;

function checked(now: number): string {
  return new Date(now - 2 * DAY).toISOString();
}

const ACCOUNTS = ['riya.sharma@gmail.com', 'riya@work-example.com'];

const SERVICES = [
  {
    service: 'netflix.com', name: 'Netflix', category: 'streaming', accounts: ACCOUNTS, first_seen: '2023-03-12', last_seen: '2026-09-30',
    evidence: {
      'riya.sharma@gmail.com': [
        { kind: 'welcome', date: '2023-03-12', subject: 'Welcome to Netflix' },
        { kind: 'new_login', date: '2026-09-30', subject: 'New sign-in to your account', device: 'Chrome on Windows', location: 'Delhi, IN' },
      ],
      'riya@work-example.com': [{ kind: 'receipt', date: '2025-01-05', subject: 'Your Netflix receipt' }],
    } as Record<string, Array<Record<string, string>>>,
  },
  {
    service: 'amazon.in', name: 'Amazon', category: 'shopping', accounts: ['riya.sharma@gmail.com'], first_seen: '2019-07-01', last_seen: '2026-10-10',
    evidence: { 'riya.sharma@gmail.com': [{ kind: 'receipt', date: '2026-10-10', subject: 'Your Amazon.in order' }] } as Record<string, Array<Record<string, string>>>,
  },
  {
    service: 'github.com', name: 'GitHub', category: 'developer', accounts: ['riya@work-example.com'], first_seen: '2021-02-02', last_seen: '2026-08-01',
    evidence: {
      'riya@work-example.com': [{ kind: 'security_alert', date: '2026-08-01', subject: 'A new SSH key was added', device: 'Firefox on Linux', location: 'Pune, IN' }],
    } as Record<string, Array<Record<string, string>>>,
  },
  {
    service: 'orkut.com', name: 'Orkut', category: 'social', accounts: ['riya.sharma@gmail.com'], first_seen: '2009-05-01', last_seen: '2014-06-30',
    evidence: { 'riya.sharma@gmail.com': [{ kind: 'welcome', date: '2009-05-01', subject: 'Welcome to orkut' }] } as Record<string, Array<Record<string, string>>>,
  },
];

const DEVICES = [
  { name: 'Chrome on Windows', type: 'desktop', location: 'Delhi, IN', first_seen: '2024-01-01', last_seen: '2026-09-30', services: ['netflix.com'] },
  { name: 'Firefox on Linux', type: 'desktop', location: 'Pune, IN', first_seen: '2026-08-01', last_seen: '2026-08-01', services: ['github.com'] },
  { name: 'Safari on iPhone', type: 'mobile', location: 'Delhi, IN', first_seen: '2025-05-05', last_seen: '2026-07-07', services: ['amazon.in'] },
];

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/^www\./, '').replace(/\.(com|in|org|net|co)$/, '').trim();

function find(q: unknown) {
  const n = norm(q);
  return n ? SERVICES.filter((s) => norm(s.service).includes(n) || norm(s.name).includes(n) || n.includes(norm(s.name))) : SERVICES;
}

const strip = ({ evidence: _e, ...rest }: (typeof SERVICES)[number]) => rest;

export function sampleAnswer(tool: string, args: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const base = { sample_data: true, data_checked_at: checked(now) };
  switch (tool) {
    case 'loginlens_overview':
      return { ...base, email_accounts: ACCOUNTS.map((email) => ({ email, connected: true, last_scan_at: checked(now) })), totals: { services: SERVICES.length, devices: DEVICES.length, alerts_30d: 1 } };
    case 'loginlens_check_service': {
      const s = find(args.service)[0];
      const asked = typeof args.service === 'string' ? args.service : '';
      return {
        ...base,
        service: s && norm(asked) ? s.service : asked,
        connected_accounts: ACCOUNTS.length,
        accounts: s && norm(asked) ? s.accounts.map((email) => ({ email, first_seen: s.first_seen, last_seen: s.last_seen, evidence: s.evidence[email] ?? [] })) : [],
      };
    }
    case 'loginlens_search_services': {
      let list = typeof args.query === 'string' ? find(args.query) : SERVICES;
      if (typeof args.email === 'string') list = list.filter((s) => s.accounts.includes(String(args.email).toLowerCase()));
      if (typeof args.category === 'string') list = list.filter((s) => s.category === String(args.category).toLowerCase());
      if (typeof args.unused_for_months === 'number') list = list.filter((s) => now - Date.parse(s.last_seen) > Number(args.unused_for_months) * 30 * DAY);
      if (args.linked_to_multiple_accounts === true) list = list.filter((s) => s.accounts.length > 1);
      return { ...base, services: list.map(strip), total: list.length };
    }
    case 'loginlens_devices': {
      const list = typeof args.service === 'string' ? DEVICES.filter((d) => d.services.some((s) => norm(s).includes(norm(args.service)))) : DEVICES;
      return { ...base, devices: list, total: list.length };
    }
    case 'loginlens_security_alerts':
      return { ...base, alerts: [{ service: 'netflix.com', email: ACCOUNTS[0], kind: 'new_login', date: '2026-09-30', device: 'Chrome on Windows', location: 'Delhi, IN' }], total: 1 };
    case 'loginlens_evidence': {
      const s = find(args.service)[0];
      return { ...base, service: s?.service ?? args.service, evidence: s ? Object.entries(s.evidence).flatMap(([email, ev]) => ev.map((e) => ({ email, ...e }))) : [] };
    }
    case 'loginlens_security_review':
      return {
        ...base,
        findings: [
          { kind: 'security_alert', service: 'github.com', email: ACCOUNTS[1], detail: 'A new SSH key was added', evidence_date: '2026-08-01', severity: 'high' },
          { kind: 'unused_service', service: 'orkut.com', email: ACCOUNTS[0], detail: 'No emails since 2014', evidence_date: '2014-06-30', severity: 'medium' },
          { kind: 'multiple_accounts', service: 'netflix.com', detail: 'Seen with 2 email accounts', severity: 'low' },
        ],
      };
    case 'loginlens_add_note':
      return { ...base, ok: true, note: 'Demo only: nothing was saved.' };
    case 'loginlens_rescan':
      return { ...base, started: false, note: 'Demo only: no real scan.' };
    default:
      return { ...base, error: 'unknown tool' };
  }
}
