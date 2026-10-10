"use strict";

/* ============================================================
   SOC Console — pentesttask
   Frontend: data layer + view rendering (no UI framework).
   Server data is always escaped before rendering.
   ============================================================ */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function tone(p) {
  p = Number(p) || 0;
  return p >= 90 ? "bad" : p >= 70 ? "warn" : "ok";
}
function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}
function timeHM(ts) {
  return new Date(ts).toLocaleTimeString("id-ID", { hour12: false });
}
function timeFmt(ts) {
  return new Date(ts).toLocaleString("id-ID", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}
function sevClass(sev) {
  return { info: "info", medium: "warn", high: "crit", crit: "crit", warn: "warn", ok: "ok" }[sev] || "dim";
}
function stateClass(st) {
  st = String(st || "").toLowerCase();
  if (st === "active" || st === "ok" || st === "open") return "ok";
  if (st === "failed" || st === "error" || st === "closed") return "crit";
  if (st === "inactive" || st === "unknown" || st === "-") return "dim";
  return "warn";
}
function addr(hostport) {
  const i = hostport.lastIndexOf(":");
  if (i <= 0) return hostport;
  return { host: hostport.slice(0, i), port: hostport.slice(i + 1) };
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

/* ---------------- state ---------------- */
const state = {
  data: null,
  lastOk: null,
  view: (location.hash || "#overview").replace("#", "") || "overview",
  sidebarOpen: false,
  tbls: {},
  modals: [],
};

/* The active views we can render */
const VIEWS = ["overview", "infrastructure", "security", "network", "processes", "audit"];

/* ---------------- api ---------------- */
async function api(url, opts = {}) {
  try {
    const r = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      ...opts,
    });
    if (r.status === 401) {
      showLogin("Sesi berakhir, silakan masuk lagi.");
      return null;
    }
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      if (r.status === 429) {
        $("#msg").textContent = j && j.error ? j.error : "Terlalu banyak percobaan.";
        return null;
      }
      if (j && j.error) throw new Error(j.error);
    }
    return j;
  } catch (e) {
    console.warn("api error", e);
    return null;
  }
}

/* ---------------- login ---------------- */
function showLogin(msg) {
  stopClock();
  $("#app").classList.add("hidden");
  $("#loading").classList.add("hidden");
  $("#view-login").classList.remove("hidden");
  if (msg) $("#msg").textContent = msg;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
function showApp() {
  $("#view-login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  initShell();
  goto(state.view);
  startClock();
  poll();
  pollTimer = setInterval(poll, 3000);
}
let pollTimer = null;

async function doLogin() {
  const u = $("#username").value.trim();
  const p = $("#password").value;
  const msg = $("#msg");
  msg.textContent = "";
  if (!u || !p) { msg.textContent = "Isi username dan password."; return; }
  const btn = $("#btn-login");
  btn.disabled = true;
  const d = await api("api/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  btn.disabled = false;
  if (d && d.ok) showApp();
  else if (!msg.textContent) msg.textContent = "Login gagal.";
}

/* ---------------- polling ---------------- */
let freshTimer = null;
async function poll() {
  const hadData = !!state.data;
  const d = await api("api/noc");
  if (!d || d.error) {
    setStale(true);
    return;
  }
  state.data = d;
  state.lastOk = Date.now();
  setStale(false);
  updateChrome();
  if (!hadData) render();
  else updateView();
}
function setStale(st) {
  const b = $("#banner");
  if (st) {
    b.classList.remove("hidden");
    b.classList.add("stale");
    b.textContent = "Data feed tidak tersedia — menampilkan nilai terakhir yang valid. " +
      (state.lastOk ? "(terakhir diperbarui " + ago(state.lastOk) + " lalu)" : "");
  } else {
    b.classList.add("hidden");
    b.classList.remove("stale");
  }
}

/* ---------------- chrome ---------------- */
function updateChrome() {
  const d = state.data;
  if (!d) return;
  const h = d.health || { status: "ok", issues: [] };
  const sec = d.security || {};
  const zt = d.network || {};

  const dotSoc = $("#dot-soc"), statSoc = $("#stat-soc");
  dotSoc.className = "dot " + (h.status === "ok" ? "ok" : h.status === "warn" ? "warn" : "bad");
  statSoc.textContent = h.status.toUpperCase();

  const ztUp = (zt.summary && zt.summary.total > 0) || (d.network && d.network.networks && d.network.networks.length);
  const dotVpn = $("#dot-vpn"), statVpn = $("#stat-vpn");
  dotVpn.className = "dot " + (ztUp ? "ok" : "bad");
  statVpn.textContent = ztUp
    ? (zt.summary.total + " peer · " + zt.summary.online + " online")
    : "disconnected";

  const w = sec.wazuh || {};
  const dotW = $("#dot-wazuh"), statW = $("#stat-wazuh");
  dotW.className = "dot " + (w.running ? "ok" : "bad");
  statW.textContent = w.running ? (w.modules.length + " modules") : "down";

  const fr = $("#fresh");
  fr.textContent = "§ " + ago(d.ts) + " lalu";
  fr.title = d.hostname + " · " + timeFmt(d.ts);

  const pr = $("#probe");
  pr.textContent = d.hostname;
  pr.className = "probe " + (h.status === "ok" ? "ok" : h.status === "warn" ? "warn" : "bad");
  $("#envchip").textContent = (d.env || "PROD").toUpperCase();
}

/* ---------------- clock ---------------- */
let clockTimer = null;
function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  tickClock();
  clockTimer = setInterval(tickClock, 1000);
}
function stopClock() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (freshTimer) { clearInterval(freshTimer); freshTimer = null; }
}
function tickClock() {
  const n = new Date();
  $("#clock").textContent =
    n.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }) + " " +
    n.toLocaleTimeString("id-ID", { hour12: false });
}

/* ---------------- shell / nav ---------------- */
let shellInit = false;
function initShell() {
  if (shellInit) return;
  shellInit = true;
  $("#btn-menu").addEventListener("click", () => {
    state.sidebarOpen = !state.sidebarOpen;
    $("#sidebar").classList.toggle("open", state.sidebarOpen);
  });
  $$(".nav-item").forEach((a) =>
    a.addEventListener("click", () => {
      state.sidebarOpen = false;
      $("#sidebar").classList.remove("open");
    })
  );
  window.addEventListener("hashchange", () => {
    const v = (location.hash || "").replace("#", "");
    if (VIEWS.includes(v)) goto(v);
  });
}
function goto(view) {
  if (!VIEWS.includes(view)) view = "overview";
  state.view = view;
  $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  const titles = {
    overview: "Overview", infrastructure: "Infrastructure", security: "Security Events",
    network: "Network & Zero Trust", processes: "Processes & Connections", audit: "Audit Logs",
  };
  $("#crumb").textContent = titles[view];
  render();
}

/* ---------------- generic table ---------------- */
/*
  Tbl(el, {
    cols: [{ key, label, render(row), sort, sortVal(row), align, right }],
    search: "Placeholder text",      // enabled + placeholder
    filter: { label, options: [{v,label}], onApply(row, v) },   // single select filter
    pageSize, initial: { sort, dir }
  })
  Instance methods: setRows(rows, keepPage)
  State (q, f, sort, dir, page) persisted across polls; inputs not re-rendered.
*/
function Tbl(el, cfg) {
  this.el = el;
  this.cfg = cfg;
  this.cols = cfg.cols;
  this.s = {
    rows: [],
    q: "",
    f: "",
    sort: cfg.initial ? cfg.initial.sort : cfg.cols[0].key,
    dir: cfg.initial && cfg.initial.dir != null ? cfg.initial.dir : 1,
    page: 0,
    size: cfg.pageSize || 25,
  };
  this.searchable = (row) =>
    this.cols.map((c) => String(c.searchVal ? c.searchVal(row) : (row[c.key] == null ? "" : row[c.key]))).join(" ").toLowerCase();

  this.build();
}
Tbl.prototype.build = function () {
  const that = this;
  const cfg = this.cfg;

  const bar = document.createElement("div");
  bar.className = "toolbar";
  if (cfg.search) {
    const inp = document.createElement("input");
    inp.type = "search";
    inp.placeholder = cfg.search;
    inp.value = this.s.q || "";
    inp.addEventListener("input", () => {
      that.s.q = inp.value.trim().toLowerCase();
      that.s.page = 0;
      that.renderBody();
    });
    bar.appendChild(inp);
  }
  if (cfg.filter) {
    const sel = document.createElement("select");
    sel.appendChild(new Option(cfg.filter.label || "Semua", ""));
    cfg.filter.options.forEach((o) => sel.appendChild(new Option(o.label, o.v)));
    sel.value = this.s.f;
    sel.addEventListener("change", () => {
      that.s.f = sel.value;
      that.s.page = 0;
      that.renderBody();
    });
    bar.appendChild(sel);
  }
  if (cfg.extra) bar.appendChild(cfg.extra);
  const tip = document.createElement("span");
  tip.className = "toolbar-tip grow";
  tip.id = this.el.id + "-tip";
  bar.appendChild(tip);
  this.el.appendChild(bar);

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  this.table = document.createElement("table");
  this.table.className = "tbl";
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  this.cols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c.label;
    if (c.sort !== false) {
      th.className = "sortable";
      th.innerHTML = c.label + ' <span class="arrow">' +
        (that.s.sort === c.key ? (that.s.dir > 0 ? "▲" : "▼") : "") + "</span>";
      th.addEventListener("click", () => {
        if (that.s.sort === c.key) that.s.dir *= -1;
        else { that.s.sort = c.key; that.s.dir = 1; }
        that.s.page = 0;
        that.renderBody();
      });
    }
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  this.tbody = document.createElement("tbody");
  this.tfoot = document.createElement("tfoot");
  this.table.appendChild(thead);
  this.table.appendChild(this.tbody);
  this.table.appendChild(this.tfoot);
  wrap.appendChild(this.table);
  this.el.appendChild(wrap);

  const pager = document.createElement("div");
  pager.className = "pager";
  this.pager = pager;
  this.el.appendChild(pager);
  this.pagerWrap = getPager(this.pager, {
    prev: () => { this.s.page--; this.renderBody(); },
    next: () => { this.s.page++; this.renderBody(); },
    size: (n) => { this.s.size = n; this.s.page = 0; this.renderBody(); },
  });
  this.renderBody();
};
function getPager(el, cb) {
  const prev = document.createElement("button"); prev.textContent = "‹ prev"; prev.className = "pg-prev";
  const info = document.createElement("span"); info.className = "pg-info";
  const next = document.createElement("button"); next.textContent = "next ›"; next.className = "pg-next";
  el.appendChild(prev); el.appendChild(info); el.appendChild(next);
  prev.addEventListener("click", cb.prev);
  next.addEventListener("click", cb.next);
  return { prev, info, next };
}
Tbl.prototype.visible = function () {
  let rows = this.s.rows;
  if (this.s.q) rows = rows.filter((r) => this.searchable(r).includes(this.s.q));
  if (this.s.f && this.cfg.filter) rows = rows.filter((r) => this.cfg.filter.onApply(r, this.s.f));
  const c = this.cols.find((x) => x.key === this.s.sort);
  if (c && c.sort !== false) {
    const dir = this.s.dir;
    rows = rows.slice().sort((a, b) => {
      let av = c.sortVal ? c.sortVal(a) : a[c.key];
      let bv = c.sortVal ? c.sortVal(b) : b[c.key];
      if (av == null) av = "";
      if (bv == null) bv = "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), "id") * dir;
    });
  }
  return rows;
};
Tbl.prototype.renderBody = function () {
  const rows = this.visible();
  const total = rows.length;
  const size = this.s.size;
  let pages = Math.max(1, Math.ceil(total / size));
  if (this.s.page > pages - 1) this.s.page = pages - 1;
  const start = this.s.page * size;
  const pageRows = rows.slice(start, start + size);

  const cols = this.cols;
  let html = "";
  if (!pageRows.length) {
    html += `<tr class="row-empty"><td colspan="${cols.length}">tidak ada data untuk filter saat ini</td></tr>`;
  }
  pageRows.forEach((r) => {
    html += "<tr data-i='" + esc(r.__i) + "'>";
    cols.forEach((c) => {
      const v = c.render ? c.render(r) : esc(r[c.key]);
      html += `<td class="${c.right ? "num" : ""}" data-key="${esc(c.key)}">${v}</td>`;
    });
    html += "</tr>";
  });
  this.tbody.innerHTML = html;

  /* header sort arrows (th nodes persist -> listeners survive) */
  const sortIdx = this.cols.findIndex((c) => c.key === this.s.sort);
  $$("th", this.table).forEach((th, i) => {
    th.innerHTML = "";
    th.appendChild(document.createTextNode(this.cols[i].label + " "));
    const arr = document.createElement("span");
    arr.className = "arrow";
    arr.textContent = i === sortIdx ? (this.s.dir > 0 ? "▲" : "▼") : "";
    th.appendChild(arr);
  });

  /* pager */
  const from = total ? start + 1 : 0;
  const to = Math.min(start + size, total);
  this.pagerWrap.info.textContent = `${from}–${to} dari ${total}`;
  this.pagerWrap.prev.disabled = this.s.page <= 0;
  this.pagerWrap.next.disabled = this.s.page >= pages - 1;
  const tip = this.el.querySelector("#" + this.el.id + "-tip");
  if (tip) tip.textContent = total + " baris · halaman " + (this.s.page + 1) + "/" + pages;
};
Tbl.prototype.setRows = function (rows) {
  rows.forEach((r, i) => (r.__i = i));
  this.s.rows = rows;
  this.renderBody();
};

/* row click -> incident detail */
function wireRowClick(el, fn) {
  el.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    const i = Number(tr.dataset.i);
    if (!Number.isFinite(i)) return;
    fn(i);
  });
}

/* get-or-make a Tbl, re-attaching to a freshly rendered element on view change */
function tblFor(id, cfg) {
  const el = $("#" + id);
  let t = state.tbls[id];
  if (!el) return null;
  if (t && !el.contains(t.table)) {
    t.el = el;
    t.build();
  }
  if (!t) {
    t = new Tbl(el, cfg);
    state.tbls[id] = t;
  }
  return t;
}

/* ---------------- charts ---------------- */
const CHART_W = 320;
function svgArea(points, defs, h) {
  h = h || 92;
  if (!points || !points.length || points.length < 2) {
    return '<div class="dim" style="height:' + h + 'px;display:flex;align-items:center;justify-content:center">belum ada telemetri</div>';
  }
  const maxY = Math.max(1, ...defs.map((d) => Math.max(...points.map((p) => Number(p[d.key]) || 0))));
  const pad = 6;
  const W = CHART_W, H = h;
  const iw = W - pad * 2, ih = H - pad * 2;

  const xs = (i) => pad + (i / (points.length - 1)) * iw;
  const ys = (v) => pad + ih - (v / maxY) * ih;

  let grid = "";
  [0.25, 0.5, 0.75, 1].forEach((f) => {
    const y = pad + ih * (1 - f);
    grid += `<line class="grid" x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}"/>`;
  });

  let body = "";
  defs.forEach((de) => {
    const d = de.damped ? 1 : 1;
    const pts = points.map((p, i) => xs(i) + "," + ys(Number(p[de.key]) || 0));
    body += `<polyline points="${pts.join(" ")}" fill="none" stroke="${de.color}" stroke-width="1.4"/>`;
    if (de.fill !== false) {
      const area = pts.join(" ") + ` ${xs(points.length - 1)},${pad + ih} ${xs(0)},${pad + ih}`;
      body += `<polygon points="${area}" fill="${de.color}" opacity="0.08"/>`;
    }
  });

  const label = (x, y, t, anchor) =>
    `<text class="axis" x="${x}" y="${y}" text-anchor="${anchor || "start"}">${t}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${body}` +
    label(pad, H - 1, timeHM(points[0].ts), "start") +
    label(W - pad, H - 1, timeHM(points[points.length - 1].ts), "end") +
    label(pad, pad - 3, Math.round(maxY), "start") +
    label(pad, pad + ih + 1, "0", "start") +
    `</svg>`;
}
function legend(defs) {
  return '<div class="legend">' + defs.map((d) => `<span><i style="background:${d.color}"></i>${d.label}</span>`).join("") + "</div>";
}

function svgBar(pctVal, cls) {
  return `<div class="bar-wrap"><div class="bar ${cls}"><i style="width:${Math.min(100, Math.max(0, pctVal))}%"></i></div><span class="val">${pctVal}%</span></div>`;
}

/* ---------------- overview ---------------- */
function renderOverview(d) {
  const s = d.system, mem = s.mem;
  const root = (d.disk.find((x) => x.mount === "/") || {});
  const sec = d.security, net = d.network, svc = d.services;
  const svcOk = svc.items.filter((x) => x.ok).length;
  const metrics = d.metrics || [];
  const diskMax = Math.max(1, ...d.disk.map((x) => x.usePct));
  const loadTone = tone((s.load.l1 / s.cpus) * 100);

  const kpi = [
    { k: "Load 1m", v: s.load.l1.toFixed(2), cls: loadTone, s: "1m · 5m · 15m", s2: `${s.load.l5.toFixed(2)} · ${s.load.l15.toFixed(2)}` },
    { k: "Memory", v: mem.usedPct + "%", cls: tone(mem.usedPct), s: mem.usedH + " / " + mem.totalH, s2: "avail " + mem.availH },
    { k: "Disk /", v: (root.usePct || 0) + "%", cls: tone(root.usePct), s: (root.usedH || "-") + " / " + (root.totalH || "-"), s2: "inode " + (root.inodePct == null ? "–" : root.inodePct + "%") },
    { k: "SSH fails 24h", v: fmtNum(sec.sshFail24h), cls: sec.sshFail24h >= 200 ? "bad" : sec.sshFail24h >= 50 ? "warn" : "ok", s: fmtNum(sec.ssh.uniqueSrc || 0) + " sumber unik", s2: "accepted " + fmtNum(sec.ssh.ok) },
    { k: "UFW blocks 24h", v: fmtNum(sec.ufw.count), cls: sec.ufw.count >= 1000 ? "warn" : "ok", s: "kernel drop IN/OUT", s2: "top: " + esc((sec.ufw.topSrc[0] && sec.ufw.topSrc[0].ip) || "–") },
    { k: "TCP conns", v: fmtNum(d.net.established), cls: "info", s: "conntrack " + (d.net.conntrack == null ? "–" : fmtNum(d.net.conntrack)), s2: "" },
    { k: "ZT peers", v: net.ztPeers.length, cls: net.ztPeers.length ? "ok" : "bad", s: net.summary.online + " online / " + net.summary.total, s2: "" },
    { k: "Services", v: svcOk + "/" + svc.items.length, cls: svcOk === svc.items.length ? "ok" : "warn", s: "systemd units", s2: "" },
  ];

  const sevMax = Math.max(1, ...sec.severity.map((x) => x.count));
  const severityHtml = sec.severity.map((x) => `
    <div class="sev-row">
      <span class="lab"><i style="background:var(--${x.tone === "crit" ? "crit" : x.tone === "warn" ? "warn" : "info"})"></i>${x.label}</span>
      <span class="trk"><i style="width:${(x.count / sevMax) * 100}%;background:var(--${x.tone === "crit" ? "crit" : x.tone === "warn" ? "warn" : "info"})"></i></span>
      <span class="cnt">${x.count}</span>
    </div>`).join("");

  const topSrcRows = sec.ufw.topSrc.slice(0, 5).map((x, i) => `
    <tr><td class="num">${i + 1}</td><td class="mono-cell">${esc(x.ip)}</td><td class="num">${esc(fmtNum(x.n))}</td></tr>`).join("");

  const disc = sec.severity.find((x) => x.key === "high");

  renderView(`<div class="health-strip">
      <span class="status-pill ${d.health.status}"><span class="dp" style="width:8px;height:8px;border-radius:50%;background:var(--${d.health.status === "ok" ? "ok" : d.health.status === "warn" ? "warn" : "crit"})"></span>${d.health.status}</span>
      ${(d.health.issues || []).map((x) => `<span class="issue-chip ${x.level}"><span class="tag">${x.level === "crit" ? "CRIT" : "WARN"}</span>${esc(x.msg)}</span>`).join("")}
      <span class="grow"></span>
      <span class="toolbar-tip">uptime ${esc(d.uptime)} · kernel ${esc(s.kernel)}</span>
    </div>

    <div class="kpi-row">
      ${kpi.map((k) => `<div class="kpi"><span class="k">${k.k}</span><span class="v ${k.cls}">${k.v}</span><span class="s">${k.s}</span><span class="s">${k.s2}</span></div>`).join("")}
    </div>

    <div class="grid">
      <div class="panel g5">
        <div class="panel-head"><span class="panel-title"><span class="mark" style="background:var(--info)"></span>CPU load</span><span class="toolbar-tip">1m vs core</span></div>
        <div class="panel-body"><div class="chart" id="ov-cpu">${svgArea(metrics, [{ key: "load1", color: "var(--info)", label: "load 1m" }])}</div>${legend([{ color: "var(--info)", label: "system load (avg 1 menit)" }])}</div>
      </div>
      <div class="panel g4">
        <div class="panel-head"><span class="panel-title"><span class="mark" style="background:var(--warn)"></span>Memory utilisation</span><span class="toolbar-tip">2 GB RAM</span></div>
        <div class="panel-body"><div class="chart" id="ov-mem">${svgArea(metrics, [{ key: "memUsedPct", color: "var(--warn)", label: "mem %" }])}</div>${legend([{ color: "var(--warn)", label: "memory % pakai" }])}</div>
      </div>
      <div class="panel g3">
        <div class="panel-head"><span class="panel-title"><span class="mark" style="background:var(--crit)"></span>Disk &amp; inode</span></div>
        <div class="panel-body">
          ${d.disk.map((x) => `
            <div class="mb14">
              <div class="flex" style="justify-content:space-between"><span class="muted">${esc(x.mount)}</span><span class="mono dim">${esc(x.totalH)} · inode ${x.inodePct == null ? "–" : x.inodePct + "%"}</span></div>
              <div class="mt8">${svgBar(x.usePct, tone(x.usePct))}</div>
            </div>`).join("")}
        </div>
      </div>

      <div class="panel g7">
        <div class="panel-head"><span class="panel-title"><span class="mark"></span>Network traffic</span><span class="toolbar-tip">RX / TX · B/s (sampler 30dtk)</span></div>
        <div class="panel-body"><div class="chart" id="ov-traffic">${svgArea(metrics, [
          { key: "rx", color: "var(--ok)", label: "RX" },
          { key: "tx", color: "var(--info)", label: "TX" },
        ], 128)}</div>${legend([{ color: "var(--ok)", label: "RX bytes/s" }, { color: "var(--info)", label: "TX bytes/s" }])}</div>
      </div>

      <div class="panel g5">
        <div class="panel-head"><span class="panel-title"><span class="mark"></span>Sumber UFW block teratas</span><span class="toolbar-tip">kernel · 24 jam</span></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>#</th><th>Source IP</th><th>Blocked</th></tr></thead>
          <tbody>${topSrcRows || '<tr class="row-empty"><td colspan="3">tidak ada block</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="panel g6" id="ov-svc">
        <div class="panel-head"><span class="panel-title"><span class="mark" style="background:var(--ok)"></span>Service health</span><span class="toolbar-tip">systemd is-active</span></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Unit</th><th>State</th></tr></thead>
          <tbody>${svc.items.slice(0, 12).map((x) => `
            <tr><td class="mono-cell">${esc(x.name)}</td><td><span class="pill ${stateClass(x.state)}"><span class="dp"></span>${esc(x.state)}</span></td></tr>`).join("")}</tbody>
        </table></div>
      </div>

      <div class="panel g6">
        <div class="panel-head"><span class="panel-title"><span class="mark" style="background:var(--warn)"></span>Keamanan — ringkasan</span></div>
        <div class="panel-body">${severityHtml}</div>
        <div class="panel-note">Distribusi event SSH 24 jam. ${sec.wazuh.running ? "Wazuh agent aktif (" + sec.wazuh.modules.length + " modul)" : "Wazuh agent down"}${sec.wazuh.alertsAvailable ? "" : " — tanpa archive alert lokal."}</div>
      </div>
    </div>

    <div class="section-head mt14"><div><h2 class="section-title">Recent security events <span class="badge ${disc && disc.count ? "warn" : "dim"}">${disc ? disc.count : 0} high</span></h2><div class="section-sub">24 jam terakhir · klik baris untuk detail &amp; bukti</div></div><a href="#security" class="btn-subtle">Buka Security Events →</a></div>
    <div class="panel" id="ov-sec"></div>`);

  /* recent security table */
  const tsec = tblFor("ov-sec", {
    pageSize: 10,
    cols: [
      { key: "ts", label: "Waktu", sortVal: (r) => r.ts, render: (r) => `<span class="mono-cell dim">${timeFmt(r.ts)}</span>` },
      { key: "sev", label: "Severity", render: (r) => `<span class="pill ${sevClass(r.sev)}">${esc(r.sev)}</span>` },
      { key: "type", label: "Tipe", render: (r) => `<span class="mono-cell">${esc(r.type.replace(/_/g, " "))}</span>` },
      { key: "user", label: "Akun", render: (r) => `<span class="mono-cell">${esc(r.user || "–")}</span>` },
      { key: "src", label: "Source", render: (r) => `<span class="mono-cell">${esc(r.src || "–")}</span>` },
    ],
    initial: { sort: "ts", dir: -1 },
  });
  const rows = sec.sshEvents.filter((e) => e.sev !== "info");
  tsec.setRows(rows);
  wireRowClick($("#ov-sec"), (i) => openIncident(rows.find((r) => r.__i === i)));
}

/* ---------------- infrastructure ---------------- */
function renderInfra(d) {
  const metrics = d.metrics || [];
  const last = metrics[metrics.length - 1];
  renderView(`
    <div class="kpis-mini">
      <div class="mini-io"><div class="k">CPU load 1m</div><div class="v" id="inf-load">${esc((last && last.load1.toFixed(2)) || "–")}</div></div>
      <div class="mini-io"><div class="k">Memory %</div><div class="v" id="inf-mem">${(last && last.memUsedPct + "%") || "–"}</div></div>
      <div class="mini-io"><div class="k">Disk / %</div><div class="v" id="inf-disk">${(last && last.diskUsedPct + "%") || "–"}</div></div>
      <div class="mini-io"><div class="k">Perubahan RX/TX</div><div class="v" id="inf-rt">${last ? Math.round(last.rx) + " / " + Math.round(last.tx) + " B/s" : "–"}</div></div>
    </div>

    <div class="grid">
      <div class="panel g8">
        <div class="panel-head"><span class="panel-title">RX / TX — telemetri 30 dtk</span><span class="toolbar-tip">cache ${escapeHtml(d.metrics.length)} titik · ~2 jam</span></div>
        <div class="panel-body"><div class="chart" id="inf-traffic">${svgArea(metrics, [
          { key: "rx", color: "var(--ok)", label: "RX" },
          { key: "tx", color: "var(--info)", label: "TX" },
        ], 150)}</div>${legend([{ color: "var(--ok)", label: "RX bytes/s" }, { color: "var(--info)", label: "TX bytes/s" }])}</div>
      </div>
      <div class="panel g4">
        <div class="panel-head"><span class="panel-title">Resource — tren</span></div>
        <div class="panel-body">
          <div class="muted" style="margin-bottom:4px">CPU load (avg 1m)</div>
          <div class="chart" id="inf-cpu">${svgArea(metrics, [{ key: "load1", color: "var(--info)", label: "load" }])}</div>
          <div class="muted mt14" style="margin-bottom:4px">Memory %</div>
          <div class="chart" id="inf-memchart">${svgArea(metrics, [{ key: "memUsedPct", color: "var(--warn)", label: "mem" }])}</div>
        </div>
      </div>

      <div class="panel g6" id="inf-diskpanel"></div>
      <div class="panel g6" id="inf-ifacepanel"></div>

      <div class="panel g12" id="inf-svcpanel"></div>
    </div>`);

  /* disk table */
  const td = tblFor("inf-diskpanel", { pageSize: 10,
    cols: [
      { key: "mount", label: "Mount", render: (r) => `<span class="mono-cell">${esc(r.mount)}</span>` },
      { key: "fs", label: "FS", render: (r) => `<span class="mono-cell dim">${esc(r.fs)}</span>` },
      { key: "totalH", label: "Total" },
      { key: "usedH", label: "Terpakai" },
      { key: "availH", label: "Tersedia" },
      { key: "usePct", label: "Penggunaan", sortVal: (r) => r.usePct, render: (r) => svgBar(r.usePct, tone(r.usePct)) },
      { key: "inodePct", label: "Inode", sortVal: (r) => r.inodePct || 0, render: (r) => (r.inodePct == null ? "–" : r.inodePct + "%") },
    ] });
  td.setRows(d.disk);

  const ti = tblFor("inf-ifacepanel", { pageSize: 10,
    cols: [
      { key: "name", label: "Interface", render: (r) => `<span class="mono-cell">${esc(r.name)}</span>` },
      { key: "rxRateH", label: "RX/s", right: true },
      { key: "txRateH", label: "TX/s", right: true },
      { key: "rx", label: "RX total" },
      { key: "tx", label: "TX total" },
    ] });
  ti.setRows(d.interfaces);

  const ts2 = tblFor("inf-svcpanel", { pageSize: 30,
    cols: [
      { key: "name", label: "Unit", render: (r) => `<span class="mono-cell">${esc(r.name)}</span>` },
      { key: "state", label: "State", render: (r) => `<span class="pill ${stateClass(r.state)}"><span class="dp"></span>${esc(r.state)}</span>` },
    ] });
  ts2.setRows(d.services.items);
}

/* ---------------- security ---------------- */
function renderSecurity(d) {
  const sec = d.security, ev = sec.sshEvents;
  renderView(`
    <div class="section-head"><div><h2 class="section-title">Security events</h2><div class="section-sub">Sumber: journalctl sshd + kernel UFW · jendela 24 jam · klik baris untuk detail</div></div>
    <span class="toolbar-tip">${esc(fmtNum(ev.length))} event · ${esc(fmtNum(sec.ufw.count))} UFW block · sampler 15 dtk</span></div>

    <div class="grid">
      <div class="panel g6" id="sec-summ"></div>
      <div class="panel g6" id="sec-dist"></div>
      <div class="panel g9" id="sec-events"></div>
      <div class="panel g3" id="sec-wazuh"></div>
    </div>`);

  /* summary strip */
  $("#sec-summ").innerHTML = `
    <div class="panel-head"><span class="panel-title">Periode ringkas — SSH 24 jam</span></div>
    <div class="panel-body">
      <div class="kpi-row" style="grid-template-columns:repeat(3,1fr);margin:0">
        <div class="kpi"><span class="k">Accepted</span><span class="v ok">${fmtNum(sec.ssh.ok)}</span><span class="s">login sah</span></div>
        <div class="kpi"><span class="k">Failed</span><span class="v ${sec.ssh.fail >= 200 ? "bad" : sec.ssh.fail ? "warn" : "ok"}">${fmtNum(sec.ssh.fail)}</span><span class="s">password / invalid user</span></div>
        <div class="kpi"><span class="k">Sumber unik</span><span class="v info">${fmtNum(sec.ssh.uniqueSrc)}</span><span class="s">IP berbeda</span></div>
      </div>
      <div class="flex mt14"><span class="muted">High-severity (max attempts)</span><span class="grow"></span><span class="mono ${sec.ssh.high ? "bad" : "dim"}">${fmtNum(sec.ssh.high)}</span></div>
      <div class="flex mt8"><span class="muted">UFW blocks 24h</span><span class="grow"></span><span class="mono ${sec.ufw.count >= 1000 ? "warn" : "ok"}">${fmtNum(sec.ufw.count)}</span></div>
      <div class="flex mt8"><span class="muted">Wazuh modules berjalan</span><span class="grow"></span><span class="mono ${sec.wazuh.running ? "ok" : "bad"}">${sec.wazuh.modules.length} / 5</span></div>
    </div>`;

  /* severity dist */
  const sevMax = Math.max(1, ...sec.severity.map((x) => x.count));
  $("#sec-dist").innerHTML = `
    <div class="panel-head"><span class="panel-title">Distribusi severity</span><span class="toolbar-tip">event SSH (derivasi langsung)</span></div>
    <div class="panel-body">${sec.severity.map((x) => `
      <div class="sev-row">
        <span class="lab"><i style="background:var(--${sevColor(x.tone)})"></i>${x.label}</span>
        <span class="trk"><i style="width:${(x.count / sevMax) * 100}%;background:var(--${sevColor(x.tone)})"></i></span>
        <span class="cnt">${x.count}</span>
      </div>`).join("")}
      <div class="dim" style="font-size:11px;margin-top:10px">Tidak ada archive alert Wazuh lokal — distribusi disusun dari kelas event sshd yang benar-benar terjadi.</div>
    </div>`;

  /* wazuh panel */
  $("#sec-wazuh").innerHTML = `
    <div class="panel-head"><span class="panel-title">Wazuh agent</span></div>
    <div class="panel-body">
      <div class="flex"><span class="muted">Status</span><span class="grow"></span><span class="pill ${sec.wazuh.running ? "ok" : "bad"}">${sec.wazuh.running ? "running" : "down"}</span></div>
      <div class="mt14">${sec.wazuh.modules.map((m) => `<div class="flex" style="margin:5px 0"><span class="dp" style="width:6px;height:6px;border-radius:50%;background:var(--ok)"></span><span class="mono-cell">${esc(m)}</span></div>`).join("")}
      ${!sec.wazuh.running ? '<div class="dim">agent tidak merespons</div>' : ""}
      <div class="dim mt14" style="font-size:11px">${sec.wazuh.alertsAvailable ? "archive alert tersedia di host." : "Alert archive (alerts.json) belum ada di host ini — keterbatasan data."}</div>
    </div>`;

  /* events table */
  const te = tblFor("sec-events", {
    search: "Cari akun / IP…",
    filter: {
      label: "Semua severity",
      options: [
        { v: "info", label: "Info" },
        { v: "medium", label: "Medium" },
        { v: "high", label: "High" },
      ],
      onApply: (r, f) => r.sev === f,
    },
    pageSize: 20,
    cols: [
      { key: "ts", label: "Waktu", sortVal: (r) => r.ts, render: (r) => `<span class="mono-cell dim">${timeFmt(r.ts)}</span>` },
      { key: "sev", label: "Severity", render: (r) => `<span class="pill ${sevClass(r.sev)}"><span class="dp"></span>${esc(r.sev)}</span>` },
      { key: "type", label: "Tipe", render: (r) => `<span class="mono-cell">${esc(r.type.replace(/_/g, " "))}</span>` },
      { key: "user", label: "Account", render: (r) => `<span class="mono-cell">${esc(r.user || "–")}</span>` },
      { key: "src", label: "Source", render: (r) => `<span class="mono-cell">${esc(r.src || "–")}</span>` },
      { key: "port", label: "Port", right: true, render: (r) => `<span class="mono-cell dim">${esc(r.port || "–")}</span>` },
    ],
    initial: { sort: "ts", dir: -1 },
  });
  te.setRows(ev);
  wireRowClick($("#sec-events"), (i) => openIncident(ev.find((r) => r.__i === i)));
}
function sevColor(tone) {
  return tone === "crit" ? "crit" : tone === "warn" ? "warn" : "info";
}

/* ---------------- network & zero trust ---------------- */
function renderNetwork(d) {
  const net = d.network;
  const sc = net.scoped || { public: 0, private: 0, loopback: 0 };
  renderView(`
    <div class="section-head"><div><h2 class="section-title">Network &amp; Zero Trust</h2><div class="section-sub">Mesh ZeroTier, listener classified by exposure</div></div>
    <span class="toolbar-tip">peers langsung dari zerotier-cli</span></div>

    <div class="grid">
      <div class="panel g6" id="nt-zt"></div>
      <div class="panel g6" id="nt-listen"></div>
    </div>`);

  /* zerotier panel */
  const peersRows = net.ztPeers.map((p) => `<tr>
      <td class="mono-cell">${esc(p.addr)}</td>
      <td class="num">${esc(p.version)}</td>
      <td><span class="pill ${p.role === "LEAF" ? "ok" : "warn"}"><span class="dp"></span>${esc(p.role)}</span></td>
      <td class="num">${esc(p.latency)} ms</td>
      <td><span class="pill ${p.link === "DIRECT" ? "ok" : "warn"}">${esc(p.link)}</span></td>
      <td class="mono-cell">${esc(p.path)}</td>
    </tr>`).join("");
  $("#nt-zt").innerHTML = `
    <div class="panel-head"><span class="panel-title">ZeroTier mesh</span><span class="toolbar-tip">${net.summary.online}/${net.summary.total} peer online</span></div>
    <div class="panel-body">
      ${net.networks.map((n) => `
        <div class="io-box mb14">network ${esc(n.id)} · ${esc(n.name)}<br>type <b>${esc(n.type)}</b> · status <b>${esc(n.status)}</b> · dev ${esc(n.dev)}<br>host IP <b>${esc(n.ip || "–")}</b></div>`).join("")}
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>ZT addr</th><th>Ver</th><th>Peran</th><th>Lat</th><th>Link</th><th>Path</th></tr></thead>
        <tbody>${peersRows || '<tr class="row-empty"><td colspan="6">tidak ada peer</td></tr>'}</tbody>
      </table></div>
    </div>`;

  /* listeners table */
  const tl = tblFor("nt-listen", {
    search: "Cari port / proses / IP…",
    filter: {
      label: "Semua exposure",
      options: [
        { v: "public", label: "Public (reachable)" },
        { v: "private", label: "Private" },
        { v: "loopback", label: "Loopback" },
      ],
      onApply: (r, f) => r.scope === f,
    },
    pageSize: 20,
    cols: [
      { key: "addr", label: "Bind", render: (r) => `<span class="mono-cell">${esc(r.addr)}</span>` },
      { key: "proto", label: "Proto", render: (r) => `<span class="pill ${r.proto === "tcp" ? "info" : "dim"}">${esc(r.proto)}</span>` },
      { key: "scope", label: "Exposure", render: (r) => `<span class="pill ${r.scope === "public" ? "crit" : r.scope === "private" ? "warn" : "dim"}"><span class="dp"></span>${esc(r.scope)}</span>` },
      { key: "process", label: "Proses", render: (r) => `<span class="mono-cell">${esc(r.process)}</span>` },
      { key: "pid", label: "PID", right: true, render: (r) => `<span class="mono-cell dim">${esc(r.pid || "–")}</span>` },
      { key: "user", label: "Owner", render: (r) => `<span class="mono-cell">${esc(r.user || "–")}</span>` },
    ],
    initial: { sort: "scope", dir: 1 },
  });
  tl.setRows(net.listeners);
}

/* ---------------- processes & connections ---------------- */
function renderProcesses(d) {
  const rows = d.processes;
  renderView(`
    <div class="section-head"><div><h2 class="section-title">Processes &amp; connections</h2><div class="section-sub">Socket TCP/UDP lengkap dari ss · klik baris untuk detail</div></div>
    <span class="toolbar-tip">${rows.length} socket</span></div>
    <div class="panel" id="prc-table"></div>`);

  const tp = tblFor("prc-table", {
    search: "Cari proses, user, lokal, remote, port…",
    filter: {
      label: "Semua protocol",
      options: [
        { v: "tcp", label: "TCP" },
        { v: "udp", label: "UDP" },
      ],
      onApply: (r, f) => r.proto === f,
    },
    pageSize: 25,
    cols: [
      { key: "proto", label: "Proto", render: (r) => `<span class="pill ${r.proto === "tcp" ? "info" : "dim"}">${esc(r.proto)}</span>` },
      { key: "state", label: "State", render: (r) => `<span class="mono-cell ${stateClass(r.state) === "crit" ? "bad" : stateClass(r.state) === "warn" ? "warn" : stateClass(r.state) === "ok" ? "ok" : "dim"}">${esc(r.state)}</span>` },
      { key: "local", label: "Local", render: (r) => `<span class="mono-cell">${esc(r.local)}</span>` },
      { key: "peer", label: "Remote", render: (r) => `<span class="mono-cell">${esc(r.peer)}</span>` },
      { key: "process", label: "Proses", render: (r) => `<span class="mono-cell">${esc(r.process)}</span>` },
      { key: "pid", label: "PID", right: true, render: (r) => `<span class="mono-cell dim">${esc(r.pid || "–")}</span>` },
      { key: "user", label: "User", render: (r) => `<span class="mono-cell">${esc(r.user || "–")}</span>` },
    ],
    initial: { sort: "process", dir: 1 },
  });
  tp.setRows(rows);
  wireRowClick($("#prc-table"), (i) => openProcess(rows.find((r) => r.__i === i)));
}

/* ---------------- audit ---------------- */
function renderAudit(d) {
  const ev = d.audit;
  renderView(`
    <div class="section-head"><div><h2 class="section-title">Audit &amp; system activity</h2><div class="section-sub">sudo, service start/stop/reload, sshd lifecycle · 24 jam</div></div>
    <span class="toolbar-tip">${ev.length} event · disaring dari journalctl</span></div>
    <div class="panel" id="aud-table"></div>`);

  const ta = tblFor("aud-table", {
    search: "Cari pesan / nama service…",
    filter: {
      label: "Semua sumber",
      options: [
        { v: "sudo", label: "sudo" },
        { v: "systemd", label: "systemd" },
        { v: "sshd", label: "sshd" },
      ],
      onApply: (r, f) => r.source === f,
    },
    pageSize: 25,
    cols: [
      { key: "tsStr", label: "Waktu", sortVal: (r) => r.ts, render: (r) => `<span class="mono-cell dim">${esc(r.tsStr)}</span>` },
      { key: "source", label: "Source", render: (r) => `<span class="pill info">${esc(r.source)}</span>` },
      { key: "sev", label: "Level", render: (r) => `<span class="pill ${sevClass(r.sev)}">${esc(r.sev)}</span>` },
      { key: "msg", label: "Event", sort: false, render: (r) => `<span class="mono-cell">${esc(r.msg)}</span>` },
    ],
    initial: { sort: "tsStr", dir: -1 },
  });
  ta.setRows(ev);
  wireRowClick($("#aud-table"), (i) => openAudit(ev.find((r) => r.__i === i)));
}

/* ---------------- incident / detail modals ---------------- */
function openModal(titleHtml, bodyHtml) {
  const m = $("#modal");
  $("#modalCard").innerHTML =
    `<div class="modal-head"><span class="modal-title">${titleHtml}</span><button class="icon-btn" id="modal-close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
     <div class="modal-body">${bodyHtml}</div>`;
  m.classList.remove("hidden");
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target === $(".modal-scrim")) closeModal(); });
  document.addEventListener("keydown", closeModalKey);
}
function closeModalKey(e) { if (e.key === "Escape") closeModal(); }
function closeModal() {
  const m = $("#modal");
  m.classList.add("hidden");
  document.removeEventListener("keydown", closeModalKey);
}
function openIncident(ev) {
  if (!ev) return;
  openModal(
    `<span class="pill ${sevClass(ev.sev)}"><span class="dp"></span>${esc(ev.sev)}</span>` + esc(" " + ev.type.replace(/_/g, " ")),
    `<dl class="kv">
       <dt>Waktu</dt><dd>${esc(timeFmt(ev.ts))}</dd>
       <dt>Severity</dt><dd>${esc(ev.sev)}</dd>
       <dt>Account</dt><dd>${esc(ev.user || "–")}</dd>
       <dt>Source IP</dt><dd>${esc(ev.src || "–")}</dd>
       <dt>Port</dt><dd>${esc(ev.port || "–")}</dd>
     </dl>
     <div class="section-sub" style="margin-top:12px">Bukti — journalctl sshd</div>
     <pre class="evidence">${esc(ev.raw || "(tidak ada baris asli)")}</pre>`
  );
}
function openProcess(r) {
  if (!r) return;
  const l = addr(r.local), p = addr(r.peer);
  openModal(
    `<span class="pill ${r.proto === "tcp" ? "info" : "dim"}">${esc(r.proto)}</span>` + esc(" " + (r.process || "-")),
    `<dl class="kv">
       <dt>Timestamp</dt><dd>${esc(timeHM(new Date().getTime()))}</dd>
       <dt>State</dt><dd>${esc(r.state)}</dd>
       <dt>Local</dt><dd>${esc(r.local)}</dd>
       <dt>Remote</dt><dd>${esc(r.peer)}</dd>
       <dt>PID</dt><dd>${esc(r.pid || "–")}</dd>
       <dt>User</dt><dd>${esc(r.user || "–")}</dd>
     </dl>
     <div class="section-sub" style="margin-top:12px">Konteks koneksi (live)</div>
     <pre class="evidence">local  ${esc(l.host)}:${esc(l.port || "*")}
remote ${esc(p.host)}:${esc(p.port || "*")}
protocol ${esc(r.proto)} · state ${esc(r.state)}</pre>`
  );
}
function openAudit(r) {
  if (!r) return;
  openModal(
    `<span class="pill ${sevClass(r.sev)}">${esc(r.sev)}</span>` + esc(" " + r.source + " event"),
    `<dl class="kv">
       <dt>Waktu</dt><dd>${esc(r.tsStr)}</dd>
       <dt>Sumber</dt><dd>${esc(r.source)}</dd>
       <dt>Pesan</dt><dd class="kvdd">${esc(r.msg)}</dd>
     </dl>`
  );
}

/* ---------------- view router ---------------- */
function renderView(html) {
  $("#content").innerHTML = html;
}
function render() {
  const d = state.data;
  if (!d) { $("#content").innerHTML = '<div class="dim">Menunggu feed data…</div>'; return; }
  const h = (fn) => fn(d);
  switch (state.view) {
    case "overview": return h(renderOverview);
    case "infrastructure": return h(renderInfra);
    case "security": return h(renderSecurity);
    case "network": return h(renderNetwork);
    case "processes": return h(renderProcesses);
    case "audit": return h(renderAudit);
  }
}
function updateView() {
  if (!state.data) return;
  /* KPI / chart live refresh for overview & infra panels that expose ids */
  if (state.view === "overview") {
    const m = state.data.metrics || [];
    const el = (id, html) => { const x = $(id); if (x) x.innerHTML = html; };
    const d = state.data, sec = d.security;
    const disc = sec.severity.find((x) => x.key === "high");
    const sevMax = Math.max(1, ...sec.severity.map((x) => x.count));
    el("#ov-cpu", svgArea(m, [{ key: "load1", color: "var(--info)", label: "load 1m" }]));
    el("#ov-mem", svgArea(m, [{ key: "memUsedPct", color: "var(--warn)", label: "mem %" }]));
    el("#ov-traffic", svgArea(m, [
      { key: "rx", color: "var(--ok)", label: "RX" },
      { key: "tx", color: "var(--info)", label: "TX" },
    ], 128));
    const tbl = state.tbls["ov-sec"];
    if (tbl) {
      const rows = sec.sshEvents.filter((e) => e.sev !== "info");
      tbl.setRows(rows);
      wireRowClick($("#ov-sec"), (i) => openIncident(rows.find((r) => r.__i === i)));
    }
  }
  if (state.view === "infrastructure") {
    const m = state.data.metrics || [];
    const last = m[m.length - 1];
    const st = (id, v) => { const x = $(id); if (x) x.textContent = v; };
    st("#inf-load", last ? last.load1.toFixed(2) : "–");
    st("#inf-mem", last ? last.memUsedPct + "%" : "–");
    st("#inf-disk", last ? last.diskUsedPct + "%" : "–");
    st("#inf-rt", last ? Math.round(last.rx) + " / " + Math.round(last.tx) + " B/s" : "–");
    const el = (id, html) => { const x = $(id); if (x) x.innerHTML = html; };
    el("#inf-traffic", svgArea(m, [
      { key: "rx", color: "var(--ok)", label: "RX" },
      { key: "tx", color: "var(--info)", label: "TX" },
    ], 150));
    el("#inf-cpu", svgArea(m, [{ key: "load1", color: "var(--info)", label: "load" }]));
    el("#inf-memchart", svgArea(m, [{ key: "memUsedPct", color: "var(--warn)", label: "mem" }]));
  }
}

/* ---------------- init ---------------- */
(function init() {
  $("#btn-login").addEventListener("click", doLogin);
  $("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("#btn-logout").addEventListener("click", async () => {
    await api("api/logout", { method: "POST" });
    showLogin("Anda telah keluar.");
  });

  (async () => {
    const s = await api("api/session");
    $("#loading").classList.add("hidden");
    /* prime timers even for login screen */
    startClock();
    if (s && s.authenticated) showApp();
    else showLogin();
  })();
})();

/* helper used for tooltip in infra (avoid inline escape name clash) */
function escapeHtml(s) { return esc(s); }