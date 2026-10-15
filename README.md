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

Known rendering notes: text renders in the test runner's fallback font, and the pipeline appends a small adapter to the *generated* bundle (`tools/goldens.js` → `RENDER_ADAPTER`) that unwraps the HUD's single-child listView root before it reaches the production renderer — the renderer crashes on the unbounded sliver height under that root (upstream widget bug per SKILL.md §5b; `game/*` itself is untouched by the pipeline). Rendering: the widget requires js_widget_runtime >= 0.4.156 and always drives the bridge-owned voxel node (`voxel.mesh` per dirty chunk + one tiny `voxel.camera` per frame — geometry crosses the bridge once per chunk, not per frame); a failed or hung capability probe renders a static update card — there is no scene3d meshes fallback. Boot renders a splash card synchronously at eval (no blank panel while storage + world gen run) and the spawn ring streams in frame-capped (3 chunks/frame, nearest first) instead of one multi-second upload burst; `[facraft] boot:` console lines attribute the storage/world/terrain split in field reports. A `Facraft.prof` profiler (exported via exportState + `[facraft]` console summary every 300 frames + F3 overlay lines) reports hud/mesh frame cost and upload volume.

**0.2.24 — raw byte lane for chunk bytes**: when the probe also reports
`bin: true` (js_widget_runtime 0.4.171+ on the QuickJS native-bytes
backend), `voxel.blocks` uploads cross via `jsr.hostCallBinary(
'voxel.blocks.bin', …)` — same 'JVXM' envelope, but the body is the RAW
block bytes instead of their base64 string: ~25% less wire volume per
chunk and zero b64 encode/decode on either side. Engines without the
lane keep the base64 JSON path; nothing else changes.

`block-targeted` is byte-identical to `first-run` by design: the HUD has no target indicator yet (the crosshair ray hit is asserted via `exportState` in `npm run goldens:verify`). `crafting-crafted`, `health-change` and `saved-reload` seed `jsr.storage` with a deterministic save payload (see `tools/goldens.js` `savePayload`) because those states need pre-mined resources / a damaged player / an existing world that live event replay cannot reach (worldgen has no trees, so logs for planks are unobtainable in a fresh world).
