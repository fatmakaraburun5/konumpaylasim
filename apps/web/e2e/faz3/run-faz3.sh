#!/usr/bin/env bash
# Faz 3 entegrasyon e2e (GERÇEK emülatörler + mobil yayıncı/kuyruk kodu + backend bekçi taraması).
# Emülatörlerin İÇİNDEN çalıştırılır:
#   cd backend && npm run build && \
#     npx firebase emulators:exec --project demo-konum --only auth,firestore,database,functions "bash ../apps/web/e2e/faz3/run-faz3.sh"
# Ortam: OUT (çıktı, varsayılan apps/web/e2e-output/faz3), SKIP_WEB=1 (web görüntüleyici adımını atla),
#        SKIP_WEB_BUILD=1 (dist-emu hazırsa yeniden derleme), WITH_FAZ2=1 (önce Faz 2 kabul e2e'sini de koş).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
web="$(cd "$here/../.." && pwd)"
repo="$(cd "$web/../.." && pwd)"
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy
export NO_PROXY=127.0.0.1,localhost
export NODE_PATH="$repo/backend/functions/node_modules:$repo/backend/node_modules${NODE_PATH:+:$NODE_PATH}"
cd "$web"
node e2e/faz3/build.mjs
if [ "${SKIP_WEB:-0}" != "1" ] && [ "${SKIP_WEB_BUILD:-0}" != "1" ]; then
  VITE_USE_EMULATORS=1 npx vite build --outDir dist-emu --emptyOutDir --logLevel warn
fi
if [ "${WITH_FAZ2:-0}" = "1" ]; then
  node e2e/integration/build-lib.mjs
  OUT="${OUT:-$web/e2e-output}/faz2" node e2e/emulator.cjs
fi
node e2e/faz3/faz3.cjs
