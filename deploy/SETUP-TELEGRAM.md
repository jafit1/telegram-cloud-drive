# Setup Telegram — Panduan Step-by-Step

> **Jangan pernah menuliskan password, session secret, atau URL tunnel aktif di
> file ini.** Dokumen ini ikut ke dalam repo. Semua nilai rahasia diisi lewat
> environment variable atau lewat wizard di browser, tidak pernah lewat file
> yang di-commit.

Drive ini memakai **MTProto user session** (bukan Bot API), jadi tidak terkena
batas 50 MB milik bot. Konsekuensinya: yang login adalah akun Telegram Anda
sendiri, dan session string yang dihasilkan setara dengan akses penuh ke akun
itu. Perlakukan seperti password.

---

## Cara 1: lewat Wizard Web (RECOMMENDED)

Tidak perlu mengedit file apa pun.

### 1. Jalankan server

```powershell
$env:DRIVE_PASSWORD = "<password-panjang-pilihan-anda>"
$env:DRIVE_SECRET   = "<32+ karakter acak, lihat cara generate di bawah>"
$env:PORT           = "3000"
npm start
```

`DRIVE_PASSWORD` adalah password untuk membuka drive di browser. `DRIVE_SECRET`
adalah kunci HMAC untuk menandatangani cookie session — kalau nilainya berubah,
semua sesi login yang sedang berjalan langsung tidak valid. Server menolak
start kalau `DRIVE_PASSWORD` tidak diset, jadi tidak ada mode "tanpa password".

Generate `DRIVE_SECRET` yang layak:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Buka drive di browser

Lokal: `http://localhost:3000`

Kalau diakses dari luar, pakai URL deploy Anda sendiri. Quick tunnel Cloudflare
(`trycloudflare.com`) menghasilkan URL baru setiap kali dijalankan dan mati saat
prosesnya berhenti — jadi URL-nya tidak pernah dicatat di sini. Ambil URL-nya
dari output `cloudflared` saat itu.

### 3. Ikuti wizard

Masukkan password → wizard setup Telegram muncul:

| Step | Isi |
|------|-----|
| 1 | **API ID** dan **API Hash** dari https://my.telegram.org |
| 2 | Nomor HP format internasional, mis. `+6281234567890` |
| 3 | Kode OTP — dikirim lewat **aplikasi Telegram**, bukan SMS |
| 4 | Password 2FA, hanya kalau akun Anda mengaktifkannya |
| 5 | **Chat ID** grup/channel yang dipakai sebagai storage |

Selesai. Session disimpan di `data/config.json` dan tidak perlu diulang.

---

## Cara 2: Isi `data/config.json` manual

### 1. Ambil API credentials

1. Buka https://my.telegram.org
2. Login dengan nomor Telegram Anda
3. Klik **"API development tools"**
4. Isi form:
   - **App title**: `Drive Uyee`
   - **Short name**: `nexusdrive`
   - **Platform**: `Desktop`
5. Klik **"Create application"**
6. Catat **api_id** (angka) dan **api_hash** (32 karakter hex)

### 2. Tulis `data/config.json`

Semua state mutable ada di `data/`. Isi `apiId` dan `apiHash` saja; dua field
sisanya diisi oleh wizard.

```json
{
  "apiId": "",
  "apiHash": "",
  "sessionString": "",
  "chatId": ""
}
```

### 3. Restart server

```powershell
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
$env:DRIVE_PASSWORD = "<password-panjang-pilihan-anda>"
$env:DRIVE_SECRET   = "<32+ karakter acak>"
npm start
```

Gunakan `npm start`, bukan `node server.js` langsung — script-nya sudah
menyertakan `--localstorage-file=data/gramjs-localstorage.json`, yang dibutuhkan
GramJS dan harus berada di `data/` supaya ikut terbawa volume saat deploy.

### 4. Selesaikan OTP

Buka drive di browser. Wizard membaca API credentials dari `data/config.json`
dan langsung meminta nomor HP + OTP.

---

## Mencari Chat ID

### Opsi A: Saved Messages (paling simpel)
Chat dengan diri sendiri. Pakai bot `@userinfobot` untuk mendapatkan ID Anda.

### Opsi B: Private group baru
1. Buat group baru
2. Invite `@RawDataBot`
3. Bot membalas info group termasuk `id` (format `-100xxxxxxxxxx`)
4. Keluarkan bot dari group

---

## Catatan Keamanan

- **Jangan share API ID, API Hash, atau session string.** Session string setara
  akses penuh ke akun Telegram Anda.
- File sensitif — `data/config.json`, `data/gramjs-localstorage.json`,
  `data/metadata.db*` — sudah dikecualikan di `.gitignore`. Pola di `.gitignore`
  tidak di-anchor, jadi berlaku di semua kedalaman folder.
- `.gitignore` hanya mencegah commit **baru**. Kalau file rahasia pernah
  ter-commit sebelumnya, isinya masih ada di history. Cek dengan:

  ```powershell
  git log --all --oneline -- config.json data/config.json
  git log --all -p -S "apiHash" -- config.json data/config.json
  ```

  Kalau ada hasilnya, **rotate api_hash** di my.telegram.org — menghapus file
  dari commit terbaru tidak cukup.
- Kalau Telegram mencabut auth key (logout dari device lain, atau akun
  dinonaktifkan), server mendeteksinya dan membalas HTTP 409 dengan banner di
  UI. Jalankan wizard lagi untuk membuat session baru.
