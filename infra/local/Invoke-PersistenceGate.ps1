[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$composeFile = Join-Path $PSScriptRoot "docker-compose.yml"
$secretPath = Join-Path $PSScriptRoot "secrets/auth-token"
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")

function Wait-HydraDbNodeReady {
  param(
    [int]$TimeoutSeconds = 60
  )

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = $null

  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9090/readyz" -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return
      }
      $lastFailure = "HTTP status $($response.StatusCode)"
    } catch {
      $lastFailure = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  }

  $detail = if ($lastFailure) { " Last response: $lastFailure" } else { "" }
  throw "HydraDB graph node did not become ready within $TimeoutSeconds seconds.$detail"
}

function Get-PrometheusMetricValue {
  param(
    [Parameter(Mandatory)]
    [string]$Metrics,

    [Parameter(Mandatory)]
    [string]$MetricName
  )

  $pattern = '(?m)^' + [regex]::Escape($MetricName) + '\s+([0-9]+(?:\.[0-9]+)?)$'
  $match = [regex]::Match($Metrics, $pattern)
  if (-not $match.Success) { return $null }
  return [double]::Parse(
    $match.Groups[1].Value,
    [System.Globalization.CultureInfo]::InvariantCulture
  )
}

function Wait-HydraDbIndexerHealthy {
  param(
    [long]$MinimumSuccessfulCycles = 4,
    [int]$TimeoutSeconds = 60
  )

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastState = "metrics unavailable"

  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9091/readyz" -TimeoutSec 2
      $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9091/metrics" -TimeoutSec 2).Content
      $ready = Get-PrometheusMetricValue -Metrics $metrics -MetricName "graph_indexer_ready"
      $successfulCycles = Get-PrometheusMetricValue -Metrics $metrics -MetricName "graph_indexer_successful_cycles"
      $consecutiveFailures = Get-PrometheusMetricValue -Metrics $metrics -MetricName "graph_indexer_consecutive_failed_cycles"
      $hasGeneration = $metrics -match '(?m)^graph_indexer_generations_published\{[^}]*edge_type="DEPENDS_ON_INSTANCE"[^}]*\}\s+[1-9][0-9]*(?:\.0+)?$'
      $lastState = "ready=$ready successfulCycles=$successfulCycles consecutiveFailures=$consecutiveFailures generation=$hasGeneration"

      if (
        $health.StatusCode -eq 200 -and
        $ready -eq 1 -and
        $null -ne $successfulCycles -and
        $successfulCycles -ge $MinimumSuccessfulCycles -and
        $consecutiveFailures -eq 0 -and
        $hasGeneration
      ) {
        return [long]$successfulCycles
      }
    } catch {
      $lastState = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  }

  throw "HydraDB indexer did not sustain healthy indexed cycles within $TimeoutSeconds seconds. Last state: $lastState"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker is not installed or not on PATH. Install/start Docker Desktop, then rerun this command."
}

if (-not (Test-Path -LiteralPath $secretPath)) {
  $secretDirectory = Split-Path -Parent $secretPath
  [System.IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
  $bytes = [byte[]]::new(48)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [System.IO.File]::WriteAllText(
    $secretPath,
    [Convert]::ToBase64String($bytes),
    [System.Text.UTF8Encoding]::new($false)
  )
}
$tokenLength = [System.IO.File]::ReadAllText($secretPath).Trim().Length
if ($tokenLength -lt 32) { throw "HydraDB auth token must contain at least 32 characters." }

docker compose -f $composeFile up -d hydradb-node
if ($LASTEXITCODE -ne 0) { throw "docker compose failed to start hydradb-node." }
Wait-HydraDbNodeReady

$env:HYDRADB_BOLT_URI = "bolt://127.0.0.1:7687"
$env:HYDRADB_HTTP_URL = "http://127.0.0.1:8443"
$env:HYDRADB_ADMIN_URL = "http://127.0.0.1:9090"
$env:HYDRADB_GRAPH_ID = "default"
$env:HYDRADB_CELL_ID = "cell-0"
$env:HYDRADB_NAMESPACE = "development"
$env:HYDRADB_CONSISTENCY = "strong"
$env:HYDRADB_AUTH_TOKEN = [System.IO.File]::ReadAllText($secretPath).Trim()

Push-Location $workspaceRoot
try {
  pnpm smoke:hydradb
  if ($LASTEXITCODE -ne 0) { throw "The HydraDB smoke probe failed." }
  docker compose -f $composeFile up -d hydradb-indexer
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed to start hydradb-indexer." }
  $successfulCyclesBeforeRestart = Wait-HydraDbIndexerHealthy

  docker compose -f $composeFile restart hydradb-node
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed to restart hydradb-node." }
  Wait-HydraDbNodeReady
  pnpm smoke:hydradb
  if ($LASTEXITCODE -ne 0) { throw "The post-restart HydraDB smoke probe failed." }
  $null = Wait-HydraDbIndexerHealthy -MinimumSuccessfulCycles ($successfulCyclesBeforeRestart + 1)
  Write-Output "HydraDB persistence, idempotency, indexing, and three-hop path gate passed."
} finally {
  $env:HYDRADB_AUTH_TOKEN = $null
  Pop-Location
}
