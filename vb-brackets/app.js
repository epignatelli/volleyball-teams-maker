// ── Globals ────────────────────────────────────────────────────────────────────
let _user = null;
let _tid = null;       // current tournament ID
let _tournament = null;
let _matches = [];
let _unsubT = null;    // tournament onSnapshot unsub
let _unsubM = null;    // matches onSnapshot unsub
let _knockoutTab = 'bracket'; // 'bracket' | 'groups'

// ── Firebase refs ──────────────────────────────────────────────────────────────
const _db   = () => firebase.firestore();
const _tRef = (id) => _db().collection('brackets').doc(id);
const _mRef = (tid, mid) => _tRef(tid).collection('matches').doc(mid);
const _mCol = (tid) => _tRef(tid).collection('matches');

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  firebase.auth().onAuthStateChanged(u => {
    _user = u;
    const btn = document.getElementById('auth-btn');
    btn.textContent = u ? 'Sign out' : 'Sign in';
    btn.style.display = '';
    _route();
  });
  window.addEventListener('hashchange', _route);
  _route();
});

function _route() {
  const h = location.hash;
  if (!h || h === '#' || h === '#home') { _showHome(); return; }
  if (h === '#new') { _showCreate(); return; }
  const m = h.match(/^#t\/(.+)$/);
  if (m) { _showTournament(m[1]); return; }
  _showHome();
}

function _goBack() { location.hash = '#home'; }

function _toggleAuth() {
  if (_user) {
    firebase.auth().signOut();
  } else {
    firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider())
      .catch(e => _toast(e.message));
  }
}

// ── Utils ──────────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
function _setTitle(t) { document.getElementById('topbar-title').textContent = t; }
function _setBack(v)  { document.getElementById('back-btn').style.display = v ? '' : 'none'; }
function _sc()        { return document.getElementById('screen'); }
function _groupLabel(i) { return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] || String(i + 1); }
function _statusLabel(s) {
  return { setup:'Setup', groups:'Group stage', knockout:'Knockout', done:'Done' }[s] || s;
}
function _nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function _unsub() {
  if (_unsubT) { _unsubT(); _unsubT = null; }
  if (_unsubM) { _unsubM(); _unsubM = null; }
}

// ── Home ───────────────────────────────────────────────────────────────────────
async function _showHome() {
  _unsub(); _tid = null; _tournament = null; _matches = [];
  _setTitle('Brackets'); _setBack(false);
  _sc().innerHTML = `<div class="loading">Loading…</div>`;

  if (!_user) {
    _sc().innerHTML = `
      <div class="home-empty">
        <p>Sign in to create and manage tournaments.</p>
        <button class="btn-primary" onclick="_toggleAuth()">Sign in with Google</button>
      </div>`;
    return;
  }

  try {
    const snap = await _db().collection('brackets')
      .where('createdBy', '==', _user.uid).get();
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    _sc().innerHTML = `
      <div class="home-top">
        <button class="btn-primary" onclick="location.hash='#new'">+ New tournament</button>
      </div>
      ${all.length === 0 ? '<p class="home-empty-msg">No tournaments yet.</p>' : ''}
      <div class="tournament-list">
        ${all.map(t => `
          <a class="tournament-card" href="#t/${t.id}">
            <div>
              <div class="tc-name">${_esc(t.name)}</div>
              <div class="tc-teams" style="margin-top:3px">${(t.teams||[]).length} teams · ${t.groupCount} group${t.groupCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="tc-meta">
              <span class="tc-status status-${t.status}">${_statusLabel(t.status)}</span>
            </div>
            <span class="tc-arrow">→</span>
          </a>`).join('')}
      </div>`;
  } catch (e) {
    _sc().innerHTML = `<div class="error">${_esc(e.message)}</div>`;
  }
}

// ── Create ─────────────────────────────────────────────────────────────────────
function _showCreate() {
  if (!_user) { location.hash = '#home'; return; }
  _unsub(); _tid = null; _tournament = null; _matches = [];
  _setTitle('New Tournament'); _setBack(true);

  _sc().innerHTML = `
    <form id="cf" onsubmit="_submitCreate(event)" class="create-form">
      <div class="field">
        <label class="field-label">Tournament name</label>
        <input class="field-input" id="cf-name" type="text" placeholder="Summer Open 2025" required/>
      </div>
      <div class="field">
        <label class="field-label">Number of groups</label>
        <select class="field-input field-select" id="cf-groups" onchange="_updateCreateForm()">
          <option value="1">1</option>
          <option value="2" selected>2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
          <option value="6">6</option>
          <option value="8">8</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Round-robin format</label>
        <select class="field-input field-select" id="cf-rounds">
          <option value="1" selected>Single (each pair plays once)</option>
          <option value="2">Double (each pair plays twice)</option>
        </select>
      </div>
      <div class="section-divider">Knockout</div>
      <div class="field">
        <label class="field-label">Teams per group → Winners bracket</label>
        <select class="field-input field-select" id="cf-advw" onchange="_updateCreateForm()">
          <option value="1">1</option>
          <option value="2" selected>2</option>
          <option value="3">3</option>
          <option value="4">4</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Teams per group → Losers bracket</label>
        <select class="field-input field-select" id="cf-advl">
          <option value="0">None — skip losers bracket</option>
          <option value="1">1</option>
          <option value="2" selected>2</option>
          <option value="3">3</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Winners bracket format</label>
        <select class="field-input field-select" id="cf-wbf">
          <option value="single" selected>Single elimination</option>
          <option value="double">Double elimination</option>
        </select>
      </div>
      <div class="section-divider" style="display:flex;align-items:center;justify-content:space-between">
        <span>Teams <span id="cf-team-count" style="font-weight:400;color:var(--muted)"></span></span>
        <button type="button" class="shuffle-btn" onclick="_randomizeGroups()">⇄ Randomize</button>
      </div>
      <div class="field">
        <textarea class="field-input team-textarea" id="cf-teams-txt" rows="10"
          placeholder="One team per line&#10;e.g.&#10;Team Alpha&#10;Team Beta&#10;Team Gamma&#10;…"
          oninput="_updateCreateForm()"></textarea>
      </div>
      <div id="cf-group-preview"></div>
      <p class="field-hint" id="cf-summary"></p>
      <button type="submit" class="btn-primary" id="cf-submit">Create tournament</button>
    </form>`;

  _updateCreateForm();
}

function _parseTeamNames() {
  return (document.getElementById('cf-teams-txt')?.value || '')
    .split('\n').map(s => s.trim()).filter(Boolean);
}

function _updateCreateForm() {
  const groups = parseInt(document.getElementById('cf-groups')?.value || 2);
  const advW   = parseInt(document.getElementById('cf-advw')?.value || 2);
  const names  = _parseTeamNames();
  const n      = names.length;

  const countEl = document.getElementById('cf-team-count');
  if (countEl) countEl.textContent = n ? `(${n})` : '';

  // Group preview
  const preview = document.getElementById('cf-group-preview');
  if (preview && n > 0) {
    let html = '<div class="group-preview">';
    for (let g = 0; g < groups; g++) {
      const members = names.filter((_, i) => i % groups === g);
      html += `<div class="gp-row">
        <span class="gp-label">Group ${_groupLabel(g)}</span>
        <span class="gp-teams">${members.map(m => _esc(m)).join(', ') || '—'}</span>
      </div>`;
    }
    html += '</div>';
    preview.innerHTML = html;
  } else if (preview) {
    preview.innerHTML = '';
  }

  const sum = document.getElementById('cf-summary');
  if (sum) sum.textContent = n > 0
    ? `Winners bracket: ${_nextPow2(groups * advW)} slots`
    : '';
}

function _randomizeGroups() {
  const ta = document.getElementById('cf-teams-txt');
  if (!ta) return;
  const names = _parseTeamNames();
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  ta.value = names.join('\n');
  _updateCreateForm();
}

async function _submitCreate(e) {
  e.preventDefault();
  const btn = document.getElementById('cf-submit');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const groups = parseInt(document.getElementById('cf-groups').value);
    const rounds = parseInt(document.getElementById('cf-rounds').value);
    const advW   = parseInt(document.getElementById('cf-advw').value);
    const advL   = parseInt(document.getElementById('cf-advl').value);
    const wbf    = document.getElementById('cf-wbf').value;
    const names  = _parseTeamNames();

    if (names.length < 2) { _toast('Enter at least 2 teams'); btn.disabled = false; btn.textContent = 'Create tournament'; return; }

    // Distribute round-robin across groups: names[0]→g0, names[1]→g1, …, names[groups]→g0, …
    const teams = names.map((name, i) => ({ id: `t${i}`, name, group: i % groups }));

    const ref = await _db().collection('brackets').add({
      name: document.getElementById('cf-name').value.trim(),
      status: 'setup',
      groupCount: groups,
      teamsPerGroup: Math.ceil(names.length / groups),
      roundsPerGroup: rounds,
      advanceWinners: advW,
      advanceLosers: advL,
      winnersBracket: wbf,
      createdBy: _user.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      teams,
    });

    location.hash = `#t/${ref.id}`;
  } catch (err) {
    _toast(err.message);
    btn.disabled = false; btn.textContent = 'Create tournament';
  }
}

// ── Tournament detail ──────────────────────────────────────────────────────────
function _showTournament(id) {
  _unsub();
  _tid = id; _tournament = null; _matches = []; _knockoutTab = 'bracket';
  _setTitle('…'); _setBack(true);
  _sc().innerHTML = `<div class="loading">Loading…</div>`;

  _unsubT = _tRef(id).onSnapshot(snap => {
    if (!snap.exists) { _sc().innerHTML = `<div class="error">Tournament not found.</div>`; return; }
    _tournament = { id: snap.id, ...snap.data() };
    _setTitle(_tournament.name);
    _renderTournament();
  }, err => { _sc().innerHTML = `<div class="error">${_esc(err.message)}</div>`; });

  _unsubM = _mCol(id).onSnapshot(snap => {
    _matches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderTournament();
  }, () => {});
}

function _renderTournament() {
  if (!_tournament) return;
  switch (_tournament.status) {
    case 'setup':    _renderSetup(); break;
    case 'groups':   _renderGroups(); break;
    case 'knockout': _renderKnockout(); break;
    case 'done':     _renderDone(); break;
    default: _sc().innerHTML = `<div class="error">Unknown status.</div>`;
  }
}

// ── Phase: Setup ──────────────────────────────────────────────────────────────
function _renderSetup() {
  const t = _tournament;
  const canEdit = _user && _user.uid === t.createdBy;

  const byG = {};
  for (const tm of t.teams || []) { if (!byG[tm.group]) byG[tm.group] = []; byG[tm.group].push(tm); }

  let teamsHtml = '';
  for (let g = 0; g < t.groupCount; g++) {
    teamsHtml += `
      <div class="sh">Group ${_groupLabel(g)}</div>
      <div class="group-section" style="padding:10px 16px 12px">
        ${(byG[g]||[]).map(tm => `<span class="team-chip">${_esc(tm.name)}</span>`).join('')}
      </div>`;
  }

  _sc().innerHTML = `
    <div class="phase-setup">
      <div class="sh">Format</div>
        <div class="setup-row"><span>Groups</span><span>${t.groupCount}</span></div>
        <div class="setup-row"><span>Teams per group</span><span>${t.teamsPerGroup}</span></div>
        <div class="setup-row"><span>Format</span><span>${t.roundsPerGroup === 2 ? 'Double round-robin' : 'Single round-robin'}</span></div>
        <div class="setup-row"><span>Advance → winners</span><span>${t.advanceWinners} per group</span></div>
        <div class="setup-row"><span>Advance → losers</span><span>${t.advanceLosers > 0 ? `${t.advanceLosers} per group` : 'None'}</span></div>
        <div class="setup-row"><span>Winners bracket</span><span>${t.winnersBracket === 'double' ? 'Double elimination' : 'Single elimination'}</span></div>
      <div class="sh">Teams</div>
      <div class="teams-grid">${teamsHtml}</div>
      <div class="bottom-actions">
        ${canEdit
          ? `<button class="btn-primary" onclick="_startGroups()">Start group stage →</button>`
          : `<div class="info-pill">Waiting for organizer to start the tournament.</div>`}
        <button class="btn-ghost" onclick="_copyLink()">Copy share link</button>
      </div>
    </div>`;
}

// ── Action: Start groups ───────────────────────────────────────────────────────
async function _startGroups() {
  const t = _tournament;
  const batch = _db().batch();

  const byG = {};
  for (const tm of t.teams) { if (!byG[tm.group]) byG[tm.group] = []; byG[tm.group].push(tm); }

  for (let g = 0; g < t.groupCount; g++) {
    const teams = byG[g] || [];
    const pairs = _rrPairs(teams, t.roundsPerGroup === 2);
    pairs.forEach(([a, b], i) => {
      batch.set(_mCol(_tid).doc(`g${g}m${i}`), {
        phase: 'group', group: g, slot: i,
        teamAId: a.id, nameA: a.name,
        teamBId: b.id, nameB: b.name,
        scoreA: null, scoreB: null, winner: null,
        winnerTo: null, winnerToSlot: null,
      });
    });
  }

  batch.update(_tRef(_tid), { status: 'groups' });
  await batch.commit().catch(e => _toast(e.message));
}

// ── Phase: Groups ─────────────────────────────────────────────────────────────
function _buildGroupsHtml(canEdit) {
  const t = _tournament;
  const gm = _matches.filter(m => m.phase === 'group');

  const byG = {};
  for (const m of gm) { if (!byG[m.group]) byG[m.group] = []; byG[m.group].push(m); }

  const teamsByG = {};
  for (const tm of (t.teams || [])) { if (!teamsByG[tm.group]) teamsByG[tm.group] = []; teamsByG[tm.group].push(tm); }

  let html = `<div class="groups-container">`;
  for (let g = 0; g < (t.groupCount || 0); g++) {
    const stands = _computeStandings(teamsByG[g] || [], byG[g] || []);
    const advW = t.advanceWinners, advL = t.advanceLosers;

    html += `<div class="group-block">
      <div class="sh">Group ${_groupLabel(g)}</div>
      <table class="standings-table">
        <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>+/−</th></tr></thead>
        <tbody>
          ${stands.map((s, i) => `
            <tr class="${i < advW ? 'advance-w' : i < advW + advL ? 'advance-l' : ''}">
              <td>${i + 1}</td><td>${_esc(s.name)}</td>
              <td>${s.W}</td><td>${s.L}</td>
              <td>${s.sW - s.sL >= 0 ? '+' : ''}${s.sW - s.sL}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="matches-sh">Matches</div>
      <div class="matches-list">
        ${(byG[g] || []).sort((a,b) => a.slot - b.slot).map(m => _matchCard(m, canEdit)).join('')}
      </div>
    </div>`;
  }
  html += `</div>`;
  return html;
}

function _renderGroups() {
  const t = _tournament;
  const canEdit = _user && _user.uid === t.createdBy;
  const gm = _matches.filter(m => m.phase === 'group');
  const allDone = gm.length > 0 && gm.every(m => m.winner);

  let html = _buildGroupsHtml(canEdit);

  html += `<div class="bottom-actions">`;
  if (canEdit && allDone) {
    html += `<button class="btn-primary" onclick="_advanceToKnockout()">Start knockout stage →</button>`;
  } else if (!allDone) {
    html += `<div class="info-pill">${gm.filter(m => m.winner).length} / ${gm.length} matches played</div>`;
  }
  html += `<button class="btn-ghost" onclick="_copyLink()">Copy share link</button></div>`;

  _sc().innerHTML = html;
}

function _matchCard(m, canEdit) {
  const wA = m.winner === 'A', wB = m.winner === 'B';
  const clickable = canEdit && !m.winner;
  const scoreStr = m.scoreA !== null && m.scoreB !== null
    ? `${m.scoreA} — ${m.scoreB}`
    : '— vs —';
  return `
    <div class="match-card${wA ? ' mc-winner-a' : wB ? ' mc-winner-b' : ''}"
      ${clickable ? `onclick="_openScore('${_esc(m.id)}')"` : ''}>
      <span class="mc-name mc-name-a">${_esc(m.nameA)}</span>
      <span class="mc-score">${scoreStr}</span>
      <span class="mc-name mc-name-b">${_esc(m.nameB)}</span>
    </div>`;
}

// ── Score entry modal ─────────────────────────────────────────────────────────
function _openScore(matchId) {
  const m = _matches.find(x => x.id === matchId);
  if (!m) return;
  document.getElementById('score-overlay')?.remove();

  const el = document.createElement('div');
  el.className = 'score-overlay'; el.id = 'score-overlay';
  el.innerHTML = `
    <div class="score-modal">
      <div class="score-modal-title">Enter score</div>
      <div class="score-row">
        <span class="score-team-name">${_esc(m.nameA)}</span>
        <input class="score-input" id="se-a" type="number" min="0" max="99" inputmode="numeric"
          value="${m.scoreA !== null ? m.scoreA : ''}"/>
      </div>
      <div class="score-row">
        <span class="score-team-name">${_esc(m.nameB)}</span>
        <input class="score-input" id="se-b" type="number" min="0" max="99" inputmode="numeric"
          value="${m.scoreB !== null ? m.scoreB : ''}"/>
      </div>
      <div class="score-modal-actions">
        <button class="btn-ghost" onclick="document.getElementById('score-overlay').remove()">Cancel</button>
        <button class="btn-primary" onclick="_submitScore('${_esc(matchId)}')">Save</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('se-a').focus();
}

async function _submitScore(matchId) {
  const m = _matches.find(x => x.id === matchId);
  if (!m) return;

  const sA = parseInt(document.getElementById('se-a').value);
  const sB = parseInt(document.getElementById('se-b').value);

  if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) { _toast('Enter valid scores'); return; }
  if (sA === sB) { _toast('Scores cannot be equal'); return; }

  const winner = sA > sB ? 'A' : 'B';
  document.getElementById('score-overlay')?.remove();

  try {
    await _mRef(_tid, matchId).update({ scoreA: sA, scoreB: sB, winner });

    // Propagate winner in knockout bracket
    if (m.winnerTo) {
      const team = winner === 'A' ? { id: m.teamAId, name: m.nameA } : { id: m.teamBId, name: m.nameB };
      const upd = m.winnerToSlot === 'A'
        ? { teamAId: team.id, nameA: team.name }
        : { teamBId: team.id, nameB: team.name };
      await _mRef(_tid, m.winnerTo).update(upd);
    }
  } catch (err) { _toast(err.message); }
}

// ── Action: Advance to knockout ────────────────────────────────────────────────
async function _advanceToKnockout() {
  const t = _tournament;
  const gm = _matches.filter(m => m.phase === 'group');

  const teamsByG = {};
  for (const tm of t.teams) { if (!teamsByG[tm.group]) teamsByG[tm.group] = []; teamsByG[tm.group].push(tm); }

  const standsByG = {};
  for (let g = 0; g < t.groupCount; g++) {
    standsByG[g] = _computeStandings(teamsByG[g] || [], gm.filter(m => m.group === g));
  }

  const wSeeds = _assignSeeds(standsByG, t.advanceWinners, t.groupCount, 0);
  const lSeeds = t.advanceLosers > 0 ? _assignSeeds(standsByG, t.advanceLosers, t.groupCount, t.advanceWinners) : [];

  const wMatches = _generateBracket(wSeeds, 'winners');
  const lMatches = lSeeds.length >= 2 ? _generateBracket(lSeeds, 'losers') : [];

  const batch = _db().batch();
  for (const m of [...wMatches, ...lMatches]) batch.set(_mCol(_tid).doc(m.id), m);
  batch.update(_tRef(_tid), { status: 'knockout' });
  await batch.commit().catch(e => _toast(e.message));
}

// ── Phase: Knockout ───────────────────────────────────────────────────────────
function _setKnockoutTab(tab) {
  _knockoutTab = tab;
  _renderKnockout();
}

function _renderKnockout() {
  const t = _tournament;
  const canEdit = _user && _user.uid === t.createdBy;
  const wm = _matches.filter(m => m.bracket === 'winners').sort((a,b) => a.round - b.round || a.slot - b.slot);
  const lm = _matches.filter(m => m.bracket === 'losers').sort((a,b) => a.round - b.round || a.slot - b.slot);

  const finalM = wm.find(m => !m.winnerTo);
  const champ = finalM?.winner ? (finalM.winner === 'A' ? finalM.nameA : finalM.nameB) : null;

  let html = '';
  if (champ) html += `<div class="champion-banner">Champion: ${_esc(champ)}</div>`;

  html += `<nav class="tab-bar">
    <button class="tab${_knockoutTab === 'bracket' ? ' tab-active' : ''}" onclick="_setKnockoutTab('bracket')">Bracket</button>
    <button class="tab${_knockoutTab === 'groups'  ? ' tab-active' : ''}" onclick="_setKnockoutTab('groups')">Group stage</button>
  </nav>`;

  if (_knockoutTab === 'groups') {
    try {
      html += _buildGroupsHtml(false);
    } catch (err) {
      html += `<div class="error">Could not load group results: ${_esc(err.message)}</div>`;
    }
  } else {
    html += `<div class="bracket-container">
      <div class="sh">Winners bracket</div>
      ${_renderBracket(wm, canEdit)}
    </div>`;

    if (lm.length > 0) {
      html += `<div class="bracket-container">
        <div class="sh">Losers bracket</div>
        ${_renderBracket(lm, canEdit)}
      </div>`;
    }
  }

  html += `<div class="bottom-actions">`;
  if (canEdit && champ) html += `<button class="btn-primary" onclick="_finishTournament()">Close tournament</button>`;
  html += `<button class="btn-ghost" onclick="_copyLink()">Copy share link</button></div>`;

  _sc().innerHTML = html;
}

function _renderBracket(matches, canEdit) {
  if (!matches.length) return '<div class="info-pill">No bracket matches.</div>';

  const maxRound = Math.max(...matches.map(m => m.round));
  const MATCH_H = 72, SLOT_H0 = 80;

  let headsHtml = '', bodyHtml = '';
  for (let r = 0; r <= maxRound; r++) {
    const label = r === maxRound && maxRound > 0 ? 'Final' : r === maxRound - 1 && maxRound > 1 ? 'Semifinal' : `Round ${r + 1}`;
    headsHtml += `<div class="br-col-head">${label}</div>`;

    const rMatches = matches.filter(m => m.round === r).sort((a,b) => a.slot - b.slot);
    const slotH = SLOT_H0 * Math.pow(2, r);
    const gap     = slotH - MATCH_H;
    const padTop  = (slotH - MATCH_H) / 2;

    bodyHtml += `<div class="bracket-round" style="gap:${gap}px;padding-top:${padTop}px">`;
    for (const m of rMatches) {
      const wA = m.winner === 'A', wB = m.winner === 'B';
      const isBye = m.nameA === 'BYE' || m.nameB === 'BYE';
      const clickable = canEdit && !m.winner && !isBye && m.teamAId && m.teamBId;
      bodyHtml += `
        <div class="bracket-match${m.winner ? ' bm-done' : ''}"
          ${clickable ? `onclick="_openScore('${_esc(m.id)}')"` : ''}>
          <div class="bm-team${wA ? ' bm-winner' : ''}${m.nameA === 'TBD' ? ' bm-tbd' : ''}">
            <span class="bm-name">${_esc(m.nameA)}</span>
            <span class="bm-score">${m.scoreA !== null ? m.scoreA : ''}</span>
          </div>
          <div class="bm-team${wB ? ' bm-winner' : ''}${m.nameB === 'TBD' ? ' bm-tbd' : ''}">
            <span class="bm-name">${_esc(m.nameB)}</span>
            <span class="bm-score">${m.scoreB !== null ? m.scoreB : ''}</span>
          </div>
        </div>`;
    }
    bodyHtml += `</div>`;
  }

  return `<div class="bracket-scroll">
    <div class="bracket-header">${headsHtml}</div>
    <div class="bracket-body">${bodyHtml}</div>
  </div>`;
}

// ── Phase: Done ───────────────────────────────────────────────────────────────
function _renderDone() {
  const wm = _matches.filter(m => m.bracket === 'winners').sort((a,b) => a.round - b.round || a.slot - b.slot);
  const finalM = wm.find(m => !m.winnerTo);
  const champ = finalM?.winner ? (finalM.winner === 'A' ? finalM.nameA : finalM.nameB) : '—';

  _sc().innerHTML = `
    <div class="done-screen">
      <div class="champion-banner">Champion: ${_esc(champ)}</div>
      <div class="bracket-container">
        <div class="bracket-phase-label">Winners bracket</div>
        ${_renderBracket(wm, false)}
      </div>
      <div class="bottom-actions">
        <button class="btn-ghost" onclick="_copyLink()">Copy share link</button>
      </div>
    </div>`;
}

async function _finishTournament() {
  await _tRef(_tid).update({ status: 'done' }).catch(e => _toast(e.message));
}

function _copyLink() {
  const url = `${location.origin}${location.pathname}#t/${_tid}`;
  navigator.clipboard.writeText(url)
    .then(() => _toast('Link copied!'))
    .catch(() => _toast('Copy failed'));
}

// ── Algorithms ─────────────────────────────────────────────────────────────────

// All pairs for round-robin; doubles = each pair appears twice (reversed)
function _rrPairs(teams, doubles) {
  const pairs = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      pairs.push([teams[i], teams[j]]);
      if (doubles) pairs.push([teams[j], teams[i]]);
    }
  }
  return pairs;
}

// Standings sorted by W → set diff → sets won
function _computeStandings(teams, matches) {
  const s = {};
  for (const t of teams) s[t.id] = { ...t, W: 0, L: 0, sW: 0, sL: 0 };
  for (const m of matches) {
    if (!m.winner || !s[m.teamAId] || !s[m.teamBId]) continue;
    const w = m.winner === 'A' ? m.teamAId : m.teamBId;
    const l = m.winner === 'A' ? m.teamBId : m.teamAId;
    s[w].W++; s[l].L++;
    if (m.scoreA != null && m.scoreB != null) {
      s[m.teamAId].sW += m.scoreA; s[m.teamAId].sL += m.scoreB;
      s[m.teamBId].sW += m.scoreB; s[m.teamBId].sL += m.scoreA;
    }
  }
  return Object.values(s).sort((a, b) =>
    (b.W - a.W) || ((b.sW - b.sL) - (a.sW - a.sL)) || (b.sW - a.sW)
  );
}

// Standard bracket seeding order: result[slot] = seed number (1-indexed)
// Ensures seed 1 and seed 2 can only meet in the final
function _bracketSeedOrder(n) {
  if (n <= 1) return [1];
  if (n === 2) return [1, 2];
  const prev = _bracketSeedOrder(n / 2);
  const result = [];
  for (const s of prev) result.push(s, n + 1 - s);
  return result;
}

// Interleave groups: rank 1 from each group, rank 2 from each group, etc.
// skipRanks = how many top ranks to skip (for losers bracket seeding)
function _assignSeeds(standsByG, count, groupCount, skipRanks) {
  const seeds = [];
  for (let rank = skipRanks; rank < skipRanks + count; rank++) {
    for (let g = 0; g < groupCount; g++) {
      if (standsByG[g]?.[rank]) seeds.push(standsByG[g][rank]);
    }
  }
  return seeds;
}

// Generate bracket match objects for a set of seeds
function _generateBracket(seeds, bracketName) {
  const n = seeds.length;
  if (n < 2) return [];

  const size = _nextPow2(n);
  const order = _bracketSeedOrder(size); // order[slot_i] = seedNum (1-indexed)
  // Map: slot → team (null = bye)
  const seated = order.map(sn => sn <= n ? seeds[sn - 1] : null);

  const numRounds = Math.log2(size);
  const byRound = [];

  for (let r = 0; r < numRounds; r++) {
    const numM = size >> (r + 1);
    byRound[r] = [];
    for (let s = 0; s < numM; s++) {
      byRound[r][s] = {
        id:           `${bracketName}-r${r}-s${s}`,
        phase:        'knockout',
        bracket:      bracketName,
        round:        r,
        slot:         s,
        teamAId:      null, nameA: 'TBD',
        teamBId:      null, nameB: 'TBD',
        scoreA:       null, scoreB: null, winner: null,
        winnerTo:     r < numRounds - 1 ? `${bracketName}-r${r + 1}-s${s >> 1}` : null,
        winnerToSlot: s % 2 === 0 ? 'A' : 'B',
      };
    }
  }

  // Fill round 0 with seeds
  for (let s = 0; s < size / 2; s++) {
    const m = byRound[0][s];
    const ta = seated[2 * s], tb = seated[2 * s + 1];
    m.teamAId = ta?.id  || null; m.nameA = ta?.name || 'BYE';
    m.teamBId = tb?.id  || null; m.nameB = tb?.name || 'BYE';
    if (!ta && tb) m.winner = 'B';
    else if (ta && !tb) m.winner = 'A';
  }

  // Propagate byes through subsequent rounds
  for (let r = 0; r < numRounds - 1; r++) {
    for (let s = 0; s < byRound[r].length; s++) {
      const m = byRound[r][s];
      if (!m.winner) continue;
      const team = m.winner === 'A' ? { id: m.teamAId, name: m.nameA } : { id: m.teamBId, name: m.nameB };
      const nm   = byRound[r + 1][s >> 1];
      if (s % 2 === 0) { nm.teamAId = team.id; nm.nameA = team.name; }
      else             { nm.teamBId = team.id; nm.nameB = team.name; }
      if (nm.nameA === 'BYE' && nm.teamBId) nm.winner = 'B';
      else if (nm.nameB === 'BYE' && nm.teamAId) nm.winner = 'A';
    }
  }

  return byRound.flat();
}
