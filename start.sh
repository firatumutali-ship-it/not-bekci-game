#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js kurulu degil: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
node server.js
