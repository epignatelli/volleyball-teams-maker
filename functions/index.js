'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }                  = require('firebase-functions/params');
const { initializeApp }                 = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');

initializeApp();

const STRIPE_SECRET_KEY    = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const REGION = 'europe-west2';

// Lazy Stripe initializer — secrets are not available at module load time.
let _stripe;
function getStripe() {
  if (!_stripe) {
    _stripe = require('stripe')(STRIPE_SECRET_KEY.value(), {
      apiVersion: '2026-05-27.dahlia',
    });
  }
  return _stripe;
}

// ── createCheckoutSession ───────────────────────────────────────────────────
// Called by the client when a player joins a paid session.
// Returns a Stripe Checkout URL; client redirects there.
exports.createCheckoutSession = onCall(
  { region: REGION, secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

    const { sessionId, successUrl, cancelUrl } = request.data;
    if (!sessionId || !successUrl || !cancelUrl)
      throw new HttpsError('invalid-argument', 'Missing required fields.');

    const db  = getFirestore();
    const uid = request.auth.uid;

    const [sessionSnap, attendeeSnap] = await Promise.all([
      db.collection('sessions').doc(sessionId).get(),
      db.collection('sessions').doc(sessionId).collection('attendees').doc(uid).get(),
    ]);

    if (!sessionSnap.exists) throw new HttpsError('not-found', 'Session not found.');
    if (attendeeSnap.exists && attendeeSnap.data().paid)
      throw new HttpsError('already-exists', 'Already registered and paid.');

    const session     = sessionSnap.data();
    const playerPrice = _playerPrice(session.cost || 0);
    if (playerPrice <= 0)
      throw new HttpsError('invalid-argument', 'This session is free — no payment needed.');

    const stripe = getStripe();
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
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
      customer_email: request.auth.token.email || undefined,
      metadata: {
        sessionId,
        uid,
        // Store the base cost (pence) so the webhook knows how much to refund.
        refundAmountPence: String(Math.round((session.cost || 0) * 100)),
      },
      success_url: successUrl,
      cancel_url:  cancelUrl,
    });

    return { url: checkout.url };
  }
);

// ── stripeWebhook ───────────────────────────────────────────────────────────
// Stripe calls this after a successful payment.
// Creates the attendee doc and increments attendeeCount.
exports.stripeWebhook = onRequest(
  { region: REGION, secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
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

    if (event.type === 'checkout.session.completed') {
      const checkout = event.data.object;
      const { sessionId, uid, refundAmountPence } = checkout.metadata;
      const paymentIntentId = checkout.payment_intent;

      const db           = getFirestore();
      const sessionRef   = db.collection('sessions').doc(sessionId);
      const attendeeRef  = sessionRef.collection('attendees').doc(uid);
      const userDoc      = await db.collection('users').doc(uid).get();
      const u            = userDoc.exists ? userDoc.data() : {};

      await db.runTransaction(async t => {
        const existing = await t.get(attendeeRef);
        if (existing.exists && existing.data().paid) return; // idempotent

        const isNew = !existing.exists;
        t.set(attendeeRef, {
          name:               u.name  || checkout.customer_details?.name  || '',
          email:              u.email || checkout.customer_details?.email || '',
          gender:             u.gender    || null,
          positions:          u.positions || [],
          present:            false,
          paid:               true,
          paymentIntentId,
          refundAmountPence:  parseInt(refundAmountPence, 10) || 0,
          paidAt:             FieldValue.serverTimestamp(),
          joinedAt:           existing.exists ? existing.data().joinedAt : FieldValue.serverTimestamp(),
        }, { merge: true });

        if (isNew) {
          t.update(sessionRef, { attendeeCount: FieldValue.increment(1) });
        }
      });
    }

    res.json({ received: true });
  }
);

// ── cancelAttendeeAndRefund ─────────────────────────────────────────────────
// Called by the client when a paid player cancels.
// Issues a partial Stripe refund (base cost only, not the fee), then removes
// the attendee doc.
exports.cancelAttendeeAndRefund = onCall(
  { region: REGION, secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

    const { sessionId } = request.data;
    if (!sessionId) throw new HttpsError('invalid-argument', 'Missing sessionId.');

    const uid = request.auth.uid;
    const db  = getFirestore();

    const [sessionSnap, attendeeSnap] = await Promise.all([
      db.collection('sessions').doc(sessionId).get(),
      db.collection('sessions').doc(sessionId).collection('attendees').doc(uid).get(),
    ]);

    if (!sessionSnap.exists)  throw new HttpsError('not-found', 'Session not found.');
    if (!attendeeSnap.exists) throw new HttpsError('not-found', 'Registration not found.');

    const session  = sessionSnap.data();
    const attendee = attendeeSnap.data();

    // 24h cancellation cut-off
    if (session.date) {
      const sessionDate = session.date.toDate ? session.date.toDate() : new Date(session.date);
      const hoursUntil  = (sessionDate - Date.now()) / 36e5;
      if (hoursUntil < 24)
        throw new HttpsError(
          'failed-precondition',
          'Cancellations are not allowed within 24 hours of the session.'
        );
    }

    // Issue partial refund (base cost, not the Stripe surcharge)
    if (attendee.paid && attendee.paymentIntentId) {
      const refundPence = attendee.refundAmountPence || 0;
      if (refundPence > 0) {
        await getStripe().refunds.create({
          payment_intent: attendee.paymentIntentId,
          amount:         refundPence,
        });
      }
    }

    // Remove attendee and update count
    const sessionRef  = db.collection('sessions').doc(sessionId);
    const attendeeRef = sessionRef.collection('attendees').doc(uid);
    await db.runTransaction(async t => {
      t.delete(attendeeRef);
      t.update(sessionRef, { attendeeCount: FieldValue.increment(-1) });
    });

    return { refunded: !!(attendee.paid && attendee.paymentIntentId) };
  }
);

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
