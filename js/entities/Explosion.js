/**
 * ============================================================
 * Explosion.js —— 爆炸演出实体（第 6 步新增）
 * ============================================================
 * 职责：
 *   纯表现层：在爆心画一个半透明橙色圆，
 *   从 0 放大到爆炸半径（ItemConfig.radius × pxPerUnit），
 *   在 explodeAnimMs 内淡出，然后自毁。
 *
 * 关键约定（模块化的核心）：
 *   · **本实体不做任何伤害计算**。伤害与击退统一由 FK.DamageSystem 结算，
 *     道具模块在 onExplode 里创建 Explosion，同时调用 DamageSystem。
 *   · 因此替换爆炸特效（几何圆 → 序列帧 → 粒子）不需要改一行伤害逻辑。
 *
 * 时间模型：
 *   不使用 setTimeout / Phaser Tween，而是由 ProjectileController 每帧
 *   调用 update(deltaMs) 推进，这样：
 *     ① 场景暂停 / 切后台时不会“偷偷炸完”；
 *     ② Node 自检可以精确控制时间轴，验证「300ms 后消失」。
 *
 * 依赖：Phaser（可缺省）、FK.Config、FK.EVENTS、FK.EventBus
 * 对外：FK.Explosion
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 爆炸配色与层数（集中，方便调） */
  const COLOR = {
    fill: 0xF97316,
    fillCore: 0xFDE047,
    stroke: 0xFB923C,
    ring: 0xFDBA74,
    core: 0xFFFFFF,
    mid: 0xF97316,
    outer: 0xDC2626,
    ray: 0xFDE047,
    fragment: 0x16A34A
  };
  const STYLE = {
    coreK: 0.32,
    midK: 0.68,
    rayCount: 6,
    fragCount: 6,
    cherryStroke: 3,
    melonStroke: 5
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  /** 宿主基类：有 Phaser 用 Container，没有则退化（与 UnitBase / Projectile 一致） */
  const BaseClass = (typeof Phaser !== 'undefined' && Phaser &&
    Phaser.GameObjects && Phaser.GameObjects.Container)
    ? Phaser.GameObjects.Container
    : class FallbackContainer {
      constructor(scene, x, y) {
        this.scene = scene || null;
        this.x = x || 0;
        this.y = y || 0;
        this.active = true;
      }
      setPosition(x, y) { this.x = x; this.y = y; return this; }
      setDepth() { return this; }
      setAlpha() { return this; }
      setVisible() { return this; }
      setScale() { return this; }
      add() { return this; }
      destroy() { this.active = false; }
    };

  class Explosion extends BaseClass {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   id            爆炸序号（日志用）
     *   itemId        来源道具 id
     *   x, y          爆心世界坐标（px）
     *   radiusPx      爆炸半径（px）= ItemConfig.radius × pxPerUnit
     *   radiusUnits   爆炸半径（地图单位，仅记录便于调试）
     *   durationMs    演出时长（毫秒）= ItemConfig.explodeAnimMs
     *   damage        中心伤害（仅记录，用于 HUD / 自检，不在本类结算）
     *   knockback     击退力度（仅记录）
     *   depth         渲染深度
     */
    constructor(scene, opts) {
      const o = opts || {};
      super(scene, num(o.x, 0), num(o.y, 0));
      const P = (FK.Config && FK.Config.PROJECTILE) ? FK.Config.PROJECTILE : {};

      this.explosionId = num(o.id, 0);
      this.itemId = o.itemId || '';
      this.center = { x: num(o.x, 0), y: num(o.y, 0) };
      this.radiusPx = Math.max(1, num(o.radiusPx, 1));
      this.radiusUnits = num(o.radiusUnits, 0);
      this.durationMs = Math.max(1, num(o.durationMs, 300));
      this.damage = num(o.damage, 0);
      this.knockback = num(o.knockback, 0);
      this.depth = num(o.depth, num(P.explosionDepth, 22));

      /** 已播放时长（毫秒） */
      this.elapsedMs = 0;
      /** 是否已结束（结束即等待 destroy） */
      this.finished = false;
      this.destroyed = false;
      /** 演出进度 0～1 的快照（HUD / 自检用） */
      this.progress = 0;

      this.gfx = null;
      this.built = false;
    }

    /* ==================================================================
     * 生命周期
     * ================================================================== */

    /**
     * 构建视觉（幂等）。没有渲染管线时跳过，只保留时间逻辑。
     * @returns {Explosion} this
     */
    create() {
      if (this.built) { return this; }

      const scene = this.scene;
      const canDraw = !!(scene && scene.add && typeof scene.add.graphics === 'function');

      this.setPosition(this.center.x, this.center.y);
      if (typeof this.setDepth === 'function') { this.setDepth(this.depth); }

      if (canDraw) {
        this.gfx = scene.add.graphics();
        // 由 update() 每帧重绘（半径随时间放大），这里先画一帧
        this.drawCircle(0);
        if (typeof this.add === 'function') { this.add(this.gfx); }
      }

      this.built = true;
      return this;
    }

    /**
     * 每帧推进演出
     * @param {number} deltaMs 距上一帧毫秒数
     * @returns {boolean} 是否已结束
     */
    update(deltaMs) {
      if (this.destroyed) { return true; }
      if (this.finished) { return true; }

      this.elapsedMs += Math.max(0, num(deltaMs, 0));
      const k = Math.min(1, this.elapsedMs / this.durationMs);
      this.progress = k;

      // 半径：0 → radiusPx（缓出，前段扩得快，符合爆炸手感）
      const eased = 1 - Math.pow(1 - k, 2);
      const r = this.radiusPx * eased;

      this.drawCircle(r);

      if (typeof this.setAlpha === 'function') {
        // 后 40% 开始淡出，收尾不留残影
        this.alpha = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
        this.setAlpha(this.alpha);
      }

      if (k >= 1) {
        this.finished = true;
        return true;
      }
      return false;
    }

    /**
     * 重绘爆炸圆（半径随时间变化）
     * @param {number} r 当前半径（px）
     */
    drawCircle(r) {
      if (!this.gfx) { return; }
      const g = this.gfx;
      g.clear();

      const melon = this.itemId === 'watermelon_bomb';
      const k = this.progress;
      const fade = k < 0.55 ? 1 : Math.max(0, 1 - (k - 0.55) / 0.45);

      g.fillStyle(COLOR.outer, 0.38 * fade);
      g.fillCircle(0, 0, r);
      g.fillStyle(COLOR.mid, 0.5 * fade);
      g.fillCircle(0, 0, r * STYLE.midK);
      g.fillStyle(COLOR.core, 0.72 * fade);
      g.fillCircle(0, 0, r * STYLE.coreK);
      g.fillStyle(COLOR.fillCore, 0.45 * fade);
      g.fillCircle(0, 0, r * STYLE.coreK * 0.55);

      const strokeW = melon ? STYLE.melonStroke : STYLE.cherryStroke;
      g.lineStyle(strokeW, COLOR.stroke, 0.9 * fade);
      g.strokeCircle(0, 0, r);
      g.lineStyle(melon ? 4 : 2, COLOR.ring, 0.5 * fade);
      g.strokeCircle(0, 0, r * 0.82);

      g.lineStyle(2, COLOR.ray, 0.85 * fade);
      const rays = STYLE.rayCount;
      for (let i = 0; i < rays; i++) {
        const a = (Math.PI * 2 * i) / rays + 0.2;
        const inner = r * 0.18;
        const outer = r * (melon ? 1.12 : 1.02);
        g.beginPath();
        g.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        g.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        g.strokePath();
      }

      if (melon) {
        g.fillStyle(COLOR.fragment, 0.9 * fade);
        for (let i = 0; i < STYLE.fragCount; i++) {
          const a = (Math.PI * 2 * i) / STYLE.fragCount + 0.4;
          const d = r * (0.55 + 0.45 * k);
          g.fillCircle(Math.cos(a) * d, Math.sin(a) * d, 3.2);
        }
      }
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /** 爆心世界坐标 */
    getCenter() { return { x: this.center.x, y: this.center.y }; }

    /** 爆炸半径（px） */
    getRadiusPx() { return this.radiusPx; }

    /** 演出进度 0～1 */
    getProgress() { return this.progress; }

    /** 是否已播放完毕 */
    isFinished() { return this.finished; }

    /** 是否已销毁 */
    isDestroyed() { return this.destroyed; }

    /** 状态摘要 */
    describe() {
      return 'Explosion#' + this.explosionId + '(' + this.itemId + ', r=' + Math.round(this.radiusPx) +
        'px, ' + Math.round(this.elapsedMs) + '/' + this.durationMs + 'ms)';
    }

    /* ==================================================================
     * 销毁
     * ================================================================== */

    /**
     * 销毁图形对象（无残留，满足「爆炸演出结束后对象数回到基线」）
     * @param {boolean} [fromScene]
     */
    destroy(fromScene) {
      if (this.destroyed) { return; }
      this.destroyed = true;
      this.finished = true;
      this.gfx = null;
      if (typeof super.destroy === 'function') { super.destroy(fromScene); }
    }
  }

  Explosion.COLOR = Object.freeze(COLOR);

  FK.Explosion = Explosion;
})();
