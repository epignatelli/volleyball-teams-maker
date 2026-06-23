'use strict';

// Tests the logic behind notifyCoachRequest, notifyAdminRequest, and removeUser.

// ─── notifyCoachRequest guard ─────────────────────────────────────────────
function validateCoachRequest({ uid, name }) {
  if (!uid) return { status: 400, error: 'Missing uid.' };
  return { status: 200, uid, name: name || uid };
}

function safeName(name, uid) {
  return (name || uid || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── removeUser guards ────────────────────────────────────────────────────
function validateRemoveUser({ callerUid, targetUid, isAdmin, callerIsOwner, targetRoles }) {
  if (!isAdmin) return { status: 403, error: 'Admins only.' };
  if (!targetUid) return { status: 400, error: 'Missing uid.' };
  if (targetUid === callerUid) return { status: 400, error: 'Cannot remove yourself.' };
  const tRoles = targetRoles || [];
  if (tRoles.includes('owner')) return { status: 403, error: 'Cannot remove an owner.' };
  if (!callerIsOwner && tRoles.includes('admin')) return { status: 403, error: 'Only owners can remove admins.' };
  return { status: 200 };
}

// ─── approveCoach role logic ──────────────────────────────────────────────
function approveCoachRoles(existingRoles) {
  const roles = Array.isArray(existingRoles) ? [...existingRoles] : ['player'];
  if (!roles.includes('coach')) roles.push('coach');
  return roles;
}

// ─── approveAdmin role logic ──────────────────────────────────────────────
function approveAdminRoles(existingRoles) {
  const roles = Array.isArray(existingRoles) ? [...existingRoles] : ['player'];
  if (!roles.includes('admin')) roles.push('admin');
  return roles;
}

// ─── Tests ───────────────────────────────────────────────────────────────
describe('notifyCoachRequest', () => {
  it('accepts valid request', () => {
    const r = validateCoachRequest({ uid: 'abc', name: 'Alice' });
    expect(r.status).toBe(200);
    expect(r.name).toBe('Alice');
  });

  it('rejects missing uid with 400', () => {
    const r = validateCoachRequest({ uid: '' });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/uid/);
  });

  it('falls back to uid when name is omitted', () => {
    const r = validateCoachRequest({ uid: 'abc' });
    expect(r.status).toBe(200);
    expect(r.name).toBe('abc');
  });

  it('escapes HTML in email body', () => {
    const out = safeName('<script>alert(1)</script>', 'uid1');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
});

describe('removeUser', () => {
  it('allows admin to remove a player', () => {
    const r = validateRemoveUser({ callerUid: 'admin1', targetUid: 'user1', isAdmin: true, callerIsOwner: false, targetRoles: ['player'] });
    expect(r.status).toBe(200);
  });

  it('rejects non-admin with 403', () => {
    const r = validateRemoveUser({ callerUid: 'admin1', targetUid: 'user1', isAdmin: false });
    expect(r.status).toBe(403);
  });

  it('prevents self-removal', () => {
    const r = validateRemoveUser({ callerUid: 'admin1', targetUid: 'admin1', isAdmin: true, callerIsOwner: true, targetRoles: [] });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/yourself/);
  });

  it('prevents admin removing another admin', () => {
    const r = validateRemoveUser({ callerUid: 'admin1', targetUid: 'admin2', isAdmin: true, callerIsOwner: false, targetRoles: ['player', 'admin'] });
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/owner/);
  });

  it('allows owner to remove an admin', () => {
    const r = validateRemoveUser({ callerUid: 'owner1', targetUid: 'admin1', isAdmin: true, callerIsOwner: true, targetRoles: ['player', 'admin'] });
    expect(r.status).toBe(200);
  });

  it('prevents anyone from removing an owner', () => {
    const r = validateRemoveUser({ callerUid: 'owner1', targetUid: 'owner2', isAdmin: true, callerIsOwner: true, targetRoles: ['player', 'admin', 'owner'] });
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/owner/);
  });

  it('rejects missing targetUid', () => {
    const r = validateRemoveUser({ callerUid: 'admin1', targetUid: '', isAdmin: true });
    expect(r.status).toBe(400);
  });
});

describe('approveCoach', () => {
  it('adds coach role on approval', () => {
    const roles = approveCoachRoles(['player']);
    expect(roles).toContain('coach');
    expect(roles).toContain('player');
  });

  it('does not duplicate coach role if already present', () => {
    const roles = approveCoachRoles(['player', 'coach']);
    expect(roles.filter(r => r === 'coach').length).toBe(1);
  });
});

describe('approveAdmin', () => {
  it('adds admin role on owner approval', () => {
    const roles = approveAdminRoles(['player']);
    expect(roles).toContain('admin');
    expect(roles).toContain('player');
  });

  it('does not duplicate admin role if already present', () => {
    const roles = approveAdminRoles(['player', 'admin']);
    expect(roles.filter(r => r === 'admin').length).toBe(1);
  });
});
