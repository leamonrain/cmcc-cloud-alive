#!/bin/bash
# 移动云电脑保活 - 一键启动脚本
# 使用方法：bash bin/cmcc-alive.sh

set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# 检查Python
if ! command -v python3 &> /dev/null; then
    echo "错误：未找到 python3，请先安装 Python 3.10+"
    exit 1
fi

# 检查并安装依赖
if ! python3 -c "import cryptography" 2>/dev/null; then
    echo "正在安装依赖..."
    pip3 install --user --break-system-packages cryptography 2>/dev/null || \
    pip3 install cryptography 2>/dev/null || \
    echo "警告：cryptography 安装失败，部分功能可能不可用"
fi

# 运行保活工具
echo "=========================================="
echo "  移动云电脑保活工具"
echo "=========================================="
echo ""

PYTHONPATH="$DIR" exec python3 -m cmcc_cloud_alive "$@"
