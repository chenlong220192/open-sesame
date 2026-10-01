/* ============================================================
   陈三姐康复追踪 — 新版交互逻辑（数据驱动 · 零外部依赖）
   图表引擎：纯内联 SVG（移植自参考页，并增强对缺失值 null 的处理）
   数据来自内联 window.APP_DATA（build.py 注入，file:// 下不 fetch）
   ============================================================ */
(function () {
  "use strict";
  var D = window.APP_DATA || {};
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    if (n == null || n === "") return "—";
    var v = Number(n);
    if (isNaN(v)) return String(n);
    return "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ==================== 图表引擎（纯 SVG，零依赖，支持 null 缺失值） ==================== */
  function Chart(box, tip, opt) {
    this.box = box; this.tip = tip; this.opt = opt; this.lastW = 0; this.built = false;
    var self = this;
    this.render();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(function () {
        var w = box.clientWidth;
        if (!w) return;                       // 面板隐藏时跳过
        if (Math.abs(w - self.lastW) > 2) { self.lastW = w; self.render(); }
      });
      this.ro.observe(box);
    }
    this.built = true;
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), r = raw / p;
    var k = r <= 1 ? 1 : (r <= 2 ? 2 : (r <= 2.5 ? 2.5 : (r <= 5 ? 5 : 10)));
    return k * p;
  }
  /* Catmull-Rom → cubic Bezier 平滑曲线。pts = [[x,y], ...]；返回 SVG path d 串。
     仅 1 个点：返回 "M x,y"；2 个点：直线 "M x,y L x,y"。 */
  function smoothPath(pts) {
    if (!pts.length) return "";
    if (pts.length === 1) return "M " + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    var t = 0.5;  // 张力（0-1，越大越平滑）
    var d = "M " + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2] || p2;
      // 控制点 1 = p1 + (p2 - p0) * t/3
      var c1x = p1[0] + (p2[0] - p0[0]) * t / 3;
      var c1y = p1[1] + (p2[1] - p0[1]) * t / 3;
      // 控制点 2 = p2 - (p3 - p1) * t/3
      var c2x = p2[0] - (p3[0] - p1[0]) * t / 3;
      var c2y = p2[1] - (p3[1] - p1[1]) * t / 3;
      d += " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + ", " + c2x.toFixed(1) + " " + c2y.toFixed(1) + ", " + p2[0].toFixed(1) + " " + p2[1].toFixed(1);
    }
    return d;
  }
  Chart.prototype.range = function (side) {
    var o = this.opt, vals = [];
    o.series.forEach(function (s) {
      // 关键：只统计可见系列（用户点击 legend 隐藏的系列不参与 Y 轴计算）
      if (s.hidden) return;
      if ((s.axis || "left") === side) {
        s.data.forEach(function (v) { if (v != null && !isNaN(v)) vals.push(v); });
      }
    });
    // band / refLine 归属某系列（si）时，该系列被隐藏则其值域不再参与坐标轴计算
    var owned = function (x) { return !(x.si != null && o.series[x.si] && o.series[x.si].hidden); };
    (o.bands || []).forEach(function (b) { if ((b.axis || "left") === side && owned(b)) { vals.push(b.from, b.to); } });
    (o.refLines || []).forEach(function (r) { if ((r.axis || "left") === side && owned(r)) { vals.push(r.value); } });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pr = (side === "right" ? o.padRight : o.padLeft);
    if (pr == null) pr = (o.padRatio != null ? o.padRatio : 0.18);
    var pad = (hi - lo) * pr || Math.abs(hi) * 0.2 || 1;
    var min = o.forceZero ? 0 : lo - pad, max = hi + pad;
    if (lo >= 0 && min < 0) min = 0;
    var omin = side === "right" ? o.minRight : o.minLeft;
    var omax = side === "right" ? o.maxRight : o.maxLeft;
    if (omin != null) min = Math.min(min, omin);
    if (omax != null) max = Math.max(max, omax);
    var st = side === "right" ? (o.stepRight || o.step) : (o.stepLeft || o.step);
    var step = st || niceStep((max - min) / 4);
    min = Math.floor(min / step) * step;
    max = Math.ceil(max / step) * step;
    return { min: min, max: max, step: step };
  };
  Chart.prototype.render = function () {
    var o = this.opt, box = this.box;
    var W = Math.max(320, box.clientWidth || 700);
    var H = o.height || 250;
    var m = { t: 16, r: o.right ? 52 : 16, b: 34, l: 44 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var n = o.labels.length;
    // 先收集每个系列对应的 axis，看哪个 axis 还有可见系列
    var visLeft = o.series.some(function (s) { return !s.hidden && (s.axis || "left") === "left"; });
    var visRight = o.series.some(function (s) { return !s.hidden && (s.axis || "left") === "right"; });
    // 如果两边都空（极端情况），兜底让左边可见
    if (!visLeft && !visRight) visLeft = true;
    var L, R, soloRight = false;
    if (visLeft && visRight) {
      L = this.range("left"); R = this.range("right");
    } else if (visLeft) {
      L = this.range("left"); R = null;
    } else {
      // 只右轴可见：把右轴当左轴画。R 仍保留右轴值域，
      // 这样右轴的 band/refLine 能按正确值域换算（Y(v,"right") 走 R），
      // 只是不再重复画右侧刻度（soloRight 控制）。
      L = this.range("right"); R = L; soloRight = true;
    }
    var X = function (i) { return n <= 1 ? (m.l + iw / 2) : (m.l + iw * i / (n - 1)); };
    // Y 函数：side=="right" 且 R==null 时也用 L（兜底）
    var Y = function (v, side) { var a = (side === "right" && R) ? R : L; return m.t + ih - (v - a.min) / (a.max - a.min) * ih; };
    var s = [], i, v;
    s.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:' + H + 'px" font-family="inherit">');
    // 左轴网格
    var ticks = [], cnt = Math.round((L.max - L.min) / L.step);
    for (i = 0; i <= cnt; i++) ticks.push(L.min + L.step * i);
    ticks.forEach(function (tv) {
      var y = Y(tv, "left");
      s.push('<line x1="' + m.l + '" y1="' + y.toFixed(1) + '" x2="' + (m.l + iw) + '" y2="' + y.toFixed(1) + '" stroke="#f0ede6" stroke-width="1"/>');
      s.push('<text x="' + (m.l - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="10.5" fill="#696f6a">' + esc(o.fmtY ? o.fmtY(tv) : tv) + '</text>');
    });
    // 右轴刻度（双轴分离时显示；只右轴可见时不重复画，因为左轴已在显示该值域）
    if (R && !soloRight) {
      var rt = [], rc = Math.round((R.max - R.min) / R.step);
      for (i = 0; i <= rc; i++) rt.push(R.min + R.step * i);
      rt.forEach(function (tv) {
        var y = Y(tv, "right");
        s.push('<text x="' + (m.l + iw + 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="start" font-size="10.5" fill="#a8b2ac">' + esc(o.fmtRY ? o.fmtRY(tv) : tv) + '</text>');
      });
    }
    // 正常值带（R 为空 = 右轴系列已全部隐藏，此时跳过右轴 band）
    var anyVisible = o.series.some(function (se) { return !se.hidden; });
    (o.bands || []).forEach(function (b) {
      var side = b.axis || "left";
      if (!anyVisible) return;                                   // 全部系列已隐藏 → 不画任何参考带
      if (side === "right" && !R) return;                        // 右轴系列全隐 → 跳过右轴带
      if (soloRight && side === "left") return;                  // soloRight 时 L 装的是右轴值域，左轴值换算必错
      if (b.si != null && o.series[b.si] && o.series[b.si].hidden) return;   // 带所属系列已隐藏
      var y1 = Y(b.to, side), y2 = Y(b.from, side);
      var top = Math.min(y1, y2);
      s.push('<rect x="' + m.l + '" y="' + top.toFixed(1) + '" width="' + iw + '" height="' + Math.abs(y2 - y1).toFixed(1) + '" fill="' + (b.color || "#2f6b5b") + '" opacity="0.075"/>');
      if (b.label) s.push('<text x="' + (m.l + 6) + '" y="' + (top + 11).toFixed(1) + '" font-size="9.5" fill="' + (b.color || "#2f6b5b") + '" opacity="0.8">' + esc(b.label) + '</text>');
    });
    // 参考线（R 为空 = 右轴系列已全部隐藏，此时跳过右轴参考线）
    (o.refLines || []).forEach(function (r) {
      var side = r.axis || "left";
      if (!anyVisible) return;
      if (side === "right" && !R) return;
      if (soloRight && side === "left") return;
      if (r.si != null && o.series[r.si] && o.series[r.si].hidden) return;
      var y = Y(r.value, side);
      s.push('<line x1="' + m.l + '" y1="' + y.toFixed(1) + '" x2="' + (m.l + iw) + '" y2="' + y.toFixed(1) + '" stroke="' + (r.color || "#b04a3f") + '" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.6"/>');
      if (r.label) s.push('<text x="' + (m.l + iw - 4) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="end" font-size="9.5" fill="' + (r.color || "#b04a3f") + '" opacity="0.9">' + esc(r.label) + '</text>');
    });
    // X 轴
    s.push('<line x1="' + m.l + '" y1="' + (m.t + ih) + '" x2="' + (m.l + iw) + '" y2="' + (m.t + ih) + '" stroke="#e6e2d9" stroke-width="1"/>');
    var labelStep = n > 8 ? Math.ceil(n / 8) : 1;
    o.labels.forEach(function (lb, li) {
      if (li % labelStep !== 0 && li !== n - 1) return;
      s.push('<text x="' + X(li).toFixed(1) + '" y="' + (m.t + ih + 18) + '" text-anchor="middle" font-size="10.5" fill="#696f6a">' + esc(lb) + '</text>');
    });
    // 数据系列（隐藏的不画、不算 range）
    o.series.forEach(function (se, si) {
      if (se.hidden) return;
      var side = se.axis || "left";
      var segs = [], cur = [];
      se.data.forEach(function (dv, di) {
        if (dv == null || isNaN(dv)) { if (cur.length) { segs.push(cur); cur = []; } }
        else cur.push(di);
      });
      if (cur.length) segs.push(cur);
      segs.forEach(function (seg) {
        var pts = seg.map(function (di) { return [X(di), Y(se.data[di], side)]; });
        // Catmull-Rom → cubic Bezier 平滑曲线（张力 0.5）
        var d = smoothPath(pts);
        s.push('<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="' + (se.w || 2.4) + '" stroke-linejoin="round" stroke-linecap="round"/>');
        seg.forEach(function (di) {
          var cx = X(di).toFixed(1), cy = Y(se.data[di], side).toFixed(1);
          if (di === n - 1) s.push('<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="' + se.color + '" opacity="0.18"/>');
          s.push('<circle cx="' + cx + '" cy="' + cy + '" r="3.6" fill="#fff" stroke="' + se.color + '" stroke-width="2"/>');
        });
      });
    });
    // 悬停热区
    var hw = iw / n * 1.25;
    for (i = 0; i < n; i++) {
      var hx = X(i) - hw / 2;
      s.push('<rect class="hz" data-i="' + i + '" x="' + hx.toFixed(1) + '" y="' + m.t + '" width="' + hw.toFixed(1) + '" height="' + ih + '" fill="transparent" style="cursor:crosshair"/>');
    }
    s.push('<line class="cross" x1="0" y1="' + m.t + '" x2="0" y2="' + (m.t + ih) + '" stroke="#2f6b5b" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>');
    s.push('</svg>');
    box.innerHTML = s.join("");
    this.bind(X, Y, m, W, H);
  };
  Chart.prototype.bind = function (X, Y, m, W, H) {
    var self = this, o = this.opt, svg = this.box.querySelector("svg");
    if (!svg) return;
    var cross = svg.querySelector(".cross");
    var hz = svg.querySelectorAll(".hz");
    function findNearestIdx(svgX) {
      // 二分找最近数据点索引（labels 等距分布；如有 labelStep 跳过也按实际索引算）
      var n = o.labels.length;
      if (!n) return -1;
      var best = 0, bestDist = Infinity;
      for (var k = 0; k < n; k++) {
        var d = Math.abs(X(k) - svgX);
        if (d < bestDist) { bestDist = d; best = k; }
      }
      return best;
    }
    function showAt(i, mouseY) {
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("opacity", "0.4");
      // tooltip 只显示可见系列；不显示单位（图例里已有）
      var rows = o.series.filter(function (se) { return !se.hidden; }).map(function (se) {
        var dv = se.data[i];
        var dvTxt = (dv == null || isNaN(dv)) ? "—" : dv;
        return '<div class="row"><s style="background:' + se.color + '"></s>' + esc(se.name) + '<b>' + dvTxt + '</b></div>';
      }).join("");
      self.tip.innerHTML = '<div class="d">' + esc(o.full ? o.full[i] : o.labels[i]) + '</div>' + rows;
      self.tip.classList.add("on");
      var tw = self.tip.offsetWidth || 130;
      var left = X(i) + 14;
      if (left + tw > self.box.clientWidth) left = X(i) - tw - 14;
      self.tip.style.left = Math.max(0, left) + "px";
      // tooltip y：默认 m.t + 8（图表上沿下方）；如果传 mouseY 则就近
      self.tip.style.top = (typeof mouseY === "number" ? mouseY : m.t) + 8 + "px";
    }
    function show(i) { showAt(i, undefined); }
    function hide() { cross.setAttribute("opacity", "0"); self.tip.classList.remove("on"); }
    for (var k = 0; k < hz.length; k++) {
      (function (el) {
        el.addEventListener("mouseenter", function () { show(+el.getAttribute("data-i")); });
        el.addEventListener("click", function () { show(+el.getAttribute("data-i")); });
      })(hz[k]);
    }
    // SVG 任意位置 mousemove → 找最近数据点 → tooltip
    svg.addEventListener("mousemove", function (e) {
      var rect = svg.getBoundingClientRect();
      var sx = (e.clientX - rect.left) * (W / rect.width);
      var sy = (e.clientY - rect.top) * (H / rect.height);
      var idx = findNearestIdx(sx);
      if (idx < 0) return;
      showAt(idx, sy - m.t);
    });
    svg.addEventListener("mouseleave", hide);
    // 绑定 legend 点击切换：绑在 chart-head 的 .legend 上（事件委托）
    var lgId = o.legendId;
    if (lgId) {
      var lg = document.getElementById(lgId);
      if (lg && !lg._chartBound) {
        lg._chartBound = true;
        lg.addEventListener("click", function (e) {
          var item = e.target.closest("i[data-si]");
          if (!item) return;
          var si = +item.getAttribute("data-si");
          self.toggleSeries(si);
        });
      }
    }
  };
  Chart.prototype.toggleSeries = function (idx) {
    var s = this.opt.series[idx];
    if (!s) return;
    s.hidden = !s.hidden;
    // 更新 legend 视觉
    var lgId = this.opt.legendId;
    if (lgId) {
      var item = document.querySelector("#" + lgId + " i[data-si='" + idx + "']");
      if (item) item.classList.toggle("off", !!s.hidden);
    }
    this.render();
  };

  /* ==================== 数据访问辅助 ==================== */
  function col(name) {
    return (D.indicators.rows).map(function (r) {
      var v = r[name];
      return (v == null || v === "" || v === "-") ? null : Number(v);
    });
  }
  function rr(name) { return (D.indicators.reference_ranges || {})[name] || {}; }

  /* CA19-9 结论由 data/*.json 派生（禁止写死 —— pipe5 N1 断言） */
  function ca19Note() {
    var arr = col("CA19-9"), vals = [], i;
    for (i = 0; i < arr.length; i++) { if (arr[i] != null) vals.push(arr[i]); }
    if (!vals.length) return "";
    var hi = 37, last = vals[vals.length - 1], peak = Math.max.apply(null, vals);
    var drop = Math.round((1 - last / peak) * 100);
    // SYNC-OK: 派生分支字面量 —— 仅当最新值超出参考范围时才输出后半句（pipe5 N1 豁免）
    return last < hi ? ("已进入参考范围（<" + hi + "）；较峰值 " + peak + " 下降约 " + drop + "%")
                     : ("仍高于参考上限 " + hi + "；较峰值 " + peak + " 下降约 " + drop + "%");
  }

  /* ==================== 指标摘要卡 ==================== */
  function renderMetricCards() {
    var box = $("metricCards"); if (!box || !D.indicators) return;
    var rows = D.indicators.rows;
    var last = rows.length - 1, prev = Math.max(0, last - 1);
    var items = [
      { k: "CA19-9 肿瘤标志物", f: "CA19-9", u: "U/mL", norm: "< 37", cls: "good", low: 0, high: 37, abn: "crit", note: ca19Note() },
      { k: "白细胞 WBC", f: "WBC", u: "×10⁹/L", norm: "3.5–9.5", cls: "good", low: 3.5, high: 9.5, abn: "warn", note: "化疗后 7–14 天谷底期，每日测温" },
      { k: "中性粒细胞", f: "中性粒", u: "×10⁹/L", norm: "1.8–6.3", cls: "good", low: 1.8, high: 6.3, abn: "warn", note: "谷底期需关注；<1.0 为重度" },
      { k: "血红蛋白 HGB", f: "HGB", u: "g/L", norm: "115–150", cls: "good", low: 115, high: 150, abn: "warn", note: "轻度贫血，需持续关注" }
    ];
    box.innerHTML = items.map(function (it) {
      var av = (rows[prev][it.f] == null) ? null : Number(rows[prev][it.f]);
      var bv = (rows[last][it.f] == null) ? null : Number(rows[last][it.f]);
      var t = { cls: "flat", txt: "— 持平" };
      if (av != null && bv != null) {
        var d = bv - av;
        if (Math.abs(d) >= 1e-9) { var up = d > 0; t = { cls: up ? "up" : "down", txt: (up ? "↑ " : "↓ ") + Math.abs(d).toFixed(Math.abs(d) < 10 ? 2 : 0) }; }
      }
      var bdisp = (bv == null) ? "—" : bv;
      var mcls = it.cls;
      if (it.low != null && bv != null) mcls = (bv < it.low || bv > it.high) ? (it.abn || "warn") : "good";
      return '<div class="card metric ' + mcls + '">'
        + '<div class="k">' + esc(it.k) + '</div>'
        + '<div class="v">' + bdisp + '<span class="u">' + esc(it.u) + '</span></div>'
        + '<div class="r ' + t.cls + '">' + t.txt + ' <span style="font-weight:500;color:var(--ink-3)">较上次</span></div>'
        + '<div class="n">参考 ' + esc(it.norm) + '<br>' + esc(it.note) + '</div>'
        + '</div>';
    }).join("");
    var hint = $("lastDateHint");
    var lastEv = rows[last]["事件"] ? String(rows[last]["事件"]).replace(/^[^\w\u4e00-\u9fff]+\s*/u, "") : "";
    if (hint) hint.textContent = rows[last]["日期"] + (lastEv ? " · " + lastEv : "");
  }

  /* ==================== 图表实例 ==================== */
  var CHARTS = {}, CHARTS_BUILT = false;
  function buildCharts() {
    if (CHARTS_BUILT || !D.indicators) return;
    CHARTS_BUILT = true;
    var rows = D.indicators.rows;
    var labels = rows.map(function (r) { return String(r["日期"]).slice(5); });   // 07-10
    var full = rows.map(function (r) { return r["日期"]; });

    var el;
    el = $("tumorChart");
    if (el) {
      CHARTS.tumor = new Chart(el, $("tip-tumorChart"), {
        labels: labels, full: full, height: 250, forceZero: true, stepLeft: 60, padRatio: 0.06, right: true,
        legendId: "lg-tumorChart",
        series: [
          { name: "CA19-9", color: "#b04a3f", data: col("CA19-9"), unit: "U/mL", axis: "left" },
          { name: "CEA", color: "#3d6b93", data: col("CEA"), unit: "ng/mL", axis: "right" }
        ],
        refLines: [
          { value: 37, label: "CA19-9 上限 37", color: "#b04a3f", axis: "left", si: 0 },
          { value: 5, label: "CEA 上限 5", color: "#3d6b93", axis: "right", si: 1 }
        ],
        fmtY: function (v) { return Math.round(v); }, fmtRY: function (v) { return v.toFixed(1); }
      });
      $("lg-tumorChart").innerHTML =
        '<i data-si="0"><s style="background:#b04a3f"></s>CA19-9（左轴 U/mL）</i>'
        + '<i data-si="1"><s style="background:#3d6b93"></s>CEA（右轴 ng/mL）</i>';
      var caCol = col("CA19-9"), caVals = [], caLastDate = "", ci;
      for (ci = 0; ci < caCol.length; ci++) { if (caCol[ci] != null) { caVals.push(caCol[ci]); caLastDate = rows[ci]["日期"]; } }
      if (caVals.length) {
        var caPeak = Math.max.apply(null, caVals), caLast = caVals[caVals.length - 1], caUp = caLast >= 37;
        $("ft-tumorChart").textContent = "CA19-9 峰值 " + caPeak + " → 最新 " + caLast + " U/mL（" + caLastDate + "）："
          + (caUp ? "仍高于参考上限 37" : "已进入参考范围（<37）")   // SYNC-OK: 派生分支字面量
          + "，较峰值下降约 " + Math.round((1 - caLast / caPeak) * 100) + "%；CEA 维持正常低值。";
      }
    }

    el = $("wbcChart");
    if (el) {
      CHARTS.wbc = new Chart(el, $("tip-wbcChart"), {
        labels: labels, full: full, height: 250, minLeft: 0, stepLeft: 5, padRatio: 0.05,
        legendId: "lg-wbcChart",
        series: [
          { name: "白细胞 WBC", color: "#2f6b5b", data: col("WBC"), unit: "×10⁹/L" },
          { name: "中性粒细胞", color: "#c0872c", data: col("中性粒"), unit: "×10⁹/L" }
        ],
        bands: [{ from: 3.5, to: 9.5, label: "白细胞正常 3.5–9.5", color: "#2f6b5b", axis: "left", si: 0 }],
        refLines: [{ value: 1.5, label: "中性粒警戒 1.5", color: "#b04a3f", axis: "left", si: 1 }],
        fmtY: function (v) { return v.toFixed(1); }
      });
      $("lg-wbcChart").innerHTML =
        '<i data-si="0"><s style="background:#2f6b5b"></s>白细胞</i>'
        + '<i data-si="1"><s style="background:#c0872c"></s>中性粒细胞</i>';
      $("ft-wbcChart").textContent = "07-28、08-18 化疗后白细胞一过性升高（升白针/G-CSF 作用），低谷见于 07-21（中性粒 1.04，2 度抑制）。";
    }

    el = $("hgbChart");
    if (el) {
      CHARTS.hgb = new Chart(el, $("tip-hgbChart"), {
        labels: labels, full: full, height: 250, right: true,
        legendId: "lg-hgbChart",
        series: [
          { name: "血红蛋白 HGB", color: "#e0567a", data: col("HGB"), unit: "g/L", axis: "left" },
          { name: "血小板 PLT", color: "#3d6b93", data: col("PLT"), unit: "×10⁹/L", axis: "right" }
        ],
        bands: [
          { from: 115, to: 150, label: "HGB 正常 115–150", color: "#e0567a", axis: "left", si: 0 },
          { from: 125, to: 350, label: "PLT 正常 125–350", color: "#3d6b93", axis: "right", si: 1 }
        ],
        fmtY: function (v) { return Math.round(v); }, fmtRY: function (v) { return Math.round(v); }
      });
      $("lg-hgbChart").innerHTML =
        '<i data-si="0"><s style="background:#e0567a"></s>血红蛋白（左轴 g/L）</i>'
        + '<i data-si="1"><s style="background:#3d6b93"></s>血小板（右轴 ×10⁹/L）</i>';
      $("ft-hgbChart").textContent = "血红蛋白由 118 降至 90（1 度贫血），后回升至 104.4（09-15）；血小板 252（09-15）在正常范围，随化疗波动。";
    }

    el = $("liverChart");
    if (el) {
      CHARTS.liver = new Chart(el, $("tip-liverChart"), {
        labels: labels, full: full, height: 240, stepLeft: 5, padRatio: 0.15,
        legendId: "lg-liverChart",
        series: [
          { name: "ALT", color: "#2f6b5b", data: col("ALT"), unit: "U/L" },
          { name: "AST", color: "#3d6b93", data: col("AST"), unit: "U/L" }
        ],
        bands: [{ from: 7, to: 40, label: "ALT/AST 正常 7–40", color: "#2f6b5b", axis: "left" }],
        fmtY: function (v) { return Math.round(v); }
      });
      $("lg-liverChart").innerHTML =
        '<i data-si="0"><s style="background:#2f6b5b"></s>ALT</i>'
        + '<i data-si="1"><s style="background:#3d6b93"></s>AST</i>';
      $("ft-liverChart").textContent = "肝功能平稳，ALT/AST 始终处于正常范围内（07-21 未查，已断开显示）。";
    }

    el = $("liverExtraChart");
    if (el) {
      CHARTS.liverExtra = new Chart(el, $("tip-liverExtraChart"), {
        labels: labels, full: full, height: 240, right: true, stepLeft: 50, padRatio: 0.10,
        legendId: "lg-liverExtraChart",
        series: [
          { name: "前白蛋白", color: "#2f6b5b", data: col("前白蛋白"), unit: "mg/L", axis: "left" },
          { name: "LDH", color: "#c0872c", data: col("LDH"), unit: "U/L", axis: "right" }
        ],
        bands: [{ from: 200, to: 400, label: "前白蛋白正常 200–400", color: "#2f6b5b", axis: "left", si: 0 }],
        refLines: [
          { value: 250, label: "LDH 上限 250", color: "#c0872c", axis: "right", si: 1 }
        ],
        fmtY: function (v) { return Math.round(v); }, fmtRY: function (v) { return Math.round(v); }
      });
      $("lg-liverExtraChart").innerHTML =
        '<i data-si="0"><s style="background:#2f6b5b"></s>前白蛋白（左轴 mg/L）</i>'
        + '<i data-si="1"><s style="background:#c0872c"></s>LDH（右轴 U/L）</i>';
      $("ft-liverExtraChart").textContent = "前白蛋白偏低提示营养状态欠佳；LDH 在 08-18 升高至 333（肿瘤负荷/溶血可能），余次正常。";
    }

    el = $("renalChart");
    if (el) {
      CHARTS.renal = new Chart(el, $("tip-renalChart"), {
        labels: labels, full: full, height: 240, right: true, stepLeft: 10, padRatio: 0.10, minRight: 80,
        legendId: "lg-renalChart",
        series: [
          { name: "肌酐 Crea", color: "#3d6b93", data: col("Crea"), unit: "μmol/L", axis: "left" },
          { name: "eGFR", color: "#2f6b5b", data: col("eGFR"), unit: "mL/min/1.73m²", axis: "right" }
        ],
        refLines: [
          { value: 73, label: "肌酐上限 73", color: "#3d6b93", axis: "left", si: 0 },
          { value: 90, label: "eGFR 下限 90", color: "#2f6b5b", axis: "right", si: 1 }
        ],
        fmtY: function (v) { return Math.round(v); }, fmtRY: function (v) { return v.toFixed(1); }
      });
      $("lg-renalChart").innerHTML =
        '<i data-si="0"><s style="background:#3d6b93"></s>肌酐（左轴 μmol/L）</i>'
        + '<i data-si="1"><s style="background:#2f6b5b"></s>eGFR（右轴）</i>';
      $("ft-renalChart").textContent = "肌酐 49–66 μmol/L 正常；eGFR 波动于 89–120，08-18 略低于 90，整体肾功能良好。";
    }

    el = $("electrolyteChart");
    if (el) {
      CHARTS.electro = new Chart(el, $("tip-electrolyteChart"), {
        labels: labels, full: full, height: 240, right: true, minLeft: 0, stepLeft: 1, padRatio: 0.12,
        legendId: "lg-electrolyteChart",
        series: [
          { name: "钾 K", color: "#c0872c", data: col("K"), unit: "mmol/L", axis: "left" },
          { name: "钠 Na", color: "#3d6b93", data: col("Na"), unit: "mmol/L", axis: "right" }
        ],
        bands: [
          { from: 3.5, to: 5.3, label: "钾 3.5–5.3", color: "#c0872c", axis: "left", si: 0 },
          { from: 137, to: 147, label: "钠 137–147", color: "#3d6b93", axis: "right", si: 1 }
        ],
        fmtY: function (v) { return v.toFixed(1); }, fmtRY: function (v) { return Math.round(v); }
      });
      $("lg-electrolyteChart").innerHTML =
        '<i data-si="0"><s style="background:#c0872c"></s>钾（左轴 mmol/L）</i>'
        + '<i data-si="1"><s style="background:#3d6b93"></s>钠（右轴 mmol/L）</i>';
      $("ft-electrolyteChart").textContent = "血钾偏低（3.5 左右），需关注饮食补钾；血钠正常。化疗相关电解质紊乱已监测。";
    }
  }

  /* ==================== 指标数据表 ==================== */
  /* 指标缩写 → 中文名映射（非专业人士友好）。
     顺序与 src/data/indicators.json 的 meta.fields 一一对应。 */
  var FIELD_CN = {
    "CA19-9": "糖类抗原 19-9",
    "CEA": "癌胚抗原",
    "WBC": "白细胞",
    "中性粒": "中性粒细胞",
    "HGB": "血红蛋白",
    "PLT": "血小板",
    "ALT": "丙氨酸氨基转移酶",
    "AST": "天门冬氨酸氨基转移酶",
    "K": "血钾",
    "Na": "血钠",
    "Crea": "肌酐",
    "eGFR": "肾小球滤过率",
    "前白蛋白": "前白蛋白",
    "LDH": "乳酸脱氢酶",
    "胱抑素C": "胱抑素 C",
    "CA72-4": "糖类抗原 72-4",
    "HBV-DNA": "乙肝病毒 DNA"
  };

  function renderIndicatorsTable() {
    var box = $("indicators-table"); if (!box || !D.indicators) return;
    var ind = D.indicators, fields = ind.meta.fields, rows = ind.rows, rrng = ind.reference_ranges;
    function cellCls(f, v) {
      var r = rrng[f]; if (!r) return { cls: "", arrow: "" };
      if (v == null || v === "" || v === "-") return { cls: "", arrow: "" };
      var nn = Number(v);
      if (r.lo != null && nn < r.lo) return { cls: "lo", arrow: " ↓" };
      if (r.hi != null && nn > r.hi) return { cls: "hi", arrow: " ↑" };
      return { cls: "ok", arrow: "" };
    }
    /* 列可见性：数据不动，只在展示层屏蔽。
       后续需要时把对应项改为 false（或从对象里删掉）即可恢复，无需改数据/Excel。 */
    var COL_HIDDEN = { "CEA": true, "CA19-9环比": true };
    var head = "<thead><tr><th>日期</th><th class=\"col-event\">事件</th>";
    fields.forEach(function (f) {
      if (COL_HIDDEN[f]) return;
      var cn = FIELD_CN[f] || f;
      // 缩写 / 中文 / 参考范围（中文为主，括号附缩写）
      var head_main = cn === f ? esc(f) : esc(cn) + " <span class=\"abbr\">" + esc(f) + "</span>";
      head += "<th>" + head_main + "<br><span class=\"ref\">" + esc((rrng[f] && rrng[f].text) || "") + "</span></th>";
    });
    if (!COL_HIDDEN["CA19-9环比"]) {
      head += "<th>糖类抗原 19-9 <span class=\"abbr\">CA19-9</span><br><span class=\"ref\">环比</span></th>";
    }
    head += "</tr></thead>";
    var body = "";
    rows.forEach(function (r, idx) {
      var ca = r["CA19-9"];
      body += "<tr><td>" + esc(r["日期"] || "") + "</td><td class=\"col-event\">" + esc(r["事件"] || "") + "</td>";
      fields.forEach(function (f) {
        if (COL_HIDDEN[f]) return;
        var v = r[f];
        var disp = (v == null || v === "" || v === "-") ? "—" : v;
        var cs = cellCls(f, v);
        body += "<td class=\"num " + cs.cls + "\">" + esc(disp) + cs.arrow + "</td>";
      });
      if (!COL_HIDDEN["CA19-9环比"]) {
        var chg = "<span style=\"color:var(--ink-3)\">—</span>";
        if (idx > 0 && ca != null && rows[idx - 1]["CA19-9"] != null) {
          var p = (ca - rows[idx - 1]["CA19-9"]) / rows[idx - 1]["CA19-9"] * 100;
          var col = p < 0 ? "var(--green-d)" : "var(--brick)";
          chg = "<span style=\"color:" + col + "\">" + p.toFixed(1) + "%</span>";
        }
        body += "<td class=\"num\">" + chg + "</td>";
      }
      body += "</tr>";
    });
    box.innerHTML = '<div class="tbl-wrap"><table class="tbl">' + head + body + "</tbody></table></div>";
  }
  /* ==================== 费用 ==================== */
  function renderFees() {
    var f = D.fees; if (!f) return;
    var t = f.totals_from_detail;
    var total = t["总金额"], ins = t["医保统筹"], per = t["个人支付"];
    var rate = Math.round(per / total * 100);
    // 注：「医保报销比例」卡片已按用户裁决移除，只保留「总自付比例」。
    // fees.json 的 latest_outpatient_reimburse 仍由 pipe1 派生（口径保留备用），但前端不再消费。
    // 统计区间由 fees.detail 派生（2026-09-22 立规：禁止在 app.js 写死日期，见 scripts/pipeline/pipe5_check_narrative_sync.py F3 断言）
    var _ds = (f.detail || []).map(function (r) { return String(r["日期"] || "").slice(0, 10); })
      .filter(Boolean).sort();
    var span = _ds.length ? (_ds[0] + " 至 " + _ds[_ds.length - 1]) : "\u2014";
    var hero = $("fees-hero");
    if (hero) {
      hero.innerHTML = '<div class="row">'
        + '<div><div class="k">累计总费用</div><div class="big">' + money(total) + '</div></div>'
        + '<div><div class="k">医保统筹支付</div><div class="mid">' + money(ins) + '</div></div>'
        + '<div><div class="k">个人现金支付</div><div class="mid">' + money(per) + '</div></div>'
        + '<div><div class="k">总自付比例</div><div class="mid">' + rate + '%</div>'
        + '<div style="font-size:11px;color:rgba(255,255,255,.62);margin-top:3px">个人支付 ÷ 总费用（全部记录）</div></div>'
        + '</div>'
        + '<div class="note">统计区间 ' + esc(span) + '　｜　医保类型：职工基本医疗保险　｜　含大病医保报销</div>';
    }
    var cnt = $("fees-count");
    if (cnt) cnt.textContent = "共 " + f.meta.detail_count + " 笔门诊/住院记录";
    var bars = $("fees-bars");
    if (bars) {
      var map = {};
      f.detail.forEach(function (r) { var k = r["项目分类"] || "其他"; map[k] = (map[k] || 0) + Number(r["金额"]); });
      var arr = Object.keys(map).map(function (k) { return { n: k, v: map[k] }; }).sort(function (a, b) { return b.v - a.v; });
      var top = arr.slice(0, 8), rest = arr.slice(8);
      var rowsB = top.slice();
      if (rest.length) { var oth = rest.reduce(function (a, b) { return a + b.v; }, 0); rowsB.push({ n: "其他", v: oth }); }
      var tot = rowsB.reduce(function (a, b) { return a + b.v; }, 0);
      bars.innerHTML = rowsB.map(function (c) {
        var pc = c.v / tot * 100;
        return '<div class="bar-row"><div class="nm">' + esc(c.n) + '</div>'
          + '<div class="track"><div class="fill" style="width:' + pc.toFixed(1) + '%;background:var(--green)"></div></div>'
          + '<div class="vv">' + money(c.v) + '</div><div class="pc">' + pc.toFixed(1) + '%</div></div>';
      }).join("");
    }
    var det = $("fees-detail");
    if (det) {
      // 不固定列、不压缩列宽（2026-09-22 用户立规）：整表按内容自然宽度，容器左右滑动
      // 列序：日期 / 类型 / 医院·科室 / 项目分类 / 项目明细 / 金额 / 医保统筹 / 个人支付
      var head = "<thead><tr>"
        + "<th>日期</th><th>类型</th><th>医院/科室</th>"
        + '<th>项目分类</th><th>项目明细</th>'
        + '<th style="text-align:right">金额</th><th style="text-align:right">医保统筹</th><th style="text-align:right">个人支付</th>'
        + "</tr></thead><tbody>";
      var body = ""; var st = 0, si = 0, sp = 0;
      f.detail.forEach(function (r) {
        var amt = Number(r["金额"]), gi = Number(r["医保统筹"]), pe = Number(r["个人支付"]);
        st += amt; si += gi; sp += pe;
        body += '<tr>'
          + '<td>' + esc(r["日期"]) + '</td>'
          + '<td>' + esc(r["类型"]) + '</td>'
          + '<td>' + esc(r["医院"]) + '</td>'
          + '<td><span class="mini n">' + esc(r["项目分类"]) + '</span></td>'
          + '<td class="cell-desc">' + esc(r["项目明细"]) + '</td>'
          + '<td class="num" style="text-align:right">' + money(amt) + '</td>'
          + '<td class="num" style="text-align:right;color:var(--green-d)">' + money(gi) + '</td>'
          + '<td class="num" style="text-align:right;color:var(--brick)">' + money(pe) + '</td></tr>';
      });
      // 合计行
      body += '<tr class="row-total">'
        + '<td colspan="3" style="text-align:right">合计</td>'
        + '<td></td><td></td>'
        + '<td class="num" style="text-align:right">' + money(st) + '</td>'
        + '<td class="num" style="text-align:right;color:var(--green-d)">' + money(si) + '</td>'
        + '<td class="num" style="text-align:right;color:var(--brick)">' + money(sp) + '</td>'
        + '</tr>';
      det.innerHTML = '<div class="tbl-wrap fees-wrap"><table class="tbl fees-tbl">' + head + body + "</tbody></table></div>"
        + '<div class="fees-hint">↔ 表格可左右滑动查看完整列</div>';
    }
    var hos = $("fees-hospital");
    if (hos && f.hospitalization) {
      var hh = "<thead><tr><th>费用类别</th><th style=\"text-align:right\">金额(元)</th><th>占比</th><th>说明</th></tr></thead><tbody>";
      f.hospitalization.forEach(function (r) {
        hh += "<tr><td>" + esc(r["费用类别"]) + "</td><td class=\"num\" style=\"text-align:right\">" + money(Number(r["金额(元)"]))
          + "</td><td>" + esc(r["占比"]) + "</td><td style=\"white-space:normal;max-width:300px;color:var(--ink-2)\">" + esc(r["说明"] || "") + "</td></tr>";
      });
      hh += "</tbody>";
      hos.innerHTML = '<div class="tbl-wrap"><table class="tbl">' + hh + "</table></div>";
    }
  }

  /* ==================== 表格横向滑动提示 ====================
     表格一律「不压缩列宽 + 容器横滚」（用户立规，见 pipe5 N4 断言）。
     提示**每个 tab 至多 1 条**（用户裁决）：挂在当前可见面板里第一个
     真正需要横滚的容器之后，避免单页叠出 20+ 条重复文字。
     SYNC-N4: 全文件仅允许此一处 scroll-hint 插入点（pipe5 N4 断言单例）。 */
  function markScrollables() {
    var wraps = document.querySelectorAll(".table-wrap, .tbl-wrap, .fees-wrap");
    var shown = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    var first = null;
    for (var i = 0; i < wraps.length; i++) {
      // 隐藏面板（display:none）内元素 rect 全 0 → 自动跳过；此处不能依赖
      // offsetParent，headless 下对可见元素也会返回 null（实测）
      if (!shown(wraps[i])) continue;
      if (wraps[i].scrollWidth > wraps[i].clientWidth + 1) { first = wraps[i]; break; }
    }
    var hints = document.querySelectorAll(".scroll-hint");
    // 已挂在正确位置且仅一条 → 直接返回，避免每次滚动/切 tab 重建 DOM 造成闪烁
    if (hints.length === 1 && first && hints[0].previousElementSibling === first) return;
    for (var j = 0; j < hints.length; j++) hints[j].parentNode.removeChild(hints[j]);
    if (!first) return;
    var p = document.createElement("p");
    p.className = "scroll-hint";
    p.textContent = "↔ 本页表格可左右滑动查看完整列";
    first.parentNode.insertBefore(p, first.nextSibling);
  }
  var _scrollTimer = null;
  function markScrollablesSoon() {
    if (_scrollTimer) clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(markScrollables, 60);
  }

  /* ==================== 交互 ==================== */
  function initTabs() {
    var tabs = $("tabs"); if (!tabs) return;
    tabs.addEventListener("click", function (e) {
      var btn = e.target.closest(".tab"); if (!btn) return;
      var id = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === btn); });
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("active", p.id === "panel-" + id); });
      if (id === "indicators") setTimeout(buildCharts, 30);
      markScrollablesSoon();
    });
  }
  function initFolds() {
    document.querySelectorAll(".fold-head").forEach(function (h) {
      h.addEventListener("click", function () {
        var b = document.getElementById("fold-" + h.getAttribute("data-fold")); if (!b) return;
        var open = b.classList.toggle("open");
        h.classList.toggle("open", open);
        var tag = h.querySelector(".mini"); if (tag) tag.textContent = open ? "点击收起" : "点击展开";
      });
    });
  }

  /* ==================== 隐私提示条关闭 ==================== */
  function initNotice() {
    var bar = $("noticeBar"); if (!bar) return;
    try {
      if (localStorage.getItem("cs_notice_dismissed") === "1") {
        bar.classList.add("hidden");
      }
    } catch (e) {}
  }
  function tagChartsA11y() {
    var cards = document.querySelectorAll(".chart-card");
    for (var i = 0; i < cards.length; i++) {
      var svg = cards[i].querySelector("svg");
      if (!svg) continue;
      var t = cards[i].querySelector(".chart-title");
      var f = cards[i].querySelector(".chart-foot");
      var txt = ((t) ? t.textContent : "") + "。" + ((f) ? f.textContent : "");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", txt.trim());
    }
  }

  /* ==================== 打印：快照前展开全部面板 ====================
     根因（实测，勿删）：Chrome **不为「屏幕态 display:none、仅 @media print 改 block」
     的元素执行布局** —— 6 个非活动面板会整块打印成空白（49 页里只有 1~2 页有内容、
     总墨量 46）。因此必须在 beforeprint 阶段**先改 DOM**，让面板在打印快照前
     就已是 display:block；同时把 tabs / notice-bar 在 DOM 里隐藏（跨媒体 display
     不一致同样会崩坏整份文档分页）。

     实测（同一份 index.html）：介入后 49/49 页均有内容、总墨量 1073（对照 46）。
     afterprint 必须还原，否则屏幕上会 7 个面板全部堆叠显示。 */
  function prepPrint() {
    var i, els;
    els = document.querySelectorAll(".panel");
    for (i = 0; i < els.length; i++) { els[i].style.display = "block"; els[i].style.animation = "none"; }
    els = document.querySelectorAll(".tabs,.notice-bar");
    for (i = 0; i < els.length; i++) { els[i].style.display = "none"; }
  }
  function unprepPrint() {
    var i, els;
    els = document.querySelectorAll(".panel");
    for (i = 0; i < els.length; i++) { els[i].style.display = ""; els[i].style.animation = ""; }
    els = document.querySelectorAll(".tabs,.notice-bar");
    for (i = 0; i < els.length; i++) { els[i].style.display = ""; }
  }
  window.addEventListener("beforeprint", prepPrint);
  window.addEventListener("afterprint", unprepPrint);
  if (window.matchMedia) {
    var _pq = window.matchMedia("print");
    var _pqh = function (e) { if (e.matches) prepPrint(); };
    if (_pq.addEventListener) _pq.addEventListener("change", _pqh);
    else if (_pq.addListener) _pq.addListener(_pqh);
  }

  function dismissNotice() {
    var bar = $("noticeBar"); if (!bar) return;
    bar.classList.add("hidden");
    try { localStorage.setItem("cs_notice_dismissed", "1"); } catch (e) {}
  }
  window.dismissNotice = dismissNotice;

  /* ==================== 启动 ==================== */
  document.addEventListener("DOMContentLoaded", function () {
    initNotice();
    renderMetricCards();
    renderIndicatorsTable();
    renderFees();
    initTabs();
    initFolds();
    tagChartsA11y();
    markScrollables();
    window.addEventListener("resize", markScrollablesSoon);
    if ($("panel-indicators") && $("panel-indicators").classList.contains("active")) buildCharts();
  });
})();
