// Minimal dependency-free WebSocket server (RFC 6455) with the small subset
// of the "ws" package API the relay uses: connection/message/close/error/pong
// events, send(data, {binary}), ping(), terminate(), readyState, clients.
const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class Socket extends EventEmitter {
  constructor(sock, maxPayload) {
    super();
    this.sock = sock;
    this.readyState = 1;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.frag = null;      // {op, parts}
    sock.setNoDelay(true);
    sock.on("data", (d) => this._data(d));
    sock.on("close", () => this._closed());
    sock.on("error", (e) => { this.emit("error", e); this._closed(); });
  }
  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > this.maxPayload) { this.terminate(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = this.buf.subarray(need);
      this._frame(fin, op, payload);
      if (this.readyState !== 1) return;
    }
  }
  _frame(fin, op, payload) {
    if (op === 0x8) { this._write(0x8, Buffer.alloc(0)); this.sock.end(); this._closed(); return; }
    if (op === 0x9) { this._write(0xA, payload); return; }
    if (op === 0xA) { this.emit("pong"); return; }
    if (op === 0x0) {
      if (!this.frag) return;
      this.frag.parts.push(payload);
      if (!fin) return;
      const whole = Buffer.concat(this.frag.parts);
      const fop = this.frag.op;
      this.frag = null;
      this.emit("message", whole, fop === 0x2);
      return;
    }
    if (op === 0x1 || op === 0x2) {
      if (!fin) { this.frag = { op, parts: [payload] }; return; }
      this.emit("message", payload, op === 0x2);
    }
  }
  _write(op, payload) {
    if (this.readyState !== 1 && op !== 0x8) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.from([0x80 | op, len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.sock.write(Buffer.concat([head, payload])); } catch (e) { this._closed(); }
  }
  send(data, opts) {
    const binary = (opts && opts.binary) || Buffer.isBuffer(data);
    this._write(binary ? 0x2 : 0x1, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
  }
  ping() { this._write(0x9, Buffer.alloc(0)); }
  terminate() { try { this.sock.destroy(); } catch (e) {} this._closed(); }
}

class WebSocketServer extends EventEmitter {
  constructor({ server, maxPayload }) {
    super();
    this.clients = new Set();
    server.on("upgrade", (req, sock) => {
      const key = req.headers["sec-websocket-key"];
      if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { sock.destroy(); return; }
      const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const ws = new Socket(sock, maxPayload || 1 << 20);
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      this.emit("connection", ws, req);
    });
  }
}

module.exports = { WebSocketServer };
