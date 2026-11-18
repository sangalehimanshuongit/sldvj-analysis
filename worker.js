// Runs the Python analysis (Pyodide) off the page thread. Loads only files from this site.
import { loadPyodide } from "./pyodide/pyodide.mjs";

const PACKAGES = ["numpy", "scipy", "pandas", "matplotlib"];
let py = null;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

async function init() {
  const base = new URL("./pyodide/", import.meta.url).href;
  post({ type: "progress", step: "Starting Python", pct: 5 });
  py = await loadPyodide({ indexURL: base, stdout: () => {}, stderr: () => {} });
  post({ type: "progress", step: "Loading the analysis packages", pct: 35 });
  await py.loadPackage(PACKAGES, { messageCallback: () => {}, errorCallback: () => {} });
  post({ type: "progress", step: "Loading the SL-DVJ analysis", pct: 85 });
  const res = await fetch(new URL("./analysis.zip", import.meta.url));
  if (!res.ok) throw new Error(`analysis.zip: HTTP ${res.status}`);
  py.unpackArchive(await res.arrayBuffer(), "zip", { extractDir: "/app" });
  py.runPython(`
import sys
sys.path.insert(0, "/app")
import sldvj_web
`);
  py.FS.mkdirTree("/in"); py.FS.mkdirTree("/out");
  post({ type: "progress", step: "Ready", pct: 100 });
}

function call(fn, ...args) {
  const mod = py.pyimport("sldvj_web");
  try { return JSON.parse(mod[fn](...args)); } finally { mod.destroy(); }
}

function readTree(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const n of py.FS.readdir(d)) {
      if (n === "." || n === "..") continue;
      const p = d + "/" + n, r = rel ? rel + "/" + n : n;
      if (py.FS.isDir(py.FS.stat(p).mode)) walk(p, r);
      else files.push({ path: r, data: py.FS.readFile(p) });
    }
  };
  walk(dir, "");
  return files;
}

const handlers = {
  async init() { await init(); return { ok: true }; },
  scan({ name, data }) {
    py.FS.writeFile("/in/" + name, new Uint8Array(data));
    return call("scan", name);
  },
  forget({ name }) {
    try { py.FS.unlink("/in/" + name); } catch (e) { /* already gone */ }
    return { ok: true };
  },
  run({ name, data, record, leg }) {
    py.FS.writeFile("/in/" + name, new Uint8Array(data));
    let r;
    try { r = call("run", name, record, leg); }
    finally { try { py.FS.unlink("/in/" + name); } catch (e) { /* already gone */ } }
    if (!r.ok) return r;
    r.fileData = readTree(r.dir).filter((f) => r.deliver.includes(f.path));
    const mod = py.pyimport("sldvj_web");
    try { mod.trim(r.dir); } finally { mod.destroy(); }
    return r;
  },
  share({ dirs, log }) {
    const r = call("share", JSON.stringify(dirs), log);
    if (!r.ok) return r;
    r.fileData = readTree("/share");
    return r;
  },
};

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data;
  try {
    const result = await handlers[cmd](args || {});
    const transfer = (result.fileData || []).map((f) => f.data.buffer);
    post({ type: "result", id, result }, transfer);
  } catch (err) {
    post({ type: "result", id, result: { ok: false, error: `the page hit an internal error (${err && err.message || err})`, detail: String(err && err.stack || "") } });
  }
};
