# Chạy demo SmartEdge Monitor trên Windows

## Môi trường

- Windows, Windows PowerShell 5.1 (có sẵn) hoặc PowerShell mới hơn.
- Docker Desktop đã cài đặt, đang chạy **Linux containers**, với Docker Compose v2 trở lên (`docker compose version`).
- Internet để tải base images và npm dependencies bên trong Docker lúc build lần đầu.
- Các cổng host còn trống: **5432, 1883, 5001, 5002, 5003, 4000, 8080**.
- Không cần Node.js, npm hoặc PostgreSQL trên host. Đảm bảo Docker có đủ RAM/CPU cho 8 service thường trực; lần build đầu có thể mất vài phút.

## Một lệnh để bắt đầu

Khi nâng cấp, dừng bản cũ bằng `demo-down.ps1` trước (giữ volume), rồi chạy `demo-up.ps1` để tránh chạy lẫn writer cũ và mới. Không cần reset. Migration 004 giữ lịch sử telemetry, migration 005 thêm lease/epoch, audit và trigger bảo vệ assignment; không đổi assignment/readings/alerts đã có.

Tại thư mục repository:

```powershell
.\scripts\demo-up.ps1
```

Nếu execution policy chặn script, chạy riêng phiên này:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1
```

Script dùng vị trí của chính nó để tìm Compose, nên có thể gọi bằng đường dẫn tuyệt đối từ thư mục bất kỳ, kể cả đường dẫn chứa khoảng trắng:

```powershell
& 'D:\Projects\SmartEdge Monitor\scripts\demo-up.ps1'
```

Quy trình: PostgreSQL/MQTT healthy → `migrate` hoàn tất → ba edge nodes healthy → API và simulator → bootstrap demo và dashboard. `migrate` và `demo-bootstrap` có trạng thái **Exited (0)** là bình thường. Nếu một job thất bại, script trả exit code 1 và in log chẩn đoán; API/edge không được khởi động lần đầu khi migrations thất bại. Healthchecks kiểm tra dependency khởi động; `demo-check` xác minh thêm cluster hội tụ và telemetry thực tế.

Lệnh mặc định build images. Dùng `-NoBuild` khi đã build và source không đổi; dùng `-TimeoutSeconds 300` nếu máy chậm. Timeout này áp dụng cho từng bước polling sau Compose, không giới hạn thời gian tải image/build. Compose chờ dependencies theo số lần healthcheck hữu hạn.

## Mở giao diện và kiểm tra

| Thành phần | Địa chỉ |
| --- | --- |
| Dashboard | http://localhost:8080 |
| API | http://localhost:4000 |
| API health / DB | http://localhost:4000/health / http://localhost:4000/health/db |
| Cluster | http://localhost:4000/api/cluster |
| Sensors / assignment | http://localhost:4000/api/sensors |
| Edge health | http://localhost:5001/health, http://localhost:5002/health, http://localhost:5003/health |

```powershell
.\scripts\demo-check.ps1
docker compose ps -a
docker compose logs --tail 50 migrate demo-bootstrap api edge-3
```

`demo-check` in 11 PASS/FAIL cho API, DB, từng edge, cluster ổn định qua 3 mẫu, sáu sensor có readings/assignment hợp lệ, cả sáu luồng mẫu tiếp tục tăng, provenance đúng node và receipt/readings/alerts nhất quán, cùng HTML dashboard. Kết quả thành công trả exit code 0; bất kỳ lỗi nào trả 1. Khi đủ ba node, chỉ edge-3 làm leader và cả ba cùng báo leaderId 3. Đây là smoke check toàn cluster; sẽ FAIL có chủ đích nếu đang demo failover bằng cách dừng một node.

## Dữ liệu và khả năng khởi động lại

- SQL nằm trong image API. Migration runner chạy 001 → 002 → 003 → 004 → 005, dùng advisory lock chống chạy đồng thời, transaction cho từng migration và bảng `schema_migrations` ghi nhận thành công. Mỗi SQL statement có timeout 60 giây, chờ SQL lock tối đa 30 giây. Migration lỗi rollback và không được ghi nhận; lần sau có thể chạy lại. Migration 004 thêm receipt và provenance, 005 thêm lease/fencing và assignment audit, giữ dữ liệu cũ.
- Volume cũ chưa có lịch sử vẫn chạy được: các bước DDL dùng `IF NOT EXISTS`; seed node chỉ bổ sung zone còn NULL, giữ tên/zone đã đặt. Không xóa hoặc chèn trùng sensor, rules, readings hay alerts.
- Phase A đăng ký sáu thiết bị thật được cấu hình trong `config/demo-sensors.json` **trước khi đợi telemetry**, rồi gán bằng assignmentService với khóa sensor và chế độ chỉ gán khi NULL. Simulator và bootstrap dùng cùng catalog; bootstrap không tạo readings/alerts giả.
- Phân bố mặc định: sensor 1–2 hanoi → edge-1, 3–4 danang → edge-2, 5–6 hcm → edge-3, đều SAME_ZONE. Leader và Followers đều xử lý sensor được giao. Xem [báo cáo Phase A](PHASE_A_REPORT.md).
- `demo_bootstrap` giữ marker `phase-a:sensor-N` riêng từng sensor. Lần nâng cấp đầu bổ sung metadata còn thiếu, giữ tên/zone/assignment đã có. Nếu marker sensor-1 cũ đã hoàn tất, bootstrap cũng giữ zone/assignment đã được người dùng chủ động xóa. Những lần sau không tự đặt lại metadata; giá trị NULL chủ động để lại có thể làm smoke check FAIL và cần cấu hình có chủ đích.
- Assignment monitor chạy ở Leader đang giữ DB lease; API không tự phân công. Bootstrap commit metadata trước rồi chuyển yêu cầu tới Leader, không giữ sensor lock khi đợi RPC. Việc giữ metadata của bootstrap không vô hiệu hóa failover/rebalance hợp lệ.

## Phase B: failover, least-loaded và recovery

Monitor tại Leader dùng số sensor đang gán làm tải. Ưu tiên nhóm node UP cùng zone; chọn tải thấp nhất trong nhóm, hòa chọn ID số nhỏ nhất. Khi không có cùng zone, áp dụng cùng quy tắc trên toàn bộ node UP. Batch xử lý sensor theo ID tăng dần và cập nhật tải dự kiến sau mỗi lần chọn. Manual assign qua API cũng được Leader thực hiện bằng cùng implementation, dùng sensor row lock và lease/epoch check.

Với bố trí mặc định, dừng edge-3 đưa sensor-5 sang edge-1, sensor-6 sang edge-2; edge-2 làm Leader và giành lease để điều phối. Khi edge-3 phục hồi, hai sensor quay về edge-3 sau khi quyền điều phối chuyển giao. Một node còn UP có thể tiếp nhận cả sáu sensor. Không có node UP: lease hết hạn, API assign trả 409, không có processor; assignment cuối được giữ để phục hồi tự động. Dashboard/API vẫn dùng strategy `FALLBACK`, log nêu `LEAST_LOADED_FALLBACK`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-phase-b.ps1 -ProjectName smartedge
```

Đây là fault injection có dừng các edge và tạo rule/probe MQTT thật. Script yêu cầu catalog chuẩn sáu sensor, luôn cố khôi phục cả ba node và disable rule do chính nó tạo. Không xóa volume hoặc đổi zone. Kiểm thử với cấu hình tùy chỉnh nên dùng project riêng. Xem [PHASE_B_REPORT.md](PHASE_B_REPORT.md) cho output SQL/log, kiểm thử race và giới hạn.

## Leader điều phối và kiểm thử fencing

Leader Bully chỉ được ghi assignment sau khi giành DB lease (TTL 8 giây, renew mỗi giây). API không chạy monitor; POST assign giữ response cũ nhưng được chuyển đến lease holder, kèm epoch dự kiến. PostgreSQL kiểm tra token/node/process và thời hạn khi UPDATE/COMMIT. `/assignments/authority` trên từng edge cho biết local epoch và lease DB; `assignment_events` ghi coordinator/epoch/lý do mỗi thay đổi.

```powershell
Invoke-RestMethod http://localhost:5003/assignments/authority
docker compose exec -T postgres psql -U smartedge -d smartedge -c "SELECT * FROM assignment_authority; SELECT * FROM assignment_events ORDER BY id DESC LIMIT 12;"
# Fault tests nâng cao cần Node/npm trên host và npm ci tại root repo:
npm.cmd run build --workspace @smartedge/coordination
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-leader-coordination.ps1 -ProjectName smartedge
```

Script tạo tạm hai sensor UUID riêng để kiểm tra API/fencing, rồi chỉ xóa hai sensor đó (audit được giữ). Nó chủ động tạo hai LEADER qua endpoint election hiện có, chuyển quyền giữa một request đang đợi khóa, ngắt các kết nối DB của coordinator để kiểm tra hồi phục, rồi chạy fault matrix Phase B có kiểm tra lease. Chỉ dùng trên demo kiểm thử; không đổi zone hoặc xóa dữ liệu của sensor sẵn có. Cleanup đưa ba node về UP, Leader/authority về edge-3. Xem [báo cáo Leader coordination](LEADER_COORDINATION_REPORT.md).

Nếu muốn hoàn thiện sensor-1 trên database cũ, kiểm tra trước và chỉ tự thực hiện khi muốn thay dữ liệu đó:

```powershell
Invoke-RestMethod http://localhost:4000/api/sensors
# Lệnh sau chủ động đổi zone, chỉ dùng khi đã quyết định thay đổi:
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U smartedge -d smartedge -c "UPDATE sensors SET zone='hanoi' WHERE id='1';"
Invoke-RestMethod -Method Post http://localhost:4000/api/sensors/1/assign
.\scripts\demo-check.ps1
```

## Dừng và reset có kiểm soát

```powershell
.\scripts\demo-down.ps1
.\scripts\demo-up.ps1
```

`demo-down` chỉ chạy Compose down, **giữ volume PostgreSQL**. Khởi động lại không mất readings, rules, alerts hoặc assignment; telemetry tiếp tục tăng. Gọi `demo-up` nhiều lần dùng cùng project, không tạo stack trùng.

Để xóa toàn bộ dữ liệu của project rồi tạo lại demo sạch:

```powershell
.\scripts\demo-reset.ps1
# Đọc tên project và volume được in ra.
# Nhập chính xác RESET <ten-project> theo lời nhắc; nhập khác để hủy.
.\scripts\demo-up.ps1
```

Reset không có cờ bỏ qua xác nhận. Chỉ sau khi nhập đúng, script mới chạy `down --volumes`. Không chạy reset để xử lý lỗi thông thường nếu chưa muốn mất dữ liệu.

## Project thử nghiệm và cấu hình tùy chọn

Không cần `.env`. Có thể sao chép `.env.example` thành `.env` nếu cần:

- `COMPOSE_PROJECT_NAME`: mặc định theo tên thư mục repo (thường là `smartedge`); đổi tên project sẽ dùng volume khác.
- `DEMO_BOOTSTRAP_TIMEOUT_SECONDS`: mặc định 120 giây; timeout bên trong job đợi sensor/cluster mới.
- `DEMO_API_URL` chỉ được đặt nội bộ Compose thành `http://api:4000`, không cần cấu hình trên host.
- Compose đặt `SENSORS_FILE=/app/config/demo-sensors.json` bên trong simulator để phát đủ sáu sensor. Chạy simulator độc lập không đặt biến này vẫn hỗ trợ `SENSOR_ID`, `SENSOR_NAME` cũ; `SENSOR_ZONE` là zone tùy chọn của chế độ một sensor.

Ưu tiên dùng `-ProjectName` để thử trên volume riêng. Dùng **cùng tên** cho mọi script:

```powershell
.\scripts\demo-up.ps1 -ProjectName smartedge-demo-test
.\scripts\demo-check.ps1 -ProjectName smartedge-demo-test
.\scripts\demo-down.ps1 -ProjectName smartedge-demo-test
docker volume inspect smartedge-demo-test_smartedge-postgres-data
```

Project riêng vẫn dùng các cổng demo cố định; hãy dừng stack hiện có trước khi thử rồi khởi động lại sau. Các container không còn `container_name` cố định, nên tên container do Compose sinh; dùng **tên service** qua `docker compose` thay vì tên container cũ. Volume mặc định của project `smartedge` vẫn là `smartedge_smartedge-postgres-data`.

Khi chạy Compose trực tiếp cho project thử, thêm `-p smartedge-demo-test` trước subcommand. Không chạy hai stack đồng thời trên cùng các cổng.

## Xử lý lỗi

| Lỗi | Cách xử lý |
| --- | --- |
| Không tìm thấy Docker / Compose | Cài Docker Desktop và mở lại terminal; kiểm tra `docker version`, `docker compose version`. |
| Cannot connect / daemon unavailable | Mở Docker Desktop, chọn Linux containers và đợi engine sẵn sàng; kiểm tra `docker info`. |
| Port is already allocated | Kiểm tra `docker ps`, `Get-NetTCPConnection -State Listen`; dừng đúng stack hoặc ứng dụng đang chiếm các cổng. Không xóa volume. |
| Migration thất bại | Xem `docker compose logs migrate postgres`. Kiểm tra kết nối/schema; sửa nguyên nhân rồi gọi lại `demo-up`. Không tự chèn bản ghi lịch sử để bỏ qua SQL lỗi. |
| Timeout service / bootstrap | Xem `docker compose ps -a`, `docker compose logs --tail 100 mqtt edge-1 edge-2 edge-3 api sensor-simulator demo-bootstrap`; kiểm tra tài nguyên Docker, telemetry, node metadata và leader. Có thể tăng hai timeout đã nêu khi máy chậm. |
| Database cũ thiếu zone/assignment | Script giữ nguyên dữ liệu và check báo FAIL. Kiểm tra sensor; cập nhật có chủ đích theo ví dụ hoặc chọn reset có xác nhận nếu không cần dữ liệu. |
| Dashboard mở được nhưng API lỗi | Dashboard gọi `http://127.0.0.1:4000` từ browser trên chính máy demo; kiểm tra API/DB health và cổng 4000. |
| Build không tải được dependencies | Kiểm tra mạng/proxy Docker rồi chạy lại; host không cần npm. |

Không commit/push tự động. Đây là demo local dùng thông tin đăng nhập mẫu và MQTT anonymous, giữ nguyên các thuật toán của ứng dụng.
