/**
 * ============================================================
 * Projectile.js —— 投掷物实体（第 6 步新增）
 * ============================================================
 * 职责：
 *   承载「飞行中的道具」这一实体：自己的位置 / 速度 / 自旋 / 引线视觉，
 *   以及逐帧的物理推进与碰撞检测。
 *
 * 物理一致性（本步最重要的约束）：
 *   投掷物**不自己写一份积分**，而是复用
 *     · FK.TrajectoryPredictor.stepIntegrate()    单步积分
 *     · FK.TrajectoryPredictor.resolveSegmentHit() 地形/水面/边界碰撞
 *   由 ProjectileController 把 TrajectoryPredictor 实例注入进来，
 *   因此「预测轨迹」与「实飞轨迹」永远是同一份代码，不会随迭代漂移。
 *
 * 与 Phaser 的关系：
 *   正常环境下继承 Phaser.GameObjects.Container（红色圆身 + 引线，
 *   飞行中整体旋转）；在没有 Phaser 的环境（Node 自检）下退化为空基类，
 *   保证脚本可加载、物理逻辑可被完整单测。
 *
 * 本步刻意不做：
 *   · 不做单位碰撞（单位是静态体，碰撞由 DamageSystem 在爆炸时按距离结算）
 *   · 不做落水即死（第 8 步）、不做死亡判定（第 8 步）、不做连锁爆炸
 *
 * 依赖：Phaser（可缺省）、FK.Config、FK.EVENTS、FK.EventBus
 * 对外：FK.Projectile
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 投掷物配色与尺寸（集中，方便调） */
  const COLOR = {
    body: 0xDC2626,
    bodyDark: 0x7F1D1D,
    highlight: 0xFCA5A5,
    fuse: 0x78350F,
    spark: 0xFDE047,
    stem: 0x166534,
    leaf: 0x22C55E,
    melon: 0x16A34A,
    melonDark: 0x14532D,
    melonStripe: 0x166534,
    crate: 0xB45309,
    crateDark: 0x78350F,
    crateGrain: 0x92400E,
    crateHi: 0xD97706,
    banana: 0xFACC15,
    bananaDark: 0xCA8A04,
    bananaTip: 0x78350F
  };
  const STYLE = {
    sparkAlphaMin: 0.6,
    sparkAlphaMax: 1.0,
    fuseLenK: 2.1,
    sparkR: 0.22
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function bounceOffHit(hit, vx, vy, rest) {
    let nx = 0;
    let ny = -1;
    const r = hit && hit.target;
    if (r && typeof r.x === 'number') {
      const dl = Math.abs(hit.x - r.x);
      const dr = Math.abs(hit.x - (r.x + r.width));
      const dt = Math.abs(hit.y - r.y);
      const db = Math.abs(hit.y - (r.y + r.height));
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) { nx = -1; ny = 0; }
      else if (m === dr) { nx = 1; ny = 0; }
      else if (m === dt) { nx = 0; ny = -1; }
      else { nx = 0; ny = 1; }
    } else if (Math.abs(vx) >= Math.abs(vy)) {
      nx = vx > 0 ? -1 : 1;
      ny = 0;
    } else {
      nx = 0;
      ny = vy > 0 ? -1 : 1;
    }
    const dot = vx * nx + vy * ny;
    return {
      vx: (vx - 2 * dot * nx) * rest,
      vy: (vy - 2 * dot * ny) * rest,
      nx: nx,
      ny: ny
    };
  }

  /**
   * 宿主基类：有 Phaser 用 Container，没有则退化（与 UnitBase 的策略一致）
   */
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
      setRotation() { return this; }
      setAlpha() { return this; }
      setVisible() { return this; }
      add() { return this; }
      destroy() { this.active = false; }
    };

  class Projectile extends BaseClass {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   id                   投掷物标识（自增，日志用）
     *   itemId               道具 id（= ItemConfig.id）
     *   itemConfig           ItemConfig（提供 radius / projectileRadiusUnits / fuseOnHitMs / explodeAnimMs）
     *   team                 投掷方阵营
     *   shooterId            投掷者单位 id
     *   x, y                 发射点世界坐标（px）
     *   vx, vy               初速度（px/s，向上为负）
     *   gravityY             重力加速度（px/s²）
     *   stepSec              积分步长（秒）
     *   maxFlightMs          飞行硬上限（毫秒）
     *   depth                渲染深度
     *   spinDegPerSec        自旋角速度（度/秒，表现层）
     *   fuseBlinkMs          引线火花闪烁周期（毫秒，表现层）
     *   predictor            TrajectoryPredictor 实例（复用其积分与碰撞，强烈建议注入）
     */
    constructor(scene, opts) {
      const o = opts || {};
      super(scene, num(o.x, 0), num(o.y, 0));

      const P = (FK.Config && FK.Config.PROJECTILE) ? FK.Config.PROJECTILE : {};
      const ppx = (FK.Config ? FK.Config.PX_PER_UNIT : 48);

      this.projectileId = num(o.id, 0);
      this.itemId = o.itemId || '';
      this.itemConfig = o.itemConfig || null;
      this.team = o.team || '';
      this.shooterId = o.shooterId || '';

      /** 飞行状态（用普通字段而非 Phaser 的 x/y 保存，保证无 Phaser 环境也可计算） */
      this.pos = { x: num(o.x, 0), y: num(o.y, 0) };
      this.vel = { x: num(o.vx, 0), y: num(o.vy, 0) };

      this.gravityY = num(o.gravityY, (FK.Config ? FK.Config.PHYSICS.gravityY : 1500));
      this.stepSec = num(o.stepSec, (FK.Config && FK.Config.AIM ? FK.Config.AIM.stepSec : 1 / 60));
      this.maxFlightMs = num(o.maxFlightMs, num(P.maxFlightMs, 6000));
      this.maxStepMs = num(o.maxStepMs, num(P.maxStepMs, 50));
      this.depth = num(o.depth, num(P.depth, 20));
      this.spinDegPerSec = num(o.spinDegPerSec, num(P.spinDegPerSec, 720));
      this.fuseBlinkMs = num(o.fuseBlinkMs, num(P.fuseBlinkMs, 120));

      /** 地形碰撞数据与积分器（来自 BattleScene 注入的 TrajectoryPredictor） */
      this.predictor = o.predictor || null;
      /**
       * 世界数据快照 { platforms, waterLevel, bounds }。
       * 由 ProjectileController 从预测器导出，保证「实飞用的地形」与「预测用的地形」
       * 是同一份数据；预测器缺失时也可以独立工作。
       */
      this.world = o.world || null;

      /** 投掷物视半径（px）：来自 ItemConfig.projectileRadiusUnits */
      const rUnits = (this.itemConfig && typeof this.itemConfig.projectileRadiusUnits === 'number')
        ? this.itemConfig.projectileRadiusUnits : 0.3;
      this.radiusPx = num(o.radiusPx, rUnits * ppx);

      /** 引信时长（毫秒）：来自 ItemConfig.fuseOnHitMs */
      this.fuseMs = (this.itemConfig && typeof this.itemConfig.fuseOnHitMs === 'number')
        ? this.itemConfig.fuseOnHitMs : 50;

      const hops = (this.itemConfig && typeof this.itemConfig.bounceSettleHops === 'number')
        ? this.itemConfig.bounceSettleHops : 2;
      this.settleHopsLeft = Math.max(0, Math.round(hops));
      this.settleHopMax = this.settleHopsLeft;
      this.settling = false;
      this.terrainBounces = 0;
      this.lastSpeed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);

      /** 飞行统计 */
      this.flightTimeMs = 0;
      this.stepCount = 0;
      this.landed = false;
      this.removed = false;
      this.spinDeg = 0;
      this.blinkAccMs = 0;
      /** 引线火花可见性（每 fuseBlinkMs 翻转一次，从可见开始） */
      this.fuseVisible = true;

      /** 落地信息：{ x, y, hitType, hitTarget } */
      this.landing = null;

      /** 视觉对象（create() 中构建） */
      this.bodyGfx = null;
      this.fuseGfx = null;
      this.sparkGfx = null;
      this.built = false;
    }

    /* ==================================================================
     * 生命周期
     * ================================================================== */

    /**
     * 构建视觉（幂等）。在没有 Phaser 渲染管线的环境下会自动跳过，只保留逻辑。
     * @returns {Projectile} this
     */
    create() {
      if (this.built) { return this; }

      const scene = this.scene;
      const canDraw = !!(scene && scene.add && typeof scene.add.graphics === 'function');

      this.setPosition(this.pos.x, this.pos.y);
      if (typeof this.setDepth === 'function') { this.setDepth(this.depth); }

      if (canDraw) {
        if (typeof scene.add.existing === 'function') { scene.add.existing(this); }
        this.bodyGfx = scene.add.graphics();
        this.fuseGfx = scene.add.graphics();
        this.sparkGfx = scene.add.graphics();
        this.drawFlightArt();
        if (typeof this.add === 'function') {
          this.add([this.bodyGfx, this.fuseGfx, this.sparkGfx]);
        }
        if (typeof this.setDepth === 'function') { this.setDepth(Math.max(this.depth, 42)); }
        if (typeof this.setVisible === 'function') { this.setVisible(true); }
        if (typeof this.setAlpha === 'function') { this.setAlpha(1); }
      }

      this.built = true;
      this.syncVisual();
      return this;
    }

    /** 按道具 id 画飞行外观（只用 fillCircle / fillRect / fillTriangle / lineTo） */
    drawFlightArt() {
      const g = this.bodyGfx;
      const fuse = this.fuseGfx;
      const spark = this.sparkGfx;
      if (!g) { return; }
      const r = Math.max(8, this.radiusPx);
      const id = this.itemId;
      g.clear();
      if (fuse) { fuse.clear(); }
      if (spark) { spark.clear(); }

      if (id === 'fruit_crate') {
        const s = r * 1.8;
        g.fillStyle(COLOR.crate, 1);
        g.fillRect(-s / 2, -s / 2, s, s);
        g.fillStyle(COLOR.crateHi, 0.85);
        g.fillRect(-s / 2, -s / 2, s, Math.max(3, s * 0.2));
        g.lineStyle(2, COLOR.crateGrain, 0.9);
        g.beginPath(); g.moveTo(-s / 2 + 3, -s * 0.08); g.lineTo(s / 2 - 3, -s * 0.08); g.strokePath();
        g.beginPath(); g.moveTo(-s / 2 + 3, s * 0.15); g.lineTo(s / 2 - 3, s * 0.15); g.strokePath();
        g.beginPath(); g.moveTo(-s / 2 + 4, -s / 2 + 4); g.lineTo(s / 2 - 4, s / 2 - 4); g.strokePath();
        g.lineStyle(2, COLOR.crateDark, 1);
        g.strokeRect(-s / 2, -s / 2, s, s);
        return;
      }

      if (id === 'banana_bomb') {
        g.fillStyle(COLOR.banana, 1);
        g.fillCircle(-r * 0.35, r * 0.12, r * 0.72);
        g.fillCircle(0, -r * 0.08, r * 0.78);
        g.fillCircle(r * 0.38, r * 0.18, r * 0.7);
        g.lineStyle(Math.max(2, r * 0.14), COLOR.bananaDark, 1);
        g.beginPath();
        g.moveTo(-r * 0.7, r * 0.15);
        g.lineTo(-r * 0.1, -r * 0.55);
        g.lineTo(r * 0.72, r * 0.22);
        g.strokePath();
        g.fillStyle(COLOR.bananaTip, 1);
        g.fillCircle(-r * 0.78, r * 0.28, r * 0.16);
        g.fillCircle(r * 0.8, r * 0.32, r * 0.14);
        g.fillStyle(COLOR.highlight, 0.45);
        g.fillCircle(-r * 0.1, -r * 0.28, r * 0.2);
        return;
      }

      if (id === 'watermelon_bomb') {
        g.fillStyle(COLOR.melon, 1);
        g.fillCircle(0, 0, r);
        g.lineStyle(Math.max(2, r * 0.22), COLOR.melonStripe, 1);
        g.beginPath(); g.moveTo(-r * 0.35, -r * 0.72); g.lineTo(-r * 0.5, r * 0.7); g.strokePath();
        g.beginPath(); g.moveTo(-r * 0.05, -r * 0.85); g.lineTo(-r * 0.12, r * 0.82); g.strokePath();
        g.beginPath(); g.moveTo(r * 0.28, -r * 0.75); g.lineTo(r * 0.4, r * 0.68); g.strokePath();
        g.beginPath(); g.moveTo(r * 0.55, -r * 0.45); g.lineTo(r * 0.62, r * 0.4); g.strokePath();
        g.lineStyle(Math.max(2, r * 0.14), COLOR.melonDark, 1);
        g.strokeCircle(0, 0, r);
        g.fillStyle(COLOR.highlight, 0.4);
        g.fillCircle(-r * 0.28, -r * 0.28, r * 0.22);
      } else {
        g.fillStyle(COLOR.body, 1);
        g.fillCircle(0, 0, r);
        g.lineStyle(Math.max(2, r * 0.14), COLOR.bodyDark, 1);
        g.strokeCircle(0, 0, r);
        g.fillStyle(COLOR.highlight, 0.85);
        g.fillCircle(-r * 0.3, -r * 0.3, r * 0.28);
      }

      g.lineStyle(Math.max(2, r * 0.16), COLOR.stem, 1);
      g.beginPath(); g.moveTo(0, -r * 0.85); g.lineTo(r * 0.1, -r * 1.4); g.strokePath();
      g.fillStyle(COLOR.leaf, 1);
      g.fillTriangle(r * 0.05, -r * 1.15, r * 0.7, -r * 1.45, r * 0.2, -r * 0.85);

      if (fuse) {
        fuse.lineStyle(Math.max(2, r * 0.14), COLOR.fuse, 1);
        fuse.beginPath();
        fuse.moveTo(0, -r);
        fuse.lineTo(-r * 0.15, -r * STYLE.fuseLenK);
        fuse.strokePath();
      }
      if (spark) {
        spark.fillStyle(COLOR.spark, 1);
        spark.fillCircle(-r * 0.15, -r * STYLE.fuseLenK, Math.max(2.4, r * STYLE.sparkR));
        spark.fillStyle(0xFFFFFF, 0.85);
        spark.fillCircle(-r * 0.15, -r * STYLE.fuseLenK, Math.max(1.1, r * STYLE.sparkR * 0.4));
      }
    }

    /**
     * 把逻辑坐标同步到 Phaser 显示对象（并做自旋 + 火花闪烁）。
     * 逻辑与表现分离：即使没有渲染对象，物理仍然完整可信。
     * @param {number} [deltaMs] 距上一帧毫秒数（用于火花闪烁）
     */
    syncVisual(deltaMs) {
      const dtMs = num(deltaMs, 0);

      if (typeof this.setPosition === 'function') { this.setPosition(this.pos.x, this.pos.y); }

      // 自旋（整体旋转，视觉上像翻滚的樱桃）；落地后冻结角度
      if (!this.landed) {
        this.spinDeg = (this.spinDeg + this.spinDegPerSec * dtMs / 1000) % 360;
        if (typeof this.setRotation === 'function') {
          this.setRotation(this.spinDeg * Math.PI / 180);
        }
      }

      // 引线末端火花：alpha 在 0.6～1.0 间循环（引线本身常显）
      if (this.sparkGfx && this.fuseBlinkMs > 0 && !this.landed) {
        this.blinkAccMs += dtMs;
        const phase = (this.blinkAccMs / this.fuseBlinkMs) * Math.PI;
        const a = STYLE.sparkAlphaMin + (STYLE.sparkAlphaMax - STYLE.sparkAlphaMin) *
          (0.5 + 0.5 * Math.sin(phase));
        this.fuseVisible = a >= 0.8;
        if (typeof this.sparkGfx.setAlpha === 'function') { this.sparkGfx.setAlpha(a); }
        if (typeof this.sparkGfx.setVisible === 'function') { this.sparkGfx.setVisible(true); }
      }
      return this;
    }

    /* ==================================================================
     * 物理推进（每帧由 ProjectileController 调用）
     * ================================================================== */

    /**
     * 推进一小步并检测碰撞。
     * 积分与碰撞全部复用注入的 TrajectoryPredictor；未注入时用静态原语回退，
     * 结果一致（同样调用 stepIntegrate / resolveSegmentHit）。
     *
     * @param {number} deltaMs 距上一帧毫秒数
     * @returns {Object|null} 命中信息 { x, y, hitType, hitTarget }；仍在飞行返回 null
     */
    step(deltaMs) {
      if (this.landed || this.removed) { return this.landing; }

      // 单帧步进时间钳制：掉帧/切后台回来时不要一步跨过平台
      const dtMs = Math.min(Math.max(num(deltaMs, 0), 0), this.maxStepMs);
      const dt = dtMs / 1000;

      if (dt > 0) {
        this.lastSpeed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
        const state = { x: this.pos.x, y: this.pos.y, vx: this.vel.x, vy: this.vel.y, g: this.gravityY };
        const next = this.integrate(state, dt);

        const hit = this.detectCollision(this.pos, { x: next.x, y: next.y });

        if (hit) {
          this.pos.x = hit.x;
          this.pos.y = hit.y;
        } else {
          this.pos.x = next.x;
          this.pos.y = next.y;
        }
        this.vel.y = next.vy;
        this.stepCount += 1;
        this.flightTimeMs += dtMs;

        if (hit) {
          if (this.tryTerrainBounce(hit, next)) {
            return null;
          }
          if (this.landed) { return this.landing; }
          this.landFrom({ x: hit.x, y: hit.y, hitType: hit.type, hitTarget: hit.target });
          return this.landing;
        }
      }

      // 飞行硬上限：兜底，保证任何情况下都会落地（不卡回合）
      if (this.flightTimeMs >= this.maxFlightMs) {
        this.landFrom({ x: this.pos.x, y: this.pos.y, hitType: 'timeout', hitTarget: null });
        return this.landing;
      }

      return null;
    }

    /** 单步积分：优先用注入的预测器（同一份代码），否则退回静态原语 */
    integrate(state, dt) {
      if (this.predictor && typeof this.predictor.stepProjectile === 'function') {
        return this.predictor.stepProjectile(state, dt, this.flightTimeMs / 1000);
      }
      if (FK.TrajectoryPredictor && typeof FK.TrajectoryPredictor.stepIntegrate === 'function') {
        const analytic = !this.predictor || this.predictor.integration !== 'euler';
        return FK.TrajectoryPredictor.stepIntegrate(this.flightTimeMs / 1000, state, dt, analytic);
      }
      // 理论上到不了这里（TrajectoryPredictor 一定先于本文件加载）；
      // 真到这一步说明工程结构被破坏，直接返回原状态而不是偷偷用另一套公式
      return { x: state.x, y: state.y, vy: state.vy };
    }

    /** 香蕉弹：平台弹跳；动能不足后先贴地弹两次再引爆 */
    tryTerrainBounce(hit, next) {
      const cfg = this.itemConfig;
      if (!cfg || !cfg.bounceTerrain) { return false; }
      if (!hit || hit.type !== 'platform') { return false; }

      const rest = num(cfg.bounceRestitution, 0.85);
      const bounced = bounceOffHit(hit, this.vel.x, next.vy, rest);
      this.vel.x = bounced.vx;
      this.vel.y = bounced.vy;
      this.pos.x = hit.x + bounced.nx * 3;
      this.pos.y = hit.y + bounced.ny * 3;
      this.lastSpeed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);

      const speed = this.lastSpeed;
      const minSp = num(cfg.bounceMinSpeed, 90);
      const floorHit = bounced.ny < -0.4;
      if (speed < minSp) { this.settling = true; }
      if (this.settling && floorHit) {
        if (this.settleHopsLeft > 0) {
          const used = this.settleHopMax - this.settleHopsLeft;
          const base = num(cfg.bounceSettleVy, 205);
          const hop = base * (used === 0 ? 1 : 0.58);
          this.vel.y = -Math.abs(hop);
          this.vel.x *= 0.52;
          this.settleHopsLeft -= 1;
          this.terrainBounces = (this.terrainBounces || 0) + 1;
          return true;
        }
        this.landFrom({ x: this.pos.x, y: this.pos.y, hitType: 'energy', hitTarget: hit.target });
        return false;
      }
      if (this.settling && Math.abs(this.vel.x) < 36) {
        this.vel.x = bounced.nx * 72;
      }
      this.terrainBounces = (this.terrainBounces || 0) + 1;
      return true;
    }

    /** 地形碰撞：优先用注入的预测器（同一份世界数据），否则用构造时传入的世界快照 */
    detectCollision(from, to) {
      if (this.predictor && typeof this.predictor.resolveCollision === 'function') {
        return this.predictor.resolveCollision(from, to, this.world || undefined);
      }
      if (FK.TrajectoryPredictor && typeof FK.TrajectoryPredictor.resolveSegmentHit === 'function') {
        return FK.TrajectoryPredictor.resolveSegmentHit(from, to, this.world || {});
      }
      return null;
    }

    /**
     * 标记为已落地（由 step 内部或控制器调用）
     * @param {Object} info { x, y, hitType, hitTarget }
     */
    landFrom(info) {
      const i = info || {};
      this.landed = true;
      this.pos.x = num(i.x, this.pos.x);
      this.pos.y = num(i.y, this.pos.y);
      this.vel.x = 0;
      this.vel.y = 0;
      this.landing = {
        x: this.pos.x,
        y: this.pos.y,
        hitType: i.hitType || 'timeout',
        hitTarget: i.hitTarget || null
      };
      this.syncVisual(0);

      if (typeof this.setRotation === 'function') { this.setRotation(0); }
      if (this.fuseGfx && typeof this.fuseGfx.setVisible === 'function') { this.fuseGfx.setVisible(false); }
      if (this.sparkGfx && typeof this.sparkGfx.setVisible === 'function') { this.sparkGfx.setVisible(false); }
      this.fuseVisible = false;

      if (FK.EventBus && FK.EVENTS && FK.EVENTS.PROJECTILE_LANDED) {
        FK.EventBus.emit(FK.EVENTS.PROJECTILE_LANDED, {
          id: this.projectileId,
          itemId: this.itemId,
          team: this.team,
          shooterId: this.shooterId,
          x: Math.round(this.pos.x),
          y: Math.round(this.pos.y),
          hitType: this.landing.hitType,
          hitTarget: this.landing.hitTarget,
          landing: { x: Math.round(this.pos.x), y: Math.round(this.pos.y) },
          flightTimeMs: Math.round(this.flightTimeMs),
          stepCount: this.stepCount
        });
      }
      return this.landing;
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /** 当前世界坐标 { x, y }（像素） */
    getPosition() { return { x: this.pos.x, y: this.pos.y }; }

    getExplodeDamage() {
      const cfg = this.itemConfig || {};
      return num(cfg.damage, 0);
    }

    /** 当前速度 { vx, vy, vx? }：同时提供 vx/vy 与 x/y 两种键名，方便调用方 */
    getVelocity() { return { vx: this.vel.x, vy: this.vel.y, x: this.vel.x, y: this.vel.y }; }

    /** 是否已落地 */
    hasLanded() { return this.landed; }

    /** 是否已被移除 */
    isRemoved() { return this.removed; }

    /** 落地信息（未落地返回 null） */
    getLanding() { return this.landing; }

    /** 飞行了多久（毫秒） */
    getFlightTimeMs() { return Math.round(this.flightTimeMs); }

    /** 引信时长（毫秒，来自 ItemConfig.fuseOnHitMs） */
    getFuseMs() { return this.fuseMs; }

    /** 投掷方阵营（第 7 步：放置类道具生成障碍物时需要记名） */
    getTeam() { return this.team; }

    /** 道具 id（= ItemConfig.id） */
    getItemId() { return this.itemId; }

    /** 视半径（px） */
    getRadiusPx() { return this.radiusPx; }

    /** 状态摘要（日志 / 调试） */
    describe() {
      return 'Projectile#' + this.projectileId + '(' + this.itemId + ', team=' + this.team +
        ', pos=' + Math.round(this.pos.x) + ',' + Math.round(this.pos.y) +
        ', t=' + Math.round(this.flightTimeMs) + 'ms' +
        (this.landed ? ', landed@' + this.landing.hitType : ', flying') + ')';
    }

    /* ==================================================================
     * 销毁
     * ================================================================== */

    /**
     * 从场景移除（递归销毁子图形）
     * @param {boolean} [fromScene]
     */
    destroy(fromScene) {
      if (this.removed) { return; }
      this.removed = true;
      this.built = false;
      this.bodyGfx = null;
      this.fuseGfx = null;
      this.sparkGfx = null;

      // 无 Phaser 环境（退化基类）时 super.destroy 只是把 active 置 false
      if (typeof super.destroy === 'function') { super.destroy(fromScene); }
    }
  }

  Projectile.COLOR = Object.freeze(COLOR);

  FK.Projectile = Projectile;
})();
