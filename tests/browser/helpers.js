// @ts-check
const { expect } = require("@playwright/test");

/** 打开页面并清空存档，得到种子数据（3 设备 6 锚点的一致三角） */
async function openFresh(page) {
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('[data-testid="device-row"]')).toHaveCount(3);
  return page;
}

/** 按设备名称正则选择下拉项 */
async function selectDevice(page, selectTestid, nameRegex) {
  const value = await page.locator(selectTestid).evaluate((sel, pattern) => {
    const opt = [...sel.options].find(o => new RegExp(pattern).test(o.textContent));
    if (!opt) throw new Error("未找到匹配 /" + pattern + "/ 的选项：" + [...sel.options].map(o => o.textContent).join(" | "));
    return opt.value;
  }, nameRegex.source);
  await page.selectOption(selectTestid, value);
  return value;
}

async function clickRecalibrate(page) {
  await page.click('[data-testid="recalibrate"]');
}

module.exports = { openFresh, selectDevice, clickRecalibrate };
