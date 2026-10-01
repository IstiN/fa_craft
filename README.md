# fa_craft

Minecraft-like voxel sandbox widget (pure JS) for [flutter_js_widget_runtime](https://github.com/IstiN/flutter_js_widget_runtime) — issue IstiN/fa_craft#1. Fully local (`"network": false`), deterministic world event log (I3), installable as a Fa widget.

## Development

```sh
npm test          # node test/all.js — UT/IT suite
npm run cover     # nyc coverage, statements >= 85 gate
npm run crap      # crap4js, CRAP <= 30 gate
```

## Goldens (AC2 evidence)

`test/golden/*.png` are real rendered states of the widget, captured with the production renderer of `js_widget_runtime` 0.4.126 (`bin/jsr_widget.dart screenshot`, `--freeze-clock`). One PNG per required AC2 state:

`first-run` · `block-targeted` · `block-placed` · `hotbar-switch` · `crafting-crafted` · `health-change` · `saved-reload`

Regenerate all seven with one command:

```sh
npm run goldens           # capture into test/golden/ + print sha256 per file
npm run goldens:verify    # drive each state headlessly and assert jsr.exportState
```

Requirements on PATH: `node`, `dart`, Flutter >= 3.47, `clang` (first run builds the QuickJS bridge into the pub cache). Overrides: `JSR_FLUTTER`, `JSR_DART`, `JSR_RUNTIME_DIR` (a js_widget_runtime checkout; default downloads the published 0.4.126 archive), `PUB_CACHE`, `JSR_QUICKJS_LIB`.

Determinism: the capture pins `Date.now` (world seed `1210892288`), world states come from the deterministic event log (`game/worldgen.js`, `game/world.js`), and the harness drives no frame ticks — re-running `npm run goldens` reproduces byte-identical PNGs.

Known rendering notes: text renders in the test runner's fallback font, and the pipeline appends a small adapter to the *generated* bundle (`tools/goldens.js` → `RENDER_ADAPTER`) that unwraps the HUD's single-child listView root before it reaches the production renderer — the renderer crashes on the unbounded sliver height under that root (upstream widget bug per SKILL.md §5b; `game/*` itself is untouched by the pipeline). Rendering: on js_widget_runtime 0.4.127+ the widget drives the bridge-owned voxel node (`voxel.mesh` per dirty chunk + one tiny `voxel.camera` per frame — geometry crosses the bridge once per chunk, not per frame); older runtimes fall back to the legacy scene3d meshes adapter automatically. A `Facraft.prof` profiler (exported via exportState + `[facraft]` console summary every 300 frames + F3 overlay lines) reports hud/mesh frame cost and upload volume.

`block-targeted` is byte-identical to `first-run` by design: the HUD has no target indicator yet (the crosshair ray hit is asserted via `exportState` in `npm run goldens:verify`). `crafting-crafted`, `health-change` and `saved-reload` seed `jsr.storage` with a deterministic save payload (see `tools/goldens.js` `savePayload`) because those states need pre-mined resources / a damaged player / an existing world that live event replay cannot reach (worldgen has no trees, so logs for planks are unobtainable in a fresh world).
