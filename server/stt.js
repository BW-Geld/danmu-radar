'use strict';

/**
 * 斗鱼 STT 弹幕协议编解码。
 *
 * 帧结构（小端）：
 *   int32  len        = 8 + payload 字节数
 *   int32  len        重复
 *   int32  689        协议号
 *   bytes  payload    以 \0 结尾的 "k@=v/k@=v/" 文本
 * 总长度 = 4 + len
 *
 * 一个 WebSocket 帧里可能拼接了多条 STT 消息，必须按长度前缀循环切分。
 */

const STT_MAGIC = 689;

function encode(text) {
  const body = Buffer.from(String(text) + '\0', 'utf8');
  const len = body.length + 8;
  const buf = Buffer.alloc(len + 4);
  buf.writeInt32LE(len, 0);
  buf.writeInt32LE(len, 4);
  buf.writeInt32LE(STT_MAGIC, 8);
  body.copy(buf, 12);
  return buf;
}

/** 把 "k@=v/k@=v/" 解析成对象 */
function parseFields(text) {
  const out = {};
  for (const part of text.split('/')) {
    const i = part.indexOf('@=');
    if (i <= 0) continue;
    const key = part.slice(0, i);
    out[key] = unescape(part.slice(i + 2));
  }
  return out;
}

function unescape(v) {
  if (!v.includes('@')) return v;
  return v.replace(/@S/g, '/').replace(/@A/g, '@');
}

/**
 * 从一段 WebSocket 载荷中切分并解析出所有 STT 消息。
 * @returns {Array<object>} 解析后的字段对象数组
 */
function decodeAll(payload) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const out = [];
  let off = 0;

  while (off + 4 <= payload.length) {
    const len = payload.readInt32LE(off);
    if (len < 8) break;
    const end = off + 4 + len;
    if (end > payload.length) break;

    const body = payload.subarray(off + 12, end);
    const text = body.toString('utf8').replace(/\0+$/g, '');
    const start = text.indexOf('type@=');
    if (start >= 0) {
      try {
        out.push(parseFields(text.slice(start)));
      } catch {
        /* 忽略单条坏消息 */
      }
    }
    off = end;
  }

  if (out.length === 0) {
    // 兜底：整段当一条消息解析
    const text = payload.toString('utf8').replace(/\0+$/g, '');
    const start = text.indexOf('type@=');
    if (start >= 0) {
      try {
        out.push(parseFields(text.slice(start)));
      } catch {}
    }
  }

  return out;
}

module.exports = { encode, decodeAll, parseFields };
