# ZTE 协议保活 — 逆向复用素材清单

> 产出方：逆向复用组（响应 #181 user 直接指令加派人手）
> 日期：2026-07-06
> 性质：**只读勘察**，仅梳理现有逆向数据/HAR/证据/源码定位，供其他 4 组复用，不修改源码。
> 隐私约束：本清单只记录**结构与定位**，不复制账号/密码/token/connectStr/accessToken/cpsid/auth payload 等敏感值。

---

## 0. 全局结论（先读这段）

- **真正保活路线**（docs/protocol-keepalive.md 已确认）：HTTP heartbeat/infoReport/point 仅 telemetry 不保活（已拒绝）；CAG HTTPS 仅 boot/connect material 不保活且会踢官方 session（已拒绝）。真正路线 = **SOHO → CAG boot/connect material → RAP/ZIME transport → SPICE main channel → SPICE display channel → DISPLAY_INIT → ACK/PONG → power-state proof**。
- **当前唯一有效 gate**（docs/plan-zte-evidence-matrix.md）：`cmd26 local proxy bootstrap → AUTH_HEAD199 → same-fd/same-remote ACK-like71 → AUTH_DATA241`。突破口 = 拿到 `authGateAcceptance.authGateOnlyAccepted=true`（Python live accepted report）。
- **当前阻塞**：CAG TCP/TLS/mux/raw SPICE 路径**冻结**（未拿到 Python live accepted report），印证 #179 worker9 smoke 结果「fix(a) PASS / CAG auth FAIL」。
- **两条 AUTH 路径区分**（重要，勿混淆）：
  - 路径 A（冻结）：`zte_cag.py` CAG TCP 直连握手 178/50/220/36 字节 → TLS。
  - 路径 B（突破口）：`cmd26` local proxy bootstrap → 199/71/241 字节 AUTH gate。当前攻坚焦点在路径 B。

---

## 1. AUTH / MATERIAL 派生素材（供 auth/material派生组）

### 1.1 CAG TCP pre-auth 握手（路径 A，冻结）
- **位置**：`cmcc_cloud_alive/zte_cag.py:181` `dial_cag_tcp_tls(opts: CAGDialOptions)`
- **5 步序列**：
  1. send **178-byte** local-key = `build_cag_auth_head_packet()[0][21:]`（199 字节包取后 178）
  2. read **50-byte** local-key ack；校验 `head_ack[:4]==b"ZTEC"`；`conv = struct.unpack_from("<I", head_ack, 14)[0]`
  3. send **220-byte** auth blob = `build_cag_auth_blob(opts.inner, auth_template)`
  4. read **36-byte** auth ack；校验 `auth_ack[4]==0x01`
  5. 同 socket TLS upgrade（TLSv1.2，check_hostname=False，CERT_NONE）
- **入参**：`CAGDialOptions(address, inner: InnerConnectParams, auth_template_hex, timeout)`

### 1.2 auth-head packet 结构（199 字节）
- **位置**：`zte_cag.py:71` `build_cag_auth_head_packet() -> (packet_199, syn_id_4)`
- 结构（memoryview 写视图，注意 Go→Python 移植须用 memoryview）：
  - `mv[0:4]=0x06000080`；`syn_id=mv[11:15]` 随机
  - payload=`mv[21:]`(178B)：`[0:4]=b"ZTEC"`，`[4:6]=0x00ac(<H)`，`[6:10]=101(<I)`，`[10:14]`随机，`[14:18]=0xdc000000`，`[18:38]`随机，`[38:42]=0x07000b0b`，`[54:86]` ascii_hex(32B)，`[118:134]` ascii_hex(16B)

### 1.3 auth template 解析
- **位置**：`zte_cag.py:98` `parse_auth_template(template_hex) -> Optional[bytes]`
- 规则：空→`None`(build-from-scratch)；241 字节且 `template[0]==0x08`→原样；220 字节→原样；其他长度报错
- **env 注入**：`CCK_ZTE_CAG_AUTH_TEMPLATE_HEX`（`zte_route.py:534`）

### 1.4 auth blob 构建（220 字节）
- **位置**：`zte_cag.py:119` `build_cag_auth_blob(inner, template=None)`
- template 路径：241→`template[21:]`(220)；220→patch `vmId` 到 `blob[20:56]`
- build-from-scratch 路径：`blob[0:4]=proxy_sport(<I)`，`blob[4:8]=inet_aton(host)`，`blob[20:56]=vm_id`(36B UUID)，`blob[60:188]`随机，`blob[188]=0x50`
- **依赖 InnerConnectParams**：`host`(须 IPv4)、`proxy_sport`、`vm_id`(须 36 字节)

### 1.5 material 派生命令（路径 B，突破口）
- **位置**：`main.py:713` `cmd_rap_zime_kcp_auth_from_cag(args)`；子命令注册 `main.py:1772`
- **material 两种来源**：
  - 显式：`--cag-material-file` → `_load_explicit_cag_material`
  - fresh fetch：`protocol_runner.fetch_cag_auth_connect_info(user_service_id, state, boot_wait, timeout)` → `materialSource="fresh-cag-fetch"`, `freshFetched=True`
- **pre-AUTH cmd26 local proxy bootstrap**（`--pre-auth-cmd26-local-proxy`）：
  - `local_host/local_port` + `dest_ip/dest_port`(取自 CAG connectInfo host/port) + `channel_type/channel_id` + `trace_id/parent_id`
- **pre_auth_state contract**（`--pre-auth-state-contract`）字段：
  - `type6_proxy_fd_session_slot`、`proxy_sock_udp_gate`、`init_local_rw_sock_pair_udp_kcp_attachment`、`quic_channel_manage_ready_or_bypassed`
  - `channel_type_id_candidate = 0x{((channel_type<<8)|channel_id):04x}`
- **三阶段门控**：`--auth-gate-preflight-only`(preflight) / `--require-live-gate-ready`(live gate) / `--require-auth-gate-accepted`(accepted，须 live 非 preflight)
- **突破口函数**（evidence-matrix 指明）：`listen_udp_data_thread_ice_deal_sock_loop` 及 71-byte ACK-like 报文

---

## 2. SPICE 屏幕流量报文（供 SPICE屏幕流量组）

### 2.1 keepaliveRawSpiceLoop（保活主循环）
- **位置**：`cmcc_cloud_alive/zte_raw_spice.py` `keepaliveRawSpiceLoop(conn, interval=25, stop_after=None)`
- **每 interval(默认 25s) 注入**：
  - `conn.sendall(rawMessageWithPrefix(state.nextSerial(), BuildZTERawDisplayInit()))`
  - `conn.sendall(rawMessageWithPrefix(state.nextSerial(), BuildZTERawInputInit()))`
- **AutoReply**：`state.AutoReply(conn, msg_type, payload)` 对收到的消息自动应答
- **counters**：`messages / autoReplies / ticks / errors`
- 对应 user 指令「每次 60s 屏幕流量」——interval 可调，注入 DISPLAY_INIT+INPUT_INIT 即维持 display channel 活性

### 2.2 RawSubChannelHandshake（子通道鉴权）
- **位置**：`zte_raw_spice.py` `RawSubChannelHandshake(conn, key, vmid, linkUUID, traceID, spanID, spiceSessionID, channelType, channelID)`
- **4 步序列**（P10-006/007/008）：
  1. send `BuildZTERawChannelREDQ(...)`（**725-byte** REDQ with channel caps）
  2. `readRawLinkReply(conn, 8.0)` → 定位 RSA public-key marker（`0x30819F300D` 或 fallback `0x3081`）
  3. send **128-byte zero ticket**（no auth-type prefix）
  4. read **4-byte little-endian** auth result；`0`=success

### 2.3 spice_protocol.py（离线协议构建块）
- **位置**：`cmcc_cloud_alive/spice_protocol.py`
- 提供 REDQ link header/message encode 等离线构建块
- 关键函数（docs/protocol-keepalive.md 列出）：`spice_channel_send_link` / `spice_channel_recv_link_res` / `spice_channel_send_vapp_ticket_key` / `main_channel_linked` / `display_handle_surface_create` / `display_handle_mark` / `display_handle_draw_copy` / `hand_display_channel_ping_msg`

---

## 3. 关机检测接口（供 验证监控组）

### 3.1 cloud.py 状态查询
- **位置**：`cmcc_cloud_alive/cloud.py`
- `status(user_service_id=None, state_path=None)` → `core.cloud_status(args)` → 返回 desktop item
- `is_running(item)`：`vmStatus in RUNNING_STATUS_VALUES or "运行" in vmStatusShow`
- `is_off(item)`：`vmStatus in OFF_STATUS_VALUES or "关机" in vmStatusShow`
- 字段来源：desktop item 的 `vmStatus`(数值) / `vmStatusShow`(中文文本)

### 3.2 power_monitor.py（独立电源监控）
- **位置**：`cmcc_cloud_alive/power_monitor.py`
- 独立于 CAG 的电源状态监控；report 含 `endedAt` / `lastPowerMonitorAt`
- 对应 user 指令「每 min 检测关机」+「独立监控」

### 3.3 关键教训（必读）
- **证据**：`docs/evidence/cag-plus-http-prime-failed-20260702.json`
- **陷阱**：CAG after-status 检查会**掩盖关机区间**——下一轮 CAG 可能把 desktop 拉回 running
- **要求**：验证须在**每次 CAG 尝试前**检查 power state，且/或运行独立 monitor（power_monitor.py）
- `strategy.py:87` 已记录该约束

---

## 4. 证据文件清单（docs/evidence/，8 个）

| 文件 | 大小 | 对应阶段 / 用途 |
|---|---|---|
| `cross-platform-har-summary-20260701.json` | 32KB | 跨平台 HAR 汇总（HTTP 层面） |
| `sdk-tls-jsonl-decoded-20260630.json` | 124KB | SDK TLS 明文解码（最大，含 transport 细节） |
| `sdk-session-jsonl-decoded-20260630.json` | 22KB | SDK session 解码 |
| `http-official-client-40min-20260701.json` | 16KB | 官方客户端 40min HTTP 抓取 |
| `terminalprobe-har-20260630.json` | 15KB | terminalprobe HAR |
| `linux-client-connected-pcapng-20260701.json` | 11KB | Linux 客户端连接 pcapng |
| `cag-official-session-takeover-20260701.json` | 2KB | CAG 官方 session takeover |
| `cag-plus-http-prime-failed-20260702.json` | 1.6KB | CAG+HTTP prime 失败（含关机掩盖教训） |

> 补充 reports/ 下高频引用：`HAR_point_soho_keepalive_analysis.md`、`T7-C-fix_keepalive-route-fix.md`、`zime-transport-*.analysis*.json`、`cag-https-*-proof.json`、`*-status-before/after.json`（power-state 前后对比）。

---

## 5. 关键源码定位速查

| 素材 | 文件:行 | 函数 |
|---|---|---|
| CAG TCP 握手 | zte_cag.py:181 | `dial_cag_tcp_tls` |
| auth-head 199B | zte_cag.py:71 | `build_cag_auth_head_packet` |
| auth template 解析 | zte_cag.py:98 | `parse_auth_template` |
| auth blob 220B | zte_cag.py:119 | `build_cag_auth_blob` |
| material 派生命令 | main.py:713 | `cmd_rap_zime_kcp_auth_from_cag` |
| auth_template_hex env | zte_route.py:534 | `CCK_ZTE_CAG_AUTH_TEMPLATE_HEX` |
| SPICE 保活循环 | zte_raw_spice.py | `keepaliveRawSpiceLoop` |
| SPICE 子通道鉴权 | zte_raw_spice.py | `RawSubChannelHandshake` |
| SPICE 协议构建块 | spice_protocol.py | REDQ encode 等 |
| 关机检测 | cloud.py:108/118 | `is_running` / `is_off` |
| 独立电源监控 | power_monitor.py | — |
| 保活协议总览 | docs/protocol-keepalive.md | — |
| AUTH gate 矩阵 | docs/plan-zte-evidence-matrix.md | — |

---

## 6. 给各组的复用建议

- **auth/material派生组**：聚焦 §1.5（cmd26 路径 B）+ §1.3/1.4。当前阻塞在 `authGateOnlyAccepted`，需突破 `listen_udp_data_thread_ice_deal_sock_loop` 的 71-byte ACK-like。§1.1-1.4 的 CAG TCP 路径 A 已冻结，勿重复投入。
- **SPICE屏幕流量组**：直接复用 §2.1 `keepaliveRawSpiceLoop`（每 25s DISPLAY_INIT+INPUT_INIT）+ §2.2 子通道鉴权。注意 user 要求「每次 60s 屏幕流量」，interval 需对齐。
- **longtest runner组**：参考 §3.3 关机掩盖陷阱——长测须配独立 power_monitor，且每次 CAG 前查 power state。证据文件见 §4。
- **验证监控组**：复用 §3.1 `cloud.is_off` + §3.2 `power_monitor.py`。user 要求「每 min 检测关机」+「40/60/120 长测须真实拒 mock」。

---

*本清单为只读勘察产出，如需补充某素材的更深层报文细节，请回帖指明，逆向复用组可继续深挖对应证据文件。*
