#requires -Version 5.1
<#
.SYNOPSIS
  Register (or re-register) the codex-bridge MCP server at USER scope for Claude Code.

.DESCRIPTION
  Idempotent: removes any existing 'codex_bridge' user-scope registration, then adds it fresh.
  The resulting MCP tool surfaces to agents as:  mcp__codex_bridge__codex_turn

  Windows launch detail: Node is invoked via cmd.exe (`cmd /c "<abs node.exe>" "<abs index.js>"`)
  using ABSOLUTE, fully-quoted paths for both executables, so the command survives installation
  directories that contain spaces (e.g. "C:\Program Files\nodejs\node.exe"). The absolute path to
  node.exe is resolved at registration time via (Get-Command node).Source. (The codex CLI shim
  itself is launched by the bridge at runtime, not here.)

.PARAMETER WhatIf
  Show the commands without executing them.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $ServerName = 'codex_bridge'
)

$ErrorActionPreference = 'Stop'

# Absolute path to this bridge's index.js (resolve relative to THIS script's location).
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexJs   = Join-Path $bridgeDir 'index.js'

if (-not (Test-Path -LiteralPath $indexJs)) {
  throw "index.js not found at '$indexJs'. Run register.ps1 from inside the codex-bridge directory."
}

# Resolve the absolute path to node.exe so the command survives paths with spaces
# (e.g. "C:\Program Files\nodejs\node.exe").
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "node.exe was not found on PATH. Install Node.js and ensure 'node' is on PATH."
}
$nodeExe = $nodeCmd.Source

# Verify claude CLI is available.
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  throw "The 'claude' CLI was not found on PATH. Install Claude Code and ensure 'claude' is on PATH."
}

Write-Host "codex-bridge dir : $bridgeDir"
Write-Host "index.js         : $indexJs"
Write-Host "node.exe         : $nodeExe"
Write-Host "server name      : $ServerName"
Write-Host ""

# 1) Remove any existing user-scope registration (idempotency). Ignore failure if not present.
Write-Host "Removing any existing user-scope '$ServerName' registration (ignore errors if absent)..."
if ($PSCmdlet.ShouldProcess($ServerName, "claude mcp remove --scope user")) {
  try { & claude mcp remove --scope user $ServerName 2>&1 | Out-Host } catch { Write-Host "  (none to remove)" }
}

# 2) Add fresh. stdio transport, user scope.
#    Launch node via cmd.exe with ABSOLUTE, fully-quoted paths for both node.exe and index.js,
#    so the command survives installation directories that contain spaces.
#    Everything after `--` is the launch command for the stdio server.
Write-Host ""
Write-Host "Adding user-scope '$ServerName'..."
$addArgs = @(
  'mcp', 'add',
  '--transport', 'stdio',
  '--scope', 'user',
  $ServerName,
  '--',
  'cmd', '/c', $nodeExe, $indexJs
)

if ($PSCmdlet.ShouldProcess($ServerName, "claude mcp add (stdio, user)")) {
  & claude @addArgs
  if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed with exit code $LASTEXITCODE" }
}

Write-Host ""
Write-Host "Done. Verifying registration..."
& claude mcp get $ServerName 2>&1 | Out-Host

Write-Host ""
Write-Host "The tool will surface to agents as:  mcp__${ServerName}__codex_turn"
Write-Host "Exact add line used:"
Write-Host ("  claude mcp add --transport stdio --scope user {0} -- cmd /c ""{1}"" ""{2}""" -f $ServerName, $nodeExe, $indexJs)
