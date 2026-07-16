"""SOHO token validity checks."""

import re
import time

from . import auth, core


INVALID_TOKEN_CODES = {4014, 4015, 4016, 4017, 4200, 4201}

# openresty / gateway blips and plain transport failures must NOT be treated
# as "token expired" — re-login against a 502 just cascades into a full crash.
_TRANSIENT_HTTP_RE = re.compile(r"HTTP\s+(5\d\d)\b", re.I)
_TRANSIENT_HINTS = (
    "network failed",
    "timed out",
    "timeout",
    "temporarily",
    "connection reset",
    "connection refused",
    "broken pipe",
    "bad gateway",
    "service unavailable",
    "gateway time",
)


def is_transient_error(exc_or_msg) -> bool:
    """Return True for gateway/network blips that say nothing about token validity."""
    msg = str(exc_or_msg or "")
    if not msg:
        return False
    if _TRANSIENT_HTTP_RE.search(msg):
        return True
    lower = msg.lower()
    return any(hint in lower for hint in _TRANSIENT_HINTS)


def _token_response_from_exc(exc):
    return {
        "code": 0,
        "msg": str(exc),
        "businessCode": "",
        "transient": is_transient_error(exc),
    }


def check_token(state_path=None, retries=3, retry_delay=1.5):
    """Check SOHO token.

    Retries a few times on HTTP 5xx / network blips.  If the gateway is still
    down after retries, the response is marked ``transient=True`` so callers
    skip re-login (re-login would just hit the same 502 and abort the loop).
    """
    args = core.argparse.Namespace(state=state_path)
    attempts = max(1, int(retries or 1))
    delay = max(0.0, float(retry_delay or 0.0))
    response = None

    for attempt in range(attempts):
        try:
            response = core.api_request("/token/checkToken/v1", None, args)
            break
        except Exception as exc:  # network/API errors
            response = _token_response_from_exc(exc)
            if response.get("transient") and attempt + 1 < attempts:
                time.sleep(delay * (attempt + 1))
                continue
            break

    if not isinstance(response, dict):
        response = {"code": 0, "msg": "empty token check response", "businessCode": "", "transient": True}

    try:
        code = int(response.get("code") or 0)
    except (TypeError, ValueError):
        code = 0

    # Real token validity only comes from a successful JSON business response.
    # Transient transport failures leave validity unknown — never force re-login.
    if response.get("transient"):
        valid = False
    else:
        valid = code == 2000 and code not in INVALID_TOKEN_CODES

    core.merge_state({
        "lastTokenCheckAt": core.shanghai_now().isoformat(),
        "lastTokenCheckResponse": {
            "code": response.get("code"),
            "msg": response.get("msg"),
            "businessCode": response.get("businessCode") or "",
            "transient": bool(response.get("transient")),
        },
    }, args)
    return valid, response


def ensure_token(state_path=None, relogin=True):
    valid, response = check_token(state_path)
    if valid:
        return True, response
    # Gateway blip: keep existing token, do not re-login into the same 502.
    if isinstance(response, dict) and response.get("transient"):
        return False, response
    if not relogin:
        return False, response
    state = auth.login_from_cached_credentials(state_path)
    return True, {"code": 2000, "msg": "re-login ok", "userId": state.get("userId")}
