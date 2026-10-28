// Backend-independent lifetime contracts; no compiled app or web server required.
// Deterministic deferred work covers disposal races, rather than waiting for timers to win.
import assert from "node:assert/strict";
import fs from "node:fs";
import { pw } from "./playwright.mjs";

const runtime = fs.readFileSync(new URL("../../runtime/leanui.js", import.meta.url), "utf8");
const engines = process.argv.slice(2);
if (!engines.length) engines.push("chromium", "firefox");
const tests = [
  ["bitmap closes on every decode exit", async () => {
    const rows = [];
    for (const fail of ["context", "draw", "read", "none"]) {
      let closes = 0, result;
      const rt = new LeanUI.Runtime({ callbackBytes(...args) { result = args; } });
      rt.files.set(1, new File(["x"], "x"));
      globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() { closes++; } });
      globalThis.OffscreenCanvas = class {
        getContext() {
          if (fail === "context") return null;
          return {
            drawImage() { if (fail === "draw") throw new Error("draw failed"); },
            getImageData() { if (fail === "read") throw new Error("read failed"); return { data: new Uint8ClampedArray(4) }; },
          };
        }
      };
      await rt.readFile(1, 1, true);
      rows.push({ closes, ok: result[1], bytes: result[3].length });
      rt.dispose();
    }
    return rows;
  }, [{ closes: 1, ok: false, bytes: 0 }, { closes: 1, ok: false, bytes: 0 },
      { closes: 1, ok: false, bytes: 0 }, { closes: 1, ok: true, bytes: 4 }]],
  ["late bitmap closes without drawing", async () => {
    let resolve, closes = 0, canvases = 0, callbacks = 0;
    const rt = new LeanUI.Runtime({ callbackBytes() { callbacks++; } });
    rt.files.set(1, new File(["x"], "x"));
    globalThis.createImageBitmap = () => new Promise((r) => { resolve = r; });
    globalThis.OffscreenCanvas = class { constructor() { canvases++; } };
    const work = rt.readFile(1, 1, true);
    rt.dispose();
    resolve({ width: 1, height: 1, close() { closes++; } });
    await work;
    return { closes, canvases, callbacks };
  }, { closes: 1, canvases: 0, callbacks: 0 }],
  ["late frame copy cannot acquire fallback canvas", async () => {
    const rows = [];
    for (const reject of [true, false]) {
      let settle, closes = 0, canvases = 0, callbacks = 0;
      const rt = new LeanUI.Runtime({ callbackBytes() { callbacks++; } });
      globalThis.VideoFrame = class {
        constructor() { this.displayWidth = this.displayHeight = 1; this.visibleRect = { width: 1, height: 1 }; }
        copyTo() { return new Promise((ok, fail) => { settle = reject ? () => fail(new Error("unsupported")) : ok; }); }
        close() { closes++; }
      };
      globalThis.OffscreenCanvas = class { constructor() { canvases++; } };
      const query = document.querySelector;
      document.querySelector = () => ({ readyState: 2, videoWidth: 1, videoHeight: 1, paused: true, currentTime: 0 });
      try {
        const work = rt.grabFrame(1, "#video");
        rt.dispose(); settle(); await work;
        rows.push({ closes, canvases, callbacks, retained: rt.grabCanvas !== null });
      } finally { document.querySelector = query; rt.dispose(); }
    }
    return rows;
  }, [{ closes: 1, canvases: 0, callbacks: 0, retained: false }, { closes: 1, canvases: 0, callbacks: 0, retained: false }]],
  ["download click can dispose its owner", () => {
    const rt = new LeanUI.Runtime({});
    document.addEventListener("click", (e) => { e.preventDefault(); rt.dispose(); }, { capture: true, once: true });
    rt.download("probe.bin", "application/octet-stream", new Uint8Array([1, 2]));
    return { disposed: rt.disposed, timers: rt.timeouts.size, urls: rt.objectUrls.size, anchors: document.querySelectorAll("a").length };
  }, { disposed: true, timers: 0, urls: 0, anchors: 0 }],
  ["wasm startup rolls back boot and queued failures", async () => {
    const rows = [];
    // A fake Emscripten boundary exercises JS startup, not compiled-Wasm fault behavior.
    for (const failure of ["false", "throw", "queued", "disposed", "replacement"]) {
      const previous = new LeanUI.Runtime({}); LeanUI.active = previous;
      let rt, replacement, notifications = 0, reported;
      const error = new Error("boot error"), cleanupError = new Error("cleanup error");
      globalThis.LifetimeModule = async () => ({
        lengthBytesUTF8(s) { return new TextEncoder().encode(s).length; }, _malloc() { return 16n; }, stringToUTF8() {},
        _leanui_event() { throw error; },
        _leanui_boot() {
          rt = LeanUI.active;
          rt.setContainer("#app");
          rt.timeouts.add(setTimeout(() => {}, 60000));
          if (failure === "throw") {
            rt.transport.dispose = () => { throw cleanupError; };
            throw error;
          }
          if (failure === "disposed") { rt.dispose(); return 1; }
          if (failure === "queued" || failure === "replacement") {
            rt.container.addEventListener("leanui:error", () => {
              notifications++;
              if (failure === "replacement") { replacement = new LeanUI.Runtime({}); LeanUI.active = replacement; }
            }, { once: true });
            rt.send(0, 1, "queued"); return 1;
          }
          return 0;
        },
      });
      try { await LeanUI.start({ factory: "LifetimeModule", glue: "unused.js" }); } catch (e) { reported = e; }
      rows.push({ rejected: !!reported, original: failure === "throw" || failure === "queued" || failure === "replacement" ? reported === error : true,
        disposed: rt.disposed, aborted: rt.effects.signal.aborted, timers: rt.timeouts.size,
        owner: LeanUI.active === (replacement || previous), notifications });
      replacement?.dispose(); previous.dispose();
    }
    return rows;
  }, [0, 0, 1, 0, 1].map((notifications) => ({ rejected: true, original: true, disposed: true, aborted: true, timers: 0, owner: true, notifications }))],
  ["successful wasm startup drains input and releases module", async () => {
    const calls = [];
    let rt;
    globalThis.LifetimeModule = async () => ({
      lengthBytesUTF8(s) { return s.length; }, _malloc() { return 16n; }, stringToUTF8() {},
      _leanui_boot() { rt = LeanUI.active; calls.push("boot"); rt.send(0, 1, "queued"); return 1; },
      _leanui_event() { calls.push("event"); },
    });
    const returned = await LeanUI.start({ factory: "LifetimeModule", glue: "unused.js" });
    const transport = rt.transport;
    const result = { calls, same: returned === rt, active: LeanUI.active === rt, pending: rt.queue.length, busy: rt.busy };
    rt.dispose(); rt.dispose(); rt.send(0, 1, "late");
    return { ...result, released: transport.mod === null, inactive: LeanUI.active === null };
  }, { calls: ["boot", "event"], same: true, active: true, pending: 0, busy: false, released: true, inactive: true }],
  ["invalid remote mount restores previous owner", () => {
    const previous = new LeanUI.Runtime({}); LeanUI.active = previous;
    let rejected = false, calls = 0;
    globalThis.fetch = () => { calls++; throw new Error("unexpected network call"); };
    try { LeanUI.connect({ session: "test", selector: "[" }); } catch { rejected = true; }
    const result = { rejected, restored: LeanUI.active === previous, calls };
    previous.dispose(); return result;
  }, { rejected: true, restored: true, calls: 0 }],
  ["remote disposal cancels queued and late responses", async () => {
    let calls = 0, resolveResponse, aborted = false, applies = 0;
    globalThis.fetch = (_url, init) => {
      calls++; init.signal.addEventListener("abort", () => { aborted = true; });
      return new Promise((resolve) => { resolveResponse = resolve; });
    };
    const early = LeanUI.connect({ session: "early" }), earlyTransport = early.transport;
    early.dispose(); await earlyTransport.chain;
    const canceledBeforeSend = calls === 0;
    const rt = LeanUI.connect({ session: "live" }), transport = rt.transport;
    rt.apply = () => { applies++; };
    await Promise.resolve(); transport.event(1, "queued"); rt.dispose(); rt.dispose();
    resolveResponse({ status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    await transport.chain;
    return { canceledBeforeSend, calls, aborted, applies };
  }, { canceledBeforeSend: true, calls: 1, aborted: true, applies: 0 }],
];

let failures = 0;
for (const engine of engines) {
  const browser = await pw[engine].launch({ headless: true });
  try {
    for (const [name, test, expected] of tests) {
      const page = await browser.newPage();
      try {
        await page.setContent('<base href="http://lifetime.invalid/"><div id="app"></div>');
        await page.addScriptTag({ content: runtime });
        const result = await page.evaluate(test);
        assert.deepEqual(result, expected);
        console.log(`${engine}: PASS ${name}`);
      } catch (e) { failures++; console.error(`${engine}: FAIL ${name}`, e); }
      finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
assert.equal(failures, 0, `${failures} lifecycle failures`);
