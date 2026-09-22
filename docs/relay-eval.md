# Akceptační ověření relay

**Česky** | [English](relay-eval.en.md)

Příkazy spouštěj z klonu repozitáře po `npm --prefix bridge ci`.
Eval čte také `agent/codex-peer.md.template`, samotná nainstalovaná složka
bridge proto nestačí.

| Příkaz | Skutečné komponenty | Co ověřuje |
|---|---|---|
| `npm --prefix bridge test` | Node, MCP, deterministický backend/JSONL fixtures | Kontrakty bridge, obnovu, resources, ukončení procesů a pozorování/hodnocení eval; bez Claude a Codex modelů |
| `npm --prefix bridge run smoke` s `CODEX_BRIDGE_LIVE=1` | Bridge + přihlášený Codex App Server | Dva oddělené procesy, uložené vlákno a vybavení náhodného tokenu; bez Claude |
| `npm --prefix bridge run eval:relay -- --stub` | Přihlášený Claude + skutečný MCP bridge + deterministická náhrada Codexu | Skutečné chování relay: přesný diff, vložené instrukce, chyby, chybějící nástroj a nová instance |
| `npm --prefix bridge run eval:relay -- --live-codex` | Přihlášený Claude + bridge + přihlášený Codex | Dva nové procesy Claude/bridge sdílejí jen stav bridge; stejné vlákno, tahy 1/2 a vybavení náhodného tokenu |

Volitelné evaly čerpají modelovou kvótu existujících účtů. Stub sada spouští
osm nových instancí Claude, živá sada dvě. Každá má CLI limit 1 USD a časový
limit 120 sekund (180 sekund se skutečným Codexem); rozpočet Claude neomezuje
spotřebu Codexu. Povolený je pouze jediný MCP nástroj, vestavěné nástroje jsou
vypnuté. Skutečný Codex spouští jen `--live-codex`, a to v sandboxu `danger-full-access` s uživatelovými reálnými MCP servery, jejichž volání se tím auto-schvalují; `--stub` žádný Codex nespouští. Infrastrukturní/API chyba sadu
zastaví a další případy označí `skipped`; odchylka chování zůstává skutečným
selháním a nezávislé případy pokračují.

Harness vykreslí aktuální šablonu pomocí instalačních helperů. Prompt, popis
a model předá jako dočasnou definici `--agents` vybranou přes `--agent`,
s explicitními `--mcp-config` a `--strict-mcp-config`. Vypne zdroje nastavení,
hooks, skills, auto-memory a ukládání session; použije prázdný dočasný projekt
a vlastní MCP konfiguraci/stav. Nic neregistruje ani neinstaluje a nekopíruje
přihlašovací údaje; běžné přihlášení CLI zůstává dostupné. Pokud Claude není
ve výchozím umístění Windows nebo na POSIX PATH, nastav `CLAUDE_BIN` na
absolutní cestu k nativnímu programu. Stav přihlášení sám neprokazuje úspěšný
modelový požadavek: expirovaný token může skončit API chybou 401.

Ověřuje se hlavní print session `--agent` s explicitní MCP konfigurací.
Neověřuje se vyhledání nainstalované frontmatter definice, vnořený subagent,
interaktivní in-process/split-pane teammate, doručení/vypnutí přes SendMessage
ani compaction. Viz [ověření jednotlivých režimů](claude-modes.md). Automatický
test paměti používá nový proces: compaction může token uchovat v souhrnu,
takže sama neprokazuje, že jej relay zapomněl.

## Důkazy a interpretace

Každý běh vypíše svůj nový dočasný adresář a umístění `report.json`.
Návratový kód 0 znamená, že prošly všechny požadované kontroly. Jednotlivé
`result.json`, MCP `audit.jsonl`, vstupní fixtures a izolovaný stav zůstávají
k prohlédnutí; po kontrole smaž tento vygenerovaný adresář. Reporty obsahují
syntetické prompty/odpovědi, výsledky nástrojů a PID, nikoli kopie souborů
s přihlašovacími údaji. API chyba je selhání, ne přeskočený úspěch.

Příklad formátu konzole (ilustrační, nejde o tvrzení o provedeném běhu):

```text
Evaluation artefacts: <dočasný adresář>
exact-diff: FAIL {"claude_completed":true,...,"exact_reply":false,"artifact_exact":true,...}
Report: <dočasný adresář>/report.json
```

Proxy zaznamenává skutečné MCP `tools/call` požadavky/výsledky, nevybírá ani
nepřepisuje jejich obsah. Hodnocení kontroluje jedno nezměněné `{envelope}`
volání, žádné další Claude nástroje, přesnou UTF-8 shodu finální odpovědi
s odpovědí/chybou nástroje a ukončení procesů. Bez nástroje vyžaduje nula
volání a pevný řádek `TOOL_UNAVAILABLE`. Chybný vstup musí dorazit nezměněný
k validaci bridge. Diff obsahuje CRLF, kombinující Unicode, koncové mezery,
tabelátory a prázdné řádky; hodnocení nic nenormalizuje.

Eval se zvlášť připojí jako MCP klient a přečte každé úspěšné
`reply_artifact.uri`. Porovná dekódované bajty s `reply`, SHA-256 a délkou.
`exact_reply: false, artifact_exact: true` proto znamená, že Claude změnil
svůj text, zatímco resource bridge zůstal přesný. Test věrnosti relay přesto
selhal. Pro výstup vyžadující integritu použij [resource kontrakt](runbook.md#přesné-bajty-odpovědi-a-mcp-resources).

Kontinuita kontroluje `thread_id` ze skutečného výsledku nástroje, čísla tahů,
náhodný token nepřítomný ve druhém požadavku, různá Claude session ID a PID
bridge. Chybná odpověď sama neurčuje chybu bridge: prohlédni obálku, vlákno,
backend výsledek a výstup relay. Deterministická sada také úmyslně změní
pozorované vstupy/výstupy a ověří odmítnutí změněné obálky, dalších volání
a ztracených bílých znaků.

## Rozsah ověřený při této změně

Deterministická sada prochází na Windows s Node 24.12.0. Samostatný skutečný
Codex 0.153.4 smoke prošel včetně kontinuity vlákna/tokenu a ukončení procesů.
Skutečný relay eval s Claude 2.1.126 byl spuštěn, ale API odmítlo expirovaný
OAuth token (401) ještě před modelovým tahem. Tento běh neověřuje chování
Claude ani celou kontinuitu Claude–Codex; zopakuj jej po běžné obnově
přihlášení Claude. Interaktivní týmové režimy nebyly spuštěny. `sonnet` je
výchozí volba modelu, nikoli záruka spolehlivosti; po změně šablony, modelu
nebo CLI proveď eval znovu.
