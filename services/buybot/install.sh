#!/bin/bash
# Install the Telegram buy bot as a systemd service.
#
# The two secrets are read from the TERMINAL, never from the command line: an
# argument lands in your shell history and in `ps` output, where any process on
# the box can read it. That is the same rule the executor's installer follows,
# and it exists because a bot token in a group chat is the group chat.
#
#   bash services/buybot/install.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT=/etc/systemd/system/cc-buybot.service
POOLS_DEFAULT="0x595aa54d2a32d9c6ced42e88355dae507aaf6fa5:NVDA,0x16490a58e924b22078237a3f20634aca25b97c45:WETH"

command -v node >/dev/null || { echo "node is not installed" >&2; exit 1; }
[ "$(id -u)" = "0" ] || { echo "run as root (systemd needs it)" >&2; exit 1; }
[ -r /dev/tty ] || { echo "no terminal: this installer asks for the token interactively" >&2; exit 1; }

printf "Telegram bot token (from @BotFather, hidden): " > /dev/tty
IFS= read -r -s TG_TOKEN < /dev/tty
printf "\n" > /dev/tty
[ -n "$TG_TOKEN" ] || { echo "no token given" >&2; exit 1; }
case "$TG_TOKEN" in
  *:*) ;;
  *) echo "that does not look like a bot token (they contain a colon)" >&2; exit 1;;
esac

printf "Telegram chat id (the group, usually starts -100): " > /dev/tty
IFS= read -r TG_CHAT < /dev/tty
[ -n "$TG_CHAT" ] || { echo "no chat id given" >&2; exit 1; }

printf "Minimum buy to post in USD [5]: " > /dev/tty
IFS= read -r MIN_USD < /dev/tty
MIN_USD="${MIN_USD:-5}"

# Prove the credentials BEFORE installing a service around them: an install that
# "succeeds" into a silent bot is the worst outcome, and getMe costs nothing.
echo "checking the token…"
ME=$(curl -s --max-time 15 "https://api.telegram.org/bot${TG_TOKEN}/getMe" || true)
case "$ME" in
  *'"ok":true'*) echo "  token is valid: $(printf '%s' "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/@\1/p')";;
  *) echo "  the token was rejected by Telegram — nothing installed" >&2; exit 1;;
esac

echo "sending a test message to ${TG_CHAT}…"
SENT=$(curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  -H 'content-type: application/json' \
  -d "{\"chat_id\":\"${TG_CHAT}\",\"text\":\"Buy bot connected. Watching CLAUDECO on chain 4663.\"}" || true)
case "$SENT" in
  *'"ok":true'*) echo "  posted — check the group";;
  *) echo "  could not post to that chat. Is the bot IN the group and an admin?" >&2
     echo "  telegram said: $(printf '%s' "$SENT" | head -c 200)" >&2; exit 1;;
esac

install -d -m 700 "$DIR"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=Claude Company buy bot (Telegram, chain 4663)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${DIR}
ExecStart=$(command -v node) ${DIR}/buybot.mjs
Environment=TELEGRAM_TOKEN=${TG_TOKEN}
Environment=TELEGRAM_CHAT_ID=${TG_CHAT}
Environment=POOLS=${POOLS_DEFAULT}
Environment=MIN_BUY_USD=${MIN_USD}
Environment=BUYBOT_STATE=${DIR}/.buybot-state.json
Restart=always
RestartSec=10
# The token is in this unit file, so nobody but root reads it.
UMask=0077

[Install]
WantedBy=multi-user.target
UNITEOF
chmod 600 "$UNIT"

systemctl daemon-reload
systemctl enable --now cc-buybot
sleep 3
echo
systemctl --no-pager --lines=12 status cc-buybot || true
echo
echo "Installed. It primes silently on the trades already in the feed and posts only what happens next."
echo "  logs:    journalctl -u cc-buybot -f"
echo "  floor:   edit MIN_BUY_USD in ${UNIT}, then systemctl daemon-reload && systemctl restart cc-buybot"
