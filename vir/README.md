# LeanUI on lean-vir

A second way to run a LeanUI program, kept for the benchmarks. The site and every app ship the
wasm64 build (Lean → C → wasm64 with Emscripten, `tools/build-app.sh`); this directory runs the
same Lean source in [lean-vir](https://github.com/ejgallego/lean-vir), Lean's own IR interpreter
compiled to wasm32, so the two can be compared on the same programs: side by side in the browser
on the race page (`bench/race/`, served at `/race/`), and in the automated benchmarks
(`tests/browser/bench.mjs --impls leanui,vanilla,leanvir`; results in docs/BENCHMARKS.md).

The library and the apps do not depend on this directory (`lake build` and the wasm64 builds never
read it), and it changes nothing in them: the benchmarked programs (`examples/Bench.lean`,
`examples/Life.lean`) are the same files, compiled by both. The browser tests, CI and the site's
`/race/` page build it.

## How it runs

| | wasm64 (production) | lean-vir (this directory) |
|---|---|---|
| Lean | 4.34.0 (`lean-toolchain`) | 4.36.0-rc1 (`vir/lean-toolchain`): lean-vir pins one Lean release |
| What the browser runs | the app compiled to C, then to wasm64 | lean-vir's interpreter (`runtime.wasm`, one for every app) and the app's IR (`.irpkg` files) |
| Entry module | `examples/BenchApp.lean`: `leanui_app Bench.program` | `vir/LeanUIVir/BenchApp.lean`: `leanui_vir_app Bench.program` |
| Host | `LeanUI/Host/Wasm.lean` + `runtime/leanui_wasm.c`: each update read in place from wasm memory | `vir/LeanUIVir/Host.lean`: each update returned as `[packet, ...blobs]`, where the packet uses the server's `[u32 opsBytes][ops][strs]` format |
| JavaScript | `runtime/leanui.js` (`LeanUI.start`) | `runtime/leanui.js` plus `vir/leanui-vir.js` (`LeanUIVir.start`) |
| Build | `tools/build-app.sh BenchApp bench` → `dist/bench/` | `vir/build.sh bench` → `dist/vir/bench/` |
| Browsers | needs Memory64 (not in Safari yet) | any browser with WebAssembly |

Both hosts feed the same DOM code: `vir/leanui-vir.js` builds a `LeanUI.Runtime` with its own
transport, which calls the app's exported `event` and `callback` and applies the updates they
return.

The five exported `IO` functions are `start`, `event`, `callback`, `callbackBytes` and `take`.
The session stays in Lean behind a `JSL` carrier. Each returned update is an array of copied
byte arrays: its command packet first, followed by the blobs used by canvas and download commands.
File and image results enter Lean through `callbackBytes`, also using copied bytes.

The runtime returned by `LeanUIVir.start` has an idempotent `dispose()` method. Dispose it when
unmounting the app: it cancels owned timers, animation frames and fetches, removes listeners,
revokes object URLs, drops the session and disposes the VIR program. Failed startup performs
the same cleanup. A terminal VIR failure or DOM-application error stops delivery and emits
`leanui:error`; recoverable call errors leave the program available.

## Building

    vir/build.sh            # both apps; or vir/build.sh bench, vir/build.sh life
    vir/build.sh test       # integration fixture
    node tests/browser/vir.mjs  # Chromium and Firefox; Playwright as in tests/browser/playwright.mjs

Lake runs on the toolchain in `vir/lean-toolchain` (elan installs it). The first build needs the
network: Lake fetches lean-vir at the commit `vir/lakefile.toml` pins and downloads the matching
prebuilt interpreter. `vir/.lake` holds that build, apart from the main `.lake`.
The public dependency is `bf8b6a80a5d4011ffd6804fb7a395b9cd2d0d668`
(PR270), paired with runtime content `0d7d7edd`. Its tracked runtime lock
selects the public resource; no local runtime override is needed.

`vir/lakefile.toml` compiles LeanUI's core from `../LeanUI` and the benchmarked programs from
`../examples`. Adding an app `X` (its program in `examples/X.lean`):

1. `LeanUIVir/XApp.lean`, the entry module: `leanui_vir_app X.program` inside
   `namespace LeanUIVir.XApp` (copy `LeanUIVir/BenchApp.lean`);
2. `LeanUIVir/XResources.lean`, which makes Lake package the app's IR (copy
   `LeanUIVir/BenchResources.lean`);
3. in `vir/lakefile.toml`: `X` in the `Examples` roots, `LeanUIVir.XApp` in the `LeanUIVir` roots,
   and a `[[lean_lib]]` for the resources with `needs = ["+LeanUIVir.XApp:virResourcePack"]`;
4. in `Publish.lean`: the import and a line in `apps`;
5. `pages/x.html` (copy `pages/bench.html`, with `app: "LeanUIVir.XApp"`), and `x` in
   `vir/build.sh`'s default list.

## Limits of the pinned benchmark setup

lean-vir interprets everything except a fixed catalog of native functions (bignums, strings,
arrays, …), and it has no C compiler. So:

* LeanUI's two inline-C buffer helpers (`LeanUI.pushU32`, `LeanUI.appendUtf8`) run as their Lean
  definitions (`vir_extern_fallback` in `leanui_vir_app`; that is why `LeanUI/Patch.lean` exposes
  them).
* The photo editor's inline-C helpers (`Editor.get32`, `set32`, `histAdd`) need explicit Lean
  fallbacks before packaging that app. Editor/video integration is outside this benchmark setup.
* Byte arrays cross the VIR boundary by copying; large images and video frames need performance
  measurements before choosing this host for those workloads.
* Historical Lean 4.35 benchmarks measured script time at about 13× the wasm64 build's in
  keyed operations and 48× in Life. Those ratios have not been remeasured for the new pin.

## Updating lean-vir

lean-vir promises no compatibility across revisions, and its runtime (`runtime.js`,
`runtime.wasm`) must come from the same revision as the packages. To move to a newer one: change
`rev` in `vir/lakefile.toml`, set `vir/lean-toolchain` to the Lean release that revision pins (its
own `lean-toolchain`), run `lake update` in `vir/`, then `vir/build.sh` and the race test
(`tests/browser/race.mjs`).
Also build the integration fixture (`vir/build.sh test`) and run `node tests/browser/vir.mjs`
to check effects, byte transfers, ownership, cleanup and failure handling.
