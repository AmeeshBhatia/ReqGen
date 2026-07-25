/* ReqGen — AI Requirements Documentation Generator
 * Node + Express server. Calls the Google Gemini API (free tier) to turn
 * discovery meeting transcripts into BRD / FRD / User Stories / RTM / Test Cases.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const APP_VERSION = 'v3.0';
const PORT = parseInt(process.env.PORT, 10) || 4545;

/* ---------- Provider config (Gemini + OpenRouter) ---------- */
const DEFAULTS = {
  gemini: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
  openrouter: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free'
};
const CFG = {
  provider: (process.env.LLM_PROVIDER || 'gemini').trim(),
  keys: {
    gemini: cleanKey(process.env.GEMINI_API_KEY),
    openrouter: cleanKey(process.env.OPENROUTER_API_KEY)
  },
  models: { gemini: DEFAULTS.gemini, openrouter: DEFAULTS.openrouter }
};
function cleanKey(k) { k = (k || '').trim(); return (k === 'paste_your_key_here' || k === 'paste_your_openrouter_key_here') ? '' : k; }
function activeProvider(p) { return (p === 'openrouter' || p === 'gemini') ? p : CFG.provider; }
function getKey(p) { return CFG.keys[activeProvider(p)] || ''; }
function getModel(p) { const pr = activeProvider(p); return (CFG.models[pr] || DEFAULTS[pr]).trim(); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Unified LLM call ---------- */
async function llm(prompt, { json = false, model, provider } = {}) {
  const pr = activeProvider(provider);
  const key = getKey(pr);
  if (!key) {
    const err = new Error(`No ${pr === 'openrouter' ? 'OpenRouter' : 'Gemini'} API key set. Paste it in the app (⚙) or add it to .env.`);
    err.code = 'NO_KEY'; throw err;
  }
  const useModel = (model || getModel(pr)).trim();
  return pr === 'openrouter'
    ? callOpenRouter(prompt, { json, key, model: useModel })
    : callGemini(prompt, { json, key, model: useModel });
}

async function callGemini(prompt, { json, key, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: json ? 0.2 : 0.35, maxOutputTokens: 8192, ...(json ? { responseMimeType: 'application/json' } : {}) }
  };
  const MAX = 4;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429 && attempt < MAX) {
      let waitMs = 0;
      try { const j = JSON.parse(await r.clone().text()); const rd = (j.error?.details || []).find(d => /RetryInfo/.test(d['@type'] || ''))?.retryDelay; if (rd) waitMs = (parseFloat(rd) || 0) * 1000; } catch (_) {}
      if (!waitMs) waitMs = Math.min(60000, 5000 * Math.pow(2, attempt));
      console.log(`  [gemini] rate limited (429) — waiting ${Math.round(waitMs / 1000)}s, retry ${attempt + 1}/${MAX}…`);
      await sleep(waitMs); continue;
    }
    if (!r.ok) {
      const t = await r.text(); let msg = `Gemini API error ${r.status}`;
      try { msg = JSON.parse(t).error?.message || msg; } catch (_) {}
      if (r.status === 400 && /API key not valid/i.test(msg)) msg = 'Your Gemini API key is not valid. Re-check it (⚙).';
      if (r.status === 404) msg = `Model "${model}" not available for your Gemini key. Pick another in ⚙ (e.g. gemini-2.0-flash-lite).`;
      if (r.status === 429) msg = 'Gemini free-tier daily quota reached. Switch to OpenRouter in ⚙, use another Google account, or wait for reset.';
      const err = new Error(msg); err.status = r.status; throw err;
    }
    const d = await r.json(); const cand = d.candidates?.[0];
    if (!cand) throw new Error('Gemini returned no result (may have been blocked). Try again.');
    return (cand.content?.parts || []).map(p => p.text || '').join('');
  }
  throw new Error('Gemini rate limit persisted after retries.');
}

async function callOpenRouter(prompt, { json, key, model }) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  // Note: we do NOT force response_format json — many free models don't support it and
  // return empty content. We ask for JSON in the prompt and parse leniently instead.
  const body = {
    model,
    messages: [{ role: 'user', content: prompt + (json ? '\n\nReturn ONLY the JSON object, nothing else.' : '') }],
    temperature: json ? 0.2 : 0.35,
    max_tokens: 16000
  };
  const MAX = 4;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'ReqGen'
      },
      body: JSON.stringify(body)
    });
    if (r.status === 429 && attempt < MAX) {
      const waitMs = Math.min(60000, 5000 * Math.pow(2, attempt));
      console.log(`  [openrouter] rate limited (429) — waiting ${Math.round(waitMs / 1000)}s, retry ${attempt + 1}/${MAX}…`);
      await sleep(waitMs); continue;
    }
    if (!r.ok) {
      const t = await r.text(); let msg = `OpenRouter API error ${r.status}`;
      try { msg = JSON.parse(t).error?.message || msg; } catch (_) {}
      if (r.status === 401) msg = 'Your OpenRouter API key is not valid. Re-check it (⚙).';
      if (r.status === 402) msg = 'This OpenRouter model needs credits. Pick a free model (ID ends with ":free") in ⚙.';
      if (r.status === 404) msg = `OpenRouter model "${model}" not found. Pick one from the list in ⚙ (free ones end with ":free").`;
      if (r.status === 429) msg = 'OpenRouter free limit hit (20/min, ~50/day). Wait a minute, or switch provider/model in ⚙.';
      const err = new Error(msg); err.status = r.status; throw err;
    }
    const d = await r.json();
    const msg = d.choices?.[0]?.message || {};
    let content = msg.content;
    if (Array.isArray(content)) content = content.map(c => (typeof c === 'string' ? c : (c.text || c.content || ''))).join('');
    if (!content || !content.trim()) content = msg.reasoning || ''; // reasoning models put text here
    const finish = d.choices?.[0]?.finish_reason;
    if (!content || !content.trim()) {
      if (finish === 'length') throw new Error('The model ran out of output space before answering (a "reasoning" model). Pick a lighter free model in ⚙ (e.g. poolside/laguna-m.1:free or tencent/hy3:free).');
      throw new Error('OpenRouter returned no usable text for this model. Try another free model in ⚙, or switch provider to Gemini.');
    }
    return content;
  }
  throw new Error('OpenRouter rate limit persisted after retries.');
}

function safeJson(text) {
  // Strip code fences if the model added them, then parse.
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); }
  catch (_) {
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error('Could not parse AI response as JSON.');
  }
}

/* ---------- Status ---------- */
function statusPayload() {
  return {
    version: APP_VERSION,
    provider: CFG.provider,
    model: getModel(),
    keySet: !!getKey(),
    providers: {
      gemini: { keySet: !!CFG.keys.gemini, model: CFG.models.gemini },
      openrouter: { keySet: !!CFG.keys.openrouter, model: CFG.models.openrouter }
    }
  };
}
app.get('/api/status', (req, res) => res.json(statusPayload()));

/* ---------- List models for the given/active provider ---------- */
app.get('/api/models', async (req, res) => {
  try {
    const pr = activeProvider(req.query.provider);
    const key = CFG.keys[pr];
    if (!key) return res.status(400).json({ error: `Set your ${pr === 'openrouter' ? 'OpenRouter' : 'Gemini'} key first.` });

    if (pr === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': `Bearer ${key}` } });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Could not list OpenRouter models.' });
      const free = (d.data || [])
        .filter(m => { const p = m.pricing || {}; return (parseFloat(p.prompt) === 0 && parseFloat(p.completion) === 0) || /:free$/.test(m.id); })
        .map(m => m.id)
        // hide non-chat / specialist models that make poor doc writers
        .filter(id => !/(content-safety|guard|moderation|-code$|-code:|coder|embed|vision|image|tts|whisper)/i.test(id))
        .sort();
      // Put capable general models first if present (list rotates, so this is best-effort).
      const pref = free.filter(id => /nemotron-3-ultra|nemotron.*reasoning|llama-3\.3-70b|qwen.*72b|deepseek/i.test(id));
      const ordered = [...pref, ...free.filter(f => !pref.includes(f))];
      return res.json({ models: ordered.length ? ordered : free });
    }

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Could not list models.' });
    const models = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace(/^models\//, ''))
      .filter(n => /gemini/i.test(n) && !/vision|embedding|aqa|image|tts|robotics|computer/i.test(n))
      .sort();
    res.json({ models });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Set provider / key / model from the UI ---------- */
app.post('/api/config', (req, res) => {
  const { provider, apiKey, model, persist } = req.body || {};
  const pr = activeProvider(provider);
  if (provider === 'gemini' || provider === 'openrouter') CFG.provider = provider;
  if (typeof apiKey === 'string' && apiKey.trim()) CFG.keys[pr] = apiKey.trim();
  if (typeof model === 'string' && model.trim()) CFG.models[pr] = model.trim();

  let persisted = false, persistError = null;
  if (persist) {
    try {
      const lines = [
        `LLM_PROVIDER=${CFG.provider}`,
        `GEMINI_API_KEY=${CFG.keys.gemini || 'paste_your_key_here'}`,
        `GEMINI_MODEL=${CFG.models.gemini}`,
        `OPENROUTER_API_KEY=${CFG.keys.openrouter || 'paste_your_openrouter_key_here'}`,
        `OPENROUTER_MODEL=${CFG.models.openrouter}`,
        `PORT=${process.env.PORT || PORT}`
      ];
      fs.writeFileSync(path.join(__dirname, '.env'), lines.join('\n') + '\n');
      persisted = true;
    } catch (e) { persistError = e.message; }
  }
  res.json({ ...statusPayload(), persisted, persistError });
});

/* ---------- File extraction ---------- */
app.post('/api/extract', upload.array('files'), async (req, res) => {
  try {
    const out = [];
    for (const f of req.files || []) {
      const ext = (f.originalname.split('.').pop() || '').toLowerCase();
      let text = '';
      try {
        if (ext === 'docx') {
          const mammoth = require('mammoth');
          text = (await mammoth.extractRawText({ buffer: f.buffer })).value;
        } else if (ext === 'pdf') {
          const pdfParse = require('pdf-parse');
          text = (await pdfParse(f.buffer)).text;
        } else {
          text = f.buffer.toString('utf8'); // txt, vtt, md, csv, json, log, srt
        }
      } catch (e) {
        text = '';
        out.push({ name: f.originalname, chars: 0, content: '', error: 'Could not read this file: ' + e.message });
        continue;
      }
      out.push({ name: f.originalname, chars: text.length, content: text });
    }
    res.json({ files: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Build knowledge base ---------- */
function sourcesBlock(sources) {
  return sources.map((s, i) =>
    `----- SOURCE ${i + 1}: ${s.name} -----\n${(s.content || '').slice(0, 60000)}`
  ).join('\n\n');
}

app.post('/api/process', async (req, res) => {
  try {
    const { project = {}, sources = [], model, provider } = req.body;
    if (!sources.length) return res.status(400).json({ error: 'No sources provided.' });

    const prompt =
`You are an expert Business Analyst. You are given raw discovery inputs (meeting transcripts, workshop notes, client emails, chats) for a software project. Read ALL sources, merge information, remove duplicate discussions, and resolve contradictions.

PROJECT NAME: ${project.name || 'Untitled Project'}
DOMAIN: ${project.domain || 'N/A'}

SOURCES:
${sourcesBlock(sources)}

Return ONLY valid JSON matching exactly this schema (no commentary):
{
  "projectSummary": "2-3 sentence overview",
  "stakeholders": [{"name":"", "role":""}],
  "groups": [{"name":"requirement group name", "count": <int approx # of requirements>, "tags":["business rule"|"assumption"|"risk"...]}],
  "requirements": [{"id":"REQ-XXX-01","title":"short","statement":"The system shall...","group":"group name","sources":["exact source names it came from"],"confidence": <0-100 int>,"confidenceReason":"why (how many sessions etc.)"}],
  "conflicts": [{"topic":"","positions":["position A (source)","position B (source)"],"resolution":"how you resolved it and which wins"}],
  "gaps": ["important requirement areas that a BRD needs but were NOT discussed in the sources"],
  "timelineExample": {"requirement":"name of one key requirement","events":[{"source":"source name","note":"what that source said about it"}],"merged":"the single merged requirement statement combining all events"}
}

Rules:
- Confidence: high (80-100) if mentioned in multiple sources or stated as a firm decision; medium (50-79) if mentioned once or informally; low (<50) if vague/unfunded/deferred.
- Only list gaps that genuinely are not covered by the sources.
- Base everything strictly on the provided sources; do not invent stakeholders or requirements.`;

    const raw = await llm(prompt, { json: true, model, provider });
    const kb = safeJson(raw);
    res.json({ kb });
  } catch (e) {
    res.status(e.code === 'NO_KEY' ? 400 : 500).json({ error: e.message });
  }
});

/* ---------- Generate documents ---------- */
const DOC_PROMPTS = {
  BRD: `Produce a professional BUSINESS REQUIREMENTS DOCUMENT (BRD) with these sections: Project Overview, Business Objectives, Problem Statement, Scope, Out of Scope, Stakeholders (as a table), Functional Requirements, Non-Functional Requirements, Assumptions, Constraints, Risks (as a table with Risk/Impact/Mitigation), Success Criteria.`,
  FRD: `Produce a FUNCTIONAL REQUIREMENTS DOCUMENT (FRD): group functional requirements by module. For each requirement give an ID (FR-XXX-01), a clear "The system shall..." statement, and sub-rules where relevant.`,
  US: `Produce USER STORIES grouped by Epic. For each story use the format "As a <role>, I want <goal>, so that <benefit>." and include 2-4 acceptance criteria in Given/When/Then form.`,
  RTM: `Produce a REQUIREMENTS TRACEABILITY MATRIX as an HTML table with columns: Req ID, Requirement, Source, User Story, Test Case, Status. Status is Covered / Partial / Gap. Flag requirements that have no story or test as Gap.`,
  TC: `Produce TEST CASES as an HTML table with columns: ID, Type, Requirement, Scenario, Expected Result. Include Positive, Negative, Boundary and Validation types covering the key requirements.`
};

app.post('/api/generate', async (req, res) => {
  try {
    const { project = {}, kb = {}, docs = [], model, provider } = req.body;
    if (!docs.length) return res.status(400).json({ error: 'No document types selected.' });

    const context =
`PROJECT: ${project.name || 'Untitled'} (${project.domain || 'N/A'})
KNOWLEDGE BASE (merged from all discovery sources):
${JSON.stringify(kb, null, 2)}`;

    const results = {};
    const errors = {};
    // Generate all requested documents IN PARALLEL for speed (was sequential before).
    await Promise.all(docs.map(async (id) => {
      const spec = DOC_PROMPTS[id];
      if (!spec) { errors[id] = 'Unknown document type'; return; }
      const prompt =
`You are an expert Business Analyst. Using ONLY the knowledge base below, ${spec}

${context}

Output requirements:
- Return a clean HTML fragment ONLY (no <html>, <head>, <body>, no markdown code fences).
- Use <h3> for sections, <h4> for sub-headings, <p>, <ul>/<li>, and <table>/<tr>/<th>/<td>.
- Keep it complete and professional. Do not invent facts not supported by the knowledge base; where the knowledge base flags a gap, note it explicitly.`;
      try {
        let html = await llm(prompt, { model, provider });
        html = html.trim().replace(/^```(?:html)?/i, '').replace(/```$/, '').trim();
        results[id] = html;
      } catch (e) {
        errors[id] = e.message;
      }
    }));
    res.json({ docs: results, errors });
  } catch (e) {
    res.status(e.code === 'NO_KEY' ? 400 : 500).json({ error: e.message });
  }
});

function start(port, attemptsLeft) {
  const server = app.listen(port, () => {
    console.log(`\n  ReqGen ${APP_VERSION} running →  http://localhost:${port}`);
    if (port !== PORT) console.log(`  (port ${PORT} was busy, so I used ${port} instead)`);
    console.log(`  Provider: ${CFG.provider}  (Gemini key: ${CFG.keys.gemini ? 'set' : 'none'}, OpenRouter key: ${CFG.keys.openrouter ? 'set' : 'none'})`);
    if (!getKey()) {
      console.log('  ⚠  No API key for the active provider yet — open the page and set it in the top-right ⚙.\n');
    } else {
      console.log(`  ✓  Ready. Model: ${getModel()}\n`);
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  port ${port} in use, trying ${port + 1}…`);
      start(port + 1, attemptsLeft - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✗ Could not find a free port near ${PORT}. Close the other server or set a different PORT in .env.\n`);
      process.exit(1);
    } else {
      throw err;
    }
  });
}
// Run a normal server locally; on Vercel/serverless just export the app.
if (require.main === module) {
  start(PORT, 10);
}
module.exports = app;
