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
                      └─ codex mcp-server (real Codex CLI)
                           └─ ~/.claude/state/codex-bridge/my-conv.json  ← thread_id on disk
```

## Prerequisites

| Tool | Minimum version | Notes |
|---|---|---|
| Node.js | v20 | `node --version` |
| Claude Code CLI | current | `claude --version`, must be authenticated |
| OpenAI Codex CLI | v0.133+ | `codex --version`, must be authenticated |
| PowerShell | 7 (pwsh) | for install script |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `=1` | set in your environment |

## Install

```powershell
git clone https://github.com/JOhugo6/cc-codex-bridge
cd cc-codex-bridge
.\install.ps1
```

Then **restart Claude Code** (agent definitions are cached at session start).

The installer:
1. Copies `bridge/` → `~/.claude/bridges/codex-bridge/`
2. Runs `npm install`
3. Substitutes your actual path into `agent/codex-peer.md.template` → `~/.claude/agents/codex-peer.md`
4. Registers the MCP server at user scope (`claude mcp add --scope user codex_bridge`)

Re-run `.\install.ps1` after pulling updates — it is idempotent.

## Usage

Every message to `codex-peer` **must** start with a `CONV_ID:` line:

```
CONV_ID: my-project--review-01
Please review the following diff and point out any bugs…
<diff here>
```

The `CONV_ID` is your stable key for the whole conversation — pick it once and reuse it on every message. The bridge keeps Codex's thread alive on disk under that key, so each fresh `codex-peer` spawn picks up right where the last one left off.

### In a Claude Code team

```python
# Example: orchestrator sends a message to codex-peer
SendMessage(to="codex-peer", message="""
CONV_ID: sprint42--arch-review
We're designing a new caching layer. What are the trade-offs between
write-through and write-back strategies for our use case?
""")
```

Then later, in a fresh spawn:

```python
SendMessage(to="codex-peer", message="""
CONV_ID: sprint42--arch-review
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

- **Thread continuity on disk, not in the LLM.** The relay agent holds no state. The bridge persists `thread_id` to `~/.claude/state/codex-bridge/<conv_id>.json` so it survives agent re-instantiation and context compaction.
- **Hard-error on lost session.** A failed resume throws loudly — never silently starts a fresh session (which would be invisible amnesia).
- **`model: sonnet` for the relay.** Haiku was unreliable about calling the tool vs. improvising its own answer. Sonnet follows the tool-call instruction reliably.
- **`CONV_ID:` is operator-supplied.** The relay never derives the key — an LLM-guessed key would be non-deterministic and break cross-spawn continuity.
- **v1 limitation:** one shared `codex mcp-server` process backs all conversations (thread-level isolation, not process-level). Read-only sandbox by default. Do not widen the sandbox without adding per-conversation process isolation.

## Updating

```powershell
git pull
.\install.ps1   # idempotent, safe to re-run
# restart Claude Code
```

## Docs

- `docs/design.en.md` — full architecture, design decisions, Windows gotchas
- `docs/runbook.en.md` — operator runbook, acceptance test procedure, troubleshooting

## License

MIT
