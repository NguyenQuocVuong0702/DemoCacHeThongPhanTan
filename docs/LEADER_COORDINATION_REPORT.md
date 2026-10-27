# Leader-Controlled Assignment — báo cáo triển khai

Thực hiện/kiểm thử **27/10/2026**, Windows PowerShell 5.1, Docker Engine 29.7.2, Compose v5.4.0, PostgreSQL 17. Sửa trực tiếp workspace Phase A/B đang chưa commit; không lấy source GitHub để ghi đè. Đã đọc election/heartbeat/Gossip/index, assignment/cluster/API, telemetry transaction/receipt/alerts, migrations/bootstrap/Compose và các test Phase A/B hiện có.

## 1. Trước và sau

| Thành phần | Trước task | Sau task |
| --- | --- | --- |
| Leader Bully | Role trong control plane, xử lý sensor được giao | Còn giành DB lease để quyết định/ghi assignment, failover, recovery |
| Follower | Xử lý telemetry được giao | Giữ nguyên, không được tự điều phối assignment |
| API | Background monitor, manual assign và bootstrap đều gọi service có SQL UPDATE | Không còn monitor; assign/bootstrap chỉ forward đến lease holder |
| Thuật toán | Policy Phase B tại API | Một implementation trong `packages/coordination`, chạy bởi Edge coordinator |
| Chống hai coordinator | Advisory lock tuần tự hóa tải, chưa có quyền Leader/epoch | Lease singleton + process UUID + epoch + row lock + trigger khi ghi và COMMIT |
| Telemetry | MQTT broadcast, owner theo `assigned_node_id`, receipt/readings/alerts chung transaction | Giữ nguyên hoàn toàn |

Các writer cũ là API monitor, endpoint `POST /api/sensors/:id/assign` và bootstrap. Khóa sensor của Phase A bảo vệ bàn giao với telemetry nhưng chưa chứng minh writer là Leader; chỉ thêm `role === LEADER` cũng không chặn được hai node cùng tự nhận Leader hoặc tác vụ cũ tiếp tục sau đổi quyền.

## 2. Quyền điều phối và fencing

Migration `005_assignment_authority.sql` tạo singleton `assignment_authority`: holder node, UUID của **một process**, BIGINT epoch và `lease_until`. Không sửa hàng sensor/readings/alerts sẵn có. TTL production **8 giây**, tick gia hạn **1 giây**, monitor **3 giây**.

- Chỉ node có local role LEADER, leaderId bằng chính nó và không election-in-progress mới thử acquire/renew. `UPDATE ... WHERE` nguyên tử chỉ cấp khi chưa có holder, lease hết hạn, hoặc đúng process hiện tại gia hạn lease còn hiệu lực.
- Cấp mới/kế nhiệm hoặc acquire lại sau hết hạn tăng epoch; renew còn hiệu lực giữ epoch. Release có điều kiện đúng node/process/epoch, tăng epoch để token cũ không dùng lại. Epoch truyền dưới dạng chuỗi, không ép BIGINT vào số JavaScript.
- Getter election generation dùng round vốn có của Bully; không đổi thuật toán bầu cử. Mỗi tác vụ giữ generation và trạng thái lease cục bộ. Kiểm tra lại trước quyết định, từng UPDATE và COMMIT. Mất role/đổi round/lỗi kết nối DB làm tác vụ cũ mất hiệu lực; lease tick trả quyền khi thấy step-down.
- Không có lease hợp lệ: node không tự phân công. API trả 409 để caller thử lại sau hội tụ. Khi tất cả edge dừng, lease cũ hết hạn, API không nhận vai trò coordinator dự phòng.

Transaction assignment:

```text
local Leader/generation guard
  -> BEGIN + transaction-local node/process/epoch
  -> advisory lock 73643103
  -> sensor rows ORDER BY id FOR UPDATE
  -> authority row FOR UPDATE, khớp token và thời gian DB
  -> policy Phase B + UPDATE + audit
  -> kiểm tra lại authority/local generation
  -> COMMIT, deferred trigger kiểm tra lease lần cuối
```

Khóa authority được lấy **sau sensor lock**. Nếu một tác vụ cũ đang chờ telemetry giữ hàng sensor, nó không được giữ authority row để cản Leader mới tiếp quản. Sau khi được đánh thức, tác vụ đó phải kiểm tra epoch mới và rollback. Khi transaction đã giữ authority row, takeover/release phải chờ nó kết thúc; vì vậy một epoch mới không thể được cấp rồi lại có commit assignment từ epoch cũ.

Trigger BEFORE chặn thay đổi assignment không có đúng token (kể cả INSERT có assignment); trigger constraint deferred kiểm tra bằng `clock_timestamp()` khi COMMIT, tránh dùng thời gian `NOW()` cố định đầu transaction. Nếu process bị pause sau kiểm tra JavaScript và lease hết hạn, cả assignment lẫn audit rollback. Row locks được giữ đến hết transaction; đây là cơ sở đồng bộ của thiết kế, xem [PostgreSQL 17: row locks](https://www.postgresql.org/docs/17/explicit-locking.html). Constraint trigger có thể chạy ở cuối transaction theo [tài liệu CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html).

`assignment_events` ghi sensor, owner cũ/mới, coordinator node/process, epoch và lý do. Không có thay đổi assignment thì không sinh audit/no-op UPDATE. Log thay đổi được in sau COMMIT. Role đổi sau khi COMMIT đã được gửi không thể thu hồi ngược một commit đã hoàn thành; DB row lock bảo đảm commit đó phải đứng trước việc cấp epoch mới, không đứng sau.

## 3. Giữ thuật toán và giao diện

Policy giữ nguyên Phase B: ưu tiên node UP cùng zone, chọn ít sensor nhất, hòa chọn ID số nhỏ nhất. Không có cùng zone thì least-loaded trên các node UP. Batch theo ID số sensor, cập nhật projected load ngay mỗi lần chọn. Chỉ chuyển khi owner lỗi hoặc có node UP cùng zone để recovery; không cân lại assignment khỏe liên tục, không sửa zone, giữ NULL chủ động của người dùng.

`POST /api/sensors/:id/assign` giữ response assignment cũ, enum `SAME_ZONE | FALLBACK`. API đọc lease DB, forward đến `/assignments/:sensorId` trên holder kèm `x-assignment-epoch`; không tự tính node đích, không có SQL UPDATE assignment. Follower hoặc request epoch cũ bị edge từ chối. `/assignments/authority` là endpoint chẩn đoán mới, không thêm field vào `/health` hay `/api/cluster`.

Bootstrap đăng ký metadata NULL assignment và **commit trước** khi đợi cluster/forward RPC. Leader cấp assignment với `onlyIfUnassigned`, giữ metadata đã cấu hình. Advisory lock bootstrap khác khóa assignment, nên không giữ sensor transaction trong lúc đợi Leader. Migration hoàn thành trước edge startup như Compose hiện có; không thêm service.

Leader vẫn chạy cùng MQTT subscriber/telemetry-store với Followers, nên edge-3 tự xử lý sensor-5/6 khi được gán. Lease coordinator mất tạm thời không chặn xử lý các assignment hiện hữu của worker còn sống. Không thay receipt, unique indexes, fingerprint, alert matching hay đường MQTT.

## 4. Lỗi phát hiện khi kiểm thử và cách sửa

Lần chạy DB test đầu đạt các assertion nhưng bị đánh FAIL vì sự kiện error bất đồng bộ sau khi cố ý `pg_terminate_backend` chưa được xử lý trên active client. Đã thêm xử lý error cho cả pool idle và active client của coordinator để mất kết nối làm vô hiệu quyền cục bộ thay vì crash. Giữ [LEADER_DB_TESTS_INITIAL.txt](LEADER_DB_TESTS_INITIAL.txt); lần chạy cuối **30 PASS, 0 FAIL, 0 SKIP**.

Lần fault matrix đầu **FAIL** ở dừng edge-3: edge-2 đã LEADER nhưng coordinator không mở được kết nối DB mới, liên tục `Connection terminated due to connection timeout`; telemetry qua kết nối đã có vẫn ghi được. Giữ [LEADER_FAULTS_INITIAL.txt](LEADER_FAULTS_INITIAL.txt) và [LEADER_FAILURE_DIAGNOSTICS.txt](LEADER_FAILURE_DIAGNOSTICS.txt).

Đã dùng TCP stream riêng cho pool PostgreSQL của coordinator, tái sử dụng DNS A/AAAA bất đồng bộ của health probe Phase B. Stream giữ hostname gốc cho cơ chế TLS của pg, hỗ trợ IP/localhost/Unix socket; không chạm heartbeat/election/Gossip transport hoặc pool telemetry. Suy luận nguyên nhân là OS DNS cho các peer Docker dừng làm nghẽn đường lookup dùng chung; chưa có trace đầy đủ để kết luận chi tiết hàng đợi libuv. [Node DNS documentation](https://nodejs.org/api/dns.html#implementation-considerations) mô tả khác biệt giữa lookup qua OS và resolve qua DNS. Bằng chứng sau sửa là cùng fault matrix đạt toàn bộ, kể cả zero-UP rồi chỉ bật edge-2, và test live ngắt DB coordinator đã hồi phục.

## 5. Kết quả Docker thực tế

Output đầy đủ: [LEADER_FAULTS.txt](LEADER_FAULTS.txt). Các cột sensor là owner sau hội tụ; từng pha còn kiểm tra telemetry simulator mới hơn mốc `clock_timestamp()`, không chỉ metadata.

| Pha | s1 | s2 | s3 | s4 | s5 | s6 | Leader/DB authority sau hội tụ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Normal | 1 | 1 | 2 | 2 | 3 | 3 | 3 / epoch 13 |
| Stop edge-3 | 1 | 1 | 2 | 2 | 1 | 2 | 2 / epoch 14 |
| Recover edge-3 | 1 | 1 | 2 | 2 | 3 | 3 | 3 / epoch 16 |
| Stop edge-1 | 2 | 3 | 2 | 2 | 3 | 3 | 3 / epoch 16 |
| Recover edge-1 | 1 | 1 | 2 | 2 | 3 | 3 | 3 / epoch 18 |
| Stop edge-2 | 1 | 1 | 1 | 3 | 3 | 3 | 3 / epoch 18 |
| Recover edge-2 | 1 | 1 | 2 | 2 | 3 | 3 | 3 / epoch 20 |
| Chỉ edge-1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 / epoch 21 |
| Phục hồi cả ba | 1 | 1 | 2 | 2 | 3 | 3 | 3 / epoch 23 |
| Zero-UP | metadata cuối giữ nguyên, không processor | — | — | — | — | — | không lease hợp lệ, API 409 |
| Từ zero-UP chỉ bật edge-2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 / epoch 24 |
| Khôi phục cuối matrix | 1 | 1 | 2 | 2 | 3 | 3 | 3 / epoch 26 |

Epoch có thể tăng dù node ID Leader không đổi: một election/coordinator event mới vô hiệu tác vụ của round trước. Khi một node vừa UP nhưng Bully chưa đổi Leader, holder cũ còn hợp lệ có thể đưa sensor về zone trước khi nhường lease; đây vẫn là quyết định được fencing, không phải follower bypass.

Bằng chứng DB trong [LEADER_SQL.txt](LEADER_SQL.txt):

```text
sensor | from | to | coordinator | epoch | reason
5      | 3    | 1  | 2           | 14    | FAILOVER
6      | 3    | 2  | 2           | 14    | FAILOVER
5      | 1    | 3  | 3           | 16    | RECOVERY_REBALANCE
6      | 2    | 3  | 3           | 16    | RECOVERY_REBALANCE
1      | 1    | 2  | 3           | 16    | FAILOVER
2      | 1    | 3  | 3           | 16    | FAILOVER
```

Khi edge-3 DOWN, receipt simulator mới cho sensor-5 có processor=1, sensor-6 processor=2; recovery có processor=3 cho cả hai. Mỗi pha publish năm bản cùng messageId cho sáu sensor, xác nhận một receipt/hai readings/một alert của rule riêng/đúng processor. Replay qua hai lần bàn giao giữ provenance của receipt gốc, không nhân readings/alerts. Sau matrix kiểm tra toàn ledger không có receipt thiếu metric hoặc readings/alerts lệch processor. Khi ổn định, zone/owner/`xmin` không đổi qua 12 giây. Audit chỉ có một process mỗi epoch, epoch không đi lùi.

### Follower, hai LEADER và tác vụ đang chạy

Test live tạo hai sensor UUID riêng (đã xóa đúng hai metadata test trong cleanup, giữ audit), không sửa sensor người dùng:

- Follower edge-1 gọi `/assignments/...` trả **409**. UPDATE SQL không có quyền trả **42501**.
- Dùng endpoint `/coordinator` hiện có để edge-2 và edge-3 thực sự cùng báo LEADER. DB lease vẫn node-3/epoch-9; node-2 bị từ chối HTTP 409 và SQL 42501. Một assign qua API trong cửa sổ này tạo audit **MANUAL, coordinator=3, epoch=9**.
- Giữ sensor lock, gửi request API tới Leader cũ node-3, xác nhận SQL đang chờ qua `pg_stat_activity`; đổi local Leader, node-2 lấy **epoch 11 trong khi tác vụ cũ còn chờ**. Thả khóa: request cũ trả **409**, SQL dùng token epoch-9 bị từ chối, không có audit node-3 mới; API qua holder mới tạo **MANUAL, coordinator=2, epoch=11**.

Integration test PostgreSQL riêng còn chặn tại audit INSERT sau UPDATE, làm mất local leadership rồi thả khóa: cả sensor và audit rollback. Test khác để lease hết hạn trong transaction đã ghi, COMMIT bị từ chối và không lưu cả hai. Không chỉ dựa vào role.

### Mất kết nối DB

[LEADER_DB_RECOVERY.txt](LEADER_DB_RECOVERY.txt): cố ý terminate hai PostgreSQL backend của `smartedge-coordinator-3`; coordinator mở kết nối mới và phục hồi quyền, API assign sensor-5 trả 200. Sau mốc ngắt kết nối, cả sáu sensor có **hai mẫu mới mỗi sensor**, đúng processor `1,1,2,2,3,3`. Pool telemetry không bị terminate. Test DB riêng còn ngắt connection giữa một assignment đang chờ, xác nhận không có thay đổi/audit dở rồi epoch sau ghi an toàn.

## 6. Lệnh và test suite

```powershell
npm.cmd install --offline --ignore-scripts
$env:ASSIGNMENT_TEST_DATABASE_URL='postgres://smartedge:smartedge@127.0.0.1:5432/phase_b_test_assignments'
npm.cmd test --workspace @smartedge/api
$env:TEST_DATABASE_URL='postgres://smartedge:smartedge@127.0.0.1:5432/phase_a_test_phase_b_regression'
npm.cmd test --workspace @smartedge/edge-node
npm.cmd test --workspace @smartedge/sensor-simulator
npm.cmd run build --workspaces --if-present
npm.cmd run typecheck
docker compose -p smartedge build api edge-1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-leader-coordination.ps1 -ProjectName smartedge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-gossip.ps1 -ProjectName smartedge
$env:LEADER_COORDINATION_TESTING='1'
$env:DATABASE_URL='postgres://smartedge:smartedge@127.0.0.1:5432/smartedge'
node scripts/test-leader-db-recovery.mjs
$env:PHASE_A_TESTING='1'
node scripts/test-phase-a.mjs check
```

Lệnh install offline dùng cache hiện có; máy mới dùng `npm ci`. Hai test database tách khỏi demo; test API tạo schema ngẫu nhiên, chạy 001–005, giữ schema/bằng chứng. Phase B test được chuyển sang gọi shared service với lease thật, không gọi API service có quyền ghi. Phase A processing test giữ fixture 001–004 của nó; các test handoff của Phase B và authority chạy thêm trigger 005.

| Đã chạy | Kết quả | Output |
| --- | --- | --- |
| API policy + Phase B/PostgreSQL + authority/expiry/fencing/disconnect + health | **30 PASS / 0 FAIL / 0 SKIP** | [LEADER_DB_TESTS.txt](LEADER_DB_TESTS.txt) |
| Edge Phase A transaction/idempotency/rollback + Gossip unit | **16 PASS / 0 FAIL / 0 SKIP** | [LEADER_EDGE_TESTS.txt](LEADER_EDGE_TESTS.txt) |
| Simulator catalog/legacy | **2 PASS** | [LEADER_SIMULATOR_TESTS.txt](LEADER_SIMULATOR_TESTS.txt) |
| Workspace build, typecheck, Docker API/Edge build | **exit 0** | [workspace build](LEADER_WORKSPACE_BUILD.txt), [typecheck](LEADER_TYPECHECK.txt), [Docker build](LEADER_BUILD.txt) |
| Live follower/dual leader/in-flight/manual + fault matrix | **PASS sau sửa DNS DB**; lần đầu FAIL giữ riêng | [LEADER_FAULTS.txt](LEADER_FAULTS.txt) |
| Live coordinator DB disconnect/reconnect | **PASS** | [LEADER_DB_RECOVERY.txt](LEADER_DB_RECOVERY.txt) |
| Live Bully/Gossip normal → stop3 → recover3 | **PASS**, ba mẫu liên tiếp khớp mỗi pha | [LEADER_GOSSIP.txt](LEADER_GOSSIP.txt) |
| MQTT Phase A: 20 delivery/mẫu, receipts/alerts + CRUD rule | **PASS** | [LEADER_MQTT.txt](LEADER_MQTT.txt) |
| Dashboard normal/down3/recovered: leader, UP count, sáu placement, chart, no pageerror | **PASS** | [LEADER_UI.txt](LEADER_UI.txt) |
| Fresh bootstrap trên volume riêng | **11 PASS / 0 FAIL**, sáu BOOTSTRAP audit bởi node-3/epoch-1 | [LEADER_FRESH.txt](LEADER_FRESH.txt) |
| Restart volume cũ, startup lặp lại | **11 PASS / 0 FAIL mỗi lần**, snapshot/audit giữ nguyên | [restart](LEADER_RESTART.txt), [repeat](LEADER_REPEAT.txt), [data hashes](LEADER_PERSISTENCE.txt), [audit/epoch](LEADER_AUDIT_PERSISTENCE.txt) |

Gossip test đối chiếu `/gossip/state` từng node sống với `/health` và `/api/cluster`, bao gồm owner `updatedAt`. Không sửa merge/version của Gossip hoặc heartbeat. Dashboard không đổi source, chỉ kiểm thử bằng Playwright/Edge headless dev-only. Ảnh: [normal](LEADER_DASHBOARD_normal.png), [down3](LEADER_DASHBOARD_edge-3-down.png), [recovered](LEADER_DASHBOARD_recovered.png). Các rule probe được disable; không xóa rules có sẵn.

## 7. Bootstrap mới, nâng cấp và restart

Nâng cấp tại chỗ đã PASS: trước/sau migration 005 giữ cùng hash của **30.836 readings, 1.970 alerts, 8 rules, 6 sensors và 8.638 receipts**; [LEADER_UPGRADE_PRESERVATION.txt](LEADER_UPGRADE_PRESERVATION.txt). Dừng writer cũ trước khi nâng cấp, không reset volume.

Đã tạo project **`smartedge-leader-fresh`** với volume mới riêng, trong lúc project chính được `demo-down` không `-v` để nhường cổng. `demo-up -NoBuild` áp dụng 001–005, bootstrap forward sáu request thành công đến node-3/epoch-1 và job kết thúc Exited(0). DB audit có đúng sáu hàng `BOOTSTRAP`, owner `1,1,2,2,3,3`, coordinator đều 3. Có readings thật và demo-check **11 PASS / 0 FAIL**; không deadlock startup. Sau đó dừng project fresh bằng down không `-v` và bật lại project chính. **Cả hai volume đều giữ lại.**

Các lệnh startup đã chạy:

```powershell
# Dừng simulator, chờ drain rồi snapshot trước khi dừng main.
docker compose -p smartedge stop sensor-simulator
Start-Sleep -Seconds 2
$snapshot=Join-Path $env:TEMP 'smartedge-leader-restart.json'
node scripts/test-phase-a.mjs snapshot $snapshot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-down.ps1 -ProjectName smartedge
try {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1 -ProjectName smartedge-leader-fresh -NoBuild
  # SELECT ... FROM assignment_events / assignment_authority trên project fresh
} finally {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-down.ps1 -ProjectName smartedge-leader-fresh
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1 -ProjectName smartedge -NoBuild
}
node scripts/test-phase-a.mjs verify $snapshot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1 -ProjectName smartedge -NoBuild
node scripts/test-phase-a.mjs verify $snapshot
```

Hai lần verify đều exit 0, giữ cùng count/hash dưới đây. So sánh readings/alerts đến ID chốt, receipts đến mốc DB để cho phép simulator sau startup thêm mẫu; rules và sensors được so sánh nguyên hàng, gồm cấu hình đã có. Audit so sánh các ID đã chốt. Không sửa metadata để làm test qua.

| Dữ liệu cũ trước/sau | Count | MD5 giống nhau |
| --- | --- | --- |
| Readings đến ID 34825 | 34754 | `6a63ee3a0d6565420aa3859179968bff` |
| Alerts đến ID 2078 | 2048 | `a8cca35834b7f99fecb988185b55d7c1` |
| Toàn bộ alert rules | 11 | `6061cbf05ebfb543a5b576bdf68c85ff` |
| Toàn bộ sensors/zone/assignment | 6 | `d04010805375ea4ecfdb31f5980d829e` |
| Receipts đến 2026-10-27T11:38:02.624Z | 10597 | `5dedd1034103e521a0bfbe50ef41dd7b` |
| Assignment audit đã có | 42 | `c8992c9cd3da57cdfeb9a791b393a21d` |

Epoch trước restart **32**, sau restart **33**: quyền không bị reset về epoch cũ. Startup lặp lại không đổi các audit cũ. Migration 001–005 được SKIP trên database hiện có; bootstrap báo preserve metadata cho cả sáu sensor. Cả restart và repeated startup đều **11 PASS / 0 FAIL**, gồm kiểm tra local epoch của process node-3 khớp lease DB, không chỉ nhìn node ID holder.

Kết thúc: project `smartedge` chạy, ba node UP, edge-3 LEADER và giữ authority **epoch 33**, local epoch khớp DB; sáu sensor đúng zone, simulator tiếp tục hoạt động. `test-gossip.ps1 -CheckOnly` sau restart có ba mẫu liên tiếp khớp cả ba view, [LEADER_FINAL.txt](LEADER_FINAL.txt) lưu kết quả, JSON authority/assignment và danh sách volume còn nguyên. Không xóa/reset volume, không commit/push.

## 8. File thay đổi riêng task này

| Nhóm | File và mục đích |
| --- | --- |
| Shared package mới | `packages/coordination/{package.json,tsconfig.json,src/*}`: policy Phase B, assignment transaction, lease, cluster/health probe, stream DB và exports |
| Edge | `src/assignment-coordinator.ts` mới; `src/index.ts` khởi động coordinator và endpoints; `src/election.ts` chỉ thêm getter generation; `package.json`, `Dockerfile` đóng gói shared package |
| API | Xóa `src/services/assignmentMonitor.ts`; bỏ startup monitor trong `src/index.ts`; `assignmentService.ts` thành proxy; `assignmentPolicy.ts`/`healthProbe.ts` re-export tương thích test, `clusterService.ts` dùng shared probe |
| Database/bootstrap | `sql/005_assignment_authority.sql` mới; `src/migrate.ts` thêm 005; `src/demo-bootstrap.ts` chuyển assign qua Leader, retry khi chưa có authority |
| Build | API `package.json`/`Dockerfile`, root `package.json`/`package-lock.json`: local workspace dependency, build/predev/pretest/typecheck; không nâng phiên bản dependency ngoài |
| Tests | `apps/api/test/authority.integration.test.ts` mới; `assignment.integration.test.ts` dùng shared engine + token thật |
| Scripts | `test-leader-coordination.ps1`, `test-leader-authority.mjs`, `test-leader-db-recovery.mjs` mới; `test-phase-b.ps1` thêm tùy chọn kiểm tra authority/audit; `demo-check.ps1`/`demo-common.ps1` thêm lease/local epoch vào smoke check vẫn 11 checks; `phase-b-dashboard.mjs` thêm prefix ảnh để không ghi đè bằng chứng cũ |
| Tài liệu | README, DEMO_SETUP, báo cáo này, `LEADER_*.txt` và ảnh bằng chứng |

Các thay đổi Phase A/B đã có trước task vẫn giữ nguyên. Đặc biệt telemetry-store, event-matcher, MQTT, simulator, migrations 001–004, heartbeat và Gossip không bị sửa trong task này, dù một số file đó vẫn xuất hiện trong tổng Git diff chưa commit. Không đổi Docker Compose topology hoặc công nghệ.

## 9. Giới hạn và đánh đổi

- PostgreSQL là nơi phân xử quyền assignment. DB mất kết nối thì dừng quyết định mới; xử lý telemetry cũng cần DB để ghi. Không có Raft/consensus giữa edge và không cam kết exactly-once end-to-end (MQTT subscriber vẫn QoS 0).
- Bully có thể báo hai Leader trong partition; DB chỉ cấp một holder. Node ID cao hơn không cưỡng đoạt một lease còn sống; chờ holder step-down hoặc hết hạn. Failover cần thời gian election, probe và TTL; không cam kết thời gian tối đa chỉ bằng 3 giây monitor.
- Lease dùng đồng hồ PostgreSQL, không dùng đồng hồ client cho quyền ghi. Thay đổi giờ DB đột ngột có thể ảnh hưởng availability, nhưng epoch/row lock vẫn chặn writer cũ sau khi epoch mới được cấp.
- Transaction có lock timeout 5 giây, statement timeout 10 giây, idle-in-transaction timeout 4 giây; coordinator pool còn có connection/query timeout. Tác vụ timeout rollback và monitor thử lại; không giữ DB transaction qua RPC.
- Đếm sensor là tải tương đối; khóa toàn bộ sensor phù hợp demo sáu sensor, chưa tối ưu contention cho quy mô lớn.
- Các process dùng tài khoản DB demo dùng chung, có quyền cao; đây là fencing cho ứng dụng tuân thủ giao thức, không là ranh giới chống process/DB administrator ác ý sửa lease, giả toàn bộ danh tính hoặc vô hiệu trigger. Endpoint control plane hiện có vẫn là prototype local.
- DNS resolver dùng A/AAAA, hỗ trợ IP/localhost/Docker DNS; không đọc alias tùy chỉnh chỉ có trong OS hosts file. TLS PostgreSQL không được kiểm thử trong demo plaintext này.
- Docker build còn in cảnh báo npm audit từ các phiên bản dependency sẵn có và Dashboard bundle lớn; không nâng dependency hoặc xây lại Dashboard ngoài phạm vi task.
