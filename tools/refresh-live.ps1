param(
  [string]$Live = (Join-Path $env:USERPROFILE '.claude\mods\constellation-live'),
  [string]$Previous = (Join-Path $env:USERPROFILE '.claude\mods\constellation-prev'),
  [switch]$Rollback,
  [switch]$CheckOnly,
  [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Invoke-Mirror([string]$From, [string]$To, [string[]]$Extra = @()) {
  & robocopy $From $To /MIR /NFL /NDL /NJH /NJS /NP @Extra | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed ($LASTEXITCODE)" }
}

function Find-ClaudeCli {
  $cli = Get-ChildItem (Join-Path $env:APPDATA 'Claude\claude-code\*\*\claude.exe') -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Directory.Parent.Name -replace '[^0-9.].*$', '') } | Select-Object -Last 1
  if (-not $cli) { throw 'Claude Code CLI not found under %APPDATA%\Claude\claude-code' }
  $cli.FullName
}

function Assert-Step([string]$Name, [scriptblock]$Run) {
  $started = Get-Date
  $ErrorActionPreference = 'Continue'
  $output = & $Run 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  if ($code -ne 0) {
    $failing = $output | Where-Object { "$_" -match '\(fail\)|not ok|FAILED|\| false|AssertionError|Expected' } | Select-Object -First 15
    if ($failing) {
      Write-Host '    failing:'
      $failing | ForEach-Object { Write-Host "      $_" }
    }
    $output | Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" }
    throw "$Name failed (exit $code). Nothing was mirrored."
  }
  $last = $output | Where-Object { "$_".Trim() -ne '' } | Select-Object -Last 1
  Write-Host ("ok  {0} ({1} s){2}" -f $Name, $seconds, $(if ($last) { " - $last" } else { '' }))
}

function Get-Modules {
  $patterns = @('companion\inbox\*.js', 'companion\lib\*.mjs', 'companion\*.mjs', 'shared\*.js', 'shared\aggregate\*.js', 'hooks\*.mjs', 'tools\*.mjs')
  foreach ($pattern in $patterns) { Get-ChildItem (Join-Path $repo $pattern) -ErrorAction SilentlyContinue }
}

if ($Rollback) {
  if (-not (Test-Path $Previous)) { throw "No previous copy at $Previous" }
  Invoke-Mirror $Previous $Live
  Write-Host "Rolled back: $Live now matches $Previous. New sessions load it."
  return
}

if (-not $AllowDirty -and -not $CheckOnly) {
  $dirty = & git -C $repo status --porcelain
  if ($dirty) { throw "The working tree has uncommitted changes; commit them first (or pass -AllowDirty). Nothing was mirrored." }
}

$cli = Find-ClaudeCli
$node = (Get-Command node -ErrorAction Stop).Source
Assert-Step 'validate' { & $cli plugin validate $repo }
Assert-Step 'kit tests' { & $cli plugin test $repo }
Assert-Step 'server unit tests' { & $node --test (Join-Path $repo 'tests\server\*.test.mjs') }
Assert-Step 'smoke test' { & $node (Join-Path $repo 'companion\smoke-test.mjs') }
Assert-Step 'hook check' { & $node (Join-Path $repo 'tools\approve-hook-check.mjs') }
Assert-Step 'type-check' { & $node (Join-Path $repo 'tools\typecheck.mjs') }
Assert-Step 'node --check' {
  $failed = 0
  foreach ($module in Get-Modules) {
    & $node --check $module.FullName
    if ($LASTEXITCODE -ne 0) { $failed += 1 }
  }
  $global:LASTEXITCODE = $(if ($failed -gt 0) { 1 } else { 0 })
  "modules checked, $failed failed"
}

if ($CheckOnly) {
  Write-Host 'All checks passed (-CheckOnly: nothing was mirrored).'
  return
}

if (Test-Path $Live) {
  Invoke-Mirror $Live $Previous
  Write-Host "ok  previous copy -> $Previous"
}
$export = Join-Path ([IO.Path]::GetTempPath()) "orbit-export-$PID"
$tarball = "$export.tar"
if (Test-Path $export) { Remove-Item -Recurse -Force $export }
New-Item -ItemType Directory $export | Out-Null
try {
  & git -C $repo archive --format=tar -o $tarball HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive HEAD failed. Nothing was mirrored.' }
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tarball -C $export
  if ($LASTEXITCODE -ne 0) { throw 'Unpacking the committed tree failed. Nothing was mirrored.' }
  Invoke-Mirror $export $Live
} finally {
  Remove-Item -Recurse -Force $export, $tarball -ErrorAction SilentlyContinue
}
Assert-Step 'validate live copy' { & $cli plugin validate $Live }
Write-Host "Live copy refreshed: $Live (new sessions load it). Roll back with: tools\refresh-live.ps1 -Rollback"
