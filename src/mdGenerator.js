/**
 * Generate the .md companion file that lives next to a receipt image in
 * the Dropbox 証憑写真 tree. Mirrors the YAML+markdown layout already used
 * by 01_電子-Gmail and 02_紙原本-LINE so all sources are searchable the
 * same way.
 */
'use strict';

function yamlEscape(s) {
  if (s == null || s === '') return '';
  const str = String(s);
  // Quote if it contains special yaml chars; otherwise leave bare.
  if (/[:#\-\[\]\{\}&*!|>'"%@`,\n\t]/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function ymOf(dateStr) {
  return (dateStr || '').slice(0, 7) || '日付不明';
}

/**
 * @param {object} p
 * @param {number} p.receiptId
 * @param {string} p.imageFilename
 * @param {string} p.section          — 部門名 (e.g. デザイン業務)
 * @param {string} p.issueDate        — YYYY-MM-DD
 * @param {string} p.partnerName
 * @param {number} p.amount
 * @param {string} [p.invoiceRegistrationNumber]
 * @param {number} [p.amountTax]
 * @param {number} [p.amountExcludingTax]
 * @param {string} [p.paymentMethod]  — '現金' | 'セゾンカード' …
 * @param {string} [p.description]    — short summary line used in body
 * @param {string} [p.ocrFullText]    — when we have richer text; otherwise the
 *                                       file frontmatter records that only
 *                                       freee's basic OCR fields are present
 * @param {string} [p.ocrEngine]      — 'claude-vision' | 'freee-basic'
 * @param {string} [p.lineUserName]
 * @param {string} [p.lineUserId]
 * @param {string} [p.lineGroupLabel] — what was in the [...] of the description
 * @param {string} [p.uploadedAtIso]
 * @param {string[]} [p.extraKeywords]
 * @returns {string}
 */
function buildReceiptMarkdown(p) {
  const ym = ymOf(p.issueDate);
  const folder = '03_セゾンカード-LINE/' + ym;
  const tags = ['receipt', 'line-bot', 'saison-card', p.section || '部門不明'];
  if (p.ocrEngine === 'claude-vision') tags.push('ocr-vision');
  else tags.push('ocr-freee');

  const fm = [
    '---',
    'date: ' + (p.issueDate || ''),
    'time: ',
    'source: line-bot',
    'media: セゾンクレジットカード',
    'user_id: ' + yamlEscape(p.lineUserId || ''),
    'user_name: ' + yamlEscape(p.lineUserName || ''),
    'line_group: ' + yamlEscape(p.lineGroupLabel || ''),
    'image: ' + yamlEscape(p.imageFilename),
    'type: 領収書',
    'vendor: ' + yamlEscape(p.partnerName || ''),
    'invoice_registration_no: ' + yamlEscape(p.invoiceRegistrationNumber || ''),
    'amount_total: ' + (p.amount != null ? p.amount : ''),
    'amount_tax: ' + (p.amountTax != null ? p.amountTax : ''),
    'amount_excluding_tax: ' + (p.amountExcludingTax != null ? p.amountExcludingTax : ''),
    'payment_method: ' + yamlEscape(p.paymentMethod || 'セゾンカード'),
    'section: ' + yamlEscape(p.section || ''),
    'freee_receipt_id: ' + (p.receiptId != null ? p.receiptId : ''),
    'ocr_engine: ' + (p.ocrEngine || 'freee-basic'),
    'folder: ' + folder,
    'uploaded_at: ' + (p.uploadedAtIso || ''),
    'tags: ' + JSON.stringify(tags),
    '---',
    '',
  ].join('\n');

  const titleVendor = p.partnerName || '取引先不明';
  const title = `# ${p.issueDate || ''} ${titleVendor} 領収書 (¥${p.amount != null ? p.amount.toLocaleString() : '?'})`;

  const summaryLines = [
    `- **発行元**: ${p.partnerName || '不明'}` + (p.invoiceRegistrationNumber ? ` (登録番号 ${p.invoiceRegistrationNumber})` : ''),
    `- **発行日**: ${p.issueDate || '不明'}`,
    `- **領収金額**: ¥${p.amount != null ? p.amount.toLocaleString() : '不明'}` + (p.amountTax != null ? ` (内消費税 ¥${p.amountTax.toLocaleString()})` : ''),
    `- **支払方法**: ${p.paymentMethod || 'セゾンカード'}`,
    `- **部門**: ${p.section || '不明'}`,
    `- **送信元**: LINE グループ「${p.lineGroupLabel || ''}」 by ${p.lineUserName || ''}`.replace(/「」 by $/, ''),
  ].filter(Boolean);

  const notes = p.description
    ? `## 内容メモ\n\n${p.description}\n`
    : '';

  const ocrBlock = p.ocrFullText
    ? `## OCR 全文（${p.ocrEngine === 'claude-vision' ? 'Claude Vision' : 'freee'} 抽出）\n\n\`\`\`\n${p.ocrFullText}\n\`\`\`\n`
    : `## OCR 全文\n\n（freee OCR の基本フィールドのみ取得済み。Vision 全文が必要な場合は Claude で再抽出可能）\n`;

  const keywords = [
    p.partnerName, p.section, p.amount, p.invoiceRegistrationNumber,
    p.paymentMethod, p.lineGroupLabel, ym, 'セゾン', 'クレジットカード', 'LINE',
    ...(p.extraKeywords || []),
  ].filter(Boolean).join(' ');

  return [
    fm,
    title,
    '',
    '## 取引情報サマリ',
    '',
    summaryLines.join('\n'),
    '',
    notes,
    ocrBlock,
    '## キーワード（検索用）',
    '',
    keywords,
    '',
  ].filter(s => s !== undefined).join('\n');
}

module.exports = { buildReceiptMarkdown };
