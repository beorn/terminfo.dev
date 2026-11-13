# osc104 retained frames, cropped (16x16 RGBA)

Three crops of the SAME region from one retained Warp run, so a colour change can be told apart
from a geometry change without shipping the whole screenshots.

- source: run `43414740482`, `extensions.osc104-reset-palette`, second attempt, compared region
  `{x: 25, y: 78, width: 16, height: 16}`
- `seed.rgba`    ← artifact `sha256:18b2196ebbd483c33d768a670d131848c2d20600cb323ef2e57ff6a1a75a6049`
- `after.rgba`   ← artifact `sha256:86ad949a36da24d02b476d8c4d9ebce5b0cb316fe3a5a273dd7469d4c93e56d1`
- `expected.rgba`← artifact `sha256:9d14c73e380c33a3cb1e51ad1cbeecbc37ba0e858932ac027b78695bd37981bb`
- layout: 16 rows of 16 pixels, 4 bytes per pixel (RGBA), depth 8, row-major
- measured: background `#050505` in all three; ink `#616161` (seed), `#123456` (after),
  `#c1e3fe` (expected); the 5%-coverage ink mask is IDENTICAL in all three
  (`sha256:b08b270265d47c047571317dbf07dc73ec6004da644eca23f02d53e2858d48e6`)

The raw "differs from background" masks of these frames are NOT equal (198 vs 197 background
pixels; 1-2 edge pixels flip), which is exactly why the mask is normalised by each frame's own ink
before it is hashed. See `packages/terminfo.dev/src/capture-core.ts` `renderingAxes`.
