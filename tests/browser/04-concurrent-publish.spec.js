// @ts-check
const { test, expect } = require("@playwright/test");
const { openFresh, clickRecalibrate } = require("./helpers");

test.describe("同一版本并发发布只成功一次", () => {
  test.beforeEach(async ({ page }) => {
    await openFresh(page);
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
  });

  test("同一引擎实例 Promise.all 并发 5 次发布：恰好 1 次成功", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const e = window.__calib.engine();
      const rs = await Promise.all([
        e.publish("并发-1"), e.publish("并发-2"), e.publish("并发-3"),
        e.publish("并发-4"), e.publish("并发-5")
      ]);
      return {
        oks: rs.map(r => r.ok),
        codes: rs.map(r => r.code || "OK"),
        count: e.versions.length
      };
    });
    expect(result.oks.filter(Boolean)).toHaveLength(1);
    expect(result.codes.filter(c => c === "OK")).toHaveLength(1);
    expect(result.codes.filter(c => c === "PUBLISH_BUSY")).toHaveLength(4);
    expect(result.count).toBe(1);
  });

  test("UI 快速连点发布按钮：只产生一个版本，后续给出拒绝提示", async ({ page }) => {
    await page.evaluate(() => {
      // 连续点击 5 次，全部在首个 await 让出窗口内发出
      const btn = document.querySelector('[data-testid="publish"]');
      for (let i = 0; i < 5; i++) btn.click();
    });
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
    // 给出明确反馈：成功或并发拒绝（最后停留的提示可能被拒绝信息覆盖）
    const flashText = (await page.locator("#flash").textContent()) || "";
    expect(flashText).toMatch(/发布成功|拒绝/);

    // 首版落定后再次发布：内容签名相同 → ALREADY_PUBLISHED，不产生 v2
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
  });

  test("草稿变更后：在未重校时发布一律拒绝，版本数不变", async ({ page }) => {    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
    // 改一条锚点（立即失效）
    const res = await page.evaluate(() => {
      const e = window.__calib.engine();
      const first = e.anchors[0];
      e.updateAnchor(first.id, { tb: "10:00:10" });
      return Promise.all([e.publish("x"), e.publish("y")]);
    });
    expect(res.every(r => !r.ok)).toBe(true);
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
  });
});

test("空校准（无设备/锚点）不允许发布", async ({ page }) => {
  await page.goto("/index.html");
  await page.evaluate(() => {
    localStorage.clear();
    window.__calib.load(new CalibrationEngine().serialize());
  });
  await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
  await clickRecalibrate(page);
  await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
  const res = await page.evaluate(() => window.__calib.publish());
  expect(res.ok).toBe(false);
  expect(res.code).toBe("NO_ANCHORS");
});
