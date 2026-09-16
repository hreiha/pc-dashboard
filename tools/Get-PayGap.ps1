<#
    Get-PayGap.ps1

    Calculates the gender pay gap from the Employment Hero CSV export and writes paygap.json.

    Runs on your machine, not in GitHub. The export contains names, dates of birth,
    nationality, marital status and visa type, none of which should ever be committed to a
    repository. This reads it locally and writes out four numbers and a few counts. Nothing
    about any individual leaves your laptop.

    Full-time equivalent conversion:
      Annum  as recorded, scaled to a 38 hour week if part time
      Hour   rate x 38 x 52
      Day    rate x 5 x 52
      Month  rate x 12

    Usage:
      ./tools/Get-PayGap.ps1 -CsvPath "C:\path\to\export.csv" -OutputPath ".\paygap.json"

    Then commit paygap.json. The dashboard picks it up on the next refresh.
#>

param(
    [Parameter(Mandatory = $true)][string] $CsvPath,
    [string] $OutputPath = ".\paygap.json",
    [double] $StandardHours = 38,
    [double] $WeeksPerYear = 52,
    # Casual rates normally carry a loading in lieu of leave. Set this to 1.25 to strip a
    # 25 per cent loading, or leave it at 1 to convert the rate exactly as recorded.
    [double] $CasualLoadingDivisor = 1
)

$AuLocations = @(
    "melbourne victoria", "sydney new south wales", "brisbane queensland",
    "adelaide south australia", "gold coast queensland",
    "perth western australia", "canberra australian capital territory"
)
$UkLocations = @("london")

function Get-Num([string] $value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return 0.0 }
    $clean = ($value -replace '[^0-9\.\-]', '')
    if ([string]::IsNullOrWhiteSpace($clean)) { return 0.0 }
    try { return [double]$clean } catch { return 0.0 }
}

function Get-FteSalary($row) {
    $rate = Get-Num $row.'Pay rate'
    if ($rate -le 0) { return 0.0 }

    $type = ($row.'Pay rate type' ?? "").Trim().ToLower()
    $employment = ($row.'Employment type' ?? "").Trim().ToLower()
    $hours = Get-Num $row.'Actual weekly hours'

    switch ($type) {
        "hour" {
            $annual = $rate * $StandardHours * $WeeksPerYear
            if ($employment -eq "casual") { $annual = $annual / $CasualLoadingDivisor }
            return $annual
        }
        "day"   { return $rate * 5 * $WeeksPerYear }
        "month" { return $rate * 12 }
        "annum" {
            if ($employment -eq "part-time" -and $hours -gt 0 -and $hours -lt $StandardHours) {
                return $rate * ($StandardHours / $hours)
            }
            return $rate
        }
        default { return 0.0 }
    }
}

function Get-Median([double[]] $values) {
    if ($values.Count -eq 0) { return 0.0 }
    $sorted = $values | Sort-Object
    $mid = [math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 0) { return ($sorted[$mid - 1] + $sorted[$mid]) / 2 }
    return $sorted[$mid]
}

function Get-Gap([double[]] $male, [double[]] $female, [bool] $useMedian) {
    if ($male.Count -eq 0 -or $female.Count -eq 0) { return "0.0" }
    $m = if ($useMedian) { Get-Median $male }   else { ($male   | Measure-Object -Average).Average }
    $f = if ($useMedian) { Get-Median $female } else { ($female | Measure-Object -Average).Average }
    if ($m -le 0) { return "0.0" }
    return ('{0:N1}' -f ((($m - $f) / $m) * 100))
}

if (-not (Test-Path $CsvPath)) {
    Write-Error "Cannot find $CsvPath"
    exit 1
}

$rows = Import-Csv -Path $CsvPath

$active = $rows | Where-Object {
    ($_.'Employment status' ?? "").Trim().ToLower() -eq "active"
}

function Get-Scoped($rows, [string[]] $locations) {
    return $rows | Where-Object { $locations -contains ($_.'Location' ?? "").Trim().ToLower() }
}

function Get-Figures($rows, [string] $label) {
    $withPay = @()
    foreach ($r in $rows) {
        $fte = Get-FteSalary $r
        if ($fte -gt 0) {
            $withPay += [pscustomobject]@{ Gender = ($r.'Gender' ?? "").Trim(); Fte = $fte }
        }
    }
    $male   = @($withPay | Where-Object { $_.Gender -eq "Male" }   | ForEach-Object { $_.Fte })
    $female = @($withPay | Where-Object { $_.Gender -eq "Female" } | ForEach-Object { $_.Fte })

    Write-Host ("{0,-14} {1,4} people, {2,3} male and {3,3} female with pay, {4,3} without" -f `
        $label, @($rows).Count, $male.Count, $female.Count, (@($rows).Count - $withPay.Count))

    return [ordered]@{
        gpgMean   = Get-Gap $male $female $false
        gpgMedian = Get-Gap $male $female $true
        male      = $male.Count
        female    = $female.Count
        noPayData = @($rows).Count - $withPay.Count
    }
}

$auRows  = Get-Scoped $active $AuLocations
$ukRows  = Get-Scoped $active $UkLocations
$allRows = @($auRows) + @($ukRows)

Write-Host ""
$all = Get-Figures $allRows "Combined"
$au  = Get-Figures $auRows  "ADP Australia"
$uk  = Get-Figures $ukRows  "ADP London"
Write-Host ""

$output = [ordered]@{
    generatedUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    sourceRows   = @($rows).Count
    combined     = $all
    entities     = [ordered]@{ AU = $au; UK = $uk }
}

$output | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8

Write-Host "Combined pay gap: $($all.gpgMean)% mean, $($all.gpgMedian)% median" -ForegroundColor Green
Write-Host "Written to $OutputPath. Commit that file, it holds no personal data." -ForegroundColor Green
