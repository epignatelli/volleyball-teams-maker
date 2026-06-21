// ─── State ─────────────────────────────────────────────────────────────────────
let _currentUser = null;
let _isAdmin     = false;
let _editingId   = null;   // session ID being edited, null when creating

// ─── Firebase ──────────────────────────────────────────────────────────────────
function getDb()   { return firebase.firestore(); }
function getAuth() { return firebase.auth(); }

function _sessionsRef()           { return getDb().collection('sessions'); }
function _sessionRef(id)          { return _sessionsRef().doc(id); }
function _attendeesRef(sessionId) { return _sessionRef(sessionId).collection('attendees'); }

async function _checkAdmin(user) {
  if (!user?.email) return false;
  try {
    const doc = await getDb().collection('admins').doc(user.email).get();
    return doc.exists;
  } catch(e) { return false; }
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
  const btn    = document.getElementById('auth-btn');
  const newBtn = document.getElementById('home-new-btn');
  if (_currentUser) {
    const label = _currentUser.displayName?.split(' ')[0] || _currentUser.email;
    btn.textContent = `${esc(label)} · Sign out`;
    btn.classList.add('auth-btn--signed-in');
  } else {
    btn.textContent = 'Sign in';
    btn.classList.remove('auth-btn--signed-in');
  }
  if (newBtn) newBtn.style.display = _isAdmin ? '' : 'none';
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
getAuth().onAuthStateChanged(async user => {
  _currentUser = user;
  _isAdmin     = await _checkAdmin(user);
  _updateAuthUI();
  renderHome();
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function goHome() {
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
  const statusClass = s.status === 'cancelled' ? 'cancelled' : s.status === 'full' ? 'full' : 'open';
  const statusLabel = s.status === 'cancelled' ? 'Cancelled' : s.status === 'full' ? 'Full' : 'Open';
  const dateStr  = _formatDate(s.date);
  const timeStr  = s.time || '';
  const costStr  = _formatCost(s.cost);
  const countStr = s.attendeeCount != null ? `${s.attendeeCount}/${s.maxPlayers}` : `0/${s.maxPlayers}`;
  return `
    <div class="session-card" onclick="openSession('${s.id}')">
      <div class="session-card-main">
        <div class="session-date">${esc(dateStr)}${timeStr ? ` · ${esc(timeStr)}` : ''}</div>
        <div class="session-venue">${esc(s.venue || '—')}</div>
        ${s.description ? `<div class="session-desc">${esc(s.description)}</div>` : ''}
      </div>
      <div class="session-card-meta">
        <span class="session-badge ${statusClass}">${statusLabel}</span>
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
  showScreen('detail');
  const content = document.getElementById('detail-content');
  const footer  = document.getElementById('detail-footer');
  content.innerHTML = '<div class="home-empty">Loading…</div>';
  footer.innerHTML  = '';

  try {
    const [sessionDoc, attendeesSnap] = await Promise.all([
      _sessionRef(id).get(),
      _attendeesRef(id).orderBy('joinedAt', 'asc').get(),
    ]);
    if (!sessionDoc.exists) { goHome(); return; }

    const session   = { id: sessionDoc.id, ...sessionDoc.data() };
    const attendees = attendeesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const isAttending = _currentUser && attendees.some(a => a.id === _currentUser.uid);

    document.getElementById('detail-subtitle').textContent =
      [_formatDate(session.date), session.time].filter(Boolean).join(' · ');

    _renderDetail(session, attendees, isAttending, content, footer);
  } catch(e) {
    content.innerHTML = '<div class="home-empty">Couldn\'t load session.</div>';
    console.error(e);
  }
}

function _renderDetail(session, attendees, isAttending, content, footer) {
  const spotsLeft  = _spotsLeft(session, attendees.length);
  const isCancelled = session.status === 'cancelled';
  const isFull      = spotsLeft === 0 && !isAttending;
  const canRegister = _currentUser && !isCancelled;

  content.innerHTML = `
    <div class="detail-section">
      <div class="detail-meta-grid">
        ${session.venue ? `<div class="detail-meta-row"><span class="detail-meta-label">Venue</span><span>${esc(session.venue)}</span></div>` : ''}
        <div class="detail-meta-row"><span class="detail-meta-label">Date</span><span>${esc(_formatDate(session.date))}${session.time ? ` at ${esc(session.time)}` : ''}</span></div>
        <div class="detail-meta-row"><span class="detail-meta-label">Cost</span><span>${esc(_formatCost(session.cost))}</span></div>
        <div class="detail-meta-row"><span class="detail-meta-label">Spots</span><span>${attendees.length} / ${session.maxPlayers}${isCancelled ? '' : ` · ${spotsLeft} left`}</span></div>
        ${isCancelled ? `<div class="detail-meta-row"><span class="detail-badge cancelled">Cancelled</span></div>` : ''}
      </div>
      ${session.description ? `<p class="detail-description">${esc(session.description)}</p>` : ''}
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Attendees (${attendees.length})</div>
      ${attendees.length ? `
        <div class="attendee-list">
          ${attendees.map((a, i) => `
            <div class="attendee-row">
              <span class="attendee-num">${i + 1}</span>
              <span class="attendee-name">${esc(a.name)}</span>
              ${_isAdmin ? `<span class="attendee-email">${esc(a.email || '')}</span>` : ''}
              ${_isAdmin ? `<button class="icon-btn danger small" onclick="removeAttendee('${session.id}','${a.id}')" title="Remove">✕</button>` : ''}
            </div>`).join('')}
        </div>` : '<div class="empty-note">No one signed up yet.</div>'}
    </div>`;

  if (!_currentUser) {
    footer.innerHTML = `<button class="cta-btn" onclick="handleAuthClick()">Sign in to register</button>`;
  } else if (isCancelled) {
    footer.innerHTML = `<button class="cta-btn" disabled>Session cancelled</button>`;
  } else if (isAttending) {
    footer.innerHTML = `<button class="cta-btn secondary-btn" onclick="cancelRegistration('${session.id}')">Cancel my registration</button>`;
  } else if (isFull) {
    footer.innerHTML = `<button class="cta-btn" disabled>Session full</button>`;
  } else {
    footer.innerHTML = `<button class="cta-btn" onclick="register('${session.id}')">Join session →</button>`;
  }
}

async function register(sessionId) {
  if (!_currentUser) return;
  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) btn.disabled = true;
  try {
    await _attendeesRef(sessionId).doc(_currentUser.uid).set({
      name:     _currentUser.displayName || _currentUser.email,
      email:    _currentUser.email || '',
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await _sessionRef(sessionId).update({
      attendeeCount: firebase.firestore.FieldValue.increment(1),
    });
    await openSession(sessionId);
  } catch(e) {
    console.error('Register failed:', e);
    if (btn) btn.disabled = false;
  }
}

async function cancelRegistration(sessionId) {
  if (!_currentUser) return;
  if (!confirm('Cancel your registration for this session?')) return;
  const btn = document.querySelector('#detail-footer .cta-btn');
  if (btn) btn.disabled = true;
  try {
    await _attendeesRef(sessionId).doc(_currentUser.uid).delete();
    await _sessionRef(sessionId).update({
      attendeeCount: firebase.firestore.FieldValue.increment(-1),
    });
    await openSession(sessionId);
  } catch(e) {
    console.error('Cancel registration failed:', e);
    if (btn) btn.disabled = false;
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
  } catch(e) { console.error('Remove attendee failed:', e); }
}

// ─── Create / Edit session ─────────────────────────────────────────────────────
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
      const s = doc.data();
      const d = s.date?.toDate();
      document.getElementById('form-date').value        = d ? d.toISOString().slice(0, 10) : '';
      document.getElementById('form-time').value        = s.time || '';
      document.getElementById('form-venue').value       = s.venue || '';
      document.getElementById('form-description').value = s.description || '';
      document.getElementById('form-max').value         = s.maxPlayers || '';
      document.getElementById('form-cost').value        = s.cost != null ? s.cost : '';
      document.getElementById('form-status').value      = s.status || 'open';
    });
  } else {
    titleEl.textContent  = 'New session';
    submitEl.textContent = 'Create session';
    const now = new Date();
    document.getElementById('form-date').value        = now.toISOString().slice(0, 10);
    document.getElementById('form-time').value        = '10:00';
    document.getElementById('form-venue').value       = '';
    document.getElementById('form-description').value = '';
    document.getElementById('form-max').value         = '12';
    document.getElementById('form-cost').value        = '0';
    document.getElementById('form-status').value      = 'open';
  }

  document.getElementById('session-form-overlay').classList.add('open');
}

function closeSessionForm() {
  document.getElementById('session-form-overlay').classList.remove('open');
  _editingId = null;
}

async function submitSessionForm() {
  if (!_isAdmin) return;
  const dateVal  = document.getElementById('form-date').value;
  const timeVal  = document.getElementById('form-time').value;
  const venueVal = document.getElementById('form-venue').value.trim();
  const descVal  = document.getElementById('form-description').value.trim();
  const maxVal   = parseInt(document.getElementById('form-max').value);
  const costVal  = parseFloat(document.getElementById('form-cost').value) || 0;
  const status   = document.getElementById('form-status').value;
  const errorEl  = document.getElementById('form-error');

  if (!dateVal)          { errorEl.textContent = 'Please set a date.'; return; }
  if (!venueVal)         { errorEl.textContent = 'Please enter a venue.'; return; }
  if (isNaN(maxVal) || maxVal < 1) { errorEl.textContent = 'Max players must be at least 1.'; return; }

  errorEl.textContent = '';
  const btn = document.getElementById('form-submit-btn');
  btn.disabled = true;

  const data = {
    date:       firebase.firestore.Timestamp.fromDate(new Date(dateVal + 'T12:00:00')),
    time:       timeVal,
    venue:      venueVal,
    description: descVal,
    maxPlayers: maxVal,
    cost:       costVal,
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
  } catch(e) { console.error('Delete session failed:', e); }
}

// ─── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}
