[Česky](runbook.md) | **English**

# Operator runbook: `codex-peer` (Codex CLI as a Claude Code team member)

> Companion to the design doc `design.en.md`. This runbook covers how to operate the **membership layer**: the `codex-peer` relay agent (`~/.claude/agents/codex-peer.md`) and the deterministic MCP bridge (`codex-bridge`).
>
> **Tool contract (fixed):** the bridge is registered as MCP server `codex_bridge` and exposes one tool, surfacing to agents as **`mcp__codex_bridge__codex_turn`**, with signature `codex_turn({envelope})` / `codex_turn({conversation_id, message, working_dir?, request_id?}) -> { reply, thread_id, turn, reply_artifact }`.
>
> **Architecture in one line:** another Claude sub-agent → `SendMessage` → `codex-peer` (thin relay) → `codex_turn` MCP call → `codex-bridge` (deterministic, holds `thread_id` on disk) → Codex CLI → reply back up the chain, returned verbatim.
>
> **The load-bearing principle (design doc §2):** the relay holds NO state and adds NOTHING. Identity and session continuity live on the bridge (code + disk), never in the relay LLM's context. Everything below assumes this.

---

## 1. Prerequisites and how to verify them

Run each check before first use. All paths are absolute (Windows user-scope config does not expand `~`/`$HOME`).

| # | Prerequisite | Verify command (PowerShell) | Expected |
|---|---|---|---|
| 1 | Agent Teams enabled | `$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | prints `1` |
| 2 | Codex CLI installed | `(Get-Command codex).Source` | a path ending in `codex.cmd` (e.g. `C:\Users\ai\AppData\Roaming\npm\codex.cmd`) |
| 3 | Codex authenticated | `codex login status` (or run one trivial `codex` turn) | reports a logged-in account, no auth prompt |
| 4 | Node present (bridge runtime) | `node --version` | a version prints (bridge needs it) |
| 5 | Bridge registered | `claude mcp list` | a line `codex_bridge: ... - ✓ Connected` |
| 6 | Relay agent present | `Test-Path C:\Users\ai\.claude\agents\codex-peer.md` | `True` |

Notes:
- **#1** must be set in the environment that launches Claude Code, not just in a shell you opened afterwards. If it prints nothing, the multi-round `SendMessage` conversation will silently degrade to fire-once and the acceptance test cannot pass.
- **#5** — registration is done by `install.ps1` (run it per the project instructions). It performs the equivalent of: `claude mcp add --transport stdio --scope user codex_bridge -- cmd /c node "C:\Users\ai\.claude\bridges\codex-bridge\index.js"`. The server name **must** be `codex_bridge` (underscore), otherwise the tool will not surface as `mcp__codex_bridge__codex_turn` and the relay agent's allowlist will not match. If `claude mcp list` shows the server but **not** `✓ Connected`, the relay will fail at first call — fix the bridge before proceeding (see Troubleshooting).
- After registering or editing the agent file, **restart the Claude Code session** so the new MCP server and agent definition are picked up.

### Identity storage and upgrading the legacy layout

State, transcript and lock filenames share `v2@<sha256 of exact conversation_id>` with `.json`, `.transcript.jsonl` and `.lock` suffixes. The hash uses UTF-8 without case conversion; `Review-A` and `review-a` are independent conversations even on Windows. State and new transcript entries retain the original `conversation_id`; a state mismatch returns `STATE_IDENTITY_MISMATCH` before calling Codex. To print the paths, run from the bridge directory:

```powershell
node -e 'const p=require("./lib/paths"); for (const f of [p.stateFile,p.transcriptFile,p.lockDir]) console.log(f(process.argv[1]))' 'Review-A'
```

Legacy `<conversation_id>.json` files are never migrated implicitly. Calls encountering unmigrated files return `LEGACY_MIGRATION_REQUIRED`; different casing or ambiguous ownership returns `LEGACY_IDENTITY_CONFLICT`. The bridge does not start a fresh thread.

1. Stop old bridge instances and back up the entire state directory. For a custom location, set the same `CODEX_BRIDGE_STATE_DIR` used by the bridge.
2. Verify the exact ID casing against the original filename and orchestrator. The old format did not store the ID and could merge differently cased requests on Windows. Migration explicitly assigns the preserved thread to one exact ID; it cannot split merged history.
3. From the installed bridge directory, run `node migrate-state.js 'Review-A'`. The command does not call Codex, holds both the new and legacy locks, and prints JSON containing the resulting state path.
4. Continue with that exact ID when its working directory is known. Old state without a saved cwd also requires directory verification (see below); filename migration preserves the thread but cannot establish its cwd.

Migration copies the transcript byte for byte. The legacy transcript remains intact; the original state is retained in `original_state` within a migration marker at the old filename. Keep this marker: it prevents an old bridge from resuming a stale copy and lets the new bridge verify completion. Use only the updated bridge after migration.

Repeating a completed migration changes nothing. An interrupted migration can be retried while the original and already written destination data still agree. Conflicting destination state/transcript, missing state or changed archives cause an error and preserve the evidence for recovery. Do not remove state or markers to bypass errors; first establish the correct thread using backups and transcripts. Unrelated conversations are not migrated.

---

### Request redelivery and operation recovery

Direct `codex_turn` callers may pass an optional `request_id` (1–200 letters, digits, `.`, `_`, `-`). Choose a new ID for each intended turn, and reuse it only when redelivering that same request. IDs are case-sensitive and scoped to the exact `conversation_id`. Reusing an ID with a different message, effective canonical `working_dir`, or provider returns `REQUEST_ID_CONFLICT`. Omitting cwd on replay inherits that request's saved directory; an equivalent explicit path also replays. Pre-directory-policy journal records retain their original raw-input comparison, including omitted versus supplied cwd. A completed request returns the original `{reply, thread_id, turn, reply_artifact}`, including whitespace, even after process restart or later turns; replay changes no state and calls no backend. Calls without `request_id` keep the existing interface: each successful call is a new turn, so a response lost after successful completion cannot be deduplicated. Relay callers supply the same optional value as `; REQUEST_ID: <id>` on the first header line, as described below.

The `v2@<sha256>.operations.json` journal is written before the inbound transcript or backend call. Its last operation moves through `pending` → `received` → `completed`. `received` contains the exact response and intended state; `completed` is saved only after state and transcript writes finish. A timeout or transport error may follow a remote side effect, so it leaves the operation `pending`. Subsequent calls fail with `OPERATION_UNCERTAIN` or `OPERATION_INCOMPLETE` before contacting Codex. A different request ID does not bypass this block. Missing/corrupt journals or state that disagrees with the journal also fail closed.

For diagnosis and recovery, stop bridge instances, back up the **entire** state directory, and set the same `CODEX_BRIDGE_STATE_DIR` if using a custom location. Run these commands from the installed bridge directory:

```powershell
node recover-operation.js inspect 'Review-A'
node recover-operation.js finish 'Review-A'
```

`inspect` prints the state, journal and paths, including request input and any recorded response. `finish` acquires the conversation lock and completes only local writes for a `received` operation. It checks the expected previous/next state, does not duplicate existing transcript entries, and returns the original result. Repeating it is safe; it never starts Codex. After `finish`, redeliver the same `request_id` to retrieve that result, or continue with a new request. Without `request_id`, take the result printed by `finish` as the completed turn; resending its message would be another turn. Following a process crash, the existing stale-lock policy can delay recovery for up to 15 minutes; do not remove a live process's lock.

A `pending` operation has **no recorded authoritative response**. `finish` refuses it: the backend may have executed even if no state or output transcript exists. Preserve the journal and backend history for investigation and reconciliation by the operator; this command cannot resolve that uncertainty or safely resend the prompt. There is deliberately no automatic reset/forget option. Do not delete state, change the conversation ID, or restore an older snapshot merely to make the error disappear. For corrupt state or a torn/conflicting transcript, preserve the damaged files and restore only data verified against the recorded operation (or a consistent backup) before running `finish` again. A journal response can support reconstruction of that operation's transcript entry; it cannot reconstruct history predating the journal.

These guarantees cover bridge process crashes and restart while its files are preserved and cooperating processes use the conversation lock. Journal/state writes flush file contents before atomic rename; POSIX also flushes the directory entry. Windows provides no portable directory flush here, so abrupt power loss and filesystem/hardware failure have weaker guarantees. Keep backups. The journal retains all requests and results to support old request IDs; it grows with history and is rewritten per transition. Do not prune it independently of state/transcripts, and do not downgrade to an older bridge that ignores the journal.

### Exact reply bytes and MCP resources

Every successful tool result retains `reply`, `thread_id` and `turn`, and adds `reply_artifact`: `{uri, mimeType, sha256, byte_length, conversation_id, operation_id, turn, request_id}`. `request_id` is `null` when omitted. The text content block still contains the reply; an additional MCP `resource_link` exposes its URI. Metadata comes from bridge code, never from an LLM. The URI binds the exact conversation ID and hashed operation ID; repeated delivery returns the same descriptor and bytes, including after later turns and restarts.

The artifact is exactly `Buffer.from(reply, 'utf8')` for the backend reply string. CRLF/LF, trailing whitespace, Unicode normalization and final newlines are unchanged; no BOM is added. This does not promise upstream transport bytes or bytes in the relay's generated prose. Node's UTF-8 encoding replaces any unpaired UTF-16 surrogate with U+FFFD. Clients needing exact diffs/code must consume the resource or direct tool result in code, rather than copy an LLM response.

Use a connected MCP client and the existing successful `toolResult`:

```javascript
const { createHash } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const a = toolResult.structuredContent.reply_artifact;
const resource = await client.readResource({ uri: a.uri });
const bytes = Buffer.from(resource.contents[0].blob, 'base64');
if (bytes.length !== a.byte_length || createHash('sha256').update(bytes).digest('hex') !== a.sha256) {
  throw new Error('Reply integrity check failed');
}
await writeFile('codex-reply.txt', bytes); // Buffer write preserves every byte
```

`resources/read` returns one base64 blob with MIME type `text/plain; charset=utf-8`; it performs no model call and verifies the persisted bytes against journal metadata before returning them. `resources/templates/list` advertises `codex-bridge://reply/c-{conversation_id}/{operation_key}`; use the returned URI verbatim. `resources/list` is empty: resources are discovered through tool links, without listing conversation history. Malformed URIs fail with MCP `-32602`; unknown/uncompleted resources fail with `-32002`. The relay's prose-only response does not carry these links; the calling application must retain the underlying MCP tool result or use the bridge directly.

Files live at `<stateDir>/v2@<sha256(conversation_id)>.replies/<sha256(operation_id)>.utf8`. Publication uses a flushed temporary file and a no-replace hard link (NTFS/POSIX hard-link support required); conflicting files are never overwritten. The response and descriptor are journaled as `received` before artifact creation. A write/publication failure returns `OPERATION_PERSISTENCE_FAILED`; further turns remain blocked until `recover-operation.js inspect` / `finish` completes local persistence. Recovery never repeats the backend call. A process crash can leave an unreferenced `.tmp.*` file; it is not a readable resource. Windows power-loss limits are the same as the journal's.

Read-time corruption returns `CORRUPT_REPLY_ARTIFACT` (MCP internal error) and preserves the file; restore a verified copy before replay/recovery. A missing file returns `REPLY_ARTIFACT_MISSING`; replaying its completed `request_id`, or `finish` for the latest operation, recreates the same bytes from the journal. Old completed journal records without artifact metadata are upgraded by those same paths; their original reply/thread/turn, transcript and conversation state are preserved. Without a saved journal response, no historical artifact is invented. A SHA-256 check detects mismatches, not malicious changes to both the journal and artifact by a local account.

### Working directory and legacy threads

`codex_turn` accepts an optional `working_dir`. It must identify an existing directory (1–500 characters); a file, missing path, empty/null value or Windows drive-relative path such as `C:project` returns `INVALID_WORKING_DIR`. Paths are resolved relative to the bridge process's launch directory, then canonicalized using the filesystem: directory links/junctions, slash variants and Windows filesystem casing resolve to the actual target. No shell, environment variable or `~` expansion takes place.

On a new conversation, an omitted path defaults explicitly to the captured launch directory. The canonical path is sent as Codex's cwd and persisted in the operation journal and state as `working_dir`. Later turns inherit that path even after restart from another directory; a supplied path must resolve to the same directory or `WORKING_DIR_MISMATCH` is returned before a backend call. If the saved directory disappears, restore it before continuing. A completed `request_id` can still be replayed with cwd omitted without accessing project files.

For relay messages, append `; WORKING_DIR: <JSON-string>` to the first line:

```text
CONV_ID: project-review; WORKING_DIR: "C:/Projects/My App"
Review this project's source files.
```

The header occupies exactly one physical line (LF or CRLF). Its optional suffix follows the ID, JSON quotes are mandatory, and unknown/duplicate suffixes are errors. Use `/` or escape backslashes as `\\` inside the JSON string. Everything following that line's terminator remains body text, including `WORKING_DIR:` or `CONV_ID:` lines. A plain `CONV_ID: project-review` header remains valid; no body lines are interpreted as metadata. The relay passes the complete envelope unchanged; bridge code decodes and forwards `working_dir` only when supplied.

For legacy state without a saved cwd, the backend reads the existing thread with `thread/read`, validates its ID and absolute directory, then binds that directory through the next normal durable resumed turn. Supplying a different path fails; no thread is created and old journal entries remain unchanged. Resolve incomplete operations before attempting continuation. `WORKING_DIR_UNKNOWN` means authoritative cwd metadata is missing; `INVALID_WORKING_DIR` means its directory is unavailable. Restore the original project or a consistent backup; never hand-edit the journal to invent cwd. Existing supported Codex threads keep their original IDs and history across this backend migration.

## 2. Using `codex-peer` in a team

### What it is
`codex-peer` is an addressable, reactive member. Other sub-agents talk to it with `SendMessage`; it relays each message to Codex via the bridge and returns Codex's reply verbatim. It never reasons, never edits, never initiates.

### The `CONV_ID:` convention (REQUIRED — you supply the continuity key)
The on-disk continuity key (`conversation_id`) must be **byte-identical** across the whole conversation, including after the relay agent is re-instantiated with empty context. The relay does NOT derive or guess this key — **the addressing agent supplies it explicitly** as the first line of every message:

```
CONV_ID: <stable-id>
<the actual message to Codex>
```

The relay passes the entire incoming text unchanged as the single `envelope` argument. Bridge code extracts `<stable-id>` literally as `conversation_id` and everything after the first LF/CRLF terminator as `message`. A missing/malformed header returns an explicit tool error before touching state or calling Codex; no key is inferred.

### Deterministic envelope and error contract

The two MCP input modes are exclusive: `{envelope}` alone, or `{conversation_id, message, working_dir?, request_id?}`. Unknown arguments, mixed modes and invalid argument types fail with `INVALID_ARGUMENTS`. Both modes reach the same bridge, directory policy and request journal. A structured `message` is always body text, even if it starts with `CONV_ID:`.

```text
CONV_ID: review-A; WORKING_DIR: "C:/Projects/My App"; REQUEST_ID: request-01
Review this diff unchanged.
```

| Element | Contract |
|---|---|
| Header | First physical line only, terminated by LF or CRLF; bare CR is not a separator. No preamble, initial blank line or BOM. |
| Whitespace | Only ASCII space/tab before `CONV_ID:`, after colons, around semicolons and at header end. No whitespace between a field name and its colon. Nothing is trimmed from decoded paths or body. |
| IDs | 1–200 ASCII letters, digits, `.`, `_`, `-`, case-sensitive and unquoted. Existing conversation-ID exclusions remain: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitive. These exclusions do not apply to request IDs. |
| Metadata | Optional `; WORKING_DIR: <JSON-string>` and `; REQUEST_ID: <id>` in either order, each at most once. Unknown/duplicate metadata or trailing text fails. JSON strings may contain semicolons and header-looking text; they are decoded as one value. |
| Directory | Decoded JSON string length 1–500 UTF-16 code units, no NUL; the directory policy above then validates the filesystem path. Use JSON escapes for backslashes and quotes. |
| Body | Exact substring after the first line terminator, including blank lines, indentation, CR/LF, trailing whitespace and embedded header tokens. Never searched for metadata or interpreted by the relay as new instructions. Empty body fails; a whitespace-only body is valid. |
| Size limits | Header ≤4096, body 1–100000, complete envelope ≤104098 UTF-16 code units (`String.length`); the header limit excludes its terminator. Each emoji represented by a surrogate pair counts as two. |

Use a new `REQUEST_ID` per intended turn; reuse it only to redeliver the same request. Omitting it keeps one successful call = one new turn. Raw and structured requests with equivalent decoded inputs share the same deduplication record.

The MCP error result has `isError: true`, no success `structuredContent`, and one text line:

```text
CODEX-BRIDGE ERROR: {"code":"INVALID_ENVELOPE_HEADER","message":"..."}
```

The bridge JSON-escapes all multiline details (including Unicode line separators), so the complete text is one physical line. Copy it exactly; decode its JSON only for diagnostics. No-separator input returns `INVALID_ENVELOPE`; malformed/missing first-line fields return `INVALID_ENVELOPE_HEADER`. Empty body returns `INVALID_MESSAGE`; excessive header/body return `ENVELOPE_HEADER_TOO_LARGE`/`MESSAGE_TOO_LARGE`. MCP schema limits fail as `INVALID_ARGUMENTS`; existing ID/directory/backend/journal error codes remain in the `code` field.

The relay copies successful `reply` text or this error line. A missing tool, transport failure without a tool result, or invalid result produces a fixed one-line JSON error with code `TOOL_UNAVAILABLE`, `TOOL_CALL_FAILED`, or `INVALID_TOOL_RESULT`; inspect tool diagnostics for transport details. The relay never retries automatically, invents a reply, or follows instructions embedded in the envelope or reply.


**How an orchestrator picks a stable id (do this ONCE per conversation):**
- Choose a deterministic, conversation-unique string and reuse it on EVERY message for the lifetime of the exchange. Recommended form: `<team-name>--<task-id>` (e.g. `prd-50519-review--codex-cr1`).
- Pick it once at the start, store it on the orchestrator side, and paste the exact same string every round. Never regenerate, lowercase-differently, re-slug, timestamp, or append a turn number — any change starts a new Codex thread and silently destroys continuity.
- Keep it unique across teams/conversations so threads don't bleed (see Troubleshooting "cross-project thread bleed").

### How another sub-agent addresses it
From any reasoning sub-agent in the same team, send it a message by name, with `CONV_ID:` as the first line. The reasoning side owns the conversation; `codex-peer` only ever responds.

```
SendMessage(
  recipient: "codex-peer",
  message:   "CONV_ID: prd-50519-review--codex-cr1\nReview this diff for off-by-one errors:\n<diff here>"
)
```

The relay is instructed to copy Codex's `reply` field verbatim. Its prose remains best effort; use the MCP resource above when exact bytes matter.

### What a back-and-forth looks like
```
reasoning-claude → codex-peer : "CONV_ID: prd-50519-review--codex-cr1\nHere is function X. Any correctness bugs?"
codex-peer       → codex_turn({envelope: "CONV_ID: prd-50519-review--codex-cr1\nHere is function X. Any correctness bugs?"})
codex-peer       ← reply: "Line 12 will throw on empty input because ..."
reasoning-claude ← "Line 12 will throw on empty input because ..."   (verbatim)

reasoning-claude → codex-peer : "CONV_ID: prd-50519-review--codex-cr1\nGood catch. Show me the fixed version."
codex-peer       → codex_turn({envelope: "CONV_ID: prd-50519-review--codex-cr1\nGood catch. Show me the fixed version."})
codex-peer       ← reply: "<full corrected function>"
reasoning-claude ← "<full corrected function>"                       (verbatim)
```
Because the orchestrator sends the SAME `CONV_ID:` every round, the bridge keeps round 2 on the same Codex thread as round 1 — Codex remembers function X without it being re-sent.

### Reactive-only constraint (enforce on the Claude side)
- Codex (via `codex-peer`) **never initiates** a turn and never sends an unsolicited message. It only answers when addressed.
- The reasoning Claude sub-agent / orchestrator **owns turn-taking**: it decides what to ask, when to ask again, and when to stop. There is no autonomous Codex loop.
- This is what makes termination decidable. Do not try to make Codex a symmetric, self-driving peer (see Limitations).

---

## 3. Termination & safety rules (the human/orchestrator MUST enforce these)

**The relay enforces NOTHING.** It has no Bash, no timers, no counters, no cost awareness — by design (it is a pure pipe). Every guardrail below lives on the reasoning Claude orchestrator and/or the human operator. State these as standing operating rules for any team that brings in `codex-peer`:

1. **Max-turns guillotine (hard stop).** Pick a hard ceiling on round-trips to `codex-peer` per conversation (default **8**). Count every `SendMessage` to `codex-peer`. On reaching the ceiling, STOP addressing it and conclude — even if the exchange feels unfinished. This is a tripwire, not a target.
2. **Cumulative token / cost cap (MANDATORY, not nice-to-have).** Track cumulative tokens/cost spent on the Codex side across the whole conversation and set a hard cap. This is the safety belt against an overnight runaway. If the cap is hit, terminate the exchange immediately. (Per-turn token counts, if surfaced by the bridge transcript, feed this tally; if not surfaced, cap on turn count instead and treat that as the budget.)
3. **Per-call idle timeout.** A single `codex_turn` call can hang (a stuck CLI turn). Enforce a wall-clock timeout per call. The relay cannot do this — the bridge should hard-error on its own idle timeout, and the orchestrator should additionally not wait indefinitely on a `SendMessage` reply. If a call exceeds the timeout, treat it as a failed turn (do not silently retry into a fresh session).
4. **Semantic "are we done / are we looping?" judgment.** After each Codex reply, the reasoning Claude side must judge whether the goal is met or the exchange is going in circles, and stop if so. A `<DONE>` (or similar) marker from Codex is **advisory input only**, never an automatic switch — politeness loops ("Thanks!" / "You're welcome!") otherwise burn the budget.

If none of these are wired up for a given team, do not run an open-ended Codex exchange — run a fixed, small number of turns by hand.

---

## 4. Critical acceptance test (design doc §7) — runnable procedure

**What this test proves or kills:** that `thread_id` continuity is truly held by the bridge on disk, NOT in the relay agent's context. The test forces a **compaction** of the relay agent between rounds and checks that Codex still recalls round-1 context afterward. If it does, the architecture is sound. If it does not, the design is broken (continuity was secretly living in LLM context).

### Setup
1. Confirm all §1 prerequisites pass, especially #1 (`...AGENT_TEAMS=1`) and #5 (`codex_bridge: ✓ Connected`).
2. Start a fresh Claude Code session in a team that includes `codex-peer` and one reasoning sub-agent (the "driver").
3. **Fix the `CONV_ID` for this test, operator-side, and write it down.** Pick a single explicit id and reuse it on EVERY round, e.g. `accept-test--codex-continuity-01`. Because the operator now supplies the key (the relay derives nothing), this id is guaranteed byte-identical across rounds — which is precisely what makes option (c) below a TRUE test of on-disk continuity rather than a test of id re-derivation.
4. Pick a **secret token** that Codex could not guess: a random string, e.g. `ACCEPT-7F3Q-MARMOT`. You will plant it in round 1 and ask for it back in round 3.

### Procedure (3 separate SendMessage round-trips, with forced compaction)

**Round 1 — plant context.** Have the driver send to `codex-peer` (note the required `CONV_ID:` first line, using the id you fixed in Setup step 3):
> "CONV_ID: accept-test--codex-continuity-01
> Remember this for later in our conversation: my acceptance token is
> `ACCEPT-7F3Q-MARMOT`. Just acknowledge that you've noted it."

Confirm the reply comes back verbatim and acknowledges the token. Confirm the relay called `codex_turn` with the complete unchanged `envelope` and the bridge recorded `conversation_id="accept-test--codex-continuity-01"` (visible in the header and in the bridge transcript at `C:\Users\ai\.claude\state\codex-bridge\v2@<sha256>.transcript.jsonl`).

**Round 2 — a normal, unrelated turn.** Send to `codex-peer` (SAME `CONV_ID:`):
> "CONV_ID: accept-test--codex-continuity-01
> Unrelated quick question: what is 17 + 25?"

Confirm a sensible reply (`42`) comes back. This proves the thread is alive and still on the same `conversation_id` as round 1.

**FORCE A COMPACTION of the relay agent between rounds 2 and 3.** This is the crux of the test — you must wipe the relay's in-context memory. Use whichever is available, in this order of preference:
- (a) Trigger Claude Code's compaction on the relay agent's context directly (e.g. the session's `/compact` mechanism applied so the `codex-peer` agent's conversation history is compacted/summarized away). OR
- (b) If you cannot target the relay specifically, drive enough intervening traffic that the relay agent's context is compacted by the harness's automatic compaction (watch for the compaction event in the session). OR
- (c) The strongest variant, now that the key is operator-fixed: end the session entirely and start a brand-new one. Re-instantiate the relay with empty context and send round 3 with the **same explicit `CONV_ID:`** you used in rounds 1–2. Because YOU supply the key (the relay derives nothing), this is a clean test of pure on-disk continuity: a freshly born relay with zero memory of rounds 1–2 still routes to the same Codex thread.

The essential requirement: after this step the relay agent must NOT have rounds 1–2 in its own context. Verify by confirming a compaction/summarization or re-instantiation actually occurred.

**Round 3 — demand the planted context back.** Send to `codex-peer` (SAME `CONV_ID:`):
> "CONV_ID: accept-test--codex-continuity-01
> What was the acceptance token I asked you to remember at the start of our
> conversation? Reply with only the token."

### Pass / fail criterion (unambiguous)
- **PASS** ⟺ ALL of the following hold:
  1. the round-3 reply contains the exact token `ACCEPT-7F3Q-MARMOT`;
  2. a compaction (or relay re-instantiation / fresh session) demonstrably happened before round 3;
  3. the operator sent the **identical** `CONV_ID:` value in all three rounds; and
  4. the bridge transcript shows all three turns logged under that one `conversation_id` with a single stable `thread_id`.
  Codex recalled round-1 context that the freshly-born relay could not have been holding → continuity lives on the bridge keyed by the operator-supplied id. Design validated.
- **FAIL** ⟺ the round-3 reply does not contain the token (Codex says it doesn't know, or guesses wrong) **even though** the same `CONV_ID:` was sent every round and a compaction/re-instantiation occurred. Because the key was operator-fixed and byte-identical, this isolates the failure to the bridge: continuity was lost across compaction → the bridge is NOT holding `thread_id` on disk as required, OR a new session was silently started. This kills the design as built; fix the bridge (see Troubleshooting "silent amnesia") before relying on `codex-peer`.
  - Note: if the round-3 reply is instead `CODEX-BRIDGE ERROR: {"code":"INVALID_ENVELOPE_HEADER",...}`, that is a TEST-HARNESS error, not a design failure — you forgot the `CONV_ID:` first line on round 3. Re-send with it and retry.

### Evidence to capture
- The three relay replies (round 1, 2, 3).
- Proof the compaction/re-instantiation happened (notice or fresh instance).
- The transcript file showing one stable `conversation_id`/`thread_id` across all three turns.

---

## 5. Troubleshooting

| Symptom | Design-doc cause | Fix |
|---|---|---|
| **Silent amnesia** — Codex acts like a stranger on a follow-up; round-3 token recall fails even though replies look healthy | §2 / §4.1.4: `thread_id` was held in LLM context (or relay changed `conversation_id`) and was lost on compaction; or the bridge silently started a NEW session instead of erroring | Confirm the bridge persists `thread_id` to `~/.claude/state/codex-bridge/v2@<sha256>.json` and reuses it; confirm the relay passes a constant `conversation_id` (check `transcript.jsonl` — the id must be identical every turn). Bridge must HARD-ERROR when it cannot restore a session, never open a fresh one. |
| **Stdout pollution** — relay/tool call fails with JSON parse / protocol errors, garbled MCP responses | §6: CLI banners / `Write-Host` / non-protocol chatter leaked onto **stdout**; stdio MCP requires stdout to carry ONLY newline-delimited JSON | All CLI chatter must go to **stderr**; emit UTF-8 **without BOM**, LF line endings. Bridge-side fix. Verify by running the bridge command manually and confirming stdout is pure JSON-RPC. |
| **Windows shim launch failure** — bridge can't start Codex; hang or "process exited" with no reply | §6: `codex` is a `.cmd` shim; bare `CreateProcess` on it fails or hangs | Launch via `cmd /c codex …` or the absolute path to `codex.cmd` (e.g. `C:\Users\ai\AppData\Roaming\npm\codex.cmd`). Bridge-side fix. |
| **Cold-start race** — first turn returns empty / times out / "no session yet", later turns work | §6/§4.1.4: the first call races the spawn of `codex app-server` (and its own downstream MCP servers); a too-eager bridge returns before the first real reply | Bridge must **block until the first real response** and hard-error on timeout — never return a fake / fresh-session placeholder. Bridge-side fix. |
| **Cross-project / cross-thread bleed** — answers from another team/conversation leak in | §4.2/§8.3: two conversations collided on the same `conversation_id`, or shared one `codex app-server` process (in v1 a SINGLE shared process backs all conversations) | Ensure the operator-supplied `CONV_ID:` is unique per team/conversation. Check `transcript.jsonl` for interleaved turns from unrelated topics. |
| **Relay editorializes** — reply is summarized/reformatted, code/diff mangled | §2: the relay LLM changed the output | Read `reply_artifact.uri` directly with MCP `resources/read` and verify its SHA-256/byte length in code. The resource preserves the bridge reply bytes. |
| **Tool not found** — relay errors that `mcp__codex_bridge__codex_turn` is unavailable | §1 prereq #5: bridge not registered, server named wrong, or session not restarted | Run `install.ps1`; confirm `claude mcp list` shows `codex_bridge: ✓ Connected`; restart the Claude Code session. The server name must be exactly `codex_bridge`. |

---

## 6. Honest limitations

- **Addressable member ≠ symmetric peer.** `codex-peer` is "Claude driving a tool that wears a name tag," not an autonomous teammate. Turn-taking, the goal, and termination all live on the Claude side. Codex is reactive-only in v1 — it never initiates, because if it did, no one would own the decision to stop.
- **"Verbatim" is best-effort for the relay.** Its prompt forbids editing, but LLM prose is not byte-guaranteed. The immutable **`reply_artifact` MCP resource** is the authoritative UTF-8 encoding of the bridge reply string; consume and verify it directly in code for diffs, code and structured output.
- **No self-enforced safety.** The relay holds no state and enforces no limits. All termination, cost, timeout, and loop guardrails (§3) are the orchestrator's/human's responsibility.
- **The continuity key is operator-supplied, not relay-derived.** The relay does NOT slugify or guess a `conversation_id` — the addressing agent MUST send `CONV_ID: <stable-id>` as the first line, and bridge code extracts it from the unchanged envelope (see §2). This is deliberate: the disk-state key must be byte-identical across relay re-instantiation, and an LLM is the wrong component to reconstruct it. The cost is a contract obligation on every caller; omitting `CONV_ID:` yields a loud error, never a silent guessed key.
- **v1 isolation is thread-level only — NOT process/sandbox-level.** In this milestone the bridge backs ALL conversations with ONE shared `codex app-server` process; separation between conversations is logical `conversation_id`/`thread_id` keying, not OS-level process isolation. Each new thread has a validated, pinned cwd and the sandbox is **read-only**. Cwd pinning is not a filesystem access boundary. Do NOT widen the sandbox until the bridge provides per-conversation process isolation + a working-directory allow-list.
- **Global scope = isolation duties.** The bridge runs as a persistent MCP daemon across all projects. Continuity is keyed by `conversation_id`, so keep each conversation's `CONV_ID:` distinct to avoid thread bleed, and respect the bridge's read-only sandbox until per-conversation isolation lands.

### App Server backend and verification

The backend uses stdio JSONL with `initialize`/`initialized`, then `thread/start` or `thread/read` + `thread/resume`, and `turn/start`. It serializes whole turns across conversations, checks thread/turn IDs and uses completed final agent messages as exact output. Duplicate completed items and old completed-turn events do not add output; conflicting items or unexpected identities fail. Interim deltas/commentary are excluded. CLI 0.153.4 is the tested protocol baseline, using its generated JSON schemas. The public MCP SDK dependency is still required; downstream MCP client/tool discovery is removed. [Official protocol](https://learn.chatgpt.com/docs/app-server), [old backend deprecation](https://learn.chatgpt.com/docs/mcp-server).

The default initialization limit is 60 seconds and the complete backend operation limit is 10 minutes. Cancellation from the MCP caller reaches the active turn. Timeout/cancel attempts `turn/interrupt` for up to one second, closes the connection and terminates its process tree. Child exit, malformed protocol and failed turns fail explicitly. The next eligible call reconnects, but the durable pending operation still blocks retry of an uncertain conversation; reconnect never creates a replacement thread. Normal bridge shutdown or raw stdin EOF also closes the child; EOF is handled explicitly because the MCP SDK does not emit transport `onclose` for that event. Windows resolves native `codex.exe` (including the npm platform package) and launches it through a hidden job supervisor. Windows PowerShell 5.1 with `Add-Type` enabled is required: the checked-in `.ps1`/`.cs` helper is loaded in memory, with no compiled cache or persistent policy/configuration changes. It places itself in a kill-on-close Job Object before creating Codex; detached descendants inherit ownership. Killing the supervisor or an unexpected Codex exit terminates the owned job even after the original child is gone. No descendant PID scanning or `taskkill` is used. Commands/arguments travel as encoded data; stdout/stderr are copied as bytes. POSIX uses a Node supervisor that keeps the original private process group alive through SIGTERM and SIGKILL escalation; descendants deliberately escaping with `setsid` are outside that boundary. The installer copies these helpers with the rest of `bridge`.

`npm test` includes deterministic real JSONL child transport tests for restart continuity, early/duplicate/late events, errors, cwd migration, timeout/cancel and process cleanup. To run the optional authenticated smoke from `bridge` in PowerShell:

```powershell
$env:CODEX_BRIDGE_LIVE = "1"
npm run smoke
Remove-Item Env:CODEX_BRIDGE_LIVE
```

The live smoke uses existing Codex login, a temporary empty project/state directory, read-only sandbox, two separate bridge/App Server processes and 90-second per-operation limits. It checks remembered random text and the same persisted thread, then verifies native children and supervisors exited and the project stayed empty. It does not change user configuration. Verified on Windows with Node 24.12.0 and Codex 0.153.4; this does not establish Claude relay/Agent Teams behavior or POSIX live compatibility.
