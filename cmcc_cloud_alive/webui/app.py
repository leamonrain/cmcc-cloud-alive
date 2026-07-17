"""Starlette WebUI for multi-profile per-desktop keepalive orchestration (FNOS).

Parent process only: REST + static shell. No SSE (front-end polls).
Uses in-memory FakeOrchestrator until real Orchestrator is available.
Per-desktop composite keys "{profile_id}:{desktop_id}" for parallel jobs.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Paths / env
# ---------------------------------------------------------------------------

_STATIC_DIR = Path(__file__).resolve().parent / "static"

def _data_dir() -> Path:
    """Unified durable root shared with CLI (X8).

    Priority:
    1. CMCC_DATA_DIR if set (explicit override; may point at either the
       package root or the final data root)
    2. else ``$CMCC_ALIVE_HOME|HOME|~/.cmcc-cloud-alive`` — always the
       ``.cmcc-cloud-alive`` package dir so Docker HOME=/data matches
       entrypoint + core DEFAULT_DATA_DIR (``/data/.cmcc-cloud-alive``).
    """
    explicit = os.environ.get("CMCC_DATA_DIR")
    if explicit:
        p = Path(explicit)
        # Accept either the package root or the volume root.
        if p.name == ".cmcc-cloud-alive":
            return p
        # Common Docker mistake: CMCC_DATA_DIR=/data — nest under package dir.
        return p / ".cmcc-cloud-alive"
    raw = os.environ.get("CMCC_ALIVE_HOME") or os.environ.get("HOME") or str(Path.home())
    home = Path(raw)
    if home.name == ".cmcc-cloud-alive":
        return home
    return home / ".cmcc-cloud-alive"


_LEGACY_PROFILES_MIGRATED = False


def _legacy_profiles_dirs(unified: Path) -> List[Path]:
    """Pre-X8 WebUI wrote profiles under /data/profiles when HOME=/data."""
    candidates: List[Path] = []
    # Sibling of package root: /data/profiles next to /data/.cmcc-cloud-alive
    sibling = unified.parent / "profiles"
    if sibling != (unified / "profiles"):
        candidates.append(sibling)
    # Bare CMCC_DATA_DIR=/data historical
    bare = Path("/data/profiles")
    if bare not in candidates:
        candidates.append(bare)
    return candidates


def _migrate_legacy_profiles(dest: Path) -> int:
    """Copy missing profile JSON from legacy roots into unified profiles/.

    Never overwrites a newer/same-name file already in dest. Returns count
    of files copied. Best-effort; failures are non-fatal.
    """
    global _LEGACY_PROFILES_MIGRATED
    moved = 0
    try:
        dest.mkdir(parents=True, exist_ok=True)
        for legacy in _legacy_profiles_dirs(dest.parent):
            if not legacy.is_dir():
                continue
            if legacy.resolve() == dest.resolve():
                continue
            for src in legacy.glob("*.json"):
                target = dest / src.name
                if target.exists():
                    continue
                try:
                    target.write_bytes(src.read_bytes())
                    try:
                        os.chmod(target, 0o600)
                    except OSError:
                        pass
                    moved += 1
                except OSError:
                    continue
    finally:
        _LEGACY_PROFILES_MIGRATED = True
    return moved


def profiles_dir() -> Path:
    d = _data_dir() / "profiles"
    d.mkdir(parents=True, exist_ok=True)
    # One-shot best-effort migration so old /data/profiles stay visible.
    if not _LEGACY_PROFILES_MIGRATED:
        _migrate_legacy_profiles(d)
    return d


def _now_iso() -> str:
    # HARD_GATE#861: force Asia/Shanghai so API/orch timestamps match child short_time
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
    except Exception:
        return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

try:
    from cmcc_cloud_alive.core import SENSITIVE_REPORT_KEYS as _CORE_SENSITIVE
except Exception:  # pragma: no cover — package may be partial in unit smoke
    _CORE_SENSITIVE = {
        "accessToken",
        "authorization",
        "authPayload",
        "clientId",
        "connectStr",
        "cpsid",
        "jwt",
        "password",
        "sohoToken",
        "token",
    }

_SENSITIVE_LOWER = {k.lower() for k in _CORE_SENSITIVE} | {
    "refreshtoken",
    "accesstoken",
    "sohotoken",
    "authorization",
}


def _mask_username(u: Optional[str]) -> str:
    if not u:
        return ""
    s = str(u)
    if len(s) <= 4:
        return "*" * len(s)
    return s[:3] + "****" + s[-2:]


def redact_obj(value: Any, key: str = "") -> Any:
    if key and key.lower() in _SENSITIVE_LOWER:
        return "<redacted>"
    if isinstance(value, dict):
        return {k: redact_obj(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_obj(v, key) for v in value]
    return value


def api_error(code: str, message: str, status: int = 400, next_step: str = "") -> JSONResponse:
    body: Dict[str, Any] = {
        "ok": False,
        "error": {"code": code, "message": message},
    }
    if next_step:
        body["error"]["nextStep"] = next_step
    return JSONResponse(body, status_code=status)


# WAVE7 frozen contract: intervalSec/trafficSec/durationSec -> CLI flags
_DEFAULT_INTERVAL_SEC = 300
_DEFAULT_TRAFFIC_SEC = 60
_DEFAULT_DURATION_SEC = 0


def _parse_positive_int(raw: Any, field: str, *, allow_zero: bool = False) -> int:
    """Parse body field as int. allow_zero=True for durationSec (0=forever)."""
    try:
        if isinstance(raw, bool):
            raise ValueError
        val = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be an integer")
    if allow_zero:
        if val < 0:
            raise ValueError(f"{field} must be >= 0")
    elif val <= 0:
        raise ValueError(f"{field} must be > 0")
    return val


def parse_job_timing_fields(body: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Parse optional timing fields; missing -> defaults. Returns fields + extraArgs.

    Accepts FE alias ``intervalMin`` (minutes) when ``intervalSec`` is absent.
    """
    body = body or {}
    if "intervalSec" in body and body.get("intervalSec") is not None:
        interval = _parse_positive_int(body.get("intervalSec"), "intervalSec")
    elif "intervalMin" in body and body.get("intervalMin") is not None:
        # FE draft uses minutes; convert to seconds for orchestrator/CLI.
        minutes = _parse_positive_int(body.get("intervalMin"), "intervalMin")
        interval = minutes * 60
    else:
        interval = _DEFAULT_INTERVAL_SEC
    if "trafficSec" in body and body.get("trafficSec") is not None:
        traffic = _parse_positive_int(body.get("trafficSec"), "trafficSec")
    else:
        traffic = _DEFAULT_TRAFFIC_SEC
    if "durationSec" in body and body.get("durationSec") is not None:
        duration = _parse_positive_int(body.get("durationSec"), "durationSec", allow_zero=True)
    else:
        duration = _DEFAULT_DURATION_SEC
    # simple-keepalive argv (align Python menu): minutes + traffic seconds + mode
    # mode "1"=单轮, "2"=永久. durationSec==0 => forever; >0 => single round.
    interval_minutes = max(1, int(interval) // 60)
    simple_mode = "2" if int(duration) == 0 else "1"
    body_mode = str((body or {}).get("mode") or "").lower()
    if body_mode in ("once", "single", "dry-run", "dryrun"):
        simple_mode = "1"
    elif body_mode in ("live", "forever", "permanent", "loop"):
        if int(duration) == 0:
            simple_mode = "2"
    extra_args = [
        "--heartbeat-interval",
        str(interval),
        "--duration",
        str(duration),
    ]
    return {
        "intervalSec": interval,
        "trafficSec": traffic,
        "durationSec": duration,
        "extraArgs": extra_args,
    }


# ---------------------------------------------------------------------------
# Token middleware (optional CMCC_WEBUI_TOKEN)
# ---------------------------------------------------------------------------

class OptionalTokenMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        expected = os.environ.get("CMCC_WEBUI_TOKEN") or ""
        path = request.url.path
        # Always open: health aliases (compose/X2/T3) + static + root shell
        # FLAG#59: /api/health must match docker HEALTHCHECK
        open_exact = {
            "/",
            "/index.html",
            "/health",
            "/api/health",
            "/api/system/health",
            # X9: allow FE to discover tokenRequired before Bearer/localStorage is set
            "/api/system/info",
            "/api/info",
        }
        open_prefixes = ("/static/", "/favicon")
        if path in open_exact or path.startswith(open_prefixes):
            return await call_next(request)
        if not expected:
            return await call_next(request)
        auth = request.headers.get("authorization") or ""
        token = ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        if not token:
            token = request.headers.get("x-api-token") or request.query_params.get("token") or ""
        if not secrets.compare_digest(token, expected):
            return api_error(
                "AUTH_FAILED",
                "invalid or missing CMCC_WEBUI_TOKEN",
                401,
                next_step="请在请求头携带有效 Bearer/CMCC_WEBUI_TOKEN 后重试",
            )
        return await call_next(request)


# ---------------------------------------------------------------------------
# Fake orchestrator (stable shape for J2 swap)
# ---------------------------------------------------------------------------

class FakeOrchestrator:
    """In-memory job table. Per-desktop composite keys; no SSE."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._by_key: Dict[str, str] = {}
        self._log_buffers: Dict[str, List[Dict[str, str]]] = {}

    def _job_key(self, profile_id: str, desktop_id: str) -> str:
        return f"{profile_id}:{desktop_id}"

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(j) for j in self._jobs.values()]

    def get_status(self, profile_id: str, desktop_id: str) -> Dict[str, Any]:
        key = self._job_key(profile_id, desktop_id)
        with self._lock:
            jid = self._by_key.get(key)
            if not jid:
                return {"profileId": profile_id, "desktopId": desktop_id, "status": "idle", "jobId": None}
            j = self._jobs.get(jid) or {}
            return {"profileId": profile_id, "desktopId": desktop_id, "jobId": jid,
                    "status": j.get("status", "unknown"), "protocol": j.get("protocol"),
                    "pid": j.get("pid"), "startedAt": j.get("startedAt")}

    def get_statuses(self, profile_id: str) -> List[Dict[str, Any]]:
        out = []
        prefix = profile_id + ":"
        with self._lock:
            for key, jid in self._by_key.items():
                if not key.startswith(prefix):
                    continue
                did = key[len(prefix):]
                j = self._jobs.get(jid) or {}
                out.append({"profileId": profile_id, "desktopId": did, "jobId": jid,
                            "status": j.get("status", "idle"), "protocol": j.get("protocol"),
                            "pid": j.get("pid"), "startedAt": j.get("startedAt")})
        return out

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            j = self._jobs.get(job_id)
            return dict(j) if j else None

    def start_job(self, profile_id: str, desktop_id: str, state_path: Path,
                  protocol: str = "ZTE", extra_args: Optional[List[str]] = None,
                  mode: str = "live", interval_sec: Optional[int] = None,
                  traffic_sec: Optional[int] = None,
                  duration_sec: Optional[int] = None) -> Dict[str, Any]:
        protocol = (protocol or "ZTE").upper()
        if protocol not in ("ZTE", "SCG", "V3"):
            raise ValueError("protocol must be ZTE, SCG, or V3")
        key = self._job_key(profile_id, desktop_id)
        with self._lock:
            existing = self._by_key.get(key)
            if existing and self._jobs.get(existing, {}).get("status") == "running":
                raise RuntimeError("JOB_IN_USE")
            job_id = uuid.uuid4().hex[:12]
            job = {"id": job_id, "jobId": job_id, "profileId": profile_id, "desktopId": desktop_id,
                   "statePath": str(state_path), "protocol": protocol, "mode": mode or "live",
                   "status": "running", "pid": None, "startedAt": _now_iso(), "stoppedAt": None,
                   "detail": "fake orchestrator dry-run (no LIVE child)",
                   "extraArgs": list(extra_args or []), "intervalSec": interval_sec,
                   "trafficSec": traffic_sec, "durationSec": duration_sec}
            self._jobs[job_id] = job
            self._by_key[key] = job_id
            self._log_buffers.setdefault(job_id, []).append(
                {"at": _now_iso(), "line": f"[fake] start {protocol} mode={job['mode']} desktop={desktop_id}"})
            return dict(job)

    def stop_job(self, profile_id: str, desktop_id: str) -> Dict[str, Any]:
        key = self._job_key(profile_id, desktop_id)
        with self._lock:
            jid = self._by_key.get(key)
            if not jid or jid not in self._jobs:
                raise KeyError("NOT_FOUND")
            job = self._jobs[jid]
            if job.get("status") != "running":
                return dict(job)
            job["status"] = "stopped"
            job["stoppedAt"] = _now_iso()
            job["detail"] = "stopped by API"
            self._log_buffers.setdefault(jid, []).append(
                {"at": job["stoppedAt"], "line": "[fake] stop requested"})
            return dict(job)

    def stop_all(self, profile_id: str) -> List[Dict[str, Any]]:
        results = []
        prefix = profile_id + ":"
        with self._lock:
            keys = [k for k in self._by_key if k.startswith(prefix)]
        for key in keys:
            did = key[len(profile_id) + 1:]
            try:
                results.append(self.stop_job(profile_id, did))
            except KeyError:
                pass
        return results

    def recent_logs(self, profile_id: str, desktop_id: Optional[str] = None,
                    limit: int = 200) -> Dict[str, List[Dict[str, str]]]:
        with self._lock:
            prefix = profile_id + ":"
            result: Dict[str, List[Dict[str, str]]] = {}
            for key, jid in self._by_key.items():
                if not key.startswith(prefix):
                    continue
                did = key[len(prefix):]
                if desktop_id and did != desktop_id:
                    continue
                result[did] = list(self._log_buffers.get(jid, []))[-limit:]
            return result


def _load_orchestrator() -> Any:
    try:
        from cmcc_cloud_alive.webui.orchestrator import Orchestrator  # type: ignore

        return Orchestrator()
    except Exception:
        return FakeOrchestrator()


ORCH: Any = _load_orchestrator()


# ---------------------------------------------------------------------------
# Profile store (filesystem under DATA/profiles)
# ---------------------------------------------------------------------------

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_profile_id(name: str) -> str:
    name = (name or "").strip().replace(" ", "-")
    name = _SAFE_NAME.sub("-", name).strip("-._")
    if not name:
        name = "profile"
    return name[:60]


def _profile_path(profile_id: str) -> Path:
    return profiles_dir() / f"{profile_id}.json"


# HARD_GATE#868: same account shares one token/session state (like interactive).
# Card profile JSON keeps UI meta + selected userServiceId; live child uses acct_*.json.
# userId/isSubAccount/loginMode MUST sync: checkToken needs X-SOHO-UserId; re-login
# path uses isSubAccount/loginMode to pick sub vs main password login (4305/90020176).
_SHARED_ACCOUNT_KEYS = (
    "username",
    "password",
    "passwordSavedAt",
    "sohoToken",
    "token",
    "userId",
    "phone",
    "isSubAccount",
    "loginMode",
    "isLogined",
    "deviceId",
    "device_id",
    "clientProfile",
    "clientId",
    "lastLoginStatus",
    "lastLoginAttemptAt",
    "lastLoginError",
    "userServiceId",
    "selectedUserServiceId",
    "desktopLabel",
    "vmId",
    "lastVmId",
)


def _account_key(username: str) -> str:
    return _safe_profile_id(username or "unknown")


def _shared_account_path(username: str) -> Path:
    return profiles_dir() / f"acct_{_account_key(username)}.json"


def _is_shared_account_file(path: Path) -> bool:
    return path.name.startswith("acct_") and path.suffix == ".json"


def _sync_shared_account(state: Dict[str, Any]) -> Optional[Path]:
    """Merge session fields into acct_<user>.json; return shared path or None.

    HARD_GATE#868: same account shares one token. Stale per-card tokens must
    NOT clobber a good shared token on start/hydrate. Token overwrite is only
    allowed when the card just established a session (login path), or shared
    has no token yet.
    """
    username = str(state.get("username") or state.get("phone") or "").strip()
    if not username:
        return None
    shared = _shared_account_path(username)
    existing = _read_state(shared) if shared.is_file() else {}
    merged = dict(existing) if isinstance(existing, dict) else {}

    token_keys = ("sohoToken", "token")
    device_keys = ("deviceId", "device_id")

    # Non-token shared keys: non-empty card value wins (except deviceId below).
    for k in _SHARED_ACCOUNT_KEYS:
        if k in token_keys or k in device_keys:
            continue
        if k in state and state.get(k) not in (None, ""):
            merged[k] = state[k]

    # deviceId: prefer stable shared value so dual cards don't mint two devices.
    for dk in device_keys:
        card_dev = state.get(dk)
        shared_dev = merged.get(dk)
        if shared_dev in (None, "") and card_dev not in (None, ""):
            merged[dk] = card_dev
        # else keep shared / existing

    # Token policy: protect shared sohoToken from stale card overwrite.
    status = str(state.get("lastLoginStatus") or "")
    fresh_login = status in (
        "session-established",
        "session-present",
        "live-ok-no-token",
    )
    for tk in token_keys:
        card_tok = state.get(tk)
        if card_tok in (None, ""):
            continue
        shared_tok = merged.get(tk)
        if shared_tok in (None, "") or card_tok == shared_tok or fresh_login:
            merged[tk] = card_tok
        # else keep shared_tok (card is stale / partial)

    # Prefer non-empty token from either side (fill holes only).
    for tk in token_keys:
        if not merged.get(tk) and state.get(tk):
            merged[tk] = state[tk]

    merged["username"] = username
    merged["updatedAt"] = _now_iso()
    merged["sharedAccount"] = True
    _write_state(shared, merged)
    return shared


def _hydrate_profile_from_shared(state: Dict[str, Any]) -> Dict[str, Any]:
    """Fill missing token/password from shared account file (card keeps own usid)."""
    username = str(state.get("username") or state.get("phone") or "").strip()
    if not username:
        return state
    shared_path = _shared_account_path(username)
    if not shared_path.is_file():
        return state
    shared = _read_state(shared_path)
    if not shared:
        return state
    out = dict(state)
    for k in _SHARED_ACCOUNT_KEYS:
        if k in ("username",):
            continue
        if (not out.get(k)) and shared.get(k):
            out[k] = shared[k]
    return out


def _resolve_live_state_path(profile_path: Path, state: Dict[str, Any]) -> Path:
    """Path passed to child --state: shared acct file when username known."""
    username = str(state.get("username") or state.get("phone") or "").strip()
    if not username:
        return profile_path
    shared = _sync_shared_account(state)
    return shared if shared is not None else profile_path


def _card_user_service_id(state: Dict[str, Any]) -> str:
    usid = (
        state.get("userServiceId")
        or state.get("selectedUserServiceId")
        or state.get("user_service_id")
        or ""
    )
    return str(usid) if usid else ""


def _read_state(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_state(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _public_profile(profile_id: str, state: Dict[str, Any], path: Path) -> Dict[str, Any]:
    spu = state.get("spuCode") or state.get("lastSpuCode") or ""
    spu = str(spu) if spu is not None else ""
    official = state.get("lastOfficialProtocol") or state.get("protocolHint") or ""
    official = str(official).upper() if official else ""
    if not official and spu:
        official = _spu_protocol_hint(spu)
    statuses = ORCH.get_statuses(profile_id) if hasattr(ORCH, "get_statuses") else []
    any_running = any(s.get("status") == "running" for s in statuses)
    return {
        "id": profile_id,
        "displayName": state.get("displayName") or profile_id,
        "usernameMasked": _mask_username(state.get("username")),
        "desktopLabel": state.get("desktopLabel") or state.get("desktopName") or "",
        "userServiceId": state.get("userServiceId") or "",
        "spuCode": spu,
        "protocolHint": official,
        "lastOfficialProtocol": official,
        "hasPassword": bool(state.get("password")),
        "tokenPresent": bool(state.get("sohoToken") or state.get("token")),
        "isSubAccount": bool(state.get("isSubAccount")),
        "loginMode": state.get("loginMode") or ("sub" if state.get("isSubAccount") else "main"),
        "clientProfile": state.get("clientProfile") or "linux",
        "draft": bool(state.get("draft")),
        "jobStatus": "running" if any_running else "idle",
        "desktopStatuses": statuses,
        "statePath": str(path),
        "updatedAt": state.get("updatedAt") or (
            datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).astimezone().isoformat(timespec="seconds")
            if path.is_file()
            else _now_iso()
        ),
    }


def list_profiles(include_draft: bool = False) -> List[Dict[str, Any]]:
    """List profiles. Login-only draft profiles are hidden until save-and-keepalive.

    HARD_GATE#868: skip shared acct_*.json (token store only, not UI cards).
    """
    out: List[Dict[str, Any]] = []
    for p in sorted(profiles_dir().glob("*.json")):
        if _is_shared_account_file(p):
            continue
        pid = p.stem
        st = _read_state(p)
        if not include_draft and bool(st.get("draft")):
            continue
        # surface tokenPresent from shared account when card file lacks token
        st = _hydrate_profile_from_shared(st)
        out.append(_public_profile(pid, st, p))
    return out



def _commit_profile_draft(path: Path, state: Dict[str, Any]) -> Dict[str, Any]:
    """Clear draft flag so profile appears in timeline (save-and-keepalive)."""
    if state.get("draft"):
        state = dict(state)
        state.pop("draft", None)
        state["updatedAt"] = _now_iso()
        _write_state(path, state)
    return state


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

async def health(request: Request) -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "status": "up",
            "service": "cmcc-cloud-alive-webui",
            "at": _now_iso(),
            "orchestrator": type(ORCH).__name__,
        }
    )


async def system_info(request: Request) -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "dataDir": str(_data_dir()),
            "profilesDir": str(profiles_dir()),
            "cliCallable": True,  # package present; not probing LIVE
            "version": "0.1.0-webui-j3",
            "tokenRequired": bool(os.environ.get("CMCC_WEBUI_TOKEN")),
            "orchestrator": type(ORCH).__name__,
        }
    )


async def profiles_list(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "profiles": list_profiles()})


async def profiles_create(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return api_error("VALIDATION", "JSON body required")
    if not isinstance(body, dict):
        return api_error("VALIDATION", "JSON object required")
    display = (body.get("displayName") or body.get("name") or "").strip()
    username = (body.get("username") or "").strip()
    password = body.get("password")  # write-only
    client_profile = (body.get("clientProfile") or "linux").strip() or "linux"
    if client_profile not in ("linux", "windows", "mac"):
        return api_error("VALIDATION", "clientProfile must be linux|windows|mac")
    base = _safe_profile_id(display or username or f"p-{uuid.uuid4().hex[:8]}")
    pid = base
    n = 2
    while _profile_path(pid).exists():
        pid = f"{base}-{n}"
        n += 1
    state: Dict[str, Any] = {
        "displayName": display or pid,
        "username": username,
        "clientProfile": client_profile,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }
    # HARD_GATE#850: login-only create stays draft; hidden from timeline until save.
    if body.get("draft") is True or str(body.get("draft") or "").lower() in ("1", "true", "yes"):
        state["draft"] = True
    if password:
        state["password"] = str(password)
        state["passwordSavedAt"] = _now_iso()
    path = _profile_path(pid)
    _write_state(path, state)
    public = _public_profile(pid, state, path)
    return JSONResponse({"ok": True, "profile": public}, status_code=201)


async def profiles_get(request: Request) -> JSONResponse:
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    state = _read_state(path)
    return JSONResponse({"ok": True, "profile": _public_profile(pid, state, path)})


async def profiles_delete(request: Request) -> JSONResponse:
    """Delete a cloud-desktop account profile JSON.

    OPS#185 / OPEN#188: if keepalive is running, stop it first, then unlink
    the profile file. Idempotent-ish: missing profile → 404 (not 405).
    """
    pid = request.path_params["profile_id"]
    # Block path traversal; do not re-normalize id (Master probe __no_such__ → 404).
    if not pid or any(x in pid for x in ("/", "\\", "..")):
        return api_error("VALIDATION", "invalid profile id", 400)
    path = _profile_path(pid)
    try:
        path.resolve().relative_to(profiles_dir().resolve())
    except Exception:
        return api_error("VALIDATION", "invalid profile id", 400)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)

    stopped = False
    stop_detail = None
    try:
        statuses = ORCH.get_statuses(pid) if hasattr(ORCH, "get_statuses") else []
        for s in statuses:
            did = s.get("desktopId", "")
            if s.get("status") == "running":
                try:
                    ORCH.stop_job(pid, did)
                    stopped = True
                    stop_detail = "stopped"
                except KeyError:
                    pass
                except Exception as e:
                    return api_error("STOP_FAILED", f"stop {pid}/{did} failed: {e}", 500)
    except Exception as e:
        return api_error("STOP_FAILED", f"status before delete failed: {e}", 500)

    try:
        path.unlink()
    except FileNotFoundError:
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    except OSError as e:
        return api_error("IO_ERROR", f"delete failed: {e}", 500)

    # Best-effort: remove leftover tmp if any
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        if tmp.is_file():
            tmp.unlink()
    except OSError:
        pass

    return JSONResponse(
        {
            "ok": True,
            "deleted": True,
            "profileId": pid,
            "stoppedJob": stopped,
            "stopDetail": stop_detail,
        }
    )


async def profiles_update(request: Request) -> JSONResponse:
    """Update profile fields (displayName, protocol, clientProfile, mode, interval, etc)."""
    pid = request.path_params["profile_id"]
    if not pid or any(x in pid for x in ("/", "\\", "..")):
        return api_error("VALIDATION", "invalid profile id", 400)
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    state = _read_state(path)
    upd = False
    for k in ("displayName", "protocol", "clientProfile", "mode", "intervalMin", "trafficSec", "intervalSec"):
        if k in body and body.get(k) is not None:
            state[k] = body[k]
            upd = True
    if "protocol" in body:
        state["lastOfficialProtocol"] = body["protocol"]
    if upd:
        state["updatedAt"] = _now_iso()
        _write_state(path, state)
    return JSONResponse({"ok": True, "profile": _public_profile(pid, state, path)})


def _password_login_for_profile(
    path: Path, username: str, password: str, mode: str = "main"
) -> Dict[str, Any]:
    """Thin wrapper: main/sub password login writes sohoToken into profile state JSON."""
    from cmcc_cloud_alive.auth import password_login, sub_password_login

    login_fn = (
        sub_password_login
        if str(mode).lower() in ("sub", "subaccount", "1", "true")
        else password_login
    )
    return login_fn(
        username,
        password,
        state_path=str(path),
        save_password=True,
    )


async def profiles_login(request: Request) -> JSONResponse:
    """Save credentials and attempt LIVE cloud login (sohoToken).

    Default path calls ``auth.password_login`` → ``core.password_login`` on a
    worker thread and persists ``sohoToken`` into the profile state file.
    Offline smoke may set ``CMCC_WEBUI_LOGIN_STUB=1`` to store credentials only
    (never invents a session token). Callers must treat
    ``sessionEstablished=false`` as not logged in for desktops.
    """
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    state = _read_state(path)
    username = (body.get("username") or state.get("username") or "").strip()
    password = body.get("password")
    if password is not None and str(password) == "":
        return api_error(
            "VALIDATION",
            "password empty",
            400,
            next_step="请填写密码后再保存",
        )
    if body.get("password"):
        state["password"] = str(body["password"])
        state["passwordSavedAt"] = _now_iso()
        password = str(body["password"])
    else:
        password = state.get("password")
    if body.get("username"):
        state["username"] = str(body["username"]).strip()
        username = state["username"]
    # main/sub account login mode (composer dual buttons)
    raw_mode = body.get("mode")
    if raw_mode is None and "isSubAccount" in body:
        raw_mode = "sub" if body.get("isSubAccount") else "main"
    login_mode = (
        "sub"
        if str(raw_mode or "main").lower() in ("sub", "subaccount", "1", "true")
        else "main"
    )
    state["loginMode"] = login_mode
    state["isSubAccount"] = login_mode == "sub"
    if not username and not (state.get("sohoToken") or state.get("token")):
        return api_error(
            "VALIDATION",
            "username required when no session token",
            400,
            next_step="请填写账号，或先写入有效 sohoToken",
        )

    state["lastLoginAttemptAt"] = _now_iso()
    state["updatedAt"] = _now_iso()

    stub_on = os.environ.get("CMCC_WEBUI_LOGIN_STUB", "").strip() in (
        "1",
        "true",
        "TRUE",
        "yes",
        "YES",
    )
    if stub_on:
        token_present = bool(state.get("sohoToken") or state.get("token"))
        state["lastLoginStatus"] = (
            "session-present" if token_present else "credentials-saved-no-session"
        )
        _write_state(path, state)
        try:
            _sync_shared_account(state)
        except Exception:
            pass
        pub = _public_profile(pid, state, path)
        return JSONResponse(
            {
                "ok": True,
                "profile": pub,
                "sessionEstablished": token_present,
                "source": "stub",
                "note": (
                    "session already present; desktops may list_clouds"
                    if token_present
                    else "CMCC_WEBUI_LOGIN_STUB=1: credentials stored only; no sohoToken minted"
                ),
                "nextStep": (
                    "拉取桌面列表（GET /desktops）"
                    if token_present
                    else "离线 stub：未建立 sohoToken；关 stub 后重试 LIVE 登录"
                ),
            }
        )

    if not username or not password:
        token_present = bool(state.get("sohoToken") or state.get("token"))
        if token_present:
            state["lastLoginStatus"] = "session-present"
            _write_state(path, state)
            try:
                _sync_shared_account(state)
            except Exception:
                pass
            pub = _public_profile(pid, state, path)
            return JSONResponse(
                {
                    "ok": True,
                    "profile": pub,
                    "sessionEstablished": True,
                    "source": "existing-session",
                    "note": "session already present; no password supplied for re-login",
                    "nextStep": "拉取桌面列表（GET /desktops）",
                }
            )
        state["lastLoginStatus"] = "credentials-incomplete"
        _write_state(path, state)
        return api_error(
            "VALIDATION",
            "username and password required for LIVE login",
            400,
            next_step="请填写账号和密码后重新登录",
        )

    # Persist credentials before LIVE call so retries / re-login can reuse them.
    state["username"] = username
    state["password"] = str(password)
    state["passwordSavedAt"] = state.get("passwordSavedAt") or _now_iso()
    state["lastLoginStatus"] = "live-attempt"
    _write_state(path, state)

    try:
        await asyncio.to_thread(_password_login_for_profile, path, username, str(password), login_mode)
    except Exception as e:
        msg = str(e) or e.__class__.__name__
        code_name = "UPSTREAM"
        status = 502
        resp = getattr(e, "response", None)
        # Prefer upstream response codes. Do NOT match bare "login"/"password":
        # core.assert_ok labels look like "passwordLogin failed: code=... msg=..."
        # and would falsely map every upstream failure to AUTH_FAILED/401.
        auth_codes = {4001, 4003, 4010, 4011, 4100, 401, 403}
        rc_int = None
        upstream_msg = ""
        if isinstance(resp, dict):
            rc = resp.get("code")
            try:
                rc_int = int(rc) if rc is not None else None
            except (TypeError, ValueError):
                rc_int = None
            upstream_msg = str(resp.get("msg") or "")
        if rc_int in auth_codes:
            code_name = "AUTH_FAILED"
            status = 401
        else:
            # Message-based auth only for explicit credential-wrong phrases.
            # Never match bare "login" or the assert_ok label "passwordLogin".
            hay = f"{upstream_msg} {msg}".lower()
            auth_needles = (
                "wrong password",
                "invalid password",
                "password error",
                "password incorrect",
                "bad credentials",
                "invalid credentials",
                "credential",
                "authentication failed",
                "auth failed",
                "unauthorized",
                "账号或密码",
                "用户名或密码",
                "密码错误",
                "密码不正确",
            )
            if any(n in hay for n in auth_needles):
                code_name = "AUTH_FAILED"
                status = 401
        # Re-read; core may have partially written. Never invent sohoToken.
        state = _read_state(path)
        state["lastLoginAttemptAt"] = _now_iso()
        state["lastLoginStatus"] = f"failed:{code_name}"
        state["lastLoginError"] = msg[:500]
        state["updatedAt"] = _now_iso()
        _write_state(path, state)
        zh_next = (
            "账号或密码错误：请核对后重试 POST /login"
            if code_name == "AUTH_FAILED"
            else "上游登录失败：检查网络/账号后重试 POST /login"
        )
        return api_error(
            code_name,
            f"password_login failed: {msg}",
            status,
            next_step=zh_next,
        )

    state = _read_state(path)
    token_present = bool(state.get("sohoToken") or state.get("token"))
    state["lastLoginAttemptAt"] = _now_iso()
    state["lastLoginStatus"] = "session-established" if token_present else "live-ok-no-token"
    state["lastLoginError"] = ""
    state["updatedAt"] = _now_iso()
    _write_state(path, state)
    # HARD_GATE#868: same account shares one token store (acct_<user>.json)
    try:
        _sync_shared_account(state)
    except Exception:
        pass
    pub = _public_profile(pid, state, path)
    return JSONResponse(
        {
            "ok": True,
            "profile": pub,
            "sessionEstablished": token_present,
            "source": "password_login",
            "note": (
                "LIVE login ok; sohoToken written — GET /desktops may list_clouds"
                if token_present
                else "LIVE login returned without sohoToken; desktops still gated"
            ),
            "nextStep": (
                "拉取桌面列表（GET /desktops）"
                if token_present
                else "登录响应无 sohoToken：检查上游账号状态后重试"
            ),
        }
    )


def _spu_protocol_hint(spu_code: str) -> str:
    """Map spuCode → likely client protocol (UI hint only; user may override)."""
    s = (spu_code or "").strip().lower()
    if not s:
        return ""
    if s == "sc-cloud-pc" or s.startswith("sc-"):
        return "SCG"
    if s == "zte-cloud-pc" or s.startswith("zte-"):
        return "ZTE"
    return ""


def _desktop_from_cloud(item: Any) -> Optional[Dict[str, Any]]:
    """Normalize one /cc/cloudPc/list item → WebUI desktop DTO (J8 spuCode)."""
    if not isinstance(item, dict):
        return None
    usid = item.get("userServiceId") or item.get("user_service_id") or ""
    usid = str(usid).strip() if usid is not None else ""
    if not usid:
        return None
    spu_raw = item.get("spuCode") if item.get("spuCode") is not None else item.get("spu_code")
    spu = str(spu_raw or "")
    vm_name = item.get("vmName") or item.get("desktopName") or item.get("name") or ""
    sku = item.get("skuName") or ""
    vm_status_show = item.get("vmStatusShow") or item.get("statusShow") or ""
    # HARD_GATE#850: name = skuName (python CLI: 家庭云电脑高级版), fallback vmName
    sku_s = str(sku) if sku is not None else ""
    vm_s = str(vm_name) if vm_name is not None else ""
    desk_label = sku_s or vm_s or usid
    dto: Dict[str, Any] = {
        "userServiceId": usid,
        "vmName": vm_s,
        "spuCode": spu,
        "skuName": sku_s,
        "desktopLabel": desk_label,
        "name": desk_label,
        "label": desk_label,
        "vmStatus": item.get("vmStatus"),
        "vmStatusShow": str(vm_status_show) if vm_status_show is not None else "",
        "statusName": str(vm_status_show) if vm_status_show is not None else "",
    }
    hint = _spu_protocol_hint(spu)
    if hint:
        dto["protocolHint"] = hint
    return dto


def _normalize_desktops(cloud_list: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not isinstance(cloud_list, list):
        return out
    for raw in cloud_list:
        dto = _desktop_from_cloud(raw)
        if dto is not None:
            out.append(dto)
    return out


def _desktops_shape_fixture() -> List[Dict[str, Any]]:
    """Offline shape-only rows (env CMCC_WEBUI_DESKTOPS_FIXTURE=1). Not LIVE."""
    return [
        {
            "userServiceId": "fixture-sc-001",
            "vmName": "fixture-sc",
            "spuCode": "sc-cloud-pc",
            "skuName": "fixture",
            "desktopLabel": "fixture",
            "name": "fixture",
            "vmStatus": 1,
            "vmStatusShow": "运行中",
            "statusName": "运行中",
            "protocolHint": "SCG",
        },
        {
            "userServiceId": "fixture-zte-001",
            "vmName": "fixture-zte",
            "spuCode": "zte-cloud-pc",
            "skuName": "fixture",
            "vmStatus": 1,
            "vmStatusShow": "运行中",
            "protocolHint": "ZTE",
        },
    ]


def _list_clouds_for_profile(path: Path) -> List[Any]:
    """Thin wrapper: core.list_clouds with profile JSON as state file (single short call)."""
    from types import SimpleNamespace

    from cmcc_cloud_alive.core import list_clouds

    return list_clouds(SimpleNamespace(state=str(path)))


async def profiles_desktops(request: Request) -> JSONResponse:
    """List cloud desktops for a profile (J8_BE_DESKTOPS_SPU).

    Prefer cached ``cloudList`` in the profile state JSON. Otherwise call
    ``core.list_clouds`` (``/cc/cloudPc/list/v6``) once when ``sohoToken`` is
    present. Unauthenticated profiles get a structured error — never a silent
    stub empty success. Optional ``?refresh=1`` forces re-list. Fixture shape
    rows only when env ``CMCC_WEBUI_DESKTOPS_FIXTURE=1`` (offline smoke).
    """
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)

    refresh = (request.query_params.get("refresh") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    state = _read_state(path)
    state = _hydrate_profile_from_shared(state)
    token = (state.get("sohoToken") or state.get("token") or "").strip()
    cached = state.get("cloudList")
    has_cache = isinstance(cached, list) and bool(state.get("lastCloudListAt") or cached)

    source = "cache"
    raw_items: List[Any] = []

    if has_cache and not refresh:
        raw_items = list(cached or [])
        source = "cache"
    elif token:
        try:
            live_path = _resolve_live_state_path(path, state)
            raw_items = await asyncio.to_thread(_list_clouds_for_profile, live_path)
            source = "list_clouds"
            # re-read after merge_state wrote cloudList into the same profile file
            state = _read_state(live_path)
            # sync back to card profile so next cache read has fresh data
            if str(live_path) != str(path):
                card_state = _read_state(path)
                if state.get("cloudList"):
                    card_state["cloudList"] = state["cloudList"]
                    card_state["lastCloudListAt"] = state.get("lastCloudListAt", _now_iso())
                    card_state["updatedAt"] = _now_iso()
                    _write_state(path, card_state)
        except Exception as e:
            # Prefer CmccError details without requiring core at import time
            msg = str(e) or e.__class__.__name__
            code_name = "UPSTREAM"
            status = 502
            resp = getattr(e, "response", None)
            if isinstance(resp, dict):
                rc = resp.get("code")
                # common auth-ish codes from CMCC gateways
                if rc in (4001, 4003, 4010, 4011, 4100, 401, 403) or "token" in msg.lower():
                    code_name = "AUTH_EXPIRED"
                    status = 401
            zh_next = (
                "会话可能已失效：请重新登录写入 sohoToken，再 GET /desktops?refresh=1"
                if code_name == "AUTH_EXPIRED"
                else "上游列桌面失败：检查网络/账号后重试 GET /desktops?refresh=1"
            )
            return api_error(
                code_name,
                f"list_clouds failed: {msg}",
                status,
                next_step=zh_next,
            )
    else:
        fixture_on = os.environ.get("CMCC_WEBUI_DESKTOPS_FIXTURE", "").strip() in (
            "1",
            "true",
            "TRUE",
            "yes",
            "YES",
        )
        if fixture_on:
            desktops = _desktops_shape_fixture()
            return JSONResponse(
                {
                    "ok": True,
                    "profileId": pid,
                    "desktops": desktops,
                    "source": "fixture",
                    "count": len(desktops),
                    "note": "shape fixture only (CMCC_WEBUI_DESKTOPS_FIXTURE); wire path is core.list_clouds",
                }
            )
        return api_error(
            "AUTH_REQUIRED",
            "未登录：当前账号没有有效会话（sohoToken），无法拉取桌面列表",
            401,
            next_step="请先登录建立会话（写入 sohoToken），再重试拉取桌面",
        )

    desktops = _normalize_desktops(raw_items)
    return JSONResponse(
        {
            "ok": True,
            "profileId": pid,
            "desktops": desktops,
            "source": source,
            "count": len(desktops),
            "lastCloudListAt": state.get("lastCloudListAt") or "",
        }
    )


async def profiles_select_desktop(request: Request) -> JSONResponse:
    """Bind selected desktop + official protocol slot (spu / protocolHint).

    ``lastOfficialProtocol`` is the **official** protocol derived from spuCode
    (SCG/ZTE hint). It is independent of the user-chosen keepalive protocol on
    start-job.
    """
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    try:
        body = await request.json()
    except Exception:
        return api_error("VALIDATION", "JSON body required")
    if not isinstance(body, dict):
        body = {}
    usid = body.get("userServiceId") or ""
    label = body.get("desktopLabel") or body.get("desktopName") or body.get("vmName") or ""
    spu = body.get("spuCode") or body.get("spu") or ""
    # Allow explicit official protocol, else derive from spu / protocolHint body.
    official_in = body.get("lastOfficialProtocol") or body.get("protocolHint") or ""
    state = _read_state(path)
    if usid:
        state["userServiceId"] = str(usid)
    if label:
        state["desktopLabel"] = str(label)
    if spu:
        spu_s = str(spu).strip()
        state["spuCode"] = spu_s
        state["lastSpuCode"] = spu_s
    official = str(official_in).strip().upper() if official_in else ""
    if not official and state.get("spuCode"):
        official = _spu_protocol_hint(str(state.get("spuCode") or ""))
    if official:
        state["lastOfficialProtocol"] = official
        state["protocolHint"] = official
    # HARD_GATE#851: keep draft; only save-and-start commits to timeline
    state["updatedAt"] = _now_iso()
    _write_state(path, state)
    return JSONResponse({"ok": True, "profile": _public_profile(pid, state, path)})



def resolve_user_protocol(body_protocol=None, state=None, fallback="ZTE"):
    """HARD_GATE#871c: body → profile fields → historical empty fallback. Never force SCG."""
    candidates = []
    if body_protocol:
        candidates.append(body_protocol)
    st = state or {}
    for k in ("protocol", "lastOfficialProtocol", "protocolHint", "last_protocol"):
        if st.get(k):
            candidates.append(st.get(k))
    for v in candidates:
        u = str(v or "").strip().upper()
        if u in ("ZX", "ZHONGXING"):
            u = "ZTE"
        if u == "SANGFOR":
            u = "SCG"
        if u in ("ZTE", "SCG", "V3"):
            return u
    return str(fallback or "ZTE").upper()


async def profiles_start_job(request: Request) -> JSONResponse:
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    did = body.get("desktopId") or request.query_params.get("desktopId") or ""
    if not did:
        return api_error("VALIDATION", "desktopId is required", 400)
    mode = body.get("mode") or "live"
    try:
        timing = parse_job_timing_fields(body)
    except ValueError as e:
        return api_error("VALIDATION", str(e))
    state = _read_state(path)
    protocol = resolve_user_protocol(body.get("protocol"), state)
    # Per-desktop protocol override
    desktop_protos = state.get("desktopProtocols") or {}
    if did in desktop_protos:
        protocol = desktop_protos[did]
    if state.get("draft"):
        state.pop("draft", None)
        state["updatedAt"] = _now_iso()
        _write_state(path, state)
    live_path = _resolve_live_state_path(path, state)
    try:
        _sync_shared_account(state)
        live_path = _resolve_live_state_path(path, state)
    except Exception:
        pass
    try:
        job = ORCH.start_job(
            pid, did, live_path,
            protocol=protocol, mode=mode,
            extra_args=timing["extraArgs"],
            interval_sec=timing["intervalSec"],
            traffic_sec=timing["trafficSec"],
            duration_sec=timing["durationSec"],
        )
    except RuntimeError as e:
        err = str(e)
        if err in ("JOB_IN_USE", "PROFILE_IN_USE"):
            return api_error("JOB_IN_USE", "desktop already has a running job", 409)
        return api_error("VALIDATION", err)
    except ValueError as e:
        return api_error("VALIDATION", str(e))
    return JSONResponse({"ok": True, "job": job}, status_code=202)


async def profiles_stop_job(request: Request) -> JSONResponse:
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    did = body.get("desktopId") or request.query_params.get("desktopId") or ""
    try:
        job = ORCH.stop_job(pid, did)
    except KeyError:
        return api_error("NOT_FOUND", "no job for profile/desktop", 404)
    return JSONResponse({"ok": True, "job": job})


async def profiles_logs(request: Request) -> JSONResponse:
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    all_logs = request.query_params.get("all") == "1"
    if all_logs:
        by_desktop = ORCH.recent_logs(profile_id=pid, desktop_id=None, limit=500)
    else:
        did = request.query_params.get("desktopId") or ""
        by_desktop = ORCH.recent_logs(profile_id=pid, desktop_id=did, limit=200)
    safe = {
        did: [{"at": x.get("at"), "line": str(x.get("line", ""))[:2000]} for x in lines]
        for did, lines in by_desktop.items()
    }
    return JSONResponse({"ok": True, "profileId": pid, "logs": safe})


async def profiles_logs_clear(request: Request) -> JSONResponse:
    """HARD_GATE#853: clear backend log buffer for a profile/card."""
    pid = request.path_params["profile_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    did = request.query_params.get("desktopId") or ""
    result = ORCH.clear_logs(profile_id=pid, desktop_id=did)
    return JSONResponse(
        {
            "ok": True,
            "profileId": pid,
            "cleared": int((result or {}).get("cleared") or 0),
            "lines": [],
        }
    )


async def profiles_desktop_jobs_get(request: Request) -> JSONResponse:
    pid = request.path_params["profile_id"]
    did = request.path_params["desktop_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    st = ORCH.get_status(pid, did)
    return JSONResponse({"ok": True, "job": st})


async def profiles_desktop_jobs_start(request: Request) -> JSONResponse:
    pid = request.path_params["profile_id"]
    did = request.path_params["desktop_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    state = _read_state(path)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    mode = body.get("mode") or "live"
    try:
        timing = parse_job_timing_fields(body)
    except ValueError as e:
        return api_error("VALIDATION", str(e))
    protocol = resolve_user_protocol(body.get("protocol"), state)
    desktop_protos = state.get("desktopProtocols") or {}
    if did in desktop_protos:
        protocol = desktop_protos[did]
    if state.get("draft"):
        state.pop("draft", None)
        state["updatedAt"] = _now_iso()
        _write_state(path, state)
    live_path = _resolve_live_state_path(path, state)
    try:
        _sync_shared_account(state)
        live_path = _resolve_live_state_path(path, state)
    except Exception:
        pass
    try:
        job = ORCH.start_job(
            pid, did, live_path,
            protocol=protocol, mode=mode,
            extra_args=timing["extraArgs"],
            interval_sec=timing["intervalSec"],
            traffic_sec=timing["trafficSec"],
            duration_sec=timing["durationSec"],
        )
    except RuntimeError as e:
        err = str(e)
        if err in ("JOB_IN_USE", "PROFILE_IN_USE"):
            return api_error("JOB_IN_USE", "desktop already has a running job", 409)
        return api_error("VALIDATION", err)
    except ValueError as e:
        return api_error("VALIDATION", str(e))
    return JSONResponse({"ok": True, "job": job}, status_code=202)


async def profiles_desktop_jobs_stop(request: Request) -> JSONResponse:
    pid = request.path_params["profile_id"]
    did = request.path_params["desktop_id"]
    path = _profile_path(pid)
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    try:
        job = ORCH.stop_job(pid, did)
    except KeyError:
        return api_error("NOT_FOUND", "no job for profile/desktop", 404)
    return JSONResponse({"ok": True, "job": job})


async def jobs_list(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "jobs": ORCH.list_jobs()})


async def jobs_create(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return api_error("VALIDATION", "JSON body required")
    pid = (body or {}).get("profileId") or (body or {}).get("profile_id")
    if not pid:
        return api_error("VALIDATION", "profileId required")
    did = (body or {}).get("desktopId") or ""
    if not did:
        return api_error("VALIDATION", "desktopId required")
    path = _profile_path(str(pid))
    if not path.is_file():
        return api_error("NOT_FOUND", f"profile {pid} not found", 404)
    state = _read_state(path)
    protocol = resolve_user_protocol((body or {}).get("protocol"), state)
    desktop_protos = state.get("desktopProtocols") or {}
    if did in desktop_protos:
        protocol = desktop_protos[did]
    mode = body.get("mode") or "live"
    try:
        timing = parse_job_timing_fields(body if isinstance(body, dict) else {})
    except ValueError as e:
        return api_error("VALIDATION", str(e))
    try:
        job = ORCH.start_job(
            str(pid), did, _resolve_live_state_path(path, state),
            protocol=protocol, mode=mode,
            extra_args=timing["extraArgs"],
            interval_sec=timing["intervalSec"],
            traffic_sec=timing["trafficSec"],
            duration_sec=timing["durationSec"],
        )
    except RuntimeError as e:
        err = str(e)
        if err in ("JOB_IN_USE", "PROFILE_IN_USE"):
            return api_error("JOB_IN_USE", "desktop already has a running job", 409)
        return api_error("VALIDATION", err)
    except ValueError as e:
        return api_error("VALIDATION", str(e))
    return JSONResponse({"ok": True, "job": job}, status_code=202)


async def jobs_get(request: Request) -> JSONResponse:
    jid = request.path_params["job_id"]
    job = ORCH.get_job(jid)
    if not job:
        return api_error("NOT_FOUND", f"job {jid} not found", 404)
    return JSONResponse({"ok": True, "job": job})


async def jobs_stop(request: Request) -> JSONResponse:
    jid = request.path_params["job_id"]
    job = ORCH.get_job(jid)
    if not job:
        return api_error("NOT_FOUND", f"job {jid} not found", 404)
    pid = job.get("profileId", "")
    did = job.get("desktopId", "")
    try:
        stopped = ORCH.stop_job(pid, did)
    except KeyError:
        return api_error("NOT_FOUND", "job already gone", 404)
    return JSONResponse({"ok": True, "job": stopped})


async def logs_global(request: Request) -> JSONResponse:
    pid = request.query_params.get("profileId")
    did = request.query_params.get("desktopId")
    by_desktop = ORCH.recent_logs(profile_id=pid, desktop_id=did, limit=200)
    safe = {
        did: [{"at": x.get("at"), "line": str(x.get("line", ""))[:2000]} for x in lines]
        for did, lines in by_desktop.items()
    }
    return JSONResponse({"ok": True, "logs": safe})


async def index(request: Request) -> Response:
    index_path = _STATIC_DIR / "index.html"
    if index_path.is_file():
        # HARD_GATE#844: bust stale CSS/JS after layout hotfixes
        return FileResponse(
            index_path,
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
            },
        )
    return JSONResponse({"ok": True, "message": "static shell missing", "api": "/api/system/health"})


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

routes = [
    Route("/", endpoint=index),
    Route("/index.html", endpoint=index),
    # health aliases: X2 `/api/health`, T3 `/health`, PM `/api/system/health`
    Route("/health", endpoint=health),
    Route("/api/health", endpoint=health),
    Route("/api/system/health", endpoint=health),
    Route("/api/system/info", endpoint=system_info),
    # X8 alias: OPEN gates mention /api/info
    Route("/api/info", endpoint=system_info),
    # X2 §3 profiles
    Route("/api/profiles", endpoint=profiles_list, methods=["GET"]),
    Route("/api/profiles", endpoint=profiles_create, methods=["POST"]),
    Route("/api/profiles/{profile_id}", endpoint=profiles_get, methods=["GET"]),
    Route("/api/profiles/{profile_id}", endpoint=profiles_update, methods=["PUT"]),
    Route("/api/profiles/{profile_id}", endpoint=profiles_delete, methods=["DELETE"]),
    Route("/api/profiles/{profile_id}/login", endpoint=profiles_login, methods=["POST"]),
    Route("/api/profiles/{profile_id}/desktops", endpoint=profiles_desktops, methods=["GET"]),
    Route("/api/profiles/{profile_id}/select-desktop", endpoint=profiles_select_desktop, methods=["POST"]),
    Route("/api/profiles/{profile_id}/jobs", endpoint=profiles_start_job, methods=["POST"]),
    Route("/api/profiles/{profile_id}/jobs/current", endpoint=profiles_stop_job, methods=["DELETE"]),
    # Per-desktop jobs endpoints (primary)
    Route("/api/profiles/{profile_id}/desktops/{desktop_id}/jobs", endpoint=profiles_desktop_jobs_get, methods=["GET"]),
    Route("/api/profiles/{profile_id}/desktops/{desktop_id}/jobs", endpoint=profiles_desktop_jobs_start, methods=["POST"]),
    Route("/api/profiles/{profile_id}/desktops/{desktop_id}/jobs/current", endpoint=profiles_desktop_jobs_stop, methods=["DELETE"]),
    Route("/api/profiles/{profile_id}/logs", endpoint=profiles_logs, methods=["GET"]),
    Route("/api/profiles/{profile_id}/logs", endpoint=profiles_logs_clear, methods=["DELETE"]),
    Route("/api/jobs", endpoint=jobs_list, methods=["GET"]),
    Route("/api/jobs", endpoint=jobs_create, methods=["POST"]),
    Route("/api/jobs/{job_id}", endpoint=jobs_get, methods=["GET"]),
    Route("/api/jobs/{job_id}/stop", endpoint=jobs_stop, methods=["POST"]),
    Route("/api/logs", endpoint=logs_global, methods=["GET"]),
]

if _STATIC_DIR.is_dir():
    routes.append(Mount("/static", app=StaticFiles(directory=str(_STATIC_DIR)), name="static"))

async def not_found(request: Request, exc: HTTPException) -> Response:
    return await index(request)

app = Starlette(debug=os.environ.get("CMCC_WEBUI_DEBUG") == "1", routes=routes, exception_handlers={404: not_found})
app.add_middleware(OptionalTokenMiddleware)


def main() -> None:
    import uvicorn

    host = os.environ.get("CMCC_WEBUI_HOST", "127.0.0.1")
    port = int(os.environ.get("CMCC_WEBUI_PORT", "8080"))
    uvicorn.run("cmcc_cloud_alive.webui.app:app", host=host, port=port, factory=False)


if __name__ == "__main__":
    main()
