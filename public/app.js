'use strict';
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtDur = (s) => `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`;
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';
const dayStart = (ds) => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const dayEnd = (ds) => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d + 1).getTime(); };
const ROW = ['duminică', 'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă'];

// ---------------------------------------------------------------- Tab-uri
let activeTab = 'live';
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'live') { startLive(); recVideo.pause(); } else { stopLive(); loadDays(); try { if (talkPc) stopTalk(); } catch { /* inca neinitializat */ } }
  history.replaceState(null, '', '#' + name);
}

// ---------------------------------------------------------------- Status
async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    if (r.status === 401) { location.href = '/login.html'; return; } // sesiune expirata
    const s = await r.json();
    const running = s.workers.every((w) => w.running && w.uptimeSec > 5);
    $('recDot').classList.toggle('on', running);
    const w = s.workers[0];
    $('statusText').textContent = running
      ? `Înregistrează · ${s.disk.usedGB} GB arhivă · ${s.disk.freeGB} GB liber`
      : `Cameră indisponibilă – reîncerc… ${w && w.lastMessage ? '(' + w.lastMessage.slice(0, 80) + ')' : ''}`;
    $('footer').textContent = `Cameră ${s.camera} · segmente de ${s.segmentSeconds / 60} min · păstrare ${s.retentionDays} zile`;
  } catch {
    $('recDot').classList.remove('on');
    $('statusText').textContent = 'Serverul NVR nu răspunde';
  }
}
setInterval(refreshStatus, 5000);
refreshStatus();

// ---------------------------------------------------------------- LIVE
const liveVideo = $('liveVideo');
let hls = null, liveRetry = null;
function startLive() {
  stopLive();
  $('liveOverlay').textContent = 'Se încarcă fluxul live…';
  $('liveOverlay').classList.remove('hidden');
  const src = '/live/live.m3u8?t=' + Date.now();
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, lowLatencyMode: false, manifestLoadingMaxRetry: 100, manifestLoadingRetryDelay: 2000, levelLoadingMaxRetry: 100 });
    hls.loadSource(src);
    hls.attachMedia(liveVideo);
    hls.on(Hls.Events.MANIFEST_PARSED, () => liveVideo.play().catch(() => { }));
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        $('liveOverlay').textContent = 'Flux live indisponibil – reîncerc…';
        $('liveOverlay').classList.remove('hidden');
        clearTimeout(liveRetry);
        liveRetry = setTimeout(() => activeTab === 'live' && startLive(), 4000);
      }
    });
  } else if (liveVideo.canPlayType('application/vnd.apple.mpegurl')) {
    liveVideo.src = src;
    liveVideo.play().catch(() => { });
  } else {
    $('liveOverlay').textContent = 'Browserul nu suportă HLS.';
  }
}
function stopLive() {
  clearTimeout(liveRetry);
  if (hls) { hls.destroy(); hls = null; }
  liveVideo.removeAttribute('src'); liveVideo.load();
}
liveVideo.addEventListener('playing', () => $('liveOverlay').classList.add('hidden'));
// Daca ramane in urma (tab inactiv), revenim la marginea live.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeTab === 'live' && hls && hls.liveSyncPosition) liveVideo.currentTime = hls.liveSyncPosition;
});
setInterval(() => { $('liveClock').textContent = new Date().toLocaleString('ro-RO'); }, 1000);
$('liveMute').onclick = () => { liveVideo.muted = !liveVideo.muted; $('liveMute').textContent = liveVideo.muted ? '🔇 Sunet' : '🔊 Sunet'; };
$('liveFull').onclick = () => liveVideo.parentElement.requestFullscreen?.();
$('liveReload').onclick = startLive;
$('liveSnap').onclick = () => snapshot(liveVideo, Date.now());
$('recSnap').onclick = () => snapshot(recVideo, currentTs());

function snapshot(video, ts) {
  if (!video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const a = document.createElement('a');
  const d = new Date(ts);
  a.download = `captura_${dayStr(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.jpg`;
  a.href = c.toDataURL('image/jpeg', 0.92);
  a.click();
}

// ---------------------------------------------------------------- ARHIVA
const recVideo = $('recVideo');
let days = [], curDay = null, segs = [], curSeg = null;
let viewStart = 0, viewEnd = 0;
const ZOOMS = [24 * 60, 12 * 60, 6 * 60, 3 * 60, 60, 30, 10]; // minute
let zoomIdx = 0;

async function loadDays() {
  days = await (await fetch('/api/days')).json();
  const today = dayStr(new Date());
  if (!days.some((d) => d.day === today)) days.unshift({ day: today, count: 0 });
  const sel = $('daySelect');
  sel.innerHTML = days.map((d) => {
    const dt = new Date(dayStart(d.day));
    return `<option value="${d.day}">${d.day} (${ROW[dt.getDay()]}) – ${d.count} seg.</option>`;
  }).join('');
  if (!curDay || !days.some((d) => d.day === curDay)) curDay = today;
  sel.value = curDay;
  await loadDay(curDay, false);
}

async function loadDay(day, resetView = true) {
  const changed = day !== curDay;
  curDay = day;
  $('daySelect').value = day;
  segs = await (await fetch('/api/recordings?date=' + day)).json();
  if (changed || resetView || !viewEnd) { zoomIdx = 0; setView(dayStart(day), dayEnd(day)); }
  renderTimeline();
  renderTable();
  const i = days.findIndex((d) => d.day === day);
  $('dayPrev').disabled = i < 0 || i >= days.length - 1;
  $('dayNext').disabled = i <= 0;
}

$('daySelect').onchange = (e) => { recVideo.pause(); curSeg = null; loadDay(e.target.value); };
$('dayPrev').onclick = () => { const i = days.findIndex((d) => d.day === curDay); if (days[i + 1]) { curSeg = null; loadDay(days[i + 1].day); } };
$('dayNext').onclick = () => { const i = days.findIndex((d) => d.day === curDay); if (i > 0) { curSeg = null; loadDay(days[i - 1].day); } };
$('speed').onchange = (e) => { recVideo.playbackRate = Number(e.target.value); };
$('jumpBtn').onclick = () => {
  const v = $('jumpTime').value; if (!v) return;
  const [h, m, s] = v.split(':').map(Number);
  const [y, mo, d] = curDay.split('-').map(Number);
  playAt(new Date(y, mo - 1, d, h, m || 0, s || 0).getTime());
};

// Reimprospatare automata pentru ziua curenta
setInterval(() => { if (activeTab === 'archive' && curDay === dayStr(new Date())) loadDay(curDay, false); }, 30000);

function setView(a, b) {
  const ds = dayStart(curDay), de = dayEnd(curDay);
  const len = b - a;
  if (a < ds) { a = ds; b = ds + len; }
  if (b > de) { b = de; a = de - len; }
  viewStart = Math.max(ds, a); viewEnd = Math.min(de, b);
  const mins = ZOOMS[zoomIdx];
  $('zoomLabel').textContent = mins >= 60 ? `${mins / 60} h` : `${mins} min`;
}
function zoom(dir, centerTs) {
  const ni = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx + dir));
  if (ni === zoomIdx) return;
  zoomIdx = ni;
  const c = centerTs ?? (curSeg ? currentTs() : (viewStart + viewEnd) / 2);
  const len = ZOOMS[zoomIdx] * 60000;
  setView(c - len / 2, c + len / 2);
  renderTimeline();
}
$('zoomIn').onclick = () => zoom(1);
$('zoomOut').onclick = () => zoom(-1);

const tl = $('timeline');
const xToTs = (x) => viewStart + (x / tl.clientWidth) * (viewEnd - viewStart);
const tsToPct = (t) => ((t - viewStart) / (viewEnd - viewStart)) * 100;

function renderTimeline() {
  // gradatii
  const span = viewEnd - viewStart;
  const steps = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3];
  const step = steps.find((s) => span / s <= 14) || 3 * 3600e3;
  let html = '';
  // aliniere la ora locala
  const off = new Date(viewStart).getTimezoneOffset() * 60000;
  for (let t = Math.ceil((viewStart - off) / step) * step + off; t <= viewEnd; t += step) {
    const d = new Date(t);
    html += `<div class="tick" style="left:${tsToPct(t)}%"><span>${pad(d.getHours())}:${pad(d.getMinutes())}</span></div>`;
  }
  $('ticks').innerHTML = html;
  // segmente
  $('segments').innerHTML = segs.filter((s) => s.end > viewStart && s.start < viewEnd).map((s) => {
    const l = Math.max(0, tsToPct(s.start)), r = Math.min(100, tsToPct(s.end));
    const cls = s.recording ? 'seg rec' : (curSeg && curSeg.file === s.file ? 'seg cur' : 'seg');
    return `<div class="${cls}" style="left:${l}%;width:${Math.max(r - l, 0.05)}%"></div>`;
  }).join('');
  updatePlayhead();
}

function renderTable() {
  $('segCount').textContent = segs.length;
  $('segTable').innerHTML = segs.map((s, i) => `
    <tr data-i="${i}" class="${curSeg && curSeg.file === s.file ? 'cur' : ''}">
      <td>${fmtTime(s.start)}${s.recording ? ' <span style="color:var(--rec)">● se înregistrează</span>' : ''}</td>
      <td>${fmtDur(s.duration)}</td><td>${fmtSize(s.size)}</td>
      <td><a href="#" data-play="${i}">Redă</a> · <a href="${s.url}?download">Descarcă</a></td>
    </tr>`).join('');
}
$('segTable').addEventListener('click', (e) => {
  const i = e.target.dataset.play;
  if (i != null) { e.preventDefault(); playSeg(segs[i], 0); }
});

function currentTs() { return curSeg ? curSeg.start + recVideo.currentTime * 1000 : null; }

function updatePlayhead() {
  const ts = currentTs();
  const ph = $('playhead');
  if (ts == null || ts < viewStart || ts > viewEnd) { ph.style.display = 'none'; }
  else { ph.style.display = 'block'; ph.style.left = tsToPct(ts) + '%'; }
  $('recClock').textContent = ts ? new Date(ts).toLocaleString('ro-RO') : '';
}

function playSeg(seg, offsetSec, autoplay = true) {
  if (!seg) return;
  $('recOverlay').classList.add('hidden');
  const same = curSeg && curSeg.file === seg.file;
  curSeg = seg;
  $('downloadSeg').href = seg.url + '?download';
  if (same) {
    recVideo.currentTime = offsetSec;
    if (autoplay) recVideo.play().catch(() => { });
  } else {
    recVideo.src = seg.url;
    recVideo.addEventListener('loadedmetadata', () => {
      recVideo.currentTime = Math.min(offsetSec, Math.max(0, recVideo.duration - 0.5));
      recVideo.playbackRate = Number($('speed').value);
      if (autoplay) recVideo.play().catch(() => { });
    }, { once: true });
  }
  renderTimeline();
  renderTable();
}

function playAt(ts) {
  const playable = segs;
  let seg = playable.find((s) => ts >= s.start && ts < s.end);
  if (!seg) {
    const rec = segs.find((s) => s.recording && ts >= s.start);
    if (rec) seg = rec;
    else seg = playable.find((s) => s.start >= ts); // urmatorul disponibil
    ts = seg ? seg.start : ts;
  }
  if (!seg) {
    $('recOverlay').textContent = 'Nu există înregistrări după acest moment.';
    $('recOverlay').classList.remove('hidden');
    return;
  }
  playSeg(seg, (ts - seg.start) / 1000);
}

recVideo.addEventListener('timeupdate', updatePlayhead);
recVideo.addEventListener('ended', async () => {
  if (!curSeg) return;
  if (curSeg.recording) {
    // Segmentul inca se scrie: reincarcam lista si continuam de unde am ramas.
    const ts = currentTs();
    await loadDay(curDay, false);
    const fresh = segs.find((s) => s.file === curSeg.file);
    const next = segs[segs.findIndex((s) => s.file === curSeg.file) + 1];
    if (fresh && (fresh.end - ts > 3000 || !fresh.recording)) { curSeg = null; playSeg(fresh, (ts - fresh.start) / 1000); }
    else if (next) playSeg(next, 0);
    else setTimeout(() => recVideo.dispatchEvent(new Event('ended')), 3000);
    return;
  }
  const i = segs.findIndex((s) => s.file === curSeg.file);
  const next = segs[i + 1];
  if (next) playSeg(next, 0);
});
recVideo.addEventListener('error', () => {
  $('recOverlay').textContent = 'Segmentul nu poate fi redat (posibil incomplet).';
  $('recOverlay').classList.remove('hidden');
});
$('prevSeg').onclick = () => { const i = segs.findIndex((s) => curSeg && s.file === curSeg.file); if (i > 0) playSeg(segs[i - 1], 0); };
$('nextSeg').onclick = () => { const i = segs.findIndex((s) => curSeg && s.file === curSeg.file); if (i >= 0 && segs[i + 1]) playSeg(segs[i + 1], 0); };

// Interactiune linie de timp: click = salt, tragere = deplasare (cand e marita), rotita = zoom
let drag = null;
tl.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, vs: viewStart, ve: viewEnd, moved: false }; tl.setPointerCapture(e.pointerId); });
tl.addEventListener('pointermove', (e) => {
  const rect = tl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const tip = $('hoverTip');
  tip.style.display = 'block'; tip.style.left = x + 'px'; tip.textContent = fmtTime(xToTs(x));
  if (drag) {
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (drag.moved && zoomIdx > 0) {
      const dt = (dx / tl.clientWidth) * (drag.ve - drag.vs);
      setView(drag.vs - dt, drag.ve - dt);
      renderTimeline();
    }
  }
});
tl.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) playAt(xToTs(e.clientX - tl.getBoundingClientRect().left));
  drag = null;
});
tl.addEventListener('pointerleave', () => { $('hoverTip').style.display = 'none'; });
tl.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1 : -1, xToTs(e.clientX - tl.getBoundingClientRect().left));
}, { passive: false });
window.addEventListener('resize', renderTimeline);

// ---------------------------------------------------------------- PTZ (miscare camera)
const ptzMsg = (t, err) => { $('ptzMsg').textContent = t; $('ptzMsg').classList.toggle('err', !!err); };
async function ptzCall(action, body, method = 'POST') {
  const r = await fetch('/api/ptz/' + action, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
let ptzBusy = false;
async function ptzStep(dx, dy) {
  if (ptzBusy) return; // nu acumulam comenzi cat timp camera inca executa
  ptzBusy = true;
  const s = Number($('ptzStep').value);
  try { await ptzCall('move', { x: dx * s, y: dy * s }); ptzMsg('Click = pas · ține apăsat = mișcare continuă · săgețile tastaturii'); }
  catch (e) { ptzMsg('Mișcare eșuată: ' + e.message, true); }
  finally { ptzBusy = false; }
}
// click = un pas; tinut apasat = pasi repetati
let holdTimer = null;
function startHold(btn) {
  const [dx, dy] = btn.dataset.dir.split(',').map(Number);
  btn.classList.add('held');
  ptzStep(dx, dy);
  clearInterval(holdTimer);
  holdTimer = setInterval(() => ptzStep(dx, dy), 450);
}
function endHold() {
  clearInterval(holdTimer); holdTimer = null;
  document.querySelectorAll('#ptzPad button.held').forEach((b) => b.classList.remove('held'));
}
document.querySelectorAll('#ptzPad button').forEach((b) => {
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); startHold(b); });
  b.addEventListener('pointerup', endHold);
  b.addEventListener('pointercancel', endHold);
  b.addEventListener('lostpointercapture', endHold);
});
const KEYS = { ArrowUp: '0,1', ArrowDown: '0,-1', ArrowLeft: '-1,0', ArrowRight: '1,0' };
document.addEventListener('keydown', (e) => {
  if (activeTab !== 'live' || !KEYS[e.key] || e.repeat || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  e.preventDefault();
  startHold(document.querySelector(`#ptzPad button[data-dir="${KEYS[e.key]}"]`));
});
document.addEventListener('keyup', (e) => { if (KEYS[e.key]) endHold(); });

async function loadPresets(selectToken) {
  try {
    const list = await ptzCall('presets', null, 'GET');
    $('presetSelect').innerHTML = '<option value="">—</option>'
      + list.map((p) => `<option value="${p.token}">${p.name.replace(/</g, '&lt;')}</option>`).join('');
    if (selectToken) $('presetSelect').value = selectToken;
  } catch (e) { ptzMsg('PTZ indisponibil: ' + e.message, true); }
}
$('presetGo').onclick = async () => {
  const t = $('presetSelect').value; if (!t) return;
  try { await ptzCall('preset/goto', { token: t }); ptzMsg('Mă deplasez la poziția salvată…'); } catch (e) { ptzMsg(e.message, true); }
};
$('presetSelect').onchange = () => $('presetGo').click();
$('presetSave').onclick = async () => {
  const name = prompt('Nume pentru poziția curentă (ex: Ușă, Pat, Fereastră):');
  if (!name) return;
  try { await ptzCall('preset/set', { name }); ptzMsg(`Poziția „${name}” a fost salvată.`); loadPresets(); } catch (e) { ptzMsg(e.message, true); }
};
$('presetDel').onclick = async () => {
  const sel = $('presetSelect'); const t = sel.value; if (!t) return;
  if (!confirm(`Ștergi poziția „${sel.options[sel.selectedIndex].text}”?`)) return;
  try { await ptzCall('preset/remove', { token: t }); loadPresets(); } catch (e) { ptzMsg(e.message, true); }
};
loadPresets();

// ---------------------------------------------------------------- Vorbire prin camera (WebRTC -> go2rtc -> difuzor Tapo)
const talkBtn = $('talkBtn');
let talkPc = null, talkStream = null, talkState = 'idle', talkReason = '', liveWasMuted = true;

async function talkStatus() {
  try {
    const s = await (await fetch('/api/talk/status')).json();
    talkReason = s.available ? '' : s.reason;
    if (!window.isSecureContext) talkReason = 'Microfonul funcționează doar pe http://localhost sau pe https:// (browserul blochează microfonul pe http din rețea).';
    talkBtn.classList.toggle('unavailable', !!talkReason);
    talkBtn.title = talkReason || 'Click pentru a vorbi prin difuzorul camerei';
  } catch { }
}
function setTalk(state, msg) {
  talkState = state;
  talkBtn.classList.toggle('active', state === 'on');
  talkBtn.textContent = state === 'on' ? '🔴 Vorbești… (click = stop)' : state === 'connecting' ? '⏳ Se conectează…' : '🎙 Vorbește';
  if (msg) ptzMsg(msg, state === 'idle' && /eș|nu|lips|bloc/i.test(msg));
}
async function startTalk() {
  if (talkReason) return ptzMsg(talkReason, true);
  setTalk('connecting', 'Se deschide microfonul…');
  try {
    talkStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    talkPc = new RTCPeerConnection({ iceServers: [] });
    talkPc.addTransceiver(talkStream.getAudioTracks()[0], { direction: 'sendonly' });
    talkPc.onconnectionstatechange = () => {
      const st = talkPc && talkPc.connectionState;
      if (st === 'connected') {
        setTalk('on', 'Conectat – vorbește acum. Sunetul live e oprit cât vorbești (evită ecoul).');
      } else if (st === 'failed' || st === 'disconnected') {
        stopTalk('Conexiunea audio cu camera s-a întrerupt.');
      }
    };
    await talkPc.setLocalDescription(await talkPc.createOffer());
    // asteptam colectarea candidatilor ICE (fara trickle)
    await new Promise((r) => {
      if (talkPc.iceGatheringState === 'complete') return r();
      const t = setTimeout(r, 2000);
      talkPc.addEventListener('icegatheringstatechange', () => { if (talkPc.iceGatheringState === 'complete') { clearTimeout(t); r(); } });
    });
    const resp = await fetch('/api/talk/offer', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: talkPc.localDescription.sdp });
    const text = await resp.text();
    if (!resp.ok) throw new Error((() => { try { return JSON.parse(text).error; } catch { return text; } })());
    await talkPc.setRemoteDescription({ type: 'answer', sdp: text });
    liveWasMuted = liveVideo.muted;
    liveVideo.muted = true;
  } catch (e) {
    stopTalk(e.name === 'NotAllowedError' ? 'Accesul la microfon a fost refuzat în browser.' : 'Vorbirea a eșuat: ' + e.message);
  }
}
function stopTalk(msg) {
  if (talkPc) { try { talkPc.close(); } catch { } talkPc = null; }
  if (talkStream) { talkStream.getTracks().forEach((t) => t.stop()); talkStream = null; }
  if (talkState === 'on') liveVideo.muted = liveWasMuted;
  setTalk('idle', msg || 'Vorbire oprită.');
}
talkBtn.onclick = () => (talkState === 'idle' ? startTalk() : stopTalk());
window.addEventListener('beforeunload', () => stopTalk());
talkStatus();

// ---------------------------------------------------------------- Start
showTab(location.hash === '#archive' ? 'archive' : 'live');
