// @ts-check
const { test, expect } = require("@playwright/test");
const { openFresh, clickRecalibrate, selectDevice } = require("./helpers");

/**
 * 三设备三角：相机-声呐恒 +10s、相机-潜水表恒 −20s；
 * 潜水表-声呐边加入一个“内部锚点”，使直连路径仅在该锚点时刻比
 * 间接路径多出 midDelta 秒（分段线性偏差的段内峰值，固定步长采样会漏检）。
 */
async function loadPeakScene(page, midTb) {
  await page.goto("/index.html");
  await page.evaluate(mid => {
    localStorage.clear();
    const e = new CalibrationEngine();
    const c = e.addDevice("camera", "相机");
    const w = e.addDevice("divewatch", "潜水表");
    const s = e.addDevice("sonar", "声呐");
    e.addAnchor(c, s, "10:00:00", "10:00:10");
    e.addAnchor(c, s, "11:00:00", "11:00:10");
    e.addAnchor(c, w, "10:00:00", "09:59:40");
    e.addAnchor(c, w, "11:00:00", "10:59:40");
    e.addAnchor(w, s, "09:59:40", "10:00:10");
    e.addAnchor(w, s, "10:29:40", mid);
    e.addAnchor(w, s, "10:59:40", "11:00:10");
    window.__calib.load(e.serialize());
  }, midTb);
}

test.describe("分段映射的段内偏差峰值（精确折点检测）", () => {
  test("内部锚点处 1.005 秒偏差：拒绝发布，报告冲突来源与两条路径，不产生版本", async ({ page }) => {
    await loadPeakScene(page, "10:30:11.005");
    await clickRecalibrate(page);

    await expect(page.locator("#statusText")).toContainText("校准未通过");
    const card = page.locator('[data-testid="error-card"]').first();
    await expect(card).toHaveAttribute("data-code", "PATH_CONFLICT");
    await expect(card).toContainText("1.005 秒");
    await expect(card).toContainText(/上限 1 秒/);
    // 冲突来源：两条具体路径 + 锚点定位按钮 + 锚点行标红
    await expect(card).toContainText("路径 1");
    await expect(card).toContainText("路径 2");
    await expect(page.locator("tr.conflict-row").first()).toBeVisible();
    await expect(card.locator('[data-testid="locate-source"]').first()).toBeVisible();

    // 发布按钮禁用；直接调用发布同样被拒，版本数保持 0
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
    const res = await page.evaluate(() => window.__calib.publish());
    expect(res.ok).toBe(false);
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(0);
  });

  test("偏差恰好 1.000 秒：校准通过可发布；合法换算结果保留", async ({ page }) => {
    await loadPeakScene(page, "10:30:11.000");
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await expect(page.locator("#agreementValue")).toContainText("1.00 秒");
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);

    // 合法换算照常：相机 10:30 → 潜水表 10:29:40
    await selectDevice(page, '[data-testid="convert-src"]', /相机$/);
    await selectDevice(page, '[data-testid="convert-dst"]', /潜水表$/);
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:29:40");
  });

  test("失败后修正为 0.999 秒：重校恢复并发布；失败期间从未增加版本", async ({ page }) => {
    await loadPeakScene(page, "10:30:11.005");
    await clickRecalibrate(page);
    const res = await page.evaluate(() => window.__calib.publish());
    expect(res.ok).toBe(false);
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(0);

    // 修正内部锚点（直连与间接路径差 0.999s）
    await page.evaluate(() => {
      const e = window.__calib.engine();
      const mid = e.anchors.find(a => a.tb === "10:30:11.005");
      e.updateAnchor(mid.id, { tb: "10:30:10.999" });
      window.__calib.save();
    });
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
    await expect(page.locator("#agreementValue")).toContainText("0.999 秒");
    await page.click('[data-testid="publish"]');
    await expect(page.locator('[data-testid="version-item"]')).toHaveCount(1);
  });
});

test.describe("双页面共享存档并发发布", () => {
  test("两个页面同时发布同一草稿：恰好一次成功，另一页明确拒绝，刷新后版本一致", async ({ browser }) => {
    const context = await browser.newContext();
    const p1 = await context.newPage();
    const p2 = await context.newPage();

    // 页面 1 建立共享存档（种子一致三角），页面 2 读取同一份存档
    await p1.goto("/index.html");
    await p1.evaluate(() => localStorage.clear());
    await p1.reload();
    await p1.click('[data-testid="recalibrate"]');
    await expect(p1.locator("#statusText")).toContainText("校准通过");

    await p2.goto("/index.html");
    await expect(p2.locator('[data-testid="device-row"]')).toHaveCount(3);
    await p2.click('[data-testid="recalibrate"]');
    await expect(p2.locator("#statusText")).toContainText("校准通过");

    // 同时点击两页发布
    const [r1, r2] = await Promise.all([
      p1.evaluate(() => window.__calib.publish()),
      p2.evaluate(() => window.__calib.publish())
    ]);
    const results = [r1, r2];
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const loser = results.find(r => !r.ok);
    expect(loser.code).toBe("ALREADY_PUBLISHED");
    expect(loser.message).toMatch(/已发布|拒绝/);
    expect(results[0].versionsAfter).toBe(1);
    expect(results[1].versionsAfter).toBe(1);

    // 两页都只显示一个版本（败者页面即时同步共享存档）
    await expect(p1.locator('[data-testid="version-item"]')).toHaveCount(1);
    await expect(p2.locator('[data-testid="version-item"]')).toHaveCount(1);
    const id1 = await p1.locator('[data-testid="version-item"]').first().getAttribute("data-version");
    const id2 = await p2.locator('[data-testid="version-item"]').first().getAttribute("data-version");
    expect(id1).toBeTruthy();
    expect(id1).toBe(id2);

    // 败者页面的草稿合法换算仍然可用（失败没有破坏草稿）
    await p2.fill('[data-testid="convert-time"]', "10:30:00");
    await p2.click('[data-testid="convert-btn"]');
    await expect(p2.locator('[data-testid="result-time"]')).toHaveText("10:29:40");
    // 败者使用已发布版本换算同样可用
    await p2.selectOption('[data-testid="convert-version"]', id2);
    await p2.click('[data-testid="convert-btn"]');
    await expect(p2.locator('[data-testid="result-time"]')).toHaveText("10:29:40");

    // 刷新后两页版本一致，仍只有一个
    await p1.reload();
    await p2.reload();
    await expect(p1.locator('[data-testid="version-item"]')).toHaveCount(1);
    await expect(p2.locator('[data-testid="version-item"]')).toHaveCount(1);
    const n1 = await p1.locator('[data-testid="version-item"]').first().getAttribute("data-version");
    const n2 = await p2.locator('[data-testid="version-item"]').first().getAttribute("data-version");
    expect(n1).toBe(id1);
    expect(n2).toBe(id1);

    await context.close();
  });

  test("一页发布后，另一打开中的页面经 storage 事件实时同步版本", async ({ browser }) => {
    const context = await browser.newContext();
    const p1 = await context.newPage();
    const p2 = await context.newPage();
    await p1.goto("/index.html");
    await p1.evaluate(() => localStorage.clear());
    await p1.reload();
    await p1.click('[data-testid="recalibrate"]');
    await p2.goto("/index.html");
    await p2.click('[data-testid="recalibrate"]');

    await expect(p2.locator('[data-testid="version-item"]')).toHaveCount(0);
    await p1.evaluate(() => window.__calib.publish());
    // 页面 2 无需操作即可看到新版本
    await expect(p2.locator('[data-testid="version-item"]')).toHaveCount(1);
    await expect(p2.locator("#flash")).toContainText("另一页面");
    await context.close();
  });

  test("校准失败的页面发布被拒：不增加版本、不覆盖他页已发布结果", async ({ browser }) => {
    const context = await browser.newContext();
    const good = await context.newPage();
    const bad = await context.newPage();

    await good.goto("/index.html");
    await good.evaluate(() => localStorage.clear());
    await good.reload();
    await good.click('[data-testid="recalibrate"]');
    const pub = await good.evaluate(() => window.__calib.publish());
    expect(pub.ok).toBe(true);
    const v1 = pub.version.id;

    // 第二页构造矛盾草稿后尝试发布
    await bad.goto("/index.html");
    await bad.evaluate(() => {
      const e = window.__calib.engine();
      const [w, s] = [e.devices[1].id, e.devices[2].id];
      const edge = e.anchors.filter(a => (a.a === w && a.b === s) || (a.a === s && a.b === w));
      e.updateAnchor(edge[0].id, { a: w, b: s, ta: "09:59:40", tb: "10:00:40" });
      e.updateAnchor(edge[1].id, { a: w, b: s, ta: "10:59:40", tb: "11:00:40" });
      window.__calib.save();
    });
    await bad.click('[data-testid="recalibrate"]');
    await expect(bad.locator('[data-testid="publish"]')).toBeDisabled();
    const res = await bad.evaluate(() => window.__calib.publish());
    expect(res.ok).toBe(false);
    expect(["NOT_CALIBRATED", "PUBLISH_CONFLICT"]).toContain(res.code);
    expect(res.versionsAfter).toBe(1);

    // 已发布版本内容未被覆盖：v1 换算结果不变
    await bad.selectOption('[data-testid="convert-version"]', v1);
    await bad.fill('[data-testid="convert-time"]', "10:30:00");
    await bad.click('[data-testid="convert-btn"]');
    await expect(bad.locator('[data-testid="result-time"]')).toHaveText("10:29:40");

    await bad.reload();
    await expect(bad.locator('[data-testid="version-item"]')).toHaveCount(1);
    await expect(bad.locator('[data-testid="version-item"]').first()).toHaveAttribute("data-version", v1);
    await context.close();
  });
});
