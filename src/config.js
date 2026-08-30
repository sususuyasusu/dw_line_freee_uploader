'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const config = {
  port: parseInt(optional('PORT', '3000'), 10),

  line: {
    channelSecret: required('LINE_CHANNEL_SECRET'),
    channelAccessToken: required('LINE_CHANNEL_ACCESS_TOKEN'),
    apiBase: 'https://api.line.me',
    dataApiBase: 'https://api-data.line.me',
    // Master toggle for outbound replies. When false the bot never speaks.
    replyEnabled: optional('LINE_REPLY_ENABLED', 'true').toLowerCase() !== 'false',
  },

  freee: {
    clientId: required('FREEE_CLIENT_ID'),
    clientSecret: required('FREEE_CLIENT_SECRET'),
    // Bootstrap only. After the first rotation the authoritative value lives
    // in the Dropbox state file (see dropbox.statePath) because Render's disk
    // is wiped on every restart while freee rotates the refresh token on
    // every use — an env-only setup would brick itself at the first restart.
    refreshToken: required('FREEE_REFRESH_TOKEN'),
    companyId: parseInt(required('FREEE_COMPANY_ID'), 10),
    apiBase: 'https://api.freee.co.jp',
    oauthBase: 'https://accounts.secure.freee.co.jp',
  },

  dropbox: {
    appKey: required('DROPBOX_APP_KEY'),
    appSecret: required('DROPBOX_APP_SECRET'),
    refreshToken: required('DROPBOX_REFRESH_TOKEN'),
    // Team-space namespace. All paths below are relative to this root.
    rootNamespaceId: optional('DROPBOX_ROOT_NAMESPACE_ID', null),
    // Where the rotating freee refresh token is persisted.
    statePath: optional(
      'DROPBOX_STATE_PATH',
      '/D& W/社内/_bot-state/dw_line_freee_uploader/freee_token.json'
    ),
    // Saison card receipts are mirrored here (image + companion .md).
    saisonRoot: optional(
      'DROPBOX_SAISON_ROOT',
      '/D& W/社内/証憑写真/03_セゾンカード-LINE'
    ),
  },

  admin: {
    // Long random string; admin endpoints are disabled entirely when unset.
    key: optional('ADMIN_KEY', null),
  },

  registrar: {
    // Sweeps run at these JST hours (mirrors the retired Mac launchd slots)
    // plus once ~90s after boot. Each sweep is idempotent.
    slotsJst: [9, 13, 18, 23],
    // 'false' turns every scheduled sweep into a dry run (safety valve).
    commit: optional('REGISTRAR_COMMIT', 'true').toLowerCase() !== 'false',
    enabled: optional('REGISTRAR_ENABLED', 'true').toLowerCase() !== 'false',
  },

  dedup: {
    // How far back the durable freee-side duplicate check looks. The receipts
    // list API filters on upload date (measured 2026-08-31), so this window is
    // about re-sends, not receipt issue dates.
    windowDays: parseInt(optional('DEDUP_WINDOW_DAYS', '90'), 10),
  },

  tmpDir: path.resolve(process.cwd(), optional('TMP_DIR', './tmp')),

  image: {
    allowedExtensions: ['jpg', 'jpeg', 'png'],
    maxSizeBytes: 5 * 1024 * 1024,
  },
};

module.exports = config;
