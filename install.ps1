#requires -Version 5.1
<#
.SYNOPSIS
  Install cc-codex-bridge: makes OpenAI Codex CLI an addressable member of a Claude Code team.

.DESCRIPTION
  One-shot install on any Windows machine that has Node, Claude Code CLI, and Codex CLI.
  Idempotent — safe to re-run after updates.

  What it does:
    1. Copies bridge/ -> ~/.claude/bridges/codex-bridge/
    2. npm install (inside the bridge dir)
    3. Substitutes {{BRIDGE_DIR}} in agent/codex-peer.md.template
       -> ~/.claude/agents/codex-peer.md
    4. Registers the MCP server at user scope via register.ps1
       (claude mcp add --scope user codex_bridge)
    5. Verifies the registration shows "Connected"

.PARAMETER Force
  Overwrite existing files without prompting.

.EXAMPLE
  # Basic install
  .\install.ps1

  # Force-overwrite existing installation
  .\install.ps1 -Force
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$repoRoot   = $PSScriptRoot
$bridgeSrc  = Join-Path $repoRoot 'bridge'
$agentTpl   = Join-Path $repoRoot 'agent\codex-peer.md.template'

# Destinations (always under the current user's ~/.claude)
$home_      = $env:USERPROFILE ?? $env:HOME ?? (Resolve-Path '~').Path
$bridgeDst  = Join-Path $home_ '.claude\bridges\codex-bridge'
$agentsDir  = Join-Path $home_ '.claude\agents'
$agentDst   = Join-Path $agentsDir 'codex-peer.md'

Write-Host ""
Write-Host "=== cc-codex-bridge installer ===" -ForegroundColor Cyan
Write-Host "Repo    : $repoRoot"
Write-Host "Bridge  : $bridgeSrc  ->  $bridgeDst"
Write-Host "Agent   : $agentTpl  ->  $agentDst"
Write-Host ""

# ── prerequisite checks ──────────────────────────────────────────────────────
function Require($cmd, $label) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$label ('$cmd') not found on PATH. Please install it first."
  }
  Write-Host "  [ok] $label found: $((Get-Command $cmd).Source)"
}

Write-Host "Checking prerequisites..."
Require 'node'   'Node.js'
Require 'claude' 'Claude Code CLI'
Require 'codex'  'OpenAI Codex CLI'
Write-Host ""

# ── step 1: copy bridge source ───────────────────────────────────────────────
Write-Host "Step 1/4  Copying bridge source to $bridgeDst ..."
if ($PSCmdlet.ShouldProcess($bridgeDst, 'Copy bridge source')) {
  New-Item -ItemType Directory -Force -Path $bridgeDst | Out-Null
  # Robocopy: /E = all subdirs, /XD = skip node_modules, /NFL /NDL = quiet
  $rc = robocopy $bridgeSrc $bridgeDst /E /XD node_modules /NFL /NDL /NJH /NJS
  # Robocopy exit codes 0-7 are success (bitmask of actions taken)
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  Write-Host "  copied."
}

# ── step 2: npm ci (or npm install fallback) ─────────────────────────────────
Write-Host ""
Write-Host "Step 2/4  Installing npm dependencies in $bridgeDst ..."
if ($PSCmdlet.ShouldProcess($bridgeDst, 'npm ci')) {
  Push-Location $bridgeDst
  try {
    # Use `npm ci` when a lockfile is present for a faster, fully reproducible install.
    # Fall back to `npm install` only when no lockfile exists (e.g. first run from source
    # without a committed lockfile).
    if (Test-Path -LiteralPath (Join-Path $bridgeDst 'package-lock.json')) {
      Write-Host "  lockfile found — using npm ci (reproducible install)"
      npm ci 2>&1 | Where-Object { $_ -notmatch '^npm warn' } | Write-Host
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    } else {
      Write-Host "  no lockfile — using npm install"
      npm install --prefer-offline 2>&1 | Where-Object { $_ -notmatch '^npm warn' } | Write-Host
      if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
  } finally {
    Pop-Location
  }
  Write-Host "  npm install done."
}

# ── step 3: generate codex-peer.md from template ─────────────────────────────
Write-Host ""
Write-Host "Step 3/4  Generating codex-peer.md ..."
if ($PSCmdlet.ShouldProcess($agentDst, 'Write codex-peer.md')) {
  New-Item -ItemType Directory -Force -Path $agentsDir | Out-Null

  # Resolve node.exe absolute path (needed for spaces-in-path safety in the YAML args).
  $nodeExe     = (Get-Command node -ErrorAction Stop).Source
  # Forward slashes for both substitutions (YAML requirement; backslashes cause silent parse failures).
  $bridgeDirFwd = $bridgeDst.Replace('\', '/')
  $nodeExeFwd   = $nodeExe.Replace('\', '/')
  $tpl = Get-Content $agentTpl -Raw -Encoding UTF8
  $out = $tpl.Replace('{{BRIDGE_DIR}}', $bridgeDirFwd).Replace('{{NODE_EXE}}', $nodeExeFwd)

  # Write UTF-8 without BOM (PowerShell default in pwsh 7).
  [System.IO.File]::WriteAllText($agentDst, $out, [System.Text.UTF8Encoding]::new($false))
  Write-Host "  written: $agentDst"
  Write-Host "  bridge path in agent: $bridgeDirFwd"
}

# ── step 4: register MCP server ───────────────────────────────────────────────
Write-Host ""
Write-Host "Step 4/4  Registering MCP server (user scope) ..."
if ($PSCmdlet.ShouldProcess('codex_bridge', 'claude mcp add --scope user')) {
  $registerPs1 = Join-Path $bridgeDst 'register.ps1'
  & pwsh -NoProfile -ExecutionPolicy Bypass -File $registerPs1
  if ($LASTEXITCODE -ne 0) { throw "register.ps1 failed (exit $LASTEXITCODE)" }
}

# ── done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart Claude Code so the new agent definition is loaded."
Write-Host "     (Agent definitions are cached at session start — a restart is required.)"
Write-Host "  2. Ensure CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 is set in your environment."
Write-Host "  3. Verify the bridge is connected:"
Write-Host "     claude mcp list"
Write-Host "  4. Run tests (optional):"
Write-Host "     npm --prefix `"$bridgeDst`" test"
Write-Host "     # live smoke (requires authenticated Codex):"
Write-Host "     `$env:CODEX_BRIDGE_LIVE=1; npm --prefix `"$bridgeDst`" run smoke"
Write-Host ""
Write-Host "Usage in a team (send a message to codex-peer):"
Write-Host "  CONV_ID: my-project--review-01"
Write-Host "  <your message to Codex here>"
Write-Host ""
Write-Host "See docs\runbook.md for full usage and the acceptance test procedure."
