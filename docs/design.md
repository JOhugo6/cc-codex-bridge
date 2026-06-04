# Design: externí CLI (Codex / Copilot) jako člen Claude Code týmu

> **Scope:** globální, uživatelská capability v `~/.claude/`. **NEpatří do žádného projektového repa** a **nesouvisí s autopilotem** (z něj jen inspirace — `Invoke-MonitoredProcess` watchdog/idle-timeout, UTF-8 tempfile-stdin, durable log).
> **Status:** validovaný návrh (2 kola peer-review + ověření mechaniky Claude Code přes claude-code-guide, červen 2026). Ještě nepostaveno.

---

## 1. Cíl

Umět zapojit **OpenAI Codex CLI** nebo **GitHub Copilot CLI** jako **adresovatelného člena Claude Code týmu** — tj. pojmenovaného účastníka, kterému ostatní (Claude) sub-agenti pošlou `SendMessage`, dostanou odpověď, pošlou follow-up, a tak dál ve více kolech. Reusable napříč všemi projekty, konfigurované jednou globálně.

## 2. Klíčový poznatek (čti první)

**„Transparentní Claude relay" je vnitřně rozporná konstrukce.** Sub-agent v Claude Code je vždy LLM tah; neexistuje primitiv „přijmi zprávu → zavolej nástroj → vrať výstup doslova → nic nepřidávej". Když relayi řekneš „jen přeposílej":

- **nepředvídatelně edituje** výstup (učeše diff, zkrátí „redundanci", přidá „Codex říká:") — korupce zrovna u strukturovaných dat, kde nejvíc vadí;
- `threadId`/`sessionId` držený jen v jeho kontextu se **při compaction tiše ztratí** → externí agent založí novou session a relay přeposílá amnezika, který vypadá zdravě.

**Důsledek (nosný princip celého návrhu):** identitu člena **i** kontinuitu session dej na **deterministický most** (kód + disk), ne do hlavy LLM. Relay (pokud ho framework vyžaduje) drž jako **nejtenčí možnou adresovací slupku**; fidelitu ber z **tool resultu**, ne z prózy relaye.

A upřímně: tohle dá **adresovatelného člena, ne symetrického peera**. Realita je „Claude řídí nástroj s visačkou jména" — turn-taking, cíl i ukončení žijí na Claude straně.

## 3. Ověřená fakta o Claude Code (předpoklady)

- **Externí proces nelze** nativně zaregistrovat jako člena týmu → jediná cesta = MCP most + relay agent.
- Vícekolová `SendMessage` konverzace (dlouhožijící adresovatelný účastník) funguje **jen s** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Bez toho je sub-agent fire-once.
- Vlastní agenti globálně: `~/.claude/agents/*.md` (YAML frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model`, `mcpServers`; tělo = system prompt). Rekurzivně objevováno, dostupné ve všech projektech.
- Sub-agent může **současně** volat MCP nástroje (přes `mcpServers` frontmatter / globální registraci) **a** komunikovat přes `SendMessage`.
- Globální MCP registrace: `claude mcp add --transport stdio --scope user <name> -- <cmd>` (zapisuje do `~/.claude.json`).

## 4. Architektura

```
  ┌─────────────┐   SendMessage    ┌──────────────┐   MCP tool call   ┌──────────────────┐   spawn/stdio   ┌────────────┐
  │ jiný Claude │ ───────────────▶ │  codex-peer  │ ────────────────▶ │  codex-bridge    │ ──────────────▶ │  Codex CLI │
  │  sub-agent  │ ◀─────────────── │ (tenká slupka│ ◀──────────────── │ (DETERMINISTICKÝ │ ◀────────────── │ (codex     │
  └─────────────┘   verbatim reply │  v ~/.claude/│   reply + meta    │  most, vlastní   │   reply         │ mcp-server)│
                                   │   agents/)   │                   │  stav na disku)  │                 └────────────┘
                                   └──────────────┘                   └──────┬───────────┘
                                                                              │ persistuje
                                                                              ▼
                                                            ~/.claude/state/codex-bridge/<conv>.json
                                                              { threadId, turns, createdAt }   + transcript.jsonl
```

Tři vrstvy, jasně oddělené:

### 4.1 Transport — deterministický MCP most kolem CLI
Most je **vlastní tenký stdio MCP server**, který drží stav. Vystavuje **jeden** nástroj:

```
codex_turn(conversation_id: string, message: string) -> { reply: string, thread_id: string, turn: int }
```

Chování (deterministické, žádný LLM):
1. Zamkni state soubor pro `conversation_id` (file lock — globální scope = paralelní přístup z více týmů).
2. Pokud pro `conversation_id` **není** uložený `thread_id` → založ session a ulož `thread_id`. Jinak pokračuj v existující.
3. Zavolej Codex, zachyť odpověď, **append do `transcript.jsonl`**, odemkni, vrať `reply` + metadata.
4. Když nelze získat/obnovit session → **vrať hlasitou chybu** (nikdy tiše „nová session" — to je ta amnézie).

**Backing pro Codex (doporučeno):** most si jako child spustí nativní `codex mcp-server` a mluví na něj MCP-em — `codex()` (vrátí `structuredContent.threadId`) a `codex-reply(threadId, …)`. Vlákno drží konverzaci **i stav souborů** koherentně. *(Alternativa `codex exec resume <session>` má čerstvý známý hang bug — nepoužívat jako primární.)*

**Backing pro Copilot:** Copilot **není** MCP server → most volá `copilot -p` ve scripted módu a parsuje JSON (viz `reference_copilot_cli_noninteractive_capture` v paměti):
```
copilot -p "<message>" --output-format json --model gpt-5.5 --reasoning-effort xhigh --allow-all-tools [--resume <sessionId>]
```
Odpověď = `assistant.message` final_answer z JSON. `sessionId` parsuj a persistuj; když ho nelze vyparsovat → **hlasitá chyba**.

### 4.2 Stav na disku (NE v kontextu LLM)
```
~/.claude/state/codex-bridge/
  <conversation_id>.json     # { thread_id|session_id, turn, created_at, provider }
  <conversation_id>.transcript.jsonl   # 1 řádek/tah: {ts, direction, message, thread_id, tokens?}
  <conversation_id>.lock     # file lock
```
- Klíčováno `conversation_id` (= `peer` + běh/konverzace), aby se vlákna **neprolnula** mezi projekty/týmy.
- Transcript = viditelnost + crash recovery + audit (chytíš relay, který tiše editoval) + re-seed při ztrátě vlákna.

### 4.3 Membership — tenká slupka (jen pokud framework vyžaduje Claude člena)
`~/.claude/agents/codex-peer.md` — nejtenčí možný agent. Jeho jediná práce: vzít příchozí zprávu, zavolat `codex_turn(conversation_id, message)`, vrátit `reply` **doslova**. Žádný vlastní reasoning. `conversation_id` odvozený stabilně (např. z názvu týmu/úkolu). `thread_id` **drží most na disku**, ne agent ve své paměti.

> **Leanější varianta (Tier A):** pokud nepotřebuješ jméno adresovatelné *ostatními* sub-agenty, orchestrátor volá `codex_turn` přímo jako nástroj — bez relay agenta. Je to hub-and-spoke (Codex dosáhne jen orchestrátor), ne plnohodnotný člen. Fajn jako úplně první prototyp.

### 4.4 Řízení konverzace a ukončení — vlastní reasoning strana
Externí CLI člen je **reactive-only** ve v1 (neiniciuje) — to dělá ukončení rozhodnutelným. Terminaci vlastní Claude orchestrátor/peer, co s mostem mluví:
- **max-turns gilotina** (tvrdý strop, např. 8);
- **kumulativní cost/token cap** (bezpečnostní pás proti přejetí přes noc — *povinné*, ne nice-to-have);
- **per-call idle timeout** (hangnutý CLI tah);
- **sémantický stop** — Claude po každé odpovědi posoudí „hotovo / točíme se?". `<DONE>` od CLI je jen poradní vstup, ne spínač (politeness loopy).

## 5. Konkrétní artefakty k vytvoření

1. **`~/.claude/agents/codex-peer.md`** (skica):
   ```yaml
   ---
   name: codex-peer
   description: >
     Adresovatelný člen týmu zastupující OpenAI Codex CLI. Přepošli mu zprávu
     a vrať jeho odpověď. Použij, když chceš do týmu zapojit Codex jako
     konverzačního účastníka.
   tools: mcp__codex_bridge__codex_turn
   model: haiku        # slupka nereasonuje → nejlevnější model
   ---
   Jsi adresovací slupka pro Codex CLI, ne samostatný agent.
   Pro KAŽDOU příchozí zprávu zavolej nástroj `codex_turn` s konstantním
   `conversation_id` (drž stejné po celou konverzaci) a textem zprávy.
   Vrať pole `reply` z výsledku DOSLOVA — nic nepřidávej, neshrnuj, needituj,
   zvlášť diffy/kód/strukturovaná data. `thread_id` neřeš, drží ho most.
   ```
2. **`codex-bridge`** — tenký stdio MCP server (Node nebo PowerShell) dle §4.1–4.2. Registrace:
   ```
   claude mcp add --transport stdio --scope user codex_bridge -- cmd /c node "C:\Users\ai\.claude\bridges\codex-bridge\index.js"
   ```
3. **`copilot-peer.md`** + **`copilot-bridge`** — analogicky, backing přes `copilot -p --output-format json …` (až po Codexu).
4. Zapnout `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (ověřit, že už je).

## 6. Windows nástrahy (konkrétně)

- `codex`/`copilot` jsou skoro jistě `.cmd`/`.ps1` shimy → bare CreateProcess selže nebo zatuhne; spouštěj přes **`cmd /c codex …`** nebo absolutní cestu k `.cmd`. (Nejčastější příčina selhání stdio MCP na Windows.)
- V user-scope configu **absolutní cesty**; `~`/`$HOME`/POSIX cesty se neexpandují (a config pak není přenositelný mezi stroji — vědomě).
- stdio = newline-delimited JSON → vynuť **UTF-8 bez BOM a LF**; veškerý chatter CLI na **stderr** (na stdout jen MCP protokol, jinak rozbiješ stream — pozor i na bannery/`Write-Host`).
- Globálně registrovaný most = **stálý ACE daemon ve všech projektech** → per-thread sandbox + allow-list working-dirů; „pohodlně všude" ≠ „`danger-full-access` všude".
- Copilot `-p` má **dvojitý cold-start race** (Claude→most a most→copilot→copilotovy MCP servery) → most musí blokovat až do první reálné odpovědi a hard-errorovat, ne tiše fresh-session.
- Prompty předávej přes UTF-8 (vyhneš se quoting/encoding peklu), ne přes argumenty příkazové řádky.

## 7. První milník + kritický akceptační test

**Milník:** jen **Codex** přes nativní `codex mcp-server` jako backing, `codex-bridge` drží `thread_id` na disku, `codex-peer` slupka, reactive-only, terminaci řídí orchestrátor, transcript na disk.

**Test, který validuje NEBO zabije celý design:**
> `thread_id` continuity přes **3+ samostatná `SendMessage` kola s vynucenou compaction mezi nimi**. Codex si musí pamatovat kontext z 1. kola i po compaction relay agenta.

Když projde → architektura sedí. Teprve pak Copilot wrapper. Symetrické/iniciující peery odložit indefinitely.

## 8. Otevřené otázky k ověření před stavbou

1. Drží Agent Teams framework `codex-peer` jako **persistentní instanci** mezi samostatnými `SendMessage` výměnami, nebo re-instancuje? (Pokud re-instancuje, tím spíš musí být `thread_id` na disku — což návrh už dělá.)
2. Umožní framework zaregistrovat **non-Claude adresovatelný endpoint** přímo? (Pokud ano → odpadá relay slupka, most je rovnou člen.)
3. Sdílí dvě různé výzvy stejný `codex mcp-server` proces (riziko cross-talk), nebo most spouští instanci per `conversation_id`? Doporučeno: izolace per konverzace.

## 9. Honest limitations

- Adresovatelný člen, **ne** symetrický peer. Když CLI strana někdy *iniciuje*, není kdo by rozhodl o ukončení → drž reactive-only.
- „Verbatim" relay je best-effort; integritně kritická data (diffy, strukturovaný výstup) ber z tool resultu, ne z prózy relaye.
- Globální scope = bezpečnostní a izolační závazky (viz §6).

## 10. Zdroje

- Codex jako MCP server: https://codex.danielvaughan.com/2026/05/12/codex-cli-agents-sdk-mcp-server-multi-agent-workflows/
- Codex non-interactive / exec: https://developers.openai.com/codex/noninteractive · hang bug `exec resume`: https://github.com/openai/codex/issues/14470
- Copilot CLI programmatic ref: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference · first-turn MCP race: https://github.com/github/copilot-cli/issues/3329
- MCP vs A2A: https://workos.com/guide/understanding-mcp-acp-a2a
- Související paměť: `project_cli_as_team_member`, `reference_copilot_cli_noninteractive_capture`
