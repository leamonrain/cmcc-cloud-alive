#!/bin/bash
APPDEST="/var/apps/CMCCCloudAlive/target"
export PATH="/var/apps/python312/target/bin:$APPDEST/src/.venv/bin:/usr/local/bin:/usr/bin:/bin"
exec python3 "$APPDEST/ui/proxy.py"
