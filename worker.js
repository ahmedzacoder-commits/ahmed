/*
  صاحبي بجد؟ — Cloudflare Worker (مجاني)
  ------------------------------------------
  بيجمّع نتايج صحابك على الإنترنت من غير Supabase ولا سيرفر عندك.
  الخطوات (دقايق):
   1) Cloudflare → Workers & Pages → Create → Worker → Edit code → الصق الملف ده كله → Deploy
   2) Storage & Databases → KV → Create namespace اسمه SA7BY
   3) Worker → Settings → Bindings → Add → KV namespace: Variable name = DB ، Namespace = SA7BY
   4) في friends.html حط:  SUPABASE_URL: "https://<اسم-الووركر>.<حسابك>.workers.dev"  و  SUPABASE_ANON_KEY: "cf"
  نفس الـ API بتاع Supabase/server.js:  POST /rest/v1/rpc/<fr_function>
*/

const QUIZ_LENGTH = 10;
const NAME_MAX = 24;
const MAX_ATTEMPTS_PER_QUIZ = 300;
const MAX_BODY_BYTES = 64 * 1024;
const QUIZ_TTL_DAYS = 90; // quizzes nobody touched for this long disappear

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
  "Access-Control-Max-Age": "86400",
};

class UserError extends Error {}
const fail = (message) => { throw new UserError(message); };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body ?? null), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS } });

function cleanName(raw) {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) fail("الاسم مطلوب");
  if ([...name].length > NAME_MAX) fail(`الاسم لازم يكون أقل من ${NAME_MAX} حرف`);
  return name;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
const validPicks = (p) => Array.isArray(p) && p.length === QUIZ_LENGTH && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 3);
const validId = (id) => typeof id === "string" && /^[a-f0-9]{10}$/.test(id);
const ttl = { expirationTtl: QUIZ_TTL_DAYS * 24 * 60 * 60 };

// ---------- storage: quiz:<id> → quiz, att:<id>:<name-lower> → attempt ----------
async function getQuiz(env, id) {
  return validId(id) ? env.DB.get(`quiz:${id}`, "json") : null;
}

async function listAttempts(env, quizId) {
  const keys = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: `att:${quizId}:`, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const rows = (await Promise.all(keys.map((k) => env.DB.get(k, "json")))).filter(Boolean);
  return rows.sort((x, y) => y.score - x.score || x.created_at.localeCompare(y.created_at)).slice(0, MAX_ATTEMPTS_PER_QUIZ);
}

const attemptKey = (quizId, name) => `att:${quizId}:${encodeURIComponent(name.toLowerCase())}`;
const publicRow = ({ id, name, score, total, blocked }) => ({ id, name, score, total, blocked });
const privateRow = ({ id, name, score, total, blocked, picks, tries, created_at }) => ({ id, name, score, total, blocked, picks, tries, created_at });

async function ownerQuiz(env, id, key) {
  const quiz = await getQuiz(env, id);
  if (!quiz || typeof key !== "string" || (await sha256(key)) !== quiz.owner_key_hash) fail("مش مسموح");
  return quiz;
}

// ---------- the same rules as the Supabase SQL functions ----------
const rpc = {
  async fr_create_quiz(env, { p_name, p_questions, p_answers, p_gender }) {
    if (!Array.isArray(p_questions) || p_questions.length !== QUIZ_LENGTH || !Array.isArray(p_answers) || p_answers.length !== QUIZ_LENGTH) {
      fail("لازم تجاوب على كل الأسئلة");
    }
    if (new Set(p_questions).size !== QUIZ_LENGTH || !p_questions.every((q) => typeof q === "string" && /^[a-z]{2,16}$/.test(q))) fail("سؤال غير صالح");
    if (!validPicks(p_answers)) fail("إجابة غير صالحة");
    const creator_name = cleanName(p_name);
    const id = randomHex(5);
    const owner_key = randomHex(32);
    const quiz = { id, creator_name, gender: p_gender === "f" ? "f" : "m", questions: p_questions, answers: p_answers, owner_key_hash: await sha256(owner_key), created_at: new Date().toISOString() };
    await env.DB.put(`quiz:${id}`, JSON.stringify(quiz), ttl);
    return { id, owner_key };
  },

  async fr_get_quiz(env, { p_id }) {
    const quiz = await getQuiz(env, p_id);
    return quiz ? { id: quiz.id, creator_name: quiz.creator_name, gender: quiz.gender || "m", questions: quiz.questions } : null;
  },

  async fr_board(env, { p_id }) {
    return validId(p_id) ? (await listAttempts(env, p_id)).map(publicRow) : [];
  },

  async fr_submit(env, { p_id, p_name, p_answers }) {
    const quiz = await getQuiz(env, p_id);
    if (!quiz) fail("الكويز ده مش موجود");
    const name = cleanName(p_name);
    if (!Array.isArray(p_answers) || p_answers.length !== quiz.answers.length) fail("لازم تجاوب على كل الأسئلة");
    if (!validPicks(p_answers)) fail("إجابة غير صالحة");
    const score = p_answers.reduce((sum, pick, i) => sum + (pick === quiz.answers[i] ? 1 : 0), 0);
    const key = attemptKey(quiz.id, name);
    const existing = await env.DB.get(key, "json");
    let attempt;
    if (existing) {
      attempt = { ...existing, name, picks: p_answers, score, total: quiz.answers.length, tries: (existing.tries || 1) + 1, created_at: new Date().toISOString() };
    } else {
      const count = (await env.DB.list({ prefix: `att:${quiz.id}:`, limit: MAX_ATTEMPTS_PER_QUIZ })).keys.length;
      if (count >= MAX_ATTEMPTS_PER_QUIZ) fail("الكويز ده اتزحم خلاص (٣٠٠ محاولة). اعمل كويز جديد");
      attempt = { id: crypto.randomUUID(), quiz_id: quiz.id, name, picks: p_answers, score, total: quiz.answers.length, blocked: false, tries: 1, created_at: new Date().toISOString() };
    }
    await env.DB.put(key, JSON.stringify(attempt), ttl);
    return { attempt_id: attempt.id, score, total: attempt.total, tries: attempt.tries, correct: quiz.answers, board: (await listAttempts(env, quiz.id)).map(publicRow) };
  },

  async fr_owner_board(env, { p_id, p_key }) {
    const quiz = await ownerQuiz(env, p_id, p_key);
    return { creator_name: quiz.creator_name, gender: quiz.gender || "m", questions: quiz.questions, answers: quiz.answers, board: (await listAttempts(env, quiz.id)).map(privateRow) };
  },

  async fr_set_blocked(env, { p_id, p_key, p_attempt, p_blocked }) {
    const quiz = await ownerQuiz(env, p_id, p_key);
    const rows = await listAttempts(env, quiz.id);
    const attempt = rows.find((a) => a.id === p_attempt);
    if (attempt) {
      attempt.blocked = Boolean(p_blocked);
      await env.DB.put(attemptKey(quiz.id, attempt.name), JSON.stringify(attempt), ttl);
    }
    return rows.map(privateRow);
  },
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/rest/v1/rpc/")) {
      // The site itself (public/index.html) is served from the same Worker, with a flag so the page uses this origin as its API.
      if (!env.ASSETS) return new Response("صاحبي بجد؟ API شغال ✅ — افتح الموقع نفسه مش العنوان ده.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } });
      const asset = await env.ASSETS.fetch(request);
      if (!(asset.headers.get("Content-Type") || "").includes("text/html")) return asset;
      const html = (await asset.text()).replace('<meta name="viewport"', '<script>window.FRIENDS_LOCAL_SERVER = true;</script>\n<meta name="viewport"');
      return new Response(html, { status: asset.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (request.method !== "POST") return json({ code: "PGRST202", message: "POST only" }, 405);
    if (!env.DB) return json({ message: "KV binding DB is missing: add a KV namespace binding named DB" }, 500);
    const fn = url.pathname.slice("/rest/v1/rpc/".length);
    const handler = Object.prototype.hasOwnProperty.call(rpc, fn) ? rpc[fn] : null;
    if (!handler) return json({ code: "PGRST202", message: `function ${fn} not found` }, 404);
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) fail("الطلب كبير أوي");
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { fail("طلب غير صالح"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
      return json(await handler(env, body));
    } catch (err) {
      if (err instanceof UserError) return json({ code: "P0001", message: err.message }, 400);
      console.error(err);
      return json({ message: "حصلت مشكلة، جرّب تاني" }, 500);
    }
  },
};
