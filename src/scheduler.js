'use strict';

const log = require('./logger');

/**
 * Registrar cadence without cron: a 60s tick checks whether a JST slot hour
 * has been reached, plus one catch-up sweep ~90s after boot.
 *
 * On Render free tier the instance sleeps between requests, so ticks only
 * happen while awake — that is by design: the boot sweep covers wake-ups,
 * and the Mac-side guard pings the service around the slot hours so a
 * sleeping instance gets woken for them. Every sweep is idempotent
 * (linked-receipt check), so a missed slot is caught by the next one.
 */
class Scheduler {
  constructor({ registrar, slotsJst, commit, enabled }) {
    this.registrar = registrar;
    this.slotsJst = slotsJst;
    this.commit = commit;
    this.enabled = enabled;
    this.doneSlots = new Set(); // 'YYYY-MM-DD-H'
    this.timer = null;
    this.bootTimer = null;
  }

  _jstNow() {
    return new Date(Date.now() + 9 * 3600 * 1000);
  }

  start() {
    if (!this.enabled) {
      log.info('scheduler.disabled');
      return;
    }
    this.bootTimer = setTimeout(() => {
      this._sweep('boot');
    }, 90 * 1000);
    this.timer = setInterval(() => {
      const jst = this._jstNow();
      const hour = jst.getUTCHours();
      if (!this.slotsJst.includes(hour)) return;
      const key = `${jst.toISOString().slice(0, 10)}-${hour}`;
      if (this.doneSlots.has(key)) return;
      this.doneSlots.add(key);
      if (this.doneSlots.size > 50) {
        this.doneSlots.delete(this.doneSlots.values().next().value);
      }
      this._sweep(`slot-${hour}`);
    }, 60 * 1000);
    if (this.timer.unref) this.timer.unref();
    if (this.bootTimer.unref) this.bootTimer.unref();
    log.info('scheduler.started', { slotsJst: this.slotsJst, commit: this.commit });
  }

  async _sweep(reason) {
    try {
      log.info('scheduler.sweep', { reason, commit: this.commit });
      await this.registrar.runOnce({ commit: this.commit });
    } catch (err) {
      log.error('scheduler.sweep_failed', { reason, err: String(err).slice(0, 300) });
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
  }
}

module.exports = { Scheduler };
