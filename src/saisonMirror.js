'use strict';

const { buildReceiptMarkdown } = require('./mdGenerator');

/**
 * Mirror a Saison-card receipt (image + companion .md) into the Dropbox
 * 証憑写真/03_セゾンカード-LINE tree.
 *
 * Port of the Mac-era scripts/saison-image-save.js: same naming convention,
 * same skip-if-exists semantics — but via the Dropbox API instead of the
 * local CloudStorage filesystem, so it runs on Render.
 *
 *   <SAISON_ROOT>/<YYYY-MM>/<部門>_<YYYY-MM-DD>_<取引先>_<金額>.jpg (+ .md)
 */

function sanitize(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function buildFilename({ section, issueDate, partnerName, amount }) {
  const sec = sanitize(section || '部門不明');
  const dt = sanitize(issueDate || '日付不明');
  const pn = sanitize(partnerName || '取引先不明');
  const amt = amount != null ? String(amount) : '金額不明';
  return `${sec}_${dt}_${pn}_${amt}.jpg`;
}

async function saveSaisonImage({
  freee, dropbox, saisonRoot,
  receiptId, section, issueDate, partnerName, amount,
  invoiceRegistrationNumber, amountTax, amountExcludingTax, paymentMethod,
  description, ocrFullText, ocrEngine, lineUserName, lineUserId, lineGroupLabel,
  uploadedAtIso, extraKeywords,
}) {
  const ym = (issueDate || '').slice(0, 7) || '日付不明';
  const filename = buildFilename({ section, issueDate, partnerName, amount });
  const imagePath = `${saisonRoot}/${ym}/${filename}`;
  const mdPath = imagePath.replace(/\.jpg$/, '.md');

  const buffer = await freee.downloadReceipt(receiptId);
  const imageRes = await dropbox.upload(imagePath, buffer); // add → conflict = skipped

  const md = buildReceiptMarkdown({
    receiptId,
    imageFilename: filename,
    section,
    issueDate,
    partnerName,
    amount,
    invoiceRegistrationNumber,
    amountTax,
    amountExcludingTax,
    paymentMethod: paymentMethod || 'セゾンカード',
    description,
    ocrFullText,
    ocrEngine: ocrEngine || (ocrFullText ? 'claude-vision' : 'freee-basic'),
    lineUserName,
    lineUserId,
    lineGroupLabel,
    uploadedAtIso,
    extraKeywords,
  });
  const mdRes = await dropbox.upload(mdPath, Buffer.from(md, 'utf8'));

  return {
    status: imageRes.status === 'saved' || mdRes.status === 'saved' ? 'saved' : 'skipped',
    imageStatus: imageRes.status,
    mdStatus: mdRes.status,
    imagePath,
    mdPath,
  };
}

module.exports = { saveSaisonImage };
