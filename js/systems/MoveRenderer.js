/**
 * ============================================================
 * MoveRenderer.js —— 移动轨迹预览（第 8.5 步新增）
 * ============================================================
 * 职责：
 *   把 MoveController 算出的移动路径画成「弧线轨迹 + 落点圈」，
 *   与投掷的 TrajectoryRenderer（虚线点列 + 爆炸预警圈）区分开：
 *
 *   | 项目 | 投掷轨迹 | 移动轨迹（本文件） |
 *   | --- | --- | --- |
 *   | 形状 | 白色小圆点列 | 青色连续折线 + 端点圆点 |
 *   | 落点 | 琥珀/红色爆炸圈（= 伤害范围） | 青色空心圈 + 十字（= 站位点） |
 *   | 弹回 | 无 | 每个撞墙点画一个「⟲」标记 |
 *
 *   本类只做绘制，不做任何物理计算；数据全部来自 MoveController.getState()。
 *
 * 第 8.5 步任务 B（拖拽不受画布限制）：
 *   轨迹允许超出画布，绘制时按 viewport 裁剪——只画画布内可见的部分，
 *   因此「拖到画布外」时玩家仍能看到轨迹从单位延伸出屏幕边界，而不是整条消失。
 *
 * 依赖：Phaser Graphics、FK.MoveController、FK.Config.MOVE
 * 对外：FK.MoveRenderer
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const DEFAULT_DEPTH = 40;

  /** 配色与点尺寸（集中，方便调） */
  const COLOR = {
    line: 0x38BDF8,
    lineBallistic: 0x22D3EE,
    landing: 0x22D3EE,
    landingWater: 0xEF4444,
    landingWall: 0xFACC15,
    bounce: 0xFDE047,
    unit: 0xFFFFFF
  };
  const STYLE = {
    pointAlpha: 0.7,
    pointR: 3,
    dashSegs: 16,
    dashGap: 0.45
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class MoveRenderer {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   moveController  FK.MoveController（提供 getState / isPlanning）
     *   depth           渲染深度（缺省 40，与投掷轨迹同级）
     *   viewport        { left, top, right, bottom } 可视区域（缺省整块画布）
     *   alpha           轨迹透明度
     */
    constructor(scene, opts) {
      opts = opts || {};
      const M = (FK.Config && FK.Config.MOVE) ? FK.Config.MOVE : {};
      const C = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS : { width: 1600, height: 800 };

      this.scene = scene || null;
      this.moveController = opts.moveController || null;
      this.depth = num(opts.depth, num(M.previewDepth, DEFAULT_DEPTH));
      this.alpha = num(opts.alpha, num(M.previewAlpha, 0.6));
      this.landingAlpha = num(opts.landingAlpha, num(M.landingAlpha, 0.85));
      this.radiusPx = num(opts.radiusPx, num(M.previewRadiusPx, 22));
      this.viewport = Object.assign({ left: 0, top: 0, right: C.width, bottom: C.height }, opts.viewport || {});

      this.canDraw = !!(this.scene && this.scene.add && typeof this.scene.add.graphics === 'function');
      if (this.canDraw) {
        this.lineGfx = this.scene.add.graphics();
        this.ringGfx = this.scene.add.graphics();
        if (typeof this.lineGfx.setDepth === 'function') { this.lineGfx.setDepth(this.depth); }
        if (typeof this.ringGfx.setDepth === 'function') { this.ringGfx.setDepth(this.depth + 1); }
      } else {
        this.lineGfx = null;
        this.ringGfx = null;
      }

      /** 最近一次绘制信息（HUD / 自检用） */
      this.lastDraw = {
        visible: false, totalPoints: 0, drawnPoints: 0, culled: 0,
        bounces: 0, landing: null, hitType: 'none', ringRadius: 0
      };
    }

    /* ---------------- 配置 ---------------- */

    /** 设置落点圈半径（像素） */
    setRadiusPx(px) {
      this.radiusPx = Math.max(0, num(px, 0));
      return this;
    }

    /* ---------------- 每帧绘制 ---------------- */

    /** 每帧调用：规划中绘制轨迹，否则擦除 */
    update() {
      const st = this.moveController && typeof this.moveController.getState === 'function'
        ? this.moveController.getState() : null;

      if (!st || !st.planning) {
        this.clear();
        return;
      }
      const preview = this.getPreview();
      if (!preview || !preview.points || preview.points.length < 2) {
        this.clear();
        return;
      }
      this.drawPath(preview);
      this.drawLanding(preview);
      this.lastDraw.visible = true;
    }

    /**
     * 取本次规划的路径数据。
     * 优先用 MoveController 维护的 path（与实飞同源），
     * 拿不到时退化为「只有落点」的降级绘制。
     */
    getPreview() {
      const mc = this.moveController;
      if (!mc) { return null; }
      if (mc.path && mc.path.points && mc.path.points.length >= 2) {
        return {
          points: mc.path.points,
          landing: mc.path.landing,
          hitType: mc.path.hitType,
          bounces: mc.path.bounces
        };
      }
      const st = mc.getState ? mc.getState() : null;
      if (st && st.landing) {
        return { points: [], landing: st.landing, hitType: st.hitType, bounces: st.bounces || 0 };
      }
      return null;
    }

    /** 点是否在可视区域内（含余量） */
    isVisiblePoint(x, y, margin) {
      const v = this.viewport;
      const m = num(margin, 0);
      return x >= v.left - m && x <= v.right + m && y >= v.top - m && y <= v.bottom + m;
    }

    /**
     * 线段是否与可视区域相交（用于「裁剪而不是整段丢弃」）
     * 采用 Liang–Barsky 的简化版：只要任一端的点在框内，或线段穿过框，即算可见。
     */
    segmentVisible(a, b) {
      if (this.isVisiblePoint(a.x, a.y, 0) || this.isVisiblePoint(b.x, b.y, 0)) { return true; }
      const v = this.viewport;
      // 粗判：线段包围盒与视口包围盒有交集 + 方向穿越检测
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      if (maxX < v.left || minX > v.right || maxY < v.top || minY > v.bottom) { return false; }

      // 与四条边求交（参数 t ∈ [0,1]）
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const ts = [];
      if (Math.abs(dx) > 1e-9) {
        ts.push((v.left - a.x) / dx);
        ts.push((v.right - a.x) / dx);
      }
      if (Math.abs(dy) > 1e-9) {
        ts.push((v.top - a.y) / dy);
        ts.push((v.bottom - a.y) / dy);
      }
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (t < 0 || t > 1) { continue; }
        const px = a.x + dx * t;
        const py = a.y + dy * t;
        if (px >= v.left - 1e-6 && px <= v.right + 1e-6 && py >= v.top - 1e-6 && py <= v.bottom + 1e-6) {
          return true;
        }
      }
      return false;
    }

    /**
     * 画移动轨迹（青色折线 + 抛物线点 + 弹回标记）
     * 画布外的部分不画（预测仍然完整，只是不可见）
     * @param {Object} preview { points, landing, hitType, bounces }
     */
    drawPath(preview) {
      const g = this.lineGfx;
      if (!g) { return; }

      const pts = preview.points || [];
      let drawn = 0;
      let culled = 0;
      let prev = null;

      g.clear();
      g.lineStyle(3, COLOR.line, this.alpha);

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const visible = this.isVisiblePoint(p.x, p.y, 0);
        if (!visible) { culled += 1; }
        if (prev) {
          if (this.segmentVisible(prev, p)) {
            g.beginPath();
            g.moveTo(prev.x, prev.y);
            g.lineTo(p.x, p.y);
            g.strokePath();
          }
        }
        if (visible) {
          g.fillStyle(COLOR.lineBallistic, STYLE.pointAlpha);
          g.fillCircle(p.x, p.y, STYLE.pointR);
          drawn += 1;
        }
        prev = p;
      }

      // 起点标记（单位当前站位）
      if (pts.length > 0 && this.isVisiblePoint(pts[0].x, pts[0].y, 0)) {
        g.fillStyle(COLOR.unit, Math.min(1, this.alpha + 0.3));
        g.fillCircle(pts[0].x, pts[0].y, 4.5);
      }

      // 弹回点：撞墙那一瞬间画一个黄色小圈
      for (let i = 0; i < pts.length; i++) {
        if (!pts[i].bounce) { continue; }
        if (!this.isVisiblePoint(pts[i].x, pts[i].y, 0)) { continue; }
        g.lineStyle(2, COLOR.bounce, 0.95);
        g.strokeCircle(pts[i].x, pts[i].y, 9);
        g.fillStyle(COLOR.bounce, 0.9);
        g.fillCircle(pts[i].x - 4, pts[i].y, 2);
        g.fillCircle(pts[i].x + 4, pts[i].y, 2);
      }

      this.lastDraw.totalPoints = pts.length;
      this.lastDraw.drawnPoints = drawn;
      this.lastDraw.culled = culled;
      this.lastDraw.bounces = preview.bounces || 0;
      this.lastDraw.hitType = preview.hitType || 'none';
    }

    /**
     * 画落点圈（青色空心圈 + 十字准星；落水变红、撞墙停下变黄）
     * 落点在画布外 → 不画（预测数据仍然完整）
     */
    drawLanding(preview) {
      const g = this.ringGfx;
      if (!g) { return; }
      g.clear();

      const land = preview.landing;
      if (!land) { this.lastDraw.ringRadius = 0; return; }
      if (!this.isVisiblePoint(land.x, land.y, 0)) {
        this.lastDraw.landing = land;
        this.lastDraw.ringRadius = 0;
        return;
      }

      const color = (preview.hitType === 'water') ? COLOR.landingWater
        : (preview.hitType === 'bounds' ? COLOR.landingWall : COLOR.landing);
      const r = this.radiusPx;

      g.fillStyle(color, 0.16);
      g.fillCircle(land.x, land.y, r);
      g.lineStyle(3, color, this.landingAlpha);
      g.strokeCircle(land.x, land.y, r);
      g.lineStyle(1.5, color, this.landingAlpha * 0.8);
      drawDashedCircle(g, land.x, land.y, r * 0.55, STYLE.dashSegs, STYLE.dashGap);
      g.lineStyle(2, color, this.landingAlpha * 0.9);
      const c = r * 0.5;
      g.beginPath();
      g.moveTo(land.x - c, land.y);
      g.lineTo(land.x + c, land.y);
      g.moveTo(land.x, land.y - c);
      g.lineTo(land.x, land.y + c);
      g.strokePath();

      this.lastDraw.landing = land;
      this.lastDraw.ringRadius = r;
    }

    /** 擦除全部绘制 */
    clear() {
      if (this.lineGfx) { this.lineGfx.clear(); }
      if (this.ringGfx) { this.ringGfx.clear(); }
      this.lastDraw.visible = false;
      this.lastDraw.totalPoints = 0;
      this.lastDraw.drawnPoints = 0;
      this.lastDraw.culled = 0;
      this.lastDraw.bounces = 0;
      this.lastDraw.landing = null;
      this.lastDraw.ringRadius = 0;
    }

    /** 绘制信息快照（自检用） */
    getDrawInfo() {
      return {
        visible: !!this.lastDraw.visible,
        totalPoints: this.lastDraw.totalPoints,
        drawnPoints: this.lastDraw.drawnPoints,
        culled: this.lastDraw.culled,
        bounces: this.lastDraw.bounces,
        landing: this.lastDraw.landing,
        hitType: this.lastDraw.hitType,
        ringRadius: this.lastDraw.ringRadius
      };
    }

    destroy() {
      if (this.lineGfx && typeof this.lineGfx.destroy === 'function') { this.lineGfx.destroy(); }
      if (this.ringGfx && typeof this.ringGfx.destroy === 'function') { this.ringGfx.destroy(); }
      this.lineGfx = null;
      this.ringGfx = null;
      this.moveController = null;
    }
  }

  function drawDashedCircle(g, x, y, radius, segments, gapRatio) {
    const seg = (Math.PI * 2) / segments;
    const gap = seg * (typeof gapRatio === 'number' ? gapRatio : 0.45);
    g.beginPath();
    for (let i = 0; i < segments; i++) {
      const a0 = i * seg;
      g.arc(x, y, radius, a0, a0 + (seg - gap), false);
    }
    g.strokePath();
  }

  MoveRenderer.COLOR = Object.freeze(COLOR);

  FK.MoveRenderer = MoveRenderer;
})();
