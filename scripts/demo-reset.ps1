[CmdletBinding()]
param([string]$ProjectName = '')
. (Join-Path $PSScriptRoot 'demo-common.ps1')
try {
    Initialize-Demo -ProjectName $ProjectName
    # Show the resolved project and volumes, including .env / COMPOSE_PROJECT_NAME.
    $config = (Invoke-DemoCompose -Arguments @('config', '--format', 'json')) -join "`n" | ConvertFrom-Json
    $volumeName = $config.volumes.'smartedge-postgres-data'.name
    Write-Host "Project: $($config.name)"
    Write-Host "PostgreSQL volume to DELETE: $volumeName" -ForegroundColor Yellow
    Write-Host 'All readings, rules, alerts, sensors and assignments in this project will be lost.' -ForegroundColor Yellow
    $required = "RESET $($config.name)"
    $answer = Read-Host "Type exactly '$required' to confirm deletion"
    if ($answer -cne $required) {
        Write-Host 'Reset cancelled. No data was deleted.'
        exit 0
    }
    Invoke-DemoCompose -Arguments @('down', '--volumes')
    Write-Host 'Demo data removed. Run demo-up.ps1 with the same ProjectName to create a fresh demo.'
    exit 0
} catch {
    Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
