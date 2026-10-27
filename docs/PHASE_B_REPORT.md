# Phase B — Automatic Failover, Least-loaded Assignment & Recovery

Thực hiện và kiểm thử ngày **27/10/2026** trên Windows PowerShell 5.1, Docker Engine 29.7.2, Compose v5.4.0, PostgreSQL 17. Dùng project demo `smartedge` và volume hiện có. Trước khi sửa đã đọc báo cáo Phase A và luồng assignment, bootstrap, cluster health, MQTT, telemetry transaction, receipt, alert matching, Bully/heartbeat/Gossip và Dashboard.

## 1. Kết quả và nguyên nhân cần sửa

Trước Phase B, dừng edge-3 cho kết quả thực tế:

```text
BASELINE cluster: {"leaderId":"2","upNodes":2,"downNodes":1}
sensor-5 -> 1 FALLBACK
sensor-6 -> 1 FALLBACK
```

Output gốc: [PHASE_B_BEFORE.txt](PHASE_B_BEFORE.txt). Fallback chỉ chọn ID nhỏ nhất; monitor gọi assignment từng sensor, chưa có một kế hoạch batch dùng số assignment dự kiến. Do đó hai sensor cùng dồn vào edge-1 mặc dù edge-2 còn cùng mức tải ban đầu.

Sau sửa, cả edge-1 và edge-2 thực sự ghi telemetry mới cho các sensor nhận thêm; phục hồi edge-3 đưa sensor-5/6 về edge-3. Không thay Phase A processing, không chuyển xử lý qua Leader, không thay Bully, heartbeat, Gossip, MQTT, schema hay Dashboard.

Lần chạy fault matrix đầu tiên phát hiện thêm lỗi health probe: sau khi dừng cả ba rồi chỉ bật edge-2, `/api/cluster` vẫn báo cả ba DOWN quá thời hạn 60 giây, mặc dù `/health` edge-2 trả 200, LEADER/2; một tiến trình Node mới trong cùng container API cũng gọi được edge-2. Lần thất bại được giữ trong [PHASE_B_FAULTS_INITIAL.txt](PHASE_B_FAULTS_INITIAL.txt), không tính là PASS.

Đã thay probe `fetch` bằng HTTP request có DNS resolver riêng, deadline toàn bộ request, kết nối mới và kiểm tra đúng nodeId. Suy luận từ hiện tượng và cơ chế Node: các tên Docker đang dừng có thể giữ các yêu cầu OS `getaddrinfo` và gây nghẽn pool dùng chung; chưa có trace chứng minh nguyên nhân DNS cụ thể. [Tài liệu Node về DNS](https://nodejs.org/api/dns.html#implementation-considerations) mô tả `dns.lookup` dùng libuv thread pool còn `dns.resolve*` dùng DNS bất đồng bộ. Bằng chứng kiểm thử sau thay đổi: chính kịch bản zero-UP → chỉ edge-2 đã hội tụ và xử lý đủ sáu sensor trong lần chạy hoàn chỉnh.

## 2. Thuật toán phân công

Tải là **số sensor hiện được gán**, đọc từ PostgreSQL; không dùng CPU hoặc role Leader. Node ứng viên phải có metadata và vừa được health probe xác định UP.

1. Lọc nhóm node UP cùng zone. Nếu có, chọn tải nhỏ nhất trong nhóm: `SAME_ZONE`.
2. Nếu không có cùng zone, chọn tải nhỏ nhất trong toàn bộ node UP: `LEAST_LOADED_FALLBACK`.
3. Hòa tải: chọn ID số nhỏ nhất (`2` trước `10`).
4. Monitor xét sensor theo ID số tăng dần. Khi chuyển, trừ tải owner cũ và cộng tải node được chọn ngay trong kế hoạch, trước lựa chọn tiếp theo. Commit toàn bộ batch trong một transaction.
5. Chỉ tự chuyển khi owner DOWN/mất metadata (`FAILOVER`), hoặc owner khác zone và đã có node UP cùng zone (`RECOVERY_REBALANCE`). Không di chuyển assignment khỏe chỉ để cân lại tải; không UPDATE nếu không có thay đổi.

Khi gọi API assign riêng, bỏ chính sensor đang xét khỏi tải trước khi so sánh, tránh đếm hai lần hoặc thiên lệch do owner hiện tại. API/Dashboard giữ enum công khai `SAME_ZONE | FALLBACK`; log nội bộ nêu `LEAST_LOADED_FALLBACK`, không đổi contract.

Không có node UP: monitor giữ assignment cuối làm metadata phục hồi, log rõ `NO_AVAILABLE_EDGE_NODE`, `processor=NONE`; API assign trả HTTP 409. Không gán sang node DOWN và không biến hàng loạt assignment thành NULL. Assignment NULL do người dùng chủ động xóa tiếp tục được giữ NULL. Zone không được monitor sửa. Assignment khỏe khác zone được giữ khi chưa có node cùng zone UP; chuyển về zone là lý do recovery hợp lệ.

## 3. Transaction và ảnh hưởng tới Phase A

API assign, bootstrap và monitor dùng cùng transaction advisory lock `73643103`, sau đó khóa các hàng sensor theo cùng thứ tự bằng `SELECT ... FOR UPDATE`. Việc đọc tải và cập nhật batch được tuần tự hóa giữa các tiến trình API. Health probe nằm ngoài transaction; `lock_timeout=5s`, `statement_timeout=10s` giới hạn chờ. Log thay đổi chỉ xuất sau COMMIT.

Phase A vẫn khóa chính hàng sensor trước khi kiểm tra owner và ghi receipt/readings/alerts. Vì thế monitor phải chờ mẫu đang xử lý COMMIT; nếu assignment commit trước thì worker cũ đọc lại owner mới và không ghi. Không có sửa đổi trong telemetry-store, receipt fingerprint, unique indexes hay alert matching ở Phase B.

Integration test dùng PostgreSQL thật, chặn transaction xử lý tại bảng alerts để chứng minh monitor thực sự đợi khóa hàng sensor. Sau bàn giao rồi recovery, replay mẫu cũ vẫn chỉ có một receipt, hai readings và một alert của rule kiểm thử. Một test khác cho writer cấu hình zone `lab`/owner hợp lệ trong lúc monitor đang đợi và xác nhận monitor đọc lại cấu hình đã commit, không ghi đè theo bản cũ. Test đồng thời sáu API assign cho kết quả 3/3.

## 4. Phân công đã quan sát trong Docker

Các cột là owner sensor-1 đến sensor-6 **sau hội tụ**. Mỗi bước có ba mẫu cluster/assignment liên tiếp khớp, sau đó chờ telemetry simulator mới theo mốc thời gian DB.

| Kịch bản | s1 | s2 | s3 | s4 | s5 | s6 | Leader |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bình thường | 1 | 1 | 2 | 2 | 3 | 3 | 3 |
| Dừng edge-3 | 1 | 1 | 2 | 2 | 1 | 2 | 2 |
| Phục hồi edge-3 | 1 | 1 | 2 | 2 | 3 | 3 | 3 |
| Dừng edge-1 | 2 | 3 | 2 | 2 | 3 | 3 | 3 |
| Phục hồi edge-1 | 1 | 1 | 2 | 2 | 3 | 3 | 3 |
| Dừng edge-2 | 1 | 1 | 1 | 3 | 3 | 3 | 3 |
| Phục hồi edge-2 | 1 | 1 | 2 | 2 | 3 | 3 | 3 |
| Chỉ edge-1 UP | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| Phục hồi cả ba | 1 | 1 | 2 | 2 | 3 | 3 | 3 |
| Không node UP | metadata cuối giữ nguyên; không có processor | — | — | — | — | — | null |
| Từ zero-UP, chỉ bật edge-2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| Khôi phục cuối cùng | 1 | 1 | 2 | 2 | 3 | 3 | 3 | 3 |

Toàn bộ output: [PHASE_B_FAULTS.txt](PHASE_B_FAULTS.txt). Trường hợp chỉ edge-3 UP cũng có unit test; Docker live đã chạy chỉ edge-1 và chỉ edge-2. Trong zero-UP, số receipt không tăng trong cửa sổ sáu giây sau khi chờ drain; assignment và `xmin` giữ nguyên, POST assign trả 409. Khi cluster ổn định, snapshot zone/owner/`xmin` không đổi qua bốn chu kỳ monitor (12 giây).

## 5. Bằng chứng xử lý thật và chống trùng

Trích log sau COMMIT từ [PHASE_B_API_LOGS.txt](PHASE_B_API_LOGS.txt):

```text
[Assignment][FAILOVER][LEAST_LOADED_FALLBACK] sensor=5 from=3 to=1 projected_load=3
[Assignment][FAILOVER][LEAST_LOADED_FALLBACK] sensor=6 from=3 to=2 projected_load=3
[Assignment][RECOVERY_REBALANCE][SAME_ZONE] sensor=5 from=1 to=3 projected_load=1
[Assignment][RECOVERY_REBALANCE][SAME_ZONE] sensor=6 from=2 to=3 projected_load=2
```

Sau khi xác nhận mapping, script lấy `clock_timestamp()` rồi truy vấn receipt **mới hơn mốc đó**, loại các message probe `phase-b-%`. Output khi edge-3 DOWN cho cả sáu sensor ít nhất một mẫu simulator mới; riêng sensor-5: `owner=1,samples=1`, sensor-6: `owner=2,samples=1`. Sau recovery: `owner=3,samples=1` cho cả hai. Đây là receipt có `processed_by_node_id`, không chỉ metadata `/api/sensors`.

SQL cốt lõi trong script:

```sql
SELECT s.id, s.assigned_node_id AS owner, COUNT(m.message_id) AS samples
FROM sensors s
LEFT JOIN telemetry_messages m
  ON m.sensor_id=s.id AND m.processed_by_node_id=s.assigned_node_id
 AND m.processed_at > :phase_start
 AND m.message_id NOT LIKE 'phase-b-%'
GROUP BY s.id,s.assigned_node_id;
```

Mỗi pha còn publish năm bản cùng messageId cho từng sensor, kiểm tra **1 receipt / 2 readings / 1 alert của rule riêng / đúng processor**. Replay hai mẫu từng xử lý bởi node-3 sau failover vẫn giữ processor=3 và số hàng không đổi. Replay hai mẫu do node-1/2 xử lý sau recovery vẫn giữ processor=1/2, không tạo receipt/alert mới tại node-3.

[PHASE_B_SQL.txt](PHASE_B_SQL.txt) lưu output PostgreSQL sau toàn bộ fault matrix: mẫu probe sensor-5 được xử lý tại 1/2/3 và sensor-6 tại 1/2/3 qua các pha; truy vấn toàn bộ ledger phát hiện receipt thiếu hai metric hoặc readings/alerts sai provenance trả:

```text
 incomplete_or_wrong_provenance
--------------------------------
                              0
```

Các rule kiểm thử có tên/ID riêng được disable khi kết thúc, giữ dữ liệu bằng chứng. Không xóa rule sẵn có. MQTT subscriber QoS 0 vẫn có thể mất message trong gián đoạn: **không bảo đảm exactly-once end-to-end**. Receipt chống ghi trùng các mẫu đã được nhận và commit.

## 6. Lệnh và kết quả kiểm thử

Chạy từ root workspace; hai URL test dưới đây trỏ **database kiểm thử riêng**, không phải database demo `smartedge`. Integration test API tạo schema ngẫu nhiên, áp dụng 001–004, giữ lại schema để xem xét.

```powershell
$env:ASSIGNMENT_TEST_DATABASE_URL='postgres://smartedge:smartedge@127.0.0.1:5432/phase_b_test_assignments'
npm.cmd test --workspace @smartedge/api
$env:TEST_DATABASE_URL='postgres://smartedge:smartedge@127.0.0.1:5432/phase_a_test_phase_b_regression'
npm.cmd test --workspace @smartedge/edge-node
npm.cmd test --workspace @smartedge/sensor-simulator
npm.cmd run build --workspaces --if-present
npm.cmd run typecheck
docker compose -p smartedge build api
docker compose -p smartedge up -d --no-deps api
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-phase-b.ps1 -ProjectName smartedge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-gossip.ps1 -ProjectName smartedge
$env:PHASE_A_TESTING='1'
$env:DATABASE_URL='postgres://smartedge:smartedge@127.0.0.1:5432/smartedge'
node scripts/test-phase-a.mjs check
```

| Kiểm thử đã chạy | Kết quả | Output |
| --- | --- | --- |
| API: policy, PostgreSQL thật, monitor/worker race, concurrency, no-UP, health probe identity/HTTP/JSON/timeout/recovery | 23 PASS, 0 FAIL, 0 SKIP | [PHASE_B_DB_TESTS.txt](PHASE_B_DB_TESTS.txt) |
| Edge: Phase A transaction/idempotency/rollback + Gossip unit | 16 PASS, 0 FAIL, 0 SKIP | [PHASE_B_PHASE_A_REGRESSION.txt](PHASE_B_PHASE_A_REGRESSION.txt) |
| Simulator catalog + legacy single-sensor | 2 PASS, 0 FAIL | [PHASE_B_SIMULATOR_TESTS.txt](PHASE_B_SIMULATOR_TESTS.txt) |
| Workspace build, typecheck, Docker API build | exit 0 | Dashboard giữ cảnh báo bundle lớn vốn có |
| Live fault matrix và provenance | PASS sau sửa health probe; lần đầu FAIL được giữ riêng | [PHASE_B_FAULTS.txt](PHASE_B_FAULTS.txt) |
| Bully/Gossip: normal → stop3/leader2 → recover3/leader3 | PASS, ba mẫu khớp liên tiếp mỗi pha | [PHASE_B_GOSSIP.txt](PHASE_B_GOSSIP.txt) |
| MQTT Phase A regression: 20 delivery/mẫu, CRUD rule, alerts sáu sensor | PASS | [PHASE_B_MQTT_REGRESSION.txt](PHASE_B_MQTT_REGRESSION.txt) |
| Dashboard ba trạng thái, leader/UP count/sáu placement/chart/browser errors | PASS | [PHASE_B_UI.txt](PHASE_B_UI.txt) |
| Restart toàn bộ stack, rồi startup lặp lại | Mỗi lần demo-check 11 PASS / 0 FAIL; hash dữ liệu cũ khớp cả hai lần | [PHASE_B_RESTART.txt](PHASE_B_RESTART.txt), [PHASE_B_REPEAT.txt](PHASE_B_REPEAT.txt), [PHASE_B_PERSISTENCE.txt](PHASE_B_PERSISTENCE.txt) |

Live Gossip đối chiếu `/gossip/state` của mỗi node sống với `/health` và `/api/cluster`, bao gồm role, leaderId và owner `updatedAt`. Khi edge-3 DOWN, Gossip giữ role/leaderId cuối của node đã chết nhưng status phải DOWN; API dùng UNKNOWN cho node không truy cập được. Sau phục hồi, cả ba view khớp FOLLOWER/3, FOLLOWER/3, LEADER/3.

## 7. Dashboard và bằng chứng hình ảnh

Không sửa source Dashboard. Script `scripts/phase-b-dashboard.mjs` dùng Playwright dev-only bên ngoài repo và Edge headless, đọc API rồi assert DOM thật: sáu placement, FALLBACK/SAME_ZONE, leader, node DOWN và biểu đồ sensor-5; không có uncaught browser error. Ảnh đã được mở kiểm tra trực quan.

```powershell
$env:PLAYWRIGHT_DIR=Join-Path $env:TEMP 'smartedge-phase-a-browser'
node scripts/phase-b-dashboard.mjs normal
docker compose -p smartedge stop edge-3
node scripts/phase-b-dashboard.mjs edge-3-down
docker compose -p smartedge up -d --no-deps edge-3
node scripts/phase-b-dashboard.mjs recovered
```

Ảnh: [bình thường](PHASE_B_DASHBOARD_normal.png), [edge-3 dừng](PHASE_B_DASHBOARD_edge-3-down.png), [phục hồi](PHASE_B_DASHBOARD_recovered.png). Playwright là công cụ kiểm thử tùy chọn, không thêm dependency runtime hay lockfile vào ứng dụng. Khi chạy thủ công, dùng `try/finally` để luôn bật lại edge-3 như lần thực thi đã làm.

## 8. Restart và bảo toàn dữ liệu

Tạm dừng simulator, chờ drain rồi lấy count/hash các readings, alerts, rules, sensors/assignments và receipts đã tồn tại. Chạy `demo-down.ps1` (compose down **không có `-v`**), xác nhận volume `smartedge_smartedge-postgres-data` vẫn còn, rồi `demo-up.ps1 -NoBuild`. Sau đó chạy `demo-up.ps1 -NoBuild` thêm lần nữa trên stack đang chạy.

```powershell
$phaseBSnapshot=Join-Path $env:TEMP 'smartedge-phase-b-snapshot.json'
docker compose -p smartedge stop sensor-simulator
Start-Sleep -Seconds 2
node scripts/test-phase-a.mjs snapshot $phaseBSnapshot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-down.ps1 -ProjectName smartedge
docker volume inspect smartedge_smartedge-postgres-data --format '{{.Name}}'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1 -ProjectName smartedge -NoBuild
node scripts/test-phase-a.mjs verify $phaseBSnapshot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1 -ProjectName smartedge -NoBuild
node scripts/test-phase-a.mjs verify $phaseBSnapshot
```

Hai lần verify đều exit 0 và cho cùng snapshot dưới đây. Chỉ so sánh các readings/alerts đến ID chốt, receipts đến mốc thời gian chốt, để simulator sau startup được phép thêm mẫu mới; toàn bộ rules/sensors được so sánh nguyên hàng, không loại cấu hình tùy chỉnh.

| Tập bản ghi cũ | Count | MD5 trước/sau giống nhau |
| --- | --- | --- |
| Readings đến ID 25375 | 25304 | `2ccac59775fcac8c1bdbeefd98e769f5` |
| Alerts đến ID 2000 | 1970 | `90bb67c7d5a81ca8370e7d851b1a44a1` |
| Alert rules, gồm cấu hình đã có | 8 | `16b79febbaeb92e940267c85ec5bb489` |
| Sensors, gồm zone/assignment | 6 | `d04010805375ea4ecfdb31f5980d829e` |
| Receipts đến 2026-10-27T10:57:33.493Z | 5872 | `00beaeb7dad67aad690344d9faa7eea2` |

Output thật trong [PHASE_B_PERSISTENCE.txt](PHASE_B_PERSISTENCE.txt). Cả restart và startup lặp lại đều có `Checks: 11 PASS, 0 FAIL`; migration 001–004 đều SKIP vì đã áp dụng, bootstrap báo `initialization already complete; preserve metadata` cho sáu sensor. Không tạo migration Phase B, không xóa/reset volume, không sửa zone để làm test qua. Integration test còn xác nhận `onlyIfUnassigned` giữ custom owner/zone và monitor giữ assignment NULL do người dùng xóa.

Kết thúc: cả ba node UP, edge-3 LEADER, assignment `1,1,2,2,3,3`, simulator tiếp tục chạy và các stream tiếp tục tăng. Sau restart còn chạy `test-gossip.ps1 -CheckOnly`: cả ba view Gossip, health và API khớp qua ba mẫu liên tiếp, output [PHASE_B_FINAL.txt](PHASE_B_FINAL.txt).

## 9. File thay đổi của riêng Phase B

| File | Thay đổi |
| --- | --- |
| `apps/api/src/services/assignmentPolicy.ts` (mới) | Policy least-loaded, numeric tie/order, projected batch load, recovery/no-UP |
| `apps/api/src/services/assignmentService.ts` | Tải DB hiện tại, transaction/advisory lock/row lock chung cho API và monitor |
| `apps/api/src/services/assignmentMonitor.ts` | Reconcile batch, log sau COMMIT, thông báo unavailable khi đổi trạng thái |
| `apps/api/src/services/healthProbe.ts` (mới) | Probe có DNS resolver riêng, deadline, xác thực nodeId |
| `apps/api/src/services/clusterService.ts` | Gọi probe mới, giữ response contract |
| `apps/api/package.json` | Thêm script test, không thêm dependency |
| `apps/api/test/assignment-policy.test.ts`, `assignment.integration.test.ts`, `health-probe.test.ts` (mới) | Policy, PostgreSQL/race, probe |
| `scripts/test-phase-b.ps1`, `scripts/phase-b-dashboard.mjs` (mới) | Fault injection, telemetry/replay/alerts/zero-UP/no-churn và UI evidence |
| `README.md`, `docs/DEMO_SETUP.md` | Quy tắc assignment mới và cách chạy demo/test |
| `docs/PHASE_B_REPORT.md`, `docs/PHASE_B_*.txt`, `docs/PHASE_B_DASHBOARD_*.png` | Báo cáo và output/ảnh thực tế |

Workspace đã có thay đổi Phase A chưa commit trước task này. Các file MQTT/telemetry/schema 004/simulator/Docker Compose/bootstrap đang xuất hiện trong Git diff thuộc Phase A được giữ nguyên ở Phase B; không quy chúng thành thay đổi mới của Phase B. Không commit/push.

## 10. Giới hạn còn lại

- UP là snapshot health theo thời điểm; node có thể chết ngay sau probe. Monitor thử lại mỗi ba giây, không phải cơ chế consensus/fencing theo epoch.
- Load chỉ đếm sensor; không đo CPU, lưu lượng, backlog. Batch cập nhật đúng dự kiến nhưng không cố tối ưu lại tất cả assignment khỏe liên tục.
- Transaction khóa toàn bộ tập sensor hiện có để nhất quán tải, phù hợp demo sáu sensor; nhiều sensor cần đánh giá contention. Direct SQL insert sensor đồng thời không tham gia advisory lock có thể làm số tải lệch tạm thời; xử lý mỗi sensor vẫn có row lock/owner check.
- Resolver mới dùng DNS A/AAAA, hỗ trợ localhost/IP và hostname Docker; alias chỉ khai trong OS hosts file tùy chỉnh không được `dns.resolve*` đọc. Không thay TLS SNI/verification.
- Không có node UP: Dashboard vẫn hiển thị assignment metadata cuối cùng theo contract cũ; cluster hiển thị toàn bộ DOWN, log nêu processor=NONE và API assign trả 409.
- QoS 0 có thể mất mẫu; không bổ sung replay queue hoặc cam kết exactly-once. Bully/Gossip và cơ chế chống trùng Phase A giữ nguyên.
