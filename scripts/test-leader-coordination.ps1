# Run after demo-up on the standard demo; never resets volumes.
[CmdletBinding()]
param([string]$ProjectName='smartedge')
. (Join-Path $PSScriptRoot 'demo-common.ps1')
try {
    Initialize-Demo -ProjectName $ProjectName
    $env:LEADER_COORDINATION_TESTING='1'
    if(-not $env:DATABASE_URL){$env:DATABASE_URL='postgres://smartedge:smartedge@127.0.0.1:5432/smartedge'}
    & node (Join-Path $PSScriptRoot 'test-leader-authority.mjs')
    if($LASTEXITCODE -ne 0){throw 'Leader authority live tests failed'}
    & node (Join-Path $PSScriptRoot 'test-leader-db-recovery.mjs')
    if($LASTEXITCODE -ne 0){throw 'Leader DB reconnect test failed'}
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test-phase-b.ps1') -ProjectName $ProjectName -CheckLeaderAuthority
    if($LASTEXITCODE -ne 0){throw 'Leader-controlled fault matrix failed'}
    exit 0
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
    exit 1
}
