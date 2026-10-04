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

Before a demo, open http://localhost:3000/?reset to start over as a new player, with every tree asleep and 0 points.

It runs fine without any Azure keys, it just falls back to local files and the browser's built in voice. Copy `.env.example` to `.env` and add keys as you get them.

## What uses Azure

- Speech for each tree's voice
- OpenAI (or Gemini as the backup) for writing the stories and time-lapse images ahead of time, and for "Ask me something", where you can ask a tree a question. Campus history only comes from its sourced facts, but it'll happily chat about seasons, birds and being a tree. It remembers your last few questions, and each tree has a few suggested questions (`data/questions.json`) you can tap
- Custom Vision for spotting pests and damage in photos, if you train a model. Without one, Gemini checks the photo with no training. Species guesses use the free [Pl@ntNet API](https://my.plantnet.org)
- Translator to tell each story in Spanish, Chinese, Hindi and Gujarati, with Speech as the backup voice
- Table Storage and Blob Storage for visits, reports and photos
- App Service / Static Web Apps for hosting

## Google Gemini

Writing (stories and "Ask me something"), fact search and the time-lapse images use Azure OpenAI when it's set up, and Google Gemini otherwise. The app asks Google which models your key can use and picks the newest Flash model for writing, a Flash image model for pictures (it can also redraw a real reference photo), and an embedding model for fact search. Each job picks on its own, so you can mix them. Get a key at [aistudio.google.com](https://aistudio.google.com) and put it in `GEMINI_API_KEY`.

## ElevenLabs

Each of the 9 tree personalities has its own ElevenLabs voice (set in `data/personas.json`, or override one with `ELEVENLABS_VOICE_ELDER=...` and so on). With `ELEVENLABS_API_KEY` set, `npm run audio` and `npm run translate` record every story in all 5 languages, and trees answer "Ask me something" out loud. Without it, Azure Speech does the voices.

## TigerData

Every visit, report and season sighting is also written to a TimescaleDB hypertable in TigerData. The grounds dashboard's week-by-week charts and "season firsts" come straight from it. Sourced facts are stored there with vector embeddings (pgvector, with pgvectorscale's DiskANN index when available), so when you ask a tree something it pulls the most relevant sourced facts, including campus-wide ones from `data/facts/campus.json`.

Create a free service at [console.cloud.timescale.com](https://console.cloud.timescale.com), put its connection string in `TIGER_DATABASE_URL`, then run `npm run index-facts`. Without it, the charts are worked out from the app's own records.

## Pages

- `/` the map. Drag the time travel slider back through real photos of campus from above: New Jersey's 1930s aerial survey, any later state aerial surveys its server has, and satellite photos from 2014 to now ([Esri World Imagery Wayback](https://livingatlas.arcgis.com/wayback/)). No keys needed. A line above the buttons shows how many trees are asleep, which ones need a check-up, and today's weather. The Book button shows the trees you've met and your badges.

Inside a tree's story you can switch language, compare "then" with "today", ask it a question (type or hold the mic), and leave it a note for the next visitor. Sending a photo of a tree that already has a reported problem earns a rescue bonus.
- 📱 **Log in** with your phone number: the bot texts you, you reply YES, and the website and iMessage share the same trees and points. No password.
- 💚 **Adopt** a tree you've woken. After that it texts you first, in its own voice: when someone reports a problem on it, leaves a note or voice memory, takes its photo, or when it's scorching, freezing or stormy (at most 4 texts a day, never at night).
- 🧭 **Route** starts from where you really are: live location (a blue dot that follows you, and a heads-up when you walk up to a sleeping tree), or type a building, address or ZIP code, or tap the map. The first stop has a "Walk there" link for Apple or Google Maps. In iMessage, text "route" and share your location or say where you are.
- 🎯 **Quests**: seasonal photo challenges ("a tree with red leaves", "a squirrel on a tree"). Gemini checks the photo, you get points, and the photo goes into that tree's explorer album and the grounds team's records.
- 🎙️ **Voice memories**: record a short memory at a tree (or send a voice note in iMessage). It's transcribed and checked, and the next person who wakes the tree hears it.
- `/grounds.html` tree health dashboard for the grounds team, with seasons, photos and a CSV export

## Things that keep it honest

- Each QR tag has a secret key in its link (set `QR_SECRET` before printing), so you can't wake trees by typing links at home.
- A pest or damage flag only becomes confirmed when 5 different people report it with a photo. Reports are also rate limited.
- Photos get shrunk to a JPEG on the phone before uploading, so big iPhone photos still work.
- Pest reports link to New Jersey's official spotted lanternfly reporting tool.

## Adding trees and stories

Trees live in `data/trees.json` and the 9 tree personalities are in `data/personas.json`. The 6 trees in there are samples with real, sourced NJIT history (Eberhardt Hall, the Central King Building, Weston Hall, Cullimore Hall and the school's founding). Their map spots are approximate, so move them to the real tagged trees.

To write a tree's story, put the facts and sources in `data/facts/<code>.json` (there's an example file) and run:

```bash
npm run stories     # writes the story in the tree's voice
npm run timelapse   # makes the time-lapse images
npm run audio       # records the narration
npm run translate   # Spanish, Chinese, Hindi and Gujarati (+ voices)
npm run historic    # adds a real 1930s aerial photo of the spot to the time-lapse
npm run qr          # printable QR tags, set PUBLIC_URL and QR_SECRET first
```

`npm run prepare-demo` makes everything in one go (1930 photos, reference photos, pictures, translations, voices, fact search). `npm run check-content` tells you what each tree is still missing. `npm run check-env -- --live` checks every key in `.env` without printing any of them.

## Time-lapse pictures

Each era is drawn as a real-looking photo from that time: sepia for the 1800s, black and white up to the 1950s, faded color film for the 70s to 90s. Every tree also gets the real 1930s aerial photo of its spot.

They look best when they're redrawn from a real photo of the spot, so the building and angle stay the same and only the year changes. Two ways to get that photo:

- `npm run reference` grabs a freely licensed photo of the nearby building from Wikimedia Commons (picked in `data/reference-sources.json`) and keeps the photographer credit, which shows under the picture.
- Better: take your own photo from where people will stand and save it as `web/reference/TD-001.jpg`. Your own photos are never replaced.

Then run `npm run timelapse -- --force`. "Today" shows the real photo itself.

To show what a tree does for campus each year, look it up on [i-Tree MyTree](https://mytree.itreetools.org) and add it to the tree in `data/trees.json`:

```json
"benefits": { "stormwaterGallons": 1200, "co2Pounds": 450, "airPollutionOunces": 20, "source": "i-Tree MyTree", "year": 2026 }
```

## Texting (Photon)

The whole game also works over iMessage, no app, website or sign-in needed. Text the Tree Detective number and:

- Send a photo of a tree's QR tag (or type the code printed under it) and the tree wakes up, tells its story, and sends it as a voice note
- After that, anything you text is a question for that tree, and it answers out loud
- "report pest" (or damage, dying), then a photo, sends it to the grounds team with a species guess
- "spanish", "chinese", "hindi", "gujarati" or "english" switches the language
- "adopt" so the tree texts you first, "quest" for photo challenges, and a voice note leaves a memory at the tree
- "pictures" sends the tree's spot through time
- "points", "visited", "next", "route", "story", "talk to Whisper", "map" (opens the website as you)

People who already play on the website can tap "Text me" and send the code to link the two. Get keys from app.photon.codes and add them to `.env`. Then `npm start` runs the website and the iMessage bot together in one window (set `PHOTON=off` to run the website alone).

Put the grounds team's numbers in `GROUNDS_ALERT_TO` and they get a text within a minute of a problem being confirmed, with a map pin and a link to the photos.
