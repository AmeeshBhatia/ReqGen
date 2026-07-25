# ReqGen — AI Requirements Documentation Generator

Turn multiple discovery meeting transcripts into complete BA documentation:
**BRD, FRD, User Stories, RTM, and Test Cases** — with conflict resolution,
confidence scores, gap detection, and source traceability.

Runs on your own computer and uses your **free Google Gemini API key**
(no credit card required).

---

## Part 1 — Get your free Gemini API key (~2 minutes)

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with any Google account.
3. Click **"Create API key"** (choose "Create API key in new project" if asked).
4. Copy the key it shows you — it looks like `AIza...`. Keep it private.

That's it. No billing setup, no credit card. The free tier is generous and
handles long transcripts.

> Note: On the free tier, Google may use your data to improve their products.
> For confidential client work, upgrade to a paid Gemini tier (same key, just
> enable billing in Google AI Studio) where your content is **not** used for training.

---

## Part 2 — Install & run

You need **Node.js 18 or newer**. Check with `node -v`.
If you don't have it, download the LTS version from https://nodejs.org and install.

In a terminal (PowerShell on Windows), from inside the `reqgen` folder:

```bash
npm install    # installs dependencies (one time)
npm start      # starts the app
```

You'll see something like:

```
  ReqGen running →  http://localhost:3000
```

Open that address in your browser.

### Add your key — the easy way (no file editing)

In the app, click **⚙** (top-right, or the button in the yellow banner). Choose a
**provider**, paste that provider's key, and click **Save & connect**. Leave "Also
save to .env" ticked so you won't have to paste it again.

You can set up **both** providers and switch between them anytime in ⚙ — handy when
one hits its free daily limit.

**Two free providers supported:**

- **Google Gemini** (recommended) — free, no credit card, huge context window (best
  for long transcripts). Key: https://aistudio.google.com/apikey
- **OpenRouter** — free tier ~50 requests/day across many models. Key:
  https://openrouter.ai/keys — pick a model whose ID ends with `:free`.

Tip: in ⚙, click **"↻ Show models my key supports"** to get a dropdown of the exact
models your key can use — no guessing at names.

### Add your key — the file way (optional)

Prefer a file? Copy `.env.example` to `.env` (`copy .env.example .env` on Windows),
paste your key after `GEMINI_API_KEY=`, save, and restart with `npm start`.

> **Port already in use?** No problem — the app now automatically picks the next free
> port (3001, 3002…) and prints the address it actually used. Just open that one.

---

## Part 3 — Use it

1. **Project** — name your project (e.g. "Customer Bank CRM Modernization").
2. **Upload** — drag in transcripts/notes (`.txt .vtt .srt .md .csv .docx .pdf`)
   or paste text manually. Add as many sources as you have.
3. **Knowledge Base** — click *Process*. Gemini merges everything into one view:
   stakeholders, grouped requirements, resolved conflicts, confidence scores,
   detected gaps, and a requirement timeline.
4. **Generate** — tick the documents you want and click *Generate*.
   Review each in its tab, then **Export all** (.html) or **Copy** into Word/Docs.

**Adding a later meeting?** Go back to *Upload*, add the new transcript, and
*Process* again — the knowledge base and documents regenerate from everything.

---

## Troubleshooting

| Message | Fix |
|---|---|
| `No API key found` banner | You didn't create `.env` or didn't paste the key. Edit `.env`, then restart (`npm start`). |
| `API key is not valid` | Re-copy the key from AI Studio; make sure there are no spaces. |
| `Model ... not found` | Edit `GEMINI_MODEL` in `.env` to `gemini-2.5-flash` or `gemini-1.5-flash`, restart. |
| `rate limit hit (429)` | Free tier limit. Wait a minute, or generate fewer documents at once. |
| Very long transcripts | Free tier still handles large context; if you hit limits, split into fewer, larger sources. |

---

## Part 4 (optional) — Put it online for your team

To host it so colleagues can use it without installing anything:

1. Push this folder to a GitHub repo.
2. Create a free account at **https://render.com** → **New → Web Service** → connect the repo.
3. Settings: Build command `npm install`, Start command `npm start`.
4. Under **Environment**, add `GEMINI_API_KEY` = your key (and optionally `GEMINI_MODEL`).
5. Deploy. Render gives you a public URL.

> The API key lives safely in the server's environment — it is never exposed to the browser.

---

## How it works (for the curious)

- `server.js` — Express server. `/api/extract` pulls text from uploaded files
  (Word/PDF included), `/api/process` asks Gemini to build a structured JSON
  knowledge base, `/api/generate` asks Gemini to write each document from that
  knowledge base.
- `public/index.html` — the whole UI (no build step, no framework).
- Your key stays in `.env` on the server; transcripts are sent only to Google's
  Gemini API for processing.
