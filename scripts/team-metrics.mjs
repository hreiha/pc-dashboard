/**
 * team-metrics.mjs
 *
 * The Bids and IT dashboard: headcount broken down several ways, plus average age
 * and average tenure. No turnover, no pay gap, no recruitment.
 *
 * Who counts is decided by scopeEmployees in metrics.mjs, not here, so this page and the
 * P&C dashboard can never disagree about the total.
 *
 * Output shape is deliberately different from data.json. The P&C dashboard precomputes
 * every filter combination because it carries a dozen rates per slice. This one carries
 * one anonymised row per person and lets the page do the filtering, because the
 * breakdowns multiply out to far too many combinations to precompute, and because an
 * exact answer for any filter combination beats an approximate one.
 */

import { scopeEmployees, parseDate, monthEnd, activeAt, tidyLocation } from "./metrics.mjs";

// ---------------------------------------------------------------- configuration

/**
 * Employment Hero has no Position Grade field and no Discipline field. Both are read out
 * of the job title, which at ADP is written "Grade | Discipline", for example
 * "Senior Engineer | Mechanical" or "Associate Director | Fire Protection".
 *
 * Grade is matched against the list below rather than taken verbatim, so that
 * "Senior Engineer (Sydney)" and "Senior Engineer" land on the same row.
 *
 * Longest match wins, so "Associate Director" beats both "Associate" and "Director", and
 * "Graduate Engineer" beats "Engineer". Order in this list does not matter; length does.
 *
 * Add any grade that shows up in the "unmatched job titles" list the refresh prints.
 */
const POSITION_GRADES = [
  "Managing Director",
  "Regional Director",
  "Technical Director",
  "Associate Director",
  "Director",
  "Senior Associate",
  "Associate",
  "Principal",
  "Senior Consultant",
  "Consultant",
  "Graduate Engineer",
  "Senior Engineer",
  "Engineer",
  "Graduate",
  "Senior BIM Designer",
  "BIM Designer",
  "Senior Designer",
  "Designer",
  "Senior Technician",
  "Technician",
  "Senior Advisor",
  "Senior Adviser",
  "Advisor",
  "Adviser",
  "Senior Manager",
  "Manager",
  "Coordinator",
  "Administrator",
  "Analyst",
  "Specialist",
  "Officer",
  "Support",
  "Intern",
  "Cadet",
  "Student"
];

/**
 * Disciplines that are written more than one way. Matched after the pipe, lower case,
 * and the value on the right is what the dashboard shows.
 */
const DISCIPLINE_ALIASES = {
  "mech": "Mechanical",
  "mechanical services": "Mechanical",
  "elec": "Electrical",
  "electrical services": "Electrical",
  "hydraulic": "Hydraulics",
  "fire": "Fire Safety",
  "fire protection": "Fire Safety",
  "ict": "ICT",
  "it": "ICT",
  "esd": "Sustainability",
  "sustainability (carbon)": "Sustainability",
  "vertical transport": "Vertical Transportation",
  "vertical transportation": "Vertical Transportation",
  "acoustic": "Acoustics",
  "structural": "Structures",
  "civil": "Civil",
  "bids": "Bids",
  "bid": "Bids"
};

const NOT_RECORDED = "Not recorded";

// Below this many people a breakdown row is folded into "Other", so that a single person
// is not identifiable by their grade and discipline on a page several teams can open.
const MIN_ROW_SIZE = 1;

// ---------------------------------------------------------------- derivation

/** Everything before the first pipe, with any trailing bracketed note removed. */
function titleLeft(jobTitle) {
  const t = String(jobTitle || "").trim();
  if (!t) return "";
  const left = t.split("|")[0];
  return left.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Everything after the first pipe. Blank when the title has no pipe at all. */
function titleRight(jobTitle) {
  const t = String(jobTitle || "").trim();
  const idx = t.indexOf("|");
  if (idx < 0) return "";
  return t.slice(idx + 1).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Position grade. Longest keyword that appears in the part before the pipe.
 * Returns "Not recorded" when the title is blank, "Other" when it is present but
 * matches nothing, so that a missing title and an unrecognised one stay distinguishable.
 */
export function positionGrade(jobTitle) {
  const left = titleLeft(jobTitle);
  if (!left) return NOT_RECORDED;

  const haystack = left.toLowerCase();
  let best = "";
  for (const grade of POSITION_GRADES) {
    const needle = grade.toLowerCase();
    if (haystack.indexOf(needle) >= 0 && needle.length > best.length) best = grade;
  }
  return best || "Other";
}

/** Discipline, from the part after the pipe, with the alias list applied. */
export function discipline(jobTitle) {
  const right = titleRight(jobTitle);
  if (!right) return NOT_RECORDED;

  const key = right.toLowerCase();
  if (DISCIPLINE_ALIASES[key]) return DISCIPLINE_ALIASES[key];

  // Title case whatever is left, so "fire safety" and "Fire Safety" do not split a row
  return right.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Male, Female, or Not recorded. Anything else is reported as recorded, not forced. */
function genderLabel(value) {
  const g = String(value || "").trim();
  if (!g) return NOT_RECORDED;
  const lower = g.toLowerCase();
  if (lower.indexOf("female") === 0) return "Female";
  if (lower === "male" || lower === "m") return "Male";
  return g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
}

/** Year and month only. Enough for an average age, less precise than a date of birth. */
function birthYearMonth(value) {
  const d = parseDate(value);
  if (!d) return "";
  const year = d.getUTCFullYear();
  // Obvious rubbish: a placeholder date or a typo in the year
  if (year < 1930 || year > new Date().getUTCFullYear() - 14) return "";
  return year + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

/** ISO date with no time, so the rows stay small and no time zone can shift a date. */
function dayOnly(value) {
  const d = parseDate(value);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- main

export function computeTeamData(employees, asOfIso) {
  const asOf = parseDate(asOfIso) || new Date();
  const { scoped, quality } = scopeEmployees(employees);

  const people = scoped.map(e => ({
    e: e.entity,                        // AU or UK
    l: tidyLocation(e.location),        // office, state suffix removed
    c: e.costCentre || "Unassigned",    // already NAT-grouped and London-defaulted
    g: genderLabel(e.gender),
    gr: positionGrade(e.jobTitle),
    d: discipline(e.jobTitle),
    s: dayOnly(e.startDate),
    t: dayOnly(e.terminationDate),
    b: birthYearMonth(e.birthDate),
    // Employment status wins over a stale termination date, same rule as the P&C dashboard
    a: String(e.status || "").toLowerCase() === "active" ? 1 : 0
  }));

  // ---- the 24 month ends the period filter can land on

  function capAt(d) { return d > asOf ? asOf : d; }

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const months = [];
  for (let i = 23; i >= 0; i--) {
    const end = capAt(monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - i));
    months.push({
      key: end.getUTCFullYear() + "-" + String(end.getUTCMonth() + 1).padStart(2, "0"),
      label: monthNames[end.getUTCMonth()] + " " + end.getUTCFullYear(),
      iso: end.toISOString()
    });
  }

  // ---- distinct values, for the filter pickers and for a stable column order

  function distinct(key) {
    const seen = [];
    for (const p of people) {
      if (p[key] && seen.indexOf(p[key]) < 0) seen.push(p[key]);
    }
    return seen.sort((a, b) => {
      // "Not recorded" and "Other" always last, so they never head a list
      const rank = v => (v === NOT_RECORDED ? 2 : v === "Other" ? 1 : 0);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  }

  // ---- how much of this is actually populated, so the page can be honest about it

  const activeNow = people.filter(p => {
    const start = parseDate(p.s);
    if (start && start > asOf) return false;
    if (p.a === 1) return true;
    const term = parseDate(p.t);
    return !term || term > asOf;
  });

  function coverage(predicate) {
    if (!activeNow.length) return "0.0";
    return ((activeNow.filter(predicate).length / activeNow.length) * 100).toFixed(1);
  }

  // Job titles that produced neither a grade nor a discipline, so the lists above can
  // be corrected rather than guessed at. Deduplicated and capped.
  const unmatched = [];
  for (const e of scoped) {
    const t = String(e.jobTitle || "").trim();
    if (!t) continue;
    if (positionGrade(t) !== "Other") continue;
    if (unmatched.indexOf(t) < 0 && unmatched.length < 60) unmatched.push(t);
  }

  return {
    generatedUtc: new Date().toISOString(),
    asOf: asOf.toISOString(),
    asOfLabel: monthNames[asOf.getUTCMonth()] + " " + asOf.getUTCFullYear(),
    months: months,
    filterOptions: {
      costCentres: distinct("c"),
      genders: distinct("g"),
      locations: distinct("l"),
      grades: distinct("gr"),
      disciplines: distinct("d")
    },
    coverage: {
      headcount: activeNow.length,
      birthDate: coverage(p => !!p.b),
      jobTitle: coverage(p => p.gr !== NOT_RECORDED),
      grade: coverage(p => p.gr !== NOT_RECORDED && p.gr !== "Other"),
      discipline: coverage(p => p.d !== NOT_RECORDED),
      gender: coverage(p => p.g !== NOT_RECORDED),
      startDate: coverage(p => !!p.s)
    },
    unmatchedJobTitles: unmatched,
    people: people,
    dataQuality: quality,
    minRowSize: MIN_ROW_SIZE
  };
}
