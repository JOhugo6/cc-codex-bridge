**Česky** | [English](runbook.en.md)

# Provozní příručka: `codex-peer` (Codex CLI jako člen Claude Code týmu)

> Doplněk k design doku `design.md`. Tato příručka pokrývá provoz **membership vrstvy**: relay agenta `codex-peer` (`~/.claude/agents/codex-peer.md`) a deterministického MCP mostu (`codex-bridge`).
>
> **Tool kontrakt (pevný):** bridge je zaregistrovaný jako MCP server `codex_bridge` a vystavuje jeden nástroj, surfacující k agentům jako **`mcp__codex_bridge__codex_turn`**, se signaturou `codex_turn(conversation_id, message) -> { reply, thread_id, turn }`.
>
> **Architektura jednou větou:** jiný Claude sub-agent → `SendMessage` → `codex-peer` (tenká slupka) → MCP volání `codex_turn` → `codex-bridge` (deterministický, drží `thread_id` na disku) → Codex CLI → odpověď zpět, vrácená verbatim.
>
> **Nosný princip (design doc §2):** relay nedrží ŽÁDNÝ stav a NIČEMU nepřidává. Identita a kontinuita session žijí na bridge (kód + disk), nikdy v kontextu relay LLM. Vše níže z tohoto vychází.

---

## 1. Prerekvizity a jak je ověřit

Spusť každou kontrolu před prvním použitím. Všechny cesty jsou absolutní (user-scope config Windows neexpanduje `~`/`$HOME`).

| # | Prerekvizita | Příkaz (PowerShell) | Očekáváno |
|---|---|---|---|
| 1 | Agent Teams zapnuto | `$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | vypíše `1` |
| 2 | Codex CLI nainstalováno | `(Get-Command codex).Source` | cesta končící na `codex.cmd` (např. `C:\Users\ai\AppData\Roaming\npm\codex.cmd`) |
| 3 | Codex autentizován | `codex login status` (nebo spusť triviální `codex` turn) | hlásí přihlášený účet, bez auth promptu |
| 4 | Node přítomen (runtime bridge) | `node --version` | vypíše verzi (bridge ho potřebuje) |
| 5 | Bridge zaregistrován | `claude mcp list` | řádek `codex_bridge: ... - ✓ Connected` |
| 6 | Relay agent přítomen | `Test-Path C:\Users\ai\.claude\agents\codex-peer.md` | `True` |

Poznámky:
- **#1** musí být nastaveno v prostředí, které spouští Claude Code, ne jen v shellu otevřeném poté. Pokud nic nevypíše, vícekolová `SendMessage` konverzace tiše degraduje na fire-once a akceptační test nemůže projít.
- **#5** — registraci provádí `install.ps1` (spusť dle instrukcí). Provede ekvivalent: `claude mcp add --transport stdio --scope user codex_bridge -- cmd /c node "C:\Users\ai\.claude\bridges\codex-bridge\index.js"`. Název serveru **musí** být `codex_bridge` (podtržítko), jinak se nástroj nesurfacuje jako `mcp__codex_bridge__codex_turn` a allow-list relay agenta nebude souhlasit. Pokud `claude mcp list` ukazuje server ale **ne** `✓ Connected`, relay selže při prvním volání — oprav bridge dříve, než budeš pokračovat (viz Troubleshooting).
- Po registraci nebo úpravě agent souboru **restartuj Claude Code session**, aby byl nový MCP server a definice agenta načtena.

### Uložení identity a přechod ze starého formátu

Stav, transcript a zámek používají společný název `v2@<sha256 přesného conversation_id>` s příponami `.json`, `.transcript.jsonl` a `.lock`. Hash se počítá z UTF-8 bez změny velikosti písmen; `Review-A` a `review-a` jsou dvě samostatné konverzace i na Windows. Stav i nové řádky transcriptu obsahují původní `conversation_id`; při neshodě stavu bridge vrátí `STATE_IDENTITY_MISMATCH` bez volání Codexu. Pro vypsání cest spusť v adresáři bridge:

```powershell
node -e 'const p=require("./lib/paths"); for (const f of [p.stateFile,p.transcriptFile,p.lockDir]) console.log(f(process.argv[1]))' 'Review-A'
```

Starší soubory `<conversation_id>.json` se nemigrují automaticky. Dokud existují bez migračního záznamu, volání vrátí `LEGACY_MIGRATION_REQUIRED`; rozdílná velikost písmen nebo jiné nejednoznačné přiřazení vyvolá `LEGACY_IDENTITY_CONFLICT`. Bridge nezačne nové vlákno.

1. Zastav staré instance bridge a zazálohuj celý adresář stavu. Pro vlastní umístění nastav stejné `CODEX_BRIDGE_STATE_DIR` jako u bridge.
2. Ověř přesnou velikost písmen ID podle původního názvu souboru a orchestrátoru. Původní formát neukládal ID a na Windows mohl sloučit požadavky s různou velikostí písmen. Migrace je výslovné přiřazení zachovaného vlákna jednomu přesnému ID; sloučenou historii neumí rozdělit.
3. Z adresáře nainstalovaného bridge spusť `node migrate-state.js 'Review-A'`. Příkaz nevolá Codex, drží nový i původní zámek a vypíše JSON s cestou výsledného stavu.
4. Pokračuj se stejným přesným ID. Bridge obnoví původní `thread_id` a naváže na číslo tahu.

Migrace kopíruje transcript beze změny bajtů. Původní transcript zůstává zachován a původní stav je uložen v poli `original_state` uvnitř migračního záznamu ve starém souboru. Tento záznam zachovej: starému bridge zabrání pokračovat nad zastaralou kopií a novému umožní kontrolovat dokončenou migraci. Po migraci používej jen novou verzi bridge.

Opakování dokončené migrace nic nepřepíše. Přerušenou migraci lze zopakovat, pokud stále souhlasí původní a již zapsané cílové údaje. Při konfliktním cílovém stavu/transcriptu, chybějícím stavu nebo změně archivu příkaz skončí chybou a ponechá důkazy pro obnovu. Neodstraňuj stav ani záznam kvůli obejití chyby; nejprve podle zálohy a transcriptu ověř správné vlákno. Nedotčené konverzace se nemigrují.

---

## 2. Použití `codex-peer` v týmu

### Co to je
`codex-peer` je adresovatelný, reaktivní člen. Jiné sub-agenty s ním mluví přes `SendMessage`; přeposílá každou zprávu do Codexu přes bridge a vrací odpověď Codexu verbatim. Nikdy nereasonuje, nikdy neupravuje, nikdy neiniciuje.

### Konvence `CONV_ID:` (POVINNÉ — ty dodáváš klíč kontinuity)
On-disk klíč kontinuity (`conversation_id`) musí být **byte-identický** po celou konverzaci, včetně po re-instanciaci relay agenta s prázdným kontextem. Relay NEodvozuje ani nehaduje tento klíč — **adresující agent ho dodá explicitně** jako první řádek každé zprávy:

```
CONV_ID: <stable-id>
<skutečná zpráva pro Codex>
```

Relay extrahuje `<stable-id>` doslova, předá ho jako `conversation_id` a pošle vše za prvním řádkem jako `message`. Pokud vynecháš řádek `CONV_ID:`, relay vrátí hlasitou chybu `CODEX-BRIDGE ERROR: missing required CONV_ID ...` a nic jiného neudělá — klíč nikdy nevymyslí.

**Jak orchestrátor vybere stabilní id (udělej JEDNOU na začátku konverzace):**
- Zvol deterministický, konverzaci-unikátní string a opakovaně ho použij na KAŽDÉ zprávě po celou dobu výměny. Doporučená forma: `<team-name>--<task-id>` (např. `prd-50519-review--codex-cr1`).
- Vyber ho jednou na začátku, ulož ho na orchestrátorské straně a vlož stejný string v každém kole. Nikdy neregeneruj, nepřeváděj na malá písmena jinak, re-slug, nepřidávej timestamp nebo číslo kola — jakákoli změna zahájí nové Codex vlákno a tiše zničí kontinuitu.
- Udržuj ho unikátní napříč týmy/konverzacemi, aby se vlákna neprolínala (viz Troubleshooting „cross-project thread bleed").

### Jak ho jiný sub-agent adresuje
Z libovolného reasoning sub-agenta ve stejném týmu mu pošli zprávu jménem s `CONV_ID:` jako prvním řádkem. Reasoning strana vlastní konverzaci; `codex-peer` pouze odpovídá.

```
SendMessage(
  recipient: "codex-peer",
  message:   "CONV_ID: prd-50519-review--codex-cr1\nZkontroluj tento diff na off-by-one chyby:\n<diff zde>"
)
```

Odpověď, kterou dostaneš zpět, je pole `reply` od Codexu, verbatim. Považuj jeho obsah za Codexova slova, ne relay agenta.

### Jak vypadá dialog
```
reasoning-claude → codex-peer : "CONV_ID: prd-50519-review--codex-cr1\nZde je funkce X. Jsou tam chyby?"
codex-peer       → (codex_turn conv_id="prd-50519-review--codex-cr1", msg="Zde je funkce X. ...")
codex-peer       ← reply: "Řádek 12 vyhodí výjimku na prázdném vstupu protože ..."
reasoning-claude ← "Řádek 12 vyhodí výjimku na prázdném vstupu protože ..."   (verbatim)

reasoning-claude → codex-peer : "CONV_ID: prd-50519-review--codex-cr1\nDobře. Ukaž mi opravenou verzi."
codex-peer       → (codex_turn STEJNÉ conv_id, msg="Dobře. ...")  # stejné vlákno na disku
codex-peer       ← reply: "<opravená funkce>"
reasoning-claude ← "<opravená funkce>"                            (verbatim)
```
Protože orchestrátor posílá STEJNÝ `CONV_ID:` v každém kole, bridge drží kolo 2 na stejném Codex vláknu jako kolo 1 — Codex si pamatuje funkci X bez nutnosti ji znovu posílat.

### Omezení reactive-only (vynucuj na straně Claude)
- Codex (přes `codex-peer`) **nikdy neiniciuje** tah a nikdy neposílá nevyžádanou zprávu. Odpovídá pouze, když je osloven.
- Reasoning Claude sub-agent / orchestrátor **vlastní turn-taking**: rozhoduje co se ptát, kdy se ptát znovu a kdy skončit. Neexistuje autonomní Codex smyčka.
- To je důvod, proč je ukončení rozhodnutelné. Nesnaž se udělat z Codexu symetrického, self-driving peera (viz Limitations).

---

## 3. Terminace a bezpečnostní pravidla (MUSÍ vynucovat člověk/orchestrátor)

**Relay nevynucuje NIC.** Nemá Bash, timery, čítače, ani cost awareness — záměrně (je to čistá roura). Každá níže uvedená pojistka žije na reasoning Claude orchestrátoru a/nebo lidském operátorovi. Uveď tato pravidla jako stálé provozní pravidla pro každý tým, který zapojí `codex-peer`:

1. **Max-turns gilotina (tvrdý stop).** Zvol tvrdý strop na round-tripy k `codex-peer` za konverzaci (výchozí **8**). Počítej každý `SendMessage` k `codex-peer`. Po dosažení stropu PŘESTAŇ ho adresovat a uzavři — i když se výměna zdá nedokončená. Toto je tripwire, ne cíl.
2. **Kumulativní token / cost cap (POVINNÉ, ne nice-to-have).** Sleduj kumulativní tokeny/náklady na Codex straně napříč celou konverzací a nastav tvrdý limit. Toto je bezpečnostní pás proti přejetí přes noc. Pokud je cap dosažen, ukončí výměnu okamžitě. (Per-turn počty tokenů, pokud je vystavuje bridge transcript, krmí tento tally; pokud ne, cap na počtu kol místo toho a považuj to za budget.)
3. **Per-call idle timeout.** Jedno `codex_turn` volání může zatuchnout (zaseklý CLI tah). Vynuť wall-clock timeout per volání. Relay to nemůže dělat — bridge by měl na vlastní idle timeout hard-errorovat, a orchestrátor by také neměl čekat donekonečna na odpověď `SendMessage`. Pokud volání překročí timeout, považuj to za selhání kola (netikej tiše do nové session).
4. **Sémantický úsudek „jsme hotovi / točíme se v kruhu?"** Po každé Codex odpovědi musí reasoning Claude strana posoudit, zda je cíl splněn nebo zda jde výměna v kruhu, a pokud ano zastavit. Marker `<DONE>` (nebo podobný) od Codexu je **pouze poradní vstup**, nikdy automatický přepínač — smyčky zdvořilosti jinak spálí budget.

Pokud žádná z těchto pojistek není zapojená pro daný tým, nespouštěj open-ended Codex výměnu — spusť pevný, malý počet kol ručně.

---

## 4. Kritický akceptační test (design doc §7) — spustitelná procedura

**Co tento test dokazuje nebo zabíjí:** že kontinuita `thread_id` je skutečně udržována bridge na disku, NE v kontextu relay agenta. Test vynutí **compaction** relay agenta mezi koly a zkontroluje, že Codex si stále pamatuje kontext kola 1. Pokud ano, architektura je solidní. Pokud ne, design je rozbitý (kontinuita tajně žila v LLM kontextu).

### Setup
1. Potvrď, že všechny prerekvizity §1 projdou, zejména #1 (`...AGENT_TEAMS=1`) a #5 (`codex_bridge: ✓ Connected`).
2. Spusť čerstvou Claude Code session v týmu, který zahrnuje `codex-peer` a jeden reasoning sub-agent (tzv. „driver").
3. **Pevně nastav `CONV_ID` pro tento test na straně operátora a zapiš si ho.** Vyber jedno explicitní id a opakovaně ho použij v KAŽDÉM kole, např. `accept-test--codex-continuity-01`. Protože operátor nyní dodává klíč (relay nic neodvozuje), je toto id garantovaně byte-identické napříč koly — což přesně dělá níže z varianty (c) SKUTEČNÝ test on-disk kontinuity, nikoli test re-derivace id.
4. Vyber **tajný token**, který Codex nemůže uhodnout: náhodný string, např. `ACCEPT-7F3Q-MARMOT`. Zasadíš ho v kole 1 a požádáš o něj zpět v kole 3.

### Procedura (3 samostatné SendMessage round-tripy, s vynucenou compaction)

**Kolo 1 — zasaď kontext.** Nech driver poslat `codex-peer` (poznámka: povinný `CONV_ID:` první řádek, s id které jsi pevně nastavil v Setup kroku 3):
> "CONV_ID: accept-test--codex-continuity-01
> Zapamatuj si toto pro náš pozdější rozhovor: můj akceptační token je
> `ACCEPT-7F3Q-MARMOT`. Jen potvrď, že sis to poznamenal."

Potvrď, že odpověď přišla verbatim a token potvrzuje. Potvrď, že relay zavolal `codex_turn` s `conversation_id="accept-test--codex-continuity-01"` (viditelné v args volání a v bridge transcriptu na `C:\Users\ai\.claude\state\codex-bridge\v2@<sha256>.transcript.jsonl`).

**Kolo 2 — normální, nesouvisející tah.** Pošli `codex-peer` (STEJNÝ `CONV_ID:`):
> "CONV_ID: accept-test--codex-continuity-01
> Nesouvisející rychlá otázka: kolik je 17 + 25?"

Potvrď, že přišla rozumná odpověď (`42`). Toto dokazuje, že vlákno je živé a stále na stejném `conversation_id` jako kolo 1.

**VYNUTÍ COMPACTION relay agenta mezi koly 2 a 3.** Toto je jádro testu — musíš smazat in-context paměť relay agenta. Použij co je dostupné, v tomto pořadí preference:
- (a) Spusť compaction Claude Code na kontextu relay agenta přímo (např. mechanismus `/compact` session aplikovaný tak, aby byl history konverzace agenta `codex-peer` compactován/shrnutý pryč). NEBO
- (b) Pokud nemůžeš cílit relay specificky, pohyb dostatek meziprovozu aby byl kontext relay agenta compactován harnesem automaticky (sleduj compaction event v session). NEBO
- (c) Nejsilnější varianta, teď co je klíč operátor-pevný: ukonči session úplně a spusť novou. Re-instancuj relay s prázdným kontextem a pošli kolo 3 se **stejným explicitním `CONV_ID:`** jak jsi použil v kolech 1–2. Protože TY dodáváš klíč (relay nic neodvozuje), toto je čistý test pure on-disk kontinuity: čerstvě narozený relay s nulovou pamětí na kola 1–2 stále routuje na stejné Codex vlákno.

Podstatný požadavek: po tomto kroku relay agent NESMÍ mít kola 1–2 ve svém vlastním kontextu. Ověř potvrzením, že compaction/re-instanciace skutečně proběhla.

**Kolo 3 — vyžádej zasazený kontext zpět.** Pošli `codex-peer` (STEJNÝ `CONV_ID:`):
> "CONV_ID: accept-test--codex-continuity-01
> Jaký byl akceptační token, který jsem tě požádal zapamatovat si na začátku našeho
> rozhovoru? Odpověz pouze tokenem."

### Kritérium pass / fail (jednoznačné)
- **PASS** ⟺ VŠECHNA z následujících platí:
  1. odpověď v kole 3 obsahuje přesný token `ACCEPT-7F3Q-MARMOT`;
  2. compaction (nebo re-instanciace relay / čerstvá session) demonstrativně nastala před kolem 3;
  3. operátor poslal **identickou** hodnotu `CONV_ID:` ve všech třech kolech; a
  4. bridge transcript ukazuje všechna tři kola zalogovaná pod jedním `conversation_id` s jediným stabilním `thread_id`.
  Codex si pamatoval kontext kola 1, který čerstvě narozený relay nemohl držet → kontinuita žije na bridge klíčovaném operátor-dodaným id. Design validován.
- **FAIL** ⟺ odpověď v kole 3 neobsahuje token (Codex říká, že neví, nebo hádá špatně) **přestože** byl stejný `CONV_ID:` posílán v každém kole a compaction/re-instanciace proběhla. Protože klíč byl operátor-pevný a byte-identický, toto izoluje selhání na bridge: kontinuita byla ztracena přes compaction → bridge NE drží `thread_id` na disku jak je požadováno, NEBO tiše byla zahájena nová session. Toto zabíjí design jak je postavený; oprav bridge (viz Troubleshooting „silent amnesia") dříve než se budeš spoléhat na `codex-peer`.
  - Poznámka: pokud je odpověď v kole 3 místo toho `CODEX-BRIDGE ERROR: missing required CONV_ID ...`, je to chyba TEST-HARNESS, ne selhání designu — zapomněl jsi `CONV_ID:` první řádek v kole 3. Znovu pošli s ním a opakuj.

### Důkazy k zachycení
- Tři relay odpovědi (kolo 1, 2, 3).
- Důkaz, že compaction/re-instanciace proběhla (oznámení nebo čerstvá instance).
- Transcript soubor ukazující jeden stabilní `conversation_id`/`thread_id` napříč všemi třemi koly.

---

## 5. Troubleshooting

| Symptom | Příčina (dle design doc) | Oprava |
|---|---|---|
| **Tichá amnézie** — Codex se chová jako cizinec na follow-up; recall tokenu v kole 3 selže přestože odpovědi vypadají zdravě | §2 / §4.1.4: `thread_id` byl držen v LLM kontextu (nebo relay změnil `conversation_id`) a byl ztracen při compaction; nebo bridge tiše zahájil NOVOU session místo errorování | Potvrď, že bridge persistuje `thread_id` do `~/.claude/state/codex-bridge/v2@<sha256>.json` a znovupoužívá ho; potvrď, že relay předává konstantní `conversation_id` (zkontroluj `transcript.jsonl` — id musí být identické v každém tahu). Bridge musí HARD-ERROROVAT, když nemůže obnovit session, nikdy nespustí novou. |
| **Stdout pollution** — relay/tool call selže s JSON parse / protocol errors, zkomolenými MCP odpověďmi | §6: CLI bannery / `Write-Host` / non-protocol chatter unikl na **stdout**; stdio MCP vyžaduje, aby stdout nesl POUZE newline-delimited JSON | Veškerý CLI chatter musí jít na **stderr**; emituj UTF-8 **bez BOM**, LF line endings. Oprava na straně bridge. Ověř spuštěním bridge příkazu ručně a potvrď, že stdout je čisté JSON-RPC. |
| **Windows shim launch failure** — bridge nemůže spustit Codex; hang nebo "process exited" bez odpovědi | §6: `codex` je `.cmd` shim; bare `CreateProcess` na něm selže nebo zatuče | Spouštěj přes `cmd /c codex …` nebo absolutní cestu k `.cmd` (např. `C:\Users\<user>\AppData\Roaming\npm\codex.cmd`). Oprava na straně bridge. |
| **Cold-start race** — první tah vrátí prázdno / timeout / "no session yet", pozdější tahy fungují | §6/§4.1.4: první volání závodí se spawnem `codex mcp-server`; příliš rychlý bridge vrátí dříve než dostane první reálnou odpověď | Bridge musí **blokovat až do první reálné odpovědi** a hard-errorovat při timeout — nikdy nevrátit fake / fresh-session placeholder. Oprava na straně bridge. |
| **Cross-project / cross-thread bleed** — odpovědi z jiného týmu/konverzace se prolínají | §4.2/§8.3: dvě konverzace kolidovaly na stejném `conversation_id`, nebo sdílejí jeden `codex mcp-server` proces | Ujisti se, že operátor-dodaný `CONV_ID:` je unikátní per tým/konverzace. Ověř `transcript.jsonl` na proložené tahy z nesouvisejících témat. |
| **Relay editorizuje** — odpověď je shrnutá/přeformátovaná, kód/diff zmrzačen | §2: relay LLM „zlepšil" výstup místo přeposlání | Selhání relay-promptu. Agent prompt to explicitně zakazuje; pokud se opakuje, integritně kritická data jsou stále nedotčená v **tool resultu** (`reply` pole) / `transcript.jsonl` — vytáhni je odtud. |
| **Nástroj nenalezen** — relay erroruje, že `mcp__codex_bridge__codex_turn` není dostupný | §1 prereq #5: bridge není zaregistrován, server špatně pojmenován, nebo session nebyla restartována | Spusť `install.ps1`; potvrď, že `claude mcp list` ukazuje `codex_bridge: ✓ Connected`; restartuj Claude Code session. Název serveru musí být přesně `codex_bridge`. |

---

## 6. Honest limitations

- **Adresovatelný člen ≠ symetrický peer.** `codex-peer` je „Claude řídí nástroj s visačkou jména", ne autonomní spoluhráč. Turn-taking, cíl a ukončení všechny žijí na Claude straně. Codex je reactive-only ve v1 — nikdy neiniciuje, protože jinak by nikdo nevlastnil rozhodnutí zastavit.
- **„Verbatim" je best-effort.** Relay je LLM; prompt zakazuje úpravy, ale věrnost není byte-garantovaná. Pro cokoliv integritně kritického (diffy, kód, strukturovaný výstup) je autoritativní kopie **tool result pole `reply`** a bridge `transcript.jsonl`, ne próza relay agenta.
- **Žádná self-vynucená bezpečnost.** Relay nedrží žádný stav a nevynucuje žádné limity. Všechna ukončení, cost, timeout a loop pojistky (§3) jsou zodpovědností orchestrátoru/člověka.
- **Klíč kontinuity dodává operátor, ne relay.** Relay neslugguje ani nehaduje `conversation_id` — adresující agent MUSÍ poslat `CONV_ID: <stable-id>` jako první řádek, a relay ho extrahuje verbatim (viz §2). To je záměrné: disk-state klíč musí být byte-identický napříč relay re-instanciací, a LLM je špatná komponenta pro jeho rekonstrukci.
- **v1 izolace je pouze na úrovni vlákna — NE na úrovni procesu/cwd/sandboxu.** V tomto milníku bridge obsluhuje VŠECHNY konverzace JEDNÍM sdíleným `codex mcp-server` procesem; separace mezi konverzacemi je pouze logické `conversation_id`/`thread_id` klíčování, nikoli OS-level process isolace. Pracovní adresář Codexu je **nedeterministický** pod user-scope spuštěním a sandbox je **read-only**. NEROZSIRUJ sandbox, dokud bridge neposkytne per-conversation process isolation + working-directory allow-list.
- **Globální scope = izolační závazky.** Bridge běží jako persistentní MCP daemon napříč všemi projekty. Kontinuita je klíčována `conversation_id`, takže drž `CONV_ID:` každé konverzace unikátní, aby nedocházelo k thread bleed, a respektuj read-only sandbox bridge dokud nepřijde per-conversation isolace.
