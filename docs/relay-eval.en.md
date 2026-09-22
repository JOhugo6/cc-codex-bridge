# Relay acceptance evaluation

[Česky](relay-eval.md) | **English**

Run these commands from a source checkout after `npm --prefix bridge ci`.
The relay evaluator also reads `agent/codex-peer.md.template`, so the installed
bridge directory alone is insufficient.

| Command | Actual components | What it checks |
|---|---|---|
| `npm --prefix bridge test` | Node, MCP, deterministic backend/JSONL fixtures | Bridge contracts, recovery, resources, process cleanup and the eval observer/scorer; no Claude or Codex model call |
| `npm --prefix bridge run smoke` with `CODEX_BRIDGE_LIVE=1` | Bridge + authenticated Codex App Server | Two separate processes, saved thread and random-token recall; no Claude |
| `npm --prefix bridge run eval:relay -- --stub` | Authenticated Claude + real MCP bridge + deterministic Codex substitute | Actual relay behavior for exact diff, injected instructions, errors, missing tool and fresh-instance follow-up |
| `npm --prefix bridge run eval:relay -- --live-codex` | Authenticated Claude + bridge + authenticated Codex | Two fresh Claude/bridge processes sharing only bridge state; same thread, turns 1/2 and random-token recall |

The optional evaluations consume the existing accounts' model quota. The stub
suite has eight fresh Claude invocations and the live Codex suite has two.
Each Claude invocation has a USD 1 CLI budget limit and a 120-second wall-clock
limit (180 seconds with real Codex); the Claude budget does not cap Codex usage.
Only the single MCP tool is allowed and built-in tools are disabled. Only
`--live-codex` starts a real Codex, and it runs with the `danger-full-access`
sandbox against the user's real MCP servers, whose calls are thereby
auto-approved; `--stub` starts no Codex at all. An infrastructure/API failure stops the
suite and labels later cases `skipped`; a behavioral mismatch remains a real
failure and the other independent cases still run.

The harness renders the current template using the installer's helpers. It
supplies the resulting prompt, description and model as an ephemeral `--agents`
definition selected by `--agent`, with explicit `--mcp-config` and
`--strict-mcp-config`. It disables settings sources, hooks, skills, auto-memory
and session persistence, uses an empty temporary project, and creates private
MCP config/state files. It does not register/install anything or copy credentials;
normal CLI authentication remains available. Set `CLAUDE_BIN` to an absolute
native executable path if Claude is not in its default Windows location or on
POSIX PATH. Authentication status alone does not establish that a model request
will succeed: an expired token can still fail with API 401.

This tests a main `--agent` print session with explicit MCP configuration. It
does not exercise installed frontmatter discovery, ordinary nested subagents,
interactive in-process/split-pane teammates, SendMessage delivery/shutdown, or
context compaction. See [mode-specific checks](claude-modes.en.md). Starting a
fresh process is used for the automated memory test: compaction can retain a
token in its summary and is not evidence that the relay has forgotten it.

## Evidence and interpretation

Each run prints its unique temporary directory and ends with the location of
`report.json`, returning exit code 0 only if every required check passes.
Per-case `result.json`, MCP `audit.jsonl`, input fixtures and isolated state stay
there for inspection; remove that generated directory when finished. Reports
contain synthetic prompts/model replies, tool results and process IDs, not
copied authentication files. An API error is recorded as failure, not a skipped
success.

Example console shape (illustrative, not a claimed run):

```text
Evaluation artefacts: <temporary directory>
exact-diff: FAIL {"claude_completed":true,...,"exact_reply":false,"artifact_exact":true,...}
Report: <temporary directory>/report.json
```

The proxy records actual MCP `tools/call` requests/results without choosing or
rewriting them. The scorer checks one unchanged `{envelope}` call, no other
Claude tool uses, exact UTF-8 equality of final reply and tool reply/error, and
process cleanup. Missing-tool behavior requires zero tool uses and the fixed
`TOOL_UNAVAILABLE` line. The malformed-input case must reach bridge validation
unchanged. The diff includes CRLF, combining Unicode, trailing spaces/tabs and
final blank lines; neither strings nor newlines are normalized for scoring.

The evaluator separately reconnects as an MCP client and reads every successful
`reply_artifact.uri`. It compares the decoded bytes with `reply`, SHA-256 and
byte length. Thus `exact_reply: false, artifact_exact: true` means Claude changed
its prose while the bridge resource remained exact. It is still a failed relay
fidelity case. For integrity-critical output use the [resource contract](runbook.en.md#exact-reply-bytes-and-mcp-resources).

Continuity checks actual tool-result `thread_id`, turns, a random token absent
from the second request, distinct Claude session IDs and distinct bridge PIDs.
A wrong recall alone does not identify a bridge bug: inspect the envelope,
thread identity, backend result and relay output to locate the failing layer.
The deterministic suite also feeds intentionally corrupted observations to the
scorer to verify that changed input, extra calls and whitespace loss fail.

## Verified scope for this change

The deterministic suite passes on Windows with Node 24.12.0. The separate real
Codex 0.153.4 smoke passed with thread/token continuity and process cleanup.
The actual Claude 2.1.126 relay evaluation was attempted, but its API rejected
the expired OAuth token (401) before a model turn. That run establishes no
Claude behavior or complete Claude-to-Codex continuity; rerun after normal
Claude authentication is restored. Interactive teammate modes were not run.
The template's `sonnet` choice is a default, not a reliability guarantee; rerun
the evaluation when changing the template, model or CLI version.
