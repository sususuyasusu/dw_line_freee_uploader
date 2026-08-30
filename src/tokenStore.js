'use strict';

const log = require('./logger');

/**
 * Persistence for the rotating freee refresh token.
 *
 * freee rotates the refresh token on every access-token refresh, and Render's
 * filesystem is wiped on every restart/deploy — so the only safe home for the
 * current token is external durable storage. We use a small JSON file in
 * Dropbox (same account the Saison mirror writes to).
 *
 * Load order: Dropbox state file → env bootstrap.
 * Every rotation is written back to Dropbox immediately; failure to persist
 * is loud (health flag) but non-fatal — the in-memory token keeps the
 * current process alive, and the risk window is only until the next restart.
 */
class TokenStore {
  constructor({ dropbox, statePath, envBootstrapToken }) {
    this.dropbox = dropbox;
    this.statePath = statePath;
    this.envBootstrapToken = envBootstrapToken;
    this.lastPersistOk = null;
    this.lastPersistAt = null;
    this.lastLoadSource = null;
  }

  async load() {
    try {
      const buf = await this.dropbox.download(this.statePath);
      if (buf) {
        const data = JSON.parse(buf.toString('utf8'));
        if (data && typeof data.refresh_token === 'string' && data.refresh_token.length > 10) {
          this.lastLoadSource = 'dropbox';
          log.info('freee.token.loaded', {
            source: 'dropbox',
            updated_at: data.updated_at || null,
            prefix: data.refresh_token.slice(0, 6),
          });
          return data.refresh_token;
        }
      }
    } catch (err) {
      log.error('freee.token.load_failed', { err: String(err).slice(0, 300) });
    }
    this.lastLoadSource = 'env';
    log.info('freee.token.loaded', { source: 'env(bootstrap)' });
    return this.envBootstrapToken;
  }

  async persist(refreshToken) {
    const body = Buffer.from(
      JSON.stringify(
        {
          refresh_token: refreshToken,
          updated_at: new Date().toISOString(),
          service: 'dw_line_freee_uploader',
        },
        null,
        2
      ),
      'utf8'
    );
    try {
      await this.dropbox.upload(this.statePath, body, { overwrite: true });
      this.lastPersistOk = true;
      this.lastPersistAt = new Date().toISOString();
      log.info('freee.token.persisted', { prefix: refreshToken.slice(0, 6) });
    } catch (err) {
      this.lastPersistOk = false;
      log.error('freee.token.persist_failed', { err: String(err).slice(0, 300) });
    }
  }
}

module.exports = { TokenStore };
