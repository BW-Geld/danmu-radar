'use strict';

/**
 * 斗鱼侧：房间信息查询 + 弹幕长连接。
 */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { WSClient } = require('./ws');
const stt = require('./stt');

// 未知消息类型日志（默认关闭）：DANMU_WS_LOG=1 打开，写到 data\ws-unknown.log
const WS_LOG = process.env.DANMU_WS_LOG === '1';
const WS_LOG_FILE = path.join(__dirname, '..', 'data', 'ws-unknown.log');

const HOST = 'danmuproxy.douyu.com';
const PORTS = [8501, 8502, 8503, 8504, 8505, 8506];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 支持 475252 / https://www.douyu.com/475252 / 房间别名 */
function extractRoomKey(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('房间号不能为空');
  const m = s.match(/(\d{2,})/);
  if (m) return m[1];
  const tail = s.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
  if (!tail) throw new Error('无法识别房间号');
  return tail;
}

async function fetchRoomInfo(input) {
  const key = extractRoomKey(input);
  let room = await betardRoom(key);

  // 短号/别名（比如 6657）betard 会直接返回房间页 HTML，拿不到 JSON。
  // 这时退一步去房间页里扒真正的 room_id，再用它查一次。
  if (!room) {
    const rid = await roomIdFromPage(key);
    if (rid) room = await betardRoom(String(rid));
  }
  if (!room || !room.room_id) throw new Error(`未找到房间：${input}`);

  return {
    rid: Number(room.room_id),
    name: room.room_name || String(room.room_id),
    owner: room.nickname || '',
    ownerUid: String(room.owner_uid || ''),
    avatar: (room.avatar && (room.avatar.big || room.avatar.middle)) || '',
    cate: String(room.cate_id || ''),
    status: Number(room.show_status || 0) === 1 ? 'live' : 'offline',
  };
}

/** betard 接口：正常返回 { room: {...} }，短号会返回 HTML，此时返回 null */
async function betardRoom(key) {
  const res = await fetch(`https://www.douyu.com/betard/${encodeURIComponent(key)}`, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.douyu.com/',
      Accept: 'application/json, text/plain, */*',
    },
  });
  if (!res.ok) throw new Error(`房间信息请求失败（HTTP ${res.status}）`);
  const body = await res.text();
  if (!body.trim().startsWith('{')) return null;
  try {
    const data = JSON.parse(body);
    return (data && data.room) || null;
  } catch {
    return null;
  }
}

/** 从房间页内联脚本里扒 room_id（形如 "room_id":6979222） */
async function roomIdFromPage(key) {
  const res = await fetch(`https://www.douyu.com/${encodeURIComponent(key)}`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.douyu.com/' },
  });
  if (!res.ok) return 0;
  const html = await res.text();
  const m = html.match(/room_id\\?"\s*:\s*(\d{4,})/);
  return m ? Number(m[1]) : 0;
}

/**
 * 弹幕时间戳归一化。斗鱼在不同房间/不同版本里给过三种形态：
 *   10 位秒(1793783760)、13 位毫秒(1793783760068)，以及偶尔的空值。
 * 判断依据用**字符串长度**而不是数值大小——数值大小在 1e12 附近有歧义，
 * 而长度只在 10 和 13 之间取值，确定性更高。
 * 返回毫秒；无法识别时退回当前时间，宁可时间不准也不要写进 1970 年。
 */
function toMs(v) {
  if (v === undefined || v === null || v === '') return Date.now();
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 1e12 ? n : Date.now();
  }
  if (s.length >= 13) return Number(s.slice(0, 13));
  if (s.length === 10) return Number(s) * 1000;
  const n = Number(s);
  if (!n) return Date.now();
  return n > 1e12 ? n : n * 1000;
}

class DanmuClient extends EventEmitter {
  /**
   * @param {{rid:number, name:string}} room
   * @param {{onLog?:Function}} opts
   */
  constructor(room, opts = {}) {
    super();
    this.rid = Number(room.rid);
    this.roomName = room.name || String(room.rid);
    this.opts = opts;
    this.ws = null;
    this.timer = null;
    this.keepTimer = null;
    this.reconnectDelay = 1000;
    this.stopped = false;
    this.connected = false;
    this.portIndex = 0;
    this.stats = { received: 0, chats: 0, reconnects: 0, lateFrames: 0, since: Date.now() };
    this.maxCst = 0;
  }

  log(msg) {
    this.opts.onLog && this.opts.onLog(`[${this.roomName}] ${msg}`);
  }

  async start() {
    this.stopped = false;
    await this._connect();
  }

  async _connect() {
    if (this.stopped) return;
    const port = PORTS[this.portIndex % PORTS.length];
    this.portIndex++;

    const ws = new WSClient({ host: HOST, port, origin: 'https://www.douyu.com' });
    this.ws = ws;

    ws.on('message', (payload) => this._onPayload(payload));
    ws.on('close', () => this._onDrop('连接关闭'));
    ws.on('error', (err) => this._onDrop(err.message));

    try {
      await ws.connect(8000);
    } catch (err) {
      this._onDrop(err.message);
      return;
    }

    try {
      ws.send(stt.encode(`type@=loginreq/roomid@=${this.rid}/`));
      ws.send(stt.encode(`type@=joingroup/rid@=${this.rid}/gid@=-9999/`));
    } catch (err) {
      this._onDrop(err.message);
      return;
    }

    this.connected = true;
    this.reconnectDelay = 1000;
    this.emit('status', { state: 'online', port });
    this.log(`已连接 :${port}`);

    clearInterval(this.keepTimer);
    this.keepTimer = setInterval(() => {
      if (!this.ws || !this.ws.alive) return;
      try {
        this.ws.send(stt.encode(`type@=keeplive/tick@=${Math.floor(Date.now() / 1000)}/`));
      } catch {}
    }, 45000);
  }

  _onPayload(payload) {
    const msgs = stt.decodeAll(payload);
    for (const m of msgs) {
      this.stats.received++;
      switch (m.type) {
        case 'chatmsg': {
          this.stats.chats++;
          const cst = toMs(m.cst);
          // 水位倒流说明服务端在回放旧消息（重连补发）。补发是否重打时间戳，
          // 决定了数据库里的指纹去重能不能命中——这个计数就是判断依据。
          if (cst < this.maxCst - 3000) {
            this.stats.lateFrames++;
            if (this.stats.lateFrames === 1) this.log(`收到迟到 ${Math.round((this.maxCst - cst) / 1000)}s 的弹幕（疑似补发）`);
          } else if (cst > this.maxCst) {
            this.maxCst = cst;
          }
          this.emit('chat', {
            kind: 'chat',
            rid: this.rid,
            roomName: this.roomName,
            uid: String(m.uid || ''),
            nn: m.nn || '',
            txt: m.txt || '',
            cst,
            level: Number(m.level) || 0,
            bnn: m.bnn || '',
            bl: Number(m.bl) || 0,
            brid: Number(m.brid) || 0,
            col: m.col || '',
            ic: m.ic || '',
          });
          break;
        }
        case 'uenter': {
          this.emit('event', {
            kind: 'enter',
            rid: this.rid,
            uid: String(m.uid || ''),
            nn: m.nn || '',
            level: Number(m.level) || 0,
            cst: Date.now(),
          });
          break;
        }
        case 'dgb':
        case 'sdgb': {
          this.emit('event', {
            kind: 'gift',
            rid: this.rid,
            uid: String(m.uid || ''),
            nn: m.nn || '',
            txt: m.gfid ? `礼物 ${m.gfid} x${m.gfcnt || 1}` : '礼物',
            cst: toMs(m.cst),
            level: Number(m.level) || 0,
            gfid: String(m.gfid || ''),
            gfcnt: Number(m.gfcnt) || 1,
          });
          break;
        }
        case 'loginres':
          this.log('登录成功');
          break;
        case 'error':
          this.log(`服务端错误：${m.msg || m.error || JSON.stringify(m)}`);
          break;
        default:
          // DANMU_WS_LOG=1 时把不认识的类型记下来。
          // 用途：查「看点」「高光」这类功能到底走不走弹幕 WS——
          // 直播时弹出来一次，日志里就能看到它的 type 和原文。
          if (WS_LOG) {
            try {
              // 防止挂几天把盘写满：超过 5 MB 就截断重来
              const st = fs.statSync(WS_LOG_FILE, { throwIfNoEntry: false });
              if (st && st.size > 5 * 1024 * 1024) fs.truncateSync(WS_LOG_FILE, 0);
              const line = JSON.stringify({
                at: Date.now(),
                rid: this.rid,
                type: String(m.type || ''),
                preview: JSON.stringify(m).slice(0, 4000),
              });
              fs.appendFileSync(WS_LOG_FILE, line + '\n');
            } catch {}
          }
          break;
      }
    }
  }

  _onDrop(reason) {
    if (this.stopped) return;
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this.keepTimer);
    try {
      this.ws && this.ws.close();
    } catch {}
    this.ws = null;
    this.emit('status', { state: 'offline', reason });

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 30000);
    if (wasConnected) this.stats.reconnects++;
    this.log(`${reason}，${Math.round(delay / 1000)}s 后重连`);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), delay);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.keepTimer);
    this.connected = false;
    try {
      this.ws && this.ws.close();
    } catch {}
    this.ws = null;
    this.emit('status', { state: 'stopped' });
  }
}

/**
 * 拉本场「AI 看点」列表。
 * 接口是 vodnc 下的 getHighlightDetail，用 form 提交，只要 rid，hlId 传 0 也返回整场列表。
 * 返回的 highlightList 每项含 highlightId / title / summary / describe / startTime / endTime / heat。
 */
async function fetchHighlights(rid) {
  const res = await fetch('https://www.douyu.com/wgapi/vodnc/center/ailive/getHighlightDetail', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Referer: `https://www.douyu.com/${rid}`,
      'User-Agent': UA,
    },
    body: new URLSearchParams({ rid: String(rid), hlId: '0' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`看点接口 HTTP ${res.status}`);
  const json = await res.json();
  if (json.error !== 0) throw new Error(json.msg || '看点接口返回错误');
  const list = (json.data && json.data.highlightList) || [];
  return list
    .map((x) => ({
      id: String(x.highlightId || ''),
      title: String(x.title || ''),
      summary: String(x.summary || ''),
      desc: String(x.describe || ''),
      start: Number(x.startTime || 0) * 1000,
      end: Number(x.endTime || 0) * 1000,
      heat: Number(x.heat || 0),
    }))
    .filter((x) => x.start > 0)
    .sort((a, b) => a.start - b.start);
}

module.exports = { fetchRoomInfo, fetchHighlights, DanmuClient, PORTS, HOST, toMs };
