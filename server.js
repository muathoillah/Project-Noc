"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { execFile } = require("child_process");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CRED_FILE = path.join(DATA_DIR, "INITIAL_CREDENTIALS.txt");
const METRICS_FILE = path.join(DATA_DIR, "metrics.json");
const SESSION_TTL = 60 * 60 * 1000; // 1 jam
const SAMPLE_MS = 30000; // telemetry
const SAMPLE_KEEP = 240; // ~2 jam

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers: users ----------
fs.mkdirSync(DATA_DIR, { recursive: true });

function scrypt(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString("hex");
}

function randomB64(len) {
  return crypto.randomBytes(len).toString("base64url");
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

function seedAdmin() {
  const users = loadUsers();
  if (Object.keys(users).length > 0) return users;

  const username = process.env.NOC_USER || "admin";
  const password =
    process.env.NOC_PASSWORD || randomB64(12).replace(/-/g, "A").slice(0, 16);
  const salt = randomB64(16);
  const totpSecret = speakeasy.generateSecret({ length: 20 }).base32;

  users[username] = {
    username,
    salt,
    hash: scrypt(password, salt),
    totpSecret,
    totpVerified: false,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);

  const cred =
    `SOC / NOC Dashboard - initial credentials\n` +
    `URL      : https://noc.muthisyah.my.id\n` +
    `Username : ${username}\n` +
    `Password : ${password}\n` +
    `Secret   : ${totpSecret}\n` +
    `---------------------------------------------------------------------------\n`;
  fs.writeFileSync(CRED_FILE, cred, { mode: 0o600 });
  console.log(cred);
  return users;
}

// ---------- sessions ----------
const sessions = new Map();

function sign(value) {
  return crypto
    .createHmac("sha256", process.env.NOC_SESSION_KEY || "noc-session-key")
    .update(value)
    .digest("base64url");
}

function makeToken() {
  const tok = randomB64(24);
  sessions.set(tok, { username: "admin", exp: Date.now() + SESSION_TTL });
  return tok;
}

function auth(req, res, next) {
  const raw = readCookie(req);
  const [tok, sig] = raw.split(".");
  if (tok && sig && sign(tok) === sig) {
    const s = sessions.get(tok);
    if (s && s.exp > Date.now()) {
      req.sessionUser = s.username;
      return next();
    }
  }
  return res.status(401).json({ error: "autentikasi diperlukan" });
}

function cookieHeaders(res, tok) {
  const val = `${tok}.${sign(tok)}`;
  res.set(
    "Set-Cookie",
    `noc=${val}; HttpOnly; Path=/; Max-Age=3600; SameSite=Strict; Secure`
  );
}

function readCookie(req) {
  const h = req.headers["cookie"] || "";
  const m = h.match(/(?:^|;\s*)noc=([^;]+)/);
  return m ? m[1] : "";
}

// ---------- rate limit ----------
const attempts = new Map();
function limited(ip) {
  const e = attempts.get(ip);
  if (e && e.lockUntil > Date.now()) return true;
  return false;
}
function fail(ip) {
  const e = attempts.get(ip) || { n: 0, lockUntil: 0 };
  e.n += 1;
  if (e.n >= 5) {
    e.lockUntil = Date.now() + 5 * 60 * 1000;
    e.n = 0;
  }
  attempts.set(ip, e);
}
function pass(ip) {
  attempts.delete(ip);
}

// ---------- NOC data ----------
function run(cmd, args, timeout) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: timeout || 6000 }, (e, out) =>
      res(out || "")
    );
  });
}

function memo(fn, ttl) {
  let last = 0;
  let val = null;
  let inflight = null;
  return async () => {
    const now = Date.now();
    if (val && now - last < ttl) return val;
    if (!inflight) {
      inflight = (async () => {
        try {
          val = await fn();
          last = Date.now();
        } catch {
          val = null;
        } finally {
          inflight = null;
        }
      })();
    }
    await inflight;
    return val;
  };
}

function humanRate(bps) {
  if (bps >= 1e6) return (bps / 1e6).toFixed(2) + " MB/s";
  if (bps >= 1e3) return (bps / 1e3).toFixed(1) + " KB/s";
  return bps.toFixed(0) + " B/s";
}

function humanBytes(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

// ---- system ----
const systemInfo = memo(async () => {
  const [load, mem, kver, nproc] = await Promise.all([
    run("cat", ["/proc/loadavg"]),
    run("cat", ["/proc/meminfo"]),
    run("uname", ["-r"]),
    run("nproc", []),
  ]);

  const l = load.trim().split(/\s+/);
  const m = {};
  for (const line of mem.split("\n")) {
    const p = line.match(/^(\w+):\s+(\d+)/);
    if (p) m[p[1]] = parseInt(p[2], 10) * 1024;
  }
  const total = m.MemTotal || 0;
  const available = m.MemAvailable || 0;
  const used = Math.max(0, total - available);
  const usedPct = total ? Math.round((used / total) * 100) : 0;
  const swapTotal = m.SwapTotal || 0;
  const swapUsed = Math.max(0, swapTotal - (m.SwapFree || 0));

  return {
    load: {
      l1: parseFloat(l[0] || 0),
      l5: parseFloat(l[1] || 0),
      l15: parseFloat(l[2] || 0),
      procs: l[3] || "",
    },
    cpus: parseInt(nproc.trim() || "1", 10) || 1,
    kernel: kver.trim(),
    mem: {
      total,
      available,
      used,
      usedPct,
      usedH: humanBytes(used),
      totalH: humanBytes(total),
      availH: humanBytes(available),
      swapTotal,
      swapUsed,
      swapUsedH: humanBytes(swapUsed),
    },
  };
}, 2000);

const diskInfo = memo(async () => {
  const [hu, hi] = await Promise.all([
    run("df", ["-hP", "-x", "tmpfs", "-x", "overlay", "-x", "squashfs", "-x", "devtmpfs"]),
    run("df", ["-iP", "-x", "tmpfs", "-x", "overlay", "-x", "squashfs", "-x", "devtmpfs"]),
  ]);
  const inodes = {};
  for (const line of hi.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    inodes[f[5]] = { inodeUsedPct: parseInt(f[4] || "0", 10) || 0 };
  }
  const rows = [];
  for (const line of hu.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const total = parseInt(f[1], 10);
    const used = parseInt(f[2], 10);
    const avail = parseInt(f[3], 10);
    const usePct = parseInt((f[4] || "0").replace("%", ""), 10) || 0;
    rows.push({
      fs: f[0],
      mount: f[5],
      totalH: f[1],
      usedH: f[2],
      availH: f[3],
      usedG: total ? used : 0,
      usePct,
      inodePct: inodes[f[5]] ? inodes[f[5]].inodeUsedPct : null,
    });
  }
  return rows;
}, 5000);

const interruptStats = memo(async () => {
  const [interfaces, intent, conntrack] = await Promise.all([
    ifaceRates(),
    run("ss", ["-H", "-t", "-n", "state", "established"]),
    conntrackCount(),
  ]);
  const established = intent.split("\n").filter((l) => l.trim()).length;
  return { interfaces, established, conntrack: conntrack || null };
}, 2000);

const prevIface = {};

async function ifaceRates() {
  const out = await run("cat", ["/proc/net/dev"]);
  const now = Date.now();
  const res = [];
  let rxRate = 0;
  let txRate = 0;
  for (const line of out.split("\n").slice(2)) {
    const m = line.match(
      /^\s*(.+?):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/
    );
    if (!m) continue;
    const name = m[1];
    const rx = parseInt(m[2], 10);
    const tx = parseInt(m[3], 10);
    const p = prevIface[name];
    let r = 0;
    let t = 0;
    if (p) {
      const dt = (now - p.ts) / 1000;
      if (dt > 0) {
        r = Math.max(0, (rx - p.rx) / dt);
        t = Math.max(0, (tx - p.tx) / dt);
      }
    }
    prevIface[name] = { rx, tx, ts: now };
    rxRate += r;
    txRate += t;
    res.push({
      name,
      rx: humanBytes(rx),
      tx: humanBytes(tx),
      rxRateH: humanRate(r),
      txRateH: humanRate(t),
      rxRate: +r.toFixed(1),
      txRate: +t.toFixed(1),
    });
  }
  return { rows: res, rxRate, txRate };
}

async function conntrackCount() {
  try {
    const out = await run("sysctl", ["net.netfilter.nf_conntrack_count"]);
    const n = parseInt(out.trim().split(" ").slice(-1)[0], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---- services + checks ----
const SERVICE_UNITS = [
  "nginx",
  "mysql",
  "php8.3-fpm",
  "php8.4-fpm",
  "smbd",
  "nmbd",
  "wazuh-agent",
  "malang-funfacts",
  "noc",
  "zerotier-one",
  "nexusboard-serve@8000",
  "nexusboard-serve@8001",
  "nexusboard-serve@8002",
  "nexusboard-serve@8003",
  "nexusboard-serve@8004",
  "nexusboard-serve@8005",
];

const serviceHealth = memo(async () => {
  const states = await Promise.all(
    SERVICE_UNITS.map(async (u) => {
      const out = (await run("systemctl", ["is-active", u], 8000)).trim();
      return { name: u, state: out === "unknown" ? null : out };
    })
  );
  return states.filter((s) => s.state !== null).map((s) => ({
    name: s.name,
    state: s.state,
    ok: s.state === "active",
  }));
}, 10000);

const httpChecks = memo(async () => {
  const jobs = [
    { name: "WWW HTTP :80", url: "muthisyah.my.id:80:127.0.0.1", host: "http://muthisyah.my.id/", tcp: 80 },
    { name: "WWW HTTPS :443", url: "muthisyah.my.id:443:127.0.0.1", host: "https://muthisyah.my.id/", tcp: 443 },
    { name: "NOC HTTPS :443", url: "noc.muthisyah.my.id:443:127.0.0.1", host: "https://noc.muthisyah.my.id/api/session", tcp: 443 },
    { name: "Next.js :3000", host: "http://127.0.0.1:3000/", tcp: 3000 },
    { name: "NOC app :4000", host: "http://127.0.0.1:4000/api/session", tcp: 4000 },
  ];
  const rows = [];
  for (const j of jobs) {
    const args = ["-sk", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}|%{time_total}", j.host];
    if (j.url) args.splice(args.length - 1, 0, "--resolve", j.url);
    const out = (await run("curl", args, 5000)).trim();
    const [code, sec] = out.split("|");
    rows.push({
      name: j.name,
      target: j.host.replace("http://", "").replace("https://", ""),
      code: code || "-",
      ms: sec ? Math.round(parseFloat(sec) * 1000) : null,
      ok: !!(code && /^(2|3)\d\d$/.test(code)),
      tcp: j.tcp,
    });
  }
  for (const j of jobs) {
    const t = await tcpProbe(j.tcp);
    if (t !== null) rows.push({
      name: null,
      target: `tcp/${j.tcp}`,
      code: t.ok ? "open" : "closed",
      ms: t.ms,
      ok: t.ok,
      tcp: j.tcp,
    });
  }
  return rows.filter((r) => r.ok !== undefined);
}, 10000);

function tcpProbe(port) {
  return new Promise((res) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 2500 });
    const st = Date.now();
    sock.once("connect", () => {
      sock.destroy();
      res({ ok: true, ms: Date.now() - st });
    });
    sock.once("error", () => {
      sock.destroy();
      res({ ok: false, ms: Date.now() - st });
    });
    sock.once("timeout", () => {
      sock.destroy();
      res({ ok: false, ms: Date.now() - st });
    });
  });
}

// ---- security ----
const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

function parseTs(s) {
  const m = s.match(/^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  let year = new Date().getFullYear();
  let d = new Date(year, MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
  if (d.getTime() > Date.now() + 86400000) d = new Date(year - 1, MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
  return d.getTime();
}

const sshEvents = memo(async () => {
  const out = await run("journalctl", [
    "-u", "ssh", "--since", "24 hours ago", "--no-pager", "-o", "short",
  ]);
  const events = [];
  for (const line of out.split("\n")) {
    const t = parseTs(line);
    if (t === null) continue;
    let ev = null;
    let am = /Accepted (password|publickey|keyboard-interactive) for (\S+) from ([0-9a-fA-F:.]+) port (\d+)/.exec(line);
    if (am) {
      ev = { type: "accepted", sev: "info", user: am[2], src: am[3], port: am[4] };
    } else if ((am = /Failed password for (\S+) from ([0-9a-fA-F:.]+) port (\d+)/.exec(line))) {
      ev = { type: "failed_password", sev: "medium", user: am[1], src: am[2], port: am[3] };
    } else if ((am = /Invalid user (\S+) from ([0-9a-fA-F:.]+)/.exec(line))) {
      ev = { type: "invalid_user", sev: "medium", user: am[1], src: am[2], port: "" };
    } else if ((am = /error: maximum authentication attempts exceeded for (\S+) from ([0-9a-fA-F:.]+)/.exec(line))) {
      ev = { type: "max_attempts", sev: "high", user: am[1], src: am[2], port: "" };
    } else if ((am = /Connection (closed|reset) by authenticating user (\S+)/.exec(line))) {
      ev = { type: "conn_" + am[1], sev: "info", user: am[2], src: "", port: "" };
    } else if ((am = /Disconnected from ([0-9a-fA-F:.]+)/.exec(line))) {
      ev = { type: "disconnect", sev: "info", user: "", src: am[1], port: "" };
    }
    if (ev) events.push({ ts: t, ...ev, raw: line.trim().replace(/\s+/g, " ") });
  }
  events.sort((a, b) => a.ts - b.ts);
  const srcs = new Set();
  for (const e of events) if (e.src) srcs.add(e.src);
  const counts = { ok:0, fail:0, invalid:0, high:0 };
  for (const e of events) {
    if (e.type === "accepted") counts.ok++;
    else if (e.type === "failed_password" || e.type === "invalid_user") counts.fail++;
    else if (e.type === "max_attempts") counts.high++;
  }
  return {
    events: events.slice(-200).reverse(),
    totals: { ok: counts.ok, fail: counts.fail, high: counts.high, uniqueSrc: srcs.size },
  };
}, 15000);

const ufwBlocks = memo(async () => {
  const out = await run("journalctl", [
    "-k", "--since", "24 hours ago", "--no-pager",
  ], 20000);
  const lines = out.split("\n").filter((l) => /UFW BLOCK/.test(l));
  const src = {};
  const dport = {};
  for (const l of lines) {
    const s = /SRC=([0-9a-fA-F:.]+)/.exec(l);
    const d = /DPT=(\d+)/.exec(l);
    if (s) src[s[1]] = (src[s[1]] || 0) + 1;
    if (d) dport[d[1]] = (dport[d[1]] || 0) + 1;
  }
  const topSrc = Object.entries(src).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ip, n]) => ({ ip, n }));
  const topPort = Object.entries(dport).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([p, n]) => ({ port: p, n }));
  return { count: lines.length, topSrc, topPort };
}, 30000);

const wazuhStatus = memo(async () => {
  const out = await run("/var/ossec/bin/wazuh-control", ["status"], 10000);
  const modules = out.split("\n").filter((l) => l.includes("is running..."));
  let alertsAvailable = false;
  try {
    alertsAvailable = fs
      .readdirSync("/var/ossec/logs/alerts")
      .some((f) => f.endsWith(".json"));
  } catch {
    alertsAvailable = false;
  }
  return {
    running: modules.length >= 3,
    modules: modules.map((m) => m.split(" ")[0]),
    alertsAvailable,
  };
}, 20000);

// ---- network / zerotier ----
const ztInfo = memo(async () => {
  const [networks, peers, addr] = await Promise.all([
    run("zerotier-cli", ["listnetworks"]),
    ztPeers(),
    run("ip", ["-4", "-o", "addr", "show"]),
  ]);
  const hosts = {};
  for (const l of addr.split("\n")) {
    const m = l.match(/^\d+:\s+(\S+)\s+inet\s+([0-9.]+)\/\d+/);
    if (m) hosts[m[1]] = m[2];
  }
  const rows = [];
  for (const line of networks.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const id = f[2];
    if (!/^[0-9a-f]{16}$/.test(id)) continue;
    let ip = "";
    for (const t of f.slice(8)) if (/^\d{1,3}(\.\d{1,3}){3}/.test(t)) ip = t.split("/")[0];
    rows.push({
      id,
      name: f[3],
      status: f[5],
      type: f[6],
      dev: f[7],
      ip,
    });
  }
  const online = peers.filter((p) => p.role === "LEAF");
  return {
    networks: rows,
    peers,
    iface: rows[0] ? rows[0].dev : "-",
    ip: rows[0] ? rows[0].ip : "",
    hosts,
    summary: {
      total: peers.length,
      online: online.length,
    },
  };
}, 5000);

async function ztPeers() {
  const out = await run("zerotier-cli", ["peers"]);
  const rows = [];
  for (const line of out.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 2 || /PLANET/.test(f[2])) continue;
    if (/^\d+$/.test(f[0]) || f[0].startsWith("<")) continue;
    rows.push({
      addr: f[0] || "-",
      version: f[1] || "-",
      role: f[2] || "-",
      latency: f[3] || "-",
      link: f[4] || "-",
      path: f.slice(7).join(" ") || "-",
    });
  }
  return rows;
}

function socketScope(addr) {
  if (addr.startsWith("127.") || addr === "::1" || addr === "*" || addr === "") return "loopback";
  if (addr.startsWith("10.") || addr.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return "private";
  if (addr === "0.0.0.0" || addr === "::") return "public";
  return "public";
}

function extractUser(field) {
  const pid = /pid=(\d+)/.exec(field || "");
  const uid = /uid[:\s]*(\d+|\S+)/.exec(field || "");
  return {
    pid: pid ? pid[1] : "",
    uid: uid ? uid[1] : "",
  };
}

const passwdCache = memo(async () => {
  const out = await run("cat", ["/etc/passwd"]);
  const map = {};
  for (const l of out.split("\n")) {
    const p = l.split(":");
    if (p.length >= 3) map[p[2]] = p[0];
  }
  return map;
}, 60000);

async function usersForPids(pids) {
  const uniq = [...new Set(pids.filter(Boolean))];
  if (!uniq.length) return {};
  try {
    const out = await run("ps", ["-o", "pid=,user=", "-p", uniq.join(",")], 5000);
    const map = {};
    for (const l of out.split("\n")) {
      const m = l.trim().match(/^(\d+)\s+(\S+)/);
      if (m) map[m[1]] = m[2];
    }
    return map;
  } catch {
    return {};
  }
}

const listenerNet = memo(async () => {
  const [tcp, udp] = await Promise.all([listeners(), listeners(true)]);
  const all = tcp.concat(udp);
  const owners = await usersForPids(all.map((l) => l.pid));
  all.forEach((l) => {
    l.scope = socketScope(l.addr.split(":")[0]);
    l.user = owners[l.pid] || "";
  });
  const scoped = { public: 0, private: 0, loopback: 0 };
  for (const l of all) scoped[l.scope]++;
  return { listeners: all, scoped };
}, 3000);

async function listeners(udp) {
  const out = await run("ss", ["-H", udp ? "-u" : "-t", "-l", "-n", "-e", "-p"]);
  const rows = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const { pid, uid } = extractUser(line);
    rows.push({
      proto: udp ? "udp" : "tcp",
      addr: f[3],
      process: extractProcess(line),
      pid,
      uid,
    });
  }
  rows.sort((a, b) => a.addr.localeCompare(b.addr));
  return rows;
}

function extractProcess(field) {
  const m = (field || "").match(/users:\(\s*\(?"?([^",()]+)"/);
  if (m) return m[1];
  const m2 = (field || "").match(/pid=(\d+)/);
  return m2 ? "pid " + m2[1] : "-";
}

const connectionsNet = memo(async () => {
  const [out, users] = await Promise.all([run("ss", ["-H", "-tunape"]), passwdCache()]);
  const rows = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const proto = f[0];
    const state = f[1];
    const local = f[4].replace(/[\[\]]/g, "");
    const peer = f[5].replace(/[\[\]]/g, "");
    const { pid, uid } = extractUser(line);
    rows.push({
      proto,
      state,
      local,
      peer,
      process: extractProcess(line),
      pid,
      user: users[uid] || uid || "",
    });
  }
  return rows;
}, 3000);

// ---- audit ----
const auditEvents = memo(async () => {
  const [sudoOut, sysOut, sshdOut] = await Promise.all([
    run("journalctl", ["--identifier", "sudo", "--since", "24 hours ago", "--no-pager", "-o", "short"], 15000),
    run("journalctl", ["--since", "24 hours ago", "--no-pager"], 20000),
    run("journalctl", ["-u", "ssh", "--since", "24 hours ago", "--no-pager", "-o", "short"], 15000),
  ]);
  const ev = [];
  for (const line of sudoOut.split("\n")) {
    const t = parseTs(line);
    if (t === null) continue;
    const m = line.match(/^.{15}\s+\S+\s+sudo\[\d+\]:\s+(.+)$/);
    if (!m) continue;
    const msg = m[1];
    if (/session opened|session closed/.test(msg)) continue;
    ev.push({ ts: t, tsStr: line.slice(0, 15), source: "sudo", sev: msg.includes("FAIL") ? "high" : "info", msg });
  }
  for (const line of sysOut.split("\n")) {
    const t = parseTs(line);
    if (t === null) continue;
    const m = line.match(/^.{15}\s+\S+\s+systemd\[1\]:\s+(Started|Stopped|Reloaded)\s+(.+)$/);
    if (!m) continue;
    ev.push({ ts: t, tsStr: line.slice(0, 15), source: "systemd", sev: "info", msg: `Service ${m[1].toLowerCase()}: ${m[2]}` });
  }
  for (const line of sshdOut.split("\n")) {
    const t = parseTs(line);
    if (t === null) continue;
    const m = line.match(/Server listening on .*? port (\d+)/);
    const m2 = line.match(/Server terminated/);
    if (m) ev.push({ ts: t, tsStr: line.slice(0, 15), source: "sshd", sev: "info", msg: `sshd listening on port ${m[1]}` });
    else if (m2) ev.push({ ts: t, tsStr: line.slice(0, 15), source: "sshd", sev: "warn", msg: "sshd stopped" });
  }
  ev.sort((a, b) => b.ts - a.ts);
  return { events: ev.slice(0, 150), count: ev.length };
}, 25000);

// ---- telemetry sampler ----
function loadMetrics() {
  try {
    return JSON.parse(fs.readFileSync(METRICS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveMetrics(arr) {
  const tmp = METRICS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr));
  fs.renameSync(tmp, METRICS_FILE);
}

async function sampleMetrics() {
  const [sys, disk, net] = await Promise.all([systemInfo(), diskInfo(), ifaceRates()]);
  const root = disk.find((d) => d.mount === "/") || {};
  const point = {
    ts: Date.now(),
    load1: sys.load.l1,
    memUsedPct: sys.mem.usedPct,
    diskUsedPct: root.usePct ?? 0,
    rx: net.rxRate,
    tx: net.txRate,
  };
  let arr = loadMetrics();
  arr.push(point);
  if (arr.length > SAMPLE_KEEP) arr = arr.slice(arr.length - SAMPLE_KEEP);
  saveMetrics(arr);
}

setInterval(sampleMetrics, SAMPLE_MS).unref();
sampleMetrics().catch(() => {});

const metricsSeries = memo(async () => loadMetrics(), 2500);

function healthChecks(sys, disk, services, sec) {
  const issues = [];
  let status = "ok";
  const add = (level, msg) => {
    issues.push({ level, msg });
    if (level === "crit") status = "crit";
    else if (status !== "crit" && level === "warn") status = "warn";
  };
  if (sys.mem.usedPct >= 90) add("crit", `Memory ${sys.mem.usedPct}%`);
  else if (sys.mem.usedPct >= 75) add("warn", `Memory ${sys.mem.usedPct}%`);
  for (const d of disk) {
    if (d.usePct >= 90) add("crit", `Disk ${d.mount} ${d.usePct}%`);
    else if (d.usePct >= 80) add("warn", `Disk ${d.mount} ${d.usePct}%`);
  }
  for (const s of services) {
    if (s.state === "failed") add("crit", `Service ${s.name} failed`);
    else if (s.state !== "active") add("warn", `Service ${s.name} ${s.state}`);
  }
  if (sec.ssh.fail >= 200) add("crit", `SSH failures 24h: ${sec.ssh.fail}`);
  else if (sec.ssh.fail >= 50) add("warn", `SSH failures 24h: ${sec.ssh.fail}`);
  if (sec.ufw.count >= 1000) add("warn", `UFW blocks 24h: ${sec.ufw.count}`);
  return { status, issues };
}

// ---------- routes ----------
app.get("/api/session", (req, res) => {
  const raw = readCookie(req);
  const [tok, sig] = raw.split(".");
  const ok = tok && sig && sign(tok) === sig && sessions.has(tok);
  res.json({ authenticated: !!ok });
});

app.post("/api/login", (req, res) => {
  const ip = req.ip || "?";
  if (limited(ip)) {
    return res
      .status(429)
      .json({ error: "Terlalu banyak percobaan. Coba lagi 5 menit lagi." });
  }

  const { username, password } = req.body || {};
  const users = loadUsers();
  const user = users[username];

  let pwOk = false;
  if (user) {
    const hash = scrypt(password || "", user.salt);
    pwOk = hash === user.hash;
  }

  if (!user || !pwOk) {
    fail(ip);
    return res.status(401).json({ error: "Username atau password salah." });
  }

  pass(ip);
  cookieHeaders(res, makeToken());
  res.json({ ok: true });
});

app.post("/api/2fa/verify", (req, res) => {
  const ip = req.ip || "?";
  if (limited(ip)) return res.status(429).json({ error: "Terlalu banyak percobaan." });

  const { username, password, code } = req.body || {};
  const users = loadUsers();
  const user = users[username];
  if (!user || scrypt(password || "", user.salt) !== user.hash) {
    fail(ip);
    return res.status(401).json({ error: "Username atau password salah." });
  }

  const ok2 = speakeasy.totp.verify({
    secret: user.totpSecret,
    encoding: "base32",
    token: String(code || "").trim(),
    window: 1,
  });
  if (!ok2) {
    fail(ip);
    return res.status(401).json({ error: "Kode 2FA salah atau kedaluwarsa." });
  }

  user.totpVerified = true;
  saveUsers(users);
  pass(ip);
  cookieHeaders(res, makeToken());
  res.json({ ok: true });
});

app.post("/api/logout", auth, (req, res) => {
  const raw = readCookie(req);
  const [tok] = raw.split(".");
  if (tok) sessions.delete(tok);
  res.json({ ok: true });
});

app.get("/api/noc", auth, async (req, res) => {
  try {
    const [
      sys,
      disk,
      net2,
      svc,
      checks,
      ssh,
      ufw,
      wazuh,
      zt,
      listen,
      conns,
      audit,
      metrics,
      up,
    ] = await Promise.all([
      systemInfo(),
      diskInfo(),
      interruptStats(),
      serviceHealth(),
      httpChecks(),
      sshEvents(),
      ufwBlocks(),
      wazuhStatus(),
      ztInfo(),
      listenerNet(),
      connectionsNet(),
      auditEvents(),
      metricsSeries(),
      uptime(),
    ]);

    const sec = {
      sshFail24h: ssh.totals.fail + ssh.totals.high,
      ssh: ssh.totals,
      sshEvents: ssh.events,
      ufw: ufw,
      wazuh: wazuh,
      severity: [
        { key: "information", label: "Information", count: ssh.totals.ok, tone: "info" },
        { key: "medium", label: "Medium", count: ssh.totals.fail, tone: "warn" },
        { key: "high", label: "High", count: ssh.totals.high, tone: "crit" },
      ],
    };

    const health = healthChecks(sys, disk, svc, sec);

    res.json({
      ts: Date.now(),
      hostname: os.hostname(),
      uptime: up,
      health,
      env: process.env.NODE_ENV || "production",
      system: sys,
      disk,
      net: net2,
      interfaces: net2.interfaces.rows,
      services: { items: svc, checks },
      security: sec,
      network: { summary: zt.summary, networks: zt.networks, ztPeers: zt.peers, listeners: listen.listeners, scoped: listen.scoped },
      processes: conns,
      audit: audit.events,
      metrics: metrics,
    });
  } catch (e) {
    res.status(500).json({ error: String(e), stack: String((e && e.stack) || "").slice(0, 300) });
  }
});

async function uptime() {
  const out = await run("cat", ["/proc/uptime"]);
  const sec = parseInt(out.trim().split(" ")[0], 10) || 0;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} hari ${h} jam ${m} menit`;
  if (h > 0) return `${h} jam ${m} menit`;
  return `${m} menit`;
}

const users = seedAdmin();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`NOC listening on http://127.0.0.1:${PORT}`);
  sampleMetrics().catch(() => {});
});