<#
    Get-EmploymentHeroToken.ps1

    One-time handshake to obtain an Employment Hero refresh token.
    Employment Hero made PKCE mandatory from 14 September 2026, and Power Automate
    custom connectors cannot generate a code_challenge, so this step has to be done
    outside Power Automate. The refresh call afterwards does not need PKCE, which is
    why Power Automate can take over from here.

    Run in PowerShell 7. Register the redirect URI below in the Developer Portal first.
    Employment Hero rejects localhost, so this uses Postman's public callback endpoint.
    The page simply displays; copy the code= value out of the browser address bar.
#>

param(
    [Parameter(Mandatory = $true)][string] $ClientId,
    [Parameter(Mandatory = $true)][string] $ClientSecret,
    [string] $RedirectUri = "https://oauth.pstmn.io/v1/callback"
)

# 1. Build the PKCE verifier and challenge.
$bytes = New-Object byte[] 64
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$verifier = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha256.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($verifier))
$challenge = [Convert]::ToBase64String($hash).TrimEnd('=').Replace('+', '-').Replace('/', '_')

# 2. Open the authorisation URL.
$authUrl = "https://oauth.employmenthero.com/oauth2/authorize" +
           "?client_id=$([uri]::EscapeDataString($ClientId))" +
           "&redirect_uri=$([uri]::EscapeDataString($RedirectUri))" +
           "&response_type=code" +
           "&code_challenge=$challenge" +
           "&code_challenge_method=S256"

Write-Host ""
Write-Host "Sign in as an Employment Hero owner or admin, approve the scopes, then copy the" -ForegroundColor Cyan
Write-Host "'code' value out of the browser address bar. The page itself will fail to load." -ForegroundColor Cyan
Write-Host ""
Write-Host $authUrl
Write-Host ""
Start-Process $authUrl

$code = Read-Host "Paste the code value"

# 3. Exchange the code. The code expires quickly, so do this straight away.
$tokenUrl = "https://oauth.employmenthero.com/oauth2/token" +
            "?grant_type=authorization_code" +
            "&redirect_uri=$([uri]::EscapeDataString($RedirectUri))"

$body = @{
    client_id     = $ClientId
    client_secret = $ClientSecret
    code          = $code.Trim()
    code_verifier = $verifier
}

$response = Invoke-RestMethod -Method Post -Uri $tokenUrl -Body $body `
    -ContentType "application/x-www-form-urlencoded"

Write-Host ""
Write-Host "Access token expires in $($response.expires_in) seconds." -ForegroundColor Green
Write-Host "Granted scopes: $($response.scope)"
Write-Host ""
Write-Host "REFRESH TOKEN (store this in the SharePoint token list):" -ForegroundColor Yellow
Write-Host $response.refresh_token

# 4. Grab the organisation ID while the access token is still valid.
$orgs = Invoke-RestMethod -Method Get -Uri "https://api.employmenthero.com/api/v1/organisations" `
    -Headers @{ Authorization = "Bearer $($response.access_token)" }

Write-Host ""
Write-Host "Organisations visible to this token:" -ForegroundColor Yellow
$orgs.data.items | ForEach-Object { Write-Host "  $($_.id)  $($_.name)" }
