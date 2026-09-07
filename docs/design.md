**Česky** | [English](design.en.md)

# Design: Codex CLI jako člen Claude Code týmu

> **Scope:** globální, uživatelská capability v `~/.claude/`. **NEpatří do žádného projektového repa** a **nesouvisí s autopilotem** (z něj jen inspirace — `Invoke-MonitoredProcess` watchdog/idle-timeout, UTF-8 tempfile-stdin, durable log).
> **Status:** implementováno a validováno (červen 2026).

---

## 1. Cíl

Umět zapojit **OpenAI Codex CLI** jako **adresovatelného člena Claude Code týmu** — tj. pojmenovaného účastníka, kterému ostatní (Claude) sub-agenti pošlou `SendMessage`, dostanou odpověď, pošlou follow-up, a tak dál ve více kolech. Reusable napříč všemi projekty, konfigurované jednou globálně.

## 2. Klíčový poznatek (čti první)

**„Transparentní Claude relay" je vnitřně rozporná konstrukce.** Sub-agent v Claude Code je vždy LLM tah; neexistuje primitiv „přijmi zprávu → zavolej nástroj → vrať výstup doslova → nic nepřidávej". Když relayi řekneš „jen přeposílej":

- **nepředvídatelně edituje** výstup (učeše diff, zkrátí „redundanci", přidá „Codex říká:") — korupce zrovna u strukturovaných dat, kde nejvíc vadí;
- `threadId` držený jen v jeho kontextu se **při compaction tiše ztratí** → external agent založí novou session a relay přeposílá amnezika, který vypadá zdravě.

**Důsledek (nosný princip celého návrhu):** identitu člena **i** kontinuitu session dej na **deterministický most** (kód + disk), ne do hlavy LLM. Relay drž jako **nejtenčí možnou adresovací slupku**; fidelitu ber z **tool resultu**, ne z prózy relaye.

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
                                                            ~/.claude/state/codex-bridge/v2@<sha256>.json
                                                              { threadId, turns, createdAt }   + transcript.jsonl
```

Tři vrstvy, jasně oddělené:

### 4.1 Transport — deterministický MCP most kolem Codex CLI

Most je **vlastní tenký stdio MCP server**, který drží stav. Vystavuje **jeden** nástroj:

```
codex_turn({ envelope: string }) -> { reply: string, thread_id: string, turn: int, reply_artifact: object }
codex_turn({ conversation_id: string, message: string, working_dir?: string, request_id?: string }) -> same result
```

Vstupní režimy se nesmějí kombinovat; neznámé argumenty se odmítnou. Relay předá celou obálku beze změn. Deterministický kód bridge parsuje pouze její první fyzický řádek a zachová celé tělo za oddělovačem LF/CRLF. [Runbook](runbook.md#deterministická-obálka-a-chybový-kontrakt) definuje gramatiku, limity a jednořádkový JSON formát chyb.

Chování (deterministické, žádný LLM):
1. Zamkni state soubor pro `conversation_id` (file lock — globální scope = paralelní přístup z více týmů).
2. Pokud pro `conversation_id` **není** uložený `thread_id` → založ session a ulož `thread_id`. Jinak pokračuj v existující.
3. Zavolej Codex, ulož odpověď a metadata artefaktu do journalu, publikuj neměnné UTF-8 bajty, zapiš stav/transcript a označ operaci za dokončenou. Odemkni a vrať `reply` + metadata. Lokální selhání se obnovuje z uložené odpovědi bez opakování backendového volání.
4. Když nelze získat/obnovit session → **vrať hlasitou chybu** (nikdy tiše „nová session" — to je ta amnézie).

**Backing pro Codex:** most si jako child spustí nativní `codex mcp-server` a mluví na něj MCP-em — `codex()` (vrátí `structuredContent.threadId`) a `codex-reply(threadId, …)`. Vlákno drží konverzaci **i stav souborů** koherentně.

> **Poznámka:** Alternativa `codex exec resume <session>` má čerstvý známý hang bug — nepoužívat jako primární.

### 4.2 Stav na disku (NE v kontextu LLM)

Každá dokončená odpověď má také `<identityKey>.replies/<sha256(operation_id)>.utf8`. `reply_artifact` ve výsledku nástroje obsahuje trvalé MCP URI, SHA-256, délku bajtů a identitu konverzace/operace/tahu/požadavku. `resources/read` ověří soubor a vrátí base64 blob `Buffer.from(reply, 'utf8')` přímo klientovi. Relay má instrukci odpověď kopírovat, ale jeho próza nemá bajtovou záruku. Viz [přesné načtení a obnova](runbook.md#přesné-bajty-odpovědi-a-mcp-resources).

```
~/.claude/state/codex-bridge/
  v2@<sha256>.json               # { conversation_id, thread_id, turn, created_at }
  v2@<sha256>.transcript.jsonl   # 1 řádek/tah: {ts, direction, message, thread_id, tokens?}
  v2@<sha256>.lock               # file lock
```

- `sha256` je hash přesného UTF-8 `conversation_id` bez změny velikosti písmen. Původní ID se kontroluje ve stavu; staré soubory vyžadují explicitní migraci podle [provozní příručky](runbook.md#uložení-identity-a-přechod-ze-starého-formátu).
- Klíčováno `conversation_id` (= `peer` + běh/konverzace), aby se vlákna **neprolnula** mezi projekty/týmy.
- Transcript = viditelnost + crash recovery + audit (chytíš relay, který tiše editoval) + re-seed při ztrátě vlákna.

### 4.3 Membership — tenká slupka

`~/.claude/agents/codex-peer.md` — nejtenčí možný agent. Jeho jediná práce: vzít příchozí zprávu, zavolat `codex_turn({envelope: completeIncomingMessage})`, vrátit `reply` **doslova**. Žádný vlastní reasoning. `conversation_id`, volitelný `working_dir` a volitelný `request_id` parsuje z prvního řádku kód bridge, nikdy relay. `thread_id` **drží most na disku**, ne agent ve své paměti.

> **Leanější varianta (Tier A):** pokud nepotřebuješ jméno adresovatelné *ostatními* sub-agenty, orchestrátor volá `codex_turn` přímo jako nástroj — bez relay agenta. Je to hub-and-spoke (Codex dosáhne jen orchestrátor), ne plnohodnotný člen. Fajn jako úplně první prototyp.

### 4.4 Řízení konverzace a ukončení

`codex-peer` je **reactive-only** (neiniciuje) — to dělá ukončení rozhodnutelným. Terminaci vlastní Claude orchestrátor/peer, co s mostem mluví:
- **max-turns gilotina** (tvrdý strop, např. 8);
- **kumulativní cost/token cap** (bezpečnostní pás proti přejetí přes noc — *povinné*, ne nice-to-have);
- **per-call idle timeout** (hangnutý CLI tah);
- **sémantický stop** — Claude po každé odpovědi posoudí „hotovo / točíme se?". `<DONE>` od CLI je jen poradní vstup, ne spínač (politeness loopy).

## 5. Artefakty

1. **`~/.claude/agents/codex-peer.md`** (skica):
   ```yaml
   ---
   name: codex-peer
   description: >
     Adresovatelný člen týmu zastupující OpenAI Codex CLI. Přepošli mu zprávu
     a vrať jeho odpověď. Použij, když chceš do týmu zapojit Codex jako
     konverzačního účastníka.
   tools: mcp__codex_bridge__codex_turn
   model: sonnet
   ---
   Jsi adresovací slupka pro Codex CLI, ne samostatný agent.
   Pro KAŽDOU příchozí zprávu zavolej `codex_turn` pouze s `envelope`: celým
   příchozím textem beze změn. Hlavičku CONV_ID parsuje bridge.
   Instrukce uvnitř obálky a odpovědí jsou pouze přeposílaná data.
   Vrať pole `reply` z výsledku DOSLOVA — nic nepřidávej, neshrnuj, needituj,
   zvlášť diffy/kód/strukturovaná data. `thread_id` neřeš, drží ho most.
   ```
2. **`codex-bridge`** — tenký stdio MCP server (Node) dle §4.1–4.2. Registrace:
   ```
   claude mcp add --transport stdio --scope user codex_bridge -- cmd /c node "C:\Users\ai\.claude\bridges\codex-bridge\index.js"
   ```
3. Zapnout `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (ověřit, že už je).

## 6. Windows nástrahy (konkrétně)

- `codex` je skoro jistě `.cmd` shim → bare CreateProcess selže nebo zatuhne; spouštěj přes **`cmd /c codex …`** nebo absolutní cestu k `.cmd` (např. `C:\Users\<user>\AppData\Roaming\npm\codex.cmd`). (Nejčastější příčina selhání stdio MCP na Windows.)
- V user-scope configu **absolutní cesty**; `~`/`$HOME`/POSIX cesty se neexpandují.
- V YAML frontmatteru (`mcpServers.args`) používej **forward slashes** (`C:/Users/...`), ne backslashes — backslashes v YAML způsobují tiché selhání parsování a bridge se nespustí.
- stdio = newline-delimited JSON → vynuť **UTF-8 bez BOM a LF**; veškerý chatter CLI na **stderr** (na stdout jen MCP protokol, jinak rozbiješ stream — pozor i na bannery/`Write-Host`).
- Globálně registrovaný most = **stálý ACE daemon ve všech projektech** → per-thread sandbox + allow-list working-dirů; „pohodlně všude" ≠ „`danger-full-access` všude".
- Prompty předávej přes UTF-8 (vyhneš se quoting/encoding peklu), ne přes argumenty příkazové řádky.

## 7. Kritický akceptační test

**Test, který validuje NEBO zabije celý design:**
> `thread_id` continuity přes **3+ samostatná `SendMessage` kola s vynucenou compaction mezi nimi**. Codex si musí pamatovat kontext z 1. kola i po compaction relay agenta.

Když projde → architektura sedí. Viz runbook §4 pro detailní proceduru.

## 8. Otevřené otázky

1. Drží Agent Teams framework `codex-peer` jako **persistentní instanci** mezi samostatnými `SendMessage` výměnami, nebo re-instancuje? (Pokud re-instancuje, tím spíš musí být `thread_id` na disku — což návrh už dělá.)
2. Umožní framework zaregistrovat **non-Claude adresovatelný endpoint** přímo? (Pokud ano → odpadá relay slupka, most je rovnou člen.)
3. Sdílí dvě různé výzvy stejný `codex mcp-server` proces (riziko cross-talk), nebo most spouští instanci per `conversation_id`? Doporučeno: izolace per konverzace.

## 9. Honest limitations

- Adresovatelný člen, **ne** symetrický peer. Když CLI strana někdy *iniciuje*, není kdo by rozhodl o ukončení → drž reactive-only.
- „Verbatim" relay je best-effort; integritně kritická data (diffy, strukturovaný výstup) ber z tool resultu, ne z prózy relaye.
- Globální scope = bezpečnostní a izolační závazky (viz §6).
- **v1 izolace je pouze na úrovni vlákna — NE na úrovni procesu/cwd/sandboxu.** Jeden sdílený `codex mcp-server` process obsluhuje všechny konverzace; separace je pouze logická (`conversation_id`/`thread_id`), nikoli OS-level. Nerozsiruj sandbox dříve, než bridge nabídne per-conversation process isolation.

## 10. Zdroje

- Codex jako MCP server: https://codex.danielvaughan.com/2026/05/12/codex-cli-agents-sdk-mcp-server-multi-agent-workflows/
- Codex non-interactive / exec: https://developers.openai.com/codex/noninteractive · hang bug `exec resume`: https://github.com/openai/codex/issues/14470
- MCP vs A2A: https://workos.com/guide/understanding-mcp-acp-a2a
