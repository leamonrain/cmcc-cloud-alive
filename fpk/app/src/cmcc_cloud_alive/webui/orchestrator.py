"""Multi-profile per-desktop keepalive job orchestrator (FNOS).

Parent-process only. Does NOT run keepalive loops on the ASGI event-loop
thread. Default backend is dry-run (FakeBackend). LIVE subprocess requires
explicit mode=live AND env CMCC_WEBUI_ALLOW_LIVE=1 (default off).

Composite key: "{profile_id}:{desktop_id}" — independent jobs per desktop.
No SSE. Front-end polls for status/logs.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__ = ["Orchestrator", "FakeBackend", "live_allowed", "job_key"]


def job_key(profile_id: str, desktop_id: str) -> str:
    return f"{profile_id}:{desktop_id}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def live_allowed() -> bool:
    return os.environ.get("CMCC_WEBUI_ALLOW_LIVE", "").strip() in ("1", "true", "TRUE", "yes", "YES")


def _data_dir() -> Path:
    explicit = os.environ.get("CMCC_DATA_DIR")
    if explicit:
        p = Path(explicit)
        if p.name == ".cmcc-cloud-alive":
            return p
        return p / ".cmcc-cloud-alive"
    raw = os.environ.get("CMCC_ALIVE_HOME") or os.environ.get("HOME") or str(Path.home())
    home = Path(raw)
    if home.name == ".cmcc-cloud-alive":
        return home
    return home / ".cmcc-cloud-alive"


def _jobs_dir() -> Path:
    d = _data_dir() / "jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _redact_line(line: str) -> str:
    low = line.lower()
    for key in ("password", "passwd", "token", "secret", "authorization", "cookie"):
        if key in low:
            return f"[redacted:{key}]"
    return line[:2000]


def _fake_short_time() -> str:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _usid_from_state(state_path: Path) -> str:
    try:
        raw = Path(state_path).read_text(encoding="utf-8")
        data = json.loads(raw) if raw.strip() else {}
        if isinstance(data, dict):
            usid = data.get("userServiceId") or data.get("selectedUserServiceId") or data.get("user_service_id") or ""
            if usid:
                return str(usid)
    except Exception:
        pass
    return "dry-run-svc"


def _live_creds_from_state(state_path: Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    try:
        raw = Path(state_path).read_text(encoding="utf-8")
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return out
    if not isinstance(data, dict):
        return out
    username = data.get("username") or data.get("phone") or ""
    password = data.get("password") or ""
    usid = data.get("userServiceId") or data.get("selectedUserServiceId") or data.get("user_service_id") or ""
    if username:
        out["username"] = str(username)
    if password:
        out["password"] = str(password)
    if usid:
        out["user_service_id"] = str(usid)
    return out


# ---------------------------------------------------------------------------
# FakeBackend — unchanged
# ---------------------------------------------------------------------------

class FakeBackend:
    name = "fake"

    def __init__(self, orch: "Orchestrator", job_id: str, stop_evt: threading.Event,
                 protocol: str = "ZTE", traffic_sec: Optional[int] = None,
                 user_service_id: str = "dry-run-svc") -> None:
        self.orch = orch
        self.job_id = job_id
        self.stop_evt = stop_evt
        self.protocol = (protocol or "ZTE").upper()
        if self.protocol not in ("ZTE", "SCG", "CAG", "V3"):
            self.protocol = "ZTE"
        self.traffic_sec = int(traffic_sec) if traffic_sec and int(traffic_sec) > 0 else 60
        self.user_service_id = user_service_id or "dry-run-svc"
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"fake-job-{self.job_id}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        self.stop_evt.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=timeout)

    def pid(self) -> Optional[int]:
        return None

    def _stamp(self) -> str:
        return _fake_short_time()

    def _emit_round(self, round_no: int) -> None:
        proto = self.protocol
        kind = proto.lower()
        duration_cfg = self.traffic_sec
        duration_done = f"{float(duration_cfg) + 0.42:.2f}"
        stage_done = f"{kind}-keepalive-done"
        usid = self.user_service_id
        if proto in ("SCG", "CAG"):
            lbl = "CAG" if proto == "CAG" else "SCG"
            hand = (f"[{self._stamp()}] 第{round_no}轮{lbl}保活：手选{lbl}，调用纯Python SCG协议 "
                    f"duration={duration_cfg}s userServiceId={usid}")
            done = (f"[{self._stamp()}] 第{round_no}轮{lbl}保活完成 "
                    f"kind={kind} ok=True stage={stage_done} duration={duration_done}s")
        elif proto == "V3":
            hand = (f"[{self._stamp()}] 第{round_no}轮V3保活：CAG TCP/TLS隧道模式 "
                    f"duration={duration_cfg}s userServiceId={usid}")
            done = (f"[{self._stamp()}] 第{round_no}轮V3保活完成 "
                    f"kind={kind} ok=True stage={stage_done} duration={duration_done}s")
        else:
            hand = (f"[{self._stamp()}] 第{round_no}轮ZTE保活：手选ZTE，调用长测同款CAG/mux/raw-SPICE "
                    f"duration={duration_cfg}s userServiceId={usid}")
            done = (f"[{self._stamp()}] 第{round_no}轮ZTE保活完成 "
                    f"kind={kind} ok=True stage={stage_done} duration={duration_done}s")
        product = f"[product-keepalive] kind={kind} ok=True stage={stage_done} duration={duration_done}s"
        status = f"[{self._stamp()}] 云桌面状态：开机运行中"
        for line in (hand, product, done, status):
            if self.stop_evt.is_set():
                return
            self.orch._append_log(self.job_id, line)

    def _run(self) -> None:
        self.orch._append_log(self.job_id, "[orch] dry-run backend=fake (simulated product-keepalive lines)")
        script = [
            "移动云电脑保活工具",
            f"  协议：{self.protocol}",
            "[首次开机检查] 云电脑已运行，跳过开机，马上进入第一轮保活。",
            f"进入保活循环：心跳间隔=300s 状态打印间隔=60s duration={self.traffic_sec}s",
            "提示：当前 desktop HTTP keepalive 路由尚未被证明可独立保活，仅作状态探测。",
        ]
        for line in script:
            if self.stop_evt.is_set():
                break
            self.orch._append_log(self.job_id, line)
            if self.stop_evt.wait(0.15):
                break
        round_no = 0
        while not self.stop_evt.is_set():
            round_no += 1
            self._emit_round(round_no)
            wait_s = 0.35 if round_no < 3 else 2.0
            if self.stop_evt.wait(wait_s):
                break
            if not self.stop_evt.is_set():
                self.orch._append_log(self.job_id, f"[{self._stamp()}] 云桌面状态：开机运行中")
        self.orch._append_log(self.job_id, "[orch] dry-run backend stopped")


# ---------------------------------------------------------------------------
# SubprocessBackend — unchanged
# ---------------------------------------------------------------------------

class SubprocessBackend:
    name = "subprocess"

    def __init__(self, orch: "Orchestrator", job_id: str, state_path: Path,
                 protocol: str, extra_args: Optional[List[str]],
                 stop_evt: threading.Event, log_path: Path, lock_path: Path) -> None:
        self.orch = orch
        self.job_id = job_id
        self.state_path = state_path
        self.protocol = protocol
        self.extra_args = list(extra_args or [])
        self.stop_evt = stop_evt
        self.log_path = log_path
        self.lock_path = lock_path
        self._proc: Optional[subprocess.Popen] = None
        self._thread: Optional[threading.Thread] = None
        self._lock_fd: Optional[int] = None

    def start(self) -> None:
        self._acquire_lock()
        cmd = self._build_cmd()
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log_f = open(self.log_path, "a", encoding="utf-8")
        try:
            self._proc = subprocess.Popen(cmd, stdout=log_f, stderr=subprocess.STDOUT,
                                          stdin=subprocess.DEVNULL, start_new_session=True, env=self._child_env())
        except Exception as e:
            log_f.close()
            self._release_lock()
            raise RuntimeError(f"spawn failed: {e}") from e
        self.orch._append_log(self.job_id, f"[orch] live spawned pid={self._proc.pid} protocol={self.protocol} state={self.state_path.name}")
        self._thread = threading.Thread(target=self._watch, args=(log_f,), name=f"live-job-{self.job_id}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self.stop_evt.set()
        proc = self._proc
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    proc.terminate()
                except Exception:
                    pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        proc.kill()
                    except Exception:
                        pass
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=timeout)
        self._release_lock()

    def pid(self) -> Optional[int]:
        if self._proc is None:
            return None
        return self._proc.pid if self._proc.poll() is None else self._proc.pid

    def _build_cmd(self) -> List[str]:
        creds = _live_creds_from_state(self.state_path)
        usid = creds.get("user_service_id")
        proto = (self.protocol or "ZTE").upper()

        if proto in ("CAG", "SCG"):
            cmd = [sys.executable, "-m", "cmcc_cloud_alive", "--state", str(self.state_path),
                   "product-keepalive", "--forever"]
            if usid:
                cmd.extend(["--user-service-id", usid])
            cmd.extend(self.extra_args)
            return cmd

        cmd = [sys.executable, "-m", "cmcc_cloud_alive", "--state", str(self.state_path),
               "product-keepalive", "interactive"]
        if usid:
            cmd.append(usid)
        cmd.append("--non-interactive")
        if creds.get("username"):
            cmd.extend(["--username", creds["username"]])
        if creds.get("password"):
            cmd.extend(["--password", creds["password"]])
        cmd.extend(self.extra_args)
        return cmd

    def _child_env(self) -> Dict[str, str]:
        env = dict(os.environ)
        env["CMCC_ORCH_JOB_ID"] = self.job_id
        env["CMCC_ORCH_PROTOCOL"] = self.protocol
        for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
                   "all_proxy", "ALL_PROXY", "ftp_proxy", "FTP_PROXY"):
            env.pop(k, None)
        env["NO_PROXY"] = "*"
        env["no_proxy"] = "*"
        src_dir = os.path.abspath(os.path.join(os.path.dirname(sys.executable), '..', '..'))
        env["PYTHONPATH"] = src_dir + ":" + env.get("PYTHONPATH", "")
        return env

    def _acquire_lock(self) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception as e:
            os.close(fd)
            raise RuntimeError(f"LOCK_FAILED: {e}") from e
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode("ascii"))
        self._lock_fd = fd

    def _release_lock(self) -> None:
        fd = self._lock_fd
        self._lock_fd = None
        if fd is None:
            return
        try:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass
        try:
            if self.lock_path.is_file():
                self.lock_path.unlink()
        except Exception:
            pass

    def _watch(self, log_f: Any) -> None:
        proc = self._proc
        offset = 0
        pending = ""
        try:
            try:
                if self.log_path.is_file():
                    offset = self.log_path.stat().st_size
            except Exception:
                offset = 0
            while proc and proc.poll() is None and not self.stop_evt.is_set():
                try:
                    offset, pending = self._drain_log(offset, pending)
                except Exception:
                    pass
                if self.stop_evt.wait(0.5):
                    break
            try:
                offset, pending = self._drain_log(offset, pending, final=True)
            except Exception:
                pass
            rc = proc.returncode if proc else None
            if self.stop_evt.is_set():
                self.orch._mark_stopped(self.job_id, detail="stopped by API", exit_code=rc)
            else:
                status = "stopped" if rc == 0 else "error"
                self.orch._mark_stopped(self.job_id, detail=f"child exited rc={rc}", exit_code=rc, status=status)
        finally:
            try:
                log_f.close()
            except Exception:
                pass
            self._release_lock()

    def _drain_log(self, offset: int, pending: str, *, final: bool = False) -> tuple:
        if not self.log_path.is_file():
            return offset, pending
        with open(self.log_path, "r", encoding="utf-8", errors="replace") as rf:
            rf.seek(offset)
            chunk = rf.read()
            offset = rf.tell()
        if not chunk:
            if final and pending.strip():
                self.orch._append_log(self.job_id, pending.rstrip("\r\n"))
                pending = ""
            return offset, pending
        data = pending + chunk
        lines = data.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            pending = lines.pop()
        else:
            pending = ""
        for raw in lines:
            line = raw.rstrip("\r\n")
            if line == "":
                continue
            self.orch._append_log(self.job_id, line)
        if final and pending.strip():
            self.orch._append_log(self.job_id, pending.rstrip("\r\n"))
            pending = ""
        return offset, pending


# ---------------------------------------------------------------------------
# SimpleAliveBackend — unchanged
# ---------------------------------------------------------------------------

class SimpleAliveBackend:
    name = "subprocess-v3"

    def __init__(self, orch: "Orchestrator", job_id: str, state_path: Path,
                 extra_args: Optional[List[str]], stop_evt: threading.Event, log_path: Path) -> None:
        self.orch = orch
        self.job_id = job_id
        self.state_path = state_path
        self.extra_args = list(extra_args or [])
        self.stop_evt = stop_evt
        self.log_path = log_path
        self._proc: Optional[subprocess.Popen] = None
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        cmd = self._build_cmd()
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log_f = open(self.log_path, "a", encoding="utf-8")
        env = dict(os.environ)
        src_dir = os.path.abspath(os.path.join(os.path.dirname(sys.executable), '..', '..'))
        env["PYTHONPATH"] = src_dir + ":" + env.get("PYTHONPATH", "")
        try:
            self._proc = subprocess.Popen(cmd, stdout=log_f, stderr=subprocess.STDOUT,
                                          stdin=subprocess.DEVNULL, start_new_session=True, env=env)
        except Exception as e:
            log_f.close()
            raise RuntimeError(f"V3 spawn failed: {e}") from e
        self.orch._append_log(self.job_id, f"[orch] V3 spawned pid={self._proc.pid} state={self.state_path.name}")
        self._thread = threading.Thread(target=self._watch, args=(log_f,), name=f"v3-job-{self.job_id}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self.stop_evt.set()
        proc = self._proc
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    proc.terminate()
                except Exception:
                    pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        proc.kill()
                    except Exception:
                        pass
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=timeout)

    def pid(self) -> Optional[int]:
        if self._proc is None:
            return None
        return self._proc.pid if self._proc.poll() is None else self._proc.pid

    def _build_cmd(self) -> List[str]:
        creds = _live_creds_from_state(self.state_path)
        cmd = [sys.executable, "-m", "cmcc_cloud_alive", "--state", str(self.state_path), "simple-alive"]
        usid = creds.get("user_service_id")
        if usid:
            cmd.append(usid)
        if creds.get("username"):
            cmd.extend(["--username", creds["username"]])
        if creds.get("password"):
            cmd.extend(["--password", creds["password"]])
        for i, arg in enumerate(self.extra_args):
            if arg == "--heartbeat-interval" and i + 1 < len(self.extra_args):
                val = self.extra_args[i + 1]
                mins = max(1, int(val) // 60)
                cmd.extend(["--cag-refresh", str(mins)])
                break
        else:
            cmd.extend(["--cag-refresh", "5"])
        return cmd

    def _watch(self, log_f: Any) -> None:
        proc = self._proc
        offset = 0
        pending = ""
        try:
            try:
                if self.log_path.is_file():
                    offset = self.log_path.stat().st_size
            except Exception:
                offset = 0
            while proc and proc.poll() is None and not self.stop_evt.is_set():
                try:
                    offset, pending = self._drain_log(offset, pending)
                except Exception:
                    pass
                if self.stop_evt.wait(0.5):
                    break
            try:
                offset, pending = self._drain_log(offset, pending, final=True)
            except Exception:
                pass
            rc = proc.returncode if proc else None
            if self.stop_evt.is_set():
                self.orch._mark_stopped(self.job_id, detail="stopped by API", exit_code=rc)
            else:
                status = "stopped" if rc == 0 else "error"
                self.orch._mark_stopped(self.job_id, detail=f"V3 child exited rc={rc}", exit_code=rc, status=status)
        finally:
            try:
                log_f.close()
            except Exception:
                pass

    def _drain_log(self, offset: int, pending: str, *, final: bool = False) -> tuple:
        if not self.log_path.is_file():
            return offset, pending
        with open(self.log_path, "r", encoding="utf-8", errors="replace") as rf:
            rf.seek(offset)
            chunk = rf.read()
            offset = rf.tell()
        if not chunk:
            if final and pending.strip():
                self.orch._append_log(self.job_id, pending.rstrip("\r\n"))
                pending = ""
            return offset, pending
        data = pending + chunk
        lines = data.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            pending = lines.pop()
        else:
            pending = ""
        for raw in lines:
            line = raw.rstrip("\r\n")
            if line == "":
                continue
            self.orch._append_log(self.job_id, line)
        if final and pending.strip():
            self.orch._append_log(self.job_id, pending.rstrip("\r\n"))
            pending = ""
        return offset, pending


# ---------------------------------------------------------------------------
# Orchestrator — composite key, no SSE
# ---------------------------------------------------------------------------

class Orchestrator:
    """In-memory job table + per-(profile,desktop) mutex + dry-run/LIVE backends.

    Each desktop within a profile gets an independent job identified by
    composite key ``"{profile_id}:{desktop_id}"``.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._jobs: Dict[str, Dict[str, Any]] = {}           # job_id -> job dict
        self._by_key: Dict[str, str] = {}                    # composite_key -> job_id
        self._log_buffers: Dict[str, List[Dict[str, str]]] = {}  # job_id -> [{at, line}]
        self._last_log_line: Dict[str, str] = {}
        self._backends: Dict[str, Any] = {}                  # job_id -> backend
        self._stop_events: Dict[str, threading.Event] = {}

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(j) for j in self._jobs.values()]

    def get_status(self, profile_id: str, desktop_id: str) -> Dict[str, Any]:
        key = job_key(profile_id, desktop_id)
        with self._lock:
            jid = self._by_key.get(key)
            if not jid:
                return {"profileId": profile_id, "desktopId": desktop_id, "status": "idle", "jobId": None}
            j = self._jobs.get(jid) or {}
            return {"profileId": profile_id, "desktopId": desktop_id, "jobId": jid,
                    "status": j.get("status", "unknown"), "protocol": j.get("protocol"),
                    "pid": j.get("pid"), "startedAt": j.get("startedAt")}

    def get_statuses(self, profile_id: str) -> List[Dict[str, Any]]:
        """Return status for every desktop in this profile (idle for unstarted)."""
        out = []
        with self._lock:
            prefix = profile_id + ":"
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

    def recent_logs(self, profile_id: str, desktop_id: Optional[str] = None,
                    limit: int = 200) -> Dict[str, List[Dict[str, str]]]:
        """Return logs keyed by desktop_id.

        If desktop_id is given, returns only that desktop's logs.
        If None (batch), returns all desktops' logs for this profile.
        """
        with self._lock:
            prefix = profile_id + ":"
            result: Dict[str, List[Dict[str, str]]] = {}
            for key, jid in self._by_key.items():
                if not key.startswith(prefix):
                    continue
                did = key[len(prefix):]
                if desktop_id and did != desktop_id:
                    continue
                buf = self._log_buffers.get(jid, [])
                result[did] = list(buf)[-limit:]
            return result

    def clear_logs(self, profile_id: str, desktop_id: str = "") -> Dict[str, Any]:
        cnt = 0
        with self._lock:
            prefix = profile_id + ":"
            for key, jid in list(self._by_key.items()):
                if not key.startswith(prefix):
                    continue
                if desktop_id and key != profile_id + ":" + desktop_id:
                    continue
                buf = self._log_buffers.get(jid, [])
                cnt += len(buf)
                self._log_buffers[jid] = []
        return {"cleared": cnt}

    # ------------------------------------------------------------------
    # Start / stop
    # ------------------------------------------------------------------

    def start_job(self, profile_id: str, desktop_id: str, state_path: Path,
                  protocol: str = "ZTE", extra_args: Optional[List[str]] = None,
                  mode: str = "dry-run", interval_sec: Optional[int] = None,
                  traffic_sec: Optional[int] = None,
                  duration_sec: Optional[int] = None) -> Dict[str, Any]:
        protocol = (protocol or "ZTE").upper()
        if protocol == "V3":
            return self._start_job_v3(profile_id, desktop_id, state_path, extra_args, mode,
                                       interval_sec, traffic_sec, duration_sec)
        if protocol not in ("ZTE", "SCG", "CAG"):
            raise ValueError("protocol must be ZTE, SCG, CAG, or V3")
        mode = (mode or "dry-run").lower()
        if mode in ("live", "prod", "production"):
            if not live_allowed():
                raise RuntimeError("LIVE_DISABLED: set CMCC_WEBUI_ALLOW_LIVE=1 and mode=live to spawn child")
            mode = "live"
        else:
            mode = "dry-run"

        state_path = Path(state_path)
        key = job_key(profile_id, desktop_id)
        with self._lock:
            existing = self._by_key.get(key)
            if existing and self._jobs.get(existing, {}).get("status") == "running":
                raise RuntimeError("JOB_IN_USE")

            old_jid = self._by_key.get(key)
            job_id = uuid.uuid4().hex[:12]
            job: Dict[str, Any] = {
                "id": job_id, "jobId": job_id, "profileId": profile_id, "desktopId": desktop_id,
                "statePath": str(state_path), "protocol": protocol, "mode": mode,
                "status": "running", "pid": None, "startedAt": _now_iso(), "stoppedAt": None,
                "detail": "dry-run FakeBackend (no LIVE child)" if mode == "dry-run" else "live subprocess pending",
                "extraArgs": list(extra_args or []), "intervalSec": interval_sec,
                "trafficSec": traffic_sec, "durationSec": duration_sec,
                "backend": "fake" if mode == "dry-run" else "subprocess", "exitCode": None,
            }
            self._jobs[job_id] = job
            self._by_key[key] = job_id
            self._log_buffers.setdefault(job_id, [])
            if old_jid and old_jid != job_id:
                old_logs = self._log_buffers.get(old_jid, [])
                if old_logs:
                    self._log_buffers[job_id] = list(old_logs[-200:]) + self._log_buffers[job_id]
            stop_evt = threading.Event()
            self._stop_events[job_id] = stop_evt

        try:
            if mode == "dry-run":
                backend = FakeBackend(self, job_id, stop_evt, protocol=protocol,
                                       traffic_sec=traffic_sec,
                                       user_service_id=_usid_from_state(state_path))
            else:
                jdir = _jobs_dir() / job_id
                jdir.mkdir(parents=True, exist_ok=True)
                log_path = jdir / "worker.log"
                lock_path = _data_dir() / "locks" / f"{profile_id}_{desktop_id}.lock"
                backend = SubprocessBackend(self, job_id, state_path=state_path, protocol=protocol,
                                            extra_args=extra_args, stop_evt=stop_evt,
                                            log_path=log_path, lock_path=lock_path)
            backend.start()
            with self._lock:
                self._backends[job_id] = backend
                pid = backend.pid()
                if pid is not None:
                    self._jobs[job_id]["pid"] = pid
                    self._jobs[job_id]["detail"] = f"live subprocess pid={pid}"
                job_out = dict(self._jobs[job_id])
        except Exception as e:
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["status"] = "error"; j["stoppedAt"] = _now_iso()
                    j["detail"] = f"start failed: {e}"
                self._stop_events.pop(job_id, None)
            self._append_log(job_id, f"[orch] start failed: {e}")
            raise

        self._append_log(job_id, f"[orch] start protocol={protocol} mode={mode} desktop={desktop_id}")
        return job_out

    def _start_job_v3(self, profile_id: str, desktop_id: str, state_path: Path,
                      extra_args, mode, interval_sec, traffic_sec, duration_sec):
        sp = Path(state_path) if not isinstance(state_path, Path) else state_path
        key = job_key(profile_id, desktop_id)
        job_id = uuid.uuid4().hex[:12]
        job: Dict[str, Any] = {
            "id": job_id, "jobId": job_id, "profileId": profile_id, "desktopId": desktop_id,
            "statePath": str(sp), "protocol": "V3", "mode": mode or "live",
            "status": "running", "pid": None, "startedAt": _now_iso(), "stoppedAt": None,
            "detail": "V3 keepalive starting", "extraArgs": list(extra_args or []),
            "intervalSec": interval_sec, "trafficSec": traffic_sec, "durationSec": duration_sec,
            "backend": "subprocess-v3", "exitCode": None,
        }
        with self._lock:
            existing = self._by_key.get(key)
            if existing and self._jobs.get(existing, {}).get("status") == "running":
                raise RuntimeError("JOB_IN_USE")
            old_jid = self._by_key.get(key)
            self._jobs[job_id] = job
            self._by_key[key] = job_id
            self._log_buffers.setdefault(job_id, [])
            if old_jid and old_jid != job_id:
                old_logs = self._log_buffers.get(old_jid, [])
                if old_logs:
                    self._log_buffers[job_id] = list(old_logs[-200:]) + self._log_buffers[job_id]
            stop_evt = threading.Event()
            self._stop_events[job_id] = stop_evt
        jdir = _jobs_dir() / job_id
        jdir.mkdir(parents=True, exist_ok=True)
        log_path = jdir / "worker.log"
        backend = SimpleAliveBackend(self, job_id, state_path=sp, extra_args=extra_args,
                                      stop_evt=stop_evt, log_path=log_path)
        try:
            backend.start()
            with self._lock:
                self._backends[job_id] = backend
                pid = backend.pid()
                if pid is not None:
                    job["pid"] = pid; job["detail"] = f"V3 subprocess pid={pid}"
                job_out = dict(self._jobs[job_id])
        except Exception as e:
            with self._lock:
                j = self._jobs.get(job_id)
                if j:
                    j["status"] = "error"; j["stoppedAt"] = _now_iso()
                    j["detail"] = f"V3 start failed: {e}"
                self._stop_events.pop(job_id, None)
            self._append_log(job_id, f"[orch] V3 start failed: {e}")
            raise
        self._append_log(job_id, f"[orch] V3 started desktop={desktop_id}")
        return job_out

    def stop_job(self, profile_id: str, desktop_id: str) -> Dict[str, Any]:
        key = job_key(profile_id, desktop_id)
        with self._lock:
            jid = self._by_key.get(key)
            if not jid or jid not in self._jobs:
                raise KeyError("NOT_FOUND")
            job = self._jobs[jid]
            if job.get("status") != "running":
                return dict(job)
            backend = self._backends.get(jid)
            stop_evt = self._stop_events.get(jid)
        if stop_evt is not None:
            stop_evt.set()
        if backend is not None:
            try:
                backend.stop()
            except Exception as e:
                self._append_log(jid, f"[orch] stop error: {e}")
        return self._mark_stopped(jid, detail="stopped by API")

    def stop_all(self, profile_id: str) -> List[Dict[str, Any]]:
        """Stop all running desktop jobs for a profile."""
        results = []
        with self._lock:
            prefix = profile_id + ":"
            keys = [k for k in self._by_key if k.startswith(prefix)]
        for key in keys:
            did = key[len(profile_id) + 1:]
            try:
                results.append(self.stop_job(profile_id, did))
            except KeyError:
                pass
        return results

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _append_log(self, job_id: str, line: str, *, dedupe: bool = False) -> None:
        safe = _redact_line(line)
        at = _now_iso()
        with self._lock:
            if dedupe and self._last_log_line.get(job_id) == safe:
                return
            self._last_log_line[job_id] = safe
            buf = self._log_buffers.setdefault(job_id, [])
            buf.append({"at": at, "line": safe})
            if len(buf) > 500:
                del buf[:len(buf) - 500]

    def _mark_stopped(self, job_id: str, *, detail: str, exit_code: Optional[int] = None,
                      status: str = "stopped") -> Dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return {"jobId": job_id, "status": status, "detail": detail}
            if job.get("status") not in ("running", "pending"):
                return dict(job)
            job["status"] = status
            job["stoppedAt"] = _now_iso()
            job["detail"] = detail
            if exit_code is not None:
                job["exitCode"] = exit_code
            out = dict(job)
            self._backends.pop(job_id, None)
            self._stop_events.pop(job_id, None)
        self._append_log(job_id, f"[orch] {detail}")
        return out
