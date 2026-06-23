'use strict';

// Tests user management logic: filter/search, role state, coach request state.
// Mirrors _applyUserFilter and _renderUserRow logic from vb-sessions/app.js.

const assert = require('assert');

// ─── Fixtures ──────────────────────────────────────────────────────────────
const USERS = [
  { id: 'u1', name: 'Alice', email: 'alice@x.com', roles: ['player', 'coach'], gender: 'woman', positions: ['setter'] },
  { id: 'u2', name: 'Bob',   email: 'bob@x.com',   roles: ['player', 'admin'], gender: 'man',   positions: ['hitter'] },
  { id: 'u3', name: 'Carol', email: 'carol@x.com', roles: ['player'],          gender: '',       positions: [] },
  { id: 'u4', name: 'Dave',  email: 'dave@x.com',  roles: ['player'],          gender: 'man',   positions: [],         coachRequest: true },
];

// ─── Filter helpers (mirrors _applyUserFilter) ─────────────────────────────
function applyFilter(users, filter, query) {
  const q = (query || '').toLowerCase();
  return users.filter(u => {
    if (q && !((u.name||'').toLowerCase().includes(q)) && !((u.email||'').toLowerCase().includes(q))) return false;
    if (filter === 'coach')      return (u.roles||[]).includes('coach');
    if (filter === 'admin')      return (u.roles||[]).includes('admin');
    if (filter === 'pending')    return !!u.coachRequest && !(u.roles||[]).includes('coach');
    if (filter === 'incomplete') return !u.gender || !(u.positions||[]).length;
    return true;
  });
}

// ─── Filter: all ───────────────────────────────────────────────────────────
{
  const result = applyFilter(USERS, 'all', '');
  assert.strictEqual(result.length, 4, 'all filter returns all users');
  console.log('PASS all filter');
}

// ─── Filter: coach ─────────────────────────────────────────────────────────
{
  const result = applyFilter(USERS, 'coach', '');
  assert.strictEqual(result.length, 1, 'coach filter returns only coaches');
  assert.strictEqual(result[0].name, 'Alice');
  console.log('PASS coach filter');
}

// ─── Filter: admin ─────────────────────────────────────────────────────────
{
  const result = applyFilter(USERS, 'admin', '');
  assert.strictEqual(result.length, 1, 'admin filter returns only admins');
  assert.strictEqual(result[0].name, 'Bob');
  console.log('PASS admin filter');
}

// ─── Filter: pending coach requests ────────────────────────────────────────
{
  const result = applyFilter(USERS, 'pending', '');
  assert.strictEqual(result.length, 1, 'pending filter returns users with coachRequest=true who are not already coach');
  assert.strictEqual(result[0].name, 'Dave');
  console.log('PASS pending filter');
}

// ─── Filter: incomplete profile ────────────────────────────────────────────
{
  const result = applyFilter(USERS, 'incomplete', '');
  assert.strictEqual(result.length, 2, 'incomplete filter returns users missing gender or positions');
  const names = result.map(u => u.name).sort();
  assert.deepStrictEqual(names, ['Carol', 'Dave'], 'Carol (no gender, no positions) and Dave (no positions) are incomplete');
  console.log('PASS incomplete filter');
}

// ─── Search: by name ───────────────────────────────────────────────────────
{
  const result = applyFilter(USERS, 'all', 'ali');
  assert.strictEqual(result.length, 1, 'name search narrows results');
  assert.strictEqual(result[0].name, 'Alice');
  console.log('PASS search by name');
}

// ─── Search: by email ──────────────────────────────────────────────────────
{
  const result = applyFilter(USERS, 'all', 'bob@');
  assert.strictEqual(result.length, 1, 'email search narrows results');
  assert.strictEqual(result[0].email, 'bob@x.com');
  console.log('PASS search by email');
}

// ─── Search + filter combined ───────────────────────────────────────────────
{
  const result = applyFilter(USERS, 'coach', 'bob');
  assert.strictEqual(result.length, 0, 'search+filter with no match returns empty');
  console.log('PASS search+filter combination');
}

// ─── Coach already approved: not in pending ─────────────────────────────────
{
  const usersWithApprovedCoach = [
    ...USERS,
    { id: 'u5', name: 'Eve', email: 'eve@x.com', roles: ['player', 'coach'], coachRequest: true, gender: 'woman', positions: ['middle'] },
  ];
  const result = applyFilter(usersWithApprovedCoach, 'pending', '');
  assert(!result.some(u => u.name === 'Eve'), 'approved coach not shown in pending even if coachRequest still true');
  console.log('PASS approved coach not in pending list');
}

console.log('\nAll user management tests passed.');
