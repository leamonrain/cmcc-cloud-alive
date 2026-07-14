"""简约版云电脑保活 - 登录、开机、保活循环、定期CAG刷新、自动重连"""

import time
import sys
from pathlib import Path

from . import auth, cag_boot, cloud, core, desktop_keepalive, token


def simple_alive(
    username=None, password=None, state_path=None,
    user_service_id=None, heartbeat_interval=120, cag_refresh_minutes=60,
    run_seconds=0, boot_wait=60, boot_timeout=180,
):
    started = time.time()
    state_path = str(core.state_path(state_path))
    target = None

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
        if not items:
            raise core.CmccError("没有找到云电脑")
        target = str(items[0]["userServiceId"])
        cloud.select_desktop(target, state_path)
        if len(items) > 1:
            vm_names = "; ".join(f"{i}:{item.get('vmName')}" for i, item in enumerate(items))
            print(f"自动选择第1台云电脑 ({vm_names})", flush=True)

    print(f"已选择云电脑 userServiceId={target}")

    # 开机
    item = cloud.status(target, state_path)
    if not cloud.is_running(item):
        print("云电脑未开机，正在开机...")
        cag_boot.ensure_running(target, state_path, boot_wait, boot_timeout)
        print("开机完成")
    else:
        print("云电脑已运行")

    # 首次获取自动关机时长
    try:
        disc = desktop_keepalive.disconnect_time(target, state_path)
        msg = disc.get("data", {}).get("message") or disc.get("message", "")
        if msg:
            print(f"官方提示：{msg}")
    except Exception:
        pass

    cag_refresh_seconds = cag_refresh_minutes * 60
    last_cag_refresh = 0.0
    count = 0

    print(f"\n开始保活 cycle={heartbeat_interval}s CAG刷新={cag_refresh_minutes}分钟"
          f" 时长={'永久' if not run_seconds else str(run_seconds) + 's'}")
    print("=" * 50)

    while True:
        now = time.time()
        if run_seconds and now - started >= run_seconds:
            break

        count += 1
        try:
            # 检查token
            valid = token.ensure_token(state_path, relogin=False)
            if not (valid[0] if isinstance(valid, (tuple, list)) else valid):
                state = core.load_state(state_path)
                pw = state.get("_password") or password
                if pw:
                    auth.password_login(state.get("username", username), pw, state_path, save_password=False)
                else:
                    raise core.CmccError("token失效，需要重新登录")

            # 检查状态，关机则重开
            item = cloud.status(target, state_path)
            if not cloud.is_running(item):
                print(f"[{core.short_time()}] 云电脑已关机，正在重新开机...")
                cag_boot.ensure_running(target, state_path, boot_wait, boot_timeout)
                print(f"[{core.short_time()}] 重新开机完成")
                last_cag_refresh = now

            # CAG周期性刷新
            if cag_refresh_seconds and now - last_cag_refresh >= cag_refresh_seconds:
                print(f"[{core.short_time()}] 执行CAG会话刷新...")
                try:
                    cag_boot.ensure_running(target, state_path, boot_wait, boot_timeout)
                    print(f"[{core.short_time()}] CAG刷新完成")
                except Exception as e:
                    print(f"[{core.short_time()}] CAG刷新失败: {e}")
                last_cag_refresh = now

            # 保活心跳
            result = desktop_keepalive.once(
                target, state_path,
                send_probe=False, send_point=False,
                send_disconnect_time=True, send_connect_events=False,
                use_firm_auth=True,
            )
            hb = result.get("heartbeat", {}).get("code", "-")
            info = result.get("infoReport", {}).get("code", "-")
            disc = result.get("disconnectTime", "")
            status = "✓" if result.get("candidateAccepted") else "△"
            elapsed = int(time.time() - started)
            print(f"[{core.short_time()}] #{count} {status} "
                  f"elapsed={elapsed}s hb={hb} info={info}", flush=True)

        except KeyboardInterrupt:
            print("\n收到中断，保活结束")
            break
        except Exception as e:
            print(f"[{core.short_time()}] #{count} 异常: {e}，等待后重试", flush=True)

        time.sleep(heartbeat_interval)

    elapsed = int(time.time() - started)
    print(f"\n保活结束，共运行 {elapsed} 秒，{count} 轮")
    return {"elapsed": elapsed, "rounds": count}
