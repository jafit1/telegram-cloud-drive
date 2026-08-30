# 🌐 Nexus Drive — Cloudflare Tunnel (5 Menit Setup, Tanpa Daftar)

Cara **paling mudah** untuk expose app Anda ke internet publik. **Tanpa daftar akun, tanpa kartu kredit, tanpa domain.**

## ✨ Konsep

```
[PC/Laptop/Server Anda]  ──cloudflared──>  Cloudflare Edge  ──>  Internet
        :3000                              (SSL otomatis)         https://xxx.trycloudflare.com
```

Cloudflare quick tunnel bikin "pintu" dari server lokal Anda langsung ke CDN Cloudflare — dapat URL publik dengan HTTPS, gratis unlimited bandwidth.

## ✅ Keuntungan
- ⚡ **Setup 5 menit** — 1 command jalan
- 🔒 **SSL otomatis** — HTTPS tanpa setup
- 🌍 **Akses global** — dari HP, laptop, teman, di mana saja
- 🆓 **100% gratis** — tidak perlu akun
- 🛡️ **Anti-DDoS** — gratis dari Cloudflare
- 🚫 **Tanpa port forwarding** — tidak perlu setting router/firewall

## ⚠️ Catatan
- URL publik berubah tiap restart (kalau pakai quick tunnel tanpa akun)
- Kalau PC/laptop mati → app mati (solusi: jalan di server yang selalu nyala)

---

## 🚀 Cara Pakai (Windows)

### Opsi 1: Otomatis (Recommended)

```powershell
cd "d:\Project\New folder\telegram-cloud-drive\deploy"
powershell -ExecutionPolicy Bypass -File .\tunnel-setup.ps1
```

Script akan otomatis:
1. Download & install `cloudflared`
2. Start server (kalau belum jalan)
3. Buka tunnel + tampilkan URL publik

### Opsi 2: Manual

```powershell
# 1. Install cloudflared
winget install --id Cloudflare.cloudflared

# ATAU download dari: https://github.com/cloudflare/cloudflared/releases
# Extract cloudflared.exe ke folder manapun, tambahkan ke PATH

# 2. Pastikan app jalan di port 3000
cd "d:\Project\New folder\telegram-cloud-drive"
node --localstorage-file=data/gramjs-localstorage.json server.js

# 3. Di terminal LAIN, jalankan tunnel
cloudflared tunnel --url http://localhost:3000
```

Outputnya akan menampilkan URL seperti:
```
Your quick tunnel has been created! Visit it at:
https://random-words-random.trycloudflare.com
```

**Itu URL publik Anda!** Share ke siapa saja.

---

## 🐧 Cara Pakai (Linux / macOS)

```bash
cd /path/to/telegram-cloud-drive/deploy
chmod +x tunnel-setup.sh
bash tunnel-setup.sh
```

Atau manual:
```bash
# Linux
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cf.deb
sudo dpkg -i /tmp/cf.deb

# macOS
brew install cloudflared

# Start tunnel
cloudflared tunnel --url http://localhost:3000
```

---

## 🏠 Cara Pakai dengan Domain Sendiri (Opsional)

Kalau Anda punya domain (misal `drive.yourdomain.com`) dan ingin URL permanen:

### Setup (1x)
```bash
# 1. Login ke Cloudflare (perlu akun, tapi gratis)
cloudflared tunnel login

# 2. Buat tunnel
cloudflared tunnel create nexus-drive

# 3. Setup DNS
cloudflared tunnel route dns nexus-drive drive.yourdomain.com

# 4. Buat config file
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<EOF
url: http://localhost:3000
tunnel: nexus-drive
credentials-file: /path/to/<TUNNEL_ID>.json
EOF

# 5. Run
cloudflared tunnel run nexus-drive
```

URL Anda jadi permanen: `https://drive.yourdomain.com`

---

## 🖥️ Auto-Start saat Boot (Windows)

Supaya tunnel auto-start saat PC nyala:

1. Tekan `Win + R` → ketik `shell:startup` → Enter
2. Buat shortcut di folder tersebut, target:
   ```
   powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\Project\New folder\telegram-cloud-drive\deploy\tunnel-setup.ps1"
   ```

Sekarang tiap PC nyala, tunnel otomatis jalan.

---

## 🐧 Auto-Start saat Boot (Linux)

```bash
sudo nano /etc/systemd/system/nexus-tunnel.service
```

Isi:
```ini
[Unit]
Description=Nexus Drive Cloudflare Tunnel
After=network.target nexusdrive.service

[Service]
Type=simple
User=youruser
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3000 --no-autoupdate
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable nexus-tunnel
sudo systemctl start nexus-tunnel
```

---

## 📊 Cek Status Tunnel

Liat log live:
```bash
cloudflared tunnel info
```

Cek koneksi:
```powershell
# Cek tunnel aktif
Get-Process cloudflared

# Cek port 3000
Get-NetTCPConnection -LocalPort 3000
```

---

## 🆘 Troubleshooting

| Masalah | Solusi |
|---|---|
| URL tidak muncul | Tunggu 10-30 detik pertama kali (download binary ~30MB) |
| `command not found: cloudflared` | Restart terminal atau tambah ke PATH manual |
| Tunnel putus terus | PC sleep/hibernate → disable di Power Settings |
| App error di tunnel | Cek `app.log` di folder repo |
| Port 3000 sudah dipakai | Edit server.js ganti PORT, atau set `PORT=3001` di .env |

### Cek log app
```powershell
# Windows
Get-Content "d:\Project\New folder\telegram-cloud-drive\app.log" -Wait

# Linux
tail -f /path/to/telegram-cloud-drive/app.log
```

---

## 💡 Tips

1. **Jangan close terminal** — kalau tutup, tunnel putus
2. **PC harus tetap nyala** — kalau mati, URL mati juga
3. **Gunakan screen/tmux** di Linux agar tunnel tetap jalan saat SSH disconnect
4. **Untuk production 24/7**, gunakan VPS murah (~$3/bulan) atau lihat `README-ORACLE.md`

---

## 🎯 Rekomendasi Setup Permanen (Murah)

Kalau mau app jalan **24/7 tanpa PC nyala terus**, alternatif terbaik:

| Opsi | Biaya | Cara |
|---|---|---|
| **Mini PC** | Rp 1-2 juta (sekali) | Bekas mini PC + install Windows/Linux |
| **Raspberry Pi 4** | Rp 500rb-1jt (sekali) | Low power, selalu nyala |
| **VPS murah** | $2-3/bulan | Contabo, Hetzner, DigitalOcean |
| **Oracle Free** | $0/bulan | Lihat `README-ORACLE.md` |

Setelah dapat server murah, tinggal install Node.js + jalankan tunnel di sana — tetap gratis bandwidth karena pakai Cloudflare!
