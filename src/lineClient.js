'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { retry } = require('./retry');

class LineClient {
  constructor({ channelSecret, channelAccessToken, apiBase, dataApiBase }) {
    this.channelSecret = channelSecret;
    this.channelAccessToken = channelAccessToken;
    this.apiBase = apiBase;
    this.dataApiBase = dataApiBase;
  }

  /**
   * Verify the X-Line-Signature header against a raw request body.
   * @param {Buffer|string} rawBody  Raw body bytes from the webhook request
   * @param {string} signature       Value of the X-Line-Signature header
   */
  verifySignature(rawBody, signature) {
    if (!signature) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
    const expected = crypto
      .createHmac('sha256', this.channelSecret)
      .update(body)
      .digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async fetchImageContent(messageId) {
    const url = `${this.dataApiBase}/v2/bot/message/${messageId}/content`;
    return retry(
      async () => {
        const res = await axios.get(url, {
          headers: { Authorization: `Bearer ${this.channelAccessToken}` },
          responseType: 'arraybuffer',
          timeout: 20000,
          validateStatus: (s) => s >= 200 && s < 300,
        });
        return Buffer.from(res.data);
      },
      {
        retries: 3,
        baseDelayMs: 500,
        shouldRetry: (err) => {
          const status = err?.response?.status;
          if (!status) return true; // network error
          return status >= 500 || status === 429;
        },
      }
    );
  }

  async replyText(replyToken, text) {
    if (!replyToken) return;
    const url = `${this.apiBase}/v2/bot/message/reply`;
    await axios.post(
      url,
      { replyToken, messages: [{ type: 'text', text }] },
      {
        headers: {
          Authorization: `Bearer ${this.channelAccessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
  }

  /**
   * Resolve a sender's display name. The endpoint depends on context:
   * - 1:1 (source.type === 'user'): /v2/bot/profile/{userId}
   * - group: /v2/bot/group/{groupId}/member/{userId}
   * - room (multi-person):  /v2/bot/room/{roomId}/member/{userId}
   *
   * Returns null on any failure (privacy settings, deleted account, network).
   * Callers must treat the name as best-effort metadata, not a precondition.
   */
  async fetchDisplayName(source, userId) {
    if (!userId || !source) return null;
    let url;
    if (source.type === 'user') {
      url = `${this.apiBase}/v2/bot/profile/${userId}`;
    } else if (source.type === 'group' && source.groupId) {
      url = `${this.apiBase}/v2/bot/group/${source.groupId}/member/${userId}`;
    } else if (source.type === 'room' && source.roomId) {
      url = `${this.apiBase}/v2/bot/room/${source.roomId}/member/${userId}`;
    } else {
      return null;
    }
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${this.channelAccessToken}` },
        timeout: 8000,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return res.data?.displayName || null;
    } catch (_err) {
      return null;
    }
  }

  async fetchGroupName(groupId) {
    if (!groupId) return null;
    try {
      const res = await axios.get(`${this.apiBase}/v2/bot/group/${groupId}/summary`, {
        headers: { Authorization: `Bearer ${this.channelAccessToken}` },
        timeout: 8000,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return res.data?.groupName || null;
    } catch (_err) {
      return null;
    }
  }
}

module.exports = { LineClient };
