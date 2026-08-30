#!/bin/bash
# 5分ごと（launchd com.dw.uploader-guard）:
#  1) LINE受信先ガード — 「領収書アップロード」@916egopi の Webhook 受信先が
#     Render v2 からずれていたら自動で戻す（トンネル方式の再構築などによる
#     「奪い返し」を検知・自己修復。証憑ボットの 2026-08-31 ガードと同方式）
#  2) スイープ時間帯の起床ping — 取引登録スイープ(JST 9/13/18/23時)の前後だけ
#     /healthz を叩いてRenderを起こす。常時keep-warmはRender無料枠を食い潰す
#     ため行わない（正確性はLINE再送＋freee側重複排除が担保している）。
LOG=/tmp/dw-uploader-guard.log
V2="https://dw-line-freee-uploader.onrender.com"

source "$(dirname "$0")/env.sh" 2>/dev/null || exit 0
[ -n "$LINE_CHANNEL_ACCESS_TOKEN" ] || exit 0

# ── 1) 受信先ガード ─────────────────────────────────────────────
EP=$(curl -s -m 15 'https://api.line.me/v2/bot/channel/webhook/endpoint' \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  | grep -o '"endpoint":"[^"]*"' | cut -d'"' -f4)
if [ -n "$EP" ] && [ "$EP" != "$V2/webhook/line" ]; then
  curl -s -m 15 -X PUT 'https://api.line.me/v2/bot/channel/webhook/endpoint' \
    -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"endpoint\":\"$V2/webhook/line\"}" >/dev/null
  echo "$(date '+%Y-%m-%d %H:%M:%S') 受信先が $EP にずれていたため v2 に自動修正" >> "$LOG"
fi

# ── 2) スイープ時間帯のみ起床ping（JST 9/13/18/23時の 00〜14分）────
H=$(date '+%H')
M=$(date '+%M')
case "$H" in
  09|13|18|23)
    if [ "$M" -lt 15 ]; then
      CODE=$(curl -s -m 45 -o /dev/null -w '%{http_code}' "$V2/healthz")
      if [ "$CODE" != "200" ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') v2 healthz=$CODE（Render停止の疑い: 無料枠切れ/障害）" >> "$LOG"
      fi
    fi
    ;;
esac
