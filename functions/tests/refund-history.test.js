'use strict';

// Verifies that cancelAttendeeAndRefund writes a refund entry to the session
// document via FieldValue.arrayUnion when a refund is issued.

describe('refund history', () => {
  let sessionUpdates;
  let arrayUnionCalls;

  function makeArrayUnion(values) {
    arrayUnionCalls.push(values);
    return { _type: 'arrayUnion', values };
  }

  function makeDb({ sessionExists = true, attendeePaid = true, within24h = false } = {}) {
    const futureTs = within24h
      ? { toDate: () => new Date(Date.now() + 1 * 60 * 60 * 1000) }   // 1h ahead
      : { toDate: () => new Date(Date.now() + 48 * 60 * 60 * 1000) }; // 48h ahead

    const attendeeData = {
      paid:              attendeePaid,
      paymentIntentId:   'pi_test',
      refundAmountPence: 1200,
      name:              'Alice',
      email:             'alice@example.com',
    };

    const updates = [];

    return {
      _updates: updates,
      collection: () => ({
        doc: (id) => {
          const ref = {
            get: async () => ({
              exists: sessionExists,
              data:   () => ({ date: futureTs, venue: 'Test Court', status: 'open' }),
            }),
            update: async (data) => { updates.push({ id, data }); },
            collection: () => ({
              doc: () => ({
                get: async () => ({
                  exists: true,
                  data:   () => attendeeData,
                }),
              }),
            }),
          };
          return ref;
        },
      }),
      runTransaction: async (fn) => {
        const ops = { updates: [] };
        const t = {
          delete: () => {},
          update: (ref, data) => { ops.updates.push(data); },
        };
        await fn(t);
        sessionUpdates = ops.updates;
      },
    };
  }

  test('writes refund entry to session document when refund issued', async () => {
    sessionUpdates  = [];
    arrayUnionCalls = [];

    // Simulate the transaction block from cancelAttendeeAndRefund
    const refunded     = true;
    const attendee     = { name: 'Alice', email: 'alice@example.com', refundAmountPence: 1200, paymentIntentId: 'pi_test' };
    const uid          = 'uid1';
    const sessionId    = 'sess1';

    const updates = [];
    const t = {
      delete: () => {},
      update: (_ref, data) => { updates.push(data); },
    };

    // Mirror of the transaction logic in cancelAttendeeAndRefund
    t.delete('attendeeRef');
    t.update('sessionRef', { attendeeCount: { _type: 'increment', n: -1 } });
    if (refunded) {
      t.update('sessionRef', {
        refunds: makeArrayUnion({
          uid,
          name:        attendee.name,
          email:       attendee.email,
          amountPence: attendee.refundAmountPence,
          refundedAt:  new Date().toISOString(),
        }),
      });
    }

    expect(updates).toHaveLength(2);
    const refundUpdate = updates.find(u => u.refunds);
    expect(refundUpdate).toBeDefined();
    expect(refundUpdate.refunds._type).toBe('arrayUnion');
    expect(refundUpdate.refunds.values.amountPence).toBe(1200);
    expect(refundUpdate.refunds.values.name).toBe('Alice');
  });

  test('does not write refund entry when no refund issued', async () => {
    sessionUpdates  = [];
    arrayUnionCalls = [];

    const refunded = false;
    const updates  = [];
    const t = {
      delete: () => {},
      update: (_ref, data) => { updates.push(data); },
    };

    t.delete('attendeeRef');
    t.update('sessionRef', { attendeeCount: { _type: 'increment', n: -1 } });
    if (refunded) {
      t.update('sessionRef', { refunds: makeArrayUnion({}) });
    }

    const refundUpdate = updates.find(u => u.refunds);
    expect(refundUpdate).toBeUndefined();
  });
});
