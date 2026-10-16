// The panel's three static assets, kept as strings so the build ships them inside dist/ with no copy step.
// They load nothing from outside the panel: no external URL, no inline script or style (the CSP forbids both).
// app.js writes every value with textContent, never as HTML, so chain content cannot run as markup.

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Intent gateway panel</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header>
<h1>Intent gateway</h1>
<p>Read-only view of this gateway's local log. It shows what the gateway sent and what Intent Cloud acknowledged receiving.</p>
</header>
<main>
<section><h2>Chain</h2><p id="chain">Loading…</p></section>
<section><h2>Approver pin</h2><p id="pin"></p><ul id="flags"></ul></section>
<section><h2>Pending approvals</h2><ul id="pending"></ul></section>
<section><h2>Disclosures</h2>
<table>
<thead><tr><th>#</th><th>Time</th><th>Kind</th><th>Endpoint</th><th>Fields sent</th><th>Fields blocked</th><th>Note</th></tr></thead>
<tbody id="rows"></tbody>
</table>
</section>
</main>
</body>
</html>
`;

export const APP_JS = `"use strict";
(function () {
  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function byId(id) {
    return document.getElementById(id);
  }
  function fill(list, items, empty, render) {
    list.replaceChildren();
    if (items.length === 0) list.appendChild(el("li", empty, "muted"));
    items.forEach(function (item) { list.appendChild(render(item)); });
  }
  function show(data) {
    var view = data.view;
    var chain = byId("chain");
    if (view.chain.ok) {
      chain.textContent = "Valid: " + data.entries.length + " entries.";
      chain.className = "ok";
    } else {
      chain.textContent = "Broken at seq " + view.chain.brokenSeq + ": " + view.chain.reason;
      chain.className = "bad";
    }
    byId("pin").textContent = view.pin
      ? "Fingerprint " + view.pin.fingerprint + " (pinned at #" + view.pin.seq + ", " + view.pin.ts + ")"
      : "No approver pinned yet. The first verified Approval sets the pin.";
    fill(byId("flags"), view.flags, "No flagged passkeys.", function (flag) {
      return el("li", "Flagged passkey " + flag.fingerprint + " (#" + flag.seq + "). Accept it only with " + data.intent + " approver accept at a terminal.", "bad");
    });
    fill(byId("pending"), view.pending, "No pending approvals.", function (p) {
      var li = el("li");
      li.appendChild(el("span", "#" + p.seq + " " + p.handle + " "));
      li.appendChild(el("code", p.approvalUrl));
      return li;
    });
    var rows = byId("rows");
    rows.replaceChildren();
    view.rows.forEach(function (r) {
      var tr = el("tr", undefined, r.kind);
      [r.seq, r.ts, r.kind, r.endpoint, r.fields.join(", "), r.blocked.join(", "), r.note].forEach(function (v) {
        tr.appendChild(el("td", v));
      });
      rows.appendChild(tr);
    });
  }
  function load() {
    fetch("/entries.json", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(show)
      .catch(function (err) {
        var chain = byId("chain");
        chain.textContent = "Could not read the log: " + err.message;
        chain.className = "bad";
      });
  }
  document.addEventListener("DOMContentLoaded", function () {
    load();
    setInterval(load, 5000);
  });
})();
`;

export const APP_CSS = `body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 72rem; padding: 0 16px 2rem; color: #1b1f24; background: #fff; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 1.5rem; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border-bottom: 1px solid #d0d7de; padding: 4px 8px; text-align: left; vertical-align: top; }
code { word-break: break-all; }
.ok { color: #1a7f37; font-weight: 600; }
.bad { color: #cf222e; font-weight: 600; }
.muted { color: #57606a; }
tr.block td, tr.discarded td { color: #cf222e; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  th, td { border-color: #30363d; }
  .ok { color: #3fb950; }
  .bad, tr.block td, tr.discarded td { color: #ff7b72; }
  .muted { color: #8b949e; }
}
`;
