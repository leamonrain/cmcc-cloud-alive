# Worker-B HAR 逆向补齐 — 进度

## 任务
- BBS #72 Worker-B：point.soho.komect.com HAR 字段级逆向，核实 spuCode / getDisconnectTime / 真实保活字段 / first_desktop 登录鉴权关系。
- 占单：#73（最早 claim）。

## 状态：已完成并回帖闭环（BBS #91）

## 交付物
- reports/HAR_point_soho_keepalive_analysis.md（7325B，主报告）
- reports/HAR_point_soho_keepalive_analysis.json（结构化脱敏数据）

## 关键结论
1. HTTP heartbeat/v2 0/186 成功（178×4041 + 6×4043），非有效保活。
2. 真实长连接保活通道：MQTT over TLS，ssl://alive.soho.komect.com，HS256 JWT，订阅 sc/s-notify/*。
3. getDisconnectTime=30min（关机策略，非保活字段）。
4. spuCode：zte-cloud-pc(userServiceId 2663816, 首项/first_desktop) + sc-cloud-pc(38613039)。
5. 接入网关 CAG 111.31.3.182:8899，SCG 字段空（未启用）。
6. 登录链：encryptKey(RSA)→sms/send→sms/login(sohoToken+userId)→checkToken；后续 X-SOHO-SohoToken+Signature+Timestamp+AppKey，请求体 RSA 加密。

## 限制
- 请求体全 RSA 加密，明文不可见；MQTT 长连接报文不在 HAR 内，keepalive 间隔未取证（需 hook/抓包）。
- 未重放/未长测，纯静态 HAR 证据。

## 闭环
- 已回帖 BBS #91（hive-worker-B），报告完成 + 交付路径 + 关键结论。
- BBS key 仅引用存放位置，不在进度文档写入完整值（存于 temp/desktop_sessions.json 与 _hive_meta.json）。

## T4-B #126 结构化交付物脱敏复核
- 修复文件：reports/HAR_point_soho_keepalive_analysis.json。
- 确定性脱敏规则：手机号、sohoToken、JWT、userName/clientId/topic 中嵌入的手机号或账号 ID、userId、uuid、nickname 等真实账号相关字段替换为 `<REDACTED_*>` 占位；保留端点、字段名、计数、业务码分布、spuCode/getDisconnectTime/CAG/MQTT 结论所需结构。
- 权限：结构化 JSON 写回后设置为 0600。
- 复核命令：`python3 - <<'PY' ...` 使用正则统计 `phone_11`、`hex32_tokens`、`jwt` 三类命中，并用 `json.loads` 校验 JSON 有效。
- 复核结果：`phone_11=0`、`hex32_tokens=0`、`jwt=0`、`json_valid=yes`。
