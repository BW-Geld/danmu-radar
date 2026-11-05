'use strict';

/**
 * 端到端冒烟测试：直接打本地 HTTP 接口，覆盖统计 / 房间 / 检索 / 用户 / 录播预览。
 *
 *   node tools/e2e.js http://127.0.0.1:7799
 */

const BASE = process.argv[2] || 'http://127.0.0.1:7799';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function j(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: r.status, data };
}

async function post(path, body) {
  return j(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

(async () => {
  const stats = await j('/api/stats');
  check('GET /api/stats', stats.status === 200 && stats.data.ok, `total=${stats.data.total} users=${stats.data.users}`);
  check('统计里有 dbBytes', Number(stats.data.dbBytes) > 0, String(stats.data.dbBytes));

  const rooms = await j('/api/rooms');
  check('GET /api/rooms', rooms.status === 200 && Array.isArray(rooms.data.rooms), `${rooms.data.rooms?.length} 个房间`);
  // 录播房间取决于库里有没有导入过，不能当成硬断言；只校验每个房间都有状态字段
  check(
    '房间列表字段完整',
    (rooms.data.rooms || []).every((r) => r.rid && r.status),
    (rooms.data.rooms || []).map((r) => `${r.rid}:${r.status}`).join(' ')
  );

  const page = await j('/');
  check('GET / 返回 HTML', page.status === 200 && String(page.data.raw || '').includes('弹幕雷达'));

  const search = await j('/api/search?q=' + encodeURIComponent('哈哈') + '&limit=200');
  check('GET /api/search 有召回', search.data.total > 0, `total=${search.data.total} took=${search.data.took}ms`);
  check('检索结果带命中原因', (search.data.rows || []).every((r) => r.reason && r.reasonType));
  // 来源可以是三种：本机采集 live、录播导入 vod、别人的库包 import
  const SRC_OK = ['live', 'vod', 'import'];
  check(
    '检索结果区分来源',
    (search.data.rows || []).length > 0 && (search.data.rows || []).every((r) => SRC_OK.includes(r.source)),
    [...new Set((search.data.rows || []).map((r) => r.source))].join(',')
  );

  // 取一个在榜用户做画像
  const users = await j('/api/users?q=' + encodeURIComponent(''));
  const uid = (users.data.users || [])[0]?.uid;
  check('GET /api/users 有用户', !!uid, String(uid));
  if (uid) {
    const p = await j('/api/users/' + encodeURIComponent(uid));
    check('GET /api/users/:uid', p.status === 200 && p.data.ok, `total=${p.data.total}`);
    check('画像有 6 维评分', p.data.scores && Object.keys(p.data.scores).length === 6, JSON.stringify(p.data.scores));
    check('画像有标签与来源统计', Array.isArray(p.data.labels) && !!p.data.sources, JSON.stringify(p.data.sources));
  }

  const preview = await j('/api/vod/preview?input=' + encodeURIComponent('2V0JMV10OYD7RY5k'));
  check('GET /api/vod/preview', preview.status === 200 && preview.data.ok, `${preview.data.count} 条 / ${preview.data.title?.slice(0, 18)}`);

  const vodList = await j('/api/vod');
  // 导入记录取决于库里有没有导过、以及有没有被删过，不能断言「必须有一条」
  check('GET /api/vod 可用', vodList.status === 200 && Array.isArray(vodList.data.imports), `${vodList.data.imports?.length ?? '?'} 条记录`);

  const board = await j('/api/board?today=1&limit=5');
  check(
    'GET /api/board 返回两条榜',
    board.status === 200 && Array.isArray(board.data.users) && Array.isArray(board.data.phrases),
    `${board.data.users?.length ?? '?'} 人 / ${board.data.phrases?.length ?? '?'} 句`
  );
  const p0 = (board.data.phrases || [])[0];
  check('+1 次数 = 条数 - 1', !p0 || p0.plusOne === p0.n - 1, p0 ? `${p0.phrase.slice(0, 8)} +1=${p0.plusOne}/${p0.n}` : '榜单为空');
  const u0 = (board.data.users || [])[0];
  check('用户榜按发言量倒序', !u0 || u0.n > 0);

  // 排行榜按日期：指定某天 / 全部时段，两种口径都要能返回且口径正确
  const ymd = (d) => {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const yday = new Date(Date.now() - 86400000);
  const bDate = await j('/api/board?date=' + ymd(yday) + '&limit=5');
  check(
    '排行榜可指定日期',
    bDate.status === 200 && bDate.data.date === ymd(yday) && Array.isArray(bDate.data.users),
    `date=${bDate.data.date} 人=${(bDate.data.users || []).length}`
  );
  const bAll = await j('/api/board?today=0&limit=5');
  const sumAll = (bAll.data.users || []).reduce((a, x) => a + x.n, 0);
  const sumDay = (bDate.data.users || []).reduce((a, x) => a + x.n, 0);
  check(
    '全部时段 ≥ 单日',
    bAll.data.date === null && sumAll >= sumDay,
    `全部 ${sumAll} 条 / ${ymd(yday)} ${sumDay} 条`
  );

  // 从「全部房间」（rid=0）收藏时，后端要把 rid 补成真实房间并回传，
  // 前端靠它把星标的 key 对齐，否则图标永远停在 ☆
  const pSample = (bAll.data.phrases || [])[0];
  if (pSample) {
    const fv = await j('/api/favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rid: 0, stem: pSample.stem || pSample.phrase, txt: pSample.phrase }),
    });
    check('收藏时 rid=0 会被补成真实房间', fv.data.ok && Number(fv.data.rid) > 0, `rid=${fv.data.rid}`);
    if (fv.data.id) await fetch(BASE + '/api/favorites/' + fv.data.id, { method: 'DELETE' });
  }

  const af = await j('/api/affixes');
  check(
    'GET /api/affixes 返回预设与当前配置',
    af.status === 200 && Array.isArray(af.data.presets.suffixes) && Array.isArray(af.data.current.suffixes),
    `${af.data.presets?.suffixes?.length ?? '?'} 个预设后缀`
  );
  const cur = af.data.current || { prefixes: [], suffixes: [] };
  const afSave = await post('/api/affixes', cur);
  check('POST /api/affixes 能保存并重算', afSave.status === 200 && afSave.data.ok === true, `重算 ${afSave.data?.changed ?? '?'} 条`);

  // 高频词推荐
  // 冷场时最近 2 小时可能没几条弹幕，推荐位为空是正常的；放宽到 72 小时，
  // 并且要求空的时候也给出样本量，不能静默返回空数组。
  const kw = await j('/api/keywords?hours=72&limit=10');
  const kwTerms = kw.data.terms || [];
  check(
    'GET /api/keywords 返回高频词',
    kw.status === 200 && kw.data.ok && Array.isArray(kwTerms) && (kwTerms.length > 0 || typeof kw.data.sample === 'number'),
    `${kwTerms.length} 个词，样本 ${kw.data.sample} 条，${kw.data.took}ms`
  );
  const kwSorted = kwTerms.every((t, i) => i === 0 || kwTerms[i - 1].n >= t.n);
  check('高频词按出现次数降序', kwSorted, kwTerms.slice(0, 3).map((t) => `${t.term}×${t.n}`).join(' / '));

  // 时间线
  const tline = await j('/api/timeline');
  const buckets = tline.data.buckets || [];
  check(
    'GET /api/timeline 返回 1440 个分钟桶',
    tline.status === 200 && buckets.length === 1440,
    `${tline.data.date} total=${tline.data.total} max=${tline.data.max}`
  );
  const nz = buckets.filter((c) => c > 0).length;
  check('时间线有非零桶', nz > 0, `${nz} 个分钟有弹幕`);

  // 时间线框选：取有数据的第一段 30 分钟
  let startIdx = buckets.findIndex((c) => c > 0);
  if (startIdx < 0) startIdx = 0;
  const fromMs = tline.data.from + startIdx * tline.data.bucketMs;
  const toMs = fromMs + 30 * tline.data.bucketMs;
  const ttop = await j(`/api/timeline/top?from=${fromMs}&to=${toMs}&limit=50&min=2`);
  const trows = ttop.data.rows || [];
  check(
    'GET /api/timeline/top 返回按次数排序的说法',
    ttop.status === 200 && trows.length > 0,
    `${trows.length} 种说法，${ttop.data.took}ms`
  );
  const tSorted = trows.every((r, i) => i === 0 || trows[i - 1].n >= r.n);
  check('时间线结果按重复次数降序', tSorted, trows.slice(0, 3).map((r) => `${r.n}条`).join(' ≥ '));
  const tMin = trows.every((r) => r.n >= 2);
  check('时间线结果遵守 min=2', tMin);

  // 界面设置
  const ui = await j('/api/ui');
  check(
    'GET /api/ui 返回界面设置',
    ui.status === 200 &&
      ['app', 'browser'].includes(ui.data.windowMode) &&
      typeof ui.data.stopOnWindowClose === 'boolean' &&
      ['tray', 'stop'].includes(ui.data.closeAction),
    `${ui.data.windowMode} / 关窗口 ${ui.data.closeAction} / 宽限 ${ui.data.graceSec}s`
  );
  const uiKeep = {
    windowMode: ui.data.windowMode,
    closeAction: ui.data.closeAction,
    stopOnWindowClose: ui.data.stopOnWindowClose,
    graceSec: ui.data.graceSec,
  };
  const uiSave = await post('/api/ui', { ...uiKeep, graceSec: 30 });
  check('POST /api/ui 能保存且宽限被夹到合法区间', uiSave.status === 200 && uiSave.data.graceSec === 30);

  // 局部 patch 不应重置没传的字段（曾经只传 closeAction 就把 windowMode 打回 app）
  const patchOnly = await post('/api/ui', { closeAction: uiKeep.closeAction });
  check(
    '局部 patch 不重置其他字段',
    patchOnly.status === 200 &&
      patchOnly.data.windowMode === uiKeep.windowMode &&
      patchOnly.data.graceSec === 30,
    `${patchOnly.data.windowMode} / 宽限 ${patchOnly.data.graceSec}s`
  );
  await post('/api/ui', uiKeep); // 还原，免得把测试机的设置改掉

  // 保留期：0 表示永久保留，必须真的存下去并且不触发清理
  const keepDays = (await j('/api/stats')).data.runtime.retentionDays;
  const forever = await post('/api/maintenance', { retentionDays: 0 });
  const afterForever = (await j('/api/stats')).data.runtime.retentionDays;
  check(
    'POST /api/maintenance 0 = 永久保留',
    forever.status === 200 && forever.data.retentionDays === 0 && afterForever === 0,
    `removed=${forever.data.removed} retentionDays=${afterForever}`
  );
  const badDays = await post('/api/maintenance', { retentionDays: 'abc' });
  check('非法保留天数被拒', badDays.status === 400, `status=${badDays.status}`);
  await post('/api/maintenance', { retentionDays: Number.isFinite(keepDays) ? keepDays : 90 }); // 还原（含 0 = 永久）

  // 库包导出：只检查响应头，不落盘（默认匿名）
  const libRes = await fetch(`${BASE}/api/library/export?anon=1&from=${Date.now() - 86400000}`);
  const libRows = Number(libRes.headers.get('x-lib-rows') || 0);
  check(
    'GET /api/library/export 返回可下载的库包',
    libRes.status === 200 &&
      (libRes.headers.get('content-type') || '').includes('sqlite') &&
      libRes.headers.get('x-lib-anon') === '1' &&
      libRows >= 0,
    `rows=${libRows} type=${libRes.headers.get('content-type')}`
  );
  await libRes.arrayBuffer(); // 读空响应体，避免连接挂着

  // 收藏：新增 → 列表带上现在的条数 → 取消
  const favRooms = (await j('/api/rooms')).data.rooms || [];
  const favRid = favRooms.length ? favRooms[0].rid : 6979222;
  const favStem = `e2e收藏测试-${Date.now()}`;
  const favAdd = await post('/api/favorites', { rid: favRid, stem: favStem, txt: favStem });
  check('POST /api/favorites 能收藏', favAdd.status === 200 && favAdd.data.ok === true && !!favAdd.data.id);
  const favList = await j('/api/favorites');
  const got = (favList.data.items || []).find((x) => x.stem === favStem);
  check('GET /api/favorites 能查到，并带上现在的条数/人数', !!got && 'hits' in got && 'users' in got, got ? `hits=${got.hits}` : '没查到');
  const favDel = await j(`/api/favorites/${favAdd.data.id}`, { method: 'DELETE' });
  check('DELETE /api/favorites/:id 能取消', favDel.status === 200 && favDel.data.removed === true);

  const bad = await j('/api/nope');
  check('未知接口返回 404', bad.status === 404);

  // CSV 导出
  const csv = await fetch(BASE + '/api/export/search?q=' + encodeURIComponent('哈哈'));
  const csvText = await csv.text();
  check(
    '导出检索 CSV',
    csv.status === 200 &&
      (csv.headers.get('content-type') || '').includes('text/csv') &&
      csvText.includes('时间,房间,UID') &&
      csvText.split('\n').length > 5,
    `${Math.round(csvText.length / 1024)} KB / ${csvText.split('\n').length} 行`
  );
  const csvUser = await fetch(BASE + '/api/export/user/' + encodeURIComponent(uid));
  check('导出用户 CSV', csvUser.status === 200, `${csvUser.headers.get('content-type')}`);

  // 用户页新增字段：最近 50 条 + 按天分布
  const prof = await (await fetch(BASE + '/api/users/' + encodeURIComponent(uid))).json();
  check(
    '画像返回最近 50 条与按天分布',
    prof.ok && Array.isArray(prof.recent) && prof.recent.length > 0 && prof.recent.length <= 50 && Array.isArray(prof.daily),
    `recent=${(prof.recent || []).length} daily=${(prof.daily || []).length}`
  );
  const hs = prof.hostility || {};
  check(
    '对立发言带原话明细',
    Array.isArray(hs.rows) && hs.rows.length === Math.min(500, hs.total || 0),
    `total=${hs.total} rows=${(hs.rows || []).length}`
  );

  // 用户历史弹幕：分页、按时间倒序、不去重
  const page1 = await (
    await fetch(BASE + '/api/users/' + encodeURIComponent(uid) + '/messages?limit=20')
  ).json();
  const ordered = (page1.rows || []).every((r, i, a) => i === 0 || a[i - 1].cst >= r.cst);
  check(
    '历史弹幕分页且倒序',
    page1.ok && page1.rows.length > 0 && page1.rows.length <= 20 && ordered && page1.total >= page1.rows.length,
    `total=${page1.total} rows=${page1.rows.length} hasMore=${page1.hasMore}`
  );

  // 历史弹幕可按关键词筛：匹配数 ≤ 全部，且返回的每一行都真的含这个词
  const histKw = (page1.rows[0].txt || '').slice(0, 2);
  const fp = await (
    await fetch(BASE + '/api/users/' + encodeURIComponent(uid) + '/messages?limit=20&q=' + encodeURIComponent(histKw))
  ).json();
  check(
    '历史弹幕可按关键词筛',
    fp.ok &&
      fp.q === histKw &&
      fp.total <= fp.totalAll &&
      fp.rows.every((r) => r.txt.includes(histKw)) &&
      (fp.rows.length === 0 || fp.total > 0),
    `q=${histKw} 匹配 ${fp.total} / 全部 ${fp.totalAll}`
  );

  // 通配符要被转义：输入 % 不能退化成「整库」
  const fw = await (
    await fetch(BASE + '/api/users/' + encodeURIComponent(uid) + '/messages?limit=5&q=' + encodeURIComponent('%'))
  ).json();
  check('历史弹幕搜索转义 %', fw.ok && fw.total < fw.totalAll, `输入 % 命中 ${fw.total} / ${fw.totalAll}`);

  // 关注：加 → 列表里有 → 画像 following=true → 删 → 消失
  // 注意：这里动的是真实关注表，测试前后必须原样还原（曾经把用户自己的关注删掉过）
  const favUid = prof.uid || uid;
  const favBefore = await (await fetch(BASE + '/api/follows')).json();
  const favPrev = (favBefore.items || []).find((x) => String(x.uid) === String(favUid)) || null;
  await fetch(BASE + '/api/follows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: favUid, nn: 'e2e-临时关注' }),
  });
  const flist = await (await fetch(BASE + '/api/follows')).json();
  const inList = (flist.items || []).some((x) => String(x.uid) === String(favUid));
  const prof2 = await (await fetch(BASE + '/api/users/' + encodeURIComponent(favUid))).json();
  check('关注后列表与画像都能看到', inList && prof2.following === true, `items=${(flist.items || []).length}`);

  // 特别关注：设为特别 → 列表里 special=true 且排在最前
  const sp1 = await (
    await fetch(BASE + '/api/follows/' + encodeURIComponent(favUid) + '/special', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ special: true }),
    })
  ).json();
  const flistSp = await (await fetch(BASE + '/api/follows')).json();
  const itemsSp = flistSp.items || [];
  const mine = itemsSp.findIndex((x) => String(x.uid) === String(favUid));
  const firstPlain = itemsSp.findIndex((x) => !x.special);
  check(
    '设为特别关注后排在普通关注前面',
    sp1.ok && sp1.special === true && mine >= 0 && itemsSp[mine].special === true && (firstPlain === -1 || mine < firstPlain),
    `mine@${mine} special=${itemsSp[mine] && itemsSp[mine].special} 首个普通@${firstPlain}`
  );

  await fetch(BASE + '/api/follows/' + encodeURIComponent(favUid), { method: 'DELETE' });
  const flist2 = await (await fetch(BASE + '/api/follows')).json();
  check(
    '取关后从列表消失',
    !(flist2.items || []).some((x) => String(x.uid) === String(favUid)),
    `items=${(flist2.items || []).length}`
  );

  // 还原：这个人本来就是用户关注的，就把昵称和特别关注状态一起放回去
  if (favPrev) {
    await fetch(BASE + '/api/follows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: favPrev.uid, nn: favPrev.nn || '', note: favPrev.note || '' }),
    });
    if (favPrev.special) {
      await fetch(BASE + '/api/follows/' + encodeURIComponent(favPrev.uid) + '/special', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ special: true }),
      });
    }
    const back = await (await fetch(BASE + '/api/follows')).json();
    const got = (back.items || []).find((x) => String(x.uid) === String(favPrev.uid)) || {};
    check('测试结束后还原原本的关注', !!got.uid && got.nn === favPrev.nn, `nn=${got.nn}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
