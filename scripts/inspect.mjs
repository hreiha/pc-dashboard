/**
 * inspect.mjs
 *
 * Prints the shape and the distinct values of the fields the dashboard depends on, so the
 * mappings can be set from fact rather than guessed.
 *
 * Deliberately prints no names, emails, dates of birth or salaries. Only the field names,
 * the structure of nested objects, and how many people hold each value.
 *
 * Run from the Actions tab: "Inspect Employment Hero fields".
 */

const TOKEN_URL = "https://oauth.employmenthero.com/oauth2/token";
const API_BASE = "https://api.employmenthero.com/api/v1";

// Values are counted and printed for these. Safe to show: they are categories, not people.
const CATEGORICAL = [
  "location",
  "employment_type",
  "status",
  "employing_entity",
  "payroll_type",
  "independent_contractor",
  "primary_cost_centre",
  "teams",
  "role",
  "typical_work_day",
  "termination_summary"
];

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing environment variable ${name}.`);
    process.exit(1);
  }
  return v.trim();
}

async function accessToken() {
  const url = `${TOKEN_URL}?grant_type=refresh_token&refresh_token=${encodeURIComponent(required("EH_REFRESH_TOKEN"))}`;
  const body = new URLSearchParams({
    client_id: required("EH_CLIENT_ID"),
    client_secret: required("EH_CLIENT_SECRET")
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    console.error(`Token refresh failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()).access_token;
}

async function fetchAll(token, orgId, label) {
  const out = [];
  let page = 1, totalPages = 1;
  while (page <= totalPages && page <= 200) {
    const res = await fetch(
      `${API_BASE}/organisations/${orgId}/employees?page_index=${page}&item_per_page=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      console.error(`${label} page ${page} failed: ${res.status}`);
      process.exit(1);
    }
    const data = (await res.json()).data || {};
    totalPages = Number(data.total_pages ?? 1) || 1;
    for (const item of data.items || []) out.push({ ...item, __entity: label });
    page += 1;
  }
  return out;
}

/** Short description of a value's shape, without showing anything personal. */
function shapeOf(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return "[] empty array";
    return `array of ${typeof v[0] === "object" ? `{ ${Object.keys(v[0]).join(", ")} }` : typeof v[0]}`;
  }
  if (typeof v === "object") return `{ ${Object.keys(v).join(", ")} }`;
  return typeof v;
}

/** Flatten a value to something countable: a string, or a nested name/value if it is an object. */
function labelOf(v) {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "(empty array)";
    return v.map(x => (typeof x === "object" ? (x.name ?? x.title ?? x.value ?? JSON.stringify(Object.keys(x))) : x)).join(" | ");
  }
  if (typeof v === "object") return String(v.name ?? v.title ?? v.value ?? v.label ?? JSON.stringify(Object.keys(v)));
  return String(v);
}

function tally(records, field) {
  const counts = new Map();
  for (const r of records) {
    const key = labelOf(r[field]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const token = await accessToken();
  const au = await fetchAll(token, required("EH_ORG_ID_AU"), "AU");
  const uk = await fetchAll(token, required("EH_ORG_ID_UK"), "UK");
  const all = [...au, ...uk];

  console.log(`Records: ${au.length} in the AU organisation, ${uk.length} in the UK organisation`);
  console.log("");

  console.log("=== Field shapes (from the first record) ===");
  for (const field of CATEGORICAL) {
    console.log(`  ${field.padEnd(24)} ${shapeOf(all[0][field])}`);
  }
  console.log("");

  for (const field of CATEGORICAL) {
    const rows = tally(all, field);
    console.log(`=== ${field} (${rows.length} distinct) ===`);
    for (const [value, count] of rows.slice(0, 40)) {
      console.log(`  ${String(count).padStart(5)}  ${value}`);
    }
    if (rows.length > 40) console.log(`  ... and ${rows.length - 40} more`);
    console.log("");
  }

  console.log("=== location split by organisation ===");
  for (const [label, set] of [["AU", au], ["UK", uk]]) {
    console.log(`  ${label}:`);
    for (const [value, count] of tally(set, "location").slice(0, 30)) {
      console.log(`    ${String(count).padStart(5)}  ${value}`);
    }
  }
  console.log("");

  const active = all.filter(r => labelOf(r.status).toLowerCase() === "active");
  console.log(`Records with status Active: ${active.length}`);
  console.log(`  of which in the AU organisation: ${active.filter(r => r.__entity === "AU").length}`);
  console.log(`  of which in the UK organisation: ${active.filter(r => r.__entity === "UK").length}`);
  console.log(`Records with a termination_date: ${all.filter(r => r.termination_date).length}`);
  console.log(`Records flagged independent_contractor: ${all.filter(r => r.independent_contractor === true).length}`);

  const sample = active.find(r => r.__entity === "AU") || all[0];
  await probePay(token, required("EH_ORG_ID_AU"), sample.id);
}

async function probePay(token, orgId, sampleId) {
  console.log("");
  console.log("=== Looking for pay data ===");

  const paths = [
    `/organisations/${orgId}/employees/${sampleId}`,
    `/organisations/${orgId}/employees/${sampleId}/employment_histories`,
    `/organisations/${orgId}/employees/${sampleId}/pay_details`,
    `/organisations/${orgId}/employees/${sampleId}/remuneration`,
    `/organisations/${orgId}/employees/${sampleId}/salaries`,
    `/organisations/${orgId}/employment_histories`,
    `/organisations/${orgId}/pay_details`
  ];

  for (const path of paths) {
    try {
      const res = await fetch(API_BASE + path, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        console.log(`  ${res.status.toString().padEnd(4)} ${path}`);
        continue;
      }
      const json = await res.json();
      const data = json.data ?? json;
      const sample = Array.isArray(data?.items) ? data.items[0] : data;
      const keys = sample && typeof sample === "object" ? Object.keys(sample).sort() : [];
      console.log(`  200  ${path}`);
      console.log(`       keys: ${keys.join(", ") || "(none)"}`);
      const payish = keys.filter(k => /pay|salary|rate|remunerat|wage|compensat|hour/i.test(k));
      if (payish.length) console.log(`       PAY FIELDS: ${payish.join(", ")}`);
    } catch (err) {
      console.log(`  err  ${path}  ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
