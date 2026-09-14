/* 校准台 UI 控制器（无框架，离线运行） */
(function () {
  "use strict";
  const $ = sel => document.querySelector(sel);
  const STORE_KEY = "clockCalibV1";
  const LEGACY_KEY = "zfl30Marks";

  const KIND_LABEL = { camera: "相机", divewatch: "潜水表", sonar: "声呐", other: "其他" };
  const ERROR_META = {
    ORDER_ANCHORS: { label: "锚点非严格递增", cls: "invalid" },
    DRIFT_SEGMENT: { label: "漂移超限（>5 秒/小时）", cls: "invalid" },
    PATH_BROKEN: { label: "路径断开 / 越界外推", cls: "invalid" },
    PATH_CONFLICT: { label: "多路径矛盾（>1 秒）", cls: "invalid" }
  };

  let engine = null;
  let editingAnchor = null;
  let editingDevice = null;

  // ———————————————————— 初始化与持久化 ————————————————————
  function seedDemo() {
    const e = new CalibrationEngine();
    const cam = e.addDevice("camera", "船载相机A");
    const watch = e.addDevice("divewatch", "潜水表W2");
    const sonar = e.addDevice("sonar", "侧扫声呐S1");
    // 声呐比相机快 10s，潜水表比相机慢 20s（均无漂移）
    e.addAnchor(cam, sonar, "10:00:00", "10:00:10");
    e.addAnchor(cam, sonar, "11:00:00", "11:00:10");
    e.addAnchor(cam, watch, "10:00:00", "09:59:40");
    e.addAnchor(cam, watch, "11:00:00", "10:59:40");
    // 第三条边闭合三角：经声呐换算应与直连路径完全一致
    e.addAnchor(watch, sonar, "09:59:40", "10:00:10");
    e.addAnchor(watch, sonar, "10:59:40", "11:00:10");
    e.recalibrate();
    return e;
  }

  function save() {
    localStorage.setItem(STORE_KEY, engine.serialize());
  }

  function init() {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      try { engine = CalibrationEngine.load(raw); }
      catch (e) {
        console.error("存档损坏，重建示例数据", e);
        engine = seedDemo(); save();
      }
    } else {
      engine = seedDemo(); save();
    }
    bindEvents();
    renderAll();
    if (engine.ready) runConvert();
    // 离线提示
    window.addEventListener("online", () => flash("已联网（本应用仍只使用本机数据）", "ok"));
    window.addEventListener("offline", () => flash("当前离线，校准台可正常使用", "ok"));
    if (!navigator.onLine) flash("离线模式：所有数据仅保存在本机", "ok");
  }

  function mutate(fn) {
    fn();
    save();
    renderAll();
  }

  // ———————————————————— 渲染 ————————————————————
  function deviceName(id) { const d = engine.devices.find(x => x.id === id); return d ? d.name : "（已删除）"; }

  function conflictAnchorIds() {
    const set = new Set();
    if (engine.report) for (const err of engine.report.errors)
      for (const s of err.sources || []) if (engine.anchors.some(a => a.id === s)) set.add(s);
    return set;
  }

  function renderDevices() {
    $("#deviceRows").innerHTML = engine.devices.map(d => `
      <tr data-device="${d.id}" data-testid="device-row">
        <td><span class="pill kind-${d.kind}">${KIND_LABEL[d.kind] || d.kind}</span></td>
        <td>${escapeHtml(d.name)}</td>
        <td>
          <button class="small secondary" data-edit-device="${d.id}">编辑</button>
          <button class="small danger" data-del-device="${d.id}">删除</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="3" class="muted">尚未登记设备</td></tr>`;
  }

  function renderDeviceOptions() {
    const opts = engine.devices.map(d => `<option value="${d.id}">${KIND_LABEL[d.kind] || ""} · ${escapeHtml(d.name)}</option>`).join("");
    // 重建选项时保留用户已选设备
    const sels = [
      document.querySelector("#anchorForm select[name=a]"),
      document.querySelector("#anchorForm select[name=b]"),
      $("#convertSrc"), $("#convertDst")
    ].filter(Boolean);
    const prev = sels.map(s => s.value);
    sels.forEach(s => { s.innerHTML = opts; });
    sels.forEach((s, i) => {
      if (prev[i] && engine.devices.some(d => d.id === prev[i])) s.value = prev[i];
    });
    if (!$("#convertSrc").value && engine.devices[0]) $("#convertSrc").selectedIndex = 0;
    if (engine.devices.length > 1 && (!$("#convertDst").value || $("#convertDst").value === $("#convertSrc").value)) {
      $("#convertDst").selectedIndex = 1;
    }
  }

  function renderAnchors() {
    const bad = conflictAnchorIds();
    $("#anchorRows").innerHTML = engine.anchors.map((a, idx) => `
      <tr data-anchor="${a.id}" data-testid="anchor-row" class="${bad.has(a.id) ? "conflict-row" : ""}">
        <td>${escapeHtml(deviceName(a.a))}</td>
        <td style="font-variant-numeric:tabular-nums">${escapeHtml(a.ta)}</td>
        <td>${escapeHtml(deviceName(a.b))}</td>
        <td style="font-variant-numeric:tabular-nums">${escapeHtml(a.tb)}</td>
        <td>
          <button class="small secondary" data-edit-anchor="${a.id}">编辑</button>
          <button class="small danger" data-del-anchor="${a.id}">删除</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted">尚无锚点，至少需要一对同时刻读数</td></tr>`;
  }

  function renderStatus() {
    const badge = $("#statusBadge");
    const text = $("#statusText");
    const panelR = $("#reportPanel");
    const panelA = $("#anchorPanel");
    panelR.classList.remove("dirty", "invalid");
    panelA.classList.remove("dirty", "invalid");
    const pill = $("#agreementPill");
    if (engine.ready) {
      badge.className = "badge ok";
      const sufficient = engine.devices.length >= 2 && engine.anchors.length >= 1;
      text.textContent = sufficient ? "校准通过 · 可发布" : "校准通过 · 数据不足，暂不能发布";
      const max = engine.report.maxAgreement;
      if (engine.devices.length >= 2) {
        pill.hidden = false;
        $("#agreementValue").textContent = max.toFixed(2) + " 秒（限 1 秒）";
      } else pill.hidden = true;
      $("#publishBtn").disabled = !sufficient;
    } else {
      $("#publishBtn").disabled = true;
      pill.hidden = true;
      const hasErrors = engine.report && engine.report.errors.length;
      if (hasErrors) {
        badge.className = "badge invalid";
        text.textContent = "校准未通过 · " + engine.report.errors.length + " 项问题";
        panelR.classList.add("invalid");
        panelA.classList.add("invalid");
      } else {
        badge.className = "badge dirty";
        text.textContent = "草稿已编辑 · 结果失效，待重新校准";
        panelR.classList.add("dirty");
        panelA.classList.add("dirty");
      }
    }
  }

  function renderReport() {
    const body = $("#reportBody");
    if (engine.ready) {
      const pairs = Object.values(engine.report.pairReports);
      body.innerHTML = `
        <div class="badge ok" style="margin-bottom:10px"><span class="dot"></span>全部校验通过</div>
        <div class="muted">· 锚点严格递增　· 每段漂移 ≤ 5 秒/小时　· 设备图连通　· 多路径换算偏差 ≤ 1 秒</div>
        <table style="margin-top:10px">
          <thead><tr><th>设备对</th><th>可用路径</th><th>覆盖区间（源）</th><th>最大偏差</th></tr></thead>
          <tbody>
            ${pairs.map(p => {
              const nameOf = id => deviceName(id);
              const dom = p.commonDomain || p.usable[0].domain;
              return `<tr>
                <td>${nameOf(p.from)} ↔ ${nameOf(p.to)}</td>
                <td>${p.usable.length} 条</td>
                <td style="font-variant-numeric:tabular-nums">${TimeUtil.format(dom[0])} – ${TimeUtil.format(dom[1])}</td>
                <td>${(p.maxAgreement || 0).toFixed(2)} s</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>`;
      return;
    }
    const errors = (engine.report && engine.report.errors) || [];
    if (!errors.length) {
      body.innerHTML = `<div class="badge dirty" style="margin-bottom:10px"><span class="dot"></span>依赖结果已失效</div>
        <div class="muted">锚点或设备在上次校准后被改动。点击右上角“重新校准”进行校验；通过后换算与发布才会恢复。<br>已发布的旧版本仍可继续使用。</div>`;
      return;
    }
    body.innerHTML = `<div class="errors">${errors.map((err, i) => {
      const meta = ERROR_META[err.code] || { label: err.code };
      const srcButtons = (err.sources || []).slice(0, 8).map(id => {
        const anchorIdx = engine.anchors.findIndex(a => a.id === id);
        const isAnchor = anchorIdx >= 0;
        const label = isAnchor ? "锚点 #" + (anchorIdx + 1) : deviceName(id);
        return `<button class="small secondary srcbtn" data-locate="${id}" data-testid="locate-source">定位：${escapeHtml(label)}</button>`;
      }).join(" ");
      const paths = err.pathNames ? `<div class="paths">路径 1：${escapeHtml(err.pathNames[0])}<br>路径 2：${escapeHtml(err.pathNames[1])}</div>` : "";
      return `<div class="err-card" data-testid="error-card" data-code="${err.code}">
        <div class="code">${i + 1}. ${escapeHtml(meta.label)}（${err.code}）</div>
        <div>${escapeHtml(err.message)}</div>
        ${paths}${srcButtons ? `<div class="srcbtn">${srcButtons}</div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }

  function renderVersionOptions() {
    const sel = $("#convertVersion");
    sel.innerHTML = `<option value="draft">当前草稿${engine.ready ? "（已校准）" : "（已失效/未通过）"}</option>` +
      engine.versions.slice().reverse().map(v =>
        `<option value="${v.id}">${escapeHtml(v.label)} · ${v.id}</option>`).join("");
  }

  function renderVersions() {
    const el = $("#versionList");
    if (!engine.versions.length) {
      el.innerHTML = `<div class="muted" style="margin-bottom:10px">尚无已发布版本。校准通过后点击“发布版本”。</div>`;
    } else {
      el.innerHTML = engine.versions.slice().reverse().map(v => `
        <div class="version-item" data-version="${v.id}" data-testid="version-item">
          <div class="meta">
            <b>${escapeHtml(v.label)}</b>
            <span class="pill">${v.id}</span>
            <div class="muted">${new Date(v.createdAt).toLocaleString()} · ${v.anchors.length} 锚点 · ${v.devices.length} 设备 · 偏差 ${v.maxAgreement.toFixed(2)}s</div>
          </div>
          <button class="small secondary" data-use-version="${v.id}" data-testid="use-version">用于换算</button>
        </div>`).join("");
    }
    renderVersionOptions();
  }

  function renderLegacyMarks() {
    // 兼容旧潜水记录应用：zfl30Marks 原样保留、只读展示，不参与校准
    let marks = [];
    try { marks = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]"); } catch (e) { marks = []; }
    const host = $("#legacyPanel");
    if (!marks.length) { host.hidden = true; return; }
    host.hidden = false;
    $("#legacyList").innerHTML = marks.map(m =>
      `<tr><td>${escapeHtml(m.code || "?")}</td><td>${escapeHtml(m.dive || "-")}</td><td>${escapeHtml(m.depth || "-")}</td></tr>`
    ).join("");
  }

  function renderForms() {
    const af = $("#anchorForm");
    if (editingAnchor) {
      af.id.value = editingAnchor;
      af.a.value = engine.anchors.find(a => a.id === editingAnchor).a;
      af.b.value = engine.anchors.find(a => a.id === editingAnchor).b;
      af.ta.value = engine.anchors.find(a => a.id === editingAnchor).ta;
      af.tb.value = engine.anchors.find(a => a.id === editingAnchor).tb;
      af.querySelector('[type="submit"]').textContent = "保存修改";
      $("#anchorCancel").hidden = false;
    } else {
      af.reset(); af.id.value = "";
      af.querySelector('[type="submit"]').textContent = "添加";
      $("#anchorCancel").hidden = true;
    }
    const df = $("#deviceForm");
    df.querySelector('[type="submit"]').textContent = editingDevice ? "保存修改" : "登记";
  }

  function renderResultState() {
    const box = $("#resultBox");
    if (engine.ready) return; // 保留当前结果，由用户重新换算
    box.className = "result-box bigerr";
    box.innerHTML = `<div class="result-err" data-testid="result-invalidated">
      草稿依赖结果已失效：设备或锚点在上次校准后被改动。重新校准前不提供换算；已发布旧版本仍可在“使用版本”中选用。
    </div>`;
  }

  function renderAll() {
    renderDevices();
    renderDeviceOptions();
    renderAnchors();
    renderStatus();
    renderReport();
    renderVersions();
    renderLegacyMarks();
    renderForms();
    renderResultState();
  }

  // ———————————————————— 事件 ————————————————————
  function bindEvents() {
    // 设备
    $("#deviceForm").onsubmit = e => {
      e.preventDefault();
      const f = e.target;
      const kind = f.kind.value, name = f.name.value.trim();
      if (!name) return;
      mutate(() => {
        if (editingDevice) engine.updateDevice(editingDevice, { kind, name });
        else engine.addDevice(kind, name);
      });
      editingDevice = null;
      f.reset();
      renderAll();
      flash("设备已保存：新增/修改后需重新校准", "ok");
    };

    $("#deviceRows").addEventListener("click", e => {
      const editId = e.target.dataset.editDevice;
      const delId = e.target.dataset.delDevice;
      if (editId) {
        const d = engine.devices.find(x => x.id === editId);
        editingDevice = editId;
        const f = $("#deviceForm");
        f.id.value = d.id; f.kind.value = d.kind; f.name.value = d.name;
        renderForms();
      } else if (delId) {
        const related = engine.anchors.filter(a => a.a === delId || a.b === delId).length;
        if (!confirm("删除设备将同时移除其 " + related + " 个锚点，且相关换算立即失效。确认？")) return;
        mutate(() => engine.removeDevice(delId));
        if (editingDevice === delId) { editingDevice = null; $("#deviceForm").reset(); }
        flash("设备已删除，依赖结果失效，需重新校准");
      }
    });

    // 锚点
    $("#anchorForm").onsubmit = e => {
      e.preventDefault();
      if (engine.devices.length < 2) return flash("请先登记至少两台设备", "err");
      const f = e.target;
      const data = { a: f.a.value, b: f.b.value, ta: f.ta.value.trim(), tb: f.tb.value.trim() };
      if (data.a === data.b) return flash("锚点的两台设备不能相同", "err");
      if (TimeUtil.parse(data.ta) === null || TimeUtil.parse(data.tb) === null)
        return flash("时间格式无效，应为 HH:MM:SS", "err");
      mutate(() => {
        if (editingAnchor) engine.updateAnchor(editingAnchor, data);
        else engine.addAnchor(data.a, data.b, data.ta, data.tb);
      });
      editingAnchor = null;
      f.reset();
      renderAll();
      flash("锚点已保存：依赖结果已失效，请重新校准");
    };
    $("#anchorCancel").onclick = () => { editingAnchor = null; $("#anchorForm").reset(); renderForms(); };

    $("#anchorRows").addEventListener("click", e => {
      const editId = e.target.dataset.editAnchor;
      const delId = e.target.dataset.delAnchor;
      if (editId) {
        editingAnchor = editId;
        renderForms();
      } else if (delId) {
        mutate(() => engine.removeAnchor(delId));
        if (editingAnchor === delId) { editingAnchor = null; $("#anchorForm").reset(); }
        flash("锚点已删除：依赖结果已失效，请重新校准");
      }
    });

    // 定位冲突来源
    $("#reportBody").addEventListener("click", e => {
      const id = e.target.dataset.locate;
      if (!id) return;
      const anchorEl = document.querySelector('[data-anchor="' + id + '"]');
      const deviceEl = document.querySelector('[data-device="' + id + '"]');
      const target = anchorEl || deviceEl;
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.style.transition = "outline .2s";
        target.style.outline = "3px solid #d84a3f";
        setTimeout(() => { target.style.outline = ""; }, 1800);
      }
    });

    // 校准 / 发布
    $("#recalibrateBtn").onclick = () => {
      const rep = engine.recalibrate();
      save();
      renderAll();
      if (rep.ok) flash("重新校准通过" + (engine.devices.length >= 2 ? "，多路径偏差 " + rep.maxAgreement.toFixed(2) + " 秒" : ""), "ok");
      else flash("校准未通过：" + rep.errors.length + " 项问题，已发布版本不受影响", "err");
    };

    $("#publishBtn").onclick = () => publish();

    // 换算
    $("#convertBtn").onclick = runConvert;
    ["#convertSrc", "#convertDst", "#convertTime", "#convertVersion"].forEach(s =>
      $(s).addEventListener("change", () => { if (engine.ready || $("#convertVersion").value !== "draft") runConvert(); }));

    $("#versionList").addEventListener("click", e => {
      const id = e.target.dataset.useVersion;
      if (id) { $("#convertVersion").value = id; runConvert(); }
    });

    $("#resetBtn").onclick = () => {
      if (!confirm("将清空全部设备、锚点与已发布版本（旧潜水标记保留不动），并恢复示例数据。确认？")) return;
      localStorage.removeItem(STORE_KEY);
      editingAnchor = null; editingDevice = null;
      engine = seedDemo();
      save();
      renderAll();
      flash("已恢复示例数据", "ok");
    };
  }

  async function publish() {
    const before = engine.versions.length;
    const res = await engine.publish("版本 " + (engine.versions.length + 1));
    if (res.ok) {
      save();
      renderAll();
      flash("发布成功：" + res.version.id, "ok");
    } else {
      // 失败回滚：已发布版本数量必须不变
      const unchanged = engine.versions.length === before;
      flash("发布被拒绝（" + res.code + "）：" + res.message + "；已发布版本" + (unchanged ? "保持不变" : "异常！"), "err");
      renderAll();
    }
    return res;
  }

  function runConvert() {
    const src = $("#convertSrc").value, dst = $("#convertDst").value;
    const t = $("#convertTime").value.trim();
    const at = $("#convertVersion").value;
    const box = $("#resultBox");
    if (!src || !dst) { box.className = "result-box bigerr"; box.innerHTML = `<div class="result-err">请先登记两台设备</div>`; return; }
    if (src === dst) { box.className = "result-box"; box.innerHTML = `<div class="muted">源设备与目标设备相同，时间不变：${escapeHtml(t)}</div>`; return; }
    try {
      const r = engine.convert(src, dst, t, at === "draft" ? "draft" : at);
      const ver = r.viaVersion ? engine.versions.find(v => v.id === r.viaVersion) : null;
      box.className = "result-box";
      box.innerHTML = `
        <div class="muted">${at === "draft" ? "当前草稿" : escapeHtml(ver ? ver.label + " · " + ver.id : r.viaVersion)}</div>
        <div class="result-time" data-testid="result-time">${escapeHtml(r.text)}</div>
        <div class="result-path">${escapeHtml(deviceName(src))} → ${escapeHtml(deviceName(dst))}，换算路径：${r.path.map(escapeHtml).join(" → ")}</div>`;
    } catch (e) {
      box.className = "result-box bigerr";
      const hint = e.code === "STALE"
        ? "草稿在上次校准后被改动，换算结果已失效。请重新校准；或在下方改用已发布的旧版本。"
        : e.code === "PATH_BROKEN"
          ? e.message + "（路径断开或越界外推一律拒绝）"
          : e.message;
      box.innerHTML = `<div class="result-err" data-testid="result-error">[${e.code || "ERROR"}] ${escapeHtml(hint)}</div>`;
    }
  }

  // ———————————————————— 工具 ————————————————————
  let flashTimer = null;
  function flash(msg, kind) {
    if (!msg) return;
    const el = $("#flash");
    el.textContent = msg;
    el.className = "flash show " + (kind || "");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.className = "flash"; }, 2600);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 测试与控制台用钩子
  window.__calib = {
    engine: () => engine,
    publish,
    reset: () => { localStorage.removeItem(STORE_KEY); engine = seedDemo(); save(); renderAll(); },
    seedDemo: () => { engine = seedDemo(); save(); renderAll(); return engine; },
    load: json => { engine = CalibrationEngine.load(json); save(); renderAll(); return engine; },
    newEngine: () => new CalibrationEngine(),
    save
  };

  document.addEventListener("DOMContentLoaded", init);
})();
