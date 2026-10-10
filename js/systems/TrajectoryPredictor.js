/**
 * ============================================================
 * TrajectoryPredictor.js —— 抛物线预测系统
 * ============================================================
 * 职责：
 *   给定起点、初速度、重力与地形，算出整条抛物线轨迹、
 *   落点、命中类型（平台 / 水面 / 边界 / 超时）。
 *   **纯 JS，不依赖 Phaser**，可在 Node 中直接单元测试。
 *
 * 物理：
 *   斜抛运动方程（integration = 'analytic'，默认，精确解）
 *       x(t) = x0 + vx * t
 *       y(t) = y0 + vy * t + 0.5 * g * t²
 *   或半隐式欧拉（integration = 'euler'，贴近 Arcade 逐帧积分）
 *       vy += g * dt;  x += vx * dt;  y += vy * dt
 *   坐标约定：世界像素，y 轴向下为正，重力 g 为正数。
 *
 * 碰撞：
 *   逐段（上一点 → 当前点）做检测，取最先命中的那一个：
 *     · 平台：线段与 AABB 的求交，命中点即预警圈位置（自然停在平台表面）
 *     · 水面：y 跨过 waterLevel
 *     · 边界：x 越出左右；**顶部默认忽略**（第 7 步起允许飞出画面上方，
 *             见 segmentBoundsHit 的 ignoreTop，弹道会一直算到落回或超时）
 *
 * 障碍物（第 7 步）：
 *   水果箱生成的静态方块与地形平台**走同一条碰撞路径**——
 *   ObstacleRegistry 把方块的 AABB 追加到 world.platforms 里，
 *   因此预测与实飞都不需要为障碍物写第二份碰撞代码。
 *
 * 依赖：无
 * 对外：FK.TrajectoryPredictor
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const EPS = 1e-9;

  /* ==================================================================
   * 第 6 步新增：可复用的积分与碰撞原语
   *   投掷物实飞（Projectile）直接调用这里的函数，保证
   *   「预测」与「实飞」永远只有一份物理代码，不会随迭代漂移。
   * ================================================================== */

  /**
   * 单步积分（与 predict() 内部完全同源）
   * @param {number} t 累计时间（秒）；analytic 模式用它求精确解
   * @param {Object} s { x, y, vx, vy, g } 状态（像素 / 像素每秒）
   * @param {number} dt 步长（秒）
   * @param {boolean} analytic true = 斜抛运动方程，false = 半隐式欧拉
   * @returns {{x:number,y:number,vy:number}} 新位置与新的垂直速度
   */
  function stepIntegrate(t, s, dt, analytic) {
    if (analytic) {
      return {
        x: s.x + s.vx * dt,
        y: s.y + s.vy * dt + 0.5 * s.g * dt * dt,
        vy: s.vy + s.g * dt
      };
    }
    const vy = s.vy + s.g * dt;
    return { x: s.x + s.vx * dt, y: s.y + vy * dt, vy: vy };
  }

  /**
   * 线性插值取线段上的点
   * @param {{x:number,y:number}} a 起点
   * @param {{x:number,y:number}} b 终点
   * @param {number} t 参数 0～1
   */
  function pointOnSegment(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /**
   * 取「最先命中」的地形事件（平台 / 水面 / 边界）
   * 顺序与 predict() 内部一致：平台 → 水面 → 边界，按 t 取最小者。
   * @param {{x:number,y:number}} from 上一点
   * @param {{x:number,y:number}} to 当前点
   * @param {Object} world { platforms, waterLevel, bounds }
   * @returns {{t:number,x:number,y:number,type:string,target:Object|null}|null}
   */
  function resolveSegmentHit(from, to, world) {
    const w = world || {};
    const platforms = w.platforms || [];
    const waterLevel = (w.waterLevel === undefined) ? null : w.waterLevel;
    const bounds = w.bounds || null;

    let best = null;

    for (let i = 0; i < platforms.length; i++) {
      const r = platforms[i];
      const seg = segmentRectHit(from.x, from.y, to.x, to.y, r);
      if (seg && (!best || seg.t < best.t)) {
        best = { t: seg.t, x: seg.x, y: seg.y, type: 'platform', target: r };
      }
    }

    const wh = segmentWaterHit(from.x, from.y, to.x, to.y, waterLevel);
    if (wh && (!best || wh.t < best.t)) {
      best = { t: wh.t, x: wh.x, y: wh.y, type: 'water', target: null };
    }

    const bh = segmentBoundsHit(from.x, from.y, to.x, to.y, bounds);
    if (bh && (!best || bh.t < best.t)) {
      best = { t: bh.t, x: bh.x, y: bh.y, type: 'bounds', target: null };
    }

    return best;
  }

  /** 水果箱等放置障碍（预览可忽略，实飞仍走完整碰撞） */
  function isObstacleRect(r) {
    if (!r) { return false; }
    if (r.material === 'crate' || r.kind === 'crate' || r.kind === 'obstacle') { return true; }
    const id = (r.id != null) ? String(r.id) : '';
    return id.indexOf('obstacle_') === 0;
  }

  /**
   * 线段与 AABB 求交（slab 法）
   * @returns {{t:number,x:number,y:number}|null} 命中参数 t ∈ [0,1] 与命中点
   */
  function segmentRectHit(x0, y0, x1, y1, rect) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const rx1 = rect.x;
    const rx2 = rect.x + rect.width;
    const ry1 = rect.y;
    const ry2 = rect.y + rect.height;

    let tmin = 0;
    let tmax = 1;

    if (Math.abs(dx) < EPS) {
      if (x0 < rx1 || x0 > rx2) { return null; }
    } else {
      let t1 = (rx1 - x0) / dx;
      let t2 = (rx2 - x0) / dx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; }
      if (t2 < tmax) { tmax = t2; }
      if (tmin > tmax) { return null; }
    }

    if (Math.abs(dy) < EPS) {
      if (y0 < ry1 || y0 > ry2) { return null; }
    } else {
      let t1 = (ry1 - y0) / dy;
      let t2 = (ry2 - y0) / dy;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; }
      if (t2 < tmax) { tmax = t2; }
      if (tmin > tmax) { return null; }
    }

    if (tmax < 0 || tmin > 1) { return null; }

    const t = Math.min(1, Math.max(0, tmin));
    return { t: t, x: x0 + dx * t, y: y0 + dy * t };
  }

  /** 线段与水平液面求交（y 跨过 waterY 且方向向下） */
  function segmentWaterHit(x0, y0, x1, y1, waterY) {
    if (waterY === null || waterY === undefined) { return null; }
    if (y0 >= waterY) { return { t: 0, x: x0, y: waterY }; }
    if (y1 >= waterY && y1 > y0) {
      const t = (waterY - y0) / (y1 - y0);
      return { t: t, x: x0 + (x1 - x0) * t, y: waterY };
    }
    return null;
  }

  /**
   * 线段越出竞技场边界的最早 t
   *
   * 第 7 步变更：抛物线允许**越过屏幕上边界**（y 跑到 bounds.top 之上）。
   *   bounds.ignoreTop === true 时，不再把「向上越出 top」算作碰撞，
   *   于是高抛弹道会继续积分（预测图上表现为点列延伸到画布外，
   *   渲染器只画可见部分），直到：
   *     · 落回有效区域并命中平台 / 水面，或
   *     · 越出左右边界，或
   *     · 走满 maxSteps（4 秒）→ timeout。
   * @param {number} x0 上一点 X
   * @param {number} y0 上一点 Y
   * @param {number} x1 当前点 X
   * @param {number} y1 当前点 Y
   * @param {Object} bounds { left, right, top, ignoreTop? }
   */
  function segmentBoundsHit(x0, y0, x1, y1, bounds) {
    if (!bounds) { return null; }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const cands = [];

    if (bounds.left !== undefined && x1 < bounds.left && dx < 0) {
      cands.push((bounds.left - x0) / dx);
    }
    if (bounds.right !== undefined && x1 > bounds.right && dx > 0) {
      cands.push((bounds.right - x0) / dx);
    }
    // 顶部边界：默认忽略（第 7 步起允许飞出画面上方）
    if (!bounds.ignoreTop && bounds.top !== undefined && y1 < bounds.top && dy < 0) {
      cands.push((bounds.top - y0) / dy);
    }
    if (cands.length === 0) { return null; }

    let t = Infinity;
    for (let i = 0; i < cands.length; i++) {
      if (cands[i] >= 0 && cands[i] <= 1 && cands[i] < t) { t = cands[i]; }
    }
    if (!isFinite(t)) { return null; }
    return { t: t, x: x0 + dx * t, y: y0 + dy * t };
  }

  class TrajectoryPredictor {

    /**
     * @param {Object} [config]
     *   gravityY    重力加速度（px/s²，正数）
     *   stepSec     积分步长（秒）
     *   maxSteps    最大步数
     *   sampleEvery 渲染点抽稀步长
     *   integration 'analytic' | 'euler'
     *   platforms   平台矩形数组 [{ id, x, y, width, height }]（世界像素，左上角）
     *   waterLevel  液面世界像素 Y（可为 null）
     *   bounds      竞技场边界 { left, right, top, ignoreTop? }（世界像素，可为 null）
     *               ignoreTop = true（第 7 步默认）时顶部不截断弹道
     */
    constructor(config) {
      const c = config || {};
      this.gravityY = num(c.gravityY, 1500);
      this.stepSec = num(c.stepSec, 1 / 60);
      this.maxSteps = Math.max(1, Math.round(num(c.maxSteps, 240)));
      this.sampleEvery = Math.max(1, Math.round(num(c.sampleEvery, 3)));
      this.integration = (c.integration === 'euler') ? 'euler' : 'analytic';

      this.platforms = Array.isArray(c.platforms) ? c.platforms.slice() : [];
      this.waterLevel = (typeof c.waterLevel === 'number') ? c.waterLevel : null;
      this.bounds = c.bounds || null;

      this._resetResult();
    }

    /* ---------------- 世界数据（BattleScene 从 MapConfig 注入） ---------------- */

    /**
     * 更新地形与水面（换地图 / 重开对局时调用）
     * @param {Object} opts { platforms, waterLevel, bounds }
     */
    setWorld(opts) {
      opts = opts || {};
      if (opts.platforms) { this.platforms = opts.platforms.slice(); }
      if (Object.prototype.hasOwnProperty.call(opts, 'waterLevel')) { this.waterLevel = opts.waterLevel; }
      if (Object.prototype.hasOwnProperty.call(opts, 'bounds')) { this.bounds = opts.bounds; }
      return this;
    }

    /** 更新物理参数（重力 / 步长等） */
    setPhysics(opts) {
      opts = opts || {};
      if (typeof opts.gravityY === 'number') { this.gravityY = opts.gravityY; }
      if (typeof opts.stepSec === 'number') { this.stepSec = opts.stepSec; }
      if (typeof opts.maxSteps === 'number') { this.maxSteps = Math.max(1, Math.round(opts.maxSteps)); }
      if (typeof opts.sampleEvery === 'number') { this.sampleEvery = Math.max(1, Math.round(opts.sampleEvery)); }
      if (typeof opts.integration === 'string') {
        this.integration = (opts.integration === 'euler') ? 'euler' : 'analytic';
      }
      return this;
    }

    /* ---------------- 核心计算 ---------------- */

    /**
     * 计算抛物线轨迹
     * @param {number} startX 起点世界 X（px）
     * @param {number} startY 起点世界 Y（px）
     * @param {number} vx 初速度 X（px/s）
     * @param {number} vy 初速度 Y（px/s，向上为负）
     * @param {Object} [opts] { platforms, waterLevel, bounds, maxSteps } 覆盖默认值
     * @returns {Object} 计算结果
     */
    predict(startX, startY, vx, vy, opts) {
      opts = opts || {};

      const x0 = num(startX, 0);
      const y0 = num(startY, 0);
      const vx0 = num(vx, 0);
      const vy0 = num(vy, 0);
      const g = this.gravityY;
      const dt = this.stepSec;
      const maxSteps = opts.maxSteps ? Math.max(1, Math.round(opts.maxSteps)) : this.maxSteps;
      let platforms = opts.platforms || this.platforms;
      if (opts.ignoreObstacles) {
        platforms = (platforms || []).filter(function (r) { return !isObstacleRect(r); });
      }
      const waterLevel = (Object.prototype.hasOwnProperty.call(opts, 'waterLevel'))
        ? opts.waterLevel : this.waterLevel;
      const bounds = (Object.prototype.hasOwnProperty.call(opts, 'bounds')) ? opts.bounds : this.bounds;
      const analytic = this.integration !== 'euler';

      const all = [{ x: x0, y: y0 }];

      let px = x0;
      let py = y0;
      let vyCur = vy0;
      let hit = null;         // { t, x, y, type, target }
      let apexY = y0;
      let steps = 0;

      for (let step = 1; step <= maxSteps; step++) {
        // ---- 积分：与 Projectile.step() 共用同一套公式（stepIntegrate） ----
        let nx, ny;
        if (analytic) {
          const t = step * dt;
          nx = x0 + vx0 * t;
          ny = y0 + vy0 * t + 0.5 * g * t * t;
        } else {
          const adv = stepIntegrate(0, { x: px, y: py, vx: vx0, vy: vyCur, g: g }, dt, false);
          vyCur = adv.vy;
          nx = adv.x;
          ny = adv.y;
        }

        // ---- 逐段检测：平台 / 水面 / 边界，取最先命中 ----
        const best = resolveSegmentHit({ x: px, y: py }, { x: nx, y: ny },
          { platforms: platforms, waterLevel: waterLevel, bounds: bounds });

        px = nx;
        py = ny;
        if (py < apexY) { apexY = py; }
        all.push({ x: px, y: py });
        steps = step;

        if (best) {
          hit = best;
          all[all.length - 1] = { x: best.x, y: best.y };
          px = best.x;
          py = best.y;
          break;
        }
      }

      // ---- 抽稀成渲染点（保证最后一点是落点） ----
      const display = [];
      for (let i = 0; i < all.length; i += this.sampleEvery) {
        display.push(all[i]);
      }
      const lastPoint = all[all.length - 1];
      const displayLast = display[display.length - 1];
      if (!displayLast || displayLast.x !== lastPoint.x || displayLast.y !== lastPoint.y) {
        display.push(lastPoint);
      }

      const landing = hit
        ? { x: round2(hit.x), y: round2(hit.y) }
        : { x: round2(px), y: round2(py) };

      this._result = {
        points: display,
        allPoints: all,
        landing: landing,
        hitType: hit ? hit.type : 'timeout',
        hitTarget: hit && hit.target ? { id: hit.target.id, x: hit.target.x, y: hit.target.y, width: hit.target.width, height: hit.target.height } : null,
        hitObstacle: !!(hit && hit.type === 'platform'),
        flightTimeMs: Math.round(steps * dt * 1000),
        apexY: round2(apexY),
        start: { x: x0, y: y0 },
        velocity: { vx: vx0, vy: vy0 }
      };

      return this._result;
    }

    /* ---------------- 结果查询 ---------------- */

    /* ==================================================================
     * 第 6 步新增：供投掷物实飞复用的逐帧接口
     *   目的：预测与实飞共用同一份积分 + 碰撞代码，
     *         从机制上杜绝「预测准、实飞偏」的漂移。
     * ================================================================== */

    /**
     * 单步推进一个投掷物状态（不修改传入对象，返回新对象）
     * @param {Object} state { x, y, vx, vy, g } 当前状态（像素 / 像素每秒）
     * @param {number} dt 步长（秒）
     * @param {number} [t] 累计时间（秒，analytic 模式不需要，保留参数便于扩展）
     * @returns {{x:number,y:number,vy:number}} 新位置与新的垂直速度（vx 恒定）
     */
    stepProjectile(state, dt, t) {
      const s = state || {};
      const g = (typeof s.g === 'number') ? s.g : this.gravityY;
      const step = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : this.stepSec;
      return stepIntegrate(t || 0, {
        x: num(s.x, 0), y: num(s.y, 0),
        vx: num(s.vx, 0), vy: num(s.vy, 0),
        g: g
      }, step, this.integration !== 'euler');
    }

    /**
     * 检测一小段位移上的最早碰撞
     * @param {{x:number,y:number}} from
     * @param {{x:number,y:number}} to
     * @param {Object} [opts] { platforms, waterLevel, bounds } 缺省用构造时的世界数据
     * @returns {{t:number,x:number,y:number,type:'platform'|'water'|'bounds',target:Object|null}|null}
     */
    resolveCollision(from, to, opts) {
      opts = opts || {};
      const world = {
        platforms: opts.platforms || this.platforms,
        waterLevel: Object.prototype.hasOwnProperty.call(opts, 'waterLevel') ? opts.waterLevel : this.waterLevel,
        bounds: Object.prototype.hasOwnProperty.call(opts, 'bounds') ? opts.bounds : this.bounds
      };
      return resolveSegmentHit(from || { x: 0, y: 0 }, to || { x: 0, y: 0 }, world);
    }

    /**
     * 导出一份世界数据的浅拷贝（供投掷物 / 后续系统复用同一份地形与水面）
     * @returns {{platforms:Array, waterLevel:(number|null), bounds:(Object|null)}}
     */
    getWorld() {
      return {
        platforms: this.platforms.slice(),
        waterLevel: this.waterLevel,
        bounds: this.bounds
      };
    }

    /** 从预测结果中截取「前 n 步」的点列（自检用：比对前 n 步实飞与预测是否重合） */
    slicePoints(n) {
      const all = this._result.allPoints || [];
      return all.slice(0, Math.max(0, Math.round(num(n, 0))));
    }

    /** 把当前积分模式转成布尔（true = analytic） */
    isAnalytic() { return this.integration !== 'euler'; }

    /** 轨迹渲染点数组 [{x,y}, ...] */
    getPoints() { return this._result.points; }

    /** 全部积分点（物理用） */
    getAllPoints() { return this._result.allPoints; }

    /** 落点 { x, y } */
    getLandingPoint() { return this._result.landing; }

    /** 是否命中障碍物（平台） */
    getHitObstacle() { return this._result.hitObstacle; }

    /** 命中类型：'platform' | 'water' | 'bounds' | 'timeout' */
    getHitType() { return this._result.hitType; }

    /** 命中的平台信息（未命中平台时为 null） */
    getHitTarget() { return this._result.hitTarget; }

    /** 完整结果对象 */
    getResult() { return this._result; }

    /** 是否有可用结果 */
    hasResult() { return this._result.points.length > 0; }

    /** 清空结果（结束瞄准时调用） */
    reset() {
      this._resetResult();
      return this;
    }

    _resetResult() {
      this._result = {
        points: [],
        allPoints: [],
        landing: { x: 0, y: 0 },
        hitType: 'none',
        hitTarget: null,
        hitObstacle: false,
        flightTimeMs: 0,
        apexY: 0,
        start: { x: 0, y: 0 },
        velocity: { vx: 0, vy: 0 }
      };
    }
  }

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  /** 暴露线段求交工具，供自检与后续步骤复用 */
  TrajectoryPredictor.segmentRectHit = segmentRectHit;
  TrajectoryPredictor.segmentWaterHit = segmentWaterHit;
  TrajectoryPredictor.segmentBoundsHit = segmentBoundsHit;
  /* 第 6 步：投掷物实飞复用这三个原语（静态调用，不需要实例） */
  TrajectoryPredictor.stepIntegrate = stepIntegrate;
  TrajectoryPredictor.pointOnSegment = pointOnSegment;
  TrajectoryPredictor.resolveSegmentHit = resolveSegmentHit;
  TrajectoryPredictor.isObstacleRect = isObstacleRect;
  /** 默认物理参数（与 gameConfig 一致，便于纯 JS 自检直接构造状态） */
  TrajectoryPredictor.DEFAULTS = Object.freeze({
    gravityY: 1500,
    stepSec: 1 / 60,
    maxSteps: 240,
    integration: 'analytic'
  });

  FK.TrajectoryPredictor = TrajectoryPredictor;
})();
