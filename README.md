# Purrkfection

A shared ledger for tracking credit-card perks — which credits you've captured this period,
what's about to reset unused, and how much each card has earned back against its fee.

The whole app is `index.html` (React, compiled in the browser) backed by one Firestore
document per ledger. People sharing a ledger join with a code or an invite link. Hosted as
static files (GitHub Pages works as-is).

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The app. |
| `ledger-math.js` | Period, redemption and expiry rules shared by the app and the reminder sender. |
| `sw.js` | Service worker: offline shell cache plus push-notification display. |
| `scripts/send-reminders.mjs` | Finds expiring credits per subscribed device and sends Web Push notifications. |
| `.github/workflows/reminders.yml` | Runs the sender once a day. |

## Push reminders — one-time setup

Reminders are Web Push notifications, sent by a GitHub Actions job rather than a server you
run. Each device opts in from **Settings → Reminders** inside the app. For the job to send
anything, the repository needs two secrets:

1. **`VAPID_PRIVATE_KEY`** — the private half of the key pair whose public half is the
   `VAPID_PUBLIC_KEY` constant in `index.html`. The two must match. To rotate, generate a
   new pair with `npx web-push generate-vapid-keys`, paste the public key into
   `index.html`, and put the private key in this secret (every device will need to opt in
   again).
2. **`FIREBASE_SERVICE_ACCOUNT`** — a service-account JSON for the Firebase project.
   Firebase console → Project settings → Service accounts → *Generate new private key*,
   then paste the file's contents into the secret. The sender reads every ledger with it
   and records when each device was last notified.

Optional repository *variables*: `VAPID_SUBJECT` (a `mailto:` address push services can
contact — set this to your own), and `APP_URL` (what a tapped notification opens; defaults
to the app's own origin).

Then run the workflow once by hand (Actions → *Expiring-credit reminders* → Run workflow,
tick *dry run*) to confirm it can read the ledgers and see who would be notified.

Notes:

- iPhone and iPad only receive web push from apps added to the Home Screen (iOS 16.4+).
  The Settings panel says so when it detects that case.
- A device hears at most once a day, and only when a credit with money still on it resets
  within its lead window (3, 5 or 7 days, chosen per device).
- Stale subscriptions (device wiped, notifications revoked) are removed automatically.

## Local dry run

```
npm install
node scripts/send-reminders.mjs --dry-run --fixture path/to/ledgers.json
```

where the fixture is `{ "<ledger code>": { cards, benefits, usage, push } }` — the same shape
as the Firestore documents.
