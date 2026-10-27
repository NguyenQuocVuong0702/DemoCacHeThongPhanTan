[CmdletBinding()]
param(
    [string]$ProjectName = '',
    [ValidateRange(15, 3600)][int]$TimeoutSeconds = 120
)
. (Join-Path $PSScriptRoot 'demo-common.ps1')
$script:PassedChecks = 0
$script:FailedChecks = 0

function Assert-Demo {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Invoke-Check {
    param([string]$Name, [scriptblock]$Test)
    try {
        & $Test
        $script:PassedChecks++
        Write-Host "[PASS] $Name" -ForegroundColor Green
    } catch {
        $script:FailedChecks++
        Write-Host "[FAIL] ${Name}: $($_.Exception.Message)" -ForegroundColor Red
    }
}

try {
    Initialize-Demo -ProjectName $ProjectName
    Invoke-Check 'API /health' { Assert-Demo ((Get-DemoJson '/health').status -eq 'ok') 'API not healthy' }
    Invoke-Check 'API /health/db' { Assert-Demo ((Get-DemoJson '/health/db').database -eq 'connected') 'Database not connected' }
    foreach ($id in @(1, 2, 3)) {
        Invoke-Check "edge-$id /health" {
            $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$(5000 + $id)/health" -TimeoutSec 5
            Assert-Demo ($health.status -eq 'ok' -and $health.nodeId -eq [string]$id) 'Invalid edge health response'
        }
    }
    Invoke-Check 'Stable cluster: 3 UP, leader/assignment authority edge-3, consistent leaderId' {
        $stable = 0
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds -and $stable -lt 3) {
            try {
                if (Test-DemoCluster) { $stable++ } else { $stable = 0 }
            } catch { $stable = 0 }
            if ($stable -lt 3) { Start-Sleep -Seconds 2 }
        }
        Assert-Demo ($stable -ge 3) 'Cluster did not converge for 3 consecutive samples'
    }
    $demoSensors = Get-Content -LiteralPath (Join-Path $script:DemoRoot 'config/demo-sensors.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Invoke-Check 'Six demo sensors have real readings, zones and valid assignments' {
        $allSensors = @((Get-DemoJson '/api/sensors').sensors)
        $allNodes = @((Get-DemoJson '/api/nodes').nodes)
        foreach ($demo in $demoSensors) {
            $found = @($allSensors | Where-Object { $_.id -eq $demo.id })
            Assert-Demo ($found.Count -eq 1) "Missing or duplicate $($demo.name)"
            $s = $found[0]
            Assert-Demo (-not [string]::IsNullOrWhiteSpace($s.zone)) "$($demo.name) has no zone; existing metadata was preserved"
            $nodes = @($allNodes | Where-Object { $_.id -eq $s.assignedNodeId })
            Assert-Demo ($nodes.Count -eq 1) "$($demo.name) has no valid assignment; existing metadata was preserved"
            $expected = 'FALLBACK'
            if ($s.zone -eq $nodes[0].zone) { $expected = 'SAME_ZONE' }
            Assert-Demo ($s.assignmentStrategy -eq $expected) 'Inconsistent assignment strategy'
            $readings = @((Get-DemoJson "/api/sensors/$($demo.id)/readings?limit=2").readings)
            Assert-Demo ($readings.Count -eq 2) "$($demo.name) has no pair of readings"
            Write-Host "       $($demo.name): zone=$($s.zone), edge=$($s.assignedNodeId), strategy=$expected"
        }
    }
    $countSql = "SELECT json_object_agg(s.id, s.total) FROM (SELECT sensor_id AS id, COUNT(*) AS total FROM telemetry_messages GROUP BY sensor_id) s"
    Invoke-Check 'All six telemetry streams continue to grow' {
        $before = Get-DemoSql $countSql | ConvertFrom-Json
        Wait-Demo -Name 'new samples from all demo sensors' -TimeoutSeconds $TimeoutSeconds -Test {
            $current = Get-DemoSql $countSql | ConvertFrom-Json
            foreach ($demo in $demoSensors) {
                $id = [string]$demo.id
                if ($null -eq $before.PSObject.Properties[$id] -or $null -eq $current.PSObject.Properties[$id]) { return $false }
                if ([long]$current.$id -le [long]$before.$id) { return $false }
            }
            return $true
        }
    }
    Invoke-Check 'Current assigned nodes actually process the six sensors' {
        Wait-Demo -Name 'processing provenance' -TimeoutSeconds $TimeoutSeconds -Test {
            $valid = Get-DemoSql "SELECT COUNT(*) FROM sensors s WHERE s.id IN ('1','2','3','4','5','6') AND s.assigned_node_id = (SELECT m.processed_by_node_id FROM telemetry_messages m WHERE m.sensor_id=s.id ORDER BY m.processed_at DESC LIMIT 1)"
            return $valid -eq '6'
        }
    }
    Invoke-Check 'Receipts, readings and alerts have consistent unique provenance' {
        $bad = Get-DemoSql "SELECT COUNT(*) FROM (SELECT m.sensor_id,m.message_id FROM telemetry_messages m LEFT JOIN sensor_readings r ON r.sensor_id=m.sensor_id AND r.message_id=m.message_id GROUP BY m.sensor_id,m.message_id,m.processed_by_node_id HAVING COUNT(r.id)<>2 OR COUNT(DISTINCT r.metric)<>2 OR BOOL_OR(r.processed_by_node_id IS DISTINCT FROM m.processed_by_node_id) UNION ALL SELECT a.sensor_id,a.message_id FROM alerts a JOIN telemetry_messages m USING(sensor_id,message_id) WHERE a.processed_by_node_id IS DISTINCT FROM m.processed_by_node_id) bad"
        Assert-Demo ($bad -eq '0') 'Incomplete sample or inconsistent processing node'
    }
    Invoke-Check 'Dashboard HTTP' {
        $page = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/' -TimeoutSec 5
        Assert-Demo ($page.StatusCode -eq 200 -and $page.Content -match '<div id="root">') 'Dashboard HTML not available'
    }
    Write-Host "Checks: $script:PassedChecks PASS, $script:FailedChecks FAIL"
    if ($script:FailedChecks -gt 0) { exit 1 }
    exit 0
} catch {
    Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
