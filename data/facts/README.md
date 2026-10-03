# Facts

One JSON file per tree, named after its code, like `TD-001.json`. Copy `TD-001.example.json` to start.

`npm run stories` turns these into the tree's story. It only uses what's in the file, so every fact needs a source link. Keep a tree either all `Fact` or all `Local Legend`, don't mix them.

New stories come out with `verified: false`. Read them over and flip it to `true` in `data/trees.json` once they're right.
