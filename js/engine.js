/*
 * 多设备时钟校准引擎（无依赖，纯逻辑）
 *
 * 模型：每台设备持有自己的本地钟面时间（当日秒）。成对锚点 (A,B) 记录同一瞬间
 * 两台设备的本地读数，构成一条分段线性映射边。任意两设备之间通过图上路径
 * 连乘换算；同一设备对存在多条独立路径时，结果必须在 1 秒内一致才允许发布。
 *
 * 拒绝条件：
 *   ORDER_ANCHORS   锚点未按两台设备本地时间严格递增
 *   DRIFT_SEGMENT   某段漂移率超过 5 秒/小时
 *   PATH_BROKEN     设备不连通（路径断开），或换算点落在路径覆盖区间外（越界外推）
 *   PATH_CONFLICT   多条换算路径相差超过 1 秒（锚点矛盾/矛盾环路）
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./timeutil.js"));
  } else root.CalibrationEngine = factory(root.TimeUtil);
})(typeof self !== "undefined" ? self : this, function (TimeUtil) {
  "use strict";

  const DRIFT_LIMIT = 5;        // 每小时允许漂移秒数
  const AGREEMENT_LIMIT = 1;    // 多路径结果允许偏差（秒）
  const MAX_PATHS = 8;          // 每设备对最多枚举的独立路径
  const MAX_PATH_LEN = 6;       // 路径最多经过的边数
  const CHECK_STEP = 30;        // 路径一致性采样步长（秒）
  const EPS = 1e-9;

  const KIND_NAMES = { camera: "相机", divewatch: "潜水表", sonar: "声呐", other: "其他" };

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
  }

  function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }
  function orderedPairs(n) {
    const out = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
    return out;
  }

  /** 单边：锚点已按规范端点 devA 的本地时间 x 严格递增排序 */
  function makeEdge(anchorSet, devA, devB) {
    // 锚点可能以任意方向录入，统一为 (x=devA 时间, y=devB 时间)
    const pts = anchorSet
      .map(an => {
        const ta = TimeUtil.parse(an.ta), tb = TimeUtil.parse(an.tb);
        return an.a === devA
          ? { id: an.id, x: ta, y: tb }
          : { id: an.id, x: tb, y: ta };
      })
      .sort((p, q) => p.x - q.x);

    // —— 严格递增：A 侧排序后 B 侧也必须严格同序 ——
    for (let i = 1; i < pts.length; i++) {
      if (!(pts[i].x > pts[i - 1].x + EPS) || !(pts[i].y > pts[i - 1].y + EPS)) {
        return {
          error: {
            code: "ORDER_ANCHORS",
            message: "锚点必须严格递增：第 " + i + "、" + (i + 1) + " 个锚点在某台设备上不是递增关系",
            sources: [pts[i - 1].id, pts[i].id]
          }
        };
      }
    }

    // —— 每段漂移率 ≤ 5 秒/小时。用对称对数率 |ln(dy/dx)|，保证锚点反向录入时结论不变 ——
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      if (dx <= EPS) {
        return { error: { code: "ORDER_ANCHORS", message: "存在时间差为零的锚点段", sources: [pts[i - 1].id, pts[i].id] } };
      }
      const drift = Math.abs(Math.log(dy / dx)) * 3600;
      if (drift > DRIFT_LIMIT + 1e-4) {
        return {
          error: {
            code: "DRIFT_SEGMENT",
            message: "第 " + i + " 段漂移 " + drift.toFixed(2) + " 秒/小时，超过上限 " + DRIFT_LIMIT + " 秒/小时",
            sources: [pts[i - 1].id, pts[i].id],
            drift: drift
          }
        };
      }
    }

    return { edge: { a: devA, b: devB, pts } };
  }

  /** 沿一条边换算。dir=+1: A→B；dir=-1: B→A。仅接受锚点覆盖区间内的点（拒绝外推） */
  function mapAcross(edge, value, dir) {
    const pts = edge.pts;
    const forward = dir === 1;
    const xs = forward ? pts.map(p => p.x) : pts.map(p => p.y);
    const ys = forward ? pts.map(p => p.y) : pts.map(p => p.x);
    const lo = xs[0], hi = xs[xs.length - 1];
    if (value < lo - EPS || value > hi + EPS) {
      const err = new Error("越界：读数超出锚点覆盖区间 [" + TimeUtil.format(lo) + ", " + TimeUtil.format(hi) + "]，拒绝外推");
      err.code = "PATH_BROKEN";
      err.outOfRange = true;
      throw err;
    }
    // 单点锚点：该边只在该点有效
    if (xs.length === 1) {
      if (Math.abs(value - lo) > 1e-6) {
        const err = new Error("越界：该设备对只有一个锚点，仅可换算锚点时刻");
        err.code = "PATH_BROKEN";
        err.outOfRange = true;
        throw err;
      }
      return ys[0];
    }
    let i = 0;
    while (i < xs.length - 1 && value > xs[i + 1] + EPS) i++;
    const seg = Math.min(i, xs.length - 2);
    const t = (value - xs[seg]) / (xs[seg + 1] - xs[seg]);
    return ys[seg] + t * (ys[seg + 1] - ys[seg]);
  }

  /** 纯函数：在给定设备/锚点数据上做完整校准评估，供草稿与已发布快照共用 */
  function evaluateData(devices, anchors) {
    const errors = [];
    const devIndex = new Map(devices.map((d, i) => [d.id, i]));

    // 引用完整性
    for (const an of anchors) {
      if (!devIndex.has(an.a) || !devIndex.has(an.b)) {
        errors.push({
          code: "PATH_BROKEN",
          message: "锚点引用了未登记的设备",
          sources: [an.id],
          anchorId: an.id
        });
      }
      if (an.a === an.b) {
        errors.push({ code: "ORDER_ANCHORS", message: "锚点的两台设备不能相同", sources: [an.id], anchorId: an.id });
      }
      const va = TimeUtil.validate(an.ta);
      const vb = TimeUtil.validate(an.tb);
      if (!va.ok || !vb.ok) {
        const bad = !va.ok ? va : vb;
        const which = !va.ok ? "A" : "B";
        errors.push({
          code: bad.code,
          message: "锚点「" + an.ta + " / " + an.tb + "」中设备 " + which +
            " 的时间不合法：" + bad.reason,
          sources: [an.id],
          anchorId: an.id,
          field: which
        });
      }
    }

    // 构边
    const edgeMap = new Map();
    for (const an of anchors) {
      if (!devIndex.has(an.a) || !devIndex.has(an.b) || an.a === an.b) continue;
      edgeMap.set(pairKey(an.a, an.b), { a: an.a < an.b ? an.a : an.b, b: an.a < an.b ? an.b : an.a, anchors: [] });
    }
    for (const an of anchors) {
      if (!devIndex.has(an.a) || !devIndex.has(an.b) || an.a === an.b) continue;
      if (!TimeUtil.validate(an.ta).ok || !TimeUtil.validate(an.tb).ok) continue;
      edgeMap.get(pairKey(an.a, an.b)).anchors.push(an);
    }

    const edges = [];
    const edgeByKey = new Map();
    for (const [key, set] of edgeMap) {
      const built = makeEdge(set.anchors, set.a, set.b);
      if (built.error) { errors.push(built.error); continue; }
      edges.push(built.edge);
      edgeByKey.set(key, built.edge);
    }

    // 图连通性（按设备索引邻接，保证确定性）
    const adj = devices.map(() => []);
    for (const e of edges) {
      const i = devIndex.get(e.a), j = devIndex.get(e.b);
      adj[i].push(j); adj[j].push(i);
    }
    adj.forEach(list => list.sort((x, y) => x - y));

    const components = [];
    const seen = new Array(devices.length).fill(false);
    for (let s = 0; s < devices.length; s++) {
      if (seen[s]) continue;
      const comp = [];
      const q = [s]; seen[s] = true;
      while (q.length) {
        const u = q.shift();
        comp.push(u);
        for (const v of adj[u]) if (!seen[v]) { seen[v] = true; q.push(v); }
      }
      components.push(comp);
    }
    if (components.length > 1) {
      for (const comp of components) {
        errors.push({
          code: "PATH_BROKEN",
          message: "设备不连通：「" + comp.map(i => devices[i].name).join("、") + "」与其余设备之间缺少锚点路径",
          sources: comp.map(i => devices[i].id),
          component: comp
        });
      }
    }

    // 路径枚举（无结构错误且设备≥2 时才有意义）
    const pairReports = {};
    if (errors.length === 0 && devices.length >= 2) {
      const edgeAt = (u, v) => edgeByKey.get(pairKey(devices[u].id, devices[v].id));

      function enumerate(src, dst) {
        const results = [];
        function dfs(u, dstIdx, nodePath, edgePath, visited) {
          if (results.length >= MAX_PATHS) return;
          if (u === dstIdx) { results.push({ nodes: nodePath.slice(), edges: edgePath.slice() }); return; }
          if (nodePath.length > MAX_PATH_LEN) return;
          for (const v of adj[u]) {
            if (visited.has(v)) continue;
            const e = edgeAt(u, v);
            visited.add(v); nodePath.push(v); edgePath.push({ edge: e, dir: e.a === devices[u].id ? 1 : -1, from: u });
            dfs(v, dstIdx, nodePath, edgePath, visited);
            edgePath.pop(); nodePath.pop(); visited.delete(v);
          }
        }
        dfs(src, dst, [src], [], new Set([src]));
        // 按边数、再按节点名字排序，保证选路确定
        results.sort((p, q) => p.edges.length - q.edges.length ||
          p.nodes.map(i => devices[i].name).join(",").localeCompare(q.nodes.map(i => devices[i].name).join(",")));
        return results;
      }

      function applyPath(path, value) {
        let v = value;
        for (const step of path.edges) v = mapAcross(step.edge, v, step.dir);
        return v;
      }

      function edgeDomain(edge, dir) {
        const pts = edge.pts;
        const lo = dir === 1 ? pts[0].x : pts[0].y;
        const hi = dir === 1 ? pts[pts.length - 1].x : pts[pts.length - 1].y;
        return [Math.min(lo, hi), Math.max(lo, hi)];
      }

      function pathDomain(path) {
        // 前向：区间始终位于“当前设备坐标系”。每边先与该边入侧覆盖域取交，
        // 再把两端点映到下一坐标系；最后逐边反映射回源坐标系。
        // 严格单调保证端点始终在域内、次序保持。
        let lo = -Infinity, hi = Infinity;
        for (const step of path.edges) {
          const [dLo, dHi] = edgeDomain(step.edge, step.dir);
          lo = Math.max(lo, dLo);
          hi = Math.min(hi, dHi);
          if (hi < lo - EPS) return null;
          lo = mapAcross(step.edge, lo, step.dir);
          hi = mapAcross(step.edge, hi, step.dir);
        }
        for (let k = path.edges.length - 1; k >= 0; k--) {
          const step = path.edges[k];
          lo = mapAcross(step.edge, lo, -step.dir);
          hi = mapAcross(step.edge, hi, -step.dir);
        }
        return [lo, hi];
      }

      for (const [i, j] of orderedPairs(devices.length)) {
        const paths = enumerate(i, j);
        const enriched = paths.map(p => ({ nodes: p.nodes, edges: p.edges, domain: pathDomain(p) }));
        const usable = enriched.filter(p => p.domain);
        const key = pairKey(devices[i].id, devices[j].id);
        if (!usable.length) {
          pairReports[key] = { paths: enriched, usable: [], maxAgreement: null };
          errors.push({
            code: "PATH_BROKEN",
            message: "「" + devices[i].name + "」与「" + devices[j].name + "」之间没有落在共同覆盖区间内的有效换算路径",
            sources: [devices[i].id, devices[j].id]
          });
          continue;
        }

        // 共同源区间（取所有可用路径源域交集）
        let lo = -Infinity, hi = Infinity;
        for (const p of usable) { lo = Math.max(lo, p.domain[0]); hi = Math.min(hi, p.domain[1]); }

        let worst = 0;
        let worstPoint = null;
        let worstValues = null;
        if (Number.isFinite(lo) && Number.isFinite(hi) && usable.length >= 2 && hi - lo > EPS) {
          for (let t = lo; t <= hi + EPS; t += CHECK_STEP) {
            const vals = usable.map(p => applyPath(p, Math.min(t, hi)));
            const spread = Math.max(...vals) - Math.min(...vals);
            if (spread > worst) { worst = spread; worstPoint = Math.min(t, hi); worstValues = vals; }
          }
        }
        pairReports[key] = {
          from: devices[i].id, to: devices[j].id,
          paths: enriched, usable,
          commonDomain: [lo, hi],
          maxAgreement: worst,
          checkPoint: worstPoint
        };
        if (worst > AGREEMENT_LIMIT + 1e-6) {
          // 定位分歧最大的两条路径作为“冲突来源”
          let bi = 0, bj = 1, bd = -1;
          for (let a = 0; a < worstValues.length; a++)
            for (let b = a + 1; b < worstValues.length; b++)
              if (Math.abs(worstValues[a] - worstValues[b]) > bd) { bd = Math.abs(worstValues[a] - worstValues[b]); bi = a; bj = b; }
          const p1 = usable[bi], p2 = usable[bj];
          const anchorIds = new Set();
          for (const p of [p1, p2]) for (const st of p.edges) for (const pt of st.edge.pts) anchorIds.add(pt.id);
          errors.push({
            code: "PATH_CONFLICT",
            message: "「" + devices[i].name + "」→「" + devices[j].name + "」在 " +
              TimeUtil.format(worstPoint) + " 处多路径结果相差 " + worst.toFixed(2) + " 秒（上限 " + AGREEMENT_LIMIT + " 秒），锚点矛盾",
            sources: [...anchorIds],
            pair: [devices[i].id, devices[j].id],
            at: worstPoint,
            divergence: worst,
            pathNames: [p1, p2].map(p => p.nodes.map(n => devices[n].name).join(" → "))
          });
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      edges,
      edgeByKey,
      pairReports,
      devIndex,
      maxAgreement: Math.max(0, ...Object.values(pairReports).map(r => r.maxAgreement || 0))
    };
  }

  class CalibrationEngine {
    constructor() {
      this.devices = [];
      this.anchors = [];
      this.versions = [];
      this.report = null;
      this.dirty = true;
      this.signature = null;
      this._publishing = false;
    }

    // —— 登记 ——
    addDevice(kind, name) {
      const id = uid();
      this.devices.push({ id, kind: kind || "other", name: name || KIND_NAMES[kind] || "设备" });
      this._invalidate();
      return id;
    }

    updateDevice(id, patch) {
      const d = this._device(id);
      if (patch.kind) d.kind = patch.kind;
      if (patch.name !== undefined) d.name = patch.name;
      this._invalidate();
    }

    removeDevice(id) {
      this.devices = this.devices.filter(d => d.id !== id);
      this.anchors = this.anchors.filter(a => a.a !== id && a.b !== id);
      this._invalidate();
    }

    addAnchor(a, b, ta, tb) {
      const id = uid();
      this.anchors.push({ id, a, b, ta, tb });
      this._invalidate();
      return id;
    }

    updateAnchor(id, patch) {
      const an = this._anchor(id);
      if (patch.a !== undefined) an.a = patch.a;
      if (patch.b !== undefined) an.b = patch.b;
      if (patch.ta !== undefined) an.ta = patch.ta;
      if (patch.tb !== undefined) an.tb = patch.tb;
      this._invalidate();
    }

    removeAnchor(id) {
      this.anchors = this.anchors.filter(a => a.id !== id);
      this._invalidate();
    }

    _invalidate() {
      this.dirty = true;
      this.signature = null;
    }

    _device(id) { const d = this.devices.find(x => x.id === id); if (!d) throw new Error("未知设备 " + id); return d; }
    _anchor(id) { const a = this.anchors.find(x => x.id === id); if (!a) throw new Error("未知锚点 " + id); return a; }

    // —— 重校 ——
    recalibrate() {
      this.report = evaluateData(this.devices, this.anchors);
      if (this.report.ok) {
        this.dirty = false;
        this.signature = this._computeSignature();
      } else {
        this.dirty = true;
        this.signature = null;
      }
      return this.report;
    }

    _computeSignature() {
      const payload = JSON.stringify({
        d: this.devices.map(d => [d.kind, d.name]),
        a: this.anchors.map(a => [a.a, a.b, TimeUtil.parse(a.ta), TimeUtil.parse(a.tb)])
      });
      let h = 5381;
      for (let i = 0; i < payload.length; i++) h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0;
      return "sig-" + h.toString(16) + "-" + this.anchors.length + "a" + this.devices.length + "d";
    }

    get ready() { return !this.dirty && this.report && this.report.ok; }

    // —— 发布（同一草稿并发只成功一次）。异步：进入即占锁，让出事件循环后落盘 ——
    async publish(label) {
      if (this._publishing) {
        return { ok: false, code: "PUBLISH_BUSY", message: "同一版本正在发布中，并发发布仅允许一次成功" };
      }
      this._publishing = true;
      // 让出事件循环，制造真实的并发窗口：后到者必然看到占锁
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        if (!this.ready) {
          return { ok: false, code: "NOT_CALIBRATED", message: "草稿尚未通过重校，不能发布", errors: this.report ? this.report.errors : [] };
        }
        if (this.devices.length < 2 || this.anchors.length < 1) {
          return { ok: false, code: "NO_ANCHORS", message: "至少需要两台设备与一对锚点才能发布校准版本" };
        }
        if (this.versions.length && this.versions[this.versions.length - 1].signature === this.signature) {
          return { ok: false, code: "ALREADY_PUBLISHED", message: "该版本已发布，重复发布不会产生新版本", version: this.versions[this.versions.length - 1] };
        }
        const version = {
          id: "v" + (this.versions.length + 1) + "-" + this.signature.slice(4, 10),
          label: label || ("版本 " + (this.versions.length + 1)),
          signature: this.signature,
          createdAt: new Date().toISOString(),
          devices: JSON.parse(JSON.stringify(this.devices)),
          anchors: JSON.parse(JSON.stringify(this.anchors)),
          maxAgreement: this.report.maxAgreement
        };
        this.versions.push(version);
        return { ok: true, version };
      } finally {
        this._publishing = false;
      }
    }

    /** 在指定上下文中选择两设备间的最优路径（最短优先），返回报告与路径 */
    _resolvePath(ctx, srcId, dstId) {
      if (srcId === dstId) throw Object.assign(new Error("源设备与目标设备相同"), { code: "SAME_DEVICE" });
      const rep = ctx.pairReports[pairKey(srcId, dstId)];
      if (!rep || !rep.usable || !rep.usable.length) {
        throw Object.assign(new Error("路径断开：两设备之间不存在有效换算路径"), { code: "PATH_BROKEN" });
      }
      return { rep, path: rep.usable[0] };
    }

    /**
     * 换算。
     * @param at 'draft'（当前草稿，须先重校）或版本 id
     */
    convert(srcId, dstId, rawTime, at) {
      at = at || "draft";
      let ctx, version, devices;
      if (at === "draft") {
        if (!this.report || (this.dirty && !this.report.errors.length)) {
          throw Object.assign(new Error("草稿已被编辑失效，请先重新校准"), { code: "STALE" });
        }
        if (!this.report.ok) {
          throw Object.assign(new Error("草稿校准未通过，不能换算"), { code: "NOT_CALIBRATED", errors: this.report.errors });
        }
        ctx = this.report; devices = this.devices;
      } else {
        version = this.versions.find(v => v.id === at);
        if (!version) throw Object.assign(new Error("未知版本 " + at), { code: "UNKNOWN_VERSION" });
        ctx = evaluateData(version.devices, version.anchors);
        if (!ctx.ok) throw Object.assign(new Error("已发布版本内部数据异常"), { code: "NOT_CALIBRATED", errors: ctx.errors });
        devices = version.devices;
      }
      const vr = TimeUtil.validate(rawTime);
      if (!vr.ok) {
        throw Object.assign(new Error("换算时间不合法：" + vr.reason), { code: "BAD_TIME", reason: vr.reason, subcode: vr.code });
      }
      const value = vr.seconds;
      const src = devices.find(d => d.id === srcId);
      const dst = devices.find(d => d.id === dstId);
      if (!src || !dst) throw Object.assign(new Error("未知设备"), { code: "UNKNOWN_DEVICE" });

      const { rep, path } = this._resolvePath(ctx, srcId, dstId);
      // 路径按 rep.from→rep.to 方向枚举存储；反向换算时逆序且翻转每边方向
      const forward = srcId === rep.from;
      let v = value;
      try {
        if (forward) {
          for (const st of path.edges) v = mapAcross(st.edge, v, st.dir);
        } else {
          for (let k = path.edges.length - 1; k >= 0; k--) {
            const st = path.edges[k];
            v = mapAcross(st.edge, v, -st.dir);
          }
        }
      } catch (e) {
        if (e.code === "PATH_BROKEN") {
          throw Object.assign(new Error("越界外推：" + e.message), { code: "PATH_BROKEN", outOfRange: !!e.outOfRange });
        }
        throw e;
      }
      return {
        seconds: v,
        text: TimeUtil.format(v),
        path: (forward ? path.nodes.slice() : path.nodes.slice().reverse()).map(i => devices[i].name),
        viaVersion: version ? version.id : null
      };
    }

    // —— 持久化 ——
    serialize() {
      return JSON.stringify({
        schema: 1,
        devices: this.devices,
        anchors: this.anchors,
        versions: this.versions
      });
    }

    static load(json) {
      const data = typeof json === "string" ? JSON.parse(json) : json;
      const eng = new CalibrationEngine();
      eng.devices = data.devices || [];
      eng.anchors = data.anchors || [];
      eng.versions = data.versions || [];
      eng.report = evaluateData(eng.devices, eng.anchors);
      eng.dirty = !eng.report.ok;
      eng.signature = eng.report.ok ? eng._computeSignature() : null;
      return eng;
    }
  }

  CalibrationEngine.DRIFT_LIMIT = DRIFT_LIMIT;
  CalibrationEngine.AGREEMENT_LIMIT = AGREEMENT_LIMIT;
  CalibrationEngine.evaluateData = evaluateData;
  CalibrationEngine.makeEdge = makeEdge;
  CalibrationEngine.mapAcross = mapAcross;
  CalibrationEngine.KIND_NAMES = KIND_NAMES;

  return CalibrationEngine;
});
