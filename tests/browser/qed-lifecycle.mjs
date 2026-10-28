// QED64 adapter lifetime with a real Worker speaking a small deterministic protocol fixture.
// No lean.wasm/snapshot download: the producer and rendering workloads are tested by race.mjs.
//   node tests/browser/qed-lifecycle.mjs [chromium] [firefox]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { pw } from "./playwright.mjs";

const runtime = fs.readFileSync(new URL("../../runtime/leanui.js", import.meta.url));
const adapter = fs.readFileSync(new URL("../../qed64/lane/leanui-qed64.js", import.meta.url));
const worker = `
const mode = new URL(location.href).searchParams.get('mode');
const reply = (updates = [], mount = false) => postMessage({type:'reply', updates, mount, leanNs:0, workerMs:0, errors:[], bytes:0}, updates);
onmessage = ({data:m}) => {
  if (m.type === 'boot') {
    for (const name of ['downloaded','runtime','mounted']) postMessage({type:'phase',name,at:performance.timeOrigin+performance.now()});
    if (mode === 'hold-mount') return;
    const tag = 'dispose-during-mount';
    let text = 'ready#app', ops = [2,1,0,5,18,5,4,1];
    if (mode === 'mount-disposal') { text = tag+'#app'; ops = [17,1,0,tag.length,1,1,0,1,18,tag.length,4,1]; }
    else if (mode === 'mount-error') { text += '['; ops.push(18,9,1,1); }
    const words = new Uint32Array(ops);
    const strings = new TextEncoder().encode(text), packet = new Uint8Array(4+words.byteLength+strings.length);
    new DataView(packet.buffer).setUint32(0,words.byteLength,true);
    packet.set(new Uint8Array(words.buffer),4); packet.set(strings,4+words.byteLength);
    reply([packet.buffer],true);
  } else if (m.type === 'ping') { if (mode !== 'hold-ping') reply(); }
  else if (mode === 'fail-event') postMessage({type:'stopped',message:'fixture worker failure'});
  else if (mode !== 'hold-event') reply();
};`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (url.pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end('<div id="app"></div><script src="/runtime.js"></script><script src="/adapter.js"></script>');
  } else if (url.pathname === "/runtime.js" || url.pathname === "/adapter.js" || url.pathname === "/worker.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(url.pathname === "/runtime.js" ? runtime : url.pathname === "/adapter.js" ? adapter : worker);
  } else if (url.pathname === "/config.json") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rt: "/", worker: "/worker.js?mode=" + url.searchParams.get("mode"), app: "fixture",
      leanJs: "unused.js", leanWasm: "unused.wasm", core: "unused.js", snapshot: "unused.snap", snapshotDeps: "unused.deps", runFile: "unused.lean" }));
  } else { res.writeHead(url.pathname === "/favicon.ico" ? 204 : 404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

async function evaluate(page, fn, arg) {
  let timer;
  try {
    return await Promise.race([page.evaluate(fn, arg), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("QED64 adapter test did not settle within 15 seconds")), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

async function open(browser) {
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base);
  assert.equal(await evaluate(page, () => crossOriginIsolated), true);
  await evaluate(page, () => {
    const Runtime = LeanUI.Runtime, BrowserWorker = Worker;
    window.runtimes = []; window.workers = [];
    LeanUI.Runtime = class extends Runtime { constructor(...args) { super(...args); runtimes.push(this); } };
    window.Worker = class extends BrowserWorker {
      constructor(...args) {
        if (window.constructorError) throw constructorError;
        super(...args); this.record = { worker: this, terminations: 0, posts: 0 }; workers.push(this.record);
        if (window.disposeOnWorkerCreate) LeanUI.active.dispose();
      }
      postMessage(...args) { this.record.posts++; return super.postMessage(...args); }
      terminate() { this.record.terminations++; return super.terminate(); }
    };
    window.previous = new LeanUI.Runtime({}); LeanUI.active = previous;
    window.notifications = 0;
    document.querySelector("#app").addEventListener("leanui:error", (e) => { notifications++; window.lastError = e.detail; });
  });
  return { page, errors };
}

async function successAndDispose(browser) {
  const { page, errors } = await open(browser);
  try {
    const result = await evaluate(page, async () => {
      const rt = await LeanUIQed64.start({ config: "/config.json?mode=hold-event" }), tr = rt.transport;
      const ready = document.querySelector("#app").textContent === "ready";
      tr.event(1, "pending");
      const waiting = tr.idle().then(() => "resolved", (e) => e.name);
      const record = workers[0], posts = record.posts;
      rt.dispose(); rt.dispose(); tr.event(1, "late");
      // A reply already captured by page code must also be ignored after cleanup.
      tr.onReply({ updates: [new Uint8Array(4).buffer], errors: [], leanNs: 0, workerMs: 0 });
      return { ready, wait: await waiting, terminations: record.terminations, latePosts: record.posts - posts,
        workerReleased: tr.worker === null, handlersReleased: record.worker.onmessage === null && record.worker.onerror === null && tr.rejectMount === null,
        aborted: rt.effects.signal.aborted, inactive: LeanUI.active === null, previousLive: !previous.disposed, notifications };
    });
    assert.deepEqual(result, { ready: true, wait: "AbortError", terminations: 1, latePosts: 0, workerReleased: true,
      handlersReleased: true, aborted: true, inactive: true, previousLive: true, notifications: 0 });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function terminal(browser, domError = false) {
  const { page, errors } = await open(browser);
  try {
    const result = await evaluate(page, async (domError) => {
      const rt = await LeanUIQed64.start({ config: "/config.json?mode=fail-event" }), tr = rt.transport;
      rt.timeouts.add(setTimeout(() => {}, 60000));
      const original = new Error("fixture DOM failure");
      if (domError) { rt.apply = () => { throw original; }; }
      tr.event(1, "fail");
      const waiting = tr.idle().then(() => false, (e) => e);
      if (domError) tr.onReply({ updates: [new Uint8Array(4).buffer] });
      const reason = await waiting;
      tr.die(new Error("duplicate"));
      return { disposed: rt.disposed, aborted: rt.effects.signal.aborted, timers: rt.timeouts.size, notifications,
        sameError: reason === rt.crashed && reason === window.lastError && (!domError || reason === original),
        terminations: workers[0].terminations, pending: tr.out, inactive: LeanUI.active === null };
    }, domError);
    assert.deepEqual(result, { disposed: true, aborted: true, timers: 0, notifications: 1, sameError: true, terminations: 1, pending: 0, inactive: true });
    assert.equal(errors.length, 1); assert.match(errors[0], /app stopped/);
  } finally { await page.close(); }
}

async function startupFailure(browser, mode) {
  const { page, errors } = await open(browser);
  try {
    await evaluate(page, (mode) => {
      if (mode === "constructor") window.constructorError = new Error("fixture Worker constructor failure");
      if (mode === "constructor-disposal") window.disposeOnWorkerCreate = true;
      if (mode === "progress-disposal") {
        customElements.define("dispose-on-progress", class extends HTMLElement {
          disconnectedCallback() { if (LeanUI.active !== previous) LeanUI.active.dispose(); }
        });
        document.querySelector("#app").append(document.createElement("dispose-on-progress"));
      }
      if (mode === "mount-error") document.querySelector("#app").addEventListener("leanui:error", () => {
        window.replacement = new LeanUI.Runtime({}); LeanUI.active = replacement;
      }, { once: true });
      if (mode === "mount-disposal") customElements.define("dispose-during-mount", class extends HTMLElement { constructor() { super(); LeanUI.active.dispose(); } });
      const options = { config: "/config.json?mode=" + mode };
      if (mode === "selector") options.selector = "[";
      if (mode === "post") options.flags = () => {};   // native postMessage rejects an uncloneable value
      window.startup = LeanUIQed64.start(options).then(() => ({ resolved: true }), (e) => ({ name: e.name, original: mode === "mount-error" ? e === window.lastError : !window.constructorError || e === constructorError }));
    }, mode);
    if (mode === "hold-mount" || mode === "hold-ping") {
      await page.waitForFunction((mode) => workers.length === 1 && !!workers[0].worker.onmessage &&
        (mode !== "hold-ping" || workers[0].posts >= 2), mode);
      await evaluate(page, () => LeanUI.active.dispose());
    }
    const result = await evaluate(page, async () => {
      const error = await startup, rt = runtimes[1];
      return { error, restored: LeanUI.active === (window.replacement || previous), disposed: rt.disposed, aborted: rt.effects.signal.aborted,
        released: rt.transport === null, tables: [rt.nodes.length, rt.tpl.length], terminations: workers.map((r) => r.terminations), notifications };
    });
    const name = mode === "constructor" ? "Error" : (mode === "selector" || mode === "mount-error") ? "SyntaxError" : mode === "post" ? "DataCloneError" : "AbortError";
    assert.deepEqual(result, { error: { name, original: true }, restored: true, disposed: true, aborted: true, released: true,
      tables: [0, 0], terminations: mode === "constructor" || mode === "selector" ? [] : [1], notifications: mode === "mount-error" ? 1 : 0 });
    if (mode === "mount-error") { assert.equal(errors.length, 1); assert.match(errors[0], /app stopped/); }
    else assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

const engines = process.argv.slice(2);
if (!engines.length) engines.push("chromium", "firefox");
try {
  for (const engine of engines) {
    const browser = await pw[engine].launch({ headless: true });
    try {
      for (const [name, test] of [["ready and explicit disposal", successAndDispose], ["terminal worker failure", terminal],
        ["terminal DOM failure", (b) => terminal(b, true)],
        ...["hold-mount", "hold-ping", "mount-disposal", "mount-error", "selector", "constructor", "constructor-disposal", "progress-disposal", "post"].map((mode) => ["startup " + mode, (b) => startupFailure(b, mode)])]) {
        await test(browser); console.log(`${engine}: PASS QED64 ${name}`);
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
