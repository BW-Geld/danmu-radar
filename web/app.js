'use strict';

/* 弹幕雷达前端：无框架、无构建，直接操作 DOM。 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// 数据来源：live = 本机采集，vod = 录播导入，import = 别人的库包
const SOURCE_NAME = { live: '直播', vod: '录播', import: '导入' };
function sourceName(src) {
  return SOURCE_NAME[src] || '直播';
}
function sourceTag(src, tiny) {
  const label = src === 'vod' ? '录播' : src === 'import' ? '导入' : '';
  if (!label) return null;
  return h('span', `tag ${src === 'import' ? 'imp' : src}${tiny ? ' tiny' : ''}`, label);
}

const state = {
  rooms: [],
  liveRid: null,       // null = 全部房间
  paused: false,
  filter: '',
  buffer: [],          // 当前页面内的消息（用于筛选重绘）
  tab: 'live',
  liveTimer: null,
  stampBuckets: [],
  prefs: { tlsel: {} }, // 服务端存的小状态（时间线选区），跨窗口一致
};

// ------------------------------------------------------------ 基础工具

function toast(msg, isErr = false, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`接口异常（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms) {
  const d = new Date(Number(ms));
  if (!ms) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(ms) {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayStart(ms) {
  const d = new Date(Number(ms));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(1) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return v.toLocaleString('zh-CN');
}
function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v > 1 << 30) return (v / (1 << 30)).toFixed(2) + ' GB';
  if (v > 1 << 20) return (v / (1 << 20)).toFixed(1) + ' MB';
  if (v > 1 << 10) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}
function ago(ms) {
  const s = Math.floor((Date.now() - Number(ms)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// ------------------------------------------------------------ 标签页

function switchTab(name) {
  state.tab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  location.hash = name;
  if (name === 'settings') { loadSettings(); loadAffixes(); }
  if (name === 'live') loadBursts();
  if (name === 'board') loadBoard();
  if (name === 'search') loadKeywords();
  if (name === 'timeline') loadTimeline();
  if (name === 'favorites') loadFavorites();
  if (name === 'user') loadFollows();
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

// ------------------------------------------------------------ 连接状态

function setConn(ok, text) {
  const c = $('#conn');
  c.className = 'conn ' + (ok ? 'on' : 'off');
  $('#conn-text').textContent = text;
}

const es = new EventSource('/api/stream');

es.addEventListener('hello', (e) => {
  const d = JSON.parse(e.data);
  state.rooms = d.rooms || [];
  renderRooms();
  updateStats({ ...d.stats, rooms: countActive(state.rooms) });
  setConn(true, '实时连接正常');
});

es.addEventListener('messages', (e) => {
  const d = JSON.parse(e.data);
  const rows = d.rows || [];
  if (!rows.length) return;
  pushLive(rows);
  bumpSpeed(rows.length);
});

// 「在采房间」：只要程序在盯着这个房间就算（主播没开播时是 offline，但仍在等它开播）
const NOT_COLLECTING = ['saved', 'stopped', 'vod', 'archived'];
function countActive(rooms) {
  return (rooms || []).filter((r) => !NOT_COLLECTING.includes(r.status)).length;
}

es.addEventListener('rooms', (e) => {
  state.rooms = JSON.parse(e.data) || [];
  renderRooms();
  $('#stat-rooms').textContent = countActive(state.rooms);
  if (!state.rooms.some((r) => r.rid === state.liveRid)) state.liveRid = null;
});

es.addEventListener('libprogress', (e) => {
  try {
    onLibProgress(JSON.parse(e.data));
  } catch {
    /* ignore */
  }
});

es.addEventListener('status', (e) => {
  try {
    const d = JSON.parse(e.data);
    const room = state.rooms.find((r) => Number(r.rid) === Number(d.rid));
    if (room && d.state) {
      room.status = d.state;
      renderRooms();
    }
  } catch {
    /* ignore */
  }
});

// 关注 / 收藏在别的窗口改了就跟着刷新（两边读的是同一个 SQLite，只是界面不会自己知道）
es.addEventListener('follows', () => {
  loadFollows().catch(() => {});
});
es.addEventListener('favorites', () => {
  loadFavorites().catch(() => {});
});
es.addEventListener('prefs', () => {
  loadPrefs().catch(() => {});
});

es.onopen = () => setConn(true, '实时连接正常');
es.onerror = () => setConn(false, '连接断开，正在重连…');

// ------------------------------------------------------------ 统计条

function updateStats(s) {
  if (!s) return;
  if (s.today != null) $('#stat-today').textContent = fmtNum(s.today);
  if (s.total != null) $('#stat-total').textContent = fmtNum(s.total);
  if (s.users != null) $('#stat-users').textContent = fmtNum(s.users);
  if (s.rooms != null) $('#stat-rooms').textContent = s.rooms;
  if (s.dbBytes != null) $('#stat-db').textContent = fmtBytes(s.dbBytes);
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    updateStats({ ...s, rooms: countActive(state.rooms) });
  } catch {
    /* 静默 */
  }
}

// ------------------------------------------------------------ 实时页

// ------------------------------------------------------------ 弹幕潮

async function loadBursts() {
  const list = $('#burst-list');
  if (!list) return;
  try {
    const url = `/api/floods?limit=8${state.liveRid ? '&rid=' + state.liveRid : ''}`;
    const res = await fetch(url);
    const d = await res.json();
    const rows = d.rows || [];
    $('#burst-count').textContent = rows.length;
    list.textContent = '';
    if (!rows.length) {
      list.append(h('p', 'hint', COPY.NOTE.localOnly));
      return;
    }
    for (const r of rows) {
      const item = h('div', 'burst-item');
      item.append(h('div', 'burst-text', r.phrase || ''));
      const t = new Date(Number(r.event_start));
      item.append(
        h(
          'div',
          'burst-meta',
          `${fmtNum(r.msg_count)} 条 · 至少 ${fmtNum(r.user_count)} 人 · ${
            (COPY.TOPIC[r.topic] || '')
          } · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
        )
      );
      item.addEventListener('click', () => {
        $('#q').value = r.phrase || '';
        switchTab('search');
        runSearch();
      });
      list.append(item);
    }
  } catch (err) {
    /* 网络抖动忽略，下次刷新再来 */
  }
}

function renderRooms() {  const list = $('#room-list');
  const setList = $('#set-rooms');
  list.textContent = '';
  $('#room-count').textContent = state.rooms.length;

  const all = h('div', 'room-item' + (state.liveRid === null ? ' sel' : ''));
  all.append(h('span', 'dot on'));
  all.append(h('span', 'rname', '全部房间'));
  const countOf = (r) => (r.stored != null ? r.stored : r.chats || 0);
  const totalChats = state.rooms.reduce((a, r) => a + countOf(r), 0);
  all.append(h('span', 'rmeta', fmtNum(totalChats)));
  all.addEventListener('click', () => selectRoom(null));
  list.append(all);

  for (const r of state.rooms) {
    const item = h('div', 'room-item' + (state.liveRid === r.rid ? ' sel' : ''));
    const dot = h('span', 'dot' + (r.status === 'online' ? ' on' : r.status === 'connecting' ? ' warn' : ''));
    item.append(dot);
    const name = h('span', 'rname', r.name || String(r.rid));
    name.title = `${r.name}（${r.rid}）${r.owner ? ' · ' + r.owner : ''}`;
    item.append(name);
    item.append(h('span', 'rmeta', fmtNum(countOf(r))));
    const kill = h('button', 'kill', '×');
    kill.title = '停止采集';
    kill.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await stopRoom(r.rid);
    });
    item.append(kill);
    item.addEventListener('click', () => selectRoom(r.rid));
    list.append(item);
  }

  if (setList) renderSetRooms();
}

function statusLabel(s) {
  return (
    {
      online: '采集中',
      connecting: '连接中',
      reconnecting: '重连中',
      offline: '已离线',
      stopped: '已停止',
      vod: '录播导入',
      saved: '未采集',
      archived: '仅历史',
    }[s] || s || '未知'
  );
}

function renderSetRooms() {
  const box = $('#set-rooms');
  box.textContent = '';
  if (!state.rooms.length) {
    box.append(h('p', 'hint', '还没有添加房间。'));
    return;
  }
  for (const r of state.rooms) {
    const row = h('div', 'setroom');
    row.append(h('span', 'rname', `${r.name || r.rid}　#${r.rid}`));
    row.append(h('span', 'muted', statusLabel(r.status)));
    const isLive = r.status !== 'vod' && r.live !== false;
    if (isLive) {
      const del = h('button', 'btn ghost', '停止');
      del.addEventListener('click', () => stopRoom(r.rid, false));
      row.append(del);
    }
    const forget = h('button', 'btn danger', '删除数据');
    forget.addEventListener('click', () => confirmDeleteRoom(r));
    row.append(forget);
    box.append(row);
  }
}

// 删除房间数据是不可恢复的，多拦一道：勾选之前「删除」按钮是禁用的
function confirmDeleteRoom(r) {
  const n = Number(r.stored || r.chats || 0);
  const isLive = r.status !== 'vod' && r.live !== false;
  showModal('删除房间数据', '删了补不回来', (body) => {
    const info = h('div', 'del-info');
    info.append(h('div', 'del-name', `${r.name || r.rid}（#${r.rid}）`));
    info.append(
      h('div', 'del-line', `会删掉这个房间的 ${fmtNum(n)} 条弹幕，以及连发留档、采集缺口、弹幕潮记录。`)
    );
    if (isLive) info.append(h('div', 'del-line warn', '这个房间正在采集，删除会同时停止它。'));
    body.append(info);

    const pick = h('label', 'del-check');
    const box = h('input');
    box.type = 'checkbox';
    pick.append(box, h('span', null, '我确认删除这些数据，且不可恢复'));

    const foot = h('div', 'modal-foot');
    const cancel = h('button', 'btn ghost', '取消');
    cancel.addEventListener('click', closeModal);
    const ok = h('button', 'btn danger', '删除');
    ok.disabled = true;
    ok.addEventListener('click', async () => {
      if (!box.checked) return;
      closeModal();
      await stopRoom(r.rid, true);
    });
    box.addEventListener('change', () => {
      ok.disabled = !box.checked;
    });
    foot.append(cancel, ok);
    body.append(pick, foot);
    setTimeout(() => cancel.focus(), 30);
  });
}

async function stopRoom(rid, forget = false) {
  try {
    const d = await api(`/api/rooms/${rid}${forget ? '?forget=1' : ''}`, { method: 'DELETE' });
    state.rooms = state.rooms.filter((r) => r.rid !== rid);
    if (state.liveRid === rid) selectRoom(null);
    renderRooms();
    if (forget) toast(`已删除 ${fmtNum(d.removed || 0)} 条弹幕，并移出列表`);
    else toast('已停止采集');
  } catch (err) {
    toast(err.message, true);
  }
}

function selectRoom(rid) {
  state.liveRid = rid;
  state.buffer = [];
  $('#live-list').textContent = '';
  renderRooms();
  const room = state.rooms.find((r) => r.rid === rid);
  $('#live-rid-label').textContent = rid ? `${room ? room.name : rid} · 实时弹幕` : '全部房间 · 实时弹幕';
  loadRecent();
}

async function loadRecent() {
  try {
    const qs = state.liveRid ? `?rid=${state.liveRid}&limit=150` : '?limit=150';
    const d = await api('/api/messages' + qs);
    state.buffer = d.rows || [];
    renderLive(true);
  } catch {
    /* ignore */
  }
}

function msgNode(m) {
  const row = h('div', 'msg' + (m.kind === 'enter' ? ' enter' : ''));
  row.append(h('span', 't', fmtTime(m.cst)));
  if (m.kind === 'enter') {
    row.append(h('span', 'x', `${m.nn || m.uid} 进入直播间`));
    return row;
  }
  if (m.level) row.append(h('span', 'lv', `Lv${m.level}`));
  const nn = h('span', 'n', m.nn || m.uid);
  nn.title = `${m.nn || ''}（${m.uid}）`;
  nn.addEventListener('click', () => openUser(m.uid));
  row.append(nn);
  if (m.bnn) row.append(h('span', 'badge', m.bnn));
  row.append(h('span', 'x', m.txt));
  return row;
}

function matchFilter(m) {
  if (!state.filter) return true;
  return String(m.txt || '').toLowerCase().includes(state.filter) ||
    String(m.nn || '').toLowerCase().includes(state.filter);
}

// 是否吸附在底部：用户往上翻看历史时不抢滚动条，翻回底部自动恢复跟随
state.stick = true;

function atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

function updateStick() {
  const box = $('#live-list');
  state.stick = atBottom(box);
  const btn = $('#live-jump');
  if (btn) btn.classList.toggle('show', !state.stick);
}

$('#live-list').addEventListener('scroll', updateStick, { passive: true });

$('#live-jump').addEventListener('click', () => {
  const box = $('#live-list');
  state.stick = true;
  box.scrollTop = box.scrollHeight;
  updateStick();
});

function renderLive(toBottom = false) {
  const box = $('#live-list');
  box.textContent = '';
  const rows = state.buffer.slice(-500).filter(matchFilter);
  if (!rows.length) {
    const empty = h('div', 'empty');
    empty.append(h('p', 'big', state.filter ? '没有匹配的弹幕' : '还没有弹幕'));
    empty.append(h('p', '', state.filter ? '换个筛选词试试。' : '在左侧添加一个斗鱼直播间，弹幕会实时出现在这里。'));
    box.append(empty);
  } else {
    const frag = document.createDocumentFragment();
    for (const m of rows) frag.append(msgNode(m));
    box.append(frag);
    if (toBottom || state.stick) box.scrollTop = box.scrollHeight;
  }
  $('#live-count').textContent = `${state.buffer.length} 条`;
  updateStick();
}

function pushLive(rows) {
  const list = rows.filter((m) => !state.liveRid || m.rid === state.liveRid);
  if (!list.length) return;
  state.buffer.push(...list);
  if (state.buffer.length > 500) state.buffer = state.buffer.slice(-500);

  const box = $('#live-list');
  if (box.querySelector('.empty')) box.textContent = '';

  const frag = document.createDocumentFragment();
  for (const m of list) if (matchFilter(m)) frag.append(msgNode(m));
  box.append(frag);

  // 裁剪只动顶部：删掉多少高度，就把 scrollTop 往上补多少，
  // 这样正在看的那几行不会被顶走。追加在底部的消息本来就不影响上方内容。
  if (box.childElementCount > 500) {
    const hBefore = box.scrollHeight;
    while (box.childElementCount > 500) box.removeChild(box.firstElementChild);
    if (!state.stick) box.scrollTop += box.scrollHeight - hBefore;
  }
  if (state.stick && !state.paused && !state.filter) box.scrollTop = box.scrollHeight;
  $('#live-count').textContent = `${state.buffer.length} 条`;
}

function bumpSpeed(n) {
  const now = Date.now();
  state.stampBuckets.push({ t: now, n });
  state.stampBuckets = state.stampBuckets.filter((b) => now - b.t < 15000);
  const total = state.stampBuckets.reduce((a, b) => a + b.n, 0);
  const span = Math.max(5, Math.min(15, (now - state.stampBuckets[0].t) / 1000));
  $('#live-speed').textContent = `约 ${(total / span).toFixed(1)} 条/秒`;
}

$('#room-add-btn').addEventListener('click', addRoom);
$('#room-add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addRoom();
});

async function addRoom() {
  const input = $('#room-add-input');
  const value = input.value.trim();
  if (!value) return;
  const btn = $('#room-add-btn');
  btn.disabled = true;
  btn.textContent = '连接中…';
  try {
    const d = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ input: value }) });
    if (d.failed && d.failed.length) toast(d.failed[0].error, true);
    else toast(`已添加：${d.added[0].name || d.added[0].rid}`);
    input.value = '';
    const rooms = await api('/api/rooms');
    state.rooms = rooms.rooms || [];
    renderRooms();
    if (d.added && d.added.length) selectRoom(d.added[0].rid);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '添加';
  }
}

$('#live-pause').addEventListener('change', (e) => {
  state.paused = e.target.checked;
  if (!state.paused) {
    const box = $('#live-list');
    box.scrollTop = box.scrollHeight;
  }
});

$('#live-clear').addEventListener('click', () => {
  state.buffer = [];
  renderLive();
});

let filterTimer = null;
$('#live-filter').addEventListener('input', (e) => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    state.filter = e.target.value.trim().toLowerCase();
    renderLive(false);
  }, 160);
});

// ------------------------------------------------------------ 检索页

function renderRoomOptions() {
  for (const id of ['#s-rid', '#b-rid', '#t-rid', '#lib-rid', '#f-rid']) {
    const sel = $(id);
    if (!sel) continue;
    const cur = sel.value;
    sel.textContent = '';
    sel.append(new Option('全部房间', ''));
    for (const r of state.rooms) sel.append(new Option(r.name || String(r.rid), String(r.rid)));
    sel.value = cur;
  }
}

$('#s-btn').addEventListener('click', runSearch);
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});
$('#s-rid').addEventListener('change', loadKeywords);

// 高频词推荐：当前房间最近 2 小时的头部词，点一下直接搜
async function loadKeywords() {
  const box = $('#s-keywords');
  if (!box) return;
  try {
    const rid = $('#s-rid').value;
    const d = await api(`/api/keywords?hours=2&limit=10${rid ? '&rid=' + rid : ''}`);
    box.textContent = '';
    if (!d.terms.length) {
      box.append(h('span', 'muted', '这个房间最近 2 小时还没有足够的高频词'));
      return;
    }
    const name = rid ? (state.rooms.find((r) => String(r.rid) === rid)?.name || rid) : '全部房间';
    box.append(h('span', 'muted', `${name} 最近 2 小时高频：`));
    for (const t of d.terms) {
      const chip = h('button', 'chip', t.term);
      chip.title = `出现 ${t.n} 次，点击检索`;
      chip.addEventListener('click', () => {
        $('#q').value = t.term;
        runSearch();
      });
      box.append(chip);
    }
  } catch (err) {
    box.textContent = '高频词加载失败：' + err.message;
  }
}

/** 把时间范围下拉换成 from 时间戳 */
function rangeFrom() {
  const v = $('#s-range').value;
  if (!v) return null;
  const now = Date.now();
  if (v === '1h') return now - 3600e3;
  if (v === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const days = Number(v.replace('d', ''));
  return now - days * 86400e3;
}

function searchParams() {
  const params = new URLSearchParams({
    q: $('#q').value.trim(),
    limit: '300',
    synonym: $('#s-syn').checked ? '1' : '0',
    cooccur: $('#s-cooc').checked ? '1' : '0',
  });
  if ($('#s-rid').value) params.set('rid', $('#s-rid').value);
  const from = rangeFrom();
  if (from) params.set('from', String(from));
  return params;
}

async function runSearch() {
  const q = $('#q').value.trim();
  if (!q) {
    toast('先输入关键词');
    return;
  }
  const btn = $('#s-btn');
  btn.disabled = true;
  btn.textContent = '检索中…';
  const summary = $('#s-summary');
  summary.textContent = '';
  summary.append(h('span', 'tag', '正在召回…'));

  try {
    const d = await api('/api/search?' + searchParams().toString());
    renderSummary(d);
    renderResults(d);
  } catch (err) {
    summary.textContent = '';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '检索';
  }
}

// 导出当前检索条件的所有命中（CSV）
$('#s-export').addEventListener('click', () => {
  const q = $('#q').value.trim();
  if (!q) {
    toast('先输入关键词');
    return;
  }
  toast('正在生成 CSV…');
  window.location.href = '/api/export/search?' + searchParams().toString();
});

function renderSummary(d) {
  const box = $('#s-summary');
  box.textContent = '';
  if (!d.ok) {
    box.append(h('span', 'tag', d.error || '没有结果'));
    return;
  }
  box.append(h('span', 'tag accent', `「${d.query}」共 ${fmtNum(d.total)} 条`));
  if (d.truncated) {
    box.append(h('span', 'tag note', `列表只显示最近 ${fmtNum(d.shown)} 条，导出 CSV 取全量`));
  }
  const numTag = (label, n) => {
    const el = h('span', 'tag', `${label} `);
    el.append(h('b', '', String(n)));
    return el;
  };
  box.append(numTag('精确', d.counts.exact || 0));
  if (d.counts.synonym) box.append(numTag('同义', d.counts.synonym));
  if (d.counts.cooccur) box.append(numTag('强相关', d.counts.cooccur));
  if (d.terms.length > 1) {
    for (const t of d.terms.slice(1)) box.append(h('span', 'tag', `扩展：${t}`));
  }
  if (d.cooccurTerms && d.cooccurTerms.length) {
    for (const c of d.cooccurTerms.slice(0, 6)) {
      box.append(h('span', 'tag', `共现：${c.term} ×${c.count}`));
    }
  }
  if (d.cooccurNote) box.append(h('span', 'tag note', d.cooccurNote));
  box.append(h('span', 'tag', `${d.took} ms`));
}

function renderResults(d) {
  const box = $('#s-results');
  box.textContent = '';
  const list = d.groups && d.groups.length ? d.groups : d.rows || [];
  if (!list.length) {
    const empty = h('div', 'empty');
    empty.append(h('p', 'big', '没有召回到弹幕'));
    empty.append(h('p', '', '换个词、关掉同义扩展，或先让采集多跑一会儿。'));
    box.append(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const row = h('div', 'result');
    const who = h('div', 'who');
    const nn = h('div', 'nn', r.nn || r.uid || '—');
    if (r.uid) nn.addEventListener('click', () => openUser(r.uid));
    who.append(nn);
    who.append(h('div', 'meta', r.room || `#${r.rid}`));
    const body = h('div', 'body');
    const txtLine = h('div', 'txt');
    txtLine.append(h('span', null, r.disp || r.txt));
    txtLine.append(favButton(r));
    body.append(txtLine);
    const why = h('div', 'why');
    const srcTag = sourceTag(r.source);
    if (srcTag) why.append(srcTag);
    // 计数放在命中原因前面：一句话被刷了多少条、多少人，是这行的主要信息
    if (r.n) {
      why.append(h('span', 'tag', `×${fmtNum(r.n)} 条 · ${fmtNum(r.users)} 人`));
    }
    const em = h('em', '', r.reason);
    why.append(document.createTextNode('命中：'), em);
    if (r.badge) why.append(document.createTextNode(` · ${r.badge}`));

    const detail = h('div', 'origin-box');
    const ask = h('button', 'origin-btn', '展开');
    ask.title = '看谁在发、本库最早是谁';
    ask.addEventListener('click', async () => {
      if (detail.dataset.open === '1') {
        detail.dataset.open = '0';
        detail.textContent = '';
        ask.textContent = '展开';
        return;
      }
      ask.textContent = '查询中…';
      try {
        const [o, s] = await Promise.all([
          api(`/api/origin?txt=${encodeURIComponent(r.stem || r.txt)}`),
          api(`/api/senders?stem=${encodeURIComponent(r.stem || r.txt)}&limit=12`),
        ]);
        detail.textContent = '';
        if (o.ok) {
          const f = o.first || {};
          const line = h('p', 'origin-line');
          line.append(document.createTextNode(`本库最早：${f.nn || f.uid} · `));
          if (f.cst) {
            const when = h('button', 'when-link', fmtTime(f.cst));
            when.title = '在时间线里看这前后 5 分钟';
            when.addEventListener('click', (ev) => {
              ev.stopPropagation();
              jumpToTimeline(Number(f.cst) - 150000, Number(f.cst) + 150000, f.rid);
            });
            line.append(when);
          } else {
            line.append(document.createTextNode('—'));
          }
          line.append(document.createTextNode(` · ${sourceName(f.source)}`));
          detail.append(line);
          detail.append(
            h(
              'p',
              'origin-line',
              `共 ${fmtNum(o.total)} 条 / ${fmtNum(o.users)} 人 · 其中被 +1 ${fmtNum(o.plusOne)} 次 · 弹幕潮 ${fmtNum(o.floods)} 次`
            )
          );
          detail.append(h('p', 'hint', o.note || ''));
        }
        if (s.ok && s.senders.length) {
          const wrap = h('div', 'senders');
          wrap.append(h('p', 'origin-line', `谁在发（${s.senders.length} 人）：`));
          for (const p of s.senders) {
            const chip = h('button', 'sender-chip', `${p.nn || p.uid}${p.n > 1 ? ' ×' + p.n : ''}`);
            chip.title = `${fmtTime(p.first)} ~ ${fmtTime(p.last)}`;
            chip.addEventListener('click', () => openUser(p.uid));
            wrap.append(chip);
          }
          detail.append(wrap);
        }
        detail.dataset.open = '1';
        ask.textContent = '收起';
      } catch (err) {
        ask.textContent = '展开';
        toast(err.message);
      }
    });
    body.append(why, ask, detail);
    const tm = h('div', 'tm', r.n > 1 ? `${fmtTime(r.last)} 最后` : fmtTime(r.cst || r.last));
    row.append(who, body, tm);
    frag.append(row);
  }
  box.append(frag);
}

// ------------------------------------------------------------ 排行榜

state.board = { mode: 'today', date: '', limit: 100 };

function todayStr() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function boardQuery() {
  const p = new URLSearchParams();
  p.set('limit', String(state.board.limit));
  // today / date / all 三种口径，服务端都有对应分支
  if (state.board.mode === 'all') p.set('today', '0');
  else if (state.board.mode === 'date') p.set('date', state.board.date || todayStr());
  const rid = $('#b-rid').value;
  if (rid) p.set('rid', rid);
  return p.toString();
}

/** 排行榜里用户名后面的小关注按钮（和「收藏」星标离得远一点，避免点错） */
let boardData = null;

function followChip(u) {
  const on = isFollowed(u.uid);
  const b = h('button', 'follow-chip' + (on ? ' on' : ''), on ? '已关注' : '＋关注');
  b.title = on ? '已关注（点一下取消）' : '关注这个人';
  b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    b.disabled = true;
    try {
      if (on) {
        confirmUnfollow({ uid: u.uid, nn: u.nn, total: u.n }, b);
      } else {
        const r = await api('/api/follows', {
          method: 'POST',
          body: JSON.stringify({ uid: u.uid, nn: u.nn || '' }),
        });
        if (r && r.ok) {
          await loadFollows();
          toast('已关注，左侧「其他关注」里能找到');
          if (boardData) renderBoard(boardData);
        }
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function renderBoard(d) {
  boardData = d;
  const ub = $('#b-users');
  const pb = $('#b-phrases');
  ub.textContent = '';
  pb.textContent = '';
  const scope = d.date
    ? (d.date === todayStr() ? `今天（${d.date}）00:00 起` : `${d.date} 全天`)
    : '全部时段';
  $('#b-users-meta').textContent = scope;
  $('#b-phrases-meta').textContent = scope;

  if (!d.users.length) ub.append(h('li', 'empty small', '这段时间还没人说话'));
  d.users.forEach((u, i) => {
    const li = h('li', 'board-row');
    li.append(h('span', 'rank', String(i + 1)));
    const a = h('button', 'board-name', u.nn || u.uid);
    a.title = `UID ${u.uid}`;
    a.addEventListener('click', () => openUser(u.uid));
    li.append(a);
    li.append(followChip(u));
    const meta = h('span', 'board-meta');
    meta.append(h('b', null, fmtNum(u.n)), document.createTextNode(' 条'));
    if (u.rooms > 1) meta.append(document.createTextNode(` · ${u.rooms} 个房间`));
    if (u.level) meta.append(document.createTextNode(` · Lv${u.level}`));
    li.append(meta);
    ub.append(li);
  });

  if (!d.phrases.length) pb.append(h('li', 'empty small', '还没有被 +1 的说法'));
  d.phrases.forEach((p, i) => {
    const li = h('li', 'board-row');
    li.append(h('span', 'rank', String(i + 1)));
    const a = h('button', 'board-name phrase', p.disp || p.sample || p.phrase);
    a.title = '拿这句话去检索';
    a.addEventListener('click', () => {
      $('#q').value = p.phrase;
      switchTab('search');
      runSearch();
    });
    li.append(a);
    const star = favButton({
      rid: Number($('#b-rid').value) || 0,
      stem: p.stem || p.phrase,
      txt: p.disp || p.sample || p.phrase,
      room: p.room || '',
      n: p.n,
      users: p.users,
    });
    star.classList.add('fav-sm');
    li.append(star);
    const meta = h('span', 'board-meta');
    meta.append(h('b', null, fmtNum(p.plusOne)), document.createTextNode(' 次 +1'));
    meta.append(document.createTextNode(` · 共 ${fmtNum(p.n)} 条 / ${fmtNum(p.users)} 人`));
    li.append(meta);
    pb.append(li);
  });
}

async function loadBoard() {
  try {
    renderBoard(await api(`/api/board?${boardQuery()}`));
  } catch (e) {
    const ub = $('#b-users');
    ub.textContent = '';
    ub.append(h('li', 'empty small', '读取失败：' + e.message));
  }
}

$('#b-btn').addEventListener('click', loadBoard);
$('#b-rid').addEventListener('change', loadBoard);
$('#b-limit').addEventListener('change', () => {
  state.board.limit = Number($('#b-limit').value) || 20;
  loadBoard();
});
$('#b-date').addEventListener('change', () => {
  state.board.date = $('#b-date').value;
  // 改日期就自动切到「指定日期」，不用再点一次模式
  if (state.board.date) {
    state.board.mode = 'date';
    $$('#b-range button').forEach((b) => b.classList.toggle('active', b.dataset.range === '1'));
  }
  loadBoard();
});
$('#b-range').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  const v = btn.dataset.range;
  state.board.mode = v === '0' ? 'all' : v === 'today' ? 'today' : 'date';
  if (state.board.mode === 'date' && !$('#b-date').value) $('#b-date').value = todayStr();
  state.board.date = $('#b-date').value;
  $('#b-date').disabled = state.board.mode === 'all';
  $$('#b-range button').forEach((b) => b.classList.toggle('active', b === btn));
  loadBoard();
});

// ------------------------------------------------------------ 口癖前后缀

state.affix = { prefixes: [], suffixes: [], presets: { prefixes: [], suffixes: [] }, dirty: false };

function affixHas(side, v) {
  return state.affix[side].includes(v);
}

function affixToggle(side, v) {
  const arr = state.affix[side];
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(v);
  state.affix.dirty = true;
  $('#affix-status').textContent = '有改动，点「保存并重算」生效';
  renderAffixes();
}

function chipEl(text, opts = {}) {
  const el = h('button', 'chip' + (opts.on ? ' on' : ''), text);
  el.title = opts.title || text;
  if (opts.onRemove) {
    const x = h('span', 'x', '×');
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onRemove();
    });
    el.append(x);
  }
  if (opts.onClick) el.addEventListener('click', opts.onClick);
  return el;
}

function renderAffixes() {
  const ps = $('#affix-preset-suffixes');
  const pp = $('#affix-preset-prefixes');
  const act = $('#affix-active');
  if (!ps) return;
  ps.textContent = '';
  pp.textContent = '';
  act.textContent = '';

  for (const p of state.affix.presets.suffixes || []) {
    ps.append(
      chipEl(p.label, {
        on: affixHas('suffixes', p.value),
        title: p.note,
        onClick: () => affixToggle('suffixes', p.value),
      })
    );
  }
  for (const p of state.affix.presets.prefixes || []) {
    pp.append(
      chipEl(p.label, {
        on: affixHas('prefixes', p.value),
        title: p.note,
        onClick: () => affixToggle('prefixes', p.value),
      })
    );
  }

  const all = [
    ...state.affix.prefixes.map((v) => ['prefixes', v]),
    ...state.affix.suffixes.map((v) => ['suffixes', v]),
  ];
  if (!all.length) act.append(h('span', 'muted small', '还没启用任何前后缀'));
  for (const [side, v] of all) {
    act.append(
      chipEl((side === 'prefixes' ? '开头 ' : '结尾 ') + v, {
        on: true,
        title: '点 × 移除',
        onRemove: () => affixToggle(side, v),
      })
    );
  }
}

async function loadAffixes() {
  try {
    const d = await api('/api/affixes');
    state.affix.presets = d.presets || { prefixes: [], suffixes: [] };
    state.affix.prefixes = (d.current && d.current.prefixes) || [];
    state.affix.suffixes = (d.current && d.current.suffixes) || [];
    state.affix.dirty = false;
    $('#affix-status').textContent = '';
    renderAffixes();
  } catch (e) {
    const st = $('#affix-status');
    if (st) st.textContent = '读取失败：' + e.message;
  }
}

$('#affix-add').addEventListener('click', () => {
  const v = $('#affix-input').value.trim();
  if (!v) return;
  const side = $('#affix-side').value === 'prefixes' ? 'prefixes' : 'suffixes';
  if (state.affix[side].includes(v)) {
    $('#affix-input').value = '';
    return;
  }
  state.affix[side].push(v);
  state.affix.dirty = true;
  $('#affix-input').value = '';
  $('#affix-status').textContent = '有改动，点「保存并重算」生效';
  renderAffixes();
});

$('#affix-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#affix-add').click();
});

$('#affix-save').addEventListener('click', async () => {
  const st = $('#affix-status');
  st.textContent = '重算中…';
  try {
    const d = await api('/api/affixes', {
      method: 'POST',
      body: JSON.stringify({ prefixes: state.affix.prefixes, suffixes: state.affix.suffixes }),
    });
    state.affix.dirty = false;
    st.textContent = `已生效：重算 ${fmtNum(d.changed)} 条（共 ${fmtNum(d.total)} 条，${d.took} ms）`;
    toast('前后缀已更新');
  } catch (e) {
    st.textContent = '保存失败：' + e.message;
  }
});

// ------------------------------------------------------------ 关注

let follows = [];

async function loadPrefs() {
  try {
    const d = await api('/api/prefs');
    const p = d.prefs && typeof d.prefs === 'object' ? d.prefs : {};
    state.prefs = {
      tlsel: p.tlsel && typeof p.tlsel === 'object' ? p.tlsel : {},
      fold: p.fold && typeof p.fold === 'object' ? p.fold : {},
    };
  } catch {
    state.prefs = { tlsel: {}, fold: {} };
  }
  renderFollows();
}

async function loadFollows() {
  try {
    follows = (await api('/api/follows')).items || [];
  } catch {
    follows = [];
  }
  renderFollows();
}

function isFollowed(uid) {
  return follows.some((f) => String(f.uid) === String(uid));
}

function renderFollows() {
  const fold = (state.prefs && state.prefs.fold) || {};
  const normals = follows.filter((f) => !f.special);
  const specials = follows.filter((f) => f.special);

  const sc = $('#follow-special-count');
  if (sc) sc.textContent = specials.length;
  const sbox = $('#follow-special-list');
  if (sbox) {
    const shut = !!fold.special;
    sbox.hidden = shut;
    const btn = $('#fold-special');
    if (btn) {
      btn.textContent = shut ? '▶' : '▼';
      btn.setAttribute('aria-expanded', shut ? 'false' : 'true');
    }
    sbox.textContent = '';
    if (!specials.length) sbox.append(h('p', 'muted small', '还没有。在右边用户页点「关注」，再点「已关注」→「设为特别关注」。'));
    else for (const f of specials) sbox.append(followItem(f));
  }

  const box = $('#follow-list');
  if (!box) return;
  const cnt = $('#follow-count');
  if (cnt) cnt.textContent = normals.length;
  const shut2 = !!fold.normal;
  box.hidden = shut2;
  const btn2 = $('#fold-normal');
  if (btn2) {
    btn2.textContent = shut2 ? '▶' : '▼';
    btn2.setAttribute('aria-expanded', shut2 ? 'false' : 'true');
  }
  box.textContent = '';
  if (!normals.length) {
    box.append(h('p', 'muted small', '还没有其他关注。在右边用户页里点「关注」，就会出现在这里。'));
    return;
  }
  for (const f of normals) box.append(followItem(f));
}

/** 折叠 / 展开关注卡，状态存服务端 prefs（两个窗口同步） */
function toggleFold(which) {
  state.prefs = state.prefs || { tlsel: {}, fold: {} };
  state.prefs.fold = state.prefs.fold || {};
  state.prefs.fold[which] = !state.prefs.fold[which];
  renderFollows();
  savePrefsSoon();
}

/** 关注列表里的一行（特别关注卡和关注卡共用）
 *  特别关注卡里的按钮是「取消特别关注」（降级回普通关注），
 *  普通关注卡里才是「取消关注」（彻底移除，带二次确认）。 */
function followItem(f) {
  const item = h('div', 'follow-item');
  const name = h('button', 'follow-name', f.nn || f.uid);
  name.title = `UID ${f.uid}` + (f.special ? '（特别关注）' : '');
  name.addEventListener('click', () => openUser(f.uid));
  const sub = h('div', 'follow-sub');
  sub.append(h('span', null, `${fmtNum(f.total)} 条`));
  if (f.last_at) sub.append(h('span', null, `最近 ${ago(f.last_at)}`));

  const act = h('button', 'follow-act', f.special ? '取消特别关注' : '取消关注');
  act.title = f.special ? '不取消关注，只是移回「其他关注」' : '取消关注（会从列表里移除）';
  act.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (f.special) {
      act.disabled = true;
      try {
        await setSpecial(f.uid, false);
      } catch (err) {
        toast(err.message, true);
      } finally {
        act.disabled = false;
      }
      return;
    }
    confirmUnfollow(f, act);
  });

  const main = h('div', 'follow-main');
  main.append(name, sub);
  item.append(main, act);
  return item;
}

/** 取消关注前的确认：防止手滑点掉一条关注 */
function confirmUnfollow(f, btn) {
  showModal('取消关注', f.nn || f.uid || '这个人', (body) => {
    const info = h('div', 'del-info');
    info.append(
      h('div', 'del-line', '不会删除 TA 的弹幕，只是从你的关注列表里移掉。'),
      h('div', 'del-line', '以后想再加回来，去用户页点一次「关注」就行。')
    );
    const foot = h('div', 'modal-foot');
    const cancel = h('button', 'btn ghost', '取消');
    cancel.addEventListener('click', closeModal);
    const ok = h('button', 'btn danger', '取消关注');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        await api('/api/follows/' + encodeURIComponent(f.uid), { method: 'DELETE' });
        follows = follows.filter((y) => String(y.uid) !== String(f.uid));
        renderFollows();
        refreshFollowBtn();
        toast('已取消关注');
        closeModal();
      } catch (err) {
        toast(err.message, true);
        ok.disabled = false;
      }
    });
    foot.append(cancel, ok);
    body.append(info, foot);
    setTimeout(() => cancel.focus(), 30);
  });
}

async function setSpecial(uid, special) {
  await api('/api/follows/' + encodeURIComponent(uid) + '/special', {
    method: 'POST',
    body: JSON.stringify({ special }),
  });
  await loadFollows();
  refreshFollowBtn();
  toast(special ? '已设为特别关注' : '已取消特别关注');
}

/** 「已关注」按钮上的小菜单：取消关注 / 特别关注 */
let followMenuEl = null;

function closeFollowMenu() {
  if (followMenuEl && followMenuEl.parentNode) followMenuEl.parentNode.removeChild(followMenuEl);
  followMenuEl = null;
}

function openFollowMenu(btn, d) {
  closeFollowMenu();
  const on = follows.find((f) => String(f.uid) === String(d.uid)) || {};
  const menu = h('div', 'follow-menu');
  const sp = h('button', 'follow-menu-item', on.special ? '取消特别关注' : '设为特别关注');
  sp.addEventListener('click', async () => {
    closeFollowMenu();
    try {
      await setSpecial(d.uid, !on.special);
    } catch (err) {
      toast(err.message, true);
    }
  });
  const un = h('button', 'follow-menu-item danger', '取消关注');
  un.addEventListener('click', async () => {
    closeFollowMenu();
    try {
      await toggleFollow(d.uid, (d.names && d.names[0]) || '');
    } catch (err) {
      toast(err.message, true);
    }
  });
  menu.append(sp, un);

  const r = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  document.body.append(menu);
  followMenuEl = menu;

  setTimeout(() => {
    const off = (ev) => {
      if (followMenuEl && !followMenuEl.contains(ev.target)) {
        closeFollowMenu();
        document.removeEventListener('pointerdown', off, true);
      }
    };
    document.addEventListener('pointerdown', off, true);
  }, 0);
}

function toggleFollow(uid, nn) {
  if (isFollowed(uid)) {
    return api('/api/follows/' + encodeURIComponent(uid), { method: 'DELETE' }).then(() => {
      follows = follows.filter((f) => String(f.uid) !== String(uid));
      renderFollows();
      refreshFollowBtn();
      toast('已取消关注');
    });
  }
  return api('/api/follows', {
    method: 'POST',
    body: JSON.stringify({ uid, nn: nn || '' }),
  }).then(() => loadFollows().then(() => {
    refreshFollowBtn();
    toast('已关注，可以在这里直接点名字看 TA');
  }));
}

let curProfile = null;

function refreshFollowBtn() {
  const b = $('#u-follow');
  if (!b || !curProfile) return;
  const on = isFollowed(curProfile.uid);
  const sp = on && follows.some((f) => String(f.uid) === String(curProfile.uid) && f.special);
  b.textContent = on ? (sp ? '已关注 ★' : '已关注') : '关注';
  b.classList.toggle('on', on);
  b.title = on ? '点这里可以取消关注，或设为特别关注' : '关注后会在左侧「关注」列表里，点名字直接看';
}

function followButton(d) {
  const on0 = isFollowed(d.uid);
  const sp0 = on0 && follows.some((f) => String(f.uid) === String(d.uid) && f.special);
  const b = h('button', 'btn ghost' + (on0 ? ' on' : ''), on0 ? (sp0 ? '已关注 ★' : '已关注') : '关注');
  b.id = 'u-follow';
  b.title = on0 ? '点这里可以取消关注，或设为特别关注' : '关注后会在左侧「关注」列表里，点名字直接看';
  b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    b.disabled = true;
    try {
      if (isFollowed(d.uid)) openFollowMenu(b, d);
      else await toggleFollow(d.uid, (d.names && d.names[0]) || '');
    } catch (err) {
      toast(err.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

// ------------------------------------------------------------ 画像页

function openUser(uid) {
  switchTab('user');
  $('#uid').value = uid;
  runProfile(uid);
}

$('#follow-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = $('#follow-search').value.trim();
  if (v) openUser(v);
});

for (const [id, which] of [['#fold-special', 'special'], ['#fold-normal', 'normal']]) {
  const el = $(id);
  if (el) el.addEventListener('click', () => toggleFold(which));
}

$('#u-btn').addEventListener('click', () => runProfile($('#uid').value.trim()));
$('#uid').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runProfile($('#uid').value.trim());
});

async function runProfile(uid) {
  if (!uid) {
    toast('请输入 UID 或昵称');
    return;
  }
  const btn = $('#u-btn');
  btn.disabled = true;
  btn.textContent = '分析中…';
  try {
    const d = await api('/api/users/' + encodeURIComponent(uid));
    renderProfile(d);
  } catch (err) {
    renderProfileError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '分析';
  }
}

function renderProfileError(msg) {
  const box = $('#u-result');
  box.textContent = '';
  const empty = h('div', 'empty');
  empty.append(h('p', 'big', '没有可分析的数据'));
  empty.append(h('p', '', msg));
  empty.append(h('p', 'muted small', '确认 UID 正确，并确保本工具在该用户发言期间正在采集这个直播间。'));
  box.append(empty);
}

const DIM = COPY.DIM;

const LABEL_TONE = {
  loyal: 'hot', roam: '', repeat: '', toxic: 'bad', ad: 'bad',
  lotto: 'warn', night: '', talker: 'hot', lurk: '', bot: 'bad', thin: 'warn',
};

// ---------------- 通用浮层（居中、可拖动、内容可滚动） ----------------

let modalEl = null;

function closeModal() {
  if (!modalEl) return;
  modalEl.remove();
  modalEl = null;
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modalEl) closeModal();
});

function showModal(title, sub, buildBody) {
  closeModal();
  const mask = h('div', 'modal-mask');
  const dlg = h('div', 'modal');
  const head = h('div', 'modal-head');
  const titles = h('div', 'modal-titles');
  titles.append(h('span', 'modal-title', title));
  if (sub) titles.append(h('span', 'modal-sub', sub));
  const x = h('button', 'modal-x', '✕');
  x.title = '关闭（Esc）';
  x.addEventListener('click', closeModal);
  head.append(titles, x);
  const body = h('div', 'modal-body');
  buildBody(body);
  dlg.append(head, body);
  mask.append(dlg);
  document.body.append(mask);
  modalEl = mask;

  // 先量一次尺寸再定位到屏幕中间
  const place = () => {
    const r = dlg.getBoundingClientRect();
    dlg.style.left = `${Math.max(12, (window.innerWidth - r.width) / 2)}px`;
    dlg.style.top = `${Math.max(12, (window.innerHeight - r.height) / 2)}px`;
  };
  place();

  // 按住标题栏拖动（用 pointer capture，指针移出窗口也不会丢）
  let drag = null;
  head.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.modal-x')) return;
    const r = dlg.getBoundingClientRect();
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    dlg.classList.add('dragging');
    try {
      head.setPointerCapture(ev.pointerId);
    } catch {
      /* 合成事件没有真实指针 */
    }
  });
  head.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = dlg.getBoundingClientRect();
    const left = Math.min(Math.max(4, ev.clientX - drag.dx), window.innerWidth - r.width - 4);
    const top = Math.min(Math.max(4, ev.clientY - drag.dy), window.innerHeight - 48);
    dlg.style.left = `${left}px`;
    dlg.style.top = `${top}px`;
  });
  const endDrag = (ev) => {
    if (!drag) return;
    drag = null;
    dlg.classList.remove('dragging');
    try {
      head.releasePointerCapture(ev.pointerId);
    } catch {
      /* 忽略 */
    }
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) closeModal();
  });
  return body;
}

function showHostility(d) {
  const hs = d.hostility || {};
  const rows = hs.rows || [];
  showModal(
    '对立发言',
    `直接 ${hs.direct} 条 · 拱火 ${hs.rhythm} 条 · 共 ${hs.total} 条`,
    (body) => {
      if (!rows.length) {
        body.append(h('p', 'muted small', '没有记录'));
        return;
      }
      body.append(
        h(
          'p',
          'muted small modal-note',
          '直接＝含明确攻击词；拱火＝带节奏、嘲讽、反串（阵营词本身不算，要同句有挑事语气）。按时间倒序。'
        )
      );
      const list = h('div', 'modal-list');
      for (const m of rows) {
        const line = h('div', 'modal-row');
        line.append(h('span', 'msg-t', `${fmtDate(m.cst).slice(5)} ${fmtTime(m.cst)}`));
        line.append(h('span', `tag tiny ${m.kind === 'direct' ? 'bad' : 'warn'}`, m.kind === 'direct' ? '直接' : '拱火'));
        line.append(h('span', 'msg-x', m.txt));
        list.append(line);
      }
      body.append(list);
    }
  );
}

function renderProfile(d) {
  const box = $('#u-result');
  box.textContent = '';
  if (!d.ok) return renderProfileError(d.error || '未找到该用户');
  curProfile = d;

  const head = h('div', 'pf-head');
  const av = h('div', 'avatar', (d.names[0] || d.uid).slice(0, 1).toUpperCase());
  const meta = h('div');
  meta.append(h('div', 'names', d.names.join(' / ') || d.uid));
  meta.append(h('div', 'ids', `UID ${d.uid} · 采集覆盖 ${d.range.spanDays} 天 / ${d.range.days} 个活跃日 · 共 ${fmtNum(d.total)} 条`));
  if (d.sources && (d.sources.vod > 0 || d.sources.import > 0)) {
    const bits = [`直播采集 ${fmtNum(d.sources.live)} 条`];
    if (d.sources.vod > 0) bits.push(`录播 ${fmtNum(d.sources.vod)} 条`);
    if (d.sources.import > 0) bits.push(`导入 ${fmtNum(d.sources.import)} 条`);
    meta.append(h('div', 'ids', `其中${bits.join(' · ')}`));
  }
  head.append(av, meta, h('div', 'spacer'));

  const sumTag = h('div', 'tag accent', `最近发言 ${ago(d.range.last)}`);
  head.append(sumTag);

  const expBtn = h('button', 'btn ghost', '导出 CSV');
  expBtn.addEventListener('click', () => {
    window.location.href = '/api/export/user/' + encodeURIComponent(d.uid);
  });
  head.append(followButton(d), expBtn);
  box.append(head);

  const grid = h('div', 'pf-grid');

  // 左：评分 + 标签
  const left = h('div', 'card');
  left.append(h('h2', null, '行为特征'));
  const scores = h('div', 'scores');
  for (const [k, name] of Object.entries(DIM)) {
    const row = h('div', 'score-row');
    row.append(h('span', 'muted', name));
    const bar = h('div', 'bar');
    const fill = h('i');
    fill.style.width = `${Math.max(2, d.scores[k] || 0)}%`;
    bar.append(fill);
    row.append(bar);
    row.append(h('span', 'v', String(d.scores[k] || 0)));
    scores.append(row);
  }
  left.append(scores);

  left.append(h('h2', null, ''));
  const labHead = h('h2');
  labHead.textContent = '行为标签';
  labHead.style.marginTop = '18px';
  left.append(labHead);

  const labels = h('div', 'labels');
  if (!d.labels.length) labels.append(h('span', 'muted small', '暂无明显标签'));
  for (const l of d.labels) {
    const chip = h('span', 'label ' + (LABEL_TONE[l.key] || ''), l.label);
    chip.title = l.desc;
    labels.append(chip);
  }
  left.append(labels);

  const dl = h('dl', 'kv');
  dl.style.marginTop = '18px';
  const rows = [
    ['日均发言', d.stats.perDay + ' 条'],
    ['平均长度', d.stats.avgLen + ' 字'],
    ['重复率', Math.round(d.stats.repeatRatio * 100) + '%'],
    ['短文本占比', Math.round(d.stats.shortRatio * 100) + '%'],
    ['夜间(0-6点)', Math.round(d.stats.nightRatio * 100) + '%'],
    ['发言间隔变异', d.stats.intervalCv],
    ['去过的房间', d.stats.rooms + ' 个'],
    ['送礼/事件', d.stats.gifts + ' 次'],
  ];
  if (d.hostility && d.hostility.total) {
    const h0 = d.hostility;
    rows.push(['对立发言', `直接 ${h0.direct} 条 · 拱火 ${h0.rhythm} 条`]);
  }
  if (d.flood && d.flood.total) {    rows.push(['弹幕潮参与', `${Math.round((d.flood.share || 0) * 100)}%（${fmtNum(d.flood.inFlood)} 条）`]);
  }
  if (d.coverage && d.coverage.effectiveHours) {
    const span = d.coverage.spanHours;
    rows.push(['发言时间跨度', span >= 1 ? `${span} 小时` : `${Math.round(span * 60)} 分钟`]);
    if (d.coverage.gapCount) rows.push(['采集缺口', `${d.coverage.gapCount} 处 / ${d.coverage.gapMinutes} 分钟`]);
    if (d.coverage.downtimeCount) {
      rows.push(['其中程序未运行', `${d.coverage.downtimeCount} 处 / ${d.coverage.downtimeMinutes} 分钟`]);
    }
  }
  for (const [k, v] of rows) {
    const dt = h('dt', null, k);
    if (k === '对立发言') {
      const dd = h('dd');
      const btn = h('button', 'when-link', `${v} · 看原话`);
      btn.addEventListener('click', () => showHostility(d));
      dd.append(btn);
      dl.append(dt, dd);
    } else {
      dl.append(dt, h('dd', null, v));
    }
  }
  left.append(dl);
  if (d.coverage && d.coverage.partial) {
    const warn = h('p', 'hint note-gap', COPY.NOTE.gap);
    warn.style.marginTop = '12px';
    left.append(warn);
  }
  grid.append(left);

  // 右：房间分布 + 活跃时段 + 高频句
  const right = h('div');
  right.style.display = 'flex';
  right.style.flexDirection = 'column';
  right.style.gap = '16px';

  const roomCard = h('div', 'card');
  roomCard.append(h('h2', null, '房间分布'));
  const rb = h('div', 'roombars');
  for (const r of d.rooms.slice(0, 6)) {
    const bar = h('div', 'roombar');
    bar.append(h('span', 'n', r.name || `#${r.rid}`));
    bar.append(h('span', 'muted', `${Math.round(r.share * 100)}%`));
    const track = h('div', 'track');
    const fill = h('i');
    fill.style.width = `${Math.max(2, r.share * 100)}%`;
    track.append(fill);
    bar.append(track);
    bar.title = `${r.n} 条`;
    rb.append(bar);
  }
  if (!d.rooms.length) rb.append(h('span', 'muted small', '无数据'));
  roomCard.append(rb);
  right.append(roomCard);

  const hourCard = h('div', 'card');
  hourCard.append(h('h2', null, '活跃时段（按小时）'));
  const maxH = Math.max(1, ...d.hourly);
  const hours = h('div', 'hours');
  d.hourly.forEach((n, i) => {
    const col = h('div', 'hbar');
    const num = h('b', null, n ? String(n) : '');
    const bar = h('i');
    bar.style.height = `${Math.max(2, (n / maxH) * 100)}%`;
    bar.title = `${pad(i)}:00 · ${n} 条`;
    col.append(num, bar);
    if (n > 0) {
      col.classList.add('clickable');
      col.title = `${pad(i)}:00 · ${n} 条 · 点击在时间线里看这一小时`;
      col.addEventListener('click', () => {
        const base = dayStart(d.range.last || Date.now());
        jumpToTimeline(base + i * 3600000, base + (i + 1) * 3600000, 0);
      });
    }
    hours.append(col);
  });
  hourCard.append(hours);
  const ticks = h('div', 'hours-ticks');
  for (let i = 0; i < 24; i++) {
    const t = h('span', null, pad(i));
    t.title = `${pad(i)}:00 · ${d.hourly[i] || 0} 条`;
    if (d.hourly[i]) {
      t.classList.add('clickable');
      t.addEventListener('click', () => {
        const base = dayStart(d.range.last || Date.now());
        jumpToTimeline(base + i * 3600000, base + (i + 1) * 3600000, 0);
      });
    }
    ticks.append(t);
  }
  hourCard.append(ticks);
  hourCard.append(h('div', 'muted small', '0 点 → 23 点 · 点柱子看那一小时'));
  right.append(hourCard);

  const topicCard = h('div', 'card');
  topicCard.append(h('h2', null, '发得最多的一类'));
  const tb = h('div', 'roombars');
  const topTopic = (d.topics || []).slice(0, 6);
  for (const t of topTopic) {
    const bar = h('div', 'roombar');
    bar.append(h('span', 'n', t.name));
    bar.append(h('span', 'muted', `${Math.round(t.share * 100)}%`));
    const track = h('div', 'track');
    const fill = h('i');
    fill.style.width = `${Math.max(2, t.share * 100)}%`;
    track.append(fill);
    bar.append(track);
    bar.title = `${t.n} 条`;
    tb.append(bar);
  }
  if (!topTopic.length) tb.append(h('span', 'muted small', '无数据'));
  topicCard.append(tb);
  topicCard.append(h('p', 'hint', COPY.NOTE.notIdentity));
  right.append(topicCard);

  const topCard = h('div', 'card');
  topCard.append(h('h2', null, '高频发言'));
  const tl = h('div', 'list-msgs');
  if (!d.topTexts.length) tl.append(h('span', 'muted small', '无'));
  for (const t of d.topTexts.slice(0, 10)) {
    const line = h('div');
    line.append(h('span', 't', `×${t.n}`));
    line.append(h('span', '', t.txt));
    tl.append(line);
  }
  topCard.append(tl);
  right.append(topCard);

  grid.append(right);
  box.append(grid);

  // 历史弹幕（按天）
  const dayCard = h('div', 'card');
  dayCard.append(h('h2', null, '活跃分布（按天）'));
  const days = (d.daily || []).slice().reverse();
  const openDay = (day) => {
    const [y, m, dd] = day.split('-');
    const from = new Date(`${y}-${m}-${dd}T00:00:00`).getTime();
    jumpToTimeline(from, from + 86400000 - 60000, 0);
  };
  if (!days.length) {
    dayCard.append(h('p', 'muted small', '没有数据'));
  } else if (days.length === 1) {
    // 只有一天的话画柱状图会是一根孤零零的柱子，不如直接给一行可点的字
    const one = h('button', 'when-link', `${days[0].day} · ${fmtNum(days[0].n)} 条`);
    one.addEventListener('click', () => openDay(days[0].day));
    const line = h('p', 'muted small', '只有一天有发言：');
    line.append(one, h('span', null, ' · 点它看那一天的时间线'));
    dayCard.append(line);
  } else {
    const maxD = Math.max(1, ...days.map((x) => x.n));
    const wrap = h('div', 'daybars');
    for (const x of days) {
      const col = h('div', 'daybar');
      const bar = h('i');
      bar.style.height = `${Math.max(2, (x.n / maxD) * 100)}%`;
      col.title = `${x.day} · ${x.n} 条 · 点击在时间线里看这一天`;
      col.append(bar);
      col.addEventListener('click', () => openDay(x.day));
      wrap.append(col);
    }
    dayCard.append(wrap);
    const axis = h('div', 'dayaxis');
    axis.append(h('span', null, days[0].day.slice(5)));
    axis.append(h('span', null, days[days.length - 1].day.slice(5)));
    dayCard.append(axis);
    dayCard.append(h('p', 'muted small', `共 ${days.length} 天有发言 · 最多一天 ${fmtNum(maxD)} 条 · 点柱子看那一天`));
  }
  box.append(dayCard);

  // 历史弹幕：这个用户的全部弹幕，按时间倒序，不聚合、不查重
  const histCard = h('div', 'card');
  const histHead = h('div', 'hist-head');
  const histTitle = h('h2', null, '历史弹幕');
  const histQ = h('input', 'text-input hist-q');
  histQ.id = 'u-hist-q';
  histQ.type = 'search';
  histQ.placeholder = '在这个用户的弹幕里搜…';
  histQ.setAttribute('aria-label', '在这个用户的弹幕里搜');
  histHead.append(histTitle, histQ);
  histCard.append(histHead);
  const histList = h('div', 'msg-list');
  const histScroll = h('div', 'msg-scroll');
  histScroll.append(histList);
  const histFoot = h('div', 'msg-foot');
  histCard.append(histScroll, histFoot);
  box.append(histCard);

  const hist = { uid: d.uid, before: 0, total: d.total || 0, totalAll: d.total || 0, loaded: 0, done: false, busy: false, q: '' };

  // 把命中的子串包成 <mark>；不区分大小写，中文直接按子串切
  const markText = (txt, kw) => {
    const frag = document.createDocumentFragment();
    const s = String(txt || '');
    if (!kw) {
      frag.append(document.createTextNode(s));
      return frag;
    }
    const lower = s.toLowerCase();
    const k = kw.toLowerCase();
    let i = 0;
    let at = lower.indexOf(k, i);
    while (at !== -1) {
      if (at > i) frag.append(document.createTextNode(s.slice(i, at)));
      frag.append(h('mark', null, s.slice(at, at + kw.length)));
      i = at + kw.length;
      at = lower.indexOf(k, i);
    }
    frag.append(document.createTextNode(s.slice(i)));
    return frag;
  };

  const msgRow = (m) => {
    const line = h('div', 'msg-row');
    line.append(h('span', 'msg-t', `${fmtDate(m.cst).slice(5)} ${fmtTime(m.cst)}`));
    if (m.topic && COPY.TOPIC[m.topic]) line.append(h('span', 'tag tiny', COPY.TOPIC[m.topic]));
    else line.append(h('span'));
    const mtag = sourceTag(m.source, true);
    line.append(mtag || h('span'));
    const x = h('span', 'msg-x');
    x.append(markText(m.txt, hist.q));
    line.append(x);
    return line;
  };
  const histLabel = () => {
    histTitle.textContent = hist.q
      ? `历史弹幕（匹配「${hist.q}」${fmtNum(hist.total)} 条 · 已显示 ${fmtNum(hist.loaded)} 条）`
      : `历史弹幕（全部 ${fmtNum(hist.total)} 条 · 已显示 ${fmtNum(hist.loaded)} 条）`;
  };
  const histRenderFoot = () => {
    histFoot.replaceChildren();
    if (!hist.total) {
      histFoot.append(
        h('span', 'muted small', hist.q ? `这个用户没说过包含「${hist.q}」的话` : '没有记录')
      );
      return;
    }
    if (hist.done) {
      const scrollable = histScroll.scrollHeight > histScroll.clientHeight + 4;
      histFoot.append(
        h('span', 'muted small', scrollable ? `已全部显示 ${fmtNum(hist.loaded)} 条 · 往上滚看更早的` : `共 ${fmtNum(hist.loaded)} 条`)
      );
    } else {
      const more = h('button', 'btn ghost', '加载更多');
      more.addEventListener('click', () => histLoad().catch(() => {}));
      histFoot.append(more, h('span', 'muted small', `还有 ${fmtNum(Math.max(0, hist.total - hist.loaded))} 条 · 滚到底会自动加载`));
    }
  };
  // 内容没超过一屏就不做底部渐隐（短列表被糊掉很难看）
  function syncHistFade() {
    histScroll.classList.toggle('more', histScroll.scrollHeight > histScroll.clientHeight + 4);
  }
  window.addEventListener('resize', syncHistFade);

  async function histLoad(reset) {
    if (hist.busy) return;
    if (reset) {
      hist.before = 0;
      hist.loaded = 0;
      hist.done = false;
      histList.replaceChildren();
      histScroll.scrollTop = 0;
    }
    if (hist.done) return;
    hist.busy = true;
    try {
      const qs = new URLSearchParams({ limit: '200' });
      if (hist.before) qs.set('before', String(hist.before));
      if (hist.q) qs.set('q', hist.q);
      const r = await api(`/api/users/${encodeURIComponent(hist.uid)}/messages?${qs.toString()}`);
      hist.total = r.total;
      hist.totalAll = r.totalAll != null ? r.totalAll : r.total;
      for (const m of r.rows) histList.append(msgRow(m));
      hist.loaded += r.rows.length;
      hist.before = r.nextBefore;
      hist.done = !r.hasMore || !r.rows.length;
      histLabel();
      histRenderFoot();
      syncHistFade();
    } finally {
      hist.busy = false;
    }
  }

  // 输入「停 300ms」才查，避免每敲一个字扫一遍库
  let histTimer = 0;
  const histSearch = () => {
    hist.q = histQ.value.trim();
    histLoad(true).catch(() => {});
  };
  histQ.addEventListener('input', () => {
    clearTimeout(histTimer);
    histTimer = setTimeout(histSearch, 300);
  });
  histQ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(histTimer);
      histSearch();
    } else if (e.key === 'Escape') {
      clearTimeout(histTimer);
      histQ.value = '';
      histSearch();
    }
  });
  histScroll.addEventListener('scroll', () => {
    if (!hist.done && histScroll.scrollTop + histScroll.clientHeight >= histScroll.scrollHeight - 60) {
      histLoad().catch(() => {});
    }
  });
  histLabel();
  histFoot.append(h('span', 'muted small', '读取中…'));
  histLoad().catch((err) => {
    histFoot.replaceChildren(h('span', 'muted small', '加载失败：' + err.message));
  });

  // 证据
  const evCard = h('div', 'card');
  evCard.append(h('h2', null, '判定依据（可回溯到原始弹幕）'));
  const ev = h('div', 'evidence');
  for (const l of d.labels.filter((x) => x.evidence.length)) {
    const block = h('div');
    const title = h('div', 'ev');
    title.style.borderLeftColor = 'var(--accent)';
    const strong = h('b', '', l.label);
    title.append(strong, document.createTextNode(`　${l.desc}`));
    block.append(title);
    for (const e of l.evidence) {
      const line = h('div', 'ev');
      line.append(h('div', 'q', e.txt));
      line.append(h('div', 'm', `${fmtDate(e.cst)} ${fmtTime(e.cst)}`));
      block.append(line);
    }
    ev.append(block);
  }
  if (!ev.childElementCount) ev.append(h('span', 'muted small', '缺少足够证据'));
  evCard.append(ev);
  box.append(evCard);
}

// ------------------------------------------------------------ 设置页

async function loadSettings() {
  try {
    const s = await api('/api/stats');
    const info = $('#set-info');
    info.textContent = '';
    const rows = [
      ['数据库大小', fmtBytes(s.dbBytes)],
      ['累计弹幕', fmtNum(s.total)],
      ['今日弹幕', fmtNum(s.today)],
      ['用户数', fmtNum(s.users)],
      ['最早记录', s.first ? fmtDate(s.first) : '—'],
      ['最新记录', s.last ? fmtDate(s.last) : '—'],
    ];
    if (s.runtime) {
      rows.push(['上次自动清理', s.runtime.lastPruneAt ? fmtDate(s.runtime.lastPruneAt) : '还没跑过（启动 1 分钟后首次）']);
      rows.push([
        '去重计数',
        `指纹 ${fmtNum(s.runtime.dropped)} · 补发 ${fmtNum(s.runtime.replayDropped)} · 迟到帧 ${fmtNum(s.runtime.lateFrames)}`,
      ]);
      rows.push(['待落库缓冲', `${fmtNum(s.runtime.buffered)} 条`]);
      rows.push(['WAL / 内存', `${fmtBytes(s.runtime.walBytes)} / ${fmtBytes(s.runtime.rssBytes)}`]);
    }
    for (const [k, v] of rows) info.append(h('dt', null, k), h('dd', null, v));
    syncRetentionUI(s.runtime ? s.runtime.retentionDays : 90);
    renderSetRooms();
    loadVod();
    loadUISettings();
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------ 收藏夹
const fav = { items: [], keys: new Set() };

const favKey = (r) => `${Number(r.rid)}|${r.stem || r.txt || ''}`;

function syncFavKeys() {
  fav.keys = new Set(fav.items.map((f) => `${Number(f.rid)}|${f.stem}`));
}

async function loadFavorites() {
  try {
    const d = await api('/api/favorites');
    fav.items = d.items || [];
    syncFavKeys();
    renderFavorites();
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleFavorite(r) {
  const key = favKey(r);
  let hit = fav.items.find((f) => `${Number(f.rid)}|${f.stem}` === key);
  // rid=0（「全部房间」）收藏时后端会补成真实房间，下标的 key 已经换过，
  // 但这里拿到的 r.rid 还是 0 —— 退一步按说法再找一次，否则会重复收藏而不是取消。
  if (!hit && !Number(r.rid)) {
    const stem = r.stem || r.txt;
    hit = fav.items.find((f) => f.stem === stem);
  }
  if (hit) {
    await api(`/api/favorites/${hit.id}`, { method: 'DELETE' });
    fav.items = fav.items.filter((f) => f.id !== hit.id);
    toast('已取消收藏');
  } else {
    const d = await api('/api/favorites', {
      method: 'POST',
      body: JSON.stringify({
        rid: r.rid,
        stem: r.stem || r.txt,
        txt: r.disp || r.txt,
        roomName: r.room || '',
        uid: r.uid || '',
        nn: r.nn || '',
        cst: r.cst || 0,
      }),
    });
    // rid=0（排行榜/时间线的「全部房间」）会被后端补成真实房间，
    // 星标的 key 也必须跟着换，否则图标永远停在 ☆。
    const realRid = Number(d.rid ?? r.rid) || 0;
    fav.items.unshift({
      id: d.id,
      rid: realRid,
      stem: r.stem || r.txt,
      txt: r.disp || r.txt,
      room_name: r.room || '',
      note: '',
      created_at: Date.now(),
      hits: r.n || 0,
      users: r.users || 0,
    });
    if (realRid !== Number(r.rid)) {
      const nextKey = `${realRid}|${r.stem || r.txt}`;
      for (const b of document.querySelectorAll(`.fav[data-key="${CSS.escape(key)}"]`)) {
        b.dataset.key = nextKey;
      }
    }
    toast('已收藏，可以在「收藏夹」里找到');
  }
  syncFavKeys();
  renderFavorites();
  refreshFavButtons();
}

/** 收藏状态变了以后，把页面上所有星标重新刷一遍（不只当前点的那一个） */
function refreshFavButtons() {
  for (const b of document.querySelectorAll('.fav[data-key]')) {
    const on = fav.keys.has(b.dataset.key);
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
    b.title = on ? '取消收藏' : '收藏这句';
  }
}

/** 结果行右侧的星标：点一下收藏 / 取消 */
function favButton(r) {
  const key = favKey(r);
  const on = fav.keys.has(key);
  const b = h('button', 'fav' + (on ? ' on' : ''), on ? '★' : '☆');
  b.dataset.key = key;
  b.title = on ? '取消收藏' : '收藏这句';
  b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    b.disabled = true;
    try {
      await toggleFavorite(r);
    } catch (err) {
      toast(err.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function favSearch(item) {
  switchTab('search');
  const q = $('#q');
  if (q) q.value = item.stem || item.txt;
  const ridSel = $('#s-rid');
  if (ridSel) ridSel.value = String(item.rid);
  runSearch();
}

function renderFavorites() {
  const box = $('#f-list');
  if (!box) return;
  box.textContent = '';
  const ridSel = $('#f-rid');
  const want = ridSel && ridSel.value ? Number(ridSel.value) : 0;
  const items = fav.items.filter((f) => !want || Number(f.rid) === want);

  const cnt = $('#f-count');
  if (cnt) cnt.textContent = items.length ? `共 ${items.length} 条收藏` : '';

  if (!items.length) {
    const empty = h('div', 'empty');
    empty.append(h('p', 'big', '还没有收藏'));
    empty.append(h('p', '', '在检索结果里点句子右边的 ☆ 就能收进来；收藏夹里点说法直接回检索。'));
    box.append(empty);
    return;
  }

  for (const it of items) {
    const row = h('div', 'fav-item');
    const main = h('div', 'fav-main');
    const title = h('button', 'fav-title', it.stem || it.txt);
    title.title = '在检索里查这句';
    title.addEventListener('click', () => favSearch(it));
    main.append(title);
    const sub = h('div', 'fav-sub');
    sub.append(h('span', null, it.live_room_name || it.room_name || `#${it.rid}`));
    sub.append(h('span', null, `收藏于 ${fmtDate(it.created_at)} ${fmtTime(it.created_at)}`));
    if (it.hits) sub.append(h('span', null, `现在 ${fmtNum(it.hits)} 条 · ${fmtNum(it.users)} 人`));
    main.append(sub);
    row.append(main);

    const del = h('button', 'btn ghost tiny', '取消收藏');
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {
        await api(`/api/favorites/${it.id}`, { method: 'DELETE' });
        fav.items = fav.items.filter((f) => f.id !== it.id);
        syncFavKeys();
        renderFavorites();
      } catch (err) {
        toast(err.message, true);
        del.disabled = false;
      }
    });
    row.append(del);
    box.append(row);
  }
}

$('#f-refresh').addEventListener('click', loadFavorites);
$('#f-rid').addEventListener('change', renderFavorites);

// ------------------------------------------------------------ 库包导出 / 导入

$('#lib-anon').addEventListener('change', () => {
  const anon = $('#lib-anon').checked;
  $('#lib-warn').hidden = anon;
  // 勾着匿名时也要说清楚「匿名」具体抹掉什么，别让人以为是「不记来源」那种匿名
  const note = $('#lib-anon-note');
  note.innerHTML = anon
    ? '<strong>匿名库包</strong>里没有 <strong>UID</strong> 也没有<strong>昵称</strong>：每条弹幕的 uid 写成 0、昵称写成「匿名」，只保留正文、时间、房间和计数。所以它可以公开分给别人。'
    : '导出的是<strong>实名库包</strong>：带每条的 UID 和昵称。';
  note.className = anon ? 'hint' : 'hint warn';
});

$('#lib-export').addEventListener('click', async () => {
  const anon = $('#lib-anon').checked;
  if (!anon && !confirm('这个库包会带上 UID 和昵称。\n\n只建议在自己设备之间同步，确定导出吗？')) return;
  const rid = $('#lib-rid').value || '';
  const range = $('#lib-range').value;
  const q = new URLSearchParams();
  if (rid) q.set('rid', rid);
  q.set('anon', anon ? '1' : '0');
  if (range !== 'all') {
    const now = Date.now();
    const day = Math.floor(now / 86400000) * 86400000;
    if (range === 'today') q.set('from', String(day));
    else q.set('from', String(now - Number(range) * 86400000));
  }

  const out = $('#lib-export-status');
  const btn = $('#lib-export');
  btn.disabled = true;
  out.textContent = '正在打包…';
  try {
    const res = await fetch(`/api/library/export?${q.toString()}`);
    if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
    const rows = Number(res.headers.get('x-lib-rows') || 0);
    const blob = await res.blob();
    if (!blob.size) throw new Error('导出的文件是空的');
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] ||
      `danmu-lib-${new Date().toISOString().slice(0, 10)}.db`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    out.textContent = `已保存 ${name}：${fmtNum(rows)} 条，${fmtBytes(blob.size)}`;
  } catch (err) {
    out.textContent = '';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#lib-import').addEventListener('click', async () => {
  const f = $('#lib-file').files && $('#lib-file').files[0];
  if (!f) {
    toast('先选一个 .db 库包', true);
    return;
  }
  if (!confirm(`导入「${f.name}」（${(f.size / 1048576).toFixed(1)} MB）？\n\n同一条弹幕会自动去重。`)) return;
  $('#lib-status').textContent = '正在上传…';
  try {
    const res = await fetch('/api/library/import', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: f,
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || '导入失败');
    $('#lib-status').textContent = `完成：新增 ${fmtNum(d.inserted)} 条，重复 ${fmtNum(d.dupes)} 条`;
    toast(`导入完成：新增 ${fmtNum(d.inserted)} 条`);
    loadSettings();
    refreshStats();
  } catch (err) {
    $('#lib-status').textContent = '';
    toast(err.message, true);
  }
});

// 导入进度（服务端合并 / 重算时推 libprogress）
function onLibProgress(d) {
  const el = $('#lib-status');
  if (!el) return;
  if (d.phase === 'read') el.textContent = `读取库包…共 ${fmtNum(d.total)} 条`;
  else if (d.phase === 'merged') el.textContent = `已合并 新增 ${fmtNum(d.inserted)} / 重复 ${fmtNum(d.dupes)}，正在重算…`;
  else if (d.phase === 'recompute') {
    el.textContent =
      d.step === 'topics' ? `正在重算词条分类${d.done ? `（已处理 ${fmtNum(d.done)} 条）` : ''}…` : '正在重算弹幕潮…';
  } else if (d.phase === 'done') el.textContent = `完成：新增 ${fmtNum(d.inserted)} 条，重复 ${fmtNum(d.dupes)} 条`;
}

// ------------------------------------------------------------ 界面与退出
let uiCfg = { windowMode: 'app', stopOnWindowClose: true, graceSec: 30, closeAction: 'tray' };

async function loadUISettings() {
  try {
    const s = await api('/api/ui');
    uiCfg = s;
    $('#ui-mode-app').checked = s.windowMode === 'app';
    $('#ui-mode-browser').checked = s.windowMode !== 'app';
    $('#ui-close-tray').checked = s.closeAction !== 'stop';
    $('#ui-close-stop').checked = s.closeAction === 'stop';
    $('#ui-grace').value = s.graceSec;
    renderUiHint();
  } catch {
    /* 设置读不到不影响主功能 */
  }
}

// 顶部常驻一句：关窗口会发生什么。系统确认框文案改不了，就别靠它解释。
function renderUiHint() {
  const el = $('#ui-hint');
  if (!el) return;
  if (!uiCfg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.title = (uiCfg.closeAction === 'stop'
    ? `关闭窗口后程序不会立刻退出，${uiCfg.graceSec || 30} 秒内重新打开这个页面就继续采集；超时才停止。`
    : '关闭窗口不会停止采集：程序留在任务栏右下角，双击图标回到界面，右键可以退出。') + '（点这里去设置）';
  if (uiCfg.closeAction === 'stop') {
    el.textContent = `关窗口 ${uiCfg.graceSec || 30} 秒后停止采集`;
  } else {
    el.textContent = '关窗口后缩到系统托盘继续采集';
  }
}

$('#ui-save').addEventListener('click', async () => {
  try {
    const closeAction = $('#ui-close-stop').checked ? 'stop' : 'tray';
    const next = await api('/api/ui', {
      method: 'POST',
      body: JSON.stringify({
        windowMode: $('#ui-mode-app').checked ? 'app' : 'browser',
        closeAction,
        graceSec: Number($('#ui-grace').value) || 30,
      }),
    });
    uiCfg = next;
    renderUiHint();
    $('#ui-status').textContent = '已保存 · 下次启动按这个来';
    toast('界面设置已保存');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#ui-open').addEventListener('click', async () => {
  const btn = $('#ui-open');
  btn.disabled = true;
  // 开窗口要等页面真的连上来（最多十几秒），这段空档必须让按钮有反馈，否则就像「点了没反应」
  $('#ui-status').textContent = '正在打开界面…';
  try {
    // 直接把当前地址当独立窗口打开（即使当前已经是 app 模式也要能手动唤出）
    const d = await api('/api/ui', {
      method: 'POST',
      body: JSON.stringify({ openWindow: 'browser' }),
    });
    $('#ui-status').textContent = d.opened
      ? '已打开（没弹出来的话，看浏览器的新标签页）'
      : '没能打开：手动打开 ' + location.origin + ' 也可以';
  } catch (err) {
    $('#ui-status').textContent = '打开界面失败：' + err.message;
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#ui-open-tab').addEventListener('click', async () => {
  const btn = $('#ui-open-tab');
  btn.disabled = true;
  $('#ui-status').textContent = '正在打开浏览器窗口…';
  try {
    // 不管当前是什么模式，都在浏览器里再开一个窗口
    const d = await api('/api/ui', {
      method: 'POST',
      body: JSON.stringify({ openWindow: 'browser' }),
    });
    $('#ui-status').textContent = d.opened
      ? '已在浏览器里打开（看任务栏或浏览器新标签）'
      : '没能打开浏览器：可能被「以管理员身份运行」的实例挡住了。手动访问 ' + location.origin;
  } catch (err) {
    $('#ui-status').textContent = '打开浏览器失败：' + err.message;
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#ui-hint').addEventListener('click', () => {
  switchTab('settings');
  const card = $('#ui-save') && $('#ui-save').closest('.card');
  if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
});
$('#ui-close-tray').addEventListener('change', () => $('#ui-close-stop').checked = false);
$('#ui-close-stop').addEventListener('change', () => $('#ui-close-tray').checked = false);

$('#set-shutdown').addEventListener('click', async () => {
  if (!confirm('停止采集并退出程序？\n\n退出后就不再往库里写弹幕，重新启动才能继续采集。')) return;
  try {
    await api('/api/shutdown', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div style="position:fixed;inset:0;background:#0b0e13;color:#e6edf6;display:flex;align-items:center;justify-content:center;font-size:15px;z-index:99">采集已停止，程序已退出。这个窗口可以关掉了。</div>'
    );
  } catch (err) {
    toast(err.message, true);
  }
});

// 关窗口不拦：浏览器的确认框文案改不了（只会说「你所做的更改可能未保存」），
// 而且和「宽限期」重复确认。改成关窗口直接放行，靠宽限期 + 顶部常驻提示兜底。

// 「永久保留」：勾上就不再自动清理（retentionDays = 0）
function syncRetentionUI(days) {
  const forever = !days || days <= 0;
  $('#set-forever').checked = forever;
  const input = $('#set-retention');
  input.disabled = forever;
  input.value = forever ? '' : days;
  input.placeholder = forever ? '∞' : '90';
  $('#set-retention-hint').textContent = forever
    ? '永久保留：程序不会自动删除任何弹幕。大房间一天约 100–300 万条，注意磁盘空间。'
    : '清理会永久删除更早的弹幕，无法恢复。默认保留 90 天，勾「永久保留」可以关掉自动清理。';
}
$('#set-forever').addEventListener('change', async () => {
  const forever = $('#set-forever').checked;
  const days = forever ? 0 : Number($('#set-retention').value) || 90;
  syncRetentionUI(days);
  try {
    await api('/api/maintenance', { method: 'POST', body: JSON.stringify({ retentionDays: days }) });
    toast(forever ? '已设为永久保留，不再自动清理' : `已设为保留最近 ${days} 天`);
    loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#set-prune').addEventListener('click', async () => {
  const forever = $('#set-forever').checked;
  const days = Number($('#set-retention').value) || 90;
  if (forever) {
    toast('现在是永久保留，不会自动清理。要手动清理，先取消勾选并填天数。');
    return;
  }
  if (!confirm(`确认删除 ${days} 天之前的全部弹幕？此操作不可恢复。`)) return;
  try {
    const d = await api('/api/maintenance', { method: 'POST', body: JSON.stringify({ retentionDays: days }) });
    toast(`已清理 ${fmtNum(d.removed)} 条`);
    loadSettings();
    refreshStats();
  } catch (err) {
    toast(err.message, true);
  }
});

// ------------------------------------------------------------ 录播导入

function renderVod(items) {
  const box = $('#vod-done');
  if (!box) return;
  box.textContent = '';
  if (!items.length) {
    box.append(h('p', 'hint', '还没有导入过录播。'));
    return;
  }
  for (const it of items) {
    const row = h('div', 'vod-item');
    row.append(h('span', 't', it.title || it.show_id));
    row.append(h('span', 'n', fmtNum(it.imported) + ' 条'));
    row.append(h('span', null, it.duration ? Math.round(it.duration / 60) + ' 分钟' : ''));
    row.append(h('span', null, fmtDate(it.imported_at)));
    const del = h('span', 'del', '删除');
    del.addEventListener('click', async () => {
      if (!confirm('删除这个录播导入的全部弹幕？')) return;
      try {
        const d = await api(`/api/vod/${it.show_id}`, { method: 'DELETE' });
        toast(`已删除 ${fmtNum(d.removed)} 条`);
        loadVod();
        refreshStats();
      } catch (err) {
        toast(err.message, true);
      }
    });
    row.append(del);
    box.append(row);
  }
}

async function loadVod() {
  try {
    const d = await api('/api/vod');
    renderVod(d.imports || []);
  } catch {
    /* 服务端版本较旧时忽略 */
  }
}

$('#vod-preview')?.addEventListener('click', async () => {
  const input = $('#vod-input').value.trim();
  if (!input) return toast('先粘贴录播链接', true);
  const st = $('#vod-status');
  st.textContent = '正在查询…';
  try {
    const d = await api(`/api/vod/preview?input=${encodeURIComponent(input)}`);
    if (!d.ok) throw new Error(d.error || '查询失败');
    st.textContent =
      `${d.title}　时长 ${Math.round((d.duration || 0) / 60)} 分钟 · 接口报 ${fmtNum(d.count)} 条` +
      (d.done ? `（已导入过 ${fmtNum(d.done.imported)} 条，再导入会重复，除非先删除）` : '');
  } catch (err) {
    st.textContent = '';
    toast(err.message, true);
  }
});

$('#vod-import')?.addEventListener('click', async () => {
  const input = $('#vod-input').value.trim();
  if (!input) return toast('先粘贴录播链接', true);
  const btn = $('#vod-import');
  const st = $('#vod-status');
  btn.disabled = true;
  st.textContent = '正在拉取弹幕…（一万条大约要 30 秒）';

  const run = async (force) => {
    const d = await api('/api/import/vod', { method: 'POST', body: JSON.stringify({ input, force }) });
    if (!d.ok) throw new Error(d.error || '导入失败');
    return d;
  };

  try {
    let d;
    try {
      d = await run(false);
    } catch (err) {
      if (/已经导入过/.test(err.message) && confirm(`${err.message}\n\n仍要再导入一遍吗？（会产生重复数据）`)) {
        d = await run(true);
      } else {
        throw err;
      }
    }
    st.textContent =
      `已导入 ${fmtNum(d.imported)} 条 / ${fmtNum(d.users)} 人（人均 ${d.perUser} 条，` +
      `${d.density ? d.density + ' 条/分钟' : '时间轴不可用'}）`;
    if (d.uniformSts) st.textContent += '　注：这条录播的发送时间戳是整场同一个值，已改用视频内偏移还原时间轴';
    $('#vod-input').value = '';
    loadVod();
    loadSettings();
    refreshStats();
  } catch (err) {
    st.textContent = '';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ 启动

async function boot() {
  const hash = location.hash.replace('#', '');
  if (['live', 'search', 'user', 'board', 'timeline', 'favorites', 'settings'].includes(hash)) switchTab(hash);

  // 先知道收藏了哪些，检索结果里的星标才能显示正确的状态
  loadFavorites();
  loadFollows();
  // 时间线选区存在服务端，独立窗口和浏览器标签才一致
  loadPrefs();
  // 顶部那句「关窗口 N 秒后停止采集」要一开始就显示，不能等切到设置页
  loadUISettings();
  // 排行榜的日期框默认填今天，切到「选日期」时才有东西可选
  $('#b-date').value = todayStr();

  try {
    const d = await api('/api/rooms');
    state.rooms = d.rooms || [];
    renderRooms();
    renderRoomOptions();
    if (state.rooms.length) {
      selectRoom(state.rooms.find((r) => r.status === 'online') ? state.rooms.find((r) => r.status === 'online').rid : state.rooms[0].rid);
    } else {
      renderLive();
    }
  } catch (err) {
    toast('无法连接本地服务：' + err.message, true);
  }

  await refreshStats();
  setInterval(refreshStats, 15000);
  await loadBursts();
  setInterval(() => {
    if (state.tab === 'live') loadBursts();
  }, 30000);

  const r = await api('/api/rooms').catch(() => null);
  if (r) renderRoomOptions();
  if (state.tab === 'search') loadKeywords();
}

// ------------------------------------------------------------ 时间线

const tl = { data: null, sel: null, drag: null };

function fmtDur(mins) {
  const m = Math.max(1, Math.round(mins));
  if (m < 60) return `${m} 分钟`;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${hh} 小时 ${mm} 分钟` : `${hh} 小时`;
}

function tlCanvas() {
  const cv = $('#t-canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(cv.clientWidth || 900, 200);
  const hgt = 150;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hgt * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cv, ctx, w, hgt };
}

function tlDraw() {
  const d = tl.data;
  const { ctx, w, hgt } = tlCanvas();
  const padB = 18;
  const H = hgt - padB;
  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, w, H);
  if (!d) return;
  const n = d.buckets.length;
  const bw = w / n;
  const max = Math.max(d.max, 1);

  // 小时刻度
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = 'rgba(160,175,195,0.9)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let hh = 0; hh <= 24; hh++) {
    const x = (hh / 24) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    if (hh < 24) {
      ctx.fillText(String(hh).padStart(2, '0'), Math.min(Math.max(x + 10, 8), w - 8), hgt - 4);
    }
  }

  // 柱子：开二次方压一下高度，否则一次大潮会把其他时段压成一条线
  for (let i = 0; i < n; i++) {
    const c = d.buckets[i];
    if (!c) continue;
    const bh = Math.pow(c / max, 0.55) * (H - 2);
    ctx.fillStyle = 'rgba(77,224,176,0.55)';
    ctx.fillRect(i * bw, H - bh, Math.max(bw, 1), bh);
  }

  // 选择范围
  if (tl.sel) {
    const a = Math.min(tl.sel.a, tl.sel.b);
    const b = Math.max(tl.sel.a, tl.sel.b);
    const x1 = a * bw;
    const x2 = (b + 1) * bw;
    ctx.fillStyle = 'rgba(124,156,255,0.22)';
    ctx.fillRect(x1, 0, x2 - x1, H);
    ctx.strokeStyle = 'rgba(124,156,255,0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, H);
    ctx.moveTo(x2, 0);
    ctx.lineTo(x2, H);
    ctx.stroke();

    // 两端的抓取把手
    ctx.fillStyle = 'rgba(124,156,255,0.95)';
    ctx.fillRect(x1 - 1, 0, 3, H);
    ctx.fillRect(x2 - 2, 0, 3, H);

    // 具体时间：贴在两端，窄的时候上下错开
    const t1 = fmtTime(d.from + a * d.bucketMs);
    const t2 = fmtTime(d.from + (b + 1) * d.bucketMs);
    const narrow = x2 - x1 < 108;
    tlTag(ctx, x1, 3, t1, w);
    tlTag(ctx, x2, narrow ? 22 : 3, t2, w);
  }
}

// 画一个贴着时间线的小时间牌
function tlTag(ctx, x, y, text, w) {
  ctx.font = '600 10px system-ui, sans-serif';
  const tw = ctx.measureText(text).width + 10;
  const bx = Math.min(Math.max(x - tw / 2, 2), w - tw - 2);
  ctx.fillStyle = 'rgba(124,156,255,0.95)';
  ctx.beginPath();
  ctx.roundRect(bx, y, tw, 15, 4);
  ctx.fill();
  ctx.fillStyle = '#0b0e13';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 5, y + 8);
  ctx.textBaseline = 'alphabetic';
}

function tlIndexAt(ev) {
  // 注意：这里绝不能走 tlCanvas()。它会在宽度变化时重设 cv.width，
  // 而重设 width 会清空画布；pointermove 里调用它又不重绘，
  // 结果就是「圈完选、鼠标一动，图没了」。
  const cv = $('#t-canvas');
  const r = cv.getBoundingClientRect();
  const w = r.width || 1;
  const x = Math.min(Math.max(ev.clientX - r.left, 0), w - 1);
  const n = (tl.data && tl.data.buckets.length) || 1440;
  return Math.min(n - 1, Math.floor((x / w) * n));
}

function tlSelRange() {
  if (!tl.data || !tl.sel) return null;
  const a = Math.min(tl.sel.a, tl.sel.b);
  const b = Math.max(tl.sel.a, tl.sel.b);
  const d = tl.data;
  return { a, b, from: d.from + a * d.bucketMs, to: d.from + (b + 1) * d.bucketMs };
}

function tlSum(a, b) {
  const d = tl.data;
  let s = 0;
  for (let i = a; i <= b; i++) s += d.buckets[i] || 0;
  return s;
}

async function tlCommit() {
  const r = tlSelRange();
  if (!r) return;
  const mins = (r.to - r.from) / 60000;
  $('#t-readout').textContent = `${fmtTime(r.from)} → ${fmtTime(r.to)} · ${fmtDur(mins)} · 这段 ${fmtNum(tlSum(r.a, r.b))} 条`;
  const rid = $('#t-rid').value;
  const min = $('#t-min2').checked ? 2 : 1;
  const box = $('#t-results');
  const sum = $('#t-summary');
  sum.textContent = '统计中…';
  try {
    const d = await api(
      `/api/timeline/top?from=${r.from}&to=${r.to}&min=${min}&limit=200${rid ? '&rid=' + rid : ''}`
    );
    renderTimelineRows(d, r);
  } catch (err) {
    sum.textContent = '';
    box.textContent = '';
    const e = h('div', 'empty');
    e.append(h('p', 'big', '查询失败'));
    e.append(h('p', '', err.message));
    box.append(e);
  }
}

function renderTimelineRows(d, range) {
  const box = $('#t-results');
  const sum = $('#t-summary');
  box.textContent = '';
  const mins = Math.round((range.to - range.from) / 60000);
  sum.textContent = `${fmtTime(range.from)} → ${fmtTime(range.to)} · ${fmtDur(mins)} · 共 ${fmtNum(
    tlSum(range.a, range.b)
  )} 条 · 命中 ${fmtNum(d.rows.length)} 种说法 · ${d.took} ms`;

  if (!d.rows.length) {
    const e = h('div', 'empty');
    e.append(h('p', 'big', '这一段没有重复出现的说法'));
    e.append(h('p', '', '把范围拉大一些，或者去掉「只看出现 ≥2 次的」。'));
    box.append(e);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of d.rows) {
    const row = h('div', 'result');
    const who = h('div', 'who');
    who.append(h('div', 'nn', `×${fmtNum(r.n)} 条`));
    who.append(h('div', 'meta', `${fmtNum(r.users)} 人`));
    const body = h('div', 'body');
    body.append(h('div', 'txt', r.disp || r.sample || r.phrase));
    const why = h('div', 'why');
    why.append(h('span', 'tag', `首次 ${fmtTime(r.first)}`));
    if (r.plusOne) why.append(h('span', 'tag', `被 +1 ${fmtNum(r.plusOne)} 次`));
    const go = h('button', 'origin-btn', '在检索里看');
    go.addEventListener('click', () => {
      $('#q').value = r.phrase;
      switchTab('search');
      runSearch();
    });
    why.append(go);
    const star = favButton({
      rid: Number($('#t-rid').value) || 0,
      stem: r.stem || r.phrase,
      txt: r.disp || r.sample || r.phrase,
      n: r.n,
      users: r.users,
    });
    star.classList.add('fav-sm');
    why.append(star);
    body.append(why);
    row.append(who, body, h('div', 'tm', fmtTime(r.last)));
    frag.append(row);
  }
  box.append(frag);
}

async function loadTimeline() {
  const dateInput = $('#t-date');
  if (!dateInput.value) dateInput.value = fmtDate(Date.now());
  const rid = $('#t-rid').value;
  const readout = $('#t-readout');
  try {
    const d = await api(`/api/timeline?date=${dateInput.value}${rid ? '&rid=' + rid : ''}`);
    tl.data = d;
    tl.drag = null;
    dateInput.value = d.date;
    const pend = tl.pending;
    tl.pending = null;
    const saved = tlLoadSel(d.date, rid);
    tl.sel = pend ? tlSelFromRange(pend) : saved && saved.b <= d.buckets.length ? saved : null;
    if (tl.sel) tlSaveSel();
    tlDraw();
    readout.textContent = d.total
      ? `这一天共 ${fmtNum(d.total)} 条，单分钟最多 ${fmtNum(d.max)} 条 · 拖拽选择范围`
      : '这一天还没有数据';
    $('#t-summary').textContent = '';
    const box = $('#t-results');
    box.textContent = '';
    if (tl.sel) {
      tlCommit();
      return;
    }
    const e = h('div', 'empty');
    e.append(h('p', 'big', '按时间看弹幕在说什么'));
    e.append(h('p', '', '选出一天的某一段，按「重复次数」从多到少列出这段时间里出现过的说法。'));
    e.append(h('p', 'muted small', '排序是重复次数，所以整场只说过一次的话会排在最后。'));
    box.append(e);
  } catch (err) {
    readout.textContent = '时间线加载失败：' + err.message;
  }
}

function tlSelKey(date, rid) {
  return `dy.tlsel.${date}.${rid || 'all'}`;
}

// 选区存服务端（meta.prefs），这样浏览器标签和独立窗口看到的是同一份。
// 独立窗口用自己的 data/window-profile，和浏览器 profile 的 localStorage 根本不通。
let prefsTimer = 0;
function savePrefsSoon() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    api('/api/prefs', { method: 'POST', body: JSON.stringify({ prefs: state.prefs }) }).catch(() => {});
  }, 400);
}

function tlSaveSel() {
  const d = tl.data;
  if (!d || !tl.sel) return;
  if (!state.prefs.tlsel) state.prefs.tlsel = {};
  state.prefs.tlsel[tlSelKey(d.date, $('#t-rid').value)] = { a: tl.sel.a, b: tl.sel.b };
  savePrefsSoon();
}

function tlLoadSel(date, rid) {
  const v = (state.prefs.tlsel || {})[tlSelKey(date, rid)];
  if (v && Number.isFinite(Number(v.a)) && Number.isFinite(Number(v.b))) {
    return { a: Math.max(0, Number(v.a)), b: Math.max(0, Number(v.b)) };
  }
  return null;
}

function tlClearSel() {
  tl.sel = null;
  tl.drag = null;
  tlDraw();
  $('#t-axis').textContent = '';
  if (tl.data && state.prefs.tlsel) {
    delete state.prefs.tlsel[tlSelKey(tl.data.date, $('#t-rid').value)];
    savePrefsSoon();
  }
  $('#t-readout').textContent = tl.data
    ? `这一天共 ${fmtNum(tl.data.total)} 条 · 拖拽选择范围`
    : '';
  $('#t-summary').textContent = '';
  $('#t-results').textContent = '';
}

// 从检索结果 / 画像跳到时间线：给一段时间（毫秒），落到对应的分钟桶上
function jumpToTimeline(from, to, rid) {
  tl.pending = { from: Number(from), to: Number(to), rid: rid ? String(rid) : '' };
  const dateInput = $('#t-date');
  if (dateInput) dateInput.value = fmtDate(from);
  const sel = $('#t-rid');
  if (sel) {
    if (rid) {
      const v = String(rid);
      if (![...sel.options].some((o) => o.value === v)) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = `房间 ${v}`;
        sel.append(o);
      }
      sel.value = v;
    } else {
      sel.value = '';
    }
  }
  if ($('#tab-timeline').classList.contains('active')) loadTimeline();
  else switchTab('timeline');
  const card = document.querySelector('.tl-card');
  if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// 把 [from, to) 换成分钟桶下标
function tlSelFromRange(p) {
  const d = tl.data;
  if (!d) return null;
  if (p.rid && p.rid !== ($('#t-rid').value || '')) return null;
  const n = d.buckets.length;
  let a = Math.floor((p.from - d.from) / d.bucketMs);
  let b = Math.floor((p.to - d.from) / d.bucketMs) - 1;
  a = Math.min(Math.max(a, 0), n - 1);
  b = Math.min(Math.max(b, a), n - 1);
  return { a, b };
}

// 鼠标是不是压在选区的某条边上（用来微调）
function tlEdgeAt(ev) {
  const d = tl.data;
  if (!d || !tl.sel) return null;
  const r = $('#t-canvas').getBoundingClientRect();
  const w = r.width || 1;
  const bw = w / d.buckets.length;
  const a = Math.min(tl.sel.a, tl.sel.b);
  const b = Math.max(tl.sel.a, tl.sel.b);
  const x = ev.clientX - r.left;
  if (Math.abs(x - a * bw) <= 7) return 'a';
  if (Math.abs(x - (b + 1) * bw) <= 7) return 'b';
  return null;
}

(function bindTimeline() {
  const cv = $('#t-canvas');
  if (!cv) return;
  cv.addEventListener('pointerdown', (ev) => {
    if (!tl.data) return;
    ev.preventDefault();
    try {
      cv.setPointerCapture(ev.pointerId);
    } catch {
      /* 合成的 PointerEvent 没有真实指针，捕获失败不影响拖拽 */
    }
    const edge = tlEdgeAt(ev);
    if (edge) {
      // 抓住某条边：只动那一边
      tl.drag = { mode: 'edge', edge, start: tlIndexAt(ev), moved: false };
      cv.style.cursor = 'ew-resize';
      return;
    }
    tl.drag = {
      mode: 'new',
      start: tlIndexAt(ev),
      moved: false,
      prev: tl.sel ? { a: tl.sel.a, b: tl.sel.b } : null,
    };
    tl.sel = { a: tl.drag.start, b: tl.drag.start };
    tlDraw();
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!tl.data) return;
    const i = tlIndexAt(ev);
    if (tl.drag && tl.drag.mode === 'edge') {
      tl.drag.moved = true;
      if (tl.drag.edge === 'a') tl.sel.a = i;
      else tl.sel.b = i;
      tlDraw();
      const r = tlSelRange();
      if (r) {
        $('#t-readout').textContent = `${fmtTime(r.from)} → ${fmtTime(r.to)} · ${fmtDur(
          (r.to - r.from) / 60000
        )} · ${fmtNum(tlSum(r.a, r.b))} 条`;
      }
      return;
    }
    if (tl.drag) {
      if (i !== tl.drag.start) tl.drag.moved = true;
      tl.sel = { a: tl.drag.start, b: i };
      tlDraw();
      const r = tlSelRange();
      if (r) $('#t-readout').textContent = `${fmtTime(r.from)} → ${fmtTime(r.to)} · ${fmtDur((r.to - r.from) / 60000)} · ${fmtNum(tlSum(r.a, r.b))} 条`;
      return;
    }
    cv.style.cursor = tlEdgeAt(ev) ? 'ew-resize' : 'crosshair';
    const d = tl.data;
    const t = d.from + i * d.bucketMs;
    $('#t-axis').textContent = `${fmtTime(t)} · ${fmtNum(d.buckets[i] || 0)} 条`;
  });
  cv.addEventListener('pointerup', (ev) => {
    if (!tl.drag) return;
    const drag = tl.drag;
    tl.drag = null;
    try {
      cv.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    if (drag.mode === 'edge') {
      if (drag.moved) {
        tlSaveSel();
        tlCommit();
      }
      return;
    }
    if (!drag.moved) {
      // 在空白处单击：保留已固定的选区，不清空
      tl.sel = drag.prev;
      tlDraw();
      return;
    }
    tlSaveSel();
    tlCommit();
  });
  cv.addEventListener('pointerleave', () => {
    $('#t-axis').textContent = '';
  });
  cv.style.cursor = 'crosshair';
  window.addEventListener('resize', () => tlDraw());
  // 结果列表撑出滚动条时窗口宽度会变，resize 不一定触发；盯住画布本身最稳
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (document.querySelector('#tab-timeline.active')) tlDraw();
    });
    ro.observe(cv);
  }
  $('#t-refresh').addEventListener('click', loadTimeline);
  $('#t-clear').addEventListener('click', tlClearSel);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.querySelector('#tab-timeline.active') && tl.sel) {
      tlClearSel();
    }
  });
  $('#t-date').addEventListener('change', loadTimeline);
  $('#t-rid').addEventListener('change', loadTimeline);
  $('#t-min2').addEventListener('change', () => {
    if (tl.sel) tlCommit();
  });
})();

boot();
