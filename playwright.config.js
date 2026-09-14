// @ts-check
const { defineConfig, devices } = require("@playwright/test");
const fs = require("fs");

// 无 root 环境：Chromium 依赖库解压在本地目录，经 LD_LIBRARY_PATH 注入
const LOCAL_LIBS = "/tmp/chromelibs/lib/aarch64-linux-gnu:/tmp/chromelibs/usr/lib/aarch64-linux-gnu";
const extraEnv = fs.existsSync("/tmp/chromelibs/usr/lib/aarch64-linux-gnu/libnss3.so")
  ? { LD_LIBRARY_PATH: LOCAL_LIBS + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "") }
  : {};

module.exports = defineConfig({
  testDir: "./tests/browser",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8971",
    headless: true,
    actionTimeout: 5000,
    launchOptions: { env: { ...process.env, ...extraEnv } }
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: undefined } }
  ],
  webServer: {
    command: "node tests/server.js",
    url: "http://127.0.0.1:8971/index.html",
    reuseExistingServer: false,
    timeout: 10000
  }
});
