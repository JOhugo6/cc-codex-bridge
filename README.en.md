[Česky](README.md) | **English**

# cc-codex-bridge

Makes **OpenAI Codex CLI** an addressable member of a [Claude Code](https://claude.ai/code) team.

After installation you can send `SendMessage` to a `codex-peer` agent from any Claude Code team conversation and get a real Codex reply back — with full multi-turn memory kept alive across separate agent spawns.

```
Other Claude sub-agent
  └─ SendMessage("CONV_ID: my-conv\nReview this diff…")
       └─ codex-peer (thin relay, model: sonnet)
            └─ codex_turn MCP tool
                 └─ codex-bridge (deterministic Node server)
                      └─ codex app-server (real Codex CLI)
                           └─ ~/.claude/state/codex-bridge/v2@<sha256>.json  ← thread_id on disk
```

## Prerequisites

| Tool | Minimum version | Notes |
|---|---|---|
| Node.js | v20 | `node --version` |
| Claude Code CLI | native 2.1.126 tested | see mode/version limits below; model calls require login |
| OpenAI Codex CLI | v0.153.4 | `codex --version`, must be authenticated |
| PowerShell | Windows 5.1 or 7 | installer; built-in 5.1 + Add-Type for backend |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `=1` | only for experimental teammates; ordinary subagents work without it |

## Install

```powershell
git clone https://github.com/JOhugo6/cc-codex-bridge
cd cc-codex-bridge
.\install.ps1
```

Then **restart Claude Code** (agent definitions are cached at session start).

The installer:
1. Copies `bridge/` → `~/.claude/bridges/codex-bridge/`
2. Runs `npm ci`
3. Substitutes your actual path into `agent/codex-peer.md.template` → `~/.claude/agents/codex-peer.md`
4. Registers the MCP server at user scope (`claude mcp add --scope user codex_bridge`)

Re-run `.\install.ps1` after pulling updates — it is idempotent.

Ordinary subagents return their final answer to the caller; team replies use `SendMessage`. The installer verifies the registered command with a real MCP handshake and tool listing, without calling Codex. See [Claude modes, setup and diagnostics](docs/claude-modes.en.md) for `--agent`, in-process/split-pane loading, version limits and isolated installation.

## Usage

Every message to `codex-peer` **must** start with a `CONV_ID:` line:

```
CONV_ID: my-project--review-01
Please review the following diff and point out any bugs…
<diff here>
```

The `CONV_ID` is your stable key for the whole conversation — pick it once and reuse it on every message. The bridge keeps Codex's thread alive on disk under that key, so each fresh `codex-peer` spawn picks up right where the last one left off.

To review files in a project, add its directory on the **same first line**:

```text
CONV_ID: my-project--review-02; WORKING_DIR: "C:/Projects/My App"
Review the source files in this project.
```

The path is a JSON string; `/` avoids escaping Windows backslashes. Only the first line contains metadata; the body is passed unchanged. The bridge validates the directory and stores its canonical path with the thread. Later messages may omit it; a different directory is rejected. Without an explicit first-turn path, the default is the bridge process's launch directory, captured when the bridge starts. Relative paths resolve against that same directory, so prefer absolute project paths. Old threads without a saved directory are blocked pending verification; see [directory diagnostics](docs/runbook.en.md#working-directory-and-legacy-threads).

The relay forwards the complete message as `codex_turn({envelope: "CONV_ID: ...\n..."})`; bridge code parses the first line. Use LF or CRLF, with no initial blank line, BOM or preamble. Header whitespace is ASCII space/tab only. The nonempty body is preserved exactly, including blank lines and header-looking tokens. Optional `; REQUEST_ID: request-01` on the same first line enables safe redelivery; use a new request ID for each intended turn and the same ID only for retrying that request. Either metadata order is valid; duplicate/unknown metadata is rejected. Direct callers may still use `{conversation_id, message, working_dir?, request_id?}`; mixing modes or adding unknown arguments fails. See the [complete input/error contract](docs/runbook.en.md#deterministic-envelope-and-error-contract) for limits and error formats.

### In a Claude Code team

The examples below are pseudocode. Create/spawn the teammate first, and use the schema supported by your Claude version; see the [versioned teammate procedure](docs/claude-modes.en.md#experimental-teammates).

For exact diffs/code, retain the direct MCP result: `reply_artifact` provides an immutable UTF-8 resource URI, SHA-256, byte length and turn identity. Retrieve it with `resources/read` and verify the decoded bytes in code; the relay's prose is best effort. See [exact reply retrieval](docs/runbook.en.md#exact-reply-bytes-and-mcp-resources).

```python
# Example: orchestrator sends a message to codex-peer
SendMessage(to="codex-peer", message="""CONV_ID: sprint42--arch-review
We're designing a new caching layer. What are the trade-offs between
write-through and write-back strategies for our use case?
""")
```

Then later, in a fresh spawn:

```python
SendMessage(to="codex-peer", message="""CONV_ID: sprint42--arch-review
Given the trade-offs you described, which would you recommend for a
read-heavy workload with occasional burst writes?
""")
```

Codex will remember the earlier context because `CONV_ID` resolves to the same on-disk thread.

## Tests

```powershell
# Unit + integration (no Codex required)
npm --prefix "$env:USERPROFILE\.claude\bridges\codex-bridge" test

# Live smoke (requires authenticated Codex, ~30s)
$env:CODEX_BRIDGE_LIVE = "1"
npm --prefix "$env:USERPROFILE\.claude\bridges\codex-bridge" run smoke
```

## Key design decisions

- **Thread continuity on disk, not in the LLM.** The relay agent holds no state. The bridge persists `thread_id` to `~/.claude/state/codex-bridge/v2@<sha256>.json` so it survives agent re-instantiation and context compaction.
- **Safe request redelivery.** Optional `request_id` in `codex_turn` retrieves an already completed result without another Codex call. A durable journal blocks progress after an ambiguous failure; the [runbook](docs/runbook.en.md#request-redelivery-and-operation-recovery) explains diagnosis and recovery of local writes.
- **Hard-error on lost session.** A failed resume throws loudly — never silently starts a fresh session (which would be invisible amnesia).
- **`model: sonnet` for the relay.** Haiku was unreliable about calling the tool vs. improvising its own answer. Sonnet follows the tool-call instruction reliably.
- **`CONV_ID:` is operator-supplied.** The relay never derives the key — an LLM-guessed key would be non-deterministic and break cross-spawn continuity.
- **v1 limitation:** one shared `codex app-server` process backs all conversations (thread-level isolation, not process-level). Read-only sandbox by default. Do not widen the sandbox without adding per-conversation process isolation.

## Updating

```powershell
git pull
.\install.ps1   # idempotent, safe to re-run
```

Then **restart Claude Code** — the agent definition (`codex-peer`) is cached at session start.
Without a restart the relay agent keeps running the old version regardless of `install.ps1`.

Verify after restart:
```powershell
claude mcp list   # codex_bridge must show ✓ Connected
npm --prefix "$env:USERPROFILE\.claude\bridges\codex-bridge" test
```

## Docs

- `docs/design.en.md` — full architecture, design decisions, Windows gotchas
- `docs/runbook.en.md` — operator runbook, acceptance test procedure, troubleshooting

## License

MIT

The downstream backend uses native App Server JSONL (`initialize`/`initialized`, `thread/start`, `thread/read`, `thread/resume`, `turn/start`). It is tested with Codex CLI 0.153.4; incompatible protocol responses fail explicitly. The MCP SDK remains a dependency for the public bridge interface. See the [backend lifecycle and verification](docs/runbook.en.md#app-server-backend-and-verification).

On Windows the backend also requires built-in Windows PowerShell 5.1 with `Add-Type` enabled for its Job Object supervisor. The installer includes both helper sources; no separate binary or npm dependency is installed.
