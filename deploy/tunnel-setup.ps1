# ============================================================================
# Drive Uyee — Cloudflare Tunnel Setup untuk Windows
# ----------------------------------------------------------------------------
# Exposes local server ke internet via Cloudflare quick tunnel.
# TIDAK PERLU daftar akun / kartu kredit / domain.
# Run as:    powershell -ExecutionPolicy Bypass -File .\tunnel-setup.ps1
# ============================================================================

$ErrorActionPreference = "Stop"

# Colors
function Log($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Info($m)  { Write-Host "[i] $m" -ForegroundColor Cyan }
function Warn($m)  { Write-Host "[!] $m" -ForegroundColor Yellow }
function Fail($m)  { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

# ── 1. Detect arch ────────────────────────────────────────────────────────
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "AMD64") { $cfArch = "amd64" } elseif ($arch -eq "ARM64") { $cfArch = "arm64" } else { Fail "Unsupported arch: $arch" }
Info "Detected: Windows / $cfArch"

# ── 2. Install cloudflared ───────────────────────────────────────────────
$cfPath = "$env:LOCALAPPDATA\Microsoft\WindowsApps\cloudflared.exe"
$cfAltPath = "C:\Program Files\cloudflared\cloudflared.exe"
$winget = Get-Command winget -ErrorAction SilentlyContinue
$choco = Get-Command choco -ErrorAction SilentlyContinue

$cfCmd = $null
if (Test-Path $cfPath) {
    $cfCmd = $cfPath
    Log "cloudflared found at: $cfCmd"
} elseif (Test-Path $cfAltPath) {
    $cfCmd = $cfAltPath
    Log "cloudflared found at: $cfCmd"
} elseif (Get-Command cloudflared -ErrorAction SilentlyContinue) {
    $cfCmd = "cloudflared"
    Log "cloudflared found in PATH"
} else {
    if ($winget) {
        Info "Installing via winget..."
        winget install --id Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements
        $cfCmd = "cloudflared"
    } elseif ($choco) {
        Info "Installing via choco..."
        choco install cloudflared -y
        $cfCmd = "cloudflared"
    } else {
        Info "Downloading cloudflared binary..."
        $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$cfArch.exe"
        $outDir = "$env:USERPROFILE\.cloudflared"
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        $outFile = "$outDir\cloudflared.exe"
        Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
        $env:PATH += ";$outDir"
        [Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";$outDir", "User")
        $cfCmd = $outFile
    }
    Log "cloudflared installed"
}

# ── 3. Check app is running ───────────────────────────────────────────────
try {
    $code = (Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop).StatusCode
    Log "App is running (HTTP $code)"
} catch {
    Warn "App not running on port 3000. Starting now..."
    if (Test-Path ".env") {
        Get-Content ".env" | ForEach-Object {
            if ($_ -match "^\s*([^#][^=]*)=(.*)$") {
                [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process")
            }
        }
    }
    $proc = Start-Process -FilePath "node" -ArgumentList "--localstorage-file=data/gramjs-localstorage.json","server.js" -WorkingDirectory $RepoRoot -PassThru -NoNewWindow -RedirectStandardOutput "app.log" -RedirectStandardError "app.log"
    Start-Sleep -Seconds 3
    Log "App started (PID $($proc.Id))"
}

# ── 4. Start tunnel ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Info "Starting Cloudflare quick tunnel..."
Info "Your public URL will appear below (trycloudflare.com)"
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""

# Run cloudflared - this is a long-running process, Ctrl+C to stop
& $cfCmd tunnel --url http://localhost:3000 --no-autoupdate
