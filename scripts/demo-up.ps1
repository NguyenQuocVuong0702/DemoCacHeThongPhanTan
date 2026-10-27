[CmdletBinding()]
param(
    [string]$ProjectName = '',
    [ValidateRange(15, 3600)][int]$TimeoutSeconds = 180,
    [switch]$NoBuild
)
. (Join-Path $PSScriptRoot 'demo-common.ps1')

try {
    Initialize-Demo -ProjectName $ProjectName
    Invoke-DemoCompose -Arguments @('config', '--quiet')
    $upArgs = @('up', '-d')
    if (-not $NoBuild) { $upArgs += '--build' }
    # Compose health dependencies gate startup; bounded service healthchecks
    # report migration/dependency failure as a non-zero exit here.
    Invoke-DemoCompose -Arguments $upArgs
    Wait-DemoJob -Service 'migrate' -TimeoutSeconds $TimeoutSeconds
    Wait-Demo -Name 'PostgreSQL' -TimeoutSeconds $TimeoutSeconds -Test { (Get-DemoSql 'SELECT 1') -eq '1' }
    Wait-Demo -Name 'API and database' -TimeoutSeconds $TimeoutSeconds -Test {
        (Get-DemoJson '/health').status -eq 'ok' -and (Get-DemoJson '/health/db').database -eq 'connected'
    }
    foreach ($port in @(5001, 5002, 5003)) {
        Wait-Demo -Name "edge health port $port" -TimeoutSeconds $TimeoutSeconds -Test {
            (Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5).status -eq 'ok'
        }
    }
    Wait-DemoJob -Service 'demo-bootstrap' -TimeoutSeconds $TimeoutSeconds
    Wait-Demo -Name 'Dashboard' -TimeoutSeconds $TimeoutSeconds -Test {
        (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/' -TimeoutSec 5).StatusCode -eq 200
    }
    & (Join-Path $PSScriptRoot 'demo-check.ps1') -ProjectName $ProjectName -TimeoutSeconds $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw 'Demo smoke checks failed.' }
    Invoke-DemoCompose -Arguments @('ps', '-a') | Out-Host
    Write-Host 'Dashboard: http://localhost:8080'
    Write-Host 'API:       http://localhost:4000'
    exit 0
} catch {
    Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red
    Show-DemoDiagnostics
    exit 1
}
