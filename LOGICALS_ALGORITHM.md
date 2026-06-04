# Logicals-Rätselgenerator — Algorithmus & Parameter

Dieses Dokument beschreibt die interne Funktionsweise von `logicals.html`: wie
die Gitter erzeugt werden, wie die Hinweise ausgewählt werden, wie der Solver
arbeitet und wie das Zeit-Turnier die Hinweiszahl (= Schwierigkeit) minimiert.

## Spielregeln

Vorlage ist das deutsche Heft „LOGISCH Spezial / Logicals":

- 6 × 6 Gitter, beschriftet mit Spalten 1–6 und Reihen A–F.
- Die Zahlen 1 bis 9 werden jeweils genau viermal eingetragen.
- Gleiche Zahlen grenzen waagerecht und senkrecht **nie** aneinander
  (diagonal erlaubt).
- Pro Reihe bzw. Spalte sind die Zahlen **standardmäßig verschieden**.
  Kommt eine Zahl mehrfach vor, wird das explizit als Hinweis genannt
  („Die N kommt doppelt vor").

Hinweistypen, die der Generator erzeugt:

| Typ            | Beispieltext                                                         |
|----------------|----------------------------------------------------------------------|
| `duplicate`    | „Die 5 kommt doppelt vor."                                           |
| `pairSum`      | „A3 plus A4 ergibt 11."                                              |
| `totalSum`     | „Die Summe aller sechs Zahlen lautet 38."                            |
| `directSequence`   | „… direkt aufsteigend angeordnet (lückenlos, z. B. 3-4-5-6-7-8)."  |
| `directDescending` | „… direkt absteigend angeordnet (lückenlos, z. B. 8-7-6-5-4-3)."   |
| `ascending`        | „… aufsteigend angeordnet (ggf. mit Lücken)."                      |
| `descending`       | „… absteigend angeordnet (ggf. mit Lücken)."                       |

## Architektur

Der Code ist auf drei lokale Skripte aufgeteilt, die `logicals.html` in dieser
Reihenfolge lädt (klassische Skripte, keine ES-Module — damit der
`file://`-Smoke-Test funktioniert): `qrcode.min.js` (vendorte QR-Bibliothek),
`logicals.solver.js` (reine Rätsellogik, DOM-frei: Konstanten, Rätselcode-
Encoding, `workerCode`, Difficulty-Scoring, `solveWithTrace`) und
`logicals.app.js` (DOM, Worker-Orchestrierung, UI). Ladereihenfolge ist
bindend: `logicals.app.js` baut `WORKER_SRC` zur Ladezeit aus
`workerCode.toString()`, also muss `logicals.solver.js` vorher geladen sein.

Die Erzeugung läuft in **Web Workers** (`workerCode()`, per
`Blob` + `URL.createObjectURL` als Worker-Skript geladen). Bis zu 4 Worker
laufen parallel als **Zeit-Turnier**: jeder erzeugt und minimiert
fortlaufend Rätsel und meldet immer dann eines, wenn es weniger Hinweise hat
als sein bisher bestes. Der Hauptthread hält über alle Worker das globale
Minimum, zeigt es live an und beendet die Worker nach Ablauf des Zeitbudgets
(oder per „Übernehmen", oder bei Stagnation). Siehe „Suchstrategie &
Schwierigkeit".

Der Hauptthread kümmert sich um UI, Encoding/Decoding des **Rätselcodes**
(Crockford-Base32, 31–42 Zeichen mit Prüfsumme — enthält die Hinweise, nicht
die Lösung) und die Worker-Verwaltung.

## Gitter-Generierung

Datei-Funktionen: `decideSequences`, `applySequencesToGrid`, `generateGrid`.

1. **Sequenz-Vorabbelegung**: Pro Rätsel werden 1–3 Reihen oder Spalten
   zufällig als Sequenz-Linien festgelegt (der Worker würfelt die Anzahl je
   Versuch). Jede Sequenz erhält einen zufälligen Typ und konkrete Werte
   (Verteilung ~17,5 / 17,5 / 33 / 32 %):
   - `directSequence`: aufeinanderfolgende Zahlen aufsteigend (1–6,
     2–7, 3–8 oder 4–9).
   - `directDescending`: aufeinanderfolgende Zahlen absteigend
     (6–1, 7–2, 8–3 oder 9–4).
   - `ascending` / `descending`: 6 zufällige unterschiedliche Werte aus 1–9,
     auf- bzw. absteigend sortiert.
2. Die Sequenz-Werte werden ins Gitter eingetragen und auf Konflikte
   geprüft (Adjazenz, Zähler ≤ 4 pro Zahl).
3. **Backtracking mit „prefer fresh values"-Heuristik**: Die restlichen
   Zellen werden mit normaler Backtracking-Suche gefüllt. Pro Zelle werden
   gültige Kandidaten gesammelt und nach `(Vorkommen-in-Reihe +
   Vorkommen-in-Spalte)` aufsteigend sortiert; frische Werte (Score 0)
   werden zuerst ausprobiert. Damit entstehen Gitter mit deutlich weniger
   Dopplungen — die `gridQualityOK`-Pass-Rate steigt von ca. 0,1 % auf
   ca. 67 %.
4. **Qualitätsfilter** `gridQualityOK`: pro Reihe/Spalte höchstens eine
   doppelt vorkommende Zahl, keine 3+-fachen Vorkommen, höchstens 5
   Linien mit Dopplung im Gitter insgesamt.

Wenn der Generator nach 20 × 8 Sequenz/Backtracking-Versuchen kein gültiges
Gitter findet, gibt er `null` zurück; der Worker geht zum nächsten Versuch.

## Akzeptanzkriterium: deduzierbar, nicht nur eindeutig

Der entscheidende Punkt: ein Rätsel mit **eindeutiger** Lösung ist nicht
automatisch **deduzierbar**. Eindeutigkeit heißt nur „es existiert genau eine
Lösung" — die kann trotzdem nur per Raten/Backtracking auffindbar sein. Ein
Mensch, der alle Hinweise und Default-Regeln ausgereizt hat und nicht
weiterkommt, sitzt vor einem solchen Rätsel.

Deshalb akzeptiert der Generator ein Rätsel nur, wenn es der **reine
Propagations-Solver** `logicalSolve` vollständig löst — also ohne jede
Fallunterscheidung. Weil jede Elimination von `logicalSolve` in *jeder* Lösung
gültig ist, ist eine vollständig bestimmte Lösung zugleich der **Beweis der
Eindeutigkeit**. `logicalSolve` ist damit die einzige Prüfinstanz; ein
separater Backtracking-Solver wird nicht mehr gebraucht (und wäre im
hinweisarmen Regime ohnehin unzuverlässig — er lief dort in Timeouts).

## Solver (`logicalSolve`)

Funktion: `logicalSolve(selected)`. Reiner Constraint-Propagations-Solver:
er wendet ausschließlich **sichere Deduktionen** bis zum Fixpunkt an und
**rät nie**. Domains sind Bitmasken (`Int32Array`, Bits 0–8 = Werte 1–9).
Pro Durchlauf werden angewandt:

- **Naked Singles + Adjazenz**: Eine fix bestimmte Zelle verbietet ihren
  Wert in den vier H/V-Nachbarn.
- **Zeilen-/Spalten-Distinktheit**: Pro Reihe/Spalte gilt jeder Wert höchstens
  einmal (Obergrenze). Eine **untere** Schranke gibt es pro Linie nur für den
  Dopplungs-Wert (genau zweimal) — daraus folgt für ihn auch ein „Hidden
  Single". Achtung: Eine 6er-Linie enthält nur 6 der 9 Werte, es gibt also
  **keine** Sudoku-artige „jeder Wert kommt vor"-Schranke.
- **Globale Anzahl**: Jeder Wert kommt genau 4× im Gitter vor (Ober- und
  Unterschranke über alle 36 Zellen).
- **pairSum-Bogenkonsistenz**: Für `A + B = s` behält jede der beiden Zellen
  nur Werte, zu denen der Partner einen passenden Komplementärwert hat.
- **totalSum-Schrankenpropagation**: Pro Linie mit bekannter Gesamtsumme
  werden Zellwerte über Min/Max-Summen der übrigen Zellen eingegrenzt.
- **Sequenzen**: `directSequence` propagiert `Zelle[k+1] = Zelle[k] + 1`
  (Domain per `<<1`); `directDescending` analog `Zelle[k+1] = Zelle[k] - 1`
  (Domain per `>>1`); `ascending` / `descending` propagieren die
  Monotonie-Schranken (Min/Max) entlang der Linie.

`logicalSolve` liefert `{ solved, grid }`. `solved === true` bedeutet: alle
36 Zellen sind auf genau einen Wert bestimmt — Rätsel deduzierbar **und**
eindeutig. Eine leergelaufene Domain (`bad`) heißt Widerspruch → `false`.

## Hinweis-Auswahl (`pickClues`)

Funktion: `pickClues(grid, cfg)`. Die App ruft sie **immer mit
`{ targetClues: 0 }`** auf — also volle Minimierung; die eigentliche
Schwierigkeitssteuerung übernimmt das Zeit-Turnier (siehe unten).

1. **Mit allen Kandidaten starten**: Für jede Reihe/Spalte werden alle
   anwendbaren Hinweise (1 duplicate bei Dopplung, alle pairSum, 1 totalSum,
   ggf. 1 Sequenz) ins Set gelegt — ~70–78 Hinweise. **Gate**: wenn schon
   dieses Maximalset nicht deduzierbar ist (`logicalSolve`), Gitter verwerfen.
2. **Phase 1 — maximal reduzieren**: In mehreren Durchläufen wird jeder
   entfernbare Hinweis probeweise gelöscht und nur dann entfernt, wenn das
   Rätsel deduzierbar bleibt. Reihenfolge: vollste Linien zuerst (das ebnet
   die Verteilung ein), und je Linie totalSum vor pairSum (Sequenzen und
   Mandatory-Duplikate werden geschont). Ergebnis: ein nahezu minimales,
   gleichmäßig verteiltes Hinweisset. **Weil totalSum zuerst weicht,
   verschwinden totalSum-Hinweise bei voller Minimierung praktisch immer.**
3. **Phase 2 — auf `cfg.targetClues` auffüllen** (nur falls > aktueller Zahl,
   also bei der reinen Minimierung der App **inaktiv**): entfernte Kandidaten
   werden auf die leersten Linien zurückgelegt. Legacy-Pfad für einen festen
   Hinweis-Zielwert.
4. **Σ-Cap**: Höchstens 5 totalSum-Hinweise (greift nur, wenn Phase 2 welche
   zurückgelegt hätte).
5. **Anzeige-Sortierung** pro Linie: duplicate, Sequenz, pairSums
   (positionsweise), totalSum.

Da jede Entfernung über `logicalSolve` geprüft wird, ist jedes Ergebnis ohne
Raten lösbar. Ein einzelner Reduktionslauf landet in *einem* lokalen Minimum
(~19 Hinweise im Schnitt, Streuung min ~11 … max ~26); das Turnier nutzt diese
Streuung aus.

## Rätselcode

Das Rätsel — **nicht** die Lösung — wird in einem Crockford-Base32-Code
verpackt (Alphabet `0–9 A–Z` ohne `I L O U`, Bindestriche in 4er-Blöcken).
Der Empfänger rekonstruiert die Lösung lokal aus den Clues per
`solveWithTrace` (der Generator garantiert Lösbarkeit per reiner Deduktion).

Bit-Layout (`encodePuzzle` / `decodePuzzle`):

- 4 Bit Version (0)
- **pairSum**: 60-Bit-Bitmap (Indizes 0..29 = horizontale Paare zeilenmajor,
  30..59 = vertikale Paare spaltenmajor) + 4 Bit pro gesetztem Bit für den
  Summenwert (3..17 → 0..14)
- **totalSum**: 12-Bit-Bitmap (0..5 = Reihen, 6..11 = Spalten) + 6 Bit pro
  gesetztem Bit (6..54 → 0..48)
- **duplicate**: 12-Bit-Bitmap + 4 Bit pro gesetztem Bit (1..9 → 0..8)
- **sequence**: 12-Bit-Bitmap + 2 Bit pro gesetztem Bit
  (0=directSequence, 1=ascending, 2=descending, 3=directDescending)
- 8 Bit Prüfsumme (Summe aller vorigen Daten-Bytes mod 256)

Gesamtlänge 152–200 Bit ≙ **31–42 Base32-Zeichen** je nach Hinweisdichte
(Median ~37 bei Default-Einstellungen). Beim Eingabefeld werden
Kleinbuchstaben, Bindestriche und Leerzeichen toleriert. Ungültige Codes
werden über die Prüfsumme erkannt.

## Lösungsweg (Schritt für Schritt, Kandidaten-Darstellung)

Funktion: `solveWithTrace(clues)` (Hauptthread). Eigenständige, **tracende
Variante von `logicalSolve`** — gleiche Regeln, aber jede **Regelanwendung, die
Kandidaten entfernt, ergibt einen Schritt**: `{ reason, removals:[{idx,vals}],
solved:[idx] }`. Sie löst **allein aus den Clues** (liest nie
`currentPuzzle.grid`) und liefert `{ solved, steps, grid }`. Typisch ~100–120
Schritte pro Rätsel.

Die Darstellung ist **Sudoku-artig mit Pencil-Marks**: jede Zelle zeigt ihre
noch möglichen Ziffern (3×3-Raster); pro Schritt werden die durch die Regel
entfernten Kandidaten durchgestrichen und verschwinden danach. Erreicht eine
Zelle genau einen Kandidaten, wird sie als große Ziffer „gelöst" dargestellt.
So wird z. B. „A5 = 9 aus A5+B5=14" nachvollziehbar, weil man B5s schon
eingeschränkte Kandidaten sieht.

`renderStep` spielt die `removals` der ersten N Schritte auf volle Domains
(1–9) zurück, um den Kandidatenstand bei Schritt N zu zeigen. Bedienung
(`enterStepMode`/`renderStep`/`stepNext`/`stepPrev`/`stepReset`/`togglePlay`/
`exitStepMode`): Vor/Zurück/Zurücksetzen + Abspielen (~400 ms/Schritt) und eine
mitlaufende, klickbare Schrittliste mit Begründung + entfernten Werten.

**Wichtig:** `solveWithTrace` muss die Regeln von `logicalSolve` spiegeln — bei
Solver-Änderungen beide anpassen. Sicherheitsnetz: stimmt `grid` nicht mit der
bekannten Lösung überein (Drift/Bug), wird der Schritt-Modus übersprungen und
die Lösung direkt eingeblendet. Validierung headless via Node-Kopie der
Funktion (Brace-Matching extrahieren): gelöst, zurückgespielte `removals` ==
Lösung, kein Entfernen abwesender Werte, keine geleerte Domain.

## Suchstrategie & Schwierigkeit (Zeit-Turnier)

Es gibt **keine festen Schwierigkeitsstufen** mehr. Stattdessen bestimmt die
**Hinweiszahl** die Schwierigkeit (weniger Hinweise ⇒ schwerer), und die
**Suchzeit** bestimmt, wie weit minimiert wird.

Worker-Schleife (`self.onmessage`, läuft endlos bis `terminate()`):

1. Sequenzanzahl bestimmen (laut Config oder zufällig 1–3), Gitter erzeugen
   (`generateGrid(numSeq, maxDupLines)`),
2. `pickClues(grid, { targetClues: 0, numSequences, minTotalSum })` →
   minimales deduzierbares Set unter Beachtung der erzwungenen Typen,
3. nur posten, wenn die Hinweiszahl unter dem bisher besten Wert liegt
   (`threshold` erlaubt, bei „Weiter suchen" nur echte Verbesserungen zu
   melden).

Hauptthread (`startSearch` / `searchTick` / `finishSearch`):

- Standard-Budget **~6 s** (`DEFAULT_BUDGET_MS`), „Weiter suchen" hängt
  jeweils **+10 s** an (`EXTEND_MS`).
- **Adaptiver Frühstopp**: keine Verbesserung seit `STALL_MS` (2,5 s) und
  mindestens `MIN_MS` (3 s) gelaufen → Suche beenden.
- **„Übernehmen"** beendet sofort und nimmt das aktuell beste Rätsel.
- Fortschrittsbalken läuft über die Zeit; der Status zeigt live die kleinste
  bisher gefundene Hinweiszahl und die Versuchszahl.

Mehr Suchzeit ⇒ weniger Hinweise ⇒ schwerer. Die Hinweiszahl wird am Rätsel
und im Druck angezeigt.

### Konfigurierbare Hinweis-Typen

Ein einklappbares „Einstellungen"-Feld liefert eine Config, die der Hauptthread
(`readConfig`) je Suche an alle Worker schickt (bei „Weiter suchen" wird
dieselbe Config wiederverwendet):

- **`numSequences`** (`zufällig` oder 0–3): so viele Sequenz-Linien werden ins
  Gitter eingestreut **und** in `pickClues` geschützt. Der Zufallsfüller
  erzeugt gelegentlich *zusätzliche* Sequenz-Linien; da `pickClues` nur N
  Sequenzen schützt und der Rest entfernbar ist, entspricht die angezeigte
  Anzahl der Einstellung (selten +1, falls eine zufällige Sequenz für die
  Deduzierbarkeit gebraucht wird).
- **`minTotalSum`** (0–3): so viele `totalSum`-Hinweise werden geschützt
  (sonst entfernt die Minimierung sie praktisch immer). Kostet je ~1 Hinweis.
- **`maxDupLines`** (0–5): Obergrenze für Dopplungslinien im Gitter
  (`gridQualityOK`). 0 = nie „kommt doppelt vor".

Geschützte Hinweise tragen in `pickClues` ein `keep`-Flag und werden — wie
Mandatory-Duplikate — nicht entfernt. `pairSum` ist bewusst nicht
konfigurierbar (Rückgrat der Lösbarkeit; die Minimierung lässt genau die
nötige Menge übrig). Strenge Kombinationen (viele Sequenzen, erzwungene
totalSums, wenige Dopplungen) senken die Trefferquote der Gittererzeugung.

## Performance

`logicalSolve` ist im hinweisarmen Regime schnell **und** zuverlässig
(Polynomialzeit-Fixpunkt statt exponentieller Suche). Ein Versuch (Gitter
erzeugen + voll minimieren) liegt bei ~6 ms; ein Thread schafft also
~150–170 Versuche/s, vier Worker entsprechend ~600/s.

Typische Ergebnisse des Turniers (4 Worker): nach ~1–2 s ~13–14 Hinweise,
nach ~6 s ~11–12 Hinweise. Danach stark abnehmender Grenznutzen — die letzten
1–2 Hinweise kosten überproportional Zeit, weshalb „Weiter suchen" optional
ist. Das erste gültige Rätsel erscheint binnen Millisekunden; der
Frühstopp beendet die Suche meist deutlich vor Ablauf des Budgets.

## Manuelle Rätseleingabe

Aufklappbares `<details>`-Panel im UI mit 12 Eingabefeldern (Reihen A–F,
Spalten 1–6). Pro Linie mehrere Hinweise mit `;` oder `,` getrennt. Whitespace
beliebig, Groß-/Kleinschreibung egal.

### Syntax

| Hinweistyp                          | Eingabe                                          | Beispiel       |
|-------------------------------------|--------------------------------------------------|----------------|
| Paarsumme                           | `Zelle+Zelle=Wert` (voll qualifiziert)           | `A3+A4=11`     |
| Gesamtsumme der Linie               | `SUM=Wert` (auch `Σ=Wert`)                       | `SUM=29`       |
| Doppelte Zahl                       | `Wertx2`, `Wertx`, `2xWert` oder `Wert²`         | `5x2` / `5²`   |
| Direkt aufsteigend (lückenlos)      | `RUN ASC`                                        | `RUN ASC`      |
| Direkt absteigend (lückenlos)       | `RUN DESC`                                       | `RUN DESC`     |
| Aufsteigend mit Lücken              | `ASC`                                            | `ASC`          |
| Absteigend mit Lücken               | `DESC`                                           | `DESC`         |

### Validierung (`parseManualLine` → `loadManualPuzzle`)

- Paarzellen müssen orthogonal benachbart sein.
- Paarzellen müssen beide im aktuellen Linienkontext liegen
  (Reihe-A-Feld → beide Zellen mit `A…`; Spalte-3-Feld → beide Zellen
  mit `…3`).
- Wertebereiche: pairSum 3–17, totalSum 6–54, duplicate 1–9.
- Pro Linie höchstens eine totalSum / ein Duplikat / eine Sequenz.
- Alle Feldfehler werden gesammelt und gemeinsam angezeigt; betroffene
  Inputs bekommen die Klasse `field-bad`.

### Politik bei nicht-deduzierbaren Eingaben

**Hart abgelehnt** — wenn `solveWithTrace` die Clue-Menge nicht zu einer
vollständigen Lösung propagiert, blockt der Loader mit einer Fehlermeldung
ab. Kein Backtracking-Fallback (vgl. „Akzeptanzkriterium"-Abschnitt oben);
Magazinrätsel sind in der Regel deduzierbar, und unser Solver-Coverage ist
der Vertrag.

### Erfolgsfall

Bei akzeptiertem Rätsel: `currentPuzzle` wird mit Gitter (aus `solveWithTrace`),
Hinweisen und frisch erzeugtem `encodePuzzle`-Code befüllt; `renderPuzzle`
zeigt das Rätsel wie ein generiertes; der Code ist sofort teilbar (QR + URL).
