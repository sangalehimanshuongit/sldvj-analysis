// SL-DVJ Analysis page. All work happens in this tab: files go to a web worker, never to a server.
"use strict";

const VERSION = "2.0";
const MAX_BYTES = 500 * 1024 * 1024;
const $ = (s) => document.querySelector(s);
const rows = [];
let nextId = 1, worker = null, ready = false, busy = false, calls = 0;
const pending = new Map();
let shareFiles = null, logLines = [];

/* ---------- small helpers ---------- */
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null) e.append(k.nodeType ? k : String(k));
  return e;
}
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("sldvj:" + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem("sldvj:" + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
function log(line) { logLines.push(line); }
function stamp() { return new Date().toISOString().slice(0, 16).replace("T", " "); }
function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB"; }

function call(cmd, args, transfer) {
  return new Promise((resolve) => {
    const id = ++calls;
    pending.set(id, resolve);
    worker.postMessage({ id, cmd, args }, transfer || []);
  });
}

/* ---------- start-up ---------- */
function setStatus(state, text, pct, hint) {
  $("#status-dot").className = "dot " + state;
  $("#status-text").textContent = text;
  if (pct != null) $("#status-bar").style.width = pct + "%";
  if (hint != null) $("#status-hint").textContent = hint;
}

function fail(text, hint) {
  ready = false;
  setStatus("failed", text, 0, hint);
  $("#drop").classList.add("disabled");
  updateRun();
}

async function start() {
  $("#version").textContent = VERSION;
  if (!window.Worker || typeof WebAssembly !== "object") {
    fail("This browser cannot run the analysis.", "Use a recent Chrome, Edge, Firefox or Safari.");
    return;
  }
  try {
    worker = new Worker("worker.js", { type: "module" });
  } catch (e) {
    fail("This browser cannot run the analysis.", "Update the browser, or use a recent Chrome, Edge, Firefox or Safari.");
    return;
  }
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "progress") setStatus("loading", m.step === "Ready" ? "Ready" : m.step + "…", m.pct);
    else if (m.type === "result") { const r = pending.get(m.id); pending.delete(m.id); if (r) r(m.result); }
  };
  worker.onerror = (ev) => {
    ev.preventDefault();
    fail("Could not load the analysis.", "Check the internet connection, then reload the page. If it fails again, update the browser.");
    for (const r of pending.values()) r({ ok: false, error: "the analysis stopped. Reload the page." });
    pending.clear();
  };
  const t0 = Date.now();
  const r = await call("init");
  if (!r.ok) { fail("Could not load the analysis.", "Check the internet connection, then reload the page. (" + r.error + ")"); return; }
  ready = true;
  setStatus("ready", "Ready", 100, `Loaded in ${Math.round((Date.now() - t0) / 1000)} s. You can now add files.`);
  $("#drop").classList.remove("disabled");
  log(`SL-DVJ Analysis ${VERSION}, started ${stamp()}`);
  log(`Browser: ${navigator.userAgent}`);
  for (const row of rows) if (row.status === "waiting") scan(row);
  updateRun();
}

/* ---------- adding files ---------- */
function parseName(name) {
  const m = name.match(/^([A-Za-z]+)[_\- ]+(\d+)[_\- ]+([A-Za-z0-9]+)/);
  return m ? { participant: m[2], session: m[3] } : { participant: "", session: "" };
}

async function filesFromDrop(dt) {
  const out = [];
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []);
  const readAll = (reader) => new Promise((res) => {
    const acc = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) res(acc); else { acc.push(...batch); next(); } }, () => res(acc));
    next();
  });
  const walk = async (entry, depth) => {
    if (entry.isFile) await new Promise((res) => entry.file((f) => { out.push(f); res(); }, () => res()));
    else if (entry.isDirectory && depth < 6) for (const e of await readAll(entry.createReader())) await walk(e, depth + 1);
  };
  for (const e of entries) await walk(e, 0);
  return out;
}

function addFiles(list) {
  const note = [];
  let added = 0;
  for (const f of list) {
    if (f.name.startsWith(".") || f.name.startsWith("~$")) continue;
    if (rows.some((r) => r.file.name === f.name && r.file.size === f.size)) { note.push(`${f.name} is already in the list.`); continue; }
    const row = { id: nextId++, file: f, ...parseName(f.name), leg: "", record: null, records: [],
                  status: "waiting", error: "", result: null };
    const known = store.get(`${row.participant}_${row.session}`);
    if (known && row.participant && /^[RL]$/.test(known.leg)) row.leg = known.leg;
    if (!/\.adicht$/i.test(f.name)) { row.status = "error"; row.error = "Not a LabChart .adicht file. Remove it from the list."; }
    else if (f.size === 0) { row.status = "error"; row.error = "The file is empty."; }
    else if (f.size > MAX_BYTES) { row.status = "error"; row.error = `The file is ${mb(f.size)}, too large for one session. Check that it is an SL-DVJ recording.`; }
    rows.push(row); added++;
    if (row.status === "waiting" && ready) scan(row);
  }
  const n = $("#drop-note");
  n.hidden = !note.length; n.textContent = note.join(" ");
  if (added) invalidateShare();
  render();
}

async function scan(row) {
  row.status = "checking"; render();
  let data;
  try { data = await row.file.arrayBuffer(); }
  catch (e) { row.status = "error"; row.error = "Could not open the file. Check that it is not open in LabChart or still syncing, then add it again."; render(); return; }
  const name = `scan_${row.id}.adicht`;
  const r = await call("scan", { name, data }, [data]);
  await call("forget", { name });
  if (!rows.includes(row)) return;
  if (!r.ok) { row.status = "error"; row.error = cap(r.error); row.detail = r.detail; }
  else {
    row.records = r.records; row.record = r.record; row.status = "ready";
    const known = store.get(`${row.participant}_${row.session}`);
    if (known && known.record && r.records.some((x) => x.record === known.record && x.jumps > 0)) row.record = known.record;
  }
  render();
}

function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------- validation ---------- */
function codesOf(row) { return `${row.participant}_${row.session}`; }
function problems(row) {
  const p = [];
  if (!/^\d{1,12}$/.test(row.participant)) p.push("Type the participant code (digits only).");
  if (!/^[A-Za-z0-9]{1,16}$/.test(row.session)) p.push("Type the session code (letters and digits only).");
  if (!row.leg) p.push("Choose the stance leg.");
  const twin = rows.find((o) => o !== row && o.status !== "error" && codesOf(o) === codesOf(row) && rows.indexOf(o) < rows.indexOf(row));
  if (twin && row.participant && row.session) p.push(`Same codes as ${twin.file.name}. Correct one of them.`);
  return p;
}
function usable(row) { return ["ready", "done", "failed"].includes(row.status); }

/* ---------- table ---------- */
function render() {
  const tb = $("#files tbody");
  const a = document.activeElement, tr0 = a && a.closest && a.closest("tr[data-id]");
  const keep = tr0 && a.tagName === "INPUT" ? { id: tr0.dataset.id, label: a.getAttribute("aria-label"),
    s: a.selectionStart, e: a.selectionEnd } : null;
  tb.textContent = "";
  for (const row of rows) tb.append(renderRow(row));
  if (keep) {
    const i = tb.querySelector(`tr[data-id="${keep.id}"] input[aria-label="${keep.label}"]`);
    if (i && !i.disabled) { i.focus(); try { i.setSelectionRange(keep.s, keep.e); } catch (e) { /* not a text box */ } }
  }
  $("#files-card").hidden = !rows.length;
  $("#run-card").hidden = !rows.length;
  updateRun();
}

function renderRow(row) {
  const locked = busy || row.status === "running";
  const edit = (key, cls) => el("input", {
    class: "code" + (row.status !== "error" && !(key === "participant" ? /^\d{1,12}$/ : /^[A-Za-z0-9]{1,16}$/).test(row[key]) ? " invalid" : ""),
    value: row[key], disabled: locked || row.status === "error", "aria-label": key + " code", maxlength: key === "participant" ? 12 : 16,
    oninput: (e) => {
      row[key] = e.target.value.trim();
      const okv = (key === "participant" ? /^\d{1,12}$/ : /^[A-Za-z0-9]{1,16}$/).test(row[key]);
      e.target.classList.toggle("invalid", !okv);
      changed(row);
      for (const o of rows) if (o !== row) refreshStatus(o);       // duplicate-code messages
    },
  });
  const legs = el("span", { class: "legs" + (!row.leg && row.status !== "error" ? " missing" : ""), role: "group", "aria-label": "stance leg" },
    ...["R", "L"].map((L) => el("button", {
      type: "button", class: row.leg === L ? "on" : "", disabled: locked || row.status === "error",
      "aria-pressed": row.leg === L ? "true" : "false", title: L === "R" ? "Right leg" : "Left leg",
      onclick: () => { row.leg = L; changed(row); render(); },
    }, L === "R" ? "Right" : "Left")));
  let rec = "";
  if (row.records.length) {
    const opts = row.records.filter((r) => r.jumps > 0);
    if (opts.length > 1) {
      rec = el("select", { disabled: locked, "aria-label": "record", onchange: (e) => { row.record = +e.target.value; changed(row); render(); } },
        ...opts.map((r) => el("option", { value: r.record, selected: r.record === row.record }, `${r.record}: ${r.jumps} jump${r.jumps === 1 ? "" : "s"}, ${r.seconds} s`)));
    } else {
      const r = row.records.find((x) => x.record === row.record);
      rec = r ? `${r.record} of ${row.records.length} (${r.jumps} jump${r.jumps === 1 ? "" : "s"})` : "";
    }
  }
  return el("tr", { "data-id": row.id },
    el("td", { class: "file" }, row.file.name),
    el("td", {}, edit("participant")),
    el("td", {}, edit("session")),
    el("td", {}, legs),
    el("td", {}, rec),
    el("td", {}, statusCell(row)),
    el("td", {}, el("button", { type: "button", class: "ghost", title: "Remove", "aria-label": "Remove " + row.file.name, disabled: locked,
      onclick: () => { rows.splice(rows.indexOf(row), 1); invalidateShare(); render(); } }, "×")));
}

function statusCell(row) {
  const d = el("div");
  const add = (cls, text) => d.append(el("div", { class: cls }, text));
  if (row.status === "waiting") add("st-busy", ready ? "Waiting" : "Waiting for the analysis to load");
  else if (row.status === "checking") add("st-busy", "Checking the file…");
  else if (row.status === "running") add("st-busy", `Analysing… ${row.elapsed || 0} s`);
  else if (row.status === "error") add("st-bad", row.error);
  else if (row.status === "failed") add("st-bad", "Not analysed: " + row.error);
  else if (row.status === "ready") {
    const p = problems(row);
    if (p.length) for (const x of p) add("st-warn msg", x); else add("", "Ready to analyse");
  } else if (row.status === "done") {
    const r = row.result;
    add("st-ok", `Done: ${r.n_trials} trial${r.n_trials === 1 ? "" : "s"}, body weight ${Math.round(r.body_weight_N)} N`);
    for (const f of r.flags) add("st-warn msg", "Check: trial flag " + f);
    for (const w of r.reader_warnings) add("st-warn msg", "Check: " + w);
    if (r.n_trials < 3) add("st-warn msg", "Check: fewer than 3 trials found.");
    d.append(el("div", { class: "msg" },
      el("button", { type: "button", class: "link", onclick: () => openReport(row) }, "Report"), "  ·  ",
      el("button", { type: "button", class: "link", onclick: () => downloadSession(row) }, "Download")));
  }
  return d;
}

function changed(row) {
  if (row.status === "done" || row.status === "failed") { row.status = "ready"; row.result = null; invalidateShare(); }
  if (row.participant && row.session && row.leg) store.set(codesOf(row), { leg: row.leg, record: row.record });
  updateRun();
  refreshStatus(row);
}

function refreshStatus(row) {
  const tr = document.querySelector(`tr[data-id="${row.id}"]`);
  if (tr) tr.children[5].replaceChildren(statusCell(row));
}

function todo() { return rows.filter((r) => r.status === "ready"); }
function updateRun() {
  const b = $("#analyse"), note = $("#run-note");
  const t = todo(), blocked = t.filter((r) => problems(r).length), checking = rows.filter((r) => ["waiting", "checking"].includes(r.status));
  b.disabled = !ready || busy || !t.length || blocked.length > 0 || checking.length > 0;
  b.textContent = busy ? "Analysing…" : t.length ? `Analyse ${t.length} session${t.length === 1 ? "" : "s"}` : "Analyse";
  if (!ready) note.textContent = "Wait until the status above says Ready.";
  else if (busy) note.textContent = "Keep this tab open until the analysis ends. Each session takes 10 to 60 s.";
  else if (checking.length) note.textContent = "Checking the files…";
  else if (blocked.length) note.textContent = `Complete the yellow items in the table (${blocked.length} file${blocked.length === 1 ? "" : "s"}).`;
  else if (t.length) note.textContent = `About ${Math.max(1, Math.round(t.length * 20 / 60))} minute${t.length * 20 > 90 ? "s" : ""} in all.`;
  else if (rows.some((r) => r.status === "done")) note.textContent = "All sessions are analysed. To add sessions, drop more files above.";
  else note.textContent = "No file is ready to analyse.";
}

/* ---------- analysis ---------- */
async function analyseAll() {
  const queue = todo().filter((r) => !problems(r).length);
  if (!queue.length) return;
  busy = true; invalidateShare(); render();
  log(`Analysis started ${stamp()}: ${queue.length} session(s)`);
  for (const row of queue) {
    if (!rows.includes(row)) continue;
    row.status = "running"; row.elapsed = 0; render();
    const t0 = Date.now();
    const tick = setInterval(() => {
      row.elapsed = Math.round((Date.now() - t0) / 1000);
      const tr = document.querySelector(`tr[data-id="${row.id}"]`);
      if (tr) tr.children[5].replaceChildren(statusCell(row));
    }, 1000);
    let r;
    try {
      const data = await row.file.arrayBuffer();
      r = await call("run", { name: `sdvj_${row.participant}_${row.session}.adicht`, data, record: row.record, leg: row.leg }, [data]);
    } catch (e) { r = { ok: false, error: "could not open the file. Check that it is not open in LabChart, then try again." }; }
    clearInterval(tick);
    const secs = Math.round((Date.now() - t0) / 1000);
    const code = `${row.session}_${row.participant}`;
    if (r.ok) {
      r.blobs = {};
      for (const f of r.fileData) r.blobs[f.path] = new Blob([f.data], { type: mime(f.path) });
      delete r.fileData;
      row.result = r; row.status = "done";
      store.set(codesOf(row), { leg: row.leg, record: row.record });
      log(`${code}: record ${row.record}, stance leg ${row.leg}, ${r.n_trials} trial(s), body weight ${Math.round(r.body_weight_N)} N, ${secs} s`);
      for (const f of r.flags) log(`${code}: check trial flag ${f}`);
      for (const w of r.reader_warnings) log(`${code}: check ${w}`);
    } else {
      row.status = "failed"; row.error = r.error;
      log(`${code}: not analysed: ${r.error}`);
      if (r.detail) log(r.detail);
    }
    render();
  }
  busy = false;
  await buildShare();
  render();
}

function mime(p) {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".csv")) return "text/csv";
  if (p.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function buildShare() {
  const done = rows.filter((r) => r.status === "done");
  $("#results-card").hidden = !done.length;
  if (!done.length) return;
  const failed = rows.filter((r) => r.status === "failed").length;
  log(`Finished ${stamp()}: ${done.length} analysed, ${failed} not analysed`);
  const r = await call("share", { dirs: done.map((x) => x.result.dir), log: logLines.join("\n") + "\n" });
  const note = $("#share-note");
  if (!r.ok) { shareFiles = null; note.hidden = false; note.textContent = "Could not build the summary: " + r.error; return; }
  shareFiles = r.fileData;
  note.hidden = !failed;
  note.textContent = failed ? `${failed} file(s) were not analysed. Their reasons are in the table and in Run log.txt.` : "";
}

function invalidateShare() { shareFiles = null; $("#results-card").hidden = true; }

/* ---------- output ---------- */
async function zipAndSave(entries, name) {
  const files = {};
  for (const [path, data] of entries) files[path] = [data, { level: /\.(png|zip)$/.test(path) ? 0 : 6 }];
  const zipped = fflate.zipSync(files);
  save(new Blob([zipped], { type: "application/zip" }), name);
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function sessionEntries(row, prefix) {
  const out = [];
  for (const [p, b] of Object.entries(row.result.blobs)) out.push([prefix + p, new Uint8Array(await b.arrayBuffer())]);
  return out;
}

async function downloadSession(row) {
  await zipAndSave(await sessionEntries(row, row.result.suffix + "/"), `SLDVJ results ${row.result.suffix}.zip`);
}

async function downloadAll() {
  const b = $("#dl-all"); b.disabled = true; b.textContent = "Preparing…";
  try {
    let entries = [];
    for (const row of rows.filter((r) => r.status === "done")) entries = entries.concat(await sessionEntries(row, row.result.suffix + "/"));
    await zipAndSave(entries, `SLDVJ all results ${new Date().toISOString().slice(0, 10)}.zip`);
  } catch (e) {
    alert("Could not build the zip (" + e.message + "). Download the sessions one at a time with the Download links in the table.");
  } finally { b.disabled = false; b.textContent = "Download all results"; }
}

async function downloadShare() {
  if (!shareFiles) await buildShare();
  if (!shareFiles) return;
  await zipAndSave(shareFiles.map((f) => ["SLDVJ summary/" + f.path, f.data]), `SLDVJ summary for Calgary ${new Date().toISOString().slice(0, 10)}.zip`);
}

function openReport(row) {
  const blob = row.result.blobs[row.result.page];
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (!w) save(blob, row.result.page);
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60000);
}

/* ---------- wiring ---------- */
function wire() {
  const drop = $("#drop"), picker = $("#picker");
  drop.addEventListener("click", () => { if (!drop.classList.contains("disabled")) picker.click(); });
  drop.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !drop.classList.contains("disabled")) { e.preventDefault(); picker.click(); } });
  picker.addEventListener("change", () => { addFiles(Array.from(picker.files)); picker.value = ""; });
  for (const t of ["dragenter", "dragover"]) document.addEventListener(t, (e) => { e.preventDefault(); if (!busy) drop.classList.add("over"); });
  for (const t of ["dragleave", "dragend"]) document.addEventListener(t, (e) => { if (e.target === drop || !e.relatedTarget) drop.classList.remove("over"); });
  document.addEventListener("drop", async (e) => {
    e.preventDefault(); drop.classList.remove("over");
    if (busy || drop.classList.contains("disabled")) return;
    addFiles(await filesFromDrop(e.dataTransfer));
  });
  $("#analyse").addEventListener("click", analyseAll);
  $("#all-r").addEventListener("click", () => setAll("R"));
  $("#all-l").addEventListener("click", () => setAll("L"));
  $("#clear").addEventListener("click", () => {
    if (rows.some((r) => r.status === "done") && !confirm("Remove all files and results from the page?")) return;
    rows.length = 0; invalidateShare(); render();
  });
  $("#dl-share").addEventListener("click", downloadShare);
  $("#dl-all").addEventListener("click", downloadAll);
  window.addEventListener("beforeunload", (e) => {
    if (busy || rows.some((r) => r.status === "done")) { e.preventDefault(); e.returnValue = ""; }
  });
}

function setAll(L) {
  for (const r of rows) if (r.status !== "error" && r.status !== "running") { r.leg = L; changed(r); }
  render();
}

wire();
render();
start();
