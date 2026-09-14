/* 时间工具：本地钟面时间统一换算为“当日秒”。
 *
 * 唯一合法书写：HH:MM:SS，可选恰好三位毫秒 .fff。
 *   合法：00:00:00  09:59:40  23:59:59.500
 *   非法：10:00        缺少秒
 *         10:00:00.5   毫秒不足三位（混合写法）
 *         10:00:00,500 逗号小数（混合写法）
 *         24:00:00 / 10:60:00 / 10:00:60  越界
 * 注：引擎内部仍允许“当日秒”为负或超 86400（由合法钟面换算路径产生的跨日结果），
 *     但用户直接录入必须是当日有效钟面读数。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TimeUtil = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const HOUR_MAX = 23, MIN_MAX = 59, SEC_MAX = 59;

  function pad(n, w) {
    n = String(Math.trunc(Math.abs(n)));
    while (n.length < (w || 2)) n = "0" + n;
    return n;
  }

  /**
   * 校验并解析严格的当日钟面时间。
   * @returns {{ok:true, seconds:number, text:string} | {ok:false, reason:string, code:string}}
   */
  function validate(raw) {
    if (typeof raw === "number") {
      return Number.isFinite(raw)
        ? { ok: true, seconds: raw, text: format(raw) }
        : { ok: false, code: "TIME_FORMAT", reason: "时间不是有限数值" };
    }
    if (typeof raw !== "string") {
      return { ok: false, code: "TIME_FORMAT", reason: "时间必须是字符串 HH:MM:SS" };
    }
    const s = raw.trim();
    if (s === "") return { ok: false, code: "TIME_FORMAT", reason: "时间为空" };

    // 恰好：两位时 : 两位分 : 两位秒，可选“.” + 恰好三位毫秒
    const m = s.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/);
    if (!m) {
      let code = "TIME_FORMAT";
      let reason;
      if (/^\d{1,2}:\d{1,2}$/.test(s)) {
        reason = "缺少秒：时间必须为 HH:MM:SS，例如 10:00:00（不接受 10:00）";
        code = "TIME_MISSING_SECONDS";
      } else if (/[,，]/.test(s)) {
        reason = "混合格式：毫秒请用英文句点且恰好三位，例如 10:00:00.500（不接受逗号 10:00:00,500）";
      } else if (/\.\d+$/.test(s) && !/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(s)) {
        reason = "混合格式：毫秒必须恰好三位，例如 10:00:00.500（不接受 .5 或 .50）";
      } else if (/^\d{1,2}:\d{1,2}:\d{1,2}(?:\.(\d+))?$/.test(s)) {
        reason = "混合格式：时、分、秒都必须是两位数字，例如 09:05:02";
      } else {
        reason = "格式无效：必须是 HH:MM:SS，可选三位毫秒（.fff），例如 09:59:40 或 23:59:59.250";
      }
      return { ok: false, code, reason };
    }

    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    const se = parseInt(m[3], 10);
    const ms = m[4] !== undefined ? parseInt(m[4], 10) : 0;

    if (h > HOUR_MAX) return rangeFail("时", h, HOUR_MAX);
    if (mi > MIN_MAX) return rangeFail("分", mi, MIN_MAX);
    if (se > SEC_MAX) return rangeFail("秒", se, SEC_MAX);

    const seconds = h * 3600 + mi * 60 + se + ms / 1000;
    return { ok: true, seconds, text: s };
  }

  function rangeFail(part, val, max) {
    return {
      ok: false,
      code: "TIME_RANGE",
      reason: part + "超出范围：" + String(val).padStart(2, "0") +
        " 不是合法的" + part + "值（允许 00–" + String(max).padStart(2, "0") + "）"
    };
  }

  /** 严格解析：非法返回 null。供引擎内部数据规范化使用 */
  function parse(str) {
    if (typeof str === "number") return Number.isFinite(str) ? str : null;
    const r = validate(str);
    return r.ok ? r.seconds : null;
  }

  /** 格式化秒数为 HH:MM:SS[.fff]，跨日带 (±Nd) 标注；仅用于显示换算结果，不用于录入 */
  function format(sec, opts) {
    opts = opts || {};
    if (!Number.isFinite(sec)) return sec > 0 ? "+∞" : "−∞";
    const neg = sec < -1e-9;
    const ms = Math.round(Math.abs(sec) * 1000);
    let rem = ms;
    const milli = rem % 1000; rem = Math.floor(rem / 1000);
    const second = rem % 60; rem = Math.floor(rem / 60);
    const minute = rem % 60; rem = Math.floor(rem / 60);
    let hour = rem;
    let day = 0;
    if (!opts.allowOverflow) { day = Math.floor(hour / 24); hour %= 24; }
    let out = (neg ? "-" : "") + pad(hour) + ":" + pad(minute) + ":" + pad(second);
    if (milli || opts.ms) out += "." + pad(milli, 3);
    if (day) out += " (+" + day + "d)";
    return out;
  }

  const DAY = 86400;

  return { validate, parse, format, pad, DAY };
});
