# Tree Detective

A storybook campus map where every real tagged tree has a name, a voice, and a true local story. Walk up to a tree, scan its tag, and it wakes up: it glows on the map, you earn points, and it tells you what this spot looked like across its own lifetime. Meanwhile, the photos and problem flags people send quietly build a real, usable map of campus tree health for the grounds team.

Built for GirlHacks 2026, "Enchanted Grove" (NJIT). Tracks: **Whimsical Wonders** and **Best Use of Azure by Avanade**.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # 23 tests: points, vouching, API, Photon replies
```

You don't need any Azure keys to run it. When a service isn't configured, the app falls back to a local equivalent:

| Piece | With Azure | Without |
|---|---|---|
| Visits, points, reports | Azure Table Storage | JSON files in `.data/` |
| Report photos | Azure Blob Storage | `uploads/` folder |
| Species guess | Azure Custom Vision | Photo is saved, guess is skipped |
| Tree voices | Azure Speech (pre-rendered MP3) | Browser speech, tuned per persona |
| Stories | Azure OpenAI, ahead of time, human-checked | Sample text in `data/trees.json` |
| Time-lapse | Azure OpenAI images, ahead of time | Drawn storybook SVG scenes |

Copy `.env.example` to `.env` and fill in whatever keys you have.

Try it without a tree: open `http://localhost:3000/?tree=TD-001`, which is exactly the link a printed QR tag holds.

## How it works

1. **Map** (`web/`): a dark storybook Leaflet map with fireflies. Sleeping trees are grey with little "z z"s. Woken trees glow in their persona's color and sway.
2. **Scan**: each tag's QR is a plain link (`/?tree=TD-001`), so any phone camera works. There's also an in-app scanner and a "type the code" fallback.
3. **Location check**: happens on the phone. Only the yes/no result goes to the server, never the position. If location is off, the QR code alone still counts.
4. **Points**: 10 per tree, once per player. Players are an anonymous random ID kept on the device.
5. **Story**: read aloud in the tree's voice while the words light up, with a time-lapse of the spot across the tree's life. Every story shows its label (**Fact** or **Local Legend**), its source, and a "Draft" badge until a human has verified it.
6. **Photo and flags**: a photo gets a species guess with a confidence score, and the person can say if it looks right. Pest, damage, and dying flags stay **possible** until **5 different people** flag the same thing on the same tree, and then they become **confirmed**. The same person reporting five times still counts as one.
7. **Grounds dashboard** (`/grounds.html`): a map and table of every tree's flags, crowd species guesses, and recent photos, plus a CSV export.
8. **Photon** (optional): an iMessage companion that answers "points", "visited", "next", "route", and "story Old Oakley", and sends a gentle "go explore" nudge.

## The content pipeline (Person A)

The rule: **nothing is generated live during the demo, and no fact is invented.**

```bash
# 1. Write sourced facts: data/facts/TD-001.json (see TD-001.example.json)
npm run stories -- --dry-run      # see exactly what the model will be told
npm run stories                   # Azure OpenAI writes it in-persona, marked verified:false
# 2. Read each story against its sources, then set "verified": true in data/trees.json
npm run timelapse                 # Azure OpenAI images for each era -> web/timelapse/
npm run audio                     # Azure Speech narration per persona -> web/audio/
npm run check-content             # what's still missing before each tree is demo-ready
```

The 9 personas (voice, speaking style, glow color) live in `data/personas.json`.

## Tagging trees (Person D)

1. Replace the sample trees in `data/trees.json` with the real tagged trees (code, name, persona, lat, lng).
2. Set `PUBLIC_URL` to the deployed site, then run `npm run qr` and print `print/qr-tags.html`.

## Photon setup (Person C, cut first if short on time)

1. Sign up at [app.photon.codes](https://app.photon.codes) for a project ID and secret.
2. Set `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `PHOTON_PHONE_NUMBER`, and the same `PHOTON_API_KEY` on the API and the Photon service.
3. `npm run photon` runs the chat loop, and nudges are checked hourly. `npm run photon:nudge` sends any due nudges once.

Linking: the website shows a 6-letter code (it lasts 30 minutes and works once). The player texts it to the number, and from then on their texts map to their progress. Text "stop" to pause nudges.

## Deploying on Azure

- **One App Service (simplest):** `npm start` serves both the API and the website. Run `npm run photon` as a second App Service, or as a WebJob.
- **Split:** deploy `web/` to Azure Static Web Apps (`staticwebapp.config.json` is included), deploy the API to App Service, and set `apiBase` in `web/config.js`. The API would also need CORS for the static site's origin.
- Set `AZURE_STORAGE_CONNECTION_STRING`. Tables and the blob container are created automatically. The photo container uses public blob read access so the dashboard can show the photos.

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/trees`, `/api/trees/:code`, `/api/personas`, `/api/config` | Read content |
| POST | `/api/visits` `{playerId, treeCode, locationVerified}` | Wake a tree, award points |
| GET | `/api/players/:playerId` | Points, visited trees, next tree |
| POST | `/api/trees/:code/reports` (multipart: `photo`, `flagType`, `playerId`) | Photo, species guess, flag |
| POST | `/api/trees/:code/reports/:id/feedback` | "Does the species guess look right?" |
| GET | `/api/health`, `/api/reports.csv` | Grounds team data |
| POST | `/api/link-codes` | Code for linking Photon |
| * | `/api/photon/*` | Photon service only (needs `x-photon-key`) |

## Honest limits

- The six trees in this repo are **samples** with placeholder coordinates. Their stories deliberately contain no historical claims, and each one is marked as a draft.
- Stories use only real, sourced local history. Legends are labeled as legends.
- Time-lapse images are always labeled as generated impressions, never as real photos.
- Species guesses are sometimes wrong, so the confidence score is always shown.
- Don't claim NJIT facilities uses this data unless they've said so.
- `npm audit` reports moderate advisories in OpenTelemetry packages pulled in by Photon's SDK. They only affect the optional Photon service.
