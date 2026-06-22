'use strict';

// Gen 1 functions — avoids Cloud Run IAM org-policy issues with allUsers.
const functions = require('firebase-functions/v1');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp }            = require('firebase-admin/app');
const { getAuth }                  = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();

const STRIPE_SECRET_KEY     = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const REGION = 'europe-west2';

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

    const { sessionId, successUrl, cancelUrl } = req.body;
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

    const checkout = await getStripe().checkout.sessions.create({
      mode: 'payment',
      automatic_payment_methods: { enabled: true },
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
      },
      success_url: successUrl,
      cancel_url:  cancelUrl,
    });

    return res.json({ url: checkout.url });
  });

// ── stripeWebhook ───────────────────────────────────────────────────────────
exports.stripeWebhook = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] })
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

    if (event.type === 'checkout.session.completed') {
      const checkout        = event.data.object;
      const { sessionId, uid, refundAmountPence } = checkout.metadata;
      const paymentIntentId = checkout.payment_intent;

      const db          = getFirestore();
      const sessionRef  = db.collection('sessions').doc(sessionId);
      const attendeeRef = sessionRef.collection('attendees').doc(uid);
      const userDoc     = await db.collection('users').doc(uid).get();
      const u           = userDoc.exists ? userDoc.data() : {};

      await db.runTransaction(async t => {
        const existing = await t.get(attendeeRef);
        if (existing.exists && existing.data().paid) return;

        const isNew = !existing.exists;
        t.set(attendeeRef, {
          name:              u.name  || checkout.customer_details?.name  || '',
          email:             u.email || checkout.customer_details?.email || '',
          address:           checkout.customer_details?.address || null,
          gender:            u.gender    || null,
          positions:         u.positions || [],
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
    }

    res.json({ received: true });
  });

// ── cancelAttendeeAndRefund ─────────────────────────────────────────────────
exports.cancelAttendeeAndRefund = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY] })
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

    if (session.date) {
      const sessionDate = session.date.toDate ? session.date.toDate() : new Date(session.date);
      if ((sessionDate - Date.now()) / 36e5 < 24)
        return res.status(403).json({ error: 'Cancellations are not allowed within 24 hours of the session.' });
    }

    if (attendee.paid && attendee.paymentIntentId) {
      const refundPence = attendee.refundAmountPence || 0;
      if (refundPence > 0) {
        await getStripe().refunds.create({
          payment_intent: attendee.paymentIntentId,
          amount:         refundPence,
        });
      }
    }

    const sessionRef  = db.collection('sessions').doc(sessionId);
    const attendeeRef = sessionRef.collection('attendees').doc(uid);
    await db.runTransaction(async t => {
      t.delete(attendeeRef);
      t.update(sessionRef, { attendeeCount: FieldValue.increment(-1) });
    });

    return res.json({ refunded: !!(attendee.paid && attendee.paymentIntentId) });
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
