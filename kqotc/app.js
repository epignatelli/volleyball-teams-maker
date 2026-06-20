// ─── Debug ─────────────────────────────────────────────────────────────────────
const DEBUG = true;

// ─── State ─────────────────────────────────────────────────────────────────────
let players     = [];   // { id, name, cumScore }
let round       = 0;
let numTopTeams = 0;
let topTeams    = [];   // { id, playerIds[], roundScore }
let workUp      = [];   // { playerId, roundScore }
let pendingNext = null;

let _tournamentId   = null;
let _tournamentName = '';
let _currentUser    = null;
let _isAdmin        = false;

// ─── Firebase / Auth ───────────────────────────────────────────────────────────
function getDb()   { return firebase.firestore(); }
function getAuth() { return firebase.auth(); }

async function _checkAdmin(user) {
  if (!user) return false;
  try {
    const doc = await getDb().collection('admins').doc(user.email).get();
    return doc.exists;
  } catch(e) { return false; }
}

async function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try { await getAuth().signInWithPopup(provider); }
  catch(e) { if (e.code !== 'auth/popup-closed-by-user') console.error(e); }
}

async function signOut() { await getAuth().signOut(); }

function handleAuthClick() {
  if (_currentUser) signOut();
  else signIn();
}

function _updateAuthUI() {
  const btn    = document.getElementById('auth-btn');
  const newBtn = document.getElementById('home-new-event-btn');
  if (!btn) return;
  if (_currentUser) {
    const label = _currentUser.displayName?.split(' ')[0] || _currentUser.email;
    btn.textContent = `${label} · Sign out`;
    btn.classList.add('auth-btn--signed-in');
  } else {
    btn.textContent = 'Sign in';
    btn.classList.remove('auth-btn--signed-in');
  }
  if (newBtn) newBtn.style.display = _isAdmin ? '' : 'none';
}

// ─── Firebase / Tournaments ────────────────────────────────────────────────────
function _tourRef()    { return getDb().collection('tournaments').doc(_tournamentId); }
function _playersRef() { return _tourRef().collection('players'); }

async function _loadPlayers(id) {
  const snap = await getDb().collection('tournaments').doc(id).collection('players').get();
  return snap.docs.map(d => ({ id: d.id, name: d.data().name, cumScore: d.data().cumScore || 0 }));
}

async function _savePlayerScores() {
  if (!_tournamentId || !players.length) return;
  const batch = getDb().batch();
  players.forEach(p => batch.update(_playersRef().doc(p.id), { cumScore: p.cumScore }));
  await batch.commit().catch(e => console.error('Score save failed:', e));
}

function _localState() {
  return { round, numTopTeams, topTeams, workUp, pendingNext };
}

async function saveTournament(extra = {}) {
  if (!_tournamentId) return;
  try { await _tourRef().update({ ..._localState(), ...extra }); }
  catch(e) { console.error('Save failed:', e); }
}

async function _loadDoc(id) {
  const doc = await getDb().collection('tournaments').doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

function _applyData(data) {
  _tournamentName = data.name || '';
  round       = data.round       || 0;
  numTopTeams = data.numTopTeams || 0;
  topTeams    = data.topTeams    || [];
  workUp      = data.workUp      || [];
  pendingNext = data.pendingNext || null;
}

function _navigateToScreen(data) {
  const screen = data.screen || 'checkin';
  if (screen === 'leaderboard') {
    renderLeaderboard(); showScreen('leaderboard');
  } else if (screen === 'transition' && data.transitionResult) {
    renderTransition(data.transitionResult);
    document.getElementById('transition-title').textContent = `Round ${round} done`;
    document.getElementById('next-round-num').textContent   = round + 1;
    showScreen('transition');
  } else if (screen === 'round') {
    renderRound(); showScreen('round');
  } else {
    renderCheckin(); showScreen('checkin');
  }
}

async function openTournament(id) {
  const [data, loadedPlayers] = await Promise.all([_loadDoc(id), _loadPlayers(id)]);
  if (!data) return;
  _tournamentId = id;
  localStorage.setItem('kqotc-last-tournament', id);
  _applyData(data);
  players = loadedPlayers;
  _navigateToScreen(data);
}

// ─── Home screen ───────────────────────────────────────────────────────────────
function goHome() {
  showScreen('home');
  renderHome();
}

async function renderHome() {
  const container = document.getElementById('home-content');
  container.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    const snap  = await getDb().collection('tournaments').orderBy('createdAt', 'desc').limit(50).get();
    const tours = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!tours.length) {
      container.innerHTML = `<div class="home-empty">No events yet.<br>Tap <strong>+ New event</strong> to get started.</div>`;
      return;
    }

    const groups = [
      { label: 'Active',   color: 'var(--green)', items: tours.filter(t => t.status === 'active') },
      { label: 'Upcoming', color: 'var(--amber)', items: tours.filter(t => t.status === 'upcoming') },
      { label: 'Past',     color: 'var(--muted)', items: tours.filter(t => t.status === 'completed') },
    ].filter(g => g.items.length);

    container.innerHTML = groups.map(g => `
      <div class="tour-group">
        <div class="tour-group-label" style="color:${g.color}">${g.label}</div>
        ${g.items.map(_renderTourItem).join('')}
      </div>`).join('');

  } catch(e) {
    container.innerHTML = `<div class="home-empty">Couldn't load events. Check your connection.</div>`;
    console.error(e);
  }
}

function _renderTourItem(t) {
  const date  = t.date ? t.date.toDate().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const count = t.playerCount || 0;
  const badge = t.status === 'active'
    ? `<span class="tour-badge active">Active</span>`
    : t.status === 'upcoming'
      ? `<span class="tour-badge upcoming">Upcoming</span>`
      : `<span class="tour-badge completed">Done</span>`;
  const meta  = [date, count ? `${count} players` : ''].filter(Boolean).join(' · ');
  return `
    <div class="tour-item" onclick="openTournament('${t.id}')">
      <div class="tour-main">
        <span class="tour-name">${esc(t.name)}</span>
        ${meta ? `<span class="tour-meta">${meta}</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${badge}
        ${_isAdmin ? `<button class="tour-delete-btn" onclick="event.stopPropagation();deleteTournament('${t.id}','${esc(t.name)}')" title="Delete event">✕</button>` : ''}
        <span class="tour-arrow">›</span>
      </div>
    </div>`;
}

async function deleteTournament(id, name) {
  if (!_isAdmin) return;
  if (!confirm(`Delete "${name}"?\n\nThis will permanently remove the event and all its data.`)) return;
  try {
    const snap  = await getDb().collection('tournaments').doc(id).collection('players').get();
    const batch = getDb().batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(getDb().collection('tournaments').doc(id));
    await batch.commit();
    await renderHome();
  } catch(e) {
    console.error('Delete failed:', e);
    alert('Could not delete the event. Please try again.');
  }
}

function showCreateForm() {
  if (!_isAdmin) return;
  const now       = new Date();
  const monthYear = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  document.getElementById('create-name').value = `KQOTC ${monthYear}`;
  document.getElementById('create-date').value = now.toISOString().slice(0, 10);
  document.getElementById('create-overlay').classList.add('open');
}

function hideCreateForm() {
  document.getElementById('create-overlay').classList.remove('open');
}

async function submitCreateTournament() {
  const nameEl = document.getElementById('create-name');
  const dateEl = document.getElementById('create-date');
  const name   = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }

  const docData = {
    name, status: 'upcoming', screen: 'checkin',
    round: 0, numTopTeams: 0, playerCount: 0,
    topTeams: [], workUp: [], pendingNext: null, transitionResult: null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  if (dateEl.value) {
    docData.date = firebase.firestore.Timestamp.fromDate(new Date(dateEl.value + 'T12:00:00'));
  }

  const ref       = await getDb().collection('tournaments').add(docData);
  _tournamentId   = ref.id;
  _tournamentName = name;
  localStorage.setItem('kqotc-last-tournament', _tournamentId);

  players = []; round = 0; numTopTeams = 0; topTeams = []; workUp = []; pendingNext = null;

  hideCreateForm();
  renderCheckin();
  showScreen('checkin');
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function getPlayer(id) { return players.find(p => p.id === id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// ─── Check-in screen ───────────────────────────────────────────────────────────
async function addPlayer() {
  const input = document.getElementById('player-input');
  const name  = input.value.trim();
  if (!name) return;
  if (players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    input.select(); return;
  }
  const ref = _playersRef().doc();
  const p   = { id: ref.id, name, cumScore: 0 };
  await ref.set({ name, cumScore: 0, joinedAt: firebase.firestore.FieldValue.serverTimestamp() });
  await _tourRef().update({ playerCount: firebase.firestore.FieldValue.increment(1) });
  players.push(p);
  if (_qrActive) _seenKeys.add(p.id);
  input.value = '';
  input.focus();
  renderCheckin();
}

document.getElementById('player-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addPlayer();
});

async function removePlayer(id) {
  await _playersRef().doc(id).delete();
  await _tourRef().update({ playerCount: firebase.firestore.FieldValue.increment(-1) });
  players = players.filter(p => p.id !== id);
  renderCheckin();
}

function renderCheckin() {
  const n        = players.length;
  const countEl  = document.getElementById('player-count');
  const hintEl   = document.getElementById('court-hint');
  const startBtn = document.getElementById('start-btn');
  const listEl   = document.getElementById('player-list');
  const emptyEl  = document.getElementById('player-empty');
  const nameEl   = document.getElementById('checkin-tournament-name');

  if (nameEl) nameEl.textContent = _tournamentName;
  countEl.textContent = n || '';

  const nTop     = calcNumTopTeams(n);
  const topCount = nTop * 4;
  if (n >= 8) {
    hintEl.textContent = `${nTop} king court team${nTop > 1 ? 's' : ''} · ${Math.max(0, n - topCount)} on work-up`;
  } else {
    hintEl.textContent = 'Need at least 8 players';
  }

  startBtn.disabled = n < 8;

  if (!n) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  listEl.innerHTML = players.map((p, i) => `
    <div class="player-row">
      <span class="player-num">${i + 1}</span>
      <span class="player-name">${esc(p.name)}</span>
      <button class="remove-btn" onclick="removePlayer('${p.id}')">×</button>
    </div>`).join('');
}

// ─── Start event ───────────────────────────────────────────────────────────────
function startEvent() {
  numTopTeams    = calcNumTopTeams(players.length);
  const topCount = numTopTeams * 4;

  players.forEach(p => p.cumScore = 0);

  const topPlayers  = players.slice(0, topCount);
  const workPlayers = players.slice(topCount);

  topTeams = [];
  for (let i = 0; i < numTopTeams; i++) {
    topTeams.push({
      id: i + 1,
      playerIds: topPlayers.slice(i * 4, i * 4 + 4).map(p => p.id),
      roundScore: 0,
    });
  }
  workUp = workPlayers.map(p => ({ playerId: p.id, roundScore: 0 }));
  round  = 1;

  showScreen('round');
  renderRound();
  saveTournament({ status: 'active', screen: 'round' });
}

// ─── Round screen ──────────────────────────────────────────────────────────────
function renderRound() {
  document.getElementById('round-title').textContent    = `Round ${round}`;
  document.getElementById('round-subtitle').textContent =
    `${numTopTeams} king court team${numTopTeams > 1 ? 's' : ''} · ${workUp.length} on work-up`;

  const container = document.getElementById('round-content');

  const teamCards = topTeams.map(t => {
    const names = t.playerIds.map(id => esc(getPlayer(id)?.name ?? '—')).join(', ');
    const cum   = t.playerIds.reduce((s, id) => s + (getPlayer(id)?.cumScore ?? 0), 0) / t.playerIds.length;
    return `
      <div class="team-card" id="team-${t.id}">
        <div class="team-names">
          ${names}
          <span class="cum-score">total ${Math.round(cum)} pts</span>
        </div>
        <input class="score-input" type="number" min="0" inputmode="numeric"
          value="${t.roundScore}"
          onfocus="this.select()"
          oninput="setTeamScore(${t.id}, this.value)"
          onblur="blurTeamScore(${t.id}, this)" />
      </div>`;
  }).join('');

  const workRows = workUp.length ? workUp.map(wu => {
    const p = getPlayer(wu.playerId);
    return `
      <div class="workup-row">
        <span class="player-name">
          ${esc(p?.name ?? '—')}
          <span class="cum-score">${p?.cumScore ?? 0} pts</span>
        </span>
        <input class="score-input" type="number" min="0" inputmode="numeric"
          value="${wu.roundScore}"
          onfocus="this.select()"
          oninput="setWorkScore('${wu.playerId}', this.value)"
          onblur="blurWorkScore('${wu.playerId}', this)" />
      </div>`;
  }).join('') : '<div class="empty-note">No players on work-up this round</div>';

  container.innerHTML = `
    <div class="court-section">
      <div class="court-label king">♛ King Court</div>
      ${teamCards}
    </div>
    <div class="court-section">
      <div class="court-label workup">↑ Work-up Court</div>
      ${workRows}
    </div>`;
}

let _toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('score-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'score-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
}

function parseScore(val) {
  const n = parseInt(val);
  return isNaN(n) ? null : Math.max(0, n);
}

function setTeamScore(id, val) {
  const n = parseScore(val);
  const t = topTeams.find(t => t.id === id);
  if (n !== null && t) t.roundScore = n;
}

function blurTeamScore(id, el) {
  const t = topTeams.find(t => t.id === id);
  if (parseScore(el.value) === null) {
    showToast('Invalid score — numbers only');
    el.value = t ? t.roundScore : 0;
  }
}

function setWorkScore(playerId, val) {
  const n  = parseScore(val);
  const wu = workUp.find(w => w.playerId === playerId);
  if (n !== null && wu) wu.roundScore = n;
}

function blurWorkScore(playerId, el) {
  const wu = workUp.find(w => w.playerId === playerId);
  if (parseScore(el.value) === null) el.value = wu ? wu.roundScore : 0;
}

// ─── End round ─────────────────────────────────────────────────────────────────
function endRound() {
  players = computeScores(players, topTeams, workUp);
  _savePlayerScores();

  const result = computeTransition(topTeams, workUp, numTopTeams, round);
  result.newTeams.forEach((t, i) => { t.id = Date.now() + i; });

  pendingNext = { topTeams: result.nextTopTeams, workUp: result.nextWorkUp };

  renderTransition(result);
  document.getElementById('transition-title').textContent = `Round ${round} done`;
  document.getElementById('next-round-num').textContent   = round + 1;
  showScreen('transition');
  saveTournament({ screen: 'transition', transitionResult: result });
}

// ─── Transition screen ─────────────────────────────────────────────────────────
function renderTransition({ moversUp, movingDownTeams, stayTeams, newTeams, stayWorkUp }) {
  const name     = id => esc(getPlayer(id)?.name ?? '—');
  const total    = id => getPlayer(id)?.cumScore ?? 0;
  const avgTotal = ids => Math.round(ids.reduce((s, id) => s + total(id), 0) / ids.length);

  const downList = movingDownTeams.map(t =>
    `<div class="move-row down"><span class="move-name">${t.playerIds.map(name).join(', ')}</span><span class="move-score">${t.roundScore} pts · <b>${avgTotal(t.playerIds)} total</b></span></div>`
  ).join('') || '<div class="empty-note">—</div>';

  const nextKingCards = [
    ...stayTeams.map(t => ({ ...t, isNew: false, roundLabel: `${t.roundScore} pts this round`, totalLabel: `${avgTotal(t.playerIds)} total` })),
    ...newTeams.map((t, i) => {
      const slice = moversUp.slice(i * 4, i * 4 + 4);
      return { ...t, isNew: true, roundLabel: slice.map(wu => wu.roundScore).join(' / ') + ' pts', totalLabel: `${avgTotal(t.playerIds)} total` };
    }),
  ].map(t => `
    <div class="team-card ${t.isNew ? 'team-new' : 'team-stay'}">
      <div class="team-names">
        <span class="team-badge">${t.isNew ? '★ New' : '↩ Stay'}</span>
        ${t.playerIds.map(name).join(', ')}
        <span class="cum-score">${t.roundLabel} · <b>${t.totalLabel}</b></span>
      </div>
    </div>`).join('');

  const nextWorkRows = [
    ...movingDownTeams.flatMap(t => t.playerIds.map(pid => ({ pid, score: t.roundScore }))),
    ...stayWorkUp.map(wu => ({ pid: wu.playerId, score: wu.roundScore })),
  ].map(({ pid, score }) =>
    `<div class="workup-row"><span class="player-name">${name(pid)}<span class="cum-score">${score} pts · <b>${total(pid)} total</b></span></span></div>`
  ).join('') || '<div class="empty-note">—</div>';

  document.getElementById('transition-content').innerHTML = `
    <div class="court-section">
      <div class="court-label down">↓ Moving down to Work-up (${movingDownTeams.length} team${movingDownTeams.length !== 1 ? 's' : ''})</div>
      ${downList}
    </div>
    <div class="court-section">
      <div class="court-label king">♛ King Court — Round ${round + 1}</div>
      ${nextKingCards}
    </div>
    <div class="court-section">
      <div class="court-label workup">↑ Work-up — Round ${round + 1}</div>
      ${nextWorkRows}
    </div>`;
}

function startNextRound() {
  if (!pendingNext) return;
  topTeams    = pendingNext.topTeams;
  workUp      = pendingNext.workUp;
  pendingNext = null;
  round++;
  showScreen('round');
  renderRound();
  saveTournament({ screen: 'round', transitionResult: null });
}

// ─── End event / leaderboard ───────────────────────────────────────────────────
function endEvent() {
  renderLeaderboard();
  showScreen('leaderboard');
  saveTournament({ status: 'completed', screen: 'leaderboard' });
}

function renderLeaderboard() {
  const sorted = [...players].sort((a, b) => b.cumScore - a.cumScore);
  const rows   = sorted.map((p, i) => {
    const medal = i === 0 ? '♛' : i === 1 ? '✦' : i === 2 ? '◆' : `${i + 1}.`;
    return `
      <div class="lb-row ${i === 0 ? 'lb-winner' : ''}">
        <span class="lb-rank">${medal}</span>
        <span class="lb-name">${esc(p.name)}</span>
        <span class="lb-score">${p.cumScore} pts</span>
      </div>`;
  }).join('');

  document.getElementById('leaderboard-content').innerHTML = `
    <div class="court-section">
      <div class="court-label king">Final scores · ${round} round${round !== 1 ? 's' : ''}</div>
      ${rows}
    </div>`;
}

async function clearPlayers() {
  if (!players.length) return;
  if (!confirm(`Remove all ${players.length} players? This cannot be undone.`)) return;
  const snap  = await _playersRef().get();
  const batch = getDb().batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  await _tourRef().update({ playerCount: 0 });
  players = [];
  renderCheckin();
}

async function resetScores() {
  if (!players.some(p => p.cumScore > 0)) return;
  if (!confirm('Reset all cumulative scores to zero? This cannot be undone.')) return;
  const batch = getDb().batch();
  players.forEach(p => {
    p.cumScore = 0;
    batch.update(_playersRef().doc(p.id), { cumScore: 0 });
  });
  await batch.commit();
  renderCheckin();
}

// ─── QR / self check-in ────────────────────────────────────────────────────────
let _qrActive       = false;
let _seenKeys       = new Set();
let _unsubFirestore = null;

async function openQRCheckin() {
  if (!_tournamentId) return;
  _qrActive = true;
  _seenKeys = new Set(players.map(p => p.id));

  let base = location.href.split('?')[0].replace(/\/?$/, '/');
  try {
    const r = await fetch('/api/ip');
    if (r.ok) {
      const { ip } = await r.json();
      if (ip && ip !== '127.0.0.1') base = base.replace(location.hostname, ip);
    }
  } catch(e) {}
  const joinUrl = base + 'join/?t=' + _tournamentId;
  document.getElementById('qr-join-url').value  = joinUrl;
  updateQRUrl(joinUrl);
  document.getElementById('qr-code-text').textContent = _tournamentId.slice(0, 6).toUpperCase();
  document.getElementById('qr-status').textContent    = 'Waiting for players…';
  document.getElementById('qr-player-list').innerHTML = '';
  document.getElementById('qr-overlay').classList.add('open');

  _unsubFirestore = _playersRef().onSnapshot(snap => {
    if (!_qrActive) return;
    players.forEach(p => _seenKeys.add(p.id));
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const d = change.doc;
      if (_seenKeys.has(d.id)) return;
      _seenKeys.add(d.id);
      const p = { id: d.id, name: d.data().name, cumScore: d.data().cumScore || 0 };
      players.push(p);
      renderCheckin();
      const list  = document.getElementById('qr-player-list');
      const row   = document.createElement('div');
      row.className   = 'qr-player-row';
      row.textContent = p.name;
      list.prepend(row);
      const count = list.children.length;
      document.getElementById('qr-status').textContent =
        `${count} player${count !== 1 ? 's' : ''} via QR`;
    });
  });
}

function updateQRUrl(url) {
  document.getElementById('qr-img').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}&qzone=1`;
}

function closeQRCheckin() {
  _qrActive = false;
  if (_unsubFirestore) { _unsubFirestore(); _unsubFirestore = null; }
  document.getElementById('qr-overlay').classList.remove('open');
}

// ─── Debug helpers ─────────────────────────────────────────────────────────────
const _DEBUG_NAMES = [
  'Alice','Bob','Charlie','Diana','Eve','Frank','Grace','Henry',
  'Iris','Jack','Kate','Leo','Mia','Noah','Olivia','Paul',
  'Quinn','Rachel','Sam','Tina','Uma','Victor','Wendy','Xavier',
  'Yara','Zoe','Aaron','Bella','Carlos','Demi','Elliot','Fiona',
];

async function debugFillPlayers() {
  const n     = Math.max(1, parseInt(document.getElementById('debug-n').value) || 24);
  const pool  = [..._DEBUG_NAMES].sort(() => Math.random() - 0.5);
  const batch = getDb().batch();
  const now   = firebase.firestore.FieldValue.serverTimestamp();
  const newPlayers = [];
  for (let i = 0; i < n; i++) {
    const name = pool[i % pool.length] + (i >= pool.length ? ` ${Math.floor(i / pool.length) + 1}` : '');
    const ref  = _playersRef().doc();
    batch.set(ref, { name, cumScore: 0, joinedAt: now });
    newPlayers.push({ id: ref.id, name, cumScore: 0 });
  }
  await batch.commit();
  await _tourRef().update({ playerCount: firebase.firestore.FieldValue.increment(n) });
  players.push(...newPlayers);
  renderCheckin();
}

function debugRandomScores() {
  topTeams.forEach(t => { t.roundScore = Math.floor(Math.random() * 25) + 1; });
  workUp.forEach(wu => { wu.roundScore = Math.floor(Math.random() * 15) + 1; });
  renderRound();
}

// ─── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  if (DEBUG) document.querySelectorAll('.debug-bar').forEach(el => el.style.display = 'flex');

  await new Promise(resolve => {
    const unsub = getAuth().onAuthStateChanged(async user => {
      unsub();
      _currentUser = user;
      _isAdmin     = await _checkAdmin(user);
      resolve();
    });
  });

  getAuth().onAuthStateChanged(async user => {
    _currentUser = user;
    _isAdmin     = await _checkAdmin(user);
    _updateAuthUI();
    const homeActive = document.getElementById('screen-home')?.classList.contains('active');
    if (homeActive) await renderHome();
  });

  _updateAuthUI();

  const lastId = localStorage.getItem('kqotc-last-tournament');
  if (lastId) {
    try {
      const [data, loadedPlayers] = await Promise.all([_loadDoc(lastId), _loadPlayers(lastId)]);
      if (data) {
        _tournamentId = lastId;
        _applyData(data);
        players = loadedPlayers;
        _navigateToScreen(data);
        return;
      }
    } catch(e) {
      console.error('Auto-resume failed:', e);
    }
  }

  await renderHome();
  showScreen('home');
}

boot();
