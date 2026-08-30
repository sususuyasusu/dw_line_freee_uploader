'use strict';

const axios = require('axios');
const FormData = require('form-data');
const log = require('./logger');
const { retry, sleep } = require('./retry');

/**
 * freee API client.
 *
 * v2 additions over the Mac-era client:
 *  - single-flight token refresh (concurrent 401s must not double-rotate,
 *    because a lost rotation bricks the whole token chain)
 *  - refresh token load/persist delegated to a TokenStore (Dropbox-backed)
 *  - invalid_grant fallback to the env bootstrap token, then a loud
 *    auth-broken flag surfaced on the admin status endpoint
 *  - generic get/post helpers + a paginated receipts window used by the
 *    dedup gate and the deal registrar
 */
class FreeeClient {
  constructor({
    clientId,
    clientSecret,
    refreshToken,
    companyId,
    apiBase,
    oauthBase,
    tokenStore,
  }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.envBootstrapToken = refreshToken;
    this.companyId = companyId;
    this.apiBase = apiBase;
    this.oauthBase = oauthBase;
    this.tokenStore = tokenStore || null;

    this.refreshToken = null; // resolved lazily via tokenStore
    this.accessToken = null;
    this.authBroken = false;
    this.lastRefreshAt = null;
    this.rotations = 0;
    this._refreshing = null;
    this._loaded = false;
  }

  async _loadInitialToken() {
    if (this._loaded) return;
    this.refreshToken = this.tokenStore
      ? await this.tokenStore.load()
      : this.envBootstrapToken;
    this._loaded = true;
  }

  async _doRefresh(tokenToUse) {
    const url = `${this.oauthBase}/public_api/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: tokenToUse,
    });
    const res = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return res.data;
  }

  async refreshAccessToken() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      await this._loadInitialToken();
      let data;
      try {
        data = await this._doRefresh(this.refreshToken);
      } catch (err) {
        const body = JSON.stringify(err?.response?.data || '');
        const isInvalidGrant = body.includes('invalid_grant');
        if (isInvalidGrant && this.envBootstrapToken && this.envBootstrapToken !== this.refreshToken) {
          // The stored token chain is dead (e.g. state file lagged a rotation).
          // One recovery attempt with the env bootstrap before declaring broken.
          log.warn('freee.token.invalid_grant_retry_env');
          try {
            data = await this._doRefresh(this.envBootstrapToken);
          } catch (err2) {
            this.authBroken = true;
            log.error('freee.token.auth_broken', {
              detail: JSON.stringify(err2?.response?.data || String(err2)).slice(0, 300),
            });
            throw err2;
          }
        } else {
          if (isInvalidGrant) this.authBroken = true;
          throw err;
        }
      }
      this.accessToken = data.access_token;
      this.authBroken = false;
      this.lastRefreshAt = new Date().toISOString();
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token;
        this.rotations += 1;
        if (this.tokenStore) {
          // Await: the rotation must be durable before we do anything else —
          // an instance death between rotation and persist kills the chain.
          await this.tokenStore.persist(data.refresh_token);
        }
      }
      return this.accessToken;
    })();
    try {
      return await this._refreshing;
    } finally {
      this._refreshing = null;
    }
  }

  async ensureAccessToken() {
    if (!this.accessToken) await this.refreshAccessToken();
    return this.accessToken;
  }

  _shouldRetry(err) {
    const status = err?.response?.status;
    if (!status) return true; // network error
    if (status === 401) return true;
    if (status === 429) return true;
    if (status >= 500) return true;
    return false;
  }

  async _handleAuthAndBackoff(err) {
    const status = err?.response?.status;
    if (status === 401) {
      this.accessToken = null;
      await this.refreshAccessToken();
    } else if (status === 429) {
      const ra = parseInt(err.response.headers['retry-after'] || '0', 10);
      if (Number.isFinite(ra) && ra > 0) await sleep(Math.min(ra, 30) * 1000);
    }
  }

  /** Generic GET with auth/429/5xx handling. Returns response data. */
  async get(pathname, params = {}) {
    return retry(
      async () => {
        await this.ensureAccessToken();
        try {
          const res = await axios.get(`${this.apiBase}${pathname}`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            params: { company_id: this.companyId, ...params },
            timeout: 30000,
            validateStatus: (s) => s >= 200 && s < 300,
          });
          return res.data;
        } catch (err) {
          await this._handleAuthAndBackoff(err);
          throw err;
        }
      },
      { retries: 3, baseDelayMs: 1000, maxDelayMs: 8000, shouldRetry: (e) => this._shouldRetry(e) }
    );
  }

  /** Generic JSON POST with auth/429/5xx handling. Returns response data. */
  async post(pathname, body) {
    return retry(
      async () => {
        await this.ensureAccessToken();
        try {
          const res = await axios.post(`${this.apiBase}${pathname}`, body, {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
            validateStatus: (s) => s >= 200 && s < 300,
          });
          return res.data;
        } catch (err) {
          await this._handleAuthAndBackoff(err);
          throw err;
        }
      },
      {
        retries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        // POSTs are not idempotent (deal/partner creation) — only retry when
        // the request provably never executed (auth) or was throttled.
        shouldRetry: (e) => {
          const status = e?.response?.status;
          return status === 401 || status === 429;
        },
      }
    );
  }

  /**
   * Paginated receipts fetch. start/end filter on the UPLOAD date
   * (measured 2026-08-31: receipts with issue_date still null are returned,
   * membership follows created_at, ascending order).
   * Hard-fails on runaway pagination instead of silently truncating.
   */
  async listReceipts({ startDate, endDate }) {
    const all = [];
    let offset = 0;
    while (true) {
      const data = await this.get('/api/1/receipts', {
        start_date: startDate,
        end_date: endDate,
        limit: 100,
        offset,
      });
      const page = data.receipts || [];
      all.push(...page);
      if (page.length < 100) break;
      offset += 100;
      if (offset > 50000) {
        throw new Error(
          '[FATAL] receipts の取得が上限50,000件に達しました。欠落したまま続けると重複を作るため中断します。'
        );
      }
    }
    return all;
  }

  /** Download a receipt's stored file (used by the Saison mirror). */
  async downloadReceipt(receiptId) {
    return retry(
      async () => {
        await this.ensureAccessToken();
        try {
          const res = await axios.get(`${this.apiBase}/api/1/receipts/${receiptId}/download`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            params: { company_id: this.companyId },
            responseType: 'arraybuffer',
            timeout: 60000,
            validateStatus: (s) => s >= 200 && s < 300,
          });
          return Buffer.from(res.data);
        } catch (err) {
          await this._handleAuthAndBackoff(err);
          throw err;
        }
      },
      { retries: 3, baseDelayMs: 1000, shouldRetry: (e) => this._shouldRetry(e) }
    );
  }

  /**
   * Upload one receipt image to the freee file box via Receipts API.
   * Required parameters: company_id, receipt (file), description.
   * issue_date is deliberately omitted — OCR fills the metadata.
   */
  async uploadReceipt({ buffer, filename, contentType, description }) {
    return retry(
      async () => {
        await this.ensureAccessToken();
        const form = new FormData();
        form.append('company_id', String(this.companyId));
        form.append('description', description || 'LINE経由アップロード');
        form.append('receipt', buffer, { filename, contentType });

        try {
          const res = await axios.post(`${this.apiBase}/api/1/receipts`, form, {
            headers: {
              ...form.getHeaders(),
              Authorization: `Bearer ${this.accessToken}`,
              accept: 'application/json',
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 30000,
            validateStatus: (s) => s >= 200 && s < 300,
          });
          const body = res.data || {};
          const receipt = body.receipt || body;
          return { id: receipt && receipt.id, raw: body };
        } catch (err) {
          await this._handleAuthAndBackoff(err);
          throw err;
        }
      },
      {
        retries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        // The file-box POST is NOT idempotent. Retry only when the request
        // cannot have been accepted (auth/throttle/network-before-response
        // cannot be distinguished from timeouts, so: no 5xx/timeout retries —
        // LINE redelivery + the dedup gate are the recovery path instead).
        shouldRetry: (err) => {
          const status = err?.response?.status;
          return status === 401 || status === 429;
        },
      }
    );
  }
}

module.exports = { FreeeClient };
