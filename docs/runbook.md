# Operator runbook: `codex-peer` (Codex CLI as a Claude Code team member)

> Companion to the design doc `cli-as-team-member.md`. This runbook covers how
> to operate the **membership layer**: the `codex-peer` relay agent
> (`~/.claude/agents/codex-peer.md`) plus the safety rules and the critical
> acceptance test. The deterministic MCP bridge (`codex-bridge`) and its
> `register.ps1` are owned by a separate component; this runbook treats the
> bridge's contract as fixed:
>
> **Tool contract (fixed):** the bridge registers as MCP server `codex_bridge`
> and exposes one tool, surfacing to agents as
> **`mcp__codex_bridge__codex_turn`**, with signature
> `codex_turn(conversation_id, message) -> { reply, thread_id, turn }`.
>
> **Architecture in one line:** another Claude sub-agent → `SendMessage` →
> `codex-peer` (thin relay) → `codex_turn` MCP call → `codex-bridge`
> (deterministic, holds `thread_id` on disk) → Codex CLI → reply back up the
> chain, returned verbatim.
>
> **The load-bearing principle (design doc §2):** the relay holds NO state and
> adds NOTHING. Identity and session continuity live on the bridge (code +
> disk), never in the relay LLM's context. Everything below assumes this.

---

## 1. Prerequisites and how to verify them

Run each check before first use. All paths are absolute (Windows user-scope
config does not expand `~`/`$HOME`).

| # | Prerequisite | Verify command (PowerShell) | Expected |
|---|---|---|---|
| 1 | Agent Teams enabled | `$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | prints `1` |
| 2 | Codex CLI installed | `(Get-Command codex).Source` | a path ending in `codex.cmd` (e.g. `C:\Users\ai\AppData\Roaming\npm\codex.cmd`) |
| 3 | Codex authenticated | `codex login status` (or run one trivial `codex` turn) | reports a logged-in account, no auth prompt |
| 4 | Node present (bridge runtime) | `node --version` | a version prints (bridge needs it) |
| 5 | Bridge registered | `claude mcp list` | a line `codex_bridge: ... - ✓ Connected` |
| 6 | Relay agent present | `Test-Path C:\Users\ai\.claude\agents\codex-peer.md` | `True` |

Notes:
- **#1** must be set in the environment that launches Claude Code, not just in
  a shell you opened afterwards. If it prints nothing, the multi-round
  `SendMessage` conversation will silently degrade to fire-once and the
  acceptance test cannot pass.
- **#5** — registration is done by the bridge component's `register.ps1`
  (run it per that component's instructions). It performs the equivalent of:
  `claude mcp add --transport stdio --scope user codex_bridge -- cmd /c node "C:\Users\ai\.claude\bridges\codex-bridge\index.js"`.
  The server name **must** be `codex_bridge` (underscore), otherwise the tool
  will not surface as `mcp__codex_bridge__codex_turn` and the relay agent's
  allowlist will not match. If `claude mcp list` shows the server but **not**
  `✓ Connected`, the relay will fail at first call — fix the bridge before
  proceeding (see Troubleshooting).
- After registering or editing the agent file, **restart the Claude Code
  session** so the new MCP server and agent definition are picked up.

---

## 2. Using `codex-peer` in a team

### What it is
`codex-peer` is an addressable, reactive member. Other sub-agents talk to it
with `SendMessage`; it relays each message to Codex via the bridge and returns
Codex's reply verbatim. It never reasons, never edits, never initiates.

### The `CONV_ID:` convention (REQUIRED — you supply the continuity key)
The on-disk continuity key (`conversation_id`) must be **byte-identical** across
the whole conversation, including after the relay agent is re-instantiated with
empty context. The relay does NOT derive or guess this key — **the addressing
agent supplies it explicitly** as the first line of every message:

```
CONV_ID: <stable-id>
<the actual message to Codex>
```

The relay extracts the `<stable-id>` literally, passes it as `conversation_id`,
and sends everything after the first line as the `message`. If you omit the
`CONV_ID:` line, the relay returns a loud `CODEX-BRIDGE ERROR: missing required
CONV_ID ...` and does nothing else — it will never invent a key.

**How an orchestrator picks a stable id (do this ONCE per conversation):**
- Choose a deterministic, conversation-unique string and reuse it on EVERY
  message for the lifetime of the exchange. Recommended form:
  `<team-name>--<task-id>` (e.g. `prd-50519-review--codex-cr1`).
- Pick it once at the start, store it on the orchestrator side, and paste the
  exact same string every round. Never regenerate, lowercase-differently,
  re-slug, timestamp, or append a turn number — any change starts a new Codex
  thread and silently destroys continuity.
- Keep it unique across teams/conversations so threads don't bleed (see
  Troubleshooting "cross-project thread bleed").

### How another sub-agent addresses it
From any reasoning sub-agent in the same team, send it a message by name, with
`CONV_ID:` as the first line. The reasoning side owns the conversation;
`codex-peer` only ever responds.

```
SendMessage(
  recipient: "codex-peer",
  message:   "CONV_ID: prd-50519-review--codex-cr1\nReview this diff for off-by-one errors:\n<diff here>"
)
```

The reply you receive back is Codex's `reply` field, verbatim. Treat its
content as Codex's words, not the relay's.

### What a back-and-forth looks like
```
reasoning-claude → codex-peer : "CONV_ID: prd-50519-review--codex-cr1\nHere is function X. Any correctness bugs?"
codex-peer       → (codex_turn conv_id="prd-50519-review--codex-cr1", msg="Here is function X. ...")
codex-peer       ← reply: "Line 12 will throw on empty input because ..."
reasoning-claude ← "Line 12 will throw on empty input because ..."   (verbatim)

reasoning-claude → codex-peer : "CONV_ID: prd-50519-review--codex-cr1\nGood catch. Show me the fixed version."
codex-peer       → (codex_turn SAME conv_id, msg="Good catch. ...")  # same thread on disk
codex-peer       ← reply: "<full corrected function>"
reasoning-claude ← "<full corrected function>"                       (verbatim)
```
Because the orchestrator sends the SAME `CONV_ID:` every round, the bridge keeps
round 2 on the same Codex thread as round 1 — Codex remembers function X without
it being re-sent.

### Reactive-only constraint (enforce on the Claude side)
- Codex (via `codex-peer`) **never initiates** a turn and never sends an
  unsolicited message. It only answers when addressed.
- The reasoning Claude sub-agent / orchestrator **owns turn-taking**: it
  decides what to ask, when to ask again, and when to stop. There is no
  autonomous Codex loop.
- This is what makes termination decidable. Do not try to make Codex a
  symmetric, self-driving peer (see Limitations).

---

## 3. Termination & safety rules (the human/orchestrator MUST enforce these)

**The relay enforces NOTHING.** It has no Bash, no timers, no counters, no cost
awareness — by design (it is a pure pipe). Every guardrail below lives on the
reasoning Claude orchestrator and/or the human operator. State these as
standing operating rules for any team that brings in `codex-peer`:

1. **Max-turns guillotine (hard stop).** Pick a hard ceiling on round-trips to
   `codex-peer` per conversation (default **8**). Count every `SendMessage` to
   `codex-peer`. On reaching the ceiling, STOP addressing it and conclude —
   even if the exchange feels unfinished. This is a tripwire, not a target.
2. **Cumulative token / cost cap (MANDATORY, not nice-to-have).** Track
   cumulative tokens/cost spent on the Codex side across the whole
   conversation and set a hard cap. This is the safety belt against an
   overnight runaway. If the cap is hit, terminate the exchange immediately.
   (Per-turn token counts, if surfaced by the bridge transcript, feed this
   tally; if not surfaced, cap on turn count instead and treat that as the
   budget.)
3. **Per-call idle timeout.** A single `codex_turn` call can hang (a stuck CLI
   turn). Enforce a wall-clock timeout per call. The relay cannot do this — the
   bridge should hard-error on its own idle timeout, and the orchestrator
   should additionally not wait indefinitely on a `SendMessage` reply. If a
   call exceeds the timeout, treat it as a failed turn (do not silently retry
   into a fresh session).
4. **Semantic "are we done / are we looping?" judgment.** After each Codex
   reply, the reasoning Claude side must judge whether the goal is met or the
   exchange is going in circles, and stop if so. A `<DONE>` (or similar) marker
   from Codex is **advisory input only**, never an automatic switch — politeness
   loops ("Thanks!" / "You're welcome!") otherwise burn the budget.

If none of these are wired up for a given team, do not run an open-ended Codex
exchange — run a fixed, small number of turns by hand.

---

## 4. Critical acceptance test (design doc §7) — runnable procedure

**What this test proves or kills:** that `thread_id` continuity is truly held
by the bridge on disk, NOT in the relay agent's context. The test forces a
**compaction** of the relay agent between rounds and checks that Codex still
recalls round-1 context afterward. If it does, the architecture is sound. If it
does not, the design is broken (continuity was secretly living in LLM context).

### Setup
1. Confirm all §1 prerequisites pass, especially #1 (`...AGENT_TEAMS=1`) and #5
   (`codex_bridge: ✓ Connected`).
2. Start a fresh Claude Code session in a team that includes `codex-peer` and
   one reasoning sub-agent (the "driver").
3. **Fix the `CONV_ID` for this test, operator-side, and write it down.** Pick a
   single explicit id and reuse it on EVERY round, e.g.
   `accept-test--codex-continuity-01`. Because the operator now supplies the key
   (the relay no longer derives anything), this id is guaranteed byte-identical
   across rounds — which is precisely what makes option (c) below a TRUE test of
   on-disk continuity rather than a test of id re-derivation.
4. Pick a **secret token** that Codex could not guess: a random string, e.g.
   `ACCEPT-7F3Q-MARMOT`. You will plant it in round 1 and ask for it back in
   round 3.

### Procedure (3 separate SendMessage round-trips, with forced compaction)

**Round 1 — plant context.** Have the driver send to `codex-peer` (note the
required `CONV_ID:` first line, using the id you fixed in Setup step 3):
> "CONV_ID: accept-test--codex-continuity-01
> Remember this for later in our conversation: my acceptance token is
> `ACCEPT-7F3Q-MARMOT`. Just acknowledge that you've noted it."

Confirm the reply comes back verbatim and acknowledges the token. Confirm the
relay called `codex_turn` with `conversation_id="accept-test--codex-continuity-01"`
(visible in the call args, and in the bridge transcript at
`C:\Users\ai\.claude\state\codex-bridge\accept-test--codex-continuity-01.transcript.jsonl`).

**Round 2 — a normal, unrelated turn.** Send to `codex-peer` (SAME `CONV_ID:`):
> "CONV_ID: accept-test--codex-continuity-01
> Unrelated quick question: what is 17 + 25?"

Confirm a sensible reply (`42`) comes back. This proves the thread is alive and
still on the same `conversation_id` as round 1.

**FORCE A COMPACTION of the relay agent between rounds 2 and 3.** This is the
crux of the test — you must wipe the relay's in-context memory. Use whichever is
available, in this order of preference:
- (a) Trigger Claude Code's compaction on the relay agent's context directly
  (e.g. the session's `/compact` mechanism applied so the `codex-peer` agent's
  conversation history is compacted/summarized away). OR
- (b) If you cannot target the relay specifically, drive enough intervening
  traffic that the relay agent's context is compacted by the harness's
  automatic compaction (watch for the compaction event in the session). OR
- (c) The strongest variant, now that the key is operator-fixed: end the
  session entirely and start a brand-new one. Re-instantiate the relay with
  empty context and send round 3 with the **same explicit `CONV_ID:`** you used
  in rounds 1–2. Because YOU supply the key (the relay derives nothing), this is
  a clean test of pure on-disk continuity: a freshly born relay with zero memory
  of rounds 1–2 still routes to the same Codex thread. (This also settles the
  "framework re-instantiates the relay between exchanges" open question from
  design doc §8.1 — with an operator-fixed key it no longer matters whether it
  does.)

The essential requirement: after this step the relay agent must NOT have rounds
1–2 in its own context. Verify by confirming a compaction/summarization or
re-instantiation actually occurred (compaction notice in the session, or a
fresh agent instance / fresh session).

**Round 3 — demand the planted context back.** Send to `codex-peer` (SAME
`CONV_ID:`):
> "CONV_ID: accept-test--codex-continuity-01
> What was the acceptance token I asked you to remember at the start of our
> conversation? Reply with only the token."

### Pass / fail criterion (unambiguous)
- **PASS** ⟺ ALL of the following hold:
  1. the round-3 reply contains the exact token `ACCEPT-7F3Q-MARMOT`;
  2. a compaction (or relay re-instantiation / fresh session) demonstrably
     happened before round 3;
  3. the operator sent the **identical** `CONV_ID:` value in all three rounds
     (so any continuity is on-disk, not in the relay's head); and
  4. the bridge transcript shows all three turns logged under that one
     `conversation_id` with a single stable `thread_id`.
  Codex recalled round-1 context that the freshly-born relay could not have been
  holding → continuity lives on the bridge keyed by the operator-supplied id.
  Design validated.
- **FAIL** ⟺ the round-3 reply does not contain the token (Codex says it
  doesn't know, or guesses wrong) **even though** the same `CONV_ID:` was sent
  every round and a compaction/re-instantiation occurred. Because the key was
  operator-fixed and byte-identical, this isolates the failure to the bridge:
  continuity was lost across compaction → the bridge is NOT holding `thread_id`
  on disk as required, OR a new session was silently started. This kills the
  design as built; fix the bridge (see Troubleshooting "silent amnesia") before
  relying on `codex-peer`.
  - Note: if the round-3 reply is instead `CODEX-BRIDGE ERROR: missing required
    CONV_ID ...`, that is a TEST-HARNESS error, not a design failure — you
    forgot the `CONV_ID:` first line on round 3. Re-send with it and retry.

### Evidence to capture
- The three relay replies (round 1, 2, 3).
- Proof the compaction/re-instantiation happened (notice or fresh instance).
- The transcript file showing one stable `conversation_id`/`thread_id` across
  all three turns.

---

## 5. Troubleshooting

| Symptom | Design-doc cause | Fix |
|---|---|---|
| **Silent amnesia** — Codex acts like a stranger on a follow-up; round-3 token recall fails even though replies look healthy | §2 / §4.1.4: `thread_id` was held in LLM context (or relay changed `conversation_id`) and was lost on compaction; or the bridge silently started a NEW session instead of erroring | Confirm the bridge persists `thread_id` to `~/.claude/state/codex-bridge/<conv>.json` and reuses it; confirm the relay passes a constant `conversation_id` (check `transcript.jsonl` — the id must be identical every turn). Bridge must HARD-ERROR when it cannot restore a session, never open a fresh one. |
| **Stdout pollution** — relay/tool call fails with JSON parse / protocol errors, garbled MCP responses | §6: CLI banners / `Write-Host` / non-protocol chatter leaked onto **stdout**; stdio MCP requires stdout to carry ONLY newline-delimited JSON | All CLI chatter must go to **stderr**; emit UTF-8 **without BOM**, LF line endings. This is a bridge-side fix. Verify by running the bridge command manually and confirming stdout is pure JSON-RPC. |
| **Windows shim launch failure** — bridge can't start Codex; hang or "process exited" with no reply | §6: `codex` is a `.cmd`/`.ps1` shim; bare `CreateProcess` on it fails or hangs | Launch via `cmd /c codex …` or the absolute path to `codex.cmd` (here: `C:\Users\ai\AppData\Roaming\npm\codex.cmd`). Bridge-side fix. |
| **Cold-start race** — first turn returns empty / times out / "no session yet", later turns work | §6/§4.1.4: the first call races the spawn of `codex mcp-server` (and its own downstream MCP servers); a too-eager bridge returns before the first real reply | Bridge must **block until the first real response** and hard-error on timeout — never return a fake / fresh-session placeholder. Re-run the call after confirming the bridge waits. Bridge-side fix. |
| **Cross-project / cross-thread bleed** — answers from another team/conversation leak in | §4.2/§8.3: two conversations collided on the same `conversation_id`, or shared one `codex mcp-server` process (in v1 a SINGLE shared process backs all conversations — see Limitations) | Ensure the operator-supplied `CONV_ID:` is unique per team/conversation (orchestrators must pick distinct ids — reusing the same `CONV_ID:` across unrelated exchanges merges them by design). Prefer the bridge isolating a Codex instance per `conversation_id`. Check `transcript.jsonl` for interleaved turns from unrelated topics. |
| **Relay editorializes** — reply is summarized/reformatted, code/diff mangled | §2: the relay LLM "improved" the output instead of passing it through | This is a relay-prompt failure. The agent prompt forbids it explicitly; if it recurs, the integrity-critical payload is still intact in the **tool result** (`reply` field) / `transcript.jsonl` — pull it from there. Re-derive verbatim from the transcript, and tighten the prompt if persistent. |
| **Tool not found** — relay errors that `mcp__codex_bridge__codex_turn` is unavailable | §1 prereq #5: bridge not registered, server named wrong, or session not restarted | Run the bridge's `register.ps1`; confirm `claude mcp list` shows `codex_bridge: ✓ Connected`; restart the Claude Code session. The server name must be exactly `codex_bridge`. |

---

## 6. Honest limitations

- **Addressable member ≠ symmetric peer.** `codex-peer` is "Claude driving a
  tool that wears a name tag," not an autonomous teammate. Turn-taking, the
  goal, and termination all live on the Claude side. Codex is reactive-only in
  v1 — it never initiates, because if it did, no one would own the decision to
  stop.
- **"Verbatim" is best-effort.** The relay is an LLM; the prompt forbids
  editing, but faithfulness is not byte-guaranteed. For anything
  integrity-critical (diffs, code, structured output), the authoritative copy
  is the **tool result `reply` field** and the bridge `transcript.jsonl`, not
  the relay's prose. When fidelity matters, verify against the transcript.
- **No self-enforced safety.** The relay holds no state and enforces no limits.
  All termination, cost, timeout, and loop guardrails (§3) are the
  orchestrator's/human's responsibility. An unsupervised `codex-peer` exchange
  has no brakes of its own.
- **The continuity key is operator-supplied, not relay-derived.** The relay
  does NOT slugify or guess a `conversation_id` — the addressing agent MUST send
  `CONV_ID: <stable-id>` as the first line, and the relay extracts it verbatim
  (see §2). This is deliberate: the disk-state key must be byte-identical across
  relay re-instantiation, and an LLM is the wrong component to reconstruct it.
  The cost is a contract obligation on every caller; omitting `CONV_ID:` yields
  a loud error, never a silent guessed key.
- **v1 isolation is thread-level only — NOT process/cwd/sandbox-level.** In this
  milestone the bridge backs ALL conversations with ONE shared
  `codex mcp-server` process; separation between conversations is only the
  logical `conversation_id`/`thread_id` keying, not OS-level process isolation.
  Consequently: the Codex working directory (cwd) is **nondeterministic** under
  user-scope launch (it inherits whatever launched the daemon, not your
  project), and the sandbox is **read-only**. Do NOT widen the sandbox or grant
  write/tool access until the bridge provides **per-conversation process
  isolation + a working-directory allow-list**. (The bridge README documents the
  same v1 reality; treat these as the gating requirements before any sandbox
  widening.)
- **Global scope = isolation duties.** The bridge runs as a persistent MCP
  daemon across all projects. Continuity is keyed by `conversation_id`, so keep
  each conversation's `CONV_ID:` distinct to avoid thread bleed, and respect the
  bridge's read-only sandbox until per-conversation isolation lands (design
  doc §6).
- **Scope of this milestone.** Codex only (via native `codex mcp-server`
  backing). Copilot and any initiating/symmetric peer behavior are explicitly
  out of scope until this acceptance test passes.
