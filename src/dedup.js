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
   * One durable scan of the recent freee receipts window, returned as a
   * reusable snapshot. Callers check the message id BEFORE fetching image
   * content (so a redelivery costs no content fetch, and is still recognised
   * after LINE's content retention expires) and the image hash after, against
   * the SAME snapshot — one freee scan per new message, not two.
   * Also seeds the in-memory maps so later events answer locally.
   */
  async scanFreee() {
    const receipts = await this.freee.listReceipts({
      startDate: this._jstDate(-this.windowDays),
      endDate: this._jstDate(1),
    });
    this.lastScanCount = receipts.length;
    this.lastScanAt = new Date().toISOString();

    const byMsg = new Map(); // full or legacy-truncated message id -> receiptId
    const byImgPrefix = new Map(); // sha256 prefix -> receiptId
    for (const r of receipts) {
      const desc = r.description || '';
      const m = desc.match(MSG_RE);
      const h = desc.match(IMG_RE);
      if (m) {
        byMsg.set(m[1], r.id);
        this._remember(m[1], { status: 'uploaded', receiptId: r.id, hash: h ? h[1] : undefined });
      }
      if (h) byImgPrefix.set(h[1], r.id);
    }

    return {
      count: receipts.length,
      hasMessage(messageId) {
        const id = String(messageId);
        return byMsg.has(id) ? { receiptId: byMsg.get(id), matchedBy: 'message_id' } : null;
      },
      hasHash(hash) {
        for (const [prefix, receiptId] of byImgPrefix) {
          if (hash.startsWith(prefix)) return { receiptId, matchedBy: 'image_hash' };
        }
        return null;
      },
    };
  }
}

module.exports = { DedupGate, MSG_RE, IMG_RE };
