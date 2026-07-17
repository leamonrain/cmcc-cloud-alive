"""CGI proxy — forward requests to local uvicorn daemon (127.0.0.1:TRIM_SERVICE_PORT)."""
import os, sys, urllib.request, urllib.error, time

APPDEST = "/var/apps/CMCCCloudAlive/target"
PORT = os.environ.get("TRIM_SERVICE_PORT", "18080")
PIDFILE = os.environ.get("TRIM_PKGVAR", APPDEST + "/../../var") + "/uvicorn.pid"

def ensure_backend():
    if os.path.exists(PIDFILE):
        try:
            with open(PIDFILE) as f:
                pid = int(f.read().strip())
            os.kill(pid, 0)
            return
        except (OSError, ValueError):
            pass
    pid = os.fork()
    if pid > 0:
        for _ in range(15):
            if os.path.exists(PIDFILE):
                try:
                    with open(PIDFILE) as f:
                        os.kill(int(f.read().strip()), 0)
                    return
                except: pass
            time.sleep(0.3)
    else:
        os.setsid()
        pid2 = os.fork()
        if pid2 > 0:
            os._exit(0)
        sys.stdout.flush(); sys.stderr.flush()
        os.chdir(APPDEST + "/src")
        with open("/dev/null", "r") as fd:
            os.dup2(fd.fileno(), 0)
        with open(os.environ.get("TRIM_PKGVAR", APPDEST + "/../../var") + "/uvicorn.log", "a") as log:
            os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
        venv_python = APPDEST + "/src/.venv/bin/python3"
        args = [venv_python, "-m", "uvicorn", "cmcc_cloud_alive.webui.app:app",
                "--host", "127.0.0.1", "--port", PORT,
                "--workers", "1", "--log-level", "info",
                "--app-dir", APPDEST + "/src"]
        os.execve(venv_python, args, {"PATH": APPDEST + "/src/.venv/bin:/var/apps/python312/target/bin:/usr/local/bin:/usr/bin",
                  "HOME": "/root", "LANG": "zh_CN.UTF-8"})

def main():
    ensure_backend()
    method = os.environ.get("REQUEST_METHOD", "GET")
    uri = os.environ.get("REQUEST_URI", "/")
    query = os.environ.get("QUERY_STRING", "")
    ctype = os.environ.get("CONTENT_TYPE", "")
    clen = os.environ.get("CONTENT_LENGTH", "0")
    clen_int = int(clen) if clen.isdigit() else 0
    rel = "/"
    idx = uri.find("index.cgi")
    if idx >= 0:
        rel = uri[idx + 9:]
    if not rel.startswith("/"):
        rel = "/" + rel
    target = f"http://127.0.0.1:{PORT}{rel}"
    if query:
        target += "?" + query
    body = sys.stdin.buffer.read(clen_int) if clen_int > 0 else b""
    req = urllib.request.Request(target, data=body or None, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    req.add_header("X-Forwarded-For", os.environ.get("REMOTE_ADDR", ""))
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        sys.stdout.write(f"Status: {resp.status} {resp.reason}\r\n")
        for k, v in resp.headers.items():
            lk = k.lower()
            if lk not in ("transfer-encoding", "content-encoding", "content-length", "connection"):
                sys.stdout.write(f"{k}: {v}\r\n")
        sys.stdout.write("\r\n"); sys.stdout.flush()
        chunk = resp.read()
        sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
    except urllib.error.HTTPError as e:
        sys.stdout.write(f"Status: {e.code} {e.reason}\r\n")
        sys.stdout.write("Content-Type: application/json\r\n\r\n"); sys.stdout.flush()
        sys.stdout.buffer.write(e.read()); sys.stdout.buffer.flush()
    except urllib.error.URLError as e:
        sys.stdout.write("Status: 502 Bad Gateway\r\n")
        sys.stdout.write("Content-Type: text/plain; charset=utf-8\r\n\r\n")
        sys.stdout.write(f"后端服务未就绪")
    except Exception as e:
        sys.stdout.write("Status: 500 Internal Server Error\r\n")
        sys.stdout.write("Content-Type: text/plain; charset=utf-8\r\n\r\n")
        sys.stdout.write(f"代理错误")

if __name__ == "__main__":
    main()
