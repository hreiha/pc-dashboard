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

### 5. Reduce the people numbers

**Filter array** `Filter_active` — From `variables('Employees')`, advanced mode:

```
@equals(item()?['employment_status'], 'Active')
```

**Filter array** `Filter_female` — From `body('Filter_active')`:

```
@equals(item()?['gender'], 'Female')
```

**Filter array** `Filter_active_UK` — From `body('Filter_active')`:

```
@equals(item()?['entity'], 'UK')
```

**Filter array** `Filter_active_AU` — same with `'AU'`. Repeat the female filter against each
entity array for the per-entity percentages.

**Filter array** `Filter_leavers` — From `variables('Employees')`:

```
@and(not(empty(item()?['termination_date'])), greaterOrEquals(item()?['termination_date'], formatDateTime(startOfMonth(utcNow()), 'yyyy-MM-dd')))
```

**Filter array** `Filter_leavers_voluntary` — From `body('Filter_leavers')`:

```
@equals(item()?['termination_reason'], 'Resignation')
```

| Figure | Expression |
| --- | --- |
| Headcount | `length(body('Filter_active'))` |
| Female % to one decimal | `formatNumber(mul(div(float(length(body('Filter_female'))), float(length(body('Filter_active')))), 100), 'N1')` |
| Leavers this month | `length(body('Filter_leavers'))` |
| Start of month | `formatDateTime(startOfMonth(utcNow()), 'yyyy-MM-dd')` |
| Start of FY (1 July) | `formatDateTime(addYears(startOfMonth(utcNow()), if(greaterOrEquals(int(formatDateTime(utcNow(), 'MM')), 7), 0, -1)), 'yyyy-07-01')` |
| Months elapsed in FY | `add(mod(add(sub(int(formatDateTime(utcNow(), 'MM')), 7), 12), 12), 1)` |
| Annualised turnover | `formatNumber(mul(div(mul(float(<YTD leavers>), 12.0), mul(float(<average headcount>), float(<months elapsed>))), 100), 'N1')` |

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

**Compose**, renamed `Dashboard_JSON`:

```json
{
  "generatedUtc": "@{utcNow()}",
  "periodLabel": "@{formatDateTime(utcNow(), 'MMMM yyyy')}",
  "people": {
    "headcount": @{length(body('Filter_active'))},
    "headcountPrior": @{<prior month headcount>},
    "femalePct": "@{formatNumber(mul(div(float(length(body('Filter_female'))), float(length(body('Filter_active')))), 100), 'N1')}",
    "femalePctPrior": "@{<prior month female pct>}",
    "leaversMonth": @{length(body('Filter_leavers'))},
    "leaversVoluntaryMonth": @{length(body('Filter_leavers_voluntary'))},
    "turnoverYtdTotal": "@{<expression>}",
    "turnoverYtdVoluntary": "@{<expression>}",
    "turnoverAnnualisedTotal": "@{<expression>}",
    "turnoverAnnualisedVoluntary": "@{<expression>}"
  },
  "entities": [
    {
      "code": "AU",
      "name": "ADP Consulting",
      "headcount": @{length(body('Filter_active_AU'))},
      "female": @{length(body('Filter_female_AU'))},
      "femalePct": "@{formatNumber(mul(div(float(length(body('Filter_female_AU'))), float(length(body('Filter_active_AU')))), 100), 'N1')}",
      "leaversMonth": @{<expression>}
    },
    {
      "code": "UK",
      "name": "ADP Consulting & Engineering Ltd",
      "headcount": @{length(body('Filter_active_UK'))},
      "female": @{length(body('Filter_female_UK'))},
      "femalePct": "@{formatNumber(mul(div(float(length(body('Filter_female_UK'))), float(length(body('Filter_active_UK')))), 100), 'N1')}",
      "leaversMonth": @{<expression>}
    }
  ],
  "recruitment": {
    "openRoles": @{length(body('Filter_open_roles'))},
    "filledMonth": @{length(body('Filter_filled_month'))},
    "avgDaysOpen": "@{<average expression>}",
    "avgDaysToHire": "@{<average expression>}"
  },
  "pipeline": @{variables('Pipeline')},
  "costCentres": @{variables('CostCentres')},
  "headcountTrend": []
}
```

Note that `pipeline` and `costCentres` have no quotes around them. They are already arrays, and
quoting them turns them into strings the dashboard cannot read.

For `headcountPrior` and `headcountTrend`, neither source holds history. Add a SharePoint list
`HeadcountHistory` with Month and Headcount columns, have the flow add one item per month, and
read the last six back. Until it has six months the sparkline will be short, which is fine.

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
| GitHub PUT returns 409 | The `sha` is stale. The GET must run immediately before the PUT in the same run. |
| Dashboard loads without asking for a password | `vercel.json` did not deploy, or the Framework Preset is not Other. |
