# cmcc-cloud-alive

Pure HTTP-first keepalive research and implementation for China Mobile Cloud PC
family edition.

This is a new project. It is not the legacy SDK-wrapper keepalive that starts
`bootCypc` or `uSmartView_VDI_Client`.

## Source And Credit

This project credits and cross-checks against these reverse-engineering notes:

- <https://hansiy.net/p/86b7133e>
- <https://codming.com/posts/cmcc-cloud-computer-keepalive/>

The Hansiy article is for methodology, not endpoint copying: it is about the
enterprise Windows client, while this project targets the family edition. The
important process kept here is:

1. statically reverse the actual family client and recover request behavior;
2. verify runtime traffic with packet capture because capture evidence wins
   when it conflicts with source-code assumptions;
3. only call a route keepalive after a long run proves the cloud PC stays
   powered without starting or occupying the official client.

## Goal

The primary target is the ordinary family cloud-PC HTTP heartbeat:

```text
POST https://soho.komect.com/terminal/cc/cloudPc/heartbeat/v2
body: { userServiceId }
```

A successful HTTP keepalive must:

- not start official SDK client binaries;
- send the same ordinary-cloud-PC heartbeat endpoint used by the family client;
- preserve business responses instead of converting them to generic network
  errors;
- stop only on `4043`/`YUN_OTHER_LOGIN`, matching the family client scheduler;
- show SOHO HTTPS traffic in capture and no CAG/SPICE traffic;
- prove the VM stays powered/running beyond the idle sleep window.

SPICE/CAG/ZIME remains a fallback research route only if the HTTP route is
proven insufficient. SDK log lines such as `connectDesktop ret val: 0` are not
considered success.

## Current Status

Implemented and tested:

- Family-edition SOHO API signing/RSA request support for SMS login, cloud
  list, token check, system settings, and ordinary-cloud-PC HTTP heartbeat
  `/cc/cloudPc/heartbeat/v2`.
- Continuous `heartbeat-loop` with client-aligned retry semantics and explicit
  `保活成功: <duration>` log lines.
- `verify-http` report generation that checks accepted heartbeat responses,
  SOHO HTTPS traffic, absence of official SDK processes, absence of CAG `8899`
  traffic, and cloud-PC status snapshots.
- SPICE REDQ link codecs, full data headers, `DISPLAY_INIT`, `SET_ACK`, ACK,
  and PONG helpers.
- Linux local GSpice/proxy loopback parser.
- Linux/ZTE CAG UDP `ZTEC` control parser.
- Dynamic CAG tunnel `word0` detection.
- Decoding for the observed CAG chain:
  `local_key -> server_key/tunnelId -> connect_info -> connect_reply 200`.
- Native sender for the verified CAG UDP control path through
  `connect_reply code=200`, without starting official SDK binaries.
- Pcap analyzers for loopback SPICE and external CAG/ZIME traffic.
- Static ZIME C-wrapper ABI evidence extraction for the installed Linux
  family client.

Not complete yet:

- final long-duration proof on a VM that is already powered/running;
- standalone SPICE-over-CAG/ZIME fallback keepalive without SDK;
- ZIME reliable UDP sequencing, ACK, retransmit, and close implementation;
- DISPLAY_INIT-level proof on the Linux family CAG route;

The current code is intentionally fail-closed around unproven SPICE/CAG/ZIME
sending paths.

## Usage

Run tests:

```bash
npm test
```

Login with the family-edition SOHO API:

```bash
node bin/cmcc-cloud-alive.js sms-send <phone>
node bin/cmcc-cloud-alive.js sms-login <phone> <code>
node bin/cmcc-cloud-alive.js list
node bin/cmcc-cloud-alive.js cloud-status <userServiceId>
node bin/cmcc-cloud-alive.js firm-auth <userServiceId>
node bin/cmcc-cloud-alive.js protocol-probe <userServiceId> --tls-probe 1
node bin/cmcc-cloud-alive.js cag-plan <userServiceId>
```

The SMS login flow is intentionally aligned with the previous family-edition
SOHO API implementation. It is reused only to obtain and cache the account
login state needed by the protocol work; it is not the keepalive mechanism.

If a legacy login already exists, import it instead of requesting another SMS
code:

```bash
node bin/cmcc-cloud-alive.js import-legacy-state
```

Run the HTTP heartbeat candidate once:

```bash
node bin/cmcc-cloud-alive.js heartbeat <userServiceId>
```

Generate the static reverse-engineering evidence first:

```bash
node bin/cmcc-cloud-alive.js audit-http-source
```

This scans the recovered family client sources and reports the ordinary cloud
PC heartbeat constant, the separate time-zone `v1` heartbeat branch, the
`userServiceId` request body, the `4043` stop condition, and the reschedule
logic. It is the source-audit half of the Hansiy-style workflow; packet capture
still decides the final runtime claim.

Run it continuously:

```bash
node bin/cmcc-cloud-alive.js heartbeat-loop <userServiceId>
```

When `--interval-ms` is omitted, the interval is read from the official family
client settings endpoint `/system/settings/v1` (`cloudPcheartbeatTime`) and
falls back to 30 seconds if settings are unavailable.

Generate a short verification report that checks heartbeat responses, official
client processes, SOHO HTTPS traffic, CAG `8899` traffic, and cloud-PC status
snapshots:

```bash
sudo node bin/cmcc-cloud-alive.js verify-http <userServiceId> \
  --duration-ms 120000
```

`verify-http` reports `httpPathOk` for the pure HTTP path and
`sleepPreventionProof` for the stronger claim that the VM stayed powered during
a long enough run. A powered-off VM can still return accepted heartbeat
responses, so `httpPathOk=true` alone is not final keepalive proof.

`firm-auth` calls the family `/cc/getFirmAuth/v1` endpoint and prints a redacted
protocol route summary. It does not start the official client or connect to
CAG/SPICE.

`protocol-probe` additionally performs a safe CAG TCP TLS handshake when
`--tls-probe 1` is used. It does not send desktop auth, SPICE auth, or SDK
socket commands.

`cag-plan` builds the CAG `local_key` and, when `--server-key` plus
`--tunnel-id` are supplied from a capture, `connect_info` datagram summaries
offline. It does not send packets. Hex output is hidden unless `--show-hex 1`
is explicitly passed.

Extract reusable CAG handshake parameters from a capture:

```bash
node bin/cmcc-cloud-alive.js extract-cag-handshake /path/to/cag.pcap
```

The output includes `cagPlanArgs`. These values can be passed back to
`cag-plan`, including `--local-key-sequence` and `--connect-info-sequence`, to
reproduce packet summaries from observed family-edition Linux CAG traffic. The
observed `connect_info` control word is also exposed as
`--connect-info-control-word` for capture-to-plan comparisons.

Probe the native CAG UDP control handshake:

```bash
node bin/cmcc-cloud-alive.js cag-handshake <userServiceId>
node bin/cmcc-cloud-alive.js cag-handshake <userServiceId> --send-preflight 1
node bin/cmcc-cloud-alive.js cag-handshake <userServiceId> --send-connect-info 1
```

The first command sends only `local_key` and waits for `server_key`. The second
preflight command sends the observed 26-byte CAG probe and records the 14-byte
echo when CAG accepts the probe tail. The third continues through `connect_info` and expects
`connect_reply code=200`. It still does not implement the ZIME tunnel or
DISPLAY_INIT-level keepalive.

`--send-ready 1` is intentionally fail-closed. Current captures show that the
post-`connect_reply` ready sequences are not determined by the marker byte
alone. Use explicit `--client-ready-sequence` and `--peer-confirm-sequence`
only while comparing against a fresh official-client research capture.

Extract native ZIME/CAG library evidence from the installed Linux client:

```bash
node bin/cmcc-cloud-alive.js extract-zime-native
```

The report summarizes `libcag.so`, `libZIMEDataEngine.so`, and `sdk_config.json`
signals such as CAG bootstrap functions, ZIME data-channel symbols,
QUIC/SCTP/DTLS strings, ACK/PING/packet scheduling strings, and keepalive
timers. This is static transport evidence for implementation work; it does not
run the SDK or send packets.

Extract the narrower ZIME C-wrapper ABI boundary:

```bash
node bin/cmcc-cloud-alive.js extract-zime-abi
```

This checks exported `ZIME_*` functions and disassembly evidence for wrapper
handle layout, `ZIME_Init` parameter offsets, `ZIME_ReceiveData` socket
parameter copying, `ZIME_SendData`/`ZIME_SendData2` profile handling, and the
callback/external-transport setup path. It is an offline reverse-engineering
aid for building the next no-SDK transport harness; it is not live keepalive
proof.

Use this as the final proof gate after the VM is already powered/running:

```bash
sudo node bin/cmcc-cloud-alive.js verify-http <userServiceId> \
  --duration-ms 3600000 \
  --wait-powered-ms 600000 \
  --require-sleep-proof 1 \
  --report-file ./reports/http-proof.json
```

`--wait-powered-ms` is a precheck window. The proof timer starts only after the
cloud PC status becomes powered/running.

The heartbeat command is aligned to the family Linux client source: `4043`
(`YUN_OTHER_LOGIN`) is treated as a hard stop, while other JSON business codes
are recorded and the loop continues, matching the client heartbeat scheduler.
Transient network/API exceptions are logged and retried by default in
`heartbeat-loop`; pass `--stop-on-error 1` only for debugging.
On the current test account, `/cc/cloudPc/heartbeat/v2` returned:

```json
{
  "acceptedByClientLogic": true,
  "code": 4041,
  "msg": "当前云电脑处于解锁状态,且无密码",
  "businessCode": "90020129"
}
```

Docker:

```bash
docker compose build
docker compose run --rm cmcc-cloud-alive sms-send <phone>
docker compose run --rm cmcc-cloud-alive sms-login <phone> <code>
docker compose run --rm cmcc-cloud-alive list
CMCC_USER_SERVICE_ID=<userServiceId> docker compose --profile loop up -d
```

For packet-capture verification in Docker, run with host networking or grant
capture capability:

```bash
docker run --rm --network host --cap-add NET_RAW --cap-add NET_ADMIN \
  -e CMCC_ALIVE_STATE=/state/state.json \
  -v cmcc-cloud-alive-state:/state \
  cmcc-cloud-alive:local verify-http <userServiceId> --duration-ms 120000
```

Analyze external CAG traffic:

```bash
node bin/cmcc-cloud-alive.js analyze-cag /path/to/cag.pcap --limit 80
node bin/cmcc-cloud-alive.js extract-cag-tunnel-flow /path/to/cag.pcap --from SEC.USEC --to SEC.USEC
```

Analyze local loopback SPICE traffic:

```bash
node bin/cmcc-cloud-alive.js analyze-loopback /path/to/loopback.pcap
```

Run an offline local-SPICE proof fixture:

```bash
node bin/cmcc-cloud-alive.js spice-offline-proof
```

This reconstructs the Linux local display-channel success boundary without
network access or SDK startup: display `DISPLAY_INIT`, server `SET_ACK` and
`PING`, client `ACK_SYNC` and `PONG`, then display `SURFACE_CREATE`/`MARK`.
It proves the local plaintext state machine and byte encoders before those
bytes are carried through CAG/ZIME.

Correlate an official-client research CAG capture with a synchronized local
loopback SPICE capture:

```bash
node bin/cmcc-cloud-alive.js correlate-cag-loopback \
  /path/to/cag.pcap /path/to/loopback.pcap --window-ms 80 --limit 12
```

This is an offline research tool. It identifies the external CAG/ZIME packet
families surrounding proven local SPICE events such as `DISPLAY_INIT`,
`SURFACE_CREATE`, `DRAW_COPY`, and `MARK`; it does not start the official SDK
client or send live protocol packets.

Capture a short official SDK run for protocol research only:

```bash
sudo scripts/capture-official-cag-research.sh <userServiceId> 20
node bin/cmcc-cloud-alive.js extract-cag-handshake /tmp/cmcc-cloud-alive-research-cag-YYYYmmdd-HHMMSS.pcap
```

This helper starts the legacy `yidongyun` SDK wrapper briefly as an oracle and
then stops it. It is not used by the protocol implementation or Docker runtime.

## Docker

Build:

```bash
docker build -t cmcc-cloud-alive:local .
```

Run analyzer against a mounted capture:

```bash
docker run --rm -v "$PWD/captures:/captures:ro" \
  --name cmcc-cloud-alive-analyze \
  cmcc-cloud-alive:local \
  analyze-cag /captures/cag.pcap --limit 80
```

Compose:

```bash
docker compose run --rm cmcc-cloud-alive help
```

Login and run the HTTP heartbeat loop inside Docker:

```bash
docker compose run --rm cmcc-cloud-alive sms-send <phone>
docker compose run --rm cmcc-cloud-alive sms-login <phone> <code>
docker compose run --rm cmcc-cloud-alive list
docker compose run --rm cmcc-cloud-alive heartbeat-loop <userServiceId> --interval-ms 30000
```

For local migration testing, an existing legacy state file can be mounted
read-only instead of copying secrets into the image:

```bash
docker run --rm \
  --name cmcc-cloud-alive-heartbeat \
  -v /etc/yidongyun/state.json:/etc/yidongyun/state.json:ro \
  cmcc-cloud-alive:local heartbeat <userServiceId>
```

Run the loop persistently with Docker restart policy:

```bash
CMCC_USER_SERVICE_ID=<userServiceId> CMCC_INTERVAL_MS=30000 \
  docker compose --profile loop up -d cmcc-cloud-alive-loop

docker compose logs -f cmcc-cloud-alive-loop
docker compose --profile loop stop cmcc-cloud-alive-loop
```

The Docker image, compose services, containers, and volumes use
`cmcc-cloud-alive*` names. They intentionally do not reuse the legacy
`yidongyun*` names.

## Development Notes

Keep the protocol project separate from legacy SDK-wrapper implementations.
Official client binaries may be used only as a research oracle for captures and
plaintext comparison. Production protocol mode must replace them with native
protocol code.

See [docs/protocol-keepalive.md](docs/protocol-keepalive.md) for the current
protocol map, capture evidence, implementation plan, and unresolved boundaries.
