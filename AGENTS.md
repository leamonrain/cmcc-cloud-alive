# AGENTS.md — cmcc-cloud-alive

## Entrypoints

- **CLI** `python3 -m cmcc_cloud_alive` (or `cmcc-cloud-alive` after editable install)
- **WebUI** `uvicorn cmcc_cloud_alive.webui.app:app` (or `cmcc-cloud-webui`)

Module entry: `cmcc_cloud_alive/__main__.py` → `main.py:main()`.

## Project layout

```
cmcc_cloud_alive/          # Python package (editable install via pip install -e .)
  webui/
    app.py                 # Starlette ASGI app (~1800 lines)
    orchestrator.py        # Subprocess job orchestrator (~1000 lines)
    static/                # SPA shell (app.js, app.css, index.html)
  main.py                  # CLI entry
  other_*.py               # Protocol modules (ZTE, SCG, CAG, SPICE, etc.)
docker/
  Dockerfile               # python:3.11-slim, offline wheel install
  docker-compose.yml       # Container: port 28080 → 8080, volume cmcc_data
  entrypoint.sh            # Starts uvicorn or CLI
  wheels/                  # Pre-built py3.11 manylinux wheels (offline)
```

## Key dependencies

- **Runtime:** Python stdlib only (requirement: `cryptography>=3.4`)
- **WebUI optional:** `pip install -e ".[web]"` → starlette + uvicorn
- **Docker image:** non-editable install from local tree, offline wheels only
- **Python >=3.10** required

## WebUI architecture

- Starlette ASGI app with SSE, REST CRUD for profiles, static file serving
- Two orchestrator implementations: `FakeOrchestrator` (in-memory, in app.py) swapped for real `Orchestrator` (subprocess-based, in orchestrator.py)
- Orchestrator per-profile single job constraint (`PROFILE_IN_USE`)
- Multi-desktop flow: per-desktop `select-desktop` + single `/jobs` POST
- Protocol per desktop: ZTE or SCG; fallback logic in `app.js:startKeepalive`

## Common commands

```bash
# WebUI dev (no Docker)
uvicorn cmcc_cloud_alive.webui.app:app --host 127.0.0.1 --port 18080

# Run keepalive job (from orchestrator test)
python3 -c "
from cmcc_cloud_alive.webui.orchestrator import Orchestrator
import asyncio; asyncio.run(Orchestrator().start_job('profile_id', protocol='ZTE', mode='live'))
"

# Docker
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f cmcc-webui
docker compose -f docker/docker-compose.yml run --rm cmcc-webui cmcc-cloud-alive --help

# Test (no tests currently)
python3 -m unittest discover -s tests -p 'test_python_*.py' -v  # tests dir is gitignored

# Health check
curl http://127.0.0.1:28080/api/health
```

LSP checks:
```bash
# Python
~/.local/bin/pylsp --stdio   # LSP protocol on stdin/stdout
# JS syntax only (no JS LSP available; Node 18, tls requires Node >=20)
node --check cmcc_cloud_alive/webui/static/app.js
```

## Environment quirks

| Env var | Purpose |
|---------|---------|
| `CMCC_DATA_DIR` | Override data root (default: `$HOME/.cmcc-cloud-alive`) |
| `CMCC_ALIVE_HOME` | Legacy home override (Docker: `/data`) |
| `CMCC_WEBUI_TOKEN` | Optional Bearer token for API access (set in `.env`, never commit) |
| `CMCC_HOST_PORT` | Docker host port mapping (default 28080) |
| `CMCC_WEBUI_ALLOW_LIVE` | Set `=1` to enable real subprocess keepalive (default off) |
| `CMCC_ENFORCE_PIN` | Developer-only: pin to specific product ID |

- **No HTTP proxy:** Container must connect directly to CMCC APIs. Do not inject `HTTP(S)_PROXY`.
- **State directory:** `~/.cmcc-cloud-alive/` (CLI) or `/data/.cmcc-cloud-alive/` (Docker). Contains `profiles/`, `locks/`, `jobs/`, `run/`.
- **Token auto-refresh:** Expired tokens are refreshed automatically from saved credentials. No manual token management needed.
- **WebUI default is live mode** — no `LIVE` gate required.

## WebUI bug patterns (app.js)

- Protocol selection must persist to both `state.deskProtocol[pid][did]` and server profile via `PUT /api/profiles/:pid`
- `startKeepalive` reads `state.deskProtocol[pid][did]` with fallback to `state.drafts[pid].protocol`
- `startOne` (status page) must sync draft protocol into deskProtocol before calling `startKeepalive`
- Multi-desktop: each desktop calls `select-desktop`, followed by one `/jobs` POST per profile
- Modal visibility: use `.hidden` class consistently (not `style.display`)

## Key data model (profile JSON)

```json
{ "id": "uuid", "displayName": "...", "username": "...",
  "hasPassword": true, "usernameMasked": "138****",
  "protocol": "ZTE|SCG", "mode": "live", "status": "idle|running|error" }
```

State (client-side in `app.js`): `state.profiles`, `state.drafts[pid]`, `state.deskProtocol[pid][did]`, `state.selectedDesktops[pid]`.

## FNOS packaging notes

- Target: FPK native package via CGI proxy (`index.cgi` → urllib → `127.0.0.1:18080`)
- Requires offline dependency bundling for FNOS Python 3.11
