// @ts-check
const { test, expect } = require("@playwright/test");
const { openFresh, clickRecalibrate, selectDevice } = require("./helpers");

test.describe("跨设备分段线性换算（真实浏览器 UI）", () => {
  test("相机→潜水表→声呐：三角闭合多路径一致，换算结果精确", async ({ page }) => {
    await openFresh(page);
    // 种子数据重校：声呐=相机+10s，潜水表=相机−20s，三边闭合
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toHaveText("校准通过 · 可发布");
    await expect(page.locator("#agreementValue")).toContainText("0.00 秒");

    // 相机 10:30:00 → 潜水表（−20s）
    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /潜水表W2/);
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:29:40");

    // 相机 → 声呐（+10s）
    await selectDevice(page, '[data-testid="convert-dst"]', /侧扫声呐S1/);
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:30:10");

    // 潜水表 → 声呐（反向路径，经相机：+30s）
    await selectDevice(page, '[data-testid="convert-src"]', /潜水表W2/);
    await selectDevice(page, '[data-testid="convert-dst"]', /侧扫声呐S1/);
    await page.fill('[data-testid="convert-time"]', "10:00:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:00:30");
    await expect(page.locator('[data-testid="result-box"]')).toContainText(/潜水表W2.*声呐S1/s);
  });

  test("分段漂移：段内线性插值精确，跨段斜率不同", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const e = new CalibrationEngine();
      const a = e.addDevice("camera", "CAM");
      const b = e.addDevice("sonar", "SON");
      // 10:00 同步；11:00 声呐快 2s（2 s/h，合法）；12:00 共快 5s（3 s/h，合法）
      e.addAnchor(a, b, "10:00:00", "10:00:00");
      e.addAnchor(a, b, "11:00:00", "11:00:02");
      e.addAnchor(a, b, "12:00:00", "12:00:05");
      window.__calib.load(e.serialize());
    });
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");

    const conv = async t => {
      await page.fill('[data-testid="convert-time"]', t);
      await page.click('[data-testid="convert-btn"]');
      return (await page.locator('[data-testid="result-time"]').textContent()) || "";
    };
    expect(await conv("10:30:00")).toBe("10:30:01"); // 第一段中点
    expect(await conv("11:30:00")).toBe("11:30:03.500"); // 第二段中点
    expect(await conv("11:00:00")).toBe("11:00:02"); // 锚点处
  });

  test("越界外推：覆盖区间之外的读数被拒绝", async ({ page }) => {
    await openFresh(page);
    await clickRecalibrate(page);
    await page.fill('[data-testid="convert-time"]', "12:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("PATH_BROKEN");
    await expect(page.locator('[data-testid="result-error"]')).toContainText("越界");
    await expect(page.locator('[data-testid="result-time"]')).toHaveCount(0);

    // 默认目标为潜水表（−20s），边界内仍可用
    await selectDevice(page, '[data-testid="convert-src"]', /船载相机A/);
    await selectDevice(page, '[data-testid="convert-dst"]', /潜水表W2/);
    await page.fill('[data-testid="convert-time"]', "10:30:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:29:40");
  });

  test("漂移超过 5 秒/小时被拒绝（5 秒恰可通过）", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const e = new CalibrationEngine();
      const a = e.addDevice("camera", "CAM");
      const b = e.addDevice("sonar", "SON");
      e.addAnchor(a, b, "10:00:00", "10:00:00");
      e.addAnchor(a, b, "11:00:00", "11:00:06"); // 6 s/h，拒绝
      window.__calib.load(e.serialize());
    });
    await clickRecalibrate(page);
    await expect(page.locator('[data-testid="error-card"]').first()).toHaveAttribute("data-code", "DRIFT_SEGMENT");
    await expect(page.locator("#reportBody")).toContainText("6.00 秒/小时");
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();

    // 改成恰好 5 秒/小时 → 通过
    await page.evaluate(() => {
      const e = window.__calib.engine();
      e.updateAnchor(e.anchors[1].id, { tb: "11:00:05" });
      window.__calib.save();
      location.reload();
    });
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");
  });

  test("锚点未严格递增（任一台设备钟面倒退）被拒绝", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const e = new CalibrationEngine();
      const a = e.addDevice("camera", "CAM");
      const b = e.addDevice("sonar", "SON");
      e.addAnchor(a, b, "10:00:00", "10:00:05");
      e.addAnchor(a, b, "11:00:00", "10:00:04"); // B 倒退 1 秒
      window.__calib.load(e.serialize());
    });
    await clickRecalibrate(page);
    await expect(page.locator('[data-testid="error-card"]').first()).toHaveAttribute("data-code", "ORDER_ANCHORS");
    // 问题锚点被标红
    await expect(page.locator("tr.conflict-row")).toHaveCount(2);
  });

  test("路径断开：孤立设备无法发布，错误指出设备来源", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const e = new CalibrationEngine();
      const a = e.addDevice("camera", "CAM");
      const b = e.addDevice("divewatch", "WATCH");
      e.addDevice("sonar", "ORPHAN-SONAR");
      e.addAnchor(a, b, "10:00:00", "10:00:00");
      e.addAnchor(a, b, "11:00:00", "11:00:02");
      window.__calib.load(e.serialize());
    });
    await clickRecalibrate(page);
    const cards = page.locator('[data-testid="error-card"]');
    await expect(cards.first()).toHaveAttribute("data-code", "PATH_BROKEN");
    await expect(page.locator("#reportBody")).toContainText("ORPHAN-SONAR");
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
  });

  test("链式路径覆盖区间不相交（A-B 上午、B-C 下午）：校准拒绝", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const e = new CalibrationEngine();
      const a = e.addDevice("camera", "CAM");
      const b = e.addDevice("divewatch", "WATCH");
      const c = e.addDevice("sonar", "SON");
      e.addAnchor(a, b, "10:00:00", "10:00:00");
      e.addAnchor(a, b, "11:00:00", "11:00:01");
      // B-C 只覆盖 B 的 12:00–13:00，与 A-B 的 B 区间 10:00–11:00 不相交
      e.addAnchor(b, c, "12:00:00", "12:00:00");
      e.addAnchor(b, c, "13:00:00", "13:00:01");
      window.__calib.load(e.serialize());
    });
    await clickRecalibrate(page);
    await expect(page.locator('[data-testid="error-card"]').first()).toHaveAttribute("data-code", "PATH_BROKEN");
    await expect(page.locator("#reportBody")).toContainText(/共同覆盖区间/);
    await expect(page.locator('[data-testid="publish"]')).toBeDisabled();
  });

  test("链式路径部分重叠：区间内可换算，区间外（即便落在首边域内）拒绝外推", async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const e = new CalibrationEngine();
      const a = e.addDevice("camera", "CAM");
      const b = e.addDevice("divewatch", "WATCH");
      const c = e.addDevice("sonar", "SON");
      e.addAnchor(a, b, "10:00:00", "10:00:00");
      e.addAnchor(a, b, "11:00:00", "11:00:00");
      // B-C 覆盖 B 的 10:30–11:30；共同源区间（A）为 10:30–11:00
      e.addAnchor(b, c, "10:30:00", "10:30:00");
      e.addAnchor(b, c, "11:30:00", "11:30:00");
      window.__calib.load(e.serialize());
    });
    await clickRecalibrate(page);
    await expect(page.locator("#statusText")).toContainText("校准通过");

    await selectDevice(page, '[data-testid="convert-src"]', /CAM/);
    await selectDevice(page, '[data-testid="convert-dst"]', /SON/);
    // 共同区间内：成功
    await page.fill('[data-testid="convert-time"]', "10:45:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-time"]')).toHaveText("10:45:00");
    // 10:15 落在 A-B 域内但超出 B-C 覆盖：拒绝
    await page.fill('[data-testid="convert-time"]', "10:15:00");
    await page.click('[data-testid="convert-btn"]');
    await expect(page.locator('[data-testid="result-error"]')).toContainText("PATH_BROKEN");
    await expect(page.locator('[data-testid="result-error"]')).toContainText("越界");
  });
});
