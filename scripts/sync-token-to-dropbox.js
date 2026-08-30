/**
 * 運用ツール: 手元の freee_token.json を Dropbox の state パスへ同期する。
 *
 * 用途:
 *  - 初回切替（Mac側の最新トークンを Render の読み先へ引き渡す）
 *  - 障害復旧（invalid_grant でチェーンが切れた際、freee再認可後の新トークンを配置）
 *
 * 使い方:
 *   DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... DROPBOX_REFRESH_TOKEN=... \
 *   DROPBOX_ROOT_NAMESPACE_ID=... \
 *   node scripts/sync-token-to-dropbox.js /path/to/freee_token.json
 *
 * 表示はプレフィックス6文字とパスのみ（トークン全文は出さない）。
 */
'use strict';
const fs = require('fs');
const { DropboxClient } = require('../src/dropboxClient');

const STATE_PATH =
  process.env.DROPBOX_STATE_PATH ||
  '/D& W/社内/_bot-state/dw_line_freee_uploader/freee_token.json';

(async () => {
  const src = process.argv[2];
  if (!src) throw new Error('usage: sync-token-to-dropbox.js <freee_token.json>');
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  if (!data.refresh_token) throw new Error('refresh_token not found in ' + src);

  const dropbox = new DropboxClient({
    appKey: process.env.DROPBOX_APP_KEY,
    appSecret: process.env.DROPBOX_APP_SECRET,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
    rootNamespaceId: process.env.DROPBOX_ROOT_NAMESPACE_ID || null,
  });

  const body = Buffer.from(
    JSON.stringify(
      {
        refresh_token: data.refresh_token,
        updated_at: new Date().toISOString(),
        service: 'dw_line_freee_uploader',
        note: 'synced from Mac by scripts/sync-token-to-dropbox.js',
      },
      null,
      2
    ),
    'utf8'
  );
  const res = await dropbox.upload(STATE_PATH, body, { overwrite: true });
  console.log('synced:', res.status, STATE_PATH, 'prefix=' + data.refresh_token.slice(0, 6));

  const back = await dropbox.download(STATE_PATH);
  const check = JSON.parse(back.toString('utf8'));
  console.log('verify readback: prefix=' + check.refresh_token.slice(0, 6), 'updated_at=' + check.updated_at);
})().catch((e) => {
  console.error('FAILED:', String(e?.response?.status || ''), String(e?.dropboxBody || e).slice(0, 300));
  process.exit(1);
});
