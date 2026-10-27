# Integration test: normal cluster -> edge-3 stopped -> edge-3 restarted.
[CmdletBinding()]
param(
    [string]$ProjectName = 'smartedge',
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 90,
    [switch]$CheckOnly
)
. (Join-Path $PSScriptRoot 'demo-common.ps1')

function Get-GossipSnapshot {
    $snapshot = @{ api = Get-DemoJson '/api/cluster'; health = @{}; gossip = @{} }
    foreach ($id in @('1', '2', '3')) {
        try {
            $snapshot.health[$id] = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$(5000 + [int]$id)/health" -TimeoutSec 2
        } catch { $snapshot.health[$id] = $null }
        if ($null -ne $snapshot.health[$id]) {
            $snapshot.gossip[$id] = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$(5000 + [int]$id)/gossip/state" -TimeoutSec 2
        }
    }
    return $snapshot
}

function Assert-GossipSnapshot {
    param($Snapshot, [string]$Leader)
    $nodes = @($Snapshot.api.nodes)
    if ($nodes.Count -ne 3) { throw 'API must return all 3 nodes' }
    $leaders = @($nodes | Where-Object { $_.status -eq 'UP' -and $_.role -eq 'LEADER' })
    if ($leaders.Count -ne 1 -or $leaders[0].id -ne $Leader -or $Snapshot.api.summary.leaderId -ne $Leader) {
        throw "API has not converged to leader $Leader"
    }
    foreach ($id in @('1', '2', '3')) {
        $apiNode = @($nodes | Where-Object { $_.id -eq $id })
        if ($apiNode.Count -ne 1) { throw "API node $id missing/duplicated" }
        if ($Leader -eq '2' -and $id -eq '3') {
            if ($apiNode[0].status -ne 'DOWN' -or $null -ne $Snapshot.health[$id]) {
                throw 'Stopped edge-3 should be DOWN and /health unreachable'
            }
            continue
        }
        $health = $Snapshot.health[$id]
        if ($null -eq $health) { throw "edge-$id /health unreachable" }
        $role = 'FOLLOWER'
        if ($id -eq $Leader) { $role = 'LEADER' }
        if ($health.nodeId -ne $id -or $health.status -ne 'ok' -or $health.role -ne $role -or $health.leaderId -ne $Leader) {
            throw "edge-$id /health has not converged"
        }
        if ($apiNode[0].status -ne 'UP' -or $apiNode[0].role -ne $health.role -or $apiNode[0].leaderId -ne $health.leaderId) {
            throw "API and edge-$id /health disagree"
        }
    }
    foreach ($observer in @('1', '2', '3')) {
        if ($null -eq $Snapshot.health[$observer]) { continue }
        $view = $Snapshot.gossip[$observer]
        if ($view.nodeId -ne $observer -or @($view.knowledge).Count -ne 3) { throw "edge-$observer gossip membership incomplete" }
        foreach ($id in @('1', '2', '3')) {
            $records = @($view.knowledge | Where-Object { $_.nodeId -eq $id })
            if ($records.Count -ne 1) { throw "edge-$observer gossip member $id missing/duplicated" }
            $record = $records[0]
            if ($Leader -eq '2' -and $id -eq '3') {
                # A stopped node cannot report a new role. Gossip retains the
                # last known owner state; API uses UNKNOWN for unreachable nodes.
                if ($record.status -ne 'DOWN') { throw "edge-$observer still sees edge-3 UP" }
            } else {
                $health = $Snapshot.health[$id]
                if ($record.status -ne 'UP' -or $record.role -ne $health.role -or $record.leaderId -ne $health.leaderId) {
                    throw "edge-$observer gossip for edge-$id disagrees with /health: $($record.status)/$($record.role)/$($record.leaderId)"
                }
                $owner = @($Snapshot.gossip[$id].knowledge | Where-Object { $_.nodeId -eq $id })
                if ($owner.Count -ne 1 -or $record.updatedAt -ne $owner[0].updatedAt) {
                    throw "edge-$observer does not have edge-$id's current owner version"
                }
            }
        }
    }
}

function Show-GossipSnapshot {
    param($Snapshot)
    Write-Output ('API: ' + ((@($Snapshot.api.nodes) | Sort-Object id | ForEach-Object { "$($_.id)=$($_.status)/$($_.role)/$($_.leaderId)" }) -join '; '))
    foreach ($id in @('1', '2', '3')) {
        $health = $Snapshot.health[$id]
        if ($null -eq $health) { Write-Output "HEALTH edge-${id}: unreachable"; continue }
        Write-Output "HEALTH edge-${id}: $($health.role)/$($health.leaderId)"
        $rows = @($Snapshot.gossip[$id].knowledge | Sort-Object nodeId | ForEach-Object { "$($_.nodeId)=$($_.status)/$($_.role)/$($_.leaderId)" })
        Write-Output "GOSSIP edge-${id}: $($rows -join '; ')"
        $versions = @($Snapshot.gossip[$id].knowledge | Sort-Object nodeId | ForEach-Object { "$($_.nodeId)=$($_.updatedAt)" })
        Write-Output "VERSIONS edge-${id}: $($versions -join '; ')"
    }
}

function Wait-GossipConvergence {
    param([string]$Phase, [string]$Leader)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $stable = 0
    $snapshot = $null
    $lastError = 'No snapshot yet'
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        try {
            $snapshot = Get-GossipSnapshot
            Assert-GossipSnapshot -Snapshot $snapshot -Leader $Leader
            $stable++
            if ($stable -ge 3) {
                Write-Output "[PASS] ${Phase}: 3 consecutive matching samples (leader=$Leader)"
                Show-GossipSnapshot $snapshot
                return
            }
        } catch { $stable = 0; $lastError = $_.Exception.Message }
        Start-Sleep -Seconds 2
    }
    if ($null -ne $snapshot) { Show-GossipSnapshot $snapshot }
    throw "${Phase}: timeout after ${TimeoutSeconds}s: $lastError"
}

$edge3Stopped = $false
try {
    Initialize-Demo -ProjectName $ProjectName
    Wait-GossipConvergence -Phase 'normal' -Leader '3'
    if (-not $CheckOnly) {
        Invoke-DemoCompose -Arguments @('stop', 'edge-3')
        $edge3Stopped = $true
        Wait-GossipConvergence -Phase 'edge-3 stopped / edge-2 leader' -Leader '2'
        Invoke-DemoCompose -Arguments @('up', '-d', '--no-deps', 'edge-3')
        $edge3Stopped = $false
        Wait-GossipConvergence -Phase 'edge-3 recovered' -Leader '3'
    }
    exit 0
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
    exit 1
} finally {
    if ($edge3Stopped) { Invoke-DemoCompose -Arguments @('up', '-d', '--no-deps', 'edge-3') | Out-Host }
}
