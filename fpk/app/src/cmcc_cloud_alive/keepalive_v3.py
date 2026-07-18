"""保活V3：CAG TCP/TLS持久连接 + SPICE主握手 + 自动重连"""

import time
from . import auth, cag_boot, cloud, core, desktop_keepalive, token
from .core import summarize_cag_response, cag_https_request, create_cag_connect_desktop_body, json_dumps_compact, get_firm_auth
from .zte_connect_params import decode_connect_params, inner_from_connect_params
from .zte_cag import build_cag_auth_blob, dial_cag_tcp_tls, CAGDialOptions
from .zte_cag_mux import CAGMux, open_cag_mux_link
from .zte_raw_spice import RawMainHandshake


def simple_alive_v3(
    username=None, password=None, state_path=None,
    user_service_id=None,
    run_seconds=5400,
    connect_str_renew_minutes=30,
):
    state_path = str(core.state_path(state_path))
    target = user_service_id

    if not core.load_state(state_path).get("sohoToken"):
        if not username or not password:
            raise core.CmccError("需要账号密码登录")
        auth.password_login(username, password, state_path, save_password=True)

    if target:
        # Already selected by cmd_simple_keepalive (main.py line ~2013); skip redundant
        # select_desktop which calls listClouds API — that fails with 4015 on restart
        # when the shared acct file's token hasn't been accepted yet.
        print(f"已选择云电脑 userServiceId={target}", flush=True)
    else:
        items = cloud.list_desktops(state_path)
        target = str(items[0]["userServiceId"])
        cloud.select_desktop(target, state_path)
        print(f"已选择云电脑 userServiceId={target}", flush=True)

    # Initial status check; the inner loop re-checks and handles failures inside
    # its try/except, so a transient 4015 here is non-fatal.
    try:
        item = cloud.status(target, state_path)
        state_text = "开机运行中" if cloud.is_running(item) else "已关机"
        print(f"[V3] 云桌面状态：{state_text}", flush=True)
        if not cloud.is_running(item):
            print("云电脑未开机，正在开机...", flush=True)
            cag_boot.ensure_running(target, state_path, 60, 180)
            print("开机完成", flush=True)
        else:
            print("云电脑已运行", flush=True)
    except Exception as e:
        print(f"[V3] 云桌面状态：查询中… ({e})", flush=True)
        print(f"[V3] 初始状态检查跳过: {e}，内层循环会自动处理", flush=True)

    try:
        disc = desktop_keepalive.disconnect_time(target, state_path)
        msg = disc.get("data", {}).get("message") or disc.get("message", "")
        if msg:
            print(f"官方提示：{msg}", flush=True)
    except Exception:
        pass

    started = time.time()
    count = 0
    shutdowns = 0
    renew_interval = connect_str_renew_minutes * 60
    last_renew = 0.0
    connect_str = None
    firm = None

    args = core.argparse.Namespace(
        state=state_path,
        user_service_id=target,
        boot_wait=60, timeout=30,
        version="V7.25.40-HY",
        client_ip="", mac="", host_name="",
    )

    def get_connect_str():
        nonlocal firm
        firm = get_firm_auth(args)
        version = getattr(args, "version", "V7.25.40-HY")
        sys_path = f"/cs/cs_sysConfig.action?version={version}&language=zh&requestFrom=5&name={firm['vmUserName']}&RspSecurity=1"
        sys_resp = cag_https_request(firm, sys_path, "", timeout=30)
        _, sys_dec = summarize_cag_response(sys_resp)
        rsa_pub = sys_dec.get("rsapub")
        if not rsa_pub:
            raise core.CmccError("CAG sysConfig未返回rsapub")
        body = create_cag_connect_desktop_body(firm, rsa_pub, args)
        conn_resp = cag_https_request(firm, "/cs/cs_connectDesktop.action", json_dumps_compact(body["body"]), timeout=30)
        _, conn_dec = summarize_cag_response(conn_resp)
        connect_info = (conn_dec or {}).get("connectInfo", {})
        conn_str = connect_info.get("connectStr", "")
        if not conn_str:
            raise core.CmccError("CAG connectDesktop未返回connectStr")
        return conn_str

    def setup_cag_session(cs):
        cp = decode_connect_params(cs)
        inner = inner_from_connect_params(cp)
        auth_hex = build_cag_auth_blob(inner, None).hex()
        opts = CAGDialOptions(
            address=f'{firm["cagIp"]}:{firm["cagPort"]}',
            inner=inner,
            auth_template_hex=auth_hex,
            timeout=30.0,
        )
        tls_conn, _session = dial_cag_tcp_tls(opts)
        mux = CAGMux.open(tls_conn)
        main_link = open_cag_mux_link(mux, cp)
        hs = RawMainHandshake(
            main_link, cp.key, cp.vm_id,
            main_link.link_uuid, main_link.trace_id, main_link.redq_span_id,
        )
        if not hs.OK:
            main_link.close()
            mux.close()
            tls_conn.close()
            raise core.CmccError(f"SPICE握手失败: {hs.error}")
        return tls_conn, mux, main_link, cp

    print(f"\n保活V3启动 时长={run_seconds}s "
          f"connectStr续期={connect_str_renew_minutes}分钟", flush=True)
    print("=" * 50, flush=True)

    while True:
        now = time.time()
        if run_seconds and now - started >= run_seconds:
            break

        count += 1
        el = int(now - started)

        try:
            valid = token.ensure_token(state_path, relogin=False)
            if not (valid[0] if isinstance(valid, (tuple, list)) else valid):
                pw = core.load_state(state_path).get("_password") or password
                if pw:
                    auth.password_login(
                        core.load_state(state_path).get("username", username),
                        pw, state_path, save_password=False,
                    )
                else:
                    raise core.CmccError("token失效")

            item = cloud.status(target, state_path)
            state_text = "开机运行中" if cloud.is_running(item) else "已关机"
            print(f"[{core.short_time()}] 云桌面状态：{state_text}", flush=True)
            if not cloud.is_running(item):
                shutdowns += 1
                print(f"[{core.short_time()}] 桌面已关机(第{shutdowns}次)，正在开机...", flush=True)
                cag_boot.ensure_running(target, state_path, 60, 180)
                print(f"[{core.short_time()}] 开机完成", flush=True)
                connect_str = get_connect_str()

            if connect_str is None or (renew_interval and now - last_renew >= renew_interval):
                connect_str = get_connect_str()
                last_renew = now

            tls_conn, mux, main_link, cp = setup_cag_session(connect_str)
            print(f"[{core.short_time()}] CAG TCP/TLS连接建立成功", flush=True)

            session_start = time.time()
            while True:
                if run_seconds and time.time() - started >= run_seconds:
                    break
                if time.time() - session_start >= 90:
                    break

                try:
                    main_link.sendall(b"\x00\x00\x00\x00")
                except Exception:
                    break

                token.ensure_token(state_path)
                item = cloud.status(target, state_path)
                state_text = "开机运行中" if cloud.is_running(item) else "已关机"
                print(f"[{core.short_time()}] 云桌面状态：{state_text}", flush=True)
                if not cloud.is_running(item):
                    shutdowns += 1
                    print(f"[{core.short_time()}] 桌面已关机(第{shutdowns}次)，退出当前会话", flush=True)
                    break

                elapsed = int(time.time() - started)
                print(f"[{core.short_time()}] #{count} el={elapsed}s CAG连接正常", flush=True)
                time.sleep(30)

            try:
                main_link.close()
            except Exception:
                pass
            try:
                mux.close()
            except Exception:
                pass
            try:
                tls_conn.close()
            except Exception:
                pass

        except KeyboardInterrupt:
            print("\n收到中断", flush=True)
            break
        except Exception as e:
            print(f"[{core.short_time()}] #{count} 异常: {e}，等待后重试", flush=True)
            time.sleep(10)

    elapsed = int(time.time() - started)
    print(f"\n保活结束，运行{elapsed}秒，{count}轮，关机{shutdowns}次", flush=True)
    return {"elapsed": elapsed, "rounds": count, "shutdowns": shutdowns}
