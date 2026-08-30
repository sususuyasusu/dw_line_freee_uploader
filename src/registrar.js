'use strict';

const log = require('./logger');
const { saveSaisonImage } = require('./saisonMirror');

/**
 * Deal registrar: turn unregistered LINE-origin receipts in the freee file
 * box into deals with 取引先 / 部門 / 勘定科目 / 税区分 attached.
 *
 * Port of the Mac-era scripts/process-receipts.js with two fixes:
 *  - the receipts fetch is now properly paginated (the old single
 *    limit=100 call silently saw only the OLDEST 100 receipts — ascending
 *    order — so once the box grew past 100 the batch stopped seeing new
 *    receipts entirely)
 *  - the Saison Dropbox mirror goes through the Dropbox API instead of the
 *    local Mac filesystem
 * Classification rules are unchanged.
 */

// ── defaults (one place, easy to tweak before re-run) ────────────────────
const DEFAULT_SECTION_ID = 2054948;        // どら山 門前仲町
const DEFAULT_TAX_NAME_PREFER = '課対仕入8%（軽）';   // 8% 軽減税率
const DEFAULT_TAX_NAME_FALLBACK = '課対仕入10%';     // 10%
const DEFAULT_WALLETABLE_NAME = '現金';     // 決済口座

// ── Saison credit card routing ───────────────────────────────────────────
const SAISON_WALLETABLE_NAME = 'セゾンカード';
const SAISON_SECTION_RULES = [
  { match: ['デザイン'], section: 'デザイン業務' },
  { match: ['会社共通'], section: '会社共通' },
  { match: ['どら山', 'ドラ山', '門仲', '門前仲町'], section: 'どら山　門前仲町' },
];
const SAISON_PARTNER_RULES = [
  { match: ['赤札', 'アブアブ', '成城石井', 'ハナマサ', 'Hanamasa', '業務スーパー', 'ヤオコー', 'まいばす', 'ライフ', 'オオゼキ', '果然の園', '小田桐', '河内屋'],
    account: '仕入高', item: '仕入諸経費', isFood: true },
  { match: ['大創産業', 'ダイソー', 'Daiso', 'セリア', 'キャンドゥ'],
    account: '消耗品費', item: '備品', isFood: false },
  { match: ['東京地下鉄', '東京メトロ', '東京都交通局', 'JR', '私鉄', '京王', '東急', '小田急', '西武', '京急'],
    account: '旅費交通費', item: '電車代', isFood: false },
  { match: ['交通', 'タクシー'],
    account: '旅費交通費', item: 'タクシー代', isFood: false },
  { match: ['ドコモ', 'au ', 'ソフトバンク', 'NTT', 'KDDI'],
    account: '通信費', item: null, isFood: false },
];
const SAISON_DEFAULT_ACCOUNT = '会議費';
const SAISON_DEFAULT_ITEM = null;
const SAISON_DEFAULT_IS_FOOD = false;

// ── cash-group routing ───────────────────────────────────────────────────
const PARTNER_RULES = [
  { match: ['赤札', 'アブアブ', '成城石井', 'ハナマサ', 'Hanamasa', '業務スーパー', 'ヤオコー', 'まいばす', 'ライフ'],
    account: '仕入高', item: '仕入諸経費', isFood: true },
  { match: ['大創産業', 'ダイソー', 'Daiso', 'セリア', 'キャンドゥ'],
    account: '消耗品費', item: '備品', isFood: false },
  { match: ['東京地下鉄', 'メトロ', 'JR', '私鉄', 'タクシー', '京王', '東急', '小田急', '西武', '京急'],
    account: '旅費交通費', item: '電車代', isFood: false },
  { match: ['ドコモ', 'au ', 'ソフトバンク', 'NTT', 'KDDI'],
    account: '通信費', item: null, isFood: false },
];
const DEFAULT_ACCOUNT_NAME = '仕入高';
const DEFAULT_ITEM_NAME = '仕入諸経費';
const DEFAULT_IS_FOOD = true;

function isSaisonReceipt(description) {
  if (!description) return false;
  return /セゾン|saison|Saison|クレジット|カード払/.test(description);
}

function pickSaisonSection(description) {
  const m = (description || '').match(/\[([^\]]+)\]/);
  if (!m) return null;
  const label = m[1];
  for (const r of SAISON_SECTION_RULES) {
    if (r.match.some((k) => label.includes(k))) return r.section;
  }
  return null;
}

function classifySaisonPartner(partnerName) {
  for (const rule of SAISON_PARTNER_RULES) {
    if (rule.match.some((k) => partnerName?.includes(k))) {
      return { account: rule.account, item: rule.item, isFood: rule.isFood };
    }
  }
  return { account: SAISON_DEFAULT_ACCOUNT, item: SAISON_DEFAULT_ITEM, isFood: SAISON_DEFAULT_IS_FOOD };
}

function classifyPartner(partnerName) {
  for (const rule of PARTNER_RULES) {
    if (rule.match.some((k) => partnerName?.includes(k))) {
      return { account: rule.account, item: rule.item, isFood: rule.isFood };
    }
  }
  return { account: DEFAULT_ACCOUNT_NAME, item: DEFAULT_ITEM_NAME, isFood: DEFAULT_IS_FOOD };
}

class Registrar {
  constructor({ freee, dropbox, saisonRoot }) {
    this.freee = freee;
    this.dropbox = dropbox;
    this.saisonRoot = saisonRoot;
    this.running = false;
    this.lastRunAt = null;
    this.lastResult = null;
  }

  async _paginate(pathname, params, key) {
    const limit = 100;
    let offset = 0;
    const all = [];
    while (true) {
      const data = await this.freee.get(pathname, { ...params, offset, limit });
      const items = data?.[key] || [];
      all.push(...items);
      if (items.length < limit) break;
      offset += limit;
      if (offset > 50000) {
        throw new Error(
          `[FATAL] ${key} の取得が上限50,000件に達しました。データ欠落のまま処理を続けると重複を作るため中断します。`
        );
      }
    }
    return all;
  }

  /**
   * One sweep. commit=false plans only.
   * Returns a summary object (also stored as lastResult).
   */
  async runOnce({ commit }) {
    if (this.running) {
      log.warn('registrar.already_running');
      return { skipped: 'already_running' };
    }
    this.running = true;
    const startedAt = new Date().toISOString();
    try {
      const result = await this._run({ commit });
      this.lastRunAt = startedAt;
      this.lastResult = { ...result, commit, at: startedAt };
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }

  async _run({ commit }) {
    log.info('registrar.start', { commit });

    // ── masters ─────────────────────────────────────────────────────────
    const [partners, sectionsData, accountItemsData, taxesData, walletablesData, itemsData] =
      await Promise.all([
        this._paginate('/api/1/partners', {}, 'partners'),
        this.freee.get('/api/1/sections'),
        this.freee.get('/api/1/account_items'),
        this.freee.get(`/api/1/taxes/companies/${this.freee.companyId}`),
        this.freee.get('/api/1/walletables'),
        this.freee.get('/api/1/items', { limit: 300 }),
      ]);
    const sectionList = sectionsData.sections;
    const acctItemList = accountItemsData.account_items;
    const taxList = taxesData.taxes || taxesData;
    const walletables = walletablesData.walletables || [];
    const items = itemsData.items || [];

    const findTax = (name) => taxList.find((t) => (t.name_ja || t.name) === name);
    const taxFood = findTax(DEFAULT_TAX_NAME_PREFER) || findTax('課対仕入8%(軽)') || findTax('課対仕入8%軽');
    const taxRegular = findTax(DEFAULT_TAX_NAME_FALLBACK) || findTax('課対仕入10%');
    if (!taxFood || !taxRegular) {
      throw new Error('registrar: tax codes not found (仕入8%軽減/10%)');
    }
    const wallet = walletables.find((w) => w.name === DEFAULT_WALLETABLE_NAME) || walletables[0];
    const saisonWallet = walletables.find((w) => w.name === SAISON_WALLETABLE_NAME);

    const partnersByName = new Map(partners.map((p) => [p.name, p]));
    const sectionByName = new Map(sectionList.map((s) => [s.name, s]));
    const acctByName = new Map(acctItemList.map((a) => [a.name, a]));
    const itemByItemName = new Map(items.map((it) => [it.name, it]));

    const accountIdFor = (name) => {
      const a = acctByName.get(name);
      if (!a) throw new Error('account_item not found: ' + name);
      return a.id;
    };
    const itemIdFor = (name) => (name ? itemByItemName.get(name)?.id ?? null : null);
    const sectionIdByName = (name) => sectionByName.get(name)?.id ?? null;

    // ── receipts already linked to any deal ─────────────────────────────
    const deals = await this._paginate(
      '/api/1/deals',
      { start_issue_date: '2024-01-01', end_issue_date: '2030-12-31', accruals: 'without' },
      'deals'
    );
    const linkedReceiptIds = new Set();
    for (const d of deals) for (const rc of d.receipts || []) linkedReceiptIds.add(rc.id);

    // ── unregistered LINE-origin receipts (fully paginated) ─────────────
    const receipts = (
      await this.freee.listReceipts({ startDate: '2024-01-01', endDate: '2030-12-31' })
    ).filter((r) => (r.description || '').includes('LINE') && !linkedReceiptIds.has(r.id));

    log.info('registrar.candidates', {
      linked: linkedReceiptIds.size,
      candidates: receipts.length,
    });

    const plan = [];
    for (const r of receipts) {
      const md = r.receipt_metadatum || {};
      const saison = isSaisonReceipt(r.description);
      const cls = saison ? classifySaisonPartner(md.partner_name) : classifyPartner(md.partner_name);
      plan.push({
        receipt_id: r.id,
        issue_date: md.issue_date || null,
        amount: md.amount ?? null,
        partner_name: md.partner_name || '',
        saison,
        account: cls.account,
        item_name: cls.item,
        is_food: cls.isFood,
        ocr_ready: Boolean(md.issue_date && md.amount),
      });
    }

    if (!commit) {
      return {
        candidates: receipts.length,
        ocr_pending: plan.filter((p) => !p.ocr_ready).length,
        plan: plan.slice(0, 100),
      };
    }

    // ── commit ──────────────────────────────────────────────────────────
    let ok = 0;
    let skippedOcr = 0;
    let failed = 0;
    const created = [];
    for (const r of receipts) {
      const md = r.receipt_metadatum || {};
      if (!md.issue_date || !md.amount) {
        skippedOcr += 1;
        continue;
      }
      try {
        const saison = isSaisonReceipt(r.description);
        const cls = saison ? classifySaisonPartner(md.partner_name) : classifyPartner(md.partner_name);
        const tax = cls.isFood ? taxFood : taxRegular;
        const sectionId = saison
          ? sectionIdByName(pickSaisonSection(r.description)) || DEFAULT_SECTION_ID
          : DEFAULT_SECTION_ID;

        // partner upsert (exact → loose → create)
        let partnerId = null;
        if (md.partner_name) {
          if (partnersByName.has(md.partner_name)) {
            partnerId = partnersByName.get(md.partner_name).id;
          } else {
            for (const [k, v] of partnersByName) {
              if (k.includes(md.partner_name) || md.partner_name.includes(k)) {
                partnerId = v.id;
                break;
              }
            }
            if (!partnerId) {
              const createdPartner = await this.freee.post('/api/1/partners', {
                company_id: this.freee.companyId,
                name: md.partner_name,
              });
              partnerId = createdPartner.partner.id;
              partnersByName.set(md.partner_name, createdPartner.partner);
              log.info('registrar.partner_created', { id: partnerId, name: md.partner_name });
            }
          }
        }

        const detail = {
          tax_code: tax.code,
          account_item_id: accountIdFor(cls.account),
          amount: md.amount,
          section_id: sectionId,
          description: '領収書#' + r.id + ' ' + (md.partner_name || '') + ' ' + md.issue_date,
        };
        const itemId = itemIdFor(cls.item);
        if (itemId) detail.item_id = itemId;

        const payWallet = saison ? saisonWallet : wallet;
        const payload = {
          company_id: this.freee.companyId,
          issue_date: md.issue_date,
          type: 'expense',
          partner_id: partnerId || undefined,
          partner_name: md.partner_name || undefined,
          ref_number: 'LINE-' + r.id,
          receipt_ids: [r.id],
          details: [detail],
          payments: payWallet
            ? [{
                amount: md.amount,
                from_walletable_type: saison ? 'credit_card' : 'wallet',
                from_walletable_id: payWallet.id,
                date: md.issue_date,
              }]
            : undefined,
        };
        const res = await this.freee.post('/api/1/deals', payload);
        const dealId = res.deal.id;
        ok += 1;
        created.push({ receipt_id: r.id, deal_id: dealId, amount: md.amount, partner: md.partner_name });
        log.info('registrar.deal_created', { receiptId: r.id, dealId, amount: md.amount });

        if (saison) {
          try {
            const sectionName = pickSaisonSection(r.description) || 'その他';
            const descMatch = (r.description || '').match(/^LINE\s+(\S+)\s+\[([^\]]+)\]/);
            const out = await saveSaisonImage({
              freee: this.freee,
              dropbox: this.dropbox,
              saisonRoot: this.saisonRoot,
              receiptId: r.id,
              section: sectionName,
              issueDate: md.issue_date,
              partnerName: md.partner_name || '',
              amount: md.amount,
              invoiceRegistrationNumber: r.invoice_registration_number || '',
              paymentMethod: 'セゾンカード',
              ocrEngine: 'freee-basic',
              lineUserName: descMatch?.[1],
              lineGroupLabel: descMatch?.[2],
              uploadedAtIso: r.created_at,
            });
            log.info('registrar.saison_mirrored', {
              receiptId: r.id,
              image: out.imageStatus,
              md: out.mdStatus,
            });
          } catch (se) {
            log.warn('registrar.saison_mirror_failed', {
              receiptId: r.id,
              err: String(se?.message || se).slice(0, 300),
            });
          }
        }
      } catch (e) {
        failed += 1;
        log.error('registrar.deal_failed', {
          receiptId: r.id,
          detail: JSON.stringify(e.response?.data || String(e)).slice(0, 300),
        });
      }
    }

    log.info('registrar.done', { ok, skippedOcr, failed });
    return { candidates: receipts.length, created: ok, skipped_ocr: skippedOcr, failed, deals: created };
  }
}

module.exports = { Registrar, isSaisonReceipt, pickSaisonSection, classifySaisonPartner, classifyPartner };
