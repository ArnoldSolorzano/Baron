# Baron — MyCU Virtual Assistant

Baron is a ChatGPT-style virtual assistant embedded in the Carolina University
MyCU dashboard. It answers questions about the MyCU portal (Admissions,
Courses, Forms, Helpdesk, password changes, etc.) and general questions about
Carolina University.

## Quick start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and put your OpenAI key in it:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set `OPENAI_API_KEY=sk-...`.
3. Start the server:
   ```bash
   npm start
   ```
4. Open **http://localhost:3000** in your browser. Click the yellow **Ask
   Baron** button in the bottom-right corner.

## What's included

- `server.js` — Express backend with OpenAI + optional SerpAPI web search,
  per-session conversation memory, and health/reset endpoints.
- `index.html`, `app.js`, `styles.css` — the MyCU dashboard mock and the
  Baron chat widget.
- `assets/` — logo and bot image.

## Endpoints

- `GET  /api/health` → basic status (model, keys present, session count)
- `POST /api/chat`   → `{ message, sessionId }` → `{ reply }`
- `POST /api/reset`  → `{ sessionId }` → clears that session's memory

## Environment variables

| Variable           | Required | Default         | Purpose                         |
|--------------------|----------|-----------------|---------------------------------|
| `OPENAI_API_KEY`   | yes      | —               | OpenAI auth                     |
| `SERPAPI_API_KEY`  | no       | —               | Enables live web search         |
| `OPENAI_MODEL`     | no       | `gpt-4o-mini`   | Model id                        |
| `PORT`             | no       | `3000`          | HTTP port                       |

If a legacy `api.txt` file exists, the server will read the OpenAI key from
it as a fallback — but `.env` is strongly preferred.

## Security note

Do **not** commit `.env` or `api.txt` to git. Rotate any key that has been
shared publicly.
