'use strict';

/** 库包导出 / 导入自测：匿名包与实名包必须互相去重。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../server/db');
const { exportLibrary, importLibrary } = require('../server/library');

let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) {
    pass++;
    console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libtest-'));
const srcPath = path.join(dir, 'src.db');
const dstPath = path.join(dir, 'dst.db');

function seed(store) {
  store.upsertRoom({ rid: 1001, name: '房间A', owner: '主播A' });
  store.upsertRoom({ rid: 1002, name: '房间B', owner: '主播B' });
  const base = Date.UTC(2026, 10, 4, 12, 0, 0);
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({
      rid: 1001,
      room_name: '房间A',
      uid: 5000 + (i % 7),
      nn: `用户${i % 7}`,
      txt: `房间A的第${i}句话 哈哈`,
      cst: base + i * 1000,
      level: 10 + (i % 20),
      kind: 'chat',
      source: 'live',
    });
  }
  for (let i = 0; i < 80; i++) {
    rows.push({
      rid: 1002,
      room_name: '房间B',
      uid: 6000 + (i % 5),
      nn: `观众${i % 5}`,
      txt: `房间B的第${i}句 开团`,
      cst: base + i * 900,
      level: 3 + (i % 9),
      kind: 'chat',
      source: 'live',
    });
  }
  // 同一毫秒、不同用户、完全相同的话：改指纹后应合并成一条
  rows.push({ rid: 1001, room_name: '房间A', uid: 777, nn: '甲', txt: '同一毫秒同一句话', cst: base + 999999, level: 5, kind: 'chat', source: 'live' });
  rows.push({ rid: 1001, room_name: '房间A', uid: 888, nn: '乙', txt: '同一毫秒同一句话', cst: base + 999999, level: 5, kind: 'chat', source: 'live' });
  store.insertBatch(rows);
  return store.stats().total;
}

(async () => {
  const srcStore = new Store(srcPath);
  srcStore.open();
  const inserted = seed(srcStore);
  ok(inserted === 201, '源库写入 201 条（同毫秒同内容已合并 1 条）', `实际 ${inserted}`);

  // 1. 匿名导出
  const anonPack = exportLibrary(srcStore, { anon: true });
  const pack = new DatabaseSync(anonPack.file, { readOnly: true });
  const meta = Object.fromEntries(pack.prepare('SELECT k, v FROM lib_meta').all().map((r) => [r.k, r.v]));
  const uids = pack.prepare('SELECT COUNT(*) AS c FROM messages WHERE uid != 0').get().c;
  const nns = pack.prepare('SELECT COUNT(*) AS c FROM messages WHERE nn != ?').get('匿名').c;
  pack.close();
  ok(meta.format === 'danmu-radar-library', '库包带 lib_meta.format');
  ok(meta.anon === '1', '匿名包标记 anon=1');
  ok(Number(meta.rows) === 201, '库包条数与源一致', `${meta.rows}`);
  ok(uids === 0, '匿名包里没有非零 uid', `非零 ${uids}`);
  ok(nns === 0, '匿名包里昵称都是「匿名」', `非匿名 ${nns}`);
  ok(anonPack.bytes > 10000, '库包有实际内容', `${(anonPack.bytes / 1024).toFixed(0)} KB`);

  // 2. 导进空库
  const dstStore = new Store(dstPath);
  dstStore.open();
  const r1 = importLibrary(dstStore, anonPack.file);
  ok(r1.inserted === 201 && r1.dupes === 0, '空库导入：全部新增', `新增 ${r1.inserted} / 重复 ${r1.dupes}`);

  // 3. 再导一遍
  const r2 = importLibrary(dstStore, anonPack.file);
  ok(r2.inserted === 0 && r2.dupes === 201, '重复导入：全部算重复', `新增 ${r2.inserted} / 重复 ${r2.dupes}`);

  // 4. 实名包导进已有匿名包的库：同一条弹幕不能翻倍
  const fullPack = exportLibrary(srcStore, { anon: false });
  const r3 = importLibrary(dstStore, fullPack.file);
  ok(r3.inserted === 0 && r3.dupes === 201, '实名包 × 匿名包：指纹一致，一条都不重复入库', `新增 ${r3.inserted} / 重复 ${r3.dupes}`);

  // 5. 反向：先实名后匿名
  const dst2 = new Store(path.join(dir, 'dst2.db'));
  dst2.open();
  const r4 = importLibrary(dst2, fullPack.file);
  const r5 = importLibrary(dst2, anonPack.file);
  ok(r4.inserted === 201 && r5.inserted === 0, '先实名后匿名：也不翻倍', `实名 ${r4.inserted} / 匿名 ${r5.inserted}`);

  // 6. 按房间 / 按时间切片
  const part = exportLibrary(srcStore, { rid: 1002, anon: true });
  const partDb = new DatabaseSync(part.file, { readOnly: true });
  const roomsInPart = partDb.prepare('SELECT DISTINCT rid FROM messages').all().map((r) => r.rid);
  partDb.close();
  ok(part.rows === 80 && roomsInPart.length === 1 && roomsInPart[0] === 1002, '按房间导出只含该房间', `${part.rows} 条`);

  const base = Date.UTC(2026, 10, 4, 12, 0, 0);
  const slice = exportLibrary(srcStore, { from: base + 50000, to: base + 80000, anon: true });
  ok(slice.rows > 0 && slice.rows < 201, '按时间导出是子集', `${slice.rows} 条`);

  // 7. 坏文件要拒绝
  const badFile = path.join(dir, 'bad.db');
  fs.writeFileSync(badFile, 'not a database');
  let threw = false;
  try {
    importLibrary(dstStore, badFile);
  } catch {
    threw = true;
  }
  ok(threw, '坏文件被拒绝');

  srcStore.close();
  dstStore.close();
  dst2.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
