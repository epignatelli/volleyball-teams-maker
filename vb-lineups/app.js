// ─── Persistence ──────────────────────────────────────────────────────────────
const STORE_KEY    = 'vb-roster-v1';
const SETTINGS_KEY = 'vb-settings-v1';

function saveRoster() {
  const serializable = players.map(p => ({ ...p, positions: [...p.positions] }));
  try { localStorage.setItem(STORE_KEY, JSON.stringify(serializable)); } catch(e) {}
}
function loadRoster() {
  try {
    const d = localStorage.getItem(STORE_KEY);
    if (d) players = JSON.parse(d);
  } catch(e) {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ minWomen, splitHitters })); } catch(e) {}
}
function loadSettings() {
  try {
    const d = localStorage.getItem(SETTINGS_KEY);
    if (d) {
      const s = JSON.parse(d);
      if (typeof s.minWomen    === 'number')  minWomen    = s.minWomen;
      if (typeof s.splitHitters === 'boolean') splitHitters = s.splitHitters;
    }
  } catch(e) {}
}

// ─── State ─────────────────────────────────────────────────────────────────────
let players = [];      // { id, name, gender:'m'|'f', positions: Set }
let selectedGender = 'm';
let ALL_LINEUPS = [];
let minWomen = 2;
let splitHitters = false;

const POS_LABEL = { setter:'S', hitter:'H', outside:'OH', opposite:'OPP', middle:'M', libero:'L' };
function getPositions() {
  return splitHitters
    ? ['setter','outside','opposite','middle','libero']
    : ['setter','hitter','middle','libero'];
}

// ─── Lineup generation ─────────────────────────────────────────────────────────
function isWoman(p) { return p.gender === 'f'; }

function combos(arr, k) {
  const res = [];
  function bt(start, cur) {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); bt(i+1, cur); cur.pop(); }
  }
  bt(0, []);
  return res;
}

function generateLineups() {
  const setters = players.filter(p => p.positions.has('setter'));
  const middles = players.filter(p => p.positions.has('middle'));
  const liberos = players.filter(p => p.positions.has('libero'));
  const out = [];

  if (!splitHitters) {
    const hitters = players.filter(p => p.positions.has('hitter'));
    for (const s of setters) {
      for (const h of combos(hitters.filter(p => p.id !== s.id), 3)) {
        const used = new Set([s.id, ...h.map(p=>p.id)]);
        for (const m of combos(middles.filter(p => !used.has(p.id)), 2)) {
          const used2 = new Set([...used, ...m.map(p=>p.id)]);
          for (const l of liberos.filter(p => !used2.has(p.id))) {
            let ok = true, minW = 9;
            for (const sit of m) {
              const act = m.find(x => x.id !== sit.id);
              const active = [s, ...h, act, l];
              const wc = active.filter(isWoman).length;
              if (wc < minWomen) { ok = false; break; }
              if (wc < minW) minW = wc;
            }
            const all7 = [s, ...h, ...m, l];
            if (all7.filter(isWoman).length < minWomen) ok = false;
            if (ok) out.push({
              setter: s, hitters: h, middles: m, libero: l,
              wc: all7.filter(isWoman).length,
              tight: minW === minWomen
            });
          }
        }
      }
    }
  } else {
    const outsides  = players.filter(p => p.positions.has('outside'));
    const opposites = players.filter(p => p.positions.has('opposite'));
    for (const s of setters) {
      for (const opp of opposites.filter(p => p.id !== s.id)) {
        for (const oh of combos(outsides.filter(p => p.id !== s.id && p.id !== opp.id), 2)) {
          const used = new Set([s.id, opp.id, ...oh.map(p=>p.id)]);
          for (const m of combos(middles.filter(p => !used.has(p.id)), 2)) {
            const used2 = new Set([...used, ...m.map(p=>p.id)]);
            for (const l of liberos.filter(p => !used2.has(p.id))) {
              let ok = true, minW = 9;
              for (const sit of m) {
                const act = m.find(x => x.id !== sit.id);
                const active = [s, opp, ...oh, act, l];
                const wc = active.filter(isWoman).length;
                if (wc < minWomen) { ok = false; break; }
                if (wc < minW) minW = wc;
              }
              const all7 = [s, opp, ...oh, ...m, l];
              if (all7.filter(isWoman).length < minWomen) ok = false;
              if (ok) out.push({
                setter: s, opposite: opp, outsides: oh, middles: m, libero: l,
                wc: all7.filter(isWoman).length,
                tight: minW === minWomen
              });
            }
          }
        }
      }
    }
  }
  return out;
}

// ─── Setup screen ──────────────────────────────────────────────────────────────
function setGender(g) {
  selectedGender = g;
  document.getElementById('gender-m').className = g === 'm' ? 'active-m' : '';
  document.getElementById('gender-f').className = g === 'f' ? 'active-f' : '';
}

function addPlayer() {
  const input = document.getElementById('player-name-input');
  const name = input.value.trim();
  if (!name) return;
  if (players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    input.select();
    return;
  }
  players.push({ id: Date.now() + Math.random(), name, gender: selectedGender, positions: new Set() });
  input.value = '';
  input.focus();
  saveRoster();
  renderRoster();
  validateSetup();
}

document.getElementById('player-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addPlayer();
});

function removePlayer(id) {
  players = players.filter(p => p.id !== id);
  saveRoster();
  renderRoster();
  validateSetup();
}

function clearRoster() {
  if (!confirm('Remove all players and start fresh?')) return;
  players = [];
  saveRoster();
  renderRoster();
  validateSetup();
}

function setPlayerGender(id, g) {
  const p = players.find(p => p.id === id);
  if (!p) return;
  p.gender = g;
  saveRoster();
  renderRoster();
  validateSetup();
}

function setSplitHitters(val) {
  splitHitters = val;
  saveSettings();
  renderRoster();
  validateSetup();
}

function adjustMinWomen(delta) {
  const v = minWomen + delta;
  if (v < 0) return;
  minWomen = v;
  document.getElementById('min-women-val').textContent = minWomen;
  saveSettings();
  validateSetup();
}

function togglePosition(id, pos) {
  const p = players.find(p => p.id === id);
  if (!p) return;
  if (p.positions.has(pos)) p.positions.delete(pos);
  else p.positions.add(pos);
  saveRoster();
  renderRoster();
  validateSetup();
}

function renderRoster() {
  const list = document.getElementById('roster-list');
  const empty = document.getElementById('roster-empty');

  const clearBtn  = document.getElementById('clear-roster-btn');
  const countEl   = document.getElementById('roster-count');
  if (countEl) countEl.textContent = players.length || '';
  if (!players.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'inline';

  list.innerHTML = players.map(p => {
    const isF  = p.gender === 'f';
    const chips = getPositions().map(pos => {
      const on = p.positions.has(pos);
      return `<button class="pos-chip${on?' on-'+pos:''}" onclick="togglePosition(${p.id},'${pos}')">${POS_LABEL[pos]}</button>`;
    }).join('');
    return `
      <div class="player-item">
        <div class="gender-toggle">
          <button class="${isF?'':'active-m'}" onclick="setPlayerGender(${p.id},'m')" title="Man">♂</button>
          <button class="${isF?'active-f':''}" onclick="setPlayerGender(${p.id},'f')" title="Woman">♀</button>
        </div>
        <span class="player-name-text">${escHtml(p.name)}</span>
        <div class="player-pos-chips">${chips}</div>
        <button class="remove-player" onclick="removePlayer(${p.id})" title="Remove">×</button>
      </div>`;
  }).join('');
}

function validateSetup() {
  const msg = document.getElementById('validation-msg');
  const btn = document.getElementById('build-btn');

  const setters = players.filter(p => p.positions.has('setter'));
  const middles = players.filter(p => p.positions.has('middle'));
  const liberos = players.filter(p => p.positions.has('libero'));

  const issues = [];
  if (!setters.length)    issues.push('at least 1 setter');
  if (!splitHitters) {
    const hitters = players.filter(p => p.positions.has('hitter'));
    if (hitters.length < 3) issues.push(`at least 3 hitters (have ${hitters.length})`);
  } else {
    const outsides  = players.filter(p => p.positions.has('outside'));
    const opposites = players.filter(p => p.positions.has('opposite'));
    if (!opposites.length)   issues.push('at least 1 opposite');
    if (outsides.length < 2) issues.push(`at least 2 outside hitters (have ${outsides.length})`);
  }
  if (middles.length < 2) issues.push(`at least 2 middles (have ${middles.length})`);
  if (!liberos.length)    issues.push('at least 1 libero');

  const women = players.filter(p => p.gender === 'f');
  if (women.length < minWomen) issues.push(`at least ${minWomen} women in the roster`);

  if (issues.length) {
    msg.className = 'validation error';
    msg.style.display = 'block';
    msg.textContent = 'Need: ' + issues.join(' · ');
    btn.disabled = true;
  } else {
    msg.className = 'validation ok';
    msg.style.display = 'block';
    const count = generateLineups().length;
    msg.textContent = `✓ Ready — ${count} valid lineup${count !== 1 ? 's' : ''} found`;
    btn.disabled = false;
  }
}

// ─── Transition to results ─────────────────────────────────────────────────────
function buildLineups() {
  ALL_LINEUPS = generateLineups();
  resetFilters();
  buildFilterPanel();
  goResults();
}

function goSetup() {
  document.getElementById('screen-results').classList.remove('active');
  document.getElementById('screen-setup').classList.add('active');
}
function goResults() {
  document.getElementById('screen-setup').classList.remove('active');
  document.getElementById('screen-results').classList.add('active');
  renderResults();
}

// ─── Results screen ────────────────────────────────────────────────────────────
const filterState = {
  setter:   null,
  lib:      null,
  hitters:  new Set(),
  opposite: null,
  outsides: new Set(),
  middles:  new Set(),
  tight:    false,
  w3:       false,
  sort:     'idx'
};

function resetFilters() {
  filterState.setter   = null;
  filterState.lib      = null;
  filterState.hitters.clear();
  filterState.opposite = null;
  filterState.outsides.clear();
  filterState.middles.clear();
  filterState.tight = false;
  filterState.w3    = false;
  filterState.sort  = 'idx';
}

function buildFilterPanel() {
  const setters = [...new Set(ALL_LINEUPS.map(t => t.setter))];
  const middles = [...new Set(ALL_LINEUPS.flatMap(t => t.middles))];
  const liberos = [...new Set(ALL_LINEUPS.map(t => t.libero))];

  const uniq = arr => {
    const seen = new Set();
    return arr.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  };

  const hitterSection = splitHitters ? `
    <div class="filter-section">
      <div class="filter-section-label">Opposite <span class="filter-hint">(single select)</span></div>
      <div class="pills" id="fp-opposite">${uniq([...new Set(ALL_LINEUPS.map(t => t.opposite))]).map(p => pillHtml(p,'opposite',false)).join('')}</div>
    </div>
    <div class="filter-section">
      <div class="filter-section-label">Must include outside hitter <span class="filter-hint">(multi-select)</span></div>
      <div class="pills" id="fp-outside">${uniq([...new Set(ALL_LINEUPS.flatMap(t => t.outsides))]).map(p => pillHtml(p,'outsides',true)).join('')}</div>
    </div>` : `
    <div class="filter-section">
      <div class="filter-section-label">Must include hitter <span class="filter-hint">(multi-select)</span></div>
      <div class="pills" id="fp-hitter">${uniq([...new Set(ALL_LINEUPS.flatMap(t => t.hitters))]).map(p => pillHtml(p,'hitters',true)).join('')}</div>
    </div>`;

  const panel = document.getElementById('filter-panel');
  panel.innerHTML = `
    <div class="filter-section">
      <div class="filter-section-label">Setter <span class="filter-hint">(single select)</span></div>
      <div class="pills" id="fp-setter">${uniq(setters).map(p => pillHtml(p,'setter',false)).join('')}</div>
    </div>
    ${hitterSection}
    <div class="filter-section">
      <div class="filter-section-label">Libero <span class="filter-hint">(single select)</span></div>
      <div class="pills" id="fp-lib">${uniq(liberos).map(p => pillHtml(p,'lib',false)).join('')}</div>
    </div>
    <div class="filter-section">
      <div class="filter-section-label">Must include middle <span class="filter-hint">(multi-select)</span></div>
      <div class="pills" id="fp-middle">${uniq(middles).map(p => pillHtml(p,'middles',true)).join('')}</div>
    </div>
    <div class="filter-section">
      <div class="toggle-row">
        <div class="toggle-text">
          Rotation-sensitive only
          <small>Lineups where a middle swap could leave exactly ${minWomen} women</small>
        </div>
        <label class="switch">
          <input type="checkbox" id="chk-tight" onchange="onToggle('tight',this)" />
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="toggle-row">
        <div class="toggle-text">${minWomen + 1}+ women on court</div>
        <label class="switch">
          <input type="checkbox" id="chk-3w" onchange="onToggle('w3',this)" />
          <span class="switch-track"></span>
        </label>
      </div>
    </div>`;

  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === filterState.sort);
    btn.onclick = () => {
      filterState.sort = btn.dataset.sort;
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === filterState.sort));
      renderResults();
    };
  });
}

function pillHtml(player, key, multi) {
  const w = isWoman(player);
  const dotColor = w ? 'var(--green)' : 'var(--purple)';
  return `<button class="pill" data-id="${player.id}" data-key="${key}" data-multi="${multi}" onclick="togglePill(this,'${key}',${multi})">
    <span class="pdot" style="background:${dotColor}"></span>${escHtml(player.name)}
  </button>`;
}

function togglePill(btn, key, multi) {
  const id = parseFloat(btn.dataset.id);
  const player = players.find(p => p.id === id);
  if (!player) return;
  const w = isWoman(player);
  const selClass = w ? 'sel-w' : 'sel-m';

  if (multi) {
    if (filterState[key].has(id)) {
      filterState[key].delete(id);
      btn.classList.remove('sel-w','sel-m');
    } else {
      filterState[key].add(id);
      btn.classList.add(selClass);
    }
  } else {
    const prev = filterState[key];
    if (prev === id) {
      filterState[key] = null;
      btn.classList.remove('sel-w','sel-m');
    } else {
      document.querySelectorAll(`.pill[data-key="${key}"]`).forEach(b => b.classList.remove('sel-w','sel-m'));
      filterState[key] = id;
      btn.classList.add(selClass);
    }
  }
  renderResults();
}

function onToggle(key, el) {
  filterState[key] = el.checked;
  renderResults();
}

function clearFilters() {
  resetFilters();
  document.querySelectorAll('#filter-panel .pill').forEach(b => b.classList.remove('sel-w','sel-m'));
  const ct = document.getElementById('chk-tight');
  const c3 = document.getElementById('chk-3w');
  if (ct) ct.checked = false;
  if (c3) c3.checked = false;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === 'idx'));
  renderResults();
}

function getFiltered() {
  return ALL_LINEUPS.filter(t => {
    if (filterState.setter && t.setter.id !== filterState.setter) return false;
    if (filterState.lib    && t.libero.id !== filterState.lib)    return false;
    if (!splitHitters) {
      for (const id of filterState.hitters) if (!t.hitters.find(p => p.id === id)) return false;
    } else {
      if (filterState.opposite && t.opposite.id !== filterState.opposite) return false;
      for (const id of filterState.outsides) if (!t.outsides.find(p => p.id === id)) return false;
    }
    for (const id of filterState.middles) if (!t.middles.find(p => p.id === id)) return false;
    if (filterState.tight && !t.tight) return false;
    if (filterState.w3    && t.wc < minWomen + 1) return false;
    return true;
  });
}

function getSorted(arr) {
  const a = [...arr];
  if (filterState.sort === 'wdesc') a.sort((x,y) => y.wc - x.wc);
  else if (filterState.sort === 'wasc')  a.sort((x,y) => x.wc - y.wc);
  else if (filterState.sort === 'tight') a.sort((x,y) => x.tight === y.tight ? 0 : x.tight ? -1 : 1);
  return a;
}

function renderResults() {
  const filtered = getFiltered();
  const sorted   = getSorted(filtered);

  document.getElementById('lineup-count').textContent = `${sorted.length} / ${ALL_LINEUPS.length}`;
  document.getElementById('results-meta-label').textContent =
    `Showing ${sorted.length} of ${ALL_LINEUPS.length} lineup${ALL_LINEUPS.length !== 1 ? 's' : ''}`;

  const container = document.getElementById('cards');
  if (!sorted.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🏐</div>
        <p>No lineups match your filters.<br>Try removing some constraints.</p>
      </div>`;
    return;
  }

  container.innerHTML = sorted.map(t => {
    const idx = ALL_LINEUPS.indexOf(t) + 1;
    return `
      <div class="card${t.tight ? ' warn' : ''}">
        <div class="card-top">
          <div class="card-wc">${t.wc}<span class="card-wc-label">women</span></div>
          <div class="card-right">
            ${t.tight ? '<span class="tag tag-a">⚠ tight</span>' : ''}
            <span class="card-num">#${idx}</span>
          </div>
        </div>
        <div class="court${splitHitters ? ' court-5' : ''}">
          <div class="slot">
            <div class="slot-role">Setter</div>
            <div class="slot-names">${pname(t.setter)}</div>
          </div>
          ${splitHitters ? `
          <div class="slot">
            <div class="slot-role">Opp</div>
            <div class="slot-names">${pname(t.opposite)}</div>
          </div>
          <div class="slot">
            <div class="slot-role">Outside</div>
            <div class="slot-names">${t.outsides.map(pname).join('')}</div>
          </div>` : `
          <div class="slot">
            <div class="slot-role">Hitters</div>
            <div class="slot-names">${t.hitters.map(pname).join('')}</div>
          </div>`}
          <div class="slot">
            <div class="slot-role">Middle</div>
            <div class="slot-names">${t.middles.map(pname).join('')}</div>
          </div>
          <div class="slot">
            <div class="slot-role">Libero</div>
            <div class="slot-names">${pname(t.libero)}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function pname(player) {
  const w = isWoman(player);
  return `<span class="pname${w?' w':''}">${escHtml(player.name)}</span>`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── PWA install ───────────────────────────────────────────────────────────────
let installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  document.getElementById('install-btn').style.display = 'inline-flex';
});

window.addEventListener('appinstalled', () => {
  document.getElementById('install-btn').style.display = 'none';
  installPrompt = null;
});

function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt.userChoice.then(() => { installPrompt = null; });
    document.getElementById('install-btn').style.display = 'none';
    return;
  }
  // iOS Safari: no prompt API, show manual instructions
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (isIOS) {
    const toast = document.getElementById('install-toast');
    toast.style.display = toast.style.display === 'none' ? 'flex' : 'none';
  }
}

// Show install button on iOS if not already in standalone mode
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) {
  document.getElementById('install-btn').style.display = 'inline-flex';
}

// ─── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
loadSettings();
loadRoster();
// Re-hydrate position Sets (JSON serialises Set as {}, so we store as arrays)
players = players.map(p => ({ ...p, positions: new Set(Array.isArray(p.positions) ? p.positions : []) }));
document.getElementById('min-women-val').textContent = minWomen;
const splitToggleEl = document.getElementById('split-hitters-toggle');
if (splitToggleEl) splitToggleEl.checked = splitHitters;
renderRoster();
validateSetup();
