# Logicals-Rätselgenerator — Algorithmus & Parameter

Dieses Dokument beschreibt die interne Funktionsweise von `logicals.html`: wie
die Gitter erzeugt werden, wie die Hinweise ausgewählt werden, wie der Solver
arbeitet und wie sich die drei Schwierigkeitsstufen voneinander unterscheiden.

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
arbeiten parallel — der erste, der ein gültiges Rätsel findet, gewinnt; die
anderen werden terminiert.

Der Hauptthread kümmert sich um UI, Encoding/Decoding des Lösungscodes
(Crockford-Base32, 31 Zeichen mit Prüfsumme) und die Worker-Verwaltung.

## Gitter-Generierung

Datei-Funktionen: `decideSequences`, `applySequencesToGrid`, `generateGrid`.

1. **Sequenz-Vorabbelegung**: Pro Rätsel werden 1–3 Reihen oder Spalten
   zufällig als Sequenz-Linien festgelegt (siehe Tabelle weiter unten). Jede
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

## Hinweis-Auswahl (REDUCE + Rebalance)

Funktion: `pickClues(grid, cfg)`.

1. **Mit allen Kandidaten starten**: Für jede Reihe/Spalte werden alle
   anwendbaren Hinweise (1 duplicate bei Dopplung, alle pairSum, 1 totalSum,
   ggf. 1 Sequenz) ins Set gelegt — ~70–78 Hinweise. **Gate**: wenn schon
   dieses Maximalset nicht deduzierbar ist (`logicalSolve`), Gitter verwerfen.
2. **Phase 1 — maximal reduzieren**: In mehreren Durchläufen wird jeder
   entfernbare Hinweis probeweise gelöscht und nur dann entfernt, wenn das
   Rätsel deduzierbar bleibt. Reihenfolge: vollste Linien zuerst (das ebnet
   die Verteilung ein), und je Linie totalSum vor pairSum (Sequenzen und
   Mandatory-Duplikate werden geschont). Ergebnis: ein nahezu minimales,
   gleichmäßig verteiltes Hinweisset.
3. **Phase 2 — für leichtere Stufen wieder auffüllen**: Solange weniger als
   `cfg.targetClues` Hinweise vorhanden sind, werden entfernte Kandidaten auf
   die **leersten** Linien zurückgelegt (balanciert das Layout). Zusätzliche
   Hinweise können Deduzierbarkeit nie zerstören. Schwer nutzt `targetClues:
   0` → bleibt minimal.
4. **Σ-Cap**: Höchstens 5 totalSum-Hinweise; überschüssige werden entfernt,
   solange Deduzierbarkeit erhalten bleibt, sonst Gitter verwerfen.
5. **Anzeige-Sortierung** pro Linie: duplicate, Sequenz, pairSums
   (positionsweise), totalSum.

Da jede Entfernung über `logicalSolve` geprüft wird, ist das emittierte Rätsel
garantiert ohne Raten lösbar. Konsequenz der nötigen Redundanz: Linien tragen
typisch 3–4 Hinweise (selten 5) statt der früher angestrebten 2–3.

## Lösungscode

Die fertige Matrix wird in einem **31-Zeichen-Crockford-Base32-Code**
verpackt (Alphabet `0–9 A–Z` ohne `I L O U`):

- 36 Zellen × 4 Bit = 144 Bit
- + 8 Bit Prüfsumme = 152 Bit
- gepadded auf 155 Bit = 31 Base32-Zeichen
- mit Bindestrichen in 4er-Blöcken dargestellt

Beim Eingabefeld werden Kleinbuchstaben, Bindestriche und Leerzeichen
toleriert. Ungültige Codes werden über die Prüfsumme erkannt.

## Schwierigkeitsstufen

Konfiguration im Worker (`DIFFICULTY_CONFIG`):

| Parameter                              | Leicht | Mittel | Schwer |
|----------------------------------------|:------:|:------:|:------:|
| Garantierte Sequenzen (`numSequences`) |   3    |   2    |   1    |
| Hinweis-Zielzahl (`targetClues`)       |   32   |   27   |   0    |
| Sequenz-Hinweis behalten (`keepSequences`) | ja | ja    |  ja    |
| Max. Σ-Hinweise gesamt                 |   5    |   5    |   5    |
| Max. Dopplungs-Linien im Gitter        |   5    |   5    |   5    |
| Typische Gesamthinweiszahl             | ~32    | ~27    | ~20    |

`targetClues` steuert, wie weit Phase 2 wieder auffüllt: eine höhere Zahl
bedeutet **mehr** redundante Hinweise und damit ein **leichteres** Rätsel.
`targetClues: 0` (Schwer) füllt nicht auf — es bleibt beim nahezu minimalen,
deduzierbaren Set. (Die Reduktion geht nie unter das, was Deduzierbarkeit
erfordert; die reale Zahl kann den Zielwert bei Schwer also übersteigen.)

**Warum Schwer schwerer ist**: nahezu minimales Hinweisset → lange
Deduktionsketten, kaum Redundanz, nur 1 Sequenz und (durch das frühe
Entfernen) faktisch keine totalSum-Hinweise.

**Warum Leicht leichter ist**: deutlich mehr (redundante) Hinweise auf
gleichmäßig verteilten Linien und 3 Sequenzen, die ganze Linien auf einen
Schlag stark determinieren.

## Performance

`logicalSolve` ist im hinweisarmen Regime schnell **und** zuverlässig
(Polynomialzeit-Fixpunkt statt exponentieller Suche). Ein Worker-Versuch
(Gitter erzeugen + reduzieren) liegt bei ~5–9 ms; bei Mittel/Schwer liefert
praktisch jedes erzeugte Gitter ein Rätsel, bei Leicht ~83 % (die
Sequenz-Vorabbelegung für 3 Sequenzen scheitert öfter). Der erste Treffer
erscheint mit vier parallelen Workern quasi sofort.

Falls der Generator nach 400 Versuchen pro Worker × 4 Worker = 1600
Versuche keinen Treffer findet, wird eine Fehlermeldung gezeigt
(„Kein eindeutiges Rätsel gefunden …"); ein erneutes Klicken startet die
Suche neu.
