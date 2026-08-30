# dw_line_freee_uploader v2

LINE→freee現金領収書アップローダー（LINEボット「領収書アップロード」@916egopi）。
スタッフがLINEグループに領収書写真を送ると、freeeファイルボックスへ自動投稿し、
OCR確定後に取引（deals）まで自動登録する。**Render 常駐・Mac非依存**。

- 本番URL: `https://dw-line-freee-uploader.onrender.com`
- Webhook: `POST /webhook/line`
- 旧構成（Mac常駐 + cloudflared quick tunnel, `~/dw-uploader-runtime/`）は
  2026-08-31 に廃止。**トンネル方式を再構築しないこと**
  （Macスリープ→トンネル死→LINE配達失敗で領収書が消える。証憑ボットで実証済みの事故構造）。

## 構成

```
LINE(スタッフのグループ) → Render(このサービス) ─┬→ freee ファイルボックス（即時）
                                                  ├→ freee 取引登録（JST 9/13/18/23時＋起動時スイープ）
                                                  └→ Dropbox セゾンミラー（03_セゾンカード-LINE/）
Mac側は launchd com.dw.uploader-guard（5分毎）だけ:
  ・LINE受信先がこのサービスからずれたら自動で戻す（奪い返しガード）
  ・スイープ時間帯だけ /healthz ping で起床させる
```

## 取りこぼし対策（多層防御）

1. **Render固定URL** — トンネル切断・URL変化が構造的に消滅
2. **LINE「Webhookの再送」ON** — コールドスタートや一時障害の失敗をLINEが再送
3. **freee側 重複排除** — 説明文に `msg=<LINEメッセージID>` と `img=<画像ハッシュ>` を刻み、
   アップロード直前に直近90日（アップロード日基準）の領収書を照合。
   Renderのディスクは再起動で消えるため、**排除の正本はfreee側**に置く。
   これがあるから再送ONにしても二重投稿しない（ファイルボックスは冪等でない）
4. **同期処理＋失敗時503** — 失敗を LINE に伝えて再送させる（旧版は即200で裏処理失敗＝無通知消失だった）
5. **freeeトークンのDropbox退避** — freeeは更新のたびrefresh tokenが回転する。
   回転のたび Dropbox `_bot-state/dw_line_freee_uploader/freee_token.json` に保存し、
   起動時はそこから読む（env値はブートストラップのみ）

## 管理エンドポイント（要 `X-Admin-Key` ヘッダー）

- `GET  /admin/status` — 稼働統計・トークン状態・スイープ結果
- `POST /admin/selftest` — freee/Dropbox/LINE受信先の疎通確認
- `POST /admin/registrar/run` — 取引登録スイープ手動実行（body `{"commit":true}` で本登録、無しでドライラン）

## 運用メモ

- 返信は `LINE_REPLY_ENABLED=false` で全て無効（グループに人の会話が流れるため無言運用）
- freeeアプリは**アップローダー専用**（経理自動化本体 `dw_freee_accounting_automation` とは別アプリ。
  同一アプリを2か所で使うとトークン奪い合いで両方死ぬ）
- Dropboxアプリは証憑ボットと共用（Dropboxのrefresh tokenは回転しないため共用可）
- 旧SQLite台帳（`~/dw-uploader-runtime/data/app.db`）は履歴アーカイブとしてMacに残置
- 正本ドキュメント: Vault `Knowledge/line-bot-uploader-freee.md`
