#!/bin/bash
# Installs the executor feed secret into .cc-executor.env, with hidden input.
# The secret never echoes to screen, never enters shell history, never leaves this Mac.
cd "$(dirname "$0")" || exit 1

# First run on a fresh checkout: scaffold the config and generate this machine's
# burner wallet. The burner's PRIVATE key is created here and never leaves this
# machine; only its PUBLIC address is printed, for funding later (fund LAST, after
# a clean dry run).
if [ ! -f .cc-executor.env ]; then
  printf "Your floor number (the floor whose calls this bot trades): "
  read -r FLOORNO
  case "$FLOORNO" in (*[!0-9]*|"") echo "That is not a floor number — nothing was created."; exit 1;; esac
  cat > .cc-executor.env <<EOF
# WALL-ST-E configuration. This file is gitignored; keep it at permissions 600.
# CC_SECRET authenticates the READ-ONLY call feed. It is not a wallet key and
# cannot move funds. Never put a private key or seed phrase in this file.
CC_SECRET=PASTE_THE_FEED_SECRET_HERE
CC_FLOOR=$FLOORNO
CC_API=https://claude-company-robinhood-api.onrender.com
# DRY RUN by default: downloads calls, applies full policy, signs nothing.
# Going live is a separate deliberate step. Follow the exact-commit Linux or macOS
# workflow in executor/README.md; the legacy install-live.sh rewriter is retired.
EXECUTE=0
KEY_FILE=./burner.key
STATE_DB=./.cc-executor.sqlite
POLL_MS=15000
EOF
  chmod 600 .cc-executor.env
  echo "Created .cc-executor.env for floor $FLOORNO."
fi
if [ ! -f burner.key ]; then
  node -e "
const fs=require('fs');
const {randomBytes}=require('crypto');
const {Wallet,getAddress}=require('ethers');
const key='0x'+randomBytes(32).toString('hex');
fs.writeFileSync('burner.key', key+'\n', {mode:0o600});
console.log('Generated this machine\'s burner key for Robinhood Chain (4663), unfunded.');
console.log('Its PUBLIC address - fund this one, LAST, only with what you can lose:');
console.log('    ' + getAddress(new Wallet(key).address));
" || { echo "Could not generate the burner (is 'npm ci' done in executor/?)"; exit 1; }
fi

printf "Paste the executor feed secret, then press Return (typing is hidden): "
read -rs SECRET
echo
printf '%s' "$SECRET" | python3 -c "
import sys, io, os
sec = sys.stdin.read().strip()
if len(sec) < 20 or 'PASTE' in sec:
    sys.exit('That does not look like a secret - nothing was changed. Run the script again.')
p = '.cc-executor.env'
s = io.open(p).read()
if 'PASTE_THE_FEED_SECRET_HERE' in s:
    s = s.replace('PASTE_THE_FEED_SECRET_HERE', sec)
else:
    import re
    s = re.sub(r'CC_SECRET=.*', 'CC_SECRET=' + sec, s, count=1)
io.open(p, 'w').write(s)
os.chmod(p, 0o600)
print('Secret installed. File locked to 600. Tell Claude: done')
"
unset SECRET
