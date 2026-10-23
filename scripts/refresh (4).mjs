/**
 * refresh.mjs
 *
 * Talks to Employment Hero, pulls every employee from both organisations, hands them to
 * metrics.mjs, and writes data.json. Run by GitHub Actions on a schedule.
 *
 * Nothing else is involved: no Power Automate, no SharePoint, no Excel.
 *
 * Environment variables, set as GitHub Actions secrets:
 *   EH_CLIENT_ID, EH_CLIENT_SECRET, EH_REFRESH_TOKEN, EH_ORG_ID_AU, EH_ORG_ID_UK
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeMetrics } from "./metrics.mjs";
import { computeTeamData } from "./team-metrics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TOKEN_URL = "https://oauth.employmenthero.com/oauth2/token";
const API_BASE = "https://api.employmenthero.com/api/v1";
const PAGE_SIZE = 100;

/**
 * Employment Hero field names, per tenant. Each entry lists the keys to try, in order,
 * and the first one present on the record wins.
 *
 * Run this script once, look at the sample record it prints, and add your real key names
 * to the front of each list.
 */
const FIELDS = {
  gender:            ["gender", "sex"],
  location:          ["location", "office", "work_location"],
  employmentType:    ["employment_type", "payroll_type"],
  hoursPerWeek:      ["typical_work_day", "hours_per_week", "weekly_hours"],
  annualSalary:      ["annual_salary", "salary", "base_salary"],
  hourlyRate:        ["hourly_rate", "rate"],
  startDate:         ["start_date", "global_teams_start_date"],
  terminationDate:   ["termination_date"],
  terminationReason: ["termination_summary", "termination_reason"],
  level4:            ["teams", "division", "business_unit"],
  costCentre:        ["primary_cost_centre", "cost_centre", "teams"],
  rehire:            ["rehire_this_personnel", "rehire", "eligible_for_rehire", "re_hire"],
  name:              ["full_name", "known_as", "first_name"],
  // For the ADP Dashboard. Employment Hero does carry Position Grade and Discipline as
  // real fields, so they are read directly where present; the job title is only a
  // fallback for records where they are blank.
  jobTitle:          ["job_title", "role", "title"],
  birthDate:         ["date_of_birth", "dob", "birth_date"],
  positionGrade:     ["position_grade", "positionGrade", "grade", "level"],
  discipline:        ["discipline", "sub_discipline", "practice"]
};

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`Missing environment variable ${name}. Add it as a repository secret.`);
    process.exit(1);
  }
  return value.trim();
}

/** First present, non-empty value among the candidate keys. Handles nested {name} or {value}. */
function pick(record, candidates) {
  for (const key of candidates) {
    let v = record[key];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") v = v.name ?? v.value ?? v.title ?? v.label ?? "";
    if (v === "") continue;
    return v;
  }
  return "";
}

/** Yes / No / blank, however it is spelled, as true / false / null. */
function toTriState(value) {
  if (value === true) return true;
  if (value === false) return false;
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "yes" || v === "true" || v === "y" || v === "1") return true;
  if (v === "no" || v === "false" || v === "n" || v === "0") return false;
  return null;
}

/**
 * Employment Hero returns a sentence like "X was offboarded on 16/09/2026 by Y with the
 * reason of: Voluntary cessation". Only the reason is wanted.
 */
function cleanReason(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const m = v.match(/reason of:\s*(.+?)\.?\s*$/i);
  return (m ? m[1] : v).trim();
}

function toNumber(value) {
  const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const url = `${TOKEN_URL}?grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Token refresh failed with ${res.status}: ${text}`);
    console.error("Re-run tools/Get-EmploymentHeroToken.ps1 and update the EH_REFRESH_TOKEN secret.");
    process.exit(1);
  }

  const json = await res.json();

  if (json.refresh_token && json.refresh_token !== refreshToken) {
    console.warn("Employment Hero returned a different refresh token.");
    console.warn("Update the EH_REFRESH_TOKEN secret with the value below before the next run:");
    console.warn(json.refresh_token);
  }

  // The granted scopes decide whether the employee endpoint will answer at all, so they
  // are carried out of here for the diagnostics below.
  return { accessToken: json.access_token, scope: String(json.scope || "") };
}

/**
 * Which organisations this token can actually see, and under what scopes.
 *
 * Employment Hero answers an employee request with 424 and an empty body when the token
 * is valid but cannot reach that organisation, which on its own says nothing useful.
 * This turns that into something actionable: the real organisation IDs beside the ones
 * configured, and whether the employee read scope was granted.
 */
async function explainAccessFailure(accessToken, scope, orgAu, orgUk) {
  console.error("");
  console.error("The token refreshed, so the client ID, secret and refresh token are all good.");
  console.error("The employee endpoint refused the request, which is about access, not credentials.");
  console.error("");

  const wanted = "employees";
  const granted = scope ? scope.split(/\s+/).filter(Boolean) : [];
  const employeeScopes = granted.filter(s => s.indexOf(wanted) >= 0);

  if (!scope) {
    console.error("Employment Hero returned no scope list with the token.");
  } else if (!employeeScopes.length) {
    console.error("NO EMPLOYEE SCOPE WAS GRANTED. This is almost certainly the problem.");
    console.error("In the Developer Portal, edit the app, tick the employee read scopes,");
    console.error("then re-run tools/Get-EmploymentHeroToken.ps1 and update EH_REFRESH_TOKEN.");
  } else {
    console.error(`Employee scopes granted: ${employeeScopes.slice(0, 6).join(", ")}`);
  }

  console.error("");
  try {
    const res = await fetch(`${API_BASE}/organisations`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      console.error(`Listing organisations also failed with ${res.status}.`);
      console.error("The token has no organisation access at all. Re-approve it as an");
      console.error("Employment Hero owner or admin when you run the token script.");
      return;
    }
    const json = await res.json();
    const items = (json.data && json.data.items) || json.items || [];
    if (!items.length) {
      console.error("This token can see no organisations. Re-approve it as an owner or admin.");
      return;
    }

    console.error("Organisations this token can see:");
    const ids = [];
    for (const o of items) {
      console.error(`  ${o.id}  ${o.name || ""}`);
      ids.push(String(o.id));
    }
    console.error("");
    console.error("Configured:");
    console.error(`  EH_ORG_ID_AU  ${orgAu}  ${ids.indexOf(orgAu) >= 0 ? "matches" : "NOT IN THE LIST ABOVE"}`);
    console.error(`  EH_ORG_ID_UK  ${orgUk}  ${ids.indexOf(orgUk) >= 0 ? "matches" : "NOT IN THE LIST ABOVE"}`);
    if (ids.indexOf(orgAu) < 0 || ids.indexOf(orgUk) < 0) {
      console.error("");
      console.error("Copy the IDs above into the EH_ORG_ID_AU and EH_ORG_ID_UK secrets.");
    }
  } catch (err) {
    console.error(`Could not list organisations: ${err.message}`);
  }
}

async function fetchAllEmployees(accessToken, orgId, entity, scope, orgAu, orgUk) {
  const collected = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= 200) {
    const url = `${API_BASE}/organisations/${orgId}/employees?page_index=${page}&item_per_page=${PAGE_SIZE}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Employee fetch failed for ${entity} on page ${page} with ${res.status}` +
        (text ? `: ${text}` : " and an empty body."));
      await explainAccessFailure(accessToken, scope, orgAu, orgUk);
      process.exit(1);
    }

    const json = await res.json();
    const data = json.data || json;
    const items = data.items || [];

    totalPages = Number(data.total_pages ?? data.totalPages ?? 1) || 1;

    for (const item of items) collected.push({ raw: item, entity });
    page += 1;
  }

  console.log(`${entity}: ${collected.length} records across ${totalPages} page(s)`);
  return collected;
}

function normalise({ raw, entity }) {
  return {
    id: String(raw.id ?? raw.employee_id ?? ""),
    name: String(pick(raw, FIELDS.name)),
    gender: String(pick(raw, FIELDS.gender)),
    location: String(pick(raw, FIELDS.location)),
    employmentType: String(pick(raw, FIELDS.employmentType)),
    hoursPerWeek: toNumber(pick(raw, FIELDS.hoursPerWeek)),
    annualSalary: toNumber(pick(raw, FIELDS.annualSalary)),
    hourlyRate: toNumber(pick(raw, FIELDS.hourlyRate)),
    startDate: String(pick(raw, FIELDS.startDate)),
    terminationDate: String(pick(raw, FIELDS.terminationDate)),
    terminationReason: cleanReason(pick(raw, FIELDS.terminationReason)),
    level4: String(pick(raw, FIELDS.level4)),
    costCentre: String(pick(raw, FIELDS.costCentre)),
    jobTitle: String(pick(raw, FIELDS.jobTitle)),
    birthDate: String(pick(raw, FIELDS.birthDate)),
    positionGrade: String(pick(raw, FIELDS.positionGrade)),
    discipline: String(pick(raw, FIELDS.discipline)),
    // Employment Hero carries an explicit flag, which beats matching employment type text
    independentContractor: raw.independent_contractor === true,
    // Drives the regrettable departure rate. Tri-state: true, false, or null when not recorded.
    rehire: toTriState(pick(raw, FIELDS.rehire)),
    status: String(pick(raw, ["status"])),
    entity
  };
}

/**
 * Recruitment figures are not in Employment Hero. If recruitment.json exists in the repo it
 * is merged in, otherwise the recruitment section renders as zeros and the rest still works.
 */
function loadJson(name) {
  const path = join(ROOT, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(`${name} could not be parsed, ignoring it: ${err.message}`);
    return null;
  }
}

function loadRecruitment() {
  const path = join(ROOT, "recruitment.json");
  if (!existsSync(path)) {
    console.log("Recruitment: no recruitment.json in the repo, figures will show as zero.");
    return null;
  }

  let parsed;
  try {
    let text = readFileSync(path, "utf8").trim();

    // A markdown code fence pasted into the Power Automate Compose leaves "json" or
    // ```json on the first line, which makes the file unparseable. Strip it.
    text = text.replace(/^```?\s*json\s*\n/i, "").replace(/^json\s*\n/i, "");
    text = text.replace(/\n```\s*$/i, "").trim();

    // A variable that resolved to nothing leaves "key":  with no value
    if (/:\s*\n\s*[}\]]/.test(text)) {
      console.warn("Recruitment: a value in recruitment.json is empty. " +
        "Check the variables referenced in the flow's Compose action.");
      text = text.replace(/("(?:costCentres|pipeline)"\s*:)\s*(?=\n\s*[}\]])/g, "$1 [],");
      text = text.replace(/,(\s*[}\]])/g, "$1");
    }

    parsed = JSON.parse(text);
    // Power Automate sometimes encodes the file twice, leaving a JSON string that itself
    // contains the JSON. Unwrap it rather than silently reading nothing.
    if (typeof parsed === "string") {
      console.log("Recruitment: file was double encoded, unwrapping it.");
      parsed = JSON.parse(parsed);
    }
  } catch (err) {
    console.warn(`Recruitment: recruitment.json could not be parsed, ignoring it: ${err.message}`);
    return null;
  }

  const open = parsed?.recruitment?.openRoles;
  const stages = Array.isArray(parsed?.pipeline) ? parsed.pipeline : null;
  const centres = Array.isArray(parsed?.costCentres) ? parsed.costCentres : null;

  console.log(`Recruitment: openRoles ${open ?? "missing"}`);
  if (stages) {
    console.log(`Recruitment: ${stages.length} stage(s): ` +
      stages.map(st => `${st.stage}=${st.count}`).join(", "));
  } else {
    console.log(`Recruitment: pipeline is ${typeof parsed?.pipeline}, expected an array. ` +
      "If it is a string, the Compose in the flow has quotes around @{variables('Pipeline')}.");
  }
  if (centres) {
    console.log(`Recruitment: ${centres.length} cost centre(s) with open roles`);
  } else {
    console.log(`Recruitment: costCentres is ${typeof parsed?.costCentres}, expected an array.`);
  }

  // Arrays that arrived as strings are recoverable, so recover them
  for (const key of ["pipeline", "costCentres"]) {
    if (typeof parsed?.[key] === "string") {
      try { parsed[key] = JSON.parse(parsed[key]); } catch { parsed[key] = []; }
    }
  }

  return parsed;
}

async function main() {
  const clientId = required("EH_CLIENT_ID");
  const clientSecret = required("EH_CLIENT_SECRET");
  const refreshToken = required("EH_REFRESH_TOKEN");
  const orgAu = required("EH_ORG_ID_AU");
  const orgUk = required("EH_ORG_ID_UK");

  const { accessToken, scope } = await refreshAccessToken(clientId, clientSecret, refreshToken);

  const rawEmployees = [
    ...(await fetchAllEmployees(accessToken, orgAu, "AU", scope, orgAu, orgUk)),
    ...(await fetchAllEmployees(accessToken, orgUk, "UK", scope, orgAu, orgUk))
  ];

  if (!rawEmployees.length) {
    console.error("No employees returned. Check the organisation IDs and the token scopes.");
    process.exit(1);
  }

  // Printed so the field names can be mapped without guessing. Keys only, never values.
  console.log("Available fields on the first record:");
  console.log("  " + Object.keys(rawEmployees[0].raw).sort().join(", "));

  const employees = rawEmployees.map(normalise);

  const unmappedFields = Object.entries(FIELDS)
    .filter(([key]) => employees.every(e => e[key] === "" || e[key] === 0))
    .map(([key]) => key);
  if (unmappedFields.length) {
    console.warn("These fields came back empty for every record, so FIELDS needs updating:");
    console.warn("  " + unmappedFields.join(", "));
  }

  // Names are only written into data.json when the repository variable says so, because
  // data.json is served to anyone who can open the dashboard.
  const includeNames = String(process.env.INCLUDE_NAMES || "").trim().toLowerCase() === "true";
  if (includeNames) {
    console.log("INCLUDE_NAMES is on: starter and leaver names will be written to data.json.");
  }

  const metrics = computeMetrics(employees, new Date().toISOString(), { includeNames });
  const recruitment = loadRecruitment();

  // Pay is not on the employees endpoint, so the gap is calculated locally from the CSV
  // export by tools/Get-PayGap.ps1 and committed as paygap.json.
  const paygap = loadJson("paygap.json");
  if (paygap) {
    metrics.people.gpgMean = paygap.combined?.gpgMean ?? "0.0";
    metrics.people.gpgMedian = paygap.combined?.gpgMedian ?? "0.0";
    for (const entity of metrics.entities) {
      const e = paygap.entities?.[entity.code];
      if (e) {
        entity.gpgMean = e.gpgMean;
        entity.gpgMedian = e.gpgMedian;
      }
    }
    console.log(`Pay gap from paygap.json, generated ${paygap.generatedUtc}`);
  } else {
    console.log("No paygap.json found. Run tools/Get-PayGap.ps1 and commit the result.");
  }

  const output = {
    generatedUtc: new Date().toISOString(),
    periodLabel: metrics.periodLabel,
    priorLabel: metrics.priorLabel,
    people: metrics.people,
    turnoverPeriods: metrics.turnoverPeriods,
    filterOptions: metrics.filterOptions,
    includesNames: metrics.includesNames,
    slices: metrics.slices,
    turnoverSeries: metrics.turnoverSeries,
    turnoverHistory: metrics.turnoverHistory,
    historyQuality: metrics.historyQuality,
    entities: metrics.entities,
    recruitment: recruitment?.recruitment ?? {
      openRoles: 0, filledMonth: 0, avgDaysOpen: "0.0", avgDaysToHire: "0.0"
    },
    pipeline: recruitment?.pipeline ?? [],
    stageDetail: recruitment?.stageDetail ?? [],
    costCentres: mergeOpenRoles(metrics.costCentres, recruitment?.costCentres),
    locations: mergeActiveRoles(metrics.locations, recruitment?.locations),
    headcountTrend: metrics.headcountTrend,
    dataQuality: metrics.dataQuality
  };

  writeFileSync(join(ROOT, "data.json"), JSON.stringify(output, null, 2) + "\n", "utf8");

  // The trend line reaches back only as far as the records allow, so say how far that is
  const hq = metrics.historyQuality || {};
  const hist = metrics.turnoverHistory || [];
  const firstWithLeavers = hist.find(pt => pt.l > 0);
  console.log("");
  console.log("Turnover history:");
  console.log(`  ${hq.recordsWithStartDate} records carry a start date and can be placed in time`);
  console.log(`  ${hq.leaversWithoutStartDate} leavers have no start date and are left out`);
  console.log(`  earliest departure on a dated record: ${hq.firstLeaverMonth || "none"}`);
  console.log(`  the line can begin 12 months after that, at ${firstWithLeavers ? firstWithLeavers.k : "n/a"}`);
  if (hq.leaversWithoutStartDate > 0) {
    console.log(`  Add a start date to those ${hq.leaversWithoutStartDate} records in Employment Hero ` +
      "and the line reaches further back on the next run.");
  }

  // ---- the Bids and IT dashboard, from the same pull
  //
  // team.json carries one row per person rather than aggregates, so the page can answer
  // any combination of the cost centre, period and gender filters exactly. It holds no
  // names, no salary and no full date of birth, and it is served behind its own password.

  const team = computeTeamData(employees, new Date().toISOString());
  writeFileSync(join(ROOT, "team.json"), JSON.stringify(team) + "\n", "utf8");

  console.log("");
  console.log(`Team dashboard: ${team.people.length} rows, ${team.coverage.headcount} active today`);
  console.log(`  field coverage, active people: ` +
    `date of birth ${team.coverage.birthDate}%, job title ${team.coverage.jobTitle}%, ` +
    `grade matched ${team.coverage.grade}%, discipline ${team.coverage.discipline}%, ` +
    `gender ${team.coverage.gender}%`);
  console.log(`  grades: ${team.filterOptions.grades.join(", ")}`);
  console.log(`  disciplines: ${team.filterOptions.disciplines.join(", ")}`);
  if (team.unmatchedJobTitles.length) {
    console.log(`  ${team.unmatchedJobTitles.length} job title(s) matched no position grade. ` +
      "Add the missing grade to POSITION_GRADES in scripts/team-metrics.mjs:");
    for (const t of team.unmatchedJobTitles) console.log(`    ${t}`);
  }
  if (Number(team.coverage.birthDate) < 50) {
    console.log("  Date of birth is sparse, so the average age is drawn from a minority " +
      "of records. The page says so on the tile.");
  }

  console.log("");
  console.log(`Headcount ${output.people.headcount}: ` +
    output.entities.map(e => `${e.name} ${e.headcount}`).join(", "));
  console.log(`Churn ${output.people.churnTotal}% total, ${output.people.churnVoluntary}% voluntary`);
  console.log(`Pay gap ${output.people.gpgMean}% mean, ${output.people.gpgMedian}% median`);
  console.log(`Excluded: ${JSON.stringify(output.dataQuality)}`);
}

/**
 * The Recruitment Forecast list uses short cost centre codes; Employment Hero uses full
 * names. Without this map every cost centre would show zero open roles.
 */
const RF_CODE_TO_COST_CENTRE = {
  mel: "Melbourne",
  syd: "Sydney",
  bne: "Brisbane",
  adl: "Adelaide",
  per: "Perth",
  lon: "London",
  corp: "NAT-CORP",
  esd: "NAT-ESD",
  spl: "NAT-SPL",
  dig: "NAT-DIG",
  str: "NAT-STR",
  bim: "NAT-BIM"
};

/** Active role counts per office come from recruitment.json, headcount from Employment Hero. */
function mergeActiveRoles(locations, recruitmentLocations) {
  if (!Array.isArray(recruitmentLocations)) return locations;
  const byName = new Map(
    recruitmentLocations.map(r => [String(r.name || r.code || "").toLowerCase().trim(),
                                   Number(r.activeRoles ?? r.openRoles) || 0])
  );
  return locations.map(l => ({ ...l, activeRoles: byName.get(String(l.name).toLowerCase().trim()) || 0 }));
}

/** Open role counts live in recruitment.json, headcount comes from Employment Hero. */
function mergeOpenRoles(costCentres, recruitmentCostCentres) {
  if (!Array.isArray(recruitmentCostCentres)) return costCentres;

  // Roll the recruitment codes up to the same names the metrics use
  const byName = new Map();
  for (const r of recruitmentCostCentres) {
    const raw = String(r.code || "").trim();
    const name = RF_CODE_TO_COST_CENTRE[raw.toLowerCase()] || raw;
    byName.set(name.toLowerCase(), (byName.get(name.toLowerCase()) || 0) + (Number(r.openRoles) || 0));
  }

  const matched = new Set();
  const merged = costCentres.map(cc => {
    const key = String(cc.code).toLowerCase().trim();
    if (byName.has(key)) matched.add(key);
    return { ...cc, openRoles: byName.get(key) || 0 };
  });

  const unmatched = [...byName.keys()].filter(k => !matched.has(k));
  if (unmatched.length) {
    console.warn("Recruitment: these cost centres had open roles but no matching headcount: " +
      unmatched.join(", ") + ". Add them to RF_CODE_TO_COST_CENTRE if the code is wrong.");
  }

  return merged;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
