# Chạy demo SmartEdge Monitor trên Windows

## Môi trường

- Windows, Windows PowerShell 5.1 (có sẵn) hoặc PowerShell mới hơn.
- Docker Desktop đã cài đặt, đang chạy **Linux containers**, với Docker Compose v2 trở lên (`docker compose version`).
- Internet để tải base images và npm dependencies bên trong Docker lúc build lần đầu.
- Các cổng host còn trống: **5432, 1883, 5001, 5002, 5003, 4000, 8080**.
- Không cần Node.js, npm hoặc PostgreSQL trên host. Đảm bảo Docker có đủ RAM/CPU cho 8 service thường trực; lần build đầu có thể mất vài phút.

## Một lệnh để bắt đầu

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

`demo-check` in PASS/FAIL cho API, DB, từng edge, cluster ổn định qua 3 mẫu, sensor thật, tổng readings tăng, zone/assignment hợp lệ và HTML dashboard. Kết quả thành công trả exit code 0; bất kỳ lỗi nào trả 1. Khi đủ ba node, chỉ edge-3 làm leader và cả ba cùng báo leaderId 3. Đây là smoke check toàn cluster; sẽ FAIL có chủ đích nếu đang demo failover bằng cách dừng một node.

## Dữ liệu và khả năng khởi động lại

- SQL nằm trong image API. Migration runner chạy 001 → 002 → 003, dùng advisory lock chống chạy đồng thời, transaction cho từng migration và bảng `schema_migrations` ghi nhận thành công. Mỗi SQL statement có timeout 60 giây, chờ SQL lock tối đa 30 giây. Migration lỗi rollback và không được ghi nhận; lần sau có thể chạy lại.
- Volume cũ chưa có lịch sử vẫn chạy được: các bước DDL dùng `IF NOT EXISTS`; seed node chỉ bổ sung zone còn NULL, giữ tên/zone đã đặt. Không xóa hoặc chèn trùng sensor, rules, readings hay alerts.
- Chỉ database **không có bảng public nào trước lần migrate đầu tiên** được đánh dấu trong `demo_bootstrap` để chuẩn bị demo. Marker bền vững giúp tiếp tục nếu startup đầu bị gián đoạn.
- Với database mới, bootstrap đợi simulator gửi telemetry tạo sensor id `1`, đợi cluster ổn định, đặt `hanoi` nếu zone/assignment chưa được đặt, rồi gọi **POST /api/sensors/1/assign**. Kết quả mặc định: **edge-1 / SAME_ZONE**. Không chèn sensor giả, không tạo alert rule mẫu tự động.
- Database có sẵn hoặc bootstrap đã hoàn tất sẽ không bị script đặt lại zone/assignment. Nếu dữ liệu cũ thiếu zone/assignment, smoke check báo FAIL để bạn xử lý có chủ đích. Không tự reset để làm check xanh.
- Assignment monitor hiện có vẫn thực hiện failover/rebalance theo thiết kế ứng dụng. Việc giữ metadata của bootstrap không vô hiệu hóa monitor này.

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
