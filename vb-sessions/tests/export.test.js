'use strict';

// Tests CSV generation logic (#16 export attendees, #23 export report).
// Mirrors _downloadCsv row-building logic from vb-sessions/app.js.

const assert = require('assert');

// ─── CSV builder (mirrors _downloadCsv) ────────────────────────────────────
function buildCsv(rows) {
  return rows.map(r =>
    r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
}

// ─── Attendee CSV ───────────────────────────────────────────────────────────
function buildAttendeeCsv(attendees) {
  const rows = [
    ['Name', 'Email', 'Gender', 'Positions', 'Paid', 'Present', 'Fee waived', 'Joined'],
    ...attendees.map(a => [
      a.name, a.email,
      a.gender || '',
      (a.positions || []).join(';'),
      a.paid      ? 'yes' : 'no',
      a.present   ? 'yes' : 'no',
      a.feeWaived ? 'yes' : 'no',
      a.joinedAt  || '',
    ]),
  ];
  return buildCsv(rows);
}

const ATTENDEES = [
  { name: 'Alice', email: 'alice@x.com', gender: 'woman', positions: ['setter','hitter'], paid: true,  present: true,  feeWaived: false, joinedAt: '1 Jan 2026' },
  { name: 'Bob',   email: 'bob@x.com',   gender: 'man',   positions: ['middle'],          paid: false, present: false, feeWaived: true,  joinedAt: '2 Jan 2026' },
];

{
  const csv = buildAttendeeCsv(ATTENDEES);
  assert(csv.includes('"Name","Email"'), 'header row present');
  assert(csv.includes('"Alice"'), 'Alice in CSV');
  assert(csv.includes('"setter;hitter"'), 'positions joined by semicolon');
  assert(csv.includes('"yes"'), 'paid=yes present');
  assert(csv.includes('"no"'), 'present=no present');
  console.log('PASS attendee CSV builds correctly');
}

{
  const tricky = [{ name: 'Say "hello"', email: '', gender: '', positions: [], paid: false, present: false, feeWaived: false, joinedAt: '' }];
  const csv = buildAttendeeCsv(tricky);
  assert(csv.includes('"Say ""hello"""'), 'double-quotes escaped in CSV');
  console.log('PASS double-quote escaping in CSV');
}

{
  const empty = buildAttendeeCsv([]);
  assert(empty.includes('"Name"'), 'empty attendee list still has header');
  assert(!empty.includes('Alice'), 'no data rows when empty');
  console.log('PASS empty attendee list');
}

// ─── Report CSV ─────────────────────────────────────────────────────────────
function buildReportCsv(session, report) {
  const att = report?.attendance || {};
  const st  = report?.stats      || {};
  const rev = st.revenue         || {};
  const fmt = n => n != null ? `£${Number.isInteger(n) ? n : Number(n).toFixed(2)}` : '';

  const rows = [
    ['Session report'],
    [],
    ['Venue',    session.venue || ''],
    ['Date',     session.date || ''],
    ['Coach',    session.coach || ''],
    [],
    ['Attendance'],
    ['Registered', att.registered ?? ''],
    ['Present',    att.present    ?? ''],
    ['No-shows',   att.noShows    ?? ''],
  ];
  if (rev.actual != null) {
    rows.push([], ['Revenue'], ['Expected', fmt(rev.expected)], ['Actual', fmt(rev.actual)]);
  }
  rows.push([], ['Attendees'], ['Name', 'Present', 'Gender']);
  (att.attendees || []).forEach(a => rows.push([a.name, a.present ? 'yes' : 'no', a.gender || '']));
  return buildCsv(rows);
}

const SESSION = { venue: 'Brixton Rec', date: '15 Jun 2026', coach: 'Alice', cost: 10 };
const REPORT  = {
  attendance: { registered: 8, present: 7, noShows: 1, attendees: [{ name: 'Bob', present: true, gender: 'man' }] },
  stats: { revenue: { expected: 80, actual: 70 } },
};

{
  const csv = buildReportCsv(SESSION, REPORT);
  assert(csv.includes('"Session report"'),  'title row present');
  assert(csv.includes('"Brixton Rec"'),     'venue present');
  assert(csv.includes('"£80"'),             'expected revenue present');
  assert(csv.includes('"Bob"'),             'attendee name present');
  console.log('PASS report CSV builds correctly');
}

{
  const csv = buildReportCsv({ venue: 'Gym', date: '' }, { attendance: {}, stats: {} });
  assert(csv.includes('"Session report"'), 'minimal report has title');
  assert(!csv.includes('Revenue'), 'no revenue section when no revenue data');
  console.log('PASS minimal report CSV (no revenue)');
}

console.log('\nAll export tests passed.');
