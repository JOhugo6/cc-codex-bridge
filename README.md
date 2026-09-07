**Česky** | [English](README.en.md)

# cc-codex-bridge

Zapojí **OpenAI Codex CLI** jako adresovatelného člena [Claude Code](https://claude.ai/code) týmu.

Po instalaci můžeš posílat `SendMessage` agentovi `codex-peer` z libovolné Claude Code týmové konverzace a dostávat skutečné Codex odpovědi zpět — s vícekolovým kontextem udržovaným přes samostatná spuštění agentů.

```
Jiný Claude sub-agent
  └─ SendMessage("CONV_ID: my-conv\nZkontroluj tento diff…")
       └─ codex-peer (tenká slupka, model: sonnet)
            └─ codex_turn MCP nástroj
                 └─ codex-bridge (deterministický Node server)
                      └─ codex app-server (nativní Codex CLI)
                           └─ ~/.claude/state/codex-bridge/v2@<sha256>.json  ← thread_id na disku
```

## Prerekvizity

| Nástroj | Minimální verze | Poznámka |
|---|---|---|
| Node.js | v20 | `node --version` |
| Claude Code CLI | ověřeno native 2.1.126 | viz limity režimů/verzí níže; modelové tahy vyžadují přihlášení |
| OpenAI Codex CLI | v0.153.4 | `codex --version`, musí být autentizováno |
| PowerShell | Windows 5.1 nebo 7 | instalátor; vestavěný 5.1 + Add-Type pro backend |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `=1` | jen pro experimentální teammate; běžný subagent jej nepotřebuje |

## Instalace

```powershell
git clone https://github.com/JOhugo6/cc-codex-bridge
cd cc-codex-bridge
.\install.ps1
```

Poté **restartuj Claude Code** (definice agentů se cachují při startu session).

Instalátor:
1. Zkopíruje `bridge/` → `~/.claude/bridges/codex-bridge/`
2. Spustí `npm ci`
3. Nahradí skutečnou cestu v `agent/codex-peer.md.template` → `~/.claude/agents/codex-peer.md`
4. Zaregistruje MCP server na user scope (`claude mcp add --scope user codex_bridge`)

`.\install.ps1` lze opakovaně spouštět po pullnutí aktualizací — je idempotentní.

Běžný subagent vrací finální odpověď volajícímu; týmové odpovědi doručuje přes `SendMessage`. Instalátor ověřuje registrovaný příkaz skutečným MCP handshakem a seznamem nástrojů, bez volání Codexu. Viz [režimy Claude, nastavení a diagnostika](docs/claude-modes.md): `--agent`, načítání in-process/split-pane, limity verzí a izolovaná instalace.

## Použití

Každá zpráva pro `codex-peer` **musí** začínat řádkem `CONV_ID:`:

```
CONV_ID: my-project--review-01
Zkontroluj prosím následující diff a ukaž na případné chyby…
<diff zde>
```

`CONV_ID` je tvůj stabilní klíč pro celou konverzaci — zvol ho jednou a opakovaně ho používej v každé zprávě. Bridge udržuje Codex vlákno živé na disku pod tímto klíčem, takže každé čerstvě spuštěné `codex-peer` pokračuje přesně tam, kde skončilo poslední.

Pro kontrolu souborů projektu přidej adresář na **stejný první řádek**:

```text
CONV_ID: my-project--review-02; WORKING_DIR: "C:/Projects/My App"
Zkontroluj zdrojové soubory tohoto projektu.
```

Cesta je JSON řetězec; `/` usnadňuje zápis Windows cest bez escapování zpětných lomítek. Metadata jsou pouze na prvním řádku, tělo se předává beze změn. Bridge ověří adresář a uloží jeho kanonickou cestu k vláknu. V dalších zprávách ji můžeš vynechat; jiný adresář bude odmítnut. Bez explicitní cesty v prvním tahu se použije adresář procesu bridge zachycený při jeho startu. Vůči němu se vyhodnocují i relativní cesty, proto preferuj absolutní cestu projektu. Starší vlákna bez uloženého adresáře čekají na ověření; viz [diagnostika adresáře](docs/runbook.md#pracovní-adresář-a-starší-vlákna).

Relay předává celou zprávu jako `codex_turn({envelope: "CONV_ID: ...\n..."})`; první řádek parsuje kód bridge. Použij LF nebo CRLF, bez úvodního prázdného řádku, BOM či preambule. Whitespace hlavičky tvoří pouze ASCII mezery/tabulátory. Neprázdné tělo se zachová přesně, včetně prázdných řádků a textu podobného hlavičce. Volitelné `; REQUEST_ID: request-01` na stejném prvním řádku umožní bezpečné opakované doručení; pro nový zamýšlený tah použij nové request ID a stejné pouze pro opakování daného požadavku. Pořadí metadat je libovolné; opakovaná/neznámá metadata jsou chyba. Přímí volající mohou dál používat `{conversation_id, message, working_dir?, request_id?}`; smíchání režimů a neznámé argumenty se odmítnou. Limity a formáty chyb popisuje [úplný vstupní a chybový kontrakt](docs/runbook.md#deterministická-obálka-a-chybový-kontrakt).

### V Claude Code týmu

Příklady níže jsou pseudokód. Nejdřív vytvoř/spusť teammate a používej schéma své verze Claude; viz [verzovaný týmový postup](docs/claude-modes.md#experimentální-členové-týmu).

Pro přesné diffy/kód zachovej přímý MCP výsledek: `reply_artifact` nabízí neměnné UTF-8 resource URI, SHA-256, délku bajtů a identitu tahu. Načti jej přes `resources/read` a ověř dekódované bajty kódem; próza relaye je best effort. Viz [přesné načtení odpovědi](docs/runbook.md#přesné-bajty-odpovědi-a-mcp-resources).

```python
# Příklad: orchestrátor posílá zprávu codex-peer
SendMessage(to="codex-peer", message="""CONV_ID: sprint42--arch-review
Navrhujeme novou caching vrstvu. Jaké jsou trade-offy mezi
write-through a write-back strategiemi pro náš use case?
""")
```

Poté, v čerstvě spuštěném session:

```python
SendMessage(to="codex-peer", message="""CONV_ID: sprint42--arch-review
Na základě trade-offů, které jsi popsal, co bys doporučil pro
read-heavy workload s občasnými burst writes?
""")
```

Codex si pamatuje dřívější kontext, protože `CONV_ID` odkazuje na stejné on-disk vlákno.

## Testy

```powershell
# Z klonu repozitáře: deterministické testy (bez modelových volání)
npm --prefix bridge test

# Live smoke (vyžaduje autentizovaný Codex, ~30s)
$env:CODEX_BRIDGE_LIVE = "1"
npm --prefix bridge run smoke

# Skutečný Claude relay + deterministická náhrada Codexu (vyžaduje Claude login)
npm --prefix bridge run eval:relay -- --stub

# Skutečný Claude → bridge → Codex, dva nové procesy Claude
npm --prefix bridge run eval:relay -- --live-codex
```

## Klíčová designová rozhodnutí

- **Kontinuita vlákna na disku, ne v LLM.** Relay agent nedrží žádný stav. Bridge persistuje `thread_id` do `~/.claude/state/codex-bridge/v2@<sha256>.json`, takže přežije re-instanciaci agenta a context compaction.
- **Bezpečné opakování požadavku.** Volitelné `request_id` v `codex_turn` vrátí již dokončený výsledek bez nového volání Codexu. Trvalý journal blokuje pokračování po nejasném selhání; [runbook](docs/runbook.md#opakované-doručení-a-obnova-operace) popisuje diagnostiku a obnovu lokálních zápisů.
- **Hard-error při ztrátě session.** Selhání obnovy vlákna vyhodí hlasitou chybu — nikdy tiše nezahájí novou session (to by byla neviditelná amnézie).
- **`model: sonnet` je výchozí volba relay.** Instrukce modelu nezaručují správná volání ani přesné kopírování. [Behaviorální eval](docs/relay-eval.md) zaznamenává skutečná volání, rozdíly bajtů, chyby a kontinuitu po restartu; odděluje stub/živé výsledky a uvádí omezení ověření.
- **`CONV_ID:` dodává operátor.** Relay klíč nikdy neodvozuje — LLM-hádaný klíč by byl nedeterministický a zlomil by cross-spawn kontinuitu.
- **v1 limitace:** jeden sdílený `codex app-server` proces obsluhuje všechny konverzace (izolace na úrovni vlákna, ne procesu). Sandbox je read-only. Nerozsiruj sandbox bez přidání per-conversation process isolation.

## Aktualizace

```powershell
git pull
.\install.ps1   # idempotentní, bezpečné opakovaně spustit
```

Poté **restartuj Claude Code** — definice agentů (`codex-peer`) se cachují při startu session.
Bez restartu bude relay agent stále používat starou verzi bez ohledu na `install.ps1`.

Ověř po restartu:
```powershell
claude mcp list   # codex_bridge musí ukazovat ✓ Connected
npm --prefix "$env:USERPROFILE\.claude\bridges\codex-bridge" test
```

## Dokumentace

- `docs/design.md` — plná architektura, designová rozhodnutí, Windows nástrahy
- `docs/runbook.md` — provozní příručka, procedura akceptačního testu, troubleshooting

## Licence

MIT

Backend používá nativní App Server JSONL (`initialize`/`initialized`, `thread/start`, `thread/read`, `thread/resume`, `turn/start`). Ověřeno s Codex CLI 0.153.4; nekompatibilní odpovědi protokolu vrací explicitní chybu. MCP SDK zůstává závislostí veřejného rozhraní bridge. Viz [životní cyklus a ověření backendu](docs/runbook.md#app-server-backend-a-ověření).

Na Windows backend vyžaduje také vestavěný Windows PowerShell 5.1 s povoleným `Add-Type` pro Job Object supervisor. Instalátor zahrnuje oba zdrojové soubory helperu; samostatný binární soubor ani npm závislost se neinstaluje.
