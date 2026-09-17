# reset-password.ps1 — Ganti password dashboard Drive Uyee di Fly.
#
# Kenapa cara ini aman untuk sesi Telegram:
#   auth.js hanya membaca DRIVE_PASSWORD dari environment saat proses start.
#   Sesi Telegram hidup di data/config.json (volume /data). Mengganti secret
#   lalu me-restart mesin tidak menyentuh /data sama sekali, jadi Anda tidak
#   perlu login Telegram ulang.
#
# Pakai:
#   pwsh ./reset-password.ps1                 # password acak 24 karakter
#   pwsh ./reset-password.ps1 -Password "..." # password pilihan sendiri
#
# Opsi -Secret mengubah DRIVE_SECRET. JANGAN pakai saat sekadar reset password:
# cookie sesi lama jadi tidak berlaku dan Anda logout dari browser.

param(
  [string]$App = 'drive-uyee',
  [string]$Password = '',
  [switch]$Secret
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) {
  throw 'flyctl tidak ditemukan di PATH.'
}

if (-not $Password) {
  $chars = (48..57) + (65..90) + (97..122)
  $Password = -join ($chars | Get-Random -Count 24 | ForEach-Object { [char]$_ })
}

Write-Host "App         : $App"
Write-Host "Panjang pw  : $($Password.Length) karakter"
Write-Host 'Mengirim secret ke Fly (restart otomatis)...'

& flyctl secrets set --app $App "DRIVE_PASSWORD=$Password"

if ($Secret) {
  $hex = (48..57) + (97..102)
  $newSecret = -join ($hex | Get-Random -Count 64 | ForEach-Object { [char]$_ })
  & flyctl secrets set --app $App "DRIVE_SECRET=$newSecret"
  Write-Host 'DRIVE_SECRET ikut diganti — semua cookie sesi lama tidak berlaku lagi.'
}

Write-Host ''
Write-Host "Password baru : $Password"
Write-Host 'Sesi Telegram di /data/config.json tidak tersentuh.'
Write-Host 'Simpan password ini di tempat aman, lalu hapus dari riwayat terminal bila perlu.'
