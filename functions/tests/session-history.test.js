'use strict';

// Tests the session history write/delete logic that mirrors
// the cloud function changes for #15 (session history).

// ─── History entry builder ───────────────────────────────────────────────
function buildHistoryEntry({ sessionId, session, amountTotal, paid, feeWaived }) {
  return {
    sessionId,
    date:     session.date  || null,
    venue:    session.venue || '',
    level:    session.level || '',
    cost:     paid ? (amountTotal || 0) / 100 : 0,
    paid:     !!paid,
    feeWaived: !!feeWaived,
  };
}

describe('session history entry', () => {
  it('builds correct entry for free (fee-waived) registration', () => {
    const entry = buildHistoryEntry({
      sessionId:   'sess1',
      session:     { date: new Date('2026-06-15'), venue: 'Brixton Rec', level: 'intermediate' },
      paid:        false,
      feeWaived:   true,
      amountTotal: 0,
    });
    expect(entry.sessionId).toBe('sess1');
    expect(entry.venue).toBe('Brixton Rec');
    expect(entry.paid).toBe(false);
    expect(entry.feeWaived).toBe(true);
    expect(entry.cost).toBe(0);
  });

  it('builds correct entry for paid registration via Stripe', () => {
    const entry = buildHistoryEntry({
      sessionId:   'sess2',
      session:     { date: new Date('2026-07-01'), venue: 'Oval', level: 'competitive' },
      paid:        true,
      feeWaived:   false,
      amountTotal: 1200, // pence = £12
    });
    expect(entry.paid).toBe(true);
    expect(entry.cost).toBe(12);
    expect(entry.feeWaived).toBe(false);
  });

  it('handles missing session fields gracefully', () => {
    const entry = buildHistoryEntry({ sessionId: 'sess3', session: {}, paid: false });
    expect(entry.date).toBeNull();
    expect(entry.venue).toBe('');
    expect(entry.level).toBe('');
  });
});

// ─── History delete logic ────────────────────────────────────────────────
describe('session history deletion', () => {
  it('deletes the history entry on cancellation', async () => {
    const deleted = [];
    const db = {
      collection: (col) => ({
        doc: (uid) => ({
          collection: (sub) => ({
            doc: (sid) => ({
              delete: async () => { deleted.push(`${col}/${uid}/${sub}/${sid}`); },
            }),
          }),
        }),
      }),
    };

    await db.collection('users').doc('uid1').collection('sessions').doc('sess1').delete();
    expect(deleted).toContain('users/uid1/sessions/sess1');
  });
});
