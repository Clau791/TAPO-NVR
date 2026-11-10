'use strict';
// Autentificare: parole scrypt in config.json (web.users), sesiuni prin cookie HttpOnly+Secure,
// blocare IP dupa prea multe incercari esuate.
const crypto = require('crypto');
const fs = require('fs');

const COOKIE = 'nvr_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const h = crypto.scryptSync(String(password), user.salt, 64);
  const expected = Buffer.from(user.hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

class Auth {
  constructor({ users, sessionFile, log }) {
    this.users = users || [];
    this.sessionFile = sessionFile;
    this.log = log || (() => { });
    this.sessions = new Map(); // token -> { user, expires }
    this.fails = new Map(); // ip -> { count, until }
    try {
      for (const [t, s] of Object.entries(JSON.parse(fs.readFileSync(sessionFile, 'utf8')))) {
        if (s.expires > Date.now()) this.sessions.set(t, s);
      }
    } catch { }
  }
  get enabled() { return this.users.length > 0; }

  save() {
    try { fs.writeFileSync(this.sessionFile, JSON.stringify(Object.fromEntries(this.sessions))); } catch { }
  }
  static parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  sessionUser(req) {
    const t = Auth.parseCookies(req)[COOKIE];
    if (!t) return null;
    const s = this.sessions.get(t);
    if (!s) return null;
    if (s.expires < Date.now()) { this.sessions.delete(t); this.save(); return null; }
    return s.user;
  }
  blockedFor(ip) {
    const f = this.fails.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
  }
  // returneaza { ok, cookie } sau { ok:false, error, status }
  login(ip, username, password) {
    const mins = this.blockedFor(ip);
    if (mins) return { ok: false, status: 429, error: `Prea multe încercări. Reîncearcă peste ${mins} min.` };
    const user = this.users.find((u) => u.username === String(username || '').trim());
    // verificam oricum o parola ca timpul de raspuns sa nu dezvaluie daca userul exista
    const ok = verifyPassword(password, user || { salt: '00', hash: '00'.repeat(64) }) && !!user;
    if (!ok) {
      const f = this.fails.get(ip) || { count: 0, until: 0 };
      f.count++;
      if (f.count >= MAX_FAILS) { f.until = Date.now() + BLOCK_MS; f.count = 0; this.log(`[auth] IP ${ip} blocat 15 min (parole gresite)`); }
      this.fails.set(ip, f);
      this.log(`[auth] autentificare esuata de la ${ip} (user "${String(username).slice(0, 40)}")`);
      return { ok: false, status: 401, error: 'Utilizator sau parolă greșită.' };
    }
    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { user: user.username, expires: Date.now() + SESSION_DAYS * 86400e3 });
    this.save();
    this.log(`[auth] ${user.username} autentificat de la ${ip}`);
    return { ok: true, cookie: `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}` };
  }
  logout(req) {
    const t = Auth.parseCookies(req)[COOKIE];
    if (t && this.sessions.delete(t)) this.save();
    return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  }
}

module.exports = { Auth, hashPassword };
