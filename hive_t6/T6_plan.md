# T6 攻 C：SPICE 通道持有验证（本轮唯一最远维度）
## 锚点
- A 产品CLI PASS / B HAR脱敏 PASS / C FAIL(~29.92min关机)
- C根因：HTTP+MQTT不持会话；需 SPICE main+display 通道(DISPLAY_INIT+ACK/PONG)全程持有
## 现有资产
- zte_raw_spice.py：raw SPICE 握手(REDQ/zero-ticket/main+sub)+keepaliveRawSpiceLoop(DISPLAY_INIT/InputInit+AutoReply PONG/ACK)，Go移植
- protocol_runner.py：Chuanyun SPICE display，但对 RAP/ZIME 路径显式 not_implemented
- spice_protocol.py：编解码块
## T6 双路（独立不冲突）
- T6-A：raw SPICE 通道真连+持有 smoke（关键路径，新证据）
- T6-B：原生 binary 路径可行性审计（备选）
## 红线
- 凭据只引用不写明文；smoke≤10min通道uptime，非120min长测
- 禁无新证据重跑120min
