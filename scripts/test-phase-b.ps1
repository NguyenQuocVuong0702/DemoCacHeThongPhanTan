# Fault injection on a running standard six-sensor demo. Never resets volumes.
[CmdletBinding()]
param([string]$ProjectName = 'smartedge', [ValidateRange(15,300)][int]$TimeoutSeconds = 60, [switch]$CheckLeaderAuthority)
. (Join-Path $PSScriptRoot 'demo-common.ps1')
$script:RuleId = $null
$script:LastProbes = @{}
$script:FaultsStarted = $false
$exitCode = 0
$normal = @{'1'='1';'2'='1';'3'='2';'4'='2';'5'='3';'6'='3'}

function Assert-B {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Get-OwnerSnapshot {
    Get-DemoSql "SELECT json_object_agg(id, json_build_object('zone',zone,'owner',assigned_node_id,'version',xmin::text)) FROM sensors"
}
function Wait-Mapping {
    param([string]$Phase, [string[]]$Up, [string]$Leader, [hashtable]$Expected)
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $stable=0; $last='Not ready'
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        try {
            $cluster=Get-DemoJson '/api/cluster'
            Assert-B (@($cluster.nodes).Count -eq 3) 'Missing cluster nodes'
            Assert-B (@($cluster.nodes | Where-Object {$_.status -eq 'UP'}).Count -eq $Up.Count) 'UP count mismatch'
            Assert-B ($cluster.summary.leaderId -eq $Leader) 'Leader not converged'
            Assert-B (@($cluster.nodes | Where-Object {$_.status -eq 'UP' -and $_.role -eq 'LEADER'}).Count -eq 1) 'Expected one leader'
            foreach ($id in @('1','2','3')) {
                $n=@($cluster.nodes | Where-Object {$_.id -eq $id})
                Assert-B ($n.Count -eq 1) "Missing node $id"
                if ($id -in $Up) {
                    Assert-B ($n[0].status -eq 'UP' -and $n[0].leaderId -eq $Leader) "edge-$id is not converged"
                } else { Assert-B ($n[0].status -eq 'DOWN') "edge-$id should be DOWN" }
            }
            $sensors=@((Get-DemoJson '/api/sensors').sensors)
            foreach ($id in $Expected.Keys) {
                $s=@($sensors | Where-Object {$_.id -eq $id})
                Assert-B ($s.Count -eq 1 -and $s[0].assignedNodeId -eq $Expected[$id]) "sensor-$id owner mismatch"
                Assert-B ($s[0].assignedNodeId -in $Up) "sensor-$id assigned DOWN"
                $node=@($cluster.nodes | Where-Object {$_.id -eq $Expected[$id]})
                $metadata=@((Get-DemoJson '/api/nodes').nodes | Where-Object {$_.id -eq $node[0].id})
                $strategy='FALLBACK'; if($metadata[0].zone -eq $s[0].zone){$strategy='SAME_ZONE'}
                Assert-B ($s[0].assignmentStrategy -eq $strategy) 'API strategy compatibility mismatch'
            }
            $stable++
            if($stable -ge 3){
                if($CheckLeaderAuthority){
                    $lease=Get-DemoSql "SELECT json_build_object('node',holder_node_id,'epoch',epoch::text,'valid',holder_node_id IS NOT NULL AND lease_until>clock_timestamp()) FROM assignment_authority WHERE singleton=true" | ConvertFrom-Json
                    Assert-B ($lease.valid -and $lease.node -eq $Leader) 'Assignment lease has not transferred to the elected leader'
                    Write-Output "[PASS] ${Phase}: DB authority=$($lease.node), epoch=$($lease.epoch)"
                }
                Write-Output "[PASS] ${Phase}: leader=$Leader, 3 matching samples"
                Write-Output (($sensors | Select-Object id,zone,assignedNodeId,assignmentStrategy) | ConvertTo-Json -Compress)
                return
            }
        } catch { $stable=0; $last=$_.Exception.Message }
        Start-Sleep -Seconds 2
    }
    Write-Output ((Get-DemoJson '/api/cluster') | ConvertTo-Json -Depth 6 -Compress)
    Invoke-DemoCompose -Arguments @('ps','-a') | Out-Host
    throw "${Phase}: timeout: $last"
}
function Get-NewProcessing {
    param([string]$Since)
    Get-DemoSql "SELECT json_object_agg(id,json_build_object('owner',owner,'samples',samples)) FROM (SELECT s.id,s.assigned_node_id AS owner,COUNT(m.message_id) AS samples FROM sensors s LEFT JOIN telemetry_messages m ON m.sensor_id=s.id AND m.processed_by_node_id=s.assigned_node_id AND m.processed_at>'$Since' AND m.message_id NOT LIKE 'phase-b-%' WHERE s.id IN ('1','2','3','4','5','6') GROUP BY s.id,s.assigned_node_id) p" | ConvertFrom-Json
}
function Publish-B {
    param($Payload, [int]$Copies=5)
    $json=$Payload | ConvertTo-Json -Compress
    $lines=for($i=0;$i -lt $Copies;$i++){$json}
    $lines | & docker @script:DemoComposeArgs exec -T mqtt mosquitto_pub -t "sensors/$($Payload.sensorId)/telemetry" -l -q 1
    if($LASTEXITCODE -ne 0){throw 'MQTT probe publish failed'}
}
function Get-ProbeProof {
    param($Payload)
    $id=$Payload.messageId
    Get-DemoSql "SELECT json_build_object('receipts',(SELECT COUNT(*) FROM telemetry_messages WHERE message_id='$id'),'processor',(SELECT processed_by_node_id FROM telemetry_messages WHERE message_id='$id'),'readings',(SELECT COUNT(*) FROM sensor_readings WHERE message_id='$id'),'alerts',(SELECT COUNT(*) FROM alerts WHERE message_id='$id' AND rule_id=$script:RuleId))" | ConvertFrom-Json
}
function Assert-Probe {
    param($Payload, [string]$Owner)
    Wait-Demo -Name "receipt $($Payload.messageId)" -TimeoutSeconds $TimeoutSeconds -Test {
        (Get-ProbeProof $Payload).receipts -eq 1
    }
    $proof=Get-ProbeProof $Payload
    Assert-B ($proof.receipts -eq 1 -and $proof.processor -eq $Owner -and $proof.readings -eq 2 -and $proof.alerts -eq 1) 'Duplicate sample, wrong processor or wrong alert count'
    return $proof
}
function Check-Processing {
    param([string]$Phase, [hashtable]$Expected)
    $since=Get-DemoSql 'SELECT clock_timestamp()'
    Wait-Demo -Name "new simulator samples for $Phase" -TimeoutSeconds $TimeoutSeconds -Test {
        $proof=Get-NewProcessing $since
        foreach($id in $Expected.Keys){if($proof.$id.samples -lt 1 -or $proof.$id.owner -ne $Expected[$id]){return $false}}
        return $true
    }
    $proof=Get-NewProcessing $since
    Write-Output "[PASS] ${Phase}: new real simulator receipts by assigned processor: $($proof | ConvertTo-Json -Depth 5 -Compress)"
    $script:LastProbes=@{}
    $run=[guid]::NewGuid().ToString()
    $probeProof=@{}
    foreach($id in @('1','2','3','4','5','6')){
        $payload=@{messageId="phase-b-$run-$id";sensorId=$id;sensorName="sensor-$id";temperature=91;humidity=40;timestamp=(Get-Date).ToUniversalTime().ToString('o')}
        Publish-B $payload
        $probeProof[$id]=Assert-Probe $payload $Expected[$id]
        $script:LastProbes[$id]=@{payload=$payload;owner=$Expected[$id]}
    }
    Write-Output "[PASS] ${Phase}: MQTT retries/alerts: $($probeProof | ConvertTo-Json -Depth 5 -Compress)"
}
function Replay-AfterHandoff {
    param([hashtable]$Previous, [string]$Phase)
    foreach($id in @('5','6')){
        Publish-B $Previous[$id].payload
        $proof=Assert-Probe $Previous[$id].payload $Previous[$id].owner
        Write-Output "[PASS] ${Phase}: replay sensor-$id retains original single receipt: $($proof | ConvertTo-Json -Compress)"
    }
}
function Phase-B {
    param([string]$Name,[string[]]$Up,[string]$Leader,[hashtable]$Expected)
    Wait-Mapping $Name $Up $Leader $Expected
    Check-Processing $Name $Expected
}

try {
    Initialize-Demo -ProjectName $ProjectName
    $sensors=@((Get-DemoJson '/api/sensors').sensors)
    Assert-B ($sensors.Count -eq 6) 'Fault test requires the standard six-sensor demo; use an isolated project for other configurations'
    $catalog=Get-Content -LiteralPath (Join-Path $script:DemoRoot 'config/demo-sensors.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($sensor in $catalog){
        $actual=@($sensors | Where-Object {$_.id -eq $sensor.id})
        Assert-B ($actual.Count -eq 1 -and $actual[0].zone -eq $sensor.zone) 'Custom zones detected; use an isolated project instead of changing them'
    }
    Wait-Mapping 'initial normal' @('1','2','3') '3' $normal
    $rule=@{name="Phase B fault test $([guid]::NewGuid())";metric='temperature';operator='>';threshold=90;severity='INFO';enabled=$true} | ConvertTo-Json
    $created=Invoke-RestMethod -UseBasicParsing -Method Post -Uri http://127.0.0.1:4000/api/alert-rules -ContentType application/json -Body $rule -TimeoutSec 5
    $script:RuleId=[string]$created.id
    Check-Processing 'normal' $normal
    $normalProbes=$script:LastProbes
    $script:FaultsStarted=$true

    Invoke-DemoCompose -Arguments @('stop','edge-3')
    $failed3=@{'1'='1';'2'='1';'3'='2';'4'='2';'5'='1';'6'='2'}
    Phase-B 'edge-3 down' @('1','2') '2' $failed3
    Replay-AfterHandoff $normalProbes 'edge-3 down'
    $failed3Probes=$script:LastProbes
    Invoke-DemoCompose -Arguments @('up','-d','--no-deps','edge-3')
    Phase-B 'edge-3 recovery' @('1','2','3') '3' $normal
    Replay-AfterHandoff $failed3Probes 'edge-3 recovery'

    Invoke-DemoCompose -Arguments @('stop','edge-1')
    Phase-B 'edge-1 down' @('2','3') '3' @{'1'='2';'2'='3';'3'='2';'4'='2';'5'='3';'6'='3'}
    Invoke-DemoCompose -Arguments @('up','-d','--no-deps','edge-1')
    Phase-B 'edge-1 recovery' @('1','2','3') '3' $normal

    Invoke-DemoCompose -Arguments @('stop','edge-2')
    Phase-B 'edge-2 down' @('1','3') '3' @{'1'='1';'2'='1';'3'='1';'4'='3';'5'='3';'6'='3'}
    Invoke-DemoCompose -Arguments @('up','-d','--no-deps','edge-2')
    Phase-B 'edge-2 recovery' @('1','2','3') '3' $normal

    Invoke-DemoCompose -Arguments @('stop','edge-2','edge-3')
    Phase-B 'only edge-1 UP' @('1') '1' @{'1'='1';'2'='1';'3'='1';'4'='1';'5'='1';'6'='1'}
    Invoke-DemoCompose -Arguments @('up','-d','--no-deps','edge-2','edge-3')
    Phase-B 'recover all from one node' @('1','2','3') '3' $normal

    $before=Get-OwnerSnapshot
    Invoke-DemoCompose -Arguments @('stop','edge-1','edge-2','edge-3')
    Wait-Demo -Name 'all nodes DOWN' -TimeoutSeconds $TimeoutSeconds -Test { (Get-DemoJson '/api/cluster').summary.upNodes -eq 0 }
    Start-Sleep -Seconds 2
    $count=Get-DemoSql 'SELECT COUNT(*) FROM telemetry_messages'
    Start-Sleep -Seconds 6
    Assert-B ((Get-DemoSql 'SELECT COUNT(*) FROM telemetry_messages') -eq $count) 'Telemetry committed without a live processor'
    Assert-B ((Get-OwnerSnapshot) -eq $before) 'No-UP state changed recovery metadata'
    $status=0
    try{Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:4000/api/sensors/5/assign -TimeoutSec 5 | Out-Null}catch{if($null -ne $_.Exception.Response){$status=[int]$_.Exception.Response.StatusCode}else{throw}}
    Assert-B ($status -eq 409) 'Assignment without UP nodes must return HTTP 409'
    if($CheckLeaderAuthority){
        Assert-B ((Get-DemoSql "SELECT COUNT(*) FROM assignment_authority WHERE holder_node_id IS NOT NULL AND lease_until>clock_timestamp()") -eq '0') 'Zero-UP still has a valid lease'
    }
    Write-Output '[PASS] zero UP: processor=NONE, no new receipts, metadata retained, POST assign HTTP 409'
    Invoke-DemoCompose -Arguments @('up','-d','--no-deps','edge-2')
    Phase-B 'recover only edge-2 from zero' @('2') '2' @{'1'='2';'2'='2';'3'='2';'4'='2';'5'='2';'6'='2'}
    Invoke-DemoCompose -Arguments @('up','-d','--no-deps','edge-1','edge-3')
    Phase-B 'final recovery' @('1','2','3') '3' $normal
    $before=Get-OwnerSnapshot
    Start-Sleep -Seconds 12
    Assert-B ((Get-OwnerSnapshot) -eq $before) 'Stable cluster churned assignment row versions'
    Write-Output '[PASS] stable cluster: no assignment UPDATE/churn over four monitor intervals'
    $bad=Get-DemoSql "SELECT COUNT(*) FROM (SELECT m.sensor_id,m.message_id FROM telemetry_messages m LEFT JOIN sensor_readings r USING(sensor_id,message_id) GROUP BY m.sensor_id,m.message_id,m.processed_by_node_id HAVING COUNT(r.id)<>2 OR COUNT(DISTINCT r.metric)<>2 OR BOOL_OR(r.processed_by_node_id IS DISTINCT FROM m.processed_by_node_id) UNION ALL SELECT a.sensor_id,a.message_id FROM alerts a JOIN telemetry_messages m USING(sensor_id,message_id) WHERE a.processed_by_node_id IS DISTINCT FROM m.processed_by_node_id) x"
    Assert-B ($bad -eq '0') 'Receipt/readings/alerts integrity failed'
    if($CheckLeaderAuthority){
        $badEpochs=Get-DemoSql "SELECT COUNT(*) FROM (SELECT epoch FROM assignment_events GROUP BY epoch HAVING COUNT(DISTINCT (coordinator_node_id,coordinator_instance_id))<>1 UNION ALL SELECT epoch FROM (SELECT epoch,LAG(epoch) OVER(ORDER BY id) AS previous FROM assignment_events) e WHERE epoch<previous) x"
        Assert-B ($badEpochs -eq '0') 'Audit contains conflicting writers or backwards epochs'
        Write-Output '[PASS] assignment audit: one process per epoch; epochs never go backwards'
    }
    Write-Output '[PASS] complete fault matrix and Phase A receipt/provenance integrity'
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
    $exitCode=1
} finally {
    if($script:FaultsStarted){
        try{
            Invoke-DemoCompose -Arguments @('up','-d','--no-deps','edge-1','edge-2','edge-3')
            Wait-Mapping 'cleanup: normal cluster restored' @('1','2','3') '3' $normal
        }catch{Write-Output "[FAIL] cleanup: $($_.Exception.Message)";$exitCode=1}
    }
    if($null -ne $script:RuleId){
        try{Invoke-RestMethod -UseBasicParsing -Method Patch -Uri "http://127.0.0.1:4000/api/alert-rules/$script:RuleId" -ContentType application/json -Body '{"enabled":false}' -TimeoutSec 5 | Out-Null}catch{Write-Output "[FAIL] disabling test rule: $($_.Exception.Message)";$exitCode=1}
    }
}
exit $exitCode
