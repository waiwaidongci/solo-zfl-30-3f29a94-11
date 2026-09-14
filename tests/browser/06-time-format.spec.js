// @ts-check
const { test, expect } = require("@playwright/test");
const { openFresh, clickRecalibrate, selectDevice } = require("./helpers");

/** 提交锚点表单（设备默认取前两台），ta/tb 为给定字符串 */
async function submitAnchor(page, ta, tb, { a = 0, b = 1 } = {}) {
  await selectDevice(page, '[data-testid="anchor-a"]', new RegExp(["船载相机A", "潜水表W2", "侧扫声呐S1"][a]));
  await selectDevice(page, '[data-testid="anchor-b"]', new RegExp(["船载相机A", "潜水表W2", "侧扫声呐S1"][b]));
  await page.fill('[data-testid="anchor-ta"]', ta);
  await page.fill('[data-testid="anchor-tb"]', tb);
  await page.click('[data-testid="anchor-save"]');
}

test.describe("严格时间格式 HH:MM:SS[.fff]", () => {
  test.beforeEach(async ({ page }) => {
    await openFresh(page);
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
  });

  test("合法：HH:MM:SS 与三位毫秒均可登记并参与换算", async ({ page }) => {
    const before = await page.locator('[data-testid="anchor-row"]').count();

    // 相机 12:00:00.250 ↔ 潜水表 11:59:40.250（沿用 −20s 偏移）
    await submitAnchor(page, "12:00:00.250", "11:59:40.250", { a: 0, b: 1 });
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before + 1);
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toBeHidden();
    await expect(page.locator('[data-testid="anchor-tb-error"]')).toBeHidden();
    // 登记新锚点 → 立即失效
    await expect(page.locator("#statusText")).toContainText("失效");

    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");

    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /潜水表W2/);
    await page.fill('[data-testid="convert-time"]', "12:00:00.250");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("11:59:40.250");

    // 换算也接受三位毫秒
    await page.fill('[data-testid="convert-time"]', "10:30:00.500");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:29:40.500");
  });

  test("非法一：缺少秒（10:00）——锚点不保存、字段内联报错、状态不失效", async ({ page }) => {
    const before = await page.locator('[data-testid="anchor-row"]').count();
    await submitAnchor(page, "10:00", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("缺少秒");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("HH:MM:SS");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);
    // 被拒绝的输入未改动数据：仍是校准通过，可发布
    await expect(page.locator("#statusText")).toContainText("校准通过");

    // 换算处同样拒绝
    await page.fill('[data-testid="convert-time"]', "09:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("TIME_MISSING_SECONDS");
    await expect(page.locator('[data-testid="result-error"]')).toContainText("缺少秒");
  });

  test("非法二：数值越界（24:00:00 / 10:60:00 / 10:00:60）全部拒绝", async ({ page }) => {
    const before = await page.locator('[data-testid="anchor-row"]').count();

    await submitAnchor(page, "24:00:00", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("时超出范围");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);

    await submitAnchor(page, "10:60:00", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("分超出范围");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);

    await submitAnchor(page, "10:00:00", "10:00:60");
    await expect(page.locator('[data-testid="anchor-tb-error"]')).toContainText("秒超出范围");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);

    // 换算处越界拒绝
    await page.fill('[data-testid="convert-time"]', "23:60:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("TIME_RANGE");
  });

  test("非法三：混合格式（.5 毫秒、逗号小数、单位数时分秒）全部拒绝", async ({ page }) => {
    const before = await page.locator('[data-testid="anchor-row"]').count();

    await submitAnchor(page, "10:00:00.5", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("毫秒必须恰好三位");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);

    await submitAnchor(page, "10:00:00,500", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("混合格式");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);

    await submitAnchor(page, "1:2:3", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("两位数字");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);

    // 四位毫秒也拒绝
    await submitAnchor(page, "10:00:00.5000", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toContainText("毫秒必须恰好三位");
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(before);

    // 换算处混合格式拒绝
    await page.fill('[data-testid="convert-time"]', "10:00:00,500");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("TIME_FORMAT");
  });

  test("字段内联错误在输入修正为合法值后立即消失", async ({ page }) => {
    await submitAnchor(page, "10:00", "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toBeVisible();
    await page.fill('[data-testid="anchor-ta"]', "10:00:00");
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toBeHidden();
    await expect(page.locator('[data-testid="anchor-ta"]')).not.toHaveClass(/invalid-input/);
  });
});

test.describe("非法时间导致的失效状态与刷新后结果", () => {
  test("存档中存在非法锚点：重校失败、草稿换算拒绝、旧版本仍可用；刷新后结论不变", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    const v1Id = await page.evaluate(() => {
      const e = new CalibrationEngine();
      const c = e.addDevice("camera", "相机");
      const w = e.addDevice("divewatch", "潜水表");
      e.addAnchor(c, w, "10:00:00", "09:59:40");
      e.addAnchor(c, w, "11:00:00", "10:59:40");
      e.recalibrate();
      return e.publish("合法版本").then(p => {
        // 绕过 UI 直接加入一个“缺秒”的坏锚点（模拟历史脏数据/手工改库）
        e.addAnchor(c, w, "12:00", "11:59:40");
        window.__calib.load(e.serialize());
        return p.version.id;
      });
    });

    await clickRecalibrate(page);
    const card = page.locator('[data-testid="error-card"]').first();
    await expect(card).toHaveAttribute("data-code", "TIME_MISSING_SECONDS");
    await expect(card).toContainText("缺少秒");
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
    await expect(page.locator("#statusText")).toContainText("校准未通过");

    // 草稿换算拒绝（NOT_CALIBRATED），而非给出错误数字
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("NOT_CALIBRATED");

    // 已发布旧版本仍可换算
    await page.selectOption('[data-testid="convert-version"]', v1Id);
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:29:40");

    // 刷新：非法锚点依旧被拦截，旧版本依旧可用，坏锚点行仍在（数据不丢）
    await page.reload();
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(3);
    await clickRecalibrate(page);
    await expect(page.locator('[data-testid="error-card"]').first()).toHaveAttribute("data-code", "TIME_MISSING_SECONDS");
    await page.selectOption('[data-testid="convert-version"]', v1Id);
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:29:40");
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);

    // 换算框在刷新后对非法输入仍给出同样错误
    await page.selectOption('[data-testid="convert-version"]', "draft");
    await page.fill('[data-testid="convert-time"]', "10:00:00.5");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("TIME_FORMAT");
  });

  test("合法数据刷新后保留并可继续换算；非法输入永远不写库", async ({ page }) => {
    await openFresh(page);
    // 通过 UI 用三位毫秒新增合法锚点（相机-潜水表 12:00 段）
    await selectDevice(page, '[data-testid="anchor-a"]', /船载相机A/);
    await selectDevice(page, '[data-testid="anchor-b"]', /潜水表W2/);
    await page.fill('[data-testid="anchor-ta"]', "12:00:00.000");
    await page.fill('[data-testid="anchor-tb"]', "11:59:40.000");
    await page.click('[data-testid="anchor-save"]');
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(7);

    // 再尝试输入非法值，必须不入库
    await page.fill('[data-testid="anchor-ta"]', "13:00");
    await page.fill('[data-testid="anchor-tb"]', "12:59:40");
    await page.click('[data-testid="anchor-save"]');
    await expect(page.locator('[data-testid="anchor-ta-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(7);

    // 刷新：7 条合法锚点仍在，非法的从未写入
    await page.reload();
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(7);
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /潜水表W2/);
    await page.fill('[data-testid="convert-time"]', "11:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("11:29:40");
  });
});
