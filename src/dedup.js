'use strict';

const log = require('./logger');

const MSG_RE = /msg=([A-Za-z0-9_-]{6,})/;
const IMG_RE = /img=([a-f0-9]{8,})/;

/**
 * Two-layer duplicate gate.
 *
 * Layer 1 — in-memory maps (message id / image hash). Fast path; also acts as
 * the in-flight lock against concurrent deliveries of the same event. Lost on
 * restart, which is fine because of:
 *
 * Layer 2 — freee itself. Every upload stamps `msg=<full LINE message id>` and
 * `img=<sha256 prefix>` into the receipt description; before any upload we
 * scan the recent receipts window (upload-date based, measured) for either
 * marker. This survives restarts/deploys, which on Render free tier happen at
 * every wake — it is the property that makes enabling LINE webhook redelivery
 * safe for a non-idempotent destination.
 */
class DedupGate {
  constructor({ freee, windowDays }) {
    this.freee = freee;
    this.windowDays = windowDays;
    this.byMessageId = new Map(); // messageId -> {status, receiptId, hash, at}
    this.byHash = new Map(); // sha256 -> messageId
    this.lastScanCount = 0;
    this.lastScanAt = null;
  }

  _remember(messageId, entry) {
    const prev = this.byMessageId.get(messageId) || {};
    const next = { ...prev, ...entry, at: new Date().toISOString() };
    this.byMessageId.set(messageId, next);
    if (next.hash) this.byHash.set(next.hash, messageId);
    // Cheap cap so a very long-lived instance cannot grow unbounded.
    if (this.byMessageId.size > 20000) {
      const firstKey = this.byMessageId.keys().next().value;
      const evicted = this.byMessageId.get(firstKey);
      if (evicted?.hash) this.byHash.delete(evicted.hash);
      this.byMessageId.delete(firstKey);
    }
  }

  markReceived(messageId) {
    this._remember(messageId, { status: 'received' });
  }

  markUploaded(messageId, { hash, receiptId }) {
    this._remember(messageId, { status: 'uploaded', hash, receiptId });
  }

  markFinal(messageId, status, extra = {}) {
    this._remember(messageId, { status, ...extra });
  }

  /** Forget an in-flight marker so a redelivery can retry a failed event. */
  release(messageId) {
    const cur = this.byMessageId.get(messageId);
    if (cur && cur.status === 'received') this.byMessageId.delete(messageId);
  }

  findLocal(messageId) {
    return this.byMessageId.get(messageId) || null;
  }

  findLocalByHash(hash) {
    const msgId = this.byHash.get(hash);
    if (!msgId) return null;
    const entry = this.byMessageId.get(msgId);
    return entry && entry.status === 'uploaded' ? { ...entry, messageId: msgId } : null;
  }

  _jstDate(offsetDays = 0) {
    const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Durable check against freee. Returns {found, receiptId, matchedBy} and
   * seeds the in-memory maps with every marker seen, so subsequent events in
   * this process answer locally.
   */
  async checkFreee({ messageId, hash }) {
    const receipts = await this.freee.listReceipts({
      startDate: this._jstDate(-this.windowDays),
      endDate: this._jstDate(1),
    });
    this.lastScanCount = receipts.length;
    this.lastScanAt = new Date().toISOString();

    let found = null;
    for (const r of receipts) {
      const desc = r.description || '';
      const m = desc.match(MSG_RE);
      const h = desc.match(IMG_RE);
      if (m) {
        this._remember(m[1], {
          status: 'uploaded',
          receiptId: r.id,
          hash: h ? h[1] : undefined,
        });
      }
      const msgHit = m && messageId && m[1] === String(messageId);
      // Hash markers are a 12-hex prefix; compare prefixes.
      const hashHit = h && hash && hash.startsWith(h[1]);
      if ((msgHit || hashHit) && !found) {
        found = { found: true, receiptId: r.id, matchedBy: msgHit ? 'message_id' : 'image_hash' };
      }
    }
    if (found) {
      log.info('dedup.freee_hit', { messageId, ...found });
      return found;
    }
    return { found: false };
  }
}

module.exports = { DedupGate, MSG_RE, IMG_RE };
