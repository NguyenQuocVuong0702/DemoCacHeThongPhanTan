# Shared helpers for Windows PowerShell 5.1. Keep scripts ASCII for PS 5.1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:DemoRoot = Split-Path -Parent $PSScriptRoot
$script:DemoComposeArgs = @()

function Initialize-Demo {
    param([string]$ProjectName = '')
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLI not found. Install Docker Desktop, then reopen PowerShell.'
    }
    $script:DemoComposeArgs = @('compose', '--project-directory', $script:DemoRoot, '-f', (Join-Path $script:DemoRoot 'docker-compose.yml'))
    if ($ProjectName) {
        if ($ProjectName -cnotmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'Invalid Compose project name.' }
        $script:DemoComposeArgs += @('--project-name', $ProjectName)
    }
    & docker compose version | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2+ is required (docker compose).' }
    & docker info --format '{{.ServerVersion}}' | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Docker daemon unavailable. Start Docker Desktop with Linux containers and wait until it is ready.' }
}

function Invoke-DemoCompose {
    param([string[]]$Arguments)
    & docker @script:DemoComposeArgs @Arguments
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
}

function Get-DemoJson {
    param([string]$Path)
    Invoke-RestMethod -UseBasicParsing -Uri ('http://127.0.0.1:4000' + $Path) -TimeoutSec 5
}

function Get-DemoSql {
    param([string]$Sql)
    $result = Invoke-DemoCompose -Arguments @('exec', '-T', 'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'smartedge', '-d', 'smartedge', '-c', $Sql)
    ($result -join "`n").Trim()
}

function Wait-Demo {
    param([string]$Name, [scriptblock]$Test, [int]$TimeoutSeconds = 180)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $lastError = 'Not ready yet'
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        try {
            if (& $Test) { return }
        } catch { $lastError = $_.Exception.Message }
        Start-Sleep -Seconds 2
    }
    throw "Timeout waiting for $Name after ${TimeoutSeconds}s. Last error: $lastError"
}

function Test-DemoCluster {
    $cluster = Get-DemoJson '/api/cluster'
    $nodes = @($cluster.nodes)
    if ($nodes.Count -ne 3 -or @($nodes | Where-Object { $_.role -eq 'LEADER' }).Count -ne 1) { return $false }
    foreach ($id in @('1', '2', '3')) {
        $node = @($nodes | Where-Object { $_.id -eq $id -and $_.status -eq 'UP' -and $_.leaderId -eq '3' })
        if ($node.Count -ne 1) { return $false }
    }
    $leader = @($nodes | Where-Object { $_.id -eq '3' -and $_.role -eq 'LEADER' })
    if($leader.Count -ne 1 -or $cluster.summary.leaderId -ne '3'){return $false}
    if((Get-DemoSql "SELECT COUNT(*) FROM assignment_authority WHERE singleton=true AND holder_node_id='3' AND lease_until>clock_timestamp()") -ne '1'){return $false}
    $authority=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:5003/assignments/authority' -TimeoutSec 5
    ($authority.lease.valid -and $authority.lease.holderNodeId -eq '3' -and $null -ne $authority.localEpoch -and $authority.localEpoch -eq $authority.lease.epoch)
}

function Wait-DemoJob {
    param([string]$Service, [int]$TimeoutSeconds)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $containerId = Invoke-DemoCompose -Arguments @('ps', '-a', '-q', $Service)
        if ($containerId) {
            $stateText = & docker inspect --format '{{json .State}}' $containerId
            if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $Service." }
            $state = $stateText | ConvertFrom-Json
            if ($state.Status -eq 'exited') {
                Invoke-DemoCompose -Arguments @('logs', '--no-color', '--tail', '50', $Service) | Out-Host
                if ($state.ExitCode -ne 0) { throw "$Service failed (exit $($state.ExitCode)). See logs above." }
                return
            }
            if ($state.Status -eq 'dead') { throw "$Service container is dead." }
        }
        Start-Sleep -Seconds 2
    }
    throw "Timeout waiting for $Service after ${TimeoutSeconds}s."
}

function Show-DemoDiagnostics {
    try {
        Invoke-DemoCompose -Arguments @('ps', '-a') | Out-Host
        Invoke-DemoCompose -Arguments @('logs', '--no-color', '--tail', '30', 'migrate', 'demo-bootstrap', 'api', 'postgres') | Out-Host
    } catch { Write-Host "Diagnostics unavailable: $($_.Exception.Message)" }
}
