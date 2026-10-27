# SmartEdge Monitor

SmartEdge Monitor là nền tảng mô phỏng hệ thống IoT/Edge phân tán, tập trung vào coordination, leader election, fault tolerance, gossip, event matching và location-aware edge assignment. Đây là prototype phục vụ học tập và demo trên máy local.

**Chạy demo trên Windows:** mở Docker Desktop (Linux containers), sau đó chạy `.\scripts\demo-up.ps1`. Không cần cài Node.js/npm/PostgreSQL trên host. Xem [hướng dẫn demo đầy đủ](docs/DEMO_SETUP.md).

## Mục lục

- [1. Tổng quan](#1-tổng-quan)
- [2. Các chức năng chính](#2-các-chức-năng-chính)
- [3. Mapping với Distributed Systems Chapter 5](#3-mapping-với-distributed-systems-chapter-5)
- [4. Kiến trúc hệ thống](#4-kiến-trúc-hệ-thống)
- [5. Luồng dữ liệu](#5-luồng-dữ-liệu)
- [6. Leader Election & Failover](#6-leader-election--failover)
- [7. Gossip](#7-gossip)
- [8. Event Matching](#8-event-matching)
- [9. Location-aware Edge Assignment](#9-location-aware-edge-assignment)
- [10. Công nghệ](#10-công-nghệ)
- [11. Cấu trúc repo](#11-cấu-trúc-repo)
- [12. Cách chạy](#12-cách-chạy)
- [13. Demo nhanh](#13-demo-nhanh)
- [14. Các endpoint quan trọng](#14-các-endpoint-quan-trọng)
- [15. Giới hạn hiện tại](#15-giới-hạn-hiện-tại)
- [16. Hướng phát triển](#16-hướng-phát-triển)

## 1. Tổng quan

Ba edge node cùng hoạt động, bầu leader bằng Bully Election và chia sẻ trạng thái qua heartbeat/gossip. Telemetry được xử lý phân tán: node đang được gán cho sensor tự lưu readings và đối chiếu alert rules, kể cả khi là Follower. Leader giữ lease/epoch trong PostgreSQL để quyết định và ghi assignment, failover và recovery rebalance. API phục vụ REST/Dashboard và chuyển yêu cầu assign tới Leader có thẩm quyền. Xem [Phase A](docs/PHASE_A_REPORT.md), [Phase B](docs/PHASE_B_REPORT.md) và [Leader coordination](docs/LEADER_COORDINATION_REPORT.md).

## 2. Các chức năng chính

- Cluster gồm ba edge node với heartbeat mỗi 2 giây, Bully Leader Election, startup election, automatic failover và recovery takeover khi node ID cao khởi động lại.
- Gossip mỗi 3 giây để chia sẻ cluster knowledge trong memory; API tổng hợp trạng thái thực tế của ba node qua health check.
- Sáu sensor phát nhiệt độ/độ ẩm qua MQTT: 1–2 hanoi, 3–4 danang, 5–6 hcm. Cả ba node subscribe; chỉ node được assignment cho sensor mới được ghi dữ liệu.
- Node xử lý đọc alert rules đang bật, so khớp điều kiện và tạo alert trong cùng transaction với readings. Message ID, ràng buộc unique và khóa hàng sensor chống ghi trùng và tuần tự hóa việc xử lý với handoff. Alert rules có CRUD qua REST API và dashboard, không cần restart edge node.
- API cung cấp sensors, readings, alerts, alert rules, nodes và cluster status. Dashboard React hiển thị summary, biểu đồ, cluster topology, edge placement và bảng cảnh báo.
- Dashboard polling cluster mỗi 2 giây; sensors, readings và alerts mỗi 3 giây. Alert rules được tải lúc mở trang và làm mới sau thao tác CRUD.
- Assignment ưu tiên node UP cùng zone, chọn ít sensor nhất trong nhóm; nếu không có cùng zone thì LEAST_LOADED_FALLBACK trên các node UP. Hòa tải chọn numeric ID nhỏ nhất. Monitor cập nhật tải dự kiến sau mỗi sensor, failover khi owner DOWN và recovery rebalance về zone; không di chuyển liên tục chỉ vì tải thay đổi.
- Chỉ Leader có PostgreSQL lease hợp lệ được điều phối. Epoch tăng qua mỗi lần chuyển quyền; khóa hàng và trigger kiểm tra fencing token khi UPDATE/COMMIT. API không chạy background assignment monitor.
- Docker Compose cấu hình PostgreSQL, Mosquitto, ba edge node, API, sensor simulator và dashboard Nginx.

## 3. Mapping với Distributed Systems Chapter 5

| Nội dung | SmartEdge implementation |
| --- | --- |
| 5.4 Election Algorithms | Bully Leader Election theo numeric node ID; bầu lúc startup, khi leader down và khi node ID cao khởi động lại. |
| 5.5 Gossip-based Coordination | Mỗi edge node trao đổi cluster knowledge với một peer ngẫu nhiên và merge record mới hơn theo updatedAt. |
| 5.6 Distributed Event Matching | Mỗi node xử lý sensor được giao, so telemetry với alert_rules đang bật và ghi alerts khi rule match. |
| 5.7 Location Systems | Leader chọn theo zone và số sensor được gán, fallback least-loaded, tự failover và recovery rebalance với DB lease/epoch. |

## 4. Kiến trúc hệ thống

~~~mermaid
flowchart LR
    S["Sensor Simulator<br/>6 sensors / 3 zones"] --> M["MQTT Broker<br/>Mosquitto"]
    M --> E
    subgraph C["Edge Cluster: edge-1 / edge-2 / edge-3"]
        E["Heartbeat · Bully Election · Gossip<br/>Mỗi node xử lý sensor được giao"]
    end
    E -->|"Khóa assignment + receipt + readings + alerts"| P[("PostgreSQL")]
    P --> A["Express API<br/>REST + assignment proxy"]
    A --> D["React Dashboard"]
    A -. "GET /health" .-> E
    A -->|"Rule CRUD"| P
    A -->|"Yêu cầu assign tới lease holder"| E
    E -->|"Leader: lease + epoch + assignment"| P
~~~

Assignment được quyết định và lưu bởi Leader đang giữ DB lease. MQTT vẫn đến mọi node đã subscribe; node được gán xử lý trực tiếp, không cần Leader chuyển tiếp telemetry HTTP. PostgreSQL lưu `processed_by_node_id` để kiểm chứng processor, `assignment_events` để kiểm chứng coordinator và epoch.

## 5. Luồng dữ liệu

1. Bootstrap đăng ký metadata sáu thiết bị từ `config/demo-sensors.json`, giữ cấu hình đã có và khởi tạo assignment trước khi đợi readings.
2. Simulator publish mỗi mẫu có UUID lên sensors/{id}/telemetry (QoS 0). Edge nodes giữ subscribe sensors/+/telemetry.
3. Mỗi node validate payload, khóa hàng sensor và kiểm tra assignment trong transaction. Chỉ owner hiện tại mới insert receipt `(sensor_id,message_id)`, hai readings và alerts; tất cả commit hoặc rollback cùng nhau. Retry trùng ID không tạo thêm readings/alerts.
4. API đọc PostgreSQL và health của edge nodes. Dashboard gọi API để hiển thị và tự polling dữ liệu.

## 6. Leader Election & Failover

Các node có ID số: edge-1 = 1, edge-2 = 2, edge-3 = 3. Bully Election chỉ gửi ELECTION tới peer có ID lớn hơn; node có ID cao nhất còn hoạt động sẽ trở thành leader và gửi COORDINATOR cho peers.

| Tình huống | Kết quả mong đợi |
| --- | --- |
| Cả ba node UP | edge-3 là LEADER. |
| edge-3 dừng | Heartbeat phát hiện leader DOWN; edge-2 trở thành LEADER. |
| edge-3 khởi động lại | Startup election giúp edge-3 giành lại vai trò LEADER. |

Election cũng có endpoint kích hoạt thủ công để demo. Việc bầu leader và phát hiện lỗi có độ trễ ngắn theo heartbeat, timeout và startup delay.

Vai trò LEADER là điều kiện cần; node còn phải giành lease độc quyền trong PostgreSQL (TTL 8 giây, renew mỗi giây). Leader cũ dừng quyết định khi đổi election generation; Leader mới đợi lease cũ được trả hoặc hết hạn. Mọi transaction assignment kiểm tra node/process/epoch và thời hạn; trigger deferred kiểm tra lại khi COMMIT. Đây là fencing cho assignment, không biến Bully thành consensus.

## 7. Gossip

Mỗi edge node giữ cluster knowledge trong một Map in-memory, gồm status, role, leaderId và updatedAt. Cứ 3 giây, node gửi knowledge cho một peer ngẫu nhiên; khi nhận, record mới hơn theo updatedAt sẽ ghi đè record cũ. Gossip chỉ chia sẻ góc nhìn về cluster; quyết định leader vẫn do Bully Election.

## 8. Event Matching

Ví dụ có thể tạo hai rule:

~~~text
temperature > 32
humidity > 75
~~~

Khi telemetry thỏa rule đang enabled, node được gán tạo alert với sensor, rule, metric, value, thời gian và node xử lý. Rule có thể tạo, sửa, bật/tắt hoặc xóa trên dashboard hoặc qua API. Database hiện dùng ON DELETE CASCADE: xóa rule cũng xóa các alerts liên quan.

## 9. Location-aware Edge Assignment

Migration seed metadata cho edge-1 → hanoi, edge-2 → danang, edge-3 → hcm. Sensor-1 dùng zone hanoi trong kịch bản demo.

| Trạng thái | Assignment của sensor-1 |
| --- | --- |
| edge-1 UP | edge-1, strategy SAME_ZONE |
| edge-1 DOWN; edge-2 và edge-3 UP với tải ban đầu bằng nhau | sensor-1 → edge-2, sensor-2 → edge-3; strategy FALLBACK (least-loaded, hòa chọn ID nhỏ) |
| edge-1 UP trở lại | edge-1, strategy SAME_ZONE sau recovery rebalance |

Bootstrap đăng ký metadata trước telemetry, commit rồi chuyển yêu cầu gán lần đầu qua API proxy tới Leader với chế độ chỉ gán khi NULL. Monitor tại Leader theo dõi sensor đã gán mỗi 3 giây; Followers không chạy quyết định. Một implementation trong `packages/coordination` phục vụ cả manual assign và monitor. Zone/assignment hợp lệ đã cấu hình được giữ nguyên; MQTT vẫn broadcast tới mọi subscriber.

Phase B xử lý batch sensor theo ID tăng dần, dùng tải dự kiến cập nhật ngay sau từng lựa chọn trong transaction. API/Dashboard giữ nhãn `FALLBACK`; log ghi rõ `LEAST_LOADED_FALLBACK`. Khi không có Leader/lease hợp lệ, thay đổi assignment tạm dừng và API assign trả HTTP 409. Khi zero-UP, lease hết hạn, không có processor và assignment cuối được giữ để phục hồi; metadata này không có nghĩa node DOWN đang xử lý.

## 10. Công nghệ

- TypeScript, Node.js, Express và package pg.
- React, Vite, Ant Design, Axios và Recharts.
- MQTT với Eclipse Mosquitto; PostgreSQL lưu sensors, readings, rules, alerts và node metadata.
- Docker, Docker Compose và Nginx để build/serve dashboard.

## 11. Cấu trúc repo

~~~text
apps/
  api/                 REST API, assignment proxy, migrations SQL
  dashboard/           React UI, Vite, Nginx config
  edge-node/           heartbeat, election, gossip, Leader coordinator, MQTT, event matching
  sensor-simulator/    virtual sensor MQTT
packages/
  coordination/        policy Phase B, DB lease/fencing, assignment transaction
docker/
  mosquitto.conf
docker-compose.yml
scripts/                khởi động, kiểm tra, dừng và reset demo Windows
docs/DEMO_SETUP.md       hướng dẫn demo và xử lý sự cố
package.json            npm workspaces: apps/* và packages/*
~~~

## 12. Cách chạy

Yêu cầu Windows PowerShell 5.1, Docker Desktop đang chạy Linux containers và Docker Compose v2 trở lên. Không cần cài Node.js, npm hoặc PostgreSQL trên host. Tại root repo:

~~~powershell
.\scripts\demo-up.ps1
~~~

Script tự build images, chạy migrations 001–005, đợi dependencies/cluster và DB authority, chuẩn bị metadata rồi yêu cầu Leader gán sáu sensor và kiểm tra dữ liệu thật. Migrations có lịch sử trong `schema_migrations`; chạy lại giữ dữ liệu. Các service dùng thông tin đăng nhập mẫu cho demo local.

Xem [docs/DEMO_SETUP.md](docs/DEMO_SETUP.md) để xử lý lỗi, dùng project riêng hoặc reset có xác nhận.

| Thành phần | Địa chỉ trên máy host |
| --- | --- |
| Dashboard | http://localhost:8080 |
| API | http://localhost:4000 |
| API health / DB health | http://localhost:4000/health và http://localhost:4000/health/db |
| Edge node health | http://localhost:5001/health, http://localhost:5002/health, http://localhost:5003/health |

Dashboard gọi API tại http://127.0.0.1:4000 từ browser trên máy host.

Kiểm tra, dừng hoặc tạo lại demo sạch:

~~~powershell
.\scripts\demo-check.ps1
.\scripts\demo-down.ps1
# Chỉ khi muốn xóa dữ liệu; script yêu cầu nhập xác nhận theo tên project:
.\scripts\demo-reset.ps1
.\scripts\demo-up.ps1
~~~

`demo-down.ps1` giữ PostgreSQL volume. `demo-reset.ps1` chỉ xóa volume sau khi xác nhận rõ ràng. Có thể gọi script bằng đường dẫn tuyệt đối từ terminal ở thư mục bất kỳ.

## 13. Demo nhanh

Trước demo, kiểm tra GET /api/cluster có ba node UP; chuẩn bị sensor-1 zone hanoi và đã assign vào edge-1 theo mục 12.

**Scenario 1 — Leader failure**

~~~sh
docker compose stop edge-3
~~~

Sau vài giây, edge-3 hiện DOWN, edge-2 trở thành LEADER; sensor-5 → edge-1 và sensor-6 → edge-2 với tải demo ban đầu bằng nhau. Cả hai node thực sự tiếp tục ghi telemetry. Kiểm tra dashboard, GET /api/cluster và `telemetry_messages.processed_by_node_id`. Sau đó:

~~~sh
docker compose start edge-3
~~~

Startup election đưa edge-3 trở lại LEADER; sensor-5/6 quay về edge-3 theo SAME_ZONE. Chạy toàn bộ fault matrix bằng `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-phase-b.ps1`; script tạo một rule kiểm thử rồi disable, phục hồi cả ba node trong cleanup và không reset volume. Yêu cầu demo chuẩn sáu sensor; script dừng sớm nếu zone đã tùy chỉnh.

**Scenario 2 — Edge placement failure**

Khi sensor-1 đang ở edge-1:

~~~sh
docker compose stop edge-1
~~~

Assignment monitor chuyển sensor-1 sang edge-2 với strategy FALLBACK. Khởi động lại:

~~~sh
docker compose start edge-1
~~~

Khi node này UP lại, monitor rebalance sensor-1 về edge-1 với SAME_ZONE. Xem Edge Placement hoặc GET /api/sensors.

**Scenario 3 — Alert**

Tạo rule temperature > 32 (hoặc humidity > 75) trong Alert Rules của dashboard. Simulator liên tục tạo giá trị ngẫu nhiên; khi một telemetry match, alert xuất hiện trong Recent Alerts. Có thể bật/tắt rule trực tiếp trong bảng.

## 14. Các endpoint quan trọng

API (port 4000):

| Method | Endpoint | Chức năng |
| --- | --- | --- |
| GET | /health, /health/db | Kiểm tra API và kết nối PostgreSQL. |
| GET | /api/cluster | Tổng hợp health, role và leader từ ba edge node. |
| GET | /api/nodes | Đọc node metadata trong database. |
| GET | /api/sensors | Danh sách sensor, telemetry mới nhất và assignment context. |
| GET | /api/sensors/:id/readings | Readings của một sensor; hỗ trợ query limit. |
| POST | /api/sensors/:id/assign | Gán sensor theo zone và node UP. |
| GET | /api/alerts | Alerts mới nhất; hỗ trợ query status và limit. |
| GET, POST | /api/alert-rules | Liệt kê và tạo alert rule. |
| PATCH, DELETE | /api/alert-rules/:id | Sửa và xóa alert rule. |

Mỗi edge node (port 5001/5002/5003):

| Method | Endpoint | Chức năng |
| --- | --- | --- |
| GET | /health | Health, role và leaderId hiện tại. |
| GET | /peers | Danh sách peer cấu hình. |
| GET | /cluster-status | Snapshot heartbeat UP/DOWN/UNKNOWN của peers. |
| GET | /election/status | Trạng thái election. |
| POST | /election/start | Kích hoạt election thủ công. |
| GET | /gossip/state | Cluster knowledge trong memory. |

Các route POST /election, /coordinator và /gossip cũng tồn tại để các edge node trao đổi nội bộ.

## 15. Giới hạn hiện tại

- Prototype cho local demo, cố định ba edge node với numeric ID; chưa có cơ chế mở rộng cluster động.
- Placement dùng zone và số sensor được gán, chưa đo CPU, throughput, latency hoặc GPS. Cân tải áp dụng khi cần phân công, không liên tục di chuyển các assignment khỏe mạnh.
- Chỉ node được gán mới ghi dữ liệu, nhưng MQTT vẫn broadcast. QoS 0 có thể mất mẫu lúc handoff/lỗi kết nối; cơ chế idempotency bảo vệ hiệu ứng database cho mẫu đã được nhận, không bảo đảm exactly-once end-to-end.
- Bootstrap chỉ quản lý sáu sensor trong catalog. Sau khi đã khởi tạo, zone/assignment bị người dùng xóa sẽ được giữ nguyên; monitor chỉ reassign/rebalance sensor đã gán.
- Dashboard dùng HTTP polling thay vì WebSocket. Gossip state chỉ ở memory; node metadata status/role trong bảng nodes chưa tự đồng bộ từ runtime cluster.
- Mosquitto cho phép anonymous trong môi trường local. API và dashboard chưa có authentication/authorization hoặc cấu hình bảo mật production.
- Bully Election phục vụ lựa chọn coordinator trong demo, không phải consensus protocol như Raft. Chưa có bảo đảm nhất quán mạnh khi mạng bị phân vùng.

## 16. Hướng phát triển

- Placement theo latency và tải thực tế; hỗ trợ nhiều sensor và quản lý zone linh hoạt.
- Realtime push bằng WebSocket, metrics/logging tập trung và persistence cho cluster metadata.
- Authentication, phân quyền và cấu hình triển khai production.
