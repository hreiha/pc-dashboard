/**
 * ComputeMetrics.ts
 *
 * Office Script called from Power Automate. Takes the normalised employee array,
 * returns the finished dashboard figures as a JSON string.
 *
 * Power Automate cannot sort or sum an array, which rules out a median. It is also
 * painful to reconstruct historical month-end headcount with expressions. Both are
 * trivial here, so all of it lives in this one place where it can be read and audited.
 *
 * The workbook it runs against is not used. Create an empty one in OneDrive and point
 * the Run script action at it.
 */

// ---------------------------------------------------------------- configuration

const STANDARD_HOURS_PER_WEEK = 38;
const WEEKS_PER_YEAR = 52;

// Leaving reasons counted as voluntary. Match these to your Employment Hero values
// exactly, in lower case. Anything not listed counts as involuntary.
const VOLUNTARY_REASONS = [
  "resignation",
  "resigned",
  "voluntary",
  "career change",
  "personal reasons",
  "relocation",
  "retirement"
];

// Entity comes from which Employment Hero organisation the record sits in. Location is
// only used to strip out people who are in an organisation for access reasons rather than
// because they work for that entity. Three rules:
//
//   blank location                        excluded from both
//   location "Australia" in the UK entity excluded
//   location "London" in the AU entity    excluded
//
// Matched exactly, ignoring case and surrounding spaces. Add further values to either list
// if new location options appear in Employment Hero.
const EXCLUDE_FROM_UK_ENTITY = ["australia"];
const EXCLUDE_FROM_AU_ENTITY = ["london"];

// ---------------------------------------------------------------- types

interface Employee {
  id: string;
  gender: string;
  location: string;
  employmentType: string;      // Full time | Part time | Casual
  hoursPerWeek: number;
  annualSalary: number;
  hourlyRate: number;
  startDate: string;           // yyyy-MM-dd
  terminationDate: string;     // yyyy-MM-dd or empty
  terminationReason: string;
  level4: string;              // Corporate | Engineering
  costCentre: string;
  entity: string;              // AU | UK, stamped by the flow from the organisation ID
}

interface Scoped extends Employee {
  fteSalary: number;           // 0 when no usable pay data
}

// ---------------------------------------------------------------- helpers

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function monthEnd(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59));
}

/** Exact match, ignoring case and surrounding spaces. Not a substring match, so a location
 *  of "Australia Wide" would not be caught by "australia". */
function matchesAny(value: string, list: string[]): boolean {
  const v = (value || "").toLowerCase().trim();
  if (!v) return false;
  return list.indexOf(v) >= 0;
}

function isVoluntary(reason: string): boolean {
  const r = (reason || "").toLowerCase().trim();
  if (!r) return false;
  return VOLUNTARY_REASONS.some(token => r.indexOf(token) >= 0);
}

function activeAt(e: Employee, when: Date): boolean {
  const start = parseDate(e.startDate);
  if (!start || start > when) return false;
  const term = parseDate(e.terminationDate);
  return !term || term > when;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round1(value: number): string {
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
function fteSalary(e: Employee): number {
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
function payGap(maleValues: number[], femaleValues: number[], useMedian: boolean): string {
  const m = useMedian ? median(maleValues) : mean(maleValues);
  const f = useMedian ? median(femaleValues) : mean(femaleValues);
  if (m <= 0 || f <= 0) return "0.0";
  return round1(((m - f) / m) * 100);
}

function isFemale(e: Employee): boolean {
  return (e.gender || "").toLowerCase().indexOf("female") === 0;
}

function isMale(e: Employee): boolean {
  const g = (e.gender || "").toLowerCase();
  return g === "male" || g === "m";
}

// ---------------------------------------------------------------- main

function main(
  workbook: ExcelScript.Workbook,
  employeesJson: string,
  asOfIso: string
): string {

  const raw: Employee[] = JSON.parse(employeesJson) as Employee[];
  const asOf = parseDate(asOfIso) || new Date();

  const thisMonthEnd = monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth());
  const priorMonthEnd = monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1);

  // ---- scope: drop blank and unmapped locations, assign entity by location

  let excludedBlankLocation = 0;
  let excludedAuInUkEntity = 0;
  let excludedUkInAuEntity = 0;
  let casualsConverted = 0;
  let partTimeConverted = 0;

  const scoped: Scoped[] = [];

  for (const e of raw) {
    const loc = (e.location || "").trim();
    const entity = (e.entity || "").toUpperCase();

    // No location means we cannot tell whether they belong to the entity they sit in
    if (!loc) { excludedBlankLocation++; continue; }

    // Location recorded as "Australia" against the UK organisation: access accounts
    if (entity === "UK" && matchesAny(loc, EXCLUDE_FROM_UK_ENTITY)) { excludedAuInUkEntity++; continue; }

    // Location recorded as "London" against the Australian organisation
    if (entity === "AU" && matchesAny(loc, EXCLUDE_FROM_AU_ENTITY)) { excludedUkInAuEntity++; continue; }

    const type = (e.employmentType || "").toLowerCase();
    if (type.indexOf("casual") >= 0) casualsConverted++;
    else if (type.indexOf("part") >= 0) partTimeConverted++;

    scoped.push({
      id: e.id,
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
      costCentre: e.costCentre,
      entity: entity,
      fteSalary: fteSalary(e)
    });
  }

  // ---- headcount, now and a month ago

  const activeNow = scoped.filter(e => activeAt(e, thisMonthEnd));
  const activePrior = scoped.filter(e => activeAt(e, priorMonthEnd));

  const femaleNow = activeNow.filter(isFemale);
  const femalePrior = activePrior.filter(isFemale);

  // ---- month-end headcount for the last 13 months, used for LTM averages and the trend

  const monthEnds: Date[] = [];
  for (let i = 11; i >= 0; i--) {
    monthEnds.push(monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - i));
  }
  const monthlyHeadcount = monthEnds.map(d => scoped.filter(e => activeAt(e, d)).length);
  const avgHeadcountLtm = mean(monthlyHeadcount);

  // The same window shifted back a month, so the churn figure has something to compare to
  const priorMonthEnds: Date[] = [];
  for (let i = 12; i >= 1; i--) {
    priorMonthEnds.push(monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - i));
  }
  const avgHeadcountLtmPrior = mean(priorMonthEnds.map(d => scoped.filter(e => activeAt(e, d)).length));

  // ---- leavers

  function leaversBetween(from: Date, to: Date, pool: Scoped[]): Scoped[] {
    return pool.filter(e => {
      const t = parseDate(e.terminationDate);
      return t !== null && t > from && t <= to;
    });
  }

  const ltmStart = monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 12);
  const ltmStartPrior = monthEnd(asOf.getUTCFullYear(), asOf.getUTCMonth() - 13);

  const leaversLtm = leaversBetween(ltmStart, thisMonthEnd, scoped);
  const leaversLtmPrior = leaversBetween(ltmStartPrior, priorMonthEnd, scoped);

  const monthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0, 23, 59, 59));
  const leaversMonth = leaversBetween(monthStart, thisMonthEnd, scoped);
  const leaversMonthPrior = leaversBetween(
    new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1, 0, 23, 59, 59)),
    priorMonthEnd,
    scoped
  );

  // ---- financial year to date, starting 1 July

  const fyStartYear = asOf.getUTCMonth() >= 6 ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1;
  const fyStart = new Date(Date.UTC(fyStartYear, 5, 30, 23, 59, 59));
  const monthsElapsed = ((asOf.getUTCFullYear() - fyStartYear) * 12) + asOf.getUTCMonth() - 6 + 1;

  const leaversYtd = leaversBetween(fyStart, thisMonthEnd, scoped);
  const leaversYtdPrior = leaversBetween(fyStart, priorMonthEnd, scoped);

  const ytdMonthEnds: Date[] = [];
  for (let i = 0; i < Math.max(monthsElapsed, 1); i++) {
    ytdMonthEnds.push(monthEnd(fyStartYear, 6 + i));
  }
  const avgHeadcountYtd = mean(ytdMonthEnds.map(d => scoped.filter(e => activeAt(e, d)).length));

  function annualised(leavers: number, avgHead: number, months: number): string {
    if (avgHead <= 0 || months <= 0) return "0.0";
    return round1((leavers / avgHead) * (12 / months) * 100);
  }

  function churn(leavers: Scoped[], avgHead: number, voluntaryOnly: boolean): string {
    if (avgHead <= 0) return "0.0";
    const count = voluntaryOnly
      ? leavers.filter(e => isVoluntary(e.terminationReason)).length
      : leavers.length;
    return round1((count / avgHead) * 100);
  }

  // ---- pay gap

  function gapFor(pool: Scoped[], useMedian: boolean): string {
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
      gpgMean: gapFor(now, false),
      gpgMedian: gapFor(now, true)
    };
  });

  // ---- churn split by Level 4

  const level4Values: string[] = [];
  for (const e of scoped) {
    const v = (e.level4 || "Unassigned").trim();
    if (level4Values.indexOf(v) < 0) level4Values.push(v);
  }

  const churnByLevel4 = level4Values.map(group => {
    const groupPool = scoped.filter(e => (e.level4 || "Unassigned").trim() === group);
    const groupAvgHead = mean(monthEnds.map(d => groupPool.filter(e => activeAt(e, d)).length));
    const groupLeavers = leaversBetween(ltmStart, thisMonthEnd, groupPool);
    return {
      group: group,
      leaversLtm: groupLeavers.length,
      churnTotal: churn(groupLeavers, groupAvgHead, false),
      churnVoluntary: churn(groupLeavers, groupAvgHead, true)
    };
  });

  // ---- cost centres

  const ccValues: string[] = [];
  for (const e of activeNow) {
    const v = (e.costCentre || "Unassigned").trim();
    if (ccValues.indexOf(v) < 0) ccValues.push(v);
  }

  const costCentres = ccValues.map(code => {
    const pool = activeNow.filter(e => (e.costCentre || "Unassigned").trim() === code);
    return {
      code: code,
      headcount: pool.length,
      female: pool.filter(isFemale).length,
      openRoles: 0   // merged in by Power Automate from the Recruitment Forecast list
    };
  }).sort((a, b) => b.headcount - a.headcount);

  // ---- six month trend

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const headcountTrend = monthEnds.slice(-6).map((d, i) => ({
    month: monthNames[d.getUTCMonth()],
    headcount: monthlyHeadcount[monthlyHeadcount.length - 6 + i]
  }));

  // ---- assemble

  const result = {
    periodLabel: monthNames[asOf.getUTCMonth()] + " " + asOf.getUTCFullYear(),
    priorLabel: monthNames[priorMonthEnd.getUTCMonth()] + " " + priorMonthEnd.getUTCFullYear(),
    people: {
      headcount: activeNow.length,
      headcountPrior: activePrior.length,
      femalePct: activeNow.length ? round1((femaleNow.length / activeNow.length) * 100) : "0.0",
      femalePctPrior: activePrior.length ? round1((femalePrior.length / activePrior.length) * 100) : "0.0",
      leaversMonth: leaversMonth.length,
      leaversMonthPrior: leaversMonthPrior.length,
      leaversVoluntaryMonth: leaversMonth.filter(e => isVoluntary(e.terminationReason)).length,
      leaversVoluntaryMonthPrior: leaversMonthPrior.filter(e => isVoluntary(e.terminationReason)).length,
      churnTotal: churn(leaversLtm, avgHeadcountLtm, false),
      churnTotalPrior: churn(leaversLtmPrior, avgHeadcountLtmPrior, false),
      churnVoluntary: churn(leaversLtm, avgHeadcountLtm, true),
      churnVoluntaryPrior: churn(leaversLtmPrior, avgHeadcountLtmPrior, true),
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
    churnByLevel4: churnByLevel4,
    entities: entities,
    costCentres: costCentres,
    headcountTrend: headcountTrend,
    dataQuality: {
      excludedBlankLocation: excludedBlankLocation,
      excludedAuInUkEntity: excludedAuInUkEntity,
      excludedUkInAuEntity: excludedUkInAuEntity,
      excludedNoSalary: excludedNoSalary,
      casualsConverted: casualsConverted,
      partTimeConverted: partTimeConverted
    }
  };

  return JSON.stringify(result);
}
