# Phase A — Distributed Sensor Processing

Ngày thực hiện/kiểm thử: **27/10/2026**, Windows PowerShell 5.1, Docker Engine 29.7.2, Compose v5.4.0, PostgreSQL 17. Đọc và sửa trực tiếp source của commit nền `827e289` trong workspace; trạng thái Git ban đầu sạch.

## 1. Kiến trúc trước và sau

| Thành phần | Trước | Phase A |
| --- | --- | --- |
| MQTT | Ba node subscribe `sensors/+/telemetry`; chỉ LEADER xử lý | Giữ broker/topic/subscribe; cả Leader và Followers đều có thể xử lý sensor được giao |
| Quyền ghi | Kiểm tra role LEADER | Khóa hàng sensor, kiểm tra `assigned_node_id` trong cùng transaction ghi |
| Simulator | Một sensor-1 | Sáu sensor thật, hai sensor mỗi zone |
| Assignment | Metadata hiển thị, chưa quyết định node xử lý | Quyết định trực tiếp node có quyền lưu readings/alerts |
| Chống trùng | Không có định danh mẫu/receipt | Message ID ổn định, receipt PK, unique readings/alerts và payload fingerprint |
| Alert matching | Transaction riêng sau readings | Cùng transaction/connection với receipt và readings; giữ nguyên toán tử/điều kiện matching |
| Bằng chứng xử lý | Log Leader | `processed_by_node_id` trong receipts/readings/alerts và log sau COMMIT |
| Control plane | Bully, heartbeat, Gossip, API assignment monitor | Giữ nguyên Bully/heartbeat/Gossip/monitor và cách chọn SAME_ZONE/minimum-ID fallback |

Không có HTTP forwarding từng message từ Leader. Không triển khai Least-loaded Fallback hoặc chuyển quyền assignment sang Leader ở Phase A.

## 2. Khởi tạo sáu sensor và tránh deadlock

Catalog chung `config/demo-sensors.json` được đóng gói vào image API và simulator:

| Sensor | Zone mặc định | Node mặc định |
| --- | --- | --- |
| sensor-1, sensor-2 | hanoi | edge-1 |
| sensor-3, sensor-4 | danang | edge-2 |
| sensor-5, sensor-6 | hcm | edge-3 |

Bootstrap đăng ký metadata của các thiết bị đã cấu hình **trước** khi chờ readings, đợi cluster hội tụ, dùng cùng assignmentService với API để khởi tạo assignment, rồi mới đợi telemetry thật cho đủ sáu sensor. Không insert readings hoặc alerts mẫu. Nhờ đó không có vòng chờ “chưa có assignment nên không lưu telemetry; chưa có telemetry nên chưa tạo assignment”.

`demo_bootstrap` có marker `phase-a:sensor-N` từng thiết bị. Lần đầu bổ sung sensor/zone còn thiếu; giữ tên, zone và assignment đã có. Chế độ nội bộ `onlyIfUnassigned` cùng khóa hàng bảo vệ assignment do người dùng đã đặt, kể cả khi thay đổi đồng thời lúc bootstrap. Những lần sau không tự đặt lại metadata đã khởi tạo. Nếu marker cũ chứng minh sensor đã cấu hình rồi, giá trị zone/assignment đã bị chủ động xóa cũng được giữ; bootstrap/check báo cần cấu hình rõ ràng thay vì reset.

Assignment monitor hiện có vẫn failover/rebalance theo thiết kế cũ. Giữ metadata trong bootstrap không vô hiệu hóa monitor.

Simulator publish một UUID `messageId` mới cho mỗi mẫu, cùng ID/tên/zone/timestamp/temperature/humidity lên `sensors/{id}/telemetry`. QoS simulator/subscriber giữ nguyên **0**. Chế độ chạy độc lập `SENSOR_ID=1`/`SENSOR_NAME=sensor-1` vẫn hoạt động khi không đặt `SENSORS_FILE`; có thể thêm `SENSOR_ZONE`.

## 3. Transaction, idempotency và handoff

Luồng xử lý một message tại mỗi node:

1. Validate JSON, định danh, độ dài, số hữu hạn, timestamp và topic khớp sensor ID. Payload cũ không có `messageId` được cấp khóa `legacy:SHA256` từ sensor ID, timestamp chuẩn hóa và hai giá trị đo; gửi lại cùng nội dung tạo cùng khóa.
2. `BEGIN`, `SELECT assigned_node_id ... FOR UPDATE`. Sensor chưa đăng ký, chưa gán hoặc gán cho node khác không được ghi dữ liệu.
3. Insert receipt `telemetry_messages` với PK **`(sensor_id,message_id)`**. Nếu khóa đã có: payload giống nhau trả DUPLICATE; payload khác báo lỗi conflict. Không chạy matching lần nữa.
4. Insert đúng hai readings, đọc các rules đang bật và tạo alerts bằng **cùng client/transaction**. Khóa KEY SHARE trên rule tránh rule bị xóa giữa lúc đọc và insert alert.
5. COMMIT toàn bộ rồi mới log `committed ... alerts=N`. Lỗi ở bất cứ bước ghi nào rollback cả receipt/readings/alerts, cho phép retry cùng ID sau đó.

Mọi UPDATE assignment, kể cả API/monitor hoặc SQL trực tiếp, cần khóa cùng hàng sensor. Vì vậy assignment không thể đổi giữa lúc kiểm tra quyền và COMMIT mẫu. Hai thứ tự “assignment đổi trước” và “processing khóa trước” đều được kiểm thử bằng các statement thực sự bị PostgreSQL block; không chỉ kiểm tra một điều kiện `if` ngoài transaction.

Migration 004 thêm receipt, provenance nullable cho lịch sử và các unique indexes:

- `sensor_readings(sensor_id,message_id,metric)` với message ID khác NULL.
- `alerts(sensor_id,message_id,rule_id)` với message ID khác NULL.
- FK tới receipt và node xử lý. Dữ liệu cũ giữ NULL provenance; không gán giả node xử lý cho lịch sử, không xóa readings/alerts/rules.

## 4. File đã sửa/thêm và lý do

| File | Vai trò |
| --- | --- |
| `config/demo-sensors.json` (mới) | Một catalog chung sáu thiết bị/ba zone. |
| `apps/api/sql/004_distributed_telemetry.sql` (mới) | Receipt, provenance, foreign keys, unique/performance indexes. |
| `apps/api/src/migrate.ts` | Chạy thêm 004 theo lịch sử migration hiện có. |
| `apps/api/src/demo-bootstrap.ts` | Đăng ký trước telemetry, marker từng sensor, assignment an toàn và chờ dữ liệu thật. |
| `apps/api/src/services/assignmentService.ts` | Khóa hàng/transaction và tùy chọn nội bộ chỉ khởi tạo assignment còn NULL; thuật toán chọn node giữ nguyên. |
| `apps/api/Dockerfile` | Đóng gói catalog trong runtime image. |
| `apps/edge-node/src/telemetry.ts` (mới) | Type, validation, khóa legacy và fingerprint mẫu. |
| `apps/edge-node/src/mqtt.ts` | Bỏ gate LEADER, gọi transactional processing và log đúng node/kết quả. |
| `apps/edge-node/src/telemetry-store.ts` | Fencing bằng row lock, receipt/dedup và atomic readings/alerts. |
| `apps/edge-node/src/event-matcher.ts` | Nhận transaction client, lưu provenance; giữ matching operators. |
| `apps/edge-node/package.json` | Chạy cả test Gossip và telemetry/integration. |
| `apps/edge-node/test/telemetry.test.ts` (mới) | Validation, legacy ID, fingerprint, matching regression. |
| `apps/edge-node/test/processing.integration.test.ts` (mới) | PostgreSQL thật: quyền ghi, concurrency, constraints, handoff, rollback/retry. |
| `apps/sensor-simulator/src/sensors.ts` (mới) | Load/validate catalog, giữ chế độ một sensor cũ. |
| `apps/sensor-simulator/src/index.ts` | Publish cả sáu sensor với UUID mỗi mẫu. |
| `apps/sensor-simulator/Dockerfile` | Đóng gói catalog. |
| `apps/sensor-simulator/package.json`, `test/sensors.test.ts` (mới) | Test inventory và backward compatibility. |
| `docker-compose.yml`, `.env.example` | Chọn catalog trong simulator và cấu hình các edge URL cho bootstrap dùng assignmentService. Ports/IDs/volume key giữ nguyên. |
| `scripts/demo-check.ps1` | 11 checks cho sáu sensor, tăng mẫu, assignment và provenance/receipt integrity. |
| `scripts/test-phase-a.mjs` (mới) | E2E MQTT trùng, API rule CRUD và snapshot/hash persistence. |
| `scripts/test-dashboard.mjs` (mới) | Kiểm thử trình duyệt thật: sáu chart, tạo/disable rule và chứng minh alerts. |
| `README.md`, `docs/DEMO_SETUP.md` | Cập nhật kiến trúc, bootstrap, nâng cấp và giới hạn Phase A. |
| `docs/PHASE_A_*.txt`, `docs/PHASE_A_DASHBOARD*.png`, báo cáo này (mới) | Output thực tế và ảnh kiểm thử. |

Không sửa `election.ts`, `gossip.ts`, `heartbeat.ts`, application code Dashboard, các controller/route API hoặc thuật toán assignmentMonitor.

## 5. Kiểm thử và output thực tế

Các thử nghiệm ban đầu dùng project/volume **smartedge-phase-a-test** riêng. Stack gốc được dừng để nhường cổng, không reset. Kiểm thử fresh cuối dùng thêm project/volume **smartedge-phase-a-fresh** hoàn toàn mới.

| Phép thử/lệnh | Kết quả |
| --- | --- |
| `npm.cmd run build --workspaces --if-present` | PASS cả bốn ứng dụng. |
| `npm.cmd run typecheck` | PASS. |
| `docker compose -p smartedge-phase-a-test build` | PASS tất cả images. |
| `npm.cmd test --workspace @smartedge/edge-node` với TEST_DATABASE_URL riêng | **16 PASS, 0 FAIL, 0 SKIP**, gồm Gossip cũ và PostgreSQL thật. |
| `npm.cmd test --workspace @smartedge/sensor-simulator` | **2 PASS, 0 FAIL**. |
| `demo-up.ps1 -ProjectName smartedge-phase-a-fresh -NoBuild` | **11 PASS, 0 FAIL**; 001–004 chạy, sáu sensor đúng zone/SAME_ZONE, không cần SQL thủ công. |
| `node scripts/test-phase-a.mjs check` trên stack thử mới | PASS sáu sensor/ba node thực sự xử lý; E2E duplicate MQTT và CRUD rules. |
| `test-gossip.ps1 -ProjectName smartedge-phase-a-test` | PASS bình thường, edge-3 DOWN/edge-2 leader, edge-3 phục hồi; ba mẫu liên tiếp khớp health/API/gossip và owner versions. |
| `node scripts/test-dashboard.mjs` qua Edge headless | PASS sáu sensor, sáu chart, tạo rule qua UI, alerts từ sáu sensor/ba node, disable qua UI, không uncaught browser errors. |
| `demo-up` lặp lại sau đổi sensor-1 thành danang/edge-2 | **11 PASS**, giữ cấu hình đã đổi. |
| `demo-down` rồi `demo-up` | **11 PASS**, volume còn nguyên; hash snapshot khớp. |
| Nâng cấp DB fixture legacy 001–003, không có migration history | PASS dữ liệu lịch sử, custom name/zone/assignment còn nguyên; cả sáu sensor có telemetry sau nâng cấp. |
| Nâng cấp project smartedge gốc | **11 PASS**, hash mọi dữ liệu cũ được đối chiếu và giữ nguyên. |
| Parser PowerShell 5.1 và `git -c core.whitespace=cr-at-eol diff --check` | PASS. Compose giữ CRLF sẵn có. |

### Bằng chứng ba node thực sự xử lý

Query `telemetry_messages` trước các phép thử handoff, từ simulator thật:

```text
sensor_id | processed_by_node_id | samples
1         | 1                    | 168
2         | 1                    | 168
3         | 2                    | 168
4         | 2                    | 168
5         | 3                    | 168
6         | 3                    | 168
```

Lúc này edge-1/edge-2 là FOLLOWER, edge-3 là LEADER. [PHASE_A_MQTT.txt](PHASE_A_MQTT.txt) chứa output JSON từ database.

Gửi **20 lần cùng payload cho từng sensor** qua MQTT (120 publishes) cho kết quả từng mẫu:

```text
sensor 1 -> node 1: 1 receipt, 2 readings, 1 alert cho rule kiểm thử
sensor 2 -> node 1: 1 receipt, 2 readings, 1 alert
sensor 3 -> node 2: 1 receipt, 2 readings, 1 alert
sensor 4 -> node 2: 1 receipt, 2 readings, 1 alert
sensor 5 -> node 3: 1 receipt, 2 readings, 1 alert
sensor 6 -> node 3: 1 receipt, 2 readings, 1 alert
```

Test PostgreSQL còn gửi 20 xử lý đồng thời cùng mẫu: **1 PROCESSED, 19 DUPLICATE**. Insert readings/alerts trùng trực tiếp bị unique constraint từ chối; tái sử dụng ID với payload khác báo conflict. Khóa assignment trước ngăn owner cũ ghi; khóa processing trước buộc UPDATE assignment đợi COMMIT. Chặn insert alerts gây lock timeout và kiểm chứng receipt/readings đều rollback, rồi retry thành công. [PHASE_A_DB_TESTS.txt](PHASE_A_DB_TESTS.txt).

### Rule tạo qua Dashboard

Rule `Phase A Dashboard ed97e8c7`, `temperature > 0`, tạo thành công qua form **New Rule** (HTTP 201). Database xác nhận alerts từ sensor 1–6 với provenance lần lượt 1/1/2/2/3/3. Rule được disable bằng Switch trên UI; rule và alerts giữ lại làm bằng chứng. Đã chọn từng sensor trên giao diện và xác nhận response readings/đường biểu đồ tương ứng. [Output UI](PHASE_A_UI.txt), [ảnh Dashboard](PHASE_A_DASHBOARD.png).

Native Computer Use pipe của máy không hoạt động nên kiểm thử UI dùng Playwright với Microsoft Edge headless. Playwright được cài vào thư mục tạm, không thêm dependency của repo. Các lần đầu test harness có lỗi locator icon/option Ant Design; đã sửa harness và chạy lại thành công. Dashboard application code được giữ nguyên.

### Persistence, metadata và migration cũ

- Restart stack thử giữ hash của **12.122 readings, 12 alerts, 2 rules, 6 sensor records và 6.061 receipts**. Sensor-1 vẫn danang/edge-2 sau startup lặp và restart. [PHASE_A_PERSISTENCE.txt](PHASE_A_PERSISTENCE.txt), [PHASE_A_REPEAT.txt](PHASE_A_REPEAT.txt), [PHASE_A_RESTART.txt](PHASE_A_RESTART.txt).
- Fixture legacy giữ nguyên hai readings có thời gian/giá trị đã biết, một alert lịch sử và rule, `custom-sensor-1:danang:2`, `custom-edge-1:custom-zone`. Sáu sensor nhận dữ liệu mới; sensor-2 dùng FALLBACK vì edge-1 có zone tùy chỉnh, đúng thuật toán ID nhỏ nhất hiện tại. [PHASE_A_LEGACY.txt](PHASE_A_LEGACY.txt).
- Trước nâng cấp project gốc đã tạo `pg_dump` đầy đủ tại **`$env:TEMP\smartedge-before-phase-a.sql`** và snapshot tại `$env:TEMP\smartedge-before-phase-a.json`.
- Sau nâng cấp gốc, **13.560 readings, 1.844 alerts**, toàn bộ rules và metadata node/sensor-1 giữ nguyên hash. Hash readings: `e4525957326460bf585a0b248dcd5b7b`; alerts: `75d36c4e565c589280463f0ee3619fda`. Dữ liệu mới được đối chiếu theo ID tối đa cũ để không nhầm việc tăng telemetry với thay đổi dữ liệu cũ. [PHASE_A_MAIN_PRESERVATION.txt](PHASE_A_MAIN_PRESERVATION.txt).

Lần smoke check mở rộng đầu phát hiện lỗi mảng JSON lồng trong PowerShell 5.1 do test harness mới; đã sửa cách nhận `ConvertFrom-Json`. Không nhận lần đó là PASS. [PHASE_A_FRESH.txt](PHASE_A_FRESH.txt) giữ output lần đầu lỗi; [PHASE_A_FRESH_FINAL.txt](PHASE_A_FRESH_FINAL.txt) là lần fresh trên volume mới sau sửa, **11 PASS/0 FAIL**. [PHASE_A_CHECK.txt](PHASE_A_CHECK.txt) là check độc lập sau sửa.

### Lệnh kiểm thử chính đã chạy

```powershell
npm.cmd run build --workspaces --if-present
npm.cmd run typecheck
docker compose -p smartedge-phase-a-test build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1 -ProjectName smartedge-phase-a-test -NoBuild

# Database riêng trong PostgreSQL của project thử, không dùng DB gốc:
docker compose -p smartedge-phase-a-test exec -T postgres psql -U smartedge -d postgres -c 'CREATE DATABASE phase_a_test_processing;'
$env:TEST_DATABASE_URL='postgresql://smartedge:smartedge@127.0.0.1:5432/phase_a_test_processing'
npm.cmd test --workspace @smartedge/edge-node
npm.cmd test --workspace @smartedge/sensor-simulator

$env:PHASE_A_TESTING='1'
$env:DATABASE_URL='postgresql://smartedge:smartedge@127.0.0.1:5432/smartedge'
node scripts/test-phase-a.mjs check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-gossip.ps1 -ProjectName smartedge-phase-a-test

$env:PLAYWRIGHT_DIR=Join-Path $env:TEMP 'smartedge-phase-a-browser'
npm.cmd install --prefix $env:PLAYWRIGHT_DIR --no-package-lock --no-save playwright
node scripts/test-dashboard.mjs

# Simulator đã dừng và xử lý đang bay đã hoàn tất trước khi chụp snapshot:
node scripts/test-phase-a.mjs snapshot "$env:TEMP\smartedge-phase-a-snapshot.json"
# Sau demo-down / demo-up trên cùng project:
node scripts/test-phase-a.mjs verify "$env:TEMP\smartedge-phase-a-snapshot.json"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1 -ProjectName smartedge-phase-a-fresh -NoBuild
git -c core.whitespace=cr-at-eol diff --check
```

Các lệnh ghi dữ liệu kiểm thử được chạy khi project thử riêng đang giữ cổng. Khi tái kiểm tra, dừng project gốc và dùng project test mới, không chạy các probe ghi trên dữ liệu người dùng. E2E `check` kiểm tra bố trí mặc định; database đã đổi zone có chủ đích cần được kiểm tra theo cấu hình đó. Suite PostgreSQL chủ động SKIP khi không có TEST_DATABASE_URL; kết quả 16 PASS ở trên được chạy có biến này và **không có SKIP**.

## 6. Giới hạn còn lại

- QoS simulator/subscriber vẫn 0: có thể mất mẫu lúc chưa có assignment, node lỗi/handoff hoặc kết nối lỗi. Đây là idempotency cho hiệu ứng PostgreSQL của mẫu nhận được, **không phải exactly-once end-to-end**.
- Hai mẫu legacy có cùng sensor/timestamp/hai giá trị đo không thể phân biệt; publisher mới dùng UUID giải quyết việc định danh rõ ràng.
- Chưa kiểm thử rolling upgrade chạy lẫn writer Leader-only cũ và writer Phase A. Nâng cấp an toàn bằng dừng stack cũ giữ volume trước; không đồng thời chạy writer cũ vốn không có message ID/provenance.
- Mỗi message được broadcast và mỗi node kiểm tra quyền bằng PostgreSQL. Đây là lựa chọn đơn giản cho demo; chưa tối ưu routing/cache, retention receipt hoặc kiểm thử tải lớn.
- Assignment authority/monitor vẫn ở API, fallback vẫn node UP có ID nhỏ nhất. Phase B chưa triển khai.
- Build còn cảnh báo bundle Dashboard lớn và npm audit của dependencies có sẵn; không chặn build/tests, không tự nâng dependency ngoài phạm vi.

## 7. Trạng thái cuối và Phase B

Project **smartedge** đang chạy Phase A trên volume gốc, đủ sáu sensor và cả ba node xử lý thật. Dashboard **http://localhost:8080**, API **http://localhost:4000**. Hai project thử đã dừng, các volume thử và volume gốc được giữ. Không reset, không xóa volume, không commit/push.

Đã đủ điều kiện chuyển sang **Phase B ở phạm vi demo đã kiểm chứng**: có quyền ghi gắn assignment, khóa handoff, idempotency, provenance và regression tests. Khi thay thuật toán chọn fallback ở Phase B cần giữ các transaction/constraints này và chạy lại các test concurrency/Bully/Gossip.

Khởi động/kiểm tra trên Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-check.ps1
```

Không cần Node/npm/PostgreSQL trên host để chạy demo. Node/npm và Playwright chỉ phục vụ các bài kiểm thử phát triển bổ sung.
