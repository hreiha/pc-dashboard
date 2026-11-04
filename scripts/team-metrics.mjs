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
import { NOT_RECORDED, positionGrade, discipline } from "./classify.mjs";

// Re-exported so anything already importing these from here keeps working.
export { positionGrade, discipline };

// ---------------------------------------------------------------- configuration



// ---------------------------------------------------------------- small helpers

// Rows are anonymised, so there is no small-cell risk and nothing needs suppressing.
const MIN_ROW_SIZE = 1;

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
    gr: positionGrade(e.jobTitle, e.costCentre),
    d: discipline(e.jobTitle, e.costCentre),
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

  // Records missing the recorded fields, so the gap is visible in the run log
  const missingGrade = activeNow.filter(p => p.gr === NOT_RECORDED).length;
  const missingDiscipline = activeNow.filter(p => p.d === NOT_RECORDED).length;

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
    missingGrade: missingGrade,
    missingDiscipline: missingDiscipline,
    people: people,
    dataQuality: quality,
    minRowSize: MIN_ROW_SIZE
  };
}
