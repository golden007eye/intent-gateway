// The panel's two static assets, kept as strings so the build ships them inside dist/ with no copy step. The page
// itself is rendered per request (render.ts). Neither loads anything from outside the panel, and the CSP forbids
// inline script and style. app.js never parses chain content as markup of its own: it swaps in regions of the
// panel's own server-escaped page, read with DOMParser (scripts in it never run).
import { UI_CSS } from "../ui/index.ts";

/**
 * The page's only script, served same-origin under `script-src 'self'`:
 * - routing: `#/overview`, `#/purchases`, `#/purchases/a-<seq>` (a step's details drawer), `#/approvals`,
 *   `#/policy`, `#/log?kind=…&q=…`, `#/verify`; one view at a time, aria-current on its nav link, focus on its heading
 *   when you navigate, Escape closes a drawer, back and forward work because every view is a URL;
 * - the server log filter (kind and free text), kept in the address;
 * - live refresh: every 4 s (not while the tab is hidden) it re-reads the page and replaces only the regions whose
 *   version changed, keeping focus, open entries and the filter.
 */
export const APP_JS = `"use strict";
(function () {
  var VIEWS = ["overview", "purchases", "approvals", "policy", "log", "verify"];
  var NAMES = { overview: "Overview", purchases: "Purchases", approvals: "Approvals", policy: "Policy", log: "Server log", verify: "Verify" };
  var BASE = document.title;
  var current = null;
  var opener = null;

  function route() {
    var h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch (e) { h = ""; }
    var q = h.indexOf("?");
    var path = q < 0 ? h : h.slice(0, q);
    var parts = path.split("/").filter(Boolean);
    var view = VIEWS.indexOf(parts[0]) >= 0 ? parts[0] : "overview";
    return { view: view, drawer: view === "purchases" && parts[1] ? parts[1] : null, query: new URLSearchParams(q < 0 ? "" : h.slice(q + 1)) };
  }

  function apply(focus) {
    var r = route();
    document.querySelectorAll(".view").forEach(function (s) { s.hidden = s.getAttribute("data-view") !== r.view; });
    document.querySelectorAll("[data-route]").forEach(function (a) {
      if (a.getAttribute("data-route") === r.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    var open = null;
    document.querySelectorAll(".drawer").forEach(function (d) {
      var on = r.drawer !== null && d.id === "/purchases/" + r.drawer;
      d.classList.toggle("open", on);
      if (on) open = d;
    });
    document.body.classList.toggle("has-drawer", open !== null);
    if (r.view === "log") filterLog(r.query);
    document.title = NAMES[r.view] + " · " + BASE;
    if (focus) {
      var target = open ? open.querySelector("h2") : document.getElementById("h-" + r.view);
      if (target) target.focus({ preventScroll: open !== null });
    }
    // The browser scrolls to the element a hash names (the view's section); a view starts at the top instead.
    if (current !== r.view) window.scrollTo(0, 0);
    current = r.view;
  }

  function filterLog(query) {
    var kind = document.getElementById("log-kind");
    var find = document.getElementById("log-q");
    if (!kind || !find) return;
    if (query) {
      if (document.activeElement !== kind) kind.value = query.get("kind") || "";
      if (document.activeElement !== find) find.value = query.get("q") || "";
    }
    var k = kind.value;
    var words = find.value.toLowerCase().split(/\\s+/).filter(Boolean);
    var rows = document.querySelectorAll("#log-rows > li");
    var shown = 0;
    rows.forEach(function (li) {
      var text = li.textContent.toLowerCase();
      var keep = (k === "" || li.getAttribute("data-kind") === k) && words.every(function (w) { return text.indexOf(w) >= 0; });
      li.hidden = !keep;
      if (keep) shown += 1;
    });
    var out = document.getElementById("log-shown");
    if (out) out.textContent = k === "" && words.length === 0 ? rows.length + " entries" : "showing " + shown + " of " + rows.length;
  }

  function onFilter() {
    var kind = document.getElementById("log-kind").value;
    var q = document.getElementById("log-q").value;
    var params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (q) params.set("q", q);
    var s = params.toString();
    history.replaceState(null, "", "#/log" + (s ? "?" + s : ""));
    filterLog(null);
  }

  // The panel's only write (ADR-0023): a POST carrying this run's token in a header, which no other page can read or send.
  function pausePurchases(button) {
    var meta = document.querySelector('meta[name="intent-panel-token"]');
    if (!meta) return;
    button.disabled = true;
    fetch("/pause", { method: "POST", cache: "no-store", headers: { "x-intent-panel-token": meta.getAttribute("content") } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        refresh();
      })
      .catch(function () { button.disabled = false; document.body.classList.add("stale"); });
  }

  function refresh() {
    if (document.hidden) return;
    fetch("/", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        // A region the fresh page no longer has is emptied, so nothing stale stays on screen.
        document.querySelectorAll("[data-live]").forEach(function (old) {
          if (!doc.querySelector('[data-live="' + old.getAttribute("data-live") + '"]')) {
            old.textContent = "";
            old.setAttribute("data-v", "");
          }
        });
        doc.querySelectorAll("[data-live]").forEach(function (fresh) {
          var old = document.querySelector('[data-live="' + fresh.getAttribute("data-live") + '"]');
          if (!old || old.getAttribute("data-v") === fresh.getAttribute("data-v")) return;
          var active = document.activeElement;
          var keep = active && old.contains(active) ? active.getAttribute("href") || active.id : null;
          var opened = [];
          old.querySelectorAll("details[open]").forEach(function (d) { opened.push(d.parentNode.textContent.slice(0, 40)); });
          var node = document.importNode(fresh, true);
          old.replaceWith(node);
          node.querySelectorAll("details").forEach(function (d) {
            if (opened.indexOf(d.parentNode.textContent.slice(0, 40)) >= 0) d.open = true;
          });
          if (keep) {
            var again = node.querySelector('[href="' + keep + '"]') || document.getElementById(keep);
            if (again) again.focus({ preventScroll: true });
          }
        });
        document.body.classList.remove("stale");
        apply(false);
      })
      .catch(function () { document.body.classList.add("stale"); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("log-filters");
    if (form) {
      form.hidden = false;
      form.addEventListener("submit", function (e) { e.preventDefault(); });
      form.addEventListener("input", onFilter);
      form.addEventListener("change", onFilter);
    }
    document.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("[data-drawer]") : null;
      if (a) opener = a.getAttribute("href");
      var pause = e.target.closest ? e.target.closest("[data-pause]") : null;
      if (pause) pausePurchases(pause);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("has-drawer")) {
        location.hash = "#/purchases";
        var back = opener && document.querySelector('[href="' + opener + '"]');
        if (back) back.focus();
      }
    });
    window.addEventListener("hashchange", function () { apply(true); });
    // At load the browser scrolls to the section the address names, past the brand bar; start at the top instead.
    window.addEventListener("load", function () { window.scrollTo(0, 0); });
    apply(false);
    setInterval(refresh, 4000);
  });
})();
`;

// The panel's own rules on top of UI_CSS (tokens only). A side nav on the left; under 768px it becomes a row of
// tabs under the brand bar, wrapping to a second line rather than scrolling, so every tab stays in sight. Without app.js every view is listed one after another and the nav links scroll to them.
// Rows: the brand bar, the pause region (an empty row without one), then nav and main. The pause region's grid item
// is its live wrapper, not the bar inside it, so the wrapper is what spans; otherwise it takes the nav's cell.
const PANEL_CSS = `.app{display:grid;grid-template-columns:220px minmax(0,1fr);grid-template-rows:auto auto 1fr;min-height:100vh}
.app>.live{grid-column:1/-1;grid-row:2}
.nav,main{grid-row:3}
.skip{position:absolute;left:8px;top:-60px;z-index:10;background:var(--sage);color:var(--ground);padding:8px 12px;border-radius:8px;font-weight:600}
.skip:focus{top:8px}
a{color:var(--sage)}a:hover{color:var(--on-ground)}
a:focus-visible,summary:focus-visible,select:focus-visible,input:focus-visible,button:focus-visible,[tabindex]:not([tabindex="-1"]):focus-visible{outline:2px solid var(--sage);outline-offset:2px}
[tabindex="-1"]:focus{outline:none}
.bar{grid-column:1/-1;grid-row:1;display:flex;align-items:center;gap:14px;padding:16px 28px;border-bottom:1px solid var(--card-line);flex-wrap:wrap}
.bar .brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.product{font-size:15px;color:var(--on-card-muted)}
.pause-bar,.pause-banner{margin:0;padding:12px 28px;border-bottom:1px solid var(--card-line);display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}
.pause-bar p,.pause-banner p{margin:0}
.pause-banner{display:block;background:var(--warn-bg);color:var(--warn-text);border:1px solid var(--demo-bg);border-left:8px solid var(--demo-bg)}
.pause-banner strong{display:block;font-size:17px;font-weight:700;margin-bottom:2px}
.pause-banner p+p,.pause-banner ul+p{margin-top:4px}
.pause-banner code{font-weight:600}
.pause-banner ul{margin:4px 0;padding-left:20px}
.pause-button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--warn-text);background:transparent;color:inherit;cursor:pointer}
.pause-button:disabled{opacity:.5;cursor:default}
.pill-real{background:transparent;color:var(--sage);border:1px solid var(--sage)}
.bar .live{margin-left:auto}
.meta{font-size:12px;color:var(--on-card-muted)}
.stale .meta::after{content:" · not refreshing: the panel is not answering";color:var(--danger-on-ground)}
.nav{padding:18px 14px;border-right:1px solid var(--card-line);display:flex;flex-direction:column;gap:12px}
.nav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;position:sticky;top:16px}
.nav a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-radius:8px;color:var(--on-ground);text-decoration:none;font-size:15px}
.nav a:hover{background:var(--card)}
.nav a[aria-current="page"]{background:var(--sage);color:var(--ground);font-weight:600}
.nav .live{display:contents}
.count{font:12px/1.5 var(--mono);min-width:2.2em;text-align:center;padding:0 7px;border-radius:999px;background:var(--card-line);color:var(--on-ground)}
.nav a[aria-current="page"] .count{background:var(--ground);color:var(--sage)}
.badge{font:600 12px/1.4 var(--mono);background:var(--demo-bg);color:var(--demo-text);border-radius:999px;padding:1px 8px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}.dot-ok{background:var(--success)}.dot-bad{background:var(--danger-on-ground)}
.nav-foot{margin-top:auto;font-size:12px;color:var(--on-card-muted);padding:0 12px}
main{padding:24px 28px 48px;min-width:0;outline:none}
.view{display:flex;flex-direction:column;gap:16px;margin-bottom:40px;scroll-margin-top:96px}
.view[hidden]{display:none}
.view>.live{display:flex;flex-direction:column;gap:16px}
.view h1{font-size:22px;font-weight:600;letter-spacing:-.01em}
h2{font-size:15px;font-weight:600}
h3{font-size:13px;font-weight:600;margin:6px 0 0}
.lede{color:var(--on-card-muted);font-size:14px;max-width:46rem}
.muted{color:var(--on-card-muted)}
.small{font-size:12.5px;color:var(--on-card-muted);margin:0}
.mono{font-family:var(--mono);overflow-wrap:anywhere}
.t-ok{color:var(--success)}.t-warn{color:var(--demo-bg)}.t-bad{color:var(--danger-on-ground)}.t-plain{color:inherit}
.small.t-ok,.small.t-warn{color:inherit}.small.t-ok{color:var(--success)}.small.t-warn{color:var(--demo-bg)}
code{font-size:.92em;overflow-wrap:anywhere}
code.cmd{margin:0 .2em}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--card-line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:6px;min-width:0}
.card-hot{border:1.5px solid var(--sage)}
.card .k{font-size:13px;color:var(--on-card-muted)}
.card .v{font:600 30px/1.2 var(--mono);color:var(--on-ground)}
.card .v.t-bad{color:var(--danger-on-ground)}
.bar-track{height:6px;background:var(--card-line);border-radius:3px;overflow:hidden}
.bar-fill{height:6px;background:var(--sage);border-radius:3px;width:0}
${Array.from({ length: 21 }, (_, i) => `.w${String(i * 5)}{width:${String(i * 5)}%}`).join("")}
.split{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.panel{background:var(--card);border:1px solid var(--card-line);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:10px;min-width:0}
.feed-panel{grid-column:span 2}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.panel-head h2{margin:0}
.btn-inline{display:inline-flex;width:auto;min-height:36px;padding:8px 14px;font-size:14px;text-decoration:none}
.feed{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;font-size:14px}
.feed li{display:grid;grid-template-columns:52px 84px minmax(0,1fr);gap:12px}
.feed time{font-family:var(--mono);color:var(--on-card-muted)}
.rules p{font-size:14px}.rules .small{font-size:12px}
.more{font-size:13px;margin-top:auto}
.logstrip{background:var(--ground)}
.strip{list-style:none;margin:0;padding:0;font:12.5px/1.6 var(--mono);color:var(--on-ground-muted)}
.strip li{overflow-wrap:anywhere}.strip li span:first-child{color:var(--on-ground)}
.purchase{background:var(--card);border:1px solid var(--card-line);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:10px}
.ph{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.ph h2{font-size:16px}
.chip{font-size:13px;border-radius:999px;padding:3px 10px;white-space:nowrap}
.chip-ok{color:var(--deep-sage);background:var(--deep-sage-bg)}.chip-warn{color:var(--warn-text);background:var(--warn-bg)}
.chip-bad{color:var(--danger);background:var(--danger-bg)}.chip-plain{color:var(--on-paper);background:var(--paper-2)}
.steps-line{list-style:none;margin:4px 0 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;font-size:13px}
.step{border-top:3px solid var(--card-line);padding-top:8px;display:flex;flex-direction:column;gap:2px;min-width:0}
.step-done{border-top-color:var(--sage)}.step-waiting{border-top-color:var(--demo-bg)}.step-failed{border-top-color:var(--danger-on-ground)}
.step .sn{font-weight:600}.step-todo .sn{color:var(--on-card-muted)}
.refusals{background:var(--card);border:1px solid var(--danger-on-ground);border-radius:14px;padding:14px 20px;display:flex;flex-direction:column;gap:8px}
.refusals ul,.rows,.cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:14px}
.refusals time,.rows time{color:var(--on-card-muted);font:12px var(--mono);margin-left:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:12px}
.cards .btn{margin-top:8px;text-decoration:none;min-height:44px;padding:10px 14px;font-size:15px}
.fpr{font:600 18px/1.4 var(--mono);overflow-wrap:anywhere}
.alert-dark{display:flex;gap:10px;align-items:flex-start;color:var(--danger-on-ground);border:1px solid var(--danger-on-ground);border-radius:10px;padding:12px 14px;font-size:14px}
.alert-dark .icon{flex:none;width:18px;height:18px;margin-top:2px}
.kv{margin:0;display:flex;flex-direction:column;gap:3px;font:13px/1.45 var(--mono)}
.kv>div{display:grid;grid-template-columns:minmax(8rem,14rem) minmax(0,1fr);gap:12px}
.kv dt{color:var(--on-card-muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.filters{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;font-size:13px}
.filters[hidden]{display:none}
.filters label{display:flex;flex-direction:column;gap:4px;color:var(--on-card-muted)}
.filters select,.filters input{font:14px var(--sans);color:var(--on-ground);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-height:40px}
.filters input{min-width:16rem}
.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font:13px/1.5 var(--mono)}
.log li[hidden]{display:none}
.log summary{cursor:pointer;padding:6px 10px;border-radius:6px;overflow-wrap:anywhere}
.log summary:hover{background:var(--card)}
.log .seq{color:var(--on-ground);display:inline-block;min-width:3.2em}.log time{color:var(--on-card-muted)}.log .kind{display:inline-block;min-width:9.5rem}
.log details[open]{background:var(--card);border-radius:8px}
.log details[open] .kv{padding:4px 12px 12px;color:var(--on-ground)}
.log li.t-plain,.log li.t-ok{color:var(--on-ground)}
.vres{align-items:flex-start;max-width:46rem}
.vres h2{font-size:20px}
.checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;width:100%}
.checks li{display:flex;gap:10px;align-items:flex-start}
.checks .icon{flex:none;width:18px;height:18px;margin-top:2px}
.checks .ok .icon{color:var(--deep-sage)}.checks .bad .icon{color:var(--danger)}
.checks .cn{font-weight:600}
.vres .small{color:var(--on-paper-muted)}
.drawer{display:none}
.drawer:target,.drawer.open{display:block;position:fixed;top:0;right:0;bottom:0;width:min(420px,100%);z-index:5;overflow:auto;
background:var(--paper);box-shadow:-12px 0 32px rgba(0,0,0,.45)}
.drawer-in{border-radius:0;min-height:100%;gap:12px;padding:24px}
.drawer .small,.drawer .kv dt{color:var(--on-paper-muted)}
.drawer .kv{background:var(--paper-2);border-radius:10px;padding:10px 12px;color:var(--on-paper)}
.drawer .kv>div{grid-template-columns:minmax(6rem,9rem) minmax(0,1fr)}
.drawer a{color:var(--deep-sage)}
.dtop{display:flex;justify-content:space-between;align-items:center}
.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--on-paper-muted)}
.req{display:flex;flex-direction:column;gap:8px;border-top:1.5px dashed var(--rule);padding-top:12px}
.drawer .d-ok{color:var(--deep-sage)}.drawer .d-bad{color:var(--danger)}.drawer .d-warn{color:var(--warn-text)}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.split{grid-template-columns:minmax(0,1fr)}.feed-panel{grid-column:auto}}
@media (max-width:768px){
.app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto 1fr}
.nav{grid-row:3}main{grid-row:4}
.bar,.pause-bar,.pause-banner{padding:12px 16px}
.nav{border-right:0;border-bottom:1px solid var(--card-line);padding:8px 12px;position:sticky;top:0;z-index:4;background:var(--ground)}
.nav ul{flex-direction:row;flex-wrap:wrap;position:relative;top:0;gap:4px}
.nav a{white-space:nowrap;padding:8px 10px}
.nav-foot{display:none}
main{padding:18px 16px 40px}
.view{scroll-margin-top:180px}
.steps-line{grid-template-columns:repeat(2,minmax(0,1fr))}
.feed li{grid-template-columns:44px 70px minmax(0,1fr);gap:8px}
.kv>div{grid-template-columns:minmax(0,1fr);gap:0}
}
@media (max-width:480px){.kpis{grid-template-columns:minmax(0,1fr)}.filters input{min-width:0;width:100%}}
`;

export const APP_CSS = UI_CSS + PANEL_CSS;
