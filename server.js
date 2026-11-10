'use strict';
/*
 * Tapo NVR - inregistrare non-stop pentru camera Tapo C230 + client web (live + arhiva).
 * Fara dependinte externe in afara de ffmpeg/ffprobe (si hls.js servit din /public/vendor).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { Auth } = require('./auth');
const { spawn, execFile } = require('child_process');
const { Onvif } = require('./onvif');

// ---------------------------------------------------------------------------
// Configurare
// ---------------------------------------------------------------------------
const APP_DIR = __dirname;
const CONFIG_PATH = process.env.TAPO_NVR_CONFIG || path.join(APP_DIR, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Lipseste ${CONFIG_PATH}. Copiaza config.example.json in config.json si completeaza datele camerei.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
const cam = cfg.camera;
const SEGMENT_SECONDS = Number(cfg.segmentSeconds) || 300;
const DATA_DIR = path.resolve(cfg.dataDir || path.join(APP_DIR, 'data'));
const REC_DIR = path.join(DATA_DIR, 'recordings');
const LIVE_DIR = path.join(DATA_DIR, 'live');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const FFMPEG = cfg.ffmpegPath || 'ffmpeg';
const FFPROBE = cfg.ffprobePath || 'ffprobe';

for (const d of [DATA_DIR, REC_DIR, LIVE_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

const ptz = new Onvif({ host: cam.host, port: cam.onvifPort || 2020, username: cam.username, password: cam.password });

// ---------------------------------------------------------------------------
// Log (fisier cu rotatie simpla)
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(LOG_DIR, 'nvr.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* ignore */ }
}
const redact = (s) => String(s).replace(/rtsp:\/\/[^@\s]+@/g, 'rtsp://***:***@');

// ---------------------------------------------------------------------------
// Utilitare data/ora (ora locala)
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/;
function parseFileTime(name) {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function ensureDayDirs() {
  // ffmpeg nu creeaza directoare: pregatim azi si maine.
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  for (const d of [now, tomorrow]) fs.mkdirSync(path.join(REC_DIR, dayStr(d)), { recursive: true });
}

function rtspUrl(stream) {
  const u = encodeURIComponent(cam.username);
  const p = encodeURIComponent(cam.password);
  return `rtsp://${u}:${p}@${cam.host}:${cam.port || 554}/${stream}`;
}

// ---------------------------------------------------------------------------
// Procese ffmpeg supravegheate (repornire automata + detectie blocaj)
// ---------------------------------------------------------------------------
const audioArgs = () => (cfg.audio === false ? ['-an']
  : ['-af', 'aresample=async=1000', '-c:a', 'aac', '-b:a', '48k', '-ar', '16000', '-ac', '1']);
const maps = () => (cfg.audio === false ? ['-map', '0:v:0'] : ['-map', '0:v:0', '-map', '0:a:0?']);

function inputArgs(stream) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-progress', 'pipe:1', '-stats_period', '5',
    '-rtsp_transport', 'tcp',
    '-timeout', '15000000', // 15s timeout pe socket (microsecunde)
    '-fflags', '+genpts+discardcorrupt',
    '-i', rtspUrl(stream),
  ];
}

function recordOutput() {
  return [
    ...maps(), '-c:v', 'copy', ...audioArgs(),
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SECONDS),
    '-segment_atclocktime', '1',
    '-reset_timestamps', '1',
    '-strftime', '1',
    '-segment_format', 'mp4',
    // MP4 fragmentat: fisierul ramane redabil si daca procesul/curentul se opreste brusc,
    // iar segmentul in curs poate fi redat inca de cand se scrie.
    // Fragmente la ~10 s; dupa inchidere segmentul e convertit in MP4 standard (vezi finalize()).
    '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof:frag_duration=10000000',
    path.join(REC_DIR, '%Y-%m-%d', '%Y-%m-%d_%H-%M-%S.mp4'),
  ];
}

function liveOutput() {
  return [
    ...maps(), '-c:v', 'copy', ...audioArgs(),
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist+temp_file',
    '-hls_segment_filename', path.join(LIVE_DIR, 'seg_%06d.ts'),
    path.join(LIVE_DIR, 'live.m3u8'),
  ];
}

// Avertismente repetitive (timestamp-uri neregulate trimise de Tapo) - nu le scriem pe fiecare in log.
const NOISY_RE = /Non-monotonic DTS|changing to \d+|Queue input is backward in time|Past duration .* too large/;

class Supervised {
  constructor(name, buildArgs) {
    this.name = name;
    this.buildArgs = buildArgs;
    this.lastProgress = 0; // ultima actualizare de progres de la ffmpeg (stdout)
    this.lastFrame = -1;
    this.noisy = 0;
    this.proc = null;
    this.startedAt = 0;
    this.restarts = 0;
    this.backoff = 2000;
    this.lastError = '';
    this.stopping = false;
  }
  start() {
    if (this.stopping) return;
    ensureDayDirs();
    const args = this.buildArgs();
    log(`[${this.name}] pornesc ffmpeg: ${redact(args.join(' '))}`);
    this.startedAt = Date.now();
    this.lastProgress = Date.now();
    this.lastFrame = -1;
    const p = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    // -progress: blocuri "frame=N ... progress=continue" la fiecare 5s
    p.stdout.on('data', (d) => {
      const m = /frame=(\d+)/.exec(d.toString());
      if (m && Number(m[1]) !== this.lastFrame) { this.lastFrame = Number(m[1]); this.lastProgress = Date.now(); }
    });
    let errBuf = '';
    p.stderr.on('data', (d) => {
      errBuf += d.toString();
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (!line) continue;
        if (NOISY_RE.test(line)) { this.noisy++; continue; }
        this.lastError = redact(line);
        log(`[${this.name}] ffmpeg: ${this.lastError}`);
      }
    });
    p.on('error', (e) => { this.lastError = e.message; log(`[${this.name}] eroare spawn: ${e.message}`); });
    p.on('exit', (code, sig) => {
      if (this.proc === p) this.proc = null;
      const ran = Date.now() - this.startedAt;
      log(`[${this.name}] ffmpeg oprit (cod=${code}, semnal=${sig}, a rulat ${Math.round(ran / 1000)}s)`);
      if (this.stopping) return;
      this.backoff = ran > 60000 ? 2000 : Math.min(this.backoff * 2, 60000);
      this.restarts++;
      setTimeout(() => this.start(), this.backoff);
    });
  }
  // Oprire curata: 'q' pe stdin -> ffmpeg scrie moov-ul fisierului curent.
  stop(graceful = true) {
    const p = this.proc;
    if (!p) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill(); } catch { } }, 8000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      if (graceful) { try { p.stdin.write('q'); } catch { p.kill(); } } else p.kill();
    });
  }
  async checkHealth() {
    if (this.noisy && Date.now() - (this.noisyLogged || 0) > 3600e3) {
      log(`[${this.name}] ${this.noisy} avertismente de timestamp ignorate in ultima ora`);
      this.noisy = 0; this.noisyLogged = Date.now();
    }
    if (!this.proc || Date.now() - this.startedAt < 30000) return;
    const idle = Date.now() - this.lastProgress;
    if (idle > 40000) {
      log(`[${this.name}] fara cadre noi de ${Math.round(idle / 1000)}s - repornesc`);
      this.stop(false);
    }
  }
  get healthy() { return !!this.proc && Date.now() - this.lastProgress < 20000 && this.lastFrame > 0; }
  status() {
    return {
      name: this.name,
      running: this.healthy,
      frames: this.lastFrame,
      uptimeSec: this.proc ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      lastMessage: this.lastError,
    };
  }
}

// Curatam folderul live la pornire
for (const f of fs.readdirSync(LIVE_DIR)) { try { fs.unlinkSync(path.join(LIVE_DIR, f)); } catch { } }

const workers = [];
let recorder;
if (cam.recordStream === cam.liveStream || !cam.liveStream) {
  recorder = new Supervised('camera', () => [...inputArgs(cam.recordStream), ...recordOutput(), ...liveOutput()]);
  workers.push(recorder);
} else {
  recorder = new Supervised('inregistrare', () => [...inputArgs(cam.recordStream), ...recordOutput()]);
  workers.push(recorder, new Supervised('live', () => [...inputArgs(cam.liveStream), ...liveOutput()]));
}

// ---------------------------------------------------------------------------
// Durate fisiere (ffprobe, cu cache pe disc per zi)
// ---------------------------------------------------------------------------
const durCache = new Map(); // day -> { file: {size, dur} }
function loadDurCache(day) {
  if (durCache.has(day)) return durCache.get(day);
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(REC_DIR, day, '.durations.json'), 'utf8')); } catch { }
  durCache.set(day, c);
  return c;
}
const saveTimers = new Map();
function saveDurCache(day) {
  clearTimeout(saveTimers.get(day));
  saveTimers.set(day, setTimeout(() => {
    fsp.writeFile(path.join(REC_DIR, day, '.durations.json'), JSON.stringify(durCache.get(day) || {})).catch(() => { });
  }, 2000));
}
function ffprobeDuration(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        const v = parseFloat(String(stdout).trim());
        resolve(err || !isFinite(v) ? null : v);
      });
  });
}
const probeQueue = [];
let probing = 0;
function queueProbe(day, name, size) {
  const key = day + '/' + name;
  if (probeQueue.some((q) => q.key === key)) return;
  probeQueue.push({ key, day, name, size });
  pumpProbe();
}
function pumpProbe() {
  while (probing < 3 && probeQueue.length) {
    const job = probeQueue.shift();
    probing++;
    ffprobeDuration(path.join(REC_DIR, job.day, job.name)).then((dur) => {
      const c = loadDurCache(job.day);
      if (c[job.name] && c[job.name].final) return; // deja finalizat intre timp
      c[job.name] = { size: job.size, dur: dur == null ? -1 : dur };
      saveDurCache(job.day);
    }).finally(() => { probing--; pumpProbe(); });
  }
}

async function listDay(day) {
  const dir = path.join(REC_DIR, day);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => FILE_RE.test(n)).sort(); } catch { return []; }
  const cache = loadDurCache(day);
  const now = Date.now();
  const items = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    let st;
    try { st = await fsp.stat(path.join(dir, name)); } catch { continue; }
    const start = parseFileTime(name).getTime();
    // Pe Windows dimensiunea/mtime fisierului deschis nu se actualizeaza: ultimul fisier al zilei,
    // inceput recent, cat timp ffmpeg ruleaza = segmentul in curs.
    const recording = i === names.length - 1 && !!recorder.proc && start >= recorder.startedAt - 1000
      && now - start < (SEGMENT_SECONDS + 60) * 1000;
    let dur;
    if (recording) {
      dur = (now - start) / 1000;
    } else {
      const c = cache[name];
      if (c && c.size === st.size && c.dur === -1) continue; // fisier corupt (nu poate fi citit)
      if (c && c.size === st.size && c.dur > 0) dur = c.dur;
      else {
        if (!c || c.size !== st.size) queueProbe(day, name, st.size);
        dur = Math.max(1, Math.min(SEGMENT_SECONDS, (st.mtimeMs - start) / 1000));
      }
    }
    if (st.size < 1024 && !recording) continue; // fisiere goale/corupte
    items.push({
      file: name,
      url: `/recordings/${day}/${name}`,
      start,
      end: start + dur * 1000,
      duration: Math.round(dur * 10) / 10,
      size: st.size,
      recording,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Finalizare: segmentele inchise (MP4 fragmentat) sunt rescrise ca MP4 standard cu
// index la inceput (-c copy, fara re-encodare) => incarcare si derulare instantanee in browser.
// ---------------------------------------------------------------------------
let finalizing = false;
async function finalizeSegments() {
  if (finalizing) return;
  finalizing = true;
  try {
    const days = (await fsp.readdir(REC_DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    const all = [];
    for (const d of days) {
      for (const n of (await fsp.readdir(path.join(REC_DIR, d))).filter((x) => FILE_RE.test(x)).sort()) all.push([d, n]);
    }
    const newest = all[all.length - 1];
    for (const [day, name] of all) {
      const c = loadDurCache(day);
      if (c[name] && (c[name].final || c[name].dur === -1)) continue;
      const file = path.join(REC_DIR, day, name);
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      // ultimul fisier se scrie inca (cat timp ffmpeg ruleaza si nu e prea vechi)
      if (newest && newest[0] === day && newest[1] === name
        && recorder.proc && Date.now() - parseFileTime(name).getTime() < (SEGMENT_SECONDS + 120) * 1000) continue;
      const tmp = file + '.tmp.mp4';
      const ok = await new Promise((resolve) => {
        execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy',
          '-movflags', '+faststart', tmp], { windowsHide: true, timeout: 120000 }, (err) => resolve(!err));
      });
      if (!ok) {
        await fsp.unlink(tmp).catch(() => { });
        if (st.size > 0) log(`[finalizare] ${day}/${name} nu poate fi citit - marcat corupt`);
        c[name] = { size: st.size, dur: -1 };
        saveDurCache(day);
        continue;
      }
      try {
        await fsp.rename(tmp, file); // poate esua daca fisierul e deschis in acest moment -> reincercam
        const nst = await fsp.stat(file);
        const dur = await ffprobeDuration(file);
        c[name] = { size: nst.size, dur: dur == null ? -1 : dur, final: true };
        saveDurCache(day);
      } catch {
        await fsp.unlink(tmp).catch(() => { });
      }
    }
  } catch (e) {
    log('[finalizare] eroare: ' + e.message);
  } finally {
    finalizing = false;
  }
}

async function listDays() {
  let names = [];
  try { names = await fsp.readdir(REC_DIR); } catch { }
  const out = [];
  for (const d of names.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()) {
    let files = [];
    try { files = (await fsp.readdir(path.join(REC_DIR, d))).filter((n) => FILE_RE.test(n)); } catch { }
    if (files.length) out.push({ day: d, count: files.length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Retentie: sterge zilele vechi si elibereaza spatiu
// ---------------------------------------------------------------------------
async function freeGB() {
  try { const s = await fsp.statfs(DATA_DIR); return (s.bavail * s.bsize) / 1024 ** 3; } catch { return Infinity; }
}
async function retention() {
  try {
    const days = (await fsp.readdir(REC_DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    const cutoff = dayStr(new Date(Date.now() - (Number(cfg.retentionDays) || 30) * 24 * 3600 * 1000));
    for (const d of days) {
      if (d < cutoff) {
        log(`[retentie] sterg ziua ${d} (mai veche de ${cfg.retentionDays} zile)`);
        await fsp.rm(path.join(REC_DIR, d), { recursive: true, force: true });
        durCache.delete(d);
      }
    }
    const minFree = Number(cfg.minFreeGB) || 10;
    let guard = 0;
    while ((await freeGB()) < minFree && guard++ < 500) {
      const ds = (await fsp.readdir(REC_DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
      let deleted = false;
      for (const d of ds) {
        const files = (await fsp.readdir(path.join(REC_DIR, d))).filter((n) => FILE_RE.test(n)).sort();
        if (!files.length) {
          if (d < dayStr(new Date())) await fsp.rm(path.join(REC_DIR, d), { recursive: true, force: true });
          continue;
        }
        if (d === dayStr(new Date()) && files.length <= 1) break;
        log(`[retentie] spatiu liber sub ${minFree} GB - sterg ${d}/${files[0]}`);
        await fsp.unlink(path.join(REC_DIR, d, files[0]));
        deleted = true;
        break;
      }
      if (!deleted) break;
    }
  } catch (e) { log('[retentie] eroare: ' + e.message); }
}

// ---------------------------------------------------------------------------
// Server HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
};

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function sendFile(req, res, file, { cache = 'no-cache', download = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end('Not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('Not found'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (isNaN(start) || start < 0 || start >= st.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}

// ---------------------------------------------------------------------------
// Autentificare
// ---------------------------------------------------------------------------
const auth = new Auth({ users: (cfg.web || {}).users, sessionFile: path.join(DATA_DIR, 'sessions.json'), log });
const PUBLIC_PATHS = new Set(['/login.html', '/login', '/style.css', '/favicon.ico']);
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
// Prin Tailscale Funnel / reverse proxy conexiunea vine de pe localhost; IP-ul real e in X-Forwarded-For.
// Il folosim DOAR cand conexiunea vine de pe localhost (proxy local de incredere).
function clientIp(req) {
  const sock = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const xff = req.headers['x-forwarded-for'];
  if (isLoopback(sock) && xff) return String(xff).split(',')[0].trim().replace(/^::ffff:/, '') || 'proxy';
  return sock;
}
const viaProxy = (req) => !!req.headers['x-forwarded-for'] || !!req.headers['tailscale-funnel-request'];
const isPrivate = (ip) => isLoopback(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80:|fc|fd)/i.test(ip);

// true = poate continua; altfel raspunsul a fost deja trimis
async function checkAuth(req, res, p) {
  const ip = clientIp(req);
  if (p === '/login' && req.method === 'POST') {
    let b = {};
    try { b = await readBody(req); } catch { }
    const r = auth.login(ip, b.username, b.password);
    if (!r.ok) { sendJSON(res, { error: r.error }, r.status); return false; }
    res.writeHead(200, { 'Set-Cookie': r.cookie, 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return false;
  }
  if (p === '/logout') {
    res.writeHead(302, { 'Set-Cookie': auth.logout(req), Location: '/login.html' });
    res.end();
    return false;
  }
  if (PUBLIC_PATHS.has(p)) return true;
  if (!auth.enabled) {
    // Fara utilizatori configurati: doar reteaua locala are acces (nu expunem accidental pe internet).
    if (isPrivate(ip) && !viaProxy(req)) return true;
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acces din internet dezactivat: configureaza un utilizator (node set-password.js).');
    return false;
  }
  // Login obligatoriu pentru toti (inclusiv localhost: Funnel/proxy-urile locale vin tot de pe localhost).
  if (auth.sessionUser(req)) return true;
  if (p.startsWith('/api/') || p.startsWith('/live/') || p.startsWith('/recordings/')) {
    sendJSON(res, { error: 'neautentificat' }, 401);
  } else {
    res.writeHead(302, { Location: '/login.html' });
    res.end();
  }
  return false;
}

async function app(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (!(await checkAuth(req, res, p))) return;

    if (p === '/api/status') {
      const used = await dirSize(REC_DIR);
      return sendJSON(res, {
        camera: cam.host,
        now: Date.now(),
        segmentSeconds: SEGMENT_SECONDS,
        retentionDays: cfg.retentionDays,
        workers: workers.map((w) => w.status()),
        disk: { freeGB: Math.round((await freeGB()) * 10) / 10, usedGB: Math.round(used / 1024 ** 3 * 100) / 100 },
        liveReady: fs.existsSync(path.join(LIVE_DIR, 'live.m3u8')),
      });
    }
    if (p.startsWith('/api/ptz/')) return handlePtz(req, res, p.slice(9));
    if (p.startsWith('/api/talk/')) return handleTalk(req, res, p.slice(10));
    if (p === '/api/days') return sendJSON(res, await listDays());
    if (p === '/api/recordings') {
      const day = url.searchParams.get('date') || dayStr(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJSON(res, { error: 'data invalida' }, 400);
      return sendJSON(res, await listDay(day));
    }
    if (p.startsWith('/live/')) {
      const f = safeJoin(LIVE_DIR, p.slice(6));
      if (!f) { res.writeHead(400); return res.end(); }
      return sendFile(req, res, f, { cache: 'no-store' });
    }
    if (p.startsWith('/recordings/')) {
      const f = safeJoin(REC_DIR, p.slice(12));
      if (!f || !FILE_RE.test(path.basename(f))) { res.writeHead(400); return res.end(); }
      return sendFile(req, res, f, { cache: 'private, max-age=3600', download: url.searchParams.has('download') });
    }
    if (p.startsWith('/vendor/hls.min.js')) {
      return sendFile(req, res, path.join(APP_DIR, 'node_modules', 'hls.js', 'dist', 'hls.min.js'), { cache: 'max-age=86400' });
    }
    const f = safeJoin(PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
    if (!f) { res.writeHead(400); return res.end(); }
    return sendFile(req, res, f);
  } catch (e) {
    log('[http] eroare: ' + e.stack);
    if (!res.headersSent) res.writeHead(500);
    res.end('Eroare server');
  }
}

const extReqSeen = new Set();
// Headere de securitate pentru toate raspunsurile
function withSecurityHeaders(handler) {
  return (req, res) => {
    const ip = clientIp(req);
    if (!isPrivate(ip) && !extReqSeen.has(ip)) {
      extReqSeen.add(ip);
      if (extReqSeen.size > 5000) extReqSeen.clear();
      log(`[net] ${ip} a ajuns la server: ${req.method} ${req.url.slice(0, 80)} (${req.socket.encrypted ? 'https' : 'http'})`);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    return handler(req, res);
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// PTZ: POST /api/ptz/move {x,y} (pas relativ, -1..1), /continuous {x,y}, /stop,
//      GET /api/ptz/presets, POST /api/ptz/preset/goto {token}, /preset/set {name}, /preset/remove {token}
async function handlePtz(req, res, action) {
  try {
    if (action === 'presets' && req.method === 'GET') return sendJSON(res, await ptz.presets());
    if (req.method !== 'POST') return sendJSON(res, { error: 'metoda' }, 405);
    const b = await readBody(req);
    // Pe Tapo C230 axa orizontala ONVIF e inversata (x pozitiv = stanga); configurabil.
    const sx = cam.ptzInvertPan === false ? 1 : -1;
    const sy = cam.ptzInvertTilt ? -1 : 1;
    switch (action) {
      case 'move': await ptz.relativeMove(sx * (b.x || 0), sy * (b.y || 0)); break;
      case 'continuous': await ptz.continuousMove(sx * (b.x || 0), sy * (b.y || 0)); break;
      case 'stop': await ptz.stop(); break;
      case 'preset/goto': await ptz.gotoPreset(b.token); break;
      case 'preset/set': {
        const name = String(b.name || '').trim().slice(0, 30);
        if (!name) return sendJSON(res, { error: 'nume lipsa' }, 400);
        await ptz.setPreset(name);
        log(`[ptz] pozitie salvata: ${name}`);
        break;
      }
      case 'preset/remove': await ptz.removePreset(b.token); break;
      default: return sendJSON(res, { error: 'actiune necunoscuta' }, 404);
    }
    return sendJSON(res, { ok: true });
  } catch (e) {
    log(`[ptz] ${action}: ${e.message}`);
    return sendJSON(res, { error: e.message }, 502);
  }
}

let sizeCache = { t: 0, v: 0 };
async function dirSize(dir) {
  if (Date.now() - sizeCache.t < 60000) return sizeCache.v;
  let total = 0;
  async function walk(d) {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) await walk(fp);
      else total += (await fsp.stat(fp).catch(() => ({ size: 0 }))).size;
    }
  }
  await walk(dir);
  sizeCache = { t: Date.now(), v: total };
  return total;
}

// ---------------------------------------------------------------------------
// Vorbire prin camera (two-way audio) via go2rtc
// Tapo nu ofera backchannel audio pe RTSP/ONVIF; go2rtc implementeaza protocolul Tapo
// (port 8800) si primeste microfonul din browser prin WebRTC.
// Necesita parola contului TP-Link/Tapo (camera.cloudPassword).
// ---------------------------------------------------------------------------
const GO2RTC = cfg.go2rtcPath || path.join(APP_DIR, 'bin', 'go2rtc', 'go2rtc.exe');
const GO2RTC_API = Number(cfg.go2rtcApiPort) || 1984;
const TALK_ENABLED = !!cam.cloudPassword && fs.existsSync(GO2RTC);
let go2rtcProc = null, go2rtcStopping = false, go2rtcLast = '';

function startGo2rtc() {
  if (!TALK_ENABLED || go2rtcStopping) return;
  const yq = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const yaml = [
    'api:',
    `  listen: "127.0.0.1:${GO2RTC_API}"`, // API doar local; accesul trece prin serverul NVR
    '  origin: "*"',
    'rtsp:',
    '  listen: ""',
    'rtmp:',
    '  listen: ""',
    'webrtc:',
    `  listen: ":${Number(cfg.webrtcPort) || 8555}"`,
    'log:',
    '  level: warn',
    'streams:',
    `  tapo_talk: ${yq(`tapo://admin:${encodeURIComponent(cam.cloudPassword)}@${cam.host}`)}`,
    '',
  ].join('\n');
  const cfgFile = path.join(DATA_DIR, 'go2rtc.yaml');
  fs.writeFileSync(cfgFile, yaml);
  log('[go2rtc] pornesc');
  const p = spawn(GO2RTC, ['-config', cfgFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: DATA_DIR });
  go2rtcProc = p;
  const onOut = (d) => {
    for (const line of d.toString().split('\n').map((l) => l.trim()).filter(Boolean)) {
      go2rtcLast = redact(line).replace(/tapo:\/\/[^@\s]+@/g, 'tapo://***@');
      log('[go2rtc] ' + go2rtcLast);
    }
  };
  p.stdout.on('data', onOut);
  p.stderr.on('data', onOut);
  p.on('error', (e) => log('[go2rtc] eroare: ' + e.message));
  p.on('exit', (code) => {
    if (go2rtcProc === p) go2rtcProc = null;
    log(`[go2rtc] oprit (cod=${code})`);
    if (!go2rtcStopping) setTimeout(startGo2rtc, 5000);
  });
}

function go2rtcRequest(method, pathQ, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: GO2RTC_API, path: pathQ, method,
      headers: body ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout go2rtc')));
    req.end(body);
  });
}

async function handleTalk(req, res, action) {
  if (action === 'status') {
    return sendJSON(res, {
      available: TALK_ENABLED && !!go2rtcProc,
      reason: !cam.cloudPassword ? 'Lipseste camera.cloudPassword (parola contului Tapo) in config.json'
        : !fs.existsSync(GO2RTC) ? 'go2rtc.exe lipseste' : !go2rtcProc ? 'go2rtc nu ruleaza' : '',
    });
  }
  if (action === 'offer' && req.method === 'POST') {
    if (!TALK_ENABLED || !go2rtcProc) return sendJSON(res, { error: 'vorbirea nu este configurata' }, 503);
    let sdp = '';
    for await (const c of req) { sdp += c; if (sdp.length > 100000) return sendJSON(res, { error: 'prea mare' }, 413); }
    try {
      const r = await go2rtcRequest('POST', '/api/webrtc?src=tapo_talk', sdp, 'application/sdp');
      if (r.status >= 300 || !r.body.startsWith('v=')) {
        log(`[talk] go2rtc a raspuns ${r.status}: ${r.body.slice(0, 200)}`);
        return sendJSON(res, { error: r.body.trim().slice(0, 200) || 'eroare go2rtc' }, 502);
      }
      res.writeHead(200, { 'Content-Type': 'application/sdp', 'Cache-Control': 'no-store' });
      return res.end(r.body);
    } catch (e) {
      return sendJSON(res, { error: e.message }, 502);
    }
  }
  return sendJSON(res, { error: 'actiune necunoscuta' }, 404);
}

// ---------------------------------------------------------------------------
// Pornire
// ---------------------------------------------------------------------------
const web = cfg.web || {};
const WEB_PORT = web.port || 8080;
const TLS_DIR = path.join(DATA_DIR, 'tls');
const certFile = web.certFile || path.join(TLS_DIR, 'cert.pem');
const keyFile = web.keyFile || path.join(TLS_DIR, 'key.pem');
const useHttps = web.https !== false && fs.existsSync(certFile) && fs.existsSync(keyFile);
// Jurnal pentru conexiuni din internet (o linie per IP la 10 minute)
const extSeen = new Map();
function logExternalConnection(socket) {
  const ip = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (isPrivate(ip)) return;
  const last = extSeen.get(ip) || 0;
  if (Date.now() - last < 600000) return;
  extSeen.set(ip, Date.now());
  if (extSeen.size > 5000) extSeen.clear();
  log(`[net] conexiune din internet de la ${ip}`);
}
let server;
if (useHttps) {
  // HTTPS si HTTP pe acelasi port: conexiunile TLS merg la serverul HTTPS,
  // cele HTTP simple primesc redirect catre https://.
  const httpsServer = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, withSecurityHeaders(app));
  httpsServer.on('tlsClientError', (err, socket) => {
    const ip = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!isPrivate(ip)) log(`[net] TLS respins de clientul ${ip}: ${err.code || err.message} (de obicei = avertizarea de certificat in browser)`);
  });
  const redirectServer = http.createServer((req, res) => {
    const host = String(req.headers.host || `localhost:${WEB_PORT}`).replace(/[^\w.:[\]-]/g, '');
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  });
  server = net.createServer((socket) => {
    logExternalConnection(socket);
    socket.once('data', (buf) => {
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? httpsServer : redirectServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
    socket.on('error', () => { });
    socket.setTimeout(120000, () => socket.destroy());
  });
} else {
  server = http.createServer(withSecurityHeaders(app));
  server.on('connection', logExternalConnection);
}
// Port HTTP doar pe 127.0.0.1 pentru proxy-uri locale (Tailscale Funnel termina TLS cu certificat valid).
// Nu e accesibil din retea; autentificarea ramane obligatorie.
const LOCAL_HTTP_PORT = web.localHttpPort === 0 ? 0 : (web.localHttpPort || 8081);
if (LOCAL_HTTP_PORT) {
  http.createServer(withSecurityHeaders(app)).listen(LOCAL_HTTP_PORT, '127.0.0.1', () => {
    log(`Port local pentru proxy (Tailscale Funnel): http://127.0.0.1:${LOCAL_HTTP_PORT}`);
  }).on('error', (e) => log('[http-local] ' + e.message));
}
server.listen(WEB_PORT, web.host || '0.0.0.0', () => {
  log(`Tapo NVR pornit. Client web: ${useHttps ? 'https' : 'http'}://localhost:${WEB_PORT}  | date: ${DATA_DIR}`
    + ` | autentificare: ${auth.enabled ? auth.users.length + ' utilizator(i)' : 'DOAR RETEA LOCALA (niciun utilizator)'}`);
});

ensureDayDirs();
workers.forEach((w) => w.start());
if (TALK_ENABLED) startGo2rtc();
else log('[talk] vorbirea prin camera dezactivata: ' + (!cam.cloudPassword ? 'lipseste camera.cloudPassword' : 'go2rtc.exe lipseste'));
setInterval(ensureDayDirs, 60 * 1000);
setInterval(() => workers.forEach((w) => w.checkHealth().catch(() => { })), 15 * 1000);
setInterval(retention, 10 * 60 * 1000);
setInterval(finalizeSegments, 20 * 1000);
setTimeout(finalizeSegments, 10 * 1000);
setTimeout(retention, 30 * 1000);

async function shutdown() {
  log('Oprire...');
  workers.forEach((w) => { w.stopping = true; });
  go2rtcStopping = true;
  if (go2rtcProc) go2rtcProc.kill();
  await Promise.all(workers.map((w) => w.stop(true)));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => log('uncaughtException: ' + e.stack));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack || e)));
