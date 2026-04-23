// =====================================================
// Baron — MyCU Virtual Assistant (backend)
// =====================================================
// A ChatGPT-style assistant specialized for Carolina
// University's MyCU portal.
//
// Features:
//   - MyCU-aware system prompt (Baron persona)
//   - Per-session conversation memory
//   - Optional live web search (SerpAPI) for fresh facts
//   - Smart routing: only hits the web when needed
//   - Clean error handling + health check
//   - Loads API keys from .env (falls back to legacy api.txt)
// =====================================================

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// cheerio lets us pull readable text out of the top result page
// so Baron can quote real sentences, not just snippets.
let cheerio = null;
try {
  cheerio = await import("cheerio");
} catch {
  console.warn("[warn] cheerio not installed — deep page fetch disabled.");
}

// Optional deps: loaded lazily so the server still boots
// if they aren't installed.
let getJson = null;
try {
  ({ getJson } = await import("serpapi"));
} catch {
  console.warn("[warn] serpapi not installed — web search disabled.");
}

try {
  const dotenv = await import("dotenv");
  dotenv.config();
} catch {
  // dotenv is optional
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- API KEYS ----------
function readLegacyKey() {
  try {
    const p = path.join(__dirname, "api.txt");
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8").trim();
    return raw.replace(/^["']|["']$/g, "");
  } catch {
    return null;
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || readLegacyKey();
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || null;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PORT = Number(process.env.PORT) || 3000;

if (!OPENAI_API_KEY) {
  console.warn(
    "[warn] No OPENAI_API_KEY found. Set it in .env or api.txt. " +
    "The server will still start but /api/chat will return an error."
  );
}

// ---------- APP ----------
const app = express();

// Permissive CORS so the page works whether it's served from
// http://localhost:3000 (same-origin), a different port during dev,
// or even opened as a plain file:// (origin "null"). We also answer
// Chrome's Private Network Access preflight so requests from
// http://localhost or file:// to 127.0.0.1 aren't blocked.
app.use(
  cors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});

app.use(express.json({ limit: "1mb" }));

// Serve the dashboard. `index: "index.html"` makes GET / return the
// page explicitly, and no-cache keeps the browser from running a
// stale app.js after we fix something.
app.use(
  express.static(__dirname, {
    index: "index.html",
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    }
  })
);

// Explicit root fallback (belt-and-suspenders for Express 5).
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------- SESSION MEMORY ----------
// Each session stores richer state so Baron can hold a real
// conversation (remember the last topic, who the user appears to be,
// a running summary of the chat, etc.), not just a flat history array.
//
// Shape:
//   {
//     history:             [{role, content}]   // last ~24 messages
//     lastUserQuery:       string              // for follow-up resolution
//     lastIntent:          string              // last detected intent
//     lastEntities:        {topics, roles, properNouns}
//     userProfile:         {isInternational, isProspective, isNewStudent, isGrad, preferredLang}
//     conversationSummary: string              // running summary injected into system prompt
//     turnCount:           number              // total turns this session
//     lastSeen:            ms
//   }
const sessions = new Map();
const MAX_TURNS = 12;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SUMMARIZE_EVERY = 14; // messages (user + assistant) before we summarize

function newSession() {
  return {
    history: [],
    lastUserQuery: "",
    lastIntent: "",
    lastEntities: { topics: [], roles: [], properNouns: [] },
    userProfile: {
      isInternational: false,
      isProspective: false,
      isNewStudent: false,
      isGrad: false,
      preferredLang: null
    },
    conversationSummary: "",
    turnCount: 0,
    lastSeen: Date.now()
  };
}

function getSession(sessionId) {
  const now = Date.now();
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = newSession();
    sessions.set(sessionId, entry);
  } else {
    entry.lastSeen = now;
  }
  return entry;
}

// Back-compat shim — older helpers still pass a sessionId and expect
// just the plain history array.
function getHistory(sessionId) {
  return getSession(sessionId).history;
}

function pushHistory(sessionId, role, content) {
  const s = getSession(sessionId);
  s.history.push({ role, content });
  while (s.history.length > MAX_TURNS * 2) s.history.shift();
}

// Merge a turn's info into a session object in one place, so callers
// don't have to remember every field to update.
function updateSession(session, patch) {
  if (!session || !patch) return;
  if (patch.userMsg) {
    session.lastUserQuery = patch.userMsg;
    session.history.push({ role: "user", content: patch.userMsg });
  }
  if (patch.reply) {
    session.history.push({ role: "assistant", content: patch.reply });
  }
  if (patch.intent) session.lastIntent = patch.intent;
  if (patch.entities) {
    session.lastEntities = {
      topics: patch.entities.topics || session.lastEntities.topics || [],
      roles: patch.entities.roles || session.lastEntities.roles || [],
      properNouns: patch.entities.properNouns || session.lastEntities.properNouns || []
    };
  }
  if (patch.profileHints && typeof patch.profileHints === "object") {
    for (const [k, v] of Object.entries(patch.profileHints)) {
      // Never un-set profile facts (they accumulate across turns).
      if (v === true || typeof v === "string") session.userProfile[k] = v;
    }
  }
  session.turnCount = (session.turnCount || 0) + 1;
  session.lastSeen = Date.now();
  while (session.history.length > MAX_TURNS * 2) session.history.shift();
}

// Sweep stale sessions every 10 minutes.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let removed = 0;
  for (const [id, entry] of sessions) {
    if (entry.lastSeen < cutoff) {
      sessions.delete(id);
      removed++;
    }
  }
  if (removed) console.log(`[sessions] pruned ${removed} stale session(s)`);
}, 10 * 60 * 1000).unref();

// ---------- SYSTEM PROMPT ----------
const BARON_SYSTEM_PROMPT = [
  "You are Baron, the official virtual assistant for Carolina University's",
  "MyCU student portal. You help students, faculty, and staff navigate the",
  "portal and answer questions about Carolina University (a private Christian",
  "university in Winston-Salem, NC, offering undergraduate, graduate, and",
  "doctoral programs).",
  "",
  "== CAPABILITIES ==",
  "- You DO have access to live web search results. Whenever the conversation",
  "  includes a 'FRESH WEB CONTEXT' system message, treat it as authoritative",
  "  up-to-date information that overrides your training data.",
  "- NEVER reply 'I can't browse the internet' or 'I don't have real-time",
  "  information'. If web context is present, use it. If it isn't and the",
  "  user asked for a fact you aren't sure about, say 'Let me look that up',",
  "  and the server will search on your behalf on the next turn.",
  "- When you use web context, cite it by adding a short 'Sources:' line at",
  "  the end with the page titles (the UI will render clickable links).",
  "",
  "== PERSONALITY ==",
  "- Friendly, warm, encouraging — like a helpful upperclassman.",
  "- Professional but approachable. Never robotic.",
  "- Concise by default; expand when the user wants detail.",
  "- Always answer in the same language the user wrote in (English/Spanish).",
  "  If they mix, match the dominant language of their most recent message.",
  "",
  "== WHAT YOU KNOW ABOUT MyCU ==",
  "- Top nav: Home, Admissions, Retention, Students, Courses, Finances,",
  "  Faculty, Staff, Student Services.",
  "- Sidebar: Change Password, Forms, IRB (Research with Human Subjects),",
  "  Campus Health, Early Alert Messages.",
  "- Quick Links: My Courses, CU Email, Microsoft 365, Online Bookstore.",
  "- Information panel: New Student Orientation, Services Status, eChecklist,",
  "  Helpdesk, Computer Requirements, Directory.",
  "",
  "== HOW YOU ANSWER ==",
  "1. Start with a direct answer (1–2 sentences).",
  "2. Follow with steps or detail. Use short bullets only when it genuinely",
  "   helps; otherwise write in prose.",
  "3. For MyCU features, tell the user exactly where to click",
  "   (e.g., 'Open MyCU > Students > Forms').",
  "4. If web results don't answer the question, say so honestly and point the",
  "   user to the right office: Helpdesk (IT), Registrar (academic records),",
  "   Student Services (campus life), Admissions (prospective students).",
  "5. Never invent URLs, phone numbers, emails, names, dates, or policies.",
  "   Only state them if they come from web context or MyCU knowledge above.",
  "6. For sensitive topics (mental health, emergencies), be warm and point",
  "   the user to Campus Health or the appropriate resource.",
  "",
  "== FORMAT ==",
  "Plain text with light markdown: **bold**, `code`, [link](url), numbered",
  "lists, '- ' bullets. No HTML. Keep responses under ~220 words unless",
  "the user asks for more."
].join("\n");

// Wrap the static persona with session-aware context so each reply is
// steered by who the user seems to be and what we've been talking about.
function buildSystemPrompt(session) {
  const parts = [BARON_SYSTEM_PROMPT];

  if (session && session.conversationSummary) {
    parts.push(
      "\n== CONVERSATION CONTEXT SO FAR ==\n" +
      session.conversationSummary +
      "\n(Use this context to stay consistent; don't repeat prior explanations verbatim.)"
    );
  }

  if (session && session.userProfile) {
    const p = session.userProfile;
    const tags = [];
    if (p.isProspective) tags.push("prospective applicant");
    if (p.isNewStudent) tags.push("new/incoming student");
    if (p.isGrad) tags.push("graduate student");
    if (p.isInternational) tags.push("international student");
    if (tags.length) {
      parts.push(
        "\n== USER PROFILE ==\nThe user appears to be: " + tags.join(", ") +
        ". Tailor examples, steps, and tone accordingly."
      );
    }
    if (p.preferredLang === "es") {
      parts.push(
        "\nThe user has been writing in Spanish. Continue in Spanish unless they switch."
      );
    }
  }

  if (session && session.lastIntent && session.lastIntent !== "general") {
    parts.push(`\n[meta] previous-intent=${session.lastIntent}`);
  }

  return parts.join("\n");
}

// ---------- WEB SEARCH ----------

// A short message like "search it", "look for it", "búscalo",
// "averígualo" means: re-run the previous user question as a search.
const FOLLOW_UP_RE =
  /^\s*(?:please\s+)?(?:search(?:\s+(?:it|that|for\s+it|that\s+up))?|look(?:\s+(?:it|that)(?:\s+up)?|\s+for\s+it)?|google\s+(?:it|that)|find(?:\s+(?:it|that|out))?|check(?:\s+(?:it|that))?|b[uú]scalo|busca\s+(?:eso|lo|esa)?|encu[eé]ntralo|aver[ií]gualo|investiga(?:lo)?|bus[cq]uelo)[\s.!?]*$/i;

function resolveFollowUp(userMsg, history) {
  if (!FOLLOW_UP_RE.test(userMsg)) return userMsg;
  // Find the most recent different user message to search for.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.content && m.content.trim() !== userMsg.trim()) {
      return m.content;
    }
  }
  return userMsg;
}

// ---------- NLU: INTENT / ENTITIES / PROFILE / CONTEXT ----------
// Small, dependency-free regex classifiers. They don't have to be
// perfect — they're hints for system-prompt steering and suggestion
// generation. The real reasoning still happens in the model.

function detectIntent(text) {
  if (!text) return "general";
  const t = text.toLowerCase().trim();

  if (FOLLOW_UP_RE.test(t)) return "follow_up";

  if (/^(hi|hello|hey|yo|sup|hola|buenas(?:\s+(?:d[ií]as|tardes|noches))?|buenos\s+d[ií]as|qu[eé]\s+tal|saludos)\b[\s!.?]*$/i.test(t)) return "greeting";

  if (/^(thanks?|thank\s+you|thx|ty|appreciate(?:\s+it)?|gracias|muchas\s+gracias|mil\s+gracias|te\s+lo\s+agradezco)\b[\s!.?]*$/i.test(t)) return "thanks";

  // IT / helpdesk issues
  if (/\b(password|reset\s+password|can'?t\s+log\s+in|cannot\s+log\s+in|login\s+(?:problem|issue)|locked\s+out|wifi|vpn|email\s+not\s+working|outlook|microsoft\s+365|printer|helpdesk|tech\s+support|it\s+support|contrase[nñ]a|no\s+puedo\s+(?:entrar|iniciar\s+sesi[oó]n)|correo\s+no\s+funciona|soporte\s+t[eé]cnico)\b/.test(t)) return "it_helpdesk";

  // Procedural — "how do I / where do I / steps to ..."
  if (/\b(how\s+(?:do|can|should)\s+i|how\s+to|where\s+(?:do|can)\s+i|steps?\s+to|process\s+for|guide\s+(?:me|to)|c[oó]mo\s+(?:puedo|hago|cambio|accedo|contacto|encuentro)|d[oó]nde\s+(?:puedo|encuentro|est[aá]))\b/.test(t)) return "procedural";

  // University info (facts, people, programs, etc.)
  if (/\b(president|provost|chancellor|dean|director|chair(?:person)?|registrar|professor|instructor|faculty|tuition|cost|price|fee|fees|scholarship|financial\s+aid|deadline|accredit\w*|ranking|admission|apply|application|program|degree|major|minor|campus|location|address|carolina\s+university|mycu|presidente|rector|decano|matr[ií]cula|beca|inscrip|carrera|departamento)\b/.test(t)) return "university_info";

  // Who is / quién es
  if (/\b(who(?:'s|\s+is|\s+are|\s+was)|whose|qui[eé]n(?:es)?\s+(?:es|son|fue|era))\b/.test(t)) return "university_info";

  return "general";
}

function extractEntities(text) {
  const t = (text || "").toLowerCase();
  const topics = [];
  const roles = [];

  const topicMap = {
    password: /\b(password|contrase[nñ]a)\b/,
    tuition: /\b(tuition|cost|price|fee|fees|matr[ií]cula|costo|precio)\b/,
    scholarship: /\b(scholarship|financial\s+aid|grant|beca|ayuda\s+financiera)\b/,
    admission: /\b(admission|apply|application|admit|inscrip|admisi[oó]n|aplicar)\b/,
    program: /\b(program|degree|major|minor|carrera|programa|posgrado|maestr[ií]a)\b/,
    campus: /\b(campus|location|address|direcci[oó]n|ubicaci[oó]n|winston[-\s]?salem)\b/,
    courses: /\b(course|class|register|enrollment|enroll|schedule|semester|curso|clase|inscrib\w+|horario|semestre)\b/,
    health: /\b(health|counseling|wellness|mental\s+health|campus\s+health|salud|consejer[ií]a)\b/,
    email: /\b(email|outlook|microsoft\s+365|office\s+365|correo)\b/,
    helpdesk: /\b(helpdesk|it\s+support|soporte\s+t[eé]cnico|mesa\s+de\s+ayuda)\b/,
    deadline: /\b(deadline|due\s+date|fecha\s+l[ií]mite|vence)\b/,
    forms: /\b(form|forms|formulario)\b/,
    orientation: /\b(orientation|new\s+student|orientaci[oó]n)\b/
  };
  for (const [k, re] of Object.entries(topicMap)) {
    if (re.test(t)) topics.push(k);
  }

  const roleMap = {
    president: /\b(president|presidente|rector)\b/,
    provost: /\b(provost|vice[-\s]?presidente\s+acad[eé]mic)\b/,
    dean: /\b(dean|decano)\b/,
    director: /\b(director|director[ae])\b/,
    professor: /\b(professor|instructor|faculty|profesor[a]?)\b/,
    registrar: /\b(registrar)\b/,
    chair: /\b(chair|chairperson)\b/,
    coach: /\b(coach|entrenador[a]?)\b/,
    advisor: /\b(advisor|asesor[a]?\s+acad[eé]mic)\b/
  };
  for (const [k, re] of Object.entries(roleMap)) {
    if (re.test(t)) roles.push(k);
  }

  // Proper nouns: sequences of capitalized words (crude but useful for
  // remembering names the user brings up).
  const properNouns = [];
  const rawMatches =
    (text || "").match(/\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3}\b/g) || [];
  for (const m of rawMatches) {
    const first = m.split(/\s+/)[0];
    if (!/^(I|You|The|And|Or|But|For|Of|In|On|At|By|With|How|What|Where|When|Who|Why|El|La|Los|Las|Un|Una|De|Del|Que|Como|D[oó]nde|Cu[aá]ndo|Qui[eé]n)$/i.test(first)) {
      properNouns.push(m);
    }
  }

  return { topics, roles, properNouns };
}

function extractProfileHints(text) {
  const t = (text || "").toLowerCase();
  const hints = {};
  if (/\b(international\s+student|from\s+(?:india|china|nigeria|mexico|m[eé]xico|colombia|brazil|venezuela|ecuador|peru|per[uú])|visa|i-?20|f-?1|estudiante\s+internacional)\b/.test(t)) {
    hints.isInternational = true;
  }
  if (/\b(prospective|applying|thinking\s+of\s+applying|want\s+to\s+apply|considering\s+(?:to\s+)?apply|futuro\s+estudiante|quiero\s+(?:aplicar|inscribirme)|estoy\s+pensando\s+en\s+aplicar)\b/.test(t)) {
    hints.isProspective = true;
  }
  if (/\b(new\s+student|incoming|freshman|just\s+admitted|recently\s+admitted|new\s+to\s+(?:carolina|mycu)|estudiante\s+nuevo|reci[eé]n\s+admitido)\b/.test(t)) {
    hints.isNewStudent = true;
  }
  if (/\b(grad(?:uate)?\s+student|phd|ph\.?d|doctoral|doctorate|master'?s\s+(?:degree|program)|mba|posgrado|maestr[ií]a|doctorado)\b/.test(t)) {
    hints.isGrad = true;
  }
  // Language preference: Spanish markers (we only flip TO Spanish; the
  // model can still follow a user who switches back to English).
  if (/\b(hola|buenas|c[oó]mo|d[oó]nde|cu[aá]ndo|qu[eé]|gracias|por\s+favor|necesito|quiero|puedo|soy|estudiante|busca|b[uú]scalo|ay[uú]dame)\b/.test(t)) {
    hints.preferredLang = "es";
  }
  return hints;
}

// Merge pronoun expansion + follow-up resolution into one pass so the
// downstream web search + model call both see the fully-resolved query.
function resolveContext(query, session) {
  if (!query) return query;

  // Follow-up — re-target to last user query.
  if (FOLLOW_UP_RE.test(query)) {
    if (session && session.lastUserQuery) return session.lastUserQuery;
    // fallback: walk history
    return resolveFollowUp(query, session ? session.history : []);
  }

  // Pronoun / deixis expansion on short messages.
  const t = query.toLowerCase().trim();
  if (t.length < 70 && /\b(it|its|his|her|their|them|they|he|she|this|that|su|sus|[eé]l|ella|ellos|esto|eso|aquello)\b/i.test(t)) {
    const last = session && session.lastUserQuery;
    if (last && /\b(carolina|university|mycu|president|provost|dean|director|professor|registrar|tuition|scholarship|admission|program|course|helpdesk)\b/i.test(last)) {
      return `${query} (context: ${last})`;
    }
  }

  return query;
}

// Heuristic: does the user's question need fresh, verifiable info?
// We bias toward YES whenever they ask about people, dates, numbers,
// or anything CU-specific beyond the static portal structure.
function needsWebSearch(text, history = []) {
  if (!SERPAPI_API_KEY || !getJson) return false;
  const t = text.toLowerCase().trim();
  if (!t) return false;

  // Follow-up phrases are always a search.
  if (FOLLOW_UP_RE.test(t)) return true;

  // Explicit search verbs (EN + ES).
  if (/\b(search|look\s+(?:up|for)|google|find\s+out|b[uú]scame?|b[uú]scalo|investiga|aver[ií]gua|encu[eé]ntrame?|cons[úu]ltalo)\b/i.test(t)) return true;

  // "Who is / quién es" questions almost always benefit from fresh data.
  if (/\b(?:who(?:'s|\s+is|\s+are|\s+was)|whose|qui[eé]n(?:es)?\s+(?:es|son|fue|era))\b/i.test(t)) return true;

  // University-specific roles / offices (EN + ES).
  if (/\b(president|provost|chancellor|dean|director|chair(?:person)?|registrar|professor|instructor|faculty|vp|vice[-\s]?president|coach|presidente|director[ae]?|decano|rector|profesor[a]?)\b/i.test(t)) return true;

  // Concrete facts worth verifying (deadlines, tuition, contact, programs).
  if (/\b(tuition|scholarship|financial\s+aid|cost|price|fee|fees|deadline|accredit\w*|ranking|enroll|admission|apply|application|phone|email|address|hours|location|department|program|degree|major|minor|gpa|semester|matr[ií]cula|costo|precio|beca|fecha\s+l[ií]mite|acredit\w*|inscrip|carrera|departamento)\b/i.test(t)) return true;

  // Temporal / news triggers (EN + ES).
  if (/\b(today|tonight|yesterday|this\s+(week|semester|month|year)|latest|current|news|weather|score|release\s+date|when\s+(?:does|will|is|are)|now\s+playing|trending|hoy|ayer|esta\s+semana|este\s+(mes|a[nñ]o|semestre)|[uú]ltim[oa]|actual|cu[aá]ndo|reciente)\b/i.test(t)) return true;

  // Anything explicitly mentioning Carolina University or related keywords
  // tends to benefit from real sources.
  if (/\b(carolina\s+university|mycu|winston[-\s]?salem|cu\s+(?:portal|email|campus|students|faculty|admissions))\b/i.test(t)) return true;

  // If the user just said a very short message that references "it" or
  // builds on the prior turn (e.g., "and his email?"), and the history
  // looks CU-related, search again.
  if (t.length < 40 && history.length > 0 && /\b(it|his|her|their|they|he|she|su|sus|el|ella|ellos|esto|eso)\b/i.test(t)) {
    const recent = history.slice(-4).map((h) => (h.content || "").toLowerCase()).join(" ");
    if (/\b(carolina|university|mycu|president|dean|director|professor|registrar|tuition)\b/i.test(recent)) {
      return true;
    }
  }

  return false;
}

// Add Carolina University context to CU-related queries so we don't
// get results about random "university presidents" or unrelated people.
function enrichQuery(query, history = []) {
  const q = query.trim();
  if (/carolina\s+university/i.test(q)) return q;

  const recent = history.slice(-6).map((h) => (h.content || "").toLowerCase()).join(" ");
  const combined = (q + " " + recent).toLowerCase();

  const cuish = /\b(carolina|mycu|winston[-\s]?salem)\b/.test(combined)
    || /\b(university|college|campus|dean|president|provost|chancellor|registrar|tuition|admissions|faculty|student\s+services|helpdesk|bookstore|echecklist|orientation|department|program|degree)\b/.test(q.toLowerCase());

  if (cuish) {
    return `Carolina University (Winston-Salem, NC) — ${q}`;
  }
  return q;
}

// Fetch readable body text from a URL so the model has more grounding
// than just a Google snippet. Best-effort; silent on failure.
async function fetchPageSnippet(url, { maxChars = 1500, timeoutMs = 5000 } = {}) {
  if (!cheerio) return "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "BaronBot/1.0 (MyCU VA; +https://carolinau.edu)",
        Accept: "text/html,application/xhtml+xml"
      },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) return "";
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return "";
    const html = (await res.text()).slice(0, 400000);
    const $ = cheerio.load(html);
    $("script, style, nav, header, footer, noscript, aside, form, iframe").remove();
    const text = ($("main").text() || $("article").text() || $("body").text() || "")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, maxChars);
  } catch {
    return "";
  }
}

async function searchWeb(query) {
  if (!getJson || !SERPAPI_API_KEY) {
    return { results: [], deep: "", answerBox: null, knowledgeGraph: null };
  }
  try {
    const data = await getJson({
      engine: "google",
      q: query,
      api_key: SERPAPI_API_KEY,
      num: 5,
      hl: "en",
      gl: "us"
    });
    const results = (data.organic_results || []).slice(0, 5).map((r) => ({
      title: r.title || "",
      snippet: r.snippet || r.snippet_highlighted_words?.join(" ") || "",
      link: r.link || ""
    }));
    // Pull a chunk of real text from the first reputable result.
    let deep = "";
    const top = results.find((r) => r.link && !/\.pdf($|\?)/i.test(r.link));
    if (top) {
      const text = await fetchPageSnippet(top.link);
      if (text) deep = `PAGE EXCERPT (${top.link}):\n${text}`;
    }
    return {
      results,
      deep,
      answerBox: data.answer_box || null,
      knowledgeGraph: data.knowledge_graph || null
    };
  } catch (err) {
    console.warn("[warn] web search failed:", err?.message || err);
    return { results: [], deep: "", answerBox: null, knowledgeGraph: null };
  }
}

function formatWeb({ results = [], deep = "", answerBox = null, knowledgeGraph = null }) {
  const parts = [];
  if (answerBox) {
    const ab = answerBox.answer || answerBox.snippet || answerBox.result || "";
    if (ab) parts.push(`ANSWER BOX: ${ab}`);
  }
  if (knowledgeGraph) {
    const kg = knowledgeGraph;
    const bits = [kg.title, kg.type, kg.description].filter(Boolean);
    if (bits.length) parts.push(`KNOWLEDGE GRAPH: ${bits.join(" — ")}`);
  }
  if (results.length) {
    parts.push(
      "ORGANIC RESULTS:\n" +
        results.map((r, i) => `(${i + 1}) ${r.title}\n${r.snippet}\n${r.link}`).join("\n\n")
    );
  }
  if (deep) parts.push(deep);
  return parts.join("\n\n---\n\n");
}

// ---------- OPENAI ----------
async function callOpenAI(messages, { temperature = 0.6, maxTokens = 600 } = {}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens: maxTokens,
      messages
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

// ---------- MyCU KNOWLEDGE BASE ----------
// Canonical answers for the most common MyCU portal tasks. These are
// hints, not final replies — the model still composes the response so
// it matches the user's language/tone, but it anchors on the KB text
// instead of guessing at UI layout we already know.
const MYCU_KB = [
  {
    id: "password_reset",
    match: (t) =>
      /\b(reset\s+password|change\s+password|password\s+reset|forgot\s+(?:my\s+)?password|cambiar\s+contrase[nñ]a|restablecer\s+contrase[nñ]a|olvid[eé]\s+(?:mi\s+)?contrase[nñ]a)\b/i.test(t) ||
      (/\bpassword\b/i.test(t) && /\b(change|reset|forgot|cambi\w+|restablec\w+|olvid\w+)\b/i.test(t)),
    answer:
      "To change your MyCU password: (1) sign in to MyCU, (2) click 'Change Password' in the left sidebar, (3) enter your current password and choose a new one, then save. If you're locked out, use the HELPDESK button in the right panel to request a reset."
  },
  {
    id: "forms",
    match: (t) =>
      /\b(where\s+(?:do|can)\s+i\s+find\s+(?:the\s+)?forms?|find\s+forms?|access\s+forms?|d[oó]nde\s+encuentro\s+(?:los\s+)?formularios?)\b/i.test(t),
    answer:
      "Forms live under 'Forms' in the MyCU left sidebar — you'll find registration, withdrawal, FERPA release, and enrollment verification forms there."
  },
  {
    id: "helpdesk",
    match: (t) =>
      /\b(contact\s+helpdesk|reach\s+(?:the\s+)?helpdesk|helpdesk\s+(?:phone|email|hours|contact)|c[oó]mo\s+contactar\s+(?:al\s+)?helpdesk)\b/i.test(t),
    answer:
      "Click the 'HELPDESK' button in the right-side Information panel of MyCU — it opens the current contact options, hours, and ticket form."
  },
  {
    id: "register_courses",
    match: (t) =>
      /\b(register\s+for\s+(?:a\s+)?courses?|course\s+registration|enroll\s+in\s+(?:a\s+)?(?:course|class)|inscrib\w+\s+(?:en\s+)?cursos?|registrar\s+cursos?)\b/i.test(t),
    answer:
      "Course registration runs through the Courses tab in the top navigation. Before registering: meet with your advisor, clear any holds (check Finances), and then register during your assigned window."
  },
  {
    id: "echecklist",
    match: (t) => /\b(echecklist|e[-\s]?checklist)\b/i.test(t),
    answer:
      "The eChecklist is in the right-side Information panel — use it to track outstanding items like financial aid forms, health records, and orientation tasks."
  },
  {
    id: "orientation",
    match: (t) =>
      /\b(new\s+student\s+orientation|orientation\s+(?:info|schedule)|orientaci[oó]n\s+(?:de\s+)?nuevos?\s+estudiantes)\b/i.test(t),
    answer:
      "Click 'NEW STUDENT ORIENTATION' in the right-side Information panel for the schedule and checklist. First-year and transfer students each have their own track."
  },
  {
    id: "directory",
    match: (t) =>
      /\b(directory|find\s+(?:a\s+)?faculty|staff\s+directory|directorio)\b/i.test(t),
    answer:
      "Use the 'DIRECTORY' button in the right-side Information panel to look up faculty and staff by name, department, or title."
  },
  {
    id: "cu_email",
    match: (t) => /\b(cu\s+email|access\s+(?:my\s+)?email|check\s+(?:my\s+)?email|correo\s+(?:cu|de\s+carolina))\b/i.test(t),
    answer:
      "Open your CU email from the 'CU Email' link under Quick Links in the MyCU sidebar, or sign in directly at outlook.office.com with your MyCU credentials."
  }
];

function matchKB(query) {
  const t = (query || "").toLowerCase();
  for (const item of MYCU_KB) {
    try {
      if (item.match(t)) return item;
    } catch {
      /* ignore bad matcher */
    }
  }
  return null;
}

// ---------- SUGGESTIONS ----------
// Produce up to 3 context-aware follow-up chips for the UI so the user
// always has a sensible next step without having to think of one.
function buildSuggestions(intent, entities, session) {
  const out = [];
  const push = (s) => { if (!out.includes(s)) out.push(s); };
  const topics = (entities && entities.topics) || [];
  const roles = (entities && entities.roles) || [];
  const profile = (session && session.userProfile) || {};

  // Topic-driven follow-ups
  if (topics.includes("tuition")) {
    push("Are there scholarships available?");
    push("What's the payment deadline?");
  }
  if (topics.includes("scholarship")) {
    push("How do I apply for financial aid?");
  }
  if (topics.includes("admission")) {
    push("When is the application deadline?");
    push("What documents do I need to apply?");
  }
  if (topics.includes("program")) {
    push("What are the degree requirements?");
    push("Who's the department chair?");
  }
  if (topics.includes("courses")) {
    push("How do I drop a course?");
    push("Where do I see my schedule?");
  }
  if (topics.includes("password") || intent === "it_helpdesk") {
    push("How do I contact the Helpdesk?");
    push("How do I access my CU email?");
  }
  if (topics.includes("forms")) {
    push("How do I submit a FERPA release?");
  }
  if (topics.includes("orientation") || profile.isNewStudent) {
    push("How do I access the eChecklist?");
  }

  // Role-driven
  if (roles.includes("president") || roles.includes("provost")) {
    push("How can I contact the President's office?");
  }
  if (roles.includes("dean") || roles.includes("director") || roles.includes("chair")) {
    push("How do I contact the department?");
  }
  if (roles.includes("advisor")) {
    push("How do I book a meeting with my advisor?");
  }

  // Intent-driven defaults
  if (intent === "greeting") {
    push("How do I change my MyCU password?");
    push("How much is tuition?");
    push("Who's the president of Carolina University?");
  }

  // Profile-driven
  if (profile.isProspective) {
    push("What programs does Carolina University offer?");
    push("How do I apply?");
  }
  if (profile.isInternational) {
    push("What are the international student requirements?");
  }

  // Always-useful fallbacks
  if (out.length === 0 && intent !== "thanks") {
    push("How do I register for courses?");
    push("How do I contact the Helpdesk?");
    push("Who is the president of Carolina University?");
  }

  return out.slice(0, 3);
}

// ---------- CONVERSATION SUMMARIZER ----------
// Fire-and-forget. Once a session gets long we compress older turns
// into a few sentences and store that on the session so future system
// prompts stay compact without losing context.
async function summarizeConversation(session) {
  if (!OPENAI_API_KEY) return;
  if (!session || !session.history || session.history.length < 6) return;
  try {
    const transcript = session.history
      .slice(-14)
      .map((m) => `${m.role === "user" ? "User" : "Baron"}: ${m.content}`)
      .join("\n");
    const summary = await callOpenAI(
      [
        {
          role: "system",
          content:
            "Summarize the conversation between a Carolina University student and Baron (their MyCU virtual assistant) in 3–4 short sentences. Keep topics asked about, any names or offices mentioned, and pending questions. Output the summary text only — no preamble."
        },
        { role: "user", content: transcript }
      ],
      { temperature: 0.2, maxTokens: 180 }
    );
    if (summary) {
      session.conversationSummary = summary;
      console.log(`[summary] session updated (${summary.length} chars)`);
    }
  } catch (err) {
    console.warn("[warn] summarize failed:", err?.message || err);
  }
}

// ---------- ROUTES ----------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    hasOpenAI: Boolean(OPENAI_API_KEY),
    hasSerp: Boolean(SERPAPI_API_KEY),
    hasCheerio: Boolean(cheerio),
    sessions: sessions.size,
    uptimeSec: Math.round(process.uptime())
  });
});

app.post("/api/reset", (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const { message, sessionId = "anon" } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ reply: "Please send a non-empty message." });
  }
  const rawMsg = message.trim().slice(0, 4000);
  const history = getHistory(sessionId);

  // If the user said something like "look for it", re-target the
  // search to their previous question but keep THEIR message in the
  // chat log so the transcript reads naturally.
  const resolvedMsg = resolveFollowUp(rawMsg, history);
  const isFollowUp = resolvedMsg !== rawMsg;

  try {
    let webContext = "";
    let sources = [];
    let webQuery = null;

    if (needsWebSearch(resolvedMsg, history)) {
      webQuery = enrichQuery(resolvedMsg, history);
      console.log(`[search] ${webQuery}`);
      const found = await searchWeb(webQuery);
      webContext = formatWeb(found);
      sources = (found.results || []).slice(0, 3).map((r) => ({
        title: r.title,
        link: r.link
      }));
    }

    const messages = [
      { role: "system", content: BARON_SYSTEM_PROMPT },
      ...history
    ];

    if (webContext) {
      messages.push({
        role: "system",
        content:
          "FRESH WEB CONTEXT (authoritative — prefer this over your training " +
          "memory when they disagree; cite sources by title at the end):\n\n" +
          webContext
      });
    }

    // If the user sent a follow-up, nudge the model to treat it as
    // a search on the previous topic instead of replying literally.
    if (isFollowUp) {
      messages.push({
        role: "system",
        content:
          "The user's latest message is a follow-up asking you to look up " +
          "their previous question: \"" + resolvedMsg.slice(0, 300) + "\". " +
          "Answer that question using the web context above."
      });
    }

    messages.push({ role: "user", content: rawMsg });

    const reply = await callOpenAI(messages);

    pushHistory(sessionId, "user", rawMsg);
    pushHistory(sessionId, "assistant", reply);

    res.json({
      reply,
      sources,
      usedSearch: Boolean(webQuery),
      searchQuery: webQuery || null
    });
  } catch (err) {
    console.error("[/api/chat] error:", err?.message || err);
    const msg = String(err?.message || "");
    let reply = "I ran into a problem reaching the assistant. Please try again in a moment.";
    if (msg.includes("Missing OPENAI_API_KEY")) {
      reply = "I'm not configured yet — an OpenAI API key is missing on the server. Please add OPENAI_API_KEY to your .env file and restart.";
    } else if (msg.startsWith("OpenAI 401")) {
      reply = "The OpenAI API key looks invalid or expired. Please update it on the server.";
    } else if (msg.startsWith("OpenAI 429")) {
      reply = "The assistant is rate-limited right now. Give it a few seconds and try again.";
    }
    res.status(200).json({ reply, sources: [] });
  }
});

// Debug endpoint: hit it from the browser to see exactly what
// Baron would search for a given question. Helpful during tuning.
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "pass ?q=..." });
  const enriched = enrichQuery(q, []);
  const found = await searchWeb(enriched);
  res.json({ q, enriched, ...found });
});

// ---------- START ----------
const server = app.listen(PORT, () => {
  console.log("==========================================");
  console.log(`  Baron (MyCU VA) running`);
  console.log(`  URL:       http://localhost:${PORT}`);
  console.log(`  model:     ${MODEL}`);
  console.log(`  openai:    ${OPENAI_API_KEY ? "ok" : "MISSING"}`);
  console.log(`  websearch: ${SERPAPI_API_KEY ? "ok" : "off"}`);
  console.log("==========================================");
  console.log("  Open your browser at http://localhost:" + PORT);
  console.log("  (Do NOT open index.html directly via file://)");
  console.log("==========================================");
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `\n[FATAL] Port ${PORT} is already in use. ` +
      `Another copy of Baron (or a different app) is running on it.\n` +
      `  - Close the other process, or\n` +
      `  - Set a different port:  PORT=3001 npm start\n`
    );
  } else {
    console.error("[FATAL] Failed to start server:", err);
  }
  process.exit(1);
});
