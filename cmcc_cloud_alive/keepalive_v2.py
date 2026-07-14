"""保活V2：短周期CAG HTTPS连接刷新 + HTTP心跳"""

import time
from . import auth, cag_boot, cloud, core, desktop_keepalive, token


def simple_alive_v2(
    username=None, password=None, state_path=None,
    user_service_id=None,
    cag_interval=60,        # CAG连接刷新间隔秒数（默认60秒）
    run_seconds=5400,
):
    started = time.time()
    state_path = str(core.state_path(state_path))

    # 登录
    if not core.load_state(state_path).get("sohoToken"):
        if not username or not password:
            raise core.CmccError("需要账号密码登录")
        auth.password_login(username, password, state_path, save_password=True)

    # 选择云电脑
    if user_service_id:
        target = user_service_id
        cloud.select_desktop(target, state_path)
    else:
        items = cloud.list_desktops(state_path)
        target = str(items[0]["userServiceId"])
        cloud.select_desktop(target, state_path)
        if len(items) > 1:
            print(f"自动选择第1台", flush=True)

    print(f"已选择云电脑 userServiceId={target}", flush=True)

    # 确保开机
    item = cloud.status(target, state_path)
    if not cloud.is_running(item):
        print("云电脑未开机，正在开机...", flush=True)
        cag_boot.ensure_running(target, state_path, 60, 180)
        print("开机完成", flush=True)
    else:
        print("云电脑已运行", flush=True)

    # 首次获取关机时长
    try:
        disc = desktop_keepalive.disconnect_time(target, state_path)
        msg = disc.get("data", {}).get("message") or disc.get("message", "")
        if msg:
            print(f"官方提示：{msg}", flush=True)
    except Exception:
        pass

    last_cag = 0.0
    count = 0
    consecutive_fail = 0

    print(f"\n保活V2启动 cycle=每{cag_interval}s CAG刷新 时长={run_seconds}s", flush=True)
    print("=" * 50, flush=True)

    while True:
        now = time.time()
        if run_seconds and now - started >= run_seconds:
            break

        count += 1
        try:
            # token检查
            valid = token.ensure_token(state_path, relogin=False)
            if not (valid[0] if isinstance(valid, (tuple, list)) else valid):
                state = core.load_state(state_path)
                pw = state.get("_password") or password
                if pw:
                    auth.password_login(state.get("username", username), pw, state_path, save_password=False)
                else:
                    raise core.CmccError("token失效")

            # 检查桌面状态
            item = cloud.status(target, state_path)
            if not cloud.is_running(item):
                print(f"[{core.short_time()}] 桌面已关机，重新开机...", flush=True)
                cag_boot.ensure_running(target, state_path, 60, 180)
                print(f"[{core.short_time()}] 重新开机完成", flush=True)
                last_cag = now
                time.sleep(10)

            # CAG刷新：重新执行CAG HTTPS连接来维持真实会话
            if now - last_cag >= cag_interval:
                print(f"[{core.short_time()}] CAG会话连接刷新...", flush=True)
                try:
                    args = core.argparse.Namespace(
                        state=state_path,
                        user_service_id=target,
                        boot_wait=60, timeout=30,
                        version="V7.25.40-HY",
                        client_ip="", mac="", host_name="",
                    )
                    auth_data = core.get_firm_auth(args)
                    report = core.cag_https_connect_report(auth_data, args)
                    ok = report.get("finalConnect", {}).get("businessOk", False)
                    if ok:
                        print(f"[{core.short_time()}] CAG连接成功", flush=True)
                        consecutive_fail = 0
                    else:
                        consecutive_fail += 1
                        print(f"[{core.short_time()}] CAG连接失败({consecutive_fail})", flush=True)
                except Exception as e:
                    consecutive_fail += 1
                    print(f"[{core.short_time()}] CAG异常({consecutive_fail}): {e}", flush=True)
                last_cag = now

            # HTTP心跳（辅助）
            try:
                hb = desktop_keepalive.heartbeat(target, state_path)
                info = desktop_keepalive.info_report(state_path)
                hb_code = hb.get("code", "-")
                info_code = info.get("code", "-")
                elapsed = int(time.time() - started)
                print(f"[{core.short_time()}] #{count} elapsed={elapsed}s hb={hb_code} info={info_code}", flush=True)
            except Exception as e:
                print(f"[{core.short_time()}] #{count} 心跳异常: {e}", flush=True)

        except KeyboardInterrupt:
            print("\n收到中断", flush=True)
            break
        except Exception as e:
            print(f"[{core.short_time()}] #{count} 异常: {e}", flush=True)

        time.sleep(30)  # 每30秒检查一次

    elapsed = int(time.time() - started)
    print(f"\n结束，运行{elapsed}秒，{count}轮", flush=True)
    return {"elapsed": elapsed, "rounds": count}
