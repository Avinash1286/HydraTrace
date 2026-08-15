[CmdletBinding()]
param()

$secretDirectory = Join-Path $PSScriptRoot "secrets"
$secretPath = Join-Path $secretDirectory "auth-token"

if (Test-Path -LiteralPath $secretPath) {
  $existing = [System.IO.File]::ReadAllText($secretPath).Trim()
  if ($existing.Length -lt 32) {
    throw "Existing HydraDB token is shorter than the required 32 characters: $secretPath"
  }
  Write-Output "HydraDB token already exists ($($existing.Length) characters)."
  exit 0
}

[System.IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
$bytes = [byte[]]::new(48)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes)
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($secretPath, $token, $utf8WithoutBom)
Write-Output "Generated a local HydraDB token at $secretPath ($($token.Length) characters)."
