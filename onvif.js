'use strict';
// Client ONVIF minimal (PTZ) pentru Tapo: SOAP 1.2 + WS-Security UsernameToken (PasswordDigest).
const crypto = require('crypto');
const http = require('http');

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
  + 'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"';
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const num = (v) => { const n = Number(v); if (!isFinite(n)) throw new Error('valoare invalida'); return Math.max(-1, Math.min(1, n)); };

class Onvif {
  constructor({ host, port = 2020, username, password }) {
    Object.assign(this, { host, port, username, password });
    this.profile = null;
    this.queue = Promise.resolve(); // camera accepta o comanda pe rand
  }

  header() {
    const nonce = crypto.randomBytes(16);
    const created = new Date().toISOString();
    const digest = crypto.createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.password)])).digest('base64');
    return '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
      + `<UsernameToken><Username>${esc(this.username)}</Username>`
      + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
      + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
      + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
      + '</UsernameToken></Security></s:Header>';
  }

  request(body, path = '/onvif/service') {
    const run = () => new Promise((resolve, reject) => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}>${this.header()}<s:Body>${body}</s:Body></s:Envelope>`;
      const req = http.request({
        host: this.host, port: this.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200 || /:Fault>/.test(data)) {
            const reason = (/<[^>]*Text[^>]*>([^<]+)</.exec(data) || [])[1] || `HTTP ${res.statusCode}`;
            reject(new Error('ONVIF: ' + reason));
          } else resolve(data);
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('ONVIF: timeout')));
      req.end(xml);
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => { });
    return p;
  }

  async token() {
    if (this.profile) return this.profile;
    const xml = await this.request('<trt:GetProfiles/>');
    const m = /Profiles[^>]*token="([^"]+)"/.exec(xml);
    if (!m) throw new Error('ONVIF: niciun profil');
    this.profile = m[1];
    return this.profile;
  }

  async relativeMove(x, y) {
    const t = await this.token();
    await this.request(`<tptz:RelativeMove><tptz:ProfileToken>${esc(t)}</tptz:ProfileToken>`
      + `<tptz:Translation><tt:PanTilt x="${num(x)}" y="${num(y)}"/></tptz:Translation></tptz:RelativeMove>`);
  }

  async continuousMove(x, y) {
    const t = await this.token();
    await this.request(`<tptz:ContinuousMove><tptz:ProfileToken>${esc(t)}</tptz:ProfileToken>`
      + `<tptz:Velocity><tt:PanTilt x="${num(x)}" y="${num(y)}"/></tptz:Velocity></tptz:ContinuousMove>`);
  }

  async stop() {
    const t = await this.token();
    await this.request(`<tptz:Stop><tptz:ProfileToken>${esc(t)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt></tptz:Stop>`);
  }

  async presets() {
    const t = await this.token();
    const xml = await this.request(`<tptz:GetPresets><tptz:ProfileToken>${esc(t)}</tptz:ProfileToken></tptz:GetPresets>`);
    const out = [];
    const re = /<tptz:Preset[^>]*token="([^"]+)"[^>]*>([\s\S]*?)<\/tptz:Preset>/g;
    let m;
    while ((m = re.exec(xml))) out.push({ token: m[1], name: ((/<tt:Name>([^<]*)</.exec(m[2]) || [])[1]) || m[1] });
    return out;
  }

  async gotoPreset(token) {
    const t = await this.token();
    await this.request(`<tptz:GotoPreset><tptz:ProfileToken>${esc(t)}</tptz:ProfileToken><tptz:PresetToken>${esc(token)}</tptz:PresetToken></tptz:GotoPreset>`);
  }

  async setPreset(name) {
    const t = await this.token();
    await this.request(`<tptz:SetPreset><tptz:ProfileToken>${esc(t)}</tptz:ProfileToken><tptz:PresetName>${esc(name)}</tptz:PresetName></tptz:SetPreset>`);
  }

  async removePreset(token) {
    const t = await this.token();
    await this.request(`<tptz:RemovePreset><tptz:ProfileToken>${esc(t)}</tptz:ProfileToken><tptz:PresetToken>${esc(token)}</tptz:PresetToken></tptz:RemovePreset>`);
  }
}

module.exports = { Onvif };
