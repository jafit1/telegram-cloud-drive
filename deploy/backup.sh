#!/bin/bash
# ============================================================================
# Nexus Drive — Backup Script
# ----------------------------------------------------------------------------
# Creates timestamped tar.gz backup of all data (DB, session, uploads, cache).
# Keeps last 7 backups, auto-prunes older ones.
# Run as:    sudo bash backup.sh
# Schedule:  add to crontab for daily backups:
#            0 3 * * * /opt/nexusdrive/deploy/backup.sh
# ============================================================================
set -e

APP_DIR="/opt/nexusdrive"
BACKUP_DIR="/opt/nexusdrive/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/nexusdrive-$TIMESTAMP.tar.gz"
KEEP_COUNT=7

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash backup.sh"
  exit 1
fi

mkdir -p $BACKUP_DIR

info "Creating backup..."
tar -czf $BACKUP_FILE \
  --exclude='cache' \
  --exclude='temp' \
  -C $APP_DIR data .env 2>/dev/null || \
tar -czf $BACKUP_FILE -C $APP_DIR data

SIZE=$(du -sh $BACKUP_FILE | cut -f1)
log "Backup created: $BACKUP_FILE ($SIZE)"

info "Pruning old backups (keeping last $KEEP_COUNT)..."
cd $BACKUP_DIR
ls -t nexusdrive-*.tar.gz 2>/dev/null | tail -n +$((KEEP_COUNT + 1)) | xargs -r rm -f
REMAINING=$(ls nexusdrive-*.tar.gz 2>/dev/null | wc -l)
log "$REMAINING backups in $BACKUP_DIR"

echo ""
log "Done!"
