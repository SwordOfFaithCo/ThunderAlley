// ThunderAlley accounts: create account / claim a unique username, sign in,
// stay signed in, recover a forgotten password with a recovery code, change
// username or password, delete the account, and keep levels, stats and
// loadouts in a cloud save so they follow the player to any phone.
//
// HTTP JSON API (all POST unless noted; signed-in calls send
// "Authorization: Bearer <token>"):
//   GET  /api/status                         -> {ok, storage, persistent}
//   GET  /api/name?u=NAME                    -> {available, reason}
//   POST /api/register {username, password}  -> {token, username, recovery_code}
//   POST /api/login    {username, password}  -> {token, username, created, save}
//   GET  /api/me                             -> {username, created, save}
//   POST /api/logout
//   POST /api/save     {data, base, level}   -> {t}   (409 + {save} if the cloud copy is newer)
//   POST /api/password {old, new}            -> {token}  (signs out other phones)
//   POST /api/rename   {username, password}  -> {username}
//   POST /api/recover  {username, recovery_code, new_password} -> {token, username, recovery_code, save}
//   POST /api/delete   {password}
//   GET  /api/player?u=NAME                  -> public card {username, level, created}
const crypto = require("crypto");
const { makeStore } = require("./store");

const store = makeStore();
const SESSION_DAYS = 120;
const RENAME_COOLDOWN_DAYS = 7;
const MAX_SAVE = 96 * 1024;
const RESERVED = new Set(["admin", "administrator", "mod", "moderator", "support", "staff", "system", "server", "official",
  "thunderalley", "developer", "dev", "null", "undefined", "guest", "operator", "anonymous", "player", "host", "bot", "everyone", "root"]);
const BLOCKED = ["fuck", "shit", "cunt", "nigg", "fag", "bitch", "whore", "rape", "nazi", "hitler", "porn", "pussy", "slut", "retard", "cock", "dick"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ------------------------------------------------------------- helpers
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k.toString("hex")))));
}
async function hashSecret(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: await scrypt(pw, salt) };
}
async function checkSecret(pw, rec) {
  if (!rec || !rec.salt) return false;
  const h = Buffer.from(await scrypt(String(pw), rec.salt), "hex");
  const want = Buffer.from(rec.hash, "hex");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
function recoveryCode() {
  const b = crypto.randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length] + (i % 4 === 3 && i < 15 ? "-" : "");
  return s;
}
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function nameProblem(n) {
  n = String(n || "");
  if (n.length < 3) return "Use at least 3 characters";
  if (n.length > 16) return "Use at most 16 characters";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(n)) return "Start with a letter; use letters, numbers and _ only";
  const low = n.toLowerCase();
  if (RESERVED.has(low)) return "That name is reserved";
  const flat = low.replace(/_/g, "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s");
  if (BLOCKED.some((w) => flat.includes(w))) return "Pick a different name";
  return "";
}
function pwProblem(p) {
  p = String(p || "");
  if (p.length < 6) return "Password needs at least 6 characters";
  if (p.length > 128) return "Password is too long";
  return "";
}

// simple in-memory rate limits (per IP and per account)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60000).unref();

async function getUser(uid) {
  const s = uid ? await store.get("user:" + uid) : null;
  return s ? JSON.parse(s) : null;
}
const putUser = (u) => store.set("user:" + u.uid, JSON.stringify(u));
async function uidForName(name) {
  return await store.get("name:" + String(name || "").toLowerCase());
}
async function getSave(uid) {
  const s = await store.get("save:" + uid);
  return s ? JSON.parse(s) : null;
}
async function newSession(u) {
  const token = crypto.randomBytes(32).toString("base64url");
  const h = sha(token);
  await store.set("sess:" + h, u.uid, { ex: SESSION_DAYS * 86400 });
  u.sessions = (u.sessions || []).concat(h).slice(-12);
  await putUser(u);
  return token;
}
async function dropSessions(u, keep = "") {
  for (const h of u.sessions || []) if (h !== keep) await store.del("sess:" + h);
  u.sessions = keep ? [keep] : [];
}

/** Resolve a session token to its account (used by the relay to verify names). */
async function verifySession(token) {
  if (!token) return null;
  const uid = await store.get("sess:" + sha(String(token)));
  if (!uid) return null;
  const u = await getUser(uid);
  return u ? { uid: u.uid, name: u.name, sessionHash: sha(String(token)) } : null;
}

// ------------------------------------------------------------- http
class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_SAVE + 16384) { rej(new ApiError(413, "Too much data")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return res({});
      try { res(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { rej(new ApiError(400, "Bad request")); }
    });
    req.on("error", rej);
  });
}
async function authed(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const s = m ? await verifySession(m[1]) : null;
  if (!s) throw new ApiError(401, "Please sign in again");
  const u = await getUser(s.uid);
  if (!u) throw new ApiError(401, "Please sign in again");
  return { u, sessionHash: s.sessionHash };
}
function ip(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

const routes = {
  "GET /api/status": async () => ({ ok: true, storage: store.kind, persistent: store.persistent }),

  "GET /api/name": async (req, q) => {
    const n = q.get("u") || "";
    const why = nameProblem(n);
    if (why) return { available: false, reason: why };
    return (await uidForName(n)) ? { available: false, reason: "Already taken" } : { available: true, reason: "" };
  },

  "GET /api/player": async (req, q) => {
    const uid = await uidForName(q.get("u") || "");
    const u = uid ? await getUser(uid) : null;
    if (!u) throw new ApiError(404, "No such player");
    return { username: u.name, level: u.level || 1, created: u.created };
  },

  "POST /api/register": async (req, q, b) => {
    if (limited("reg:" + ip(req), 8, 3600e3)) throw new ApiError(429, "Too many new accounts from this network. Try again later.");
    const name = String(b.username || "").trim();
    const why = nameProblem(name) || pwProblem(b.password);
    if (why) throw new ApiError(400, why);
    const uid = crypto.randomBytes(9).toString("base64url");
    // claiming the name is atomic: two phones racing for one name, only one wins
    if (!(await store.set("name:" + name.toLowerCase(), uid, { nx: true }))) throw new ApiError(409, "That username is taken");
    const code = recoveryCode();
    const u = { uid, name, created: Date.now(), pw: await hashSecret(String(b.password)), rec: await hashSecret(normCode(code)), sessions: [], renamed: 0, level: 1 };
    await putUser(u);
    const token = await newSession(u);
    console.log(`[accounts] new account ${name}`);
    return { token, username: name, created: u.created, recovery_code: code, save: null };
  },

  "POST /api/login": async (req, q, b) => {
    const name = String(b.username || "").trim();
    if (limited("ip:" + ip(req), 30, 600e3) || limited("acct:" + name.toLowerCase(), 10, 900e3))
      throw new ApiError(429, "Too many tries. Wait a few minutes and try again.");
    const u = await getUser(await uidForName(name));
    if (!u || !(await checkSecret(String(b.password || ""), u.pw))) throw new ApiError(401, "Wrong username or password");
    const token = await newSession(u);
    return { token, username: u.name, created: u.created, save: await getSave(u.uid) };
  },

  "GET /api/me": async (req) => {
    const { u } = await authed(req);
    return { username: u.name, created: u.created, renamed: u.renamed || 0, save: await getSave(u.uid) };
  },

  "POST /api/logout": async (req) => {
    const { u, sessionHash } = await authed(req);
    await store.del("sess:" + sessionHash);
    u.sessions = (u.sessions || []).filter((h) => h !== sessionHash);
    await putUser(u);
    return { ok: true };
  },

  "POST /api/save": async (req, q, b) => {
    const { u } = await authed(req);
    const body = JSON.stringify(b.data || {});
    if (body.length > MAX_SAVE) throw new ApiError(413, "Save is too big");
    const cur = await getSave(u.uid);
    if (cur && !b.force && Number(b.base || 0) < Number(cur.t)) {
      // another phone saved since this one last synced: let the player choose
      throw Object.assign(new ApiError(409, "Your cloud save changed on another phone"), { extra: { save: cur } });
    }
    const t = Date.now();
    await store.set("save:" + u.uid, JSON.stringify({ t, data: b.data || {} }));
    const lv = parseInt(b.level, 10);
    if (lv > 0 && lv !== u.level) { u.level = lv; await putUser(u); }
    return { t };
  },

  "POST /api/password": async (req, q, b) => {
    const { u, sessionHash } = await authed(req);
    if (limited("acct:" + u.name.toLowerCase(), 10, 900e3)) throw new ApiError(429, "Too many tries. Wait a few minutes.");
    if (!(await checkSecret(String(b.old || ""), u.pw))) throw new ApiError(401, "Current password is wrong");
    const why = pwProblem(b.new);
    if (why) throw new ApiError(400, why);
    u.pw = await hashSecret(String(b.new));
    await dropSessions(u);   // sign out every phone, then hand this one a fresh session
    const token = await newSession(u);
    void sessionHash;
    return { token };
  },

  "POST /api/rename": async (req, q, b) => {
    const { u } = await authed(req);
    if (!(await checkSecret(String(b.password || ""), u.pw))) throw new ApiError(401, "Password is wrong");
    const name = String(b.username || "").trim();
    const why = nameProblem(name);
    if (why) throw new ApiError(400, why);
    const wait = (u.renamed || 0) + RENAME_COOLDOWN_DAYS * 86400e3 - Date.now();
    const sameName = name.toLowerCase() === u.name.toLowerCase();
    if (wait > 0 && !sameName) throw new ApiError(429, `You can change your username again in ${Math.ceil(wait / 86400e3)} day(s)`);
    if (!sameName) {
      if (!(await store.set("name:" + name.toLowerCase(), u.uid, { nx: true }))) throw new ApiError(409, "That username is taken");
      await store.del("name:" + u.name.toLowerCase());
      u.renamed = Date.now();
    }
    u.name = name;   // a capitalisation-only change is always allowed
    await putUser(u);
    return { username: name };
  },

  "POST /api/recover": async (req, q, b) => {
    const name = String(b.username || "").trim();
    if (limited("ip:" + ip(req), 30, 600e3) || limited("rec:" + name.toLowerCase(), 6, 3600e3))
      throw new ApiError(429, "Too many tries. Try again in an hour.");
    const u = await getUser(await uidForName(name));
    if (!u || !(await checkSecret(normCode(b.recovery_code), u.rec))) throw new ApiError(401, "Username or recovery code is wrong");
    const why = pwProblem(b.new_password);
    if (why) throw new ApiError(400, why);
    u.pw = await hashSecret(String(b.new_password));
    const code = recoveryCode();   // each recovery code works once
    u.rec = await hashSecret(normCode(code));
    await dropSessions(u);
    const token = await newSession(u);
    return { token, username: u.name, created: u.created, recovery_code: code, save: await getSave(u.uid) };
  },

  "POST /api/delete": async (req, q, b) => {
    const { u } = await authed(req);
    if (!(await checkSecret(String(b.password || ""), u.pw))) throw new ApiError(401, "Password is wrong");
    await dropSessions(u);
    await store.del("name:" + u.name.toLowerCase());
    await store.del("save:" + u.uid);
    await store.del("user:" + u.uid);
    console.log(`[accounts] deleted ${u.name}`);
    return { ok: true };
  },
};

/** Handles /api/* requests. Returns false for anything else. */
function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api/")) return false;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  const fn = routes[`${req.method} ${url.pathname.replace(/\/+$/, "")}`];
  const reply = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (!fn) { reply(404, { error: "Not found" }); return true; }
  (async () => {
    const body = req.method === "POST" ? await readBody(req) : {};
    reply(200, await fn(req, url.searchParams, body || {}));
  })().catch((e) => {
    if (e instanceof ApiError) reply(e.status, { error: e.message, ...(e.extra || {}) });
    else { console.error("[accounts]", e); reply(500, { error: "Server problem, try again" }); }
  });
  return true;
}

module.exports = { handle, verifySession, store };
