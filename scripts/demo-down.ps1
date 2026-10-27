[CmdletBinding()]
param([string]$ProjectName = '')
. (Join-Path $PSScriptRoot 'demo-common.ps1')
try {
    Initialize-Demo -ProjectName $ProjectName
    Invoke-DemoCompose -Arguments @('down')
    Write-Host 'Demo stopped. PostgreSQL volume and data are preserved.'
    exit 0
} catch {
    Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
