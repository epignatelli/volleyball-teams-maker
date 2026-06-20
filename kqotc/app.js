// ─── Debug ─────────────────────────────────────────────────────────────────────
const DEBUG = false;

// ─── State ─────────────────────────────────────────────────────────────────────
let players    = [];   // { id, name, cumScore }
let round      = 0;
let numTopTeams = 0;
let topTeams   = [];   // { id, playerIds[], roundScore }
let workUp     = [];   // { playerId, roundScore }
let pendingNext = null; // prepared next-round state

const STORE_KEY = 'kqotc-players-v1';

// ─── Persistence ───────────────────────────────────────────────────────────────
function savePlayers() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(players)); } catch(e) {}
}
function loadPlayers() {
  try {
    const d = localStorage.getItem(STORE_KEY);
    if (d) players = JSON.parse(d);
  } catch(e) {}
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function getPlayer(id) { return players.find(p => p.id === id); }

// calcNumTopTeams, calcMoversUp, computeTransition, computeScores live in logic.js

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// ─── Check-in screen ───────────────────────────────────────────────────────────
function addPlayer() {
  const input = document.getElementById('player-input');
  const name = input.value.trim();
  if (!name) return;
  if (players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    input.select(); return;
  }
  players.push({ id: Date.now() + Math.random(), name, cumScore: 0 });
  input.value = '';
  input.focus();
  savePlayers();
  renderCheckin();
}

document.getElementById('player-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addPlayer();
});

function removePlayer(id) {
  players = players.filter(p => p.id !== id);
  savePlayers();
  renderCheckin();
}

function renderCheckin() {
  const n = players.length;
  const countEl = document.getElementById('player-count');
  const hintEl  = document.getElementById('court-hint');
  const startBtn = document.getElementById('start-btn');
  const listEl   = document.getElementById('player-list');
  const emptyEl  = document.getElementById('player-empty');

  countEl.textContent = n || '';

  const nTop = calcNumTopTeams(n);
  const topCount = nTop * 4;
  if (n >= 8) {
    hintEl.textContent = `${nTop} king court teams · ${Math.max(0, n - topCount)} on work-up`;
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
      <button class="remove-btn" onclick="removePlayer(${p.id})">×</button>
    </div>`).join('');
}

// ─── Start event ───────────────────────────────────────────────────────────────
function startEvent() {
  numTopTeams = calcNumTopTeams(players.length);
  const topCount = numTopTeams * 4;

  // Reset cumulative scores
  players.forEach(p => p.cumScore = 0);

  // Form king court teams from first topCount players
  const topPlayers  = players.slice(0, topCount);
  const workPlayers = players.slice(topCount);

  topTeams = [];
  for (let i = 0; i < numTopTeams; i++) {
    topTeams.push({
      id: i + 1,
      playerIds: topPlayers.slice(i * 4, i * 4 + 4).map(p => p.id),
      roundScore: 0
    });
  }
  workUp = workPlayers.map(p => ({ playerId: p.id, roundScore: 0 }));
  round = 1;

  showScreen('round');
  renderRound();
}

// ─── Round screen ──────────────────────────────────────────────────────────────
function renderRound() {
  document.getElementById('round-title').textContent = `Round ${round}`;
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
          oninput="setWorkScore(${wu.playerId}, this.value)"
          onblur="blurWorkScore(${wu.playerId}, this)" />
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
  const n = parseScore(val);
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

  const result = computeTransition(topTeams, workUp, numTopTeams, round);
  result.newTeams.forEach((t, i) => { t.id = Date.now() + i; });

  pendingNext = { topTeams: result.nextTopTeams, workUp: result.nextWorkUp };

  renderTransition(result);
  document.getElementById('transition-title').textContent = `Round ${round} done`;
  document.getElementById('next-round-num').textContent = round + 1;
  showScreen('transition');
}

// ─── Transition screen ─────────────────────────────────────────────────────────
function renderTransition({ moversUp, movingDownTeams, stayTeams, newTeams, stayWorkUp }) {
  const name = id => esc(getPlayer(id)?.name ?? '—');

  const downList = movingDownTeams.map(t =>
    `<div class="move-row down"><span class="move-name">${t.playerIds.map(name).join(', ')}</span><span class="move-score">${t.roundScore} pts</span></div>`
  ).join('') || '<div class="empty-note">—</div>';

  const nextKingCards = [
    ...stayTeams.map(t => ({ ...t, isNew: false, scoreLabel: `${t.roundScore} pts this round` })),
    ...newTeams.map((t, i) => {
      const slice = moversUp.slice(i * 4, i * 4 + 4);
      return { ...t, isNew: true, scoreLabel: slice.map(wu => wu.roundScore).join(' / ') + ' pts' };
    })
  ].map(t => `
    <div class="team-card ${t.isNew ? 'team-new' : 'team-stay'}">
      <div class="team-names">
        <span class="team-badge">${t.isNew ? '★ New' : '↩ Stay'}</span>
        ${t.playerIds.map(name).join(', ')}
        <span class="cum-score">${t.scoreLabel}</span>
      </div>
    </div>`).join('');

  const nextWorkRows = [
    ...movingDownTeams.flatMap(t => t.playerIds.map(pid => ({ pid, score: t.roundScore, tag: '↓ ' }))),
    ...stayWorkUp.map(wu => ({ pid: wu.playerId, score: wu.roundScore, tag: '' }))
  ].map(({ pid, score, tag }) =>
    `<div class="workup-row"><span class="player-name">${name(pid)}<span class="cum-score">${tag}${score} pts this round</span></span></div>`
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
  topTeams = pendingNext.topTeams;
  workUp   = pendingNext.workUp;
  pendingNext = null;
  round++;
  showScreen('round');
  renderRound();
}

// ─── End event / leaderboard ───────────────────────────────────────────────────
function endEvent() {
  // Final accumulation if round is in progress
  // (scores already tallied up to last endRound call; this shows current state)
  renderLeaderboard();
  showScreen('leaderboard');
}

function renderLeaderboard() {
  const sorted = [...players].sort((a, b) => b.cumScore - a.cumScore);
  const rows = sorted.map((p, i) => {
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

function newEvent() {
  if (!confirm('Start a new event? This will clear all scores.')) return;
  players.forEach(p => p.cumScore = 0);
  round = 0;
  topTeams = [];
  workUp = [];
  pendingNext = null;
  savePlayers();
  showScreen('checkin');
  renderCheckin();
}

// ─── Debug helpers ─────────────────────────────────────────────────────────────
const _DEBUG_NAMES = [
  'Alice','Bob','Charlie','Diana','Eve','Frank','Grace','Henry',
  'Iris','Jack','Kate','Leo','Mia','Noah','Olivia','Paul',
  'Quinn','Rachel','Sam','Tina','Uma','Victor','Wendy','Xavier',
  'Yara','Zoe','Aaron','Bella','Carlos','Demi','Elliot','Fiona'
];

function debugFillPlayers() {
  const n = Math.max(1, parseInt(document.getElementById('debug-n').value) || 24);
  players = [];
  const pool = [..._DEBUG_NAMES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < n; i++) {
    const name = pool[i % pool.length] + (i >= pool.length ? ` ${Math.floor(i / pool.length) + 1}` : '');
    players.push({ id: Date.now() + i, name, cumScore: 0 });
  }
  savePlayers();
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
loadPlayers();
renderCheckin();
if (DEBUG) document.querySelectorAll('.debug-bar').forEach(el => el.style.display = 'flex');
