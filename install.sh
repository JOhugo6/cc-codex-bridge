#!/bin/sh
# Linux installation/update. Requires POSIX sh, native Node >=20, npm, Claude and Codex.
set -eu

registration_config_dir=${CLAUDE_CONFIG_DIR:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --claude-config-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo 'Missing --claude-config-dir value' >&2; exit 1; }
      registration_config_dir=$2; shift 2 ;;
    --help|-h)
      echo 'Usage: sh install.sh [--claude-config-dir DIRECTORY]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

script_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
node_exe=$(command -v node) || { echo 'Native Node.js >=20 is required.' >&2; exit 1; }
npm_exe=$(command -v npm) || { echo 'npm is required.' >&2; exit 1; }
claude_exe=$(command -v claude) || { echo 'Native Claude CLI is required.' >&2; exit 1; }
command -v codex >/dev/null || { echo 'Native Codex CLI is required.' >&2; exit 1; }
"$node_exe" -e 'if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 20) { console.error("Native Linux Node.js >=20 is required."); process.exit(1); }'
# Make executable paths absolute before changing directory for npm.
node_exe=$("$node_exe" -p 'process.execPath')
claude_exe=$("$node_exe" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$claude_exe")
npm_exe=$("$node_exe" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$npm_exe")
config_dir=$("$node_exe" -e 'const p=require("node:path"); console.log(p.resolve(process.argv[1] || p.join(require("node:os").homedir(), ".claude")))' "$registration_config_dir")
bridge_dst=$config_dir/bridges/codex-bridge
agent_dst=$config_dir/agents/codex-peer.md

echo "Installing bridge into $bridge_dst"
"$node_exe" - "$script_dir/bridge" "$bridge_dst" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [source, destination] = process.argv.slice(2);
// Resolve existing symlink ancestors before checking overlap or writing files.
function canonical(p) {
  if (fs.existsSync(p)) return fs.realpathSync(p);
  return path.join(canonical(path.dirname(p)), path.basename(p));
}
const src = canonical(source), dst = canonical(destination);
const inside = (a, b) => a === b || a.startsWith(b + path.sep);
if (inside(dst, src) || inside(src, dst)) throw new Error('Installation source and destination must not overlap.');
// Copy only the source layout, never arbitrary local state, dependency trees or
// symlinks. Updates replace managed files without mirroring/deleting the target.
const roots = fs.readdirSync(src, { withFileTypes: true }).filter(e =>
  (e.isFile() && (/\.(js|ps1)$/.test(e.name) || ['package.json', 'package-lock.json'].includes(e.name))) ||
  (e.isDirectory() && ['lib', 'test'].includes(e.name)));
function copy(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`Refusing source symlink: ${from}`);
  if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) throw new Error(`Refusing destination symlink: ${to}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (entry === 'node_modules' || entry === 'state' || entry === '.state') continue;
      copy(path.join(from, entry), path.join(to, entry));
    }
  } else if (stat.isFile()) fs.copyFileSync(from, to);
}
fs.mkdirSync(dst, { recursive: true });
for (const entry of roots) copy(path.join(src, entry.name), path.join(dst, entry.name));
NODE
(cd "$bridge_dst" && "$npm_exe" ci --no-audit --no-fund)
mkdir -p "$config_dir/agents"
if [ -n "$registration_config_dir" ]; then
  "$node_exe" "$bridge_dst/claude-config.js" render "$script_dir/agent/codex-peer.md.template" "$bridge_dst" "$agent_dst" "$config_dir/state/codex-bridge"
  "$node_exe" "$bridge_dst/claude-config.js" register "$claude_exe" "$bridge_dst" "$config_dir"
else
  "$node_exe" "$bridge_dst/claude-config.js" render "$script_dir/agent/codex-peer.md.template" "$bridge_dst" "$agent_dst"
  "$node_exe" "$bridge_dst/claude-config.js" register "$claude_exe" "$bridge_dst"
fi
echo 'Installation complete. MCP connected and codex_turn discovered; backend/login not checked.'
echo 'Restart Claude Code to load the updated agent. Ordinary subagents do not require Agent Teams.'
if [ -n "$registration_config_dir" ]; then
  printf 'Use this configuration when starting Claude: CLAUDE_CONFIG_DIR=%s\n' "$config_dir"
fi
printf 'Doctor: node "%s/doctor.js"\n' "$bridge_dst"
