'use strict';

/** 采集调度：多房间并行、缓冲批量落库、向界面广播。 */

const { EventEmitter } = require('node:events');
const { DanmuClient, fetchRoomInfo } = require('./douyu');

const FLUSH_MS = 800;
const FLUSH_MAX = 400;
const REPLAY_WINDOW_MS = 90 * 1000;
const RECENT_TTL_MS = 10 * 60 * 1000;
const RECENT_MAX = 8000;
// 弹幕潮判定：10 秒内同一句话被 ≥3 个不同用户刷出来。满足时不做补发去重——
// 这时候的「连发」是全房复读，不是断线补发，误杀会把弹幕潮抹平。
const FLOOD_WINDOW_MS = 10 * 1000;
const FLOOD_MIN_USERS = 3;
const TEXT_SEEN_MAX = 4000;

class Collector extends EventEmitter {
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.log = opts.onLog || (() => {});
    this.clients = new Map(); // rid -> { client, info, state }
    this.buffer = [];
    this.dropped = 0; // 被唯一索引挡掉的重复（补发且时间戳未变）
    this.replayDropped = 0; // 重连窗口内按内容挡掉的重复（补发且时间戳被重打）
    this.lateFrames = 0; // 收到比水位更早的帧，说明服务端在回放旧消息
    this.recent = new Map(); // uid|txt -> cst，用于重连窗口内的内容去重
    this.replayUntil = new Map(); // rid -> 窗口截止时间
    this.replayLog = []; // 最近 20 次补发拦截的 cst 差异，用于判断服务端是否重打时间戳
    this.textSeen = new Map(); // ntxt -> [{uid, at}]，用于判定「弹幕潮」
    this.dupes = []; // 被去重层拦下的连发，flush 时写进 dupes 表留档
    this.floodKept = 0; // 因为判定为弹幕潮而放行、没被当补发删掉的条数
    this.gapsWritten = 0; // 记下的采集缺口条数（断线期间丢的数据）
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref && this.timer.unref();
  }

  /**
   * 断线重连后斗鱼可能补发一段旧弹幕。两种情况：
   *  a) 原样重发（cst 不变）→ 数据库的 hkey 唯一索引会挡住，计入 dropped；
   *  b) 服务端重新打戳（cst 变了）→ 指纹对不上，只能靠这里的「内容 + 时间窗」兜底。
   * 窗口只开在重连之后 90 秒，正常直播时不做内容去重，避免把真人连刷两次误杀。
   */
  _isReplay(msg) {
    const key = `${msg.uid}|${msg.txt}`;
    const now = Date.now();
    const until = this.replayUntil.get(msg.rid) || 0;
    const inWindow = now < until;
    const seen = this.recent.get(key);
    const flood = this._isFlood(msg, now);
    if (inWindow && seen && Math.abs(Number(msg.cst) - seen) < RECENT_TTL_MS) {
      // 弹幕潮期间的「连发」是全房复读，不是补发：放行，并记一笔 floodKept
      if (flood) {
        this.floodKept++;
        this._noteText(msg, now);
        this._remember(key, Number(msg.cst) || now);
        return false;
      }
      this.replayDropped++;
      // 记下这次补发的 cst 差异：delta=0 说明服务端是原样重发，delta≠0 说明补发时重打了时间戳
      const entry = {
        rid: msg.rid,
        uid: msg.uid,
        txt: String(msg.txt || '').slice(0, 40),
        cstNew: Number(msg.cst) || 0,
        cstSeen: seen,
        delta: (Number(msg.cst) || 0) - seen,
        at: now,
      };
      this.replayLog.push(entry);
      if (this.replayLog.length > 20) this.replayLog.shift();
      // 被拦下的不丢：写进 dupes 表，连发/弹幕潮需要这个 +1
      this.dupes.push({ ...msg, reason: 'replay', delta: entry.delta });
      if (this.dupes.length > 2000) this.dupes.splice(0, this.dupes.length - 2000);
      if (this.replayDropped === 1) this.log(`检测到重连补发，已按内容去重（房间 ${msg.rid}）`);
      return true;
    }
    this._noteText(msg, now);
    this._remember(key, Number(msg.cst) || now);
    return false;
  }

  /** 10 秒内这句话是否已被 ≥3 个其他用户刷过（弹幕潮） */
  _isFlood(msg, now) {
    const k = String(msg.txt || '').trim();
    if (!k) return false;
    const arr = this.textSeen.get(k);
    if (!arr) return false;
    const users = new Set([String(msg.uid)]);
    for (let i = arr.length - 1; i >= 0 && i >= arr.length - 60; i--) {
      const e = arr[i];
      if (now - e.at > FLOOD_WINDOW_MS) break;
      users.add(String(e.uid));
      if (users.size >= FLOOD_MIN_USERS) return true;
    }
    return false;
  }

  _noteText(msg, now) {
    const k = String(msg.txt || '').trim();
    if (!k) return;
    let arr = this.textSeen.get(k);
    if (!arr) {
      arr = [];
      this.textSeen.set(k, arr);
    }
    arr.push({ uid: msg.uid, at: now });
    if (arr.length > 80) arr.splice(0, arr.length - 80);
    if (this.textSeen.size > TEXT_SEEN_MAX) {
      const cutoff = now - FLOOD_WINDOW_MS;
      for (const [key, list] of this.textSeen) {
        const last = list[list.length - 1];
        if (!last || last.at < cutoff) this.textSeen.delete(key);
        if (this.textSeen.size <= TEXT_SEEN_MAX * 0.8) break;
      }
    }
  }

  _remember(key, cst) {
    this.recent.set(key, cst);
    if (this.recent.size > RECENT_MAX) {
      const cutoff = Date.now() - RECENT_TTL_MS;
      for (const [k, v] of this.recent) {
        if (v >= cutoff) break;
        this.recent.delete(k);
      }
      if (this.recent.size > RECENT_MAX) this.recent.clear();
    }
  }

  get(rid) {
    return this.clients.get(Number(rid));
  }

  list() {
    return [...this.clients.values()].map((c) => ({
      rid: c.info.rid,
      name: c.info.name,
      owner: c.info.owner,
      avatar: c.info.avatar,
      status: c.state,
      port: c.port || null,
      received: c.client ? c.client.stats.received : 0,
      chats: c.client ? c.client.stats.chats : 0,
      reconnects: c.client ? c.client.stats.reconnects : 0,
      since: c.client ? c.client.stats.since : Date.now(),
    }));
  }

  async add(input, { persist = true } = {}) {
    const info = await fetchRoomInfo(input);
    if (this.clients.has(info.rid)) {
      const exist = this.clients.get(info.rid);
      if (exist.state !== 'online') this._startClient(exist);
      return { info, started: true, existed: true };
    }
    if (persist) this.store.upsertRoom(info);
    const entry = { info, client: null, state: 'starting', port: null, lastMsgAt: 0, retries: 0 };
    this.clients.set(info.rid, entry);
    this._startClient(entry);
    this.emit('rooms');
    return { info, started: true, existed: false };
  }

  _startClient(entry) {
    const client = new DanmuClient(entry.info, { onLog: this.log });
    entry.client = client;
    entry.state = 'connecting';

    client.on('chat', (msg) => {
      // 记下这个房间最后一条消息的时间：断线后它就是缺口的起点
      const t = Number(msg.cst) || Date.now();
      if (t > entry.lastMsgAt) entry.lastMsgAt = t;
      if (this._isReplay(msg)) return;
      this.buffer.push(msg);
      if (this.buffer.length >= FLUSH_MAX) this.flush();
    });
    client.on('status', (s) => {
      entry.state = s.state;
      entry.port = s.port || entry.port;
      if (s.state === 'online') {
        this.store.setRoomStatus(entry.info.rid, 'live');
        // 重连成功后开一个 90 秒的补发窗口：这期间同一用户发同样的话，按补发处理
        if (client.stats && client.stats.reconnects > 0) {
          this.replayUntil.set(entry.info.rid, Date.now() + REPLAY_WINDOW_MS);
          // 同时把这段断线记成采集缺口：斗鱼不补发，这几分钟的数据是永久丢失的，
          // 不记下来，画像就会把「没采到」当成「没人说话」。
          if (entry.lastMsgAt) {
            try {
              const g = this.store.addGap({
                rid: entry.info.rid,
                from: entry.lastMsgAt,
                to: Date.now(),
                retries: entry.retries,
              });
              if (g) {
                this.gapsWritten++;
                if (!g.merged) {
                  this.log(
                    `记录采集缺口：房间 ${entry.info.rid} 中断 ${Math.round(g.durMs / 1000)} 秒（重试 ${entry.retries} 次）`
                  );
                }
              }
            } catch (err) {
              this.log(`记录缺口失败：${err.message}`);
            }
          }
          entry.retries = 0;
        }
      }
      if (s.state === 'offline') {
        entry.retries++;
        this.store.setRoomStatus(entry.info.rid, 'reconnecting');
      }
      this.emit('status', { rid: entry.info.rid, state: entry.state, port: entry.port });
      this.emit('rooms');
    });
    client.start().catch((err) => this.log(`启动失败 ${entry.info.rid}: ${err.message}`));
  }

  stop(rid, { keepAuto = false } = {}) {
    const entry = this.clients.get(Number(rid));
    if (!entry) return false;
    entry.client && entry.client.stop();
    this.clients.delete(Number(rid));
    // keepAuto：程序退出时的批量停止，不能把 auto_start 关掉，否则下次启动不会自动恢复
    this.store.setRoomStatus(Number(rid), 'stopped', { keepAuto });
    this.emit('rooms');
    return true;
  }

  stopAll() {
    for (const [rid] of this.clients) this.stop(rid, { keepAuto: true });
  }

  flush() {
    if (this.broken) return;
    if (this.dupes.length) {
      const list = this.dupes;
      this.dupes = [];
      try {
        this.store.insertDupes(list);
      } catch (err) {
        this.log(`连发留档失败：${err.message}`);
      }
    }
    if (!this.buffer.length) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      const res = this.store.insertBatch(rows);
      this.dropped = (this.dropped || 0) + res.dupes;
      if (res.inserted) {
        this.store.touchRooms(rows);
        this.emit('messages', rows);
      }
    } catch (err) {
      // 库文件被外部删掉/挪走：不能再写了。SQLite 会在原路径静默建一个空库，
      // 继续写等于把数据丢进新库、历史全没，而界面看不出异常；采集器内存里的房间
      // 还会被重新写回去，看起来像"删了库房间还在"。
      if (err && err.code === 'DB_FILE_GONE') {
        if (!this.broken) {
          this.broken = true;
          this.buffer = [];
          this.log(`【严重】${err.message}；已停止采集，避免把数据写进新建的空库`);
          this.stopAll();
          this.emit('dbgone', err);
        }
        return;
      }
      this.log(`落库失败：${err.message}`);
      // 写失败时把数据放回缓冲（限制上限，避免内存爆掉）
      this.buffer = rows.concat(this.buffer).slice(-2000);
    }
  }

  /** 启动时恢复上次的房间 */
  async restore() {
    const rooms = this.store.listRooms().filter((r) => r.auto_start);
    const now = Date.now();
    for (const r of rooms) {
      // 程序没开的那段时间也要记账：否则「关窗」造成的空白会被当成「没人说话」，
      // 活跃度/夜间占比这些就会被拉低，而且完全看不出来。
      try {
        const last = this.store.lastMessageAt(r.rid);
        if (last && now - last >= 10000) {
          const g = this.store.addGap({ rid: r.rid, from: last, to: now, retries: 0, reason: 'downtime' });
          if (g) {
            this.gapsWritten = (this.gapsWritten || 0) + 1;
            this.log(
              `记录停机缺口：房间 ${r.rid} 空白 ${Math.round(g.durMs / 1000)} 秒（程序未运行）`
            );
          }
        }
      } catch (err) {
        this.log(`补记停机缺口失败 ${r.rid}：${err.message}`);
      }
      try {
        await this.add(r.rid, { persist: false });
      } catch (err) {
        this.log(`恢复房间 ${r.rid} 失败：${err.message}`);
      }
    }
    return rooms.length;
  }
}

module.exports = { Collector };
