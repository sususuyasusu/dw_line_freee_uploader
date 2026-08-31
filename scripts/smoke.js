/**
 * ローカル煙テスト: 外部APIに一切触れずに検証できる範囲を通す。
 *  - /healthz 200
 *  - 署名不正 → 401
 *  - 正署名のテキストイベント → 200（replyは無効なので外部呼び出しなし）
 *  - ADMIN_KEY 無し/不一致 → /admin/* 404
 *  - DedupGate のメモリ動作と説明文マーカーの往復
 * 失敗時 exit 1。
 */
'use strict';

process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'dummy';
process.env.LINE_REPLY_ENABLED = 'false';
process.env.FREEE_CLIENT_ID = 'dummy';
process.env.FREEE_CLIENT_SECRET = 'dummy';
process.env.FREEE_REFRESH_TOKEN = 'dummy-refresh-token';
process.env.FREEE_COMPANY_ID = '800646';
process.env.DROPBOX_APP_KEY = 'dummy';
process.env.DROPBOX_APP_SECRET = 'dummy';
process.env.DROPBOX_REFRESH_TOKEN = 'dummy';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.REGISTRAR_ENABLED = 'false';
process.env.PORT = '0'; // 空きポートを自動採番（Macでは3000を旧サーバーが使用中）

const crypto = require('crypto');
const assert = require('assert');

const { start } = require('../src/server');
const { DedupGate, MSG_RE, IMG_RE } = require('../src/dedup');

function sign(body) {
  return crypto.createHmac('sha256', 'testsecret').update(body).digest('base64');
}

(async () => {
  const { server, ctx } = start();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // 1. healthz
  let res = await fetch(`${base}/healthz`);
  assert.strictEqual(res.status, 200, 'healthz should be 200');
  assert.deepStrictEqual(await res.json(), { ok: true });

  // 2. bad signature
  res = await fetch(`${base}/webhook/line`, {
    method: 'POST',
    headers: { 'X-Line-Signature': 'bogus', 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  assert.strictEqual(res.status, 401, 'bad signature should be 401');

  // 3. valid signature, text message event (no external calls in silent mode)
  const payload = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'rt',
        timestamp: Date.now(),
        source: { type: 'group', groupId: 'G1', userId: 'U1' },
        message: { type: 'text', id: 'm-text-1', text: 'こんにちは' },
        deliveryContext: { isRedelivery: false },
      },
    ],
  });
  res = await fetch(`${base}/webhook/line`, {
    method: 'POST',
    headers: { 'X-Line-Signature': sign(payload), 'Content-Type': 'application/json' },
    body: payload,
  });
  assert.strictEqual(res.status, 200, 'text event should ack 200');

  // 4. admin guard
  res = await fetch(`${base}/admin/status`);
  assert.strictEqual(res.status, 404, 'admin without key should be 404');
  res = await fetch(`${base}/admin/status`, { headers: { 'X-Admin-Key': 'wrong' } });
  assert.strictEqual(res.status, 404, 'admin with wrong key should be 404');
  res = await fetch(`${base}/admin/status`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
  assert.strictEqual(res.status, 200, 'admin with key should be 200');
  const status = await res.json();
  assert.strictEqual(status.stats.webhookCalls, 1, 'webhookCalls counted (401 excluded)');

  // 5. DedupGate: スキャン結果スナップショットの照合（freeeはスタブ）
  const fakeFreee = {
    listReceipts: async () => [
      { id: 111, description: 'LINE た [どら山現金領収書] 2026-08-28 19:29 msg=52951018' },
      { id: 222, description: 'LINE ひかり [どら山現金領収書] 2026-08-31 09:00 msg=629661085397942479 img=abc123def456' },
    ],
  };
  const scanGate = new DedupGate({ freee: fakeFreee, windowDays: 90 });
  const snap = await scanGate.scanFreee();
  assert.strictEqual(snap.count, 2);
  assert.strictEqual(snap.hasMessage('52951018').receiptId, 111, '旧形式(下8桁)のIDも一致すること');
  assert.strictEqual(snap.hasMessage('629661085397942479').receiptId, 222);
  assert.strictEqual(snap.hasMessage('999999999'), null);
  assert.strictEqual(snap.hasHash('abc123def456' + 'f'.repeat(52)).receiptId, 222, 'ハッシュ前方一致');
  assert.strictEqual(snap.hasHash('0'.repeat(64)), null);
  assert.strictEqual(scanGate.findLocal('52951018').status, 'uploaded', 'スキャンでメモリが温まること');

  // 6. DedupGate memory behavior
  const gate = new DedupGate({ freee: null, windowDays: 90 });
  gate.markReceived('MSG1');
  assert.strictEqual(gate.findLocal('MSG1').status, 'received');
  gate.release('MSG1');
  assert.strictEqual(gate.findLocal('MSG1'), null, 'release clears in-flight');
  gate.markUploaded('MSG2', { hash: 'a'.repeat(64), receiptId: 42 });
  assert.strictEqual(gate.findLocalByHash('a'.repeat(64)).receiptId, 42);

  // 7. description marker round-trip
  const desc = 'LINE た [どら山現金領収書] 2026-08-31 09:00 msg=581553121418804532 img=abcdef012345';
  assert.strictEqual(desc.match(MSG_RE)[1], '581553121418804532');
  assert.strictEqual(desc.match(IMG_RE)[1], 'abcdef012345');
  // 旧フォーマット（msg=下8桁のみ）にも反応すること
  const legacy = 'LINE た [どら山現金領収書] 2026-08-28 19:29 msg=52951018';
  assert.strictEqual(legacy.match(MSG_RE)[1], '52951018');

  server.close();
  ctx.scheduler.stop();
  console.log('SMOKE OK');
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
