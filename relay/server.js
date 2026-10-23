// ThunderAlley relay: phones connect OUT to this server (so it works on any
// Wi-Fi or mobile network, Android or iPhone, no port forwarding). Players
// meet in rooms by code. One member is the match host; the relay forwards
// game packets between the host and the others. If the host disconnects,
// the relay promotes the longest-connected remaining member and everyone
// carries on.
//
// Wire format
//   text frames  = JSON control messages ({op: ...})
//   binary frames client -> relay : int32 LE target member id (0 = everyone else) + payload
//   binary frames relay -> client : int32 LE sender member id + payload
const http = require("http");
const { WebSocketServer } = require("./ws_lite");
const accounts = require("./accounts");

const PORT = parseInt(process.env.PORT || "8080", 10);
const PROTOCOL = 1;
const MAX_ROOM = 16;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();   // code -> room
let nextOrder = 1;

function newCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function newMemberId(room) {
  for (;;) {
    const id = 2 + Math.floor(Math.random() * 2000000000);
    if (!room.members.has(id)) return id;
  }
}
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function roomInfo(room, friendSet) {
  const names = [...room.members.values()].map((m) => m.name);
  return {
    code: room.code, name: room.meta.name || "", title: String(room.meta.title || "").slice(0, 40),
    mode: room.meta.mode || "", map: room.meta.map || "",
    in_match: !!room.meta.in_match, players: room.members.size, max: MAX_ROOM, public: room.public,
    vis: room.meta.vis || (room.public ? "public" : "private"),
    members: names.slice(0, MAX_ROOM),
    friend: !!friendSet && names.some((n) => friendSet.has(String(n).toLowerCase())),
    age: Math.round((Date.now() - (room.created || Date.now())) / 1000),
  };
}
// Rooms a player can see in the browser: public ones, plus "friends only"
// rooms whose host has that player on their friends list.
function visibleRooms(url) {
  const q = new URL(url, "http://x").searchParams;
  const me = String(q.get("me") || "").toLowerCase();
  const friends = new Set(String(q.get("friends") || "").toLowerCase().split(",").filter(Boolean).slice(0, 200));
  const out = [];
  for (const r of rooms.values()) {
    if (r.members.size >= MAX_ROOM) continue;
    const hostFriends = Array.isArray(r.meta.friends) ? r.meta.friends.map((n) => String(n).toLowerCase()) : [];
    const vis = r.meta.vis || (r.public ? "public" : "private");
    const ok = vis === "public" || (vis === "friends" && me && hostFriends.includes(me));
    if (ok) out.push(roomInfo(r, friends));
  }
  out.sort((a, b) => (b.friend - a.friend) || (b.players - a.players));
  return out.slice(0, 100);
}
function memberList(room) {
  return [...room.members.values()].map((m) => ({ pid: m.id, name: m.name, verified: !!m.verified }));
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.members.delete(ws.mid);
  if (room.members.size === 0) {
    rooms.delete(room.code);
    return;
  }
  for (const m of room.members.values()) send(m.ws, { op: "peer_leave", pid: ws.mid });
  if (room.host === ws.mid) {
    // host migration: the member who has been here longest takes over
    let best = null;
    for (const m of room.members.values()) if (!best || m.order < best.order) best = m;
    room.host = best.id;
    room.migrations++;
    for (const m of room.members.values()) send(m.ws, { op: "host", pid: best.id, left: ws.mid });
    console.log(`[relay] room ${room.code}: host ${ws.mid} left, ${best.id} (${best.name}) is the new host`);
  }
}

/** Signed-in players get their account name (with a check mark in game);
 *  guests can't pose as a registered player: a claimed name gets a "*". */
async function resolveName(msg) {
  const acct = msg.token ? await accounts.verifySession(msg.token).catch(() => null) : null;
  if (acct) return { name: acct.name, verified: true };
  let name = String(msg.name || "Player").replace(/[\r\n]/g, "").slice(0, 15) || "Player";
  try {
    if (await accounts.store.get("name:" + name.toLowerCase())) name = name.slice(0, 14) + "*";
  } catch {}
  return { name, verified: false };
}

function join(ws, room, who) {
  const id = newMemberId(room);
  ws.mid = id;
  ws.room = room;
  room.members.set(id, { id, ws, name: who.name, verified: who.verified, order: nextOrder++ });
  if (room.host === 0) room.host = id;
  send(ws, { op: "joined", room: room.code, pid: id, host: room.host, members: memberList(room), proto: PROTOCOL });
  for (const m of room.members.values()) if (m.id !== id) send(m.ws, { op: "peer_join", pid: id, name: who.name, verified: who.verified });
}

const server = http.createServer((req, res) => {
  if (accounts.handle(req, res)) return;
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url.startsWith("/rooms")) {
    const list = visibleRooms(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rooms: list, proto: PROTOCOL }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`ThunderAlley relay OK. rooms=${rooms.size} accounts=${accounts.store.kind}${accounts.store.persistent ? "" : " (NOT persistent: set UPSTASH_REDIS_REST_URL/TOKEN)"}\n`);
});

const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

wss.on("connection", (ws) => {
  ws.alive = true;
  ws.room = null;
  ws.on("pong", () => (ws.alive = true));
  ws.on("message", (data, isBinary) => {
    ws.alive = true;
    if (isBinary) {
      const room = ws.room;
      if (!room || data.length < 4) return;
      const target = data.readInt32LE(0);
      const out = Buffer.allocUnsafe(data.length);
      out.writeInt32LE(ws.mid, 0);
      data.copy(out, 4, 4);
      if (target > 0) {
        const m = room.members.get(target);
        if (m && m.ws.readyState === 1) m.ws.send(out, { binary: true });
      } else {
        const skip = target < 0 ? -target : 0;
        for (const m of room.members.values()) {
          if (m.id !== ws.mid && m.id !== skip && m.ws.readyState === 1) m.ws.send(out, { binary: true });
        }
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.op) {
      case "create":
        resolveName(msg).then((who) => {
          if (ws.readyState !== 1) return;
          if (ws.room) leave(ws);
          let code = String(msg.code || "").toUpperCase();
          if (!code || rooms.has(code) || code.length > 8) code = newCode();
          const room = { code, members: new Map(), host: 0, public: msg.public !== false, meta: { name: who.name }, migrations: 0, created: Date.now() };
          rooms.set(code, room);
          join(ws, room, who);
        });
        break;
      case "join":
        resolveName(msg).then((who) => {
          if (ws.readyState !== 1) return;
          const room = rooms.get(String(msg.room || "").toUpperCase());
          if (!room) return send(ws, { op: "error", reason: "Room not found" });
          if (room.members.size >= MAX_ROOM) return send(ws, { op: "error", reason: "Room is full" });
          if (ws.room) leave(ws);
          join(ws, room, who);
        });
        break;
      case "meta": // host publishes what the room is playing (for the public list)
        if (ws.room && ws.room.host === ws.mid) {
          const m = msg.meta && typeof msg.meta === "object" ? msg.meta : {};
          if (Array.isArray(m.friends)) m.friends = m.friends.slice(0, 200).map((n) => String(n).slice(0, 24));
          ws.room.meta = { ...ws.room.meta, ...m };
          if (typeof msg.public === "boolean") ws.room.public = msg.public;
        }
        break;
      case "leave":
        leave(ws);
        break;
      case "ping":
        send(ws, { op: "pong", t: msg.t });
        break;
    }
  });
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

// drop dead connections quickly so a frozen host gets replaced fast
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 4000);

server.listen(PORT, () => console.log(`[relay] ThunderAlley relay listening on ${PORT}`));
