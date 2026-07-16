#!/bin/bash
# CGI proxy — set up PATH then delegate to Python
export PATH="/var/apps/python312/target/bin:$TRIM_APPDEST/.venv/bin:/usr/local/bin:/usr/bin:/bin"
exec python3 "$TRIM_APPDEST/app/ui/proxy.py"
