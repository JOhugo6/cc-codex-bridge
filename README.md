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
                      └─ codex mcp-server (nativní Codex CLI)
                           └─ ~/.claude/state/codex-bridge/v2@<sha256>.json  ← thread_id na disku
```

## Prerekvizity

| Nástroj | Minimální verze | Poznámka |
|---|---|---|
| Node.js | v20 | `node --version` |
| Claude Code CLI | aktuální | `claude --version`, musí být autentizováno |
| OpenAI Codex CLI | v0.133+ | `codex --version`, musí být autentizováno |
| PowerShell | 7 (pwsh) | pro install skript |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `=1` | nastavit v prostředí |

## Instalace

```powershell
git clone https://github.com/JOhugo6/cc-codex-bridge
cd cc-codex-bridge
.\install.ps1
```

Poté **restartuj Claude Code** (definice agentů se cachují při startu session).

Instalátor:
1. Zkopíruje `bridge/` → `~/.claude/bridges/codex-bridge/`
2. Spustí `npm install`
3. Nahradí skutečnou cestu v `agent/codex-peer.md.template` → `~/.claude/agents/codex-peer.md`
4. Zaregistruje MCP server na user scope (`claude mcp add --scope user codex_bridge`)

`.\install.ps1` lze opakovaně spouštět po pullnutí aktualizací — je idempotentní.

## Použití

Každá zpráva pro `codex-peer` **musí** začínat řádkem `CONV_ID:`:

```
CONV_ID: my-project--review-01
Zkontroluj prosím následující diff a ukaž na případné chyby…
<diff zde>
```

`CONV_ID` je tvůj stabilní klíč pro celou konverzaci — zvol ho jednou a opakovaně ho používej v každé zprávě. Bridge udržuje Codex vlákno živé na disku pod tímto klíčem, takže každé čerstvě spuštěné `codex-peer` pokračuje přesně tam, kde skončilo poslední.

### V Claude Code týmu

```python
# Příklad: orchestrátor posílá zprávu codex-peer
SendMessage(to="codex-peer", message="""
CONV_ID: sprint42--arch-review
Navrhujeme novou caching vrstvu. Jaké jsou trade-offy mezi
write-through a write-back strategiemi pro náš use case?
""")
```

Poté, v čerstvě spuštěném session:

```python
SendMessage(to="codex-peer", message="""
CONV_ID: sprint42--arch-review
Na základě trade-offů, které jsi popsal, co bys doporučil pro
read-heavy workload s občasnými burst writes?
""")
```

Codex si pamatuje dřívější kontext, protože `CONV_ID` odkazuje na stejné on-disk vlákno.

## Testy

```powershell
# Unit + integration (nevyžaduje Codex)
npm --prefix "$env:USERPROFILE\.claude\bridges\codex-bridge" test

# Live smoke (vyžaduje autentizovaný Codex, ~30s)
$env:CODEX_BRIDGE_LIVE = "1"
npm --prefix "$env:USERPROFILE\.claude\bridges\codex-bridge" run smoke
```

## Klíčová designová rozhodnutí

- **Kontinuita vlákna na disku, ne v LLM.** Relay agent nedrží žádný stav. Bridge persistuje `thread_id` do `~/.claude/state/codex-bridge/v2@<sha256>.json`, takže přežije re-instanciaci agenta a context compaction.
- **Hard-error při ztrátě session.** Selhání obnovy vlákna vyhodí hlasitou chybu — nikdy tiše nezahájí novou session (to by byla neviditelná amnézie).
- **`model: sonnet` pro relay.** Haiku byl nespolehlivý ohledně volání nástroje vs. improvizace vlastní odpovědi. Sonnet spolehlivě následuje instrukce pro tool call.
- **`CONV_ID:` dodává operátor.** Relay klíč nikdy neodvozuje — LLM-hádaný klíč by byl nedeterministický a zlomil by cross-spawn kontinuitu.
- **v1 limitace:** jeden sdílený `codex mcp-server` proces obsluhuje všechny konverzace (izolace na úrovni vlákna, ne procesu). Sandbox je read-only. Nerozsiruj sandbox bez přidání per-conversation process isolation.

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
npm --prefix "$env:USERPROFILE\.claude\bridges\codex-bridge" test   # 47/47 pass
```

## Dokumentace

- `docs/design.md` — plná architektura, designová rozhodnutí, Windows nástrahy
- `docs/runbook.md` — provozní příručka, procedura akceptačního testu, troubleshooting

## Licence

MIT
