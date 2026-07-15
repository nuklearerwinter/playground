# Logicals-Rätselgenerator — Algorithmus & Parameter

Dieses Dokument beschreibt die interne Funktionsweise von `logicals.html`: wie
die Gitter erzeugt werden, wie die Hinweise ausgewählt werden, wie der Solver
arbeitet und wie das Turnier Rätsel einer gewählten Schwierigkeitsstufe trifft
(Klassifizierung aus dem Lösungsweg über den Branching-Faktor `b`).

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
| `once`         | „Die 5 kommt genau einmal vor."                                      |
| `absent`       | „Die 5 kommt nicht vor."                                             |
| `pairSum`      | „A3 plus A4 ergibt 11."                                              |
| `totalSum`     | „Die Summe aller sechs Zahlen lautet 38."                            |
| `directSequence`   | „… direkt aufsteigend angeordnet (lückenlos, z. B. 3-4-5-6-7-8)."  |
| `directDescending` | „… direkt absteigend angeordnet (lückenlos, z. B. 8-7-6-5-4-3)."   |
| `ascending`        | „… aufsteigend angeordnet (ggf. mit Lücken)."                      |
| `descending`       | „… absteigend angeordnet (ggf. mit Lücken)."                       |

`duplicate` ist strukturell (ohne den Hinweis gälte die Linie als „alle
verschieden") und daher immer mandatory. `once` und `absent` sind dagegen
**reine Zusatzinformation**: `once` fügt nur die Untergrenze „kommt vor" hinzu
(höchstens einmal gilt ohnehin), `absent` streicht den Wert komplett aus der
Linie. Pro (Linie, Wert) ist höchstens einer von `duplicate`/`once`/`absent`
zulässig; mehrere `once`/`absent` mit verschiedenen Werten pro Linie sind ok.

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
streamen fortlaufend (gedrosselt) Rätsel; der Hauptthread klassifiziert jedes
über den Lösungsweg nach **Schwierigkeitsstufe** und behält das beste, das die
gewählte Stufe trifft. Beendet per Frühstopp, „Übernehmen" oder Zeit-Hardcap.
Siehe „Schwierigkeit: 5 Stufen".

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
  einmal (Obergrenze). Eine **untere** Schranke gibt es pro Linie nur für
  explizit benannte Werte: den Dopplungs-Wert (genau zweimal) und einen
  `once`-Wert (genau einmal) — daraus folgt für beide auch ein „Hidden
  Single" (0 mögliche Plätze ⇒ Widerspruch, genau so viele Plätze wie nötig ⇒
  erzwungen). Achtung: Eine 6er-Linie enthält nur 6 der 9 Werte, es gibt also
  **keine** Sudoku-artige „jeder Wert kommt vor"-Schranke.
- **Absent-Streichung**: Ein `absent`-Hinweis („kommt nicht vor") streicht den
  Wert einmalig aus allen sechs Zellen der Linie — vor der Fixpunkt-Schleife,
  da Domains nur schrumpfen. Danach trägt er nichts mehr bei (insbesondere
  braucht eine reine absent-Linie **keine** Feasibility-DFS: der Wert ist
  schon aus den Domains verschwunden).
- **Globale Anzahl**: Jeder Wert kommt genau 4× im Gitter vor (Ober- und
  Unterschranke über alle 36 Zellen).
- **pairSum-Bogenkonsistenz**: Für `A + B = s` behält jede der beiden Zellen
  nur Werte, zu denen der Partner einen passenden Komplementärwert hat.
- **totalSum-Schrankenpropagation**: Pro Linie mit bekannter Gesamtsumme
  werden Zellwerte über Min/Max-Summen der übrigen Zellen eingegrenzt.
- **Duplikat-Platzierung (nachbarschaftsbewusst, `dupPlacement`)**: Die doppelte
  Zahl passt nur in die Zellen, die sie noch führen; zwei davon müssen *nicht*
  benachbart liegen. Eine Zelle, die in jedem zulässigen nicht-benachbarten Paar
  steckt, wird erzwungen; eine ohne nicht-benachbarten Partner verliert den Wert.
  Läuft **vor** der Feasibility-DFS und ist die billige menschliche Abkürzung,
  die die DFS sonst per Brute Force fände (5×2 passt B5/C5/F5, B5–C5 benachbart
  ⇒ F5=5). Senkt damit auch den gemessenen Aufwand `B` (siehe Schwierigkeit).
- **Nacktes Paar (`nakedPair`)**: Zwei Zellen einer Linie mit *derselben*
  2er-Kandidatenmenge `{a,b}` belegen zusammen `a` und `b` ⇒ beide fallen in
  allen übrigen Zellen der Linie weg. Der offensichtliche menschliche Schritt
  („diese beiden Zellen sind die 8 und die 9, also ist sonst hier nichts 8 oder
  9"), `b=1`. **Der einfache Beide-Werte-Strike ist nur sound, wenn das Paar den
  Duplikat-Wert der Linie ausschließt** (sonst könnten beide Zellen der doppelte
  Wert sein). **Enthält das Paar den Duplikat-Wert `a`** (`{a,b}`, `b` kein
  Duplikat — dann ist mindestens eine der beiden Zellen `a`, weil `b` höchstens
  einmal passt), gelten stattdessen zwei duplikat-bewusste Deduktionen:
  *benachbarte* Paarzellen können auch nicht beide `a` sein (Adjazenz) ⇒ eine
  ist `a`, die andere `b` ⇒ nur `b` fällt im Rest der Linie weg; Paarzellen mit
  **genau einer Zelle dazwischen** ⇒ die Mittelzelle kann nicht `a` sein (sonst
  nähme die Adjazenz beiden Paarzellen das `a` und beide müssten `b` sein —
  zweimal ein Nicht-Duplikat). Trace-ruleType `"dup-sandwich"`, beides `b=1`.
  Läuft **vor** der Feasibility-DFS und auf **jeder** Linie (auch reinen
  pairSum/Distinktheits-Linien ohne DFS), sonst würde `sumBound`/Feasibility diese
  triviale Streichung mit aufgeblähtem `B` beanspruchen (beobachtet: `b=15` für
  ein `{6,8}`-pairSum-Paar bzw. ein `{4,5}`-Sandwich). Greift auf einer
  DFS-losen Linie ⇒ kann das Gate ein paar **mehr** Rätsel akzeptieren (echt
  deduzierbar, daher korrekt); die duplikat-bewussten Fälle feuern nur auf
  Duplikat-Linien (⊆ `lineSearches`, von der DFS ohnehin fixpunktiert) und
  ändern daher nie die Akzeptanz, nur die `B`-Zurechnung.
- **Linien-Feasibility-DFS**: Für jede Linie mit Summe und/oder Duplikat zählt
  eine DFS alle gültigen 6-Wert-Belegungen auf; Werte ohne Vorkommen werden
  gestrichen. Fängt extreme Summen + komplexere Duplikat-Fälle ab, die
  `dupPlacement` nicht löst. Trägt die Linie zusätzlich `once`-Werte, erzwingt
  der Final-Check der DFS `usage[v] === 1` für sie (sound: Belegungen ohne den
  Wert sind keine echten Vervollständigungen). **Ein `once`/`absent`-Hinweis
  allein macht eine Linie aber NICHT zur DFS-Linie** — absent steckt schon in
  den Domains, und für once ist der Hidden Single die menschlich angemessene
  Deduktion; eine Enumeration einer sonst freien Linie hätte hunderte
  Kombinationen und würde die `b`-basierte Schwierigkeitsmessung sprengen.
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
   `once`/`absent`-Kandidaten (jeder einfach bzw. gar nicht vorkommende Wert,
   ~9 pro Linie) erzeugt `buildCandidateClues` zwar alle, aber `pickClues`
   wählt **vor** dem Gate eine kleine Zufallsteilmenge (je 0..`maxOnceClues` /
   0..`maxAbsentClues` aus der Level-cfg, höchstens einer je Art und Linie),
   markiert sie `keep` und wirft den Rest komplett raus. Sie alle
   mitzuminimieren würde die Kandidatenzahl ~verdoppeln (Minimierungszeit ×2);
   so kosten sie fast nichts, erscheinen garantiert im Ergebnis und die
   Minimierung stützt sich auf sie — sie werden organisch tragend.
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
5. **Anzeige-Sortierung** pro Linie: duplicate, once (nach Wert), absent
   (nach Wert), Sequenz, pairSums (positionsweise), totalSum — kanonisch in
   `clueDisplayRank` (Hauptthread; `displayRank` im Worker spiegelt sie, da
   getrennter Realm).

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

- 4 Bit Version (0 oder 1; **1 nur wenn once/absent-Hinweise vorhanden sind** —
  Rätsel ohne sie behalten byte-identische v0-Codes, die auch ältere Stände
  der Seite noch decodieren)
- **pairSum**: 60-Bit-Bitmap (Indizes 0..29 = horizontale Paare zeilenmajor,
  30..59 = vertikale Paare spaltenmajor) + 4 Bit pro gesetztem Bit für den
  Summenwert (3..17 → 0..14)
- **totalSum**: 12-Bit-Bitmap (0..5 = Reihen, 6..11 = Spalten) + 6 Bit pro
  gesetztem Bit (6..54 → 0..48)
- **duplicate**: 12-Bit-Bitmap + 4 Bit pro gesetztem Bit (1..9 → 0..8)
- **sequence**: 12-Bit-Bitmap + 2 Bit pro gesetztem Bit
  (0=directSequence, 1=ascending, 2=descending, 3=directDescending)
- **[nur v1] once**: 12-Bit-Linien-Bitmap + 9-Bit-Wertmaske pro gesetzter
  Linie (Bit k = Wert k+1) — erlaubt mehrere once-Werte pro Linie,
  ordnungsunabhängig/kanonisch
- **[nur v1] absent**: 12-Bit-Linien-Bitmap + 9-Bit-Wertmaske, gleiche Form
- 8 Bit Prüfsumme (Summe aller vorigen Daten-Bytes mod 256)

`decodePuzzle` akzeptiert Version 0 **und** 1 und lehnt widersprüchliche
Zähl-Hinweise ab (dup∩(once|absent) oder once∩absent auf einer Linie ⇒ null;
ebenso eine geflaggte Linie mit leerer Wertmaske). Gesamtlänge 152–200 Bit
(v0) ≙ **31–42 Base32-Zeichen** je nach Hinweisdichte (Median ~37 bei
Default-Einstellungen; v1 entsprechend länger). Beim Eingabefeld werden
Kleinbuchstaben, Bindestriche und Leerzeichen toleriert. Ungültige Codes
werden über die Prüfsumme erkannt.

## Lösungsweg (Schritt für Schritt, Kandidaten-Darstellung)

Funktion: `solveWithTrace(clues)` (Hauptthread). Eigenständige, **tracende
Variante von `logicalSolve`** — gleiche Regeln, aber jede **Regelanwendung, die
Kandidaten entfernt, ergibt einen Schritt**: `{ reason, removals:[{idx,vals}],
solved:[idx] }`. Sie löst **allein aus den Clues** (liest nie
`currentPuzzle.grid`) und liefert `{ solved, steps, grid }`. Typisch ~100
Schritte pro Rätsel.

**Schritt-Reihenfolge imitiert den Menschen** (anders als die Phasen-Reihenfolge
von `logicalSolve`): Eine `cascade()`-Worklist arbeitet die
offensichtlichen Folgen jeder frisch gesetzten Zelle sofort ab — erst Adjazenz,
dann Reihen-/Spalten-Distinktheit — und zwar vollständig, *vor* und *nach* jeder
schwereren Batch-Regel. Eine **lückenlose Sequenz** wird ab einer einzigen
bekannten Zelle in **einem gebündelten `"sequence"`-Schritt** komplett gefüllt
(`fillDirectSequence`). **`absent`-Hinweise stehen als je ein `"absent"`-Schritt
ganz am Anfang des Trace** (b=1, „Die 5 kommt in Reihe C nicht vor — aus allen
sechs Zellen streichen"), so wie ein Mensch das Gitter vorbereiten würde; der
**once-Hidden-Single** erscheint als `"once-hidden-row"/"once-hidden-col"`-Schritt
(b=1) in `unit`. **Direkt vor jeder Linien-Feasibility-DFS werden die billigen
b=1-Regeln der Linie erneut ausgeführt** (`unit`, `nakedPairLine`,
`dupPlaceLine`, plus `cascade`): Streichungen aus derselben Runde (pairSum,
`sumBound`, DFS anderer Linien) können die Linie inzwischen so verengt haben,
dass eine triviale Deduktion frei liegt — ohne den Re-Run würde die DFS sie mit
riesigem `b` beanspruchen (beobachtet: b=32 für eine erzwungene
Duplikat-Platzierung, b=15 für ein nacktes Paar). Das alles ist zulässig, weil
die Propagation konfluent/monoton
ist (gleicher Fixpunkt, egal in welcher Reihenfolge) — `logicalSolve` (das
Akzeptanz-Gate) bleibt unverändert.

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

**Wichtig:** `solveWithTrace` muss die *Regelmenge* von `logicalSolve` spiegeln
— bei Solver-Änderungen beide anpassen (eine neue Regel auch bewusst in die
Kaskade/Schleife einsortieren). Sicherheitsnetz: stimmt `grid` nicht mit der
bekannten Lösung überein (Drift/Bug), wird der Schritt-Modus übersprungen und
die Lösung direkt eingeblendet. Validierung headless via Node-Kopie der
Funktion (Brace-Matching extrahieren): gelöst, zurückgespielte `removals` ==
Lösung, kein Entfernen abwesender Werte, kein Entfernen des *Lösungswerts*, keine
geleerte Domain, und lückenlose Sequenzen werden gebündelt gefüllt.

## Schwierigkeit: 5 Stufen, aus dem Lösungsweg klassifiziert

Statt Slidern wählt der Nutzer **eine von 5 Stufen** (Sehr leicht … Sehr schwer,
Radio-Group `name="level"`). Die Schwierigkeit wird **aus dem Trace gemessen**,
nicht aus der Hinweiszahl.

**`b` = Branching-Faktor pro Schritt.** Jeder Trace-Schritt trägt `b`: wie viele
Kandidaten-*Belegungen* ein Mensch überblicken müsste, um den Schritt zu
rechtfertigen. Der `lineFeasibility`-Schritt zählt die **distinkten
Wert-KOMBINATIONEN (Multisets)**, die die Linie füllen — NICHT die geordneten
Zell-Belegungen: ein Mensch überlegt „welche Zahlenmengen passen", nicht ihre
Permutationen. Permutationen aufzuzählen blähte `b` ~3–10× auf (die zwei gleichen
Werte einer Dup-Linie plus der distinkte Rest permutieren vielfach für *eine*
Kombination) und ließ erzwungene Linien viel schwerer wirken. **Ausnahme — eine
Dup-ONLY-Linie (Duplikat-Hinweis, KEIN totalSum): `b` ist der Dup-PLATZIERUNGS-
Survey = Anzahl der nicht-benachbarten Positionspaare, die der doppelte Wert noch
einnehmen kann, NICHT die Wert-Multimengen-Zahl.** Die Multimengen-Zahl blähte `b`
dort massiv auf (beobachtet bis ~70) für das, was ein Mensch als „wohin die zwei
d?" liest (eine Handvoll Plätze) — das war die Ursache, dass dup-only-Linien als
Extrem/Sehr schwer fehleingestuft wurden. Dup+Sum- und einfache/once-totalSum-
Linien behalten den Multimengen-Survey. Billige/erzwungene
Regeln sind `b=1`, `sumBound` ist `1+offene Zellen`, `sequence` ≈ die Hälfte
davon (Sequenzen sind leichter). `puzzleProfile(trace)` →
`{ maxB, bands, nFeas, nFeasHard }` (`maxB` = härtester Einzelschritt; `bands` =
Zähler `#(b>3/5/8/12/20/30)`; `nFeas` = alle `lineFeasibility`-Schritte;
`nFeasHard` = jene mit `b≥3`, **ausgenommen Dup-Platzierungs-Surveys**
(`clue.dupPos`) — ein Dup-Platzierungs-Survey ist viel leichter als ein echter
Mehr-WERT-Kombinationen-Survey und geht daher NICHT in die Arbeits-Achse ein;
seine Schwierigkeit zeigt sich weiterhin über `maxB`).

**`puzzleLevel = max(StufeAusMaxB, StufeAusArbeit, StufeAusHinweistyp)`** — drei
Achsen, weil keine einzelne alle fünf Stufen spannt. Durch die
Kombinations-Zählung ist `maxB` auf ~≤15 gestaucht und trennt nur noch das
**leichte Ende**; das **harte Ende** läuft über `nFeasHard` (wie viele Linien
einen *echten* ≥3-Kombinationen-Survey erzwangen):
- **`maxB`-Stufen**: `>6` ⇒ 3; `>4` ⇒ 2 (schluckt die `maxB≈4`-Sequenz-Grundlinie);
  plus Sicherung für einen einzelnen Monster-Survey `>9` ⇒ 4, `>14` ⇒ 5.
- **Arbeits-Stufen** (`nFeasHard`): `≥1` ⇒ Schwer; `≥2` ⇒ Sehr schwer.
  **Feasibility-Schritte mit `b≤2` zählen NICHT** — sie sind faktisch erzwungen.
  Deshalb ist ein Rätsel mit vielen Sum/Dup-Linien, aber fast nur erzwungenen
  Deduktionen (Fixture `0WH0` = maxB 7 / nFeas 8 / nFeasHard 1) **Schwer, nicht
  Sehr schwer** — seine 8 Linien lösen sich überwiegend bei b≤2.
- **Hinweistyp-Boden** (`clueFeatures` liest die *Clue-Menge*, nicht den Trace):
  Liniensumme vorhanden ⇒ ≥ Mittel; Duplikat oder `once` vorhanden ⇒ ≥ Leicht.
  `absent` setzt bewusst **keinen** Boden (eine Sofort-Streichung ist trivial —
  L1 darf absent-Hinweise tragen).
Trefferquoten ≈ 100/97/74/28/34 %; L4 bleibt der Schwachpunkt (seine Config
streut die Hard-Survey-Zahl über L3–L5).

`LEVELS` trägt pro Stufe eine Generier-`cfg` (`minTotalSum`, `maxTotalSum`,
`minDupLines`, `maxDupLines`, `fewerPairSums`, `maxOnceClues`,
`maxAbsentClues`), die die Generierung **ins Band biast** (L1: keine
Summen/Dups ⇒ `maxB=1`; L5: `minTotalSum:3` für große Enumerationen).
`maxOnceClues`/`maxAbsentClues` deckeln die keep-geschützte
once/absent-Zufallsauswahl in `pickClues`; **L1 hat `maxOnceClues: 0`** (ein
once-Hinweis floort auf Stufe 2 und würde jede L1-Kandidatur aus dem Band
schieben), absent bleibt auch auf L1 erlaubt. Die `cfg` ist nur ein Bias —
die eigentliche Einstufung macht `puzzleLevel`. **`fewerPairSums:true`
vermeiden** (senkt die Yield ~10× — daher eskaliert L5 über `minTotalSum`
statt darüber).

**Turnier trifft ein Band, maximiert nicht** (`startSearch` / `onWorkerMessage`
/ `searchTick` / `finishSearch`):

- Worker-Schleife (`self.onmessage`, endlos bis `terminate()`): Gitter erzeugen,
  `pickClues(grid, { targetClues: 0, … })` (volle Minimierung — Hinweiszahl ist
  kein Schwierigkeitsknopf mehr), und das zuletzt akzeptierte Rätsel **gedrosselt
  (~alle 120 ms)** posten → Vielfalt statt „wenigste Hinweise".
- Hauptthread: `solveWithTrace` pro Kandidat → `puzzleLevel`. Behält das
  hinweisärmste **In-Band**-Rätsel (`bestInBand`); ohne Treffer das
  nächstliegende (`bestFallback`).
- **Frühstopp**, sobald das Beste `STALL_MS` (1,5 s) stabil ist und mindestens
  `MIN_SEARCH_MS` (1,2 s) lief; Hardcap `DEFAULT_BUDGET_MS` (15 s);
  „Übernehmen" beendet sofort.
- Trefferquoten je Stufe ≈ **100 / 94 / 78 / 16 / 42 %** (L4 leckt nach L3 —
  unkritisch: der Filter + reichlich Yield fangen es ab). Das angezeigte Rätsel
  zeigt seine *eigene* Stufe (aus seinem Trace berechnet, also auch für per-Code
  geladene Rätsel korrekt).

`pairSum` ist bewusst kein konfigurierbarer Typ (Rückgrat der Lösbarkeit).

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
| Doppelte Zahl                       | `Wertx2`, `Wertx`, `Wert²` (Legacy: `2xWert` nur für Wert ≥ 3) | `5x2` / `5²`   |
| Zahl genau einmal                   | `Wertx1`                                         | `5x1`          |
| Zahl kommt nicht vor                | `Wertx0`                                         | `5x0`          |
| Direkt aufsteigend (lückenlos)      | `RUN ASC`                                        | `RUN ASC`      |
| Direkt absteigend (lückenlos)       | `RUN DESC`                                       | `RUN DESC`     |
| Aufsteigend mit Lücken              | `ASC`                                            | `ASC`          |
| Absteigend mit Lücken               | `DESC`                                           | `DESC`         |

Zähl-Hinweise lesen sich **Wert-zuerst**: in `AxB` mit `B ∈ {0,1,2}` ist `A`
der Wert und `B` die Anzahl. Die Legacy-Form `AnzahlxWert` überlebt nur als
`2xB` mit `B ≥ 3` (eindeutig). **Bewusster Bruch:** das früher gültige `2x1`
(„die 1 doppelt") bedeutet jetzt „die 2 genau einmal".

### Validierung (`parseManualLine` → `loadManualPuzzle`)

- Paarzellen müssen orthogonal benachbart sein.
- Paarzellen müssen beide im aktuellen Linienkontext liegen
  (Reihe-A-Feld → beide Zellen mit `A…`; Spalte-3-Feld → beide Zellen
  mit `…3`).
- Wertebereiche: pairSum 3–17, totalSum 6–54, duplicate/once/absent 1–9.
- Pro Linie höchstens eine totalSum / ein Duplikat / eine Sequenz. Mehrere
  once/absent pro Linie sind erlaubt, aber pro **Wert** höchstens einer von
  `Vx0`/`Vx1`/`Vx2` (Widerspruchs-Check).
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
