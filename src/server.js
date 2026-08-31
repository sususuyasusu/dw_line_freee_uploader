'use strict';

const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const log = require('./logger');
const { LineClient } = require('./lineClient');
const { FreeeClient } = require('./freeeClient');
const { DropboxClient } = require('./dropboxClient');
const { TokenStore } = require('./tokenStore');
const { DedupGate } = require('./dedup');
const { Registrar } = require('./registrar');
const { Scheduler } = require('./scheduler');
const {
  detectImageType,
  sha256,
  extensionFor,
  contentTypeFor,
  compressIfNeeded,
} = require('./imageUtils');

const REPLY = {
  success:
    '領収書画像をfreeeファイルボックスへアップロードしました。freee側でOCR読み取り後、内容確認・経費計上を行ってください。',
  duplicate: 'この領収書画像はすでにfreeeへ取り込み済みです。',
  notImage: '領収書の写真を送ってください。',
  uploadFailed: 'freeeへのアップロードに失敗しました。管理者に確認してください。',
};

// How long a webhook request may stay synchronous. Finishing within the
// budget lets us answer 4xx/5xx meaningfully so LINE's redelivery retries
// genuine failures; past the budget we ack 200 and finish in the background
// (legacy behavior). If LINE has already timed out on its side, our late
// status is simply ignored — redelivery + the dedup gate absorb both cases.
const SYNC_BUDGET_MS = 15000;

const stats = {
  startedAt: new Date().toISOString(),
  webhookCalls: 0,
  eventsSeen: 0,
  redeliveries: 0,
  uploaded: 0,
  duplicates: 0,
  rejected: 0,
  failed: 0,
  lastEventAt: null,
  lastUploadAt: null,
  lastError: null,
};

function formatJstDateTime(iso) {
  try {
    const d = new Date(iso);
    const jst = new Date(d.getTime() + 9 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}` +
      ` ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`
    );
  } catch (_e) {
    return iso || '';
  }
}

function formatDescription({ displayName, groupName, sourceType, userId, messageId, receivedAt, hash }) {
  // Human-friendly first; machine markers last. `msg=` carries the FULL LINE
  // message id and `img=` a sha256 prefix — both are what the durable dedup
  // gate greps for, so they must stay stable.
  const who = displayName || (userId ? `user=${userId.slice(0, 8)}…` : 'unknown');
  const where =
    sourceType === 'group'
      ? `[${groupName || 'グループ'}]`
      : sourceType === 'room'
      ? '[複数人トーク]'
      : '[個別]';
  const when = formatJstDateTime(receivedAt);
  const markers = `msg=${messageId} img=${hash.slice(0, 12)}`;
  return `LINE ${who} ${where} ${when} ${markers}`.trim();
}

// Outcome of one event: 'ok' | 'transient' (worth a redelivery) | 'permanent'
async function handleEvent(event, ctx) {
  const { dedup, line, freee } = ctx;
  if (event.type !== 'message') return 'ok';
  const message = event.message || {};
  const replyToken = event.replyToken;
  const userId = event.source?.userId || null;
  const isRedelivery = event.deliveryContext?.isRedelivery === true;

  stats.eventsSeen += 1;
  stats.lastEventAt = new Date().toISOString();
  if (isRedelivery) stats.redeliveries += 1;

  if (message.type !== 'image') {
    await safeReply(line, replyToken, REPLY.notImage);
    return 'ok';
  }

  const messageId = message.id;
  if (!messageId) {
    log.warn('event.image.no_message_id');
    return 'ok';
  }

  const groupId = event.source?.groupId || event.source?.roomId || null;
  log.info('event.image', {
    sourceType: event.source?.type || 'user',
    groupId,
    userId,
    messageId,
    isRedelivery,
  });

  // L1: in-memory (also the in-flight lock against concurrent deliveries).
  const existing = dedup.findLocal(messageId);
  if (existing) {
    if (existing.status === 'uploaded' || existing.status === 'duplicate') {
      stats.duplicates += 1;
      log.info('event.image.duplicate_local', { messageId, receiptId: existing.receiptId });
      await safeReply(line, replyToken, REPLY.duplicate);
    } else if (existing.status === 'received') {
      log.warn('event.image.already_in_flight', { messageId });
    } else {
      // previously failed/rejected in this process; a redelivery may retry
      if (isRedelivery && existing.status === 'failed') {
        log.info('event.image.retry_after_failure', { messageId });
        dedup.byMessageId.delete(messageId);
        return processImage({ event, messageId, replyToken, userId }, ctx);
      }
      await safeReply(line, replyToken, REPLY.uploadFailed);
    }
    return 'ok';
  }

  return processImage({ event, messageId, replyToken, userId }, ctx);
}

async function processImage({ event, messageId, replyToken, userId }, ctx) {
  const { dedup, line, freee } = ctx;
  dedup.markReceived(messageId);

  // Durable gate, part 1: message id — BEFORE fetching content, so a
  // redelivery of an already-stored receipt costs no content fetch and is
  // still recognised after LINE's content retention window has passed.
  let scan;
  try {
    scan = await dedup.scanFreee();
    const msgHit = scan.hasMessage(messageId);
    if (msgHit) {
      dedup.markFinal(messageId, 'duplicate', { receiptId: msgHit.receiptId });
      stats.duplicates += 1;
      log.info('event.image.duplicate_durable', {
        messageId,
        receiptId: msgHit.receiptId,
        matchedBy: msgHit.matchedBy,
      });
      await safeReply(line, replyToken, REPLY.duplicate);
      return 'ok';
    }
  } catch (err) {
    // Without a usable scan we cannot prove this is not a duplicate, and the
    // file box is not idempotent — refuse rather than risk a double post.
    dedup.release(messageId);
    stats.failed += 1;
    stats.lastError = `dedup_scan ${String(err).slice(0, 120)}`;
    log.error('event.dedup.scan_failed', { messageId, err: String(err).slice(0, 300) });
    return 'transient';
  }

  let buffer;
  try {
    buffer = await line.fetchImageContent(messageId);
  } catch (err) {
    const status = err?.response?.status;
    dedup.release(messageId);
    if (status && status >= 400 && status < 500) {
      // Content expired or bogus id — a redelivery cannot fix this.
      log.warn('event.image.content_gone', { messageId, status });
      stats.rejected += 1;
      return 'permanent';
    }
    log.error('event.image.content_fetch_failed', { messageId, err: String(err).slice(0, 200) });
    stats.failed += 1;
    stats.lastError = `content_fetch ${String(err).slice(0, 120)}`;
    return 'transient';
  }

  try {
    const type = detectImageType(buffer);
    if (!type) {
      dedup.markFinal(messageId, 'rejected');
      stats.rejected += 1;
      await safeReply(line, replyToken, REPLY.notImage);
      return 'ok';
    }

    const hash = sha256(buffer);

    // L1 by content hash (user re-sent the same photo as a new message).
    const hashDup = dedup.findLocalByHash(hash);
    if (hashDup) {
      dedup.markFinal(messageId, 'duplicate', { hash, receiptId: hashDup.receiptId });
      stats.duplicates += 1;
      log.info('event.image.duplicate_hash_local', { messageId, receiptId: hashDup.receiptId });
      await safeReply(line, replyToken, REPLY.duplicate);
      return 'ok';
    }

    // Durable gate, part 2: same photo re-sent as a different message —
    // checked against the snapshot already taken above (no second scan).
    const hashHit = scan.hasHash(hash);
    if (hashHit) {
      dedup.markFinal(messageId, 'duplicate', { hash, receiptId: hashHit.receiptId });
      stats.duplicates += 1;
      log.info('event.image.duplicate_durable', {
        messageId,
        receiptId: hashHit.receiptId,
        matchedBy: hashHit.matchedBy,
      });
      await safeReply(line, replyToken, REPLY.duplicate);
      return 'ok';
    }

    const { buffer: finalBuffer, type: finalType } = await compressIfNeeded(
      buffer,
      type,
      config.image.maxSizeBytes
    );
    const ext = extensionFor(finalType);
    const filename = `${hash.slice(0, 16)}_${messageId}.${ext}`;

    const receivedAt = new Date(event.timestamp || Date.now()).toISOString();
    const [displayName, groupName] = await Promise.all([
      line.fetchDisplayName(event.source, userId),
      event.source?.type === 'group'
        ? line.fetchGroupName(event.source.groupId)
        : Promise.resolve(null),
    ]);
    const description = formatDescription({
      displayName,
      groupName,
      sourceType: event.source?.type,
      userId,
      messageId,
      receivedAt,
      hash,
    });

    const result = await freee.uploadReceipt({
      buffer: finalBuffer,
      filename,
      contentType: contentTypeFor(finalType),
      description,
    });

    dedup.markUploaded(messageId, { hash, receiptId: result.id || null });
    stats.uploaded += 1;
    stats.lastUploadAt = new Date().toISOString();
    log.info('freee.upload.ok', { messageId, receiptId: result.id });
    await safeReply(line, replyToken, REPLY.success);
    return 'ok';
  } catch (err) {
    const status = err?.response?.status;
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : String(err);
    const permanent = status && status >= 400 && status < 500 && status !== 401 && status !== 429;
    if (permanent) {
      dedup.markFinal(messageId, 'rejected', { error: detail.slice(0, 300) });
      stats.rejected += 1;
    } else {
      dedup.markFinal(messageId, 'failed', { error: detail.slice(0, 300) });
      dedup.release(messageId); // allow a redelivery to retry
      stats.failed += 1;
    }
    stats.lastError = `upload ${detail.slice(0, 160)}`;
    log.error('event.upload.failed', { messageId, status, err: detail.slice(0, 400) });
    await safeReply(line, replyToken, REPLY.uploadFailed);
    return permanent ? 'permanent' : 'transient';
  }
}

async function safeReply(line, replyToken, text) {
  if (!replyToken) return;
  if (config.line.replyEnabled === false) return; // silent mode
  try {
    await line.replyText(replyToken, text);
  } catch (err) {
    log.warn('line.reply.failed', { err: String(err).slice(0, 200) });
  }
}

function adminGuard(req, res) {
  if (!config.admin.key) {
    res.status(404).end();
    return false;
  }
  const given = req.get('X-Admin-Key') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(config.admin.key).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    res.status(404).end();
    return false;
  }
  return true;
}

function buildApp(ctx) {
  const { line, freee, dropbox, dedup, registrar, tokenStore } = ctx;
  const app = express();

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post(
    '/webhook/line',
    express.raw({ type: '*/*', limit: '20mb' }),
    async (req, res) => {
      const signature = req.get('X-Line-Signature');
      if (!line.verifySignature(req.body, signature)) {
        log.warn('line.signature.invalid');
        return res.status(401).send('invalid signature');
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch (err) {
        log.warn('line.body.parse_failed', { err: String(err).slice(0, 200) });
        return res.status(400).send('invalid json');
      }

      stats.webhookCalls += 1;
      const events = Array.isArray(payload.events) ? payload.events : [];

      // Process within a sync budget so genuine failures can answer non-2xx
      // (which is what makes LINE's redelivery retry them). Past the budget,
      // ack 200 and let the rest finish in the background.
      let acked = false;
      const ackTimer = setTimeout(() => {
        acked = true;
        res.status(200).end();
        log.info('webhook.ack_by_budget', { events: events.length });
      }, SYNC_BUDGET_MS);

      let worst = 'ok';
      for (const event of events) {
        try {
          const outcome = await handleEvent(event, ctx);
          if (outcome === 'transient') worst = 'transient';
        } catch (err) {
          worst = 'transient';
          log.error('event.handler.unhandled', {
            err: String(err).slice(0, 300),
            stack: (err?.stack || '').slice(0, 500),
          });
        }
      }

      clearTimeout(ackTimer);
      if (!acked) {
        if (worst === 'transient') {
          res.status(503).send('transient failure; please redeliver');
        } else {
          res.status(200).end();
        }
      }
    }
  );

  app.get('/admin/status', (req, res) => {
    if (!adminGuard(req, res)) return;
    res.json({
      version: process.env.RENDER_GIT_COMMIT || 'local',
      stats,
      freee: {
        authBroken: freee.authBroken,
        lastRefreshAt: freee.lastRefreshAt,
        rotations: freee.rotations,
        tokenSource: tokenStore.lastLoadSource,
        tokenPersistOk: tokenStore.lastPersistOk,
        tokenPersistAt: tokenStore.lastPersistAt,
      },
      dedup: {
        memEntries: dedup.byMessageId.size,
        lastScanCount: dedup.lastScanCount,
        lastScanAt: dedup.lastScanAt,
        windowDays: config.dedup.windowDays,
      },
      registrar: {
        running: registrar.running,
        lastRunAt: registrar.lastRunAt,
        lastResult: registrar.lastResult,
        commitMode: config.registrar.commit,
        enabled: config.registrar.enabled,
      },
    });
  });

  app.post('/admin/selftest', async (req, res) => {
    if (!adminGuard(req, res)) return;
    const out = { at: new Date().toISOString() };
    try {
      const acct = await dropbox.check();
      out.dropbox = { ok: true, email: acct.email };
    } catch (err) {
      out.dropbox = { ok: false, err: String(err).slice(0, 200) };
    }
    try {
      const buf = await dropbox.download(config.dropbox.statePath);
      out.tokenState = buf
        ? { present: true, updated_at: JSON.parse(buf.toString('utf8')).updated_at }
        : { present: false };
    } catch (err) {
      out.tokenState = { error: String(err).slice(0, 200) };
    }
    try {
      const receipts = await freee.listReceipts({
        startDate: new Date(Date.now() + 9 * 3600 * 1000 - 7 * 86400 * 1000)
          .toISOString()
          .slice(0, 10),
        endDate: new Date(Date.now() + 9 * 3600 * 1000 + 86400 * 1000).toISOString().slice(0, 10),
      });
      out.freee = { ok: true, recentReceipts: receipts.length, rotations: freee.rotations };
    } catch (err) {
      out.freee = {
        ok: false,
        err: JSON.stringify(err?.response?.data || String(err)).slice(0, 300),
      };
    }
    try {
      const axios = require('axios');
      const ep = await axios.get('https://api.line.me/v2/bot/channel/webhook/endpoint', {
        headers: { Authorization: `Bearer ${config.line.channelAccessToken}` },
        timeout: 10000,
      });
      out.lineWebhook = ep.data;
    } catch (err) {
      out.lineWebhook = { error: String(err).slice(0, 200) };
    }
    res.json(out);
  });

  // 調査用（読み取りのみ）: 領収書1件の詳細。一覧APIとメタデータの差異確認に使う。
  app.get('/admin/receipt/:id', async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const data = await freee.get(`/api/1/receipts/${req.params.id}`);
      res.json(data);
    } catch (err) {
      res.status(500).json({
        error: JSON.stringify(err?.response?.data || String(err)).slice(0, 500),
      });
    }
  });

  app.post('/admin/registrar/run', express.json(), async (req, res) => {
    if (!adminGuard(req, res)) return;
    const commit = req.body?.commit === true;
    try {
      const result = await ctx.registrar.runOnce({ commit });
      res.json({ commit, result });
    } catch (err) {
      res.status(500).json({
        commit,
        error: JSON.stringify(err?.response?.data || String(err)).slice(0, 500),
      });
    }
  });

  return app;
}

function start() {
  const line = new LineClient(config.line);
  const dropbox = new DropboxClient(config.dropbox);
  const tokenStore = new TokenStore({
    dropbox,
    statePath: config.dropbox.statePath,
    envBootstrapToken: config.freee.refreshToken,
  });
  const freee = new FreeeClient({ ...config.freee, tokenStore });
  const dedup = new DedupGate({ freee, windowDays: config.dedup.windowDays });
  const registrar = new Registrar({
    freee,
    dropbox,
    saisonRoot: config.dropbox.saisonRoot,
  });
  const scheduler = new Scheduler({
    registrar,
    slotsJst: config.registrar.slotsJst,
    commit: config.registrar.commit,
    enabled: config.registrar.enabled,
  });

  const ctx = { line, freee, dropbox, tokenStore, dedup, registrar, scheduler };
  const app = buildApp(ctx);
  const server = app.listen(config.port, () => {
    log.info('server.listening', { port: config.port });
  });
  scheduler.start();

  const shutdown = (sig) => {
    log.info('server.shutdown', { sig });
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { app, server, ctx };
}

module.exports = { buildApp, handleEvent, REPLY, start };

if (require.main === module) {
  start();
}
