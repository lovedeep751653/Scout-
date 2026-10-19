# Scout: architecture, costs and evidence

## How it fits together

```
 LoginLens user (browser)                       LoginLens server                         Scout server (this repo)
 ───────────────────────                        ────────────────                         ────────────────────────
 Dashboard + floating   ── POST /api/scout-token ─▶  checks login,          ── POST /v1/users/token ─▶  signs a 15-min user token
 Scout button (scout.js)                            asks Scout for a token    (Bearer SCOUT_APP_KEY)
        │  user token (sct_ut_…)
        └──────────────── POST /v1/chat/stream ───────────────────────────────────────────▶  agent loop
                                                                                            │  1 Ollama (local, 127.0.0.1)
                                                                                            │     Qwen3.5 4B decides which tool
                                                                                            │  2 tool call, signed (HMAC) ──▶ LoginLens /api/scout-tools
                                                                                            │        (user id from the token, never from the AI)
                                                                                            │  3 Scout builds the answer card from the data
                                                                                            ◀──┘  4 AI adds a short explanation, filtered
```

Three separate things, never mixed up:

1. **`SCOUT_APP_KEY`**: how the LoginLens *server* proves it is LoginLens. Scout creates it on first start, shows it once at `/setup`, and stores only a SHA-256 fingerprint. It can be rotated with a grace period.
2. **The AI model**: Qwen3.5 4B, open weights, run by Ollama inside the Scout server. There is **no AI API key**, and the model has no network access to the outside (Ollama is bound to 127.0.0.1, `OLLAMA_NO_CLOUD=1`).
3. **The tool-call `signing_secret`**: lets LoginLens check that tool calls really come from Scout. It is returned when LoginLens registers its endpoint.

LoginLens users never see any of these.

## Components

| Part | File(s) | Job |
|---|---|---|
| HTTP API | `src/server/app.ts` | `/v1/*` endpoints, strict CORS allow-list, auth, rate limits, SSE streaming |
| Agent loop | `src/agent/loop.ts` | queue → limits → memory → model ⇄ tools (max 5 steps, last step forced to answer) → answer cards → filters → save |
| Answer cards | `src/agent/cards.ts` | Builds "Yes — 2 accounts / Proof / Confidence / Last evidence" from data in English, Hindi or Hinglish |
| Tools | `src/tools/registry.ts`, `src/connectors/loginlens.ts` | 9 LoginLens tools; read vs. **write_confirm** (runs only via `POST /v1/actions/{id}/confirm`) |
| Webhook safety | `src/tools/webhook.ts` | HMAC signatures, private-network blocking (SSRF), DNS pinning, timeouts, size limits, no redirects |
| AI runtime | `src/runtime/ollama.ts` | Starts Ollama, downloads the model with progress, warms it up, restarts it if it dies |
| AI adapters | `src/providers/*` | Ollama/OpenAI-compatible (default), plus optional Claude and Gemini; retry on 429/5xx, optional fallback |
| Keys & limits | `src/keys/*` | App key + first-run setup, user tokens, per-user/per-key/per-IP rate limits, daily and monthly caps, chat queue |
| Storage | `src/db/*` | SQLite file by default; Postgres when `DATABASE_URL` is set; same migrations for both |
| Widget | `public/scout.js` | Floating button + chat panel in Shadow DOM; streaming, cards, Confirm/Cancel, voice input, read-aloud, light/dark |

## Choosing the AI model (measured, not guessed)

All numbers were measured in this project's sandbox (4 CPU cores, no GPU) with Ollama 0.40.6, thinking turned off (`reasoning_effort: "none"`; with thinking on, a single tool call took 23.8 s instead of 2.4 s).

| Test | Qwen3.5 2B | Qwen3.5 4B |
|---|---|---|
| Writes its own Yes/No line correctly (18 cases) | 9 wrong | 7 wrong (by a strict first-word check) |
| Replies in the user's language (18 cases) | 4 wrong | **0 wrong** |
| Average answer time | 8 s | 18 s |

Because even the 4B model sometimes writes the wrong Yes/No, **Scout never lets the model write the verdict**. Scout builds the answer card from LoginLens data, and removes model sentences that contradict it or that mention numbers or dates not present in the data.

End-to-end through the real Scout API with a fake LoginLens, 12 questions in English, Hindi and Hinglish, 4B model, running in the Docker container:
- **Right tool:** 11 of 12. The miss, Hindi "how many devices", used the overview tool and still gave the right count.
- **Right language:** 12 of 12.
- **Attacks hidden in email subjects** that reached the answer: 0.
- **Confirm step:** the "add a note" request waited for Confirm.
- **Isolation:** another user saw none of the first user's data.
- **Speed:** about 25–75 s per answer, while other work was using the same CPU.

**Default model:** `hf.co/unsloth/Qwen3.5-4B-GGUF:Q4_K_M`. It is the exact file tested (Apache-2.0 per the Qwen repository; the weights' license file could not be opened from here), and it supports Hindi. `qwen3.5:4b` from the Ollama library is the same model with Ollama's own Qwen3.5 tool parser; it is a good alternative but was not testable here, because ollama.com was blocked. Use `qwen3.5:2b` for faster, rougher answers on small servers.

## Operating costs (October 2026; check again before paying)

**AI API fees: $0.** There is no paid AI API anywhere. The only cost is the server that runs the model (about 5–6 GB of RAM).

| Hosting | Runs Scout? | Free-tier limits | What happens past the limits | Unavoidable costs |
|---|---|---|---|---|
| Hugging Face Space, CPU Basic (2 vCPU, 16 GB) | Yes | Docker Spaces need **PRO** since 2026-07-21; disk wiped on restart; sleeps after 48 h idle | No overage; it sleeps and wakes on the next visit | PRO, about $9/month (third-party figure; hf.co/pricing was unreachable) |
| Oracle Cloud Always Free, Ampere A1 | Yes (arm64) | Reported halved in 2026 to 2 OCPU / 12 GB; idle reclamation; capacity shortages | Pay-as-you-go A1 pricing beyond the free limits | $0, but a credit card is needed to sign up |
| Contabo / Hetzner VPS (8 GB) | Yes | n/a | n/a | About €4.50 (Contabo) to €8.99 (Hetzner CX33 incl. IPv4) per month |
| Google Cloud Run | Technically | Free tier ≈ 12–16 h/month of a 2 vCPU/8 GiB instance; card needed | Billed per second (≈ $135/month if always on) | Card; model reload on every cold start |
| Render / Koyeb / Railway / Fly.io free | **No** (0.5–1 GB RAM) | n/a | n/a | n/a |
| GitHub Codespaces (testing) | Yes, for testing | ≈ 60 h/month on 2-core/8 GB, max 12 h per run | Paid per hour, or stops | $0 for testing |

Sources: Hugging Face hub-docs `spaces-overview.md` and `spaces-gpus.md` (commit 34ee0f0, 2026-07-21) and forum reports; Oracle Always Free documentation and 2026 news reports (medium confidence); Google Cloud Run pricing page; provider pricing pages and 2026 price-change notices for Hetzner and Contabo; GitHub Codespaces billing docs. Prices can change.

A separate computer is not needed: everything runs in one container. An optional backup is a cloud AI key (`FALLBACK_PROVIDER`), which would add pay-per-use costs; it is off by default.

## Security summary

- **Keys:** only a SHA-256 fingerprint of the app key is stored. The key is never logged, never returned except once at `/setup` or on rotation, and is rejected when sent from a browser (an `Origin` header means a browser). Browsers use 15-minute signed user tokens instead.
- **Isolation:** sessions, notes and actions are always looked up by (project, user). Tools get the user id from the authenticated context; LoginLens is told to return only that user's data.
- **Writes:** tools marked `write_confirm` never run from the AI. They create a pending action that only the same user can confirm, once, within 10 minutes. Deleting data is not available to the AI at all.
- **Prompt injection:**
  - Tool output is wrapped as `untrusted_data`.
  - Instruction-like sentences are replaced with `[suspicious text removed]`.
  - Card answers never send email subjects to the model.
  - The system prompt forbids following instructions found in data.
- **Secrets from users:** passwords, OTPs and codes typed into the chat are removed before storage, with a warning to the user.
- **Network:** webhook and connector calls require HTTPS, block private and reserved IP ranges (including `localhost.`-style names), pin the resolved IP, follow no redirects, time out after 8 s and accept at most 64 KB.
- **Abuse limits:**
  - Per user: 6 messages per minute, 200 per day, and a monthly token cap.
  - Per app key: 120 requests per minute. Per IP: 30 per minute.
  - Failed logins are throttled.
  - One answer is generated at a time, with a short waiting line.
- **Logs:** emails, keys and tokens are masked. The audit log records every tool call and action, with sensitive fields redacted.

## Known limitations

- Answers take about 20–75 s on a 2–4 core CPU. A GPU or a bigger CPU makes this much faster.
- The model is small: it can choose a less suitable tool, and its explanations can be awkward, especially in Hinglish. Facts come from cards, not from the model.
- On Hugging Face, chat history is lost on restart (no persistent disk). Use a VPS, or set `DATABASE_URL` to a hosted Postgres, to keep it.
- Rate limits are counted in memory per server instance. Run one instance, or add a shared store if you scale out.
- The Hugging Face, Oracle and VPS steps in DEPLOY.md could not be run from the build sandbox. The Docker image itself was built and run.
