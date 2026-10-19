<p align="center"><img src="public/icons/logo.png" width="140" alt="Cynthia" /></p>

<h1 align="center">Cynthia</h1>
<p align="center">An always-on AI assistant powered by Google Gemini, with her own computer, user accounts, an installable PWA and one-click Railway deploys.</p>

## Features

- **Chat like a messaging app.** Pick an **iMessage**, **WhatsApp** or **Cynthia** chat style in Settings → Appearance, in light or dark mode. The choice syncs across your devices. Replies stream in live, and you can attach images and files, dictate by voice, export chats and rename them.
- **Accounts.** Email and password sign-up, bcrypt-hashed passwords and httpOnly session cookies. Each user's chats, files, memories, tasks and connections are private to them.
- **Her own computer.**
  - 🔎 **Google Search and URL reading** for up-to-date answers, with source links.
  - 🌐 **A real web browser.** Headless Chromium that Cynthia drives herself: she opens pages, clicks, types, scrolls and takes screenshots, and she can see those screenshots.
  - 🐍 **Python sandbox** (Gemini code execution) for maths, data analysis and charts.
  - 🧊 **3D modelling.** Cynthia builds models from parts. You can view them in an interactive 3D viewer and export them as **GLB, STL (for 3D printing) or OBJ**.
  - 🎨 **Image generation and editing** with Gemini image models.
  - 📁 **Persistent file workspace** (the "Computer" panel). Files are stored in the database, so they survive redeploys.
  - 🧠 **Long-term memory** about each user.
  - 🔗 **HTTP and API requests**, protected against requests to private networks (SSRF).
- **Always on.**
  - ⏰ **Scheduled tasks.** For example: "every morning at 8 send me a news briefing" or "check this page every hour". Tasks run on the server while you're away.
  - 🔔 **Web Push notifications** to your phone or desktop.
  - A reply keeps running on the server even if you close the app, and it's waiting for you when you come back.
- **Connects to other services.**
  - **Outgoing:** Discord, Slack and generic webhooks (Zapier, Make, IFTTT, n8n, Home Assistant, custom APIs). Cynthia sends messages and data to them.
  - **Incoming:** each user gets a private webhook URL, so any app can message Cynthia and get her reply back as JSON. That includes Apple Shortcuts, Zapier, cron jobs and Home Assistant.
- **PWA.** Installable on iOS, Android and desktop, with an offline app shell, push notifications and maskable icons.

## Deploy on Railway

1. Push this repo to GitHub, then in Railway choose **New Project → Deploy from GitHub repo**.
2. Add a database: **New → Database → PostgreSQL**.
3. In the Cynthia service, open **Variables** and set:
   - `GEMINI_API_KEY`: your Gemini API key
   - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
   - optionally `ALLOW_SIGNUPS=false` once you've created your account, to keep the instance private
4. Under **Settings → Networking**, click **Generate Domain**. The app needs HTTPS for the PWA and push notifications.
5. Open the URL, create your account, then use your browser's **Add to Home Screen / Install app**.

`railway.json` makes Railway build from the `Dockerfile`, which includes Chromium for the browser. It also sets up a health check on `/healthz`, a restart policy of always, and app sleeping turned off, so Cynthia stays on and scheduled tasks keep firing. Keep the service at **one replica**, because the scheduler runs inside the web process.

> Without `DATABASE_URL`, Cynthia falls back to SQLite in `DATA_DIR` (`/data` in the Docker image). If you go that route on Railway, attach a **volume** at `/data`, or your data is lost on redeploy.

## Run locally

```bash
cp .env.example .env      # then put your GEMINI_API_KEY in .env
npm install
npm run dev               # http://localhost:3000
```

Node 22 or newer is required. For the built-in browser, install Chromium and set `CHROMIUM_PATH` if it isn't on the usual path. If Chromium isn't installed, the browser tool is turned off and everything else still works.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | (required) | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-flash-latest` | Chat and agent model |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | Image generation model |
| `DATABASE_URL` | (none) | PostgreSQL connection string; SQLite is used if unset |
| `JWT_SECRET` | auto | Session signing secret. Generated and stored in the database if unset |
| `ALLOW_SIGNUPS` | `true` | Set `false` to allow only the first account |
| `VAPID_*` | auto | Web Push keys. Generated and stored in the database if unset |
| `CHROMIUM_PATH` | auto-detect | Chromium binary for the browser tool |
| `MAX_AGENT_STEPS` | `16` | Max tool-calling rounds per message |
| `ALLOW_PRIVATE_NETWORK` | `false` | Let the agent reach private IPs (self-hosted only) |

## Incoming webhook example

```bash
curl -X POST "https://your-app.up.railway.app/api/hooks/<your-token>" \
  -H "content-type: application/json" \
  -d '{"message": "What is on my calendar reminder list?", "notify": true}'
# → {"reply": "...", "conversation_id": "..."}
```

Find your URL in **Connect → Incoming webhook**. Pass `conversation_id` to continue a thread.

## Project layout

```
server/
  index.js       Express app, static files, startup
  routes.js      REST API, streaming chat endpoint and webhooks
  agent.js       Gemini agent loop: streaming, tools, persistence
  tools.js       Cynthia's computer: browser, 3D, images, files, memory, tasks, integrations
  browser.js     Headless Chromium sessions (playwright-core)
  scheduler.js   Background task runner
  push.js        Web Push
  auth.js, db.js, workspace.js, net.js, gemini.js, config.js
public/
  index.html, css/app.css, js/*.js, sw.js, manifest.webmanifest, icons/
```

## Security notes

- Never commit your API key. Set it as a Railway variable or in a local `.env` file, which git ignores.
- Files created by users or the AI are served with a sandboxing Content-Security-Policy, so they can't run scripts on the app's origin.
- The agent's HTTP requests, browser and connections refuse private and internal network addresses unless you set `ALLOW_PRIVATE_NETWORK=true`.
