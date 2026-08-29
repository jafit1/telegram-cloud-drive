#!/bin/bash
# ============================================================================
# Nexus Drive — Oracle Cloud Free Tier Setup Script
# ----------------------------------------------------------------------------
# Tested on: Oracle Linux 8 / Ubuntu 22.04 (ARM Ampere A1)
# Run as:    sudo bash setup.sh
# ============================================================================
set -e

# ── Colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
info()  { echo -e "${BLUE}[i]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Detect OS ─────────────────────────────────────────────────────────────
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
  VER=$VERSION_ID
else
  fail "Cannot detect OS. Run on Oracle Linux 8 / Ubuntu 22.04."
fi
info "Detected OS: $OS $VER"

# ── Check root ────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  fail "Please run as root: sudo bash setup.sh"
fi

# ── Variables ─────────────────────────────────────────────────────────────
APP_USER="nexusdrive"
APP_DIR="/opt/nexusdrive"
APP_PORT="3000"
REPO_URL="https://github.com/jafit1/telegram-cloud-drive.git"
DOMAIN="${DOMAIN:-}"  # optional: pass DOMAIN=yourdomain.com for SSL

# ── 1. Update system ──────────────────────────────────────────────────────
info "Updating system packages..."
if [ "$OS" = "ol" ] || [ "$OS" = "centos" ] || [ "$OS" = "rhel" ]; then
  dnf update -y >/dev/null 2>&1
  PKG_INSTALL="dnf install -y"
elif [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
  apt-get update -y >/dev/null 2>&1
  apt-get upgrade -y >/dev/null 2>&1
  PKG_INSTALL="apt-get install -y"
fi
log "System updated."

# ── 2. Install required packages ──────────────────────────────────────────
info "Installing base packages..."
$PKG_INSTALL curl wget git build-essential python3 ufw nginx certbot python3-certbot-nginx >/dev/null 2>&1 || true
log "Base packages installed."

# ── 3. Install Node.js 22 LTS ─────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  info "Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || \
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  $PKG_INSTALL nodejs >/dev/null 2>&1
  log "Node.js installed: $(node -v)"
else
  log "Node.js already installed: $(node -v)"
fi

# ── 4. Create app user ───────────────────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
  info "Creating user '$APP_USER'..."
  useradd -m -s /bin/bash $APP_USER
  log "User $APP_USER created."
else
  log "User $APP_USER already exists."
fi

# ── 5. Clone / pull repo ─────────────────────────────────────────────────
info "Setting up app directory at $APP_DIR..."
mkdir -p $APP_DIR
chown -R $APP_USER:$APP_USER $APP_DIR

if [ ! -d "$APP_DIR/.git" ]; then
  info "Cloning repository..."
  sudo -u $APP_USER git clone $REPO_URL $APP_DIR
else
  info "Pulling latest changes..."
  sudo -u $APP_USER git -C $APP_DIR pull origin main
fi

cd $APP_DIR
log "Source code ready at $APP_DIR."

# ── 6. Install dependencies ──────────────────────────────────────────────
info "Installing npm dependencies (this may take a few minutes)..."
sudo -u $APP_USER npm install --omit=dev --no-audit --no-fund 2>&1 | tail -20
log "Dependencies installed."

# ── 7. Create directories & env ──────────────────────────────────────────
info "Setting up data directories..."
mkdir -p $APP_DIR/data/{temp,cache,thumbs,uploads}
chown -R $APP_USER:$APP_USER $APP_DIR/data

if [ ! -f "$APP_DIR/.env" ]; then
  info "Generating secure .env file..."
  SECRET=$(openssl rand -hex 32)
  cat > $APP_DIR/.env <<EOF
# Nexus Drive Production Config
PORT=$APP_PORT
NODE_ENV=production
DATA_DIR=$APP_DIR/data

# Password for web dashboard (CHANGE THIS!)
DRIVE_PASSWORD=changeme123

# Session secret (already random — DO NOT SHARE)
DRIVE_SECRET=$SECRET

# Telegram API credentials (get from https://my.telegram.org)
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
EOF
  chown $APP_USER:$APP_USER $APP_DIR/.env
  chmod 600 $APP_DIR/.env
  warn "Generated $APP_DIR/.env — please edit it with your credentials!"
  warn "Run: sudo nano $APP_DIR/.env"
else
  log ".env already exists."
fi

# ── 8. Create systemd service ───────────────────────────────────────────
info "Creating systemd service..."
cat > /etc/systemd/system/nexusdrive.service <<EOF
[Unit]
Description=Nexus Drive - Telegram Cloud Storage
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node --localstorage-file=$APP_DIR/data/gramjs-localstorage.json server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nexusdrive

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nexusdrive.service
log "Systemd service installed (not started yet)."

# ── 9. Configure nginx reverse proxy ─────────────────────────────────────
info "Configuring nginx..."
cat > /etc/nginx/sites-available/nexusdrive <<EOF
server {
    listen 80;
    server_name ${DOMAIN:-_};

    client_max_body_size 0;  # unlimited upload size
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 60s;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # Allow large uploads
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
EOF

if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
  ln -sf /etc/nginx/sites-available/nexusdrive /etc/nginx/sites-enabled/nexusdrive
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t && systemctl enable nginx && systemctl restart nginx
log "Nginx configured."

# ── 10. Configure firewall ───────────────────────────────────────────────
info "Configuring firewall..."
if command -v ufw >/dev/null 2>&1; then
  ufw --force reset >/dev/null 2>&1
  ufw default deny incoming >/dev/null 2>&1
  ufw default allow outgoing >/dev/null 2>&1
  ufw allow ssh >/dev/null 2>&1
  ufw allow http >/dev/null 2>&1
  ufw allow https >/dev/null 2>&1
  ufw --force enable >/dev/null 2>&1
  log "UFW firewall configured."
else
  warn "UFW not available. Configure iptables/Oracle security list manually!"
fi

# ── 11. SSL setup (optional) ─────────────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  info "Setting up SSL for $DOMAIN..."
  certbot --nginx -d $DOMAIN --non-interactive --agree-tos --register-unsafely-without-email || warn "SSL setup failed — run manually later"
else
  info "Skipping SSL (no DOMAIN set). Run later with:"
  info "  sudo certbot --nginx -d yourdomain.com"
fi

# ── 12. Oracle Cloud security list reminder ──────────────────────────────
warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
warn "IMPORTANT — Oracle Cloud Security List:"
warn "  1. Go to: Oracle Cloud Console → Networking → Virtual Cloud Networks"
warn "  2. Select your VCN → Subnet → Security Lists"
warn "  3. Add Ingress Rule:"
warn "     Source CIDR: 0.0.0.0/0"
warn "     Protocol: TCP"
warn "     Destination Port: 80, 443, 22"
warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 13. Start service ────────────────────────────────────────────────────
info "Starting Nexus Drive service..."
systemctl start nexusdrive.service
sleep 2
systemctl status nexusdrive.service --no-pager || true

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Setup complete!"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
info "Next steps:"
echo "  1. Edit credentials:  sudo nano $APP_DIR/.env"
echo "  2. Restart service:   sudo systemctl restart nexusdrive"
echo "  3. View logs:         sudo journalctl -u nexusdrive -f"
echo "  4. Open in browser:   http://$(curl -s ifconfig.me):${APP_PORT}"
echo ""
warn "Public IP detected: $(curl -s ifconfig.me)"
echo ""
