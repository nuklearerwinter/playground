# Plan: Logicals-Rätselgenerator als HTML-Seite

## Kontext
Das Foto `PXL_20260520_182343859.jpg` zeigt ein Rätsel aus "LOGISCH Spezial" (LOGICALS):
ein 6×6-Gitter, in das die Zahlen 1–9 jeweils viermal eingetragen werden müssen.
Hinweise werden pro Reihe (A–F) und Spalte (1–6) gegeben und mischen verschiedene
Regeltypen (Summen, Dopplungen, Sequenzen, Einzelpaar-Summen). Der Nutzer möchte
weitere solche Rätsel selbst generieren können – idealerweise mit eindeutiger
Lösung und sichtbarer Vielfalt der Regeltypen, passend zum Stil der Vorlage.

Ergebnis: eine eigenständige HTML-Seite `logicals.html`, die per Knopfdruck ein
neues Rätsel erzeugt, anzeigt und die Lösung auf Wunsch einblendet.

## Globale Regeln (immer gültig)
- Gitter: 6 Spalten (1–6) × 6 Reihen (A–F) = 36 Zellen
- Zahlen 1–9, jede genau 4×
- Gleiche Zahlen niemals horizontal/vertikal benachbart (diagonal erlaubt)
- Default: pro Reihe und pro Spalte sind alle Zahlen verschieden – Ausnahmen
  werden über einen expliziten Dopplungs-Hinweis bekanntgegeben

## Datei
- **Neu:** `/home/klaus/IdeaProjects/stlviewer/logicals.html`
  - Single-File: HTML + CSS + JS inline, keine Build-Schritte, keine externen
    Dependencies. Passt zum Stil von `index.html`/`pacman.html` im Repo.

## UI
- Kopfzeile mit Titel und kurzen Spielregeln
- **Startzustand**: beim Öffnen der Seite ist *kein* Rätsel sichtbar – nur die
  Steuerung. Erst Klick auf „Neues Rätsel" erzeugt eines.
- Steuerung:
  - Auswahl Schwierigkeit: Leicht / Mittel / Schwer (Radio oder Buttons)
  - Knopf **„Neues Rätsel"**
  - Eingabefeld **„Lösungscode"** + Knopf **„Lösung zeigen"**
  - Knopf **„Drucken"** (ruft `window.print()`)
- **Visueller Fortschritt während der Erzeugung**:
  - Generator-Button wird deaktiviert
  - Indeterminate-Progressbar oder CSS-Spinner direkt unter dem Button
  - Statustext (z. B. „Versuche 7/200, prüfe Eindeutigkeit …") wird periodisch
    aktualisiert. Damit der Browser-Thread reagiert, läuft der Generator als
    `async` Schleife mit `await new Promise(r => setTimeout(r, 0))` zwischen
    Versuchen – kein Web-Worker nötig, einfach gehalten.
- Anzeige der Hinweise (Reihen A–F, Spalten 1–6) im Layout der Vorlage.
- 6×6-Gitter mit Beschriftungen (1–6 oben, A–F links). Zellen standardmäßig
  leer; die Lösung wird nur sichtbar, wenn der **korrekte Lösungscode** in das
  Eingabefeld getippt wurde.
- Nach dem Generieren wird der **Lösungscode** prominent unter dem Rätsel
  angezeigt (zum Abschreiben/Notieren). Hinweis dazu: „Code zum späteren
  Anzeigen der Lösung notieren."

## Generator-Logik (JS, alles in `logicals.html`)

### 1. Gitter-Generator
- Backtracking: fülle Zellen zeilenweise mit Zahl 1–9 unter Beachtung von
  - „jede Zahl ≤ 4× insgesamt"
  - „nicht gleich wie linker Nachbar / oberer Nachbar"
  - Bei häufigem Sackgassen-Lauf Neustart mit zufälliger Reihenfolge der
    Kandidaten (`shuffle`) – einfacher als komplettes CSP.
- Output: 6×6-Array mit Lösungsgitter.

### 2. Hinweis-Generator
Pro Reihe/Spalte wird eine Auswahl möglicher Hinweise erzeugt, die zur
konkreten Lösung passen. Erzeugte Typen:

- **Einzelpaar-Summe**: z. B. `D1 + D2 = 14` – wähle ein zufälliges Paar
  benachbarter Zellen.
- **Gesamtsumme** einer Reihe/Spalte: `Summe aller sechs Zahlen lautet X`.
- **Dopplungshinweis**: nur wenn die Reihe/Spalte tatsächlich eine Dopplung
  enthält. Text: „Die N kommt doppelt vor" bzw. „… gibt es zweimal".
- **Direkte Sequenz**: trifft zu, wenn alle 6 Zahlen aufeinanderfolgend sind
  (z. B. 2,3,4,5,6,7) **und** in genau dieser Reihenfolge stehen.
  Text: „Die Zahlen sind von links nach rechts direkt aufeinanderfolgend
  angeordnet."
- **Aufsteigend mit Lücken**: alle 6 Werte streng aufsteigend, aber nicht
  zwingend lückenlos. Text: „Die Zahlen sind von links nach rechts
  aufsteigend angeordnet." (klar abgegrenzt von „direkt aufeinanderfolgend")
- **Absteigend** analog.
- **Gleichheits-/Differenz-Hinweise** zwischen zwei Zellen (z. B. `A3 = A5`,
  `B2 + B4 = 11`) – Erweiterung des Einzelpaar-Typs.

Mindestens 3 unterschiedliche Regeltypen pro Rätsel anstreben (Mix wie in der
Vorlage).

### 3. Schwierigkeitsstufen
Steuern Menge & Strenge der Hinweise:
- **Leicht**: viele Hinweise, mind. ein Hinweis pro Reihe und Spalte
- **Mittel**: ca. 9–11 Hinweise, weniger redundant
- **Schwer**: minimale Hinweismenge, die Eindeutigkeit noch zulässt
  (greedy entfernen, solange Solver noch genau eine Lösung findet)

### 4. Solver / Eindeutigkeits-Check
Backtracking-Solver, der **alle** Regeln gleichzeitig erzwingt:
- Globale Constraints: Zahl 1–9 je 4×, keine gleichen H/V-Nachbarn
- Default-Uniqueness: pro Reihe/Spalte alle Zahlen verschieden, **außer**
  diese Reihe/Spalte hat einen expliziten Dopplungshinweis
- Hinweise als zusätzliche Bedingungen
- Zählt Lösungen, bricht bei 2 ab → akzeptiere Rätsel nur, wenn genau 1
  Lösung existiert. Sonst Hinweise hinzufügen bzw. neu generieren.

### 5. Erzeugungsschleife
```
do
  gitter = generateGrid()
  hinweise = pickClues(gitter, schwierigkeit)
while solver(hinweise).count != 1
```
Mit Timeout/Versuchszähler (z. B. 200 Versuche) und Fallback auf mehr Hinweise,
damit der Browser nicht hängt.

## Lösungscode
- Inhalt: gesamte 6×6-Matrix (36 Werte 1–9) plus 2-stellige Prüfsumme.
- Encoding: pro Zelle 4 Bits (9 < 16). 36 Nibbles = 144 Bits → in Crockford-
  **Base32** (Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, ohne `I L O U` –
  tippsicher, nur Großbuchstaben + Ziffern) ergibt **29 Zeichen** für die
  Matrix + 2 Zeichen Prüfsumme = **31 Zeichen**.
- Darstellung in Blöcken: z. B. `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX`
  (Bindestriche & Leerzeichen werden beim Vergleich ignoriert,
  Kleinbuchstaben automatisch zu Groß konvertiert).
- Validierung: Code → Bits → Matrix; Prüfsumme verifizieren; danach
  Zellen anzeigen. Bei Tippfehler: rote Fehlermeldung „Code ungültig".
- Damit ist der Code reproduzierbar tippbar (nur `0-9` und Großbuchstaben
  außer `I/L/O/U`) und kurz genug, um auf einen Notizzettel zu passen.

## Druck-Layout (DIN A4)
- `@media print` CSS-Block in `logicals.html`:
  - Steuerung, Eingabefelder, Spinner, Buttons werden ausgeblendet (`display:none`).
  - Hinweisliste + Gitter + Lösungscode bleiben sichtbar.
  - Schriftgrößen so wählen, dass alles bequem auf eine A4-Seite passt
    (Hinweise oben, Gitter unten – analog zur Vorlage).
  - `@page { size: A4; margin: 1.5cm; }` setzen.
  - Gitter mit `border-collapse` und festen `width`/`height` (z. B. 2.2cm pro
    Zelle) für gleichmäßiges Raster im Druck.
  - Zellen leer drucken (zum Lösen mit Stift); Lösungscode unten als
    Klartext-Zeile, damit man die Lösung später wieder einblenden kann.

## Verifikation
1. `logicals.html` in einem Browser öffnen (Doppelklick reicht – keine
   externen Ressourcen). Beim Öffnen ist das Gitter leer/ausgeblendet,
   nur Steuerung sichtbar.
2. Auf „Neues Rätsel" klicken: Spinner/Progressbar wird angezeigt,
   Statustext aktualisiert sich, Button bleibt während der Erzeugung
   deaktiviert.
3. Nach dem Generieren prüfen:
   - Hinweis-Text liest sich wie in der Vorlage (deutsch, klare
     Unterscheidung „direkt aufeinanderfolgend" vs. „aufsteigend").
   - Mind. 3 verschiedene Regeltypen pro Rätsel sichtbar.
   - Lösungscode wird unter dem Rätsel angezeigt, nur Großbuchstaben +
     Ziffern, ohne `I L O U`, mit Bindestrich-Gruppierung.
4. Lösungscode kopieren, in das Eingabefeld einfügen → „Lösung zeigen"
   blendet die Lösung im Gitter ein. Ungültigen Code eintippen → rote
   Fehlermeldung, kein Anzeigen. Klein-/Großschreibung & Bindestriche
   werden toleriert.
5. Jede Hinweiszeile gegen die angezeigte Lösung gegenprüfen
   (Summen stimmen, Dopplungen vorhanden, Sequenz korrekt usw.).
6. Stichprobenartig die Eindeutigkeit kontrollieren: in DevTools `solver`
   manuell mit `countLimit=2` aufrufen → Ergebnis muss 1 sein.
7. Schwierigkeitsstufen vergleichen: „Leicht" deutlich mehr Hinweise als
   „Schwer".
8. Druck-Preview (`Strg+P`): alles passt auf eine A4-Seite,
   Steuerelemente sind ausgeblendet, Gitterzellen leer, Lösungscode
   unten als Text vorhanden.
