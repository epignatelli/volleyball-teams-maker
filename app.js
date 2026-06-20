// ── Data ──────────────────────────────────────────────────
const WOMEN   = new Set(['Marina','Josie','Maria','Taylor']);
const SETTERS = ['Dwain','Taylor'];
const HITTERS = ['Edu','Oz','Dwain','Loki','Marina','Josie'];
const MIDDLES = ['Edu','Oz','Loki','Marina'];
const LIBS    = ['Maria','Oz'];

const isW = n => WOMEN.has(n);

function combos(arr, k) {
  const res = [];
  function bt(start, cur) {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); bt(i+1, cur); cur.pop(); }
  }
  bt(0, []);
  return res;
}

function generateAll() {
  const out = [];
  for (const s of SETTERS) {
    for (const h of combos(HITTERS.filter(p => p !== s), 3)) {
      const u = new Set([s, ...h]);
      for (const m of combos(MIDDLES.filter(p => !u.has(p)), 2)) {
        const u2 = new Set([...u, ...m]);
        for (const l of LIBS.filter(p => !u2.has(p))) {
          let ok = true, minW = 9;
          for (const sit of m) {
            const act = m.find(x => x !== sit);
            const wc = [s, ...h, act, l].filter(isW).length;
            if (wc < 2) { ok = false; break; }
            if (wc < minW) minW = wc;
          }
          if ([s,...h,...m,l].filter(isW).length < 2) ok = false;
          if (ok) out.push({ s, h, m, l, wc: [s,...h,...m,l].filter(isW).length, tight: minW === 2 });
        }
      }
    }
  }
  return out;
}

const ALL = generateAll();

// ── State ─────────────────────────────────────────────────
const state = {
  setter:  null,
  lib:     null,
  hitters: new Set(),
  middles: new Set(),
  tight:   false,
  w3:      false,
  sort:    'idx'
};

// ── Build UI ──────────────────────────────────────────────
function makePill(player, key, multi) {
  const btn = document.createElement('button');
  btn.className = 'pill' + (isW(player) ? ' woman' : '');
  btn.dataset.player = player;
  btn.dataset.key = key;
  btn.innerHTML = `<span class="dot"></span>${player}`;
  btn.addEventListener('click', () => togglePill(btn, player, key, multi));
  return btn;
}

function buildFilters() {
  const pg = id => document.getElementById(id);
  [['pg-setter', SETTERS, 'setter', false],
   ['pg-lib',    LIBS,    'lib',    false],
   ['pg-hitter', [...new Set(HITTERS)], 'hitters', true],
   ['pg-middle', [...new Set(MIDDLES)], 'middles', true],
  ].forEach(([id, players, key, multi]) => {
    const el = pg(id);
    players.forEach(p => el.appendChild(makePill(p, key, multi)));
  });
}

function togglePill(btn, player, key, multi) {
  const woman = isW(player);
  const selClass = woman ? 'sel-woman' : 'sel-man';
  if (multi) {
    if (state[key].has(player)) {
      state[key].delete(player);
      btn.classList.remove(selClass);
    } else {
      state[key].add(player);
      btn.classList.add(selClass);
    }
  } else {
    if (state[key] === player) {
      state[key] = null;
      btn.classList.remove('sel-woman','sel-man');
    } else {
      // Deselect others in same group
      document.querySelectorAll(`.pill[data-key="${key}"]`).forEach(b => b.classList.remove('sel-woman','sel-man'));
      state[key] = player;
      btn.classList.add(selClass);
    }
  }
  render();
}

function clearAll() {
  state.setter = null; state.lib = null;
  state.hitters.clear(); state.middles.clear();
  state.tight = false; state.w3 = false;
  document.querySelectorAll('.pill').forEach(b => b.classList.remove('sel-woman','sel-man'));
  document.getElementById('chk-tight').checked = false;
  document.getElementById('chk-3w').checked = false;
  render();
}

function setSort(mode) {
  state.sort = mode;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
  render();
}

// ── Filter + sort ─────────────────────────────────────────
function getFiltered() {
  return ALL.filter(t => {
    if (state.setter && t.s !== state.setter) return false;
    if (state.lib    && t.l !== state.lib)    return false;
    for (const p of state.hitters) if (!t.h.includes(p)) return false;
    for (const p of state.middles) if (!t.m.includes(p)) return false;
    if (state.tight && !t.tight) return false;
    if (state.w3    && t.wc < 3) return false;
    return true;
  });
}

function getSorted(arr) {
  const a = [...arr];
  if (state.sort === 'wdesc') a.sort((x,y) => y.wc - x.wc);
  else if (state.sort === 'wasc')  a.sort((x,y) => x.wc - y.wc);
  else if (state.sort === 'tight') a.sort((x,y) => x.tight === y.tight ? 0 : x.tight ? -1 : 1);
  return a;
}

// ── Render ────────────────────────────────────────────────
function pn(name) {
  return `<span class="pname${isW(name)?' w':''}">${name}</span>`;
}

function render() {
  const filtered = getFiltered();
  const sorted   = getSorted(filtered);

  // Count badge
  const badge = document.getElementById('count-badge');
  badge.innerHTML = `<span>${sorted.length}</span> / ${ALL.length} lineups`;

  const container = document.getElementById('cards');
  if (!sorted.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🏐</div>
        <p>No lineups match your filters.<br>Try removing some.</p>
      </div>`;
    return;
  }

  container.innerHTML = sorted.map(t => `
    <div class="card${t.tight?' warn':''}">
      <div class="card-top">
        <span class="card-num">Lineup #${ALL.indexOf(t)+1}</span>
        <div class="tags">
          <span class="tag tag-g">${t.wc} women</span>
          ${t.tight ? '<span class="tag tag-a">⚠ rotation-sensitive</span>' : ''}
        </div>
      </div>
      <div class="court">
        <div class="slot">
          <div class="slot-role">Setter</div>
          <div class="slot-names">${pn(t.s)}</div>
        </div>
        <div class="slot">
          <div class="slot-role">Hitters</div>
          <div class="slot-names">${t.h.map(pn).join('')}</div>
        </div>
        <div class="slot">
          <div class="slot-role">Middles</div>
          <div class="slot-names">${t.m.map(pn).join('')}</div>
        </div>
        <div class="slot">
          <div class="slot-role">Libero</div>
          <div class="slot-names">${pn(t.l)}</div>
        </div>
      </div>
    </div>`).join('');
}

// ── PWA Install ───────────────────────────────────────────
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  document.getElementById('install-banner').classList.remove('hidden');
});
document.getElementById('install-btn').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  if (outcome === 'accepted') document.getElementById('install-banner').classList.add('hidden');
  deferredInstall = null;
});
window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').classList.add('hidden');
});

// ── Sort buttons ──────────────────────────────────────────
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => setSort(btn.dataset.sort));
});

// ── Toggle checkboxes ─────────────────────────────────────
document.getElementById('chk-tight').addEventListener('change', e => { state.tight = e.target.checked; render(); });
document.getElementById('chk-3w').addEventListener('change', e => { state.w3 = e.target.checked; render(); });

document.getElementById('clear-btn').addEventListener('click', clearAll);

// ── Service worker ────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ── Init ──────────────────────────────────────────────────
buildFilters();
render();
