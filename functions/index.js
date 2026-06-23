'use strict';

// HTTP functions use Gen 1 to avoid Cloud Run IAM org-policy (allUsers).
// Firestore triggers use Gen 2 (Eventarc) — required for eur3 multi-region DB.
const functions = require('firebase-functions/v1');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp }            = require('firebase-admin/app');
const { getAuth }                  = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();

const STRIPE_SECRET_KEY     = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const GMAIL_APP_PASSWORD    = defineSecret('GMAIL_APP_PASSWORD');
const REGION          = 'europe-west2'; // HTTP functions
const REGION_FIRESTORE = 'europe-west1'; // must match Firestore eur3 multi-region

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function setCors(res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

async function verifyAuth(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) throw new Error('Unauthenticated');
  return getAuth().verifyIdToken(token);
}

let _stripe;
function getStripe() {
  if (!_stripe) {
    _stripe = require('stripe')(STRIPE_SECRET_KEY.value(), {
      apiVersion: '2026-05-27.dahlia',
    });
  }
  return _stripe;
}

let _transporter;
function getMailer() {
  if (!_transporter) {
    _transporter = require('nodemailer').createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'edu.pignatelli@gmail.com', pass: GMAIL_APP_PASSWORD.value() },
    });
  }
  return _transporter;
}

async function sendEmail(to, subject, html) {
  if (!to) return;
  const text = html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  try {
    await getMailer().sendMail({
      from: '"Roots Volleyball" <edu.pignatelli@gmail.com>',
      to, subject, html, text,
    });
    console.log('sendEmail ok:', subject, '->', to);
  } catch (e) {
    console.error('sendEmail failed:', e.message);
  }
}

async function _notifyWaitingList(db, sessionId, session) {
  const wlSnap = await db.collection('sessions').doc(sessionId)
    .collection('waitingList').get();
  console.log(`_notifyWaitingList: sessionId=${sessionId} wlCount=${wlSnap.size}`);
  if (wlSnap.empty) return;
  const venue   = session.venue || 'the session';
  const dateStr = _formatDate(session.date);
  const calUrl  = _calendarUrl(session);
  await Promise.all(wlSnap.docs.map(doc => {
    const a = doc.data();
    if (!a.email) return;
    return sendEmail(a.email,
      `Spot available — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
      _emailHtml(`Hi ${a.name || 'there'},`, [
        `A spot has opened up for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
        `Open the app to claim it — first come, first served.`,
      ], calUrl)
    );
  }));
}

// ── createCheckoutSession ───────────────────────────────────────────────────
exports.createCheckoutSession = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const { sessionId, successUrl, cancelUrl, positions } = req.body;
    if (!sessionId || !successUrl || !cancelUrl)
      return res.status(400).json({ error: 'Missing required fields.' });

    const db  = getFirestore();
    const uid = decoded.uid;

    const [sessionSnap, attendeeSnap] = await Promise.all([
      db.collection('sessions').doc(sessionId).get(),
      db.collection('sessions').doc(sessionId).collection('attendees').doc(uid).get(),
    ]);

    if (!sessionSnap.exists)
      return res.status(404).json({ error: 'Session not found.' });
    if (attendeeSnap.exists && attendeeSnap.data().paid)
      return res.status(409).json({ error: 'Already registered and paid.' });

    const session     = sessionSnap.data();
    const playerPrice = session.absorbFee ? (session.cost || 0) : _playerPrice(session.cost || 0);
    if (playerPrice <= 0)
      return res.status(400).json({ error: 'This session is free.' });

    let checkout;
    try {
      checkout = await getStripe().checkout.sessions.create({
        mode: 'payment',
        billing_address_collection: 'required',
        line_items: [{
          price_data: {
            currency: 'gbp',
            product_data: {
              name: [session.venue, _formatDate(session.date)].filter(Boolean).join(' — ') || 'Volleyball session',
            },
            unit_amount: Math.round(playerPrice * 100),
          },
          quantity: 1,
        }],
        customer_email: decoded.email || undefined,
        metadata: {
          sessionId,
          uid,
          refundAmountPence: String(Math.round((session.cost || 0) * 100)),
          positions: JSON.stringify(positions || []),
        },
        success_url: successUrl,
        cancel_url:  cancelUrl,
      });
    } catch (e) {
      console.error('Stripe checkout error:', e.message);
      return res.status(500).json({ error: `Payment setup failed: ${e.message}` });
    }

    return res.json({ url: checkout.url });
  });

// ── stripeWebhook ───────────────────────────────────────────────────────────
exports.stripeWebhook = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = getStripe().webhooks.constructEvent(
        req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (e) {
      console.error('Webhook signature error:', e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    if (event.type === 'account.updated') {
      const account = event.data.object;
      if (!account.charges_enabled) return res.json({ received: true });

      const db = getFirestore();
      // Find the coach user with this Stripe account
      const usersSnap = await db.collection('users')
        .where('stripeAccountId', '==', account.id).limit(1).get();
      if (usersSnap.empty) return res.json({ received: true });

      const coachDoc  = usersSnap.docs[0];
      const coachUid  = coachDoc.id;
      const coachData = coachDoc.data();

      // Find all sessions in onboarding state for this coach
      const sessionsSnap = await db.collection('sessions')
        .where('coachUid', '==', coachUid)
        .where('coachPaymentStatus', '==', 'onboarding')
        .get();
      if (sessionsSnap.empty) return res.json({ received: true });

      const stripe = getStripe();
      await Promise.all(sessionsSnap.docs.map(async sessionDoc => {
        const session  = sessionDoc.data();
        const coachFee = session.coachFee ?? 0;
        if (coachFee <= 0) return;
        try {
          await stripe.transfers.create({
            amount:      Math.round(coachFee * 100),
            currency:    'gbp',
            destination: account.id,
            description: `Coach payment — ${session.venue || sessionDoc.id}`,
          });
          await sessionDoc.ref.update({
            coachPaymentStatus: 'paid',
            coachPaidAt: FieldValue.serverTimestamp(),
          });
          const coachEmail = coachData.email || '';
          const coachName  = coachData.name  || session.coach || 'Coach';
          if (coachEmail) {
            const dateStr = _formatDate(session.date);
            await sendEmail(coachEmail,
              `Payment sent — ${session.venue || ''}${dateStr ? ` · ${dateStr}` : ''}`,
              _emailHtml(`Hi ${coachName},`, [
                `Your payment of <strong>£${coachFee.toFixed(2)}</strong> for <strong>${session.venue || 'the session'}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been sent and will arrive in your bank account within 1–2 business days.`,
              ])
            );
          }
        } catch (e) {
          console.error(`Transfer failed for session ${sessionDoc.id}:`, e.message);
          // Notify all admins
          const adminsSnap = await db.collection('admins').get();
          const venue   = session.venue || 'the session';
          const dateStr = _formatDate(session.date);
          await Promise.all(adminsSnap.docs.map(doc =>
            sendEmail(doc.id,
              `Coach payment failed — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
              _emailHtml('Hi,', [
                `The automatic coach payment of <strong>£${coachFee.toFixed(2)}</strong> for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} could not be processed due to insufficient funds.`,
                `Please top up the Roots Volleyball Stripe account and approve the payment manually from the app.`,
              ])
            )
          ));
        }
      }));

      return res.json({ received: true });
    }

    if (event.type === 'checkout.session.completed') {
      const checkout        = event.data.object;
      const { sessionId, uid, refundAmountPence, positions: positionsMeta } = checkout.metadata;
      const sessionPositions = positionsMeta ? JSON.parse(positionsMeta) : [];
      const paymentIntentId = checkout.payment_intent;

      const db          = getFirestore();
      const sessionRef  = db.collection('sessions').doc(sessionId);
      const attendeeRef = sessionRef.collection('attendees').doc(uid);
      const userDoc     = await db.collection('users').doc(uid).get();
      const u           = userDoc.exists ? userDoc.data() : {};

      const sessionSnap = await sessionRef.get();
      const session     = sessionSnap.exists ? sessionSnap.data() : {};

      await db.runTransaction(async t => {
        const existing = await t.get(attendeeRef);
        if (existing.exists && existing.data().paid) {
          console.log(`stripeWebhook: skipping duplicate paid registration uid=${uid} sessionId=${sessionId}`);
          return;
        }

        const isNew = !existing.exists;
        t.set(attendeeRef, {
          name:              u.name  || checkout.customer_details?.name  || '',
          email:             u.email || checkout.customer_details?.email || '',
          address:           checkout.customer_details?.address || null,
          gender:            u.gender    || null,
          positions:         sessionPositions.length ? sessionPositions : (u.positions || []),
          present:           false,
          paid:              true,
          feeWaived:         false,
          paymentIntentId,
          refundAmountPence: parseInt(refundAmountPence, 10) || 0,
          paidAt:            FieldValue.serverTimestamp(),
          joinedAt:          existing.exists ? existing.data().joinedAt : FieldValue.serverTimestamp(),
        }, { merge: true });

        if (isNew) t.update(sessionRef, { attendeeCount: FieldValue.increment(1) });
      });

      // Write session history entry and increment session count for the user
      await db.collection('users').doc(uid).collection('sessions').doc(sessionId).set({
        sessionId,
        date:     session.date   || null,
        venue:    session.venue  || '',
        level:    session.level  || '',
        cost:     (checkout.amount_total || 0) / 100,
        paid:     true,
        feeWaived: false,
        joinedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (isNew) {
        await db.collection('users').doc(uid).update({ sessionCount: FieldValue.increment(1) }).catch(() => {});
      }

      // Remove from waiting list if they paid after being on it
      const wlRef = sessionRef.collection('waitingList').doc(uid);
      const wlEntry = await wlRef.get();
      if (wlEntry.exists) {
        await db.runTransaction(async t => {
          t.delete(wlRef);
          t.update(sessionRef, { waitingListCount: FieldValue.increment(-1) });
        });
      }

      const email    = u.email || checkout.customer_details?.email;
      const name     = u.name  || checkout.customer_details?.name || 'there';
      const amount   = ((checkout.amount_total || parseInt(refundAmountPence, 10)) / 100).toFixed(2);
      const dateStr  = _formatDate(session.date);
      const venue    = session.venue || 'the session';
      const calUrl   = _calendarUrl(session);
      await sendEmail(email,
        `Payment confirmed — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
        _emailHtml(`Hi ${name},`, [
          `Your payment of <strong>£${amount}</strong> has been confirmed.`,
          `You're registered for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
          `See you on the court!`,
        ], calUrl)
      );
    }

    res.json({ received: true });
  });

// ── cancelAttendeeAndRefund ─────────────────────────────────────────────────
exports.cancelAttendeeAndRefund = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY, GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId.' });

    const uid = decoded.uid;
    const db  = getFirestore();

    const [sessionSnap, attendeeSnap] = await Promise.all([
      db.collection('sessions').doc(sessionId).get(),
      db.collection('sessions').doc(sessionId).collection('attendees').doc(uid).get(),
    ]);

    if (!sessionSnap.exists)  return res.status(404).json({ error: 'Session not found.' });
    if (!attendeeSnap.exists) return res.status(404).json({ error: 'Registration not found.' });

    const session  = sessionSnap.data();
    const attendee = attendeeSnap.data();

    const within24h = session.date && (() => {
      const sessionDate = session.date.toDate ? session.date.toDate() : new Date(session.date);
      return (sessionDate - Date.now()) / 36e5 < 24;
    })();

    let refunded = false;
    if (!within24h && attendee.paid && attendee.paymentIntentId) {
      const refundPence = attendee.refundAmountPence || 0;
      if (refundPence > 0) {
        await getStripe().refunds.create({
          payment_intent: attendee.paymentIntentId,
          amount:         refundPence,
        });
        refunded = true;
      }
    }

    const sessionRef  = db.collection('sessions').doc(sessionId);
    const attendeeRef = sessionRef.collection('attendees').doc(uid);
    await db.runTransaction(async t => {
      t.delete(attendeeRef);
      t.update(sessionRef, { attendeeCount: FieldValue.increment(-1) });
      if (refunded) {
        t.update(sessionRef, {
          refunds: FieldValue.arrayUnion({
            uid,
            name:         attendee.name  || '',
            email:        attendee.email || '',
            amountPence:  attendee.refundAmountPence || 0,
            refundedAt:   new Date().toISOString(),
          }),
        });
      }
    });

    // Remove session history entry and decrement session count
    await db.collection('users').doc(uid).collection('sessions').doc(sessionId).delete();
    await db.collection('users').doc(uid).update({ sessionCount: FieldValue.increment(-1) }).catch(() => {});

    const email   = decoded.email || attendee.email;
    const name    = attendee.name || 'there';
    const venue   = session.venue || 'the session';
    const dateStr = _formatDate(session.date);
    const refundNote = refunded
      ? `A refund of <strong>£${(attendee.refundAmountPence / 100).toFixed(2)}</strong> has been issued and should appear within 5–10 business days.`
      : within24h && attendee.paid
        ? `As this is within 24 hours of the session, no refund will be issued.`
        : '';
    await sendEmail(email,
      `Registration cancelled — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
      _emailHtml(`Hi ${name},`, [
        `Your registration for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been cancelled.`,
        refundNote,
      ].filter(Boolean))
    );

    await _notifyWaitingList(db, sessionId, session);

    return res.json({ refunded });
  });

// ── onSessionCancelled — notify all attendees when admin cancels a session ──
exports.onSessionCancelled = onDocumentUpdated({
  document:  'sessions/{sessionId}',
  region:    REGION_FIRESTORE,
  secrets:   [GMAIL_APP_PASSWORD],
}, async (event) => {
  const before = event.data.before.data();
  const after  = event.data.after.data();
  if (before.status === after.status || after.status !== 'cancelled') return;

  const db        = getFirestore();
  const venue     = after.venue || 'the session';
  const dateStr   = _formatDate(after.date);
  const attendees = await db
    .collection('sessions').doc(event.params.sessionId)
    .collection('attendees').get();

  await Promise.all(attendees.docs.map(doc => {
    const a = doc.data();
    if (!a.email) return;
    return sendEmail(a.email,
      `Session cancelled — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
      _emailHtml(`Hi ${a.name || 'there'},`, [
        `Unfortunately <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been cancelled.`,
        a.paid && a.refundAmountPence > 0
          ? `A refund of <strong>£${(a.refundAmountPence / 100).toFixed(2)}</strong> will be processed automatically.`
          : '',
        `Apologies for the inconvenience.`,
      ].filter(Boolean))
    );
  }));

  // Also notify waiting list that the session is gone
  const wlSnap = await db.collection('sessions').doc(event.params.sessionId)
    .collection('waitingList').get();
  await Promise.all(wlSnap.docs.map(doc => {
    const a = doc.data();
    if (!a.email) return;
    return sendEmail(a.email,
      `Session cancelled — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
      _emailHtml(`Hi ${a.name || 'there'},`, [
        `Unfortunately <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been cancelled.`,
        `Your place on the waiting list has been removed.`,
      ])
    );
  }));
});

// ── onAttendeeJoined — registration confirmation for free sessions ───────────
exports.onAttendeeJoined = onDocumentCreated({
  document:  'sessions/{sessionId}/attendees/{uid}',
  region:    REGION_FIRESTORE,
  secrets:   [GMAIL_APP_PASSWORD],
}, async (event) => {
  const attendee = event.data.data();
  if (attendee.paid) return; // paid sessions get confirmation from stripeWebhook
  if (!attendee.email) return;

  const db         = getFirestore();
  const sessionId  = event.params.sessionId;
  const uid        = event.params.uid;
  const sessionDoc = await db.collection('sessions').doc(sessionId).get();
  if (!sessionDoc.exists) return;
  const session = sessionDoc.data();

  // Remove from waiting list if they were on it
  const wlRef = db.collection('sessions').doc(sessionId).collection('waitingList').doc(uid);
  const wlEntry = await wlRef.get();
  if (wlEntry.exists) {
    await db.runTransaction(async t => {
      t.delete(wlRef);
      t.update(db.collection('sessions').doc(sessionId), { waitingListCount: FieldValue.increment(-1) });
    });
  }

  const venue   = session.venue || 'the session';
  const dateStr = _formatDate(session.date);
  const calUrl = _calendarUrl(session);
  await sendEmail(attendee.email,
    `You're in — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
    _emailHtml(`Hi ${attendee.name || 'there'},`, [
      `You're registered for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
      `See you on the court!`,
    ], calUrl)
  );
});

// ── removeAttendeeAdmin ──────────────────────────────────────────────────────
exports.removeAttendeeAdmin = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const db = getFirestore();
    const [callerDoc, adminDoc] = await Promise.all([
      db.collection('users').doc(decoded.uid).get(),
      db.collection('admins').doc(decoded.email || '').get(),
    ]);
    const isAdmin = (callerDoc.data()?.roles || []).includes('admin') || adminDoc.exists;
    if (!isAdmin) return res.status(403).json({ error: 'Admin only.' });

    const { sessionId, uid } = req.body;
    if (!sessionId || !uid) return res.status(400).json({ error: 'Missing sessionId or uid.' });

    const sessionRef  = db.collection('sessions').doc(sessionId);
    const attendeeRef = sessionRef.collection('attendees').doc(uid);
    const [sessionSnap, attendeeSnap] = await Promise.all([sessionRef.get(), attendeeRef.get()]);
    if (!sessionSnap.exists)  return res.status(404).json({ error: 'Session not found.' });
    if (!attendeeSnap.exists) return res.status(404).json({ error: 'Attendee not found.' });

    const session  = sessionSnap.data();
    const attendee = attendeeSnap.data();

    await db.runTransaction(async t => {
      t.delete(attendeeRef);
      t.update(sessionRef, { attendeeCount: FieldValue.increment(-1) });
    });

    // Remove session history entry and decrement session count
    await db.collection('users').doc(uid).collection('sessions').doc(sessionId).delete();
    await db.collection('users').doc(uid).update({ sessionCount: FieldValue.increment(-1) }).catch(() => {});

    const venue   = session.venue || 'the session';
    const dateStr = _formatDate(session.date);
    await sendEmail(attendee.email,
      `Registration removed — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
      _emailHtml(`Hi ${attendee.name || 'there'},`, [
        `Your registration for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been removed by an admin.`,
        `If you have any questions, please contact the organiser.`,
      ])
    );

    await _notifyWaitingList(db, sessionId, session);

    return res.json({ ok: true });
  });

// ── onSessionUpdated — notify attendees when venue / date / time / cost changes
exports.onSessionUpdated = onDocumentUpdated({
  document:  'sessions/{sessionId}',
  region:    REGION_FIRESTORE,
  secrets:   [GMAIL_APP_PASSWORD],
}, async (event) => {
  const before = event.data.before.data();
  const after  = event.data.after.data();

  if (after.status === 'cancelled') return; // handled by onSessionCancelled

  const db = getFirestore();

  // ── session just closed → flag coach payment pending and email admins ──
  if (before.status !== 'closed' && after.status === 'closed') {
    const coachFee = after.coachFee ?? 0;
    const hasCoach = !!(after.coachUid || after.coach);
    if (hasCoach && coachFee > 0) {
      await db.collection('sessions').doc(event.params.sessionId)
        .update({ coachPaymentStatus: 'pending' });

      const adminsSnap = await db.collection('admins').get();
      const venue   = after.venue  || 'the session';
      const dateStr = _formatDate(after.date);
      const subject = `Coach payment pending — ${venue}${dateStr ? ` · ${dateStr}` : ''}`;
      const appUrl  = `https://epignatelli.github.io/apps/vb-sessions/`;
      await Promise.all(adminsSnap.docs.map(doc =>
        sendEmail(doc.id, subject,
          _emailHtml('Hi,', [
            `The session <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has closed.`,
            `Coach: <strong>${after.coach || 'TBC'}</strong> · Fee: <strong>£${Number(coachFee).toFixed(2)}</strong>`,
            `Open the app to approve the payment.`,
          ], null, appUrl, 'Open app →')
        )
      ));
    }
    return;
  }

  const venueChanged = before.venue !== after.venue;
  const dateChanged  = String(before.date?.toMillis?.() ?? '') !== String(after.date?.toMillis?.() ?? '');
  const timeChanged  = before.time  !== after.time;
  const costChanged  = before.cost  !== after.cost;

  if (!venueChanged && !dateChanged && !timeChanged && !costChanged) return;

  const venue     = after.venue || 'the session';
  const dateStr   = _formatDate(after.date);
  const attendees = await db
    .collection('sessions').doc(event.params.sessionId)
    .collection('attendees').get();
  if (!attendees.size) return;

  const changes = [
    venueChanged ? `Venue: <strong>${after.venue || '(removed)'}</strong>` : '',
    dateChanged  ? `Date: <strong>${dateStr || '(updated)'}</strong>` : '',
    timeChanged  ? `Time: <strong>${after.time || '(updated)'}</strong>` : '',
    costChanged  ? `Cost: <strong>${after.cost ? `£${after.cost.toFixed(2).replace(/\.00$/, '')}` : 'Free'}</strong>` : '',
  ].filter(Boolean);

  const calUrl = _calendarUrl(after);

  await Promise.all(attendees.docs.map(doc => {
    const a = doc.data();
    if (!a.email) return;
    return sendEmail(a.email,
      `Session updated — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
      _emailHtml(`Hi ${a.name || 'there'},`, [
        `Details have changed for <strong>${venue}</strong>:`,
        changes.join('<br>'),
        `Please make a note of the changes.`,
      ], calUrl)
    );
  }));
});

// ── deleteSessionAdmin ───────────────────────────────────────────────────────
exports.deleteSessionAdmin = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const db = getFirestore();
    const [callerDoc, adminDoc] = await Promise.all([
      db.collection('users').doc(decoded.uid).get(),
      db.collection('admins').doc(decoded.email || '').get(),
    ]);
    const isAdmin = (callerDoc.data()?.roles || []).includes('admin') || adminDoc.exists;
    if (!isAdmin) return res.status(403).json({ error: 'Admin only.' });

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId.' });

    const sessionRef   = db.collection('sessions').doc(sessionId);
    const sessionSnap  = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ error: 'Session not found.' });

    const session   = sessionSnap.data();
    const venue     = session.venue || 'the session';
    const dateStr   = _formatDate(session.date);
    const [attendeesSnap, wlSnap] = await Promise.all([
      sessionRef.collection('attendees').get(),
      sessionRef.collection('waitingList').get(),
    ]);

    // Notify attendees
    await Promise.all(attendeesSnap.docs.map(doc => {
      const a = doc.data();
      if (!a.email) return;
      return sendEmail(a.email,
        `Session deleted — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
        _emailHtml(`Hi ${a.name || 'there'},`, [
          `<strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been deleted.`,
          a.paid && a.refundAmountPence > 0
            ? `A refund of <strong>£${(a.refundAmountPence / 100).toFixed(2)}</strong> will be processed automatically.`
            : '',
          `Apologies for the inconvenience.`,
        ].filter(Boolean))
      );
    }));

    // Delete subcollections and session
    const batch = db.batch();
    attendeesSnap.docs.forEach(d => batch.delete(d.ref));
    wlSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(sessionRef);
    await batch.commit();

    return res.json({ ok: true });
  });

// ── joinWaitingList ──────────────────────────────────────────────────────────
exports.joinWaitingList = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId.' });

    const db         = getFirestore();
    const auth       = getAuth();
    const sessionRef = db.collection('sessions').doc(sessionId);

    const [sessionSnap, userDoc, userRecord] = await Promise.all([
      sessionRef.get(),
      db.collection('users').doc(decoded.uid).get(),
      auth.getUser(decoded.uid),
    ]);

    if (!sessionSnap.exists) return res.status(404).json({ error: 'Session not found.' });
    const session = sessionSnap.data();
    const u       = userDoc.exists ? userDoc.data() : {};
    const name    = u.name  || userRecord.displayName || 'there';
    const email   = u.email || userRecord.email;

    const wlRef   = sessionRef.collection('waitingList').doc(decoded.uid);
    const existing = await wlRef.get();
    if (existing.exists) return res.status(400).json({ error: 'Already on waiting list.' });

    await db.runTransaction(async t => {
      t.set(wlRef, { uid: decoded.uid, name, email, gender: u.gender || null, positions: u.positions || [], joinedAt: FieldValue.serverTimestamp() });
      t.update(sessionRef, { waitingListCount: FieldValue.increment(1) });
    });

    const wlSnap   = await sessionRef.collection('waitingList').orderBy('joinedAt', 'asc').get();
    const position = wlSnap.docs.findIndex(d => d.id === decoded.uid) + 1;

    const venue   = session.venue || 'the session';
    const dateStr = _formatDate(session.date);
    await sendEmail(email,
      `You're on the waiting list — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
      _emailHtml(`Hi ${name},`, [
        `You're <strong>#${position}</strong> on the waiting list for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
        `We'll email you if a spot opens up.`,
      ])
    );

    return res.json({ ok: true, position });
  });

// ── leaveWaitingList ─────────────────────────────────────────────────────────
exports.leaveWaitingList = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId.' });

    const db     = getFirestore();
    const wlRef  = db.collection('sessions').doc(sessionId).collection('waitingList').doc(decoded.uid);
    const entry  = await wlRef.get();
    if (!entry.exists) return res.status(404).json({ error: 'Not on waiting list.' });

    await db.runTransaction(async t => {
      t.delete(wlRef);
      t.update(db.collection('sessions').doc(sessionId), { waitingListCount: FieldValue.increment(-1) });
    });

    return res.json({ ok: true });
  });

// ── approveCoachPayment ──────────────────────────────────────────────────────
exports.approveCoachPayment = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY, GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const db = getFirestore();
    const adminDoc = await db.collection('admins').doc(decoded.email || '').get();
    if (!adminDoc.exists) return res.status(403).json({ error: 'Admins only.' });

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId.' });

    const sessionSnap = await db.collection('sessions').doc(sessionId).get();
    if (!sessionSnap.exists) return res.status(404).json({ error: 'Session not found.' });

    const session = sessionSnap.data();
    if (session.coachPaymentStatus === 'paid') return res.json({ ok: true, status: 'paid' });

    const coachFee = session.coachFee ?? 0;
    if (!coachFee || coachFee <= 0) return res.status(400).json({ error: 'No coach fee set.' });
    if (!session.coachUid) return res.status(400).json({ error: 'No coach assigned.' });

    // Look up coach's Stripe account
    const coachUserSnap = await db.collection('users').doc(session.coachUid).get();
    const coachUser     = coachUserSnap.exists ? coachUserSnap.data() : {};
    const coachEmail    = coachUser.email || '';
    const coachName     = coachUser.name  || session.coach || 'Coach';

    if (coachUser.stripeAccountId) {
      // Coach has Stripe — transfer immediately
      const stripe  = getStripe();
      const dateStr = _formatDate(session.date);
      const venue   = session.venue || 'the session';
      try {
        await stripe.transfers.create({
          amount:      Math.round(coachFee * 100),
          currency:    'gbp',
          destination: coachUser.stripeAccountId,
          description: `Coach payment — ${venue}`,
        });
      } catch (stripeErr) {
        console.error('Transfer failed:', stripeErr.message);
        // Notify the approving admin — don't expose Stripe errors to the coach
        await sendEmail(decoded.email,
          `Coach payment failed — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
          _emailHtml('Hi,', [
            `The coach payment of <strong>£${coachFee.toFixed(2)}</strong> for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} could not be processed due to insufficient funds.`,
            `Please top up the Roots Volleyball Stripe account and try again from the app.`,
          ])
        );
        return res.status(502).json({ error: 'Insufficient funds — the payment could not be processed. An email has been sent to you.' });
      }
      await db.collection('sessions').doc(sessionId)
        .update({ coachPaymentStatus: 'paid', coachPaidAt: FieldValue.serverTimestamp() });
      if (coachEmail) {
        await sendEmail(coachEmail,
          `Payment sent — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
          _emailHtml(`Hi ${coachName},`, [
            `Your payment of <strong>£${coachFee.toFixed(2)}</strong> for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been approved and will arrive in your bank account within 1–2 business days.`,
          ])
        );
      }
      return res.json({ ok: true, status: 'paid' });
    } else {
      // Coach has no Stripe — create account and send onboarding link
      const stripe = getStripe();
      const account = await stripe.accounts.create({
        type:    'express',
        country: 'GB',
        email:   coachEmail || undefined,
        capabilities: { transfers: { requested: true } },
      });
      await db.collection('users').doc(session.coachUid)
        .update({ stripeAccountId: account.id });

      const accountLink = await stripe.accountLinks.create({
        account:     account.id,
        refresh_url: `https://epignatelli.github.io/apps/vb-sessions/`,
        return_url:  `https://epignatelli.github.io/apps/vb-sessions/`,
        type:        'account_onboarding',
      });
      await db.collection('sessions').doc(sessionId)
        .update({ coachPaymentStatus: 'onboarding' });

      if (coachEmail) {
        const dateStr = _formatDate(session.date);
        await sendEmail(coachEmail,
          `Action required: set up payments to receive your coaching fee`,
          _emailHtml(`Hi ${coachName},`, [
            `You have a pending coach payment of <strong>£${coachFee.toFixed(2)}</strong> for <strong>${session.venue || 'a session'}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
            `To receive this payment, please set up your bank account with our payment provider. It only takes a few minutes.`,
          ], null, accountLink.url, 'Set up payments →')
        );
      }
      return res.json({ ok: true, status: 'onboarding' });
    }
  });

// ── messageSessionAttendees ──────────────────────────────────────────────────
exports.messageSessionAttendees = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const db = getFirestore();
    const [callerDoc, adminDoc] = await Promise.all([
      db.collection('users').doc(decoded.uid).get(),
      db.collection('admins').doc(decoded.email || '').get(),
    ]);
    const isAdmin = (callerDoc.data()?.roles || []).includes('admin') || adminDoc.exists;
    if (!isAdmin) return res.status(403).json({ error: 'Admin only.' });

    const { sessionId, subject, body } = req.body;
    if (!sessionId || !subject || !body)
      return res.status(400).json({ error: 'Missing sessionId, subject, or body.' });

    const sessionRef  = db.collection('sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ error: 'Session not found.' });

    const session       = sessionSnap.data();
    const attendeesSnap = await sessionRef.collection('attendees').get();

    await Promise.all(attendeesSnap.docs.map(doc => {
      const a = doc.data();
      if (!a.email) return;
      return sendEmail(a.email, subject,
        _emailHtml(`Hi ${a.name || 'there'},`, [body])
      );
    }));

    await sessionRef.update({
      messages: FieldValue.arrayUnion({
        sentAt:   new Date().toISOString(),
        sentBy:   decoded.email || decoded.uid,
        subject,
        body,
      }),
    });

    return res.json({ ok: true, sent: attendeesSnap.size });
  });

// ── notifyCoachRequest ───────────────────────────────────────────────────────
exports.notifyCoachRequest = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const { uid, name } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing uid.' });

    const db         = getFirestore();
    const adminsSnap = await db.collection('admins').get();
    const appUrl     = 'https://epignatelli.github.io/apps/vb-sessions/#users';

    const safeName = (name || uid || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await Promise.all(adminsSnap.docs.map(doc =>
      sendEmail(doc.id,
        `Coach request from ${safeName}`,
        _emailHtml('Hi,', [
          `<strong>${safeName}</strong> has requested to be listed as a coach.`,
          'Review and approve or reject the request from the Users screen.',
        ], null, appUrl, 'Go to Users →')
      )
    ));

    return res.json({ ok: true });
  });

// ── notifyAdminRequest ───────────────────────────────────────────────────────
exports.notifyAdminRequest = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const { uid, name } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing uid.' });

    const db          = getFirestore();
    const usersSnap   = await db.collection('users').get();
    const ownerEmails = usersSnap.docs
      .filter(d => (d.data().roles || []).includes('owner'))
      .map(d => d.data().email)
      .filter(Boolean);

    const nominator  = decoded.email || 'An admin';
    const safeName   = (name || uid || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const appUrl     = 'https://epignatelli.github.io/apps/vb-sessions/#users';

    await Promise.all(ownerEmails.map(email =>
      sendEmail(email,
        `Admin nomination: ${safeName}`,
        _emailHtml('Hi,', [
          `${nominator} has nominated <strong>${safeName}</strong> to become an Admin.`,
          'As an Owner, you can approve or reject this from the Users screen.',
        ], null, appUrl, 'Go to Users →')
      )
    ));

    return res.json({ ok: true });
  });

// ── removeUser ───────────────────────────────────────────────────────────────
exports.removeUser = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: e.message }); }

    const db         = getFirestore();
    const callerDoc  = await db.collection('users').doc(decoded.uid).get();
    const callerData = callerDoc.data() || {};
    const callerRoles = callerData.roles || [];
    const isAdmin    = callerRoles.includes('admin') || callerRoles.includes('owner')
                       || (await db.collection('admins').doc(decoded.email || '').get()).exists;
    if (!isAdmin) return res.status(403).json({ error: 'Admins only.' });

    const { uid } = req.body;
    if (!uid)                return res.status(400).json({ error: 'Missing uid.' });
    if (uid === decoded.uid) return res.status(400).json({ error: 'Cannot remove yourself.' });

    // Owners can remove anyone except other owners; admins cannot remove admins/owners.
    const targetDoc   = await db.collection('users').doc(uid).get();
    const targetRoles = targetDoc.data()?.roles || [];
    const callerIsOwner = callerRoles.includes('owner');
    if (targetRoles.includes('owner')) return res.status(403).json({ error: 'Cannot remove an owner.' });
    if (!callerIsOwner && (targetRoles.includes('admin'))) {
      return res.status(403).json({ error: 'Only owners can remove admins.' });
    }

    await db.collection('users').doc(uid).delete();
    try { await getAuth().deleteUser(uid); } catch(_) {}

    return res.json({ ok: true });
  });

// ── Helpers ─────────────────────────────────────────────────────────────────
function _playerPrice(adminPrice) {
  if (!adminPrice || adminPrice <= 0) return 0;
  const gross = (adminPrice + 0.20) / (1 - 0.015);
  return Math.ceil(gross / 0.50) * 0.50;
}

function _formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function _calendarUrl(session) {
  if (!session?.date) return null;
  const d   = session.date.toDate ? session.date.toDate() : new Date(session.date);
  const pad = n => String(n).padStart(2, '0');
  const [h = 10, m = 0] = (session.time || '10:00').split(':').map(Number);
  const start = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(h)}${pad(m)}00`;
  const end   = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(h + 2)}${pad(m)}00`;
  const title = encodeURIComponent(['Roots Volleyball', session.venue].filter(Boolean).join(' — '));
  const loc   = encodeURIComponent(session.venue || '');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${start}/${end}&location=${loc}`;
}

function _emailHtml(greeting, paragraphs, calendarUrl = null, ctaUrl = null, ctaLabel = null) {
  const body = paragraphs.map(p => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const cal  = calendarUrl
    ? `<p style="margin:20px 0 0"><a href="${calendarUrl}" style="display:inline-block;padding:10px 18px;background:#f5a623;color:#0f1117;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px">Add to Google Calendar →</a></p>`
    : '';
  const cta  = ctaUrl
    ? `<p style="margin:20px 0 0"><a href="${ctaUrl}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px">${ctaLabel || 'Open →'}</a></p>`
    : '';
  const policyUrl = 'https://epignatelli.github.io/volleyball-teams-maker/vb-sessions/';
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
<p style="margin:0 0 12px">${greeting}</p>
${body}${cal}${cta}
<p style="margin:24px 0 0;font-size:12px;color:#888">Roots Volleyball · <a href="${policyUrl}" style="color:#888">Terms &amp; cancellation policy</a></p>
</body></html>`;
}
