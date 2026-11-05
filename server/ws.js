'use strict';

/**
 * 极简 WebSocket 客户端（仅客户端模式）。
 * Node 内置的全局 WebSocket 连接斗鱼弹幕服务器会被 close 1006，
 * 所以这里基于 tls 自己实现握手与帧编解码。
 */

const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSClient extends EventEmitter {
  constructor({ host, port, path = '/', origin, userAgent, secure = true }) {
    super();
    this.host = host;
    this.port = port;
    this.path = path;
    this.secure = secure;
    this.origin = origin === undefined ? `${secure ? 'https' : 'http'}://${host}` : origin;
    this.userAgent = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.handshook = false;
    this.closed = false;
    this.connectedAt = 0;
    this.lastDataAt = 0;
  }

  get alive() {
    return !!this.sock && !this.closed && this.handshook;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const key = crypto.randomBytes(16).toString('base64');
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(this);
      };

      const onReady = () => {
        sock.write(
          `GET ${this.path} HTTP/1.1\r\n` +
            `Host: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            (this.origin ? `Origin: ${this.origin}\r\n` : '') +
            `User-Agent: ${this.userAgent}\r\n\r\n`
        );
      };

      const sock = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: true }, onReady)
        : net.connect({ host: this.host, port: this.port }, onReady);

      const timer = setTimeout(() => {
        sock.destroy();
        finish(new Error(`连接 ${this.host}:${this.port} 超时`));
      }, timeoutMs);

      this.sock = sock;
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30000);

      sock.on('data', (chunk) => {
        this.lastDataAt = Date.now();
        this._onData(chunk, key, finish);
      });
      sock.on('error', (err) => {
        this.closed = true;
        this.emit('error', err);
        finish(err);
      });
      sock.on('close', () => {
        this.closed = true;
        this.emit('close');
      });
    });
  }

  _onData(chunk, key, finish) {
    this.buf = Buffer.concat([this.buf, chunk]);

    if (!this.handshook) {
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this.buf.subarray(0, idx).toString('latin1');
      const lines = head.split('\r\n');
      const statusLine = lines[0] || '';
      const accept = lines
        .find((l) => l.toLowerCase().startsWith('sec-websocket-accept:'))
        ?.split(':')[1]
        ?.trim();
      const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

      if (!/^HTTP\/1\.1 101/.test(statusLine) || accept !== expect) {
        finish(new Error(`WebSocket 握手失败: ${statusLine}`));
        this.sock?.destroy();
        return;
      }

      this.handshook = true;
      this.connectedAt = Date.now();
      this.buf = this.buf.subarray(idx + 4);
      this.emit('open');
      finish(null);
    }

    this._parseFrames();
  }

  _parseFrames() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;

      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }

      let mask;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;

      let payload = b.subarray(off, off + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = b.subarray(off + len);

      if (opcode === 0x8) {
        this.closed = true;
        try {
          this._sendRaw(Buffer.alloc(0), 0x8);
        } catch {}
        this.sock?.end();
        this.emit('close');
        return;
      }
      if (opcode === 0x9) {
        this._sendRaw(payload, 0xa);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.emit('message', payload, { fin, opcode });
      }
    }
  }

  _sendRaw(payload, opcode) {
    const sock = this.sock;
    if (!sock || sock.destroyed) throw new Error('连接已关闭');

    const len = payload.length;
    let header;
    let maskOffset;

    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      maskOffset = 2;
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      maskOffset = 4;
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      maskOffset = 10;
    }

    const mask = crypto.randomBytes(4);
    mask.copy(header, maskOffset);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    sock.write(Buffer.concat([header, masked]));
  }

  send(payload, opcode = 0x2) {
    if (!this.alive) throw new Error('WebSocket 未连接');
    this._sendRaw(Buffer.isBuffer(payload) ? payload : Buffer.from(payload), opcode);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this._sendRaw(Buffer.alloc(0), 0x8);
    } catch {}
    this.sock?.end();
    this.sock?.destroy();
  }
}

module.exports = { WSClient };
