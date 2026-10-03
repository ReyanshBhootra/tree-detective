# Sourced facts, one file per tree

Person A drops one JSON file here per tree, named after its code (`TD-001.json`).
`npm run stories` turns the facts into a story in the tree's persona voice with
Azure OpenAI. The model is told to use **only** these facts, and every story it
writes comes back with `verified: false` until a human reads it against the
sources and flips it to `true` in `data/trees.json`.

Rules from the context doc:

- Every fact needs a real source link (NJIT archives, Newark Public Library, etc).
- A tree's facts are either all `Fact` or all `Local Legend`. Never mixed.
- Don't invent dates. If you only know a decade, write the decade.

`eras` is optional. It lets you write the time-lapse captions and give the image
model era details that come from the same sources.

See `TD-001.example.json` for the shape. Files ending in `.example.json` are ignored.
