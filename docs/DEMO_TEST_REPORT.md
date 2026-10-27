# Báo cáo đóng gói SmartEdge Monitor

Ngày kiểm thử: **27/10/2026**, Windows PowerShell **5.1.26100.9711**, Docker Engine **29.7.2**, Docker Compose **v5.4.0**.

## Vấn đề ban đầu

1. Compose chỉ đợi PostgreSQL nhận kết nối, chưa có bước chạy SQL; edge/API có thể truy vấn khi chưa có schema.
2. Image API chưa chứa SQL; migration runner không có lịch sử, transaction theo file hoặc khóa chống chạy đồng thời.
3. Migration 003 ghi đè tên/zone node và zone sensor mỗi lần chạy; trên DB mới lại không đặt được zone sensor vì telemetry chưa đến.
4. MQTT, edge, API và Dashboard thiếu healthcheck/dependency phù hợp; chưa kiểm tra cluster hội tụ hoặc readings tăng.
5. `container_name` cố định gây xung đột giữa các Compose project; chưa có script quản lý demo Windows.
6. `npm run typecheck` ở root gọi `tsc` mà không có root tsconfig, nên chỉ in trợ giúp và trả exit code 1.
7. README có thay đổi sẵn của người dùng (bỏ mục thư mục `packages/shared`); phần đó được giữ nguyên.

## File tạo mới/chỉnh sửa

| File | Thay đổi |
| --- | --- |
| `docker-compose.yml` | Job migrate/bootstrap, điều kiện health/completion, healthchecks, bỏ tên container cố định; giữ ports, numeric node IDs và volume key cũ. |
| `apps/api/Dockerfile` | Đóng gói SQL vào production image, dùng runner JS đã biên dịch. |
| `apps/api/src/migrate.ts` | Lịch sử migrations, advisory lock, transaction/rollback, timeout SQL và marker database mới. |
| `apps/api/sql/003_seed_edge_locations.sql` | Seed không ghi đè metadata đã đặt; chuyển xử lý sensor sang bootstrap sau telemetry. |
| `apps/api/src/demo-bootstrap.ts` (mới) | Poll cluster/telemetry, bootstrap sensor-1 của DB mới qua API assignment hiện có. |
| `scripts/demo-common.ps1` (mới) | Định vị repo, Docker/Compose checks, polling, SQL/HTTP và chẩn đoán chung. |
| `scripts/demo-up.ps1` (mới) | Build/start, đợi migrations/services/bootstrap, smoke check và in URL. |
| `scripts/demo-check.ps1` (mới) | 10 phép kiểm tra PASS/FAIL, tổng kết và exit code. |
| `scripts/demo-down.ps1` (mới) | Dừng stack, giữ persistent volume. |
| `scripts/demo-reset.ps1` (mới) | Hiện project/volume và chỉ xóa sau khi nhập chính xác `RESET <project>`. |
| `.env.example` (mới) | Cấu hình tùy chọn cho project và bootstrap timeout. |
| `package.json` | Sửa typecheck để chọn đủ các project ứng dụng. |
| `README.md` | Một lệnh khởi động, liên kết tài liệu và mô tả bootstrap hiện tại. |
| `docs/DEMO_SETUP.md` (mới) | Hướng dẫn Windows bằng tiếng Việt và xử lý lỗi. |
| `docs/DEMO_TEST_REPORT.md` (mới) | Báo cáo này. |

Không thay đổi Bully Election, gossip, event matching, thuật toán assignment, API contract hoặc các port. Không commit/push.

## Kiểm thử đã thực hiện

Docker Desktop ban đầu chưa chạy; sau khi khởi động engine, phát hiện stack `smartedge` cũ đang dùng các port demo. Đã tạm dừng đúng 8 container gốc, kiểm thử bằng project/volume riêng rồi khởi động lại chính các container đó. Không migrate hoặc sửa dữ liệu trên volume gốc trong quá trình thử.

| Kiểm thử/lệnh | Kết quả thực tế |
| --- | --- |
| `docker compose config --quiet` | PASS, Compose hợp lệ. |
| `npm.cmd run build --workspaces --if-present` | PASS cho API, Dashboard, edge-node và sensor-simulator. |
| `npm.cmd run typecheck` | Lần đầu phát hiện lỗi cấu hình root có sẵn; sau khi sửa script: PASS. |
| `demo-up.ps1 -ProjectName smartedge-task1-test` | PASS, build đủ images trong Docker bằng `npm ci`; tạo volume mới; migrations 001/002/003 hoàn tất. |
| A — Fresh installation | **10 PASS, 0 FAIL**; sensor thật id 1, zone hanoi, edge-1/SAME_ZONE; edge-3 là leader duy nhất; API/DB/Dashboard hoạt động và readings tăng. |
| C — Gọi lại `demo-up` có build, rồi `demo-up -NoBuild` | Mỗi lần **10 PASS, 0 FAIL**; migrations được skip theo lịch sử; đúng một container/service. |
| Chạy script bằng đường dẫn tuyệt đối từ `C:\Windows\Temp` | PASS, không phụ thuộc thư mục terminal. |
| Đổi sensor-1 trong DB thử sang danang/edge-2, tạo rule `temperature > 0` qua API | Rule sinh alerts thật; các lần startup sau giữ danang/edge-2/SAME_ZONE. |
| B — `demo-down`, rồi `demo-up -NoBuild` | **10 PASS, 0 FAIL**; readings tiếp tục tăng sau restart. |
| Đối chiếu persistence bằng hash SQL | Giữ nguyên 150 readings đầu, 1 rule, 2 alerts đầu, một sensor, zone danang và assignment 2. Sau restart có 292 readings tại mẫu đối chiếu; 3 migrations, không trùng seed. |
| D — `demo-down.ps1 -ProjectName smartedge-task1-test`, `docker volume inspect ...` | PASS; containers/network được dọn, volume vẫn tồn tại. |
| Nhập `CANCEL` vào `demo-reset.ps1` | PASS; không xóa volume hoặc dữ liệu. |
| Legacy DB không có migration history | PASS trong database `smartedge_legacy_test` thuộc volume thử: chạy đủ 3 migrations, giữ `custom-edge:custom-zone` và sensor danang/2; có 3 nodes, 1 sensor, không có marker bootstrap. |
| Legacy DB với sensor zone/assignment NULL, chạy migrate/bootstrap lần nữa | PASS; NULL được giữ nguyên, không tự tạo assignment. |
| SQL cố ý lỗi trên project `smartedge-task1-failure` | PASS cho nhánh lỗi: Compose/migrate trả exit 1; API và cả ba edge ở trạng thái Created, chưa chạy; bảng probe rollback, lịch sử migrations có 0 dòng. |
| Bỏ SQL lỗi, chạy lại migrate trên cùng failure volume | PASS; 3 migrations, 3 nodes, 0 sensors, marker fresh bootstrap vẫn pending. Xác minh seed chạy trước khi sensor tồn tại. |
| Build lại API cuối cùng và `demo-up -NoBuild` | **10 PASS, 0 FAIL** với image cuối cùng, có giới hạn chờ SQL lock. |
| Trỏ `DOCKER_HOST` tạm thời tới named pipe không tồn tại | PASS cho nhánh lỗi: `demo-up` in lỗi Docker daemon rõ ràng, trả exit 1. Không thay đổi cấu hình Docker lưu trên máy. |
| Parser PowerShell 5.1 cho cả 5 script | PASS, 0 lỗi cú pháp. |
| Gọi helper polling với test luôn lỗi và timeout 1 giây | PASS, trả lỗi timeout kèm lỗi gần nhất. |
| `git -c core.whitespace=cr-at-eol diff --check` | PASS; giữ CRLF sẵn có của Compose. |

Các lệnh lifecycle được chạy bằng `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...` do execution policy của máy chặn script mặc định. Hướng dẫn có lệnh tương ứng; không đổi execution policy toàn máy.

Đối chiếu persistence dùng `md5(string_agg(row_to_json(row)::text, '' ORDER BY id))`, giới hạn readings/alerts theo ID tối đa đã chụp trước restart. Như vậy kiểm tra dữ liệu cũ còn nguyên trong khi dữ liệu mới tiếp tục tăng, thay vì chỉ so sánh tổng dòng.

Nhánh migration lỗi dùng override Compose tạm thời: bỏ host port của PostgreSQL/MQTT và bind SQL 001 thành `CREATE TABLE migration_failure_probe (id integer); SELECT intentional_migration_failure();`. Sau khi kiểm tra rollback/gating, bỏ bind lỗi và chạy lại migration. Chỉ áp dụng trên project failure riêng.

## Trạng thái sau kiểm thử và giới hạn

- Đã khôi phục 8 container gốc của project `smartedge`; `/health` trả `ok`. Mẫu DB sau khôi phục: **1 sensor, 7.562 readings, 3 rules, 1.166 alerts**, so với mẫu trước tạm dừng là 1/7.542/3/1.163. Telemetry tiếp tục hoạt động; volume gốc không bị xóa.
- Hai project thử đã được dừng. Hai volume `smartedge-task1-test_smartedge-postgres-data` và `smartedge-task1-failure_smartedge-postgres-data` được giữ lại. Có thể xóa sau bằng `demo-reset.ps1 -ProjectName <tên>` và nhập xác nhận khi muốn.
- Stack gốc được khôi phục bằng các container cũ; chạy `demo-up.ps1` để triển khai cấu hình đóng gói mới vào project chính. Images mới đã được build và kiểm chứng trên project thử.
- Chưa thực hiện nhánh xác nhận xóa volume của reset để tránh xóa persistent data trong kiểm thử thông thường; đã kiểm tra thực tế nhánh hủy.
- Build còn cảnh báo bundle Dashboard lớn hơn 500 kB và dependency audit từ `npm ci`; không chặn build hoặc smoke test. Chưa thay dependencies ngoài phạm vi đóng gói.
- Database cũ thiếu zone/assignment sẽ được giữ nguyên và smoke check báo FAIL để người dùng xử lý có chủ đích. Monitor assignment hiện có vẫn có thể failover/rebalance theo thiết kế ứng dụng.

## Lệnh chạy trên Windows

Mở Docker Desktop, đợi Linux engine sẵn sàng. Tại root repo:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\demo-up.ps1
```

Mở **http://localhost:8080**. API tại **http://localhost:4000**. Nếu execution policy cho phép, có thể dùng trực tiếp `.\scripts\demo-up.ps1`.

```powershell
.\scripts\demo-check.ps1
.\scripts\demo-down.ps1
# Chỉ nếu chủ động muốn xóa dữ liệu và tạo demo sạch:
.\scripts\demo-reset.ps1
.\scripts\demo-up.ps1
```

Chi tiết môi trường, project riêng, timeout và xử lý lỗi: [DEMO_SETUP.md](DEMO_SETUP.md).
