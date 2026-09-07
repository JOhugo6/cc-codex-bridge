#requires -Version 5.1
<#
.SYNOPSIS
  Idempotently register codex_bridge at Claude user scope and check the actual MCP connection.
.DESCRIPTION
  Requires native node.exe and claude.exe on Windows. Paths and JSON are passed as
  arguments without cmd.exe. Does not change tool permissions or enable Agent Teams.
.PARAMETER ClaudeConfigDir
  Optional isolated Claude config directory; defaults to CLAUDE_CONFIG_DIR or normal user config.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([string] $ClaudeConfigDir = $env:CLAUDE_CONFIG_DIR)

$ErrorActionPreference = 'Stop'
$nodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$claudeExe = (Get-Command claude.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'index.js') -PathType Leaf)) {
  throw 'Bridge index.js is missing.'
}
if ($PSCmdlet.ShouldProcess('codex_bridge', 'Register at Claude user scope and connect/list tools')) {
  $registerArgs = @((Join-Path $PSScriptRoot 'claude-config.js'), 'register', $claudeExe, $PSScriptRoot)
  if ($ClaudeConfigDir) { $registerArgs += [System.IO.Path]::GetFullPath($ClaudeConfigDir) }
  & $nodeExe @registerArgs
  if ($LASTEXITCODE -ne 0) { throw "Registration/connection check failed (exit $LASTEXITCODE)." }
}
