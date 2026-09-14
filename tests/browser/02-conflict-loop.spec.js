// @ts-check
const { test, expect } = require("@playwright/test");
const { openFresh, clickRecalibrate, selectDevice } = require("./helpers");

/** 构造“一致三角”引擎并发布 v1，然后把直连边改成矛盾边（60s 偏差） */
async function seedPublishedThenConflict(page) {
  return page.evaluate(() => {
    const e = new CalibrationEngine();
    const c = e.addDevice("camera", "相机");
    const w = e.addDevice("divewatch", "潜水表");
    const s = e.addDevice("sonar", "声呐");
    e.addAnchor(c, s, "10:00:00", "10:00:10");
    e.addAnchor(c, s, "11:00:00", "11:00:10");
    e.addAnchor(c, w, "10:00:00", "09:59:40");
    e.addAnchor(c, w, "11:00:00", "10:59:40");
    e.addAnchor(w, s, "09:59:40", "10:00:10");
    e.addAnchor(w, s, "10:59:40", "11:00:10");
    e.recalibrate();
    return e.publish("一致版本").then(p => {
      // 直连 W-S 改为相差 60s：经相机路径相差 30s，两者分歧 30s
      const edge = e.anchors.filter(a => (a.a === w && a.b === s) || (a.a === s && a.b === w));
      e.updateAnchor(edge[0].id, { a: w, b: s, ta: "09:59:40", tb: "10:00:40" });
      e.updateAnchor(edge[1].id, { a: w, b: s, ta: "10:59:40", tb: "11:00:40" });
      window.__calib.load(e.serialize());
      return { publish: p, ids: { c, w, s }, versionId: p.version.id };
    });
  });
}

test.describe("矛盾环路与失败回滚", () => {
  test("矛盾环路：两条路径相差 30 秒，报告 PATH_CONFLICT 与冲突来源", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await seedPublishedThenConflict(page);
    await clickRecalibrate(page);

    const card = page.locator('[data-testid="error-card"]').first();
    await expect(card).toHaveAttribute("data-code", "PATH_CONFLICT");
    await expect(card).toContainText("30.00 秒");
    // 冲突的两条路径名称都被展示
    await expect(card).toContainText("路径 1");
    await expect(card).toContainText("路径 2");
    // 相关锚点标红
    await expect(page.locator("tr.conflict-row").first()).toBeVisible();
    // “定位”按钮可将冲突来源锚点滚动到可视区
    await page.locator('[data-testid="locate-source"]').first().click();
    await expect(page.locator("tr.conflict-row").first()).toBeInViewport();
  });

  test("失败不改变已发布版本：发布被拒、v1 换算结果不变", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    const { ids, versionId } = await seedPublishedThenConflict(page);

    // 发布前版本数 1
    const countBefore = await page.locator('[data-testid="version-item"]').count();
    expect(countBefore).toBe(1);

    await clickRecalibrate(page);
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();

    // 即便直接调用发布也必须失败
    const res = await page.evaluate(() => window.__calib.publish());
    expect(res.ok).toBe(false);
    expect(["NOT_CALIBRATED", "PUBLISH_BUSY"]).toContain(res.code);

    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="version-item"]').first()).toContainText(versionId);

    // 草稿换算被拒
    await selectDevice(page, '[data-testid="convert-src"]', /相机$/);
    await selectDevice(page, '[data-testid="convert-dst"]', /潜水表$/);
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("NOT_CALIBRATED");

    // 旧版本仍可用且结果为一致版本的 10:29:40
    await page.selectOption('[data-testid="convert-version"]', versionId);
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:29:40");
    await expect(page.locator('[data-testid="result-box"]')).toContainText(versionId);

    // 刷新后：已发布版本依旧存在，草稿依旧失败
    await page.reload();
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
  });

  test("修正矛盾后重校恢复，可发布新版本", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await seedPublishedThenConflict(page);
    await clickRecalibrate(page);
    await expect(page.locator('[data-testid="error-card"]').first()).toHaveAttribute("data-code", "PATH_CONFLICT");

    // 通过 UI 删除两条矛盾锚点，改为与经相机路径一致（相差 30s）
    for (let i = 0; i < 2; i++) {
      const rows = page.locator('[data-testid="anchor-row"]');
      const n = await rows.count();
      // 种子中最后两行即 W-S 矛盾边
      await rows.nth(n - 1).locator('[data-del-anchor]').click();
    }
    await expect(page.locator('[data-testid="anchor-row"]')).toHaveCount(4);
    // 添加一致但时刻不同的闭合边（与 v1 签名不同）：仍为相差 30s，覆盖区间外扩
    await selectDevice(page, '[data-testid="anchor-a"]', /· 潜水表$/);
    await page.fill('[data-testid="anchor-ta"]', "09:30:00");
    await selectDevice(page, '[data-testid="anchor-b"]', /· 声呐$/);
    await page.fill('[data-testid="anchor-tb"]', "09:30:30");
    await page.click('[data-testid="anchor-save"]');
    await selectDevice(page, '[data-testid="anchor-a"]', /· 潜水表$/);
    await page.fill('[data-testid="anchor-ta"]', "11:30:00");
    await selectDevice(page, '[data-testid="anchor-b"]', /· 声呐$/);
    await page.fill('[data-testid="anchor-tb"]', "11:30:30");
    await page.click('[data-testid="anchor-save"]');

    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(2);
  });
});
