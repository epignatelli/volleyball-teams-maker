// ─── Constants ─────────────────────────────────────────────────────────────────
const SESSION_TYPES = [
  { value: 'game',       label: 'Game' },
  { value: 'league',     label: 'League' },
  { value: 'clinic',     label: 'Clinic' },
  { value: 'kqotc',     label: 'KQOTC' },
  { value: 'tournament', label: 'Tournament' },
  { value: 'tryout',     label: 'Tryout' },
  { value: 'training',   label: 'Training' },
];
const SESSION_GENDERS = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'women', label: 'Women' },
  { value: 'men',   label: 'Men' },
];

// ─── State ─────────────────────────────────────────────────────────────────────
let _currentUser  = null;
let _currentRoles = [];
let _isAdmin                  = false;
let _isCoach                  = false;
let _isProvider               = false;
let _isOwner                  = false;
let _providerOnboardingComplete = false;
let _legacyAdmin  = false;   // cached check against admins/{email} collection
let _userDocUnsub = null;    // unsubscribe fn for own user doc listener
let _editingId              = null;   // session ID being edited, null when creating
let _pendingJoinSessionId   = null;   // session to join after sign-in completes
let _pendingProfileNeeds    = {};     // { needsGender, needsPositions } for profile overlay
let _editingAttendeeSession = null;   // sessionId when editing own attendee entry (positions)
let _currentSession         = null;   // session data for the open detail panel
let _currentAttendees       = [];     // attendee list for the open session (used for CSV export)

// Handle return from Stripe Checkout before Firebase initialises.
// Stripe appends ?checkout=success|cancelled&session=ID to the success/cancel URLs.
// We convert this to a hash route immediately so normal routing takes over,
// and stash the success flag to show a toast after auth resolves.
let _pendingCheckoutSuccess = null;
let _seriesInvite           = null; // { seriesId, token } when user arrived via a valid invite link
(function _handleUrlParams() {
  const p        = new URLSearchParams(window.location.search);
  const status   = p.get('checkout');
  const type     = p.get('type');
  const sid      = p.get('session');
  const seriesId = p.get('seriesId');
  const joinId   = p.get('join');
  const token    = p.get('token');

  // Invite link: ?join={seriesId}&token={token}
  if (joinId && token) {
    _seriesInvite = { seriesId: joinId, token };
    history.replaceState(null, '', window.location.pathname + '#series/' + joinId);
    return; // hash routing will handle navigation
  }

  // Stripe return
  if (!status) return;
  if (type === 'series' && seriesId) {
    history.replaceState(null, '', window.location.pathname + '#series/' + seriesId);
    if (status === 'success') _pendingCheckoutSuccess = 'series:' + seriesId;
  } else if (sid) {
    history.replaceState(null, '', window.location.pathname + '#session/' + sid);
    if (status === 'success') _pendingCheckoutSuccess = sid;
  }
})();

// ─── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', type === 'error');
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ─── Firebase ──────────────────────────────────────────────────────────────────
function getDb()   { return firebase.firestore(); }
function getAuth() { return firebase.auth(); }

const FN_BASE = 'https://europe-west2-roots-kqotc.cloudfunctions.net';
async function callFn(name, body) {
  const token = await _currentUser.getIdToken();
  const res   = await fetch(`${FN_BASE}/${name}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error(`Server error (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function _sessionsRef()              { return getDb().collection('sessions'); }
function _sessionRef(id)             { return _sessionsRef().doc(id); }
function _attendeesRef(sessionId)    { return _sessionRef(sessionId).collection('attendees'); }
function _sessionHistoryRef(uid)     { return _userRef(uid).collection('sessions'); }
function _usersRef()              { return getDb().collection('users'); }
function _userRef(uid)            { return _usersRef().doc(uid); }

// ─── User doc ──────────────────────────────────────────────────────────────────
async function _upsertUserDoc(user) {
  const ref = _userRef(user.uid);
  try {
    const doc          = await ref.get();
    const currentRoles = doc.data()?.roles || [];
    // Sync legacy admin status into roles (bootstrap path)
    let roles = currentRoles.length ? currentRoles : ['player'];
    if (_legacyAdmin && !roles.includes('admin')) roles = [...roles, 'admin'];
    if (_legacyAdmin && !roles.includes('owner')) roles = [...roles, 'owner'];

    if (doc.exists) {
      await ref.update({
        name:      user.displayName || doc.data().name || '',
        email:     user.email || '',
        photoURL:  user.photoURL || '',
        roles,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await ref.set({
        name:      user.displayName || '',
        email:     user.email || '',
        photoURL:  user.photoURL || '',
        roles,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch(e) { console.error('Upsert user doc failed:', e); }
}

async function _maybeShowOnboarding(user) {
  try {
    const doc  = await _userRef(user.uid).get();
    const data = doc.data() || {};
    if (!data.name && !data.gender) {
      await openEditProfile();
    }
  } catch(e) {}
}

function _subscribeToUserDoc(user) {
  if (_userDocUnsub) { _userDocUnsub(); _userDocUnsub = null; }
  _userDocUnsub = _userRef(user.uid).onSnapshot(doc => {
    _currentRoles = (doc.data()?.roles) || ['player'];
    _isOwner = _currentRoles.includes('owner');
    _isAdmin    = _legacyAdmin || _isOwner || _currentRoles.includes('admin');
    _isCoach    = _currentRoles.includes('coach');
    _isProvider = _currentRoles.includes('provider');
    _providerOnboardingComplete = !!doc.data()?.providerOnboardingComplete;
    _updateAuthUI();
    if (_pendingProviderRequest) {
      _pendingProviderRequest = false;
      if (_isProvider) _showProviderSessions(_currentUser?.uid);
      else openProfileScreen();
    } else if (document.querySelector('.screen.active')?.id === 'screen-home') {
      renderHome();
    }
  }, err => console.error('User doc listener error:', err));
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
async function handleAuthClick() {
  if (_currentUser) {
    await getAuth().signOut();
  } else {
    const provider = new firebase.auth.GoogleAuthProvider();
    try { await getAuth().signInWithPopup(provider); }
    catch(e) { if (e.code !== 'auth/popup-closed-by-user') console.error(e); }
  }
}

// ─── Nav helpers ───────────────────────────────────────────────────────────────
let _backFn              = null;
let _pendingCoachRequest    = false;
let _pendingProviderRequest = false;
let _activeSeriesFilter     = null; // { id, name } or null
let _activeProviderFilter   = null; // uid to filter "my sessions", or null
let _activeLevelFilter      = null; // level string or null
let _activeSeries        = null; // full series doc data when in filtered mode
let _activeSeriesReg     = null; // user's paid registration for _activeSeries, or null
let _activeSeriesMembers = []; // paid registrations for current series (admin view)
let _allSeries           = [];
let _editingSeriesId     = null;

function _canCreate() {
  return _isProvider && _providerOnboardingComplete;
}

function _setNav(mode, activeTab) {
  const tabsRow = document.getElementById('nav-tabs-row');
  const backBtn = document.getElementById('nav-back-btn');
  const isPrimary = mode === 'primary';
  const showTabs  = isPrimary && !!_currentUser;
  if (tabsRow) tabsRow.style.display = showTabs ? 'flex' : 'none';
  if (backBtn) backBtn.style.display = isPrimary ? 'none' : '';
  document.documentElement.style.setProperty('--header-h', showTabs ? '95px' : '55px');
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.style.display = _isAdmin ? '' : 'none';
  });
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', !!activeTab && t.dataset.tab === activeTab)
  );
}

function _setTitle(title) {
  const el = document.getElementById('nav-screen-title');
  if (el) el.textContent = title || '';
}

function _setBack(fn) { _backFn = fn; }
function _navBack() { if (_backFn) _backFn(); }

function _updateAuthUI() {
  const avatarWrap = document.getElementById('nav-avatar-wrap');
  if (avatarWrap) {
    if (_currentUser) {
      const photo    = _currentUser.photoURL;
      const initials = (_currentUser.displayName || _currentUser.email || '?')[0].toUpperCase();
      avatarWrap.innerHTML = `<button class="avatar-btn" onclick="openProfileScreen()" title="Profile">${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials)}</button>`;
    } else {
      avatarWrap.innerHTML = `<button class="auth-btn" onclick="handleAuthClick()">Sign in</button>`;
    }
  }
  const newBtn = document.getElementById('home-new-btn');
  if (newBtn) newBtn.style.display = _canCreate() ? '' : 'none';
  // Refresh admin-only tabs and tab strip visibility
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.style.display = _isAdmin ? '' : 'none';
  });
  const seriesFooter = document.getElementById('series-footer');
  if (seriesFooter) seriesFooter.style.display = _canCreate() ? '' : 'none';
  const tabsRow = document.getElementById('nav-tabs-row');
  if (tabsRow && !_currentUser) {
    tabsRow.style.display = 'none';
    document.documentElement.style.setProperty('--header-h', '55px');
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
let _initialRouted = false;

getAuth().onAuthStateChanged(async user => {
  _currentUser = user;

  if (_userDocUnsub) { _userDocUnsub(); _userDocUnsub = null; }

  if (user) {
    _updateAuthUI();

    try {
      const adminDoc = await getDb().collection('admins').doc(user.email).get();
      _legacyAdmin = adminDoc.exists;
    } catch(e) { _legacyAdmin = false; }

    _isAdmin = _legacyAdmin;
    _updateAuthUI();

    if (!_initialRouted) {
      _initialRouted = true;
      await _routeFromHash();
      if (_pendingCheckoutSuccess) {
        if (_pendingCheckoutSuccess.startsWith('series:')) {
          showToast('Series pass confirmed! You\'re enrolled in all sessions.');
        } else {
          showToast('Payment confirmed! You\'re in.');
        }
        _pendingCheckoutSuccess = null;
      }
    } else renderHome();

    await _upsertUserDoc(user);
    _subscribeToUserDoc(user);
    _maybeShowOnboarding(user);

    if (_pendingJoinSessionId) {
      const sid = _pendingJoinSessionId;
      _pendingJoinSessionId = null;
      await register(sid);
    }

    if (_pendingCoachRequest) {
      _pendingCoachRequest = false;
      openProfileScreen();
    }
  } else {
    _currentRoles = [];
    _isAdmin                   = false;
    _isCoach                   = false;
    _isProvider                 = false;
    _isOwner                    = false;
    _legacyAdmin                = false;
    _providerOnboardingComplete = false;
    _pendingProviderRequest     = false;
    _updateAuthUI();
    if (!_initialRouted) { _initialRouted = true; await _routeFromHash(); }
    else renderHome();
  }
});

// Browser back/forward → route within the app instead of exiting
window.addEventListener('popstate', () => { _routeFromHash(); });

// Firestore .get() can stall indefinitely on mobile after cross-origin navigation
// (e.g. returning from Stripe checkout). Race against a 12-second timeout so the
// catch handler can show a retry message rather than an infinite spinner.
function _fsGet(ref) {
  return Promise.race([
    ref.get(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000)),
  ]);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById('screen-' + id);
  screen.classList.add('active');
  if (!screen.querySelector('.roots-footer')) {
    screen.insertAdjacentHTML('beforeend',
      `<footer class="roots-footer">
        <a class="roots-footer-link" href="../">Roots</a>
        <span class="roots-footer-dot">·</span>
        <span class="roots-footer-link dim">About</span>
        <span class="roots-footer-dot">·</span>
        <a class="roots-footer-link" href="../policy/">Policy</a>
      </footer>`);
  }
}

function _setHash(hash) {
  const next = '#' + hash;
  if (location.hash === next) return; // already here — avoid duplicate history entry
  history.pushState(null, '', next);
}

async function _routeFromHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (!hash || hash === 'home') { goHome(); return; }
  if (hash === 'users')         { if (_isAdmin) openUsersScreen();    else renderHome(); return; }
  if (hash === 'finances')      { if (_isAdmin) openFinancesScreen(); else renderHome(); return; }
  if (hash === 'insights')      { if (_isAdmin) openInsightsScreen(); else renderHome(); return; }
  if (hash === 'venues')        { if (_isAdmin) openVenuesScreen();   else renderHome(); return; }
  if (hash === 'admin')         { if (_isAdmin) openAdminScreen();    else renderHome(); return; }
  if (hash === 'series')        { openSeriesScreen(); return; }
  if (hash === 'coach') {
    if (_currentUser) { openProfileScreen(); }
    else { _pendingCoachRequest = true; goHome(); showToast('Sign in to request coach status'); }
    return;
  }
  if (hash === 'provider') {
    if (!_currentUser) {
      _pendingProviderRequest = true;
      goHome();
      showToast('Sign in to start hosting sessions on Roots');
    } else if (_currentRoles.length > 0) {
      // User doc already loaded — route immediately
      if (_isProvider) _showProviderSessions(_currentUser.uid);
      else {
        history.replaceState(null, '', '#home'); // don't leave #provider in back-stack
        openProfileScreen();
      }
    } else {
      // User doc not yet loaded (page-load race) — let the first snapshot handle it
      _pendingProviderRequest = true;
      goHome();
    }
    return;
  }
  const slash   = hash.indexOf('/');
  const section = slash > -1 ? hash.slice(0, slash) : hash;
  const id      = slash > -1 ? hash.slice(slash + 1) : '';
  if (section === 'pass' && id) {
    await openSeriesDetail(id).catch(() => openSeriesScreen());
  }
  else if (section === 'series' && id) {
    // Used by invite links — goes directly to filtered session list
    try {
      const doc = await _seriesRef(id).get();
      if (doc.exists) await openSeriesSessions(id, doc.data().name);
      else openSeriesScreen();
    } catch(e) { openSeriesScreen(); }
  }
  else if (section === 'profile')         { if (_currentUser) await openProfileScreen(id || undefined); else renderHome(); }
  else if (section === 'session' && id)  { await openSession(id); }
  else if (section === 'run'     && id)  { await openSessionRun(id); }
  else if (section === 'end'     && id)  {
    try {
      await _loadRunSessionData(id);
      showScreen('session-end');
      _setNav('sub', null);
      _setBack(() => closeSessionEnd());
      _renderSessionEnd();
    } catch(e) { renderHome(); }
  }
  else { renderHome(); }
}

function setLevelFilter(level) {
  _activeLevelFilter = level || null;
  document.querySelectorAll('.level-pill').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.level || '') === (level || ''));
  });
  renderHome();
}

function goHome() {
  _activeSeriesFilter   = null;
  _activeSeries         = null;
  _activeSeriesReg      = null;
  _activeSeriesMembers  = [];
  _activeProviderFilter = null;
  _setHash('home');
  showScreen('home');
  _setNav('primary', 'home');
  _setTitle('Sessions');
  renderHome();
}

function _showProviderSessions(uid) {
  _activeSeriesFilter   = null;
  _activeSeries         = null;
  _activeSeriesReg      = null;
  _activeSeriesMembers  = [];
  _activeProviderFilter = uid;
  _setHash('home');
  showScreen('home');
  _setNav('primary', 'home');
  _setTitle('My sessions');
  renderHome();
}

function openAdminScreen() {
  if (!_isAdmin) return;
  _setHash('admin');
  showScreen('admin');
  _setNav('primary', 'admin');
  _setTitle('Sessions');
}

function _formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function _formatCost(cost) {
  if (!cost) return 'Free';
  return `£${Number(cost).toFixed(2).replace(/\.00$/, '')}`;
}

function _playerPrice(adminPrice) {
  if (!adminPrice || adminPrice <= 0) return 0;
  const gross = (adminPrice + 0.20) / (1 - 0.015);
  return Math.ceil(gross / 0.50) * 0.50;  // round up to nearest 50p
}

function _formatPlayerPrice(adminPrice, absorbFee = false) {
  if (!adminPrice || adminPrice <= 0) return 'Free';
  const p = absorbFee ? adminPrice : _playerPrice(adminPrice);
  return `£${p.toFixed(2).replace(/\.00$/, '')}`;
}

// ── Coach payment helpers ─────────────────────────────────────────────────────
function _coachPayStatus(session) {
  const s = session.coachPaymentStatus;
  if (s === 'paid')       return 'paid';
  if (s === 'onboarding') return 'onboarding';
  return 'pending'; // null / undefined / 'pending'
}
// Small inline widget next to the coach fee in the meta grid
function _coachPayStatusWidget(session) {
  if (session.status !== 'closed') return '';
  const st = _coachPayStatus(session);
  if (st === 'paid')       return `<span class="pay-status-ok">Paid ✓</span>`;
  if (st === 'onboarding') return `<span class="pay-status-pending">Onboarding…</span> <button class="inline-pay-btn" onclick="approveCoachPayment('${session.id}')">Retry</button>`;
  return `<button class="inline-pay-btn" onclick="approveCoachPayment('${session.id}')">Approve payment</button>`;
}
// Badge for the session list card
function _coachPayBadge(s) {
  const st = _coachPayStatus(s);
  if (st === 'paid') return `<span class="session-badge coach-payment-paid">Coach paid ✓</span>`;
  if (st === 'onboarding') return `<span class="session-badge coach-payment-pending">Coach onboarding…</span>`;
  return `<button class="session-badge coach-payment-pending" onclick="event.stopPropagation();approveCoachPayment('${s.id}')">Approve coach payment</button>`;
}
// CTA button for the session detail and report footers
function _coachPayCtaBtn(session) {
  const st = _coachPayStatus(session);
  if (st === 'paid')       return `<button class="cta-btn" disabled>Coach paid ✓</button>`;
  if (st === 'onboarding') return `<button class="cta-btn warning-btn" onclick="approveCoachPayment('${session.id}')">Coach onboarding — resend link</button>`;
  return `<button class="cta-btn warning-btn" onclick="approveCoachPayment('${session.id}')">Approve coach payment — £${Number(session.coachFee).toFixed(2)}</button>`;
}

function _spotsLeft(session, attendeeCount) {
  return Math.max(0, (session.maxPlayers || 0) - attendeeCount);
}

// ─── Calendar helpers ──────────────────────────────────────────────────────────
function _calendarDates(session) {
  if (!session?.date) return null;
  const d   = session.date.toDate ? session.date.toDate() : new Date(session.date);
  const pad = n => String(n).padStart(2, '0');
  const [h = 10, m = 0] = (session.time || '10:00').split(':').map(Number);
  const y = d.getFullYear(), mo = d.getMonth() + 1, day = d.getDate();
  return {
    start: `${y}${pad(mo)}${pad(day)}T${pad(h)}${pad(m)}00`,
    end:   `${y}${pad(mo)}${pad(day)}T${pad(h + 2)}${pad(m)}00`,
    title: ['Roots Volleyball', session.venue].filter(Boolean).join(' — '),
  };
}

function _googleCalendarUrl(session) {
  const c = _calendarDates(session);
  if (!c) return null;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE` +
    `&text=${encodeURIComponent(c.title)}&dates=${c.start}/${c.end}` +
    `&location=${encodeURIComponent(session.venue || '')}`;
}

function downloadIcs() {
  const c = _calendarDates(_currentSession);
  if (!c) return;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Roots Volleyball//Sessions//EN',
    'BEGIN:VEVENT',
    `DTSTART;TZID=Europe/London:${c.start}`,
    `DTEND;TZID=Europe/London:${c.end}`,
    `SUMMARY:${c.title}`,
    _currentSession.venue ? `LOCATION:${_currentSession.venue}` : '',
    _currentSession.description ? `DESCRIPTION:${_currentSession.description.replace(/\n/g, '\\n')}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([lines], { type: 'text/calendar' })),
    download: 'session.ics',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Home screen ───────────────────────────────────────────────────────────────
async function renderHome() {
  const container = document.getElementById('home-content');
  container.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    const snap = await _sessionsRef().orderBy('date', 'asc').get();
    let sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (_activeSeriesFilter) {
      sessions = sessions.filter(s => s.seriesId === _activeSeriesFilter.id);
    }
    if (_activeProviderFilter) {
      sessions = sessions.filter(s => s.providerUid === _activeProviderFilter);
    }
    if (_activeLevelFilter === 'any') {
      sessions = sessions.filter(s => !s.level);
    } else if (_activeLevelFilter) {
      sessions = sessions.filter(s => (s.level || '') === _activeLevelFilter);
    }
    const providerBannerHtml = _activeProviderFilter
      ? `<div class="provider-banner"><span class="provider-banner-label">My sessions</span><button class="provider-banner-clear" onclick="goHome()">← All sessions</button></div>`
      : '';
    const levelLabels = { any: 'Any level', beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', competitive: 'Competitive' };
    const levelBannerHtml = _activeLevelFilter
      ? `<div class="filter-active-label">Filtering by level: <strong>${levelLabels[_activeLevelFilter] || _activeLevelFilter}</strong></div>`
      : '';
    if (!sessions.length) {
      const bannerHtml = _activeSeries ? _renderSeriesBanner(_activeSeries, _activeSeriesReg) : '';
      container.innerHTML = providerBannerHtml + levelBannerHtml + bannerHtml + `<div class="home-empty">${_activeSeriesFilter ? 'No sessions in this series yet.' : _activeProviderFilter ? 'No sessions hosted yet.' : 'No sessions matching this filter.'}</div>`;
      return;
    }

    const now    = new Date();
    now.setHours(0, 0, 0, 0);
    const upcoming = sessions.filter(s => s.date?.toDate() >= now);
    const past     = sessions.filter(s => s.date?.toDate() < now).reverse();

    // Group upcoming by date label
    const dateLabel = ts => {
      const d = ts?.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    };
    const upcomingByDate = [];
    for (const s of upcoming) {
      const label = dateLabel(s.date);
      const last  = upcomingByDate[upcomingByDate.length - 1];
      if (last && last.label === label) last.items.push(s);
      else upcomingByDate.push({ label, items: [s] });
    }

    const bannerHtml = _activeSeries ? _renderSeriesBanner(_activeSeries, _activeSeriesReg) : '';
    const upcomingHtml = levelBannerHtml + upcomingByDate.map(g => `
      <div class="session-group">
        <div class="session-group-label">${g.label}</div>
        ${g.items.map(_renderSessionCard).join('')}
      </div>`).join('');
    const pastHtml = past.length ? `
      <div class="session-group">
        <div class="session-group-label">Past</div>
        ${past.map(_renderSessionCard).join('')}
      </div>` : '';
    container.innerHTML = providerBannerHtml + bannerHtml + upcomingHtml + pastHtml;

  } catch(e) {
    container.innerHTML = '<div class="home-empty">Couldn\'t load sessions. Check your connection.</div>';
    console.error(e);
  }
}

async function copySeriesInviteLink(seriesId) {
  if (!_currentUser) return;
  try {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(18)))
      .map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
    await _seriesColRef().doc(seriesId).collection('invites').doc(token).set({
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: _currentUser.uid,
    });
    const url = `${window.location.origin}${window.location.pathname}?join=${seriesId}&token=${token}#series/${seriesId}`;
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url).catch(() => _fallbackCopy(url));
    } else {
      _fallbackCopy(url);
    }
    showToast('Invite link copied!');
  } catch(e) {
    console.error('Failed to generate invite:', e);
    showToast('Couldn\'t generate invite link.', 'error');
  }
}
function _fallbackCopy(text) {
  const inp = document.createElement('input');
  inp.value = text;
  document.body.appendChild(inp);
  inp.select();
  document.execCommand('copy');
  document.body.removeChild(inp);
}

function _renderSeriesBanner(series, reg) {
  const isFull    = series.maxPlayers > 0 && (series.memberCount || 0) >= series.maxPlayers;
  const cost      = series.cost > 0 ? `£${series.cost}` : 'Free';
  const memberStr = series.maxPlayers
    ? `${series.memberCount || 0} / ${series.maxPlayers} members`
    : series.memberCount ? `${series.memberCount} member${series.memberCount !== 1 ? 's' : ''}` : '';
  const startStr  = series.startDate ? _formatDate(series.startDate) : '';
  const endStr    = series.endDate   ? _formatDate(series.endDate)   : '';
  const dateRange = startStr && endStr ? `${startStr} – ${endStr}` : startStr || endStr || '';
  const meta      = [cost, isFull ? `${memberStr} · Full` : memberStr, dateRange].filter(Boolean).join(' · ');

  let cta = '';
  if (reg) {
    cta = `<span class="session-badge series-pass-badge">Series pass ✓</span>`;
  } else if (_currentUser && !isFull) {
    const label = series.cost > 0 ? `Join series — ${cost}` : 'Join series — Free';
    cta = `<button class="cta-btn series-banner-cta" onclick="joinSeries('${series.id}')">${label}</button>`;
  } else if (_currentUser && isFull && _seriesInvite?.seriesId === series.id) {
    const label = series.cost > 0 ? `Join series — ${cost}` : 'Join series — Free';
    cta = `<button class="cta-btn series-banner-cta" onclick="joinSeries('${series.id}')">${label}</button>
           <div class="series-invite-note">You were invited — joining will extend the pass by one spot.</div>`;
  } else if (isFull) {
    cta = `<span class="session-badge full-badge">Pass full</span>`;
  }

  const copyBtn = _isAdmin
    ? `<button class="series-copy-link-btn" onclick="copySeriesInviteLink('${series.id}')">Copy invite link</button>`
    : '';

  return `<div class="series-banner">
    ${series.description ? `<div class="series-banner-desc">${esc(series.description)}</div>` : ''}
    ${meta ? `<div class="series-banner-meta">${meta}</div>` : ''}
    <div class="series-banner-actions">${cta}${copyBtn}</div>
  </div>`;
}

function _renderSeriesMembersSection(members) {
  if (!members.length) return `<div class="series-members-section"><div class="detail-section-title">Members (0)</div><div class="empty-note">No one has bought a pass yet.</div></div>`;
  const rows = members.map((m, i) => _isAdmin
    ? `<div class="attendee-row">
        <span class="attendee-num">${i + 1}</span>
        <button class="attendee-name-btn" onclick="openProfileScreen('${m.uid}')">${esc(m.name || m.email || '—')}</button>
        <span class="attendee-email">${esc(m.email || '')}</span>
        <span class="att-chip paid-chip">${m.amountPaid > 0 ? `£${m.amountPaid}` : 'Free'}</span>
        <span class="history-date" style="margin-left:auto;font-size:11px;color:var(--muted)">${_formatDate(m.registeredAt)}</span>
       </div>`
    : `<div class="attendee-row">
        <span class="attendee-num">${i + 1}</span>
        <button class="attendee-name-btn" onclick="openProfileScreen('${m.uid}')">${esc(m.name || '—')}</button>
       </div>`
  ).join('');
  return `
    <div class="series-members-section">
      <div class="detail-section-title">Members (${members.length})</div>
      <div class="attendee-list">${rows}</div>
    </div>`;
}

function _renderSessionCard(s) {
  const statusClass = s.status === 'cancelled' ? 'cancelled' : s.status === 'full' ? 'full' : s.status === 'closed' ? 'closed' : 'open';
  const statusLabel = s.status === 'cancelled' ? 'Cancelled' : s.status === 'full' ? 'Full' : s.status === 'closed' ? 'Closed' : 'Open';
  const dateStr     = _formatDate(s.date);
  const timeStr     = s.time || '';
  const costStr     = _formatPlayerPrice(s.cost, s.absorbFee);
  const countStr    = s.attendeeCount != null ? `${s.attendeeCount}/${s.maxPlayers}` : `0/${s.maxPlayers}`;
  const levelLabel  = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', competitive: 'Competitive' }[s.level] || '';
  const typeLabel   = SESSION_TYPES.find(t => t.value === s.type)?.label || '';
  const genderLabel = SESSION_GENDERS.find(g => g.value === s.gender)?.label || '';
  return `
    <div class="session-card" onclick="openSession('${s.id}')">
      <div class="session-card-main">
        <div class="session-date">${esc(dateStr)}${timeStr ? ` · ${esc(timeStr)}` : ''}</div>
        <div class="session-venue">${esc(s.venue || '—')}${s.coach ? ` · ${esc(s.coach)}` : ''}</div>
        ${s.description ? `<div class="session-desc">${esc(s.description)}</div>` : ''}
      </div>
      <div class="session-card-meta">
        <span class="session-badge ${statusClass}">${statusLabel}</span>
        ${levelLabel   ? `<span class="session-badge level">${esc(levelLabel)}</span>` : ''}
        ${typeLabel    ? `<span class="session-badge type-${esc(s.type)}">${esc(typeLabel)}</span>` : ''}
        ${genderLabel  ? `<span class="session-badge gender-${esc(s.gender)}">${esc(genderLabel)}</span>` : ''}
        ${s.seriesName && !_activeSeriesFilter ? `<span class="session-badge series-ref">${esc(s.seriesName)}</span>` : ''}
        ${_isAdmin && s.coach && s.coachFee > 0 && s.status === 'closed' ? _coachPayBadge(s) : ''}
        <span class="session-meta-item">👥 ${countStr}</span>
        <span class="session-meta-item">${esc(costStr)}</span>
      </div>
      ${(_isAdmin || (_isProvider && _currentUser && s.providerUid === _currentUser.uid)) ? `
        <div class="session-admin-btns" onclick="event.stopPropagation()">
          <button class="icon-btn" onclick="openSessionForm('${s.id}')" title="Edit">✎</button>
          ${_isAdmin ? `<button class="icon-btn danger" onclick="deleteSession('${s.id}','${esc(s.venue || '')}',this)" title="Delete">✕</button>` : ''}
        </div>` : ''}
    </div>`;
}

// ─── Session detail ────────────────────────────────────────────────────────────
async function openSession(id) {
  _setHash('session/' + id);
  showScreen('detail');
  _setNav('sub', null);
  _setTitle('Session');
  _setBack(() => history.back());
  const content = document.getElementById('detail-content');
  const footer  = document.getElementById('detail-footer');
  content.innerHTML = '<div class="home-empty">Loading…</div>';
  footer.innerHTML  = '';

  try {
    const sessionDoc = await _fsGet(_sessionRef(id));
    if (!sessionDoc.exists) { goHome(); return; }

    const session = { id: sessionDoc.id, ...sessionDoc.data() };
    _currentSession = session;
    let attendees   = [];
    let isAttending = false;

    let waitingList         = [];
    let myWaitingListPos    = 0; // 0 = not on list

    if (_currentUser) {
      const wlRef = getDb().collection('sessions').doc(id).collection('waitingList');
      const [attendeesSnap, ownWlSnap] = await Promise.all([
        _fsGet(_attendeesRef(id).orderBy('joinedAt', 'asc')),
        _fsGet(wlRef.doc(_currentUser.uid)),
      ]);
      attendees         = attendeesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      _currentAttendees = attendees;
      isAttending       = attendees.some(a => a.id === _currentUser.uid);

      try {
        const wlSnap = await _fsGet(wlRef.orderBy('joinedAt', 'asc'));
        waitingList      = wlSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        myWaitingListPos = waitingList.findIndex(w => w.id === _currentUser.uid) + 1;
      } catch {
        // Rules don't yet cover waitingList collection — fall back to own-doc check
        if (ownWlSnap.exists) myWaitingListPos = -1;
      }
    }

    _setTitle([_formatDate(session.date), session.time].filter(Boolean).join(' · '));

    // Check if user has a series pass for this session's series
    let seriesReg = null;
    if (_currentUser && session.seriesId) {
      try {
        const regDoc = await _fsGet(_seriesColRef().doc(session.seriesId)
          .collection('registrations').doc(_currentUser.uid));
        if (regDoc.exists && regDoc.data().paymentStatus === 'paid') seriesReg = regDoc.data();
      } catch(e) { /* non-critical */ }
    }

    _renderDetail(session, attendees, isAttending, waitingList, myWaitingListPos, content, footer, seriesReg);
  } catch(e) {
    content.innerHTML = `<div class="home-empty">Taking longer than usual… <button class="link-btn" onclick="location.reload()">Tap here to reload</button></div>`;
    console.error(e);
  }
}

function _renderDetail(session, attendees, isAttending, waitingList, myWaitingListPos, content, footer, seriesReg) {
  const knownCount     = _currentUser ? attendees.length : (session.attendeeCount || 0);
  const spotsLeft      = _spotsLeft(session, knownCount);
  const isCancelled    = session.status === 'cancelled';
  const isClosed       = session.status === 'closed';
  const isFull         = spotsLeft === 0 && !isAttending;
  const deadlinePassed = session.registrationDeadline && session.registrationDeadline.toDate() < new Date();
  const levelLabel     = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', competitive: 'Competitive' }[session.level] || '';
  const deadlineStr    = session.registrationDeadline
    ? session.registrationDeadline.toDate().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  content.innerHTML = `
    <div class="detail-section">
      <div class="detail-meta-grid">
        ${session.venue ? `<div class="detail-meta-row"><span class="detail-meta-label">Venue</span><span>${(() => {
          const v = session.venueId ? _allVenues.find(x => x.id === session.venueId) : null;
          const name = esc(session.venue);
          const addr = v?.address ? ` <span class="venue-address">${esc(v.address)}</span>` : '';
          const link = v?.mapsUrl ? ` <a class="venue-maps-link" href="${esc(v.mapsUrl)}" target="_blank" rel="noopener">Map ↗</a>` : '';
          return name + addr + link;
        })()}</span></div>` : ''}
        <div class="detail-meta-row"><span class="detail-meta-label">Date</span><span>${esc(_formatDate(session.date))}${session.time ? ` at ${esc(session.time)}` : ''}</span></div>
        ${session.coach ? `<div class="detail-meta-row"><span class="detail-meta-label">Coach</span><span>${esc(session.coach)}</span></div>` : ''}
        ${levelLabel ? `<div class="detail-meta-row"><span class="detail-meta-label">Level</span><span>${esc(levelLabel)}</span></div>` : ''}
        <div class="detail-meta-row"><span class="detail-meta-label">Cost</span><span>${esc(_formatPlayerPrice(session.cost, session.absorbFee))}</span></div>
        <div class="detail-meta-row"><span class="detail-meta-label">Spots</span><span>${knownCount} / ${session.maxPlayers}${isCancelled ? '' : ` · ${spotsLeft} left`}</span></div>
        ${deadlineStr ? `<div class="detail-meta-row"><span class="detail-meta-label">Deadline</span><span${deadlinePassed ? ' style="color:var(--red)"' : ''}>${esc(deadlineStr)}${deadlinePassed ? ' · closed' : ''}</span></div>` : ''}
        ${isCancelled ? `<div class="detail-meta-row"><span class="detail-badge cancelled">Cancelled</span></div>` : ''}
        ${_isAdmin && session.coach && session.coachFee != null ? `<div class="detail-meta-row"><span class="detail-meta-label">Coach fee</span><span>£${Number(session.coachFee).toFixed(2)} ${_coachPayStatusWidget(session)}</span></div>` : ''}
        ${_isAdmin && session.createdAt ? `<div class="detail-meta-row"><span class="detail-meta-label">Created</span><span>${esc(_formatDate(session.createdAt))}</span></div>` : ''}
      </div>
      ${session.description ? `<p class="detail-description">${esc(session.description)}</p>` : ''}
      ${isAttending && !isCancelled && !isClosed && session.date ? (() => {
        const gcal = _googleCalendarUrl(session);
        return gcal ? `<div class="cal-row">
          <a class="cal-link" href="${gcal}" target="_blank" rel="noopener">Add to Google Calendar</a>
          <button class="cal-link" onclick="downloadIcs()">Download .ics</button>
        </div>` : '';
      })() : ''}
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Attendees (${knownCount})</div>
      ${!_currentUser
        ? '<div class="empty-note">Sign in to see who\'s coming.</div>'
        : attendees.length ? `
          <div class="attendee-list">
            ${attendees.map((a, i) => {
              const genderSym   = { man: '♂', woman: '♀', nonbinary: '⚧' }[a.gender] || '';
              const genderClass = { man: 'gender-m', woman: 'gender-w', nonbinary: 'gender-nb' }[a.gender] || '';
              const posSet      = new Set(a.positions || []);
              const POS = { setter: 'S', hitter: 'H', middle: 'M', libero: 'L' };
              const posChips = session.askPositions
                ? Object.entries(POS).map(([key, label]) =>
                    `<span class="att-chip${posSet.has(key) ? ' on-' + key : ''}">${label}</span>`
                  ).join('')
                : '';
              const isOwn  = _currentUser && a.id === _currentUser.uid;
              const canSee = _isAdmin || (_currentUser && session.coachUid === _currentUser.uid);
              return `
              <div class="attendee-row">
                <span class="attendee-num">${i + 1}</span>
                ${genderSym ? `<span class="attendee-gender ${genderClass}">${genderSym}</span>` : ''}
                <button class="attendee-name-btn" onclick="openProfileScreen('${a.id}')">${esc(a.name)}</button>
                ${posChips ? `<div class="att-chips">${posChips}</div>` : ''}
                ${a.seriesId ? `<span class="att-chip series-chip" title="Series pass">S</span>` : ''}
                ${canSee && session.cost > 0 ? `<span class="att-chip ${a.feeWaived ? 'waived-chip' : a.paid ? 'paid-chip' : 'unpaid-chip'}">${a.feeWaived ? '£–' : a.paid ? '£✓' : '£?'}</span>` : ''}
                ${_isAdmin ? `<span class="attendee-email">${esc(a.email || '')}</span>` : ''}
                ${isOwn && session.askPositions ? `<button class="icon-btn small" onclick="openEditPositions('${session.id}','${Array.from(posSet).join(',')}')" title="Edit positions">✎</button>` : ''}
                ${_isAdmin ? `<button class="icon-btn danger small" onclick="removeAttendee('${session.id}','${a.id}')" title="Remove">✕</button>` : ''}
              </div>`;
            }).join('')}
          </div>` : '<div class="empty-note">No one signed up yet.</div>'}
    </div>

    ${_isAdmin && waitingList.length ? `
    <div class="detail-section">
      <div class="detail-section-title">Waiting list (${waitingList.length})</div>
      <div class="attendee-list">
        ${waitingList.map((w, i) => `
          <div class="attendee-row">
            <span class="attendee-num">${i + 1}</span>
            <button class="attendee-name-btn" onclick="openProfileScreen('${w.id || ''}')">${esc(w.name)}</button>
            <span class="attendee-email">${esc(w.email || '')}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}

    ${_isAdmin && session.refunds && session.refunds.length ? `
    <div class="detail-section">
      <div class="detail-section-title">Refunds (${session.refunds.length})</div>
      <div class="attendee-list">
        ${session.refunds.map(r => `
          <div class="attendee-row">
            <span class="attendee-name">${esc(r.name || r.email || r.uid)}</span>
            <span class="attendee-email">${esc(r.email || '')}</span>
            <span class="att-chip paid-chip">£${((r.amountPence || 0) / 100).toFixed(2)}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div class="policy-link-row">
      <button class="policy-link" onclick="openPolicy()">Terms &amp; cancellation policy</button>
    </div>`;

  const hasWaitingList = waitingList.length > 0;
  const cancelLabel    = isAttending && hasWaitingList && !isCancelled && !isClosed
    ? 'Sell my spot →'
    : 'Cancel my registration';

  const canStart = _isAdmin || (_currentUser && session.coachUid && session.coachUid === _currentUser.uid);
  const msgBtn = _isAdmin && !isCancelled
    ? `<button class="cta-btn secondary-btn" onclick="openMessageForm('${session.id}')">✉ Message attendees</button>`
    : '';

  // Series pass: replace cancel with drop-out, replace join with series-pass join
  const dropOutBtn  = seriesReg ? `<button class="cta-btn secondary-btn" onclick="dropOutOfSession('${session.id}')">Drop out of this session</button>` : '';
  const seriesJoin  = seriesReg && !isAttending && !isFull && !deadlinePassed
    ? `<button class="cta-btn" onclick="registerWithSeriesPass('${session.id}')">Join with series pass →</button>`
    : '';

  if (isClosed) {
    const coachPayBtn  = _isAdmin && session.coach && session.coachFee > 0 ? _coachPayCtaBtn(session) : '';
    const exportCsvBtn = _isAdmin
      ? `<button class="cta-btn secondary-btn" onclick="exportAttendeesCsv('${session.id}')">⬇ Export attendees</button>`
      : '';
    footer.innerHTML = `
      <button class="cta-btn" disabled>Session closed</button>
      ${canStart && session.report ? `<button class="cta-btn secondary-btn" onclick="openSessionEndReport('${session.id}')">View report</button>` : ''}
      ${_isAdmin ? coachPayBtn : ''}
      ${exportCsvBtn}
      ${msgBtn}`;
  } else if (isCancelled) {
    footer.innerHTML = `<button class="cta-btn" disabled>Session cancelled</button>`;
  } else if (canStart) {
    const joinBtn = !isAttending && !isFull && !deadlinePassed
      ? seriesJoin || (_isAdmin && session.cost > 0
          ? `<button class="cta-btn secondary-btn" onclick="registerFree('${session.id}')">Register free →</button>
             <button class="cta-btn secondary-btn" onclick="register('${session.id}')">Pay and join →</button>`
          : `<button class="cta-btn secondary-btn" onclick="register('${session.id}')">Join →</button>`)
      : '';
    const cancelBtn = isAttending
      ? seriesReg ? dropOutBtn : `<button class="cta-btn secondary-btn" onclick="cancelRegistration('${session.id}')">${cancelLabel}</button>`
      : '';
    const exportCsvBtn = _isAdmin
      ? `<button class="cta-btn secondary-btn" onclick="exportAttendeesCsv('${session.id}')">⬇ Export attendees</button>`
      : '';
    footer.innerHTML = `
      <button class="cta-btn" onclick="openSessionRun('${session.id}')">▶ Start session</button>
      ${cancelBtn}${joinBtn}
      ${exportCsvBtn}
      ${msgBtn}`;
  } else if (isAttending) {
    const cancelBtn = seriesReg ? dropOutBtn : `<button class="cta-btn secondary-btn" onclick="cancelRegistration('${session.id}')">${cancelLabel}</button>`;
    footer.innerHTML = `${cancelBtn}${msgBtn}`;
  } else if (seriesJoin) {
    footer.innerHTML = `${seriesJoin}${msgBtn}`;
  } else if (myWaitingListPos !== 0 && !isFull && !deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" onclick="register('${session.id}')">Claim your spot →</button>${msgBtn}`;
  } else if (myWaitingListPos !== 0) {
    const posLabel = myWaitingListPos > 0 ? `You're #${myWaitingListPos} on the waiting list` : `You're on the waiting list`;
    footer.innerHTML = `
      <span class="waiting-pos">${posLabel}</span>
      <button class="cta-btn secondary-btn" onclick="leaveWaitingList('${session.id}')">Leave list</button>${msgBtn}`;
  } else if (isFull && !deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" onclick="joinWaitingList('${session.id}')">Join waiting list →</button>${msgBtn}`;
  } else if (deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" disabled>Registration closed</button>${msgBtn}`;
  } else {
    footer.innerHTML = `<button class="cta-btn" onclick="register('${session.id}')">Join session →</button>${msgBtn}`;
  }
}

function registerFree(sessionId) { return _doRegister(sessionId, { feeWaived: true }); }

async function register(sessionId) {
  if (!_currentUser) {
    _pendingJoinSessionId = sessionId;
    await handleAuthClick();
    return;
  }

  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }

  try {
    const [userDoc, sessionDoc] = await Promise.all([
      _userRef(_currentUser.uid).get(),
      _sessionRef(sessionId).get(),
    ]);

    // Age consent — one-time, stored on user doc
    if (!userDoc.data()?.ageConsent) {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
      _showAgeConsentModal(sessionId);
      return;
    }

    const needsGender    = !userDoc.data()?.gender;
    const needsPositions = sessionDoc.data()?.askPositions === true;

    if (needsGender || needsPositions) {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
      openProfileForm(sessionId, needsGender, needsPositions);
      return;
    }
  } catch(e) {
    console.error('Profile check failed:', e);
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }

  await _doRegister(sessionId);
}

function _showAgeConsentModal(sessionId) {
  const existing = document.getElementById('age-consent-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'age-consent-overlay';
  el.className = 'overlay open';
  el.innerHTML = `
    <div class="panel" style="max-width:420px">
      <div class="panel-header">
        <span class="panel-title">Before you join</span>
      </div>
      <div style="padding:0 0 20px;font-size:14px;color:var(--muted);line-height:1.6">
        Volleyball is a physical activity. Please confirm the following before booking your first session.
      </div>
      <label style="display:flex;gap:12px;align-items:flex-start;cursor:pointer;margin-bottom:20px">
        <input type="checkbox" id="age-consent-check" style="margin-top:3px;flex-shrink:0" />
        <span style="font-size:14px;color:var(--text);line-height:1.6">I am 16 or over (or a parent/guardian has consented to my participation), I am physically fit to take part, and I accept that volleyball carries an inherent risk of injury. I take part at my own risk.</span>
      </label>
      <div id="age-consent-error" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:12px"></div>
      <button class="cta-btn" onclick="_confirmAgeConsent('${sessionId}')">Confirm &amp; continue</button>
      <button class="cta-btn secondary-btn" style="margin-top:8px" onclick="document.getElementById('age-consent-overlay').remove()">Cancel</button>
    </div>`;
  document.body.appendChild(el);
}

async function _confirmAgeConsent(sessionId) {
  if (!document.getElementById('age-consent-check').checked) {
    document.getElementById('age-consent-error').textContent = 'Please tick the box to continue.';
    return;
  }
  document.getElementById('age-consent-overlay').remove();
  await _userRef(_currentUser.uid).update({ ageConsent: { confirmed: true, at: firebase.firestore.FieldValue.serverTimestamp() } });
  await register(sessionId);
}

async function _doRegister(sessionId, extra = {}) {
  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  try {
    const [userDoc, sessionDoc] = await Promise.all([
      _userRef(_currentUser.uid).get(),
      _sessionRef(sessionId).get(),
    ]);
    const session = sessionDoc.data() || {};

    if (!extra.gender) {
      const g = userDoc.data()?.gender;
      if (g) extra = { ...extra, gender: g };
    }

    // Paid session → redirect to Stripe Checkout (unless fee is waived by admin).
    if ((session.cost || 0) > 0 && !extra.feeWaived) {
      const base = window.location.origin + window.location.pathname;
      const data = await callFn('createCheckoutSession', {
        sessionId,
        successUrl: `${base}?checkout=success&session=${sessionId}`,
        cancelUrl:  `${base}?checkout=cancelled&session=${sessionId}`,
        positions:  extra.positions || [],
      });
      window.location.href = data.url;
      return;
    }

    // Free session or fee-waived → direct Firestore write.
    await _attendeesRef(sessionId).doc(_currentUser.uid).set({
      name:       _currentUser.displayName || _currentUser.email,
      email:      _currentUser.email || '',
      joinedAt:   firebase.firestore.FieldValue.serverTimestamp(),
      paid:       false,
      feeWaived:  !!extra.feeWaived,
      ...extra,
    });
    await _sessionRef(sessionId).update({
      attendeeCount: firebase.firestore.FieldValue.increment(1),
    });
    _userRef(_currentUser.uid).update({
      sessionCount: firebase.firestore.FieldValue.increment(1),
    }).catch(() => {});
    // Write session history entry for this user
    _sessionHistoryRef(_currentUser.uid).doc(sessionId).set({
      sessionId,
      date:      session.date   || null,
      venue:     session.venue  || '',
      level:     session.level  || '',
      cost:      0,
      paid:      false,
      feeWaived: !!extra.feeWaived,
      joinedAt:  firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    await openSession(sessionId);
  } catch(e) {
    console.error('Register failed:', e);
    showToast(e.message || 'Couldn\'t join session. Try again.', 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

async function joinSeries(seriesId) {
  const btn = document.querySelector('.series-banner-cta');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }

  if (!_currentUser) {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    await handleAuthClick();
    return;
  }

  try {
    const base = window.location.origin + window.location.pathname;
    const data = await callFn('createSeriesCheckoutSession', {
      seriesId,
      inviteToken: _seriesInvite?.seriesId === seriesId ? _seriesInvite.token : null,
      successUrl: `${base}?checkout=success&type=series&seriesId=${seriesId}`,
      cancelUrl:  `${base}?checkout=cancelled&type=series&seriesId=${seriesId}`,
    });
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast('You\'re in! Series pass activated.');
      _seriesInvite    = null;
      _activeSeriesReg = { paymentStatus: 'paid' };
      renderHome();
    }
  } catch(e) {
    const alreadyHas = e.message && e.message.toLowerCase().includes('already registered');
    if (alreadyHas) {
      showToast('You already have a series pass.');
      _activeSeriesReg = { paymentStatus: 'paid' };
      renderHome();
    } else {
      showToast(e.message || 'Couldn\'t join series. Try again.', 'error');
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }
}

async function registerWithSeriesPass(sessionId) {
  if (!_currentUser) return;
  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  try {
    const [userDoc, sessionDoc] = await Promise.all([
      _userRef(_currentUser.uid).get(),
      _sessionRef(sessionId).get(),
    ]);
    const u       = userDoc.data()  || {};
    const session = sessionDoc.data() || {};
    await _attendeesRef(sessionId).doc(_currentUser.uid).set({
      name:      u.name  || _currentUser.displayName || '',
      email:     u.email || _currentUser.email       || '',
      gender:    u.gender    || null,
      positions: u.positions || [],
      present:   false,
      paid:      true,
      feeWaived: false,
      seriesId:  session.seriesId,
      joinedAt:  firebase.firestore.FieldValue.serverTimestamp(),
    });
    await _sessionRef(sessionId).update({
      attendeeCount: firebase.firestore.FieldValue.increment(1),
    });
    showToast('You\'re in!');
    await openSession(sessionId);
  } catch(e) {
    showToast(e.message || 'Couldn\'t join session.', 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

async function dropOutOfSession(sessionId) {
  if (!_currentUser) return;
  if (!confirm('Drop out of this session? Your series pass stays active for all other sessions.')) return;
  const btns = document.querySelectorAll('#detail-footer button');
  btns.forEach(b => { b.disabled = true; });
  try {
    await callFn('dropOutSeries', { sessionId });
    showToast('Dropped out. Your series pass is still active.');
    await openSession(sessionId);
  } catch(e) {
    showToast(e.message || 'Couldn\'t drop out. Try again.', 'error');
    btns.forEach(b => { b.disabled = false; });
  }
}

async function cancelRegistration(sessionId) {
  if (!_currentUser) return;

  let isPaid = false;
  try {
    const att = await _attendeesRef(sessionId).doc(_currentUser.uid).get();
    isPaid = att.exists && !!att.data().paid;
  } catch(e) {}

  const msg = isPaid
    ? 'Cancel your registration? You\'ll receive a refund (excluding the booking fee).'
    : 'Cancel your registration for this session?';
  if (!confirm(msg)) return;

  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }

  try {
    const data = await callFn('cancelAttendeeAndRefund', { sessionId });
    showToast(data.refunded ? 'Cancelled — refund on its way.' : 'Registration cancelled.');
    await openSession(sessionId);
  } catch(e) {
    console.error('Cancel failed:', e);
    showToast(e.message || 'Couldn\'t cancel. Try again.', 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

async function removeAttendee(sessionId, uid) {
  if (!_isAdmin) return;
  if (!confirm('Remove this attendee? They will receive an email notification.')) return;
  try {
    await callFn('removeAttendeeAdmin', { sessionId, uid });
    await openSession(sessionId);
  } catch(e) {
    console.error('Remove attendee failed:', e);
    showToast(e.message || 'Couldn\'t remove attendee. Try again.', 'error');
  }
}

async function joinWaitingList(sessionId) {
  if (!_currentUser) {
    _pendingJoinSessionId = sessionId;
    await handleAuthClick();
    return;
  }
  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  try {
    const data = await callFn('joinWaitingList', { sessionId });
    showToast(`You're #${data.position} on the waiting list.`);
    await openSession(sessionId);
  } catch(e) {
    showToast(e.message || 'Couldn\'t join the waiting list. Try again.', 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

async function leaveWaitingList(sessionId) {
  if (!confirm('Leave the waiting list for this session?')) return;
  try {
    await callFn('leaveWaitingList', { sessionId });
    await openSession(sessionId);
  } catch(e) {
    showToast(e.message || 'Couldn\'t leave the waiting list. Try again.', 'error');
  }
}

async function approveCoachPayment(sessionId) {
  if (!_isAdmin) return;
  if (!confirm('Approve coach payment? This will initiate a bank transfer.')) return;
  try {
    const data = await callFn('approveCoachPayment', { sessionId });
    showToast(data.status === 'paid' ? 'Payment approved — transfer initiated.' : 'Onboarding email sent to coach.');
    await openSession(sessionId);
  } catch(e) {
    showToast(e.message || 'Couldn\'t approve payment. Try again.', 'error');
  }
}

// ─── Users screen ──────────────────────────────────────────────────────────────
function openUsersScreen() {
  if (!_isAdmin) return;
  _setHash('users');
  showScreen('users');
  _setNav('sub', null);
  _setTitle('Users');
  _setBack(() => history.back());
  renderUsers();
}

let _allUsers = [];
let _userFilter = 'all';

async function renderUsers() {
  const container = document.getElementById('users-content');
  container.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    const snap  = await _usersRef().orderBy('name', 'asc').get();
    _allUsers   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _applyUserFilter();
  } catch(e) {
    container.innerHTML = '<div class="home-empty">Couldn\'t load users. Check your connection.</div>';
    console.error(e);
  }
}

function setUserFilter(f) {
  _userFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  _applyUserFilter();
}

function filterUsers() { _applyUserFilter(); }

function _applyUserFilter() {
  const q         = (document.getElementById('users-search')?.value || '').toLowerCase();
  const container = document.getElementById('users-content');
  let users = _allUsers.filter(u => {
    if (q && !((u.name||'').toLowerCase().includes(q)) && !((u.email||'').toLowerCase().includes(q))) return false;
    if (_userFilter === 'coach')            return (u.roles||[]).includes('coach');
    if (_userFilter === 'provider')         return (u.roles||[]).includes('provider');
    if (_userFilter === 'admin')            return (u.roles||[]).includes('admin');
    if (_userFilter === 'pending')          return (!!u.coachRequest && !(u.roles||[]).includes('coach'))
                                                || (!!u.providerRequest && !(u.roles||[]).includes('provider'));
    if (_userFilter === 'incomplete') return !u.gender || !(u.positions||[]).length;
    return true;
  });
  if (!users.length) { container.innerHTML = '<div class="home-empty">No users match.</div>'; return; }
  container.innerHTML = users.map(_renderUserRow).join('');
}

function _renderUserRow(u) {
  const roles           = u.roles || ['player'];
  const isMe            = _currentUser && u.id === _currentUser.uid;
  const hasOwner           = roles.includes('owner');
  const hasAdmin           = roles.includes('admin');
  const hasCoach           = roles.includes('coach');
  const hasProvider        = roles.includes('provider');
  const hasPendingCoach    = !!u.coachRequest && !hasCoach;
  const hasPendingProvider = !!u.providerRequest && !hasProvider;
  const hasPendingAdmin    = !!u.adminRequest && !hasAdmin;
  const initials        = (u.name || u.email || '?')[0].toUpperCase();
  const incomplete      = !u.gender || !(u.positions||[]).length;
  const posLabels       = { setter:'S', hitter:'H', middle:'M', libero:'L' };
  const posStr          = (u.positions||[]).map(p => posLabels[p]||p).join(' · ');
  const genderSym       = { man:'♂', woman:'♀', nonbinary:'⚧' }[u.gender] || '';
  const joined          = u.createdAt ? _formatDate(u.createdAt) : '';
  const safeName        = esc(u.name || u.email || '');

  // What the current user can do to this row:
  const canManageOwner    = _isOwner && !isMe && !hasOwner;
  const canManageAdmin    = _isOwner && !isMe;
  const canManageCoach    = _isAdmin && !isMe;
  const canManageProvider = _isAdmin && !isMe;
  const canNominate       = _isAdmin && !_isOwner && !hasAdmin && !hasOwner && !hasPendingAdmin;
  const canRemove         = _isOwner ? (!isMe && !hasOwner) : (_isAdmin && !hasAdmin && !hasOwner);

  let actions = '';
  if (_isAdmin) {
    if (hasPendingCoach) {
      actions += `<button class="role-toggle active coach" onclick="approveCoach('${u.id}','${safeName}')">Approve coach</button>
                  <button class="role-toggle" onclick="rejectCoach('${u.id}')">Reject</button>`;
    } else if (hasPendingProvider) {
      actions += `<button class="role-toggle active provider" onclick="approveProvider('${u.id}','${safeName}')">Approve host</button>
                  <button class="role-toggle" onclick="rejectProvider('${u.id}')">Reject</button>`;
    } else if (hasPendingAdmin) {
      actions += _isOwner
        ? `<button class="role-toggle active admin" onclick="approveAdmin('${u.id}','${safeName}')">Approve admin</button>
           <button class="role-toggle" onclick="rejectAdmin('${u.id}')">Reject</button>`
        : `<span class="role-toggle active admin" style="cursor:default">Admin pending</span>`;
    } else {
      if (canManageOwner)    actions += `<button class="role-toggle${hasOwner ? ' active owner' : ''}" onclick="toggleRole('${u.id}','owner','${safeName}')">Owner</button>`;
      if (canManageAdmin)    actions += `<button class="role-toggle${hasAdmin ? ' active admin' : ''}" onclick="toggleRole('${u.id}','admin','${safeName}')">Admin</button>`;
      if (canManageCoach)    actions += `<button class="role-toggle${hasCoach ? ' active coach' : ''}" onclick="toggleRole('${u.id}','coach','${safeName}')">Coach</button>`;
      if (canManageProvider) actions += `<button class="role-toggle${hasProvider ? ' active provider' : ''}" onclick="toggleRole('${u.id}','provider','${safeName}')">Host</button>`;
      if (canNominate)       actions += `<button class="role-toggle" onclick="nominateForAdmin('${u.id}','${safeName}')">Nominate admin</button>`;
    }
    if (canRemove) actions += `<button class="role-toggle danger" onclick="banUser('${u.id}','${safeName}')">Remove</button>`;
  }

  return `
    <div class="user-row" onclick="openProfileScreen('${u.id}')">
      ${u.photoURL
        ? `<img class="user-avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
        : `<div class="user-avatar user-avatar--initials">${esc(initials)}</div>`}
      <div class="user-info">
        <div class="user-name">
          ${esc(u.name || '—')}${isMe ? ' <span class="user-you">you</span>' : ''}
          ${hasOwner ? '<span class="user-flag owner-badge">owner</span>' : ''}
          ${incomplete ? '<span class="user-flag">incomplete</span>' : ''}
          ${hasPendingCoach    ? '<span class="user-flag coach-req">coach request</span>' : ''}
          ${hasPendingProvider ? '<span class="user-flag provider-req">host request</span>' : ''}
          ${hasPendingAdmin    ? '<span class="user-flag admin-req">admin pending</span>' : ''}
        </div>
        <div class="user-meta">${esc(u.email || '')}${genderSym ? ` · ${genderSym}` : ''}${posStr ? ` · ${posStr}` : ''}${joined ? ` · joined ${joined}` : ''}</div>
      </div>
      ${actions ? `<div class="user-actions" onclick="event.stopPropagation()">${actions}</div>` : ''}
    </div>`;
}

async function toggleRole(uid, role, displayName) {
  if (!_isAdmin) return;
  if ((role === 'admin' || role === 'owner') && !_isOwner) {
    showToast('Only owners can change admin or owner roles.', 'error');
    return;
  }
  try {
    const doc      = await _userRef(uid).get();
    const roles    = doc.data()?.roles || ['player'];
    const isAdding = !roles.includes(role);
    const label    = displayName || uid;
    const verb     = isAdding ? 'grant' : 'remove';
    const roleStr  = role.charAt(0).toUpperCase() + role.slice(1);
    if (!confirm(`${verb === 'grant' ? 'Grant' : 'Remove'} ${roleStr} role ${verb === 'grant' ? 'to' : 'from'} ${label}?`)) return;
    const newRoles = isAdding ? [...roles, role] : roles.filter(r => r !== role);
    if (!newRoles.includes('player')) newRoles.push('player');
    await _userRef(uid).set({ roles: newRoles }, { merge: true });
    renderUsers();
  } catch(e) {
    console.error('Toggle role failed:', e);
    showToast(e.code === 'permission-denied'
      ? 'Only owners can change admin or owner roles.'
      : 'Couldn\'t update role. Try again.', 'error');
  }
}

async function nominateForAdmin(uid, displayName) {
  if (!_isAdmin) return;
  const label = displayName || uid;
  if (!confirm(`Nominate ${label} for Admin? An owner will be asked to approve.`)) return;
  try {
    await _userRef(uid).update({ adminRequest: true });
    await callFn('notifyAdminRequest', { uid, name: displayName });
    showToast('Nomination sent — owners have been notified.');
    renderUsers();
  } catch(e) {
    showToast('Couldn\'t send nomination. Try again.', 'error');
  }
}

async function approveAdmin(uid, displayName) {
  if (!_isOwner) return;
  const label = displayName || uid;
  if (!confirm(`Approve ${label} as Admin?`)) return;
  try {
    const doc   = await _userRef(uid).get();
    const roles = doc.data()?.roles || ['player'];
    if (!roles.includes('admin')) roles.push('admin');
    await _userRef(uid).update({ roles, adminRequest: false });
    showToast('Admin approved.');
    renderUsers();
  } catch(e) { showToast('Couldn\'t approve. Try again.', 'error'); }
}

async function rejectAdmin(uid) {
  if (!_isOwner) return;
  if (!confirm('Reject this admin nomination?')) return;
  try {
    await _userRef(uid).update({ adminRequest: false });
    showToast('Nomination rejected.');
    renderUsers();
  } catch(e) { showToast('Couldn\'t reject. Try again.', 'error'); }
}

function _refreshAfterRoleAction(uid) {
  const activeId = document.querySelector('.screen.active')?.id;
  if (activeId === 'screen-profile') openProfileScreen(uid);
  else renderUsers();
}

async function approveCoach(uid, displayName) {
  if (!_isAdmin) return;
  const label = displayName || uid;
  if (!confirm(`Approve ${label} as Coach?`)) return;
  try {
    const doc   = await _userRef(uid).get();
    const roles = doc.data()?.roles || ['player'];
    if (!roles.includes('coach')) roles.push('coach');
    await _userRef(uid).update({ roles, coachRequest: false });
    callFn('notifyCoachRequestOutcome', { uid, approved: true }).catch(console.error);
    showToast('Coach approved.');
    _refreshAfterRoleAction(uid);
  } catch(e) { showToast('Couldn\'t approve. Try again.', 'error'); }
}

async function rejectCoach(uid) {
  if (!_isAdmin) return;
  if (!confirm('Reject this coach request?')) return;
  try {
    await _userRef(uid).update({ coachRequest: false });
    callFn('notifyCoachRequestOutcome', { uid, approved: false }).catch(console.error);
    showToast('Coach request rejected.');
    _refreshAfterRoleAction(uid);
  } catch(e) { showToast('Couldn\'t reject. Try again.', 'error'); }
}

async function approveProvider(uid, displayName) {
  if (!_isAdmin) return;
  const label = displayName || uid;
  if (!confirm(`Approve ${label} as a host?`)) return;
  try {
    const doc   = await _userRef(uid).get();
    const roles = doc.data()?.roles || ['player'];
    if (!roles.includes('provider')) roles.push('provider');
    await _userRef(uid).update({ roles, providerRequest: false });
    callFn('notifyHostRequestOutcome', { uid, approved: true }).catch(console.error);
    showToast('Host approved.');
    _refreshAfterRoleAction(uid);
  } catch(e) { showToast('Couldn\'t approve. Try again.', 'error'); }
}

async function rejectProvider(uid) {
  if (!_isAdmin) return;
  if (!confirm('Reject this host request?')) return;
  try {
    await _userRef(uid).update({ providerRequest: false });
    callFn('notifyHostRequestOutcome', { uid, approved: false }).catch(console.error);
    showToast('Host request rejected.');
    _refreshAfterRoleAction(uid);
  } catch(e) { showToast('Couldn\'t reject. Try again.', 'error'); }
}

async function banUser(uid, name) {
  if (!_isAdmin) return;
  if (!confirm(`Remove ${name || 'this user'}? This will permanently delete their account.`)) return;
  try {
    await callFn('removeUser', { uid });
    showToast('User removed.');
    renderUsers();
  } catch(e) { showToast(e.message || 'Couldn\'t remove user. Try again.', 'error'); }
}

// ─── Profile screen ────────────────────────────────────────────────────────────
async function openProfileScreen(uid) {
  const targetUid = uid || (_currentUser && _currentUser.uid);
  if (!targetUid) return;

  _setHash('profile/' + targetUid);
  showScreen('profile');
  _setNav('sub', null);
  _setTitle('Profile');
  _setBack(() => history.back());

  const body = document.getElementById('profile-screen-body');
  body.innerHTML = '<div class="home-empty">Loading…</div>';

  try {
    const doc    = await _userRef(targetUid).get();
    const u      = doc.exists ? { id: doc.id, ...doc.data() } : {};
    const isOwn  = _currentUser && targetUid === _currentUser.uid;
    const roles  = u.roles || ['player'];
    const hasCoach           = roles.includes('coach');
    const hasPending         = !!u.coachRequest && !hasCoach;
    const hasProvider        = roles.includes('provider');
    const hasPendingProvider = !!u.providerRequest && !hasProvider;

    if (isOwn) _setTitle('Your profile');

    const posLabels   = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };
    const genderLabel = { man: 'Man', woman: 'Woman', nonbinary: 'Non-binary' }[u.gender] || '';
    const levelLabel  = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', competitive: 'Competitive' }[u.level] || '';
    const initials    = (u.name || u.email || '?')[0].toUpperCase();
    const roleOrder   = ['owner', 'admin', 'provider', 'coach'];
    const displayRoles = roleOrder.filter(r => roles.includes(r));

    const roleLabel = { owner: 'owner', admin: 'admin', provider: 'host', coach: 'coach' };
    const roleBadges = displayRoles.map(r => {
      const cls = r === 'owner' ? 'level owner-badge-lg'
                : r === 'admin' ? 'level admin-badge-lg'
                : r === 'provider' ? 'level provider-badge-lg'
                : 'level';
      return `<span class="session-badge ${cls}">${roleLabel[r] || r}</span>`;
    }).join(' ');

    const metaRows = [
      genderLabel ? `<div class="detail-meta-row"><span class="detail-meta-label">Gender</span><span>${esc(genderLabel)}</span></div>` : '',
      levelLabel  ? `<div class="detail-meta-row"><span class="detail-meta-label">Level</span><span>${esc(levelLabel)}</span></div>` : '',
      (u.positions||[]).length ? `<div class="detail-meta-row"><span class="detail-meta-label">Positions</span><span>${(u.positions||[]).map(p => posLabels[p]||p).join(', ')}</span></div>` : '',
      u.email && (isOwn || _isAdmin) ? `<div class="detail-meta-row"><span class="detail-meta-label">Email</span><span>${esc(u.email)}</span></div>` : '',
      u.createdAt ? `<div class="detail-meta-row"><span class="detail-meta-label">Joined</span><span>${_formatDate(u.createdAt)}</span></div>` : '',
    ].filter(Boolean).join('');

    const _roleCheck  = `<span class="role-status-active">Active</span>`;
    const _roleLocked = `<span class="role-status-locked">Invitation only</span>`;
    const rolesSection = isOwn ? `
      <div class="detail-section">
        <div class="detail-section-title">Membership</div>
        <div class="role-status-list">
          <div class="role-status-row">
            <span class="role-status-name">Player</span>
            ${_roleCheck}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Coach</span>
            ${hasCoach
              ? _roleCheck
              : hasPending
                ? `<span class="role-status-pending">Request pending</span>`
                : `<button class="role-status-btn" id="coach-request-view-btn" onclick="requestCoachStatusFromView()">Request →</button>`}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Host</span>
            ${hasProvider
              ? _roleCheck
              : hasPendingProvider
                ? `<span class="role-status-pending">Request pending</span>`
                : `<button class="role-status-btn" id="provider-request-view-btn" onclick="requestProviderStatusFromView()">Request →</button>`}
          </div>
          <div class="role-status-row role-status-row--dim">
            <span class="role-status-name">Admin</span>
            ${roles.includes('admin') || roles.includes('owner') ? _roleCheck : _roleLocked}
          </div>
        </div>
      </div>` : '';

    const ownActions = isOwn ? `
      <div class="profile-actions">
        <button class="cta-btn secondary-btn" onclick="openEditProfile()">Edit profile →</button>
        <button class="cta-btn secondary-btn" onclick="handleAuthClick()">Sign out</button>
      </div>` : '';

    const safeUid  = esc(targetUid);
    const safeName = esc(u.name || '');
    const _activeTag  = `<span class="role-status-active">Active</span>`;
    const adminSection = _isAdmin && !isOwn ? `
      <div class="detail-section">
        <div class="detail-section-title">Membership</div>
        <div class="role-status-list">
          <div class="role-status-row">
            <span class="role-status-name">Player</span>
            ${_activeTag}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Coach</span>
            ${hasCoach ? _activeTag : hasPending ? `
              <div class="role-action-btns">
                <button class="role-action-approve" onclick="approveCoach('${safeUid}','${safeName}')">Approve</button>
                <button class="role-action-reject" onclick="rejectCoach('${safeUid}')">Reject</button>
              </div>` : `<span class="role-status-locked">Not requested</span>`}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Host</span>
            ${hasProvider ? _activeTag : hasPendingProvider ? `
              <div class="role-action-btns">
                <button class="role-action-approve" onclick="approveProvider('${safeUid}','${safeName}')">Approve</button>
                <button class="role-action-reject" onclick="rejectProvider('${safeUid}')">Reject</button>
              </div>` : `<span class="role-status-locked">Not requested</span>`}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Admin</span>
            ${roles.includes('admin') || roles.includes('owner') ? _activeTag : `<span class="role-status-locked">—</span>`}
          </div>
        </div>
      </div>` : '';

    const showHistory = isOwn || _isAdmin;
    const showCoach   = (hasCoach || roles.includes('admin') || roles.includes('owner')) && _isAdmin;

    // Fetch all data in parallel: coach sessions, all series docs, all session docs
    const [coachSessionsSnap, allSeriesSnap, allSessionsSnap] = await Promise.all([
      showCoach
        ? _sessionsRef().where('coachUid', '==', targetUid).where('status', '==', 'closed').orderBy('date', 'desc').limit(25).get().catch(() => null)
        : Promise.resolve(null),
      showHistory
        ? _seriesColRef().orderBy('name').get().catch(() => null)
        : Promise.resolve(null),
      showHistory
        ? _sessionsRef().orderBy('date', 'asc').get().catch(() => null)
        : Promise.resolve(null),
    ]);

    const allSeries   = allSeriesSnap?.docs.map(d => ({ id: d.id, ...d.data() }))   || [];
    const allSessions = allSessionsSnap?.docs.map(d => ({ id: d.id, ...d.data() })) || [];

    // Check user's registration for each series and attendance for each session — parallel
    const [seriesRegSnaps, sessionAttSnaps] = await Promise.all([
      allSeries.length
        ? Promise.all(allSeries.map(s =>
            _seriesColRef().doc(s.id).collection('registrations').doc(targetUid).get().catch(() => null)
          ))
        : Promise.resolve([]),
      allSessions.length
        ? Promise.all(allSessions.map(s =>
            _attendeesRef(s.id).doc(targetUid).get().catch(() => null)
          ))
        : Promise.resolve([]),
    ]);

    // ── Series passes ────────────────────────────────────────────────────────
    const myPasses = allSeries
      .map((s, i) => ({ s, reg: seriesRegSnaps[i] }))
      .filter(({ reg }) => reg?.exists && reg.data().paymentStatus === 'paid');

    const seriesPassSection = showHistory ? `
      <div class="detail-section">
        <div class="detail-section-title">Series passes</div>
        <div class="profile-history-list">
          ${myPasses.length ? myPasses.map(({ s, reg }) => {
              const r = reg.data();
              const cost = r.amountPaid > 0 ? `£${r.amountPaid}` : 'Free';
              return `<div class="history-row clickable-row" onclick="openSeriesDetail('${s.id}')">
                <span class="history-date">${_formatDate(r.registeredAt)}</span>
                <span class="history-venue">${esc(s.name)}</span>
                <span class="history-cost">${cost}</span>
              </div>`;
            }).join('')
            : '<div class="empty-note">No series passes yet.</div>'
          }
        </div>
      </div>` : '';

    // ── Sessions (upcoming + past) ────────────────────────────────────────────
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const mySessionEntries = allSessions
      .map((s, i) => ({ s, att: sessionAttSnaps[i] }))
      .filter(({ att }) => att?.exists);

    const upcoming = mySessionEntries.filter(({ s }) => s.date?.toDate() >= now);
    const past     = mySessionEntries.filter(({ s }) => s.date?.toDate() < now).reverse();

    const _sessionRow = ({ s, att }) => {
      const a = att.data();
      const costStr = a.seriesId ? 'Series pass'
                    : a.feeWaived ? 'Free (waived)'
                    : a.paid && s.cost > 0 ? `£${_formatPlayerPrice(s.cost, s.absorbFee)}`
                    : 'Free';
      return `<div class="history-row clickable-row" onclick="openSession('${s.id}')">
        <span class="history-date">${_formatDate(s.date)}${s.time ? ` · ${s.time}` : ''}</span>
        <span class="history-venue">${esc(s.venue || '—')}</span>
        <span class="history-cost">${costStr}</span>
      </div>`;
    };

    const sessionsSection = showHistory ? `
      <div class="detail-section">
        <div class="detail-section-title">Upcoming sessions</div>
        <div class="profile-history-list">
          ${upcoming.length ? upcoming.map(_sessionRow).join('') : '<div class="empty-note">No upcoming sessions.</div>'}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Past sessions</div>
        <div class="profile-history-list">
          ${past.length ? past.map(_sessionRow).join('') : '<div class="empty-note">No past sessions yet.</div>'}
        </div>
      </div>` : '';

    // ── Coach payments ────────────────────────────────────────────────────────
    const coachPayRows = coachSessionsSnap?.docs.length
      ? coachSessionsSnap.docs.map(d => {
          const s      = d.data();
          const status = s.coachPaymentStatus === 'paid' ? '✓ Paid'
                       : s.coachPaymentStatus === 'pending' ? '⏳ Pending'
                       : s.coachPaymentStatus === 'onboarding' ? '⏳ Onboarding'
                       : '—';
          const fee    = s.coachFee > 0 ? `£${s.coachFee}` : '—';
          return `<div class="history-row">
            <span class="history-date">${_formatDate(s.date)}</span>
            <span class="history-venue">${esc(s.venue || '—')}</span>
            <span class="history-cost">${fee}</span>
            <span class="history-status">${status}</span>
          </div>`;
        }).join('')
      : null;

    const coachPaySection = coachPayRows != null ? `
      <div class="detail-section">
        <div class="detail-section-title">Coach payments</div>
        <div class="profile-history-list">${coachPayRows}</div>
      </div>` : '';

    body.innerHTML = `
      <div class="profile-screen-card">
        <div class="profile-hero">
          ${u.photoURL
            ? `<img class="profile-avatar-xl" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
            : `<div class="profile-avatar-xl profile-avatar-initials">${esc(initials)}</div>`}
          <div class="profile-hero-name">${esc(u.name || '—')}</div>
          ${roleBadges ? `<div class="profile-role-badges">${roleBadges}</div>` : ''}
        </div>
        ${metaRows ? `<div class="detail-section"><div class="detail-meta-grid">${metaRows}</div></div>` : ''}
        ${rolesSection}
        ${adminSection}
        ${ownActions}
        ${coachPaySection}
        ${seriesPassSection}
        ${sessionsSection}
      </div>`;
  } catch(e) {
    console.error('Load profile failed:', e);
    body.innerHTML = '<div class="home-empty">Couldn\'t load profile.</div>';
  }
}

// ─── One-time profile form ─────────────────────────────────────────────────────
function openProfileForm(sessionId, needsGender, needsPositions) {
  _pendingJoinSessionId = sessionId;
  _pendingProfileNeeds  = { needsGender, needsPositions };

  document.getElementById('profile-form-error').textContent = '';
  document.getElementById('profile-gender-field').style.display    = needsGender    ? '' : 'none';
  document.getElementById('profile-positions-field').style.display = needsPositions ? '' : 'none';
  if (needsGender)    document.getElementById('profile-gender').value = '';
  if (needsPositions) document.querySelectorAll('#profile-positions input').forEach(cb => cb.checked = false);

  const count = (needsGender ? 1 : 0) + (needsPositions ? 1 : 0);
  document.getElementById('profile-intro').textContent =
    count === 1 ? 'One quick question before you join.' : 'Two quick questions before you join.';

  document.getElementById('profile-form-overlay').classList.add('open');
}

function closeProfileForm() {
  document.getElementById('profile-form-overlay').classList.remove('open');
  _pendingJoinSessionId   = null;
  _pendingProfileNeeds    = {};
  _editingAttendeeSession = null;
}

function openEditPositions(sessionId, positionsStr) {
  _editingAttendeeSession = sessionId;
  _pendingJoinSessionId   = null;
  _pendingProfileNeeds    = { needsGender: false, needsPositions: true };
  const posSet = new Set(positionsStr ? positionsStr.split(',') : []);
  document.getElementById('profile-form-error').textContent = '';
  document.getElementById('profile-gender-field').style.display    = 'none';
  document.getElementById('profile-positions-field').style.display = '';
  document.querySelectorAll('#profile-positions input').forEach(cb => { cb.checked = posSet.has(cb.value); });
  document.getElementById('profile-intro').textContent = 'Update your positions for this session.';
  document.getElementById('profile-form-overlay').classList.add('open');
}

async function submitProfileForm() {
  const { needsGender, needsPositions } = _pendingProfileNeeds;
  const errorEl = document.getElementById('profile-form-error');

  let gender, positions;
  if (needsGender) {
    gender = document.getElementById('profile-gender').value;
    if (!gender) { errorEl.textContent = 'Please select a gender.'; return; }
  }
  if (needsPositions) {
    positions = Array.from(document.querySelectorAll('#profile-positions input:checked')).map(el => el.value);
    if (!positions.length) { errorEl.textContent = 'Please select at least one position.'; return; }
  }

  errorEl.textContent = '';
  const btn = document.querySelector('#profile-form-overlay .cta-btn');
  btn.disabled = true;

  if (_editingAttendeeSession) {
    const sid = _editingAttendeeSession;
    _editingAttendeeSession = null;
    _pendingProfileNeeds    = {};
    document.getElementById('profile-form-overlay').classList.remove('open');
    try {
      await _attendeesRef(sid).doc(_currentUser.uid).update({ positions });
      await openSession(sid);
    } catch(e) {
      console.error('Update positions failed:', e);
      errorEl.textContent = 'Couldn\'t save. Try again.';
      btn.disabled = false;
    }
    return;
  }

  try {
    if (needsGender)    await _userRef(_currentUser.uid).update({ gender });
  if (needsPositions) await _userRef(_currentUser.uid).update({ positions });

    const sid = _pendingJoinSessionId;
    _pendingJoinSessionId = null;
    _pendingProfileNeeds  = {};
    document.getElementById('profile-form-overlay').classList.remove('open');
    if (sid) await _doRegister(sid, {
      ...(needsGender && gender ? { gender } : {}),
      ...(positions             ? { positions } : {}),
    });
  } catch(e) {
    console.error('Save profile failed:', e);
    errorEl.textContent = 'Couldn\'t save. Try again.';
    btn.disabled = false;
  }
}

// ─── Create / Edit session ─────────────────────────────────────────────────────
async function _loadCoachOptions(currentCoach, currentCoachUid) {
  const sel    = document.getElementById('form-coach-select');
  const custom = document.getElementById('form-coach-custom');
  sel.innerHTML = '<option value="">None</option>';
  try {
    const snap = await _usersRef().where('roles', 'array-contains', 'coach').get();
    snap.docs.forEach(d => {
      const name = d.data().name || d.data().email || '';
      if (!name) return;
      const opt = document.createElement('option');
      opt.value = d.id; opt.textContent = name;  // value = UID
      sel.appendChild(opt);
    });
  } catch(e) { console.error('Failed to load coaches:', e); }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__'; customOpt.textContent = 'Custom…';
  sel.appendChild(customOpt);

  if (currentCoachUid && Array.from(sel.options).find(o => o.value === currentCoachUid)) {
    sel.value = currentCoachUid;
    custom.style.display = 'none'; custom.value = '';
  } else if (currentCoach) {
    sel.value = '__custom__';
    custom.style.display = ''; custom.value = currentCoach;
  } else {
    sel.value = ''; custom.style.display = 'none'; custom.value = '';
  }
}

function onCoachSelectChange() {
  const sel    = document.getElementById('form-coach-select');
  const custom = document.getElementById('form-coach-custom');
  const isCustom = sel.value === '__custom__';
  custom.style.display = isCustom ? '' : 'none';
  if (isCustom) custom.focus();
}

function openSessionForm(id = null) {
  if (!id && !_isProvider) return;                         // creating: providers only
  if (id && !_isAdmin && !_isProvider) return;             // editing: admin or provider
  if (!id && !_providerOnboardingComplete) {
    showToast('Set up payments in your profile before creating sessions.', 'error');
    return;
  }
  _editingId = id;

  const titleEl  = document.getElementById('form-title');
  const submitEl = document.getElementById('form-submit-btn');
  const errorEl  = document.getElementById('form-error');
  errorEl.textContent  = '';
  submitEl.disabled    = false;

  // Recurrence only applies to new sessions
  document.getElementById('form-repeat-row').style.display     = id ? 'none' : '';
  document.getElementById('form-repeat-end-row').style.display = 'none';
  document.getElementById('form-repeat').value                 = '';
  document.getElementById('form-repeat-end-type').value        = 'count';
  document.getElementById('form-repeat-count').value           = '4';
  document.getElementById('form-repeat-until').value           = '';
  document.getElementById('form-repeat-count-wrap').style.display = '';
  document.getElementById('form-repeat-date-wrap').style.display  = 'none';

  const insuranceWrap = document.getElementById('form-insurance-wrap');
  if (insuranceWrap) {
    insuranceWrap.style.display = id ? 'none' : '';
    document.getElementById('form-insurance').checked = false;
  }

  if (id) {
    titleEl.textContent  = 'Edit session';
    submitEl.textContent = 'Save changes';
    _sessionRef(id).get().then(async doc => {
      if (!doc.exists) return;
      const s  = doc.data();
      const d  = s.date?.toDate();
      const dl = s.registrationDeadline?.toDate();
      document.getElementById('form-date').value        = d  ? d.toISOString().slice(0, 10) : '';
      document.getElementById('form-time').value        = s.time || '';
      document.getElementById('form-level').value       = s.level || '';
      _loadCoachOptions(s.coach || '', s.coachUid || '');
      document.getElementById('form-description').value = s.description || '';
      document.getElementById('form-max').value         = s.maxPlayers || '';
      document.getElementById('form-cost').value        = s.cost != null ? s.cost : '';
      document.getElementById('form-coach-fee').value   = s.coachFee != null ? s.coachFee : '50';
      document.getElementById('form-deadline').value    = dl ? dl.toISOString().slice(0, 16) : '';
      const statusSel = document.getElementById('form-status');
      if (s.status === 'closed' && !statusSel.querySelector('option[value="closed"]')) {
        const opt = document.createElement('option');
        opt.value = 'closed'; opt.textContent = 'Closed';
        statusSel.appendChild(opt);
      }
      statusSel.value = s.status || 'open';
      document.getElementById('form-ask-positions').checked = s.askPositions || false;
      document.getElementById('form-absorb-fee').checked   = s.absorbFee    || false;
      document.getElementById('form-type').value   = s.type   || 'game';
      document.getElementById('form-gender').value = s.gender || 'mixed';
      await _populateVenueSelect(s.venueId || '');
      await _populateSeriesSelect(s.seriesId || '');
      updateCostPreview();
    });
  } else {
    titleEl.textContent  = 'New session';
    submitEl.textContent = 'Create session';
    const now = new Date();
    document.getElementById('form-date').value        = now.toISOString().slice(0, 10);
    document.getElementById('form-time').value        = '10:00';
    document.getElementById('form-level').value       = '';
    document.getElementById('form-type').value        = 'game';
    document.getElementById('form-gender').value      = 'mixed';
    _loadCoachOptions('');
    document.getElementById('form-description').value = '';
    document.getElementById('form-max').value         = '12';
    document.getElementById('form-cost').value        = '0';
    document.getElementById('form-coach-fee').value   = '50';
    document.getElementById('form-deadline').value    = '';
    const statusSel = document.getElementById('form-status');
    statusSel.querySelector('option[value="closed"]')?.remove();
    statusSel.value = 'open';
    document.getElementById('form-ask-positions').checked = false;
    document.getElementById('form-absorb-fee').checked   = false;
    _populateVenueSelect('');
    _populateSeriesSelect(_activeSeriesFilter?.id || '');
    updateCostPreview();
  }

  // Hide admin-only fields when a provider (non-admin) creates a session
  const adminOnlyFields = ['form-coach-field', 'form-coach-fee-field', 'form-series-field',
                           'form-repeat-row', 'form-status-field', 'form-absorb-fee-field'];
  adminOnlyFields.forEach(fid => {
    const el = document.getElementById(fid);
    if (el) el.style.display = _isAdmin ? '' : 'none';
  });

  document.getElementById('session-form-overlay').classList.add('open');
}

function onRepeatChange() {
  const repeat = document.getElementById('form-repeat').value;
  document.getElementById('form-repeat-end-row').style.display = repeat ? '' : 'none';
}
function onRepeatEndTypeChange() {
  const type = document.getElementById('form-repeat-end-type').value;
  document.getElementById('form-repeat-count-wrap').style.display = type === 'count' ? '' : 'none';
  document.getElementById('form-repeat-date-wrap').style.display  = type === 'date'  ? '' : 'none';
}
function _expandDates(startDateStr, repeat, endType, endCount, endDateStr) {
  const dates = [];
  const d     = new Date(startDateStr + 'T12:00:00');
  const until = endType === 'date' && endDateStr ? new Date(endDateStr + 'T23:59:59') : null;
  const max   = endType === 'count' ? Math.min(endCount, 52) : 52;
  while (dates.length < max) {
    if (until && d > until) break;
    dates.push(new Date(d));
    if (repeat === 'weekly')   d.setDate(d.getDate() + 7);
    else if (repeat === 'biweekly') d.setDate(d.getDate() + 14);
    else if (repeat === 'monthly')  d.setMonth(d.getMonth() + 1);
  }
  return dates;
}

function updateCostPreview() {
  const val     = parseFloat(document.getElementById('form-cost').value) || 0;
  const absorb  = document.getElementById('form-absorb-fee').checked;
  const preview = document.getElementById('form-cost-preview');
  if (val === 0) {
    preview.textContent = 'Free session — no payment required';
  } else if (absorb) {
    preview.textContent = `Players will be charged £${val.toFixed(2)} (booking fee waived)`;
  } else {
    const pp = _playerPrice(val);
    preview.textContent = `Players will be charged £${pp.toFixed(2)} (covers card processing)`;
  }
}

function closeSessionForm() {
  document.getElementById('session-form-overlay').classList.remove('open');
  _editingId = null;
}

async function submitSessionForm() {
  if (!_isAdmin && !_isProvider) return;
  const dateVal     = document.getElementById('form-date').value;
  const timeVal     = document.getElementById('form-time').value;
  const venueSelEl  = document.getElementById('form-venue-select');
  const venueId     = venueSelEl.value;
  const venueObj    = _allVenues.find(v => v.id === venueId);
  const venueVal    = venueObj?.name || '';
  const coachSel    = _isAdmin ? document.getElementById('form-coach-select').value : '';
  const coachUidVal = _isAdmin && coachSel && coachSel !== '__custom__' ? coachSel : '';
  const coachVal    = _isAdmin
    ? (coachSel === '__custom__'
        ? document.getElementById('form-coach-custom').value.trim()
        : (coachSel ? document.querySelector(`#form-coach-select option[value="${coachSel}"]`)?.textContent || '' : ''))
    : '';
  const levelVal    = document.getElementById('form-level').value;
  const descVal     = document.getElementById('form-description').value.trim();
  const maxVal      = parseInt(document.getElementById('form-max').value);
  const costVal     = parseFloat(document.getElementById('form-cost').value) || 0;
  const coachFeeVal  = _isAdmin ? (parseFloat(document.getElementById('form-coach-fee').value) ?? 50) : 0;
  const deadlineVal  = document.getElementById('form-deadline').value;
  const status       = _isAdmin ? document.getElementById('form-status').value : 'open';
  const typeVal      = document.getElementById('form-type').value;
  const genderVal    = document.getElementById('form-gender').value;
  const seriesSelEl  = document.getElementById('form-series-select');
  const seriesIdVal  = seriesSelEl?.value || '';
  const seriesObj    = _allSeries.find(s => s.id === seriesIdVal);
  const seriesNameVal = seriesObj?.name || '';
  const errorEl      = document.getElementById('form-error');

  if (!dateVal)                    { errorEl.textContent = 'Please set a date.'; return; }
  if (!venueId)                    { errorEl.textContent = 'Please select a venue.'; return; }
  if (isNaN(maxVal) || maxVal < 1) { errorEl.textContent = 'Max players must be at least 1.'; return; }
  const insuranceEl = document.getElementById('form-insurance');
  if (insuranceEl && !_editingId && !insuranceEl.checked) {
    errorEl.textContent = 'Please confirm you hold public liability insurance.'; return;
  }

  errorEl.textContent = '';
  const btn = document.getElementById('form-submit-btn');
  btn.disabled = true;

  const data = {
    date:                 firebase.firestore.Timestamp.fromDate(new Date(dateVal + 'T12:00:00')),
    time:                 timeVal,
    venue:                venueVal,
    venueId:              venueId,
    coach:                coachVal,
    coachUid:             coachUidVal,
    level:                levelVal,
    description:          descVal,
    maxPlayers:           maxVal,
    cost:                 costVal,
    coachFee:             coachFeeVal,
    absorbFee:            _isAdmin ? document.getElementById('form-absorb-fee').checked : false,
    ...(insuranceEl && !_editingId ? { insuranceDeclaredBy: _currentUser.uid, insuranceDeclaredAt: firebase.firestore.FieldValue.serverTimestamp() } : {}),
    ...(!_editingId ? { providerUid: _currentUser.uid } : {}),
    playerPrice:          document.getElementById('form-absorb-fee').checked ? costVal : _playerPrice(costVal),
    askPositions:         document.getElementById('form-ask-positions').checked,
    type:                 typeVal,
    gender:               genderVal,
    seriesId:             seriesIdVal || null,
    seriesName:           seriesNameVal,
    registrationDeadline: deadlineVal
      ? firebase.firestore.Timestamp.fromDate(new Date(deadlineVal))
      : null,
    status,
  };

  const repeat    = !_editingId ? (document.getElementById('form-repeat').value || '') : '';
  const endType   = document.getElementById('form-repeat-end-type').value || 'count';
  const endCount  = parseInt(document.getElementById('form-repeat-count').value) || 4;
  const endDateStr = document.getElementById('form-repeat-until').value || '';

  const dates = repeat
    ? _expandDates(dateVal, repeat, endType, endCount, endDateStr)
    : [new Date(dateVal + 'T12:00:00')];

  if (!repeat && dates.length === 0) {
    errorEl.textContent = 'Invalid repeat configuration.';
    btn.disabled = false;
    return;
  }

  try {
    if (_editingId) {
      await _sessionRef(_editingId).update(data);
    } else if (dates.length === 1) {
      data.createdAt     = firebase.firestore.FieldValue.serverTimestamp();
      data.attendeeCount = 0;
      await _sessionsRef().add(data);
    } else {
      const batch = firebase.firestore().batch();
      dates.forEach(d => {
        const ref = _sessionsRef().doc();
        batch.set(ref, {
          ...data,
          date:          firebase.firestore.Timestamp.fromDate(d),
          createdAt:     firebase.firestore.FieldValue.serverTimestamp(),
          attendeeCount: 0,
        });
      });
      await batch.commit();
      showToast(`${dates.length} sessions created.`);
    }
    closeSessionForm();
    renderHome();
  } catch(e) {
    console.error('Save session failed:', e);
    errorEl.textContent = e.code === 'permission-denied'
      ? 'You don\'t have permission to do this. Make sure your account is listed as an admin in Firestore.'
      : 'Something went wrong. Try again.';
    btn.disabled = false;
  }
}

// ─── Delete session ────────────────────────────────────────────────────────────
async function deleteSession(id, venue, btn) {
  if (!_isAdmin) return;
  if (!confirm(`Delete session at "${venue}"?\n\nAttendees will be notified by email.`)) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await callFn('deleteSessionAdmin', { sessionId: id });
    renderHome();
  } catch(e) {
    console.error('Delete session failed:', e);
    showToast('Couldn\'t delete session. Try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✕'; }
  }
}

// ─── Session run ───────────────────────────────────────────────────────────────
const EQUIPMENT_ITEMS = [
  { key: 'volleyballs', label: 'Volleyballs',   type: 'count' },
  { key: 'tennis',      label: 'Tennis balls',  type: 'count' },
  { key: 'cones',       label: 'Cones',          type: 'count' },
  { key: 'hoops',       label: 'Setting hoops',  type: 'count' },
];

let _runSession   = null;
let _runAttendees = [];
let _runNumTeams  = 2;
let _runTeams     = null;

function _equipKey(sessionId) { return `vb-run-equip-${sessionId}`; }
function _getEquipState(sessionId) {
  try {
    const data = JSON.parse(localStorage.getItem(_equipKey(sessionId)) || '{}');
    return Array.isArray(data) ? {} : data;  // discard legacy Set-as-array format
  }
  catch { return {}; }
}
function _saveEquipState(sessionId, state) {
  localStorage.setItem(_equipKey(sessionId), JSON.stringify(state));
}

function toggleEquipment(sessionId, key) {
  const state = _getEquipState(sessionId);
  state[key] = !state[key];
  _saveEquipState(sessionId, state);
  _renderSessionRun();
}

function setEquipCount(sessionId, key, value) {
  const state = _getEquipState(sessionId);
  state[key] = Math.max(0, parseInt(value) || 0);
  _saveEquipState(sessionId, state);
}

async function _loadRunSessionData(sessionId) {
  _runTeams = null;
  const [sessionDoc, attendeesSnap] = await Promise.all([
    _sessionRef(sessionId).get(),
    _attendeesRef(sessionId).orderBy('joinedAt', 'asc').get(),
  ]);
  _runSession   = { id: sessionDoc.id, ...sessionDoc.data() };
  _runAttendees = attendeesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  _setTitle([_formatDate(_runSession.date), _runSession.time].filter(Boolean).join(' · '));
}

async function openSessionRun(sessionId) {
  _setHash('run/' + sessionId);
  showScreen('session-run');
  _setNav('sub', null);
  _setBack(() => closeSessionRun());
  const content = document.getElementById('run-content');
  content.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    await _loadRunSessionData(sessionId);
    _renderSessionRun();
  } catch(e) {
    content.innerHTML = '<div class="home-empty">Couldn\'t load session.</div>';
    console.error(e);
  }
}

function closeSessionRun() {
  if (_runSession) openSession(_runSession.id); else goHome();
}

function _renderSessionRun() {
  const content   = document.getElementById('run-content');
  const session   = _runSession;
  const attendees = _runAttendees;
  const equipState    = _getEquipState(session.id);
  const presentCount  = attendees.filter(a => a.present).length;

  const equipRows = EQUIPMENT_ITEMS.map(({ key, label, type }) => {
    if (type === 'count') {
      const count = equipState[key] || 0;
      return `
      <div class="checklist-row equip-row${count > 0 ? ' checked' : ''}">
        <input class="equip-count" type="number" min="0" inputmode="numeric"
          value="${count || ''}" placeholder="0"
          oninput="setEquipCount('${session.id}','${key}',this.value)" />
        <span>${label}</span>
      </div>`;
    } else {
      const checked = !!equipState[key];
      return `
      <label class="checklist-row equip-row${checked ? ' checked' : ''}">
        <input type="checkbox" ${checked ? 'checked' : ''}
          onchange="toggleEquipment('${session.id}','${key}')" />
        <span>${label}</span>
      </label>`;
    }
  }).join('');

  const POS = { setter: 'S', hitter: 'H', middle: 'M', libero: 'L' };
  const attendeeRows = attendees.map(a => {
    const gSym   = { man: '♂', woman: '♀', nonbinary: '⚧' }[a.gender] || '';
    const gClass = { man: 'gender-m', woman: 'gender-w', nonbinary: 'gender-nb' }[a.gender] || '';
    const posSet = new Set(a.positions || []);
    const chips  = session.askPositions
      ? Object.entries(POS).map(([k, l]) =>
          `<span class="att-chip${posSet.has(k) ? ' on-' + k : ''}">${l}</span>`
        ).join('') : '';
    return `
    <label class="checklist-row${a.present ? ' checked' : ''}">
      <input type="checkbox" ${a.present ? 'checked' : ''}
        onchange="togglePresent('${session.id}','${a.id}',${!!a.present})" />
      ${gSym ? `<span class="attendee-gender ${gClass}">${gSym}</span>` : ''}
      <span class="checklist-name">${esc(a.name)}</span>
      ${chips ? `<div class="att-chips">${chips}</div>` : ''}
    </label>`;
  }).join('');

  const teamsSection = presentCount >= 2 ? `
    <div class="teams-num-row">
      <span class="teams-num-label">Teams</span>
      <input class="teams-num-input" type="number" id="run-num-teams"
        min="2" max="6" value="${_runNumTeams}" inputmode="numeric"
        oninput="_runNumTeams=Math.max(2,parseInt(this.value)||2)" />
      <button class="cta-btn teams-build-btn" onclick="buildTeamsInRun()">Build →</button>
    </div>
    ${_runTeams ? _renderRunTeams(_runTeams) : ''}` : '<div class="empty-note">Mark attendance first.</div>';

  content.innerHTML = `
    <div class="run-section">
      <div class="run-section-title">Equipment</div>
      <div class="checklist">${equipRows}</div>
    </div>
    <div class="run-section">
      <div class="run-section-title">
        Attendance
        <span class="run-count">${presentCount} / ${attendees.length}</span>
      </div>
      <div class="checklist">${attendees.length ? attendeeRows : '<div class="empty-note">No registrations yet.</div>'}</div>
    </div>
    <div class="run-section">
      <div class="run-section-title">Teams</div>
      ${teamsSection}
    </div>`;
}

async function togglePresent(sessionId, uid, currentVal) {
  const next = !currentVal;
  const i = _runAttendees.findIndex(a => a.id === uid);
  if (i >= 0) _runAttendees[i].present = next;
  _runTeams = null;
  _renderSessionRun();
  try {
    await _attendeesRef(sessionId).doc(uid).update({ present: next });
  } catch(e) {
    console.error('Toggle present failed:', e);
    showToast('Couldn\'t update attendance. Try again.', 'error');
    if (i >= 0) _runAttendees[i].present = currentVal;
    _renderSessionRun();
  }
}

function buildTeamsInRun() {
  const numTeams = Math.max(2, parseInt(document.getElementById('run-num-teams')?.value) || 2);
  _runNumTeams = numTeams;
  const present = _runAttendees.filter(a => a.present);
  const women  = present.filter(p => p.gender === 'woman').sort(() => Math.random() - .5);
  const others = present.filter(p => p.gender !== 'woman').sort(() => Math.random() - .5);
  const teams  = Array.from({ length: numTeams }, () => []);
  [...women, ...others].forEach((p, i) => teams[i % numTeams].push(p));
  _runTeams = teams;
  _renderSessionRun();
}

function _renderRunTeams(teams) {
  return `<div class="teams-grid">
    ${teams.map((team, i) => `
      <div class="team-card">
        <div class="team-card-title">Team ${i + 1}</div>
        ${team.map(p => {
          const sym = { man: '♂', woman: '♀', nonbinary: '⚧' }[p.gender] || '';
          const cls = { man: 'gender-m', woman: 'gender-w', nonbinary: 'gender-nb' }[p.gender] || '';
          return `<div class="team-player">
            ${sym ? `<span class="attendee-gender ${cls}">${sym}</span>` : ''}
            <span>${esc(p.name)}</span>
          </div>`;
        }).join('')}
      </div>`).join('')}
  </div>`;
}

// ─── Session end ───────────────────────────────────────────────────────────────
function _endEquipKey(sessionId) { return `vb-end-equip-${sessionId}`; }
function _getEndEquipState(sessionId) {
  try { return JSON.parse(localStorage.getItem(_endEquipKey(sessionId)) || '{}'); }
  catch { return {}; }
}
function _saveEndEquipState(sessionId, state) {
  localStorage.setItem(_endEquipKey(sessionId), JSON.stringify(state));
}

function openSessionEnd() {
  if (!_runSession) return;
  _setHash('end/' + _runSession.id);
  showScreen('session-end');
  _setNav('sub', null);
  _setBack(() => closeSessionEnd());
  _renderSessionEnd();
}

function closeSessionEnd() {
  _setHash('run/' + _runSession.id);
  showScreen('session-run');
  _setNav('sub', null);
  _setBack(() => closeSessionRun());
}

function _renderSessionEnd() {
  const content    = document.getElementById('end-content');
  const footer     = document.querySelector('#screen-session-end .footer');
  const session    = _runSession;

  if (session.status === 'closed' && session.report) {
    _renderReport(session.report, session);
    return;
  }

  if (footer) footer.innerHTML =
    `<button class="cta-btn" onclick="closeSession()">Close session →</button>`;
  const startState = _getEquipState(session.id);
  const endState   = _getEndEquipState(session.id);

  const rows = EQUIPMENT_ITEMS.map(({ key, label }) => {
    const startCount = startState[key] || 0;
    const endVal     = endState[key];
    const hasEnd     = typeof endVal === 'number';
    const diff       = hasEnd ? startCount - endVal : null;
    const diffHtml =
      !hasEnd || startCount === 0 ? `<span class="end-diff" id="end-diff-${key}"></span>` :
      diff <= 0                   ? `<span class="end-diff ok"  id="end-diff-${key}">✓</span>` :
                                    `<span class="end-diff bad" id="end-diff-${key}">−${diff}</span>`;
    return `
    <div class="end-equip-row">
      <span class="end-equip-label">${label}</span>
      <span class="end-equip-start">${startCount > 0 ? startCount : '—'}</span>
      <input class="equip-count" type="number" min="0" inputmode="numeric"
        value="${hasEnd ? endVal : ''}" placeholder="0"
        oninput="setEndEquipCount('${session.id}','${key}',this.value)" />
      ${diffHtml}
    </div>`;
  }).join('');

  content.innerHTML = `
    <div class="run-section">
      <div class="run-section-title">Equipment check</div>
      <div class="end-equip-header">
        <span></span>
        <span class="end-col-label">Start</span>
        <span class="end-col-label">End</span>
        <span></span>
      </div>
      <div class="end-equip-list">${rows}</div>
      <div class="end-summary" id="end-summary"></div>
    </div>`;

  _updateEndSummary(session.id);
}

function setEndEquipCount(sessionId, key, value) {
  const state = _getEndEquipState(sessionId);
  state[key]  = Math.max(0, parseInt(value) || 0);
  _saveEndEquipState(sessionId, state);

  const startCount = _getEquipState(sessionId)[key] || 0;
  const diffEl     = document.getElementById(`end-diff-${key}`);
  if (diffEl && startCount > 0) {
    const diff     = startCount - state[key];
    diffEl.textContent = diff <= 0 ? '✓' : `−${diff}`;
    diffEl.className   = `end-diff ${diff <= 0 ? 'ok' : 'bad'}`;
  }
  _updateEndSummary(sessionId);
}

function _updateEndSummary(sessionId) {
  const el         = document.getElementById('end-summary');
  if (!el) return;
  const startState = _getEquipState(sessionId);
  const endState   = _getEndEquipState(sessionId);
  const relevant   = EQUIPMENT_ITEMS.filter(({ key }) => (startState[key] || 0) > 0);
  const answered   = relevant.filter(({ key }) => typeof endState[key] === 'number');
  if (!answered.length) { el.textContent = ''; el.className = 'end-summary'; return; }

  const missing = answered.filter(({ key }) => endState[key] < (startState[key] || 0));
  if (missing.length) {
    el.className  = 'end-summary bad';
    el.innerHTML  = '<strong>Missing:</strong> ' +
      missing.map(({ key, label }) =>
        `${(startState[key] || 0) - endState[key]} ${label.toLowerCase()}`
      ).join(', ');
  } else {
    el.className  = 'end-summary ok';
    el.textContent = 'All equipment accounted for ✓';
  }
}

async function closeSession() {
  if (!_currentUser || !_runSession) return;
  if (!confirm('Close this session and generate its report?')) return;

  const session          = _runSession;
  const startState       = _getEquipState(session.id);
  const endState         = _getEndEquipState(session.id);
  const presentAttendees = _runAttendees.filter(a => a.present);
  const noShows          = _runAttendees.length - presentAttendees.length;

  const missingEquip = EQUIPMENT_ITEMS
    .filter(({ key }) => (startState[key] || 0) > 0 && typeof endState[key] === 'number' && endState[key] < startState[key])
    .map(({ key, label }) => ({ key, label, count: startState[key] - endState[key] }));

  const genderBreakdown = {
    women:   presentAttendees.filter(a => a.gender === 'woman').length,
    men:     presentAttendees.filter(a => a.gender === 'man').length,
    other:   presentAttendees.filter(a => a.gender === 'nonbinary').length,
    unknown: presentAttendees.filter(a => !a.gender).length,
  };

  const positionBreakdown = session.askPositions ? {
    setter: presentAttendees.filter(a => (a.positions || []).includes('setter')).length,
    hitter: presentAttendees.filter(a => (a.positions || []).includes('hitter')).length,
    middle: presentAttendees.filter(a => (a.positions || []).includes('middle')).length,
    libero: presentAttendees.filter(a => (a.positions || []).includes('libero')).length,
  } : null;

  const playerPrice = parseFloat(session.cost) || 0;

  const report = {
    closedAt:     firebase.firestore.FieldValue.serverTimestamp(),
    closedBy:     _currentUser.uid,
    closedByName: _currentUser.displayName || _currentUser.email || '',
    venue:        session.venue        || '',
    date:         session.date         || null,
    time:         session.time         || '',
    coach:        session.coach        || '',
    level:        session.level        || '',
    cost:         playerPrice,
    maxPlayers:   session.maxPlayers   || 0,
    description:  session.description  || '',
    askPositions: !!session.askPositions,
    attendance: {
      registered: _runAttendees.length,
      present:    presentAttendees.length,
      noShows,
      attendees:  _runAttendees.map(a => ({
        name: a.name, gender: a.gender || null, present: !!a.present,
      })),
    },
    equipment: {
      start:   startState,
      end:     endState,
      missing: missingEquip,
    },
    stats: {
      fillRate:       session.maxPlayers
                        ? Math.round(presentAttendees.length / session.maxPlayers * 100) : null,
      attendanceRate: _runAttendees.length
                        ? Math.round(presentAttendees.length / _runAttendees.length * 100) : null,
      genderBreakdown,
      positionBreakdown,
      revenue: playerPrice > 0 ? {
        playerPrice,
        expected:     playerPrice * _runAttendees.length,
        actual:       playerPrice * presentAttendees.length,
        noShowImpact: playerPrice * noShows,
      } : null,
    },
  };

  const btn = document.querySelector('#screen-session-end .footer .cta-btn');
  if (btn) btn.disabled = true;
  try {
    await _sessionRef(session.id).update({ status: 'closed', report });
    _runSession = { ..._runSession, status: 'closed', report };
    _renderReport(report, session);
  } catch(e) {
    console.error('Close session failed:', e);
    showToast('Couldn\'t close session. Try again.', 'error');
    if (btn) btn.disabled = false;
  }
}

function _renderReport(report, session) {
  const content = document.getElementById('end-content');
  const footer  = document.querySelector('#screen-session-end .footer');
  if (footer) footer.innerHTML =
    `<button class="cta-btn secondary-btn" onclick="openSession('${session.id}')">← Back to session</button>
     ${_isAdmin && session.coach && session.coachFee > 0 ? _coachPayCtaBtn(session) : ''}
     ${_isAdmin ? `<button class="cta-btn secondary-btn" onclick="exportReportCsv(_runSession, _runSession.report)">⬇ Export CSV</button>` : ''}
     ${_isAdmin ? `<button class="cta-btn secondary-btn" onclick="printReport()">🖨 Print report</button>` : ''}`;

  const gSym = { man: '♂', woman: '♀', nonbinary: '⚧' };
  const gCls = { man: 'gender-m', woman: 'gender-w', nonbinary: 'gender-nb' };
  const att  = report.attendance || {};
  const st   = report.stats      || {};
  const eq   = report.equipment  || {};

  // ── Attendance list ─────────────────────────────────────────────────────────
  const attendeeRows = (att.attendees || []).map(a => `
    <div class="report-row${a.present ? '' : ' report-absent'}">
      <span class="report-tick">${a.present ? '✓' : '✗'}</span>
      ${a.gender ? `<span class="attendee-gender ${gCls[a.gender] || ''}">${gSym[a.gender] || ''}</span>` : ''}
      <span>${esc(a.name)}</span>
    </div>`).join('');

  // ── Equipment list ───────────────────────────────────────────────────────────
  const equipRows = EQUIPMENT_ITEMS.map(({ key, label }) => {
    const start  = (eq.start || {})[key] || 0;
    const end    = (eq.end   || {})[key];
    const hasEnd = typeof end === 'number';
    if (!start && !hasEnd) return '';
    const diff = hasEnd ? start - end : null;
    return `
    <div class="report-equip-row">
      <span>${label}</span>
      <span class="report-equip-counts">
        ${start || '—'}${hasEnd ? ` → ${end}` : ''}
        ${diff === null ? '' : diff > 0
          ? `<span class="end-diff bad">−${diff}</span>`
          : `<span class="end-diff ok">✓</span>`}
      </span>
    </div>`;
  }).filter(Boolean).join('');

  // ── Statistics rows ──────────────────────────────────────────────────────────
  const meta = (label, value) =>
    `<div class="detail-meta-row"><span class="detail-meta-label">${label}</span><span>${value}</span></div>`;

  const gb = st.genderBreakdown || {};
  const genderParts = [
    gb.women  ? `${gb.women}♀`  : '',
    gb.men    ? `${gb.men}♂`    : '',
    gb.other  ? `${gb.other}⚧`  : '',
  ].filter(Boolean);

  const pb = st.positionBreakdown;
  const positionParts = pb ? [
    pb.setter ? `${pb.setter} S` : '',
    pb.hitter ? `${pb.hitter} H` : '',
    pb.middle ? `${pb.middle} M` : '',
    pb.libero ? `${pb.libero} L` : '',
  ].filter(Boolean) : [];

  const statsRows = [
    st.fillRate       != null ? meta('Fill rate',       `${st.fillRate}% (${att.present}/${report.maxPlayers || '?'})`) : '',
    st.attendanceRate != null ? meta('Attendance rate', `${st.attendanceRate}% (${att.present}/${att.registered} registered)`) : '',
    att.noShows       > 0    ? meta('No-shows',        att.noShows) : '',
    genderParts.length       ? meta('Gender split',    genderParts.join(' · ')) : '',
    positionParts.length     ? meta('Positions',       positionParts.join(' · ')) : '',
  ].filter(Boolean).join('');

  // ── Revenue rows ─────────────────────────────────────────────────────────────
  const rev = st.revenue;
  const fmt = n => `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const revenueSection = rev ? `
    <div class="run-section">
      <div class="run-section-title">Revenue</div>
      <div class="detail-meta-grid">
        ${meta('Per player',  fmt(rev.playerPrice))}
        ${meta('Expected',    `${fmt(rev.expected)} (${att.registered} registered)`)}
        ${meta('Actual',      `${fmt(rev.actual)} (${att.present} present)`)}
        ${rev.noShowImpact > 0 ? meta('No-show gap', `${fmt(rev.noShowImpact)} (${att.noShows} no-shows)`) : ''}
      </div>
    </div>` : '';

  // ── Session info ──────────────────────────────────────────────────────────────
  const closedDate = report.closedAt?.toDate ? _formatDate(report.closedAt) : '';
  const levelLabels = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', competitive: 'Competitive' };

  content.innerHTML = `
    <div class="run-section">
      <div class="run-section-title">
        Attendance
        <span class="run-count">${att.present ?? '?'} / ${att.registered ?? '?'}</span>
      </div>
      <div class="report-list">${attendeeRows || '<div class="empty-note">No data.</div>'}</div>
    </div>
    <div class="run-section">
      <div class="run-section-title">Statistics</div>
      <div class="detail-meta-grid">
        ${statsRows || '<div class="empty-note">No statistics available.</div>'}
      </div>
    </div>
    <div class="run-section">
      <div class="run-section-title">Equipment</div>
      <div class="report-list">${equipRows || '<div class="empty-note">No equipment recorded.</div>'}</div>
    </div>
    ${revenueSection}
    <div class="run-section">
      <div class="run-section-title">Session info</div>
      <div class="detail-meta-grid">
        ${report.venue      ? meta('Venue',      esc(report.venue))                          : ''}
        ${report.date       ? meta('Date',       _formatDate(report.date))                   : ''}
        ${report.time       ? meta('Time',       esc(report.time))                           : ''}
        ${report.coach      ? meta('Coach',      esc(report.coach))                          : ''}
        ${report.level      ? meta('Level',      levelLabels[report.level] || esc(report.level)) : ''}
        ${report.cost       ? meta('Cost',       fmt(report.cost) + ' per player')           : ''}
        ${report.maxPlayers ? meta('Capacity',   report.maxPlayers + ' players')             : ''}
        ${closedDate        ? meta('Closed',     `${closedDate} by ${esc(report.closedByName)}`) : ''}
      </div>
    </div>`;
}

// ─── CSV / print export ────────────────────────────────────────────────────────
function _downloadCsv(filename, rows) {
  const csv = rows.map(r =>
    r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  const a   = Object.assign(document.createElement('a'), {
    href:     'data:text/csv;charset=utf-8,' + encodeURIComponent(csv),
    download: filename,
  });
  a.click();
}

async function exportAttendeesCsv(sessionId) {
  if (!_isAdmin) return;
  try {
    const snap = await _attendeesRef(sessionId).orderBy('joinedAt', 'asc').get();
    const rows = [
      ['Name', 'Email', 'Gender', 'Positions', 'Paid', 'Present', 'Fee waived', 'Joined'],
      ...snap.docs.map(d => {
        const a = d.data();
        return [
          a.name, a.email,
          a.gender || '',
          (a.positions || []).join(';'),
          a.paid      ? 'yes' : 'no',
          a.present   ? 'yes' : 'no',
          a.feeWaived ? 'yes' : 'no',
          a.joinedAt  ? _formatDate(a.joinedAt) : '',
        ];
      }),
    ];
    const session = _currentSession || {};
    const label   = [session.venue, _formatDate(session.date)].filter(Boolean).join(' ');
    _downloadCsv(`attendees${label ? '-' + label.replace(/[^a-z0-9]/gi, '-') : ''}.csv`, rows);
  } catch(e) {
    showToast('Export failed. Try again.', 'error');
  }
}

function exportReportCsv(session, report) {
  const att  = report?.attendance || {};
  const st   = report?.stats      || {};
  const rev  = st.revenue         || {};
  const fmt  = n => n != null ? `£${Number.isInteger(n) ? n : Number(n).toFixed(2)}` : '';

  const info = [
    ['Session report'],
    [],
    ['Venue',    session.venue || ''],
    ['Date',     _formatDate(session.date)],
    ['Time',     session.time || ''],
    ['Coach',    report.coach || session.coach || ''],
    ['Level',    session.level || ''],
    ['Capacity', session.maxPlayers || ''],
    ['Cost',     fmt(session.cost)],
    [],
    ['Attendance'],
    ['Registered', att.registered ?? ''],
    ['Present',    att.present    ?? ''],
    ['No-shows',   att.noShows    ?? ''],
  ];

  if (rev.actual != null) {
    info.push([], ['Revenue'], ['Expected', fmt(rev.expected)], ['Actual', fmt(rev.actual)]);
  }

  info.push([], ['Attendees'], ['Name', 'Present', 'Gender']);
  (att.attendees || []).forEach(a => info.push([a.name, a.present ? 'yes' : 'no', a.gender || '']));

  const label = [session.venue, _formatDate(session.date)].filter(Boolean).join(' ');
  _downloadCsv(`report${label ? '-' + label.replace(/[^a-z0-9]/gi, '-') : ''}.csv`, info);
}

function printReport() {
  window.print();
}

async function openSessionEndReport(sessionId) {
  try {
    await _loadRunSessionData(sessionId);
    const sessionDoc = await _sessionRef(sessionId).get();
    _runSession = { id: sessionDoc.id, ...sessionDoc.data() };
    _setHash('end/' + sessionId);
    showScreen('session-end');
    _setNav('sub', null);
    _setBack(() => closeSessionEnd());
    _renderSessionEnd();
  } catch(e) {
    console.error(e);
    showToast('Couldn\'t load report.', 'error');
  }
}

// ─── Message attendees overlay ─────────────────────────────────────────────────
let _messagingSessionId = null;

function openMessageForm(sessionId) {
  if (!_isAdmin) return;
  _messagingSessionId = sessionId;
  document.getElementById('message-subject').value = '';
  document.getElementById('message-body').value    = '';
  document.getElementById('message-error').textContent = '';
  const btn = document.getElementById('message-send-btn');
  btn.disabled = false;
  document.getElementById('message-overlay').classList.add('open');
}

function closeMessageForm() {
  document.getElementById('message-overlay').classList.remove('open');
  _messagingSessionId = null;
}

async function sendMessage() {
  if (!_isAdmin || !_messagingSessionId) return;
  const errorEl = document.getElementById('message-error');
  const subject = document.getElementById('message-subject').value.trim();
  const body    = document.getElementById('message-body').value.trim();

  if (!subject) { errorEl.textContent = 'Please enter a subject.'; return; }
  if (!body)    { errorEl.textContent = 'Please enter a message.'; return; }

  errorEl.textContent = '';
  const btn = document.getElementById('message-send-btn');
  btn.disabled = true;

  try {
    const data = await callFn('messageSessionAttendees', {
      sessionId: _messagingSessionId, subject, body,
    });
    closeMessageForm();
    showToast(`Message sent to ${data.sent} attendee${data.sent !== 1 ? 's' : ''}.`);
  } catch(e) {
    console.error('Send message failed:', e);
    errorEl.textContent = e.message || 'Couldn\'t send message. Try again.';
    btn.disabled = false;
  }
}

// ─── Edit profile overlay ──────────────────────────────────────────────────────
async function openEditProfile() {
  if (!_currentUser) return;
  const errorEl = document.getElementById('edit-profile-error');
  errorEl.textContent = '';

  try {
    const doc  = await _userRef(_currentUser.uid).get();
    const data = doc.data() || {};
    document.getElementById('edit-profile-name').value    = data.name || _currentUser.displayName || '';
    document.getElementById('edit-profile-gender').value  = data.gender || '';
    document.getElementById('edit-profile-level').value   = data.level  || '';
    const posSet = new Set(data.positions || []);
    document.querySelectorAll('#edit-profile-positions input').forEach(cb => {
      cb.checked = posSet.has(cb.value);
    });
    _updateCoachRequestBtn(data);
    _updateProviderRequestBtn(data);
  } catch(e) {
    console.error('Load profile failed:', e);
  }

  document.getElementById('edit-profile-overlay').classList.add('open');
}

function closeEditProfile() {
  document.getElementById('edit-profile-overlay').classList.remove('open');
}

async function saveProfile() {
  const errorEl   = document.getElementById('edit-profile-error');
  const name      = document.getElementById('edit-profile-name').value.trim();
  const gender    = document.getElementById('edit-profile-gender').value;
  const level     = document.getElementById('edit-profile-level').value;
  const positions = Array.from(
    document.querySelectorAll('#edit-profile-positions input:checked')
  ).map(el => el.value);

  if (!name) { errorEl.textContent = 'Name cannot be empty.'; return; }

  errorEl.textContent = '';
  const btn = document.getElementById('edit-profile-save-btn');
  btn.disabled = true;

  try {
    await _userRef(_currentUser.uid).update({
      name,
      gender:    gender || null,
      level:     level  || null,
      positions,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    closeEditProfile();
    showToast('Profile updated.');
  } catch(e) {
    console.error('Save profile failed:', e);
    errorEl.textContent = 'Couldn\'t save profile. Try again.';
    btn.disabled = false;
  }
}

async function requestCoachStatus() {
  if (!_currentUser) return;
  const btn = document.getElementById('coach-request-btn');
  if (btn) btn.disabled = true;
  try {
    await _userRef(_currentUser.uid).update({
      coachRequest: true,
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp(),
    });
    await callFn('notifyCoachRequest', { uid: _currentUser.uid, name: _currentUser.displayName || '' });
    showToast('Coach request sent — an admin will review it.');
    closeEditProfile();
  } catch(e) {
    console.error('Coach request failed:', e);
    if (btn) btn.disabled = false;
    showToast('Couldn\'t send request. Try again.', 'error');
  }
}

async function requestProviderStatus() {
  if (!_currentUser) return;
  const btn = document.getElementById('provider-request-btn');
  if (btn) btn.disabled = true;
  try {
    await _userRef(_currentUser.uid).update({
      providerRequest: true,
      updatedAt:       firebase.firestore.FieldValue.serverTimestamp(),
    });
    await callFn('notifyProviderRequest', { uid: _currentUser.uid, name: _currentUser.displayName || '' });
    showToast('Host request sent — an admin will review it.');
    closeEditProfile();
  } catch(e) {
    console.error('Provider request failed:', e);
    if (btn) btn.disabled = false;
    showToast('Couldn\'t send request. Try again.', 'error');
  }
}

async function requestCoachStatusFromView() {
  if (!_currentUser) return;
  const btn = document.getElementById('coach-request-view-btn');
  if (btn) { btn.textContent = 'Request pending'; btn.disabled = true; }
  try {
    await _userRef(_currentUser.uid).update({
      coachRequest: true,
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp(),
    });
    await callFn('notifyCoachRequest', { uid: _currentUser.uid, name: _currentUser.displayName || '' });
  } catch(e) {
    console.error('Coach request failed:', e);
    if (btn) { btn.textContent = 'Request →'; btn.disabled = false; }
    showToast('Request failed: ' + (e.message || 'unknown error'), 'error');
  }
}

async function requestProviderStatusFromView() {
  if (!_currentUser) return;
  const btn = document.getElementById('provider-request-view-btn');
  if (btn) { btn.textContent = 'Request pending'; btn.disabled = true; }
  try {
    await _userRef(_currentUser.uid).update({
      providerRequest: true,
      updatedAt:       firebase.firestore.FieldValue.serverTimestamp(),
    });
    await callFn('notifyProviderRequest', { uid: _currentUser.uid, name: _currentUser.displayName || '' });
  } catch(e) {
    console.error('Provider request failed:', e);
    if (btn) { btn.textContent = 'Request →'; btn.disabled = false; }
    showToast('Request failed: ' + (e.message || 'unknown error'), 'error');
  }
}

async function startProviderOnboarding() {
  const btn = document.getElementById('provider-stripe-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    const { url } = await callFn('providerOnboardingLink', { uid: _currentUser.uid });
    window.location.href = url;
  } catch(e) {
    console.error('Provider onboarding failed:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Set up payments →'; }
    showToast('Couldn\'t start onboarding. Try again.', 'error');
  }
}

function _updateCoachRequestBtn(data) {
  const field  = document.getElementById('coach-request-field');
  const btn    = document.getElementById('coach-request-btn');
  if (!field || !btn) return;
  const isCoach   = (data.roles || []).includes('coach');
  const isPending = !!data.coachRequest;
  if (isCoach) {
    field.style.display = 'none';
    return;
  }
  field.style.display = '';
  if (isPending) {
    btn.textContent = 'Coach request pending';
    btn.disabled    = true;
    btn.className   = 'coach-request-btn pending';
  } else {
    btn.textContent = 'Request coach status →';
    btn.disabled    = false;
    btn.className   = 'coach-request-btn';
  }
}

function _updateProviderRequestBtn(data) {
  const field       = document.getElementById('provider-request-field');
  const stripeField = document.getElementById('provider-stripe-field');
  const btn         = document.getElementById('provider-request-btn');
  if (!field || !btn) return;
  const roles      = data.roles || [];
  const isProvider = roles.includes('provider');
  const isPending  = !!data.providerRequest && !isProvider;
  const needsStripe = isProvider && !data.providerOnboardingComplete;

  // Request row: hidden once approved as provider
  field.style.display = isProvider ? 'none' : '';
  // Stripe setup row: only shown after provider role is granted
  if (stripeField) stripeField.style.display = needsStripe ? '' : 'none';

  if (!isProvider) {
    if (isPending) {
      btn.textContent = 'Host request pending';
      btn.disabled    = true;
      btn.className   = 'coach-request-btn pending';
    } else {
      btn.textContent = 'Host with us →';
      btn.disabled    = false;
      btn.className   = 'coach-request-btn';
    }
  }
}

// ─── Policy overlay ────────────────────────────────────────────────────────────
function openPolicy() {
  document.getElementById('policy-overlay').classList.add('open');
}
function closePolicy() {
  document.getElementById('policy-overlay').classList.remove('open');
}

// ─── Finances screen ────────────────────────────────────────────────────────────
function computeSessionFinancials(session) {
  const attendeeCount = session.attendeeCount || 0;
  const playerPrice   = session.absorbFee ? (session.cost || 0) : _playerPrice(session.cost || 0);
  const revenue       = playerPrice * attendeeCount;
  const coachFee      = (session.coachFee || 0);
  const net           = revenue - coachFee;
  return { revenue, coachFee, net, attendeeCount, playerPrice };
}

// ─── Shared session cache ──────────────────────────────────────────────────────

let _allSessions = [];

async function _loadAllSessions() {
  if (_allSessions.length) return;
  const snap = await _sessionsRef().orderBy('date', 'desc').get();
  _allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Finances screen (simple table) ───────────────────────────────────────────

function openFinancesScreen() {
  if (!_isAdmin) return;
  _setHash('finances');
  showScreen('finances');
  _setNav('primary', 'finances');
  _setTitle('Sessions');
  renderFinances();
}

async function renderFinances() {
  const container = document.getElementById('finances-content');
  container.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    await _loadAllSessions();
    const sessions = _allSessions.filter(s => s.status === 'closed');
    if (!sessions.length) {
      container.innerHTML = '<div class="home-empty">No closed sessions yet.</div>'; return;
    }
    let totalRevenue = 0, totalCosts = 0, totalNet = 0;
    const fmt  = n => `£${n.toFixed(2)}`;
    const rows = sessions.map(s => {
      const { revenue, coachFee, net, attendeeCount, playerPrice } = computeSessionFinancials(s);
      totalRevenue += revenue; totalCosts += coachFee; totalNet += net;
      return `<tr>
        <td>${esc(_formatDate(s.date))}</td>
        <td>${esc(s.venue || '—')}</td>
        <td class="fin-num">${attendeeCount}</td>
        <td class="fin-num">${playerPrice > 0 ? fmt(playerPrice) : 'Free'}</td>
        <td class="fin-num">${fmt(revenue)}</td>
        <td class="fin-num">${coachFee > 0 ? fmt(coachFee) : '—'}</td>
        <td class="fin-num ${net < 0 ? 'fin-neg' : 'fin-pos'}">${fmt(net)}</td>
      </tr>`;
    }).join('');
    container.innerHTML = `
      <div class="finances-table-wrap">
        <table class="finances-table">
          <thead><tr>
            <th>Date</th><th>Venue</th><th class="fin-num">Players</th>
            <th class="fin-num">Price</th><th class="fin-num">Revenue</th>
            <th class="fin-num">Coach fee</th><th class="fin-num">Net</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr class="fin-total">
            <td colspan="4">Total (${sessions.length} sessions)</td>
            <td class="fin-num">${fmt(totalRevenue)}</td>
            <td class="fin-num">${fmt(totalCosts)}</td>
            <td class="fin-num ${totalNet < 0 ? 'fin-neg' : 'fin-pos'}">${fmt(totalNet)}</td>
          </tr></tfoot>
        </table>
      </div>`;
  } catch(e) {
    container.innerHTML = '<div class="home-empty">Couldn\'t load finances.</div>';
    console.error(e);
  }
}

function _kpi(label, value, color) {
  return `<div class="kpi-tile">
    <div class="kpi-value kpi-${color}">${value}</div>
    <div class="kpi-label">${label}</div>
  </div>`;
}

// ─── Inline SVG charts ────────────────────────────────────────────────────────

function _chartRevenue(sessions) {
  if (sessions.length < 2) return '';
  const byMonth = {};
  sessions.forEach(s => {
    const d   = s.date?.toDate ? s.date.toDate() : new Date(s.date);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (!byMonth[key]) byMonth[key] = { revenue: 0, costs: 0 };
    const f = computeSessionFinancials(s);
    byMonth[key].revenue += f.revenue;
    byMonth[key].costs   += f.coachFee;
  });
  const months = Object.keys(byMonth).sort();
  if (months.length < 2) return '';

  // Fixed 160px tall SVG; scale text to match
  const W = 560, H = 160, PAD = { t: 12, r: 80, b: 32, l: 48 };
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
  const maxVal = Math.max(...months.map(m => byMonth[m].revenue), 1);
  const x  = i => PAD.l + (i / (months.length - 1)) * cw;
  const yr = m => PAD.t + ch - (byMonth[m].revenue / maxVal) * ch;
  const yc = m => PAD.t + ch - (byMonth[m].costs   / maxVal) * ch;
  const yn = m => PAD.t + ch - (Math.max(0, byMonth[m].revenue - byMonth[m].costs) / maxVal) * ch;

  const line = (pts, color) =>
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

  const revPts  = months.map((m,i) => `${x(i).toFixed(1)},${yr(m).toFixed(1)}`).join(' ');
  const costPts = months.map((m,i) => `${x(i).toFixed(1)},${yc(m).toFixed(1)}`).join(' ');
  const netPts  = months.map((m,i) => `${x(i).toFixed(1)},${yn(m).toFixed(1)}`).join(' ');

  const ticks = [0, Math.round(maxVal/2), Math.round(maxVal)].map(v => {
    const yy = (PAD.t + ch - (v / maxVal) * ch).toFixed(1);
    return `<line x1="${PAD.l-4}" y1="${yy}" x2="${PAD.l+cw}" y2="${yy}" stroke="var(--border)" stroke-dasharray="4,4"/>
            <text x="${PAD.l-8}" y="${yy}" text-anchor="end" dominant-baseline="middle" fill="var(--muted)" font-size="11">£${v}</text>`;
  }).join('');

  const xLabels = months.map((m, i) => {
    const [y, mo] = m.split('-');
    const label   = new Date(+y, +mo-1).toLocaleString('en-GB', { month: 'short', year: '2-digit' });
    return `<text x="${x(i).toFixed(1)}" y="${H-6}" text-anchor="middle" fill="var(--muted)" font-size="11">${label}</text>`;
  }).join('');

  const legend = `
    <text x="${W-4}" y="${PAD.t+8}"  text-anchor="end" fill="var(--green)"  font-size="11">● Revenue</text>
    <text x="${W-4}" y="${PAD.t+22}" text-anchor="end" fill="var(--red)"    font-size="11">● Costs</text>
    <text x="${W-4}" y="${PAD.t+36}" text-anchor="end" fill="var(--amber)"  font-size="11">● Net</text>`;

  return `<div class="fin-chart">
    <div class="fin-chart-title">Revenue over time</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:160px;display:block">
      <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t+ch}" stroke="var(--border2)"/>
      <line x1="${PAD.l}" y1="${PAD.t+ch}" x2="${PAD.l+cw}" y2="${PAD.t+ch}" stroke="var(--border2)"/>
      ${ticks}${xLabels}${legend}
      ${line(revPts, 'var(--green)')}
      ${line(costPts,'var(--red)')}
      ${line(netPts, 'var(--amber)')}
    </svg>
  </div>`;
}

function _chartFill(sessions) {
  const data = sessions.filter(s => s.maxPlayers > 0).slice(0, 20).reverse();
  if (data.length < 2) return '';
  const bars = data.map(s => {
    const rate  = Math.min(1, (s.attendeeCount || 0) / s.maxPlayers);
    const pct   = Math.round(rate * 100);
    const color = rate >= 0.8 ? 'var(--green)' : rate >= 0.5 ? 'var(--amber)' : 'var(--red)';
    const label = _formatDate(s.date)?.split(' ').slice(0,2).join(' ') || '';
    return `<div class="bar-col" title="${esc(label)} — ${pct}%">
      <div class="bar-fill" style="height:${pct}%;background:${color}"></div>
      <div class="bar-tip">${pct}%</div>
    </div>`;
  }).join('');
  return `<div class="fin-chart">
    <div class="fin-chart-title">Session fill rate (last ${data.length})</div>
    <div class="bar-chart-wrap">
      <div class="bar-y-labels"><span>100%</span><span>50%</span><span>0%</span></div>
      <div class="bar-chart">${bars}</div>
    </div>
  </div>`;
}

function _chartVenue(sessions) {
  const byVenue = {};
  sessions.forEach(s => {
    const v = s.venue || 'Unknown';
    if (!byVenue[v]) byVenue[v] = 0;
    byVenue[v] += computeSessionFinancials(s).revenue;
  });
  const entries = Object.entries(byVenue).sort((a,b) => b[1]-a[1]).slice(0, 6);
  if (entries.length < 2) return '';
  const maxVal = entries[0][1] || 1;
  const rows = entries.map(([venue, rev]) => `
    <div class="hbar-row">
      <span class="hbar-label">${esc(venue)}</span>
      <div class="hbar-track"><div class="hbar-fill" style="width:${Math.round(rev/maxVal*100)}%"></div></div>
      <span class="hbar-val">£${rev.toFixed(0)}</span>
    </div>`).join('');
  return `<div class="fin-chart">
    <div class="fin-chart-title">Revenue by venue</div>
    <div class="hbar-chart">${rows}</div>
  </div>`;
}

function _chartFunnel(sessions) {
  const withReport = sessions.filter(s => s.report?.attendance);
  if (withReport.length < 2) return '';
  let cap = 0, registered = 0, present = 0, noShows = 0, cancels = 0;
  withReport.forEach(s => {
    cap        += s.maxPlayers || 0;
    registered += s.report.attendance.registered || 0;
    present    += s.report.attendance.present    || 0;
    noShows    += s.report.attendance.noShows    || 0;
    cancels    += s.cancellationCount            || 0;
  });
  const base = Math.max(cap, registered + cancels, 1);
  const row  = (label, val, color, note) => `
    <div class="hbar-row">
      <span class="hbar-label">${label}</span>
      <div class="hbar-track">
        <div class="hbar-fill" style="width:${Math.round(val/base*100)}%;background:${color}"></div>
      </div>
      <span class="hbar-val">${val}${note ? `<span class="hbar-note">${note}</span>` : ''}</span>
    </div>`;
  return `<div class="fin-chart">
    <div class="fin-chart-title">Capacity funnel</div>
    <div class="hbar-chart">
      ${cap        > 0  ? row('Capacity',    cap,        'var(--border2)',  '')                                          : ''}
      ${cancels    > 0  ? row('Cancelled',   cancels,    'var(--red)',      ` (${Math.round(cancels/(registered+cancels||1)*100)}%)`) : ''}
      ${row('Registered', registered, 'var(--amber)',  ` (${Math.round(registered/base*100)}%)`)}
      ${row('Present',    present,    'var(--green)',  ` (${Math.round(present/base*100)}%)`)}
      ${noShows > 0 ? row('No-shows', noShows, 'var(--muted)', ` (${Math.round(noShows/registered*100)}%)`) : ''}
    </div>
  </div>`;
}

function _chartCoachCosts(sessions) {
  const byCoach = {};
  sessions.forEach(s => {
    if (!s.coach || !s.coachFee) return;
    byCoach[s.coach] = (byCoach[s.coach] || 0) + s.coachFee;
  });
  const entries = Object.entries(byCoach).sort((a,b) => b[1]-a[1]);
  if (entries.length < 2) return '';
  const total  = entries.reduce((s, [,v]) => s + v, 0) || 1;
  const rows   = entries.map(([coach, fee]) => `
    <div class="hbar-row">
      <span class="hbar-label">${esc(coach)}</span>
      <div class="hbar-track">
        <div class="hbar-fill" style="width:${Math.round(fee/total*100)}%;background:var(--purple)"></div>
      </div>
      <span class="hbar-val">£${fee.toFixed(0)} <span class="hbar-note">${Math.round(fee/total*100)}%</span></span>
    </div>`).join('');
  return `<div class="fin-chart">
    <div class="fin-chart-title">Coach cost breakdown</div>
    <div class="hbar-chart">${rows}</div>
  </div>`;
}

// ─── Insights screen ───────────────────────────────────────────────────────────

let _insightFilter = { range: 'all', venues: [], coaches: [], levels: [] };

function openInsightsScreen() {
  if (!_isAdmin) return;
  _setHash('insights');
  showScreen('insights');
  _setNav('primary', 'insights');
  _setTitle('Sessions');
  renderInsights();
}

function _applyInsightFilter(sessions) {
  const now = new Date();
  const cut = { '30d': 30, '3m': 90, 'year': 365 }[_insightFilter.range];
  return sessions.filter(s => {
    if (cut) {
      const d = s.date?.toDate ? s.date.toDate() : new Date(s.date);
      if ((now - d) / 86400000 > cut) return false;
    }
    if (_insightFilter.venues.length  && !_insightFilter.venues.includes(s.venue  || '')) return false;
    if (_insightFilter.coaches.length && !_insightFilter.coaches.includes(s.coach || '')) return false;
    if (_insightFilter.levels.length  && !_insightFilter.levels.includes(s.level  || '')) return false;
    return true;
  });
}

function setInsightFilter(key, value) {
  if (key === 'range') {
    _insightFilter.range = value;
  } else {
    const arr = _insightFilter[key];
    const i   = arr.indexOf(value);
    if (i > -1) arr.splice(i, 1); else arr.push(value);
  }
  _renderInsightsUI(document.getElementById('insights-content'));
}

async function renderInsights() {
  const container = document.getElementById('insights-content');
  container.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    const [, usersSnap] = await Promise.all([
      _loadAllSessions(),
      getDb().collection('users').orderBy('sessionCount', 'desc').limit(20).get(),
    ]);
    _insightsTopUsers = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderInsightsUI(container);
  } catch(e) {
    container.innerHTML = '<div class="home-empty">Couldn\'t load insights.</div>';
    console.error(e);
  }
}

let _insightsTopUsers = [];

function _renderInsightsUI(container) {
  const closed  = _allSessions.filter(s => s.status === 'closed');
  const visible = _applyInsightFilter(closed);
  const fmt     = n => `£${n.toFixed(2)}`;

  // Distinct values for filters
  const venues  = [...new Set(closed.map(s => s.venue  || '').filter(Boolean))].sort();
  const coaches = [...new Set(closed.map(s => s.coach  || '').filter(Boolean))].sort();
  const levels  = [...new Set(closed.map(s => s.level  || '').filter(Boolean))].sort();

  const rangeBtn = r => {
    const labels = { '30d': '30 days', '3m': '3 months', 'year': 'This year', 'all': 'All time' };
    const active  = _insightFilter.range === r ? ' active' : '';
    return `<button class="filter-btn${active}" onclick="setInsightFilter('range','${r}')">${labels[r]}</button>`;
  };
  const multiBtn = (key, val) => {
    const active = _insightFilter[key].includes(val) ? ' active' : '';
    return `<button class="filter-btn${active}" onclick="setInsightFilter('${key}','${esc(val)}')">${esc(val)}</button>`;
  };

  // ── Money KPIs ──
  let totalRevenue = 0, totalCosts = 0, totalAttendees = 0, totalCapacity = 0;
  let totalCancellations = 0, totalEverRegistered = 0;
  visible.forEach(s => {
    const f = computeSessionFinancials(s);
    totalRevenue   += f.revenue;
    totalCosts     += f.coachFee;
    totalAttendees += f.attendeeCount;
    totalCapacity  += (s.maxPlayers || 0);
    const cancels   = s.cancellationCount || 0;
    const atClose   = s.report?.attendance?.registered || s.attendeeCount || 0;
    totalCancellations  += cancels;
    totalEverRegistered += atClose + cancels;
  });
  const totalNet   = totalRevenue - totalCosts;
  const avgNet     = visible.length ? fmt(totalNet / visible.length) : '—';
  const avgAttend  = visible.length ? (totalAttendees / visible.length).toFixed(1) : '—';
  const cancelRate = totalEverRegistered > 0
    ? Math.round(totalCancellations / totalEverRegistered * 100) + '%' : '—';

  // ── Sessions KPIs ──
  const withCap  = visible.filter(s => s.maxPlayers > 0);
  const fillRate = withCap.length
    ? Math.round(withCap.reduce((a,s) => a + (s.attendeeCount||0)/s.maxPlayers, 0) / withCap.length * 100) + '%'
    : '—';
  let totalPresent = 0, totalRegistered = 0;
  visible.forEach(s => {
    const att = s.report?.attendance;
    if (att) { totalPresent += att.present || 0; totalRegistered += att.registered || 0; }
  });
  const noShowRate = totalRegistered > 0
    ? Math.round((1 - totalPresent / totalRegistered) * 100) + '%' : '—';

  container.innerHTML = `
    <div class="fin-filters">
      <div class="fin-filter-row">${['30d','3m','year','all'].map(rangeBtn).join('')}</div>
      ${venues.length  > 1 ? `<div class="fin-filter-row">${venues.map(v  => multiBtn('venues',  v)).join('')}</div>` : ''}
      ${coaches.length > 1 ? `<div class="fin-filter-row">${coaches.map(c => multiBtn('coaches', c)).join('')}</div>` : ''}
      ${levels.length  > 1 ? `<div class="fin-filter-row">${levels.map(l  => multiBtn('levels',  l)).join('')}</div>` : ''}
    </div>

    <div class="insights-body">

      <div class="insights-section-label">Money</div>
      <div class="kpi-tiles">
        ${_kpi('Revenue',       fmt(totalRevenue),            'green')}
        ${_kpi('Costs',         fmt(totalCosts),              'red')}
        ${_kpi('Net income',    fmt(totalNet),                totalNet >= 0 ? 'green' : 'red')}
        ${_kpi('Sessions run',  visible.length,               'muted')}
        ${_kpi('Avg attendance',avgAttend,                    'muted')}
        ${_kpi('Avg net/session',avgNet,                      'muted')}
      </div>
      ${_chartRevenue(visible)}
      ${_chartVenue(visible)}
      ${coaches.length > 1 ? _chartCoachCosts(visible) : ''}

      <div class="insights-section-label">Sessions</div>
      <div class="kpi-tiles">
        ${_kpi('Avg fill rate',    fillRate,   'amber')}
        ${_kpi('No-show rate',     noShowRate, 'amber')}
        ${_kpi('Cancellation rate',cancelRate, totalCancellations > 0 ? 'red' : 'muted')}
      </div>
      ${_chartFill(visible)}
      ${_chartFunnel(visible)}

      <div class="insights-section-label">Players</div>
      ${_insightsTopUsers.length ? `
        <div class="detail-section">
          ${_insightsTopUsers.map((u, i) => `
            <div class="stats-user-row" onclick="openProfileScreen('${u.id}')">
              <span class="stats-rank">${i+1}</span>
              <span class="stats-name">${esc(u.displayName || u.email || 'Unknown')}</span>
              <span class="stats-count">${u.sessionCount || 0} sessions</span>
            </div>`).join('')}
        </div>` : '<div class="home-empty" style="padding:12px 0">No attendance data yet.</div>'}

    </div>`;
}

// ─── Venues ────────────────────────────────────────────────────────────────────

function _venuesRef() { return getDb().collection('venues'); }

let _allVenues    = [];   // cached list
let _editingVenueId = null;

async function _loadVenues() {
  const snap  = await _venuesRef().orderBy('name').get();
  _allVenues  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _allVenues;
}

// ── Nav / routing ──

function openVenuesScreen() {
  if (!_isAdmin) return;
  _setHash('venues');
  showScreen('venues');
  _setNav('sub', null);
  _setTitle('Venues');
  _setBack(() => history.back());
  renderVenues();
}

async function renderVenues() {
  const list = document.getElementById('venues-list');
  list.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    await _loadVenues();
    if (!_allVenues.length) {
      list.innerHTML = '<div class="home-empty">No venues yet. Add one below.</div>'; return;
    }
    list.innerHTML = _allVenues.map(v => `
      <div class="venue-card" onclick="openVenueForm('${v.id}')">
        <div class="venue-card-name">${esc(v.name)}</div>
        ${v.address    ? `<div class="venue-card-meta">${esc(v.address)}</div>` : ''}
        ${v.costPerHour > 0 ? `<div class="venue-card-meta">£${v.costPerHour}/hr</div>` : ''}
        ${v.contact    ? `<div class="venue-card-meta">${esc(v.contact)}</div>` : ''}
      </div>`).join('');
  } catch(e) {
    list.innerHTML = '<div class="home-empty">Couldn\'t load venues.</div>';
    console.error(e);
  }
}

// ── Venue form (create / edit) ──

function openVenueForm(id) {
  _editingVenueId = id || null;
  const v = id ? _allVenues.find(x => x.id === id) : null;
  document.getElementById('venue-form-title').textContent = v ? 'Edit venue' : 'New venue';
  document.getElementById('vf-name').value    = v?.name        || '';
  document.getElementById('vf-address').value = v?.address     || '';
  document.getElementById('vf-maps').value    = v?.mapsUrl     || '';
  document.getElementById('vf-cost').value    = v?.costPerHour || '';
  document.getElementById('vf-contact').value = v?.contact     || '';
  document.getElementById('venue-form-error').textContent = '';
  document.getElementById('venue-delete-btn').style.display = v ? '' : 'none';
  document.getElementById('venue-form-overlay').classList.add('open');
}

function closeVenueForm() {
  document.getElementById('venue-form-overlay').classList.remove('open');
  _editingVenueId = null;
}

async function submitVenueForm() {
  const name    = document.getElementById('vf-name').value.trim();
  const errorEl = document.getElementById('venue-form-error');
  if (!name) { errorEl.textContent = 'Name is required.'; return; }

  const btn  = document.getElementById('venue-submit-btn');
  btn.disabled = true;
  const data = {
    name,
    address:     document.getElementById('vf-address').value.trim(),
    mapsUrl:     document.getElementById('vf-maps').value.trim(),
    costPerHour: parseFloat(document.getElementById('vf-cost').value) || 0,
    contact:     document.getElementById('vf-contact').value.trim(),
  };

  try {
    if (_editingVenueId) {
      await _venuesRef().doc(_editingVenueId).update(data);
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await _venuesRef().add(data);
    }
    closeVenueForm();
    await renderVenues();
    await _populateVenueSelect();
  } catch(e) {
    errorEl.textContent = 'Couldn\'t save venue. Try again.';
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

async function deleteVenue() {
  if (!_editingVenueId) return;
  if (!confirm('Delete this venue? Sessions using it will keep the venue name.')) return;
  try {
    await _venuesRef().doc(_editingVenueId).delete();
    closeVenueForm();
    await renderVenues();
    await _populateVenueSelect();
  } catch(e) {
    document.getElementById('venue-form-error').textContent = 'Couldn\'t delete venue.';
  }
}

// ── Session form integration ──

async function _populateVenueSelect(selectedId) {
  const sel = document.getElementById('form-venue-select');
  if (!sel) return;
  if (!_allVenues.length) await _loadVenues();
  const current = selectedId || sel.value;
  sel.innerHTML = '<option value="">Select a venue…</option>' +
    _allVenues.map(v =>
      `<option value="${v.id}" ${v.id === current ? 'selected' : ''}>${esc(v.name)}${v.address ? ' — ' + esc(v.address) : ''}</option>`
    ).join('');
}

function onVenueSelectChange() {
  // venueId and name resolved at form submit time — nothing extra needed here
}

// ─── Series ────────────────────────────────────────────────────────────────────

function _seriesRef(id) { return id ? getDb().collection('series').doc(id) : null; }
function _seriesColRef() { return getDb().collection('series'); }

async function _loadSeries() {
  const snap  = await _seriesColRef().orderBy('name').get();
  _allSeries  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _allSeries;
}

function openSeriesScreen() {
  _setHash('series');
  showScreen('series');
  _setNav('primary', 'series');
  _setTitle('Sessions');
  const footer = document.getElementById('series-footer');
  if (footer) footer.style.display = _canCreate() ? '' : 'none';
  renderSeries();
}

async function renderSeries() {
  const list = document.getElementById('series-list');
  list.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    await _loadSeries();
    if (!_allSeries.length) {
      list.innerHTML = '<div class="home-empty">No series yet.' + (_canCreate() ? ' Add one below.' : '') + '</div>';
      return;
    }
    // Load all user registrations in one batch so cards can show join/pass status
    let myRegs = {};
    if (_currentUser) {
      try {
        const regSnaps = await Promise.all(
          _allSeries.map(s => _seriesColRef().doc(s.id).collection('registrations').doc(_currentUser.uid).get())
        );
        regSnaps.forEach((snap, i) => {
          if (snap.exists && snap.data().paymentStatus === 'paid') myRegs[_allSeries[i].id] = true;
        });
      } catch(e) { /* non-critical */ }
    }
    list.innerHTML = _allSeries.map(s => _renderSeriesCard(s, myRegs[s.id] || false)).join('');
  } catch(e) {
    list.innerHTML = '<div class="home-empty">Couldn\'t load series.</div>';
    console.error(e);
  }
}

function _renderSeriesCard(s, hasPass = false) {
  const startStr  = s.startDate ? _formatDate(s.startDate) : '';
  const endStr    = s.endDate   ? _formatDate(s.endDate)   : '';
  const dateRange = startStr && endStr ? `${startStr} – ${endStr}` : startStr || endStr || '';
  const costStr   = s.cost > 0 ? `£${s.cost}` : 'Free';
  const isFull    = s.maxPlayers > 0 && (s.memberCount || 0) >= s.maxPlayers;
  const members   = s.maxPlayers
    ? `${s.memberCount || 0}/${s.maxPlayers}${isFull ? ' · Full' : ''}`
    : s.memberCount ? `${s.memberCount} member${s.memberCount !== 1 ? 's' : ''}` : '';
  const meta = [costStr, members, dateRange].filter(Boolean).join(' · ');

  const joinBtn = !_isAdmin && _currentUser && !hasPass && !isFull
    ? `<button class="cta-btn series-card-join" onclick="event.stopPropagation(); _joinSeriesFromCard('${s.id}', this)">${s.cost > 0 ? `Buy pass — ${costStr}` : 'Join — Free'}</button>`
    : '';
  const passBadge = !_isAdmin && hasPass
    ? `<span class="session-badge series-pass-badge">Pass ✓</span>`
    : '';
  const fullBadge = !_isAdmin && !hasPass && isFull
    ? `<span class="session-badge full-badge">Full</span>`
    : '';

  return `
    <div class="series-card" onclick="openSeriesDetail('${s.id}')">
      <div class="series-card-main">
        <div class="series-card-name">${esc(s.name)}</div>
        ${s.description ? `<div class="series-card-meta">${esc(s.description)}</div>` : ''}
        ${meta ? `<div class="series-card-meta">${meta}</div>` : ''}
        ${joinBtn}${passBadge}${fullBadge}
      </div>
      ${(_isAdmin || (_isProvider && _currentUser && s.providerUid === _currentUser.uid)) ? `
        <div class="session-admin-btns" onclick="event.stopPropagation()">
          <button class="icon-btn" onclick="openSeriesForm('${s.id}')" title="Edit">✎</button>
          <button class="icon-btn" onclick="copySeriesInviteLink('${s.id}')" title="Copy invite link">🔗</button>
        </div>` : ''}
    </div>`;
}

async function _joinSeriesFromCard(seriesId, btn) {
  // Disable immediately so the user gets instant feedback
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }

  if (!_currentUser) {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    await handleAuthClick();
    return;
  }

  try {
    const base = window.location.origin + window.location.pathname;
    const data = await callFn('createSeriesCheckoutSession', {
      seriesId,
      inviteToken: _seriesInvite?.seriesId === seriesId ? _seriesInvite.token : null,
      successUrl: `${base}?checkout=success&type=series&seriesId=${seriesId}`,
      cancelUrl:  `${base}?checkout=cancelled&type=series&seriesId=${seriesId}`,
    });
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast('You\'re in! Series pass activated.');
      _seriesInvite = null;
      renderSeries();
    }
  } catch(e) {
    const alreadyHas = e.message && e.message.toLowerCase().includes('already registered');
    if (alreadyHas) {
      showToast('You already have a series pass.');
      renderSeries();
    } else {
      showToast(e.message || 'Couldn\'t join series. Try again.', 'error');
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }
}

async function openSeriesDetail(seriesId) {
  _setHash('pass/' + seriesId);
  showScreen('detail');
  _setNav('sub', null);
  _setTitle('Pass');
  _setBack(() => history.back());
  document.getElementById('detail-content').innerHTML = '<div class="home-empty">Loading…</div>';

  try {
    const [seriesSnap, regSnap] = await Promise.all([
      _seriesColRef().doc(seriesId).get(),
      _currentUser ? _seriesColRef().doc(seriesId).collection('registrations').doc(_currentUser.uid).get().catch(() => null) : Promise.resolve(null),
    ]);

    if (!seriesSnap.exists) {
      document.getElementById('detail-content').innerHTML = '<div class="home-empty">Pass not found.</div>';
      return;
    }

    const series = { id: seriesSnap.id, ...seriesSnap.data() };
    const reg    = regSnap?.exists && regSnap.data().paymentStatus === 'paid' ? regSnap.data() : null;

    // Load members (everyone can see names, admins see full info)
    let members = [];
    if (_currentUser) {
      try {
        const membersSnap = await _seriesColRef().doc(seriesId).collection('registrations').where('paymentStatus', '==', 'paid').get();
        members = membersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
      } catch(e) { /* non-critical */ }
    }

    const isFull    = series.maxPlayers > 0 && (series.memberCount || 0) >= series.maxPlayers;
    const cost      = series.cost > 0 ? `£${series.cost}` : 'Free';
    const memberStr = series.maxPlayers
      ? `${series.memberCount || 0} / ${series.maxPlayers} members`
      : `${series.memberCount || 0} member${(series.memberCount || 0) !== 1 ? 's' : ''}`;
    const startStr  = series.startDate ? _formatDate(series.startDate) : '';
    const endStr    = series.endDate   ? _formatDate(series.endDate)   : '';
    const dateRange = startStr && endStr ? `${startStr} – ${endStr}` : startStr || endStr || '';

    let cta = '';
    if (reg) {
      cta = `<span class="session-badge series-pass-badge" style="font-size:14px;padding:6px 12px">Series pass ✓</span>`;
    } else if (_currentUser && (!isFull || _seriesInvite?.seriesId === seriesId)) {
      const label = series.cost > 0 ? `Buy pass — ${cost}` : 'Join — Free';
      cta = `<button class="cta-btn" style="margin-top:4px" onclick="joinSeries('${seriesId}')">${label}</button>`;
      if (isFull) cta += `<div class="series-invite-note">You were invited — joining will add one spot.</div>`;
    } else if (isFull) {
      cta = `<span class="session-badge full-badge" style="font-size:14px;padding:6px 12px">Pass full</span>`;
    }

    const adminActions = _isAdmin ? `
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="series-copy-link-btn" onclick="copySeriesInviteLink('${seriesId}')">Copy invite link</button>
        <button class="series-copy-link-btn" onclick="openSeriesForm('${seriesId}')">Edit pass</button>
      </div>` : '';

    const memberRows = members.map((m, i) => _isAdmin
      ? `<div class="attendee-row">
          <span class="attendee-num">${i + 1}</span>
          <button class="attendee-name-btn" onclick="openProfileScreen('${m.uid}')">${esc(m.name || m.email || '—')}</button>
          <span class="attendee-email">${esc(m.email || '')}</span>
          <span class="att-chip paid-chip">${m.amountPaid > 0 ? `£${m.amountPaid}` : 'Free'}</span>
          <span class="history-date" style="margin-left:auto;font-size:11px;color:var(--muted)">${_formatDate(m.registeredAt)}</span>
         </div>`
      : `<div class="attendee-row">
          <span class="attendee-num">${i + 1}</span>
          <button class="attendee-name-btn" onclick="openProfileScreen('${m.uid}')">${esc(m.name || '—')}</button>
         </div>`
    ).join('');

    document.getElementById('detail-content').innerHTML = `
      <div class="detail-section">
        <div class="detail-title">${esc(series.name)}</div>
        ${series.description ? `<div class="detail-desc">${esc(series.description)}</div>` : ''}
        <div class="detail-meta-grid" style="margin-top:10px">
          <div class="detail-meta-row"><span class="detail-meta-label">Cost</span><span>${cost}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">Members</span><span>${memberStr}${isFull ? ' · Full' : ''}</span></div>
          ${dateRange ? `<div class="detail-meta-row"><span class="detail-meta-label">Dates</span><span>${dateRange}</span></div>` : ''}
        </div>
        ${cta}
        ${adminActions}
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Members (${members.length})</div>
        <div class="attendee-list">
          ${memberRows || '<div class="empty-note">No members yet.</div>'}
        </div>
      </div>
      <div class="detail-section">
        <button class="cta-btn secondary-btn" onclick="openSeriesSessions('${esc(seriesId)}', '${esc(series.name)}')">View sessions →</button>
      </div>`;
  } catch(e) {
    console.error('Load series detail failed:', e);
    document.getElementById('detail-content').innerHTML = '<div class="home-empty">Couldn\'t load pass.</div>';
  }
}

async function openSeriesSessions(seriesId, seriesName) {
  _activeSeriesFilter  = { id: seriesId, name: seriesName };
  _activeSeries        = null;
  _activeSeriesReg     = null;
  _activeSeriesMembers = [];
  _setHash('series/' + seriesId);
  showScreen('home');
  _setNav('sub', null);
  _setTitle(seriesName);
  _setBack(() => { _activeSeriesFilter = null; _activeSeries = null; _activeSeriesReg = null; _activeSeriesMembers = []; openSeriesDetail(seriesId); });
  document.getElementById('home-content').innerHTML = '<div class="home-empty">Loading…</div>';

  // Series doc is critical for the banner — fetch separately so a reg/member failure can't hide it
  try {
    const seriesDoc = await _seriesColRef().doc(seriesId).get();
    if (seriesDoc.exists) _activeSeries = { id: seriesDoc.id, ...seriesDoc.data() };
  } catch(e) { console.error('Failed to load series:', e); }

  // Load user registration + member list in parallel (both non-critical)
  await Promise.all([
    _currentUser ? (async () => {
      try {
        const regDoc = await _seriesColRef().doc(seriesId).collection('registrations').doc(_currentUser.uid).get();
        if (regDoc.exists && regDoc.data().paymentStatus === 'paid') _activeSeriesReg = regDoc.data();
      } catch(e) { /* rules may not be deployed yet */ }
    })() : Promise.resolve(),
    _currentUser ? (async () => {
      try {
        const membersSnap = await _seriesColRef().doc(seriesId).collection('registrations').where('paymentStatus', '==', 'paid').get();
        _activeSeriesMembers = membersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
      } catch(e) { /* non-critical */ }
    })() : Promise.resolve(),
  ]);

  renderHome();
}

// ── Series form ──

function openSeriesForm(id) {
  if (!id && !_isProvider) return;                         // creating: providers only
  if (id && !_isAdmin && !_isProvider) return;             // editing: admin or provider
  if (!id && !_providerOnboardingComplete) {
    showToast('Set up payments in your profile before creating series.', 'error');
    return;
  }
  _editingSeriesId = id || null;
  const s = id ? _allSeries.find(x => x.id === id) : null;
  document.getElementById('series-form-title').textContent = s ? 'Edit series' : 'New series';
  document.getElementById('sf-name').value        = s?.name        || '';
  document.getElementById('sf-description').value = s?.description || '';
  const startD = s?.startDate?.toDate?.();
  const endD   = s?.endDate?.toDate?.();
  document.getElementById('sf-start').value      = startD ? startD.toISOString().slice(0, 10) : '';
  document.getElementById('sf-end').value        = endD   ? endD.toISOString().slice(0, 10)   : '';
  document.getElementById('sf-cost').value       = s?.cost       ?? '';
  document.getElementById('sf-max-players').value = s?.maxPlayers ?? '';
  document.getElementById('series-form-error').textContent = '';
  document.getElementById('series-delete-btn').style.display = s ? '' : 'none';
  document.getElementById('series-form-overlay').classList.add('open');
}

function closeSeriesForm() {
  document.getElementById('series-form-overlay').classList.remove('open');
  _editingSeriesId = null;
}

async function submitSeriesForm() {
  const name    = document.getElementById('sf-name').value.trim();
  const errorEl = document.getElementById('series-form-error');
  if (!name) { errorEl.textContent = 'Name is required.'; return; }

  const btn  = document.getElementById('series-submit-btn');
  btn.disabled = true;

  const startVal     = document.getElementById('sf-start').value;
  const endVal       = document.getElementById('sf-end').value;
  const costRaw      = parseFloat(document.getElementById('sf-cost').value);
  const maxPlayersRaw = parseInt(document.getElementById('sf-max-players').value, 10);
  const data = {
    name,
    description: document.getElementById('sf-description').value.trim(),
    startDate:   startVal ? firebase.firestore.Timestamp.fromDate(new Date(startVal + 'T12:00:00')) : null,
    endDate:     endVal   ? firebase.firestore.Timestamp.fromDate(new Date(endVal   + 'T12:00:00')) : null,
    cost:        isNaN(costRaw)       ? 0    : costRaw,
    maxPlayers:  isNaN(maxPlayersRaw) ? null : maxPlayersRaw,
  };

  try {
    if (_editingSeriesId) {
      await _seriesColRef().doc(_editingSeriesId).update(data);
    } else {
      data.createdAt   = firebase.firestore.FieldValue.serverTimestamp();
      data.providerUid = _currentUser.uid;
      await _seriesColRef().add(data);
    }
    closeSeriesForm();
    await renderSeries();
    await _populateSeriesSelect();
  } catch(e) {
    errorEl.textContent = 'Couldn\'t save series. Try again.';
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

async function deleteSeries() {
  if (!_editingSeriesId) return;
  if (!confirm('Delete this series? Sessions assigned to it will keep the association until updated.')) return;
  try {
    await _seriesColRef().doc(_editingSeriesId).delete();
    closeSeriesForm();
    await _loadSeries();
    await renderSeries();
    await _populateSeriesSelect();
  } catch(e) {
    document.getElementById('series-form-error').textContent = 'Couldn\'t delete series.';
  }
}

async function _populateSeriesSelect(selectedId) {
  const sel = document.getElementById('form-series-select');
  if (!sel) return;
  if (!_allSeries.length) await _loadSeries();
  const current = selectedId !== undefined ? selectedId : sel.value;
  sel.innerHTML = '<option value="">None</option>' +
    _allSeries.map(s =>
      `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${esc(s.name)}</option>`
    ).join('');
}

// ─── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}
