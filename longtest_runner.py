#!/usr/bin/env python3
"""Legacy-init-reconnect long-test runner (master#223 / w9).

Three tiers: 40min / 60min / 120min, run serially.
- keepalive thread: every 5min run a "burst" that reconnects product-keepalive
  until accumulated keepalive time >= 60s (each connection sends display/input
  init traffic; server drops the tunnel after ~4.5s due to ticket limits, so we
  reconnect to accumulate the requested 60s of traffic). This is the
  LEGACY init-reconnect path (NOT type=3 high-freq heartbeat).
- status thread: every 60s query cloud status (vmStatus/vmStatusShow/running).
- unified timestamped log + jsonl status file.
Usage: python3 longtest_runner.py --duration 2400 --label 40min
"""
import subprocess, time, json, os, threading, argparse
from datetime import datetime

STATE = "/home/demo/.local/bin/cloud_pc.json"
BIN = "/home/demo/restore/cmcc-cloud-alive/bin/cmcc_cloud_alive.py"
USID = "2663816"
KEEPALIVE_INTERVAL = 300  # 5 min between bursts
BURST_TARGET = 60         # accumulate 60s keepalive traffic per burst
STATUS_INTERVAL = 60      # 1 min between status checks

LOGDIR = "/home/demo/restore/cmcc-cloud-alive/longtest_logs"
os.makedirs(LOGDIR, exist_ok=True)

# set in main()
LOGFILE = None
STATUSFILE = None
LABEL = None

lock = threading.Lock()
def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    with lock:
        with open(LOGFILE, "a") as f:
            f.write(line + "\n")
        print(line, flush=True)

def base_cmd():
    return ["python3", BIN, "--state", STATE]

def run_keepalive_once(remaining):
    dur = max(10, int(remaining) + 10)
    cmd = base_cmd() + ["product-keepalive", "--duration", str(dur),
                        "--user-service-id", USID]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=dur + 90)
    except subprocess.TimeoutExpired:
        return time.time() - t0, None, False, "TIMEOUT"
    dt = time.time() - t0
    out = (p.stdout or "").strip()
    rep = None
    try:
        rep = json.loads(out)
    except Exception:
        for ln in reversed(out.splitlines()):
            ln = ln.strip()
            if ln.startswith("{"):
                try:
                    rep = json.loads(ln); break
                except Exception:
                    pass
    ka = rep.get("keepalive") if rep else None
    ok = rep.get("ok") if rep else False
    return dt, ka, ok, out

def keepalive_thread(end):
    burst_no = 0
    next_burst = time.time()
    while time.time() < end:
        now = time.time()
        if now < next_burst:
            time.sleep(min(2.0, next_burst - now))
            continue
        burst_no += 1
        log(f"########## 保活burst#{burst_no} 开始 (目标累计{BURST_TARGET}s屏幕/display流量) ##########")
        accumulated = 0.0
        attempt = 0
        total_ticks = 0
        while accumulated < BURST_TARGET and time.time() < end:
            attempt += 1
            remaining = BURST_TARGET - accumulated
            log(f"  --- 保活连接#{burst_no}.{attempt} 开始: 已累计{accumulated:.1f}s, 剩余{remaining:.1f}s ---")
            dt, ka, ok, raw = run_keepalive_once(remaining)
            accumulated += dt
            ticks = ka.get("ticks", 0) if ka else 0
            total_ticks += ticks
            log(f"  --- 保活连接#{burst_no}.{attempt} 结束: 耗时{dt:.1f}s, 累计{accumulated:.1f}s, ok={ok}, ticks={ticks}, counters={ka} ---")
            if ticks > 0:
                log(f"  >>> 已发送 display/input init 流量 (ticks={ticks}) <<<")
        log(f"########## 保活burst#{burst_no} 结束: 累计保活{accumulated:.1f}s, 共{attempt}次连接, 总ticks={total_ticks} ##########")
        next_burst += KEEPALIVE_INTERVAL

def status_thread(end):
    while time.time() < end:
        cmd = base_cmd() + ["status", USID]
        t0 = time.time()
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
            out = (p.stdout or "").strip()
        except subprocess.TimeoutExpired:
            out = "TIMEOUT"
        dt = time.time() - t0
        vmStatus = "?"; running = "?"; vmStatusShow = "?"
        try:
            d = json.loads(out)
            vmStatus = d.get("vmStatus", "?")
            vmStatusShow = d.get("vmStatusShow", "?")
            running = d.get("running", "?")
        except Exception:
            pass
        log(f"[状态检测] vmStatus={vmStatus} vmStatusShow={vmStatusShow} running={running} ({dt:.1f}s)")
        with open(STATUSFILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(), "vmStatus": vmStatus,
                                "vmStatusShow": vmStatusShow, "running": running,
                                "raw": out[:600]}, ensure_ascii=False) + "\n")
        time.sleep(STATUS_INTERVAL)

def main():
    global LOGFILE, STATUSFILE, LABEL
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=int, default=2400, help="total seconds")
    ap.add_argument("--label", default="40min", help="tier label for log filenames")
    args = ap.parse_args()
    LABEL = args.label
    TOTAL = args.duration
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    LOGFILE = os.path.join(LOGDIR, f"longtest_{LABEL}_{stamp}.log")
    STATUSFILE = os.path.join(LOGDIR, f"status_{LABEL}_{stamp}.jsonl")

    start = time.time()
    end = start + TOTAL
    log("=" * 70)
    log(f"########## 旧方案(legacy-init-reconnect)长测启动 [{LABEL}] (master#223 / w9) ##########")
    log(f"总时长={TOTAL}s({TOTAL/60:.0f}min) | 保活:每{KEEPALIVE_INTERVAL}s一个burst(每次累计{BURST_TARGET}s流量) | 状态检测:每{STATUS_INTERVAL}s")
    log(f"路径=legacy(DisplayInit+InputInit init单包+重连累计60s), 非type=3高频心跳")
    log(f"主日志={LOGFILE}")
    log(f"状态文件={STATUSFILE}")
    log(f"PID={os.getpid()}")
    log("=" * 70)
    # 首次状态检测(立即)
    cmd = base_cmd() + ["status", USID]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        out = (p.stdout or "").strip()
    except subprocess.TimeoutExpired:
        out = "TIMEOUT"
    dt = time.time() - t0
    vmStatus = "?"; running = "?"; vmStatusShow = "?"
    try:
        d = json.loads(out)
        vmStatus = d.get("vmStatus", "?")
        vmStatusShow = d.get("vmStatusShow", "?")
        running = d.get("running", "?")
    except Exception:
        pass
    log(f"[首次状态检测] vmStatus={vmStatus} vmStatusShow={vmStatusShow} running={running} ({dt:.1f}s) raw={out[:300]}")
    with open(STATUSFILE, "a") as f:
        f.write(json.dumps({"ts": datetime.now().isoformat(), "vmStatus": vmStatus,
                            "vmStatusShow": vmStatusShow, "running": running,
                            "raw": out[:600]}, ensure_ascii=False) + "\n")
    t1 = threading.Thread(target=keepalive_thread, args=(end,), daemon=True)
    t2 = threading.Thread(target=status_thread, args=(end,), daemon=True)
    t1.start(); t2.start()
    while time.time() < end:
        time.sleep(5)
    log(f"########## [{LABEL}] 长测结束 ##########")
    try:
        with open(STATUSFILE) as f:
            lines = f.readlines()
        log(f"[汇总] 状态检测共{len(lines)}次")
        off_count = sum(1 for l in lines if '"running": false' in l or '"vmStatus": "off"' in l.lower())
        log(f"[汇总] 关机/非运行次数={off_count}")
    except Exception as e:
        log(f"[汇总] 读取状态文件失败: {e}")

if __name__ == "__main__":
    main()
