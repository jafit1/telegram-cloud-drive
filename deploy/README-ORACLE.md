# 🚀 Deploy Drive Uyee ke Oracle Cloud (GRATIS SELAMANYA)

Panduan lengkap deploy Telegram Cloud Drive ke Oracle Cloud Free Tier — **gratis selamanya, 24/7, tanpa batas waktu**.

## 📋 Yang Anda Dapat

| Resource | Spec | Biaya |
|---|---|---|
| **VM** | 4 CPU ARM Ampere A1, 24 GB RAM | $0 |
| **Storage** | 200 GB volume | $0 |
| **Bandwidth** | 10 TB/bulan egress | $0 |
| **IP Public** | Selamanya | $0 |
| **Total** | Lebih dari cukup untuk Cloud Drive | **$0/bulan selamanya** |

> ⚠️ Oracle Cloud Free Tier **tidak pernah expire** selama instance tetap dijalankan (tidak boleh di-"Stop" permanen — cukup di-"Reboot").

---

## 🔧 Langkah 1: Daftar Oracle Cloud

1. Buka [cloud.oracle.com](https://cloud.oracle.com/) → klik **Start for Free**
2. Isi form: email, negara, nama — **tidak perlu kartu kredit** (kadang verifikasi HP saja)
3. Pilih **Home Region** = **Singapore** atau **Tokyo** (dekat Indonesia, latency rendah)
4. Setelah login, masuk ke **Console**

---

## 🖥️ Langkah 2: Buat VM Instance

1. Di console, klik hamburger menu (☰) → **Compute** → **Instances** → **Create Instance**
2. Isi konfigurasi:
   - **Name**: `nexus-drive`
   - **Shape**: klik **Edit** → pilih **Ampere A1** (VM.Standard.A1.Flex) — ini yang free
     - **OCPU**: 4
     - **RAM**: 24 GB
   - **Image**: Oracle Linux 8 (atau Ubuntu 22.04)
   - **Boot volume**: 50 GB
3. **Download SSH key** (atau upload public key Anda sendiri)
4. Klik **Create**

> ⏳ Provisioning butuh 1-3 menit. Catat **Public IP**.

---

## 🌐 Langkah 3: Buka Port di Security List

**PENTING** — Oracle default-nya block semua port masuk kecuali SSH.

1. Di halaman instance, klik **Subnet** (link biru di bagian bawah)
2. Klik **Default Security List** untuk subnet Anda
3. Klik **Add Ingress Rules**:
   - **Source CIDR**: `0.0.0.0/0`
   - **Protocol**: TCP
   - **Destination Port**: `80`
4. Ulangi untuk port `443` (HTTPS)
5. Klik **Add Ingress Rules**

---

## 🔑 Langkah 4: SSH ke Server

Dari terminal lokal:

```bash
# Linux/Mac
chmod 400 key.key
ssh -i key.key opc@<PUBLIC_IP>

# Windows PowerShell
ssh -i C:\path\to\key.key opc@<PUBLIC_IP>
```

Ganti `<PUBLIC_IP>` dengan IP publik instance.

---

## 🚀 Langkah 5: Jalankan Script Setup

Setelah masuk SSH sebagai `opc`:

```bash
# Opsional: pakai domain
# export DOMAIN="drive.yourdomain.com"

curl -fsSL https://raw.githubusercontent.com/jafit1/telegram-cloud-drive/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh
```

Script otomatis:
- ✅ Install Node.js 22 LTS
- ✅ Clone repository dari GitHub
- ✅ Install dependencies
- ✅ Generate `.env` dengan secret random
- ✅ Setup systemd service (auto-restart kalau crash)
- ✅ Setup nginx reverse proxy
- ✅ Setup firewall (UFW)

---

## ⚙️ Langkah 6: Konfigurasi Telegram API

1. Buka [my.telegram.org](https://my.telegram.org)
2. Login → **API development tools** → **Create new application**
3. Catat **api_id** dan **api_hash**

Edit file `.env`:

```bash
sudo nano /opt/nexusdrive/.env
```

Isi:
```env
DRIVE_PASSWORD=passwordKuatAnda123!
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
```

Save (`Ctrl+O`, `Enter`, `Ctrl+X`).

---

## 🎯 Langkah 7: Jalankan & Login Telegram

```bash
sudo systemctl restart nexusdrive
sudo journalctl -u nexusdrive -f
```

Buka browser ke `http://<PUBLIC_IP>` → masukkan password dashboard → setup Telegram:
1. Masukkan nomor HP (format `+62xxx`)
2. Masukkan kode OTP
3. Jika 2FA aktif, masukkan password
4. Session tersimpan permanen!

---

## 📊 Perintah Penting

```bash
# Status service
sudo systemctl status nexusdrive

# Live logs
sudo journalctl -u nexusdrive -f

# Restart
sudo systemctl restart nexusdrive

# Stop
sudo systemctl stop nexusdrive

# Update app
cd /opt/nexusdrive && sudo -u nexusdrive git pull && sudo systemctl restart nexusdrive

# Backup data
sudo tar -czf backup-$(date +%Y%m%d).tar.gz /opt/nexusdrive/data

# Disk usage
du -sh /opt/nexusdrive/data/*
```

---

## 🔒 Setup Domain + SSL (Opsional)

1. Beli domain murah (Namecheap / Cloudflare / Porkbun)
2. Point A record ke IP Oracle instance
3. SSH ke server:
   ```bash
   sudo certbot --nginx -d drive.yourdomain.com
   ```
4. HTTPS otomatis aktif + auto-renew!

---

## ⚠️ JANGAN PERNAH "STOP" INSTANCE

Oracle Cloud Free Tier akan **hapus instance setelah 7 hari** jika di-STOP. Selalu pakai:

```bash
# ✅ AMAN
sudo reboot              # restart OS, instance tetap ada
oci reboot instance     # restart dari Oracle CLI

# ❌ JANGAN KECUALI EMERGENCY
# Klik "Stop" di Console = instance akan dihapus 7 hari kemudian
```

Cek status di Console → Instance harus selalu **Running**.

---

## 🆘 Troubleshooting

| Masalah | Solusi |
|---|---|
| Service tidak start | `sudo journalctl -u nexusdrive -n 50` |
| Port 80 tidak bisa diakses | Cek Security List (Langkah 3) + `sudo ufw status` |
| OTP tidak masuk | Tunggu 1-2 menit, cek format nomor `+62xxx` |
| Lupa password dashboard | Edit `DRIVE_PASSWORD` di `.env`, restart service |
| Reset Telegram session | Hapus `/opt/nexusdrive/data/gramjs-localstorage.json*`, login ulang |
| Disk penuh | `sudo journalctl --vacuum-size=100M` (clear old logs) |

---

## 🎉 Selamat!

App Anda sekarang jalan **24/7 gratis selamanya** di Oracle Cloud. Share URL `http://<IP>` ke siapa saja!

Pertanyaan? Buka issue di GitHub.
