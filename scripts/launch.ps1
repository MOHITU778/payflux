<#
    PayFlux launcher - the logic behind start.bat.

    Kept in PowerShell rather than batch because this needs real control flow:
    probing ports, polling container health, and parsing .env. Batch can do it,
    but only with idioms that break silently on a locale change or a missing
    tool. start.bat invokes this with -ExecutionPolicy Bypass, so no machine
    configuration is required.
#>

[CmdletBinding()]
param(
    [switch]$NoBrowser,   # skip opening tabs
    [switch]$Reseed       # wipe and reseed demo data
)

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'   # Invoke-WebRequest is very slow without this

# Run from the repository root, whatever the caller's working directory is.
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step($n, $text) { Write-Host "  [$n/6] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "        $text" -ForegroundColor DarkGray }
function Write-Warn2($text)    { Write-Host "        $text" -ForegroundColor Yellow }

function Fail($title, $hint) {
    Write-Host ""
    Write-Host "  ERROR: $title" -ForegroundColor Red
    Write-Host ""
    foreach ($line in $hint) { Write-Host "    $line" -ForegroundColor Gray }
    Write-Host ""
    Read-Host "  Press Enter to close"
    exit 1
}

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  ===========================================================" -ForegroundColor Blue
Write-Host "    PayFlux - Distributed Payment Gateway" -ForegroundColor White
Write-Host "  ===========================================================" -ForegroundColor Blue
Write-Host ""

# --- 1. Docker -------------------------------------------------------------
Write-Step 1 "Checking Docker..."

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Docker is not installed, or not on your PATH." @(
        "Install Docker Desktop:  https://www.docker.com/products/docker-desktop",
        "Then re-run this script."
    )
}

# `docker info` fails when the CLI is present but the engine is not running -
# by far the most common cause of a failed first run.
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "Docker is installed, but the engine is not running." @(
        "Start Docker Desktop and wait for the whale icon to stop animating,",
        "then re-run this script."
    )
}

docker compose version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "'docker compose' is unavailable (your Docker may be very old)." @(
        "Update Docker Desktop and re-run."
    )
}
Write-Ok "Docker is running."

# --- 2. Ports --------------------------------------------------------------
Write-Step 2 "Checking ports..."

<#
    Test a port by actually binding it, rather than by parsing `netstat`.
    Binding is precisely what Docker is about to attempt, so this answers the
    real question - and it does not depend on netstat's output format, which
    differs across Windows locales.
#>
function Test-PortFree([int]$Port) {
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { try { $listener.Stop() } catch { } }
    }
}

function Get-FreePort([int]$Preferred) {
    $p = $Preferred
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-PortFree $p) { return $p }
        $p++
    }
    return $Preferred   # give up and let compose report the conflict
}

$defaults = [ordered]@{
    API_PORT        = 4000
    CONSOLE_PORT    = 8080
    STOREFRONT_PORT = 8081
    MONGO_PORT      = 27017
    REDIS_PORT_HOST = 6379
}
$labels = @{
    API_PORT = 'API'; CONSOLE_PORT = 'console'; STOREFRONT_PORT = 'storefront'
    MONGO_PORT = 'MongoDB'; REDIS_PORT_HOST = 'Redis'
}

$ports = [ordered]@{}
foreach ($key in $defaults.Keys) {
    $chosen = Get-FreePort $defaults[$key]
    $ports[$key] = $chosen
    if ($chosen -ne $defaults[$key]) {
        Write-Warn2 "Port $($defaults[$key]) is in use - using $chosen for the $($labels[$key])."
    }
}
Write-Ok "Ports resolved."

# --- 3. Configuration ------------------------------------------------------
Write-Step 3 "Preparing configuration..."

function New-Secret {
    # 32 random bytes as hex = 64 chars. The config layer rejects anything
    # shorter than 32, because a short JWT secret is a brute-forceable one.
    $bytes = New-Object byte[] 32
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

if (Test-Path '.env') {
    Write-Ok "Existing .env found - keeping your settings."
    Write-Ok "(delete .env and re-run to regenerate it)"

    # An existing .env wins: the user may have chosen these ports deliberately.
    foreach ($line in Get-Content '.env') {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') {
            if ($ports.Contains($Matches[1])) { $ports[$Matches[1]] = $Matches[2] }
        }
    }
} else {
    $content = @(
        '# Generated by start.bat - do not commit this file.',
        "JWT_SECRET=$(New-Secret)",
        "JWT_REFRESH_SECRET=$(New-Secret)",
        ''
    )
    foreach ($key in $ports.Keys) { $content += "$key=$($ports[$key])" }

    # ASCII, no BOM: docker compose does not strip a UTF-8 BOM, and a BOM on
    # the first line turns JWT_SECRET into "?JWT_SECRET" - which fails the
    # 32-character check with a baffling error.
    [System.IO.File]::WriteAllLines((Join-Path $Root '.env'), $content, (New-Object System.Text.ASCIIEncoding))
    Write-Ok "Generated .env with fresh secrets."
}

# --- 4. Build and start ----------------------------------------------------
Write-Step 4 "Building and starting containers..."
Write-Ok "First run pulls images and builds - allow 3-5 minutes."
Write-Host ""

docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
    Fail "docker compose failed (see the output above)." @(
        "Common causes:",
        "  - no internet connection for the initial image pull",
        "  - a port was taken by another program after this script checked",
        "  - Docker Desktop ran out of disk or memory"
    )
}
Write-Host ""

# --- 5. Wait for health ----------------------------------------------------
Write-Step 5 "Waiting for services to become healthy..."

function Get-Health($container) {
    $status = docker inspect --format '{{.State.Health.Status}}' $container 2>$null
    if ($LASTEXITCODE -ne 0) { return 'missing' }
    return ($status | Select-Object -First 1).Trim()
}

$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
    $api = Get-Health 'payflux-api'
    if ($api -eq 'healthy') { $healthy = $true; break }
    if ($i -eq 10) { Write-Ok "Still starting (MongoDB elects its replica set first)..." }
    Start-Sleep -Seconds 3
}

if ($healthy) {
    Write-Ok "API is healthy."
} else {
    Write-Warn2 "Services did not report healthy within ~3 minutes."
    Write-Warn2 "Check with:  docker compose ps"
    Write-Warn2 "Logs:        docker compose logs api"
}

# --- 6. Demo data ----------------------------------------------------------
Write-Step 6 "Checking demo data..."

# Ask the database directly rather than guessing. Exit 0 = already seeded.
$probe = 'const m=require("mongoose");(async()=>{try{await m.connect(process.env.MONGO_URI);' +
         'const n=await m.connection.db.collection("users").countDocuments();await m.disconnect();' +
         'process.exit(n>0?0:1)}catch(e){process.exit(1)}})()'
docker compose exec -T api node -e $probe 2>&1 | Out-Null
$alreadySeeded = ($LASTEXITCODE -eq 0)

if ($Reseed -or -not $alreadySeeded) {
    Write-Ok "Seeding demo data (420 payments, ledger, fraud alerts)..."
    docker compose exec -T api npm run seed
} else {
    Write-Ok "Demo data already present - skipping seed."
}

# --- Summary ---------------------------------------------------------------
$store   = $ports['STOREFRONT_PORT']
$console = $ports['CONSOLE_PORT']
$api     = $ports['API_PORT']

Write-Host ""
Write-Host "  ===========================================================" -ForegroundColor Green
Write-Host "    PayFlux is running" -ForegroundColor Green
Write-Host "  ===========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "    Storefront  (buy something)    " -NoNewline -ForegroundColor White
Write-Host "http://localhost:$store" -ForegroundColor Cyan
Write-Host "    Console     (admin dashboard)  " -NoNewline -ForegroundColor White
Write-Host "http://localhost:$console" -ForegroundColor Cyan
Write-Host "    Swagger     (API docs)         " -NoNewline -ForegroundColor White
Write-Host "http://localhost:$api/api/docs" -ForegroundColor Cyan
Write-Host "    Health                         " -NoNewline -ForegroundColor White
Write-Host "http://localhost:$api/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "    Sign in with (password PayFlux#2024 for all):" -ForegroundColor White
Write-Host "      ADMIN     admin@payflux.io" -ForegroundColor Gray
Write-Host "      MERCHANT  merchant@nimbusretail.example" -ForegroundColor Gray
Write-Host "      SUPPORT   support@payflux.io" -ForegroundColor Gray
Write-Host ""
Write-Host "    Stop:  " -NoNewline -ForegroundColor White
Write-Host "docker compose down" -ForegroundColor Gray
Write-Host "    Logs:  " -NoNewline -ForegroundColor White
Write-Host "docker compose logs -f api" -ForegroundColor Gray
Write-Host ""
Write-Host "  ===========================================================" -ForegroundColor Green
Write-Host ""

if (-not $NoBrowser) {
    Write-Host "  Opening your browser..." -ForegroundColor DarkGray
    Start-Process "http://localhost:$store"
    Start-Sleep -Milliseconds 800
    Start-Process "http://localhost:$console"
    Start-Sleep -Milliseconds 800
    Start-Process "http://localhost:$api/api/docs"
    Write-Host ""
}

Write-Host "  The containers keep running after you close this window." -ForegroundColor DarkGray
Write-Host ""
Read-Host "  Press Enter to close"
