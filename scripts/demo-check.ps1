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
    Invoke-Check 'Stable cluster: 3 UP, one leader edge-3, consistent leaderId' {
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
    Invoke-Check 'Real sensor-1 and telemetry exist' {
        $sensors = @((Get-DemoJson '/api/sensors').sensors | Where-Object { $_.id -eq '1' })
        Assert-Demo ($sensors.Count -eq 1) 'Expected exactly one sensor with id 1'
        $readings = @((Get-DemoJson '/api/sensors/1/readings?limit=5').readings)
        Assert-Demo ($readings.Count -gt 0) 'No sensor readings'
    }
    Invoke-Check 'Telemetry reading count continues to grow' {
        $before = [long](Get-DemoSql "SELECT COUNT(*) FROM sensor_readings WHERE sensor_id = '1'")
        Wait-Demo -Name 'new readings' -TimeoutSeconds $TimeoutSeconds -Test {
            [long](Get-DemoSql "SELECT COUNT(*) FROM sensor_readings WHERE sensor_id = '1'") -gt $before
        }
    }
    Invoke-Check 'Sensor-1 zone and valid assignment' {
        $sensor = @((Get-DemoJson '/api/sensors').sensors | Where-Object { $_.id -eq '1' })
        Assert-Demo ($sensor.Count -eq 1) 'Sensor-1 missing'
        $s = $sensor[0]
        Assert-Demo (-not [string]::IsNullOrWhiteSpace($s.zone)) 'Sensor-1 has no zone; existing database metadata was preserved'
        Assert-Demo ($s.assignedNodeId -in @('1', '2', '3')) 'Sensor-1 has no valid edge assignment; existing database metadata was preserved'
        $nodes = @((Get-DemoJson '/api/nodes').nodes | Where-Object { $_.id -eq $s.assignedNodeId })
        Assert-Demo ($nodes.Count -eq 1) 'Assigned node metadata missing'
        $expected = 'FALLBACK'
        if ($s.zone -eq $nodes[0].zone) { $expected = 'SAME_ZONE' }
        Assert-Demo ($s.assignmentStrategy -eq $expected) 'Inconsistent assignment strategy'
        if ($s.zone -eq 'hanoi' -and $nodes[0].zone -eq 'hanoi') {
            Assert-Demo ($s.assignmentStrategy -eq 'SAME_ZONE') 'Expected SAME_ZONE'
        }
        Write-Host "       sensor-1: zone=$($s.zone), edge=$($s.assignedNodeId), strategy=$($s.assignmentStrategy)"
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
