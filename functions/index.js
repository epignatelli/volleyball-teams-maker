'use strict';

// HTTP functions use Gen 1 to avoid Cloud Run IAM org-policy (allUsers).
// Firestore triggers use Gen 2 (Eventarc) — required for eur3 multi-region DB.
const functions = require('firebase-functions/v1');
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp }            = require('firebase-admin/app');
const { getAuth }                  = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging }             = require('firebase-admin/messaging');
const crypto = require('crypto');

initializeApp();

const STRIPE_SECRET_KEY     = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const GMAIL_APP_PASSWORD    = defineSecret('GMAIL_APP_PASSWORD');
const REGION          = 'europe-west2'; // HTTP functions
const REGION_FIRESTORE = 'europe-west1'; // must match Firestore eur3 multi-region

const APP_ORIGIN  = 'https://epignatelli.com';
const APP_URL     = `${APP_ORIGIN}/apps/vb-sessions/`;
// Also allow the raw GitHub Pages origin (it redirects to the custom domain,
// but the browser Origin header reflects where the page was loaded from).
const ALLOWED_ORIGINS = new Set([APP_ORIGIN, 'https://epignatelli.github.io']);
function setCors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGINS.has(origin) ? origin : APP_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

async function verifyAuth(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) throw new Error('Unauthenticated');
  return getAuth().verifyIdToken(token);
}

// Returns { isAdmin, isOwner, roles } for the authenticated caller.
async function _resolveCallerRole(db, decoded) {
  const callerDoc = await db.collection('users').doc(decoded.uid).get();
  const roles   = callerDoc.data()?.roles || [];
  const isOwner = roles.includes('owner');
  const isAdmin = isOwner || roles.includes('admin');
  return { isAdmin, isOwner, roles };
}

// Syncs safe public fields from a user doc to publicProfiles/{uid}.
async function _syncPublicProfile(db, uid, data) {
  const publicRoles = (data.roles || ['player']).filter(r => ['player', 'coach', 'provider'].includes(r));
  await db.collection('publicProfiles').doc(uid).set({
    name:              data.name              || null,
    photoURL:          data.photoURL          || null,
    level:             data.level             || null,
    gender:            data.gender            || null,
    positions:         data.positions         || [],
    bio:               data.bio               || null,
    createdAt:         data.createdAt         || null,
    roles:             publicRoles,
    isProvider:        publicRoles.includes('provider'),
    isCoach:           publicRoles.includes('coach'),
    coachBio:          data.coachBio          || null,
    coachPositions:    data.coachPositions     || [],
    coachLevels:       data.coachLevels        || [],
    coachStyles:       data.coachStyles        || [],
    coachRate:         data.coachRate          != null ? data.coachRate : null,
    coach1to1Enabled:  data.coach1to1Enabled   || false,
  }, { merge: false });
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

async function _sendPush(db, uid, title, body) {
  try {
    const snap  = await db.collection('users').doc(uid).get();
    const token = snap.data()?.fcmToken;
    if (!token) return;
    await getMessaging().send({
      token,
      notification: { title, body },
      webpush: {
        notification: {
          icon: `${APP_URL}icons/icon-192.png`,
          badge: `${APP_URL}icons/icon-72.png`,
        },
      },
    });
  } catch (e) {
    console.error('_sendPush failed uid=%s: %s', uid, e.message);
    if (e.code === 'messaging/registration-token-not-registered' ||
        e.code === 'messaging/invalid-registration-token') {
      await db.collection('users').doc(uid).update({ fcmToken: FieldValue.delete() }).catch(() => {});
    }
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
    const uid   = doc.id;
    const title = `Spot available — ${venue}`;
    const body  = dateStr ? `${dateStr} · Open the app to claim it` : 'Open the app to claim it';
    return Promise.all([
      sendEmail(a.email,
        `Spot available — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
        _emailHtml(`Hi ${a.name || 'there'},`, [
          `A spot has opened up for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
          `Open the app to claim it — first come, first served.`,
        ], calUrl)
      ),
      _sendPush(db, uid, title, body),
    ]);
  }));
}

// ── createCheckoutSession ───────────────────────────────────────────────────
exports.createCheckoutSession = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { sessionId, successUrl, cancelUrl, positions } = req.body;
    if (!sessionId || !successUrl || !cancelUrl)
      return res.status(400).json({ error: 'Missing required fields.' });
    if (!_validateAppUrl(successUrl) || !_validateAppUrl(cancelUrl))
      return res.status(400).json({ error: 'Invalid redirect URL.' });

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

    // If this session has a provider, route the payment to their Stripe account
    let transferData;
    if (session.providerUid) {
      const providerSnap = await db.collection('users').doc(session.providerUid).get();
      const providerStripeId = providerSnap.data()?.stripeAccountId;
      if (providerStripeId) {
        transferData = { destination: providerStripeId };
      }
    }

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
        ...(transferData ? { transfer_data: transferData, application_fee_amount: 0 } : {}),
      });
    } catch (e) {
      console.error('Stripe checkout error:', e.message);
      return res.status(500).json({ error: 'Payment setup failed. Please try again.' });
    }

    return res.json({ url: checkout.url });
  });

// ── createSeriesCheckoutSession ─────────────────────────────────────────────
exports.createSeriesCheckoutSession = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { seriesId, successUrl, cancelUrl, inviteToken } = req.body;
    if (!seriesId || !successUrl || !cancelUrl)
      return res.status(400).json({ error: 'Missing required fields.' });
    if (!_validateAppUrl(successUrl) || !_validateAppUrl(cancelUrl))
      return res.status(400).json({ error: 'Invalid redirect URL.' });

    const db  = getFirestore();
    const uid = decoded.uid;

    const [seriesSnap, regSnap] = await Promise.all([
      db.collection('series').doc(seriesId).get(),
      db.collection('series').doc(seriesId).collection('registrations').doc(uid).get(),
    ]);

    if (!seriesSnap.exists) return res.status(404).json({ error: 'Series not found.' });
    if (regSnap.exists && regSnap.data().paymentStatus === 'paid')
      return res.status(409).json({ error: 'Already registered for this series.' });

    const series      = seriesSnap.data();
    const cost        = series.cost || 0;
    const maxPlayers  = series.maxPlayers || 0;
    const memberCount = series.memberCount || 0;
    const isFull      = maxPlayers > 0 && memberCount >= maxPlayers;

    // If full, validate the invite token server-side against Firestore
    let inviteValid = false;
    if (isFull && inviteToken) {
      const inviteSnap = await db.collection('series').doc(seriesId).collection('invites').doc(inviteToken).get();
      inviteValid = inviteSnap.exists;
    }

    if (isFull && !inviteValid) {
      return res.status(409).json({ error: 'Series is full.' });
    }

    const userDoc = await db.collection('users').doc(uid).get();
    const u       = userDoc.exists ? userDoc.data() : {};
    const name    = u.name  || decoded.name  || '';
    const email   = u.email || decoded.email || '';

    // Free series — enrol directly without Stripe
    if (cost <= 0) {
      if (isFull && inviteValid) {
        await db.collection('series').doc(seriesId).update({ maxPlayers: FieldValue.increment(1) });
      }
      const regRef = db.collection('series').doc(seriesId).collection('registrations').doc(uid);
      await regRef.set({
        name, email,
        registeredAt:  FieldValue.serverTimestamp(),
        paymentStatus: 'paid',
        amountPaid:    0,
      });
      await db.collection('series').doc(seriesId).update({ memberCount: FieldValue.increment(1) });

      const sessionsSnap = await db.collection('sessions').where('seriesId', '==', seriesId).get();
      await Promise.all(sessionsSnap.docs.map(async sessionDoc => {
        const attRef  = sessionDoc.ref.collection('attendees').doc(uid);
        const existing = await attRef.get();
        if (existing.exists) return;
        await db.runTransaction(async t => {
          t.set(attRef, {
            name, email,
            gender: u.gender || null, positions: u.positions || [],
            present: false, paid: false, feeWaived: true, seriesId,
            joinedAt: FieldValue.serverTimestamp(),
          });
          t.update(sessionDoc.ref, { attendeeCount: FieldValue.increment(1) });
        });
      }));

      if (email) {
        await sendEmail(email, `You're in — ${series.name || 'the series'}`,
          _emailHtml(`Hi ${name || 'there'},`, [
            `Your free series pass for <strong>${series.name || 'the series'}</strong> is confirmed.`,
            `You've been automatically registered for all sessions in this series.`,
            `If you can't make a specific session, please drop out from the app so someone else can take your spot.`,
          ]));
      }

      return res.json({ ok: true });
    }

    // Route payment to provider's Stripe account if the series has one
    let seriesTransferData;
    if (series.providerUid) {
      const providerSnap = await db.collection('users').doc(series.providerUid).get();
      const providerStripeId = providerSnap.data()?.stripeAccountId;
      if (providerStripeId) seriesTransferData = { destination: providerStripeId };
    }

    let checkout;
    try {
      checkout = await getStripe().checkout.sessions.create({
        mode: 'payment',
        billing_address_collection: 'required',
        line_items: [{
          price_data: {
            currency:     'gbp',
            product_data: { name: series.name || 'Volleyball series' },
            unit_amount:  Math.round(cost * 100),
          },
          quantity: 1,
        }],
        customer_email: email || undefined,
        metadata: { type: 'series', seriesId, uid, inviteToken: inviteToken || '', wasAtCapacity: isFull ? 'true' : 'false' },
        success_url: successUrl,
        cancel_url:  cancelUrl,
        ...(seriesTransferData ? { transfer_data: seriesTransferData, application_fee_amount: 0 } : {}),
      });
    } catch (e) {
      console.error('Stripe series checkout error:', e.message);
      return res.status(500).json({ error: 'Payment setup failed. Please try again.' });
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

      // If this user is a provider, mark onboarding complete
      if ((coachData.roles || []).includes('provider') && !coachData.providerOnboardingComplete) {
        await db.collection('users').doc(coachUid).update({ providerOnboardingComplete: true });
      }

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
          }, { idempotencyKey: `coach-transfer-${sessionDoc.id}` });
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
      const checkout = event.data.object;

      if (checkout.metadata.type === 'series') {
        await _handleSeriesCheckout(checkout);
        return res.json({ received: true });
      }

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
          photoConsent:      u.photoConsent?.given ?? false,
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
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

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
        }, { idempotencyKey: `refund-${attendee.paymentIntentId}` });
        refunded = true;
      }
    }

    const sessionRef  = db.collection('sessions').doc(sessionId);
    const attendeeRef = sessionRef.collection('attendees').doc(uid);
    await db.runTransaction(async t => {
      t.delete(attendeeRef);
      t.update(sessionRef, { attendeeCount: FieldValue.increment(-1), cancellationCount: FieldValue.increment(1) });
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

// ── dropOutSeries — remove user from a single session (series pass stays) ───
exports.dropOutSeries = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId.' });

    const uid         = decoded.uid;
    const db          = getFirestore();
    const sessionRef  = db.collection('sessions').doc(sessionId);
    const attendeeRef = sessionRef.collection('attendees').doc(uid);

    const [sessionSnap, attendeeSnap] = await Promise.all([sessionRef.get(), attendeeRef.get()]);
    if (!sessionSnap.exists)  return res.status(404).json({ error: 'Session not found.' });
    if (!attendeeSnap.exists) return res.status(404).json({ error: 'Not registered for this session.' });

    const attendee = attendeeSnap.data();
    if (!attendee.seriesId) return res.status(400).json({ error: 'Not a series registration.' });

    await db.runTransaction(async t => {
      t.delete(attendeeRef);
      t.update(sessionRef, { attendeeCount: FieldValue.increment(-1) });
    });

    const session = sessionSnap.data();
    const venue   = session.venue || 'the session';
    const dateStr = _formatDate(session.date);
    const email   = decoded.email || attendee.email;
    const name    = attendee.name || 'there';

    if (email) {
      await sendEmail(email,
        `Dropped out — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
        _emailHtml(`Hi ${name},`, [
          `You've dropped out of <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
          `Your series pass is still active for all other sessions in the series.`,
        ])
      );
    }

    await _notifyWaitingList(db, sessionId, session);

    return res.json({ ok: true });
  });

// ── _handleSeriesCheckout ────────────────────────────────────────────────────
async function _handleSeriesCheckout(checkout) {
  const { seriesId, uid, invited } = checkout.metadata;
  const db = getFirestore();

  const [seriesSnap, userDoc] = await Promise.all([
    db.collection('series').doc(seriesId).get(),
    db.collection('users').doc(uid).get(),
  ]);

  const series = seriesSnap.data() || {};
  const u      = userDoc.data() || {};
  const name   = u.name  || checkout.customer_details?.name  || '';
  const email  = u.email || checkout.customer_details?.email || '';

  // Idempotency: skip if already registered
  const regRef  = db.collection('series').doc(seriesId).collection('registrations').doc(uid);
  const existing = await regRef.get();
  if (existing.exists && existing.data().paymentStatus === 'paid') {
    console.log(`Series checkout duplicate: uid=${uid} seriesId=${seriesId}`);
    return;
  }

  // Bump maxPlayers if this was an invited join to a series that was at capacity when checkout was created
  if (checkout.metadata.wasAtCapacity === 'true' && checkout.metadata.inviteToken) {
    const inviteSnap = await db.collection('series').doc(seriesId).collection('invites').doc(checkout.metadata.inviteToken).get();
    if (inviteSnap.exists) {
      await db.collection('series').doc(seriesId).update({ maxPlayers: FieldValue.increment(1) });
    }
  }

  await regRef.set({
    name, email,
    registeredAt:    FieldValue.serverTimestamp(),
    paymentStatus:   'paid',
    stripeSessionId: checkout.id,
    amountPaid:      (checkout.amount_total || 0) / 100,
  });

  await db.collection('series').doc(seriesId).update({
    memberCount: FieldValue.increment(1),
  });

  // Auto-enrol in all sessions with this seriesId
  const sessionsSnap = await db.collection('sessions').where('seriesId', '==', seriesId).get();
  await Promise.all(sessionsSnap.docs.map(async sessionDoc => {
    const attendeeRef = sessionDoc.ref.collection('attendees').doc(uid);
    const existingAtt = await attendeeRef.get();
    if (existingAtt.exists) return;
    await db.runTransaction(async t => {
      t.set(attendeeRef, {
        name, email,
        gender:    u.gender    || null,
        positions: u.positions || [],
        present:   false,
        paid:      true,
        feeWaived: false,
        seriesId,
        joinedAt: FieldValue.serverTimestamp(),
      });
      t.update(sessionDoc.ref, { attendeeCount: FieldValue.increment(1) });
    });
  }));

  // Confirmation email
  if (email) {
    await sendEmail(email,
      `You\'re in — ${series.name || 'the series'}`,
      _emailHtml(`Hi ${name || 'there'},`, [
        `Your series pass for <strong>${series.name || 'the series'}</strong> has been confirmed.`,
        `You\'ve been automatically registered for all sessions in this series.`,
        `If you can\'t make a specific session, please drop out from the app so someone else can take your spot.`,
      ])
    );
  }
}

// ── _autoEnrolSeriesMembers ──────────────────────────────────────────────────
async function _autoEnrolSeriesMembers(db, sessionId, session) {
  const regsSnap = await db.collection('series').doc(session.seriesId)
    .collection('registrations').where('paymentStatus', '==', 'paid').get();
  if (regsSnap.empty) return;

  const sessionRef = db.collection('sessions').doc(sessionId);

  await Promise.all(regsSnap.docs.map(async regDoc => {
    const reg      = regDoc.data();
    const uid      = regDoc.id;
    const attRef   = sessionRef.collection('attendees').doc(uid);
    const existing = await attRef.get();
    if (existing.exists) return;

    const userDoc = await db.collection('users').doc(uid).get();
    const u = userDoc.exists ? userDoc.data() : {};

    await db.runTransaction(async t => {
      t.set(attRef, {
        name:      u.name  || reg.name  || '',
        email:     u.email || reg.email || '',
        gender:    u.gender    || null,
        positions: u.positions || [],
        present:   false,
        paid:      true,
        feeWaived: false,
        seriesId:  session.seriesId,
        joinedAt:  FieldValue.serverTimestamp(),
      });
      t.update(sessionRef, { attendeeCount: FieldValue.increment(1) });
    });
  }));
}

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
    const a   = doc.data();
    const uid = doc.id;
    if (!a.email) return;
    const pushBody = dateStr ? `${dateStr} has been cancelled` : 'Session cancelled';
    return Promise.all([
      sendEmail(a.email,
        `Session cancelled — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
        _emailHtml(`Hi ${a.name || 'there'},`, [
          `Unfortunately <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been cancelled.`,
          a.paid && a.refundAmountPence > 0
            ? `A refund of <strong>£${(a.refundAmountPence / 100).toFixed(2)}</strong> will be processed automatically.`
            : '',
          `Apologies for the inconvenience.`,
        ].filter(Boolean))
      ),
      _sendPush(db, uid, `${venue} cancelled`, pushBody),
    ]);
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
  if (attendee.paid)     return; // paid sessions get confirmation from stripeWebhook
  if (attendee.seriesId) return; // series auto-enrol — confirmation sent by series checkout
  if (!attendee.email)   return;

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

  // Notify queued players with pending offers if their offered position just became full
  const pt = session.positionTargets;
  const newPositions = attendee.positions || [];
  if (pt && newPositions.length) {
    const posWlSnap = await db.collection('sessions').doc(sessionId)
      .collection('positionWaitingList').get();
    const withOffers = posWlSnap.docs.filter(d => {
      const offered = d.data().pendingOffer?.positions
        || (d.data().pendingOffer?.position ? [d.data().pendingOffer.position] : []);
      return offered.some(p => newPositions.includes(p)) && d.data().email;
    });
    if (withOffers.length) {
      const allAttSnap = await db.collection('sessions').doc(sessionId).collection('attendees').get();
      const counts = {};
      for (const d of allAttSnap.docs) {
        for (const p of (d.data().positions || [])) counts[p] = (counts[p] || 0) + 1;
      }
      const fullPositions = newPositions.filter(p => pt[p] != null && (counts[p] || 0) >= pt[p]);
      if (fullPositions.length) {
        const POS_LABELS = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };
        const sessionUrl = `${APP_URL}#${sessionId}`;
        for (const doc of withOffers) {
          const entry   = doc.data();
          const offered = entry.pendingOffer?.positions || (entry.pendingOffer?.position ? [entry.pendingOffer.position] : []);
          const taken   = fullPositions.filter(p => offered.includes(p));
          if (!taken.length) continue;
          const posStr = taken.map(p => POS_LABELS[p] || p).join(' and ');
          await sendEmail(entry.email,
            `The ${posStr} spot was taken — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
            _emailHtml(`Hi ${entry.name || 'there'},`, [
              `Someone else was faster — the <strong>${posStr}</strong> spot for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has just been taken.`,
              `You're still in the queue for your original position.`,
            ], null, sessionUrl, 'View session →')
          );
        }
      }
    }
  }
});

// ── removeAttendeeAdmin ──────────────────────────────────────────────────────
exports.removeAttendeeAdmin = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const db = getFirestore();
    const { isAdmin } = await _resolveCallerRole(db, decoded);
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
    await Promise.all([
      sendEmail(attendee.email,
        `Registration removed — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
        _emailHtml(`Hi ${attendee.name || 'there'},`, [
          `Your registration for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''} has been removed by an admin.`,
          `If you have any questions, please contact the organiser.`,
        ])
      ),
      _sendPush(db, uid, 'Registration removed', `${venue}${dateStr ? ` · ${dateStr}` : ''}`),
    ]);

    await _notifyWaitingList(db, sessionId, session);

    return res.json({ ok: true });
  });

// ── onSessionCreated — auto-enrol series members when a series session is created
exports.onSessionCreated = onDocumentCreated({
  document: 'sessions/{sessionId}',
  region:   REGION_FIRESTORE,
}, async (event) => {
  const session = event.data.data();
  if (!session?.seriesId) return;
  const db = getFirestore();
  await _autoEnrolSeriesMembers(db, event.params.sessionId, session);
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

  // Auto-enrol series members when seriesId is first assigned to this session
  if (!before.seriesId && after.seriesId) {
    await _autoEnrolSeriesMembers(db, event.params.sessionId, after);
  }

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
      const appUrl  = `https://epignatelli.com/apps/vb-sessions/`;
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

// ── onUserWritten — keep publicProfiles in sync ──────────────────────────────
// Fires on every create, update, or delete of a users/{uid} document.
// publicProfiles/{uid} exposes only safe public fields to other authenticated users.
exports.onUserWritten = onDocumentWritten({
  document: 'users/{uid}',
  region: REGION_FIRESTORE,
}, async (event) => {
  const db  = getFirestore();
  const uid = event.params.uid;
  if (!event.data.after.exists) {
    await db.collection('publicProfiles').doc(uid).delete().catch(() => {});
    return;
  }
  const d = event.data.after.data() || {};
  await _syncPublicProfile(db, uid, d);
});

// ── deleteSessionAdmin ───────────────────────────────────────────────────────
exports.deleteSessionAdmin = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const db = getFirestore();
    const { isAdmin } = await _resolveCallerRole(db, decoded);
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
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

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
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

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
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

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
        }, { idempotencyKey: `coach-payment-${sessionId}` });
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
        refresh_url: `https://epignatelli.com/apps/vb-sessions/`,
        return_url:  `https://epignatelli.com/apps/vb-sessions/`,
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
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const db = getFirestore();
    const { isAdmin } = await _resolveCallerRole(db, decoded);
    if (!isAdmin) return res.status(403).json({ error: 'Admin only.' });

    const { sessionId, subject, body } = req.body;
    if (!sessionId || !subject || !body)
      return res.status(400).json({ error: 'Missing sessionId, subject, or body.' });
    if (typeof subject !== 'string' || subject.length > 200)
      return res.status(400).json({ error: 'subject must be ≤200 characters.' });
    if (typeof body !== 'string' || body.length > 2000)
      return res.status(400).json({ error: 'body must be ≤2000 characters.' });

    const sessionRef  = db.collection('sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ error: 'Session not found.' });

    // Rate-limit: max one broadcast per 5 minutes per session.
    const sessionData = sessionSnap.data();
    const lastMsg = sessionData.lastMessageAt;
    if (lastMsg && (Date.now() - lastMsg.toMillis()) < 300000)
      return res.status(429).json({ error: 'Please wait 5 minutes between messages to attendees.' });

    const attendeesSnap = await sessionRef.collection('attendees').get();

    // Escape admin-provided body so HTML tags cannot inject into email.
    const safeBody = _hEsc(body).replace(/\n/g, '<br>');

    await Promise.all(attendeesSnap.docs.map(doc => {
      const a = doc.data();
      if (!a.email) return;
      return sendEmail(a.email, subject,
        _emailHtml(`Hi ${a.name || 'there'},`, [safeBody])
      );
    }));

    await sessionRef.update({
      lastMessageAt: FieldValue.serverTimestamp(),
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
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    // Only the requesting user themselves may trigger this notification
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing uid.' });
    if (decoded.uid !== uid) return res.status(403).json({ error: 'Forbidden.' });

    const db         = getFirestore();
    // Derive name from Firestore, never from client body
    const userSnap   = await db.collection('users').doc(uid).get();
    const userData   = userSnap.data() || {};
    const safeName   = _hEsc(userData.name || uid);

    // Rate limit: 1 notification email per hour per request
    const emailSentAt = userData.coachRequest?.emailSentAt;
    if (emailSentAt && (Date.now() - emailSentAt.toMillis()) < 3600000)
      return res.status(429).json({ error: 'Please wait 1 hour between notification emails.' });

    const adminsSnap = await db.collection('admins').get();

    const { approveUrl, rejectUrl } = await _createRequestTokens(db, uid, 'coach');
    const actionButtons = _requestActionButtons(approveUrl, rejectUrl);

    await Promise.all(adminsSnap.docs.map(doc =>
      sendEmail(doc.id,
        `Coach request from ${safeName}`,
        _emailHtml('Hi,', [
          `<strong>${safeName}</strong> has requested to be listed as a coach.`,
          'Use the buttons below to approve or reject, or go to the Users screen.',
        ], null, null, null, actionButtons)
      )
    ));

    await db.collection('users').doc(uid).update({ 'coachRequest.emailSentAt': FieldValue.serverTimestamp() });

    return res.json({ ok: true });
  });

// ── notifyVenueProposal ──────────────────────────────────────────────────────
exports.notifyVenueProposal = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { venueId, venueName } = req.body;
    if (!venueId || !venueName) return res.status(400).json({ error: 'Missing venueId or venueName.' });

    const db       = getFirestore();
    const userSnap = await db.collection('users').doc(decoded.uid).get();
    const userData = userSnap.data() || {};
    const safeName = _hEsc(userData.name || decoded.uid);
    const safeVenue = _hEsc(venueName);

    const adminsSnap = await db.collection('admins').get();
    const venueUrl   = `${APP_URL}#venues`;

    await Promise.all(adminsSnap.docs.map(doc =>
      sendEmail(doc.id,
        `New venue proposed: ${venueName}`,
        _emailHtml('Hi,', [
          `<strong>${safeName}</strong> has proposed a new venue: <strong>${safeVenue}</strong>.`,
          'Review it in the Venues screen and approve or reject it.',
        ], null, null, null,
        `<div style="text-align:center;margin-top:24px">
          <a href="${venueUrl}" style="display:inline-block;padding:12px 28px;background:#f0a500;color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:15px">
            Review venue
          </a>
        </div>`)
      )
    ));

    return res.json({ ok: true });
  });

// ── notifyAdminRequest ───────────────────────────────────────────────────────
exports.notifyAdminRequest = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing uid.' });

    const db          = getFirestore();
    const { isAdmin: callerIsAdmin } = await _resolveCallerRole(db, decoded);
    if (!callerIsAdmin) return res.status(403).json({ error: 'Admins only.' });

    // Derive name from Firestore
    const targetSnap  = await db.collection('users').doc(uid).get();
    const safeName    = _hEsc(targetSnap.data()?.name || uid);
    const nominator   = _hEsc(decoded.email || 'An admin');
    const appUrl      = 'https://epignatelli.com/apps/vb-sessions/#users';

    const usersSnap   = await db.collection('users').get();
    const ownerEmails = usersSnap.docs
      .filter(d => (d.data().roles || []).includes('owner'))
      .map(d => d.data().email)
      .filter(Boolean);

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

// ── notifyProviderRequest ─────────────────────────────────────────────────────
exports.notifyProviderRequest = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing uid.' });
    // Only the requesting user themselves may trigger this notification
    if (decoded.uid !== uid) return res.status(403).json({ error: 'Forbidden.' });

    const db         = getFirestore();
    // Derive name from Firestore, never from client body
    const userSnap   = await db.collection('users').doc(uid).get();
    const userData   = userSnap.data() || {};
    const safeName   = _hEsc(userData.name || uid);

    // Rate limit: 1 notification email per hour per request
    const emailSentAt = userData.providerRequest?.emailSentAt;
    if (emailSentAt && (Date.now() - emailSentAt.toMillis()) < 3600000)
      return res.status(429).json({ error: 'Please wait 1 hour between notification emails.' });

    const adminsSnap = await db.collection('admins').get();
    const appUrl     = 'https://epignatelli.com/apps/vb-sessions/#users';

    const { approveUrl, rejectUrl } = await _createRequestTokens(db, uid, 'provider');
    const actionButtons = _requestActionButtons(approveUrl, rejectUrl);

    await Promise.all(adminsSnap.docs.map(doc =>
      sendEmail(doc.id,
        `Host request from ${safeName}`,
        _emailHtml('Hi,', [
          `<strong>${safeName}</strong> has requested to become a host.`,
          'Hosts can create their own sessions and receive player payments via Stripe.',
          'Use the buttons below to approve or reject, or go to the Users screen.',
        ], null, null, null, actionButtons)
      )
    ));

    await db.collection('users').doc(uid).update({ 'providerRequest.emailSentAt': FieldValue.serverTimestamp() });

    return res.json({ ok: true });
  });

// ── notifyHostRequestOutcome ──────────────────────────────────────────────────
exports.notifyHostRequestOutcome = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { uid, approved } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing uid.' });

    const db = getFirestore();
    const { isAdmin } = await _resolveCallerRole(db, decoded);
    if (!isAdmin) return res.status(403).json({ error: 'Admins only.' });

    const userSnap = await db.collection('users').doc(uid).get();
    const email    = userSnap.data()?.email;
    const name     = userSnap.data()?.name || 'there';
    const appUrl   = 'https://epignatelli.com/apps/vb-sessions/';

    if (!email) return res.json({ ok: true });

    if (approved) {
      await sendEmail(email,
        'Your host request has been approved',
        _emailHtml(`Hi ${name},`, [
          'Great news — your request to become a host on Roots has been approved.',
          'You can now create sessions and receive payments from players directly.',
          'Head to your profile to connect your bank account via Stripe and start hosting.',
        ], null, appUrl, 'Go to Roots →')
      );
    } else {
      await sendEmail(email,
        'Your host request',
        _emailHtml(`Hi ${name},`, [
          'Thank you for your interest in hosting on Roots.',
          'Unfortunately your request was not approved at this time.',
          'If you have any questions, reply to this email and we\'ll be happy to help.',
        ])
      );
    }

    return res.json({ ok: true });
  });

// ── notifyCoachRequestOutcome ─────────────────────────────────────────────────
exports.notifyCoachRequestOutcome = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const { uid, approved } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing uid.' });

    const db = getFirestore();
    const { isAdmin } = await _resolveCallerRole(db, decoded);
    if (!isAdmin) return res.status(403).json({ error: 'Admins only.' });

    const userSnap = await db.collection('users').doc(uid).get();
    const email    = userSnap.data()?.email;
    const name     = userSnap.data()?.name || 'there';
    const appUrl   = 'https://epignatelli.com/apps/vb-sessions/';

    if (!email) return res.json({ ok: true });

    if (approved) {
      await sendEmail(email,
        'Your coach request has been approved',
        _emailHtml(`Hi ${name},`, [
          'Great news — your request to become a coach on Roots has been approved.',
          'Head to your profile for next steps.',
        ], null, appUrl, 'Go to Roots →')
      );
    } else {
      await sendEmail(email,
        'Your coach request',
        _emailHtml(`Hi ${name},`, [
          'Thank you for your interest in coaching on Roots.',
          'Unfortunately your request was not approved at this time.',
          'If you have any questions, reply to this email and we\'ll be happy to help.',
        ])
      );
    }

    return res.json({ ok: true });
  });

// ── handleRequestAction ───────────────────────────────────────────────────────
// GET endpoint — called from approve/reject links in admin notification emails.
// No Firebase auth required; the token is the credential.
exports.handleRequestAction = functions
  .region(REGION)
  .runWith({ secrets: [GMAIL_APP_PASSWORD] })
  .https.onRequest(async (req, res) => {
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');

    const token = req.query.token;
    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      return res.status(400).send(_actionHtml('Invalid link', 'This link is not valid.'));
    }

    const db       = getFirestore();
    const tokenRef = db.collection('requestTokens').doc(token);
    const tokenSnap = await tokenRef.get();

    if (!tokenSnap.exists) {
      return res.status(404).send(_actionHtml('Link not found', 'This link has already been used or doesn\'t exist.'));
    }

    const data = tokenSnap.data();

    if (data.used) {
      return res.status(409).send(_actionHtml('Already used', 'This link has already been used.'));
    }

    if (data.expiresAt.toDate() < new Date()) {
      return res.status(410).send(_actionHtml('Link expired', 'This link expired 7 days after it was sent.'));
    }

    const { uid, role, action, requestId, siblingToken } = data;
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return res.status(404).send(_actionHtml('User not found', 'The user no longer exists.'));
    }
    const userData  = userSnap.data();
    const userName  = userData.name  || 'Unknown';
    const userEmail = userData.email;
    const roleLabel = role === 'provider' ? 'host' : role;
    const field     = role === 'coach' ? 'coachRequest' : 'providerRequest';
    const currentReq = userData[field];

    // Guard: reject stale tokens — request must still be open, not expired, and match the stored requestId
    const reqExpiry = currentReq?.expiresAt?.toDate?.();
    if (!currentReq || currentReq.status !== 'open' || (reqExpiry && reqExpiry < new Date()) || (requestId && currentReq.id !== requestId)) {
      return res.status(409).send(_actionHtml('Already processed', 'This request has already been responded to, cancelled, or expired.'));
    }

    // Mark this token used and invalidate the sibling so the other email button can't fire
    await tokenRef.update({ used: true, usedAt: FieldValue.serverTimestamp() });
    if (siblingToken) {
      db.collection('requestTokens').doc(siblingToken).update({ used: true, usedAt: FieldValue.serverTimestamp() }).catch(() => {});
    }

    const closedUpdate = { ...currentReq, respondedAt: FieldValue.serverTimestamp() };

    if (action === 'approve') {
      const roles = userData.roles || ['player'];
      if (!roles.includes(role)) roles.push(role);
      closedUpdate.status = 'approved';
      await db.collection('users').doc(uid).update({ roles, [field]: closedUpdate });

      if (userEmail) {
        const subject = role === 'provider'
          ? 'Your host request has been approved'
          : 'Your coach request has been approved';
        const body = role === 'provider'
          ? ['Great news — your request to become a host on Roots has been approved.',
             'Head to your profile to connect your bank account via Stripe and start hosting.']
          : ['Great news — your request to become a coach on Roots has been approved.',
             'Head to your profile for next steps.'];
        await sendEmail(userEmail, subject,
          _emailHtml(`Hi ${userName},`, body, null,
            'https://epignatelli.com/apps/vb-sessions/', 'Go to Roots →'));
      }

      return res.send(_actionHtml(
        `${userName} approved as ${roleLabel}`,
        'The user has been notified by email.'
      ));
    } else {
      closedUpdate.status = 'declined';
      await db.collection('users').doc(uid).update({ [field]: closedUpdate });

      if (userEmail) {
        const subject = role === 'provider' ? 'Your host request'  : 'Your coach request';
        const body    = role === 'provider'
          ? ['Thank you for your interest in hosting on Roots.',
             'Unfortunately your request was not approved at this time.',
             'If you have any questions, reply to this email and we\'ll be happy to help.']
          : ['Thank you for your interest in coaching on Roots.',
             'Unfortunately your request was not approved at this time.',
             'If you have any questions, reply to this email and we\'ll be happy to help.'];
        await sendEmail(userEmail, subject, _emailHtml(`Hi ${userName},`, body));
      }

      return res.send(_actionHtml(
        `${userName}'s ${roleLabel} request rejected`,
        'The user has been notified by email.'
      ));
    }
  });

// ── providerOnboardingLink ────────────────────────────────────────────────────
exports.providerOnboardingLink = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_SECRET_KEY] })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const db       = getFirestore();
    const userSnap = await db.collection('users').doc(decoded.uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found.' });

    const userData = userSnap.data();
    if (!(userData.roles || []).includes('provider'))
      return res.status(403).json({ error: 'Provider role required.' });

    const stripe  = getStripe();
    const baseUrl = 'https://epignatelli.com/apps/vb-sessions/';

    let accountId = userData.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type:         'express',
        country:      'GB',
        email:        userData.email || undefined,
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      await db.collection('users').doc(decoded.uid).update({ stripeAccountId: accountId });
    }

    const accountLink = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: baseUrl,
      return_url:  baseUrl,
      type:        'account_onboarding',
    });

    return res.json({ url: accountLink.url });
  });

// ── removeUser ───────────────────────────────────────────────────────────────
exports.removeUser = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    const db = getFirestore();
    const { isAdmin, isOwner: callerIsOwner } = await _resolveCallerRole(db, decoded);
    if (!isAdmin) return res.status(403).json({ error: 'Admins only.' });

    const { uid } = req.body;
    if (!uid)                return res.status(400).json({ error: 'Missing uid.' });
    if (uid === decoded.uid) return res.status(400).json({ error: 'Cannot remove yourself.' });

    // Owners can remove anyone except other owners; admins cannot remove admins/owners.
    const targetDoc   = await db.collection('users').doc(uid).get();
    const targetRoles = targetDoc.data()?.roles || [];
    if (targetRoles.includes('owner')) return res.status(403).json({ error: 'Cannot remove an owner.' });
    if (!callerIsOwner && (targetRoles.includes('admin'))) {
      return res.status(403).json({ error: 'Only owners can remove admins.' });
    }

    await db.collection('users').doc(uid).delete();
    await db.collection('publicProfiles').doc(uid).delete().catch(() => {});
    try { await getAuth().deleteUser(uid); } catch(_) {}

    return res.json({ ok: true });
  });

// ── updateUserRole ────────────────────────────────────────────────────────────
// All role writes go through here — never from the client directly.
// Admins can grant/revoke coach and provider. Owners can also grant/revoke admin.
// Nobody can grant 'owner' via this endpoint (owner is set manually in Firestore).
exports.updateUserRole = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')    return res.status(405).end();

    let decoded;
    try { decoded = await verifyAuth(req); }
    catch (e) { return res.status(401).json({ error: 'Unauthorized.' }); }

    try {
      const { uid, role, action } = req.body;
      if (!uid || !role || !['add', 'remove'].includes(action))
        return res.status(400).json({ error: 'Missing or invalid fields.' });

      const ADMIN_ROLES = ['coach', 'provider'];
      const OWNER_ROLES = ['admin'];
      if (![...ADMIN_ROLES, ...OWNER_ROLES].includes(role))
        return res.status(400).json({ error: 'Invalid role.' });

      const db = getFirestore();
      const { isAdmin: callerIsAdmin, isOwner: callerIsOwner } = await _resolveCallerRole(db, decoded);
      if (!callerIsAdmin) return res.status(403).json({ error: 'Admins only.' });
      if (OWNER_ROLES.includes(role) && !callerIsOwner)
        return res.status(403).json({ error: 'Only owners can change admin roles.' });
      if (uid === decoded.uid)
        return res.status(400).json({ error: 'Cannot change your own roles.' });

      const targetSnap  = await db.collection('users').doc(uid).get();
      if (!targetSnap.exists) return res.status(404).json({ error: 'User not found.' });

      const targetRoles = targetSnap.data()?.roles || ['player'];
      let newRoles;
      if (action === 'add') {
        newRoles = targetRoles.includes(role) ? targetRoles : [...targetRoles, role];
      } else {
        newRoles = targetRoles.filter(r => r !== role);
      }
      if (!newRoles.includes('player')) newRoles.push('player');

      await db.collection('users').doc(uid).update({ roles: newRoles });
      return res.json({ ok: true, roles: newRoles });
    } catch(e) {
      console.error('updateUserRole error:', e);
      return res.status(500).json({ error: 'Internal error.' });
    }
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

function _hEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _validateAppUrl(url) {
  return typeof url === 'string'
    && [...ALLOWED_ORIGINS].some(o => url.startsWith(o + '/'));
}

function _emailHtml(greeting, paragraphs, calendarUrl = null, ctaUrl = null, ctaLabel = null, actionsHtml = '') {
  const body = paragraphs.map(p => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const cal  = calendarUrl
    ? `<p style="margin:20px 0 0"><a href="${calendarUrl}" style="display:inline-block;padding:10px 18px;background:#f5a623;color:#0f1117;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px">Add to Google Calendar →</a></p>`
    : '';
  const cta  = ctaUrl
    ? `<p style="margin:20px 0 0"><a href="${ctaUrl}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px">${ctaLabel || 'Open →'}</a></p>`
    : '';
  const policyUrl = 'https://epignatelli.com/apps/vb-sessions/';
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
<p style="margin:0 0 12px">${_hEsc(greeting)}</p>
${body}${actionsHtml}${cal}${cta}
<p style="margin:24px 0 0;font-size:12px;color:#888">Roots Volleyball · <a href="${policyUrl}" style="color:#888">Terms &amp; cancellation policy</a></p>
</body></html>`;
}

// Generate two single-use approve/reject tokens and store them in Firestore.
async function _createRequestTokens(db, uid, role) {
  const approveToken = crypto.randomBytes(32).toString('hex');
  const rejectToken  = crypto.randomBytes(32).toString('hex');
  const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Read current requestId from Firestore so tokens are bound to this specific request
  const userSnap  = await db.collection('users').doc(uid).get();
  const field     = role === 'coach' ? 'coachRequest' : 'providerRequest';
  const requestId = userSnap.data()?.[field]?.id || null;

  const base = { uid, role, requestId, expiresAt, used: false, siblingToken: null };
  // Store sibling token ID so we can invalidate the other link when one is used
  await Promise.all([
    db.collection('requestTokens').doc(approveToken).set({ ...base, action: 'approve', siblingToken: rejectToken }),
    db.collection('requestTokens').doc(rejectToken).set({ ...base, action: 'reject',  siblingToken: approveToken }),
  ]);
  const fnBase = 'https://europe-west2-roots-kqotc.cloudfunctions.net/handleRequestAction';
  return {
    approveUrl: `${fnBase}?token=${approveToken}`,
    rejectUrl:  `${fnBase}?token=${rejectToken}`,
  };
}

function _requestActionButtons(approveUrl, rejectUrl) {
  const a = (url, label, bg) =>
    `<a href="${url}" style="display:inline-block;padding:10px 20px;background:${bg};color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px">${label}</a>`;
  return `<div style="margin:20px 0;display:flex;gap:12px">
  ${a(approveUrl, 'Approve →', '#16a34a')}
  ${a(rejectUrl,  'Reject →',  '#dc2626')}
</div>`;
}

// ── onPositionOfferSent ───────────────────────────────────────────────────────
// Fires when admin sets pendingOffer on a queue doc. Emails the player.
exports.onPositionOfferSent = onDocumentUpdated({
  document: 'sessions/{sessionId}/positionWaitingList/{uid}',
  region:   REGION_FIRESTORE,
  secrets:  [GMAIL_APP_PASSWORD],
}, async (event) => {
  const before = event.data.before.data();
  const after  = event.data.after.data();

  const _offerPositions = d =>
    d.pendingOffer?.positions || (d.pendingOffer?.position ? [d.pendingOffer.position] : []);

  const prevPositions = _offerPositions(before);
  const nextPositions = _offerPositions(after);
  const newPositions  = nextPositions.filter(p => !prevPositions.includes(p));
  if (!newPositions.length) return; // no new offered positions

  const email = after.email;
  const name  = after.name || 'there';
  if (!email) return;

  const db         = getFirestore();
  const sessionDoc = await db.collection('sessions').doc(event.params.sessionId).get();
  if (!sessionDoc.exists) return;
  const session = sessionDoc.data();

  const POS_LABELS = { setter: 'Setter', hitter: 'Hitter', middle: 'Middle', libero: 'Libero' };
  const posStr     = newPositions.map(p => POS_LABELS[p] || p).join(' or ');
  const venue      = session.venue || 'the session';
  const dateStr    = _formatDate(session.date);
  const sessionUrl = `${APP_URL}#${event.params.sessionId}`;

  await sendEmail(email,
    `Spot available — ${posStr} · ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
    _emailHtml(`Hi ${name},`, [
      `A <strong>${posStr}</strong> spot has opened up for <strong>${venue}</strong>${dateStr ? ` on <strong>${dateStr}</strong>` : ''}.`,
      `This is <strong>first-come-first-served</strong> — be quick!`,
    ], null, sessionUrl, 'Claim your spot →')
  );
});

// ── sendSessionReminders ─────────────────────────────────────────────────────
// Runs every day at 08:00 London time. Emails all attendees of sessions
// happening the following day.
exports.sendSessionReminders = onSchedule({
  schedule:  '0 8 * * *',
  timeZone:  'Europe/London',
  region:    REGION,
  secrets:   [GMAIL_APP_PASSWORD],
}, async () => {
  const db  = getFirestore();
  const now = new Date();

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);

  const sessionsSnap = await db.collection('sessions')
    .where('date', '>=', tomorrow)
    .where('date', '<', dayAfter)
    .get();

  for (const sessionDoc of sessionsSnap.docs) {
    const session = sessionDoc.data();
    if (session.status === 'cancelled') continue;

    const venue      = session.venue || 'the session';
    const dateStr    = _formatDate(session.date);
    const calUrl     = _calendarUrl(session);
    const sessionUrl = `${APP_URL}#${sessionDoc.id}`;

    const attendeesSnap = await db.collection('sessions').doc(sessionDoc.id)
      .collection('attendees').get();

    for (const attDoc of attendeesSnap.docs) {
      const att = attDoc.data();
      if (!att.email) continue;
      await sendEmail(att.email,
        `See you tomorrow — ${venue}${dateStr ? ` · ${dateStr}` : ''}`,
        _emailHtml(`Hi ${att.name || 'there'},`, [
          `Just a heads-up — you're registered for <strong>${venue}</strong> tomorrow${dateStr ? ` (<strong>${dateStr}</strong>)` : ''}.`,
          `See you on the court!`,
        ], calUrl, sessionUrl, 'View session →')
      );
    }
  }
});

// ── notifyCoachBookingRequest ─────────────────────────────────────────────────
// Triggered when a player creates a new coachBookings document.
// Emails the coach to let them know about the request.
exports.notifyCoachBookingRequest = onDocumentCreated({
  document: 'coachBookings/{bookingId}',
  region:   REGION_FIRESTORE,
  secrets:  [GMAIL_APP_PASSWORD],
}, async (event) => {
  const booking = event.data.data();
  const db = getFirestore();
  const coachDoc = await db.collection('users').doc(booking.coachUid).get();
  if (!coachDoc.exists) return;
  const coach = coachDoc.data();
  if (!coach.email) return;

  const dateStr  = booking.date || '';
  const slotLabel = { morning: 'morning', afternoon: 'afternoon', evening: 'evening' }[booking.timeSlot] || booking.timeSlot;
  const fmtLabel  = { 'in-person': 'in person', 'video': 'via video call' }[booking.format] || booking.format;
  const appUrl    = APP_URL;

  await sendEmail(
    coach.email,
    `New 1-1 booking request from ${booking.playerName}`,
    _emailHtml(`Hi ${coach.name || 'there'},`, [
      `<strong>${_hEsc(booking.playerName)}</strong> has requested a ${booking.duration}-minute ${fmtLabel} session.`,
      `<strong>Preferred:</strong> ${_hEsc(dateStr)}${slotLabel ? `, ${slotLabel}` : ''}`,
      booking.note ? `<strong>Note:</strong> ${_hEsc(booking.note)}` : '',
      `Log in to accept or decline this request.`,
    ].filter(Boolean), null, appUrl, 'Open app →')
  );
});

function _actionHtml(title, message) {
  const adminUrl = 'https://epignatelli.com/apps/vb-sessions/#users';
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;padding:24px;color:#111">
<h2 style="margin:0 0 12px">${title}</h2>
<p style="margin:0 0 24px;color:#555">${message}</p>
<p><a href="${adminUrl}" style="color:#4f46e5">Go to admin panel →</a></p>
</body></html>`;
}
