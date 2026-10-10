// Push-reminder sender for Purrkfection.
//
// For every ledger document, finds the credits that still have money on them and reset
// within each subscribed device's lead window, then sends one Web Push notification per
// device per day. Runs from .github/workflows/reminders.yml.
//
//   node scripts/send-reminders.mjs            # send
//   node scripts/send-reminders.mjs --dry-run  # print, don't send, don't write back
//   node scripts/send-reminders.mjs --dry-run --fixture path/to/ledgers.json
//
// Env: FIREBASE_SERVICE_ACCOUNT (JSON), VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https:),
//      APP_URL (optional; the link the notification opens).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { findExpiringCredits } = require(path.join(here, "..", "ledger-math.js"));

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const fixtureIdx = args.indexOf("--fixture");
const FIXTURE = fixtureIdx !== -1 ? args[fixtureIdx + 1] : null;
const LEDGERS_COLLECTION = "perkfectionLedgers";
const DEFAULT_LEAD_DAYS = 5;

// The app's date math works in local time, so build a Date whose local components are
// "today at noon" in the subscriber's own time zone — the process runs in UTC on CI.
function nowIn(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return new Date(get("year"), get("month") - 1, get("day"), 12);
  } catch (e) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  }
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function money(n) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

// Builds the notification for one device, or null if nothing is expiring in its window.
export function buildReminder(ledger, entry, now) {
  const leadDays = Number(entry.leadDays) || DEFAULT_LEAD_DAYS;
  const expiring = findExpiringCredits(ledger.benefits || [], ledger.usage || {}, now, leadDays);
  if (expiring.length === 0) return null;
  const cardsById = Object.fromEntries((ledger.cards || []).map((c) => [c.id, c]));
  const total = expiring.reduce((s, e) => s + e.remaining, 0);
  const when = (d) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
  const lines = expiring.slice(0, 4).map((e) => {
    const card = cardsById[e.benefit.cardId];
    return `${money(e.remaining)} ${e.benefit.name}${card ? ` (${card.name})` : ""} — ${when(e.daysLeft)}`;
  });
  if (expiring.length > 4) lines.push(`…and ${expiring.length - 4} more`);
  const title = expiring.length === 1
    ? `${money(total)} credit expiring ${when(expiring[0].daysLeft)}`
    : `${expiring.length} credits worth ${money(total)} expiring soon`;
  return { title, body: lines.join("\n"), tag: "perkfection-expiring", count: expiring.length, total };
}

async function loadLedgers() {
  if (FIXTURE) {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    return { ledgers: Object.entries(raw).map(([id, data]) => ({ id, data })), writeBack: async () => {} };
  }
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) {
    // Not configured yet: say so and stop cleanly, rather than failing the scheduled run
    // every day (and emailing the owner about it) until the secrets are added.
    console.log("Reminders are not set up yet: the FIREBASE_SERVICE_ACCOUNT secret is missing. See README → Push reminders. Nothing sent.");
    return null;
  }
  const admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  const db = admin.firestore();
  const snap = await db.collection(LEDGERS_COLLECTION).get();
  const ledgers = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const writeBack = async (ledgerId, deviceId, patch) => {
    const ref = db.collection(LEDGERS_COLLECTION).doc(ledgerId);
    if (patch === null) await ref.update({ [`push.${deviceId}`]: admin.firestore.FieldValue.delete() });
    else {
      const update = {};
      Object.entries(patch).forEach(([k, v]) => { update[`push.${deviceId}.${k}`] = v; });
      await ref.update(update);
    }
  };
  return { ledgers, writeBack };
}

async function main() {
  const loaded = await loadLedgers();
  if (!loaded) return;
  const { ledgers, writeBack } = loaded;
  let webpush = null;
  if (!DRY_RUN) {
    if (!process.env.VAPID_PRIVATE_KEY) {
      console.log("Reminders are not set up yet: the VAPID_PRIVATE_KEY secret is missing. See README → Push reminders. Nothing sent.");
      return;
    }
    webpush = require("web-push");
    const appSrc = readFileSync(path.join(here, "..", "src", "app.jsx"), "utf8");
    const publicKey = (appSrc.match(/const VAPID_PUBLIC_KEY = "([^"]+)"/) || [])[1];
    if (!publicKey || publicKey.startsWith("__")) throw new Error("VAPID_PUBLIC_KEY in src/app.jsx is not set.");
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:owner@example.com", publicKey, process.env.VAPID_PRIVATE_KEY);
  }
  const appUrl = process.env.APP_URL || "./";
  let devices = 0, sent = 0, quiet = 0, skipped = 0, dropped = 0;

  for (const { id: ledgerId, data } of ledgers) {
    const push = data.push || {};
    for (const [deviceId, entry] of Object.entries(push)) {
      devices += 1;
      if (!entry || !entry.endpoint || !entry.keys) { skipped += 1; continue; }
      const now = nowIn(entry.tz || "UTC");
      const today = dayKey(now);
      if (entry.lastSentOn === today) { skipped += 1; continue; } // at most one nudge per day
      const reminder = buildReminder(data, entry, now);
      if (!reminder) { quiet += 1; continue; }
      const label = `${ledgerId} / ${entry.name || deviceId} (${entry.tz || "UTC"}, ${entry.leadDays || DEFAULT_LEAD_DAYS}d)`;
      if (DRY_RUN) {
        console.log(`[dry-run] ${label}\n  ${reminder.title}\n  ${reminder.body.replace(/\n/g, "\n  ")}`);
        sent += 1;
        continue;
      }
      try {
        await webpush.sendNotification(
          { endpoint: entry.endpoint, keys: entry.keys },
          JSON.stringify({ title: reminder.title, body: reminder.body, tag: reminder.tag, url: appUrl }),
          { TTL: 60 * 60 * 12 }
        );
        await writeBack(ledgerId, deviceId, { lastSentOn: today, lastSentAt: new Date().toISOString() });
        sent += 1;
        console.log(`sent: ${label} — ${reminder.title}`);
      } catch (err) {
        // 404/410 mean the browser revoked the subscription (user cleared data, uninstalled,
        // or turned notifications off in the OS). Drop it so we stop trying.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await writeBack(ledgerId, deviceId, null);
          dropped += 1;
          console.log(`dropped stale subscription: ${label}`);
        } else {
          console.error(`failed: ${label}`, err && err.message ? err.message : err);
          process.exitCode = 1;
        }
      }
    }
  }
  console.log(`devices=${devices} sent=${sent} nothing-expiring=${quiet} skipped=${skipped} dropped=${dropped}${DRY_RUN ? " (dry run)" : ""}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
