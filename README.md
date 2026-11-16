# Coach

A local dashboard for your Apple Health data. It keeps your full history in SQLite and writes an always-current Markdown digest plus CSVs you can hand to Claude to talk about your progress.

No dependencies, no cloud: Node's built-in SQLite and a static frontend. Everything stays in `data/` on this machine (and that folder is git-ignored).

## Run it

Requires Node 22.13 or newer (you have 25).

```bash
npm start
```

Then open http://localhost:4242.

## Getting data in

Apple doesn't offer a web API for Health, so there are two ways to get data in:

### 1. Full export (do this first)

1. On your iPhone open **Health**, tap your profile picture, then **Export All Health Data**.
2. AirDrop `export.zip` to your Mac.
3. In Coach click **Import** and drop the zip in.

For very large exports you can also import from the terminal:

```bash
npm run import -- ~/Downloads/export.zip
```

Re-importing is safe because each day+metric is replaced, never duplicated. Repeat the export whenever you want to catch up.

### Strength workouts from Hevy

Hevy only sends Apple Health a summary of each workout: its title, duration and calories. To see every exercise and set:

1. In Hevy go to **Profile → Settings → Export & Import Data → Export Workouts**, and save the CSV to your Mac.
2. Drop the CSV on **Import**, or run `npm run import -- ~/Downloads/workouts.csv`.

Each Hevy session is matched to its Apple Health workout by start time, within 10 minutes. Click any workout to see its heart-rate trace, and, for strength sessions, its exercises, sets, RPE, volume and estimated 1RM. Re-export and re-import whenever you like.

### 2. Live sync (optional, automatic)

The [Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567069) iOS app (paid tier) can POST your data to Coach on a schedule.

1. Start Coach so your phone can reach it, with a secret token:
   ```bash
   HOST=0.0.0.0 SYNC_TOKEN=pick-a-long-secret npm start
   ```
   When Coach is reachable from your network, other devices can only use the sync endpoint, and only with the token. The dashboard stays limited to this Mac.
2. In Health Auto Export create a **REST API** automation:
   - URL: `http://<your-mac-local-ip>:4242/api/ingest`
   - Header: `Authorization: Bearer pick-a-long-secret`
   - Format: JSON, **Aggregate data: Day**, include Health Metrics and Workouts.
   - Choose the metrics you care about (steps, energy, heart rate, HRV, sleep, weight…).

Your phone and Mac have to be on the same Wi-Fi for this to work.

## Talking to Claude about it

Every import, sync, journal entry or goals edit regenerates these files:

| File | What's in it |
|---|---|
| `data/export/health_summary.md` | Definitions, your goals, an overview table (7/30/90/365-day averages and how they changed), the last 30 days day by day, weekly and monthly averages, workouts, and journal notes. Usually 10–20k tokens. |
| `data/export/daily.csv` | Full history, one row per day and one column per metric (units in the headers). |
| `data/export/workouts.csv` | Every workout. |
| `data/export/strength_sets.csv` | Every Hevy set: exercise, weight, reps, RPE. Written once you import a Hevy CSV. |

The Markdown digest also gets a **Strength training** section once Hevy data is in. It lists recent sessions set by set, and a per-exercise progress table with sessions, top set and best estimated 1RM for the last 30 days compared with 31–90 days ago.

The easiest way to use them is to click **For Claude → Copy with coach prompt** and paste into a chat. You can also attach the files directly, or add them to a Claude Project's knowledge so every conversation starts with your latest data. Use the CSVs when you want Claude to analyse older history in detail.

The **Goals & context** box and the **Journal** are there to tell Claude what the numbers can't, like training plans, injuries, illness, stress or travel.

## How values are computed

- **Totals** (steps, distance, energy, exercise, food): summed per source, and the biggest source for the day wins. That stops iPhone and Watch steps from being counted twice.
- **Rates** (heart rate, HRV, SpO₂, respiratory rate): the daily mean. Heart rate also gets a daily max.
- **Body** (weight, body fat): the last reading of the day.
- **Sleep**: counted on the day you wake up. The source with the most sleep that night (usually the Watch) wins. Stages need iOS 16 or newer.
- Units are normalised to kg, km, kcal, L, h and %.

## Layout

```
server.js            HTTP server + JSON API
lib/metrics.js       metric catalogue (add new Apple Health types here)
lib/importExport.js  streaming export.zip / export.xml importer
lib/ingest.js        Health Auto Export JSON receiver
lib/aggregate.js     samples → daily values
lib/exporter.js      Markdown / CSV generation
public/              dashboard (vanilla JS, SVG charts)
data/                your database and exports (git-ignored)
```

Environment variables: `PORT` (default 4242), `HOST` (default 127.0.0.1), `SYNC_TOKEN`, `DATA_DIR`.
