'use strict';

const axios = require('axios');
const log = require('./logger');
const { retry } = require('./retry');

// Dropbox-API-Arg is an HTTP header, so every non-ASCII char (社内 etc.) must
// be \uXXXX-escaped. Same trick the official SDKs use.
function httpHeaderSafeJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

/**
 * Minimal Dropbox client for this bot's three needs:
 *   - persist/load the rotating freee refresh token (state file)
 *   - mirror Saison receipts (image + .md) into the 証憑写真 tree
 *
 * Uses the same app/refresh-token as the 証憑ボット (Dropbox refresh tokens
 * do not rotate, so sharing is safe). Team-space paths require the
 * Dropbox-API-Path-Root header with the root namespace id.
 */
class DropboxClient {
  constructor({ appKey, appSecret, refreshToken, rootNamespaceId }) {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.refreshToken = refreshToken;
    this.rootNamespaceId = rootNamespaceId;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this._refreshing = null;
  }

  async _refreshAccessToken() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.appKey,
        client_secret: this.appSecret,
      });
      const res = await axios.post('https://api.dropboxapi.com/oauth2/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      this.accessToken = res.data.access_token;
      const ttl = (res.data.expires_in || 14400) * 1000;
      this.accessTokenExpiresAt = Date.now() + ttl - 60000;
      return this.accessToken;
    })();
    try {
      return await this._refreshing;
    } finally {
      this._refreshing = null;
    }
  }

  async _ensureToken() {
    if (!this.accessToken || Date.now() >= this.accessTokenExpiresAt) {
      await this._refreshAccessToken();
    }
    return this.accessToken;
  }

  _headers(apiArg) {
    const h = {
      Authorization: `Bearer ${this.accessToken}`,
      'Dropbox-API-Arg': httpHeaderSafeJson(apiArg),
      'Content-Type': 'application/octet-stream',
    };
    if (this.rootNamespaceId) {
      h['Dropbox-API-Path-Root'] = httpHeaderSafeJson({
        '.tag': 'root',
        root: this.rootNamespaceId,
      });
    }
    return h;
  }

  /**
   * Upload a buffer. mode 'add' + autorename:false means an existing file
   * causes a conflict, which we report as {status:'skipped'} — matching the
   * old local-filesystem "skip if exists" semantics.
   */
  async upload(dropboxPath, buffer, { overwrite = false } = {}) {
    return retry(
      async () => {
        await this._ensureToken();
        try {
          const res = await axios.post(
            'https://content.dropboxapi.com/2/files/upload',
            buffer,
            {
              headers: this._headers({
                path: dropboxPath,
                mode: overwrite ? 'overwrite' : 'add',
                autorename: false,
                mute: true,
              }),
              maxBodyLength: Infinity,
              timeout: 60000,
              validateStatus: (s) => s >= 200 && s < 300,
            }
          );
          return { status: 'saved', meta: res.data };
        } catch (err) {
          const status = err?.response?.status;
          const tag = JSON.stringify(err?.response?.data || '');
          if (status === 409 && tag.includes('conflict')) {
            return { status: 'skipped' };
          }
          if (status === 401) this.accessToken = null;
          throw err;
        }
      },
      {
        retries: 3,
        baseDelayMs: 1000,
        shouldRetry: (err) => {
          const status = err?.response?.status;
          if (!status) return true;
          return status === 401 || status === 429 || status >= 500;
        },
      }
    );
  }

  /** Download a file; returns Buffer, or null when the path does not exist. */
  async download(dropboxPath) {
    return retry(
      async () => {
        await this._ensureToken();
        try {
          const res = await axios.post('https://content.dropboxapi.com/2/files/download', null, {
            headers: this._headers({ path: dropboxPath }),
            responseType: 'arraybuffer',
            timeout: 30000,
            validateStatus: (s) => s >= 200 && s < 300,
          });
          return Buffer.from(res.data);
        } catch (err) {
          const status = err?.response?.status;
          const body = err?.response?.data
            ? Buffer.from(err.response.data).toString().slice(0, 300)
            : '';
          if (status === 409 && body.includes('not_found')) return null;
          if (status === 401) this.accessToken = null;
          err.dropboxBody = body;
          throw err;
        }
      },
      {
        retries: 3,
        baseDelayMs: 1000,
        shouldRetry: (err) => {
          const status = err?.response?.status;
          if (!status) return true;
          return status === 401 || status === 429 || status >= 500;
        },
      }
    );
  }

  /** Connectivity probe for selftest: current account info. */
  async check() {
    await this._ensureToken();
    const res = await axios.post(
      'https://api.dropboxapi.com/2/users/get_current_account',
      null,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        timeout: 15000,
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
    return { ok: true, email: res.data?.email || null };
  }
}

module.exports = { DropboxClient, httpHeaderSafeJson };
