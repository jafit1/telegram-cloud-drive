#!/bin/bash
# ============================================================================
# Nexus Drive — Cloudflare Tunnel Setup (NO ACCOUNT REQUIRED)
# ----------------------------------------------------------------------------
# Exposes local server to internet via Cloudflare quick tunnel.
# No account needed, no signup, no domain needed.
# Run as:    bash tunnel-setup.sh
# ============================================================================
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[x]${NC} $1"; exit 1; }

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

# ── Detect OS / arch ─────────────────────────────────────────────────────
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  CF_ARCH=amd64 ;;
  aarch64) CF_ARCH=arm64 ;;
  armv7l)  CF_ARCH=arm ;;
  *)       fail "Unsupported architecture: $ARCH" ;;
esac
info "Detected: $OS / $CF_ARCH"

# ── Install cloudflared ───────────────────────────────────────────────────
info "Installing cloudflared..."

if command -v cloudflared >/dev/null 2>&1; then
  log "cloudflared already installed: $(cloudflared --version 2>&1 | head -1)"
else
  if [ "$OS" = "linux" ]; then
    URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}.deb"
    info "Downloading from $URL"
    if [ "$EUID" -eq 0 ]; then
      curl -fsSL "$URL" -o /tmp/cloudflared.deb
      dpkg -i /tmp/cloudflared.deb || apt-get install -f -y
    else
      warn "Not root - trying sudo..."
      curl -fsSL "$URL" -o /tmp/cloudflared.deb
      sudo dpkg -i /tmp/cloudflared.deb || sudo apt-get install -f -y
    fi
  elif [ "$OS" = "darwin" ]; then
    brew install cloudflared 2>/dev/null || {
      info "Homebrew not found. Downloading binary..."
      curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz" -o /tmp/cf.tgz
      tar -xzf /tmp/cf.tgz -C /tmp/
      sudo mv /tmp/cloudflared /usr/local/bin/
    }
  fi
  log "cloudflared installed: $(cloudflared --version 2>&1 | head -1)"
fi

# ── Check if app is running ──────────────────────────────────────────────
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -qE "200|302|401|403"; then
  warn "App doesn't seem to be running on port 3000."
  info "Starting app now..."
  if [ -f .env ]; then
    set -a; . ./.env; set +a
  fi
  nohup node --localstorage-file=data/gramjs-localstorage.json server.js > app.log 2>&1 &
  sleep 3
fi

# ── Start tunnel ──────────────────────────────────────────────────────────
info "Starting Cloudflare quick tunnel to localhost:3000..."
info "Press Ctrl+C to stop."
echo ""
echo "============================================================"
log "Your app will be accessible at the URL shown below (trycloudflare.com)"
echo "============================================================"
echo ""

cloudflared tunnel --url http://localhost:3000 --no-autoupdate
