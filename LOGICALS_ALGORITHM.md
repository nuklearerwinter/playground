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
| `directSequence` | „… direkt aufeinanderfolgend angeordnet."                          |
| `ascending`    | „… aufsteigend angeordnet (ggf. mit Lücken)."                        |
| `descending`   | „… absteigend angeordnet (ggf. mit Lücken)."                         |

## Architektur

Die Erzeugung läuft in **Web Workers** (`workerCode()` im Quelltext, per
`Blob` + `URL.createObjectURL` als Worker-Skript geladen). Bis zu 4 Worker
laufen parallel als **Zeit-Turnier**: jeder erzeugt und minimiert
fortlaufend Rätsel und meldet immer dann eines, wenn es weniger Hinweise hat
als sein bisher bestes. Der Hauptthread hält über alle Worker das globale
Minimum, zeigt es live an und beendet die Worker nach Ablauf des Zeitbudgets
(oder per „Übernehmen", oder bei Stagnation). Siehe „Suchstrategie &
Schwierigkeit".

Der Hauptthread kümmert sich um UI, Encoding/Decoding des Lösungscodes
(Crockford-Base32, 31 Zeichen mit Prüfsumme) und die Worker-Verwaltung.

## Gitter-Generierung

Datei-Funktionen: `decideSequences`, `applySequencesToGrid`, `generateGrid`.

1. **Sequenz-Vorabbelegung**: Pro Rätsel werden 1–3 Reihen oder Spalten
   zufällig als Sequenz-Linien festgelegt (der Worker würfelt die Anzahl je
   Versuch). Jede
   Sequenz erhält einen zufälligen Typ (directSequence / ascending /
   descending) und konkrete Werte:
   - `directSequence`: ein 6er-Block aus aufeinanderfolgenden Zahlen (1–6,
     2–7, 3–8 oder 4–9).
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
- **Sequenzen**: directSequence propagiert `Zelle[k+1] = Zelle[k] + 1`
  (per Bit-Shift), ascending/descending propagieren die Monotonie-Schranken
  entlang der Linie.

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

## Lösungscode

Die fertige Matrix wird in einem **31-Zeichen-Crockford-Base32-Code**
verpackt (Alphabet `0–9 A–Z` ohne `I L O U`):

- 36 Zellen × 4 Bit = 144 Bit
- + 8 Bit Prüfsumme = 152 Bit
- gepadded auf 155 Bit = 31 Base32-Zeichen
- mit Bindestrichen in 4er-Blöcken dargestellt

Beim Eingabefeld werden Kleinbuchstaben, Bindestriche und Leerzeichen
toleriert. Ungültige Codes werden über die Prüfsumme erkannt.

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
