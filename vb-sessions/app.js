// ─── State ─────────────────────────────────────────────────────────────────────
let _currentUser  = null;
let _currentRoles = [];
let _isAdmin      = false;
let _isCoach      = false;
let _legacyAdmin  = false;   // cached check against admins/{email} collection
let _userDocUnsub = null;    // unsubscribe fn for own user doc listener
let _editingId              = null;   // session ID being edited, null when creating
let _pendingJoinSessionId   = null;   // session to join after sign-in completes
let _pendingProfileNeeds    = {};     // { needsGender, needsPositions } for profile overlay
let _editingAttendeeSession = null;   // sessionId when editing own attendee entry (positions)

// Handle return from Stripe Checkout before Firebase initialises.
// Stripe appends ?checkout=success|cancelled&session=ID to the success/cancel URLs.
// We convert this to a hash route immediately so normal routing takes over,
// and stash the success flag to show a toast after auth resolves.
let _pendingCheckoutSuccess = null;
(function _handleStripeReturn() {
  const p      = new URLSearchParams(window.location.search);
  const status = p.get('checkout');
  const sid    = p.get('session');
  if (!status || !sid) return;
  history.replaceState(null, '', window.location.pathname + '#session/' + sid);
  if (status === 'success') _pendingCheckoutSuccess = sid;
})();

// ─── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ─── Firebase ──────────────────────────────────────────────────────────────────
function getDb()   { return firebase.firestore(); }
function getAuth() { return firebase.auth(); }
function getFn()   { return firebase.app().functions('europe-west2'); }

function _sessionsRef()           { return getDb().collection('sessions'); }
function _sessionRef(id)          { return _sessionsRef().doc(id); }
function _attendeesRef(sessionId) { return _sessionRef(sessionId).collection('attendees'); }
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

function _subscribeToUserDoc(user) {
  if (_userDocUnsub) { _userDocUnsub(); _userDocUnsub = null; }
  _userDocUnsub = _userRef(user.uid).onSnapshot(doc => {
    _currentRoles = (doc.data()?.roles) || ['player'];
    _isAdmin = _legacyAdmin || _currentRoles.includes('admin');
    _isCoach = _currentRoles.includes('coach');
    _updateAuthUI();
    renderHome();
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

function _updateAuthUI() {
  const btn      = document.getElementById('auth-btn');
  const newBtn   = document.getElementById('home-new-btn');
  const usersBtn = document.getElementById('home-users-btn');
  if (_currentUser) {
    const label = _currentUser.displayName?.split(' ')[0] || _currentUser.email;
    btn.textContent = `${esc(label)} · Sign out`;
    btn.classList.add('auth-btn--signed-in');
  } else {
    btn.textContent = 'Sign in';
    btn.classList.remove('auth-btn--signed-in');
  }
  if (newBtn)   newBtn.style.display   = _isAdmin ? '' : 'none';
  if (usersBtn) usersBtn.style.display = _isAdmin ? '' : 'none';
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
        showToast('Payment confirmed! You\'re in.');
        _pendingCheckoutSuccess = null;
      }
    } else renderHome();

    await _upsertUserDoc(user);
    _subscribeToUserDoc(user);

    if (_pendingJoinSessionId) {
      const sid = _pendingJoinSessionId;
      _pendingJoinSessionId = null;
      await register(sid);
    }
  } else {
    _currentRoles = [];
    _isAdmin = false;
    _isCoach = false;
    _legacyAdmin = false;
    _updateAuthUI();
    if (!_initialRouted) { _initialRouted = true; await _routeFromHash(); }
    else renderHome();
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function _setHash(hash) {
  history.replaceState(null, '', '#' + hash);
}

async function _routeFromHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (!hash || hash === 'home') { renderHome(); return; }
  if (hash === 'users')         { if (_isAdmin) openUsersScreen(); else renderHome(); return; }
  const slash = hash.indexOf('/');
  const section = slash > -1 ? hash.slice(0, slash) : hash;
  const id      = slash > -1 ? hash.slice(slash + 1) : '';
  if (section === 'session' && id)  { await openSession(id); }
  else if (section === 'run'  && id)  { await openSessionRun(id); }
  else if (section === 'end'  && id)  {
    try {
      await _loadRunSessionData(id);
      document.getElementById('end-subtitle').textContent =
        document.getElementById('run-subtitle').textContent;
      showScreen('session-end');
      _renderSessionEnd();
    } catch(e) { renderHome(); }
  }
  else { renderHome(); }
}

function goHome() {
  _setHash('home');
  showScreen('home');
  renderHome();
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

function _formatPlayerPrice(adminPrice) {
  const p = _playerPrice(adminPrice);
  return p === 0 ? 'Free' : `£${p.toFixed(2).replace(/\.00$/, '')}`;
}

function _spotsLeft(session, attendeeCount) {
  return Math.max(0, (session.maxPlayers || 0) - attendeeCount);
}

// ─── Home screen ───────────────────────────────────────────────────────────────
async function renderHome() {
  const container = document.getElementById('home-content');
  container.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    const snap     = await _sessionsRef().orderBy('date', 'asc').get();
    const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!sessions.length) {
      container.innerHTML = '<div class="home-empty">No sessions yet.</div>';
      return;
    }

    const now    = new Date();
    now.setHours(0, 0, 0, 0);
    const upcoming = sessions.filter(s => s.date?.toDate() >= now);
    const past     = sessions.filter(s => s.date?.toDate() < now);

    const groups = [
      { label: 'Upcoming', items: upcoming },
      { label: 'Past',     items: past.reverse() },
    ].filter(g => g.items.length);

    container.innerHTML = groups.map(g => `
      <div class="session-group">
        <div class="session-group-label">${g.label}</div>
        ${g.items.map(_renderSessionCard).join('')}
      </div>`).join('');

  } catch(e) {
    container.innerHTML = '<div class="home-empty">Couldn\'t load sessions. Check your connection.</div>';
    console.error(e);
  }
}

function _renderSessionCard(s) {
  const statusClass = s.status === 'cancelled' ? 'cancelled' : s.status === 'full' ? 'full' : s.status === 'closed' ? 'closed' : 'open';
  const statusLabel = s.status === 'cancelled' ? 'Cancelled' : s.status === 'full' ? 'Full' : s.status === 'closed' ? 'Closed' : 'Open';
  const dateStr     = _formatDate(s.date);
  const timeStr     = s.time || '';
  const costStr     = _formatPlayerPrice(s.cost);
  const countStr    = s.attendeeCount != null ? `${s.attendeeCount}/${s.maxPlayers}` : `0/${s.maxPlayers}`;
  const levelLabel  = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', competitive: 'Competitive' }[s.level] || '';
  return `
    <div class="session-card" onclick="openSession('${s.id}')">
      <div class="session-card-main">
        <div class="session-date">${esc(dateStr)}${timeStr ? ` · ${esc(timeStr)}` : ''}</div>
        <div class="session-venue">${esc(s.venue || '—')}${s.coach ? ` · ${esc(s.coach)}` : ''}</div>
        ${s.description ? `<div class="session-desc">${esc(s.description)}</div>` : ''}
      </div>
      <div class="session-card-meta">
        <span class="session-badge ${statusClass}">${statusLabel}</span>
        ${levelLabel ? `<span class="session-badge level">${esc(levelLabel)}</span>` : ''}
        <span class="session-meta-item">👥 ${countStr}</span>
        <span class="session-meta-item">${esc(costStr)}</span>
      </div>
      ${_isAdmin ? `
        <div class="session-admin-btns" onclick="event.stopPropagation()">
          <button class="icon-btn" onclick="openSessionForm('${s.id}')" title="Edit">✎</button>
          <button class="icon-btn danger" onclick="deleteSession('${s.id}','${esc(s.venue || '')}')" title="Delete">✕</button>
        </div>` : ''}
    </div>`;
}

// ─── Session detail ────────────────────────────────────────────────────────────
async function openSession(id) {
  _setHash('session/' + id);
  showScreen('detail');
  const content = document.getElementById('detail-content');
  const footer  = document.getElementById('detail-footer');
  content.innerHTML = '<div class="home-empty">Loading…</div>';
  footer.innerHTML  = '';

  try {
    const sessionDoc = await _sessionRef(id).get();
    if (!sessionDoc.exists) { goHome(); return; }

    const session = { id: sessionDoc.id, ...sessionDoc.data() };
    let attendees   = [];
    let isAttending = false;

    if (_currentUser) {
      const attendeesSnap = await _attendeesRef(id).orderBy('joinedAt', 'asc').get();
      attendees   = attendeesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      isAttending = attendees.some(a => a.id === _currentUser.uid);
    }

    document.getElementById('detail-subtitle').textContent =
      [_formatDate(session.date), session.time].filter(Boolean).join(' · ');

    _renderDetail(session, attendees, isAttending, content, footer);
  } catch(e) {
    content.innerHTML = '<div class="home-empty">Couldn\'t load session.</div>';
    console.error(e);
  }
}

function _renderDetail(session, attendees, isAttending, content, footer) {
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
        ${session.venue ? `<div class="detail-meta-row"><span class="detail-meta-label">Venue</span><span>${esc(session.venue)}</span></div>` : ''}
        <div class="detail-meta-row"><span class="detail-meta-label">Date</span><span>${esc(_formatDate(session.date))}${session.time ? ` at ${esc(session.time)}` : ''}</span></div>
        ${session.coach ? `<div class="detail-meta-row"><span class="detail-meta-label">Coach</span><span>${esc(session.coach)}</span></div>` : ''}
        ${levelLabel ? `<div class="detail-meta-row"><span class="detail-meta-label">Level</span><span>${esc(levelLabel)}</span></div>` : ''}
        <div class="detail-meta-row"><span class="detail-meta-label">Cost</span><span>${esc(_formatPlayerPrice(session.cost))}</span></div>
        <div class="detail-meta-row"><span class="detail-meta-label">Spots</span><span>${knownCount} / ${session.maxPlayers}${isCancelled ? '' : ` · ${spotsLeft} left`}</span></div>
        ${deadlineStr ? `<div class="detail-meta-row"><span class="detail-meta-label">Deadline</span><span${deadlinePassed ? ' style="color:var(--red)"' : ''}>${esc(deadlineStr)}${deadlinePassed ? ' · closed' : ''}</span></div>` : ''}
        ${isCancelled ? `<div class="detail-meta-row"><span class="detail-badge cancelled">Cancelled</span></div>` : ''}
      </div>
      ${session.description ? `<p class="detail-description">${esc(session.description)}</p>` : ''}
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
                <span class="attendee-name">${esc(a.name)}</span>
                ${posChips ? `<div class="att-chips">${posChips}</div>` : ''}
                ${canSee && session.cost > 0 ? `<span class="att-chip ${a.paid ? 'paid-chip' : 'unpaid-chip'}">${a.paid ? '£✓' : '£?'}</span>` : ''}
                ${_isAdmin ? `<span class="attendee-email">${esc(a.email || '')}</span>` : ''}
                ${isOwn && session.askPositions ? `<button class="icon-btn small" onclick="openEditPositions('${session.id}','${Array.from(posSet).join(',')}')" title="Edit positions">✎</button>` : ''}
                ${_isAdmin ? `<button class="icon-btn danger small" onclick="removeAttendee('${session.id}','${a.id}')" title="Remove">✕</button>` : ''}
              </div>`;
            }).join('')}
          </div>` : '<div class="empty-note">No one signed up yet.</div>'}
    </div>`;

  const canStart = _isAdmin || (_currentUser && session.coachUid && session.coachUid === _currentUser.uid);
  if (isClosed) {
    footer.innerHTML = `
      <button class="cta-btn" disabled>Session closed</button>
      ${canStart && session.report ? `<button class="cta-btn secondary-btn" onclick="openSessionEndReport('${session.id}')">View report</button>` : ''}`;
  } else if (isCancelled) {
    footer.innerHTML = `<button class="cta-btn" disabled>Session cancelled</button>`;
  } else if (canStart) {
    footer.innerHTML = `
      <button class="cta-btn" onclick="openSessionRun('${session.id}')">▶ Start session</button>
      ${isAttending ? `<button class="cta-btn secondary-btn" onclick="cancelRegistration('${session.id}')">Cancel</button>` : ''}`;
  } else if (isAttending) {
    footer.innerHTML = `<button class="cta-btn secondary-btn" onclick="cancelRegistration('${session.id}')">Cancel my registration</button>`;
  } else if (isFull) {
    footer.innerHTML = `<button class="cta-btn" disabled>Session full</button>`;
  } else if (deadlinePassed) {
    footer.innerHTML = `<button class="cta-btn" disabled>Registration closed</button>`;
  } else {
    footer.innerHTML = `<button class="cta-btn" onclick="register('${session.id}')">Join session →</button>`;
  }
}

async function register(sessionId) {
  if (!_currentUser) {
    _pendingJoinSessionId = sessionId;
    await handleAuthClick();
    return;
  }

  try {
    const [userDoc, sessionDoc] = await Promise.all([
      _userRef(_currentUser.uid).get(),
      _sessionRef(sessionId).get(),
    ]);
    const needsGender    = !userDoc.data()?.gender;
    const needsPositions = sessionDoc.data()?.askPositions === true;

    if (needsGender || needsPositions) {
      openProfileForm(sessionId, needsGender, needsPositions);
      return;
    }
  } catch(e) { console.error('Profile check failed:', e); }

  await _doRegister(sessionId);
}

async function _doRegister(sessionId, extra = {}) {
  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) btn.disabled = true;
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

    // Paid session → redirect to Stripe Checkout.
    // The webhook creates the attendee doc after payment succeeds.
    if ((session.cost || 0) > 0) {
      const base = window.location.origin + window.location.pathname;
      const { data } = await getFn().httpsCallable('createCheckoutSession')({
        sessionId,
        successUrl: `${base}?checkout=success&session=${sessionId}`,
        cancelUrl:  `${base}?checkout=cancelled&session=${sessionId}`,
      });
      window.location.href = data.url;
      return;
    }

    // Free session → direct Firestore write.
    await _attendeesRef(sessionId).doc(_currentUser.uid).set({
      name:     _currentUser.displayName || _currentUser.email,
      email:    _currentUser.email || '',
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      paid:     false,
      ...extra,
    });
    await _sessionRef(sessionId).update({
      attendeeCount: firebase.firestore.FieldValue.increment(1),
    });
    await openSession(sessionId);
  } catch(e) {
    console.error('Register failed:', e);
    showToast(e.message || 'Couldn\'t join session. Try again.');
    if (btn) btn.disabled = false;
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
    ? 'Cancel your registration? You\'ll receive a refund (excluding the booking fee). Cancellations within 24 h of the session are not allowed.'
    : 'Cancel your registration for this session?';
  if (!confirm(msg)) return;

  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) btn.disabled = true;

  if (isPaid) {
    try {
      const { data } = await getFn().httpsCallable('cancelAttendeeAndRefund')({ sessionId });
      showToast(data.refunded ? 'Cancelled — refund on its way.' : 'Registration cancelled.');
      await openSession(sessionId);
    } catch(e) {
      console.error('Cancel + refund failed:', e);
      showToast(e.message || 'Couldn\'t cancel. Try again.');
      if (btn) btn.disabled = false;
    }
  } else {
    try {
      await _attendeesRef(sessionId).doc(_currentUser.uid).delete();
      await _sessionRef(sessionId).update({
        attendeeCount: firebase.firestore.FieldValue.increment(-1),
      });
      await openSession(sessionId);
    } catch(e) {
      console.error('Cancel registration failed:', e);
      showToast('Couldn\'t cancel registration. Try again.');
      if (btn) btn.disabled = false;
    }
  }
}

async function removeAttendee(sessionId, uid) {
  if (!_isAdmin) return;
  if (!confirm('Remove this attendee?')) return;
  try {
    await _attendeesRef(sessionId).doc(uid).delete();
    await _sessionRef(sessionId).update({
      attendeeCount: firebase.firestore.FieldValue.increment(-1),
    });
    await openSession(sessionId);
  } catch(e) { console.error('Remove attendee failed:', e); showToast('Couldn\'t remove attendee. Try again.'); }
}

// ─── Users screen ──────────────────────────────────────────────────────────────
function openUsersScreen() {
  if (!_isAdmin) return;
  _setHash('users');
  showScreen('users');
  renderUsers();
}

async function renderUsers() {
  const container = document.getElementById('users-content');
  container.innerHTML = '<div class="home-empty">Loading…</div>';
  try {
    const snap  = await _usersRef().orderBy('name', 'asc').get();
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!users.length) {
      container.innerHTML = '<div class="home-empty">No users yet.</div>';
      return;
    }
    container.innerHTML = users.map(_renderUserRow).join('');
  } catch(e) {
    container.innerHTML = '<div class="home-empty">Couldn\'t load users. Check your connection.</div>';
    console.error(e);
  }
}

function _renderUserRow(u) {
  const roles      = u.roles || ['player'];
  const isMe       = _currentUser && u.id === _currentUser.uid;
  const hasAdmin   = roles.includes('admin');
  const hasCoach   = roles.includes('coach');
  const initials   = (u.name || u.email || '?')[0].toUpperCase();

  return `
    <div class="user-row">
      ${u.photoURL
        ? `<img class="user-avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
        : `<div class="user-avatar user-avatar--initials">${esc(initials)}</div>`}
      <div class="user-info">
        <div class="user-name">${esc(u.name || '—')}${isMe ? ' <span class="user-you">you</span>' : ''}</div>
        <div class="user-email">${esc(u.email || '')}</div>
      </div>
      <div class="user-roles">
        <button class="role-toggle${hasAdmin ? ' active admin' : ''}"
          onclick="toggleRole('${u.id}', 'admin')"
          ${isMe ? 'disabled' : ''}>Admin</button>
        <button class="role-toggle${hasCoach ? ' active coach' : ''}"
          onclick="toggleRole('${u.id}', 'coach')">Coach</button>
        <span class="role-toggle active player" style="cursor:default">Player</span>
      </div>
    </div>`;
}

async function toggleRole(uid, role) {
  if (!_isAdmin) return;
  if (role === 'admin' && _currentUser && uid === _currentUser.uid) return;
  try {
    const doc      = await _userRef(uid).get();
    const roles    = doc.data()?.roles || ['player'];
    const newRoles = roles.includes(role)
      ? roles.filter(r => r !== role)
      : [...roles, role];
    if (!newRoles.includes('player')) newRoles.push('player');
    await _userRef(uid).set({ roles: newRoles }, { merge: true });
    renderUsers();
  } catch(e) {
    console.error('Toggle role failed:', e);
    showToast(e.code === 'permission-denied'
      ? 'Permission denied — check Firestore rules for users/.'
      : 'Couldn\'t update role. Try again.');
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
    if (needsGender) await _userRef(_currentUser.uid).update({ gender });

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
  if (!_isAdmin) return;
  _editingId = id;

  const titleEl  = document.getElementById('form-title');
  const submitEl = document.getElementById('form-submit-btn');
  const errorEl  = document.getElementById('form-error');
  errorEl.textContent = '';

  if (id) {
    titleEl.textContent  = 'Edit session';
    submitEl.textContent = 'Save changes';
    _sessionRef(id).get().then(doc => {
      if (!doc.exists) return;
      const s  = doc.data();
      const d  = s.date?.toDate();
      const dl = s.registrationDeadline?.toDate();
      document.getElementById('form-date').value        = d  ? d.toISOString().slice(0, 10) : '';
      document.getElementById('form-time').value        = s.time || '';
      document.getElementById('form-venue').value       = s.venue || '';
      document.getElementById('form-level').value       = s.level || '';
      _loadCoachOptions(s.coach || '', s.coachUid || '');
      document.getElementById('form-description').value = s.description || '';
      document.getElementById('form-max').value         = s.maxPlayers || '';
      document.getElementById('form-cost').value        = s.cost != null ? s.cost : '';
      document.getElementById('form-deadline').value        = dl ? dl.toISOString().slice(0, 16) : '';
      const statusSel = document.getElementById('form-status');
      // Ensure 'closed' option exists when editing a closed session
      if (s.status === 'closed' && !statusSel.querySelector('option[value="closed"]')) {
        const opt = document.createElement('option');
        opt.value = 'closed'; opt.textContent = 'Closed';
        statusSel.appendChild(opt);
      }
      statusSel.value = s.status || 'open';
      document.getElementById('form-ask-positions').checked = s.askPositions || false;
      updateCostPreview();
    });
  } else {
    titleEl.textContent  = 'New session';
    submitEl.textContent = 'Create session';
    const now = new Date();
    document.getElementById('form-date').value        = now.toISOString().slice(0, 10);
    document.getElementById('form-time').value        = '10:00';
    document.getElementById('form-venue').value       = '';
    document.getElementById('form-level').value       = '';
    _loadCoachOptions('');
    document.getElementById('form-description').value = '';
    document.getElementById('form-max').value         = '12';
    document.getElementById('form-cost').value        = '0';
    document.getElementById('form-deadline').value        = '';
    const statusSel = document.getElementById('form-status');
    statusSel.querySelector('option[value="closed"]')?.remove();
    statusSel.value = 'open';
    document.getElementById('form-ask-positions').checked = false;
    updateCostPreview();
  }

  document.getElementById('session-form-overlay').classList.add('open');
}

function updateCostPreview() {
  const val      = parseFloat(document.getElementById('form-cost').value) || 0;
  const preview  = document.getElementById('form-cost-preview');
  const pp       = _playerPrice(val);
  preview.textContent = pp === 0
    ? 'Free session — no payment required'
    : `Players will be charged £${pp.toFixed(2)} (covers card processing)`;
}

function closeSessionForm() {
  document.getElementById('session-form-overlay').classList.remove('open');
  _editingId = null;
}

async function submitSessionForm() {
  if (!_isAdmin) return;
  const dateVal     = document.getElementById('form-date').value;
  const timeVal     = document.getElementById('form-time').value;
  const venueVal    = document.getElementById('form-venue').value.trim();
  const coachSel    = document.getElementById('form-coach-select').value;
  const coachUidVal = (coachSel && coachSel !== '__custom__') ? coachSel : '';
  const coachVal    = coachSel === '__custom__'
    ? document.getElementById('form-coach-custom').value.trim()
    : (coachSel ? document.querySelector(`#form-coach-select option[value="${coachSel}"]`)?.textContent || '' : '');
  const levelVal    = document.getElementById('form-level').value;
  const descVal     = document.getElementById('form-description').value.trim();
  const maxVal      = parseInt(document.getElementById('form-max').value);
  const costVal     = parseFloat(document.getElementById('form-cost').value) || 0;
  const deadlineVal = document.getElementById('form-deadline').value;
  const status      = document.getElementById('form-status').value;
  const errorEl     = document.getElementById('form-error');

  if (!dateVal)                    { errorEl.textContent = 'Please set a date.'; return; }
  if (!venueVal)                   { errorEl.textContent = 'Please enter a venue.'; return; }
  if (isNaN(maxVal) || maxVal < 1) { errorEl.textContent = 'Max players must be at least 1.'; return; }

  errorEl.textContent = '';
  const btn = document.getElementById('form-submit-btn');
  btn.disabled = true;

  const data = {
    date:                 firebase.firestore.Timestamp.fromDate(new Date(dateVal + 'T12:00:00')),
    time:                 timeVal,
    venue:                venueVal,
    coach:                coachVal,
    coachUid:             coachUidVal,
    level:                levelVal,
    description:          descVal,
    maxPlayers:           maxVal,
    cost:                 costVal,
    playerPrice:          _playerPrice(costVal),
    askPositions:         document.getElementById('form-ask-positions').checked,
    registrationDeadline: deadlineVal
      ? firebase.firestore.Timestamp.fromDate(new Date(deadlineVal))
      : null,
    status,
  };

  try {
    if (_editingId) {
      await _sessionRef(_editingId).update(data);
    } else {
      data.createdAt     = firebase.firestore.FieldValue.serverTimestamp();
      data.attendeeCount = 0;
      await _sessionsRef().add(data);
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
async function deleteSession(id, venue) {
  if (!_isAdmin) return;
  if (!confirm(`Delete session at "${venue}"?\n\nThis will remove all registrations too.`)) return;
  try {
    const snap  = await _attendeesRef(id).get();
    const batch = getDb().batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(_sessionRef(id));
    await batch.commit();
    renderHome();
  } catch(e) { console.error('Delete session failed:', e); showToast('Couldn\'t delete session. Try again.'); }
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
  document.getElementById('run-subtitle').textContent =
    [_formatDate(_runSession.date), _runSession.time].filter(Boolean).join(' · ');
}

async function openSessionRun(sessionId) {
  _setHash('run/' + sessionId);
  showScreen('session-run');
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
    showToast('Couldn\'t update attendance. Try again.');
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
  document.getElementById('end-subtitle').textContent =
    document.getElementById('run-subtitle').textContent;
  showScreen('session-end');
  _renderSessionEnd();
}

function closeSessionEnd() {
  _setHash('run/' + _runSession.id);
  showScreen('session-run');
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
    showToast('Couldn\'t close session. Try again.');
    if (btn) btn.disabled = false;
  }
}

function _renderReport(report, session) {
  const content = document.getElementById('end-content');
  const footer  = document.querySelector('#screen-session-end .footer');
  if (footer) footer.innerHTML =
    `<button class="cta-btn secondary-btn" onclick="openSession('${session.id}')">← Back to session</button>`;

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

async function openSessionEndReport(sessionId) {
  try {
    await _loadRunSessionData(sessionId);
    const sessionDoc = await _sessionRef(sessionId).get();
    _runSession = { id: sessionDoc.id, ...sessionDoc.data() };
    _setHash('end/' + sessionId);
    document.getElementById('end-subtitle').textContent =
      document.getElementById('run-subtitle').textContent;
    showScreen('session-end');
    _renderSessionEnd();
  } catch(e) {
    console.error(e);
    showToast('Couldn\'t load report.');
  }
}

// ─── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}
