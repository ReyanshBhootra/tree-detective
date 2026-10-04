# Hackathon notes (shippybranch)

## What got tested

All 66 unit/API tests pass (`npm test`). On top of that, the whole player flow was run in a real (headless) browser on a phone-sized screen, with no AI or Azure keys set:

| Feature | Result |
| --- | --- |
| First visit shows how-to-play, not again after reload | ✅ |
| Tapping a sleeping tree explains how to wake it | ✅ |
| Typing a code (lowercase `td-002`) wakes the tree, +10 pts | ✅ |
| Typing junk (`hello`) gives a clear message | ✅ |
| Spanish story (pre-translated) | ✅ |
| Then / today compare slider | ✅ |
| Leave a note, it shows up | ✅ |
| Photo + pest + season report, flag shows "1 of 5", NJ lanternfly link | ✅ |
| Grove book shows woken trees and badges | ✅ |
| Walking route with distances | ✅ |
| Status line ("5 still asleep · 1 needs a check-up") | ✅ |
| Grounds dashboard loads, map + charts + table | ✅ |
| Typed codes can't skip the QR secret (`verifyTreeKey`) | ✅ |
| No JavaScript errors on the page | ✅ |

### Problems found

- **Fixed:** the map crashed (`L is not defined`) whenever cdnjs couldn't be reached, which is common on venue or school wifi. Leaflet is now served from `web/vendor/leaflet`.
- **Fixed:** the "trees are asleep" toast covered the trees on the map. It's now a welcome sheet, and toasts sit above the buttons.
- **Fixed:** players saw "species check is not configured on this server" after sending a photo.
- **Fixed:** on desktop the play button sat below a huge photo, so you had to scroll to hear the tree. It now sits at the top and stays pinned.
- **Still open:** tree name labels overlap when two trees are close (Sprig / Professor Plane at the default zoom).
- **Still open:** "Ask me something" is hidden completely without an AI key. Run `npm run check-env -- --live` before judging so it isn't missing during the demo.
- **Still open:** Google Fonts are still loaded from Google. If they're blocked the app falls back to system fonts, which is fine.

## Ideas to make it stand out

Ranked by impact per hour of work for judging day.

1. **A judge-proof demo.** Judges won't walk around campus. Print 2 or 3 real signed QR tags and tape them to a potted plant or a cardboard tree at the table, then have a judge scan one with their own phone. That's the "wow" moment. Practice the 90-second path: scan → tree wakes and talks → slide to 1930 → ask it a question → report a pest → show it appear on the grounds dashboard.
2. **Close the loop with the grounds team.** Add a "Resolved" button on the grounds dashboard. Everyone who reported that tree then gets "You helped save Whisper 🌳" (on the site and over iMessage). It shows the data goes somewhere real, and it gives people a reason to come back.
3. **Real science partner.** Season sightings ("first leaves", "color change") are exactly what the [USA National Phenology Network / Nature's Notebook](https://www.usanpn.org/natures_notebook) collects. Add a CSV export in their format and mention it in the pitch: "every student becomes a citizen scientist".
4. **Campus impact counter.** Add up the i-Tree benefits of every tagged tree and show it on the map and grounds page (for example "these 6 trees soak up N gallons of rain a year"; the trees need their i-Tree numbers filled in first). It's one number judges will remember.
5. **Teams and a leaderboard.** Let people pick a dorm, major or club; the map shows which team woke the most trees this week. Cheap to build on the existing player summary, and it drives return visits.
6. **Installable app / offline.** Add a web manifest and a service worker that caches the stories, audio and map shell. Campus wifi near trees is often bad, and "Add to Home Screen" looks polished in a demo.
7. **Seasonal return reasons.** Each tree says one new line per season, or there's a "tree of the week" quest worth bonus points, so the game isn't over after one walk.

## Pitch in one line

"Tree Detective turns every tree on campus into a storyteller, and every student into the grounds team's eyes."
