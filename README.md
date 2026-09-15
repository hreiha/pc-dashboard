# P&C dashboard: Power Automate → GitHub → Vercel

A dashboard showing Employment Hero people metrics across both entities, and recruitment
metrics from the Recruitment Forecast SharePoint list.

**How it works.** A scheduled Power Automate flow reads Employment Hero and the Recruitment
Forecast list once a day, reduces everything to a few dozen aggregate numbers, and commits
them to `data.json` in a GitHub repo. Vercel redeploys on every push. A serverless function
checks a username and password before serving the page or the figures.

```
Power Automate (daily)
  ├─ refresh Employment Hero token
  ├─ GET employees for both organisations, tagged AU and UK
  ├─ Get items from the Recruitment Forecast list
  ├─ aggregate to ~40 numbers
  └─ PUT data.json to GitHub  ──→  Vercel deploy  ──→  https://your-dash.vercel.app
```

---

## Read this before you build

**Vercel's Hobby plan is non-commercial use only.** That is a licence term, not a quota, and
Vercel does enforce it. An internal dashboard for the business sits on the commercial side of
that line. Either put it on a Vercel Pro seat at $20 a month (viewer seats are free, so one
paid seat covers everyone), or use Render's free tier, which permits commercial use but sleeps
after 15 idle minutes. The build is identical either way.

**Password Protection is a paid Vercel feature**, and the free Vercel Authentication option
needs every viewer to have a seat on your team. So `api/index.js` does the auth itself with a
username and password. That works on any plan.

| Item | Detail |
| --- | --- |
| Employment Hero subscription | API access is Platinum and above. |
| PKCE | Employment Hero made PKCE mandatory from **14 September 2026**. Power Automate custom connectors cannot produce a `code_challenge`, so the first handshake runs outside Power Automate via `tools/Get-EmploymentHeroToken.ps1`. The refresh call needs no PKCE, so the flow takes over from there. This build uses the premium HTTP action, so no custom connector is needed. |
| Entities | One refresh token covers both organisations. Every employee record gets tagged `AU` or `UK` during the pull. |
| Recruitment data | Comes from the Recruitment Forecast list via the standard SharePoint connector. No second OAuth app and no rotating token. |
| Deployment limit | Vercel Hobby allows 100 deployments a day. A daily refresh uses one. |
| Sensitivity | Keep `data.json` aggregate only, never employee-level rows. It is bundled into the function rather than served as a static file, so it cannot be reached without signing in. |

---

## Part 1 — Get the Employment Hero refresh token (one time)

1. Sign in to Employment Hero as an owner or admin. Developer Portal is under your profile
   name, top right.
2. **Add Application**, named something like `P&C Dashboard`.
3. Choose scopes. **Scopes are a one-time selection and cannot be changed afterwards**, so
   pick generously within read-only.
4. Redirect URI: `https://oauth.pstmn.io/v1/callback`. Employment Hero rejects `localhost`.
5. Copy the client ID and secret, then run:

   ```powershell
   ./tools/Get-EmploymentHeroToken.ps1 -ClientId "..." -ClientSecret "..."
   ```

   Copy the `code=` value out of the browser address bar and paste it back in. The script
   prints the refresh token and both organisation IDs.

---

## Part 2 — Token storage in SharePoint

Create a list called **IntegrationTokens** on a site only P&C admins can open.

| Column | Type |
| --- | --- |
| Title | Single line of text |
| RefreshToken | Multiple lines of text, **plain text** |

Add one item, ID `1`, titled `EmploymentHero`, with the refresh token pasted in. Break
permission inheritance on the list.

Everything else goes in solution **environment variables**:

| Name | Value |
| --- | --- |
| `EH_ClientId` | from the Developer Portal |
| `EH_ClientSecret` | from the Developer Portal |
| `EH_OrgId_AU` | `415dbd83-a1ad-4ac8-adb9-d545c04078de` |
| `EH_OrgId_UK` | `446cf850-f703-40d4-ba3f-e001b17bf0ce` |
| `RF_SiteUrl` | the site hosting the Recruitment Forecast list |
| `GitHub_PAT` | fine-grained token, Contents read and write |
| `GitHub_Repo` | `owner/repo` |

---

## Part 3 — The GitHub repo

1. Create a **private** repo, e.g. `pc-dashboard`.
2. Push the contents of this folder to it, including `data.json` with the sample values. The
   flow updates an existing file, so `data.json` must exist before the first run.
3. Create a **fine-grained personal access token** scoped to this repo only, with
   **Contents: Read and write**. Diarise its expiry.

---

## Part 4 — Vercel

Do this before building the flow, so you have a working dashboard to test against.

1. Sign in to vercel.com with your GitHub account.
2. **Add New → Project**, import the repo.
3. Framework Preset: **Other**. Leave build command, output directory and install command
   empty. `vercel.json` handles the routing.
4. Add environment variables `DASH_USER` and `DASH_PASS`, applied to Production, Preview and
   Development. Use a long passphrase.
5. Deploy, then open the URL. You should get a sign-in prompt, then the sample figures. If the
   dashboard loads without asking for a password, check the Framework Preset is Other.

Every commit to `main` triggers a fresh deployment. Nothing is scheduled on the Vercel side.

---

## Part 5 — The Power Automate flow

Action names below use underscores the way Power Automate does inside expressions. If you name
an action differently, adjust the expression to match.

### Finding your internal column names

SharePoint stores display names differently internally. "Cost Centre" is usually
`Cost_x0020_Centre`, "Days to Hire" is `Days_x0020_to_x0020_Hire`, and so on, but renamed
columns keep their original internal name, so "Role Status" might be `Status` if it was called
something else when created.

Build the flow as far as the **Get items** action, run it once, and open the raw output. Every
key you need is there. Choice columns come back as objects, so the value is
`item()?['Cost_x0020_Centre']?['Value']`, not `item()?['Cost_x0020_Centre']`. Calculated columns
come back as **strings**, so Days Posted and Days to Hire need `float()` around them before any
arithmetic.

Placeholders below are written as `<RoleStatus>`, `<Stage>` and so on. Substitute your real
internal names once you have them.

### 1. Recurrence

Frequency **Day**, interval **1**, time zone **(UTC+10:00) Brisbane**, at hour **6**.

### 2. Read the stored token

**Get item** (SharePoint) → list `IntegrationTokens`, Id `1`. Rename to `Get_EH_token_row`.

### 3. Refresh the Employment Hero token

**HTTP**, renamed `Refresh_EH_token`.

- Method: `POST`
- URI:

  ```
  https://oauth.employmenthero.com/oauth2/token?grant_type=refresh_token&refresh_token=@{encodeUriComponent(outputs('Get_EH_token_row')?['body/RefreshToken'])}
  ```

- Headers: `Content-Type` = `application/x-www-form-urlencoded`
- Body (raw text):

  ```
  client_id=@{encodeUriComponent(parameters('EH_ClientId'))}&client_secret=@{encodeUriComponent(parameters('EH_ClientSecret'))}
  ```

**Update item** on `IntegrationTokens`, Id `1`, Title `EmploymentHero`, RefreshToken:

```
body('Refresh_EH_token')?['refresh_token']
```

**Compose** `EH_access_token`:

```
body('Refresh_EH_token')?['access_token']
```

The access token lives 15 minutes. Keep everything downstream tight.

### 4. Pull employees from both entities

**Initialize variable** `OrgIds`, type Array:

```json
["@{parameters('EH_OrgId_AU')}", "@{parameters('EH_OrgId_UK')}"]
```

**Initialize variable** `Employees` (Array) = `[]`, `PageIndex` (Integer) = `1`,
`TotalPages` (Integer) = `1`.

**Apply to each** over `variables('OrgIds')`, renamed `For_each_org`. In its Settings, turn
**Concurrency Control on with degree of parallelism 1**. The loop shares variables and parallel
runs will corrupt them.

Inside, first reset the paging: **Set variable** `PageIndex` = `1`, **Set variable**
`TotalPages` = `1`.

Then a **Do until** with condition `variables('PageIndex')` **is greater than**
`variables('TotalPages')`, limits Count `60` and Timeout `PT10M`:

1. **HTTP** `Get_EH_employees`, method `GET`:

   ```
   https://api.employmenthero.com/api/v1/organisations/@{items('For_each_org')}/employees?page_index=@{variables('PageIndex')}&item_per_page=100
   ```

   Header: `Authorization` = `Bearer @{outputs('EH_access_token')}`

2. **Select** `Tag_entity`. From `body('Get_EH_employees')?['data']?['items']`. Switch the Map
   box to text mode with the icon on the right, then:

   ```
   addProperty(item(), 'entity', if(equals(items('For_each_org'), parameters('EH_OrgId_AU')), 'AU', 'UK'))
   ```

3. **Set variable** `TotalPages`: `int(body('Get_EH_employees')?['data']?['total_pages'])`
4. **Set variable** `Employees`: `union(variables('Employees'), body('Tag_entity'))`
5. **Increment variable** `PageIndex` by `1`

Every employee now carries an `entity` property of `AU` or `UK`, so any metric can be split
without a second pull.

### 5. Hand the employees to the Office Script

Power Automate has no `sort()` and no `sum()`, which rules out a median, and reconstructing
month-end headcount for twelve months with expressions is unmaintainable. Both are a few lines
in an Office Script, so all of the maths lives in `tools/ComputeMetrics.ts`.

**Set it up once:** create an empty workbook in OneDrive called `PC Metrics Engine.xlsx`. Open
it in Excel on the web, go to **Automate → New Script**, paste in the contents of
`tools/ComputeMetrics.ts`, and save it as `ComputeMetrics`. The workbook itself is never
touched. It only exists because Office Scripts have to be attached to one.

Before you save, edit the three configuration blocks at the top:

- `VOLUNTARY_REASONS` — your actual Employment Hero leaving reasons, in lower case
- `EXCLUDE_FROM_UK_ENTITY` and `EXCLUDE_FROM_AU_ENTITY` — set to `Australia` and `London`
  respectively. These are exclusion lists, not entity assignment, and they match exactly
  rather than as substrings, so a location of "Australia Wide" would not be caught. Add
  further values if new location options appear in Employment Hero.

**In the flow:**

**Select** `Normalise_employees` — From `variables('Employees')`. Leave it in key-value mode
and build these exact keys, filling the values from the Employment Hero fields you confirmed
in the raw output:

| Key | Value |
| --- | --- |
| `id` | `item()?['id']` |
| `gender` | `item()?['gender']` |
| `location` | `item()?['<location field>']` |
| `employmentType` | `item()?['<employment type field>']` |
| `hoursPerWeek` | `float(if(empty(item()?['<hours field>']), '0', item()?['<hours field>']))` |
| `annualSalary` | `float(if(empty(item()?['<salary field>']), '0', item()?['<salary field>']))` |
| `hourlyRate` | `float(if(empty(item()?['<rate field>']), '0', item()?['<rate field>']))` |
| `startDate` | `item()?['start_date']` |
| `terminationDate` | `item()?['termination_date']` |
| `terminationReason` | `item()?['termination_reason']` |
| `level4` | `item()?['<level 4 field>']` |
| `costCentre` | `item()?['<cost centre field>']` |
| `entity` | `item()?['entity']` |

The key names must match exactly, since the script reads them by name. The `entity` key is the
tag applied in step 4 and is what tells the script which organisation each record came from. Note that pay fields
need the remuneration scope on your Employment Hero application. If they come back empty, that
is a scope problem, not a field name problem, and scopes cannot be changed after creation.

**Run script** (Excel Online (Business)), renamed `Compute_metrics`:

- Location: OneDrive for Business
- File: `PC Metrics Engine.xlsx`
- Script: `ComputeMetrics`
- `employeesJson`: `string(body('Normalise_employees'))`
- `asOfIso`: `utcNow()`

**Parse JSON** `Metrics` — Content: `body('Compute_metrics')?['result']`. Generate the schema
by running the flow once and pasting the output into the sample payload box.

Everything the dashboard needs for the people half is now in `body('Metrics')`, and the entity
split, churn, pay gap and trend come out finished. The only thing left to merge in is open
roles per cost centre from the Recruitment Forecast list.

#### What the script calculates

**Scope.** Entity comes from which Employment Hero organisation the record sits in: ADP
Consulting is ADP Australia, ADP Consulting & Engineering Ltd is ADP London. Location is then
used only to strip out people who hold an account in an organisation for access reasons rather
than because they work for that entity. Three exclusions apply:

- blank location, from both organisations
- location recorded as `Australia` in the UK organisation
- location recorded as `London` in the Australian organisation

Each count appears in the dashboard footer. If a number looks wrong, that is where to start.
Note this catches people placed in the wrong entity by location, but not non-employees who are
correctly located. If contractors or similar are still inflating the count after this, add a
filter on employment type or employment status in the same loop.

**Churn (LTM).** Leavers over the last twelve months divided by average headcount over the same
period. Average headcount is the number of active internal employees at each month end, summed
over twelve months and divided by twelve. Voluntary churn uses the same denominator with the
numerator filtered to the reasons in `VOLUNTARY_REASONS`. Split by the Level 4 value, each group
getting its own denominator.

**YTD annualised turnover.** Leavers since 1 July divided by average month-end headcount across
the financial year to date, scaled by twelve over months elapsed.

**Gender pay gap.** Mean and median, expressed as a percentage of the male figure, so a positive
number means men are paid more. Every salary is converted to full-time equivalent first: part
time is scaled to a 38 hour week, casual is hourly rate multiplied by 38 by 52. Records with no
usable pay data are excluded from the gap rather than counted as zero, and the number excluded
appears in the footer.

One thing to decide: casual rates usually carry a loading of around 25 per cent in lieu of
leave. The formula you gave converts the rate as recorded, which will place casuals slightly
above an equivalent permanent employee. If casuals skew one way by gender that will move the
gap. Divide by 1.25 in `fteSalary()` if you would rather strip the loading.

### 6. Read the Recruitment Forecast list

**Get items** (SharePoint), renamed `Get_RF_items`.

- Site Address: `@{parameters('RF_SiteUrl')}`
- List Name: `Recruitment Forecast`
- Top Count: `5000`
- In Settings, turn **Pagination** on with a threshold of `5000`

Leave the Filter Query blank for now. Once the flow works you can add
`<RoleStatus> ne 'Closed'` to cut the volume, but get it running first, because an OData filter
on a renamed or non-indexed column fails in ways that are hard to read.

**Filter array** `Filter_open_roles` — From `body('Get_RF_items')?['value']`:

```
@equals(item()?['<RoleStatus>']?['Value'], 'Open')
```

Substitute whatever your open value actually is.

**Filter array** `Filter_filled_month` — From `body('Get_RF_items')?['value']`:

```
@and(not(empty(item()?['<DateAccepted>'])), greaterOrEquals(item()?['<DateAccepted>'], formatDateTime(startOfMonth(utcNow()), 'yyyy-MM-dd')))
```

### 7. Group the pipeline by Stage, without hardcoding the stages

**Select** `Select_stages` — From `body('Filter_open_roles')`, Map in text mode:

```
item()?['<Stage>']?['Value']
```

**Compose** `Distinct_stages`:

```
union(body('Select_stages'), body('Select_stages'))
```

Union against itself is the idiomatic way to deduplicate in Power Automate.

**Initialize variable** `Pipeline`, type Array, value `[]`.

**Apply to each** over `outputs('Distinct_stages')`, renamed `For_each_stage`, with
**concurrency set to 1**. Inside:

1. **Filter array** `Filter_stage` — From `body('Filter_open_roles')`:

   ```
   @equals(item()?['<Stage>']?['Value'], items('For_each_stage'))
   ```

2. **Append to array variable** `Pipeline`:

   ```json
   {
     "stage": "@{items('For_each_stage')}",
     "count": @{length(body('Filter_stage'))}
   }
   ```

Repeat the whole pattern with `<CostCentre>` in place of `<Stage>` to build a `CostCentres`
variable of open role counts. To add headcount to those rows, add a **Filter array** inside the
same loop against `body('Filter_active')` matching the Employment Hero field that holds the
cost centre. If Employment Hero stores it as a team or department name rather than the three
letter code, you will need a lookup, and the simplest place for that is a small SharePoint
mapping list rather than a nest of `if()` expressions.

### 8. Averages from the calculated columns

There is no `sum()` in Power Automate, so averages need a loop.

**Initialize variable** `DaysOpenSum`, type Float, value `0`.

**Apply to each** over `body('Filter_open_roles')`, **concurrency 1**, containing an
**Increment variable** on `DaysOpenSum` by:

```
float(item()?['<DaysPosted>'])
```

Then the average:

```
formatNumber(div(variables('DaysOpenSum'), float(length(body('Filter_open_roles')))), 'N1')
```

Repeat with `<DaysToHire>` over `body('Filter_filled_month')` for average days to hire. Guard
against an empty month by wrapping in `if(equals(length(body('Filter_filled_month')), 0), '0', ...)`,
otherwise a month with no hires divides by zero and fails the run.

### 9. Build the payload

Most of it now comes straight out of the script. **Compose**, renamed `Dashboard_JSON`:

```json
{
  "generatedUtc": "@{utcNow()}",
  "periodLabel": "@{body('Metrics')?['periodLabel']}",
  "priorLabel": "@{body('Metrics')?['priorLabel']}",
  "people": @{body('Metrics')?['people']},
  "churnByLevel4": @{body('Metrics')?['churnByLevel4']},
  "entities": @{body('Metrics')?['entities']},
  "recruitment": {
    "openRoles": @{length(body('Filter_open_roles'))},
    "openRolesPrior": @{<prior month open roles>},
    "filledMonth": @{length(body('Filter_filled_month'))},
    "filledMonthPrior": @{length(body('Filter_filled_prior_month'))},
    "avgDaysOpen": "@{<average expression>}",
    "avgDaysOpenPrior": "@{<average expression>}",
    "avgDaysToHire": "@{<average expression>}",
    "avgDaysToHirePrior": "@{<average expression>}"
  },
  "pipeline": @{variables('Pipeline')},
  "costCentres": @{variables('CostCentres')},
  "headcountTrend": @{body('Metrics')?['headcountTrend']},
  "dataQuality": @{body('Metrics')?['dataQuality']}
}
```

Nothing pulled from `body('Metrics')` gets quotes around it. Those are already objects and
arrays, and quoting them turns them into strings the dashboard cannot read. The only quoted
values are the two date strings.

`costCentres` needs headcount from the script and open roles from the list. Build the variable
by looping over `body('Metrics')?['costCentres']` and, for each one, a **Filter array** against
`body('Filter_open_roles')` matching on cost centre, then **Append to array variable**:

```json
{
  "code": "@{items('For_each_cc')?['code']}",
  "headcount": @{items('For_each_cc')?['headcount']},
  "female": @{items('For_each_cc')?['female']},
  "openRoles": @{length(body('Filter_cc_roles'))}
}
```

Concurrency 1 on that loop, as with the others.

`openRolesPrior` and the prior-period recruitment averages need last month's snapshot, which
the list does not keep. Either add a small `RecruitmentHistory` SharePoint list that the flow
writes one row to each month and reads back, or leave those four values out of the JSON. The
dashboard simply omits the comparison arrow when a prior value is missing, so nothing breaks.

### 10. Commit to GitHub

**HTTP** `Get_current_file`:

- Method `GET`
- URI: `https://api.github.com/repos/@{parameters('GitHub_Repo')}/contents/data.json`
- Headers:

  ```
  Authorization: Bearer @{parameters('GitHub_PAT')}
  Accept: application/vnd.github+json
  X-GitHub-Api-Version: 2022-11-28
  User-Agent: adp-pc-dashboard
  ```

**HTTP** `Commit_data_json`:

- Method `PUT`, same URI and headers
- Body:

  ```json
  {
    "message": "Dashboard refresh @{formatDateTime(utcNow(), 'yyyy-MM-dd HH:mm')} UTC",
    "content": "@{base64(string(outputs('Dashboard_JSON')))}",
    "sha": "@{body('Get_current_file')?['sha']}",
    "branch": "main"
  }
  ```

The `sha` is what makes this an update rather than a rejected create, which is why `data.json`
has to be in the repo already.

### 11. Failure notification

**Send an email (V2)** with **Configure run after** set to *has failed* and *has timed out*,
pointed at yourself. A silent failure shows up as a dashboard quietly going stale, which is
worse than an error.

---

## How the pieces relate

| Thing | Where it lives | Refreshed by |
| --- | --- | --- |
| Employment Hero refresh token | SharePoint list `IntegrationTokens` | The flow, every run |
| Client ID and secret | Power Automate environment variables | Manually, when rotated |
| Recruitment data | The Recruitment Forecast list | Your team, as they work |
| The figures | `data.json` in the GitHub repo | The flow, every run |
| Dashboard username and password | Vercel environment variables | Manually |
| The live site | Vercel | Automatically, on every commit |

## When something breaks

| Symptom | Likely cause |
| --- | --- |
| Dashboard shows yesterday's date | Flow failed, or the commit failed. Check the flow run history. |
| 401 from Employment Hero mid-run | The 15 minute access token expired during the employee loop. Refresh it again before the data calls. |
| UK headcount is zero | The `entity` tag did not apply. Check the Select in step 4 is mapping in text mode, not key-value mode. |
| Pipeline counts are duplicated or missing | An Apply to each is running in parallel while appending to a variable. Set concurrency to 1. |
| `The template language function 'float' expects its parameter to be...` | A calculated column returned blank. Wrap it: `float(if(empty(item()?['<DaysPosted>']), '0', item()?['<DaysPosted>']))` |
| Pipeline renders as a single line of text | `@{variables('Pipeline')}` was wrapped in quotes in the Compose. |
| Pay gap shows 0.0% | The remuneration scope is missing from the Employment Hero application, so salary fields came back empty. Scopes cannot be changed after creation, so this needs a new application. |
| Headcount higher than expected | The location value did not match exactly. Trailing spaces are handled, but a variant like "Australia (remote)" is not. Check the distinct location values in Employment Hero against the two exclusion lists. |
| Someone is in the wrong entity | The `entity` key in `Normalise_employees` is wrong, or the `addProperty` in step 4 mapped the organisation IDs the wrong way round. AU is `415dbd83-a1ad-4ac8-adb9-d545c04078de`. |
| Churn looks low in the first month | The script reconstructs month-end headcount from start and termination dates. If Employment Hero does not return terminated employees by default, the denominator is right but the numerator is empty. Check the employees endpoint returns leavers. |
| GitHub PUT returns 409 | The `sha` is stale. The GET must run immediately before the PUT in the same run. |
| Dashboard loads without asking for a password | `vercel.json` did not deploy, or the Framework Preset is not Other. |
