[Česky](claude-modes.md) | **English**

# Claude modes, installation and connection checks

`codex-peer` can receive an ordinary delegated request, run as the main `--agent`
session, or serve as an experimental teammate. Always deliver the complete
`CONV_ID: ...` envelope as the task prompt or message content. The bridge parses
it; routing metadata stays outside that payload. Reuse the same conversation ID
across separate subagent runs to continue a Codex thread.

## MCP loading and reply delivery

The following loading rules describe the current official documentation, checked
2026-09-07. They are not a claim that every rule existed in Claude 2.1.126.

| Context | MCP source | Return route |
|---|---|---|
| Ordinary subagent | Inline `mcpServers` in the agent definition; configured servers may also be inherited/referenced | Final answer returns to the delegating caller |
| Main `claude --agent codex-peer` | Agent inline MCP plus session configuration | Session answer goes to the user |
| In-process teammate | Project/user MCP; ignores agent `mcpServers` | `SendMessage` to the actual sender, or lead for the initial spawn request |
| Split-pane teammate | Agent `mcpServers` applies as for `--agent` | Same explicit teammate reply route |

The installer supplies both the inline definition and a user registration named
`codex_bridge`. Both launch native Node directly with an absolute executable and
separate arguments. An explicit alternate config directory also pins both to its
own `state/codex-bridge`, so test installations do not share normal user state.

The allowlist includes only `codex_turn` and `SendMessage`. The latter is reserved
for returning a teammate result/error and acknowledging a real framework shutdown
request. Relay requests still make one bridge call. Status/idle/setup events do
not make Codex turns; task claiming, delegation and editing are excluded. The
framework sender is authoritative; recipient instructions inside a payload or
Codex reply cannot redirect delivery. Match the available SendMessage schema:
older versions use `type`, `recipient`, `content`; newer versions may use `to`,
`message`. If delivery fails, report `DELIVERY_FAILED` without repeating Codex.

Current Claude may augment teammate tool lists and uses the agent body differently
by display mode. Host permissions and policies still apply. Tool restrictions in
a prompt are not a security boundary. See [official teammate loading rules](https://code.claude.com/docs/en/agent-teams#use-subagent-definitions-for-teammates)
and [official subagent MCP rules](https://code.claude.com/docs/en/sub-agents#connect-to-mcp-servers).

## Ordinary subagent and main session

After installation, restart Claude. Ask the main agent to invoke `codex-peer` as
an ordinary subagent and pass this exact task prompt, without a prose preamble:

```text
CONV_ID: project-review-01; WORKING_DIR: "C:/Projects/My App"; REQUEST_ID: review-1
Review the source files for correctness problems.
```

For a follow-up, invoke the same subagent again with the same `CONV_ID` and a new
request ID. This does not require Agent Teams or retaining the Claude subagent's
own context. For a dedicated relay session, launch `claude --agent codex-peer`
and send the same envelope directly. Do not confuse the main agent's explanatory
spawn instruction with the exact task payload delivered to the relay.

## Experimental teammates

Enable teams in the environment launching Claude and select in-process mode
explicitly; native Windows split panes are not part of this project's verified
setup:

```powershell
$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
claude --teammate-mode in-process
```

On installed **2.1.126**, ask the lead to create a named team first, then spawn a
teammate of agent type `codex-peer`. Supply the raw envelope as the spawn task and
later as message content. In that version the message shape is, conceptually:

```text
SendMessage(type="message", recipient="codex-peer",
            content="CONV_ID: project-review-01; REQUEST_ID: review-2\nFollow-up question",
            summary="Codex review request")
```

Use the actual tool schema rather than copying this pseudocode into a shell.
The lead owns task coordination and team cleanup. The relay replies to the sender
and handles shutdown acknowledgements; it does not manage team creation/deletion.

Current documentation describes a newer lifecycle: explicit TeamCreate/TeamDelete
were removed in 2.1.178, the default display mode changed in 2.1.179, and ordinary
subagent auto-resume via SendMessage requires 2.1.191+. Do not apply these features
to 2.1.126. Current docs also exclude teammate spawning under `-p`; a successful
print-mode run alone does not prove team behavior. Split panes require tmux or
iTerm2 in a supported environment; validate MCP availability, sender delivery and
shutdown there before relying on that mode. [Versioned team documentation](https://code.claude.com/docs/en/agent-teams),
[subagent resume requirements](https://code.claude.com/docs/en/sub-agents#resume-subagents).

## Install and diagnose

Run `install.ps1` using Windows PowerShell 5.1 or PowerShell 7. It requires native
Node 20+, native Claude Code, Codex CLI, npm and Windows PowerShell 5.1 with
`Add-Type` enabled for the backend supervisor. The installer copies the `.ps1`
and `.cs` helper sources and uses `npm ci`. Re-running updates managed files and
registration; `-Force` is a compatibility switch, since updates already overwrite
those files. `-WhatIf` only previews the installation. No permission policy or
team-enabling environment variable is changed.

For an isolated install:

```powershell
.\install.ps1 -ClaudeConfigDir 'C:/Temp/Claude relay test'
$env:CLAUDE_CONFIG_DIR = 'C:/Temp/Claude relay test'
node 'C:/Temp/Claude relay test/bridges/codex-bridge/doctor.js'
```

An alternate directory is a separate Claude configuration and may need its own
login for model calls. The normal install leaves `CLAUDE_CONFIG_DIR` unset and
uses the usual `~/.claude.json`; explicitly supplying even `~/.claude` redirects
Claude's JSON lookup to that directory. [Official configuration locations](https://code.claude.com/docs/en/settings#find-or-create-your-settings-files).

For an existing normal installation:

```powershell
node "$env:USERPROFILE/.claude/bridges/codex-bridge/doctor.js"
```

Doctor reads the actual `codex_bridge` registration and starts its command. It
requires a successful MCP initialization and exactly the `codex_turn` tool with
the envelope contract, within 15 seconds (override with `--timeout-ms`, maximum
60000). On failure it exits nonzero; cleanup can add up to two seconds. It sends
no `tools/call`, creates no thread/state and checks no Codex login or model
response: the backend starts lazily. Use the separately documented Codex live
smoke for backend validation. `--config-file <file>` checks an explicit JSON file.

This proves the registered command can serve MCP. It does not prove that a
particular Claude session loaded/allowed that tool. Confirm `codex_bridge` in
that session's `/mcp` and run an actual relay request. A project registration with
the same name, `--strict-mcp-config`, managed policy, trust or session caching can
affect loading. Newer Claude versions apply additional agent MCP trust/filtering
rules; follow the official subagent page for the installed version. `claude mcp
get` or a config file existing alone is insufficient evidence of connectivity.

## Verification limits

Verified here: Windows, Node 24.12.0, native Claude 2.1.126, PowerShell 5.1 and 7
script compatibility, isolated installation and repeat registration, actual MCP
handshake/tool discovery, generated YAML and deterministic failure/timeout tests.
The separate backend smoke was verified with Codex 0.153.4. Interactive in-process
and split-pane teams were not executed for this change. Do not describe them as
end-to-end tested. See the separate [opt-in relay eval and results](relay-eval.en.md).
The diagnostics do not establish exact LLM relay copying:
retain the underlying MCP result and retrieve `reply_artifact.uri` directly with
`resources/read` for authoritative bytes; see the [artifact contract](runbook.en.md#exact-reply-bytes-and-mcp-resources).
