# Admin Operations Guide

Practical reference for Roots admins. Covers how backend processes work, what to do when things go wrong, and what requires action in external tools.

---

## Session lifecycle

Sessions move through these statuses:

| Status | Meaning |
|---|---|
| `open` | Accepting registrations |
| `running` | Session in progress (host tapped Start) |
| `closed` | Session ended, report submitted |
| `cancelled` | Cancelled — attendees notified, refunds issued automatically |

**Deleting vs cancelling:** Cancellation keeps the session visible with a Cancelled badge and triggers refunds + notifications. Deleting removes it entirely — use only for test data or duplicates, never for a session with real attendees.

---

## Waiting list

When a session is full, players join the waiting list. When a spot opens (someone cancels), the **first person on the waiting list** receives an email with a time-limited claim link. If they don't claim within the window, the next person is notified, and so on.

**Sell my spot vs Cancel registration:**
- **Sell my spot** — the player's spot goes to the waiting list *before* they leave, so no gap. Their refund is held until the spot is claimed; if no one claims it, they still get refunded.
- **Cancel registration** — immediate cancellation and refund. A waiting list notification fires separately.

---

## Refunds

Refunds are automatic when a player cancels **more than 24 hours before the session**. Within 24 hours, no refund is issued — the player sees this explained at cancel time.

Refunds appear in the player's account within **5–10 business days** (Stripe processing time, not within our control).

**To check refund status:** Stripe Dashboard → Payments → find the original charge → Refunds tab.

**Partial refunds** are not currently supported in the app — any partial refund must be issued manually from the Stripe Dashboard.

---

## Coach payments

### Normal flow
1. Session ends → host submits report → session status becomes `closed`
2. Admin sees **"Approve coach payment — £X"** button on the session detail
3. Tapping it triggers one of two paths:

**Path A — Coach has a Stripe account:**
A transfer fires immediately from the Roots Stripe balance to the coach's connected account. Status changes to `Coach paid ✓`.

**Path B — Coach has no Stripe account yet:**
An onboarding email is sent to the coach with a Stripe Connect link. Status shows `Coach onboarding…`. Once the coach completes onboarding, **all pending transfers for that coach fire automatically** — no further admin action needed.

### "Insufficient funds" error
This means the Roots Stripe available balance is too low to cover the transfer. Stripe settlements take 2–7 business days, so the balance can be £0 even with recent income.

**To fix:**
1. Go to Stripe Dashboard → Balance → Add funds (top up from bank account)
2. Once funds settle, go back to the session in the app and tap "Approve coach payment" again

**To check the Roots balance:** Stripe Dashboard → Balance (top of the page). Note the difference between *available* (can transfer now) and *pending* (settling, not yet usable).

### Where to find coach payment history
Stripe Dashboard → Transfers → filter by destination to see what's been sent to a specific coach.

---

## Stripe balance

The Roots Stripe account collects all session and pass payments. Key things to know:

- **Available balance** — ready to use for transfers or payouts. Can be £0 immediately after a busy weekend because settlements take 2–7 business days.
- **Pending balance** — incoming funds not yet settled. Will become available after the settlement period.
- **Payouts** — Stripe automatically pays out the available balance to the Roots bank account on a rolling schedule. Pause payouts in Stripe Dashboard → Settings → Payouts if you need to keep funds available for coach transfers.

---

## Venue proposals

When a host proposes a new venue, all owners receive an email. Pending venues appear at the top of the **Venues** screen with an amber "Pending" badge.

- **Approve** — venue goes live and becomes available to all hosts
- **Reject** — venue is deleted; the proposing host is not currently notified (manual message recommended)

The host can use a pending venue in their session immediately after proposing it — approval only affects whether other hosts can see it.

---

## Firebase: things that only work via Console

- **Granting / revoking roles** — roles live in `users/{uid}.roles[]`. Change them in Firestore Console or via the Users screen in the app (admin role required). Role changes via the app go through Cloud Functions; direct Firestore edits bypass those checks — use the app where possible.
- **Deleting a user entirely** — delete from both Firestore (`users/{uid}`) and Firebase Authentication (Auth tab). Deleting only one leaves orphaned data.
- **Viewing raw session data** — Firestore Console → `sessions` collection. Useful for debugging attendee counts or payment state.

---

## Cloud Functions: what fires when

| Function | Trigger |
|---|---|
| `stripeWebhook` | Stripe payment confirmed → marks attendee paid, fires confirmation email, triggers waiting list check |
| `cancelRegistration` | Player cancels → issues refund if > 24h before session, notifies waiting list |
| `approveCoachPayment` | Admin approves → transfers funds or sends onboarding email |
| `stripeConnectWebhook` | Coach completes Stripe onboarding → fires pending coach transfers automatically |
| `notifyVenueProposal` | Host proposes a venue → emails all owners |
| `notifyCoachRequest` | User requests coach role → emails all admins |
| `notifyProviderRequest` | User requests host role → emails all admins |

**To view function logs:** Firebase Console → Functions → Logs, or run `firebase functions:log` in the terminal.

---

## Common problems

**Attendee count is wrong (shows different from actual attendees)**
The `attendeeCount` field on the session doc is denormalised and can drift. Fix: open the session in the app — the count recalculates on load. If still wrong, manually correct the field in Firestore Console.

**Player paid but shows as unpaid**
The Stripe webhook may have failed. Check: Stripe Dashboard → Developers → Webhooks → recent events. Look for a failed `checkout.session.completed` event and use "Resend" to retry it.

**Coach onboarding email never arrived**
Check the Gmail sent folder (`edu.pignatelli@gmail.com`). If it sent, ask the coach to check spam. If it didn't send, check Firebase Functions logs for `notifyCoachRequest` or `approveCoachPayment` errors, then tap Approve again from the session detail.
