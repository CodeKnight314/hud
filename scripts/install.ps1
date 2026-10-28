# hud — terminal install on Windows: fetch the bundled CLI, verify it, put `hud` on PATH.
#
#   irm https://raw.githubusercontent.com/CodeKnight314/hud/main/scripts/install.ps1 | iex
#
# Options (environment): HUD_VERSION, HUD_HOME, HUD_REPO, HUD_ASSET_DIR
$ErrorActionPreference = 'Stop'

$Repo = if ($env:HUD_REPO) { $env:HUD_REPO } else { 'CodeKnight314/hud' }
$Home_ = if ($env:HUD_HOME) { $env:HUD_HOME } else { Join-Path $env:USERPROFILE '.hud' }
$Version = $env:HUD_VERSION
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("hud-install-" + [guid]::NewGuid().ToString('n'))

function Say([string]$Text) { Write-Host $Text }
function Die([string]$Text) { Write-Error "hud install: $Text"; exit 1 }

$Node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $Node) { Die 'hud needs Node.js 18 or newer: https://nodejs.org' }
$major = [int](& $Node.Source -p 'process.versions.node.split(".")[0]')
if ($major -lt 18) { Die "node $(& $Node.Source -v) is too old; hud needs 18+" }

New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  if ($env:HUD_ASSET_DIR) {
    $tarball = Get-ChildItem -Path $env:HUD_ASSET_DIR -Filter 'hud-*.tar.gz' | Sort-Object Name | Select-Object -Last 1
    if (-not $tarball) { Die "no hud-*.tar.gz in $($env:HUD_ASSET_DIR)" }
    Copy-Item $tarball.FullName (Join-Path $Tmp $tarball.Name)
    Copy-Item (Join-Path $env:HUD_ASSET_DIR 'SHA256SUMS') $Tmp
    if ($tarball.Name -match '^hud-(\d+\.\d+\.\d+)\.tar\.gz$') { $Version = $Matches[1] }
  } else {
    if (-not $Version) {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ accept = 'application/vnd.github+json'; 'user-agent' = 'hud-cli' }
      $Version = $release.tag_name.TrimStart('v')
    }
    if (-not $Version) { Die 'could not find the latest release; set HUD_VERSION (for example 0.3.0)' }
    $name = "hud-$Version.tar.gz"
    $base = "https://github.com/$Repo/releases/download/v$Version"
    Invoke-WebRequest -Uri "$base/$name" -OutFile (Join-Path $Tmp $name)
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile (Join-Path $Tmp 'SHA256SUMS')
  }

  $name = "hud-$Version.tar.gz"
  $sums = Get-Content (Join-Path $Tmp 'SHA256SUMS')
  $expected = ($sums | Where-Object { $_ -match "^[0-9a-f]{64}\s+\*?$([regex]::Escape($name))$" } | ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1)
  if (-not $expected) { Die "SHA256SUMS does not list $name" }
  $actual = (Get-FileHash (Join-Path $Tmp $name) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { Die "$name does not match SHA256SUMS (expected $expected, got $actual)" }

  $appNew = Join-Path $Home_ 'app.new'
  $app = Join-Path $Home_ 'app'
  $old = Join-Path $Home_ 'app.old'
  Remove-Item -Recurse -Force $appNew, $old -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $appNew, (Join-Path $Home_ 'bin') | Out-Null
  Copy-Item (Join-Path $Tmp $name) (Join-Path $appNew 'bundle.tar.gz')
  Push-Location $appNew
  try { & tar -xzf bundle.tar.gz } finally { Pop-Location }
  Remove-Item -Force (Join-Path $appNew 'bundle.tar.gz')
  if ($LASTEXITCODE -ne 0) { Die 'could not unpack the download' }
  if (-not (Test-Path (Join-Path $appNew 'hud.mjs')) -or -not (Test-Path (Join-Path $appNew 'web'))) { Die 'the download is not a hud CLI bundle' }

  if (Test-Path $app) { Move-Item $app $old }
  Move-Item $appNew $app
  Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue

  $launcher = Join-Path $Home_ 'bin\hud.cmd'
  $nodePath = $Node.Source
  @(
    '@echo off'
    "`"$nodePath`" `"$app\hud.mjs`" %*"
  ) | Set-Content -Path $launcher -Encoding ascii

  Say "hud $Version installed at $Home_"
  Say ''
  Say '  hud                 start the server and open the board in your browser'
  Say '  hud status          server pid, port, data dir'
  Say '  hud update          install the next release'
  Say '  hud mcp install     register hud with Claude Code, Codex and OpenCode'
  Say ''
  $binDir = Join-Path $Home_ 'bin'
  if (($env:PATH -split ';') -notcontains $binDir) {
    Say "add it to PATH for new terminals:"
    Say "  setx PATH `"%PATH%;$binDir`""
    Say ''
    Say "or run it by path now: $launcher"
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
