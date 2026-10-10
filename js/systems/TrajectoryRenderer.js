/**
 * ============================================================
 * TrajectoryRenderer.js —— 轨迹渲染器
 * ============================================================
 * 职责：
 *   把 TrajectoryPredictor 算出来的点列画成「半透明虚线抛物线」，
 *   并在落点画预警圈（半径来自当前道具 ItemConfig.radius）。
 *   本类只负责绘制，不做任何物理计算。
 *
 * 视觉规则：
 *   · 轨迹点：白色小圆点，越远越淡越细
 *   · **画布外的点直接跳过**（第 7 步）：抛物线允许越过屏幕上边界，
 *     物理上预测完整算完（供落点/碰撞使用），但绘制只画可见部分——
 *     画布外的点画了也看不见，跳过可以省掉大量无效绘制调用
 *   · 落点预警圈：命中平台/边界 → 琥珀色；命中水面 → 红色（更醒目）
 *   · 命中平台时，预警圈圆心就在平台表面的命中点上（自然停在表面）
 *   · 未瞄准 / 无结果 → 全部擦除（update() 每帧自动判断）
 *
 * 依赖：Phaser Graphics、FK.TrajectoryPredictor、FK.AimController
 * 对外：FK.TrajectoryRenderer
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 渲染深度（低于 HUD，高于单位） */
  const DEFAULT_DEPTH = 40;

  /** 轨迹点与落点圈（集中，方便调） */
  const STYLE = {
    pointColor: 0xFFFFFF,
    pointAlpha: 0.6,
    pointR: 3,
    dashSegs: 16,
    dashGap: 0.45
  };

  /** 落点预警圈配色 */
  const RING_COLOR = {
    normal: { fill: 0xF59E0B, fillAlpha: 0.26, stroke: 0xFCD34D, strokeAlpha: 0.95 },
    water: { fill: 0xEF4444, fillAlpha: 0.42, stroke: 0xF87171, strokeAlpha: 1.0 },
    bounds: { fill: 0x94A3B8, fillAlpha: 0.22, stroke: 0xCBD5E1, strokeAlpha: 0.85 }
  };

  class TrajectoryRenderer {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   predictor     TrajectoryPredictor 实例
     *   aimController AimController 实例（用于判断是否处于瞄准中）
     *   radiusPx      落点预警圈半径（像素）；也可后续用 setRadiusPx 更新
     *   isMoveActive  第 8.6 步：() => boolean，道具栏第 4 格「移动」是否被选中。
     *                 选中移动时投掷轨迹**一律擦除**（否则会和移动的蓝色弧线同时出现）。
     */
    constructor(scene, opts) {
      opts = opts || {};
      this.scene = scene;
      this.predictor = opts.predictor || null;
      this.aimController = opts.aimController || null;
      /** 第 8.6 步：移动选择态的查询函数（道具栏是唯一真相源） */
      this.isMoveActive = (typeof opts.isMoveActive === 'function') ? opts.isMoveActive : null;
      this.depth = num(opts.depth, DEFAULT_DEPTH);

      /** 落点预警圈半径（像素） */
      this.radiusPx = num(opts.radiusPx, 0);
      /** 透明度系数（来自 gameConfig.AIM.trajectoryAlpha） */
      this.alpha = num(opts.alpha,
        (FK.Config && FK.Config.AIM) ? FK.Config.AIM.trajectoryAlpha : 0.55);

      this.lineGfx = scene.add.graphics().setDepth(this.depth);
      this.ringGfx = scene.add.graphics().setDepth(this.depth);
      if (typeof this.lineGfx.setSize === 'function') { this.lineGfx.setSize(8192, 8192); }
      if (typeof this.ringGfx.setSize === 'function') { this.ringGfx.setSize(8192, 8192); }

      /** 最近一次绘制的信息（调试 / 自检用） */
      this.lastDraw = {
        visible: false, pointCount: 0, totalPoints: 0, culled: 0,
        ringRadius: 0, ringColor: 'none', landing: null
      };

      /**
       * 第 7 步：可视区域（画布逻辑像素）。
       * 抛物线可以飞出上边界，绘制时把画布外的点跳过；
       * 留一点余量（margin）避免边缘点被突然截断的观感。
       */
      const canvas = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS : { width: 1600, height: 800 };
      this.viewport = Object.assign({
        left: 0, top: 0, right: canvas.width, bottom: canvas.height, margin: 24
      }, opts.viewport || {});
    }

    /* ---------------- 配置 ---------------- */

    /**
     * 设置落点预警圈半径（像素）
     * @param {number} px
     */
    setRadiusPx(px) {
      this.radiusPx = Math.max(0, num(px, 0));
      return this;
    }

    /**
     * 用「地图单位」设置预警圈半径（内部按 pxPerUnit 换算）
     * @param {number} units ItemConfig.radius
     * @param {number} pxPerUnit
     */
    setRadiusUnits(units, pxPerUnit) {
      const ppx = num(pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));
      return this.setRadiusPx(num(units, 0) * ppx);
    }

    /* ---------------- 每帧绘制 ---------------- */

    /** 每帧调用：根据当前瞄准状态绘制或擦除 */
    update() {
      const aiming = this.isAiming();
      const result = this.predictor ? this.predictor.getResult() : null;

      if (!aiming || !result || !result.points || result.points.length === 0) {
        this.clear();
        return;
      }
      this.syncViewport();
      this.drawTrajectory(result.points);
      if (this.ringGfx) { this.ringGfx.clear(); }

      this.lastDraw.visible = true;
      this.lastDraw.totalPoints = result.points.length;
      this.lastDraw.landing = result.landing;
    }

    /** 按镜头世界矩形裁剪（大地图滚动后不能再用 0～画布宽） */
    syncViewport() {
      const cam = this.scene && this.scene.cameras ? this.scene.cameras.main : null;
      const m = 80;
      if (cam && cam.worldView) {
        const r = cam.worldView;
        this.viewport.left = r.x;
        this.viewport.top = r.y;
        this.viewport.right = r.x + r.width;
        this.viewport.bottom = r.y + r.height;
        this.viewport.margin = m;
        return;
      }
      this.viewport.margin = m;
    }

    /** 世界坐标是否在镜头可视范围内（含余量） */
    isVisiblePoint(x, y) {
      const v = this.viewport;
      const m = num(v.margin, 0);
      return x >= (v.left - m) && x <= (v.right + m) && y >= (v.top - m) && y <= (v.bottom + m);
    }

    /**
     * 是否处于「投掷」瞄准中。
     *   第 8.6 步：道具栏第 4 格「移动」被选中时**恒为 false** ——
     *   投掷轨迹与移动弧线互斥，任何时刻画布上最多一条抛物线 + 一个落点圈。
     *   无 AimController 时只要预测器有结果就画（自检用）。
     */
    isAiming() {
      if (this.isMoveActive) {
        let moveOn = false;
        try { moveOn = !!this.isMoveActive(); } catch (e) { moveOn = false; }
        if (moveOn) { return false; }
      }
      if (this.aimController && typeof this.aimController.isAiming === 'function') {
        return this.aimController.isAiming();
      }
      return !!(this.predictor && this.predictor.hasResult && this.predictor.hasResult());
    }

    /**
     * 画轨迹点列（半透明白色，越远越淡越细）
     * 第 7 步：画布外的点直接跳过（预测仍然完整，只是不画看不见的部分）
     * @param {Array<{x:number,y:number}>} points
     */
    drawTrajectory(points) {
      const g = this.lineGfx;
      g.clear();

      const n = points.length;
      let drawn = 0;
      let culled = 0;
      let firstDrawn = null;

      for (let i = 0; i < n; i++) {
        const p = points[i];
        if (!this.isVisiblePoint(p.x, p.y)) { culled += 1; continue; }
        const a = STYLE.pointAlpha;
        g.fillStyle(STYLE.pointColor, a);
        g.fillCircle(p.x, p.y, STYLE.pointR);
        if (!firstDrawn) { firstDrawn = p; }
        drawn += 1;
      }

      // 起点小标记（起点通常在画布内；若起点也在画布外则跳过）
      if (firstDrawn) {
        g.fillStyle(0xFFFFFF, Math.min(1, this.alpha + 0.25));
        g.fillCircle(firstDrawn.x, firstDrawn.y, 2.5);
      }

      this.lastDraw.pointCount = drawn;
      this.lastDraw.culled = culled;
    }

    /**
     * 画落点预警圈（命中水面时变红）
     * @param {Object} result TrajectoryPredictor 的结果对象
     */
    drawLandingRing(result) {
      const g = this.ringGfx;
      g.clear();

      const land = result.landing;
      const radius = this.radiusPx;
      if (!land || radius <= 0) {
        this.lastDraw.ringRadius = 0;
        this.lastDraw.ringColor = 'none';
        return;
      }

      const style = this.pickRingStyle(result.hitType);

      // 第 7 步：落点若在画布外（例如高抛飞出水面上边界之后落在很远的地方），
      // 预警圈同样跳过绘制——预测数据仍然完整，只是不画看不见的圈。
      if (!this.isVisiblePoint(land.x, land.y)) {
        this.lastDraw.ringRadius = 0;
        this.lastDraw.ringColor = 'offscreen';
        return;
      }

      const pulse = 1 + 0.04 * Math.sin((this.scene.time ? this.scene.time.now : 0) / 140);
      const r = radius * (result.hitType === 'water' ? pulse : 1);

      // 实心半透明圆
      g.fillStyle(style.fill, style.fillAlpha);
      g.fillCircle(land.x, land.y, r);

      g.lineStyle(2.5, style.stroke, style.strokeAlpha);
      g.strokeCircle(land.x, land.y, r);

      g.lineStyle(1.5, style.stroke, style.strokeAlpha * 0.75);
      drawDashedCircle(g, land.x, land.y, r * 0.55, STYLE.dashSegs, STYLE.dashGap);

      const c = 8;
      g.lineStyle(2, style.stroke, style.strokeAlpha);
      g.beginPath();
      g.moveTo(land.x - c, land.y);
      g.lineTo(land.x + c, land.y);
      g.moveTo(land.x, land.y - c);
      g.lineTo(land.x, land.y + c);
      g.strokePath();

      this.lastDraw.ringRadius = r;
      this.lastDraw.ringColor = style.name;
    }

    /** 按命中类型选择配色 */
    pickRingStyle(hitType) {
      if (hitType === 'water') { return Object.assign({ name: 'water' }, RING_COLOR.water); }
      if (hitType === 'bounds') { return Object.assign({ name: 'bounds' }, RING_COLOR.bounds); }
      return Object.assign({ name: 'normal' }, RING_COLOR.normal);
    }

    /** 擦除全部绘制 */
    clear() {
      if (this.lineGfx) { this.lineGfx.clear(); }
      if (this.ringGfx) { this.ringGfx.clear(); }
      this.lastDraw.visible = false;
      this.lastDraw.pointCount = 0;
      this.lastDraw.totalPoints = 0;
      this.lastDraw.culled = 0;
      this.lastDraw.landing = null;
      this.lastDraw.ringRadius = 0;
      this.lastDraw.ringColor = 'none';
    }

    /** 当前是否在画（lastDraw 的快照） */
    getDrawInfo() {
      return {
        visible: this.lineGfx ? (this.lastDraw.pointCount > 0) : false,
        pointCount: this.lastDraw.pointCount,
        totalPoints: this.lastDraw.totalPoints,
        culled: this.lastDraw.culled,
        ringRadius: this.lastDraw.ringRadius,
        ringColor: this.lastDraw.ringColor,
        landing: this.lastDraw.landing
      };
    }

    /** 销毁图形对象 */
    destroy() {
      if (this.lineGfx) { this.lineGfx.destroy(); this.lineGfx = null; }
      if (this.ringGfx) { this.ringGfx.destroy(); this.ringGfx = null; }
      this.predictor = null;
      this.aimController = null;
    }
  }

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
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

  TrajectoryRenderer.RING_COLOR = RING_COLOR;

  FK.TrajectoryRenderer = TrajectoryRenderer;
})();
