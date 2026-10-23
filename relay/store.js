// Key/value storage for ThunderAlley accounts.
//
// Two backends, no npm packages needed:
//   * Upstash Redis (free tier) over its REST API, used when
//     UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set. Use this on
//     Render: Render's free disk is wiped whenever the server restarts.
//   * A JSON file (DATA_DIR/accounts.json, default ./data), for a VPS, a
//     Render paid disk, or local testing.
//
// Interface (all async):
//   get(key) -> string | null
//   set(key, value, {nx, ex}) -> true (written) | false (nx and key existed)
//   del(key)
const fs = require("fs");
const path = require("path");

class UpstashStore {
  constructor(url, token) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.kind = "upstash";
    this.persistent = true;
  }
  async cmd(args) {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error("storage: " + (j.error || r.status));
    return j.result;
  }
  async get(k) {
    const v = await this.cmd(["GET", k]);
    return v === undefined ? null : v;
  }
  async set(k, v, opt = {}) {
    const a = ["SET", k, v];
    if (opt.ex) a.push("EX", String(Math.floor(opt.ex)));
    if (opt.nx) a.push("NX");
    return (await this.cmd(a)) === "OK";
  }
  async del(k) {
    await this.cmd(["DEL", k]);
  }
}

class FileStore {
  constructor(dir) {
    this.file = path.join(dir, "accounts.json");
    this.kind = "file";
    this.persistent = !process.env.RENDER || !!process.env.DATA_DIR;
    fs.mkdirSync(dir, { recursive: true });
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.data = {}; }
    this._t = null;
  }
  _live(k) {
    const e = this.data[k];
    if (!e) return null;
    if (e.x && e.x < Date.now()) { delete this.data[k]; return null; }
    return e;
  }
  _flush() {
    if (this._t) return;
    this._t = setTimeout(() => {
      this._t = null;
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    }, 200);
  }
  async get(k) {
    const e = this._live(k);
    return e ? e.v : null;
  }
  async set(k, v, opt = {}) {
    if (opt.nx && this._live(k)) return false;
    this.data[k] = { v, x: opt.ex ? Date.now() + opt.ex * 1000 : 0 };
    this._flush();
    return true;
  }
  async del(k) {
    delete this.data[k];
    this._flush();
  }
}

function makeStore() {
  const u = process.env.UPSTASH_REDIS_REST_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (u && t) return new UpstashStore(u, t);
  return new FileStore(process.env.DATA_DIR || path.join(__dirname, "data"));
}

module.exports = { makeStore };
