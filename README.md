# Setup

GitHub Actions pulls from Employment Hero on a schedule, writes `data.json`, and commits it.
Vercel redeploys on the commit. That is the whole system.

```
GitHub Actions (daily, 6am Brisbane)
  ├─ refresh the Employment Hero token
  ├─ pull employees from both organisations
  ├─ scope, calculate, write data.json
  └─ commit  ──→  Vercel deploy  ──→  https://pc-dashboard-delta.vercel.app
```

Nothing else is involved. No Power Automate, no SharePoint list, no Excel workbook.

| File | What it does |
| --- | --- |
| `.github/workflows/refresh.yml` | the schedule and the commit |
| `scripts/refresh.mjs` | talks to Employment Hero, maps the fields, writes `data.json` |
| `scripts/metrics.mjs` | all of the calculation, and the configuration you edit |
| `views/index.html` | the dashboard |
| `api/index.js` | serves it, with optional password |
| `data.json` | the figures, rewritten by each run |
| `recruitment.json` | recruitment figures, maintained separately (see the last section) |

---

## 1. Add the repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Five of them:

| Name | Value |
| --- | --- |
| `EH_CLIENT_ID` | from the Employment Hero Developer Portal |
| `EH_CLIENT_SECRET` | from the Developer Portal |
| `EH_REFRESH_TOKEN` | printed by `tools/Get-EmploymentHeroToken.ps1` |
| `EH_ORG_ID_AU` | `415dbd83-a1ad-4ac8-adb9-d545c04078de` |
| `EH_ORG_ID_UK` | `446cf850-f703-40d4-ba3f-e001b17bf0ce` |

Regenerate the client secret first if it has been in a screenshot. Doing so does not invalidate
the refresh token.

## 2. Push the repository

The folder structure has to survive, so use GitHub Desktop or the command line rather than the
web uploader, which flattens folders:

```
.github/workflows/refresh.yml
api/index.js
scripts/metrics.mjs
scripts/refresh.mjs
views/index.html
data.json
recruitment.json
package.json
vercel.json
```

## 3. Run it once by hand

**Actions → Refresh dashboard data → Run workflow.**

It will probably not produce the right numbers first time. That is expected, and the log tells
you why. Open the run and read the output of the pull step:

- **"Available fields on the first record"** lists every key Employment Hero returned. This is
  what you map against.
- **"These fields came back empty for every record"** names the fields that need remapping.

## 4. Map the field names

Open `scripts/refresh.mjs` and find the `FIELDS` block near the top. Each entry is a list of
candidate key names, tried in order. Add your real key name to the front of any list that the
log flagged:

```js
location: ["office_location", "location", "office"],
```

Salary and hourly rate depend on the remuneration scopes being on your Employment Hero
application. If those come back empty and the key name is clearly right, that is a scope
problem, and scopes cannot be changed after an application is created.

Commit and run the workflow again.

## 5. Tune the scoping

Open `scripts/metrics.mjs`. The configuration block at the top is the only part you edit:

| Setting | What to put in it |
| --- | --- |
| `AU_ENTITY_LOCATIONS` | every Australian Location value, lower case, matched exactly |
| `UK_ENTITY_LOCATIONS` | `["london"]` |
| `EXCLUDED_EMPLOYMENT_TYPES` | however independent contractors are recorded, substring match |
| `VOLUNTARY_REASONS` | your Reason for leaving values that count as voluntary |

Target is roughly 303 in Australia and 14 in London. The run log prints the headcount and the
exclusion counts, so you can see which rule accounts for any gap:

| Symptom | Fix |
| --- | --- |
| Headcount low, `excludedWrongLocationAu` high | a Location value is missing from `AU_ENTITY_LOCATIONS` |
| Headcount low, `excludedBlankLocation` high | the `location` field mapping is wrong |
| Headcount high | contractors are not being caught, add their employment type value |
| Churn is zero | Employment Hero is only returning active employees, so there are no termination dates to count |

Repeat until the numbers match. Each run takes under a minute.

## 6. Put the password back

Once the figures are right, add `DASH_USER` and `DASH_PASS` in Vercel under
**Settings → Environment Variables**, applied to Production, then redeploy from the Deployments
tab. Environment variable changes only apply to new builds.

The orange banner on the dashboard disappears when auth is on. While it is showing, anyone with
the URL can read the figures.

---

## Recruitment figures

Employment Hero has no recruitment data, so `recruitment.json` is a separate file holding the
figures from the Recruitment Forecast list. It currently has sample values. Three ways to fill
it, in increasing order of effort:

1. **Edit it by hand** once a month when you do the report. Commit, Vercel redeploys. Takes a
   minute and needs nothing built.
2. **A small Power Automate flow**, five or six actions: Get items from the Recruitment Forecast
   list, count the open roles, build the JSON, PUT it to the GitHub contents API. This is the
   only part of the job where Power Automate is genuinely the right tool, because it already has
   a SharePoint connector and GitHub Actions does not.
3. **Microsoft Graph from the same Node script**, which means an Azure app registration with
   Sites.Read.All and admin consent. More setup than option 2 for the same result.

Start with option 1. It costs you a minute a month and it means the people half of the dashboard
is live now rather than after another build.

---

## Cost and limits

| Thing | Limit | This uses |
| --- | --- | --- |
| GitHub Actions on a private repo | 2,000 minutes a month free | about 30 |
| Vercel Hobby deployments | 100 a day | 1 |
| Employment Hero access token | 15 minutes | the run takes seconds |

The Vercel Hobby licence is still non-commercial use only. That question is unchanged by any of
this, and it is the one remaining thing standing between this and being properly free.
