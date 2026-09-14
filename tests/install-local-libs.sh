#!/usr/bin/env bash
# 无 root 环境下为 Playwright 下载的 Chromium 补齐系统共享库（Debian/Ubuntu）。
# 常规有 root 的机器请直接执行：npx playwright install-deps chromium
set -euo pipefail

DEB_DIR="${DEB_DIR:-/tmp/debs}"
LIB_DIR="${LIB_DIR:-/tmp/chromelibs}"
LISTS_DIR="${LISTS_DIR:-/tmp/apt/lists}"
CACHE_DIR="${CACHE_DIR:-/tmp/apt/cache}"

PKGS="libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libasound2 \
libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3 libgbm1 libxkbcommon0 \
libxi6 libdrm2 libwayland-server0"

mkdir -p "$DEB_DIR" "$LIB_DIR" "$LISTS_DIR/partial" "$CACHE_DIR/archives/partial"

apt-get update \
  -o "Dir::State::Lists=$LISTS_DIR/" \
  -o "Dir::Cache=$CACHE_DIR/" \
  -o "Dir::Cache::Archives=$CACHE_DIR/archives/" \
  >/dev/null

cd "$DEB_DIR"
apt-get download -y $PKGS \
  -o "Dir::State::Lists=$LISTS_DIR/" \
  -o "Dir::Cache=$CACHE_DIR/"
for d in "$DEB_DIR"/*.deb; do dpkg-deb -x "$d" "$LIB_DIR"; done

echo "完成。playwright.config.js 检测到 $LIB_DIR 时会自动注入 LD_LIBRARY_PATH。"
