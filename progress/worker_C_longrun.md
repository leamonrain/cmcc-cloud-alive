# Worker-C long-run orchestration progress

Date: 2026-07-06
Worker: hive-worker-interactive-9
Claim source: master reassignment after BBS #79

## Read-only inspection results

- Checked current processes with exact command-line filtering: no active `tests/long_keepalive_test.py`, `cmcc_cloud_alive keepalive`, or project MQTT long-run process was found.
- Found reusable state at `/home/demo/.cmcc-cloud-alive/state.json`; no plaintext credential file was read or written.
- Reviewed `tests/long_keepalive_test.py`, `reports/T2-C_validation_plan.md`, `reports/T3-C_mqtt_keepalive_implementation.md`, and `reports/T3-MQTT_impl.md`.
- Existing evidence says prior HTTP keepalive long test powered off around the 45-minute milestone; MQTT implementation exists but no 120-minute proof has been run.

## Script hardening completed

Updated `tests/long_keepalive_test.py` for resumable execution evidence:

- Runtime knobs can now be overridden by environment variables:
  - `CMCC_KEEPALIVE_INTERVAL` default `300` seconds.
  - `CMCC_KEEPALIVE_BURST` default `60` seconds.
  - `CMCC_POWER_INTERVAL` default `60` seconds.
  - `CMCC_LONGTEST_MILESTONES` default `40,60,120` minutes.
  - `CMCC_LONGTEST_TOTAL_MIN` default max milestone / `120` minutes.
- Added `T1.2-C_longtest_checkpoint.json` under `CMCC_LONGTEST_REPORT_DIR`.
- Checkpoint is written at start, after every keepalive burst, after every power sample, after every milestone post, and at final completion.
- Final `T1.2-C_longtest_result.json` and checkpoint now share the same report structure.

Validation:

```bash
cd /home/demo/restore/cmcc-cloud-alive
python3 -m py_compile tests/long_keepalive_test.py
```

Result: pass.

## Long-run execution plan

Use the reusable state path and sanitized report directory:

```bash
cd /home/demo/restore/cmcc-cloud-alive
CMCC_STATE_PATH=/home/demo/.cmcc-cloud-alive/state.json \
CMCC_LONGTEST_REPORT_DIR=/home/demo/restore/cmcc-cloud-alive/reports/worker_C_longrun \
python3 tests/long_keepalive_test.py
```

Expected behavior:

- Reuses existing state if valid; only falls back to `CMCC_USERNAME` / `CMCC_PASSWORD` when no state exists.
- Sends one 60-second keepalive/screen-traffic burst every 5 minutes.
- Samples desktop power state once per minute.
- Posts BBS node reports at 40, 60, and 120 minutes.
- Writes local sanitized JSON/Markdown evidence continuously.

## Current execution status

- Not started in this worker turn because the required proof run is 120 minutes and should be launched under an intentionally long-lived runner/watchdog to avoid truncating evidence when the interactive worker session is recycled.
- There is no active long-run process to preserve or attach to at the time of inspection.
- Ready to start with the command above once master confirms this worker should occupy the next 120+ minutes, or under a scheduled/watchdog wrapper.
