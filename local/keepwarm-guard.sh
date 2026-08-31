#!/bin/bash
# 5分ごと（launchd com.dw.uploader-guard）: LINE受信先ガード専用。
#
# 「領収書アップロード」@916egopi の Webhook 受信先が Render のこのサービスから
# ずれていたら自動で戻す（Macトンネル方式の再構築などによる「奪い返し」を
# 検知して自己修復。証憑ボットの 2026-08-31 ガードと同方式）。
#
# ★keep-warm ping は行わない。常時起こし続ける ping こそが Render 無料枠
#   750時間/月を食い潰し、7/17・8/31にサービス停止を招いた真犯人だったため
#   （2026-08-31 ユーザー決定「眠らせて、取りこぼしはLINE再送で拾う」）。
#   眠ったインスタンスは受信時に起き、起動90秒後の取引登録スイープも自然に走る。
LOG=/tmp/dw-uploader-guard.log
V2="https://dw-line-freee-uploader.onrender.com"

source "$(dirname "$0")/env.sh" 2>/dev/null || exit 0
[ -n "${LINE_CHANNEL_ACCESS_TOKEN:-}" ] || exit 0

EP=$(curl -s -m 15 'https://api.line.me/v2/bot/channel/webhook/endpoint' \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  | grep -o '"endpoint":"[^"]*"' | cut -d'"' -f4)

if [ -n "$EP" ] && [ "$EP" != "$V2/webhook/line" ]; then
  curl -s -m 15 -X PUT 'https://api.line.me/v2/bot/channel/webhook/endpoint' \
    -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"endpoint\":\"$V2/webhook/line\"}" >/dev/null
  echo "$(date '+%Y-%m-%d %H:%M:%S') 受信先が $EP にずれていたため自動修正" >> "$LOG"
fi
