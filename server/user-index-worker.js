'use strict';

// 用户聚合索引的离线构建：在主线程之外全表扫一次，避免 3 秒重建卡住采集。
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

try {
  const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT m.uid,
              (SELECT nn FROM messages m2
                WHERE m2.uid = m.uid AND m2.kind = 'chat' AND m2.nn != ''
                ORDER BY m2.cst DESC, m2.id DESC LIMIT 1) AS nn,
              COUNT(*) AS n, MAX(m.cst) AS last, COUNT(DISTINCT m.rid) AS rooms,
              MIN(CASE WHEN m.kind = 'chat' THEN m.cst END) AS chat_first,
              MAX(CASE WHEN m.kind = 'chat' THEN m.cst END) AS chat_last,
              SUM(CASE WHEN m.kind = 'chat' THEN 1 ELSE 0 END) AS chat_n,
              COUNT(DISTINCT CASE WHEN m.kind = 'chat' THEN m.rid END) AS chat_rooms,
              MAX(CASE WHEN m.kind = 'chat' THEN m.level END) AS chat_level
         FROM messages m WHERE m.uid != '' GROUP BY m.uid ORDER BY n DESC`
    )
    .all();
  db.close();
  parentPort.postMessage({ ok: true, rows });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}