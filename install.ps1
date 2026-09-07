#requires -Version 5.1
<#
.SYNOPSIS
  Install/update the Codex relay and verify its public MCP connection on Windows.
.DESCRIPTION
  Copies bridge source, installs locked npm dependencies, renders the agent, then
  registers user-scope MCP and performs initialize/tools/list (no model call).
  Existing bridge/agent files are updated without prompting. State is not copied.
.PARAMETER ClaudeConfigDir
  Install destination and Claude configuration root. Defaults to CLAUDE_CONFIG_DIR,
  otherwise USERPROFILE/.claude. Use a fresh directory for isolated installation.
.PARAMETER Force
  Compatibility switch; updates already overwrite managed files without prompting.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $ClaudeConfigDir = $env:CLAUDE_CONFIG_DIR,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
# Preserve absence: explicitly setting even the usual ~/.claude directory changes
# Claude's .claude.json lookup. Only redirect configuration when requested.
$registrationConfigDir = $ClaudeConfigDir
if (-not $ClaudeConfigDir) { $ClaudeConfigDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude' }
$ClaudeConfigDir = [System.IO.Path]::GetFullPath($ClaudeConfigDir)
$bridgeSrc = Join-Path $PSScriptRoot 'bridge'
$bridgeDst = Join-Path $ClaudeConfigDir 'bridges\codex-bridge'
$agentsDir = Join-Path $ClaudeConfigDir 'agents'
$agentDst = Join-Path $agentsDir 'codex-peer.md'
$agentTpl = Join-Path $PSScriptRoot 'agent\codex-peer.md.template'

if ($bridgeDst.StartsWith($bridgeSrc + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $bridgeDst.Equals($bridgeSrc, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installation destination must not be inside bridge source.'
}

$nodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$null = Get-Command claude.exe -CommandType Application -ErrorAction Stop
$null = Get-Command codex -ErrorAction Stop
$npmCmd = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$null = Get-Command robocopy.exe -CommandType Application -ErrorAction Stop
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw 'Windows PowerShell 5.1 is required for the backend supervisor.' }
& $nodeExe -e 'if (parseInt(process.versions.node) < 20) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 20 or newer is required.' }

Write-Host "Installing bridge into $bridgeDst"
if ($PSCmdlet.ShouldProcess($bridgeDst, 'Copy bridge source and install npm dependencies')) {
  New-Item -ItemType Directory -Force -Path $bridgeDst | Out-Null
  # /E copies the checked-in .ps1/.cs job helpers too; never mirror/delete destination files.
  & robocopy.exe $bridgeSrc $bridgeDst /E /XD node_modules /NFL /NDL /NJH /NJS | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)." }
  Push-Location -LiteralPath $bridgeDst
  try {
    & $npmCmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)." }
  } finally { Pop-Location }
}

if ($PSCmdlet.ShouldProcess($agentDst, 'Render codex-peer agent')) {
  New-Item -ItemType Directory -Force -Path $agentsDir | Out-Null
  $renderArgs = @((Join-Path $bridgeDst 'claude-config.js'), 'render', $agentTpl, $bridgeDst, $agentDst)
  if ($registrationConfigDir) { $renderArgs += (Join-Path $ClaudeConfigDir 'state\codex-bridge') }
  & $nodeExe @renderArgs
  if ($LASTEXITCODE -ne 0) { throw 'Agent rendering failed.' }
}

if ($PSCmdlet.ShouldProcess('codex_bridge', 'Register MCP and verify initialize/tools/list')) {
  & (Join-Path $bridgeDst 'register.ps1') -ClaudeConfigDir $registrationConfigDir
}

if (-not $WhatIfPreference) {
  Write-Host 'Installation complete. MCP connected and codex_turn discovered; backend/login not checked.'
  Write-Host 'Restart Claude Code to load the updated agent. Ordinary subagents do not require Agent Teams.'
  Write-Host 'For teammate mode, enable Agent Teams in the launching environment; see docs/runbook.md.'
  if ($registrationConfigDir) { Write-Host "Use this configuration when starting Claude: CLAUDE_CONFIG_DIR=$ClaudeConfigDir" }
  Write-Host "Doctor: node `"$bridgeDst\doctor.js`""
}
