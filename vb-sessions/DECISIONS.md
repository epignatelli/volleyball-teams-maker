# vb-sessions — Design Decisions

Technical and product decisions that aren't obvious from the code, with the reasoning behind them.

---

## Role request model

**Files:** `app.js` (`_requestObj`, `_isOpenRequest`, `_requestClosed`), `functions/index.js` (`handleRequestAction`, `_createRequestTokens`)

Role requests (`coachRequest`, `providerRequest`) are stored as objects on the user doc in Firestore — not as booleans.

```js
// open request (written on submit)
{ id: 'a3f9bc12', status: 'open', requestedAt: <timestamp>, expiresAt: <date +30d> }

// closed request (written on approve / decline / cancel)
{ id: 'a3f9bc12', status: 'approved' | 'declined' | 'cancelled', requestedAt: <timestamp>, expiresAt: <date>, respondedAt: <timestamp> }
```

**Why not booleans?** A `coachRequest: true` field can be re-opened by an old "Approve" email link even after the request was rejected. The object lets us check `status === 'open'` before acting.

**Why a random `id`?** (User, role) is not sufficient to identify a specific request — a user can cancel and re-apply. The `id` binds email tokens to one specific submission; a token generated for an old request cannot act on a new one.

**Why `expiresAt` on the request (30 days)?** Email tokens expire in 7 days (urgency to act on the email). The request itself expires in 30 days so that a stale "pending" badge can't sit in the UI forever, and so the Cloud Function guard rejects tokens against an expired request even if somehow a token slipped through.

---

## Email token security (handleRequestAction)

Each `notifyCoachRequest` / `notifyProviderRequest` call creates **two** tokens in `requestTokens` — one for Approve, one for Reject. Before acting, `handleRequestAction` checks all of these gates in order:

1. Token exists in Firestore
2. `token.used !== true`
3. `token.expiresAt > now` (7 days)
4. User doc exists
5. `coachRequest.status === 'open'`
6. `coachRequest.expiresAt > now` (30 days)
7. `coachRequest.id === token.requestId` (binds token to specific submission)

On success: marks **both** the used token and its sibling (`siblingToken`) as `used: true` atomically, so clicking the other button in the same email is a no-op.

**Why server-side?** Client-side checks are bypassed by anyone with direct Firestore access or by replaying requests. All security gates that grant or revoke roles must live in Cloud Functions.

---

## CSS bottom chrome

**File:** `vb-sessions/style.css`, `shared.css`

The filter bar and roots-footer are wrapped in a single `.bottom-chrome` `position: fixed; bottom: 0; display: flex; flex-direction: column` container. This avoids calculating `bottom` offsets manually — the browser stacks them naturally.

The roots-footer padding is defined in `shared.css` (loaded after `vb-sessions/style.css`), so it wins at equal specificity. Edit `shared.css` to change footer height — changes to `vb-sessions/style.css` `.roots-footer` have no effect.

Rendered footer height on desktop: `18px (top) + 18px (bottom) = 36px`. On iPhone (safe-area ~34px): `18px + 34px = 52px`.

All scrollable content areas need `padding-bottom` to clear the chrome. Action bars (`.footer`) need `margin-bottom` equal to the roots-footer height so they sit flush above it.

---

## Service worker versioning

**File:** `vb-sessions/sw.js` — `const CACHE = 'vb-sessions-vN'`

Bump `N` with every CSS or JS change that should be visible to existing users. The activate handler purges old cache keys automatically. Forgetting to bump means users see stale files until they hard-refresh.

---

## shared.css load order

`vb-sessions/index.html` loads stylesheets in this order:

```html
<link rel="stylesheet" href="../fonts/barlow-condensed.css" />
<link rel="stylesheet" href="./style.css" />
<link rel="stylesheet" href="../shared.css" />
```

`shared.css` wins at equal specificity. Shared component styles (topbar, roots-footer) belong in `shared.css`; screen-specific styles belong in `style.css`.
