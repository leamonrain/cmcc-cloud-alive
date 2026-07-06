# cmcc-cloud-alive

China Mobile family cloud PC protocol-level keepalive research.

This project targets the family/ordinary cloud PC route, especially the Linux
client path that uses RAP/ZIME/SPICE desktop transport. Docker packaging and
HTTP/CAG keepalive loops are abandoned.

Current scope is limited to `家庭云电脑畅享版月包`. The user's desktop guest OS
has been restored to Win10, but the external connection path still follows the
family Linux client RAP/ZIME/SPICE transport.

## Status

Current active route:

1. Use the family SOHO API only for login, cloud list, status, and fresh
   connection material.
2. Reverse the native Linux client transport:
   `CAG/RAP -> ZIME -> SPICE main/display channel`.
3. Reproduce the display-channel keepalive path from Codming's analysis:
   SPICE link/auth, display channel, `DISPLAY_INIT`, then ACK/PONG handling.
4. Prove it with an independent per-minute cloud power monitor. If the VM
   reaches `已关机` or any non-running state, the test fails.

Implemented:

- Password login and SOHO signed/encrypted request support.
- Cloud list, selection cache, and power-state status checks.
- Target guard for `家庭云电脑畅享版月包`: automatic selection and explicit
  selection refuse clearly non-target cloud PCs.
- Independent power monitor: `power-monitor` and `scripts/power-monitor.sh`.
- CAG boot/connect-material acquisition and `connectStr` decoding.
- Offline SPICE/Chuanyun codecs:
  REDQ link messages, mini/data headers, `DISPLAY_INIT`, ACK/PONG, Surface/MARK
  success predicate, and RSA OAEP ticket encryption.
- ZIME dynamic probe:
  `research/zime-probe.c`, `scripts/build-zime-probe.sh`,
  `scripts/run-zime-probe.sh`. The probe also reports candidate
  `ZIMEPacketOutSpec` records from `TransportBatchImplC::OnSendData_Batch`
  so RAP/ZIME protected UDP payload descriptors can be studied without
  hand-decoding raw memory snapshots.
- RAP/ZIME UDP transport scaffold:
  ZTEC request/ack codec, RAP compound datagram parsing, and
  `rap-zime-udp-probe` for short target/tunnel validation. The probe can also
  load complete packet-out payloads from a `zime-native-bridge` report via
  `--native-report`.
- RAP/ZIME payload-envelope analysis:
  observed data frames expose an inner payload length and local SPICE channel
  prefix before protected ZIME bytes. This is trace evidence only and is not
  replayable plaintext.
- Research-only native ZIME bridge:
  `zime-native-bridge` can inspect `libZIMEDataEngine.so` exports/ABI and, only
  with `--allow-native-run`, call the native engine with fake external
  transport callbacks to study packet-out records. It now reaches
  `ZIME_CreateDataChannel ret=0` with `mtu=1452` and captures a complete
  `native_transport_batch` after `ZIME_DataChannelProcess2`; this is a
  protected QUIC/ZIME packet-out candidate, not desktop keepalive proof. The
  bridge also has an explicitly enabled UDP-backed external transport mode
  that can send native packet-out bytes and feed UDP responses back through
  `ZIME_ReceiveData`; local tests cover raw UDP and RAP-wrapped payloads. The
  CLI now waits for a successful `native_channel_created` callback before
  creating a user stream, so a slow RAP/ZIME handshake does not trigger an
  early `ZIME_CreateDataStream` / `Channel does not exist` failure.

Not implemented yet:

- A full RAP/ZIME/SPICE protocol runner that completes SPICE link/auth/display
  setup and keeps the family desktop alive without the official GUI client.
- A successful real cloud RAP/ZIME handshake through the new UDP-backed native
  transport, including `native_channel_created` / channel-active evidence.
- User stream creation and `ZIME_SendData(DISPLAY_INIT)` after the native
  channel is truly established.

## Rejected Routes

Pure SOHO HTTP visible timers are rejected as keepalive. Long tests showed
`heartbeat/infoReport/logConfig` could return accepted responses while the VM
still powered off.

CAG HTTPS refresh is rejected as keepalive. It is retained only for boot and
connection-material research. It can replace an official desktop session, and
independent monitoring saw shutdown during the CAG + HTTP-prime test.

Do not treat accepted HTTP responses, CAG `connectStr`, or a temporary
`运行中` status after CAG as success. Success requires the cloud desktop to stay
running past the idle shutdown window under independent per-minute monitoring.

## References

Primary protocol direction:

- <https://codming.com/posts/cmcc-cloud-computer-keepalive/>

Methodology reference only, not a family-edition protocol source:

- <https://hansiy.net/p/86b7133e>

The family Linux route differs from the macOS/enterprise examples. Captures and
the installed Linux client decide the implementation, not assumptions copied
from another edition.

Handoff for the next agent:

- [docs/delivery-handoff.md](docs/delivery-handoff.md)

## Configuration

All tunable values are environment variables with sensible defaults.  Copy
[`.env.example`](.env.example) to `.env` and adjust as needed — `.env` is
git-ignored so real credentials never enter version control.

Key variables:

| Variable | Default | Purpose |
|---|---|---|
| `CMCC_ALIVE_STATE` | `.tmp/state.json` | Login / selection state cache path |
| `CMCC_ALIVE_PROFILE` | `linux` | Client profile (linux/windows/mac) |
| `CMCC_ZTE_TARGET_VMID` | research target UUID | Target cloud-PC VM ID |
| `CCK_ZTE_KEEPALIVE_DURATION` | `120` | ZTE keepalive interval (seconds) |
| `CCK_ZTE_CAG_AUTH_TEMPLATE_HEX` | *(empty)* | Pre-captured CAG auth template (hex) |
| `CMCC_SCG_BINARY` | *(empty)* | Path to Go-compiled SCG keepalive binary |
| `CMCC_ZIME_LIB` | bundled default | Path to `libZIMEDataEngine.so` |
| `BBS_API_KEY` | *(empty)* | Internal BBS API key (live-run reports) |
| `BBS_MASTER_TOKEN` | *(empty)* | Internal BBS master token |

## Basic Commands

Run tests:

```bash
python3 -m unittest discover -s tests -p 'test_python_*.py' -v
```

Login and cache credentials. Omit the password argument so it is entered via hidden prompt; avoid putting plaintext passwords in shell history:

```bash
CMCC_ALIVE_STATE=.tmp/state.json python3 bin/cmcc_cloud_alive.py login <username> --save-password
```

List and select a desktop:

```bash
CMCC_ALIVE_STATE=.tmp/state.json python3 bin/cmcc_cloud_alive.py list
CMCC_ALIVE_STATE=.tmp/state.json python3 bin/cmcc_cloud_alive.py select <userServiceId>
```

Check cloud power state:

```bash
CMCC_ALIVE_STATE=.tmp/state.json python3 bin/cmcc_cloud_alive.py status <userServiceId>
```

Independent power monitor:

```bash
CMCC_ALIVE_STATE=.tmp/state.json scripts/power-monitor.sh <userServiceId> \
  --duration 2400 \
  --interval 60 \
  --stop-on-off \
  --report-file reports/power-monitor-40min.json
```

Run any protocol experiment under mandatory independent verification:

```bash
CMCC_ALIVE_STATE=.tmp/state.json scripts/verified-run.sh \
  --duration 2400 \
  --interval 60 \
  --report-file reports/<experiment>.verified.json \
  <userServiceId> -- <protocol-runner-command>
```

Offline SPICE codec proof:

```bash
python3 bin/cmcc_cloud_alive.py spice-offline-proof
```

`run --strategy auto` now resolves to the SPICE protocol target and exits with
a clear not-implemented error until the real RAP/ZIME/SPICE runner exists.

## ZIME Probe

Build the probe:

```bash
scripts/build-zime-probe.sh
```

Run an official client or SDK command under the probe:

```bash
ZIME_PROBE_LOG=reports/zime-official.jsonl \
  scripts/run-zime-probe.sh -- <official-client-or-sdk-command>
```

The default `ZIME_PROBE_MODE=low` is intentionally conservative after the
2026-07-03 `SPICE_OUTBAND` crash investigation: it only interposes exported
ZIME C API boundaries, defaults to `ZIME_PROBE_PROCESS_FILTER=uSmartView`, and
does not export libc socket/read/write/send/recv, SSL, or C++ callback symbols.
Use explicit modes only when the next capture needs deeper transport evidence:

```bash
ZIME_PROBE_MODE=transport scripts/run-zime-probe.sh -- <official-client-or-sdk-command>
ZIME_PROBE_MODE=callback scripts/run-zime-probe.sh -- <official-client-or-sdk-command>
ZIME_PROBE_MODE=full scripts/run-zime-probe.sh -- <official-client-or-sdk-command>
ZIME_PROBE_MODE=cpp scripts/run-zime-probe.sh -- <official-client-or-sdk-command>
```

`transport/full/cpp` use separate `.so` outputs so a high-intrusion build does
not silently affect later low-intrusion runs.

Analyze a probe log:

```bash
python3 bin/cmcc_cloud_alive.py analyze-zime-probe reports/zime-official.jsonl \
  --report-file reports/zime-official.analysis.json
```

Analyze RAP/ZIME transport and produce runner input:

```bash
python3 bin/cmcc_cloud_alive.py analyze-rap-zime reports/zime-official.jsonl \
  --report-file reports/rap-zime-runner-input.json
```

The report includes `runnerInput.observedTransports`. Treat it as usable
RAP/ZIME UDP runner input only when `rapZimeUdpObserved=true` and a tunnel ID is
present. A `family-native-spice-trace-only` result means the probe saw local
native/SPICE activity but did not capture the RAP/ZTEC UDP tunnel parameters.

Short RAP/ZIME UDP transport probe:

```bash
python3 bin/cmcc_cloud_alive.py rap-zime-udp-probe \
  --runner-input reports/rap-zime-runner-input.json \
  --target <host:port>
```

This probe validates the outer UDP transport only. It is not a desktop
keepalive proof.

Inspect the native ZIME bridge without running native code:

```bash
python3 bin/cmcc_cloud_alive.py zime-native-bridge
```

Offline native experiment with fake external transport callbacks only:

```bash
python3 bin/cmcc_cloud_alive.py zime-native-bridge \
  --display-init \
  --allow-native-run \
  --report-file reports/zime-native-bridge-display-init.json
```

Even a successful native bridge report is research evidence only. It still must
be followed by a real protocol runner and `verified-run`. With fake transport,
the default channel-created wait is expected to stop at
`native_channel_created_pending`; use `--wait-channel-created-ticks 0` only when
you need to compare the older immediate stream-creation behavior.

Experimental UDP-backed native transport, still not a keepalive proof:

```bash
python3 bin/cmcc_cloud_alive.py zime-native-bridge \
  --allow-native-run \
  --read-iov-payload \
  --runner-input reports/rap-zime-runner-input.json
```

`--runner-input` auto-fills the RAP UDP target, tunnel ID, RAP wire mode, and
channel-context remote address. `--udp-transport-target` and
`--udp-rap-tunnel-id` remain available for explicit overrides. By default the
bridge performs extra `ZIME_DataChannelProcess2` / UDP-drain ticks waiting for
`native_channel_created` before stream creation. Use
`--wait-channel-created-ticks 0` only for legacy offline probing.

The report includes `nativeMilestones`, which summarizes whether the probe
reached packet-out, UDP send/receive, `ZIME_ReceiveData`,
`native_channel_created`, user stream creation, and `DISPLAY_INIT`. A milestone
summary is still diagnostic only; it is not a keepalive proof.

Use `--udp-transport-mode raw` only when testing a raw native ZIME UDP endpoint.
For the family Linux path, RAP wrapping is the expected experiment boundary,
but the exact payload wrapper and reserve bytes still need live validation. The
RAP data-frame payload can now be varied with
`--udp-rap-payload-envelope raw|len16|strip-reserve4-len16`:

- `raw` keeps the previous behavior and places the native packet-out directly
  inside the RAP data-frame payload.
- `len16` sends `uint16_le(len(native)) + native` and strips the length on
  receive before calling `ZIME_ReceiveData`.
- `strip-reserve4-len16` sends `uint16_le(len(native[4:])) + native[4:]` and
  restores a four-byte zero reserve prefix on receive.

These modes are handshake experiments only. They are still session-owning when
used against a live RAP/ZTEC target and are not keepalive proof.

Native packet-out records may contain multiple iovec segments. The default
`--udp-packet-out-iov-mode concat` preserves the original behavior and sends the
concatenated iovec payload as one datagram. Experimental
`--udp-packet-out-iov-mode split` sends each captured iovec segment as a
separate UDP/RAP datagram so live tests can compare against trace-sized RAP
data frames.

When `--runner-input` contains `rapDataFrameSendTemplates`, the default
`--udp-rap-template-mode auto` uses those observed send-side 0x81 header
templates by payload kind. `static` keeps the old single-template behavior, and
`sequence` walks the observed templates in order.

The probe logs JSONL records for:

- `ZIME_CreateDataEngine`
- `ZIME_Init`
- `ZIME_SetDataChannelCallback`
- `ZIME_SetDataExternalTransport`
- `ZIME_CreateDataChannel`
- `ZIME_CreateDataStream`
- `ZIME_SendData`
- `ZIME_SendData2`
- `ZIME_ReceiveData`
- `ZIME_DataChannelProcess2`

It records channel/stream IDs, return values, buffer lengths, payload hex
prefixes, and coarse payload classification such as `spice-link`,
`spice-display-init`, `spice-surface-create`, or `chuanyun-frame`. It does not
modify return values or inject keepalive behavior.

When callback wrapping is enabled, the probe emits `zime_packet_spec` records
for `TransportBatchImplC::OnSendData_Batch` / `ZIMETransport.OnSendData_Batch`.
The analyzer summarizes them under `zimePacketSpecs`. These entries describe
candidate iovec/socket-address fields for protected UDP packets; they are
trace-only metadata and are not replayable SPICE plaintext.

## Verification Rule

No route is considered complete until a long run satisfies all of these:

- Target is the ordinary family cloud PC.
- Official GUI client is not silently keeping the desktop alive unless the run
  is explicitly a contaminated control.
- Every minute has an independent power-state snapshot.
- No snapshot reports `已关机` or non-running.
- The run reaches at least 40 minutes.
- The protocol trace shows the display path reached at least
  `DISPLAY_INIT` and Surface/MARK or equivalent display activity.

Accepted service responses are evidence, not success.
