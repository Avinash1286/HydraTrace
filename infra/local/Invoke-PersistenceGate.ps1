[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$composeFile = Join-Path $PSScriptRoot "docker-compose.yml"
$secretScript = Join-Path $PSScriptRoot "Initialize-HydraDbSecret.ps1"
$secretPath = Join-Path $PSScriptRoot "secrets/auth-token"
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker is not installed or not on PATH. Install/start Docker Desktop, then rerun this command."
}

& $secretScript
docker compose -f $composeFile up -d hydradb-node

$nodeReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9090/readyz" -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $nodeReady = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $nodeReady) { throw "HydraDB graph node did not become ready within 60 seconds." }

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
  docker compose -f $composeFile up -d hydradb-indexer

  $indexReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
      $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9091/metrics" -TimeoutSec 2).Content
      $hasCycle = $metrics -match '(?m)^graph_indexer_successful_cycles\s+[1-9][0-9]*(?:\.0+)?$'
      $hasGeneration = $metrics -match '(?m)^graph_indexer_generations_published\{[^}]*edge_type="DEPENDS_ON_INSTANCE"[^}]*\}\s+[1-9][0-9]*(?:\.0+)?$'
      if ($hasCycle -and $hasGeneration) {
        $indexReady = $true
        break
      }
    } catch {
      # The indexer may still be starting or building its first generation.
    }
    Start-Sleep -Seconds 2
  }
  if (-not $indexReady) { throw "HydraDB indexer did not publish the dependency index within 60 seconds." }

  docker compose -f $composeFile restart hydradb-node
  Start-Sleep -Seconds 5
  pnpm smoke:hydradb
  Write-Output "HydraDB persistence, idempotency, indexing, and three-hop path gate passed."
} finally {
  $env:HYDRADB_AUTH_TOKEN = $null
  Pop-Location
}
