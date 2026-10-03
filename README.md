# Tree Detective

Scan a QR tag on a real tree around campus and it wakes up on the map, tells you its story out loud, and shows you what that spot looked like over its lifetime. You collect points for every tree you find.

People can also snap a photo of a tree or report pests and damage, which ends up on a dashboard the grounds crew can actually use. A problem only gets marked confirmed once 5 different people report it.

Made for GirlHacks 2026 at NJIT.

## Running it

```bash
npm install
npm start
```

Then open http://localhost:3000. To fake a scan, go to http://localhost:3000/?tree=TD-001 (that's the same link the QR tags point to).

Tests: `npm test`

It runs fine without any Azure keys, it just falls back to local files and the browser's built in voice. Copy `.env.example` to `.env` and add keys as you get them.

## What uses Azure

- Speech for each tree's voice
- OpenAI for writing the stories and generating the time-lapse images (done ahead of time, not live)
- Custom Vision for guessing the species from a photo
- Table Storage and Blob Storage for visits, reports and photos
- App Service / Static Web Apps for hosting

## Pages

- `/` the map
- `/grounds.html` tree health dashboard for the grounds team, with a CSV export

## Adding trees and stories

Trees live in `data/trees.json` and the 9 tree personalities are in `data/personas.json`. The 6 trees in there right now are placeholders.

To write a tree's story, put the facts and sources in `data/facts/<code>.json` (there's an example file) and run:

```bash
npm run stories     # writes the story in the tree's voice
npm run timelapse   # makes the time-lapse images
npm run audio       # records the narration
npm run qr          # printable QR tags, set PUBLIC_URL first
```

`npm run check-content` tells you what each tree is still missing.

## Texting (Photon)

There's an optional iMessage bot that answers stuff like "points", "next" or "story Old Oakley" and reminds people to go find more trees. Get keys from app.photon.codes, add them to `.env`, and run `npm run photon`.
