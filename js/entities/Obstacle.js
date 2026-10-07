/**
 * ============================================================
 * Obstacle.js —— 静态障碍物实体（第 7 步新增）
 * ============================================================
 * 职责：
 *   承载「水果箱落地变成的木箱」这一实体：
 *     · 自己的世界坐标与 AABB（参与后续投掷物碰撞）
 *     · 剩余回合数（持续 duration 回合后自动消失）
 *     · 视觉表现（棕木箱 + 果箱条纹 + 顶面高光，纯程序化绘制）
 *
 * 与碰撞的关系（本步最重要的设计决定）：
 *   障碍物**不自己写一套碰撞**。
 *   `getRect()` 返回的 AABB 会被 FK.ObstacleRegistry 追加进
 *   TrajectoryPredictor 的 world.platforms 里——于是
 *   「预测轨迹」与「投掷物实飞」自动都认得这个箱子，
 *   一行新的碰撞代码都不需要写。
 *
 * 与 Phaser 的关系：
 *   正常环境用 scene.add.graphics() 画方块；没有渲染管线（Node 自检）时
 *   只保留逻辑，物理与回合倒计时依然完整可测。
 *
 * 依赖：Phaser（可缺省）、FK.Config
 * 对外：FK.Obstacle
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 木箱配色与尺寸（集中，方便调） */
  const COLOR = {
    fill: 0x92400E,
    fillLight: 0xD97706,
    edge: 0x431407,
    slat: 0x78350F,
    fruit: 0xEF4444,
    fruitAlt: 0x22C55E,
    nail: 0x1C1917
  };
  const STYLE = {
    topH: 0.2,
    nailR: 0.06,
    nailInset: 0.12
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class Obstacle {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   id             障碍物 id（自增序号，日志与事件用）
     *   itemId         来源道具 id（如 'fruit_crate'）
     *   team           放置方阵营
     *   ownerId        放置者单位 id
     *   x, y           障碍物**中心**世界坐标（px）
     *   sizeUnits      边长（地图单位 u），来自 ItemConfig.crateSizeUnits
     *   duration       持续回合数，来自 ItemConfig.duration
     *   turnNumber     放置时的回合号（该回合结束时不扣减，见 tickTurn）
     *   pxPerUnit      1 地图单位 = 多少像素
     *   depth          渲染深度
     */
    constructor(scene, opts) {
      const o = opts || {};
      const O = (FK.Config && FK.Config.OBSTACLE) ? FK.Config.OBSTACLE : {};
      const ppx = num(o.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));

      this.scene = scene || null;
      this.obstacleId = num(o.id, 0);
      this.itemId = o.itemId || '';
      this.team = o.team || '';
      this.ownerId = o.ownerId || '';

      this.sizeUnits = Math.max(0.1, num(o.sizeUnits, 1.5));
      this.sizePx = this.sizeUnits * ppx;
      this.center = { x: num(o.x, 0), y: num(o.y, 0) };

      /** 存活 turn 数（第 7.6 步：放置回合计入；每回合结束 -1，归零即消失） */
      this.duration = Math.max(1, Math.round(num(o.duration, 4)));
      this.remainingTurns = this.duration;
      /** 放置时的回合号（HUD / 自检用） */
      this.spawnTurn = num(o.turnNumber, 0);
      /** 最近一次扣减所属的回合号（调试用） */
      this.lastTickTurn = null;
      this.expired = false;

      this.depth = num(o.depth, num(O.depth, 8));
      this.cornerRadiusPx = num(o.cornerRadiusPx, num(O.cornerRadiusPx, 6));

      /** 视觉对象（create() 中构建） */
      this.gfx = null;
      this.built = false;
      this.spawnElapsedMs = 0;
      this.spawnAnimMs = num(o.spawnAnimMs, num(O.spawnAnimMs, 150));
    }

    /* ==================================================================
     * 生命周期
     * ================================================================== */

    /** 构建视觉（幂等；无渲染管线时只跳过绘制，逻辑不变） */
    create() {
      if (this.built) { return this; }
      const scene = this.scene;
      const canDraw = !!(scene && scene.add && typeof scene.add.graphics === 'function');

      if (canDraw) {
        this.gfx = scene.add.graphics();
        if (typeof this.gfx.setDepth === 'function') { this.gfx.setDepth(this.depth); }
        this.draw();
      }
      this.built = true;
      return this;
    }

    /** 绘制木箱（本步用程序化几何占位，正式素材替换时只换这一处） */
    draw() {
      if (!this.gfx) { return; }
      const g = this.gfx;
      const s = this.sizePx;
      const x = this.center.x - s / 2;
      const y = this.center.y - s / 2;
      const r = this.cornerRadiusPx;

      g.clear();

      g.fillStyle(COLOR.fill, 1);
      g.fillRoundedRect(x, y, s, s, r);
      g.fillStyle(COLOR.fillLight, 0.9);
      g.fillRoundedRect(x, y, s, Math.max(3, s * STYLE.topH), r);
      g.lineStyle(2, COLOR.slat, 0.85);
      g.beginPath();
      g.moveTo(x + s * 0.12, y + s * 0.28);
      g.lineTo(x + s * 0.88, y + s * 0.28);
      g.strokePath();
      g.beginPath();
      g.moveTo(x + s * 0.12, y + s * 0.62);
      g.lineTo(x + s * 0.88, y + s * 0.62);
      g.strokePath();
      g.beginPath();
      g.moveTo(x + s * 0.18, y + s * 0.18);
      g.lineTo(x + s * 0.82, y + s * 0.82);
      g.strokePath();
      const inset = s * STYLE.nailInset;
      const nr = Math.max(1.6, s * STYLE.nailR);
      g.fillStyle(COLOR.nail, 1);
      g.fillCircle(x + inset, y + inset, nr);
      g.fillCircle(x + s - inset, y + inset, nr);
      g.fillCircle(x + inset, y + s - inset, nr);
      g.fillCircle(x + s - inset, y + s - inset, nr);
      g.lineStyle(Math.max(1, s * 0.05), COLOR.edge, 1);
      g.strokeRoundedRect(x, y, s, s, r);
    }

    /** 生成动画推进（每帧由 ObstacleRegistry.update 调用；纯表现） */
    update(deltaMs) {
      if (this.expired || !this.gfx || this.spawnAnimMs <= 0) { return this; }
      if (this.spawnElapsedMs >= this.spawnAnimMs) { return this; }

      this.spawnElapsedMs += Math.max(0, num(deltaMs, 0));
      const k = Math.min(1, this.spawnElapsedMs / this.spawnAnimMs);
      // 从 0.6 放大到 1（轻微弹出感），不做旋转以免碰撞体与视觉不一致
      const scale = 0.6 + 0.4 * (1 - Math.pow(1 - k, 2));
      if (typeof this.gfx.setScale === 'function') { this.gfx.setScale(scale); }
      if (typeof this.gfx.setAlpha === 'function') { this.gfx.setAlpha(k < 1 ? 0.6 + 0.4 * k : 1); }
      return this;
    }

    destroy() {
      if (this.expired) { return this; }
      this.expired = true;
      if (this.gfx) {
        if (typeof this.gfx.destroy === 'function') { this.gfx.destroy(); }
        this.gfx = null;
      }
      this.built = false;
      return this;
    }

    /* ==================================================================
     * 回合倒计时
     * ================================================================== */

    /**
     * 回合结束：剩余回合数 -1
     *
     * 第 7.6 步口径（策划时间线）：**duration = 存活 turn 数，放置回合也计入**。
     *   例：蓝方 Turn 1 放置（duration = 4）→ 木箱在 Turn 1/2/3/4 都存在，
     *   Turn 4 结束时归零被移除 → Turn 5 蓝方开始时已经消失。
     *   因此这里对**每一次** turn:end 都扣减，不做「出生回合免计」。
     *
     * @param {number} [turnNumber] 本次 turn:end 所属回合号（仅日志用，不参与判定）
     * @returns {boolean} 是否已到期（true = 需要被移除）
     */
    tickTurn(turnNumber) {
      this.lastTickTurn = num(turnNumber, this.lastTickTurn);
      this.remainingTurns -= 1;
      return this.remainingTurns <= 0;
    }

    /** 出生回合号（自检 / HUD 用） */
    getSpawnTurn() { return this.spawnTurn; }

    /* ==================================================================
     * 碰撞与查询
     * ================================================================== */

    /**
     * 世界像素 AABB（左上角 + 宽高）——与 MapConfig 平台的矩形格式完全一致，
     * 因此可以直接塞进 TrajectoryPredictor 的 platforms 数组复用碰撞。
     * @returns {{id:string,x:number,y:number,width:number,height:number,material:string}}
     */
    getRect() {
      return {
        id: 'obstacle_' + this.obstacleId,
        x: this.center.x - this.sizePx / 2,
        y: this.center.y - this.sizePx / 2,
        width: this.sizePx,
        height: this.sizePx,
        material: 'crate'
      };
    }

    /** 中心世界坐标 */
    getCenter() { return { x: this.center.x, y: this.center.y }; }

    /** 边长（px） */
    getSizePx() { return this.sizePx; }

    /** 剩余回合数 */
    getRemainingTurns() { return this.remainingTurns; }

    /** 是否已消失 */
    isExpired() { return this.expired; }

    /** 状态摘要（日志 / 调试） */
    describe() {
      return 'Obstacle#' + this.obstacleId + '(' + this.itemId + ', ' + this.sizeUnits + 'u @' +
        Math.round(this.center.x) + ',' + Math.round(this.center.y) +
        ', 剩余 ' + this.remainingTurns + '/' + this.duration + ' 回合)';
    }
  }

  Obstacle.COLOR = Object.freeze(COLOR);

  FK.Obstacle = Obstacle;
})();
