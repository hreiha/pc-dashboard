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
  location:          ["location", "office", "work_location", "primary_location"],
  employmentType:    ["employment_type", "employmentType", "employee_type"],
  hoursPerWeek:      ["hours_per_week", "weekly_hours", "contracted_hours"],
  annualSalary:      ["annual_salary", "salary", "base_salary", "annual_salary_rate"],
  hourlyRate:        ["hourly_rate", "rate", "hourly_salary_rate"],
  startDate:         ["start_date", "employment_start_date", "hire_date"],
  terminationDate:   ["termination_date", "end_date", "employment_end_date"],
  terminationReason: ["termination_reason", "reason_for_leaving", "separation_reason"],
  level4:            ["level_4", "level4", "division", "business_unit"],
  costCentre:        ["cost_centre", "cost_center", "team", "department"]
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

  return json.access_token;
}

async function fetchAllEmployees(accessToken, orgId, entity) {
  const collected = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= 200) {
    const url = `${API_BASE}/organisations/${orgId}/employees?page_index=${page}&item_per_page=${PAGE_SIZE}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Employee fetch failed for ${entity} on page ${page} with ${res.status}: ${text}`);
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
    gender: String(pick(raw, FIELDS.gender)),
    location: String(pick(raw, FIELDS.location)),
    employmentType: String(pick(raw, FIELDS.employmentType)),
    hoursPerWeek: toNumber(pick(raw, FIELDS.hoursPerWeek)),
    annualSalary: toNumber(pick(raw, FIELDS.annualSalary)),
    hourlyRate: toNumber(pick(raw, FIELDS.hourlyRate)),
    startDate: String(pick(raw, FIELDS.startDate)),
    terminationDate: String(pick(raw, FIELDS.terminationDate)),
    terminationReason: String(pick(raw, FIELDS.terminationReason)),
    level4: String(pick(raw, FIELDS.level4)),
    costCentre: String(pick(raw, FIELDS.costCentre)),
    entity
  };
}

/**
 * Recruitment figures are not in Employment Hero. If recruitment.json exists in the repo it
 * is merged in, otherwise the recruitment section renders as zeros and the rest still works.
 */
function loadRecruitment() {
  const path = join(ROOT, "recruitment.json");
  if (!existsSync(path)) {
    console.log("No recruitment.json found, recruitment figures will show as zero.");
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(`recruitment.json could not be parsed, ignoring it: ${err.message}`);
    return null;
  }
}

async function main() {
  const clientId = required("EH_CLIENT_ID");
  const clientSecret = required("EH_CLIENT_SECRET");
  const refreshToken = required("EH_REFRESH_TOKEN");
  const orgAu = required("EH_ORG_ID_AU");
  const orgUk = required("EH_ORG_ID_UK");

  const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);

  const rawEmployees = [
    ...(await fetchAllEmployees(accessToken, orgAu, "AU")),
    ...(await fetchAllEmployees(accessToken, orgUk, "UK"))
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

  const metrics = computeMetrics(employees, new Date().toISOString());
  const recruitment = loadRecruitment();

  const output = {
    generatedUtc: new Date().toISOString(),
    periodLabel: metrics.periodLabel,
    priorLabel: metrics.priorLabel,
    people: metrics.people,
    churnByLevel4: metrics.churnByLevel4,
    entities: metrics.entities,
    recruitment: recruitment?.recruitment ?? {
      openRoles: 0, filledMonth: 0, avgDaysOpen: "0.0", avgDaysToHire: "0.0"
    },
    pipeline: recruitment?.pipeline ?? [],
    costCentres: mergeOpenRoles(metrics.costCentres, recruitment?.costCentres),
    headcountTrend: metrics.headcountTrend,
    dataQuality: metrics.dataQuality
  };

  writeFileSync(join(ROOT, "data.json"), JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`Headcount ${output.people.headcount}: ` +
    output.entities.map(e => `${e.name} ${e.headcount}`).join(", "));
  console.log(`Churn ${output.people.churnTotal}% total, ${output.people.churnVoluntary}% voluntary`);
  console.log(`Pay gap ${output.people.gpgMean}% mean, ${output.people.gpgMedian}% median`);
  console.log(`Excluded: ${JSON.stringify(output.dataQuality)}`);
}

/** Open role counts live in recruitment.json, headcount comes from Employment Hero. */
function mergeOpenRoles(costCentres, recruitmentCostCentres) {
  if (!Array.isArray(recruitmentCostCentres)) return costCentres;
  return costCentres.map(cc => {
    const match = recruitmentCostCentres.find(
      r => String(r.code).toLowerCase().trim() === String(cc.code).toLowerCase().trim()
    );
    return { ...cc, openRoles: match ? Number(match.openRoles) || 0 : 0 };
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
