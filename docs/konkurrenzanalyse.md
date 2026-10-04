# Konkurrenzanalyse: Zeiterfassung für Kundenzeiten

Ziel: Herausfinden, welche Funktionen etablierte Tools bieten, und bewusst entscheiden,
was davon in ein **einfaches Single-User-Tool** gehört.

> Stand der Funktionsübersicht: Herbst 2026, aus öffentlich bekannten Produktbeschreibungen.
> Preise ändern sich häufig und sind deshalb bewusst nicht aufgeführt.

## Betrachtete Produkte

| Produkt | Typ | Kurzprofil |
|---|---|---|
| **Toggl Track** | SaaS | Der Klassiker: Ein-Klick-Timer, Projekte/Kunden/Tags, starke Reports, Browser-Erweiterung, Apps für alle Plattformen, Leerlauf-Erkennung, Erinnerungen. |
| **Clockify** | SaaS | Sehr ähnlich zu Toggl, großzügiger Gratis-Tarif; Stundenzettel-Ansicht (Timesheet), Kiosk-Modus, Genehmigungen und Rechnungen in Bezahltarifen. |
| **Harvest** | SaaS | Fokus auf Abrechnung: Stundensätze, Budgets, Rechnungen, Ausgaben, Integrationen (QuickBooks, Xero …). |
| **Kimai** | Open Source, selbst gehostet (PHP/MySQL) | Sehr umfangreich: Kunden → Projekte → Tätigkeiten, Rechnungsvorlagen, Export (PDF/Excel/CSV), Teams, Rollen, Plugins. Mächtig, aber viel Oberfläche. |
| **solidtime** | Open Source, selbst gehostet oder SaaS | Modernes, schlankes Toggl-Pendant: Timer, Projekte, Kunden, Tags, Stundensätze, Reports, Import aus Toggl/Clockify. |
| **Timing / Timemator** | Desktop (macOS) | Automatische Erfassung über App-/Dokumentnutzung, Regeln zur automatischen Zuordnung. Kein Web/Smartphone-Fokus. |
| **Everhour / Tick u. a.** | SaaS | Integration in PM-Tools (Asana, Jira, Trello …), Budgets, Team-Planung. |

## Funktionsvergleich

Legende: ● vorhanden · ◐ teilweise/Bezahltarif · – nicht vorhanden

| Funktion | Toggl | Clockify | Harvest | Kimai | solidtime | **Dieses Tool** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Start/Stopp-Timer | ● | ● | ● | ● | ● | **●** |
| Laufzeit & Startzeit live sichtbar | ● | ● | ● | ● | ● | **●** |
| Manuelle Einträge / nachträglich bearbeiten | ● | ● | ● | ● | ● | **●** |
| Kunden | ● | ● | ● | ● | ● | **●** |
| Projekte / Tätigkeiten / Tags | ● | ● | ● | ● | ● | – (bewusst) |
| Monatsauswertung je Kunde | ● | ● | ● | ● | ● | **●** |
| CSV-Export | ● | ● | ● | ● | ● | **●** |
| PDF-Export / Rechnungen | ◐ | ◐ | ● | ● | ◐ | – |
| Stundensätze / Beträge | ◐ | ◐ | ● | ● | ● | – (Idee für später) |
| Rundung (z. B. 15 min) | ◐ | ◐ | ● | ● | – | – (Idee für später) |
| Automatische Berichte per Mail | ◐ | ◐ | ● | ◐ | – | **●** (monatlich/wöchentlich) |
| Erinnerung bei vergessenem Timer | ● | ◐ | ● | – | – | **●** (nach X Stunden per Mail) |
| Leerlauf-Erkennung (Desktop-App) | ● | ● | – | – | – | – |
| Offline-Nutzung | ● (Apps) | ● (Apps) | ◐ | – | – | **●** (PWA mit Sync-Warteschlange) |
| Smartphone | Apps | Apps | Apps | Web | Web | **Web-App, installierbar** |
| Teams, Rollen, Genehmigungen | ● | ● | ● | ● | ● | – (Single-User) |
| Integrationen (Jira, Asana, …) | ● | ● | ● | ◐ | – | – |
| Selbst hostbar / eigene Daten | – | – | – | ● | ● | **●** |

## Was übernommen wurde – und warum

1. **Ein-Klick-Start** (Toggl/Clockify): Die zuletzt genutzten Kunden erscheinen als Schnellstart-Buttons.
   Wer einen neuen Timer startet, stoppt automatisch den laufenden – es läuft immer höchstens einer.
2. **Laufender Timer immer oben** mit Kunde, Startzeit (Wochentag, Datum, Uhrzeit) und Live-Laufzeit;
   zusätzlich im Browser-Tab-Titel.
3. **Nachträglich korrigieren** (alle): Start, Ende *oder* Dauer eingeben – Ende vor Start gilt als
   „über Mitternacht“. Auch die Startzeit eines laufenden Timers lässt sich anpassen („vergessen zu starten“).
4. **Rückgängig statt Rückfrage** (Toggl): Löschen und Stoppen zeigen kurz „Rückgängig“ bzw. „Weiterlaufen“
   an. Das spart Bestätigungsdialoge.
5. **Kunden archivieren statt löschen** (Harvest/Kimai): Alte Kunden verschwinden aus der Auswahl,
   ihre Zeiten bleiben in den Auswertungen erhalten.
6. **Monatsauswertung mit Vormonatsvergleich**, Klick auf einen Kunden zeigt dessen Einträge.
7. **Automatischer Monatsbericht per Mail** inkl. CSV-Anhang (Harvest/Toggl-Weekly-Report),
   optional zusätzlich wöchentlich.
8. **Erinnerung bei vergessenem Timer** (Toggl/Harvest), hier serverseitig per Mail. Das funktioniert
   auch dann, wenn kein Gerät online ist.

## Was bewusst weggelassen wurde

- **Projekte, Tätigkeiten, Tags:** Das ist die größte Komplexitätsquelle bei allen Konkurrenten.
  Für „welcher Kunde, wie lange, was“ reichen Kunde und Notiz.
- **Teams, Rollen, Genehmigungen:** Es gibt nur einen Nutzer.
- **Rechnungen und Integrationen:** Die CSV-Datei lässt sich in jedes Buchhaltungs- oder Rechnungsprogramm übernehmen.
- **Native Apps und Leerlauf-Erkennung:** Die installierbare Web-App deckt Desktop und Smartphone
  mit *einer* Codebasis ab.

## Mögliche Erweiterungen (falls später gewünscht)

- Stundensatz je Kunde → Betrag in Auswertung und Mail
- Rundung in der Auswertung (5/10/15 Minuten)
- PDF-Export der Monatsauswertung (zum Weitergeben an Kunden)
- Freier Zeitraum (von–bis) statt nur Monat
- Wochenziel / Soll-Stunden
