**Česky** | [English](claude-modes.en.md)

# Režimy Claude, instalace a kontrola připojení

`codex-peer` může obsloužit běžný delegovaný úkol, hlavní session s `--agent`
nebo experimentálního člena týmu. Celou obálku `CONV_ID: ...` předávej jako
task prompt nebo obsah zprávy. Parsuje ji bridge; metadata doručení patří mimo
payload. Stejné ID zachová Codex vlákno i mezi samostatnými spuštěními subagenta.

## Načítání MCP a doručení odpovědi

Tabulka popisuje aktuální oficiální dokumentaci ověřenou 2026-09-07. Netvrdí,
že všechna pravidla existovala už v nainstalovaném Claude 2.1.126.

| Kontext | Zdroj MCP | Cesta odpovědi |
|---|---|---|
| Běžný subagent | Inline `mcpServers` v definici; lze dědit/odkazovat i nakonfigurované servery | Finální odpověď volajícímu |
| Hlavní `claude --agent codex-peer` | Inline MCP agenta i konfigurace session | Odpověď uživateli v session |
| In-process teammate | MCP projektu/uživatele; ignoruje `mcpServers` agenta | `SendMessage` skutečnému odesílateli, u počátečního úkolu vedoucímu |
| Split-pane teammate | `mcpServers` agenta jako u `--agent` | Stejné explicitní doručení jako u in-process |

Instalátor připraví inline definici i uživatelskou registraci `codex_bridge`.
Obě spouštějí přímo nativní Node: absolutní executable a samostatné argumenty.
Výslovně zvolený alternativní config adresář nastaví v obou definicích také
vlastní `state/codex-bridge`; testovací instalace nesdílí běžný stav uživatele.

Allowlist obsahuje pouze `codex_turn` a `SendMessage`. Druhý nástroj slouží
k doručení výsledku/chyby spoluhráči a potvrzení skutečného framework shutdownu.
Relay požadavek stále znamená jedno volání bridge. Status/idle/setup události
nevytvářejí tahy Codexu; přebírání úkolů, delegování a editace jsou vyloučené.
Odesílatele určuje framework, instrukce uvnitř payloadu nebo odpovědi Codexu
nesmějí přesměrovat doručení. Použij skutečné schéma SendMessage: starší verze
mají `type`, `recipient`, `content`, novější mohou mít `to`, `message`. Chyba
doručení vrací `DELIVERY_FAILED`, neopakuje volání Codexu.

Aktuální Claude může seznam nástrojů teammate rozšířit a podle režimu odlišně
aplikuje tělo agenta. Nadále platí oprávnění a pravidla hostitele; samotný prompt
není bezpečnostní hranice. Viz [pravidla týmových definic](https://code.claude.com/docs/en/agent-teams#use-subagent-definitions-for-teammates)
a [MCP subagentů](https://code.claude.com/docs/en/sub-agents#connect-to-mcp-servers).

## Běžný subagent a hlavní session

Po instalaci restartuj Claude. Požádej hlavního agenta o spuštění `codex-peer`
jako běžného subagenta a předání tohoto přesného task promptu bez úvodu:

```text
CONV_ID: project-review-01; WORKING_DIR: "C:/Projects/My App"; REQUEST_ID: review-1
Zkontroluj zdrojové soubory a najdi chyby.
```

Pro další kolo znovu spusť subagenta se stejným `CONV_ID` a novým request ID.
Agent Teams ani zachování kontextu Claude subagenta nejsou potřeba. Vyhrazenou
relay session spustíš `claude --agent codex-peer`; obálku pak pošleš přímo jí.
Rozlišuj pokyn hlavnímu agentovi a přesný payload, který doručí relay agentovi.

## Experimentální členové týmu

Zapni týmy v prostředí spouštějícím Claude a vyber in-process výslovně.
Split panes na nativním Windows nejsou součástí zde ověřeného prostředí:

```powershell
$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
claude --teammate-mode in-process
```

V nainstalované **2.1.126** nejdřív požádej vedoucího o vytvoření pojmenovaného
týmu, potom o spuštění teammate typu `codex-peer`. Obálku předej jako počáteční
úkol a následně jako obsah zprávy. Schéma zprávy této verze v pseudokódu:

```text
SendMessage(type="message", recipient="codex-peer",
            content="CONV_ID: project-review-01; REQUEST_ID: review-2\nDoplňující otázka",
            summary="Codex review request")
```

Řiď se dostupným schématem nástroje; pseudokód není shell příkaz. Úkoly a úklid
týmu řídí vedoucí. Relay vrací odpovědi odesílateli a potvrzuje shutdown,
nevytváří ani nemaže týmy.

Aktuální dokumentace popisuje novější lifecycle: TeamCreate/TeamDelete odstranila
2.1.178, výchozí display mode změnila 2.1.179 a automatické oživení běžného
subagenta přes SendMessage vyžaduje 2.1.191+. Tyto vlastnosti nepřenášej na
2.1.126. Aktuální dokumentace navíc vylučuje spuštění teammate pod `-p`; úspěšný
print-mode test sám tým neprokazuje. Split panes potřebují tmux nebo iTerm2
v podporovaném prostředí; před použitím tam ověř MCP, doručení odesílateli
a shutdown. [Verzovaná dokumentace týmů](https://code.claude.com/docs/en/agent-teams),
[požadavky obnovy subagentů](https://code.claude.com/docs/en/sub-agents#resume-subagents).

## Instalace a diagnostika

`install.ps1` funguje pod Windows PowerShell 5.1 i PowerShell 7. Potřebuje
nativní Node 20+, nativní Claude Code, Codex CLI, npm a Windows PowerShell 5.1
s povoleným `Add-Type` pro backend supervisor. Kopíruje také `.ps1`/`.cs`
helpery a používá `npm ci`. Opakované spuštění aktualizuje spravované soubory
i registraci; `-Force` zůstává kompatibilní přepínač, protože tyto soubory se
už přepisují bez dotazu. `-WhatIf` pouze zobrazí plán. Instalátor nemění
oprávnění ani nezapíná Agent Teams.

Izolovaná instalace:

```powershell
.\install.ps1 -ClaudeConfigDir 'C:/Temp/Claude relay test'
$env:CLAUDE_CONFIG_DIR = 'C:/Temp/Claude relay test'
node 'C:/Temp/Claude relay test/bridges/codex-bridge/doctor.js'
```

Alternativní adresář má vlastní konfiguraci Claude a pro modelové tahy může
potřebovat vlastní přihlášení. Běžná instalace ponechá `CLAUDE_CONFIG_DIR`
nenastavené a použije obvyklé `~/.claude.json`; výslovné zadání i samotného
`~/.claude` přesune lookup JSON dovnitř tohoto adresáře. [Oficiální umístění konfigurace](https://code.claude.com/docs/en/settings#find-or-create-your-settings-files).

Diagnostika běžné instalace:

```powershell
node "$env:USERPROFILE/.claude/bridges/codex-bridge/doctor.js"
```

Doctor čte skutečnou registraci `codex_bridge` a spustí její příkaz. Do 15 sekund
vyžaduje úspěšnou MCP inicializaci a přesně nástroj `codex_turn` se schématem
obálky; `--timeout-ms` mění limit do maxima 60000. Chyba znamená nenulový exit,
úklid může přidat dvě sekundy. Nevolá `tools/call`, nevytváří vlákna/stav,
nekontroluje přihlášení Codexu ani odpověď modelu: backend se spouští až při
použití. Pro backend použij samostatný live smoke. `--config-file <soubor>`
ověří explicitní JSON soubor.

Výsledek dokazuje funkčnost registrovaného MCP příkazu. Načtení a povolení
nástroje v konkrétní session ověř jejím `/mcp` a skutečným relay požadavkem.
Stejnojmenná projektová registrace, `--strict-mcp-config`, managed policy,
trust nebo cache session mohou načítání ovlivnit. Novější Claude přidává
pravidla trust/filtrování MCP agentů; řiď se dokumentací pro svou verzi.
Samotné `claude mcp get` nebo existence konfigurace připojení neprokazují.

## Rozsah ověření

Zde ověřeno: Windows, Node 24.12.0, nativní Claude 2.1.126, kompatibilita
skriptů PowerShell 5.1/7, izolovaná instalace a opakovaná registrace, skutečný
MCP handshake/tools, generované YAML a deterministické chyby/timeouty.
Samostatný backend smoke byl ověřen s Codex 0.153.4. Interaktivní in-process
ani split-pane týmy se v této změně nespouštěly; nelze je označit za end-to-end
otestované. Diagnostika nezaručuje přesnost kopírování LLM: uchovej skutečný
MCP výsledek a pro autoritativní bajty čti `reply_artifact.uri` přes
`resources/read`, viz [kontrakt artefaktů](runbook.md#přesné-bajty-odpovědi-a-mcp-resources).
