# Connecting LoginLens to Scout

This guide is for whoever builds the LoginLens app (for example ChatGPT). Give it this whole file.

Scout is a separate AI agent service. LoginLens owns the users and their data. Scout answers questions by calling LoginLens's data endpoint.

## What is what (do not mix these up)

| Thing | What it is | Where it lives |
|---|---|---|
| `SCOUT_URL` | Address of the Scout server, e.g. `https://your-scout.hf.space` | LoginLens server secrets |
| `SCOUT_APP_KEY` (`sct_sec_...`) | **The credential LoginLens uses to call Scout.** Scout creates it automatically on first start. The owner opens the private link Scout prints in its server log (`SCOUT_URL/setup?code=...`, valid 60 minutes), copies the key and presses **I saved the key**. | LoginLens **server** secrets only. Never in browser code, never in Git. |
| User token (`sct_ut_...`) | Short-lived pass (default 15 min) for **one signed-in LoginLens user**, so the chat window in the browser can talk to Scout. | Created by the LoginLens server on demand; held only in browser memory. |
| `signing_secret` (`whsec_...`) | Secret Scout uses to sign its calls to LoginLens's data endpoint. Returned when LoginLens registers the endpoint, and **the same every time** LoginLens registers again with the same app key (so several LoginLens servers agree). It changes when a new app key registers, or when `rotate_secret: true` is sent. | LoginLens server memory/secrets. |
| The AI model | A free open-source model (Qwen3.5 4B) running **inside the Scout server** with Ollama. | Scout server. **There is no AI API key anywhere.** |

LoginLens users never see or enter any key.

## 1. Server setup (once)

1. Store `SCOUT_URL` and `SCOUT_APP_KEY` as environment secrets of the LoginLens server.
2. On every LoginLens server start (and on every instance, if there are several), register the data endpoint and the allowed website. Scout may be asleep or still starting, so keep retrying in the background and never let a failure crash LoginLens:

```js
// LoginLens server (Node 18+).
const SCOUT_URL = process.env.SCOUT_URL;
const SCOUT_APP_KEY = process.env.SCOUT_APP_KEY;
let SCOUT_SIGNING_SECRET = null; // set by connectScout(); the same value on every instance

async function scout(path, method = 'GET', body) {
  const res = await fetch(SCOUT_URL + path, {
    method,
    // Send content-type only when there is a body.
    headers: { authorization: `Bearer ${SCOUT_APP_KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Scout ${path}: ${data.error?.message || res.status}`);
  return data;
}

async function connectScout() {
  const reg = await scout('/v1/connectors/loginlens', 'PUT', { url: 'https://YOUR-LOGINLENS-DOMAIN/api/scout-tools' });
  SCOUT_SIGNING_SECRET = reg.signing_secret; // stays the same when you register again
  await scout('/v1/settings', 'PUT', {
    allowed_origins: ['https://YOUR-LOGINLENS-DOMAIN'],
    agent_name: 'Scout',
    welcome_text: 'Hi! Ask me which websites and apps your email accounts are linked to.',
    quick_replies: ['How many devices do I have?', 'Any new login alerts?', 'What should I fix first?'],
  });
}

// Call this once at startup. It retries with growing pauses (up to 5 minutes) until Scout answers.
export function connectScoutInBackground(waitMs = 5000) {
  connectScout()
    .then(() => console.log('Connected to Scout'))
    .catch((err) => {
      console.warn(`Scout not reachable yet (${err.message}); retrying`);
      setTimeout(() => connectScoutInBackground(Math.min(waitMs * 2, 300000)), waitMs);
    });
}
```

Never call Scout with the app key from browser code: Scout rejects app keys that arrive with a browser `Origin` header.

## 2. The chat window (floating assistant)

Add this to every LoginLens dashboard page, before `</body>`:

```html
<script src="SCOUT_URL/scout.js" data-token-url="/api/scout-token" async></script>
```

Optional attributes: `data-position="bottom-left"`, `data-offset-bottom="90"` (move it above your own buttons), `data-mode="inline" data-target="#scout-box"` (embed in a page area instead of floating), `data-lang="hi"`.

The widget calls `POST /api/scout-token` **on your own LoginLens server**, with your normal login cookie. Implement it like this:

```js
// Express example. requireLogin = your existing auth middleware.
app.post('/api/scout-token', requireLogin, async (req, res) => {
  try {
    const t = await scout('/v1/users/token', 'POST', { user_id: String(req.user.id), ttl_seconds: 900 });
    res.json(t); // { token, expires_at }
  } catch (err) {
    // Scout asleep, restarting or busy: the chat window shows a friendly message.
    res.status(503).json({ error: 'The assistant is not available right now.' });
  }
});
```

`user_id` must be the signed-in user's id (letters, numbers, `_ . : @ + -`, max 128). Scout keeps every user's chats and data strictly separate by this id.

You can also open it from your own buttons: `Scout.open()`, `Scout.close()`, `Scout.ask('Is my email on Netflix?')`.

## 3. The data endpoint Scout calls: `POST /api/scout-tools`

Scout sends:

```json
{
  "tool": "loginlens_check_service",
  "arguments": { "service": "netflix" },
  "context": { "project_id": "prj_...", "user_id": "42", "session_id": "ses_..." },
  "timestamp": 1792384000
}
```

Headers: `x-scout-timestamp` (Unix seconds) and `x-scout-signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with signing_secret>`.

**Rules for this endpoint (security):**
- Verify the signature with a constant-time compare and reject timestamps older than 5 minutes.
- Return **only** data of `context.user_id`. Never trust a user id inside `arguments`.
- Answer within 8 seconds, at most 64 KB of JSON.
- Read-only tools must not change anything. `loginlens_add_note` and `loginlens_rescan` arrive only after the user pressed **Confirm** in the chat.
- Never return passwords, tokens, OTP codes or full email bodies. Headers like sender, subject and date are enough.
- Dates are ISO strings (`2026-09-30` or `2026-09-30T10:00:00Z`).

**Important:** register this route **before** any global `app.use(express.json())`. The signature is checked on the raw body; a global JSON parser that runs first would consume it, and every Scout call would fail with 401.

```js
import crypto from 'node:crypto';

// Must come BEFORE app.use(express.json()).
app.post('/api/scout-tools', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  try {
    if (!SCOUT_SIGNING_SECRET) return res.status(503).json({ error: 'not connected to Scout yet' });
    if (!Buffer.isBuffer(req.body)) return res.status(500).json({ error: 'register /api/scout-tools before express.json()' });
    const raw = req.body.toString('utf8');
    const ts = req.get('x-scout-timestamp') || '';
    const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    // Compare bytes, not string lengths, so odd characters in the header cannot cause a crash.
    const expected = Buffer.from('v1=' + crypto.createHmac('sha256', SCOUT_SIGNING_SECRET).update(`${ts}.${raw}`).digest('hex'));
    const sig = Buffer.from(req.get('x-scout-signature') || '');
    if (!fresh || sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
      return res.status(401).json({ error: 'bad signature' });
    }
    const { tool, arguments: args, context } = JSON.parse(raw);
    const userId = context.user_id; // the ONLY user whose data may be returned
    res.json(await handleScoutTool(tool, args || {}, userId));
  } catch (err) {
    console.error('scout-tools failed', err);
    res.status(500).json({ error: 'could not read the data' });
  }
});
```

### Tools and the JSON each must return

Scout builds the Yes/No answer cards itself from these fields, so please keep the field names exactly.

**`loginlens_overview`** (no arguments)
```json
{ "email_accounts": [{ "email": "a@gmail.com", "connected": true, "last_scan_at": "2026-10-17T08:00:00Z", "services_count": 41 }],
  "totals": { "services": 58, "devices": 3, "alerts_30d": 1 },
  "data_checked_at": "2026-10-17T08:00:00Z" }
```

**`loginlens_check_service`** `{ "service": "netflix" }` (name or domain; match loosely)
```json
{ "service": "netflix.com",
  "connected_accounts": 2,
  "data_checked_at": "2026-10-17T08:00:00Z",
  "accounts": [
    { "email": "a@gmail.com", "first_seen": "2023-03-12", "last_seen": "2026-09-30",
      "evidence": [
        { "kind": "welcome", "date": "2023-03-12", "subject": "Welcome to Netflix", "record_url": "https://loginlens.example/services/netflix" },
        { "kind": "new_login", "date": "2026-09-30", "subject": "New sign-in", "device": "Chrome on Windows", "location": "Delhi, IN" }
      ] } ] }
```
- `connected_accounts`: how many email accounts **this user has connected to LoginLens in total** (not only the ones where the service was found). Send `0` only when the user has not connected any inbox yet; Scout then tells them to connect one first.
- When nothing was found, return `"accounts": []` with the real `connected_accounts`, for example `{ "service": "spotify.com", "connected_accounts": 2, "data_checked_at": "2026-10-17T08:00:00Z", "accounts": [] }`. Scout then answers "No — not found in your emails".
- `kind` is one of: `welcome`, `verify`, `password_reset`, `receipt`, `subscription`, `new_login`, `security_alert`, `other`.

**`loginlens_search_services`** `{ "query"?, "email"?, "category"?, "unused_for_months"?, "linked_to_multiple_accounts"?, "limit"? }`
```json
{ "services": [{ "service": "netflix.com", "name": "Netflix", "category": "streaming", "accounts": ["a@gmail.com", "b@work.com"],
                 "first_seen": "2023-03-12", "last_seen": "2026-09-30", "evidence_count": 3, "tags": ["family"], "record_url": "https://..." }],
  "total": 1, "data_checked_at": "2026-10-17T08:00:00Z" }
```
`unused_for_months: 6` means "no evidence in the last 6 months". `linked_to_multiple_accounts: true` means "seen with 2 or more of the user's email accounts".

**`loginlens_devices`** `{ "service"?, "email"? }`
```json
{ "devices": [{ "name": "Chrome on Windows", "type": "desktop", "location": "Delhi, IN", "first_seen": "2024-01-01", "last_seen": "2026-09-30", "services": ["netflix.com"] }],
  "total": 1, "data_checked_at": "2026-10-17T08:00:00Z" }
```

**`loginlens_security_alerts`** `{ "since_days"?: 30 }`
```json
{ "alerts": [{ "service": "netflix.com", "email": "a@gmail.com", "kind": "new_login", "date": "2026-09-30", "device": "Chrome on Windows", "location": "Delhi, IN", "subject": "New sign-in", "record_url": "https://..." }],
  "total": 1, "data_checked_at": "2026-10-17T08:00:00Z" }
```

**`loginlens_evidence`** `{ "service": "github", "email"? }`
```json
{ "service": "github.com", "evidence": [{ "email": "b@work.com", "kind": "security_alert", "date": "2026-08-01", "from": "noreply@github.com", "subject": "A new SSH key was added" }],
  "data_checked_at": "2026-10-17T08:00:00Z" }
```

**`loginlens_security_review`** (no arguments). Facts only; Scout writes the advice.
```json
{ "findings": [
    { "kind": "unused_service", "service": "orkut.com", "email": "a@gmail.com", "detail": "No emails since 2014", "evidence_date": "2014-06-30", "severity": "medium" },
    { "kind": "security_alert", "service": "github.com", "detail": "New SSH key added", "evidence_date": "2026-08-01", "severity": "high" } ],
  "data_checked_at": "2026-10-17T08:00:00Z" }
```

**`loginlens_add_note`** `{ "service", "note"?, "tag"? }` (runs only after the user pressed Confirm) → `{ "ok": true }`

**`loginlens_rescan`** `{ "email"? }` (runs only after Confirm) → `{ "started": true }`

On an error, return HTTP 4xx/5xx with `{ "error": "short reason" }`. Scout tells the user plainly that the data could not be read.

## 4. Calling Scout directly from the LoginLens server (optional)

Every chat endpoint accepts either the app key **plus** `user_id`, or a user token.

```bash
curl -X POST "$SCOUT_URL/v1/chat" -H "authorization: Bearer $SCOUT_APP_KEY" -H 'content-type: application/json' \
  -d '{"user_id":"42","message":"Is my email signed up for Netflix?"}'
```

The response has `reply` (full text), `card_texts` + `text` (the same reply split for display), `cards` (structured answer cards), `pending_actions` (things waiting for Confirm), `session_id` (send it back to continue the chat), `language`, `stopped` and `usage`.

Other endpoints (all under `/v1`): `POST /chat/stream` (Server-Sent Events: `start`, `queued`, `delta`, `tool`, `card`, `action`, `notice`, `done`, `error`), `POST /actions/{id}/confirm`, `POST /actions/{id}/cancel`, `GET /sessions`, `GET /sessions/{id}/messages`, `DELETE /sessions/{id}`, `POST /messages/{id}/feedback`, `GET /status` (owner warnings), `GET|PUT /settings`, `PUT|DELETE /connectors/loginlens`, `GET|POST /tools`, `DELETE /tools/{name}`, `POST /users/token`, `GET /users/{user_id}/export`, `DELETE /users/{user_id}`, `POST /app-key/rotate`. Full details: `SCOUT_URL/docs` and `SCOUT_URL/openapi.json`.

## 5. Data rights

When a LoginLens user deletes their account or asks for their data, also call:

- `GET /v1/users/{user_id}/export`: everything Scout stored for that user (chats, notes, actions).
- `DELETE /v1/users/{user_id}`: deletes it.

## 6. Rotating the app key

```bash
curl -X POST "$SCOUT_URL/v1/app-key/rotate" -H "authorization: Bearer $SCOUT_APP_KEY" -H 'content-type: application/json' -d '{"grace_seconds":3600}'
```
The response contains the new key once. Update the LoginLens secret; the old key keeps working for `grace_seconds`. (If the key was set on Scout as the `SCOUT_APP_KEY` hosting secret, rotation is refused: change that secret instead.)

If the key is ever lost or leaked, the Scout owner follows "Lost or leaked key" in DEPLOY.md. All older keys stop working, and the next registration with the new key returns a new `signing_secret`.

## 7. Limits Scout enforces

- Per user: 6 messages per minute and 200 per day (owner can change: `USER_MESSAGES_PER_MINUTE`, `USER_MESSAGES_PER_DAY`).
- Per app key: 120 requests per minute. Per browser network: 30 requests per minute.
- One answer is generated at a time on a CPU server. Up to 8 more wait in line (the widget shows "Waiting in line"), and more than that get a friendly "busy" message.
- Messages up to 2,000 characters.
