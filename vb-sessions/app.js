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

// Domains not allowed in session descriptions. Add new entries here — no deploy needed beyond sw.js bump.
const _BLOCKED_DOMAINS = [
  // Competing group-sports / booking platforms
  'spond.com', 'sportas.lt', 'teamapp.com', 'sportlyzer.com',
  'teamer.net', 'pitchero.com', 'playwaze.com', 'opensports.net',
  // Short-URL services (resolved destination unknown — block outright)
  'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'rb.gy', 'shorturl.at', 'is.gd', 'buff.ly',
];

function _descriptionLinkError(text) {
  if (!text) return null;
  const urls = text.match(/https?:\/\/[^\s)>\"']+/gi) || [];
  for (const url of urls) {
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch(_) { continue; }
    const blocked = _BLOCKED_DOMAINS.find(d => host === d || host.endsWith('.' + d));
    if (blocked) {
      const isShortener = ['bit.ly','tinyurl.com','t.co','ow.ly','rb.gy','shorturl.at','is.gd','buff.ly'].includes(blocked);
      return isShortener
        ? `Short links (${blocked}) are not allowed — please use the full URL.`
        : `Links to ${blocked} are not permitted in session descriptions.`;
    }
  }
  return null;
}

const PHOTO_CONSENT_VERSION = '1.0';
const TERMS_VERSION         = '1.0';
// Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
const VAPID_KEY = 'BEGU7JjvOHiJtWbrgZ2_9EDYb1mcoengEyQNlYaPeVr_pMeIQDOvumGu1WmPmA4KNKb3wDJphCZwCoNwIiYOCzU';

// ─── Analytics ─────────────────────────────────────────────────────────────────
function _gaEvent(name, params) {
  if (typeof gtag === 'function') gtag('event', name, params || {});
}
function _gaPageView(path) {
  if (typeof gtag === 'function') gtag('event', 'page_view', { page_path: path });
}
function _gaGrantConsent() {
  if (typeof gtag === 'function') gtag('consent', 'update', { analytics_storage: 'granted' });
}

// ─── State ─────────────────────────────────────────────────────────────────────
let _currentUser  = null;
let _currentRoles = [];
let _isAdmin                  = false;
let _isCoach                  = false;
let _isProvider               = false;
let _isOwner                  = false;
let _providerOnboardingComplete = false;
let _currentUserDoc = null;  // latest user doc data for the signed-in user
let _userDocUnsub = null;    // unsubscribe fn for own user doc listener
let _editingId              = null;   // session ID being edited, null when creating
let _pendingJoinSessionId   = null;   // session to join after sign-in completes
let _pendingProfileNeeds    = {};     // { needsGender, needsPositions } for profile overlay
let _editingAttendeeSession = null;   // sessionId when editing own attendee entry (positions)
let _currentSession         = null;   // session data for the open detail panel
let _currentAttendees       = [];     // attendee list for the open session (used for CSV export)
let _teamVoteMap            = {};     // partitionKey → vote count (for open session)
let _myTeamVote             = '';     // partition key the current user voted for
let _positionQueue          = [];     // positionWaitingList docs for the open session
let _myQueueEntry           = null;   // current user's positionWaitingList entry (or null)
let _pendingEditQueueOpen   = [];     // open positions detected during edit queue flow
let _pendingEditQueueFull   = [];     // full positions to keep in queue during edit queue flow

// Handle return from Stripe Checkout before Firebase initialises.
// Stripe appends ?checkout=success|cancelled&session=ID to the success/cancel URLs.
// We convert this to a hash route immediately so normal routing takes over,
// and stash the success flag to show a toast after auth resolves.
let _pendingCheckoutSuccess = null;
let _seriesInvite           = null; // { seriesId, token } when user arrived via a valid invite link
let _bookingCoach           = null; // { uid, name, rate, coachAvailability } when booking overlay is open
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
  if (!_currentUser) throw new Error('Not signed in.');
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
function _posWlRef(sessionId)        { return _sessionRef(sessionId).collection('positionWaitingList'); }
function _sessionHistoryRef(uid)     { return _userRef(uid).collection('sessions'); }
function _usersRef()              { return getDb().collection('users'); }
function _userRef(uid)            { return _usersRef().doc(uid); }
function _isOpenRequest(req) {
  if (!req || typeof req !== 'object' || req.status !== 'open') return false;
  if (req.expiresAt && req.expiresAt.toDate?.() < new Date()) return false;
  return true;
}
function _requestObj() {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return { id: Math.random().toString(36).slice(2, 10), status: 'open', requestedAt: firebase.firestore.FieldValue.serverTimestamp(), expiresAt };
}
function _requestClosed(status) {
  return { status, respondedAt: firebase.firestore.FieldValue.serverTimestamp() };
}

// ─── User doc ──────────────────────────────────────────────────────────────────
async function _upsertUserDoc(user) {
  const ref = _userRef(user.uid);
  try {
    const doc = await ref.get();
    if (doc.exists) {
      await ref.update({
        name:      user.displayName || doc.data().name || '',
        email:     user.email || '',
        photoURL:  user.photoURL || '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await ref.set({
        name:      user.displayName || '',
        email:     user.email || '',
        photoURL:  user.photoURL || '',
        roles:     ['player'],
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    return doc.data()?.termsAccepted;
  } catch(e) { console.error('Upsert user doc failed:', e); }
}

async function _initMessaging(user) {
  if (!VAPID_KEY || !('serviceWorker' in navigator)) return;
  // Only proceed if permission is already granted — don't prompt on login.
  // The prompt is triggered by the user via enablePushNotifications().
  if (Notification.permission !== 'granted') return;
  try {
    const swReg = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
    const token = await firebase.messaging().getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (token) await _userRef(user.uid).update({ fcmToken: token });
  } catch (e) {
    console.log('Push notifications not available:', e.message);
  }
}

async function enablePushNotifications() {
  if (!VAPID_KEY || !('serviceWorker' in navigator)) return;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const swReg = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
    const token = await firebase.messaging().getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (token && _currentUser) await _userRef(_currentUser.uid).update({ fcmToken: token });
    showToast('Push notifications enabled.');
  } catch (e) {
    console.log('Push notifications not available:', e.message);
  }
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
    _currentUserDoc = doc.data() || {};
    _currentRoles = (_currentUserDoc.roles) || ['player'];
    _isOwner = _currentRoles.includes('owner');
    _isAdmin    = _isOwner || _currentRoles.includes('admin');
    _isCoach    = _currentRoles.includes('coach');
    _isProvider = _currentRoles.includes('provider');
    _providerOnboardingComplete = !!_currentUserDoc.providerOnboardingComplete;
    _updateAuthUI();
    _renderCoachOnboarding();
    if (_pendingProviderRequest) {
      _pendingProviderRequest = false;
      if (_isProvider) _showProviderSessions(_currentUser?.uid);
      else openProfileScreen();
    } else if (document.querySelector('.screen.active')?.id === 'screen-home') {
      renderHome();
    } else if (document.querySelector('.screen.active')?.id === 'screen-users') {
      renderUsers();
    }
  }, err => console.error('User doc listener error:', err));
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
async function handleAuthClick() {
  if (_currentUser) {
    await getAuth().signOut();
    showScreen('home');
    _setHash('home');
    _setNav('primary', 'home');
    _setTitle('Sessions');
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
let _activeSeriesFilter     = null;        // { id, name } or null
let _activeProviderFilter   = null;        // uid or null
let _activeLevelFilter      = new Set();   // set of level strings
let _activeGenderFilter     = new Set();   // set of gender strings
let _activeTypeFilter       = new Set();   // set of type strings
let _activeStatusFilter     = 'open';      // '' | 'open' | 'closed' — default: open only
let _activeDateFilter       = '';          // '' | 'today' | 'week' | 'nextweek' | 'month' | 'custom'
let _activeDateFrom         = '';          // ISO date string for custom range start
let _activeDateTo           = '';          // ISO date string for custom range end
let _activeSeries        = null; // full series doc data when in filtered mode
let _activeSeriesReg     = null; // user's paid registration for _activeSeries, or null
let _activeSeriesMembers = []; // paid registrations for current series (admin view)
let _allSeries           = [];
let _editingSeriesId     = null;

function _canCreate() {
  return _isAdmin || (_isProvider && _providerOnboardingComplete);
}

function _canCreateClinic() {
  return _isAdmin || _canCreate() || (_isCoach && _providerOnboardingComplete);
}

function _setNav(mode, activeTab) {
  const tabsRow = document.getElementById('nav-tabs-row');
  const backBtn = document.getElementById('nav-back-btn');
  const isPrimary = mode === 'primary';
  const showTabs    = isPrimary && !!_currentUser;
  const showFilters = showTabs && activeTab === 'home';
  if (tabsRow) tabsRow.style.display = showTabs ? 'flex' : 'none';
  if (backBtn) backBtn.style.display = isPrimary ? 'none' : '';
  const filterBar = document.getElementById('filter-bar');
  const wasHidden = filterBar && filterBar.style.display === 'none';
  if (filterBar) filterBar.style.display = showFilters ? 'flex' : 'none';
  if (showFilters && wasHidden) _loadHostFilterPills();
  document.documentElement.style.setProperty('--header-h', showTabs ? '95px' : '55px');
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.style.display = _isAdmin ? '' : 'none';
  });
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', !!activeTab && t.dataset.tab === activeTab)
  );
  const canCreate = _canCreate();
  const newGroup      = document.getElementById('home-new-btns');
  const sessionBtn    = document.getElementById('home-new-session-btn');
  const passBtn       = document.getElementById('home-new-pass-btn');
  const showSession   = canCreate && activeTab === 'home';
  const showPass      = canCreate && activeTab === 'series';
  if (sessionBtn) sessionBtn.style.display = showSession ? '' : 'none';
  if (passBtn)    passBtn.style.display    = showPass    ? '' : 'none';
  if (newGroup)   newGroup.style.display   = (showSession || showPass) ? 'flex' : 'none';
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
    avatarWrap.style.visibility = 'visible';
  }
  // Refresh admin-only tabs and tab strip visibility
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.style.display = _isAdmin ? '' : 'none';
  });
  const seriesFooter = document.getElementById('series-footer');
  if (seriesFooter) seriesFooter.style.display = _canCreate() ? '' : 'none';
  const coachesFooter = document.getElementById('coaches-footer');
  if (coachesFooter) coachesFooter.style.display = _canCreateClinic() ? '' : 'none';
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
    // Pre-fetch roles so admin routes work immediately on first load.
    try {
      const snap = await _userRef(user.uid).get();
      _currentRoles = snap.data()?.roles || ['player'];
      _isOwner    = _currentRoles.includes('owner');
      _isAdmin    = _isOwner || _currentRoles.includes('admin');
      _isCoach    = _currentRoles.includes('coach');
      _isProvider = _currentRoles.includes('provider');
      _providerOnboardingComplete = !!snap.data()?.providerOnboardingComplete;
    } catch(e) {}
    _updateAuthUI();

    if (!_initialRouted) {
      _initialRouted = true;
      await _routeFromHash();
      if (_pendingCheckoutSuccess) {
        if (_pendingCheckoutSuccess.startsWith('series:')) {
          showToast('Pass confirmed! You\'re enrolled in all sessions.');
        } else {
          showToast('Payment confirmed! You\'re in.');
        }
        _pendingCheckoutSuccess = null;
      }
    } else renderHome();

    const termsAccepted = await _upsertUserDoc(user);
    if (!termsAccepted || termsAccepted.version !== TERMS_VERSION) {
      _showTermsModal();
    } else {
      _gaGrantConsent();
    }
    _subscribeToUserDoc(user);
    _initMessaging(user);
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
    _currentUserDoc             = null;
    _isAdmin  = false;
    _isCoach                   = false;
    _isProvider                 = false;
    _isOwner                    = false;
    _providerOnboardingComplete = false;
    _pendingProviderRequest     = false;
    _updateAuthUI();
    if (!_initialRouted) { _initialRouted = true; await _routeFromHash(); }
    else renderHome();
  }
});

// Browser back/forward → route within the app instead of exiting
window.addEventListener('popstate', () => { _routeFromHash(); });

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // Close the topmost open overlay, or any open filter popover
  const overlay = document.querySelector('.overlay.open');
  if (overlay) { overlay.classList.remove('open'); return; }
  document.querySelectorAll('.fbar-pop.open').forEach(p => p.classList.remove('open'));
});

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
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Validate user-supplied URLs — only allow http/https to prevent javascript: injection
function safeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? url : null;
  } catch { return null; }
}

// Map of uid → display name, populated when rendering user cards.
// Used to avoid embedding names in onclick JS string literals.
const _userDisplayNames = {};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function _setHash(hash) {
  const next = '#' + hash;
  if (location.hash === next) return; // already here — avoid duplicate history entry
  history.pushState(null, '', next);
  // Anonymise profile UIDs; normalise home → '/'.
  const path = '/' + hash.replace(/^home$/, '').replace(/^profile\/[^/]+/, 'profile');
  _gaPageView(path || '/');
}

async function _routeFromHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (!hash || hash === 'home') { goHome(); return; }
  if (hash === 'users')         { if (_isAdmin) openUsersScreen();    else renderHome(); return; }
  if (hash === 'finances')      { if (_isAdmin) openFinancesScreen(); else renderHome(); return; }
  if (hash === 'insights')      { if (_isAdmin) openInsightsScreen(); else renderHome(); return; }
  if (hash === 'venues')        { if (_isAdmin) openVenuesScreen();   else renderHome(); return; }
  if (hash.startsWith('venue/')) { if (_isAdmin) { await openVenueDetail(hash.slice(6)); } else renderHome(); return; }
  if (hash === 'admin')         { if (_isAdmin) openAdminScreen();    else renderHome(); return; }
  if (hash === 'series')        { openSeriesScreen(); return; }
  if (hash === 'coaches')       { openCoachesScreen(); return; }
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
      _setBack(() => history.back());
      _renderSessionEnd();
    } catch(e) { renderHome(); }
  }
  else { renderHome(); }
}

const _LEVEL_LABELS  = { '': 'Level', any: 'Any level', beginner: 'Beginner', improver: 'Intermediate', intermediate: 'Advanced', advanced: 'Competit.', competitive: 'Elite' };
const _GENDER_LABELS = { '': 'Gender', mixed: 'Mixed', women: 'Women', men: 'Men' };

function _updateFbarBtn(type, isActive, label) {
  const btn  = document.getElementById('fbtn-' + type);
  const span = document.getElementById('flabel-' + type);
  if (btn)  btn.classList.toggle('active', !!isActive);
  if (span) span.textContent = label;
}

function _setLabel(set, defaultLabel, labelMap) {
  if (!set.size) return defaultLabel;
  if (set.size === 1) return labelMap[[...set][0]] || defaultLabel;
  return `${defaultLabel} (${set.size})`;
}

function _closePopovers() {
  document.querySelectorAll('.fbar-pop').forEach(p => p.classList.remove('open'));
}

function toggleFilterPopover(type) {
  const pop = document.getElementById('fpop-' + type);
  if (!pop) return;
  const wasOpen = pop.classList.contains('open');
  _closePopovers();
  if (!wasOpen) pop.classList.add('open');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.fbar-item')) _closePopovers();
});

function _syncFilterPillsToState() {
  document.querySelectorAll('#fpop-level .fpop-opt').forEach(b => {
    const v = b.dataset.level || '';
    b.classList.toggle('active', v === '' ? !_activeLevelFilter.size : _activeLevelFilter.has(v));
  });
  document.querySelectorAll('#fpop-gender .fpop-opt').forEach(b => {
    const v = b.dataset.gender || '';
    b.classList.toggle('active', v === '' ? !_activeGenderFilter.size : _activeGenderFilter.has(v));
  });
  _updateFbarBtn('level',  _activeLevelFilter.size,  _setLabel(_activeLevelFilter,  'Level',  _LEVEL_LABELS));
  _updateFbarBtn('gender', _activeGenderFilter.size, _setLabel(_activeGenderFilter, 'Gender', _GENDER_LABELS));
  _updateFbarBtn('host',   _activeProviderFilter, _activeProviderFilter ? 'Host ✓' : 'Host');
  _updateFbarBtn('type',   _activeTypeFilter.size,   _setLabel(_activeTypeFilter, 'Type', _TYPE_LABELS));
  _updateFbarBtn('status', _activeStatusFilter !== '', _STATUS_LABELS[_activeStatusFilter] || 'Status');
  _updateFbarBtn('date',   !!_activeDateFilter, _DATE_LABELS[_activeDateFilter] || 'Date');
  document.querySelectorAll('#fpop-type .fpop-opt').forEach(b => {
    const v = b.dataset.type || '';
    b.classList.toggle('active', v === '' ? !_activeTypeFilter.size : _activeTypeFilter.has(v));
  });
  document.querySelectorAll('#fpop-status .fpop-opt').forEach(b =>
    b.classList.toggle('active', (b.dataset.status || '') === (_activeStatusFilter || ''))
  );
  document.querySelectorAll('#fpop-date .fpop-opt').forEach(b =>
    b.classList.toggle('active', (b.dataset.date || '') === (_activeDateFilter || ''))
  );
}

function setHostFilter(uid, name) {
  _activeProviderFilter = uid || null;
  document.querySelectorAll('#fpop-host .fpop-opt').forEach(b =>
    b.classList.toggle('active', (b.dataset.host || '') === (uid || ''))
  );
  _updateFbarBtn('host', uid, uid ? (name || 'Host') : 'Host');
  _closePopovers();
  renderHome();
}

function setLevelFilter(level) {
  if (!level) {
    _activeLevelFilter.clear();
  } else {
    if (_activeLevelFilter.has(level)) _activeLevelFilter.delete(level);
    else _activeLevelFilter.add(level);
  }
  document.querySelectorAll('#fpop-level .fpop-opt').forEach(b => {
    const v = b.dataset.level || '';
    b.classList.toggle('active', v === '' ? !_activeLevelFilter.size : _activeLevelFilter.has(v));
  });
  _updateFbarBtn('level', _activeLevelFilter.size, _setLabel(_activeLevelFilter, 'Level', _LEVEL_LABELS));
  renderHome();
}

function setGenderFilter(gender) {
  if (!gender) {
    _activeGenderFilter.clear();
  } else {
    if (_activeGenderFilter.has(gender)) _activeGenderFilter.delete(gender);
    else _activeGenderFilter.add(gender);
  }
  document.querySelectorAll('#fpop-gender .fpop-opt').forEach(b => {
    const v = b.dataset.gender || '';
    b.classList.toggle('active', v === '' ? !_activeGenderFilter.size : _activeGenderFilter.has(v));
  });
  _updateFbarBtn('gender', _activeGenderFilter.size, _setLabel(_activeGenderFilter, 'Gender', _GENDER_LABELS));
  renderHome();
}

const _TYPE_LABELS = { game: 'Game', league: 'League', clinic: 'Clinic', kqotc: 'KQOTC', tournament: 'Tournament', tryout: 'Tryout', training: 'Training' };
const _STATUS_LABELS = { open: 'Open', closed: 'Closed' };
const _DATE_LABELS   = { today: 'Today', week: 'This week', nextweek: 'Next week', month: 'This month' };

function setTypeFilter(type) {
  if (!type) {
    _activeTypeFilter.clear();
  } else {
    if (_activeTypeFilter.has(type)) _activeTypeFilter.delete(type);
    else _activeTypeFilter.add(type);
  }
  document.querySelectorAll('#fpop-type .fpop-opt').forEach(b => {
    const v = b.dataset.type || '';
    b.classList.toggle('active', v === '' ? !_activeTypeFilter.size : _activeTypeFilter.has(v));
  });
  _updateFbarBtn('type', _activeTypeFilter.size, _setLabel(_activeTypeFilter, 'Type', _TYPE_LABELS));
  renderHome();
}

function setStatusFilter(status) {
  _activeStatusFilter = status;
  document.querySelectorAll('#fpop-status .fpop-opt').forEach(b =>
    b.classList.toggle('active', (b.dataset.status || '') === (status || ''))
  );
  const label = _STATUS_LABELS[status] || 'Status';
  _updateFbarBtn('status', status !== '', label);
  _closePopovers();
  renderHome();
}

function setDateFilter(date) {
  _activeDateFilter = date;
  _activeDateFrom   = '';
  _activeDateTo     = '';
  document.querySelectorAll('#fpop-date .fpop-opt').forEach(b =>
    b.classList.toggle('active', (b.dataset.date || '') === (date || ''))
  );
  const customWrap = document.getElementById('fpop-date-custom');
  if (customWrap) customWrap.style.display = date === 'custom' ? '' : 'none';
  const label = _DATE_LABELS[date] || 'Date';
  _updateFbarBtn('date', !!date, label);
  _closePopovers();
  renderHome();
}

function setCustomDateRange() {
  const from = document.getElementById('fdate-from').value;
  const to   = document.getElementById('fdate-to').value;
  _activeDateFrom = from;
  _activeDateTo   = to;
  _activeDateFilter = (from || to) ? 'custom' : '';
  const label = from && to ? `${from} – ${to}` : from ? `From ${from}` : to ? `Until ${to}` : 'Date';
  _updateFbarBtn('date', !!(from || to), label);
  renderHome();
}

async function _loadHostFilterPills() {
  const container = document.getElementById('fpop-host');
  if (!container) return;
  try {
    const snap = await getDb().collection('publicProfiles').where('isProvider', '==', true).get();
    if (!snap || snap.empty) {
      container.innerHTML = `<button class="fpop-opt active" data-host="" onclick="setHostFilter('')">All</button>`;
      return;
    }
    const hosts = snap.docs.map(d => ({ uid: d.id, name: d.data().name || d.id }));
    const cur = _activeProviderFilter || '';
    container.innerHTML =
      `<button class="fpop-opt${cur === '' ? ' active' : ''}" data-host="" onclick="setHostFilter(this.dataset.host, '')">All</button>` +
      hosts.map(h =>
        `<button class="fpop-opt${cur === h.uid ? ' active' : ''}" data-host="${esc(h.uid)}" data-name="${esc(h.name)}" onclick="setHostFilter(this.dataset.host, this.dataset.name)">${esc(h.name)}</button>`
      ).join('');
  } catch(e) { console.error('Load hosts failed:', e); }
}

function goHome() {
  _activeSeriesFilter   = null;
  _activeSeries         = null;
  _activeSeriesReg      = null;
  _activeSeriesMembers  = [];
  _activeProviderFilter = null;
  _activeLevelFilter.clear();
  _activeGenderFilter.clear();
  _activeTypeFilter.clear();
  _activeStatusFilter = 'open';
  _activeDateFilter   = '';
  _activeDateFrom     = '';
  _activeDateTo       = '';
  _setHash('home');
  showScreen('home');
  _setNav('primary', 'home');
  _setTitle('Sessions');
  _syncFilterPillsToState();
  _loadHostFilterPills();
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

// Escapes a value for inclusion in an iCalendar property (RFC 5545 §3.3.11).
// Strips bare CR/LF (line injection), then escapes \ ; , and folds newlines.
function _icsEsc(s) {
  return String(s || '').replace(/\r\n?|\n(?!\\)/g, ' ').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function downloadIcs() {
  const c = _calendarDates(_currentSession);
  if (!c) return;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Roots Volleyball//Sessions//EN',
    'BEGIN:VEVENT',
    `DTSTART;TZID=Europe/London:${c.start}`,
    `DTEND;TZID=Europe/London:${c.end}`,
    `SUMMARY:${_icsEsc(c.title)}`,
    _currentSession.venue ? `LOCATION:${_icsEsc(_currentSession.venue)}` : '',
    _currentSession.description ? `DESCRIPTION:${_icsEsc(_currentSession.description)}` : '',
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
    if (_activeLevelFilter.size) {
      sessions = sessions.filter(s => {
        const l = s.level || '';
        if (_activeLevelFilter.has('any') && !l) return true;
        return _activeLevelFilter.has(l);
      });
    }
    if (_activeGenderFilter.size) {
      sessions = sessions.filter(s => _activeGenderFilter.has(s.gender || ''));
    }
    if (_activeTypeFilter.size) {
      sessions = sessions.filter(s => _activeTypeFilter.has(s.type || ''));
    }
    if (_activeStatusFilter === 'open') {
      sessions = sessions.filter(s => s.status === 'open' || s.status === 'full');
    } else if (_activeStatusFilter === 'closed') {
      sessions = sessions.filter(s => s.status === 'closed' || s.status === 'cancelled');
    }
    if (_activeDateFilter) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (_activeDateFilter === 'custom') {
        if (_activeDateFrom || _activeDateTo) {
          const start   = _activeDateFrom ? new Date(_activeDateFrom) : new Date(0);
          const end     = _activeDateTo   ? new Date(_activeDateTo)   : new Date(8640000000000000);
          end.setDate(end.getDate() + 1); // inclusive end date
          sessions = sessions.filter(s => {
            const d = s.date?.toDate?.() || new Date(s.date);
            return d >= start && d < end;
          });
        }
      } else {
        const end = new Date(today);
        let start = today;
        if      (_activeDateFilter === 'today')    { end.setDate(end.getDate() + 1); }
        else if (_activeDateFilter === 'week')     { end.setDate(end.getDate() + 7); }
        else if (_activeDateFilter === 'nextweek') {
          const day = today.getDay();
          const daysToNextMon = day === 0 ? 1 : 8 - day;
          start = new Date(today); start.setDate(today.getDate() + daysToNextMon);
          end.setDate(today.getDate() + daysToNextMon + 7);
        }
        else if (_activeDateFilter === 'month')    { end.setMonth(end.getMonth() + 1); }
        sessions = sessions.filter(s => {
          const d = s.date?.toDate?.() || new Date(s.date);
          return d >= start && d < end;
        });
      }
    }
    const providerBannerHtml = _activeProviderFilter
      ? `<div class="provider-banner"><span class="provider-banner-label">My sessions</span><button class="provider-banner-clear" onclick="goHome()">← All sessions</button></div>`
      : '';
    const levelLabels = { any: 'Any level', beginner: 'Beginner', improver: 'Improver', intermediate: 'Advanced', advanced: 'Competitive', competitive: 'Elite' };
    const levelBannerHtml = _activeLevelFilter.size
      ? `<div class="filter-active-label">Level: <strong>${[..._activeLevelFilter].map(l => levelLabels[l] || l).join(', ')}</strong></div>`
      : '';
    if (!sessions.length) {
      const bannerHtml = _activeSeries ? _renderSeriesBanner(_activeSeries, _activeSeriesReg) : '';
      container.innerHTML = providerBannerHtml + levelBannerHtml + bannerHtml + `<div class="home-empty">${_activeSeriesFilter ? 'No sessions in this pass yet.' : _activeProviderFilter ? 'No sessions hosted yet.' : 'No sessions matching this filter.'}</div>`;
      return;
    }

    const now    = new Date();
    now.setHours(0, 0, 0, 0);
    const upcoming = sessions.filter(s => s.date?.toDate() >= now);
    const past     = sessions.filter(s => s.date?.toDate() < now).reverse();

    // Group upcoming by week
    const _weekMonday = d => {
      const m = new Date(d);
      m.setHours(0, 0, 0, 0);
      const day = m.getDay();
      m.setDate(m.getDate() + (day === 0 ? -6 : 1 - day));
      return m;
    };
    const _nowMonday   = _weekMonday(now);
    const _weekLabel   = ts => {
      const d      = ts?.toDate ? ts.toDate() : new Date(ts);
      const mon    = _weekMonday(d);
      const diff   = Math.round((mon - _nowMonday) / 604800000);
      if (diff === 0) return 'This week';
      if (diff === 1) return 'Next week';
      const sun    = new Date(mon); sun.setDate(sun.getDate() + 6);
      const fmtD   = { day: 'numeric', month: 'short' };
      if (mon.getMonth() === sun.getMonth())
        return `${mon.getDate()}–${sun.getDate()} ${sun.toLocaleDateString('en-GB', { month: 'short' })}`;
      return `${mon.toLocaleDateString('en-GB', fmtD)} – ${sun.toLocaleDateString('en-GB', fmtD)}`;
    };
    const upcomingByWeek = [];
    for (const s of upcoming) {
      const label = _weekLabel(s.date);
      const last  = upcomingByWeek[upcomingByWeek.length - 1];
      if (last && last.label === label) last.items.push(s);
      else upcomingByWeek.push({ label, items: [s] });
    }

    const bannerHtml = _activeSeries ? _renderSeriesBanner(_activeSeries, _activeSeriesReg) : '';
    const upcomingHtml = levelBannerHtml + upcomingByWeek.map(g => `
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
    cta = `<span class="session-badge series-pass-badge">Pass active ✓</span>`;
  } else if (_currentUser && !isFull) {
    const label = series.cost > 0 ? `Get pass — ${cost}` : 'Get pass — Free';
    cta = `<button class="cta-btn series-banner-cta" onclick="joinSeries('${series.id}')">${label}</button>`;
  } else if (_currentUser && isFull && _seriesInvite?.seriesId === series.id) {
    const label = series.cost > 0 ? `Get pass — ${cost}` : 'Get pass — Free';
    cta = `<button class="cta-btn series-banner-cta" onclick="joinSeries('${series.id}')">${label}</button>
           <div class="series-invite-note">You were invited — getting this pass will add one spot.</div>`;
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
  const levelLabel  = { any: 'Any level', beginner: 'Beginner', improver: 'Improver', intermediate: 'Advanced', advanced: 'Competitive', competitive: 'Elite' }[s.level] || 'Any level';
  const typeLabel   = SESSION_TYPES.find(t => t.value === s.type)?.label || '';
  const genderLabel = SESSION_GENDERS.find(g => g.value === s.gender)?.label || '';
  return `
    <div class="session-card${s.status === 'closed' || s.status === 'cancelled' ? ' dim-card' : ''}" onclick="openSession('${s.id}')">
      <div class="session-card-row">
        <div class="session-date">${esc(dateStr)}${timeStr ? ` · ${esc(timeStr)}` : ''}</div>
        ${s.seriesName && !_activeSeriesFilter ? `<span class="session-badge series-ref">${esc(s.seriesName)} PASS</span>` : ''}
      </div>
      <div class="session-venue">${esc(s.venue || '—')}${s.coach ? ` · ${esc(s.coach)}` : ''}</div>
      ${s.description ? `<div class="session-desc">${esc(s.description)}</div>` : ''}
      <div class="session-card-meta">
        ${statusClass !== 'open' ? `<span class="session-badge ${statusClass}">${statusLabel}</span>` : ''}
        <span class="session-badge level level-${esc(s.level || 'any')}">${esc(levelLabel)}</span>
        ${typeLabel    ? `<span class="session-badge type-${esc(s.type)}">${esc(typeLabel)}</span>` : ''}
        ${genderLabel  ? `<span class="session-badge gender-${esc(s.gender)}">${esc(genderLabel)}</span>` : ''}
        ${_isAdmin && s.coach && s.coachFee > 0 && s.status === 'closed' ? _coachPayBadge(s) : ''}
        <span class="session-aside-counts">
          <span class="session-meta-item">👥 ${countStr}</span>
          <span class="session-meta-item">${esc(costStr)}</span>
        </span>
      </div>
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
    _activeTeamCount = 0; // reset so default is re-derived from player count
    _teamVoteMap = {};
    _myTeamVote  = '';
    _positionQueue = [];
    _myQueueEntry  = null;
    let attendees   = [];
    let isAttending = false;

    let waitingList         = [];
    let myWaitingListPos    = 0; // 0 = not on list

    if (_currentUser) {
      const wlRef    = getDb().collection('sessions').doc(id).collection('waitingList');
      const votesRef = getDb().collection('sessions').doc(id).collection('teamVotes');
      const hasPosTargets = !!(session.positionTargets && Object.keys(session.positionTargets).length);
      const [attendeesSnap, ownWlSnap, votesSnap, posWlSnap] = await Promise.all([
        _fsGet(_attendeesRef(id).orderBy('joinedAt', 'asc')),
        _fsGet(wlRef.doc(_currentUser.uid)),
        _fsGet(votesRef),
        hasPosTargets ? _fsGet(_posWlRef(id).orderBy('joinedAt', 'asc')) : Promise.resolve(null),
      ]);
      attendees         = attendeesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      _currentAttendees = attendees;
      isAttending       = attendees.some(a => a.id === _currentUser.uid);

      if (posWlSnap) {
        _positionQueue = posWlSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        _myQueueEntry  = _positionQueue.find(e => e.id === _currentUser.uid) || null;
      }

      _teamVoteMap = {};
      _myTeamVote  = '';
      for (const d of votesSnap.docs) {
        const k = d.data().partition;
        if (k) {
          _teamVoteMap[k] = (_teamVoteMap[k] || 0) + 1;
          if (d.id === _currentUser.uid) _myTeamVote = k;
        }
      }

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

// ─── Position fill counting ────────────────────────────────────────────────────
// Each player counts toward exactly one position (the one most in need of them).
// Players with only one targeted position are assigned first; multi-position
// players are then assigned greedily to the position with the most remaining slots.
function _computePosCounts(attendees, positionTargets) {
  const ptKeys = Object.keys(positionTargets || {});
  if (!ptKeys.length) return {};
  const counts = {};
  for (const p of ptKeys) counts[p] = 0;
  const multi = [];
  for (const a of attendees) {
    const aPos = (a.positions || []).filter(p => counts.hasOwnProperty(p));
    if (aPos.length === 1)      counts[aPos[0]]++;
    else if (aPos.length > 1)   multi.push(aPos);
    // players with no targeted position don't count toward any target
  }
  for (const positions of multi) {
    let best = positions[0], bestRemaining = -Infinity;
    for (const p of positions) {
      const remaining = (positionTargets[p] || 0) - counts[p];
      if (remaining > bestRemaining) { bestRemaining = remaining; best = p; }
    }
    counts[best]++;
  }
  return counts;
}

// ─── Team builder ──────────────────────────────────────────────────────────────
let _activeTeamCount = 0; // 0 = use default derived from player count

function _combos(arr, k) {
  if (k === 0) return [[]];
  const res = [];
  function bt(start, cur) {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); bt(i + 1, cur); cur.pop(); }
  }
  bt(0, []);
  return res;
}

// Stable canonical key for a partition: sort each team's IDs, then sort teams.
// Used for deduplication and as the Firestore vote field value.
function _partitionKey(teams) {
  return teams
    .map(team => team.map(p => p.id).sort().join(','))
    .sort()
    .join('|');
}

// Partition attendees into numTeams balanced teams, women spread equally.
// Returns Array<{teams: Player[][], key: string}>, deduplicated by canonical key.
function _buildPartitions(attendees, numTeams, maxResults = 30) {
  const players = attendees.map(a => ({
    id:        a.id,
    name:      a.name,
    gender:    a.gender === 'woman' ? 'f' : 'm',
    positions: new Set(a.positions || []),
  }));

  const women   = players.filter(p => p.gender === 'f');
  const men     = players.filter(p => p.gender !== 'f');
  const total   = players.length;
  const tFloor  = Math.floor(total        / numTeams);
  const wFloor  = Math.floor(women.length / numTeams);
  const tExtras = total        % numTeams;
  const wExtras = women.length % numTeams;
  const tSizes  = Array.from({length: numTeams}, (_, i) => tFloor + (i < tExtras ? 1 : 0));
  const wSizes  = Array.from({length: numTeams}, (_, i) => wFloor + (i < wExtras ? 1 : 0));
  const mSizes  = tSizes.map((t, i) => t - wSizes[i]);

  // Enumerate unique splits for one gender group independently.
  function enumSplits(pool, sizes) {
    const splits = [], seen = new Set();
    function go(pool, idx, cur) {
      if (splits.length >= maxResults) return;
      if (idx === sizes.length) {
        const k = _partitionKey(cur);
        if (!seen.has(k)) { seen.add(k); splits.push(cur.map(t => [...t])); }
        return;
      }
      for (const pick of _combos(pool, sizes[idx])) {
        const ids = new Set(pick.map(p => p.id));
        cur.push(pick);
        go(pool.filter(p => !ids.has(p.id)), idx + 1, cur);
        cur.pop();
        if (splits.length >= maxResults) return;
      }
    }
    go(pool, 0, []);
    return splits;
  }

  const wSplits = enumSplits(women, wSizes);
  const mSplits = enumSplits(men,   mSizes);
  if (!wSplits.length || !mSplits.length) return [];

  // Pair women split i with men split i (cycling the shorter list).
  // This ensures every card shows different women AND different men.
  const seen    = new Set();
  const results = [];
  const steps   = Math.min(maxResults, Math.max(wSplits.length, mSplits.length));
  for (let i = 0; i < steps && results.length < maxResults; i++) {
    const teams = wSplits[i % wSplits.length].map((wTeam, j) =>
      [...wTeam, ...mSplits[i % mSplits.length][j]]);
    const key = _partitionKey(teams);
    if (!seen.has(key)) { seen.add(key); results.push({ teams, key }); }
  }
  return results;
}

function _renderTeamsSection(session, attendees) {
  if (session.type !== 'game') return '';
  if (!attendees.length) return '';

  const total    = attendees.length;
  const defaultN = total > 12 ? 3 : 2;
  const n        = _activeTeamCount || defaultN;
  if (total < n * 4) return '';

  let partitions = _buildPartitions(attendees, n);
  if (!partitions.length) return '';

  // Sort most-voted first; stable (preserves original order within same vote count).
  partitions = [...partitions].sort((a, b) => (_teamVoteMap[b.key] || 0) - (_teamVoteMap[a.key] || 0));

  const isAttending = !!(_currentUser && attendees.some(a => a.id === _currentUser.uid));
  const POS = { setter: 'S', hitter: 'H', outside: 'OH', opposite: 'OPP', middle: 'M', libero: 'L' };
  const maxN = Math.min(Math.floor(total / 4), 5);
  const nBtns = Array.from({length: maxN - 1}, (_, i) => i + 2)
    .map(k => `<button class="tbuilder-n-btn${k === n ? ' active' : ''}" onclick="setTeamCount(${k})">${k}</button>`)
    .join('');

  const cards = partitions.map((p, pi) => {
    const { teams, key } = p;
    const votes    = _teamVoteMap[key] || 0;
    const isMyVote = _myTeamVote === key;

    const cols = teams.map((team, ti) => {
      const wc   = team.filter(pl => pl.gender === 'f').length;
      const rows = team.map(pl => {
        const pos = [...pl.positions].map(k => POS[k] || k).join('/');
        return `<div class="tbuilder-player${pl.gender === 'f' ? ' w' : ''}">
          <span class="tbuilder-pname">${esc(pl.name)}</span>${pos ? `<span class="tbuilder-pos">${pos}</span>` : ''}
        </div>`;
      }).join('');
      return `<div class="tbuilder-team-col">
        <div class="tbuilder-team-hdr">Team ${ti + 1}<span class="tbuilder-wc-inline">${wc}♀</span></div>
        ${rows}
      </div>`;
    }).join('<div class="tbuilder-col-divider"></div>');

    const safeKey  = key.replace(/"/g, '&quot;');
    const voteBtn  = isAttending
      ? `<button class="tbuilder-vote-btn${isMyVote ? ' voted' : ''}"
           data-key="${safeKey}" data-sid="${session.id}"
           onclick="voteForTeam(this)">${isMyVote ? '✓ Voted' : 'Vote'}</button>`
      : '';
    const voteBadge = votes > 0
      ? `<span class="tbuilder-vote-count">${votes} vote${votes !== 1 ? 's' : ''}</span>`
      : '';

    return `<div class="tbuilder-card${isMyVote ? ' my-vote' : ''}">
      <div class="tbuilder-card-top">
        <span class="tbuilder-num">#${pi + 1}</span>
        ${voteBadge}${voteBtn}
      </div>
      <div class="tbuilder-cols">${cols}</div>
    </div>`;
  }).join('');

  return `
    <div class="detail-section" id="tbuilder-section">
      <div class="tbuilder-header">
        <span class="detail-section-title">Teams</span>
        <span class="tbuilder-count">${partitions.length}</span>
        <div class="tbuilder-n-row">${nBtns}</div>
      </div>
      <div class="tbuilder-scroll">${cards}</div>
    </div>`;
}

function _refreshTeamsSection() {
  const section = document.getElementById('tbuilder-section');
  if (!section || !_currentSession) return;
  const html = _renderTeamsSection(_currentSession, _currentAttendees);
  if (html) section.outerHTML = html;
}

window.setTeamCount = function(n) {
  _activeTeamCount = n;
  _refreshTeamsSection();
};

window.voteForTeam = async function(btn) {
  if (!_currentUser) return;
  const key       = btn.dataset.key;
  const sessionId = btn.dataset.sid;
  const voteRef   = getDb().collection('sessions').doc(sessionId)
                           .collection('teamVotes').doc(_currentUser.uid);

  if (_myTeamVote === key) {
    // Toggle off — remove vote.
    _teamVoteMap[key] = Math.max(0, (_teamVoteMap[key] || 1) - 1);
    if (!_teamVoteMap[key]) delete _teamVoteMap[key];
    _myTeamVote = '';
    _refreshTeamsSection();
    await voteRef.delete();
  } else {
    // Switch or new vote — remove old, add new.
    if (_myTeamVote) {
      _teamVoteMap[_myTeamVote] = Math.max(0, (_teamVoteMap[_myTeamVote] || 1) - 1);
      if (!_teamVoteMap[_myTeamVote]) delete _teamVoteMap[_myTeamVote];
    }
    _teamVoteMap[key] = (_teamVoteMap[key] || 0) + 1;
    _myTeamVote = key;
    _refreshTeamsSection();
    _gaEvent('vote_team', { session_id: sessionId });
    await voteRef.set({ partition: key, votedAt: firebase.firestore.FieldValue.serverTimestamp() });
  }
};

function _renderDetail(session, attendees, isAttending, waitingList, myWaitingListPos, content, footer, seriesReg) {
  const knownCount     = _currentUser ? attendees.length : (session.attendeeCount || 0);
  const spotsLeft      = _spotsLeft(session, knownCount);
  const isCancelled    = session.status === 'cancelled';
  const isClosed       = session.status === 'closed';
  const isFull         = spotsLeft === 0 && !isAttending;
  const canStart       = _isAdmin || (_currentUser && session.coachUid && session.coachUid === _currentUser.uid);
  const deadlinePassed = session.registrationDeadline && session.registrationDeadline.toDate() < new Date();
  const levelLabel     = { beginner: 'Beginner', improver: 'Intermediate', intermediate: 'Advanced', advanced: 'Competitive', competitive: 'Elite' }[session.level] || '';
  const deadlineStr    = session.registrationDeadline
    ? session.registrationDeadline.toDate().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  content.innerHTML = `
    <div class="detail-section">
      <div class="detail-meta-grid">
        ${session.venue ? `<div class="detail-meta-row"><span class="detail-meta-label">Venue</span><span>${(() => {
          const v = session.venueId ? _allVenues.find(x => x.id === session.venueId) : null;
          const name = session.venueId && _currentUser
            ? `<button class="detail-link" onclick="openVenueDetail('${session.venueId}')">${esc(session.venue)}</button>`
            : esc(session.venue);
          const addr = v?.address ? ` <span class="venue-address">${esc(v.address)}</span>` : '';
          return name + addr;
        })()}</span></div>` : ''}
        <div class="detail-meta-row"><span class="detail-meta-label">Date</span><span>${esc(_formatDate(session.date))}${session.time ? ` at ${esc(session.time)}` : ''}</span></div>
        ${session.type ? `<div class="detail-meta-row"><span class="detail-meta-label">Type</span><span><span class="session-badge type-${esc(session.type)}">${esc(SESSION_TYPES.find(t => t.value === session.type)?.label || session.type)}</span></span></div>` : ''}
        ${session.coach ? `<div class="detail-meta-row"><span class="detail-meta-label">Coach</span><span>${esc(session.coach)}</span></div>` : ''}
        ${levelLabel ? `<div class="detail-meta-row"><span class="detail-meta-label">Level</span><span><button class="detail-link" onclick="openLevelInfo('${esc(session.level)}')">${esc(levelLabel)} ↗</button></span></div>` : ''}
        <div class="detail-meta-row"><span class="detail-meta-label">Cost</span><span>${esc(_formatPlayerPrice(session.cost, session.absorbFee))}</span></div>
        <div class="detail-meta-row"><span class="detail-meta-label">Spots</span><span>${knownCount} / ${session.maxPlayers}${isCancelled ? '' : ` · ${spotsLeft} left`}${(() => {
          const isHost = _isAdmin || (_currentUser && session.providerUid === _currentUser.uid);
          const over = knownCount - (session.maxPlayers || 0);
          return isHost && over > 0 ? ` <span class="detail-badge over-cap-badge">+${over} over capacity</span>` : '';
        })()}</span></div>
        ${(() => {
          const pt = session.positionTargets;
          if (!session.askPositions || !pt || !_currentUser) return '';
          const PLABELS = { setter: 'S', hitter: 'H', middle: 'M', libero: 'L' };
          const _pCounts = _computePosCounts(attendees, pt);
          const chips = Object.entries(PLABELS)
            .filter(([pos]) => pt[pos])
            .map(([pos, lbl]) => {
              const count = _pCounts[pos] || 0;
              const full  = count >= pt[pos];
              return `<span class="pos-fill-chip ${pos}${full ? ' full' : ''}">${lbl} ${count}/${pt[pos]}</span>`;
            }).join('');
          return chips ? `<div class="detail-meta-row"><span class="detail-meta-label">Positions</span><span class="pos-fill-row">${chips}</span></div>` : '';
        })()}
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
              const passChip  = a.seriesId
                ? `<span class="att-chip series-chip">Pass</span>` : '';
              const payChip   = canSee && session.cost > 0
                ? `<span class="att-chip ${a.feeWaived ? 'waived-chip' : a.paid ? 'paid-chip' : 'unpaid-chip'}">${a.feeWaived ? 'Waived' : a.paid ? 'Paid' : 'Unpaid'}</span>` : '';
              const photoChip = _isAdmin && a.photoConsent === true
                ? `<span class="att-chip photo-chip">Photo ✓</span>`
                : _isAdmin && a.photoConsent === false
                  ? `<span class="att-chip nophoto-chip">No photo</span>` : '';
              const statusChips = passChip || payChip || photoChip
                ? `<div class="attendee-chips-row">${passChip}${payChip}${photoChip}</div>` : '';
              const subLine = _isAdmin || statusChips
                ? `<div class="attendee-sub attendee-sub-row">
                     ${_isAdmin ? `<button class="attendee-remove-btn" onclick="removeAttendee('${session.id}','${a.id}')">Remove attendee</button>` : ''}
                     ${statusChips}
                   </div>` : '';
              return `
              <div class="attendee-row">
                <div class="attendee-main">
                  <span class="attendee-num">${i + 1}</span>
                  ${genderSym ? `<span class="attendee-gender ${genderClass}">${genderSym}</span>` : ''}
                  <button class="attendee-name-btn" onclick="openProfileScreen('${a.id}')">${esc(a.name)}</button>
                  ${posChips ? `<div class="att-chips">${posChips}</div>` : ''}
                  ${isOwn && session.askPositions && !Object.keys(session.positionTargets || {}).length ? `<button class="icon-btn small" data-session-id="${esc(session.id)}" data-positions="${esc(Array.from(posSet).join(','))}" onclick="openEditPositions(this.dataset.sessionId,this.dataset.positions)" title="Edit positions">✎</button>` : ''}
                </div>
                ${subLine}
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

    ${(() => {
      const POS_LABELS = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };
      if (!_positionQueue.length) return '';
      const isMySection = !!_myQueueEntry;
      if (!_isAdmin && !isMySection) return '';
      const pt     = session.positionTargets || {};
      const counts = _computePosCounts(attendees, pt);
      // Positions with open slots (target set but not yet met)
      const openSlots = Object.entries(pt).filter(([p, t]) => (counts[p] || 0) < t);
      // Queued players who already have a pending offer
      const byPos = {};
      for (const entry of _positionQueue) {
        for (const pos of (entry.positions || [])) {
          (byPos[pos] = byPos[pos] || []).push(entry);
        }
      }
      const groups = Object.entries(byPos).filter(([,list]) => list.length);
      if (!groups.length) return '';

      const _offeredPositions = e => e.pendingOffer?.positions || (e.pendingOffer?.position ? [e.pendingOffer.position] : []);

      const offerBanner = _isAdmin && openSlots.length ? `
        <div class="queue-offer-banner">
          ${openSlots.map(([p, t]) => {
            const need  = t - (counts[p] || 0);
            const label = POS_LABELS[p] || p;
            const alreadyOffered = _positionQueue.some(e => _offeredPositions(e).includes(p));
            return alreadyOffered
              ? `<span class="queue-offer-row"><span class="queue-offer-label">${label} needs ${need} — offer pending</span></span>`
              : `<span class="queue-offer-row"><span class="queue-offer-label">${label} needs ${need}</span><button class="icon-btn small" onclick="offerPositionToQueue('${session.id}','${p}')">Send offer →</button></span>`;
          }).join('')}
          ${openSlots.length > 1 ? `<span class="queue-offer-row queue-offer-row-fill"><button class="icon-btn small" onclick="fillAllPositions('${session.id}')">Fill all positions →</button></span>` : ''}
        </div>` : '';

      return `
    <div class="detail-section">
      <div class="detail-section-title">Position queues</div>
      ${offerBanner}
      ${groups.map(([pos, list]) => `
        <div class="pos-queue-group">
          <div class="pos-queue-pos-label ${pos}">${POS_LABELS[pos] || pos} <span class="pos-queue-count">${list.length}</span></div>
          <div class="attendee-list">
            ${list.map((e, i) => {
              const isMe = _currentUser && e.id === _currentUser.uid;
              const offPos = _offeredPositions(e);
              return `<div class="attendee-row${isMe ? ' attendee-row-me' : ''}">
                <span class="attendee-num">${i + 1}</span>
                ${_isAdmin
                  ? `<button class="attendee-name-btn" onclick="openProfileScreen('${e.id}')">${esc(e.name)}</button>
                     <span class="attendee-email">${esc(e.email || '')}</span>
                     ${offPos.length ? `<span class="att-chip queue-offered-chip">Offered ${offPos.map(p => POS_LABELS[p] || p).join(' · ')}</span>` : ''}`
                  : `<span class="attendee-name-btn">${isMe ? 'You' : '—'}</span>`}
              </div>`;
            }).join('')}
          </div>
        </div>`).join('')}
    </div>`;
    })()}

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

    ${_currentUser ? _renderTeamsSection(session, attendees) : ''}

    <div class="policy-link-row">
      <button class="policy-link" onclick="openPolicy()">Terms &amp; cancellation policy</button>
    </div>
    ${(_isAdmin || (_isProvider && _currentUser && session.providerUid === _currentUser.uid)) ? `
    <div class="session-detail-admin">
      <div class="session-admin-label">Host tools</div>

      ${!isCancelled && !isClosed ? `
        <div class="session-admin-group">
          <div class="session-admin-group-label">Session</div>
          <button class="cta-btn secondary-btn" onclick="openSessionEditInline('${session.id}')">Edit</button>
        </div>` : ''}

      ${_isAdmin ? `
        <div class="session-admin-group">
          <div class="session-admin-group-label">Attendees</div>
          ${!isCancelled ? `<button class="cta-btn secondary-btn" onclick="openMessageForm('${session.id}')">Message all</button>` : ''}
          <button class="cta-btn secondary-btn" onclick="exportAttendeesCsv('${session.id}')">Export CSV</button>
        </div>` : ''}

      ${(_isAdmin && session.coach && session.coachFee > 0 && isClosed) || (canStart && isClosed && session.report) ? `
        <div class="session-admin-group">
          <div class="session-admin-group-label">After session</div>
          ${_isAdmin && session.coach && session.coachFee > 0 && isClosed ? _coachPayCtaBtn(session) : ''}
          ${canStart && isClosed && session.report ? `<button class="cta-btn secondary-btn" onclick="openSessionEndReport('${session.id}')">View report</button>` : ''}
        </div>` : ''}

      ${(!isCancelled && !isClosed) || _isAdmin ? `
        <div class="session-admin-group">
          <div class="session-admin-group-label">Danger zone</div>
          ${!isCancelled && !isClosed ? `<button class="cta-btn danger-btn" onclick="cancelSession('${session.id}')">Cancel session</button>` : ''}
          ${_isAdmin ? `<button class="cta-btn danger-btn" onclick="deleteSession('${session.id}','${esc(session.venue || '')}',this)">Delete session</button>` : ''}
        </div>` : ''}
    </div>` : ''}`;

  const hasWaitingList = waitingList.length > 0;
  const cancelLabel    = isAttending && hasWaitingList && !isCancelled && !isClosed
    ? 'Sell my spot →'
    : 'Cancel my registration';

  // Compute whether all position targets are met (relevant for position-queue routing)
  const _pt = session.positionTargets || {};
  const _ptKeys = Object.keys(_pt);
  const _pFill = _computePosCounts(attendees, _pt);
  const _allTargetsFull = _ptKeys.length > 0 && _ptKeys.every(p => (_pFill[p] || 0) >= _pt[p]);

  // Series pass: replace cancel with drop-out, replace join with series-pass join
  const dropOutBtn  = seriesReg ? `<button class="cta-btn secondary-btn" onclick="dropOutOfSession('${session.id}')">Drop out of this session</button>` : '';
  const seriesJoin  = seriesReg && !isAttending && !isFull && !deadlinePassed
    ? `<button class="cta-btn" onclick="registerWithSeriesPass('${session.id}')">Join with pass →</button>`
    : '';

  if (isClosed) {
    footer.innerHTML = `<button class="cta-btn" disabled>Session closed</button>`;
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
    footer.innerHTML = `
      <button class="cta-btn" onclick="openSessionRun('${session.id}')">▶ Start session</button>
      ${cancelBtn}${joinBtn}`;
  } else if (isAttending) {
    const cancelBtn = seriesReg ? dropOutBtn : `<button class="cta-btn secondary-btn" onclick="cancelRegistration('${session.id}')">${cancelLabel}</button>`;
    footer.innerHTML = cancelBtn;
  } else if (_myQueueEntry && !deadlinePassed) {
    const POS_LABELS = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };
    const offer = _myQueueEntry.pendingOffer;
    const offeredPositions = offer?.positions || (offer?.position ? [offer.position] : []);
    if (offeredPositions.length) {
      const labels = offeredPositions.map(p => POS_LABELS[p] || p).join(' · ');
      footer.innerHTML = `
        <span class="waiting-pos offer-waiting-pos">Spot${offeredPositions.length > 1 ? 's' : ''} available — <strong>${labels}</strong></span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${offeredPositions.map(p => `<button class="cta-btn" onclick="acceptQueueOffer('${session.id}','${p}')">Accept ${POS_LABELS[p] || p}</button>`).join('')}
          <button class="cta-btn secondary-btn" onclick="declineQueueOffer('${session.id}')">Decline</button>
        </div>`;
    } else {
      const queueNums = (_myQueueEntry.positions || []).map(p => {
        const qi = (_positionQueue.filter(e => (e.positions || []).includes(p))).findIndex(e => e.id === _currentUser.uid) + 1;
        return `${POS_LABELS[p] || p} #${qi}`;
      }).join(' · ');
      footer.innerHTML = `
        <span class="waiting-pos">In queue — ${queueNums}</span>
        <div style="display:flex;gap:8px">
          <button class="cta-btn secondary-btn" onclick="editPositionQueue('${session.id}')">Edit positions</button>
          <button class="cta-btn secondary-btn" onclick="leavePositionQueue('${session.id}')">Leave queue</button>
        </div>`;
    }
  } else if (seriesJoin) {
    footer.innerHTML = seriesJoin;
  } else if (myWaitingListPos !== 0 && !isFull && !deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" onclick="register('${session.id}')">Claim your spot →</button>`;
  } else if (myWaitingListPos !== 0) {
    const posLabel = myWaitingListPos > 0 ? `You're #${myWaitingListPos} on the waiting list` : `You're on the waiting list`;
    footer.innerHTML = `
      <span class="waiting-pos">${posLabel}</span>
      <button class="cta-btn secondary-btn" onclick="leaveWaitingList('${session.id}')">Leave list</button>`;
  } else if (_allTargetsFull && !deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" onclick="openQueueModal('${session.id}')">Join queue →</button>`;
  } else if (isFull && !deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" onclick="joinWaitingList('${session.id}')">Join waiting list →</button>`;
  } else if (deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" disabled>Registration closed</button>`;
  } else {
    footer.innerHTML = `<button class="cta-btn" onclick="register('${session.id}')">Join session →</button>`;
  }
}

function registerFree(sessionId) { return _doRegister(sessionId, { feeWaived: true }); }

// ─── Position queue ────────────────────────────────────────────────────────────

const POS_LABELS_FULL = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };

function _showMixedPositionModal(sessionId, openPositions, fullPositions, extra) {
  const existing = document.getElementById('mixed-pos-overlay');
  if (existing) existing.remove();

  const fullLabels = fullPositions.map(p => POS_LABELS_FULL[p] || p);
  const openLabels = openPositions.map(p => POS_LABELS_FULL[p] || p);
  const fullStr  = fullLabels.length === 1
    ? `The ${fullLabels[0]} slots are full`
    : `The ${fullLabels.slice(0, -1).join(', ')} and ${fullLabels.at(-1)} slots are full`;
  const openStr  = openLabels.join(' and ');
  const el = document.createElement('div');
  el.id = 'mixed-pos-overlay';
  el.className = 'overlay open';
  el.innerHTML = `
    <div class="panel" style="max-width:420px">
      <div class="panel-header"><span class="panel-title">Heads up</span></div>
      <p style="font-size:14px;color:var(--muted);line-height:1.55;padding-bottom:20px">
        ${fullStr} — would you like to be registered as <strong style="color:var(--text)">${openStr}</strong> only?
      </p>
      <div id="mixed-pos-error" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:12px"></div>
      <button class="cta-btn" onclick="_confirmMixedPosition('${sessionId}')">Yes, register as ${openStr} →</button>
      <button class="cta-btn secondary-btn" style="margin-top:8px" onclick="document.getElementById('mixed-pos-overlay').remove()">Cancel</button>
    </div>`;
  document.body.appendChild(el);
  // stash extra so the confirm handler can use it
  el._extra = extra;
  el._openPositions = openPositions;
}

window._confirmMixedPosition = async function(sessionId) {
  const overlay = document.getElementById('mixed-pos-overlay');
  const extra   = overlay._extra;
  const openPos = overlay._openPositions;
  const btn     = overlay.querySelector('.cta-btn');
  btn.disabled = true;
  try {
    await _doRegister(sessionId, { ...extra, positions: openPos });
    overlay.remove();
  } catch(e) {
    console.error('Mixed position register failed:', e);
    document.getElementById('mixed-pos-error').textContent = 'Something went wrong. Try again.';
    btn.disabled = false;
  }
};

function _showQueueModal(sessionId, suggestedPositions) {
  const existing = document.getElementById('queue-modal-overlay');
  if (existing) existing.remove();

  const allPositions = Object.keys(_currentSession?.positionTargets || {});
  const rows = allPositions.map(pos => {
    const checked = suggestedPositions.includes(pos);
    const lbl = POS_LABELS_FULL[pos] || pos;
    return `<label class="pos-queue-check-row">
      <input type="checkbox" value="${pos}" ${checked ? 'checked' : ''} />
      <span class="pos-queue-check-label">${lbl}</span>
    </label>`;
  }).join('');

  const el = document.createElement('div');
  el.id = 'queue-modal-overlay';
  el.className = 'overlay open';
  el.innerHTML = `
    <div class="panel" style="max-width:420px">
      <div class="panel-header">
        <span class="panel-title">Join position queue</span>
      </div>
      <p style="font-size:14px;color:var(--muted);line-height:1.55;padding-bottom:16px">
        The positions you selected are full. Choose which queues to join — you'll be notified if a spot opens up for you.
      </p>
      <div id="queue-modal-positions" style="display:flex;flex-direction:column;gap:10px;padding-bottom:20px">${rows}</div>
      <div id="queue-modal-error" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:12px"></div>
      <button class="cta-btn" onclick="_confirmJoinQueue('${sessionId}')">Join queue →</button>
      <button class="cta-btn secondary-btn" style="margin-top:8px" onclick="document.getElementById('queue-modal-overlay').remove()">Cancel</button>
    </div>`;
  document.body.appendChild(el);
}

window.openQueueModal = function(sessionId) {
  if (!_currentUser) { _pendingJoinSessionId = sessionId; handleAuthClick(); return; }
  const allPositions = Object.keys(_currentSession?.positionTargets || {});
  _showQueueModal(sessionId, allPositions);
};

window._confirmJoinQueue = async function(sessionId) {
  const checked = Array.from(document.querySelectorAll('#queue-modal-positions input:checked')).map(el => el.value);
  if (!checked.length) {
    document.getElementById('queue-modal-error').textContent = 'Select at least one position.';
    return;
  }
  const btn = document.querySelector('#queue-modal-overlay .cta-btn');
  btn.disabled = true;
  try {
    await _posWlRef(sessionId).doc(_currentUser.uid).set({
      name:      _currentUser.displayName || _currentUser.email,
      email:     _currentUser.email || '',
      uid:       _currentUser.uid,
      positions: checked,
      joinedAt:  firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById('queue-modal-overlay').remove();
    await openSession(sessionId);
  } catch(e) {
    console.error('Join queue failed:', e);
    document.getElementById('queue-modal-error').textContent = 'Couldn\'t join queue. Try again.';
    btn.disabled = false;
  }
};

window.leavePositionQueue = async function(sessionId) {
  if (!_currentUser) return;
  try {
    await _posWlRef(sessionId).doc(_currentUser.uid).delete();
    await openSession(sessionId);
  } catch(e) {
    console.error('Leave queue failed:', e);
    showToast('Couldn\'t leave queue. Try again.');
  }
};

function _offeredPositions(entry) {
  return entry.pendingOffer?.positions || (entry.pendingOffer?.position ? [entry.pendingOffer.position] : []);
}

// Admin sends a position offer to ALL players currently in the queue (merges with any existing offer).
window.offerPositionToQueue = async function(sessionId, position) {
  if (!_positionQueue.length) return;
  try {
    const batch = firebase.firestore().batch();
    let count = 0;
    for (const entry of _positionQueue) {
      const existing = _offeredPositions(entry);
      if (!existing.includes(position)) {
        batch.update(_posWlRef(sessionId).doc(entry.id), {
          pendingOffer: { positions: [...existing, position], offeredAt: firebase.firestore.FieldValue.serverTimestamp() },
        });
        count++;
      }
    }
    await batch.commit();
    showToast(`Offer sent to ${count} player${count !== 1 ? 's' : ''}.`);
    await openSession(sessionId);
  } catch(e) {
    console.error('Offer failed:', e);
    showToast('Couldn\'t send offer. Try again.', 'error');
  }
};

// Admin sends offers for ALL underfilled positions at once.
window.fillAllPositions = async function(sessionId) {
  if (!_positionQueue.length) return;
  const pt      = _currentSession?.positionTargets || {};
  const counts  = _computePosCounts(_currentAttendees, pt);
  const allOpen = Object.keys(pt).filter(p => (counts[p] || 0) < pt[p]);
  if (!allOpen.length) { showToast('No open slots to fill.'); return; }
  try {
    const batch = firebase.firestore().batch();
    for (const entry of _positionQueue) {
      const existing    = _offeredPositions(entry);
      const newPositions = [...new Set([...existing, ...allOpen])];
      batch.update(_posWlRef(sessionId).doc(entry.id), {
        pendingOffer: { positions: newPositions, offeredAt: firebase.firestore.FieldValue.serverTimestamp() },
      });
    }
    await batch.commit();
    showToast(`All open slots offered to ${_positionQueue.length} player${_positionQueue.length !== 1 ? 's' : ''}.`);
    await openSession(sessionId);
  } catch(e) {
    console.error('Fill all failed:', e);
    showToast('Couldn\'t send offers. Try again.', 'error');
  }
};

// Player accepts the offered position. First to commit wins.
window.acceptQueueOffer = async function(sessionId, position) {
  if (!_currentUser || !position) return;
  const pt     = _currentSession?.positionTargets || {};
  const counts = _computePosCounts(_currentAttendees, pt);
  if (pt[position] != null && (counts[position] || 0) >= pt[position]) {
    showToast('This spot was just taken — too slow!', 'error');
    await _posWlRef(sessionId).doc(_currentUser.uid).update({
      pendingOffer: firebase.firestore.FieldValue.delete(),
    });
    await openSession(sessionId);
    return;
  }
  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) btn.disabled = true;
  try {
    const session = _currentSession;
    if ((session?.cost || 0) > 0) {
      const base = window.location.origin + window.location.pathname;
      const data = await callFn('createCheckoutSession', {
        sessionId,
        successUrl: `${base}?checkout=success&session=${sessionId}`,
        cancelUrl:  `${base}?checkout=cancelled&session=${sessionId}`,
        positions:  [position],
      });
      window.location.href = data.url;
      return;
    }
    const userDoc = await _userRef(_currentUser.uid).get();
    const batch = firebase.firestore().batch();
    batch.set(_attendeesRef(sessionId).doc(_currentUser.uid), {
      name:         _currentUser.displayName || _currentUser.email,
      email:        _currentUser.email || '',
      joinedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      paid:         false,
      feeWaived:    false,
      photoConsent: userDoc.data()?.photoConsent?.given ?? false,
      positions:    [position],
      gender:       userDoc.data()?.gender || '',
    });
    batch.update(_sessionRef(sessionId), {
      attendeeCount: firebase.firestore.FieldValue.increment(1),
    });
    batch.delete(_posWlRef(sessionId).doc(_currentUser.uid));
    await batch.commit();
    _gaEvent('join_session', { session_id: sessionId });
    await openSession(sessionId);
  } catch(e) {
    console.error('Accept offer failed:', e);
    showToast('Couldn\'t accept offer. Try again.', 'error');
    if (btn) btn.disabled = false;
  }
};

// Player declines — clears the offer but stays in queue for their original position.
window.declineQueueOffer = async function(sessionId) {
  if (!_currentUser) return;
  try {
    await _posWlRef(sessionId).doc(_currentUser.uid).update({
      pendingOffer: firebase.firestore.FieldValue.delete(),
    });
    showToast('Offer declined. You\'re still in the queue.');
    await openSession(sessionId);
  } catch(e) {
    console.error('Decline offer failed:', e);
    showToast('Couldn\'t decline. Try again.', 'error');
  }
};

window.editPositionQueue = function(sessionId) {
  const current = _myQueueEntry?.positions || [];
  const allPositions = Object.keys(_currentSession?.positionTargets || {});

  const existing = document.getElementById('queue-modal-overlay');
  if (existing) existing.remove();

  const rows = allPositions.map(pos => {
    const checked = current.includes(pos);
    const lbl = POS_LABELS_FULL[pos] || pos;
    return `<label class="pos-queue-check-row">
      <input type="checkbox" value="${pos}" ${checked ? 'checked' : ''} />
      <span class="pos-queue-check-label">${lbl}</span>
    </label>`;
  }).join('');

  const el = document.createElement('div');
  el.id = 'queue-modal-overlay';
  el.className = 'overlay open';
  el.innerHTML = `
    <div class="panel" style="max-width:420px">
      <div class="panel-header"><span class="panel-title">Edit queue positions</span></div>
      <p style="font-size:14px;color:var(--muted);line-height:1.55;padding-bottom:16px">
        Update which position queues you're in. Your place in any existing queue won't change.
      </p>
      <div id="queue-modal-positions" style="display:flex;flex-direction:column;gap:10px;padding-bottom:20px">${rows}</div>
      <div id="queue-modal-error" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:12px"></div>
      <button class="cta-btn" onclick="_confirmEditQueue('${sessionId}')">Save →</button>
      <button class="cta-btn secondary-btn" style="margin-top:8px" onclick="document.getElementById('queue-modal-overlay').remove()">Cancel</button>
    </div>`;
  document.body.appendChild(el);
};

window._confirmEditQueue = async function(sessionId) {
  const checked = Array.from(document.querySelectorAll('#queue-modal-positions input:checked')).map(el => el.value);
  if (!checked.length) {
    document.getElementById('queue-modal-error').textContent = 'Select at least one position, or leave the queue.';
    return;
  }

  // Check if any newly added positions have open slots — offer direct registration instead.
  const current = _myQueueEntry?.positions || [];
  const pt = _currentSession?.positionTargets || {};
  const counts = _computePosCounts(_currentAttendees, pt);
  const newlyAdded  = checked.filter(p => !current.includes(p));
  const openAmongNew = newlyAdded.filter(p => pt[p] != null && (counts[p] || 0) < pt[p]);

  if (openAmongNew.length) {
    _showEditQueueOpenSlotModal(sessionId, checked, openAmongNew);
    return;
  }

  await _saveEditQueue(sessionId, checked);
};

window._saveEditQueue = async function _saveEditQueue(sessionId, positions) {
  try {
    await _posWlRef(sessionId).doc(_currentUser.uid).update({ positions });
    document.getElementById('queue-modal-overlay')?.remove();
    await openSession(sessionId);
  } catch(e) {
    console.error('Edit queue failed:', e);
    document.getElementById('queue-modal-error').textContent = 'Couldn\'t update queue. Try again.';
  }
};

function _showEditQueueOpenSlotModal(sessionId, allChecked, openPositions) {
  const existing = document.getElementById('queue-modal-overlay');
  if (existing) existing.remove();

  _pendingEditQueueOpen = openPositions;
  _pendingEditQueueFull = allChecked.filter(p => !openPositions.includes(p));

  const openLabels = openPositions.map(p => POS_LABELS_FULL[p] || p);
  const openStr = openLabels.length === 1 ? openLabels[0] : openLabels.slice(0,-1).join(', ') + ' and ' + openLabels.at(-1);

  const el = document.createElement('div');
  el.id = 'queue-modal-overlay';
  el.className = 'overlay open';
  el.innerHTML = `
    <div class="panel" style="max-width:420px">
      <div class="panel-header"><span class="panel-title">Free spot available</span></div>
      <p style="font-size:14px;color:var(--muted);line-height:1.55;padding-bottom:20px">
        There's a free <strong style="color:var(--text)">${openStr}</strong> spot — would you like to register now instead of joining the queue?
      </p>
      <button class="cta-btn" onclick="_confirmEditQueueRegister('${sessionId}')">Register as ${openStr} →</button>
      <button class="cta-btn secondary-btn" style="margin-top:8px" onclick="document.getElementById('queue-modal-overlay').remove()">Cancel</button>
    </div>`;
  document.body.appendChild(el);
}

window._confirmEditQueueRegister = async function(sessionId) {
  const openPositions = _pendingEditQueueOpen;
  const btn = document.querySelector('#queue-modal-overlay .cta-btn');
  if (btn) btn.disabled = true;
  try {
    const userDoc = await _userRef(_currentUser.uid).get();
    await _attendeesRef(sessionId).doc(_currentUser.uid).set({
      name:         _currentUser.displayName || _currentUser.email,
      email:        _currentUser.email || '',
      joinedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      paid:         false,
      feeWaived:    false,
      photoConsent: userDoc.data()?.photoConsent?.given ?? false,
      positions:    openPositions,
      gender:       userDoc.data()?.gender || '',
    });
    await _sessionRef(sessionId).update({ attendeeCount: firebase.firestore.FieldValue.increment(1) });
    await _posWlRef(sessionId).doc(_currentUser.uid).delete();

    document.getElementById('queue-modal-overlay')?.remove();
    await openSession(sessionId);
  } catch(e) {
    console.error('Queue register failed:', e);
    if (btn) btn.disabled = false;
  }
};

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

    // Photo consent — one-time ask, optional (user can decline and still join)
    if (userDoc.data()?.photoConsent === undefined) {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
      _showPhotoConsentModal(sessionId);
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

function _showTermsModal() {
  const existing = document.getElementById('terms-overlay');
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'terms-overlay';
  el.className = 'overlay open';
  el.style.zIndex = '9999';
  el.innerHTML = `
    <div class="panel" style="max-width:420px">
      <div class="panel-header"><span class="panel-title">Welcome to Roots</span></div>
      <div style="padding:0 0 20px;font-size:14px;color:var(--muted);line-height:1.6">
        Before you continue, please read and accept our Terms &amp; Policy.
      </div>
      <label style="display:flex;gap:12px;align-items:flex-start;cursor:pointer;margin-bottom:20px">
        <input type="checkbox" id="terms-check" style="margin-top:3px;flex-shrink:0" />
        <span style="font-size:14px;color:var(--text);line-height:1.6">I have read and agree to the <a href="../policy/" target="_blank" style="color:var(--amber)">Terms &amp; Policy</a>, including the cancellation and refund policy.</span>
      </label>
      <div id="terms-error" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:12px"></div>
      <button class="cta-btn" onclick="_confirmTerms()">Continue →</button>
      <button class="cta-btn secondary-btn" style="margin-top:8px" onclick="handleAuthClick()">Sign out</button>
    </div>`;
  document.body.appendChild(el);
}

async function _confirmTerms() {
  if (!document.getElementById('terms-check').checked) {
    document.getElementById('terms-error').textContent = 'Please tick the box to continue.';
    return;
  }
  document.getElementById('terms-overlay').remove();
  _gaGrantConsent();
  await _userRef(_currentUser.uid).update({
    termsAccepted: { version: TERMS_VERSION, at: firebase.firestore.FieldValue.serverTimestamp() },
  });
}

function _showPhotoConsentModal(sessionId) {
  const existing = document.getElementById('photo-consent-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'photo-consent-overlay';
  el.className = 'overlay open';
  const sid = sessionId ? `'${sessionId}'` : 'null';
  el.innerHTML = `
    <div class="panel" style="max-width:420px">
      <div class="panel-header"><span class="panel-title">Photo &amp; filming consent</span></div>
      <div style="padding:0 0 20px;font-size:14px;color:var(--muted);line-height:1.6">
        <p>Sessions may be photographed or filmed by the organiser for community promotion and social media.</p>
        <p style="margin-top:10px">Do you consent to being photographed or filmed at Roots sessions? You can change this at any time from your profile.</p>
      </div>
      <button class="cta-btn" onclick="_confirmPhotoConsent(true, ${sid})">Yes, I consent</button>
      <button class="cta-btn secondary-btn" style="margin-top:8px" onclick="_confirmPhotoConsent(false, ${sid})">No thanks</button>
    </div>`;
  document.body.appendChild(el);
}

async function _confirmPhotoConsent(given, sessionId) {
  const overlay = document.getElementById('photo-consent-overlay');
  if (overlay) overlay.remove();
  await _userRef(_currentUser.uid).update({
    photoConsent: { given, version: PHOTO_CONSENT_VERSION, at: firebase.firestore.FieldValue.serverTimestamp() },
  });
  if (sessionId) await register(sessionId);
  else openProfileScreen(_currentUser.uid);
}

async function withdrawPhotoConsent() {
  await _userRef(_currentUser.uid).update({
    photoConsent: { given: false, version: PHOTO_CONSENT_VERSION, at: firebase.firestore.FieldValue.serverTimestamp() },
  });
  showToast('Photo consent withdrawn.');
  openProfileScreen(_currentUser.uid);
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

    // Position-target check: route to queue or mixed modal when positions are full.
    const pt = session.positionTargets || {};
    if (session.askPositions && Object.keys(pt).length && (extra.positions || []).length) {
      const counts = _computePosCounts(_currentAttendees, pt);
      const full = extra.positions.filter(p => pt[p] != null && (counts[p] || 0) >= pt[p]);
      const open = extra.positions.filter(p => !pt[p] || (counts[p] || 0) < pt[p]);
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
      if (open.length === 0) {
        _showQueueModal(sessionId, full);
        return;
      }
      if (full.length > 0) {
        _showMixedPositionModal(sessionId, open, full, extra);
        return;
      }
      // All chosen positions are open — fall through to register normally.
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
      name:         _currentUser.displayName || _currentUser.email,
      email:        _currentUser.email || '',
      joinedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      paid:         false,
      feeWaived:    !!extra.feeWaived,
      photoConsent: userDoc.data()?.photoConsent?.given ?? false,
      ...extra,
    });
    _gaEvent('join_session', { session_id: sessionId });
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
      showToast('You\'re in! Pass activated.');
      _seriesInvite    = null;
      _activeSeriesReg = { paymentStatus: 'paid' };
      renderHome();
    }
  } catch(e) {
    const alreadyHas = e.message && e.message.toLowerCase().includes('already registered');
    if (alreadyHas) {
      showToast('You already have a pass.');
      _activeSeriesReg = { paymentStatus: 'paid' };
      renderHome();
    } else {
      showToast(e.message || 'Couldn\'t activate pass. Try again.', 'error');
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
  if (!confirm('Drop out of this session? Your pass stays active for all other sessions.')) return;
  const btns = document.querySelectorAll('#detail-footer button');
  btns.forEach(b => { b.disabled = true; });
  try {
    await callFn('dropOutSeries', { sessionId });
    _gaEvent('leave_session', { session_id: sessionId });
    showToast('Dropped out. Your pass is still active.');
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
    _gaEvent('leave_session', { session_id: sessionId });
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

let _allCoaches = [];
let _coachPosFilter   = '';   // '' | 'setter' | 'hitter' | 'middle' | 'libero'
let _coachLevelFilter = '';   // '' | level key
let _coachStyleFilter = '';   // '' | 'Technical' | 'Tactical' | 'Physical' | 'Mental'
let _coachDayFilter   = '';   // '' | 'mon' | 'tue' | ... | 'sun'
let _coachSearch      = '';

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
    if (_userFilter === 'pending')          return (_isOpenRequest(u.coachRequest) && !(u.roles||[]).includes('coach'))
                                                || (_isOpenRequest(u.providerRequest) && !(u.roles||[]).includes('provider'));
    if (_userFilter === 'incomplete') return !u.gender || !(u.positions||[]).length;
    return true;
  });
  if (!users.length) { container.innerHTML = '<div class="home-empty">No users match.</div>'; return; }
  container.innerHTML = users.map(_renderUserRow).join('');
}

function _renderUserRow(u) {
  _userDisplayNames[u.id] = u.name || u.email || u.id;
  const roles              = u.roles || ['player'];
  const isMe               = _currentUser && u.id === _currentUser.uid;
  const hasOwner           = roles.includes('owner');
  const hasAdmin           = roles.includes('admin');
  const hasCoach           = roles.includes('coach');
  const hasProvider        = roles.includes('provider');
  const hasPendingCoach    = _isOpenRequest(u.coachRequest) && !hasCoach;
  const hasPendingProvider = _isOpenRequest(u.providerRequest) && !hasProvider;
  const hasPendingAdmin    = !!u.adminRequest && !hasAdmin;
  const initials           = (u.name || u.email || '?')[0].toUpperCase();
  const incomplete         = !u.gender || !(u.positions||[]).length;
  const posLabels          = { setter:'S', hitter:'H', middle:'M', libero:'L' };
  const posStr             = (u.positions||[]).map(p => posLabels[p]||p).join(' · ');
  const genderSym          = { man:'♂', woman:'♀', nonbinary:'⚧' }[u.gender] || '';
  const joined             = u.createdAt ? _formatDate(u.createdAt) : '';

  const pill = (label, cls, active) =>
    `<span class="role-pill${active ? ' active ' + cls : ''}">${label}</span>`;

  const rolePills = `
    <div class="user-role-pills">
      ${pill('Sudo',  'owner',    hasOwner)}
      ${pill('Admin', 'admin',    hasAdmin)}
      ${pill('Coach', 'coach',    hasCoach)}
      ${pill('Host',  'provider', hasProvider)}
    </div>`;

  return `
    <div class="user-row" onclick="openProfileScreen('${u.id}')">
      ${u.photoURL
        ? `<img class="user-avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
        : `<div class="user-avatar user-avatar--initials">${esc(initials)}</div>`}
      <div class="user-info">
        <div class="user-name">
          ${esc(u.name || '—')}${isMe ? ' <span class="user-you">you</span>' : ''}
          ${incomplete         ? '<span class="user-flag">incomplete</span>'              : ''}
          ${hasPendingCoach    ? '<span class="user-flag coach-req">coach req</span>'    : ''}
          ${hasPendingProvider ? '<span class="user-flag provider-req">host req</span>'  : ''}
          ${hasPendingAdmin    ? '<span class="user-flag admin-req">admin req</span>'    : ''}
        </div>
        <div class="user-meta">${esc(u.email || '')}${genderSym ? ` · ${genderSym}` : ''}${posStr ? ` · ${posStr}` : ''}${joined ? ` · joined ${joined}` : ''}</div>
      </div>
      ${rolePills}
    </div>`;
}

async function grantRole(btn, uid, role) {
  if (!_isAdmin) return;
  if ((role === 'admin' || role === 'owner') && !_isOwner) {
    showToast('Only sudo users can grant admin or sudo roles.', 'error'); return;
  }
  const label   = _userDisplayNames[uid] || uid;
  const roleStr = role === 'owner' ? 'Sudo' : role.charAt(0).toUpperCase() + role.slice(1);
  if (!confirm(`Grant ${roleStr} role to ${label}?`)) return;
  const restore = _setBtnLoading(btn);
  try {
    await callFn('updateUserRole', { uid, role, action: 'add' });
    _refreshAfterRoleAction(uid);
  } catch(e) {
    restore();
    console.error('Grant role failed:', e);
    showToast(e.code === 'permission-denied' ? 'Only sudo users can grant admin or sudo roles.' : 'Couldn\'t grant role. Try again.', 'error');
  }
}

async function revokeRole(btn, uid, role) {
  if (!_isAdmin) return;
  if ((role === 'admin' || role === 'owner') && !_isOwner) {
    showToast('Only sudo users can revoke admin or sudo roles.', 'error'); return;
  }
  const label   = _userDisplayNames[uid] || uid;
  const roleStr = role === 'owner' ? 'Sudo' : role.charAt(0).toUpperCase() + role.slice(1);
  if (!confirm(`Revoke ${roleStr} role from ${label}?`)) return;
  const restore = _setBtnLoading(btn);
  try {
    await callFn('updateUserRole', { uid, role, action: 'remove' });
    _refreshAfterRoleAction(uid);
  } catch(e) {
    restore();
    console.error('Revoke role failed:', e);
    showToast(e.code === 'permission-denied' ? 'Only sudo users can revoke admin or sudo roles.' : 'Couldn\'t revoke role. Try again.', 'error');
  }
}

async function toggleRole(btn, uid, role) {
  if (!_isAdmin) return;
  if ((role === 'admin' || role === 'owner') && !_isOwner) {
    showToast('Only sudo users can change admin or sudo roles.', 'error'); return;
  }
  try {
    const doc      = await _userRef(uid).get();
    const roles    = doc.data()?.roles || ['player'];
    const isAdding = !roles.includes(role);
    return isAdding ? grantRole(btn, uid, role) : revokeRole(btn, uid, role);
  } catch(e) {
    showToast('Couldn\'t update role. Try again.', 'error');
  }
}

async function nominateForAdmin(btn, uid) {
  if (!_isAdmin) return;
  const label = _userDisplayNames[uid] || uid;
  if (!confirm(`Nominate ${label} for Admin? A sudo user will be asked to approve.`)) return;
  const restore = _setBtnLoading(btn);
  try {
    await _userRef(uid).update({ adminRequest: true });
    await callFn('notifyAdminRequest', { uid, name: label });
    showToast('Nomination sent — sudo users have been notified.');
    renderUsers();
  } catch(e) {
    restore();
    showToast('Couldn\'t send nomination. Try again.', 'error');
  }
}

async function approveAdmin(btn, uid) {
  if (!_isOwner) return;
  const label = _userDisplayNames[uid] || uid;
  if (!confirm(`Approve ${label} as Admin?`)) return;
  const restore = _setBtnLoading(btn);
  try {
    await callFn('updateUserRole', { uid, role: 'admin', action: 'add' });
    await _userRef(uid).update({ adminRequest: false });
    showToast('Admin approved.');
    renderUsers();
  } catch(e) { restore(); showToast('Couldn\'t approve. Try again.', 'error'); }
}

async function rejectAdmin(btn, uid) {
  if (!_isOwner) return;
  if (!confirm('Reject this admin nomination?')) return;
  const restore = _setBtnLoading(btn);
  try {
    await _userRef(uid).update({ adminRequest: false });
    showToast('Nomination rejected.');
    renderUsers();
  } catch(e) { restore(); showToast('Couldn\'t reject. Try again.', 'error'); }
}

function _refreshAfterRoleAction(uid) {
  const activeId = document.querySelector('.screen.active')?.id;
  if (activeId === 'screen-profile') openProfileScreen(uid);
  else renderUsers();
}

function _setBtnLoading(btn) {
  if (!btn) return () => {};
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '…';
  return () => { btn.disabled = false; btn.textContent = orig; };
}

async function approveCoach(btn, uid) {
  if (!_isAdmin) return;
  const label = _userDisplayNames[uid] || uid;
  if (!confirm(`Approve ${label} as Coach?`)) return;
  const restore = _setBtnLoading(btn);
  try {
    const doc  = await _userRef(uid).get();
    const data = doc.data() || {};
    if (!_isOpenRequest(data.coachRequest)) { restore(); showToast('Request is no longer open.', 'error'); return; }
    await callFn('updateUserRole', { uid, role: 'coach', action: 'add' });
    await _userRef(uid).update({ coachRequest: { ...data.coachRequest, ..._requestClosed('approved') } });
    callFn('notifyCoachRequestOutcome', { uid, approved: true }).catch(console.error);
    showToast('Coach approved.');
    _refreshAfterRoleAction(uid);
  } catch(e) { restore(); showToast('Couldn\'t approve. Try again.', 'error'); }
}

async function rejectCoach(btn, uid) {
  if (!_isAdmin) return;
  if (!confirm('Reject this coach request?')) return;
  const restore = _setBtnLoading(btn);
  try {
    const doc  = await _userRef(uid).get();
    const req  = doc.data()?.coachRequest;
    if (!_isOpenRequest(req)) { restore(); showToast('Request is no longer open.', 'error'); return; }
    await _userRef(uid).update({ coachRequest: { ...req, ..._requestClosed('declined') } });
    callFn('notifyCoachRequestOutcome', { uid, approved: false }).catch(console.error);
    showToast('Coach request rejected.');
    _refreshAfterRoleAction(uid);
  } catch(e) { restore(); showToast('Couldn\'t reject. Try again.', 'error'); }
}

async function approveProvider(btn, uid) {
  if (!_isAdmin) return;
  const label = _userDisplayNames[uid] || uid;
  if (!confirm(`Approve ${label} as a host?`)) return;
  const restore = _setBtnLoading(btn);
  try {
    const doc  = await _userRef(uid).get();
    const data = doc.data() || {};
    if (!_isOpenRequest(data.providerRequest)) { restore(); showToast('Request is no longer open.', 'error'); return; }
    await callFn('updateUserRole', { uid, role: 'provider', action: 'add' });
    await _userRef(uid).update({ providerRequest: { ...data.providerRequest, ..._requestClosed('approved') } });
    callFn('notifyHostRequestOutcome', { uid, approved: true }).catch(console.error);
    showToast('Host approved.');
    _refreshAfterRoleAction(uid);
  } catch(e) { restore(); showToast('Couldn\'t approve. Try again.', 'error'); }
}

async function rejectProvider(btn, uid) {
  if (!_isAdmin) return;
  if (!confirm('Reject this host request?')) return;
  const restore = _setBtnLoading(btn);
  try {
    const doc  = await _userRef(uid).get();
    const req  = doc.data()?.providerRequest;
    if (!_isOpenRequest(req)) { restore(); showToast('Request is no longer open.', 'error'); return; }
    await _userRef(uid).update({ providerRequest: { ...req, ..._requestClosed('declined') } });
    callFn('notifyHostRequestOutcome', { uid, approved: false }).catch(console.error);
    showToast('Host request rejected.');
    _refreshAfterRoleAction(uid);
  } catch(e) { restore(); showToast('Couldn\'t reject. Try again.', 'error'); }
}

async function banUser(uid) {
  if (!_isAdmin) return;
  const name = _userDisplayNames[uid] || 'this user';
  if (!confirm(`Remove ${name}? This will permanently delete their account.`)) return;
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
    const isOwn  = _currentUser && targetUid === _currentUser.uid;
    // Self and admins see the full user doc; others see only public fields.
    const docRef = isOwn || _isAdmin ? _userRef(targetUid) : getDb().collection('publicProfiles').doc(targetUid);
    const doc    = await docRef.get();
    const u      = doc.exists ? { id: doc.id, ...doc.data() } : {};
    const roles  = u.roles || ['player'];
    const hasOwner           = roles.includes('owner');
    const hasAdmin           = roles.includes('admin');
    const hasCoach           = roles.includes('coach');
    const hasProvider        = roles.includes('provider');
    const hasPending         = _isOpenRequest(u.coachRequest) && !hasCoach;
    const hasPendingProvider = _isOpenRequest(u.providerRequest) && !hasProvider;

    if (isOwn) _setTitle('Your profile');

    const posLabels   = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };
    const genderLabel = { man: 'Man', woman: 'Woman', nonbinary: 'Non-binary' }[u.gender] || '';
    const levelLabel  = { beginner: 'Beginner', improver: 'Intermediate', intermediate: 'Advanced', advanced: 'Competitive', competitive: 'Elite' }[u.level] || '';
    const initials    = (u.name || u.email || '?')[0].toUpperCase();
    const roleOrder   = ['owner', 'admin', 'provider', 'coach'];
    const displayRoles = roleOrder.filter(r => roles.includes(r));

    const roleLabel = { owner: 'sudo', admin: 'admin', provider: 'host', coach: 'coach' };
    const roleBadges = displayRoles.map(r => {
      const cls = r === 'owner'    ? 'level owner-badge-lg'
                : r === 'admin'    ? 'level admin-badge-lg'
                : r === 'provider' ? 'level provider-badge-lg'
                : r === 'coach'    ? 'level coach-badge-lg'
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

    // Player section — everyone is a player, but only render if there's something to show
    const playerSection = (metaRows || u.bio) ? `
      <div class="detail-section">
        <div class="detail-section-title">Player</div>
        ${u.bio ? `<div class="detail-description" style="margin-bottom:10px">${esc(u.bio)}</div>` : ''}
        ${metaRows ? `<div class="detail-meta-grid">${metaRows}</div>` : ''}
      </div>` : '';

    const _roleCheck  = `<span class="role-status-active">Active</span>`;
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
                ? `<div style="display:flex;align-items:center;gap:8px"><span class="role-status-pending">Pending</span><button class="role-status-btn" onclick="cancelCoachRequest()">Cancel</button></div>`
                : `<button class="role-status-btn" id="coach-request-view-btn" onclick="requestCoachStatusFromView()">Request →</button>`}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Host</span>
            ${hasProvider
              ? _roleCheck
              : hasPendingProvider
                ? `<div style="display:flex;align-items:center;gap:8px"><span class="role-status-pending">Pending</span><button class="role-status-btn" onclick="cancelProviderRequest()">Cancel</button></div>`
                : `<button class="role-status-btn" id="provider-request-view-btn" onclick="requestProviderStatusFromView()">Request →</button>`}
          </div>
          <div class="role-status-row role-status-row--dim">
            <span class="role-status-name">Admin</span>
            ${roles.includes('admin') || roles.includes('owner') ? _roleCheck : ''}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Photo consent</span>
            ${u.photoConsent?.given
              ? `<div style="display:flex;align-items:center;gap:8px"><span class="role-status-active">Given</span><button class="role-status-btn" onclick="withdrawPhotoConsent()">Withdraw</button></div>`
              : u.photoConsent?.given === false
                ? `<div style="display:flex;align-items:center;gap:8px"><span class="role-status-locked">Declined</span><button class="role-status-btn" onclick="_showPhotoConsentModal(null)">Give consent →</button></div>`
                : `<button class="role-status-btn" onclick="_showPhotoConsentModal(null)">Decide →</button>`}
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
    const hasPendingAdmin = !!u.adminRequest && !roles.includes('admin');

    const _grantRevoke = (role, hasRole, cls) =>
      `<button class="role-action-${hasRole ? 'revoke' : 'grant'} ${cls}" data-uid="${esc(targetUid)}" data-role="${role}"
         onclick="${hasRole ? 'revokeRole' : 'grantRole'}(this,this.dataset.uid,this.dataset.role)">${hasRole ? 'Revoke' : 'Grant'}</button>`;

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
            ${hasPending ? `
              <div class="role-action-btns">
                <button class="role-action-approve" data-uid="${esc(targetUid)}" onclick="approveCoach(this,this.dataset.uid)">Approve</button>
                <button class="role-action-reject"  data-uid="${esc(targetUid)}" onclick="rejectCoach(this,this.dataset.uid)">Reject</button>
              </div>`
            : `<div class="role-action-btns">${hasCoach ? _activeTag : ''}
                 ${_grantRevoke('coach', hasCoach, 'coach')}
               </div>`}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Host</span>
            ${hasPendingProvider ? `
              <div class="role-action-btns">
                <button class="role-action-approve" data-uid="${esc(targetUid)}" onclick="approveProvider(this,this.dataset.uid)">Approve</button>
                <button class="role-action-reject"  data-uid="${esc(targetUid)}" onclick="rejectProvider(this,this.dataset.uid)">Reject</button>
              </div>`
            : `<div class="role-action-btns">${hasProvider ? _activeTag : ''}
                 ${_grantRevoke('provider', hasProvider, 'provider')}
               </div>`}
          </div>
          <div class="role-status-row">
            <span class="role-status-name">Admin</span>
            ${hasPendingAdmin && _isOwner ? `
              <div class="role-action-btns">
                <button class="role-action-approve" data-uid="${esc(targetUid)}" onclick="approveAdmin(this,this.dataset.uid)">Approve</button>
                <button class="role-action-reject"  data-uid="${esc(targetUid)}" onclick="rejectAdmin(this,this.dataset.uid)">Reject</button>
              </div>`
            : _isOwner ? `
              <div class="role-action-btns">${hasAdmin ? _activeTag : ''}
                ${_grantRevoke('admin', hasAdmin, 'admin')}
              </div>`
            : hasPendingAdmin ? `<span class="role-status-pending">Pending</span>`
            : hasAdmin ? _activeTag
            : ''}
          </div>
          ${_isOwner && !hasOwner ? `
          <div class="role-status-row">
            <span class="role-status-name">Sudo</span>
            <div class="role-action-btns">
              ${_grantRevoke('owner', false, 'owner')}
            </div>
          </div>` : _isOwner && hasOwner ? `
          <div class="role-status-row">
            <span class="role-status-name">Sudo</span>
            ${_activeTag}
          </div>` : ''}
        </div>
        ${_isOwner && !hasOwner ? `
        <button class="role-action-revoke" style="margin-top:12px;width:100%" data-uid="${esc(targetUid)}" onclick="banUser(this.dataset.uid)">Remove user</button>` : ''}
      </div>` : '';

    const showHistory = isOwn || _isAdmin;
    const showCoach   = (hasCoach || roles.includes('admin') || roles.includes('owner')) && _isAdmin;
    // Show incoming booking requests to the coach on their own profile
    const showCoachBookings  = isOwn && _isCoach;
    // Show player's outgoing booking requests on their own profile
    const showPlayerBookings = isOwn && _currentUser;

    // Fetch all data in parallel: coach sessions, all series docs, all session docs, upcoming clinics, bookings
    const todayTs = firebase.firestore.Timestamp.fromDate(new Date(new Date().setHours(0,0,0,0)));
    const [coachSessionsSnap, allSeriesSnap, allSessionsSnap, upcomingClinicsSnap, coachBookingsSnap, playerBookingsSnap] = await Promise.all([
      showCoach
        ? _sessionsRef().where('coachUid', '==', targetUid).where('status', '==', 'closed').orderBy('date', 'desc').limit(25).get().catch(() => null)
        : Promise.resolve(null),
      showHistory
        ? _seriesColRef().orderBy('name').get().catch(() => null)
        : Promise.resolve(null),
      showHistory
        ? _sessionsRef().orderBy('date', 'asc').get().catch(() => null)
        : Promise.resolve(null),
      hasCoach
        ? _sessionsRef().where('coachUid', '==', targetUid).where('date', '>=', todayTs).orderBy('date', 'asc').limit(3).get().catch(() => null)
        : Promise.resolve(null),
      showCoachBookings
        ? getDb().collection('coachBookings').where('coachUid', '==', targetUid).where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(20).get().catch(() => null)
        : Promise.resolve(null),
      showPlayerBookings
        ? getDb().collection('coachBookings').where('playerUid', '==', _currentUser.uid).orderBy('createdAt', 'desc').limit(10).get().catch(() => null)
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
        <div class="detail-section-title">Passes</div>
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
            : '<div class="empty-note">No passes yet.</div>'
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
      const costStr = a.seriesId ? 'Pass'
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

    // ── Coach public section ─────────────────────────────────────────────────
    const _posLabel  = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };
    const _lvlLabel  = { beginner: 'Beginner', improver: 'Improver', intermediate: 'Intermediate', advanced: 'Advanced', competitive: 'Competitive' };
    const _availPeriodLabel = { am: 'morning', pm: 'afternoon', eve: 'evening' };
    const _availDayLabel    = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
    const coachProfileSection = hasCoach ? (() => {
      const bio        = u.coachBio;
      const posMeta    = (u.coachPositions || []).map(p => _posLabel[p] || p).join(', ');
      const lvlMeta    = (u.coachLevels    || []).map(l => _lvlLabel[l] || l).join(', ');
      const styleMeta  = (u.coachStyles    || []).join(', ');
      const rateLine   = u.coach1to1Enabled
        ? (u.coachRate != null ? `£${u.coachRate}/hr · Available for 1-1 sessions` : 'Available for 1-1 sessions')
        : '';
      const availSlots = (u.coachAvailability || []);
      const availMeta  = availSlots.length
        ? availSlots.map(s => {
            const [day, period] = s.split('-');
            return `${_availDayLabel[day] || day} ${_availPeriodLabel[period] || period}`;
          }).join(' · ')
        : '';
      const clinicRows = upcomingClinicsSnap?.docs.map(d => {
        const s = d.data();
        return `<div class="history-row clickable-row" onclick="openSession('${d.id}')">
          <span class="history-date">${_formatDate(s.date)}${s.time ? ` · ${s.time}` : ''}</span>
          <span class="history-venue">${esc(s.venue || '—')}</span>
          <span class="history-cost">${s.type ? esc(s.type) : 'Clinic'}</span>
        </div>`;
      }) || [];
      return `
        <div class="detail-section coach-section">
          <div class="detail-section-title">Coach</div>
          ${bio ? `<div class="detail-description">${esc(bio)}</div>` : ''}
          <div class="detail-meta-grid">
            ${posMeta    ? `<div class="detail-meta-row"><span class="detail-meta-label">Positions</span><span>${esc(posMeta)}</span></div>` : ''}
            ${lvlMeta    ? `<div class="detail-meta-row"><span class="detail-meta-label">Levels</span><span>${esc(lvlMeta)}</span></div>` : ''}
            ${styleMeta  ? `<div class="detail-meta-row"><span class="detail-meta-label">Style</span><span>${esc(styleMeta)}</span></div>` : ''}
            ${rateLine   ? `<div class="detail-meta-row"><span class="detail-meta-label">1-1</span><span>${esc(rateLine)}</span></div>` : ''}
            ${availMeta  ? `<div class="detail-meta-row"><span class="detail-meta-label">Availability</span><span>${esc(availMeta)}</span></div>` : ''}
          </div>
          ${clinicRows.length ? `
            <div class="detail-section-title" style="margin-top:4px">Upcoming clinics</div>
            <div class="profile-history-list">${clinicRows.join('')}</div>
          ` : ''}
        </div>`;
    })() : '';

    // ── Book a 1-1 button (player viewing another coach's profile) ──────────────
    const showBook1to1 = u.coach1to1Enabled && _currentUser && targetUid !== _currentUser.uid;
    const book1to1Btn  = showBook1to1
      ? `<div class="profile-actions">
           <button class="cta-btn" onclick="openBookingForm('${esc(targetUid)}', ${JSON.stringify({ name: u.name || '', rate: u.coachRate ?? null, coachAvailability: u.coachAvailability || [] })})">Book a 1-1${u.coachRate != null ? ` · £${u.coachRate}/hr` : ''}</button>
         </div>`
      : '';

    // ── Coach: incoming booking requests ────────────────────────────────────────
    const _slotLabel = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
    const _fmtLabel  = { 'in-person': 'In person', 'video': 'Video call' };
    const coachBookingRows = coachBookingsSnap?.docs.map(d => {
      const b   = d.data();
      const bid = d.id;
      const meta = [b.date, _slotLabel[b.timeSlot] || b.timeSlot, `${b.duration} min`, _fmtLabel[b.format] || b.format].filter(Boolean).join(' · ');
      return `<div class="booking-request-card" id="bk-card-${esc(bid)}">
        <div><strong>${esc(b.playerName || '—')}</strong></div>
        <div class="booking-request-meta">${esc(meta)}</div>
        ${b.note ? `<div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">${esc(b.note)}</div>` : ''}
        <div class="booking-actions">
          <button class="cta-btn btn-accept cta-btn--sm" onclick="acceptBooking('${esc(bid)}', document.getElementById('bk-card-${esc(bid)}'))">Accept</button>
          <button class="cta-btn btn-decline cta-btn--sm" onclick="declineBooking('${esc(bid)}', document.getElementById('bk-card-${esc(bid)}'))">Decline</button>
        </div>
      </div>`;
    }) || [];
    const coachBookingsSection = showCoachBookings && coachBookingRows.length
      ? `<div class="detail-section">
           <div class="detail-section-title">Booking requests</div>
           ${coachBookingRows.join('')}
         </div>`
      : showCoachBookings
        ? `<div class="detail-section">
             <div class="detail-section-title">Booking requests</div>
             <div class="empty-note">No pending requests.</div>
           </div>`
        : '';

    // ── Player: outgoing booking requests ────────────────────────────────────────
    const playerBookingRows = playerBookingsSnap?.docs.map(d => {
      const b = d.data();
      const meta = [b.date, _slotLabel[b.timeSlot] || b.timeSlot, `${b.duration} min`, _fmtLabel[b.format] || b.format].filter(Boolean).join(' · ');
      const statusBadge = `<span class="booking-status-badge ${esc(b.status || 'pending')}">${b.status || 'pending'}</span>`;
      return `<div class="booking-request-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${esc(b.coachUid ? (_userDisplayNames[b.coachUid] || 'Coach') : '—')}</strong>
          ${statusBadge}
        </div>
        <div class="booking-request-meta">${esc(meta)}</div>
        ${b.note ? `<div style="font-size:13px;color:var(--text-dim)">${esc(b.note)}</div>` : ''}
      </div>`;
    }) || [];
    const playerBookingsSection = showPlayerBookings && playerBookingRows.length
      ? `<div class="detail-section">
           <div class="detail-section-title">My 1-1 requests</div>
           ${playerBookingRows.join('')}
         </div>`
      : '';

    body.innerHTML = `
      <div class="profile-screen-card">
        <div class="profile-hero">
          ${u.photoURL
            ? `<img class="profile-avatar-xl" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
            : `<div class="profile-avatar-xl profile-avatar-initials">${esc(initials)}</div>`}
          <div class="profile-hero-name">${esc(u.name || '—')}</div>
          ${roleBadges ? `<div class="profile-role-badges">${roleBadges}</div>` : ''}
        </div>
        ${playerSection}
        ${coachProfileSection}
        ${book1to1Btn}
        ${rolesSection}
        ${adminSection}
        ${ownActions}
        ${coachBookingsSection}
        ${coachPaySection}
        ${playerBookingsSection}
        ${seriesPassSection}
        ${sessionsSection}
      </div>`;
  } catch(e) {
    console.error('Load profile failed:', e);
    body.innerHTML = '<div class="home-empty">Couldn\'t load profile.</div>';
  }
}

// ─── 1-1 Booking overlay ──────────────────────────────────────────────────────
function openBookingForm(coachUid, coachData) {
  if (!_currentUser) { showToast('Sign in to book a session.', 'error'); return; }
  _bookingCoach = { uid: coachUid, ...coachData };

  // Set minimum date to today
  const today = new Date().toISOString().slice(0, 10);
  const dateEl = document.getElementById('bk-date');
  dateEl.min   = today;
  dateEl.value = '';

  // Reset form
  document.querySelector('input[name="bk-ts"][value="morning"]').checked = true;
  document.getElementById('bk-duration').value = '60';
  document.getElementById('bk-format').value   = 'in-person';
  document.getElementById('bk-note').value     = '';
  const errEl = document.getElementById('bk-error');
  errEl.style.display = 'none';
  errEl.textContent   = '';

  const btn = document.getElementById('bk-submit-btn');
  btn.disabled    = false;
  btn.textContent = 'Send request';

  document.getElementById('booking-overlay').classList.add('open');
}

function closeBookingForm() {
  document.getElementById('booking-overlay').classList.remove('open');
  _bookingCoach = null;
}

async function submitBookingRequest() {
  if (!_currentUser || !_bookingCoach) return;

  const dateVal = document.getElementById('bk-date').value;
  const errEl   = document.getElementById('bk-error');
  const btn     = document.getElementById('bk-submit-btn');

  errEl.style.display = 'none';
  errEl.textContent   = '';

  if (!dateVal) {
    errEl.textContent   = 'Please choose a preferred date.';
    errEl.style.display = '';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (dateVal < today) {
    errEl.textContent   = 'Date must be today or in the future.';
    errEl.style.display = '';
    return;
  }

  const timeSlot = document.querySelector('input[name="bk-ts"]:checked')?.value || 'morning';
  const duration = parseInt(document.getElementById('bk-duration').value, 10) || 60;
  const format   = document.getElementById('bk-format').value;
  const note     = document.getElementById('bk-note').value.trim();

  const playerName = _currentUserDoc?.name || _currentUser.displayName || _currentUser.email || '';

  const booking = {
    coachUid:   _bookingCoach.uid,
    playerUid:  _currentUser.uid,
    playerName,
    date:       dateVal,
    timeSlot,
    duration,
    format,
    note,
    rate:       _bookingCoach.rate ?? null,
    status:     'pending',
    createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
  };

  btn.disabled    = true;
  btn.textContent = 'Sending…';

  try {
    await getDb().collection('coachBookings').add(booking);
    closeBookingForm();
    showToast('Request sent! The coach will get back to you.');
  } catch (e) {
    console.error('submitBookingRequest failed:', e);
    errEl.textContent   = e.message || 'Couldn\'t send request. Please try again.';
    errEl.style.display = '';
    btn.disabled    = false;
    btn.textContent = 'Send request';
  }
}

// ── Coach: load incoming booking requests ────────────────────────────────────
// NOTE: This query requires a composite index on coachBookings:
//   coachUid ASC + status ASC + createdAt ASC
// Firebase will prompt with a link to create it automatically when first run in dev.
async function _loadCoachBookingRequests(coachUid) {
  const snap = await getDb().collection('coachBookings')
    .where('coachUid', '==', coachUid)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .limit(20)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function acceptBooking(bookingId, containerEl) {
  try {
    await getDb().collection('coachBookings').doc(bookingId).update({ status: 'accepted' });
    showToast('Booking accepted.');
    if (containerEl) containerEl.remove();
  } catch (e) {
    showToast('Couldn\'t accept booking. Try again.', 'error');
  }
}

async function declineBooking(bookingId, containerEl) {
  try {
    await getDb().collection('coachBookings').doc(bookingId).update({ status: 'declined' });
    showToast('Booking declined.');
    if (containerEl) containerEl.remove();
  } catch (e) {
    showToast('Couldn\'t decline booking. Try again.', 'error');
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

async function openSessionCreateInline() {
  if (!_canCreate() && !_canCreateClinic()) return;
  if (!_isAdmin && !_providerOnboardingComplete) {
    showToast('Set up payments in your profile before creating sessions.', 'error');
    return;
  }
  if (!_allVenues.length) await _loadVenues();
  if (_isAdmin && !_allSeries.length) await _loadSeries();

  _setNav('sub', null);
  showScreen('detail');
  _setTitle('New session');
  _setBack(() => goHome());

  const content = document.getElementById('detail-content');
  const footer  = document.getElementById('detail-footer');

  const venueOpts  = _venueSelectOpts(_activeSeriesFilter ? _currentSession?.venueId : null);
  const seriesOpts = '<option value="">None</option>' + _allSeries.map(sr =>
    `<option value="${sr.id}"${sr.id === (_activeSeriesFilter?.id || '') ? ' selected' : ''}>${esc(sr.name)}</option>`
  ).join('');

  content.innerHTML = `
    <div class="form-fields" style="padding-bottom:80px">
      <div class="field-row">
        <div class="field">
          <label class="field-label">Date</label>
          <input class="field-input" type="date" id="ie-date" />
        </div>
        <div class="field">
          <label class="field-label">Time</label>
          <input class="field-input" type="time" id="ie-time" />
        </div>
      </div>
      ${_isAdmin ? `
      <div class="field-row" id="ie-repeat-row">
        <div class="field">
          <label class="field-label">Repeat</label>
          <select class="field-input field-select" id="ie-repeat" onchange="_ieOnRepeatChange()">
            <option value="">No repeat</option>
            <option value="weekly">Every week</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Every month</option>
          </select>
        </div>
      </div>
      <div class="field-row" id="ie-repeat-end-row" style="display:none">
        <div class="field">
          <label class="field-label">End</label>
          <select class="field-input field-select" id="ie-repeat-end-type" onchange="_ieOnRepeatEndTypeChange()">
            <option value="count">After N sessions</option>
            <option value="date">Until date</option>
          </select>
        </div>
        <div class="field" id="ie-repeat-count-wrap">
          <label class="field-label">Sessions</label>
          <input class="field-input" type="number" id="ie-repeat-count" min="2" max="52" value="4" inputmode="numeric" />
        </div>
        <div class="field" id="ie-repeat-date-wrap" style="display:none">
          <label class="field-label">Until</label>
          <input class="field-input" type="date" id="ie-repeat-until" />
        </div>
      </div>` : ''}
      <div class="field">
        <label class="field-label">Venue</label>
        <select class="field-input field-select" id="ie-venue" onchange="onVenueSelectChange(this)">${venueOpts}</select>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">Type</label>
          <select class="field-input field-select" id="ie-type">
            ${SESSION_TYPES.map(t => `<option value="${t.value}"${t.value==='game'?' selected':''}>${t.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label">Gender</label>
          <select class="field-input field-select" id="ie-gender">
            ${SESSION_GENDERS.map(g => `<option value="${g.value}"${g.value==='mixed'?' selected':''}>${g.label}</option>`).join('')}
          </select>
        </div>
      </div>
      ${_isAdmin ? `
      <div class="field">
        <label class="field-label">Pass <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">— optional</span></label>
        <select class="field-input field-select" id="ie-series">${seriesOpts}</select>
      </div>` : ''}
      <div class="field">
        <label class="field-label">Description</label>
        <textarea class="field-input field-textarea" id="ie-description" placeholder="What to expect, skill level, what to bring…" maxlength="400"></textarea>
      </div>
      ${_isAdmin ? `
      <div class="field-row">
        <div class="field">
          <label class="field-label">Coach</label>
          <select class="field-input field-select" id="ie-coach-select" onchange="_ieOnCoachChange()">
            <option value="">None</option>
          </select>
          <input class="field-input" type="text" id="ie-coach-custom" placeholder="Coach name"
            maxlength="60" autocomplete="off" autocorrect="off" spellcheck="false"
            style="display:none;margin-top:6px" />
        </div>
        <div class="field">
          <label class="field-label">Level</label>
          <select class="field-input field-select" id="ie-level">
            <option value="">Any level</option>
            <option value="beginner">Beginner</option>
            <option value="improver">Intermediate</option>
            <option value="intermediate">Advanced</option>
            <option value="advanced">Competitive</option>
            <option value="competitive">Elite</option>
          </select>
        </div>
      </div>` : `
      <div class="field">
        <label class="field-label">Level</label>
        <select class="field-input field-select" id="ie-level">
          <option value="">Any level</option>
          <option value="beginner">Beginner</option>
          <option value="improver">Intermediate</option>
          <option value="intermediate">Advanced</option>
          <option value="advanced">Competitive</option>
          <option value="competitive">Elite</option>
        </select>
      </div>`}
      <div class="field-row">
        <div class="field">
          <label class="field-label">Max players</label>
          <input class="field-input" type="number" id="ie-max" min="1" max="100" inputmode="numeric" placeholder="12" oninput="_ieUpdatePosTotal()" />
        </div>
        <div class="field">
          <label class="field-label">Cost (£)</label>
          <input class="field-input" type="number" id="ie-cost" min="0" step="0.5" inputmode="decimal" placeholder="0" />
          ${_isAdmin ? `<label class="toggle-row" style="margin-top:6px">
            <input type="checkbox" id="ie-absorb-fee" />
            <span class="toggle-label-text">Waive booking fee</span>
          </label>` : ''}
        </div>
      </div>
      ${_isAdmin ? `
      <div class="field">
        <label class="field-label">Coach fee (£)</label>
        <input class="field-input" type="number" id="ie-coach-fee" min="0" step="0.5" inputmode="decimal" placeholder="50" />
        <div class="field-hint">Amount paid to the coach after the session closes.</div>
      </div>` : ''}
      <div class="field">
        <label class="field-label">Registration deadline</label>
        <input class="field-input" type="datetime-local" id="ie-deadline" />
      </div>
      <div class="field">
        <label class="toggle-row">
          <input type="checkbox" id="ie-ask-positions"
            onchange="document.getElementById('ie-pos-targets-field').style.display=this.checked?'':'none'" />
          <span class="toggle-label-text">Ask players for their position when registering</span>
        </label>
      </div>
      <div class="field" id="ie-pos-targets-field" style="display:none">
        <label class="field-label">Position targets <span class="field-hint">— leave blank for no limit</span></label>
        <div class="pos-targets-row">
          <label class="pos-target-item"><span class="pos-target-label">Setter</span><input class="field-input pos-target-input" type="number" id="ie-target-setter" min="0" max="99" placeholder="–" oninput="_ieUpdatePosTotal()"/></label>
          <label class="pos-target-item"><span class="pos-target-label">Hitter</span><input class="field-input pos-target-input" type="number" id="ie-target-hitter" min="0" max="99" placeholder="–" oninput="_ieUpdatePosTotal()"/></label>
          <label class="pos-target-item"><span class="pos-target-label">Middle</span><input class="field-input pos-target-input" type="number" id="ie-target-middle" min="0" max="99" placeholder="–" oninput="_ieUpdatePosTotal()"/></label>
          <label class="pos-target-item"><span class="pos-target-label">Libero</span><input class="field-input pos-target-input" type="number" id="ie-target-libero" min="0" max="99" placeholder="–" oninput="_ieUpdatePosTotal()"/></label>
        </div>
        <div class="pos-targets-total" id="ie-pos-total"></div>
      </div>
      ${!_isAdmin ? `
      <label class="form-insurance-label">
        <input type="checkbox" id="ie-insurance" />
        I confirm I hold valid public liability insurance for this session
      </label>` : ''}
      <div class="form-error" id="ie-error"></div>
    </div>`;

  footer.innerHTML = `
    <button class="cta-btn secondary-btn" onclick="goHome()">Cancel</button>
    <button class="cta-btn" id="ie-save-btn" onclick="_submitInlineCreate()">Create session</button>`;

  if (_isAdmin) await _ieLoadCoachOptions('', '');
}

async function openClinicCreateInline() {
  if (!_canCreateClinic()) return;
  await openSessionCreateInline();
  // Lock type to clinic for coaches who aren't admins
  const typeEl = document.getElementById('ie-type');
  if (typeEl && !_isAdmin) {
    typeEl.value = 'clinic';
    typeEl.disabled = true;
  }
  // Hide coach-related admin fields when the coach is the organiser
  const coachRow = document.getElementById('ie-coach-row');
  if (coachRow && _isCoach && !_isAdmin) coachRow.style.display = 'none';
}

function _ieUpdatePosTotal() {
  const totalEl = document.getElementById('ie-pos-total');
  if (!totalEl) return;
  const max = parseInt(document.getElementById('ie-max')?.value) || 0;
  let sum = 0;
  for (const p of ['setter','hitter','middle','libero']) {
    sum += parseInt(document.getElementById(`ie-target-${p}`)?.value) || 0;
  }
  if (sum === 0) { totalEl.textContent = ''; totalEl.className = 'pos-targets-total'; return; }
  const ok = max && sum === max;
  totalEl.textContent = ok ? `${sum} / ${max} ✓` : `${sum} / ${max || '?'} — must equal max players`;
  totalEl.className = 'pos-targets-total' + (ok ? ' pos-total-ok' : ' pos-total-err');
}

window._ieOnRepeatChange = function() {
  const repeat = document.getElementById('ie-repeat')?.value;
  const endRow = document.getElementById('ie-repeat-end-row');
  if (endRow) endRow.style.display = repeat ? '' : 'none';
};
window._ieOnRepeatEndTypeChange = function() {
  const type = document.getElementById('ie-repeat-end-type')?.value;
  const cw = document.getElementById('ie-repeat-count-wrap');
  const dw = document.getElementById('ie-repeat-date-wrap');
  if (cw) cw.style.display = type === 'count' ? '' : 'none';
  if (dw) dw.style.display = type === 'date'  ? '' : 'none';
};

window._submitInlineCreate = async function() {
  const errorEl = document.getElementById('ie-error');
  const saveBtn = document.getElementById('ie-save-btn');
  const dateVal = document.getElementById('ie-date').value;
  const venueId = document.getElementById('ie-venue').value;
  const maxVal  = parseInt(document.getElementById('ie-max').value);
  const insuranceEl = document.getElementById('ie-insurance');

  if (!dateVal)                    { errorEl.textContent = 'Please set a date.'; return; }
  if (!venueId)                    { errorEl.textContent = 'Please select a venue.'; return; }
  if (isNaN(maxVal) || maxVal < 1) { errorEl.textContent = 'Max players must be at least 1.'; return; }
  if (insuranceEl && !insuranceEl.checked) {
    errorEl.textContent = 'Please confirm you hold public liability insurance.'; return;
  }
  if (document.getElementById('ie-ask-positions')?.checked) {
    const posSum = ['setter','hitter','middle','libero'].reduce((s, p) => s + (parseInt(document.getElementById(`ie-target-${p}`)?.value) || 0), 0);
    if (posSum > 0 && posSum !== maxVal) { errorEl.textContent = `Position targets sum to ${posSum} but max players is ${maxVal} — they must match.`; return; }
  }

  errorEl.textContent = '';
  saveBtn.disabled = true;

  const venueObj    = _allVenues.find(v => v.id === venueId);
  const costVal     = parseFloat(document.getElementById('ie-cost').value) || 0;
  const absorbEl    = document.getElementById('ie-absorb-fee');
  const absorbFee   = absorbEl ? absorbEl.checked : false;
  const coachFeeEl  = document.getElementById('ie-coach-fee');
  const coachFee    = coachFeeEl ? (parseFloat(coachFeeEl.value) || 0) : 0;
  const askPos      = document.getElementById('ie-ask-positions').checked;
  const deadlineStr = document.getElementById('ie-deadline').value;
  const seriesSelEl = document.getElementById('ie-series');
  const seriesIdVal = seriesSelEl?.value || '';
  const seriesObj   = _allSeries.find(sr => sr.id === seriesIdVal);

  const coachSel    = _isAdmin ? (document.getElementById('ie-coach-select')?.value || '') : '';
  const coachUidVal = _isAdmin && coachSel && coachSel !== '__custom__' ? coachSel : '';
  const coachVal    = _isAdmin
    ? (coachSel === '__custom__'
        ? (document.getElementById('ie-coach-custom')?.value.trim() || '')
        : (coachSel ? (document.querySelector(`#ie-coach-select option[value="${coachSel}"]`)?.textContent || '') : ''))
    : '';

  const posTargets = (() => {
    if (!askPos) return null;
    const t = {};
    for (const p of ['setter','hitter','middle','libero']) {
      const v = parseInt(document.getElementById(`ie-target-${p}`)?.value);
      if (v > 0) t[p] = v;
    }
    return Object.keys(t).length ? t : null;
  })();

  const repeat     = _isAdmin ? (document.getElementById('ie-repeat')?.value || '') : '';
  const endType    = document.getElementById('ie-repeat-end-type')?.value || 'count';
  const endCount   = parseInt(document.getElementById('ie-repeat-count')?.value) || 4;
  const endDateStr = document.getElementById('ie-repeat-until')?.value || '';
  const dates      = repeat ? _expandDates(dateVal, repeat, endType, endCount, endDateStr) : [new Date(dateVal + 'T12:00:00')];

  if (dates.length === 0) { errorEl.textContent = 'Invalid repeat configuration.'; saveBtn.disabled = false; return; }

  // When a coach (not admin, not provider) creates a clinic/training, they are both
  // the organiser and the coach — set both providerUid and coachUid to their own uid.
  const _isCoachOnly = _isCoach && !_isAdmin && !_isProvider;
  const base = {
    time:                 document.getElementById('ie-time').value,
    venue:                venueObj?.name || '',
    venueId,
    coach:                _isCoachOnly ? (_currentUser.displayName || '') : coachVal,
    coachUid:             _isCoachOnly ? _currentUser.uid : coachUidVal,
    level:                document.getElementById('ie-level').value,
    type:                 document.getElementById('ie-type').value,
    gender:               document.getElementById('ie-gender').value,
    description:          document.getElementById('ie-description').value,
    maxPlayers:           maxVal,
    cost:                 costVal,
    coachFee,
    absorbFee,
    playerPrice:          absorbFee ? costVal : _playerPrice(costVal),
    providerUid:          _currentUser.uid,
    status:               'open',
    askPositions:         askPos,
    positionTargets:      posTargets,
    seriesId:             seriesIdVal || null,
    seriesName:           seriesObj?.name || '',
    attendeeCount:        0,
    registrationDeadline: deadlineStr ? firebase.firestore.Timestamp.fromDate(new Date(deadlineStr)) : null,
    ...(insuranceEl ? { insuranceDeclaredBy: _currentUser.uid, insuranceDeclaredAt: firebase.firestore.FieldValue.serverTimestamp() } : {}),
  };

  try {
    if (dates.length === 1) {
      const data = { ...base, date: firebase.firestore.Timestamp.fromDate(dates[0]), createdAt: firebase.firestore.FieldValue.serverTimestamp() };
      const ref  = await _sessionsRef().add(data);
      await openSession(ref.id);
    } else {
      const batch = firebase.firestore().batch();
      dates.forEach(d => {
        const ref = _sessionsRef().doc();
        batch.set(ref, { ...base, date: firebase.firestore.Timestamp.fromDate(d), createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      });
      await batch.commit();
      showToast(`${dates.length} sessions created.`);
      goHome();
    }
  } catch(e) {
    console.error('Create session failed:', e);
    errorEl.textContent = e.code === 'permission-denied' ? 'Permission denied.' : 'Save failed — try again.';
    saveBtn.disabled = false;
  }
};

async function openSessionEditInline(sessionId) {
  if (!_isAdmin && !_isProvider) return;
  const s = _currentSession;
  if (!s || s.id !== sessionId) { await openSession(sessionId); return; }
  if (!_allVenues.length) await _loadVenues();
  if (!_allSeries.length) await _loadSeries();

  const content = document.getElementById('detail-content');
  const footer  = document.getElementById('detail-footer');

  const dateVal = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : '';
  let deadlineVal = '';
  if (s.registrationDeadline) {
    const d = s.registrationDeadline.toDate ? s.registrationDeadline.toDate() : new Date(s.registrationDeadline);
    deadlineVal = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  const venueOpts = _venueSelectOpts(s.venueId);
  const seriesOpts = '<option value="">None</option>' + _allSeries.map(sr =>
    `<option value="${sr.id}"${sr.id === s.seriesId ? ' selected' : ''}>${esc(sr.name)}</option>`
  ).join('');
  const levelOpts = [['','Any level'],['beginner','Beginner'],['improver','Intermediate'],['intermediate','Advanced'],['advanced','Competitive'],['competitive','Elite']]
    .map(([v,l]) => `<option value="${v}"${(s.level||'')===v?' selected':''}>${l}</option>`).join('');
  const typeOpts  = SESSION_TYPES.map(t =>
    `<option value="${t.value}"${(s.type||'game')===t.value?' selected':''}>${t.label}</option>`).join('');
  const genderOpts = SESSION_GENDERS.map(g =>
    `<option value="${g.value}"${(s.gender||'mixed')===g.value?' selected':''}>${g.label}</option>`).join('');
  const statusOpts = [['open','Open'],['cancelled','Cancelled']]
    .map(([v,l]) => `<option value="${v}"${(s.status||'open')===v?' selected':''}>${l}</option>`).join('');

  const pt = s.positionTargets || {};
  const hasPos = !!s.askPositions;

  content.innerHTML = `
    <div class="form-fields" style="padding-bottom:80px">
      <div class="field-row">
        <div class="field">
          <label class="field-label">Date</label>
          <input class="field-input" type="date" id="ie-date" value="${dateVal}" />
        </div>
        <div class="field">
          <label class="field-label">Time</label>
          <input class="field-input" type="time" id="ie-time" value="${esc(s.time||'')}" />
        </div>
      </div>
      <div class="field">
        <label class="field-label">Venue</label>
        <select class="field-input field-select" id="ie-venue" onchange="onVenueSelectChange(this)">${venueOpts}</select>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">Type</label>
          <select class="field-input field-select" id="ie-type">${typeOpts}</select>
        </div>
        <div class="field">
          <label class="field-label">Gender</label>
          <select class="field-input field-select" id="ie-gender">${genderOpts}</select>
        </div>
      </div>
      <div class="field">
        <label class="field-label">Pass <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">— optional</span></label>
        <select class="field-input field-select" id="ie-series">${seriesOpts}</select>
      </div>
      <div class="field">
        <label class="field-label">Description</label>
        <textarea class="field-input field-textarea" id="ie-description" placeholder="What to expect, skill level, what to bring…" maxlength="400">${esc(s.description||'')}</textarea>
      </div>
      ${_isAdmin ? `
      <div class="field-row" id="ie-coach-field">
        <div class="field">
          <label class="field-label">Coach</label>
          <select class="field-input field-select" id="ie-coach-select" onchange="_ieOnCoachChange()">
            <option value="">None</option>
          </select>
          <input class="field-input" type="text" id="ie-coach-custom" placeholder="Coach name"
            maxlength="60" autocomplete="off" autocorrect="off" spellcheck="false"
            style="display:none;margin-top:6px" />
        </div>
        <div class="field">
          <label class="field-label">Level</label>
          <select class="field-input field-select" id="ie-level">${levelOpts}</select>
        </div>
      </div>` : `
      <div class="field">
        <label class="field-label">Level</label>
        <select class="field-input field-select" id="ie-level">${levelOpts}</select>
      </div>`}
      <div class="field-row">
        <div class="field">
          <label class="field-label">Max players</label>
          <input class="field-input" type="number" id="ie-max" min="1" max="100" inputmode="numeric" placeholder="12" value="${s.maxPlayers||''}" oninput="_ieUpdatePosTotal()" />
        </div>
        <div class="field">
          <label class="field-label">Cost (£)</label>
          <input class="field-input" type="number" id="ie-cost" min="0" step="0.5" inputmode="decimal" placeholder="0" value="${s.cost!=null?s.cost:''}"/>
          ${_isAdmin ? `<label class="toggle-row" style="margin-top:6px">
            <input type="checkbox" id="ie-absorb-fee"${s.absorbFee?' checked':''} />
            <span class="toggle-label-text">Waive booking fee</span>
          </label>` : ''}
        </div>
      </div>
      ${_isAdmin ? `
      <div class="field">
        <label class="field-label">Coach fee (£)</label>
        <input class="field-input" type="number" id="ie-coach-fee" min="0" step="0.5" inputmode="decimal" placeholder="50" value="${s.coachFee!=null?s.coachFee:''}" />
        <div class="field-hint">Amount paid to the coach after the session closes.</div>
      </div>` : ''}
      <div class="field">
        <label class="field-label">Registration deadline</label>
        <input class="field-input" type="datetime-local" id="ie-deadline" value="${deadlineVal}" />
      </div>
      <div class="field">
        <label class="toggle-row">
          <input type="checkbox" id="ie-ask-positions"${hasPos?' checked':''}
            onchange="document.getElementById('ie-pos-targets-field').style.display=this.checked?'':'none'" />
          <span class="toggle-label-text">Ask players for their position when registering</span>
        </label>
      </div>
      <div class="field" id="ie-pos-targets-field" style="display:${hasPos?'':'none'}">
        <label class="field-label">Position targets <span class="field-hint">— leave blank for no limit</span></label>
        <div class="pos-targets-row">
          <label class="pos-target-item"><span class="pos-target-label">Setter</span><input class="field-input pos-target-input" type="number" id="ie-target-setter" min="0" max="99" placeholder="–" value="${pt.setter||''}" oninput="_ieUpdatePosTotal()"/></label>
          <label class="pos-target-item"><span class="pos-target-label">Hitter</span><input class="field-input pos-target-input" type="number" id="ie-target-hitter" min="0" max="99" placeholder="–" value="${pt.hitter||''}" oninput="_ieUpdatePosTotal()"/></label>
          <label class="pos-target-item"><span class="pos-target-label">Middle</span><input class="field-input pos-target-input" type="number" id="ie-target-middle" min="0" max="99" placeholder="–" value="${pt.middle||''}" oninput="_ieUpdatePosTotal()"/></label>
          <label class="pos-target-item"><span class="pos-target-label">Libero</span><input class="field-input pos-target-input" type="number" id="ie-target-libero" min="0" max="99" placeholder="–" value="${pt.libero||''}" oninput="_ieUpdatePosTotal()"/></label>
        </div>
        <div class="pos-targets-total" id="ie-pos-total"></div>
      </div>
      ${_isAdmin ? `
      <div class="field">
        <label class="field-label">Status</label>
        <select class="field-input field-select" id="ie-status">${statusOpts}</select>
      </div>` : ''}
      <div class="form-error" id="ie-error"></div>
    </div>`;

  footer.innerHTML = `
    <button class="cta-btn secondary-btn" onclick="openSession('${sessionId}')">Cancel</button>
    <button class="cta-btn" id="ie-save-btn" onclick="_submitInlineEdit('${sessionId}')">Save changes</button>`;

  _ieUpdatePosTotal();
  if (_isAdmin) await _ieLoadCoachOptions(s.coach, s.coachUid);
}

async function _ieLoadCoachOptions(currentCoach, currentCoachUid) {
  const sel    = document.getElementById('ie-coach-select');
  const custom = document.getElementById('ie-coach-custom');
  if (!sel) return;
  try {
    const snap = await _usersRef().where('roles', 'array-contains', 'coach').get();
    snap.docs.forEach(d => {
      const name = d.data().name || d.data().email || '';
      if (!name) return;
      const opt = document.createElement('option');
      opt.value = d.id; opt.textContent = name;
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

window._ieOnCoachChange = function() {
  const sel    = document.getElementById('ie-coach-select');
  const custom = document.getElementById('ie-coach-custom');
  const isCustom = sel.value === '__custom__';
  custom.style.display = isCustom ? '' : 'none';
  if (isCustom) custom.focus();
};

window._submitInlineEdit = async function(sessionId) {
  const errorEl = document.getElementById('ie-error');
  const saveBtn = document.getElementById('ie-save-btn');
  const dateVal = document.getElementById('ie-date').value;
  const venueId = document.getElementById('ie-venue').value;
  const maxVal  = parseInt(document.getElementById('ie-max').value);

  if (!dateVal)                    { errorEl.textContent = 'Please set a date.'; return; }
  if (!venueId)                    { errorEl.textContent = 'Please select a venue.'; return; }
  if (isNaN(maxVal) || maxVal < 1) { errorEl.textContent = 'Max players must be at least 1.'; return; }
  const currentCount = _currentSession?.attendeeCount || 0;
  if (maxVal < currentCount) {
    const over = currentCount - maxVal;
    if (!confirm(
      `⚠️ ${currentCount} players are already registered and will still show up.\n\n` +
      `Reducing max to ${maxVal} does NOT remove anyone or issue refunds — all ${currentCount} people remain registered and will attend.\n\n` +
      `You will be ${over} player${over > 1 ? 's' : ''} over capacity. Continue?`
    )) return;
  }
  if (document.getElementById('ie-ask-positions')?.checked) {
    const posSum = ['setter','hitter','middle','libero'].reduce((s, p) => s + (parseInt(document.getElementById(`ie-target-${p}`)?.value) || 0), 0);
    if (posSum > 0 && posSum !== maxVal) { errorEl.textContent = `Position targets sum to ${posSum} but max players is ${maxVal} — they must match.`; return; }
  }
  const descLinkErr = _descriptionLinkError(document.getElementById('ie-description').value);
  if (descLinkErr) { errorEl.textContent = descLinkErr; return; }

  errorEl.textContent = '';
  saveBtn.disabled = true;

  const venueObj    = _allVenues.find(v => v.id === venueId);
  const costVal     = parseFloat(document.getElementById('ie-cost').value) || 0;
  const absorbEl    = document.getElementById('ie-absorb-fee');
  const absorbFee   = absorbEl ? absorbEl.checked : (!!_currentSession?.absorbFee);
  const coachFeeEl  = document.getElementById('ie-coach-fee');
  const coachFee    = coachFeeEl ? (parseFloat(coachFeeEl.value) || 0) : (_currentSession?.coachFee || 0);
  const askPos      = document.getElementById('ie-ask-positions').checked;
  const deadlineStr = document.getElementById('ie-deadline').value;
  const seriesSelEl = document.getElementById('ie-series');
  const seriesIdVal = seriesSelEl?.value || '';
  const seriesObj   = _allSeries.find(sr => sr.id === seriesIdVal);

  const coachSel    = _isAdmin ? (document.getElementById('ie-coach-select')?.value || '') : '';
  const coachUidVal = _isAdmin && coachSel && coachSel !== '__custom__' ? coachSel : '';
  const coachVal    = _isAdmin
    ? (coachSel === '__custom__'
        ? (document.getElementById('ie-coach-custom')?.value.trim() || '')
        : (coachSel ? (document.querySelector(`#ie-coach-select option[value="${coachSel}"]`)?.textContent || '') : ''))
    : '';

  const posTargets = (() => {
    if (!askPos) return null;
    const t = {};
    for (const p of ['setter','hitter','middle','libero']) {
      const v = parseInt(document.getElementById(`ie-target-${p}`)?.value);
      if (v > 0) t[p] = v;
    }
    return Object.keys(t).length ? t : null;
  })();

  const data = {
    date:                 firebase.firestore.Timestamp.fromDate(new Date(dateVal + 'T12:00:00')),
    time:                 document.getElementById('ie-time').value,
    venue:                venueObj?.name || '',
    venueId,
    coach:                coachVal,
    coachUid:             coachUidVal,
    level:                document.getElementById('ie-level').value,
    type:                 document.getElementById('ie-type').value,
    gender:               document.getElementById('ie-gender').value,
    description:          document.getElementById('ie-description').value,
    maxPlayers:           maxVal,
    cost:                 costVal,
    coachFee,
    absorbFee,
    playerPrice:          absorbFee ? costVal : _playerPrice(costVal),
    status:               _isAdmin ? (document.getElementById('ie-status')?.value || 'open') : (_currentSession?.status || 'open'),
    askPositions:         askPos,
    positionTargets:      posTargets,
    seriesId:             seriesIdVal || null,
    seriesName:           seriesObj?.name || '',
    registrationDeadline: deadlineStr
      ? firebase.firestore.Timestamp.fromDate(new Date(deadlineStr))
      : null,
  };

  try {
    await _sessionRef(sessionId).update(data);
    await openSession(sessionId);
  } catch(e) {
    console.error('Save session failed:', e);
    errorEl.textContent = e.code === 'permission-denied' ? 'Permission denied.' : 'Save failed — try again.';
    saveBtn.disabled = false;
  }
};

// ─── Delete session ────────────────────────────────────────────────────────────
async function cancelSession(id) {
  if (!_isAdmin) return;
  if (!confirm('Cancel this session?\n\nAttendees will be notified by email.')) return;
  try {
    await _sessionRef(id).update({ status: 'cancelled' });
    await openSession(id);
  } catch(e) {
    console.error('Cancel session failed:', e);
    showToast('Couldn\'t cancel session. Try again.', 'error');
  }
}

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
  _setBack(() => history.back());
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
  _setBack(() => history.back());
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
  const levelLabels = { beginner: 'Beginner', improver: 'Intermediate', intermediate: 'Advanced', advanced: 'Competitive', competitive: 'Elite' };

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
  // Prefix formula-injection triggers so spreadsheets don't execute them.
  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return `"${(/^[=+\-@\t\r]/.test(s) ? '\'' + s : s).replace(/"/g, '""')}"`;
  };
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
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
    _setBack(() => history.back());
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

// ─── Availability grid ────────────────────────────────────────────────────────
function _renderAvailGrid(selectedSlots) {
  const days    = ['mon','tue','wed','thu','fri','sat','sun'];
  const dayLabels = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };
  const periods = [['am','Morning'],['pm','Afternoon'],['eve','Evening']];
  const sel     = new Set(selectedSlots || []);
  const grid    = document.getElementById('pf-avail-grid');
  if (!grid) return;

  // Header row: empty label cell + period headers
  let html = `<div class="avail-day-label"></div>`;
  for (const [, label] of periods) {
    html += `<div class="avail-day-label" style="justify-content:center;font-weight:600">${label}</div>`;
  }

  // One row per day
  for (const day of days) {
    html += `<div class="avail-day-label">${dayLabels[day]}</div>`;
    for (const [period] of periods) {
      const slot = `${day}-${period}`;
      const active = sel.has(slot) ? ' active' : '';
      html += `<button type="button" class="avail-slot${active}" data-slot="${slot}" onclick="this.classList.toggle('active')">${periods.find(p=>p[0]===period)[1]}</button>`;
    }
  }

  grid.innerHTML = html;
}

// ─── Edit profile overlay ──────────────────────────────────────────────────────
async function openEditProfile() {
  if (!_currentUser) return;
  const errorEl = document.getElementById('edit-profile-error');
  errorEl.textContent = '';
  const saveBtn = document.getElementById('edit-profile-save-btn');
  if (saveBtn) saveBtn.disabled = false;

  try {
    const doc  = await _userRef(_currentUser.uid).get();
    const data = doc.data() || {};
    document.getElementById('edit-profile-name').value    = data.name || _currentUser.displayName || '';
    document.getElementById('edit-profile-gender').value  = data.gender || '';
    document.getElementById('edit-profile-level').value   = data.level  || '';
    document.getElementById('edit-profile-bio').value     = data.bio   || '';
    const posSet = new Set(data.positions || []);
    document.querySelectorAll('#edit-profile-positions input').forEach(cb => {
      cb.checked = posSet.has(cb.value);
    });
    _updateCoachRequestBtn(data);
    const stripeField = document.getElementById('provider-stripe-field');
    if (stripeField) {
      const isProvider   = (data.roles || []).includes('provider');
      const needsStripe  = isProvider && !data.providerOnboardingComplete;
      stripeField.style.display = needsStripe ? '' : 'none';
    }
    // Coach profile section — show only when user has coach role
    const coachSection = document.getElementById('coach-profile-section');
    if (coachSection) {
      const isCoach = (data.roles || []).includes('coach');
      coachSection.style.display = isCoach ? '' : 'none';
      if (isCoach) {
        document.getElementById('pf-coach-bio').value      = data.coachBio || '';
        document.getElementById('pf-coach-rate').value     = data.coachRate != null ? data.coachRate : '';
        document.getElementById('pf-coach-1to1').checked   = !!data.coach1to1Enabled;
        const coachPosSet   = new Set(data.coachPositions || []);
        const coachLvlSet   = new Set(data.coachLevels    || []);
        const coachStyleSet = new Set(data.coachStyles     || []);
        document.querySelectorAll('.pf-coach-pos').forEach(cb  => { cb.checked = coachPosSet.has(cb.value);   });
        document.querySelectorAll('.pf-coach-lvl').forEach(cb  => { cb.checked = coachLvlSet.has(cb.value);   });
        document.querySelectorAll('.pf-coach-style').forEach(cb => { cb.checked = coachStyleSet.has(cb.value); });
        _renderAvailGrid(data.coachAvailability || []);
      }
    }
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

  // Collect coach fields if coach section is visible
  const coachSection = document.getElementById('coach-profile-section');
  const coachVisible = coachSection && coachSection.style.display !== 'none';
  const coachData = coachVisible ? {
    coachBio:         document.getElementById('pf-coach-bio').value.trim() || null,
    coachPositions:   Array.from(document.querySelectorAll('.pf-coach-pos:checked')).map(el => el.value),
    coachLevels:      Array.from(document.querySelectorAll('.pf-coach-lvl:checked')).map(el => el.value),
    coachStyles:      Array.from(document.querySelectorAll('.pf-coach-style:checked')).map(el => el.value),
    coachRate:          document.getElementById('pf-coach-rate').value !== ''
                          ? Number(document.getElementById('pf-coach-rate').value)
                          : null,
    coach1to1Enabled:   document.getElementById('pf-coach-1to1').checked,
    coachAvailability:  Array.from(document.querySelectorAll('.avail-slot.active')).map(b => b.dataset.slot),
  } : {};

  const bio = document.getElementById('edit-profile-bio').value.trim() || null;

  try {
    await _userRef(_currentUser.uid).update({
      name,
      gender:    gender || null,
      level:     level  || null,
      positions,
      bio,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      ...coachData,
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
      coachRequest: _requestObj(),
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
      providerRequest: _requestObj(),
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
      coachRequest: _requestObj(),
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
      providerRequest: _requestObj(),
      updatedAt:       firebase.firestore.FieldValue.serverTimestamp(),
    });
    await callFn('notifyProviderRequest', { uid: _currentUser.uid, name: _currentUser.displayName || '' });
  } catch(e) {
    console.error('Provider request failed:', e);
    if (btn) { btn.textContent = 'Request →'; btn.disabled = false; }
    showToast('Request failed: ' + (e.message || 'unknown error'), 'error');
  }
}

async function cancelCoachRequest() {
  if (!_currentUser) return;
  try {
    await _userRef(_currentUser.uid).update({ coachRequest: _requestClosed('cancelled') });
    openProfileScreen(_currentUser.uid);
  } catch(e) {
    showToast('Couldn\'t cancel. Try again.', 'error');
  }
}

async function cancelProviderRequest() {
  if (!_currentUser) return;
  try {
    await _userRef(_currentUser.uid).update({ providerRequest: _requestClosed('cancelled') });
    openProfileScreen(_currentUser.uid);
  } catch(e) {
    showToast('Couldn\'t cancel. Try again.', 'error');
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
  const isPending = _isOpenRequest(data.coachRequest);
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
    return `<button class="filter-btn${active}" data-key="${esc(key)}" data-val="${esc(val)}" onclick="setInsightFilter(this.dataset.key,this.dataset.val)">${esc(val)}</button>`;
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

// ─── Level info ────────────────────────────────────────────────────────────────

const _LEVEL_INFO = [
  { key: 'beginner',     label: 'Beginner',     lva: 'Recreational',               desc: 'New to volleyball or just starting out. Learning the rules and basic technique. Focus on fun and development.' },
  { key: 'improver',     label: 'Intermediate', lva: 'Recreational',               desc: 'You play regularly and are comfortable on court. Understand basic rotations and can perform core skills with some consistency.' },
  { key: 'intermediate', label: 'Advanced',     lva: 'London League Div 2–3',      desc: 'Experienced club player. Comfortable with 3-touch play, rotations, and position-specific skills. May not have played on an organised team.' },
  { key: 'advanced',     label: 'Competitive',  lva: 'London League Div 1',        desc: 'Played on an organised team with coaching. Strong fundamentals, some advanced skills, and a clear positional role.' },
  { key: 'competitive',  label: 'Elite',        lva: 'Première · Superleague',     desc: 'College, club, semi-pro or international experience. High volleyball IQ and the ability to perform consistently under pressure.' },
];

window.openLevelInfo = function(activeLevel) {
  const existing = document.getElementById('level-info-overlay');
  if (existing) existing.remove();
  const rows = _LEVEL_INFO.map(l => `
    <div class="level-info-row${l.key === activeLevel ? ' active' : ''}">
      <div class="level-info-top">
        <span class="session-badge level level-${l.key}">${l.label}</span>
        <span class="level-info-lva">${l.lva}</span>
      </div>
      <div class="level-info-desc">${l.desc}</div>
    </div>`).join('');
  const el = document.createElement('div');
  el.id = 'level-info-overlay';
  el.className = 'overlay open';
  el.innerHTML = `
    <div class="panel" onclick="event.stopPropagation()">
      <div class="panel-header">
        <span class="panel-title">Levels</span>
        <button class="panel-close" onclick="document.getElementById('level-info-overlay').remove()">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;padding-top:16px">${rows}</div>
      <a href="levels.html" target="_blank" rel="noopener"
         style="display:block;margin-top:20px;font-size:13px;color:var(--amber);text-decoration:none">
        Full level guide ↗
      </a>
    </div>`;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
};

// ─── Venues ────────────────────────────────────────────────────────────────────

function _venuesRef() { return getDb().collection('venues'); }

let _allVenues      = [];   // cached list
let _editingVenueId = null;
let _venueFormMode  = 'admin'; // 'admin' | 'propose'

async function _loadVenues() {
  const snap  = await _venuesRef().orderBy('name').get();
  _allVenues  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _allVenues;
}

function _venueSelectOpts(selectedId) {
  const uid = _currentUser?.uid;
  const active  = _allVenues.filter(v => !v.status);
  const myPending = _allVenues.filter(v => v.status === 'pending' && v.proposedBy === uid);
  const opts = [
    '<option value="">Select a venue…</option>',
    ...active.map(v => `<option value="${v.id}"${v.id === selectedId ? ' selected' : ''}>${esc(v.name)}</option>`),
    ...myPending.map(v => `<option value="${v.id}"${v.id === selectedId ? ' selected' : ''}>${esc(v.name)} (pending approval)</option>`),
    _canCreate() ? '<option value="__propose__">+ Propose a new venue…</option>' : '',
  ];
  return opts.join('');
}

function _repopulateIeVenueSelect(selectedId) {
  const sel = document.getElementById('ie-venue');
  if (sel) sel.innerHTML = _venueSelectOpts(selectedId);
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
    const pending = _allVenues.filter(v => v.status === 'pending');
    const active  = _allVenues.filter(v => !v.status);
    const renderRow = v => {
      const initial = (v.name || '?')[0].toUpperCase();
      const meta    = [v.address, v.costPerHour > 0 ? `£${v.costPerHour}/hr` : '', v.contact].filter(Boolean).join(' · ');
      return `
      <div class="user-row" onclick="openVenueDetail('${v.id}')">
        <div class="user-avatar user-avatar--initials venue-avatar">${esc(initial)}</div>
        <div class="user-info">
          <div class="user-name">${esc(v.name)}${v.status === 'pending' ? ' <span class="venue-pending-badge">Pending</span>' : ''}</div>
          ${meta ? `<div class="user-meta">${esc(meta)}</div>` : ''}
        </div>
      </div>`;
    };
    list.innerHTML = [...pending, ...active].map(renderRow).join('');
  } catch(e) {
    list.innerHTML = '<div class="home-empty">Couldn\'t load venues.</div>';
    console.error(e);
  }
}

// ── Venue detail ──

async function openVenueDetail(id) {
  if (!_currentUser) return;
  if (!_allVenues.length) await _loadVenues();
  const v = _allVenues.find(x => x.id === id);
  if (!v) { if (_isAdmin) openVenuesScreen(); else goHome(); return; }
  _setHash(`venue/${id}`);
  showScreen('venue-detail');
  _setNav('sub', null);
  _setTitle(v.name);
  _setBack(() => history.back());
  renderVenueDetail(v);
}

function renderVenueDetail(v) {
  const content  = document.getElementById('venue-detail-content');
  const mapsUrl  = safeUrl(v.mapsUrl)
    || (v.address ? `https://www.google.com/maps/search/${encodeURIComponent(v.address)}` : null);
  const embedSrc = v.address
    ? `https://maps.google.com/maps?q=${encodeURIComponent(v.address)}&output=embed`
    : null;

  const row = (label, val) => `
    <div class="user-row" style="cursor:default">
      <div class="user-info"><div class="user-name">${label}</div></div>
      <div class="user-meta ${val ? '' : 'venue-missing'}">${val ? esc(val) : 'Missing'}</div>
    </div>`;

  const isPending = v.status === 'pending';
  content.innerHTML = `
    <div class="venue-detail-header">
      <div class="venue-detail-initial">${esc((v.name || '?')[0].toUpperCase())}</div>
      <div class="venue-detail-info">
        <div class="venue-detail-name">${esc(v.name)}${isPending ? ' <span class="venue-pending-badge">Pending</span>' : ''}</div>
        <div class="venue-detail-address ${v.address ? '' : 'venue-missing'}">${v.address ? esc(v.address) : 'No address'}</div>
      </div>
      ${_isAdmin ? `<button class="venue-edit-btn" onclick="openVenueForm('${v.id}')">Edit</button>` : ''}
    </div>

    ${_isAdmin && isPending ? `
    <div class="venue-approve-bar">
      <span class="venue-approve-info">Proposed by a host — review before making it available to all.</span>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="cta-btn" style="flex:1" onclick="approveVenue('${v.id}')">Approve</button>
        <button class="cta-btn secondary-btn" onclick="rejectVenue('${v.id}')">Reject</button>
      </div>
    </div>` : ''}

    <div class="venue-detail-section">
      ${row('Cost per hour', v.costPerHour > 0 ? `£${v.costPerHour}` : '')}
      ${row('Contact', v.contact)}
    </div>

    ${embedSrc ? `<iframe class="venue-map-embed" src="${esc(embedSrc)}" loading="lazy" referrerpolicy="no-referrer" allowfullscreen></iframe>` : ''}
  `;
}

// ── Venue approve / reject ──

window.approveVenue = async function(id) {
  if (!_isAdmin) return;
  try {
    await _venuesRef().doc(id).update({ status: firebase.firestore.FieldValue.delete(), proposedBy: firebase.firestore.FieldValue.delete() });
    const v = _allVenues.find(x => x.id === id);
    if (v) { delete v.status; delete v.proposedBy; }
    showToast('Venue approved and now live.');
    history.back();
  } catch(e) { showToast('Could not approve venue.', 'error'); }
};

window.rejectVenue = async function(id) {
  if (!_isAdmin) return;
  if (!confirm('Reject and delete this venue proposal?')) return;
  try {
    await _venuesRef().doc(id).delete();
    _allVenues = _allVenues.filter(x => x.id !== id);
    showToast('Venue proposal rejected.');
    history.back();
  } catch(e) { showToast('Could not reject venue.', 'error'); }
};

// ── Venue form (create / edit) ──

function openVenueForm(id, mode) {
  _editingVenueId = id || null;
  _venueFormMode  = mode || 'admin';
  const v = id ? _allVenues.find(x => x.id === id) : null;
  const isPropose = _venueFormMode === 'propose';
  document.getElementById('venue-form-title').textContent  = v ? 'Edit venue' : (isPropose ? 'Propose a venue' : 'New venue');
  document.getElementById('vf-name').value    = v?.name        || '';
  document.getElementById('vf-address').value = v?.address     || '';
  document.getElementById('vf-maps').value    = v?.mapsUrl     || '';
  document.getElementById('vf-cost').value    = v?.costPerHour || '';
  document.getElementById('vf-contact').value = v?.contact     || '';
  document.getElementById('venue-form-error').textContent = '';
  document.getElementById('venue-delete-btn').style.display = (v && !isPropose) ? '' : 'none';
  document.getElementById('venue-submit-btn').textContent  = isPropose ? 'Submit for approval' : 'Save venue';
  const note = document.getElementById('vf-propose-note');
  if (note) note.style.display = isPropose ? '' : 'none';
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
      closeVenueForm();
      await renderVenues();
    } else if (_venueFormMode === 'propose') {
      data.status     = 'pending';
      data.proposedBy = _currentUser.uid;
      data.createdAt  = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await _venuesRef().add(data);
      _allVenues.push({ id: ref.id, ...data });
      closeVenueForm();
      _repopulateIeVenueSelect(ref.id);
      showToast('Venue submitted for review. You can use it in your session now.');
      try { await callFn('notifyVenueProposal', { venueId: ref.id, venueName: name }); } catch(_) {}
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await _venuesRef().add(data);
      closeVenueForm();
      await renderVenues();
      await _populateVenueSelect();
    }
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

function onVenueSelectChange(sel) {
  if (sel && sel.value === '__propose__') {
    sel.value = '';
    openVenueForm(null, 'propose');
  }
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

// ── Coaches directory ──────────────────────────────────────────────────────────
function _renderCoachOnboarding() {
  const el = document.getElementById('coach-onboarding-banner');
  if (!el || !_isCoach) { if (el) el.style.display = 'none'; return; }

  const u = _currentUserDoc || {};
  const items = [
    { label: 'Add your bio',            done: !!(u.coachBio && u.coachBio.trim()) },
    { label: 'Add positions you coach', done: !!(u.coachPositions && u.coachPositions.length) },
    { label: 'Set your levels',         done: !!(u.coachLevels && u.coachLevels.length) },
    { label: 'Set your availability',   done: !!(u.coachAvailability && u.coachAvailability.length) },
    { label: 'Set your 1-1 rate',       done: !!(u.coachRate && u.coachRate > 0) },
    { label: 'Connect Stripe',          done: !!_providerOnboardingComplete },
  ];

  const allDone = items.every(i => i.done);
  if (allDone) { el.style.display = 'none'; return; }

  const done = items.filter(i => i.done).length;
  el.style.display = '';
  el.innerHTML = `
    <div class="coach-onboarding">
      <div class="coach-onboarding-header">
        <strong>Complete your coach profile</strong>
        <span class="coach-onboarding-progress">${done}/${items.length}</span>
      </div>
      <div class="coach-onboarding-bar">
        <div class="coach-onboarding-fill" style="width:${Math.round(done/items.length*100)}%"></div>
      </div>
      <ul class="coach-onboarding-list">
        ${items.map(i => `
          <li class="coach-onboarding-item ${i.done ? 'done' : ''}">
            <span class="coach-onboarding-check">${i.done ? '✓' : '○'}</span>
            ${esc(i.label)}
          </li>
        `).join('')}
      </ul>
      <button class="cta-btn cta-btn--sm" onclick="openEditProfile()">Edit coach profile →</button>
    </div>
  `;
}

function openCoachesScreen() {
  _setHash('coaches');
  showScreen('coaches');
  _setNav('primary', 'coaches');
  _setTitle('Coaches');
  const coachesFooter = document.getElementById('coaches-footer');
  if (coachesFooter) coachesFooter.style.display = _canCreateClinic() ? '' : 'none';
  _renderCoachOnboarding();
  renderCoaches();
}

async function renderCoaches() {
  const list = document.getElementById('coaches-list');
  if (!list) return;
  // Only fetch from Firestore on first load; afterwards re-filter the cache
  if (!_allCoaches.length) {
    list.innerHTML = '<div class="home-empty">Loading…</div>';
    try {
      const snap = await getDb().collection('publicProfiles')
        .where('isCoach', '==', true)
        .orderBy('name')
        .get();
      _allCoaches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e) {
      console.error('Load coaches failed:', e);
      list.innerHTML = '<div class="home-empty">Couldn\'t load coaches.</div>';
      return;
    }
  }
  _applyCoachFilters();
}

function filterCoaches() {
  _coachSearch = (document.getElementById('coaches-search')?.value || '').toLowerCase();
  _applyCoachFilters();
}

function setCoachFilter(type, val) {
  if (type === 'pos')   _coachPosFilter   = val;
  if (type === 'level') _coachLevelFilter = val;
  if (type === 'style') _coachStyleFilter = val;
  if (type === 'day')   _coachDayFilter   = val;
  // Update active class on filter buttons in each filter group
  document.querySelectorAll(`[data-coach-filter="${type}"]`).forEach(b => {
    b.classList.toggle('active', b.dataset.val === val);
  });
  _applyCoachFilters();
}

function _applyCoachFilters() {
  const list = document.getElementById('coaches-list');
  if (!list) return;
  const q = _coachSearch;
  let coaches = _allCoaches.filter(u => {
    if (q && !(u.name || '').toLowerCase().includes(q)) return false;
    if (_coachPosFilter   && !(u.coachPositions || []).includes(_coachPosFilter))   return false;
    if (_coachLevelFilter && !(u.coachLevels    || []).includes(_coachLevelFilter)) return false;
    if (_coachStyleFilter && !(u.coachStyles    || []).includes(_coachStyleFilter)) return false;
    if (_coachDayFilter   && !(u.coachDays      || []).includes(_coachDayFilter))   return false;
    return true;
  });
  if (!coaches.length) {
    list.innerHTML = '<div class="home-empty">No coaches match your search.</div>';
    return;
  }
  list.innerHTML = coaches.map(u => {
    const initials = (u.name || '?')[0].toUpperCase();
    const avatar   = u.photoURL
      ? `<img class="user-avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="user-avatar user-avatar--initials">${esc(initials)}</div>`;
    const posBadges = (u.coachPositions || [])
      .map(p => `<span class="pos-fill-chip ${esc(p)}">${esc({setter:'S',hitter:'H',middle:'M',libero:'L'}[p]||p)}</span>`)
      .join('');
    const styleBadges = (u.coachStyles || [])
      .map(s => `<span class="coach-style-chip">${esc(s)}</span>`)
      .join('');
    const rateBadge = u.coach1to1Enabled && u.coachRate != null
      ? `<span class="coach-rate-chip">£${u.coachRate}/hr</span>` : '';
    const badges = posBadges + styleBadges + rateBadge;
    return `<div class="user-row" onclick="openProfileScreen('${esc(u.id)}')">
      ${avatar}
      <div class="user-info">
        <div class="user-name">${esc(u.name || '—')}</div>
        ${badges ? `<div class="coach-badges">${badges}</div>` : ''}
      </div>
    </div>`;
  }).join('');
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
          <button class="icon-btn" onclick="openSeriesEditInline('${s.id}')" title="Edit">✎</button>
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
      showToast('You\'re in! Pass activated.');
      _seriesInvite = null;
      renderSeries();
    }
  } catch(e) {
    const alreadyHas = e.message && e.message.toLowerCase().includes('already registered');
    if (alreadyHas) {
      showToast('You already have a pass.');
      renderSeries();
    } else {
      showToast(e.message || 'Couldn\'t activate pass. Try again.', 'error');
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }
}

async function openSeriesDetail(seriesId) {
  _activeSeriesFilter = null; _activeSeries = null; _activeSeriesReg = null; _activeSeriesMembers = [];
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
      cta = `<span class="session-badge series-pass-badge" style="font-size:14px;padding:6px 12px">Pass active ✓</span>`;
    } else if (_currentUser && (!isFull || _seriesInvite?.seriesId === seriesId)) {
      const label = series.cost > 0 ? `Buy pass — ${cost}` : 'Join — Free';
      cta = `<button class="cta-btn" style="margin-top:4px" onclick="joinSeries('${seriesId}')">${label}</button>`;
      if (isFull) cta += `<div class="series-invite-note">You were invited — getting this pass will add one spot.</div>`;
    } else if (isFull) {
      cta = `<span class="session-badge full-badge" style="font-size:14px;padding:6px 12px">Pass full</span>`;
    }

    const adminActions = _isAdmin ? `
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="series-copy-link-btn" onclick="copySeriesInviteLink('${seriesId}')">Copy invite link</button>
        <button class="series-copy-link-btn" onclick="openSeriesEditInline('${seriesId}')">Edit pass</button>
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
        <button class="cta-btn secondary-btn" data-sid="${esc(seriesId)}" data-sname="${esc(series.name)}" onclick="openSeriesSessions(this.dataset.sid, this.dataset.sname)">View sessions →</button>
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
  _setBack(() => history.back());
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

function _seriesFormHtml(s) {
  const startVal = s?.startDate?.toDate ? s.startDate.toDate().toISOString().slice(0, 10) : '';
  const endVal   = s?.endDate?.toDate   ? s.endDate.toDate().toISOString().slice(0, 10)   : '';
  return `
    <div class="form-fields" style="padding-bottom:80px">
      <div class="field">
        <label class="field-label">Name <span style="color:var(--red)">*</span></label>
        <input class="field-input" type="text" id="sfi-name" placeholder="e.g. Summer League 2026" maxlength="80" value="${esc(s?.name || '')}" />
      </div>
      <div class="field">
        <label class="field-label">Description</label>
        <textarea class="field-input field-textarea" id="sfi-description" placeholder="What is this series about?" maxlength="400">${esc(s?.description || '')}</textarea>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">Start date</label>
          <input class="field-input" type="date" id="sfi-start" value="${startVal}" />
        </div>
        <div class="field">
          <label class="field-label">End date</label>
          <input class="field-input" type="date" id="sfi-end" value="${endVal}" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">Price (£)</label>
          <input class="field-input" type="number" id="sfi-cost" min="0" step="0.5" inputmode="decimal" placeholder="0" value="${s?.cost ?? ''}" />
          <div class="field-hint">0 = free pass</div>
        </div>
        <div class="field">
          <label class="field-label">Max members</label>
          <input class="field-input" type="number" id="sfi-max-players" min="1" max="200" inputmode="numeric" placeholder="e.g. 20" value="${s?.maxPlayers ?? ''}" />
        </div>
      </div>
      <div class="form-error" id="sfi-error"></div>
    </div>`;
}

async function openSeriesCreateInline() {
  if (!_canCreate()) return;
  if (!_isAdmin && !_providerOnboardingComplete) {
    showToast('Set up payments in your profile before creating a pass.', 'error');
    return;
  }
  _setNav('sub', null);
  showScreen('detail');
  _setTitle('New pass');
  _setBack(() => openSeriesScreen());
  document.getElementById('detail-content').innerHTML = _seriesFormHtml(null);
  document.getElementById('detail-footer').innerHTML = `
    <button class="cta-btn secondary-btn" onclick="openSeriesScreen()">Cancel</button>
    <button class="cta-btn" id="sfi-save-btn" onclick="_submitSeriesInline(null)">Save pass</button>`;
}

async function openSeriesEditInline(seriesId) {
  if (!_isAdmin && !_isProvider) return;
  _setNav('sub', null);
  showScreen('detail');
  _setTitle('Edit pass');
  _setBack(() => openSeriesDetail(seriesId));
  document.getElementById('detail-content').innerHTML = '<div class="home-empty">Loading…</div>';
  document.getElementById('detail-footer').innerHTML = '';

  if (!_allSeries.length) await _loadSeries();
  const s = _allSeries.find(x => x.id === seriesId)
    || (await _seriesColRef().doc(seriesId).get().then(d => d.exists ? { id: d.id, ...d.data() } : null));

  if (!s) { document.getElementById('detail-content').innerHTML = '<div class="home-empty">Pass not found.</div>'; return; }

  document.getElementById('detail-content').innerHTML = _seriesFormHtml(s);
  document.getElementById('detail-footer').innerHTML = `
    <button class="cta-btn danger-btn" onclick="_deleteSeriesInline('${seriesId}')">Delete</button>
    <button class="cta-btn secondary-btn" onclick="openSeriesDetail('${seriesId}')">Cancel</button>
    <button class="cta-btn" id="sfi-save-btn" onclick="_submitSeriesInline('${seriesId}')">Save pass</button>`;
}

window._submitSeriesInline = async function(seriesId) {
  const errorEl = document.getElementById('sfi-error');
  const saveBtn = document.getElementById('sfi-save-btn');
  const name    = document.getElementById('sfi-name').value.trim();
  if (!name) { errorEl.textContent = 'Name is required.'; return; }

  errorEl.textContent = '';
  saveBtn.disabled = true;

  const startVal      = document.getElementById('sfi-start').value;
  const endVal        = document.getElementById('sfi-end').value;
  const costRaw       = parseFloat(document.getElementById('sfi-cost').value);
  const maxPlayersRaw = parseInt(document.getElementById('sfi-max-players').value, 10);
  const data = {
    name,
    description: document.getElementById('sfi-description').value.trim(),
    startDate:   startVal ? firebase.firestore.Timestamp.fromDate(new Date(startVal + 'T12:00:00')) : null,
    endDate:     endVal   ? firebase.firestore.Timestamp.fromDate(new Date(endVal   + 'T12:00:00')) : null,
    cost:        isNaN(costRaw)       ? 0    : costRaw,
    maxPlayers:  isNaN(maxPlayersRaw) ? null : maxPlayersRaw,
  };

  try {
    if (seriesId) {
      await _seriesColRef().doc(seriesId).update(data);
      await _loadSeries();
      await openSeriesDetail(seriesId);
    } else {
      data.createdAt   = firebase.firestore.FieldValue.serverTimestamp();
      data.providerUid = _currentUser.uid;
      const ref = await _seriesColRef().add(data);
      await _loadSeries();
      await openSeriesDetail(ref.id);
    }
  } catch(e) {
    console.error(e);
    errorEl.textContent = 'Couldn\'t save pass. Try again.';
    saveBtn.disabled = false;
  }
};

window._deleteSeriesInline = async function(seriesId) {
  if (!confirm('Delete this pass? Sessions assigned to it will keep the association until updated.')) return;
  try {
    await _seriesColRef().doc(seriesId).delete();
    await _loadSeries();
    openSeriesScreen();
  } catch(e) {
    const errorEl = document.getElementById('sfi-error');
    if (errorEl) errorEl.textContent = 'Couldn\'t delete pass.';
    console.error(e);
  }
};

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
