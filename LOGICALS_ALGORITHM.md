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

## Hinweis-Auswahl (REDUCE-Strategie)

Funktion: `pickClues(grid, cfg)`.

Statt Hinweise zu einem leeren Set hinzuzufügen (zu langsam: schwacher Solver
mit wenigen Constraints), läuft der Algorithmus rückwärts:

1. **Mit allen Kandidaten starten**: Für jede Reihe/Spalte werden alle
   anwendbaren Hinweise (1 duplicate bei Dopplung, 5 pairSum, 1 totalSum,
   ggf. 1 Sequenz) ins ausgewählte Set gelegt — ~70 Hinweise gesamt.
2. **Initiale Eindeutigkeitsprüfung** (`solve(2, 100k)`): bei diesem
   stark constraintem Puzzle braucht der Solver nur ~50 Nodes. Wenn nicht
   eindeutig: Gitter verwerfen.
3. **Cap-Enforcement**: Pro „Over-Cap"-Linie (mehr als `cfg.maxPerLine`
   Hinweise) wird versucht, Hinweise zu entfernen — pairSum zuerst, dann
   totalSum, Sequenzen und Mandatory-Duplikate werden geschont. Nach jeder
   Entfernung wird via `solve(2, 60k)` geprüft, ob das Puzzle eindeutig
   bleibt; sonst wird der Hinweis wieder eingefügt.
4. **Σ-Hinweis-Cap**: Globale Obergrenze von 5 totalSum-Hinweisen wird
   erzwungen, indem überschüssige solange entfernt werden, wie Eindeutigkeit
   gewahrt bleibt.
5. **Sequenz-Lock** (wenn `cfg.lockSequence === true`): Linien mit
   Sequenz-Hinweis werden noch einmal durchgegangen und alle nicht-Sequenz-,
   nicht-Mandatory-Hinweise probeweise entfernt. So bleibt — wann immer
   möglich — der Sequenz-Hinweis allein.

Wenn nach Cap-Enforcement irgendeine Linie noch über dem Limit liegt oder
das Σ-Cap nicht erreichbar ist, wird `null` zurückgegeben und der Worker
probiert das nächste Gitter.

## Solver

Funktion: `solve(selected, countLimit, nodeLimit)`. Backtracking-Solver mit
mehreren Optimierungen:

- **Bitmaske als Domain**: Jede Zelle hat ein `Int32Array`-Eintrag, dessen
  Bits 0–8 die noch möglichen Werte 1–9 darstellen. `domains[i] & ~bit`
  und `POPCOUNT[domain]` per Lookup-Tabelle sind deutlich schneller als
  `Set`-Operationen.
- **Forward-Checking**: Beim Platzieren von Wert `v` in Zelle `idx` werden
  sofort die Konsequenzen propagiert: aus den vier H/V-Nachbarn, aus der
  restlichen Reihe/Spalte (außer für Dopplungs-Werte), und global, wenn
  `counts[v]` 4 erreicht.
- **MRV-Heuristik** (Most Restrained Variable): Bei jeder Rekursion wählt
  `pickCellMRV()` die nicht zugewiesene Zelle mit der kleinsten Domain.
  Bei Domain-Größe 1 wird sie sofort zurückgegeben.
- **pairSum-Propagation**: Wenn Zelle A eines pairSum-Hinweises belegt
  wird, wird die Domain der Partnerzelle B per `forceDomain` direkt auf
  den einzig erlaubten Wert (Zielsumme − A) eingeschränkt. Das schneidet
  enorm viele Zweige früh ab.
- **Partielle Klausel-Validierung**: Andere Klauseltypen werden geprüft,
  sobald alle ihrer Zellen belegt sind.
- **Undo-Log per Bitpaket**: Pro Removal wird ein 32-bit-Int gepushed
  (`(targetIdx << 4) | bitIdx`); Backtracking restauriert die Bits in
  umgekehrter Reihenfolge ohne Speicherallokationen.

Der Solver bricht ab, sobald `countLimit` Lösungen gefunden oder
`nodeLimit` Knoten besucht wurden (`timedOut = true`). In `pickClues`
wird mit 60–100k Knoten gearbeitet — bei stark constraintem Puzzle reicht
das problemlos für eine vollständige Suche.

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
| Garantierte Sequenzen                  |   3    |   2    |   1    |
| Max. Hinweise pro Reihe/Spalte         |   3    |   2    |   2    |
| Sequenz-Linien exklusiv                |  nein  |  ja    |  ja    |
| Max. Σ-Hinweise gesamt                 |   5    |   5    |   5    |
| Max. Dopplungs-Linien im Gitter        |   5    |   5    |   5    |
| Typische Gesamthinweiszahl             | ~28–34 | ~18–22 | ~16–22 |

**Warum Schwer schwerer ist**: weniger Sequenz-Hinweise (die ganze Linien
auf einen Schlag determinieren) bedeuten mehr Pair-Sum-Reasoning. Bei Mittel
und Schwer enthält die Sequenz-Linie zudem nur den Sequenz-Hinweis, sodass
keine redundanten Hilfen hinzukommen.

**Warum Leicht leichter ist**: mehr Sequenzen, höheres Cap pro Linie, und
keine Sequenz-Lock — die Sequenz-Linien bekommen zusätzlich pairSums oder
totalSums dazu, was die Auflösung weiter vereinfacht.

## Performance

Mit den oben beschriebenen Optimierungen liegen die typischen Laufzeiten
pro Worker-Versuch bei ~200 ms (Mittel/Schwer) bis ~500 ms (Leicht, mehr
Sequenzen → engere Generator-Constraints). Bei vier parallelen Workern
liefert der erste Treffer üblicherweise in 1–3 Sekunden.

Falls der Generator nach 400 Versuchen pro Worker × 4 Worker = 1600
Versuche keinen Treffer findet, wird eine Fehlermeldung gezeigt
(„Kein eindeutiges Rätsel gefunden …"); ein erneutes Klicken startet die
Suche neu.
