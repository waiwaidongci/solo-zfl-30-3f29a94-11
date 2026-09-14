// @ts-check
const { test, expect } = require("@playwright/test");
const { openFresh, clickRecalibrate, selectDevice } = require("./helpers");

test.describe("增删改锚点后结果立即失效，重校恢复", () => {
  test("发布并换算后修改锚点：换算立即不可用，矛盾时重校拒绝，还原后恢复", async ({ page }) => {
    await openFresh(page);
    await clickRecalibrate(page);
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);

    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /侧扫声呐S1/);
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:30:10");

    // 通过 UI 编辑第一条锚点：直连相机-声呐改为 +12s，与经潜水表路径（+10s）相差 2 秒
    await page.locator('[data-edit-anchor]').first().click();
    await page.fill('[data-testid="anchor-ta"]', "10:00:00");
    await page.fill('[data-testid="anchor-tb"]', "10:00:12");
    await page.click('[data-testid="anchor-save"]');

    // 状态立即变为“已编辑 · 结果失效”，发布按钮禁用，换算面板显示失效
    await expect(page.locator("#statusText")).toContainText("失效");
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
    await expect(page.locator('[data-testid="result-invalidated"]')).toBeVisible();

    // 旧版本仍可换算出原值
    const v1 = await page.locator('[data-testid="version-item"]').first().getAttribute("data-version");
    await page.selectOption('[data-testid="convert-version"]', v1);
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:30:10");

    // 草稿换算显式被拒（STALE）
    await page.selectOption('[data-testid="convert-version"]', "draft");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("STALE");

    // 重校：2 秒矛盾 → PATH_CONFLICT，仍不能发布
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准未通过");
    await expect(page.locator('[data-testid="error-card"]').first()).toHaveAttribute("data-code", "PATH_CONFLICT");
    await expect(page.locator('[data-testid="error-card"]').first()).toContainText("2.00 秒");
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();

    // 还原锚点后重校恢复
    await page.locator('[data-edit-anchor]').first().click();
    await page.fill('[data-testid="anchor-tb"]', "10:00:10");
    await page.click('[data-testid="anchor-save"]');
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await page.selectOption('[data-testid="convert-version"]', "draft");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:30:10");
    // 失败期间从未产生新版本
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
  });

  test("删除锚点立即失效；删除设备全部关联锚点致设备孤立后路径断开、重校拒绝", async ({ page }) => {
    await openFresh(page);
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await page.evaluate(() => { window.confirm = () => true; });

    // 删除一条锚点：立即失效
    await page.locator('[data-del-anchor]').first().click();
    await expect(page.locator("#statusText")).toContainText("失效");
    await expect(page.locator('[data-testid="result-invalidated"]')).toBeVisible();
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();

    // 继续删除所有含“声呐”的锚点行（相机-声呐 2 条 + 潜水表-声呐 2 条），声呐成为孤立设备
    for (;;) {
      const rows = page.locator('[data-testid="anchor-row"]');
      const n = await rows.count();
      let idx = -1;
      for (let i = 0; i < n; i++) {
        const txt = (await rows.nth(i).textContent()) || "";
        if (txt.includes("侧扫声呐S1")) { idx = i; break; }
      }
      if (idx === -1) break;
      await rows.nth(idx).locator('[data-del-anchor]').click();
    }
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(2);
    await clickRecalibrate(page);
    await expect(page.locator('[data-testid="error-card"]').first()).toHaveAttribute("data-code", "PATH_BROKEN");
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
  });

  test("1 秒以内的多路径偏差视为一致，可以发布", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const e = new CalibrationEngine();
      const c = e.addDevice("camera", "相机");
      const w = e.addDevice("divewatch", "潜水表");
      const s = e.addDevice("sonar", "声呐");
      e.addAnchor(c, s, "10:00:00", "10:00:10");
      e.addAnchor(c, s, "11:00:00", "11:00:10");
      e.addAnchor(c, w, "10:00:00", "09:59:40");
      e.addAnchor(c, w, "11:00:00", "10:59:40");
      // 直连边隐含 +30s，这里做成 +30.6s（亚秒级分歧，经相机路径为 +30s）
      e.addAnchor(w, s, "09:59:40", "10:00:10.600");
      e.addAnchor(w, s, "10:59:40", "11:00:10.600");
      window.__calib.load(e.serialize());
    });
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await expect(page.locator("#agreementValue")).toContainText("0.60 秒");
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
  });
});
