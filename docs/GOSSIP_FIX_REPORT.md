# Sửa lỗi hội tụ Gossip SmartEdge

Ngày kiểm thử: **27/10/2026**. Đã đọc `gossip.ts`, `heartbeat.ts`, `election.ts` và `index.ts`, tái hiện trên Docker trước khi sửa, rồi kiểm tra lại sau khi thay image của ba edge nodes.

## Tái hiện và nguyên nhân

Trước khi sửa, `/health` và `/api/cluster` thống nhất cả ba node UP, edge-3 là LEADER và leaderId 3. Tuy nhiên:

```text
edge-3 self: role=LEADER, leaderId=3,
            updatedAt=2026-10-27T03:22:58.061Z
edge-1/2 view of edge-3: role=FOLLOWER, leaderId=null,
            updatedAt=2026-10-27T03:28:50.766Z
```

Chờ thêm 12 giây vẫn giữ sai lệch này. Script kiểm tra trước bản sửa trả exit code 1:

```text
API: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
HEALTH edge-1: FOLLOWER/3
GOSSIP edge-1: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/; 3=UP/FOLLOWER/
HEALTH edge-2: FOLLOWER/3
GOSSIP edge-2: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/FOLLOWER/
HEALTH edge-3: LEADER/3
GOSSIP edge-3: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/; 3=UP/LEADER/3
[FAIL] normal: timeout after 10s: edge-1 gossip for edge-2 disagrees with /health: UP/FOLLOWER/
```

Dấu `/` cuối biểu thị leaderId NULL. Output nguyên trạng: [GOSSIP_BEFORE.txt](GOSSIP_BEFORE.txt).

Chuỗi nguyên nhân:

1. `heartbeat.ts` chỉ dùng kết quả HTTP health để xác định UP/DOWN, không đọc role/leader trong body. Callback tại `index.ts` truyền `peer.id` và status cho Gossip.
2. `updatePeerStatus` tạo/cập nhật cả bản ghi với thời gian quan sát heartbeat hiện tại. Nó giữ role/leader cũ hoặc điền FOLLOWER/NULL khi chưa biết, nên timestamp mới không chứng minh role/leader mới.
3. `mergeClusterKnowledge` chọn toàn bộ bản ghi theo `updatedAt`, không phân biệt phiên bản trạng thái election với quan sát reachability. Bản ghi heartbeat mới hơn có thể thắng bản ghi LEADER thật.
4. `updateLocalState` chỉ tăng timestamp khi trạng thái thực sự đổi. Node đang ổn định tiếp tục phát lại bản ghi LEADER cũ hơn bản ghi quan sát sai, nên gossip không tự chữa được. Đây là lỗi phiên bản/nguồn thông tin trong Gossip; Bully Election đã bầu đúng.

## Thay đổi tối thiểu

Application code chỉ sửa **`apps/edge-node/src/gossip.ts`**:

- Lưu quan sát heartbeat trực tiếp trong `observedPeerStatuses`, tách khỏi phiên bản role/leader.
- `updatePeerStatus` chỉ thay reachability, giữ nguyên role/leader và `updatedAt` đã biết. Nếu chưa có trạng thái chủ sở hữu, dùng timestamp epoch cho placeholder để bản ghi owner thật luôn có thể thay thế nó.
- `mergeClusterKnowledge` nhận role/leader/phiên bản mới hơn, nhưng ưu tiên UP/DOWN quan sát trực tiếp tại node hiện tại so với trạng thái được relay.
- Chỉ `updateLocalState` của chính node sinh phiên bản election mới. Relays/heartbeat không đóng dấu lại phiên bản đó. Vẫn bỏ qua record do peer gửi về chính mình và giữ validation hiện có.
- Thay đổi local state trong cùng mili giây dùng phiên bản tăng tối thiểu 1 ms. Đọc endpoint hoặc relay trạng thái không tăng phiên bản giả.

Quy tắc nguồn thông tin: **owner quyết định role/leader/version; heartbeat trực tiếp quyết định reachability tại observer**. Các peer chuyển tiếp role/leader/version của owner nguyên vẹn. Không thêm field hoặc đổi JSON contract của `/gossip`, `/gossip/state`, `/health` hay `/api/cluster`.

Không sửa `heartbeat.ts`, `election.ts`, `index.ts`, MQTT, database, API hoặc dashboard trong công việc này. Các thay đổi đóng gói demo có sẵn từ công việc trước được giữ nguyên.

File phục vụ kiểm thử/báo cáo:

| File | Mục đích |
| --- | --- |
| `apps/edge-node/package.json` | Thêm lệnh npm test. |
| `apps/edge-node/test/gossip.test.ts` | 6 regression tests, không cần MQTT/database. |
| `scripts/test-gossip.ps1` | Kiểm tra integration với polling có timeout và 3 mẫu liên tiếp; tự phục hồi edge-3 nếu kiểm thử lỗi sau khi dừng node. |
| `docs/GOSSIP_BEFORE.txt` | Output trước sửa, FAIL thực tế. |
| `docs/GOSSIP_AFTER.txt` | Output sau sửa, gồm health/API/gossip và timestamps từng record. |
| `docs/GOSSIP_FIX_REPORT.md` | Báo cáo này. |

## Lệnh đã chạy và kết quả

Từ root repository:

```powershell
# Trước khi sửa application code:
npm.cmd test --workspace @smartedge/edge-node
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-gossip.ps1 -ProjectName smartedge -CheckOnly -TimeoutSeconds 10

# Sau khi sửa:
npm.cmd test --workspace @smartedge/edge-node
npm.cmd run build --workspace @smartedge/edge-node
npm.cmd run typecheck
docker compose -p smartedge build edge-1
docker compose -p smartedge up -d --no-deps edge-1 edge-2 edge-3
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-gossip.ps1 -ProjectName smartedge
git -c core.whitespace=cr-at-eol diff --check
```

Kết quả:

- Trước sửa: 5 regression tests đầu tiên có **2 pass / 3 fail**, xác nhận bản ghi heartbeat che owner report, heartbeat tự tăng version election và relay DOWN có thể đè trực tiếp UP.
- Sau sửa: bổ sung thêm test thay đổi cùng mili giây; bộ cuối cùng **6 pass / 0 fail**.
- Build edge, typecheck toàn repo và Docker build thành công, exit code 0.
- Lifecycle chạy thực tế với edge-3 stop rồi khởi động lại. Bản script cuối dùng `up -d --no-deps edge-3` để phục hồi đúng một node. Đã đối chiếu `FinishedAt` của migration container trước/sau lần chạy cuối, xác nhận migration service không chạy lại.
- Script yêu cầu cả giá trị role/leader/status và phiên bản owner `updatedAt` của mọi node đang UP khớp trong các gossip view; chỉ báo PASS khi có 3 mẫu liên tiếp hợp lệ.

Output lifecycle cuối:

```text
[PASS] normal: 3 consecutive matching samples (leader=3)
API: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
GOSSIP edge-1: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
GOSSIP edge-2: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
GOSSIP edge-3: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3

[PASS] edge-3 stopped / edge-2 leader: 3 consecutive matching samples (leader=2)
API: 1=UP/FOLLOWER/2; 2=UP/LEADER/2; 3=DOWN/UNKNOWN/
HEALTH edge-1: FOLLOWER/2
GOSSIP edge-1: 1=UP/FOLLOWER/2; 2=UP/LEADER/2; 3=DOWN/LEADER/3
HEALTH edge-2: LEADER/2
GOSSIP edge-2: 1=UP/FOLLOWER/2; 2=UP/LEADER/2; 3=DOWN/LEADER/3
HEALTH edge-3: unreachable

[PASS] edge-3 recovered: 3 consecutive matching samples (leader=3)
API: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
HEALTH edge-1: FOLLOWER/3
GOSSIP edge-1: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
HEALTH edge-2: FOLLOWER/3
GOSSIP edge-2: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
HEALTH edge-3: LEADER/3
GOSSIP edge-3: 1=UP/FOLLOWER/3; 2=UP/FOLLOWER/3; 3=UP/LEADER/3
```

Sau phục hồi, bản ghi edge-3 trong cả ba view có cùng **`updatedAt=2026-10-27T03:58:16.982Z`**. Hai node còn lại cũng hội tụ cùng phiên bản tương ứng. Xem [GOSSIP_AFTER.txt](GOSSIP_AFTER.txt) để đọc toàn bộ output gồm timestamps.

Khi edge-3 DOWN, không thể đọc `/health` hoặc `/gossip/state` của chính node đó. Gossip giữ **role/leader cuối cùng đã được owner báo cáo**, kèm status DOWN; API hiện có dùng UNKNOWN/NULL khi health không truy cập được. Kiểm thử so sánh role/leader của các node đang UP và xác nhận DOWN cho node đã dừng, không giả vờ có báo cáo mới từ node không hoạt động.

## Trạng thái cuối

Ba edge nodes đang chạy image đã sửa; edge-3 là leader. Không xóa volume, không reset database, không commit hoặc push. Kiểm thử này xác minh hội tụ trong cluster Docker local qua chu kỳ stop/restart nêu trên.
