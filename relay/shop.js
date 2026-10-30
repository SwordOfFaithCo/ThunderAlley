// ThunderAlley shop: Premium (one-time), the Season Pass, pass progress and
// pass tokens, with payments through Stripe (your own server) or Google Play.
//
// Everything a player owns is kept on the server, per account, so it follows
// them to any phone and can't be unlocked by editing a save file.
//
// Rules
//   * Premium: bought once, kept forever.
//   * Season Pass: bought per season. Its premium track pays out pass tokens
//     at set tiers (seasons.json "token_tiers"). Tiers already reached when the
//     pass is bought pay out straight away.
//   * Tokens are earned by playing, never sold. 1 token = 1 cent off a future
//     Season Pass, spent in steps of 100 (so the Google Play price points stay
//     few). The rest is paid in cash. Unspent tokens expire 30 days after the
//     season that paid them ends (seasons.json "expire_days_after_season").
//   * Pass XP comes from finished matches (POST /api/shop/xp), with caps per
//     match and per day.
//
// HTTP API (signed-in calls send "Authorization: Bearer <token>")
//   GET  /api/shop/catalog                 -> prices, seasons, which payment methods are on
//   GET  /api/shop/me                      -> what this account owns, pass XP, tokens, quotes
//   POST /api/shop/xp      {season, xp}    -> me
//   POST /api/shop/redeem  {product}       -> me     (when tokens cover the whole price)
//   POST /api/shop/checkout {product}      -> {url}  (Stripe Checkout page to open in a browser)
//   POST /api/shop/stripe                  <- Stripe webhook (checkout.session.completed)
//   POST /api/shop/play {product, product_id, purchase_token} -> me  (verifies a Google Play purchase)
//   GET  /shop/done                        -> "payment received" page Stripe sends the buyer back to
//   POST /api/shop/admin {action, user, ...}  (needs ADMIN_KEY) grant/revoke/add tokens, look up
// Products: "premium" or "pass:<season id>".
//
// Settings (environment variables)
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   turn on Stripe
//   GOOGLE_PLAY_PACKAGE                        e.g. com.swordoffaith.thunderalley
//   GOOGLE_PLAY_SERVICE_ACCOUNT                the service account JSON key (whole file) for the Play Developer API
//   PUBLIC_URL                                 https://thunderalley-relay.onrender.com (for Stripe's return page)
//   SEASONS_FILE                               optional path to another seasons.json
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const A = require("./accounts");
const { env } = require("./store");
const { store, ApiError } = A;

const DAY = 86400e3;
const MAX_XP_PER_REPORT = 15000;    // one long match with the Premium boost
const MAX_XP_PER_DAY = 150000;      // about 40 matches

// ------------------------------------------------------------- catalog
let _cfg = null, _cfgT = 0;
function cfg() {
  const file = env("SEASONS_FILE") || path.join(__dirname, "seasons.json");
  let t = 0;
  try { t = fs.statSync(file).mtimeMs; } catch { t = 0; }
  if (!_cfg || t !== _cfgT) {
    _cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    _cfgT = t;
    for (const s of _cfg.seasons) { s.t0 = Date.parse(s.start); s.t1 = Date.parse(s.end); }
  }
  return _cfg;
}
const season = (id) => cfg().seasons.find((s) => s.id === id) || null;
function currentSeason(now = Date.now()) {
  return cfg().seasons.find((s) => s.t0 <= now && now < s.t1) || null;
}
function nextSeason(now = Date.now()) {
  return cfg().seasons.filter((s) => s.t0 > now).sort((a, b) => a.t0 - b.t0)[0] || null;
}
const tokenExpiry = (s) => s.t1 + cfg().token_rules.expire_days_after_season * DAY;
const tierFor = (s, xp) => Math.min(s.tiers, Math.floor(Math.max(0, xp) / s.xp_per_tier));
const stripeOn = () => !!(env("STRIPE_SECRET_KEY") && env("STRIPE_WEBHOOK_SECRET"));
const playOn = () => !!(env("GOOGLE_PLAY_PACKAGE") && env("GOOGLE_PLAY_SERVICE_ACCOUNT"));

/** Google Play product id for a Season Pass at a given cash price: one
 *  consumable product per price point, shared by every season. */
const passPlayId = (cents) => "season_pass_" + cents;

// ------------------------------------------------------------- wallet
async function getWallet(uid) {
  const s = await store.get("shop:" + uid);
  const w = s ? JSON.parse(s) : {};
  w.passes = w.passes || {};
  w.xp = w.xp || {};
  w.paid_tiers = w.paid_tiers || {};
  w.tokens = w.tokens || [];
  w.orders = w.orders || [];
  w.day = w.day || { d: "", n: 0 };
  return w;
}
const putWallet = (uid, w) => store.set("shop:" + uid, JSON.stringify(w));

// one change at a time per account (single server process)
const locks = new Map();
async function withWallet(uid, fn) {
  const prev = locks.get(uid) || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  locks.set(uid, prev.then(() => mine));
  await prev;
  try {
    const w = await getWallet(uid);
    const out = await fn(w);
    await putWallet(uid, w);
    return out;
  } finally {
    release();
    if (locks.get(uid) === mine) locks.delete(uid);
  }
}

function liveTokens(w, now = Date.now()) {
  return w.tokens.filter((t) => t.n > 0 && t.exp > now);
}
const balance = (w, now = Date.now()) => liveTokens(w, now).reduce((a, t) => a + t.n, 0);

/** Spend n tokens, the ones that expire first going first. */
function spendTokens(w, n, now = Date.now()) {
  const live = liveTokens(w, now).sort((a, b) => a.exp - b.exp);
  let left = n;
  for (const t of live) {
    const k = Math.min(t.n, left);
    t.n -= k;
    left -= k;
    if (!left) break;
  }
  w.tokens = w.tokens.filter((t) => t.n > 0 && t.exp > now - 365 * DAY);
  return n - left;
}

/** Pay out the premium-track token tiers this account has reached. */
function creditTokenTiers(w, s) {
  if (!w.passes[s.id]) return 0;
  const tier = tierFor(s, w.xp[s.id] || 0);
  const paid = new Set(w.paid_tiers[s.id] || []);
  let got = 0;
  for (const [k, n] of Object.entries(s.token_tiers || {})) {
    const t = parseInt(k, 10);
    if (t <= tier && !paid.has(t)) {
      paid.add(t);
      w.tokens.push({ n, season: s.id, tier: t, exp: tokenExpiry(s) });
      got += n;
    }
  }
  w.paid_tiers[s.id] = [...paid].sort((a, b) => a - b);
  return got;
}

/** Price of a product for this account right now: cash part, tokens used,
 *  and the Google Play product id for that cash price. */
function quote(w, product, now = Date.now()) {
  const c = cfg();
  if (product === "premium") {
    if (w.premium) return { product, owned: true };
    return { product, name: c.premium.name, full_cents: c.premium.price_cents, cents: c.premium.price_cents, tokens: 0, play_id: c.premium.play_id, currency: c.premium.currency };
  }
  const m = /^pass:([a-z0-9_-]+)$/.exec(String(product || ""));
  const s = m ? season(m[1]) : null;
  if (!s) throw new ApiError(400, "Unknown product");
  if (w.passes[s.id]) return { product, owned: true };
  if (!(s.t0 <= now && now < s.t1)) return { product, name: s.name, on_sale: false };
  const r = c.token_rules;
  const step = r.spend_step;
  const fullTok = Math.floor(s.price_cents / r.cents_per_token);
  let use = Math.min(Math.floor(balance(w, now) / step) * step, Math.ceil(fullTok / step) * step);
  let cents = Math.max(0, s.price_cents - use * r.cents_per_token);
  // card payments under 50 cents aren't possible: keep at least 50 cents to pay, or make it free
  while (cents > 0 && cents < 50 && use >= step) { use -= step; cents = s.price_cents - use * r.cents_per_token; }
  use = Math.min(use, fullTok);
  return { product, name: s.name + " Pass", full_cents: s.price_cents, cents, tokens: use, play_id: cents > 0 ? passPlayId(cents) : "", currency: c.premium.currency, on_sale: true };
}

/** Give the product, spend the tokens, log the order. */
function grant(w, product, via, order, paidCents, tokens, now = Date.now()) {
  if (product === "premium") {
    w.premium = true;
    w.premium_at = now;
  } else {
    const s = season(product.slice(5));
    if (!s) throw new ApiError(400, "Unknown product");
    w.passes[s.id] = { at: now, via };
    tokens = spendTokens(w, tokens, now);
    creditTokenTiers(w, s);
  }
  w.orders.push({ id: order, product, via, cents: paidCents, tokens, t: now });
  w.orders = w.orders.slice(-50);
  console.log(`[shop] ${product} via ${via} order=${order} paid=${paidCents} tokens=${tokens}`);
}

function view(w, now = Date.now()) {
  const c = cfg();
  const cur = currentSeason(now), nxt = nextSeason(now);
  const seasons = {};
  for (const s of c.seasons) {
    if (s.t1 + 120 * DAY < now) continue;
    const xp = w.xp[s.id] || 0;
    seasons[s.id] = { id: s.id, name: s.name, start: s.t0, end: s.t1, tiers: s.tiers, xp_per_tier: s.xp_per_tier, xp, tier: tierFor(s, xp),
      owned: !!w.passes[s.id], token_tiers: s.token_tiers, paid_tiers: w.paid_tiers[s.id] || [], price_cents: s.price_cents };
  }
  const tokens = liveTokens(w, now).sort((a, b) => a.exp - b.exp).map((t) => ({ n: t.n, season: t.season, exp: t.exp }));
  return {
    now, premium: !!w.premium, seasons, current: cur ? cur.id : "", next: nxt ? { id: nxt.id, name: nxt.name, start: nxt.t0 } : null,
    tokens: balance(w, now), token_lots: tokens, next_expiry: tokens.length ? tokens[0].exp : 0,
    quotes: { premium: quote(w, "premium", now), pass: cur ? quote(w, "pass:" + cur.id, now) : null },
    pay: { stripe: stripeOn(), play: playOn() },
  };
}

/** fetch, but a network failure becomes a clear 502 for the player. */
async function fetchOr(url, opt) {
  try { return await fetch(url, opt); } catch (e) {
    console.error("[shop] can't reach", new URL(url).host, e.cause ? e.cause.code || e.cause.message : e.message);
    throw new ApiError(502, "The payment service can't be reached. Try again in a minute.");
  }
}

// ------------------------------------------------------------- Stripe
async function stripe(pathname, form) {
  const body = new URLSearchParams(form).toString();
  const r = await fetchOr("https://api.stripe.com/v1" + pathname, {
    method: "POST",
    headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY"), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(502, "Payment service: " + ((j.error && j.error.message) || r.status));
  return j;
}

/** Check a Stripe webhook's signature (Stripe-Signature: t=...,v1=...). */
function stripeSigOk(raw, header, secret, now = Date.now()) {
  const parts = {};
  for (const kv of String(header || "").split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) (parts[kv.slice(0, i).trim()] = parts[kv.slice(0, i).trim()] || []).push(kv.slice(i + 1).trim());
  }
  const t = parseInt((parts.t || [])[0], 10);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const want = crypto.createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  return (parts.v1 || []).some((v) => v.length === want.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)));
}

// ------------------------------------------------------------- Google Play
let _gtok = { t: "", exp: 0 };
async function googleToken() {
  if (_gtok.exp > Date.now() + 60e3) return _gtok.t;
  const sa = JSON.parse(env("GOOGLE_PLAY_SERVICE_ACCOUNT").replace(/^'|'$/g, ""));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r = await fetchOr("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new ApiError(502, "Google Play sign-in failed");
  _gtok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _gtok.t;
}
async function play(method, productId, token, action = "") {
  const pkg = env("GOOGLE_PLAY_PACKAGE");
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}${action}`;
  const r = await fetchOr(url, { method, headers: { Authorization: "Bearer " + (await googleToken()), "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status === 404 || r.status === 400 ? 400 : 502, "Google Play: " + ((j.error && j.error.message) || r.status));
  return j;
}

// ------------------------------------------------------------- routes
const routes = {
  "GET /api/shop/catalog": async () => {
    const c = cfg(), now = Date.now();
    return { premium: c.premium, token_rules: c.token_rules,
      seasons: c.seasons.filter((s) => s.t1 + 120 * DAY > now).map((s) => ({ id: s.id, name: s.name, start: s.t0, end: s.t1, tiers: s.tiers, xp_per_tier: s.xp_per_tier, price_cents: s.price_cents, token_tiers: s.token_tiers })),
      current: (currentSeason(now) || {}).id || "", pay: { stripe: stripeOn(), play: playOn() } };
  },

  "GET /api/shop/me": async (req) => {
    const { u } = await A.authed(req);
    return view(await getWallet(u.uid));
  },

  "POST /api/shop/xp": async (req, q, b) => {
    const { u } = await A.authed(req);
    if (A.limited("xp:" + u.uid, 40, 3600e3)) throw new ApiError(429, "Slow down");
    const s = season(String(b.season || ""));
    const now = Date.now();
    if (!s || now < s.t0 || now > s.t1 + 3600e3) throw new ApiError(400, "That season isn't running");
    let xp = Math.max(0, Math.min(MAX_XP_PER_REPORT, parseInt(b.xp, 10) || 0));
    return withWallet(u.uid, (w) => {
      const d = new Date(now).toISOString().slice(0, 10);
      if (w.day.d !== d) w.day = { d, n: 0 };
      xp = Math.min(xp, Math.max(0, MAX_XP_PER_DAY - w.day.n));
      w.day.n += xp;
      w.xp[s.id] = Math.min((w.xp[s.id] || 0) + xp, s.tiers * s.xp_per_tier);
      creditTokenTiers(w, s);
      return view(w, now);
    });
  },

  "POST /api/shop/redeem": async (req, q, b) => {
    const { u } = await A.authed(req);
    const product = String(b.product || "");
    return withWallet(u.uid, (w) => {
      const qt = quote(w, product);
      if (qt.owned) throw new ApiError(409, "You already have this");
      if (!qt.on_sale && product !== "premium") throw new ApiError(400, "This pass isn't on sale right now");
      if (qt.cents > 0) throw new ApiError(402, "Not enough tokens to cover the whole price");
      grant(w, product, "tokens", "tok-" + Date.now().toString(36), 0, qt.tokens);
      return view(w);
    });
  },

  "POST /api/shop/checkout": async (req, q, b) => {
    const { u } = await A.authed(req);
    if (!stripeOn()) throw new ApiError(503, "Card payments aren't set up yet");
    if (A.limited("co:" + u.uid, 10, 3600e3)) throw new ApiError(429, "Too many tries. Wait a little.");
    const product = String(b.product || "");
    const w = await getWallet(u.uid);
    const qt = quote(w, product);
    if (qt.owned) throw new ApiError(409, "You already have this");
    if (qt.on_sale === false) throw new ApiError(400, "This pass isn't on sale right now");
    if (qt.cents <= 0) throw new ApiError(400, "Your tokens cover it: use REDEEM");
    const base = env("PUBLIC_URL") || ("https://" + (req.headers.host || ""));
    const desc = qt.tokens ? `${qt.tokens} pass tokens applied (full price $${(qt.full_cents / 100).toFixed(2)})` : "";
    const sess = await stripe("/checkout/sessions", {
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": qt.currency,
      "line_items[0][price_data][unit_amount]": String(qt.cents),
      "line_items[0][price_data][product_data][name]": qt.name,
      ...(desc ? { "line_items[0][price_data][product_data][description]": desc } : {}),
      client_reference_id: u.uid,
      "metadata[uid]": u.uid,
      "metadata[user]": u.name,
      "metadata[product]": product,
      "metadata[tokens]": String(qt.tokens),
      "payment_intent_data[metadata][uid]": u.uid,
      "payment_intent_data[metadata][product]": product,
      success_url: base + "/shop/done?ok=1",
      cancel_url: base + "/shop/done?ok=0",
    });
    return { url: sess.url, id: sess.id, cents: qt.cents, tokens: qt.tokens };
  },

  "POST /api/shop/play": async (req, q, b) => {
    const { u } = await A.authed(req);
    if (!playOn()) throw new ApiError(503, "Google Play purchases aren't set up on the server yet");
    const product = String(b.product || ""), pid = String(b.product_id || ""), tok = String(b.purchase_token || "");
    if (!pid || !tok) throw new ApiError(400, "Missing purchase");
    const key = "playtok:" + crypto.createHash("sha256").update(tok).digest("hex");
    const done = await store.get(key);
    if (done) {
      if (done !== u.uid) throw new ApiError(409, "That purchase belongs to another account");
      return { ...view(await getWallet(u.uid)), consume: pid.startsWith("season_pass_") };
    }
    const p = await play("GET", pid, tok);
    if (p.purchaseState !== 0) throw new ApiError(402, p.purchaseState === 2 ? "Payment still pending" : "Purchase was cancelled");
    return withWallet(u.uid, async (w) => {
      const c = cfg();
      let paid = 0, tokens = 0;
      if (product === "premium") {
        if (pid !== c.premium.play_id) throw new ApiError(400, "Wrong product");
        paid = c.premium.price_cents;
      } else {
        const s = season(product.slice(5));
        const m = /^season_pass_(\d+)$/.exec(pid);
        if (!s || !m || !product.startsWith("pass:")) throw new ApiError(400, "Wrong product");
        if (!(s.t0 <= Date.now() && Date.now() < s.t1 + 3600e3)) throw new ApiError(400, "This pass isn't on sale right now. You won't be charged.");
        if (w.passes[s.id]) throw new ApiError(409, "You already have this pass");
        paid = parseInt(m[1], 10);
        tokens = Math.max(0, Math.ceil((s.price_cents - paid) / c.token_rules.cents_per_token));
        // the cash price only counts when the tokens to cover the rest are still there;
        // otherwise the purchase isn't acknowledged and Google refunds it in 3 days
        if (tokens > balance(w)) throw new ApiError(402, "Not enough tokens left for that price. You won't be charged.");
      }
      if (!(await store.set(key, u.uid, { nx: true }))) throw new ApiError(409, "Already used");
      grant(w, product, "play", p.orderId || pid, paid, tokens);
      // premium is kept (acknowledge); a pass price point is bought again next season (consume)
      try { await play("POST", pid, tok, product === "premium" ? ":acknowledge" : ":consume"); } catch (e) { console.error("[shop] play ack", e.message); }
      return { ...view(w), consume: false };
    });
  },

  "POST /api/shop/admin": async (req, q, b) => {
    A.adminOk(req, q);
    const name = String(b.user || "");
    const uid = await store.get("name:" + name.toLowerCase());
    if (!uid) throw new ApiError(404, "No such player");
    return withWallet(uid, (w) => {
      const s = season(String(b.season || ""));
      switch (String(b.action || "")) {
        case "look": break;
        case "grant_premium": grant(w, "premium", "admin", "admin-" + Date.now(), 0, 0); break;
        case "revoke_premium": w.premium = false; break;
        case "grant_pass": if (!s) throw new ApiError(400, "season?"); grant(w, "pass:" + s.id, "admin", "admin-" + Date.now(), 0, 0); break;
        case "revoke_pass": if (!s) throw new ApiError(400, "season?"); delete w.passes[s.id]; break;
        case "add_tokens": {
          const n = parseInt(b.n, 10) || 0;
          const src = s || currentSeason();
          if (!src) throw new ApiError(400, "season?");
          w.tokens.push({ n, season: src.id, tier: 0, exp: tokenExpiry(src) });
          break;
        }
        case "set_xp": if (!s) throw new ApiError(400, "season?"); w.xp[s.id] = Math.max(0, parseInt(b.xp, 10) || 0); creditTokenTiers(w, s); break;
        default: throw new ApiError(400, "Unknown action");
      }
      return { user: name, ...view(w), orders: w.orders };
    });
  },
};

async function stripeWebhook(req, res) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 512 * 1024) break; chunks.push(c); }
  const raw = Buffer.concat(chunks).toString("utf8");
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret || !stripeSigOk(raw, req.headers["stripe-signature"], secret)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad signature");
    return;
  }
  const ev = JSON.parse(raw);
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    const s = ev.data.object;
    if (s.payment_status === "paid" && s.metadata && s.metadata.uid) {
      // each Checkout session pays out once, even if Stripe sends the event again
      if (await store.set("stripe:" + s.id, "1", { nx: true })) {
        await withWallet(s.metadata.uid, (w) => {
          const product = String(s.metadata.product);
          const qt = quote(w, product);
          if (qt.owned) { console.log(`[shop] ${product} already owned, paid order ${s.id} needs a refund`); return; }
          grant(w, product, "stripe", s.id, s.amount_total || 0, parseInt(s.metadata.tokens, 10) || 0);
        });
      }
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"received":true}');
}

function donePage(res, ok) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>ThunderAlley</title>
<body style="background:#11151b;color:#e8edf2;font-family:system-ui,sans-serif;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center;padding:16px">
<div><h1 style="color:${ok ? "#f2b632" : "#e8edf2"}">${ok ? "Payment received" : "Payment cancelled"}</h1>
<p>${ok ? "Thanks! Go back to ThunderAlley. Your purchase shows up in the store within a few seconds." : "Nothing was charged. You can go back to ThunderAlley."}</p></div></body>`);
}

/** Handles /api/shop/* and /shop/done. Returns false for anything else. */
function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "/shop/done") { donePage(res, url.searchParams.get("ok") === "1"); return true; }
  if (!p.startsWith("/api/shop/")) return false;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, User-Agent");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "POST" && p === "/api/shop/stripe") {
    stripeWebhook(req, res).catch((e) => { console.error("[shop] webhook", e); reply(500, { error: "webhook failed" }); });
    return true;
  }
  const fn = routes[`${req.method} ${p}`];
  if (!fn) { reply(404, { error: "Not found" }); return true; }
  (async () => {
    const body = req.method === "POST" ? await A.readBody(req, 64 * 1024) : {};
    reply(200, await fn(req, url.searchParams, body || {}));
  })().catch((e) => {
    if (e instanceof ApiError) reply(e.status, { error: e.message });
    else { console.error("[shop]", e); reply(500, { error: "Server problem, try again" }); }
  });
  return true;
}

module.exports = { handle, _test: { quote, grant, balance, spendTokens, creditTokenTiers, tokenExpiry, stripeSigOk, season, view, getWallet } };
