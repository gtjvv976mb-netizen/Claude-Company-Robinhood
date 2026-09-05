# The buy bot — Telegram, chain 4663

Posts every buy of the token into a Telegram group, seconds after it lands.

The usual buy bots (Rick, Maestro) do not support chain 4663, so this reads
GeckoTerminal's public trades feed: no RPC, no explorer, no API key. Blockscout
is used for links only — it answers 403 to anything that is not a browser, so it
must never be in the hot path.

## Install (on the droplet, as root)

```
bash services/buybot/install.sh
```

It asks for the bot token (hidden — never an argument, so it stays out of your
shell history and out of `ps`), the group's chat id, and a minimum buy size.
Before installing anything it calls `getMe` and posts a test message: an install
that "succeeds" into a silent bot is the worst possible outcome.

## Getting the two values

1. **@BotFather** on Telegram → `/newbot` → he gives you a token that looks like
   `8123456789:AAH…`. That token IS the bot — treat it like a key.
2. Add the bot to the group and make it an **admin**, or it cannot post.
3. Say anything in the group, then open
   `https://api.telegram.org/bot<THE_TOKEN>/getUpdates` and read
   `"chat":{"id":-100…}`. That negative number is the chat id.

## What it will not do

- **Dump history on start.** The feed returns ~150 recent trades; it adopts them
  silently and posts only what happens next. Restarts are silent too.
- **Repost.** Trades are keyed by tx hash, persisted to disk.
- **Spam dust.** `MIN_BUY_USD` (default $5) — a group that scrolls past $0.40
  buys stops reading the $400 one.
- **Die quietly.** Every tick is wrapped; a rate limit backs off and retries.

## Knobs

| Variable | Default | |
|---|---|---|
| `POOLS` | both CLAUDECO pools | `address:LABEL`, comma separated |
| `MIN_BUY_USD` | `5` | floor for posting |
| `POLL_MS` | `20000` | refuses under 5s — the feed is rate limited |
| `TOKEN_NAME` | `CLAUDECO` | shown in the message |

## Try it without posting

```
node services/buybot/buybot.mjs --dry
```

Prints what it would post and sends nothing.
