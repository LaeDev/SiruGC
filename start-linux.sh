#!/usr/bin/env bash
# 시루 그룹챗 서버를 시작합니다 (Linux / macOS).
#   실행:  ./start-linux.sh        (실행 권한이 없다면 한 번만: chmod +x start-linux.sh)
#   설정:  config.example.env 를 config.env 로 복사해서 고치세요.   끄기: Ctrl+C
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'MSG'
[오류] Node.js가 설치되어 있지 않아요. 18 이상이 필요해요.

  Debian/Ubuntu : curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs
  Fedora/RHEL   : sudo dnf install nodejs
  Arch          : sudo pacman -S nodejs npm
  그 밖에       : https://nodejs.org 또는 nvm (https://github.com/nvm-sh/nvm)

설치한 뒤 다시 실행하세요.
MSG
  exit 1
fi

if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  echo "[오류] Node.js 버전이 너무 낮아요. 18 이상이 필요해요. 지금 버전: $(node -v)" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[오류] npm이 없어요. Node.js를 설치할 때 npm도 같이 설치하세요 (예: sudo apt-get install -y npm)." >&2
  exit 1
fi

# 처음이거나 package-lock.json이 바뀐 뒤에만 설치한다 (매번 하면 시작이 느려진다)
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "필요한 파일을 설치하는 중... (처음에는 1분 정도 걸릴 수 있어요)"
  npm install --omit=dev --no-audit --no-fund --loglevel=error
fi

[ -f config.env ] || echo "(config.env가 없어서 기본 설정으로 켭니다. 바꾸려면 config.example.env 를 config.env 로 복사하세요)"
echo
# exec: 쉘을 서버로 바꿔서 Ctrl+C / systemd stop 신호가 서버에 바로 전달되게 한다 (접속자에게 '서버가 꺼졌습니다'를 먼저 알림)
exec node server.js
