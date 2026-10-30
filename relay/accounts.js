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
//   POST /api/bug      {cat, text, ver, device, log, mode, map, shot} -> {id}
//        In-game bug report; shot is an optional base64 JPEG screenshot.
//   GET  /api/bugs?key=ADMIN_KEY             -> {bugs: [...]}  newest first
//   GET  /api/bugs/view?key=ADMIN_KEY        -> HTML page with every report and screenshot
//   GET  /api/bugs/img?id=ID&key=ADMIN_KEY   -> the screenshot (image/jpeg)
//   Bug admin routes are off unless the ADMIN_KEY environment variable is
//   set. With GITHUB_TOKEN + GITHUB_REPO ("owner/repo") set, each report also
//   opens a GitHub issue.
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
function readBody(req, limit = MAX_SAVE + 16384) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { rej(new ApiError(413, "Too much data")); req.destroy(); return; }
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

// ------------------------------------------------------------- bug reports
const BUG_CATS = new Set(["gameplay", "graphics", "crash", "multiplayer", "maps", "menus", "performance", "other"]);
const BUG_DAYS = 90;
const MAX_SHOT = 700 * 1024;          // base64 characters
const BUG_INDEX_MAX = 500;
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

function adminOk(req, q) {
  const key = require("./store").env("ADMIN_KEY");
  if (!key) throw new ApiError(404, "Not found");
  const given = String(req.headers["x-admin-key"] || q.get("key") || "");
  const a = Buffer.from(sha(given)), b = Buffer.from(sha(key));
  if (!crypto.timingSafeEqual(a, b)) throw new ApiError(403, "Wrong key");
}
async function bugIndex() {
  const s = await store.get("bugs:index");
  try { return s ? JSON.parse(s) : []; } catch { return []; }
}
async function openIssue(req, bug) {
  const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!tok || !repo) return "";
  const base = process.env.PUBLIC_URL || ("https://" + (req.headers.host || ""));
  const body = [`**${bug.cat}** · v${bug.ver} · ${bug.mode || "-"} ${bug.map || ""} · ${bug.user || "guest"}`, "", bug.text, "",
    "```", bug.device, "```", bug.shot ? `Screenshot: ${base}/api/bugs/img?id=${bug.id} (needs the admin key)` : "",
    "<details><summary>Log</summary>\n\n```\n" + bug.log + "\n```\n</details>"].join("\n");
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "thunderalley-relay" },
      body: JSON.stringify({ title: `[${bug.cat}] ${bug.text.split("\n")[0].slice(0, 80)}`, body, labels: ["bug", "in-game report"] }),
    });
    const j = await r.json().catch(() => ({}));
    return j.html_url || "";
  } catch (e) {
    console.error("[bugs] github", e.message);
    return "";
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const routes = {
  "POST /api/bug": async (req, q, b) => {
    if (limited("bug:" + ip(req), 6, 3600e3)) throw new ApiError(429, "Too many reports from this network. Try again in an hour.");
    const text = clip(b.text, 2000).trim();
    if (text.length < 4) throw new ApiError(400, "Describe the problem first");
    let shot = typeof b.shot === "string" ? b.shot : "";
    if (shot && (shot.length > MAX_SHOT || !shot.startsWith("/9j/"))) shot = "";   // JPEG only
    let user = "";
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (m) { const s = await verifySession(m[1]); if (s) user = s.name; }
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const bug = {
      id, t: Date.now(), cat: BUG_CATS.has(String(b.cat)) ? String(b.cat) : "other", text, user,
      ver: clip(b.ver, 20), device: clip(b.device, 400), mode: clip(b.mode, 30), map: clip(b.map, 40),
      log: clip(b.log, 12000), shot: !!shot,
    };
    await store.set("bug:" + id, JSON.stringify(bug), { ex: BUG_DAYS * 86400 });
    if (shot) await store.set("bugimg:" + id, shot, { ex: BUG_DAYS * 86400 });
    const idx = await bugIndex();
    idx.unshift(id);
    await store.set("bugs:index", JSON.stringify(idx.slice(0, BUG_INDEX_MAX)));
    const issue = await openIssue(req, bug);
    if (issue) { bug.issue = issue; await store.set("bug:" + id, JSON.stringify(bug), { ex: BUG_DAYS * 86400 }); }
    console.log(`[bugs] ${id} ${bug.cat} v${bug.ver} ${shot ? "with" : "no"} screenshot ${issue}`);
    return { id };
  },
  "GET /api/bugs": async (req, q) => {
    adminOk(req, q);
    const out = [];
    for (const id of (await bugIndex()).slice(0, Math.min(200, Number(q.get("n")) || 100))) {
      const s = await store.get("bug:" + id);
      if (s) out.push(JSON.parse(s));
    }
    return { bugs: out };
  },
  "GET /api/status": async () => {
    // also prove the database answers, so a bad Render setting shows up here
    let storage_ok = true, storage_error = "";
    try { await store.get("health:ping"); } catch (e) { storage_ok = false; storage_error = String(e.message || e).slice(0, 120); }
    return { ok: true, storage: store.kind, persistent: store.persistent, storage_ok, storage_error };
  },

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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, User-Agent");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
  if (route === "GET /api/bugs/img" || route === "GET /api/bugs/view") {
    bugPages(req, res, route, url.searchParams).catch((e) => {
      res.writeHead(e instanceof ApiError ? e.status : 500, { "Content-Type": "text/plain" });
      res.end(e instanceof ApiError ? e.message : "Server problem");
    });
    return true;
  }
  const fn = routes[route];
  const reply = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (!fn) { reply(404, { error: "Not found" }); return true; }
  (async () => {
    const body = req.method === "POST" ? await readBody(req, route === "POST /api/bug" ? MAX_SHOT + 32768 : undefined) : {};
    reply(200, await fn(req, url.searchParams, body || {}));
  })().catch((e) => {
    if (e instanceof ApiError) reply(e.status, { error: e.message, ...(e.extra || {}) });
    else { console.error("[accounts]", e); reply(500, { error: "Server problem, try again" }); }
  });
  return true;
}

/** Admin-only screenshot and HTML list of bug reports. */
async function bugPages(req, res, route, q) {
  adminOk(req, q);
  if (route === "GET /api/bugs/img") {
    const b64 = await store.get("bugimg:" + String(q.get("id") || ""));
    if (!b64) throw new ApiError(404, "No screenshot");
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
    res.end(Buffer.from(b64, "base64"));
    return;
  }
  const key = encodeURIComponent(String(q.get("key") || ""));
  let html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ThunderAlley bug reports</title>
<style>body{font:14px system-ui,sans-serif;background:#111;color:#ddd;margin:16px}article{border:1px solid #333;padding:12px;margin:0 0 14px;border-radius:6px}
h2{margin:0 0 4px;font-size:16px;color:#fc6}img{max-width:100%;border:1px solid #444;margin-top:8px}pre{white-space:pre-wrap;background:#000;padding:8px;max-height:220px;overflow:auto;font-size:11px}
.m{color:#999;font-size:12px}a{color:#8cf}</style><h1>Bug reports</h1>`;
  for (const id of (await bugIndex()).slice(0, 100)) {
    const s = await store.get("bug:" + id);
    if (!s) continue;
    const b = JSON.parse(s);
    html += `<article><h2>[${esc(b.cat)}] ${esc(b.text.split("\n")[0].slice(0, 90))}</h2>
<div class="m">${new Date(b.t).toISOString()} · v${esc(b.ver)} · ${esc(b.mode)} ${esc(b.map)} · ${esc(b.user || "guest")} · ${esc(b.id)}${b.issue ? ` · <a href="${esc(b.issue)}">issue</a>` : ""}</div>
<p>${esc(b.text).replace(/\n/g, "<br>")}</p><div class="m">${esc(b.device)}</div>
${b.shot ? `<img loading="lazy" src="/api/bugs/img?id=${esc(b.id)}&key=${key}">` : ""}
<details><summary>Log</summary><pre>${esc(b.log)}</pre></details></article>`;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

module.exports = { handle, verifySession, store, authed, ApiError, readBody, limited, ip, adminOk, getUser };
