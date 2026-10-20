/**
 * metrics.mjs
 *
 * All of the calculation: scoping, headcount, churn, gender pay gap, trend.
 * Pure function, no network and no I/O, so it can be reasoned about and tested on its own.
 *
 * Edit the configuration block below to match your Employment Hero values.
 */

// ---------------------------------------------------------------- configuration

const STANDARD_HOURS_PER_WEEK = 38;
const WEEKS_PER_YEAR = 52;

// Termination type values that count as voluntary. From the export, the volumes are
// Voluntary cessation, resignation, termination, other, Dismissal, Contract cessation,
// Redundancy, Transfer and Deceased. "other" is deliberately left out: it is ambiguous
// and there are enough of them to move the number. Add it if your reporting treats it
// as voluntary.
// Termination types that are not exits from the group at all. These count in neither
// voluntary nor total turnover, and the person is not treated as a leaver.
const NON_LEAVER_REASONS = ["transfer"];

const VOLUNTARY_REASONS = [
  "voluntary cessation",
  "resignation",
  "resigned"
];

// Entity comes from which Employment Hero organisation the record sits in. Location then
// decides whether the person actually belongs to that entity.
//
// These are ALLOW lists, not exclusion lists. Anyone whose location is not on the list for
// their organisation is dropped, which covers blank locations, access-only accounts, and
// anyone sitting in the wrong entity, without having to enumerate every bad value.
//
// Matched exactly, ignoring case and surrounding spaces. Pull the distinct Location values
// out of Employment Hero and make these match them, or the counts will come out low.
const AU_ENTITY_LOCATIONS = [
  "melbourne victoria",
  "sydney new south wales",
  "brisbane queensland",
  "adelaide south australia",
  "gold coast queensland",
  "perth western australia",
  "canberra australian capital territory"
];
const UK_ENTITY_LOCATIONS = ["london"];

// Employment types that are not headcount. Substring match, so "Independent Contractor
// (Fixed Term)" is caught by "independent contractor". People whose start date is still in
// the future are excluded automatically by the active-at-date test, no configuration needed.
// Cost centres folded into another one. Keys are matched after normalisation, lower case.
const COST_CENTRE_MERGES = {
  "wa": "Melbourne"
};

// The London entity records no cost centre at all, so it gets one. Applied after
// normalisation, so it wins regardless of what is or is not on the record.
const ENTITY_COST_CENTRE = {
  UK: "London"
};

// NAT prefixes that report to their local office rather than rolling up nationally.
// NAT-STR Melbourne becomes Melbourne, NAT-STR Sydney becomes Sydney.
const NAT_REPORT_LOCALLY = ["NAT-STR"];

// Below this average headcount a turnover rate is too volatile to be worth showing:
// one leaver from a team of two reads as 50 per cent and tells you nothing.
const MIN_HEADCOUNT_FOR_RATE = 3;

// Where the turnover trend line starts. January 2023 is the earliest honest point:
// Employment Hero was migrated into around late 2022, and every leaver record from
// before that came across as a stub with no employment type, cost centre or start date.
// Those stubs are dropped by the scoping above, so a line drawn through 2020 to 2022
// would read as near zero turnover and then leap, which is an artefact and not history.
const TREND_START_YEAR = 2023;
const TREND_START_MONTH = 0;   // 0 = January

// Cost centre values that mean "not set". Normalised to Unassigned.
const UNASSIGNED_COST_CENTRES = ["adp consulting pty ltd", "adp consulting", "n/a", "-"];

// A record with no employment type has no contract type, no pay and no job title either.
// In the London entity these are shell or access records rather than staff.
const REQUIRE_EMPLOYMENT_TYPE = true;

// Every current employee has a cost centre. A record without one is an external contractor
// or similar, so it counts for neither headcount nor leavers. London is exempt because the
// entity sets its cost centre rather than the record carrying one.
const REQUIRE_COST_CENTRE = true;

const EXCLUDED_EMPLOYMENT_TYPES = [
  "independent contractor",
  "contractor",
  "subcontractor",
  "agency"
];

// ---------------------------------------------------------------- types

// ---------------------------------------------------------------- helpers

function parseDate(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (!v || v.toUpperCase() === "N/A" || v === "-") return null;

  // dd/mm/yyyy. Left to the JS parser this reads as mm/dd/yyyy and is silently wrong
  // for every day past the twelfth of the month.
  const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
  }

  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function monthEnd(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59));
}

/** Exact match, ignoring case and surrounding spaces. */
function matchesAny(value, list) {
  const v = (value || "").toLowerCase().trim();
  if (!v) return false;
  return list.indexOf(v) >= 0;
}

/** Substring match, ignoring case, for employment type values that carry extra wording. */
/**
 * Groups the NAT cost centres so NAT-ESD Melbourne and NAT-ESD Sydney both become NAT-ESD.
 * Everything else is left as recorded, with blanks and placeholder values as Unassigned.
 */
function normaliseCostCentre(value) {
  let v = String(value || "").trim();
  if (!v) return "Unassigned";
  if (UNASSIGNED_COST_CENTRES.indexOf(v.toLowerCase()) >= 0) return "Unassigned";

  // "NAT - CORP" and "NAT-CORP Melbourne" both need to land on NAT-CORP
  v = v.replace(/\s*-\s*/g, "-");
  const nat = v.match(/^(NAT-[A-Za-z]+)\s*(.*)$/);
  if (nat) {
    const prefix = nat[1].toUpperCase();
    const office = (nat[2] || "").trim();
    // Some disciplines report to their office instead of rolling up nationally
    if (NAT_REPORT_LOCALLY.indexOf(prefix) >= 0) {
      return office ? office : "Unassigned";
    }
    return prefix;
  }

  const merged = COST_CENTRE_MERGES[v.toLowerCase()];
  if (merged) return merged;

  return v;
}

// Location values carry the state, which is noise on a dashboard.
const STATE_SUFFIXES = [
  "victoria", "new south wales", "queensland", "south australia",
  "western australia", "australian capital territory", "tasmania", "northern territory"
];

function tidyLocation(value) {
  let v = String(value || "").trim();
  if (!v) return "Unassigned";
  const lower = v.toLowerCase();
  for (const state of STATE_SUFFIXES) {
    if (lower.endsWith(" " + state)) return v.slice(0, v.length - state.length - 1).trim();
  }
  return v;
}

function containsAny(value, list) {
  const v = (value || "").toLowerCase().trim();
  if (!v) return false;
  return list.some(token => v.indexOf(token) >= 0);
}

/** A transfer is a move, not a departure. */
function isNonLeaver(reason) {
  const r = (reason || "").toLowerCase().trim();
  if (!r) return false;
  return NON_LEAVER_REASONS.some(token => r.indexOf(token) >= 0);
}

function isVoluntary(reason) {
  const r = (reason || "").toLowerCase().trim();
  if (!r) return false;
  return VOLUNTARY_REASONS.some(token => r.indexOf(token) >= 0);
}

function activeAt(e, when) {
  const start = parseDate(e.startDate);

  // A missing start date means the record predates the field. Treat them as already
  // started rather than dropping them, which would understate every historical month.
  if (start && start > when) return false;

  // Employment status wins over the termination date. Some current employees carry a
  // stale termination date from an earlier stint, and counting those loses real people.
  if (String(e.status || "").toLowerCase() === "active") return true;

  const term = parseDate(e.terminationDate);
  return !term || term > when;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round1(value) {
  if (!isFinite(value)) return "0.0";
  return (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * Full-time equivalent base salary.
 *   Full time  the annual salary as recorded
 *   Part time  scaled up to a 38 hour week
 *   Casual     hourly rate multiplied by 38 by 52
 * Returns 0 when there is nothing usable, so the record can be excluded rather than
 * dragging the average down with a zero.
 */
function fteSalary(e) {
  const type = (e.employmentType || "").toLowerCase();

  if (type.indexOf("casual") >= 0) {
    const rate = Number(e.hourlyRate) || 0;
    return rate > 0 ? rate * STANDARD_HOURS_PER_WEEK * WEEKS_PER_YEAR : 0;
  }

  const salary = Number(e.annualSalary) || 0;
  if (salary <= 0) return 0;

  if (type.indexOf("part") >= 0) {
    const hours = Number(e.hoursPerWeek) || 0;
    if (hours > 0 && hours < STANDARD_HOURS_PER_WEEK) {
      return salary * (STANDARD_HOURS_PER_WEEK / hours);
    }
    return salary;
  }

  return salary;
}

/** Pay gap as a percentage of the male figure. Positive means men are paid more. */
function payGap(maleValues, femaleValues, useMedian) {
  const m = useMedian ? median(maleValues) : mean(maleValues);
  const f = useMedian ? median(femaleValues) : mean(femaleValues);
  if (m <= 0 || f <= 0) return "0.0";
  return round1(((m - f) / m) * 100);
}

function isFemale(e) {
  return (e.gender || "").toLowerCase().indexOf("female") === 0;
}

function isMale(e) {
  const g = (e.gender || "").toLowerCase();
  return g === "male" || g === "m";
}

// ---------------------------------------------------------------- shared scoping

/**
 * Decides who is headcount at all, before any date is considered.
 *
 * Exported so the team dashboard applies exactly the same rules. If the two dashboards
 * ever disagree on a total, it is because one of them stopped calling this.
 *
 * Excluded here, from headcount and from leavers alike:
 *   blank location, location inconsistent with the entity, independent contractors,
 *   records with no employment type, records with no cost centre.
 *
 * Future start dates are NOT excluded here. They are excluded by the active-at-date test,
 * because somebody who starts next month is still in scope, just not yet counted.
 */
export function scopeEmployees(raw) {
  let excludedBlankLocation = 0;
  let excludedWrongLocationAu = 0;
  let excludedWrongLocationUk = 0;
  let excludedContractors = 0;
  let excludedIncomplete = 0;
  let excludedNoCostCentre = 0;
  let casualsConverted = 0;
  let partTimeConverted = 0;

  const scoped = [];

  for (const e of raw) {
    const loc = (e.location || "").trim();
    const entity = (e.entity || "").toUpperCase();

    // No location means we cannot place them in either entity
    if (!loc) { excludedBlankLocation++; continue; }

    // Allow list per organisation: anything else is an access-only account or a
    // person recorded against the wrong entity
    if (entity === "AU" && !matchesAny(loc, AU_ENTITY_LOCATIONS)) {
      excludedWrongLocationAu++;
      continue;
    }
    if (entity === "UK" && !matchesAny(loc, UK_ENTITY_LOCATIONS)) {
      excludedWrongLocationUk++;
      continue;
    }

    // Independent contractors are not headcount. The explicit Employment Hero flag is
    // authoritative; the employment type list is a fallback for anything it misses.
    if (e.independentContractor === true || containsAny(e.employmentType, EXCLUDED_EMPLOYMENT_TYPES)) {
      excludedContractors++;
      continue;
    }

    // Shell records: no employment type, and with it no contract type, pay or job title
    if (REQUIRE_EMPLOYMENT_TYPE && !String(e.employmentType || "").trim()) {
      excludedIncomplete++;
      continue;
    }

    // No cost centre means not on the books as an employee
    const centre = ENTITY_COST_CENTRE[entity] || normaliseCostCentre(e.costCentre);
    if (REQUIRE_COST_CENTRE && centre === "Unassigned") {
      excludedNoCostCentre++;
      continue;
    }

    const type = (e.employmentType || "").toLowerCase();
    if (type.indexOf("casual") >= 0) casualsConverted++;
    else if (type.indexOf("part") >= 0) partTimeConverted++;

    scoped.push({
      id: e.id,
      name: e.name,
      gender: e.gender,
      location: loc,
      employmentType: e.employmentType,
      hoursPerWeek: e.hoursPerWeek,
      annualSalary: e.annualSalary,
      hourlyRate: e.hourlyRate,
      startDate: e.startDate,
      terminationDate: e.terminationDate,
      terminationReason: e.terminationReason,
      level4: e.level4,
      costCentre: centre,
      // Carried for the team dashboard. Absent on older records, which is handled there.
      jobTitle: e.jobTitle || "",
      birthDate: e.birthDate || "",
      independentContractor: e.independentContractor === true,
      rehire: e.rehire === true ? true : (e.rehire === false ? false : null),
      status: e.status,
      entity: entity,
      fteSalary: fteSalary(e)
    });
  }

  return {
    scoped: scoped,
    quality: {
      excludedBlankLocation: excludedBlankLocation,
      excludedWrongLocationAu: excludedWrongLocationAu,
      excludedWrongLocationUk: excludedWrongLocationUk,
      excludedContractors: excludedContractors,
      excludedIncomplete: excludedIncomplete,
      excludedNoCostCentre: excludedNoCostCentre,
      casualsConverted: casualsConverted,
      partTimeConverted: partTimeConverted
    }
  };
}

// Shared with the team dashboard so both pages treat dates and labels identically
export { parseDate, monthEnd, activeAt, tidyLocation, isFemale, isMale, mean, round1 };

// ---------------------------------------------------------------- main

export function computeMetrics(employees, asOfIso, options) {
  // Names are personal data. Off unless explicitly switched on, and only ever useful
  // behind the dashboard password.
  const includeNames = !!(options && options.includeNames);

  const raw = employees;
  const asOf = parseDate(asOfIso) || new Date();

  /**
   * The current month is only complete up to today, so every "now" snapshot stops there.
   * Without this, anyone starting later this month is counted in today's headcount.
   */
  function capAt(d) {
    return d > asOf ? asOf : d;
  }

  const thisMonthEnd = capAt(monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth()));
  const priorMonthEnd = monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1);

  // ---- scope: drop blank and unmapped locations, assign entity by location

  const scopeResult = scopeEmployees(raw);
  const scoped = scopeResult.scoped;
  const {
    excludedBlankLocation, excludedWrongLocationAu, excludedWrongLocationUk,
    excludedContractors, excludedIncomplete, excludedNoCostCentre,
    casualsConverted, partTimeConverted
  } = scopeResult.quality;

  // ---- headcount, now and a month ago

  // Anyone whose start date is still ahead of us is not headcount yet. The active-at-date
  // test already handles this; the counter is only so the number is visible on the dashboard.
  const notYetStarted = scoped.filter(e => {
    const start = parseDate(e.startDate);
    return start !== null && start > thisMonthEnd;
  }).length;

  const activeNow = scoped.filter(e => activeAt(e, thisMonthEnd));
  const activePrior = scoped.filter(e => activeAt(e, priorMonthEnd));

  const femaleNow = activeNow.filter(isFemale);
  const femalePrior = activePrior.filter(isFemale);

  // ---- month-end headcount for the last 13 months, used for LTM averages and the trend

  const monthEnds = [];
  for (let i = 11; i >= 0; i--) {
    monthEnds.push(capAt(monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - i)));
  }
  const monthlyHeadcount = monthEnds.map(d => scoped.filter(e => activeAt(e, d)).length);
  const avgHeadcountLtm = mean(monthlyHeadcount);

  // The same window shifted back a month, so the churn figure has something to compare to
  const priorMonthEnds = [];
  for (let i = 12; i >= 1; i--) {
    priorMonthEnds.push(monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - i));
  }
  const avgHeadcountLtmPrior = mean(priorMonthEnds.map(d => scoped.filter(e => activeAt(e, d)).length));

  // ---- leavers

  function leaversBetween(from, to, pool) {
    return pool.filter(e => {
      if (isNonLeaver(e.terminationReason)) return false;
      const t = parseDate(e.terminationDate);
      return t !== null && t > from && t <= to;
    });
  }

  /**
   * Someone counts as a new hire once their start date has passed, never before. A
   * forward-looking range would otherwise report people who have not started, and may
   * not have signed, as hires.
   */
  function startersBetween(from, to, pool) {
    const cap = to > asOf ? asOf : to;
    return pool.filter(e => {
      const st = parseDate(e.startDate);
      return st !== null && st > from && st <= cap;
    });
  }

  const ltmStart = monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 12);
  const ltmStartPrior = monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 13);

  const leaversLtm = leaversBetween(ltmStart, thisMonthEnd, scoped);
  const leaversLtmPrior = leaversBetween(ltmStartPrior, priorMonthEnd, scoped);

  // A rolling 30 days rather than the calendar month, so the figures do not collapse to
  // zero on the first of the month.
  const DAY = 24 * 60 * 60 * 1000;
  const last30Start = new Date(asOf.getTime() - 30 * DAY);
  const prior30Start = new Date(asOf.getTime() - 60 * DAY);
  const prior30End = last30Start;

  const monthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0, 23, 59, 59));
  const priorMonthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1, 0, 23, 59, 59));
  const hiresMonth = startersBetween(last30Start, thisMonthEnd, scoped);
  const hiresMonthPrior = startersBetween(prior30Start, prior30End, scoped);
  const leaversMonth = leaversBetween(last30Start, thisMonthEnd, scoped);
  const leaversMonthPrior = leaversBetween(prior30Start, prior30End, scoped);

  // ---- turnover, one engine for every period
  //
  // Rate = terminations in the period / average monthly headcount across the period x 100.
  // The denominator is the mean of each month-end headcount inside the period, not the
  // average of opening and closing, which misreads any period where headcount moves about.

  function monthEndsBetween(from, to) {
    const ends = [];
    let y = from.getUTCFullYear();
    let m = from.getUTCMonth();
    for (let i = 0; i < 120; i++) {
      const end = monthEnd(y, m);
      if (end > to) break;
      if (end > from) ends.push(end);
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    if (!ends.length) ends.push(to);
    return ends;
  }

  function rate(count, avgHead) {
    if (avgHead <= 0) return "0.0";
    return round1((count / avgHead) * 100);
  }

  function turnoverFor(pool, from, to, key, label) {
    const ends = monthEndsBetween(from, to);
    const avgHead = mean(ends.map(d => pool.filter(e => activeAt(e, d)).length));
    const leavers = leaversBetween(from, to, pool);
    const vol = leavers.filter(e => isVoluntary(e.terminationReason));
    const regrettable = vol.filter(e => e.rehire === true);
    const months = ends.length;

    return {
      key: key,
      label: label,
      months: months,
      avgHeadcount: round1(avgHead),
      avgHeadcountValue: avgHead,
      leavers: leavers.length,
      leaversVoluntary: vol.length,
      leaversRegrettable: regrettable.length,
      total: rate(leavers.length, avgHead),
      voluntary: rate(vol.length, avgHead),
      regrettable: rate(regrettable.length, avgHead),
      totalAnnualised: months > 0 ? round1(Number(rate(leavers.length, avgHead)) * (12 / months)) : "0.0",
      voluntaryAnnualised: months > 0 ? round1(Number(rate(vol.length, avgHead)) * (12 / months)) : "0.0",
      regrettableShareOfLeavers: leavers.length ? round1((regrettable.length / leavers.length) * 100) : "0.0",
      rehireFlagMissing: leavers.filter(e => e.rehire === null).length
    };
  }

  // ---- financial year to date, starting 1 July

  const fyStartYear = asOf.getUTCMonth() >= 6 ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1;
  const fyStart = new Date(Date.UTC(fyStartYear, 5, 30, 23, 59, 59));
  const monthsElapsed = ((asOf.getUTCFullYear() - fyStartYear) * 12) + asOf.getUTCMonth() - 6 + 1;

  const leaversYtd = leaversBetween(fyStart, thisMonthEnd, scoped);
  const leaversYtdPrior = leaversBetween(fyStart, priorMonthEnd, scoped);

  const ytdMonthEnds = [];
  for (let i = 0; i < Math.max(monthsElapsed, 1); i++) {
    ytdMonthEnds.push(monthEnd(fyStartYear, 6 + i));
  }
  const avgHeadcountYtd = mean(ytdMonthEnds.map(d => scoped.filter(e => activeAt(e, d)).length));

  const calYear = asOf.getUTCFullYear();
  const calYtdStart = monthEnd(calYear - 1, 11);            // 31 December last year
  const lastCalStart = monthEnd(calYear - 2, 11);
  const lastCalEnd = monthEnd(calYear - 1, 11);

  const periodDefs = [
    { key: "ltm",    label: "Rolling 12 months", from: ltmStart,    to: thisMonthEnd },
    { key: "ytd",    label: "Year to date",      from: calYtdStart, to: thisMonthEnd },
    { key: "fytd",   label: "FYTD",              from: fyStart,     to: thisMonthEnd },
    { key: "last6",  label: "Last 6 months",
      from: monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 6), to: thisMonthEnd },
    { key: "last3",  label: "Last 3 months",
      from: monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 3), to: thisMonthEnd },
    { key: "lastcy", label: String(calYear - 1), from: lastCalStart, to: lastCalEnd }
  ];

  const periods = periodDefs.map(d => turnoverFor(scoped, d.from, d.to, d.key, d.label));

  const ltmPeriod = periods[0];
  const ytdPeriod = periods[2];   // FYTD, to match the report

  function annualised(leavers, avgHead, months) {
    if (avgHead <= 0 || months <= 0) return "0.0";
    return round1((leavers / avgHead) * (12 / months) * 100);
  }

  function churn(leavers, avgHead, voluntaryOnly) {
    if (avgHead <= 0) return "0.0";
    const count = voluntaryOnly
      ? leavers.filter(e => isVoluntary(e.terminationReason)).length
      : leavers.length;
    return round1((count / avgHead) * 100);
  }

  // ---- pay gap

  function gapFor(pool, useMedian) {
    const males = pool.filter(e => isMale(e) && e.fteSalary > 0).map(e => e.fteSalary);
    const females = pool.filter(e => isFemale(e) && e.fteSalary > 0).map(e => e.fteSalary);
    return payGap(males, females, useMedian);
  }

  const excludedNoSalary = activeNow.filter(e => e.fteSalary <= 0).length;

  // ---- by entity

  const entityConfig = [
    { code: "AU", name: "ADP Australia" },
    { code: "UK", name: "ADP London" }
  ];

  const entities = entityConfig.map(cfg => {
    const now = activeNow.filter(e => e.entity === cfg.code);
    const prior = activePrior.filter(e => e.entity === cfg.code);
    const fem = now.filter(isFemale);
    return {
      code: cfg.code,
      name: cfg.name,
      headcount: now.length,
      headcountPrior: prior.length,
      female: fem.length,
      femalePct: now.length ? round1((fem.length / now.length) * 100) : "0.0",
      leaversMonth: leaversMonth.filter(e => e.entity === cfg.code).length,
      hiresMonth: hiresMonth.filter(e => e.entity === cfg.code).length,
      gpgMean: gapFor(now, false),
      gpgMedian: gapFor(now, true)
    };
  });

  // ---- cost centres, with churn against each one's own denominator

  const ccValues = [];
  for (const e of scoped) {
    const v = e.costCentre || "Unassigned";
    if (ccValues.indexOf(v) < 0) ccValues.push(v);
  }

  const costCentres = ccValues.map(code => {
    const pool = scoped.filter(e => (e.costCentre || "Unassigned") === code);
    const nowPool = pool.filter(e => activeAt(e, thisMonthEnd));
    const avgHead = mean(monthEnds.map(d => pool.filter(e => activeAt(e, d)).length));
    const leavers = leaversBetween(ltmStart, thisMonthEnd, pool);
    const volLeavers = leavers.filter(e => isVoluntary(e.terminationReason));
    const regrettableLeavers = volLeavers.filter(e => e.rehire === true);
    const fem = nowPool.filter(isFemale);
    return {
      code: code,
      headcount: nowPool.length,
      female: fem.length,
      femalePct: nowPool.length ? round1((fem.length / nowPool.length) * 100) : "0.0",
      leaversLtm: leavers.length,
      leaversVoluntary: volLeavers.length,
      leaversRegrettable: regrettableLeavers.length,
      churnTotal: avgHead >= MIN_HEADCOUNT_FOR_RATE ? churn(leavers, avgHead, false) : null,
      churnVoluntary: avgHead >= MIN_HEADCOUNT_FOR_RATE ? churn(leavers, avgHead, true) : null,
      churnRegrettable: avgHead >= MIN_HEADCOUNT_FOR_RATE
        ? round1((regrettableLeavers.length / avgHead) * 100) : null,
      avgHeadcountLtm: round1(avgHead),
      openRoles: 0   // merged in from recruitment.json
    };
  })
    // Only cost centres that currently have people. A centre with no headcount and a
    // stray leaver is a record with the field unset, not a team worth a row of its own.
    // Those leavers still count in the company totals.
    .filter(c => c.headcount > 0)
    .sort((a, b) => b.headcount - a.headcount);

  // ---- locations, same method as cost centres

  const locValues = [];
  for (const e of scoped) {
    const v = tidyLocation(e.location);
    if (locValues.indexOf(v) < 0) locValues.push(v);
  }

  const locations = locValues.map(name => {
    const pool = scoped.filter(e => tidyLocation(e.location) === name);
    const nowPool = pool.filter(e => activeAt(e, thisMonthEnd));
    const avgHead = mean(monthEnds.map(d => pool.filter(e => activeAt(e, d)).length));
    const leavers = leaversBetween(ltmStart, thisMonthEnd, pool);
    const volLeavers = leavers.filter(e => isVoluntary(e.terminationReason));
    const fem = nowPool.filter(isFemale);
    return {
      name: name,
      headcount: nowPool.length,
      female: fem.length,
      femalePct: nowPool.length ? round1((fem.length / nowPool.length) * 100) : "0.0",
      leaversLtm: leavers.length,
      leaversVoluntary: volLeavers.length,
      churnTotal: avgHead >= MIN_HEADCOUNT_FOR_RATE ? churn(leavers, avgHead, false) : null,
      churnVoluntary: avgHead >= MIN_HEADCOUNT_FOR_RATE ? churn(leavers, avgHead, true) : null,
      avgHeadcountLtm: round1(avgHead)
    };
  })
    .filter(l => l.headcount > 0)
    .sort((a, b) => b.headcount - a.headcount);

  // ---- six month trend

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const headcountTrend = monthEnds.map((d, i) => ({
    month: monthNames[d.getUTCMonth()],
    headcount: monthlyHeadcount[i]
  }));

  // ---- filter slices
  //
  // The dashboard holds aggregates, not records, so every combination the dropdowns can
  // produce is worked out here. Same functions as the headline figures, so a filtered
  // view can never disagree with the unfiltered one.

  const SERIES_MONTHS = 24;

  const seriesEnds = [];
  for (let i = SERIES_MONTHS - 1; i >= 0; i--) {
    seriesEnds.push(capAt(monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - i)));
  }

  function monthKey(d) {
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  }

  function monthLabel(d) {
    return monthNames[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  function personLabel(e) {
    if (!includeNames) return "";
    return String(e.name || "").trim() || "(no name recorded)";
  }

  /** Per month: closing headcount, who started, who left. Sums to any window. */
  function monthlySeries(pool) {
    return seriesEnds.map((end, i) => {
      const from = i === 0
        ? monthEnd(end.getUTCFullYear(), end.getUTCMonth() - 1)
        : seriesEnds[i - 1];
      const starters = startersBetween(from, end, pool);
      const leavers = leaversBetween(from, end, pool);
      const vol = leavers.filter(e => isVoluntary(e.terminationReason));

      return {
        key: monthKey(end),
        label: monthLabel(end),
        headcountEnd: pool.filter(e => activeAt(e, end)).length,
        hires: starters.length,
        leavers: leavers.length,
        leaversVoluntary: vol.length,
        hireNames: includeNames
          ? starters.map(e => ({ name: personLabel(e), date: e.startDate, costCentre: e.costCentre }))
          : [],
        leaverNames: includeNames
          ? leavers.map(e => ({
              name: personLabel(e),
              date: e.terminationDate,
              costCentre: e.costCentre,
              type: e.terminationReason || "",
              voluntary: isVoluntary(e.terminationReason)
            }))
          : []
      };
    });
  }

  /**
   * Month ends from TREND_START to the last COMPLETE month. The current part month is
   * left off, so every point on the trend line covers whole months and the line does not
   * dip at the right hand end simply because the month is young.
   */
  const trendEnds = [];
  {
    let y = TREND_START_YEAR;
    let m = TREND_START_MONTH;
    for (let i = 0; i < 600; i++) {
      const end = monthEnd(y, m);
      if (end > asOf) break;
      trendEnds.push(end);
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
  }

  /**
   * Per month: closing headcount, leavers, voluntary leavers. Deliberately raw counts
   * rather than rates, because the dashboard combines slices when filters are applied
   * and rates cannot be added. Short keys because this ships to the browser for every
   * location and cost centre combination.
   */
  function turnoverSeriesFor(pool) {
    return trendEnds.map(end => {
      const from = monthEnd(end.getUTCFullYear(), end.getUTCMonth() - 1);
      const leavers = leaversBetween(from, end, pool);
      return {
        k: monthKey(end),
        label: monthLabel(end),
        h: pool.filter(e => activeAt(e, end)).length,
        l: leavers.length,
        v: leavers.filter(e => isVoluntary(e.terminationReason)).length
      };
    });
  }

  function sliceFor(pool) {
    const now = pool.filter(e => activeAt(e, thisMonthEnd));
    const prior = pool.filter(e => activeAt(e, priorMonthEnd));
    const fem = now.filter(isFemale);
    const femPrior = prior.filter(isFemale);
    const monthly = monthEnds.map(d => pool.filter(e => activeAt(e, d)).length);
    const lm = leaversBetween(last30Start, thisMonthEnd, pool);
    const lmPrior = leaversBetween(prior30Start, prior30End, pool);
    const hires30 = startersBetween(last30Start, thisMonthEnd, pool);

    return {
      headcount: now.length,
      headcountPrior: prior.length,
      female: fem.length,
      femalePrior: femPrior.length,
      male: now.filter(isMale).length,
      genderNotRecorded: now.filter(e => !isFemale(e) && !isMale(e)).length,
      femalePct: now.length ? round1((fem.length / now.length) * 100) : "0.0",
      femalePctPrior: prior.length ? round1((femPrior.length / prior.length) * 100) : "0.0",
      hiresMonth: hires30.length,
      hiresMonthPrior: startersBetween(prior30Start, prior30End, pool).length,
      leaversMonth: lm.length,
      leaversMonthPrior: lmPrior.length,
      leaversVoluntaryMonth: lm.filter(e => isVoluntary(e.terminationReason)).length,
      leaversVoluntaryMonthPrior: lmPrior.filter(e => isVoluntary(e.terminationReason)).length,
      avgHeadcountLtm: round1(mean(monthly)),
      churnTotal: churn(leaversBetween(ltmStart, thisMonthEnd, pool), mean(monthly), false),
      churnVoluntary: churn(leaversBetween(ltmStart, thisMonthEnd, pool), mean(monthly), true),
      turnoverPeriods: periodDefs.map(d => turnoverFor(pool, d.from, d.to, d.key, d.label)),
      headcountTrend: monthEnds.map((d, i) => ({
        month: monthNames[d.getUTCMonth()],
        headcount: monthly[i]
      })),
      months: monthlySeries(pool),
      turnoverSeries: turnoverSeriesFor(pool),
      last30: {
        hireNames: includeNames
          ? hires30.map(e => ({ name: personLabel(e), date: e.startDate, costCentre: e.costCentre }))
          : [],
        leaverNames: includeNames
          ? lm.map(e => ({
              name: personLabel(e),
              date: e.terminationDate,
              costCentre: e.costCentre,
              type: e.terminationReason || "",
              voluntary: isVoluntary(e.terminationReason)
            }))
          : []
      }
    };
  }

  const sliceLocations = locations.map(l => l.name);
  const sliceCentres = costCentres.map(c => c.code);
  const slices = [];

  for (const loc of sliceLocations) {
    for (const cc of sliceCentres) {
      const pool = scoped.filter(e =>
        tidyLocation(e.location) === loc && (e.costCentre || "Unassigned") === cc
      );
      if (!pool.length) continue;   // nobody has ever been in this combination
      slices.push(Object.assign({ location: loc, costCentre: cc }, sliceFor(pool)));
    }
  }

  // ---- assemble

  const result = {
    periodLabel: monthNames[asOf.getUTCMonth()] + " " + asOf.getUTCFullYear(),
    priorLabel: monthNames[priorMonthEnd.getUTCMonth()] + " " + priorMonthEnd.getUTCFullYear(),
    people: {
      headcount: activeNow.length,
      headcountPrior: activePrior.length,
      female: femaleNow.length,
      male: activeNow.filter(isMale).length,
      genderNotRecorded: activeNow.filter(e => !isFemale(e) && !isMale(e)).length,
      femalePct: activeNow.length ? round1((femaleNow.length / activeNow.length) * 100) : "0.0",
      femalePctPrior: activePrior.length ? round1((femalePrior.length / activePrior.length) * 100) : "0.0",
      leaversMonth: leaversMonth.length,
      leaversMonthPrior: leaversMonthPrior.length,
      leaversVoluntaryMonth: leaversMonth.filter(e => isVoluntary(e.terminationReason)).length,
      leaversVoluntaryMonthPrior: leaversMonthPrior.filter(e => isVoluntary(e.terminationReason)).length,
      hiresMonth: hiresMonth.length,
      hiresMonthPrior: hiresMonthPrior.length,
      churnTotal: churn(leaversLtm, avgHeadcountLtm, false),
      churnTotalPrior: churn(leaversLtmPrior, avgHeadcountLtmPrior, false),
      churnVoluntary: churn(leaversLtm, avgHeadcountLtm, true),
      churnVoluntaryPrior: churn(leaversLtmPrior, avgHeadcountLtmPrior, true),
      ytdTotal: ytdPeriod.total,
      ytdVoluntary: ytdPeriod.voluntary,
      regrettableLtm: ltmPeriod.regrettable,
      regrettableCountLtm: ltmPeriod.leaversRegrettable,
      regrettableShareOfLeavers: ltmPeriod.regrettableShareOfLeavers,
      rehireFlagMissing: ltmPeriod.rehireFlagMissing,
      ytdAnnualisedTotal: annualised(leaversYtd.length, avgHeadcountYtd, monthsElapsed),
      ytdAnnualisedTotalPrior: annualised(leaversYtdPrior.length, avgHeadcountYtd, Math.max(monthsElapsed - 1, 1)),
      ytdAnnualisedVoluntary: annualised(
        leaversYtd.filter(e => isVoluntary(e.terminationReason)).length, avgHeadcountYtd, monthsElapsed),
      ytdAnnualisedVoluntaryPrior: annualised(
        leaversYtdPrior.filter(e => isVoluntary(e.terminationReason)).length,
        avgHeadcountYtd, Math.max(monthsElapsed - 1, 1)),
      gpgMean: gapFor(activeNow, false),
      gpgMeanPrior: gapFor(activePrior, false),
      gpgMedian: gapFor(activeNow, true),
      gpgMedianPrior: gapFor(activePrior, true),
      avgHeadcountLtm: round1(avgHeadcountLtm)
    },
    entities: entities,
    turnoverPeriods: periods,
    filterOptions: {
      locations: sliceLocations,
      costCentres: sliceCentres,
      months: seriesEnds.map(d => ({ key: monthKey(d), label: monthLabel(d) }))
    },
    includesNames: includeNames,
    slices: slices,
    // Company wide, used when no filter is set and as the fallback shape
    turnoverSeries: turnoverSeriesFor(scoped),
    costCentres: costCentres,
    locations: locations,
    headcountTrend: headcountTrend,
    dataQuality: {
      excludedBlankLocation: excludedBlankLocation,
      excludedWrongLocationAu: excludedWrongLocationAu,
      excludedWrongLocationUk: excludedWrongLocationUk,
      excludedContractors: excludedContractors,
      excludedIncomplete: excludedIncomplete,
      excludedNoCostCentre: excludedNoCostCentre,
      notYetStarted: notYetStarted,
      excludedNoSalary: excludedNoSalary,
      casualsConverted: casualsConverted,
      partTimeConverted: partTimeConverted
    }
  };

  return result;
}
