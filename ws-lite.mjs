// Minimal, dependency-free WebSocket transport for Monster Realm's small JSON PvP messages.
// Supports RFC 6455 masked client frames, fragmentation, ping/pong and clean close.
// Uses Node.js built-ins only. Not intended as a high-scale general-purpose WS library.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const MAX_FRAME = 128 * 1024;
const MAX_BUFFER = MAX_FRAME * 2;

function makeFrame(opcode, payload = Buffer.alloc(0)) {
  const size = payload.length;
  let header;
  if (size < 126) {
    header = Buffer.from([0x80 | opcode, size]);
  } else if (size <= 65535) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(size, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(size), 2);
  }
  return Buffer.concat([header, payload]);
}

class Connection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.readyState = 1;
    this._pending = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentSize = 0;
    socket.on('data', chunk => this._receive(chunk));
    socket.on('error', err => this.emit('error', err));
    socket.on('close', () => {
      this.readyState = 3;
      this.emit('close');
    });
    if (head?.length) this._receive(head);
  }
  _write(opcode, data) {
    if (this.readyState !== 1) return;
    try { this.socket.write(makeFrame(opcode, data)); }
    catch (_) { this.socket.destroy(); }
  }
  send(value) { this._write(0x1, Buffer.from(String(value), 'utf8')); }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    const message = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + message.length);
    p.writeUInt16BE(code, 0);
    message.copy(p, 2);
    this._write(0x8, p);
    this.readyState = 2;
    this.socket.end();
  }
  _fail(code = 1002) { this.close(code); this.socket.destroy(); }
  _receive(chunk) {
    if (this.readyState !== 1) return;
    if (this._pending.length + chunk.length > MAX_BUFFER) { this._fail(1009); return; }
    this._pending = Buffer.concat([this._pending, chunk]);
    while (this._pending.length >= 2) {
      const data = this._pending;
      const first = data[0], second = data[1];
      const fin = Boolean(first & 0x80), opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let size = second & 0x7f, cursor = 2;
      if (!masked || (first & 0x70)) { this._fail(); return; }
      if (size === 126) {
        if (data.length < cursor + 2) break;
        size = data.readUInt16BE(cursor); cursor += 2;
      } else if (size === 127) {
        if (data.length < cursor + 8) break;
        const huge = data.readBigUInt64BE(cursor); cursor += 8;
        if (huge > BigInt(MAX_FRAME)) { this._fail(1009); return; }
        size = Number(huge);
      }
      if (size > MAX_FRAME || this._fragmentSize + size > MAX_FRAME) { this._fail(1009); return; }
      if (data.length < cursor + 4 + size) break;
      const mask = data.subarray(cursor, cursor + 4); cursor += 4;
      const payload = Buffer.from(data.subarray(cursor, cursor + size));
      this._pending = data.subarray(cursor + size);
      for (let i = 0; i < payload.length; ++i) payload[i] ^= mask[i & 3];
      if (opcode === 0x8) {
        // A close frame may be 0 or >=2 bytes, never exactly 1.
        if (payload.length === 1) { this._fail(); return; }
        this.close(); return;
      }
      if (opcode === 0x9) { this._write(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1) {
        if (this._fragments.length) { this._fail(); return; }
        if (fin) this.emit('message', payload);
        else { this._fragments = [payload]; this._fragmentSize = payload.length; }
      } else if (opcode === 0x0) {
        if (!this._fragments.length) { this._fail(); return; }
        this._fragments.push(payload); this._fragmentSize += payload.length;
        if (fin) {
          const value = Buffer.concat(this._fragments);
          this._fragments = []; this._fragmentSize = 0;
          this.emit('message', value);
        }
      } else { this._fail(1003); return; }
    }
  }
}

export class WebSocketServer extends EventEmitter {
  constructor({ server }) {
    super();
    this.connections = new Set();
    server.on('upgrade', (req, socket, head) => {
      try {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        const key = String(req.headers['sec-websocket-key'] || '');
        const binaryKey = Buffer.from(key, 'base64');
        if (pathname !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || binaryKey.length !== 16 || this.connections.size > 250) {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
        }
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const connection = new Connection(socket, head);
        this.connections.add(connection);
        connection.on('close', () => this.connections.delete(connection));
        connection.on('error', () => socket.destroy());
        this.emit('connection', connection, req);
      } catch (e) { socket.destroy(); }
    });
  }
}
