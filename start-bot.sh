#!/bin/bash
set -a
source "$(dirname "$0")/.env"
set +a
exec node "$(dirname "$0")/dist/telegram-bot.js"
