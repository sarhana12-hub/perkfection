// Shared period / redemption / expiry rules for Purrkfection.
//
// Loaded by index.html as a plain script (window.LedgerMath) and by the reminder sender in
// scripts/send-reminders.mjs (CommonJS), so the app and the push notifications can never
// disagree about which credits are about to expire.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LedgerMath = factory();
})(typeof self !== "undefined" ? self : this, function () {

function getPeriodInfo(periodicity, date = new Date(), resetMonth, resetDay) {
  const y = date.getFullYear();
  const m = date.getMonth();
  let key, start, end, label;
  if (periodicity === "monthly") {
    key = `${y}-${String(m + 1).padStart(2, "0")}`;
    start = new Date(y, m, 1);
    end = new Date(y, m + 1, 0);
    label = start.toLocaleDateString(undefined, { month: "long" });
  } else if (periodicity === "quarterly") {
    const q = Math.floor(m / 3);
    key = `${y}-Q${q + 1}`;
    start = new Date(y, q * 3, 1);
    end = new Date(y, q * 3 + 3, 0);
    label = `Q${q + 1} ${y}`;
  } else if (periodicity === "semiannual") {
    const h = m < 6 ? 1 : 2;
    key = `${y}-H${h}`;
    start = new Date(y, h === 1 ? 0 : 6, 1);
    end = new Date(y, h === 1 ? 6 : 12, 0);
    label = h === 1 ? `Jan–Jun ${y}` : `Jul–Dec ${y}`;
  } else if (resetMonth && resetDay) {
    // Anniversary-based annual credit: runs from the most recent reset date up to (not
    // including) the next one, rather than the calendar year.
    const am = resetMonth - 1;
    const thisYearReset = new Date(y, am, resetDay);
    const startYear = date < thisYearReset ? y - 1 : y;
    start = new Date(startYear, am, resetDay);
    end = new Date(startYear + 1, am, resetDay - 1);
    key = `${startYear}-${String(resetMonth).padStart(2, "0")}-${String(resetDay).padStart(2, "0")}`;
    label = `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  } else {
    key = `${y}`;
    start = new Date(y, 0, 1);
    end = new Date(y, 11, 31);
    label = `${y}`;
  }
  const total = end - start;
  const elapsed = date - start;
  const daysLeft = Math.max(0, Math.ceil((end - date) / (1000 * 60 * 60 * 24)));
  return { key, start, end, label, fracElapsed: Math.min(1, Math.max(0, elapsed / total)), daysLeft };
}

// Turns a stored period key (e.g. "2026-03", "2026-Q1", "2026-H1", "2026", or the
// anniversary-style "2026-03-15") back into a readable label and a sortable date, for
// browsing past periods in the History view. The shape is read off the key itself rather
// than the benefit's current periodicity, so entries logged before a benefit's cadence was
// edited still get a sensible label instead of "Invalid Date".
function parsePeriodKey(periodicity, key) {
  const k = String(key);
  const year = Number(k.slice(0, 4));
  let m;
  if ((m = /^\d{4}-Q(\d)$/.exec(k))) {
    const q = Number(m[1]);
    return { label: `Q${q} ${year}`, sortDate: new Date(year, (q - 1) * 3, 1) };
  }
  if ((m = /^\d{4}-H(\d)$/.exec(k))) {
    const h = Number(m[1]);
    return { label: h === 1 ? `Jan–Jun ${year}` : `Jul–Dec ${year}`, sortDate: new Date(year, h === 1 ? 0 : 6, 1) };
  }
  if ((m = /^\d{4}-(\d{2})$/.exec(k))) {
    const mo = Number(m[1]);
    return { label: new Date(year, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }), sortDate: new Date(year, mo - 1, 1) };
  }
  if ((m = /^\d{4}-(\d{2})-(\d{2})$/.exec(k))) {
    // Anniversary-based annual credit: "YYYY-MM-DD" marks the start of that credit's cycle.
    const am = Number(m[1]) - 1;
    const ad = Number(m[2]);
    const start = new Date(year, am, ad);
    const end = new Date(year + 1, am, ad - 1);
    return {
      label: `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
      sortDate: start,
    };
  }
  return { label: `${year}`, sortDate: new Date(year, 0, 1) };
}

// Redemption + completion are derived from the benefit's current definition, not a frozen
// snapshot, so editing a credit's value later doesn't leave stale numbers in past periods.
function redeemedValue(benefit, u) {
  const mode = benefit.trackingMode || "single";
  const cap = Number(benefit.value) || 0;
  if (!u) return 0;
  if (mode === "offer") return Number(u.amount) || 0; // no cap — whatever's been logged is the value
  if (mode === "cumulative") return Math.min(Number(u.amount) || 0, cap);
  if (mode === "counter") return (Number(u.count) || 0) * cap;
  return u.used || u.done ? cap : 0;
}

function isBenefitDone(benefit, u) {
  const mode = benefit.trackingMode || "single";
  if (!u) return false;
  if (mode === "offer") return false; // open-ended — never "complete"
  if (mode === "cumulative") {
    const cap = Number(benefit.value) || 0;
    return cap > 0 && (Number(u.amount) || 0) >= cap;
  }
  if (mode === "counter") {
    return Number(benefit.targetCount) > 0 && (Number(u.count) || 0) >= Number(benefit.targetCount);
  }
  return !!(u.used || u.done);
}

// Credits worth flagging before they reset unused: anything with a fixed dollar cap that
// still has value left and fewer than `leadDays` days to go. Counters and open-ended
// cash-back offers have no cap to lose, so they're never "expiring". Sorted by how much
// is on the table, largest first.
function findExpiringCredits(benefits, usage, now, leadDays) {
  const out = [];
  (benefits || []).forEach((b) => {
    const mode = b.trackingMode || "single";
    if (mode === "counter" || mode === "offer") return;
    const info = getPeriodInfo(b.periodicity, now, b.resetMonth, b.resetDay);
    const u = (usage || {})[`${b.id}:${info.key}`];
    const cap = Number(b.value) || 0;
    const remaining = isBenefitDone(b, u) ? 0 : Math.max(0, cap - redeemedValue(b, u));
    if (remaining > 0 && info.daysLeft <= leadDays) out.push({ benefit: b, remaining, daysLeft: info.daysLeft, periodKey: info.key });
  });
  out.sort((a, b) => b.remaining - a.remaining);
  return out;
}

return { getPeriodInfo, parsePeriodKey, redeemedValue, isBenefitDone, findExpiringCredits };
});
