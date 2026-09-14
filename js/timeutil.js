/* 时间工具：本地钟面时间统一换算为“当日秒”(可负、可超 86400，以保留跨日偏移) */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TimeUtil = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pad(n, w) {
    n = String(Math.trunc(Math.abs(n)));
    while (n.length < (w || 2)) n = "0" + n;
    return n;
  }

  /**
   * 解析 "HH:MM:SS"（允许 .fff）为自 00:00 起的秒数。
   * 允许 HH 超出 24 或为负，用于表达跨日钟面读数；非法输入返回 null。
   */
  function parse(str) {
    if (typeof str === "number") return Number.isFinite(str) ? str : null;
    if (typeof str !== "string") return null;
    const m = str.trim().match(/^(-?)(\d{1,3}):([0-5]?\d)(?::([0-5]?\d)(?:[.,](\d{1,3}))?)?$/);
    if (!m) return null;
    const neg = m[1] === "-";
    let v = parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60;
    if (m[4] !== undefined) v += parseInt(m[4], 10);
    if (m[5]) v += parseInt((m[5] + "00").slice(0, 3), 10) / 1000;
    return neg ? -v : v;
  }

  /** 秒数格式化为 HH:MM:SS.fff，跨日/负值带 (±Nd) 标注 */
  function format(sec, opts) {
    opts = opts || {};
    if (!Number.isFinite(sec)) return sec > 0 ? "+∞" : "−∞";
    const neg = sec < -1e-9;
    let a = Math.abs(sec);
    const ms = Math.round(a * 1000);
    let rem = ms;
    const milli = rem % 1000; rem = Math.floor(rem / 1000);
    const second = rem % 60; rem = Math.floor(rem / 60);
    const minute = rem % 60; rem = Math.floor(rem / 60);
    let hour = rem;
    let day = 0;
    if (!opts.allowOverflow) { day = Math.floor(hour / 24); hour %= 24; }
    let s = (neg ? "-" : "") + pad(hour) + ":" + pad(minute) + ":" + pad(second);
    if (milli || opts.ms) s += "." + pad(milli, 3);
    if (day) s += " (+" + day + "d)";
    return s;
  }

  const DAY = 86400;

  return { parse, format, pad, DAY };
});
