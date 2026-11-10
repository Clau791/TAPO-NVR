'use strict';
// Adauga sau schimba un utilizator pentru clientul web.
//   node set-password.js <utilizator> <parola>
//   node set-password.js <utilizator> --remove
// Reporneste aplicatia dupa modificare.
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./auth');

const [user, pass] = process.argv.slice(2);
if (!user || !pass) {
  console.log('Utilizare: node set-password.js <utilizator> <parola>   |   node set-password.js <utilizator> --remove');
  process.exit(1);
}
const file = process.env.TAPO_NVR_CONFIG || path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
cfg.web = cfg.web || {};
cfg.web.users = (cfg.web.users || []).filter((u) => u.username !== user);
if (pass !== '--remove') {
  if (pass.length < 1) { console.log('Parola nu poate fi goala.'); process.exit(1); }
  cfg.web.users.push({ username: user, ...hashPassword(pass) });
}
delete cfg.web.username; delete cfg.web.password; // vechiul Basic Auth nu mai e folosit
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(pass === '--remove' ? `Utilizatorul ${user} a fost sters.` : `Parola pentru ${user} a fost salvata. Reporneste aplicatia.`);
