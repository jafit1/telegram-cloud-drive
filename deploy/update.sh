#!/bin/bash
# ============================================================================
# Drive Uyee Drive — Update Script
# ----------------------------------------------------------------------------
# Pulls latest code from GitHub, reinstall deps if needed, restarts service.
# Run as:    sudo bash update.sh
# ============================================================================
set -e

APP_DIR="/opt/nexusdrive"
SERVICE="nexusdrive"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash update.sh"
  exit 1
fi

info "Stopping service..."
systemctl stop $SERVICE

info "Pulling latest code..."
cd $APP_DIR
sudo -u nexusdrive git pull origin main

info "Updating dependencies..."
sudo -u nexusdrive npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5

info "Starting service..."
systemctl start $SERVICE
sleep 2

if systemctl is-active --quiet $SERVICE; then
  log "Update successful! Service is running."
  systemctl status $SERVICE --no-pager | head -10
else
  echo "[✗] Service failed to start. Check logs:"
  journalctl -u $SERVICE -n 30 --no-pager
  exit 1
fi
