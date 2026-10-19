# Scout

Scout is the AI assistant for **LoginLens**. It answers questions like *"Is my email signed up for Netflix?"*, *"How many devices do I have?"* or *"What should I fix first?"* from LoginLens data, in English, Hindi or Hinglish.

- **No AI key, no AI bills.** Scout runs a free, open-source AI model (Qwen3.5 4B) on its own server with [Ollama](https://github.com/ollama/ollama). It downloads the model by itself.
- **Scout makes its own key.** On first start it creates the key LoginLens uses to talk to Scout, and shows it once at `/setup`.
- **Facts are never invented.** Yes/No answers are built by Scout from the real data ("answer cards"); the AI only explains them.
- **Safe by design.** Only a fingerprint (hash) of the key is stored; users only ever see their own data; changes need a Confirm button; rate limits; protection against tricks hidden in emails.

## Try it for free from a tablet (5 minutes of tapping, then waiting)

GitHub gives you a free cloud computer called a **Codespace** (no card needed; about 60 hours a month).

1. On this repository's GitHub page, tap **Code** → **Codespaces** → **Create codespace on main**. Wait until a code editor opens in your browser (the first time takes a few minutes; it installs everything by itself).
2. At the bottom there is a **Terminal**. Tap it, type `npm start` and press Enter.
3. The first start downloads the AI model (about 3.4 GB), so wait 5–10 minutes. You can watch progress on the setup page.
4. Open the **Ports** tab, find port **3000** and tap the globe icon. That opens Scout. Add `/demo` to the address to chat with made-up sample data, or `/setup` to see your Scout key and the AI status.
5. When you are done, stop the Codespace (GitHub → Codespaces → ⋯ → Stop) to save your free hours.

An answer takes about 20–60 seconds there, because the AI runs on a small shared CPU. If something does not work, type `npm run doctor` in the Terminal: it checks everything and says in plain words what to fix.

These Codespaces steps could not be tried from the build sandbox; the same code was tested there in Docker and in a real browser.

## Put it online for real

See **[DEPLOY.md](DEPLOY.md)**. In short: Scout needs a server with about **8 GB of memory**. Free hosting that big no longer exists for beginners in 2026, so it costs about **$5–9 a month**, or $0 on Oracle Cloud's free tier if you can handle its harder setup. Full honest comparison: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Connect LoginLens

Give **[docs/INTEGRATION.md](docs/INTEGRATION.md)** to whoever builds LoginLens (for example ChatGPT). It explains:

1. Where to put `SCOUT_URL` and `SCOUT_APP_KEY` (LoginLens server secrets).
2. The one line of HTML that adds the floating Scout button to the dashboard.
3. The single data endpoint (`/api/scout-tools`) LoginLens must answer, with exact JSON examples and signature checking code.

## Useful addresses on a running Scout

| Address | What it is |
|---|---|
| `/setup` | Your Scout app key (shown once, for 60 minutes after first start) and AI status |
| `/demo` | Chat with sample data (during the setup hour, or when `DEMO_MODE=true`) |
| `/health` | `"status":"ok"` when everything works |
| `/docs` | List of all API endpoints (`/openapi.json` for tools) |
| `/scout.js` | The chat widget LoginLens embeds |

## For developers

```bash
npm install
npm start            # starts Scout; also starts Ollama if it is installed
npm run doctor       # checks the setup in plain words; changes nothing
npm test             # all tests (SQLite)
TEST_DATABASE_URL=postgres://user:pass@host/db npm test   # same tests on Postgres
npm run typecheck
```

- Node.js 22.18+ runs the TypeScript directly (no build step). Fastify web server, SQLite by default or Postgres with `DATABASE_URL`.
- Settings: **[.env.example](.env.example)** (all optional).
- Code map: `src/agent` (agent loop, answer cards, languages, memory), `src/tools` (tool registry, confirmations, webhook safety), `src/connectors` (LoginLens tools, demo data), `src/providers` (Ollama/OpenAI-compatible, Claude, Gemini adapters with retry and fallback), `src/keys` (app key, setup, limits), `src/runtime/ollama.ts` (starts and watches Ollama), `src/server` (HTTP API, pages), `public/scout.js` (widget).
