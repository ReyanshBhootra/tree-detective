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
- OpenAI for writing the stories and time-lapse images (ahead of time), and for "Ask me something", where you can ask a tree a question and it answers only from its own sourced facts
- Custom Vision for spotting pests and damage in photos (species guesses use the free [Pl@ntNet API](https://my.plantnet.org) if you add a key)
- Translator to tell each story in Spanish, Portuguese and Haitian Creole, and Speech voices for Spanish and Portuguese
- OpenAI embeddings so trees can look up their sourced facts
- Communication Services Email for the weekly grounds summary
- Table Storage and Blob Storage for visits, reports and photos
- App Service / Static Web Apps for hosting

## ElevenLabs

Each of the 9 tree personalities has its own ElevenLabs voice (set in `data/personas.json`, or override one with `ELEVENLABS_VOICE_ELDER=...` and so on). With `ELEVENLABS_API_KEY` set, `npm run audio` and `npm run translate` record every story in English, Spanish, Portuguese and Haitian Creole, and trees answer "Ask me something" out loud. Without it, Azure Speech does the voices.

## TigerData

Every visit, report and season sighting is also written to a TimescaleDB hypertable in TigerData. The grounds dashboard's week-by-week charts and "season firsts" come straight from it. Sourced facts are stored there with vector embeddings (pgvector, with pgvectorscale's DiskANN index when available), so when you ask a tree something it pulls the most relevant sourced facts, including campus-wide ones from `data/facts/campus.json`.

Create a free service at [console.cloud.timescale.com](https://console.cloud.timescale.com), put its connection string in `TIGER_DATABASE_URL`, then run `npm run index-facts`. Without it, the charts are worked out from the app's own records.

## Pages

- `/` the map. Drag the time travel slider to fade campus back to the real 1930s aerial photos of New Jersey. A line above the buttons shows how many trees are asleep, which ones need a check-up, and today's weather. The Book button shows the trees you've met and your badges.

Inside a tree's story you can switch language, compare "then" with "today", ask it a question (type or hold the mic), and leave it a note for the next visitor. Sending a photo of a tree that already has a reported problem earns a rescue bonus.
- `/grounds.html` tree health dashboard for the grounds team, with seasons, photos and a CSV export

## Things that keep it honest

- Each QR tag has a secret key in its link (set `QR_SECRET` before printing), so you can't wake trees by typing links at home.
- A pest or damage flag only becomes confirmed when 5 different people report it with a photo. Reports are also rate limited.
- Photos get shrunk to a JPEG on the phone before uploading, so big iPhone photos still work.
- Pest reports link to New Jersey's official spotted lanternfly reporting tool.

## Adding trees and stories

Trees live in `data/trees.json` and the 9 tree personalities are in `data/personas.json`. The 6 trees in there right now are placeholders.

To write a tree's story, put the facts and sources in `data/facts/<code>.json` (there's an example file) and run:

```bash
npm run stories     # writes the story in the tree's voice
npm run timelapse   # makes the time-lapse images
npm run audio       # records the narration
npm run translate   # Spanish, Portuguese and Kreyòl versions (+ voices)
npm run historic    # adds a real 1930s aerial photo of the spot to the time-lapse
npm run qr          # printable QR tags, set PUBLIC_URL and QR_SECRET first
```

`npm run check-content` tells you what each tree is still missing.

For the "then and now" slider, take one photo of each tree from a spot you mark on the tag ("stand here"), save it as `web/reference/TD-001.jpg`, and add `"referencePhoto": "/reference/TD-001.jpg"` to that tree. Run `npm run timelapse -- --force` afterwards and every era gets drawn from that same photo, so the slider lines up. This needs an image model that supports edits, like gpt-image-1.

To show what a tree does for campus each year, look it up on [i-Tree MyTree](https://mytree.itreetools.org) and add it to the tree in `data/trees.json`:

```json
"benefits": { "stormwaterGallons": 1200, "co2Pounds": 450, "airPollutionOunces": 20, "source": "i-Tree MyTree", "year": 2026 }
```

## Texting (Photon)

There's an optional iMessage bot that answers stuff like "points", "next" or "story Old Oakley" and reminds people to go find more trees. Get keys from app.photon.codes, add them to `.env`, and run `npm run photon`.

Put the grounds team's numbers in `GROUNDS_ALERT_TO` and they get a text within a minute of a problem being confirmed, with a map pin and a link to the photos.

## Weekly email

`npm run digest` sends the grounds team a summary of the week. It uses Azure Communication Services Email if `ACS_CONNECTION_STRING`, `DIGEST_FROM` and `DIGEST_TO` are set, otherwise it saves `print/digest.html`. Run it once a week with a scheduled job.
