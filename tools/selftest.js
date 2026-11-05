'use strict';

/**
 * 自检脚本：验证房间解析 + 弹幕连接是否正常。
 * 用法：node tools/selftest.js 475252 [时长秒]
 */

const { fetchRoomInfo, DanmuClient } = require('../server/douyu');

const input = process.argv[2] || '475252';
const seconds = Number(process.argv[3] || 12);

(async () => {
  const info = await fetchRoomInfo(input);
  console.log('ROOM', JSON.stringify(info));

  const client = new DanmuClient(info, { onLog: (m) => console.log('LOG', m) });
  let chats = 0;
  const samples = [];
  client.on('chat', (m) => {
    chats++;
    if (samples.length < 8) samples.push(`${m.nn}: ${m.txt}`);
  });
  client.on('event', (e) => {
    if (samples.length < 12) samples.push(`[${e.kind}] ${e.nn}`);
  });

  await client.start();
  setTimeout(() => {
    client.stop();
    console.log('---');
    console.log(`12 秒内收到弹幕 ${chats} 条，消息 ${client.stats.received} 条`);
    for (const s of samples) console.log('  ' + s);
    process.exit(chats > 0 ? 0 : 2);
  }, seconds * 1000);
})().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
