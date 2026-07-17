# AGENTS.md — cmcc-cloud-alive

## Entrypoints

- **CLI** `python3 -m cmcc_cloud_alive` or `cmcc-cloud-alive` (editable install)
- **CLI simple-alive** `python3 -m cmcc_cloud_alive simple-alive <userServiceId> --username <账号> --password <密码>`
- **CLI interactive** `python3 -m cmcc_cloud_alive interactive` (zh-CN prompts)
- **WebUI** `uvicorn cmcc_cloud_alive.webui.app:app` or `cmcc-cloud-webui`

Module entry: `cmcc_cloud_alive/__main__.py` → `main.py:main()`.

## Two code trees (stale mirror alert)

| Tree | Purpose |
|------|---------|
| `cmcc_cloud_alive/` | Primary source — edit here |
| `fpk/app/src/cmcc_cloud_alive/` | FPK packaging mirror — often stale; sync after source changes |

If you fix something in the primary source, check whether the FPK mirror needs the same fix.

## Runtime

- **Python >=3.10, stdlib only** (cryptography >=3.4 is the sole hard dep)
- **WebUI optional deps:** starlette + uvicorn (`pip install -e ".[web]"`)
- **Docker image:** python:3.11-slim, pre-built cp311 manylinux wheels in `docker/wheels/`, non-editable install from local tree, offline-only (no network at `pip install` time)
- Build backend: setuptools (pyproject.toml)

## Architecture

### Package layout

```
cmcc_cloud_alive/
  main.py                  # CLI argparser + dispatch (~1240 lines of cmd_* funcs)
  core.py                  # Shared state, data dir, proxy bypass, auth crypto (~2600 lines)
  webui/
    app.py                 # Starlette ASGI app (~1700 lines, REST + SPA shell)
    orchestrator.py        # Subprocess job orchestrator (~830 lines)
    static/                # Single-page frontend: app.js, app.css, index.html
  keepalive_simple.py      # simple-alive CLI command
  keepalive_v2.py / v3.py  # Historical keepalive variants
  cag_keepalive.py         # CAG TCP keepalive loop
  desktop_keepalive.py     # Desktop HTTP session replay
  zte_*.py                 # ZTE protocol (cag, connect_params, raw_spice, route, security)
  scg_route.py             # SCG dispatch
  spice_protocol.py        # SPICE mini-protocol codec
  rap_zime.py              # RAP/ZIME tunnel research
  protocol_runner.py       # Protocol detection router
  product_router.py        # Firm-auth route classifier
  auth.py / token.py       # CMCC auth flow
  cloud.py                 # Cloud PC list/status API
```

### WebUI

- Starlette ASGI app with REST CRUD for profiles, static file serving, **no SSE** (front-end polls)
- Two backends swapped at import time in `app.py:_load_orchestrator()`:
  - **FakeOrchestrator** (in-memory, in app.py) — default when `cmcc_cloud_alive.webui.orchestrator` import fails
  - **Orchestrator** (subprocess-based, orchestrator.py) — REAL keepalive, requires `CMCC_WEBUI_ALLOW_LIVE=1`
- Orchestrator per-desktop single job constraint (composite key: `"{profile_id}:{desktop_id}"`)
- Multi-desktop: each desktop calls `select-desktop`, then one `/jobs` POST
- Docker entrypoint (`entrypoint.sh`) falls back to `webui_placeholder.py` if the real app module isn't importable
- Backend data dir resolution chain: `CMCC_DATA_DIR` → `$CMCC_ALIVE_HOME/.cmcc-cloud-alive` → `$HOME/.cmcc-cloud-alive`

### CLI

- `main.py:cmd_interactive()` is the productized flow: login → select desktop → keepalive loop with backoff
- `simple-alive` is a non-interactive one-shot: login → boot if off → CAG TCP keepalive loop with auto-reconnect
- `protocol_runner.run()` is the protocol detection + selection path

## Critical quirks & gotchas

### Proxy bypass (core.py, import-time side effect)

`core.py` clears all `HTTP_PROXY` / `HTTPS_PROXY` env vars at module import time and sets `NO_PROXY=*`. This is intentional — CMCC APIs must be reached directly. Any change to proxy handling must be aware of this.

### CMCC_WEBUI_ALLOW_LIVE gate

The real `Orchestrator` requires `CMCC_WEBUI_ALLOW_LIVE=1` (checked by `live_allowed()` in orchestrator.py:35). Docker compose and FNOS `fpk/cmd/main` set this. Local dev `uvicorn` does NOT — you'll get `FakeOrchestrator` in-memory dry-run.

### FNOS lifecycle (TRIM_* env vars)

`fpk/cmd/main` is the FNOS service manager entry. FNOS injects `TRIM_PKGVAR`, `TRIM_SERVICE_PORT`, etc. as env vars.

**Key quirk:** The script uses `test -d /proc/$PID` for PID-alive checks, **not** `kill -0`. Reason: `kill -0` on a root-owned process fails with EPERM when called by FNOS as non-root (CMCCCloudAlive user). The `/proc` check works for any user. This also applies to any agent writing FNOS lifecycle scripts.

### No tests

The `tests/` directory is gitignored. There are no unit tests. The project relies on manual verification on a live NAS.

## FNOS packaging

- Manifest at `fpk/manifest`: `service_port=18080`, `ctl_stop=true`, depends on `python312`
- `fpk/cmd/install_callback` creates a venv via `venv.create()` and `pip install -r src/requirements.txt`
- `fpk/cmd/config/privilege` sets `run-as: package` (FNOS runs lifecycle scripts as root)
- CGI proxy at `fpk/app/ui/proxy.py` is a fallback entry (PHP-style CGI → urllib → `127.0.0.1:18080`) — not the primary path
- `fpk/cmd/main` uses `port_in_use()` / `pid_alive()` functions with `/proc` check (not `kill -0`) — see quirk above

## Docker

```bash
# Build and start
docker compose -f docker/docker-compose.yml up -d --build

# Run CLI inside the same image
docker compose -f docker/docker-compose.yml run --rm cmcc-webui cmcc-cloud-alive --help

# Host port: default 28080, override via CMCC_HOST_PORT
```

- Container runs as non-root uid 10001 (`cmcc` user)
- Data persistent in `cmcc_data` volume mounted at `/data`
- Offline pip install from `docker/wheels/` (cp311 manylinux)
- Healthcheck: `/api/health` via Python urllib
- Resource limits: 1536m memory, 2.0 CPUs

## WebUI SPA bug patterns (app.js)

Keep these when editing `cmcc_cloud_alive/webui/static/app.js`:

- Protocol selection must persist to both `state.deskProtocol[pid][did]` AND server profile via `PUT /api/profiles/:pid`
- `startKeepalive` reads `state.deskProtocol[pid][did]` with fallback to `state.drafts[pid].protocol`
- `startOne` (status page) must sync draft protocol into deskProtocol before calling `startKeepalive`
- Multi-desktop: each desktop calls `select-desktop`, followed by one `/jobs` POST per profile
- Modal visibility: use `.hidden` class consistently (not `style.display`)

## Environment variables

| Var | Purpose |
|-----|---------|
| `CMCC_DATA_DIR` | Override data root (default: `$HOME/.cmcc-cloud-alive`) |
| `CMCC_ALIVE_HOME` | Legacy home override for Docker (`/data`) |
| `CMCC_WEBUI_TOKEN` | Optional Bearer token for API auth (set in `.env`, never commit) |
| `CMCC_WEBUI_ALLOW_LIVE` | `=1` enables real subprocess keepalive in WebUI |
| `CMCC_ENFORCE_PIN` | Developer-only: pin to specific product ID (default off) |
| `CMCC_HOST_PORT` | Docker host port mapping (default 28080) |
| `TRIM_PKGVAR` | FNOS: app data directory |
| `TRIM_SERVICE_PORT` | FNOS: service port (default 18080) |

- **No HTTP proxy:** cleared at `core.py` import time. Do not inject `HTTP(S)_PROXY`.
- **State directory:** `~/.cmcc-cloud-alive/` (CLI) or `/data/.cmcc-cloud-alive/` (Docker). Contains `profiles/`, `locks/`, `jobs/`, `run/`.
- **Token auto-refresh:** expired tokens are refreshed automatically from saved credentials.

## Data model (profile JSON)

```json
{ "id": "uuid", "displayName": "...", "username": "...",
  "hasPassword": true, "usernameMasked": "138****",
  "protocol": "ZTE|CAG|SCG|V3", "mode": "live|once", "status": "idle|running|error" }
```

## Systemd service

Templates at `bin/cmcc-alive.service` (adjust username/password/userServiceId before use).
