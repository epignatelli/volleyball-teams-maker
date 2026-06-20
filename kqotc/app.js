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
          oninput="setTeamScore(${t.id}, this.value, this)" />
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
          oninput="setWorkScore(${wu.playerId}, this.value, this)" />
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

function parseScore(val) {
  const n = parseInt(val);
  return isNaN(n) ? null : Math.max(0, n);
}

function setTeamScore(id, val, el) {
  const n = parseScore(val);
  if (n === null) { el.classList.add('input-error'); return; }
  el.classList.remove('input-error');
  const t = topTeams.find(t => t.id === id);
  if (t) t.roundScore = n;
}

function setWorkScore(playerId, val, el) {
  const n = parseScore(val);
  if (n === null) { el.classList.add('input-error'); return; }
  el.classList.remove('input-error');
  const wu = workUp.find(w => w.playerId === playerId);
  if (wu) wu.roundScore = n;
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

  const upList = moversUp.map(wu =>
    `<div class="move-row up"><span class="move-name">${name(wu.playerId)}</span><span class="move-score">${wu.roundScore} pts</span></div>`
  ).join('') || '<div class="empty-note">—</div>';

  const downList = movingDownTeams.map(t =>
    `<div class="move-row down"><span class="move-name">${t.playerIds.map(name).join(', ')}</span><span class="move-score">${t.roundScore} pts</span></div>`
  ).join('') || '<div class="empty-note">—</div>';

  const nextKingCards = [...stayTeams.map(t => ({ ...t, isNew: false })), ...newTeams.map(t => ({ ...t, isNew: true }))].map((t, i) => {
    const label = t.isNew ? '★ New' : '↩ Stay';
    return `
      <div class="team-card ${t.isNew ? 'team-new' : 'team-stay'}">
        <div class="team-badge">${label}</div>
        <div class="team-names">${t.playerIds.map(name).join(', ')}</div>
      </div>`;
  }).join('');

  const nextWorkRows = [...movingDownTeams.flatMap(t => t.playerIds), ...stayWorkUp.map(wu => wu.playerId)].map(pid =>
    `<div class="workup-row"><span class="player-name">${name(pid)}</span></div>`
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

// ─── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');

// ─── Boot ──────────────────────────────────────────────────────────────────────
loadPlayers();
renderCheckin();
