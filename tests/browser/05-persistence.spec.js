// @ts-check
const { test, expect } = require("@playwright/test");
const { openFresh, clickRecalibrate, selectDevice } = require("./helpers");

test.describe("持久化、旧标记兼容与离线", () => {
  test("刷新不丢数据：设备、锚点、已发布版本与换算结果全部保留", async ({ page }) => {
    await openFresh(page);
    await clickRecalibrate(page);
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
    const v1Text = (await page.locator('[data-testid="version-item"]').first().textContent()) || "";
    const v1Id = (v1Text.match(/v\d+-[0-9a-f]+/) || [""])[0];

    await page.reload();
    await expect(page.locator('[data-testid="device-row"]')).toHaveCount(3);
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(6);
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="version-item"]').first()).toContainText(v1Id);
    // 重载后自动重算状态：种子数据一致 → 可发布
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /侧扫声呐S1/);
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:30:10");
  });

  test("旧潜水标记 zfl30Marks 保留只读展示，且不受清空操作影响", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("zfl30Marks", JSON.stringify([
        { id: "x1", code: "A-017", type: "ceramic", dive: "DIVE-01", depth: "17.8m", x: 42, y: 46 },
        { id: "x2", code: "W-003", type: "wood", dive: "DIVE-02", depth: "18.2m", x: 58, y: 39 }
      ]));
      location.reload();
    });
    await expect(page.locator('[data-testid="legacy-list"] tr')).toHaveCount(2);
    await expect(page.locator("#legacyPanel")).toContainText("A-017");
    await expect(page.locator("#legacyPanel")).toContainText("W-003");
    // 校准数据仍是独立的种子
    await expect(page.locator('[data-testid="device-row"]')).toHaveCount(3);

    // 清空校准数据不动旧标记
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('[data-testid="reset"]');
    await expect(page.locator('[data-testid="legacy-list"] tr')).toHaveCount(2);
    const marks = await page.evaluate(() => JSON.parse(localStorage.getItem("zfl30Marks") || "[]").length);
    expect(marks).toBe(2);
  });

  test("断网模拟下所有本地功能可用（无任何外部请求依赖）", async ({ page, context }) => {
    await openFresh(page);
    // 阻断一切非本机网络请求，模拟船载无网环境
    await context.route("**/*", route => {
      if (route.request().url().startsWith("http://127.0.0.1")) return route.continue();
      return route.abort();
    });
    await page.reload();
    await expect(page.locator('[data-testid="device-row"]')).toHaveCount(3);
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /侧扫声呐S1/);
    await page.fill('[data-testid="convert-time"]', "10:15:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:15:10");
  });

  test("file:// 直接打开（双击 index.html）同样可用", async ({ browser }) => {
    // 独立上下文经 file:// 打开，无任何 HTTP 依赖
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("file:///workspace/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.goto("file:///workspace/index.html");
    await expect(page.locator('[data-testid="device-row"]')).toHaveCount(3);
    await page.click('[data-testid="recalibrate"]');
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /侧扫声呐S1/);
    await page.fill('[data-testid="convert-time"]', "10:45:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:45:10");
    // 刷新后数据仍在（file origin 持久化）
    await page.reload();
    await expect(page.locator('[data-testid="device-row"]')).toHaveCount(3);
    await context.close();
  });
});
