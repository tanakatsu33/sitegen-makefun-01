[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/tanakatsu33/sitegen-makefun-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/tanakatsu33/sitegen-makefun-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# sitegen-makefun

A fast, dependency-free drop-in replacement for makefun-site 1.0.0's `build`, with byte-identical output.
`solve.js` is a single self-contained ES module exporting `run(input)`; `main.ts` is the unchanged make.fun driver.

## Run

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

The driver reads `cases.json` from the input directory and writes `answers.json` to the output directory (Node 22+).

## How it is fast

- **Markdown on pre-escaped text.** Each body is HTML-escaped once (one native regex pass); blocks are lexed by
  offsets and inline rendering runs on the escaped text, jumping between `\` `` ` `` `*` `[` with regexes. Entities
  contain none of the inline-special characters, so every search finds what it finds in the raw text (`\>` is
  handled as `\&gt;`). Paragraph ends are found by a regex over candidate lines; code blocks are sliced out whole.
- **Native word counts.** Reading time counts words 16 at a time with a sticky regex.
- **Compiled templates.** Each template, per include depth, loop-variable shape and page kind, is compiled once per
  run into a JS function with lookups resolved statically (same scope-chain rules as the reference). Fragments that
  depend only on `site`/`tags`/`recent` are rendered once per run; fragments that depend only on one loop element
  (cards, tag lists) are memoized by that element.
- **Per-run caches only:** slugs, link resolution per (directory, target), parsed/compiled templates. Nothing
  survives from one `run()` call to the next.
- **V8 tuning** (allowed by the driver): tiering is capped at Maglev, since TurboFan's compiles of the large
  Markdown functions cost more CPU than they save in a short single-CPU run. Finished strings are flattened once.

Output is verified byte-identical against the reference on the practice cases, hand-written edge cases and
thousands of randomly generated sites.

## License

MIT
