# ThirdEye Backend

Secure proxy for OpenAI and GNews so the mobile app can call a trusted endpoint without shipping raw keys. Deploy this folder to Render (or any Node host) and point the app's Assistant settings at the resulting URL.

## Features

- `POST /chat` – forwards chat prompts to the OpenAI Responses API.
- `POST /vision` – describes images using OpenAI multimodal models.
- `POST /text` – summarizes long-form text.
- `POST /audio/speech` – generates speech audio.
- `GET /news/headlines` – fetches top headlines from GNews.
- Global rate limiting, Helmet/CORS hardening, and shared-secret auth via `x-api-key`.

## Quick Start (Local)

```powershell
cd server
copy .env.example .env  # fill in secrets afterwards
npm install
npm run dev
```

Verify with `http://localhost:8080/health` (include `x-api-key` header for secured routes).

## Environment Variables

See `.env.example`. Required values:

- `OPENAI_API_KEY` – project or org key.
- `OPENAI_PROJECT_ID` – needed for `sk-proj-...` keys.
- `NEWS_API_KEY` – enables live headlines.
- `SERVICE_API_KEY` – shared secret clients send as `x-api-key`.

## Deploy to Render

1. Commit this folder to GitHub.
2. In Render, create a new **Web Service**, select Node, and use:
   - Build command: `npm install`
   - Start command: `npm start`
   Render also respects the included `render.yaml` if present in the repo.
3. Add the environment variables from your `.env` file via the Render dashboard.
4. After deployment, set the app's Assistant Base URL to the Render endpoint and the Assistant API Key to the same `SERVICE_API_KEY`.

### Keep the Service Awake

Render's free tier sleeps after periods of inactivity. To keep it warm, set up an UptimeRobot (or similar) monitor that pings `https://<your-domain>/health` every few minutes. The `/health` route is public and does not require the `x-api-key` header, so it's safe for this purpose.

## Mobile App Update

Remove any hard-coded API keys from `lib/services/ai_config.dart` once the backend is online. Let the app talk to this server instead so credentials stay off user devices.
