# Putting Scout online

Scout needs a server with about **8 GB of memory**. The AI model alone uses about 5–6 GB. Small free plans (Render, Koyeb, Railway, Fly.io) have 0.5–1 GB, so they cannot run it.

| Option | Monthly cost | Difficulty from a tablet | Keeps data after restart | Notes |
|---|---|---|---|---|
| **A. Hugging Face Space** | Needs **HF PRO**, about $9 (since July 2026, Docker Spaces are no longer free) | Easiest | **No** (disk resets) | 16 GB RAM, 2 CPUs, HTTPS included. Sleeps after 48 h without visitors. |
| **B. Small rented server (VPS)** | About €4.50 (Contabo, 8 GB) to €9 (Hetzner, 8 GB) | Medium (copy-paste 4 commands) | Yes | Always on, faster. |
| **C. Oracle Cloud "Always Free"** | $0 (needs a credit card for sign-up) | Harder | Yes | 2 CPUs / 12 GB (Arm). Often "out of capacity"; idle servers may be reclaimed. |
| **Test only: GitHub Codespaces** | $0 (about 60 h/month) | Easy | While it exists | Stops after at most 12 h. See README. |

Prices and limits were checked in October 2026; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for sources. They can change.

**Tested here:** building the Docker image, starting it, the automatic model start, `/setup`, `/demo`, the chat window in a browser, and all API tests. **Not tested here** (needs your accounts or a public server): Hugging Face, Oracle and VPS sign-ups, the HTTPS certificate, and downloading the model from the internet at build time.

---

## A. Hugging Face Space (easiest, needs HF PRO)

1. Make the GitHub repository **public**, so Hugging Face can download the code. It contains no secrets: GitHub → Settings → General → Danger Zone → Change visibility.
2. On huggingface.co: **New Space**. Choose a name, **Docker** → **Blank**, hardware **CPU basic**. Then **Create Space**.
3. In the Space, open **Files** → **README.md** → edit, and make the top of the file exactly:
   ```yaml
   ---
   title: Scout
   sdk: docker
   app_port: 7860
   startup_duration_timeout: 1h
   ---
   ```
4. **Files** → **Add file** → **Create a new file** named `Dockerfile`. Paste the contents of [deploy/huggingface/Dockerfile](deploy/huggingface/Dockerfile) and change the two lines `REPO_URL` and `BRANCH` to your GitHub repository address and branch.
5. Wait for the build. It downloads the AI model into the image, so it takes 10–20 minutes.
6. Open `https://<your-space>.hf.space/setup` yourself **within 60 minutes**, directly in your browser (not inside the Hugging Face page). Copy the **Scout app key** and press **I saved the key**. For safety, only the first browser that opens this page sees the key; if the page says it was already shown in another browser and that was not you, see "Lost or leaked key" below.
7. While the setup hour lasts, try the demo: `https://<your-space>.hf.space/demo` (made-up sample data).
8. Because the Space disk resets on every restart, open **Settings → Variables and secrets** and add these **secrets** (the Space restarts afterwards):
   - `SCOUT_APP_KEY`: the key you just copied.
   - `SCOUT_ENCRYPTION_KEY`: any long random text (40+ letters and numbers).
   - `SCOUT_ALLOWED_ORIGINS`: your LoginLens website address, e.g. `https://loginlens.example.com`.

   These survive restarts. What does **not** survive a restart: chat history, and LoginLens's registration of its data endpoint. LoginLens re-registers by itself within 5 minutes if it follows docs/INTEGRATION.md. To keep chat history too, set `DATABASE_URL` to a hosted Postgres database.
9. Give `SCOUT_URL` (`https://<your-space>.hf.space`) and `SCOUT_APP_KEY` to LoginLens (see docs/INTEGRATION.md). After step 8 the demo is closed; add the variable `DEMO_MODE=true` if you want to keep it open.

## B. A small rented server (VPS)

1. Rent an Ubuntu server with **8 GB RAM** (for example Contabo Cloud VPS 10 or Hetzner CX33). Note its IP address, e.g. `203.0.113.7`.
2. Open the provider's **web console** (browser terminal) and run, one at a time:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone https://github.com/YOUR-NAME/YOUR-REPO.git scout && cd scout
   echo "SCOUT_DOMAIN=203-0-113-7.sslip.io" > .env     # your IP with dashes, plus .sslip.io
   docker compose up -d --build
   ```
   `sslip.io` gives a free web address for your IP, and the included Caddy server gets a free HTTPS certificate for it automatically. The file `.env` in the `scout` folder holds your settings (it is never uploaded to GitHub).
3. Wait 10–20 minutes (building and downloading the model), then open `https://203-0-113-7.sslip.io/setup` yourself **within 60 minutes**. Copy the key and press **I saved the key**. Only the first browser that opens this page sees the key.
4. Updating later: `cd scout && git pull && docker compose up -d --build`.
5. Changing a setting later (for example `MODEL_NAME=qwen3.5:2b`): `cd scout && echo "MODEL_NAME=qwen3.5:2b" >> .env && docker compose up -d`. To remove a setting, delete its line from `.env` (`nano .env`), then run `docker compose up -d` again.

Data (chats, the key fingerprint, settings) lives in the Docker volume `scout-data`, and the AI model in `scout-models`. Both survive restarts and updates.

## C. Oracle Cloud Always Free

Same as **B**, on an Oracle "VM.Standard.A1.Flex" Ubuntu instance (2 OCPU, 12 GB). Also:
- Oracle logs you in as the user `ubuntu`, not as the administrator. Put `sudo` in front of every `curl ... | sh` and `docker` command in **B** (for example `sudo docker compose up -d --build`).
- In the instance's **Virtual Cloud Network → Security List**, allow incoming TCP ports **80** and **443**.
- Oracle may reclaim free instances that look idle. Upgrading the account to "Pay As You Go" stops that and still costs $0 inside the free limits. Add a budget alert of $1.

## After it is online

- `https://YOUR-SCOUT/health` should show `"status":"ok"`.
- On a VPS, `cd scout && docker compose exec scout npm run doctor` checks the setup in plain words (memory, database, key, AI model, LoginLens connection). It changes nothing.
- **Lost or leaked key:**
  - If you added the `SCOUT_APP_KEY` secret (Hugging Face step 8): delete that secret. The Space restarts; open `/setup` within 60 minutes, copy the new key, then add it as the `SCOUT_APP_KEY` secret again and give it to LoginLens. The old key stops working.
  - Otherwise (VPS): `cd scout && echo "SCOUT_NEW_APP_KEY=true" >> .env && docker compose up -d`, open `/setup`, copy the new key, then delete that line from `.env` and run `docker compose up -d` again. All older keys stop working.
  - While LoginLens still has a working key, it can also rotate it with `POST /v1/app-key/rotate`.
- Forgot to press **I saved the key**? If LoginLens already used the key, Scout keeps it. Otherwise, after 60 minutes, a restart shows a new key at `/setup`.
- Want faster but simpler answers on a small server? Set `MODEL_NAME=qwen3.5:2b` (VPS: see B step 5; Hugging Face: add it under Settings → Variables).
- The demo page closes after the first hour. Set `DEMO_MODE=true` to keep it open; it only ever uses sample data.
