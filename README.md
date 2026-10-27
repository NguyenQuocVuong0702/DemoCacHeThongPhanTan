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

Ba edge node cùng hoạt động nên cần chọn một leader để xử lý telemetry. Khi leader dừng, các node còn lại phải phát hiện lỗi và bầu leader mới. Heartbeat và gossip giúp chia sẻ trạng thái cluster; sensor giả lập gửi dữ liệu qua MQTT; leader lưu readings và đối chiếu alert rules để tạo alerts. API còn gán sensor vào edge node dựa trên zone và trạng thái UP/DOWN để dashboard theo dõi vị trí gán.

## 2. Các chức năng chính

- Cluster gồm ba edge node với heartbeat mỗi 2 giây, Bully Leader Election, startup election, automatic failover và recovery takeover khi node ID cao khởi động lại.
- Gossip mỗi 3 giây để chia sẻ cluster knowledge trong memory; API tổng hợp trạng thái thực tế của ba node qua health check.
- Virtual sensor phát nhiệt độ và độ ẩm qua MQTT. Cả ba node subscribe, nhưng chỉ leader xử lý và ghi telemetry vào PostgreSQL.
- Leader đọc alert rules đang bật từ database cho mỗi telemetry, so khớp điều kiện và tạo alert. Alert rules có CRUD qua REST API và dashboard, không cần restart edge node.
- API cung cấp sensors, readings, alerts, alert rules, nodes và cluster status. Dashboard React hiển thị summary, biểu đồ, cluster topology, edge placement và bảng cảnh báo.
- Dashboard polling cluster mỗi 2 giây; sensors, readings và alerts mỗi 3 giây. Alert rules được tải lúc mở trang và làm mới sau thao tác CRUD.
- Assignment ưu tiên node UP cùng zone, fallback sang node UP có numeric ID nhỏ nhất; monitor tự chuyển sensor đã gán khi node down và rebalance về node cùng zone khi node đó phục hồi.
- Docker Compose cấu hình PostgreSQL, Mosquitto, ba edge node, API, sensor simulator và dashboard Nginx.

## 3. Mapping với Distributed Systems Chapter 5

| Nội dung | SmartEdge implementation |
| --- | --- |
| 5.4 Election Algorithms | Bully Leader Election theo numeric node ID; bầu lúc startup, khi leader down và khi node ID cao khởi động lại. |
| 5.5 Gossip-based Coordination | Mỗi edge node trao đổi cluster knowledge với một peer ngẫu nhiên và merge record mới hơn theo updatedAt. |
| 5.6 Distributed Event Matching | Leader so telemetry với các alert_rules đang bật trong PostgreSQL và ghi alerts khi rule match. |
| 5.7 Location Systems | API chọn edge node theo zone, fallback theo ID, tự reassign khi node down và rebalance khi same-zone node UP lại. |

## 4. Kiến trúc hệ thống

~~~mermaid
flowchart LR
    S["Sensor Simulator<br/>sensor-1"] --> M["MQTT Broker<br/>Mosquitto"]
    M --> E
    subgraph C["Edge Cluster: edge-1 / edge-2 / edge-3"]
        E["Heartbeat · Bully Election · Gossip<br/>Event Matching tại LEADER<br/>Assignment target"]
    end
    E -->|"Chỉ LEADER ghi telemetry và alerts"| P[("PostgreSQL")]
    P --> A["Express API<br/>Assignment service + monitor"]
    A --> D["React Dashboard"]
    A -. "GET /health" .-> E
    A -->|"Rule CRUD, assigned_node_id"| P
~~~

Assignment được quyết định và lưu bởi API; edge nodes là các đích gán. Luồng MQTT vẫn đến mọi node đã subscribe, và chỉ leader xử lý message.

## 5. Luồng dữ liệu

1. Sensor simulator publish JSON lên topic sensors/1/telemetry (QoS 0). Edge nodes subscribe sensors/+/telemetry.
2. Node có role LEADER validate payload, upsert sensor và lưu hai readings temperature/humidity trong một transaction.
3. Sau khi lưu thành công, leader đọc các alert_rules đang bật; mỗi rule match tạo một dòng alerts.
4. API đọc PostgreSQL và health của edge nodes. Dashboard gọi API để hiển thị và tự polling dữ liệu.

## 6. Leader Election & Failover

Các node có ID số: edge-1 = 1, edge-2 = 2, edge-3 = 3. Bully Election chỉ gửi ELECTION tới peer có ID lớn hơn; node có ID cao nhất còn hoạt động sẽ trở thành leader và gửi COORDINATOR cho peers.

| Tình huống | Kết quả mong đợi |
| --- | --- |
| Cả ba node UP | edge-3 là LEADER. |
| edge-3 dừng | Heartbeat phát hiện leader DOWN; edge-2 trở thành LEADER. |
| edge-3 khởi động lại | Startup election giúp edge-3 giành lại vai trò LEADER. |

Election cũng có endpoint kích hoạt thủ công để demo. Việc bầu leader và phát hiện lỗi có độ trễ ngắn theo heartbeat, timeout và startup delay.

## 7. Gossip

Mỗi edge node giữ cluster knowledge trong một Map in-memory, gồm status, role, leaderId và updatedAt. Cứ 3 giây, node gửi knowledge cho một peer ngẫu nhiên; khi nhận, record mới hơn theo updatedAt sẽ ghi đè record cũ. Gossip chỉ chia sẻ góc nhìn về cluster; quyết định leader vẫn do Bully Election.

## 8. Event Matching

Ví dụ có thể tạo hai rule:

~~~text
temperature > 32
humidity > 75
~~~

Khi telemetry thỏa rule đang enabled, leader tạo alert với sensor, rule, metric, value và thời gian của telemetry. Rule có thể tạo, sửa, bật/tắt hoặc xóa trên dashboard hoặc qua API. Database hiện dùng ON DELETE CASCADE: xóa rule cũng xóa các alerts liên quan.

## 9. Location-aware Edge Assignment

Migration seed metadata cho edge-1 → hanoi, edge-2 → danang, edge-3 → hcm. Sensor-1 dùng zone hanoi trong kịch bản demo.

| Trạng thái | Assignment của sensor-1 |
| --- | --- |
| edge-1 UP | edge-1, strategy SAME_ZONE |
| edge-1 DOWN; edge-2 và edge-3 UP | edge-2, strategy FALLBACK (ID nhỏ nhất còn UP) |
| edge-1 UP trở lại | edge-1, strategy SAME_ZONE sau recovery rebalance |

Lần gán đầu tiên dùng POST /api/sensors/1/assign; monitor 3 giây chỉ theo dõi sensor đã có assigned_node_id. Với database demo mới, bootstrap tự đợi telemetry tạo sensor-1, đặt zone hanoi và gọi API assign. Database đã tồn tại được giữ nguyên metadata khi khởi động. Assignment là metadata trong PostgreSQL; nó chưa định tuyến MQTT trực tiếp tới edge node được gán.

## 10. Công nghệ

- TypeScript, Node.js, Express và package pg.
- React, Vite, Ant Design, Axios và Recharts.
- MQTT với Eclipse Mosquitto; PostgreSQL lưu sensors, readings, rules, alerts và node metadata.
- Docker, Docker Compose và Nginx để build/serve dashboard.

## 11. Cấu trúc repo

~~~text
apps/
  api/                 REST API, assignment, migrations SQL
  dashboard/           React UI, Vite, Nginx config
  edge-node/           heartbeat, election, gossip, MQTT, event matching
  sensor-simulator/    virtual sensor MQTT
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

Script tự build images, chạy migrations theo thứ tự, đợi dependencies và cluster ổn định, chuẩn bị sensor-1 trên database mới rồi chạy smoke checks. Migrations có lịch sử trong `schema_migrations`; chạy lại giữ dữ liệu. Các service dùng thông tin đăng nhập mẫu cho demo local.

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

Sau vài giây, edge-3 hiện DOWN, edge-2 trở thành LEADER và telemetry tiếp tục được xử lý. Kiểm tra dashboard hoặc GET /api/cluster. Sau đó:

~~~sh
docker compose start edge-3
~~~

Startup election đưa edge-3 trở lại LEADER.

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
- Placement dựa trên zone và numeric ID fallback, chưa đo latency, load hoặc vị trí GPS. Bản ghi assignment không điều hướng luồng MQTT; chỉ leader xử lý telemetry.
- Ngoài bootstrap sensor-1 của demo mới, sensor chưa được tự gán khi assigned_node_id còn NULL. Monitor chỉ reassign/rebalance sensor đã gán.
- Dashboard dùng HTTP polling thay vì WebSocket. Gossip state chỉ ở memory; node metadata status/role trong bảng nodes chưa tự đồng bộ từ runtime cluster.
- Mosquitto cho phép anonymous trong môi trường local. API và dashboard chưa có authentication/authorization hoặc cấu hình bảo mật production.
- Bully Election phục vụ lựa chọn coordinator trong demo, không phải consensus protocol như Raft. Chưa có bảo đảm nhất quán mạnh khi mạng bị phân vùng.

## 16. Hướng phát triển

- Placement theo latency và tải thực tế; hỗ trợ nhiều sensor và quản lý zone linh hoạt.
- Realtime push bằng WebSocket, metrics/logging tập trung và persistence cho cluster metadata.
- Authentication, phân quyền và cấu hình triển khai production.
