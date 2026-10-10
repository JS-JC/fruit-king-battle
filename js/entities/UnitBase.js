/**
 * ============================================================
 * UnitBase.js —— 单位实体基类
 * ============================================================
 * 职责：
 *   封装所有单位共有的视觉与物理能力，供 js/entities/units/ 下的
 *   具体单位模块继承并覆盖视觉细节。
 *
 * 继承关系：
 *   Phaser.GameObjects.Container
 *     └── UnitBase（本文件）
 *           ├── FruitKing / AppleGuard / LemonGeneral / GrapeSoldier
 *
 * 视觉分层（Container 子对象，从下到上）：
 *   hoverRing  ── 悬停描边（白色空心圆）
 *   selectRing ── 选中描边（阵营强调色空心圆，带脉冲动画）
 *   art        ── 美术容器（bodyGfx 圆身 + decorGfx 装饰，悬停时整体放大）
 *   hpBg/hpFill── 头顶血条（红底绿条）
 *
 * 物理：Arcade Physics 静态体（不需要重力，单位直接站在平台上）
 *
 * 逐步扩展：
 *   第 5 步 瞄准态视觉    第 6 步 击退滑行    第 7.10 步 撞木箱/墙弹回
 *   第 8 步 落水口径 / 判死 / 复活 / 支撑面（掉下平台 → 落水）
 * 仍未做：主动移动、AI
 *
 * 依赖：Phaser、FK.EventBus、FK.EVENTS
 * 对外：FK.UnitBase（含 TEAM_COLORS）、FK.UnitBase.TEAM_COLORS
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 阵营配色：新增阵营只需在这里加一项（配合 turn.json 的 teamOrder） */
  const TEAM_COLORS = {
    blue: { fill: 0x2563EB, light: 0x93C5FD, accent: 0xFDE047, label: '蓝色方', css: '#93C5FD' },
    red: { fill: 0xDC2626, light: 0xFCA5A5, accent: 0xFDE047, label: '红色方', css: '#FCA5A5' }
  };

  /** 单位几何常量（单位制：1 u = 48 px） */
  const RADIUS = 24;              // 圆形碰撞半径，直径 48px = 1 地图单位
  const HIT_RADIUS = 28;          // 鼠标拾取半径，略大于视觉半径，方便点击
  const HOVER_SCALE = 1.08;       // 悬停时美术放大倍数
  const AIM_SCALE = 0.94;         // 瞄准时美术缩小倍数（后仰感）
  const HOVER_RING_R = RADIUS + 7;    // 悬停描边半径
  const SELECT_RING_R = RADIUS + 11;  // 选中描边半径
  const HP_BAR = { w: 48, h: 6, y: -50 };   // 血条尺寸与相对位置
  const AIM_RING_R = RADIUS + 18;           // 瞄准准星半径（第 5 步）
  // 约定：子类 buildDecor 的绘制范围应限制在 y ∈ [-34, +20]、x ∈ [-22, 22]，
  //       避免顶到血条或穿出选中描边

  /**
   * 在 Graphics 上画一圈虚线圆（16 段短弧拼接）
   * @param {Phaser.GameObjects.Graphics} g
   * @param {number} radius
   * @param {number} segments 段数
   * @param {number} gapRatio 每段中空隙占比 0~1
   */
  function drawDashedCircle(g, radius, segments, gapRatio) {
    const seg = (Math.PI * 2) / segments;
    const gap = seg * (typeof gapRatio === 'number' ? gapRatio : 0.45);
    g.beginPath();
    for (let i = 0; i < segments; i++) {
      const a0 = i * seg;
      g.arc(0, 0, radius, a0, a0 + (seg - gap), false);
    }
    g.strokePath();
  }

  /**
   * 基类宿主：正常环境是 Phaser 的 Container；
   * 在完全没有 Phaser 的环境（Node 自检脚本）下退化为空基类，
   * 保证「脚本可加载 + 接口契约可校验」，但该环境下不能实例化真实单位。
   */
  const BaseClass = (typeof Phaser !== 'undefined' && Phaser &&
    Phaser.GameObjects && Phaser.GameObjects.Container)
    ? Phaser.GameObjects.Container
    : class FallbackContainer {
      constructor(scene, x, y) { this.scene = scene || null; this.x = x || 0; this.y = y || 0; }
    };

  class UnitBase extends BaseClass {

    /**
     * 只做数据登记，视觉与物理体交给 create() 构建
     * @param {Phaser.Scene} scene
     * @param {FK.UnitConfig} config 单位配置
     * @param {Object} [spawnPoint] 出生点 { x, y, worldX, worldY, team, unitId }
     */
    constructor(scene, config, spawnPoint) {
      super(scene, 0, 0);

      this.config = config || null;
      this.spawnPoint = spawnPoint || null;

      this.unitId = config ? config.id : '';
      this.team = config ? config.team : 'blue';
      this.maxHp = config ? config.hp : 100;
      this.hp = this.maxHp;

      this.selected = false;
      this.hovered = false;
      this.aiming = false;
      this.built = false;

      /* ---------- 第 6 步：受击与击退状态 ---------- */
      /** 击退抗性倍率（1.0 = 标准，文档 3 §4 knockbackResist） */
      this.knockbackResist = (config && typeof config.knockbackResist === 'number')
        ? config.knockbackResist : 1.0;
      /** 当前击退速度（px/s）：由 applyKnockback 施加，update() 中自然衰减 */
      this.knockbackVx = 0;
      this.knockbackVy = 0;
      /** 第 7.10 步：撞木箱 / 撞墙的弹性碰撞世界（由场景注入 provider） */
      this.bounceWorldProvider = null;
      /**
       * 第 8 步：支撑面提供者（由场景注入）——`(x, y) => 支撑面顶面 y | null`。
       * 注入后，单位在空中会按「当前 x 处有没有落脚点」决定落地还是继续下坠，
       * 于是「被击退出平台 → 落水」这条链路成立；
       * 未注入时退化为第 6～7 步的「落回起始高度」旧行为（Node 单测可脱场景运行）。
       */
      this.supportProvider = null;
      /**
       * 第 8.7 步：水面高度提供者（场景注入）——`() => 水面像素 y | null`。
       * 只用于「悬空自愈」时的**落水优先**判定：脚底已越过水面就不再吸附到平台 / 木箱上，
       * 直接交给 DeathSystem 判落水（读的是与 DeathSystem 同一个 waterLevel）。
       */
      this.waterLevelProvider = null;
      /** 累计弹回次数与最近一次弹回信息（HUD / 自检用） */
      this.bounceCount = 0;
      this.lastBounce = null;
      /** 是否处于空中（击退抛起后未落回原高度） */
      this.airborne = false;
      /** 是否贴地（第 6 步恒为 true，落水与平台判定留第 8 步） */
      this.grounded = true;
      /** 受击闪白计时（毫秒） */
      this.hitFlashMs = 0;
      /**
       * 存活标记。
       * 第 8 步：死亡判定落地——落水 / 血量归零都由 FK.DeathSystem 裁决，
       * 它会把 alive 置为 false 并写入 deadReason，随后单位被移出各单位列表。
       */
      this.alive = true;
      /** 死因（'hp_zero' | 'drowned' | null） */
      this.deadReason = null;
      /** 被击退抛起前的基准高度（y）：落回该高度即结束空中段；null = 不在空中 */
      this.groundY = null;

      /* ---------- 第 8.5 步：主动移动（由 FK.MoveController 驱动） ---------- */
      /**
       * 主动移动的抛物速度（px/s）。与击退速度**分开存放**，两套运动互不干扰：
       *   · 击退 = 被动位移（knockbackVx / knockbackVy，落点高度 = 起跳时的支撑面）
       *   · 移动 = 主动抛物（moveVx / moveVy，落点即 MoveController 的预览落点）
       * 运动积分复用 TrajectoryPredictor.stepProjectile（与投掷共用同一份物理）。
       */
      this.moveVx = 0;
      this.moveVy = 0;
      /** 是否正在执行一次主动移动 */
      this.moving = false;
      /** 本次移动已弹回次数与最近一次弹回信息 */
      this.moveBounces = 0;
      this.lastMoveBounce = null;
      /** 移动结束原因（'landed' | 'wall'），便于 HUD 与自检核对 */
      this.moveEndReason = null;

      /** 选中脉冲动画（destroy 时需要停掉） */
      this.pulseTween = null;
    }

    /* ==================================================================
     * 生命周期
     * ================================================================== */

    /**
     * 创建视觉与物理体（幂等：重复调用只构建一次）
     * @param {Phaser.Scene} scene
     * @param {FK.UnitConfig} [config]
     * @param {Object} [spawnPoint] 出生点（含 worldX / worldY）
     * @returns {UnitBase} this
     */
    create(scene, config, spawnPoint) {
      const s = scene || this.scene;
      if (config) { this.config = config; this.unitId = config.id; this.team = config.team; this.maxHp = config.hp; this.hp = config.hp; }
      if (spawnPoint) { this.spawnPoint = spawnPoint; }

      if (this.built) { return this; }

      const sp = this.spawnPoint || { worldX: 0, worldY: 0 };
      this.setPosition(sp.worldX || 0, sp.worldY || 0);
      this.setSize(RADIUS * 2, RADIUS * 2);

      this.buildVisuals();
      s.add.existing(this);
      this.buildPhysics();

      this.built = true;
      return this;
    }

    /**
     * 每帧更新（基类只做空实现，子类可覆盖做动画/特效）
     *
     * 第 6 步起：基类在这里处理「击退滑行」——
     *   水平方向按 unitDragX 阻尼减速（第 7.10 步起再叠加「撞木箱 / 撞墙弹性弹回」），
     *   垂直方向受重力影响后落回原高度，
     *   位移公式与文档 3 §5.1 的 `位移 = v² / (2 × dragX)` 一致。
     * @param {number} deltaTime 距上一帧毫秒数
     */
    update(deltaTime) {
      const dt = ((typeof deltaTime === 'number' && isFinite(deltaTime) && deltaTime > 0) ? deltaTime : 0) / 1000;
      if (dt <= 0) { return; }

      if (this.hitFlashMs > 0) { this.updateHitFlash(dt * 1000); }

      // 主动跳跃只由 stepActiveMove 积分；这里再算一次会叠重力、提前落地，轨迹和预览对不上。
      if (this.moving) { return; }

      this.resolveHover();

      if (this.knockbackVx === 0 && this.knockbackVy === 0 && !this.airborne) { return; }

      const D = FK.Config.DAMAGE;
      const P = FK.KnockbackPhysics;
      const radius = (typeof this.getCollisionRadius === 'function') ? this.getCollisionRadius() : 24;
      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
      const stepSec = (typeof A.stepSec === 'number') ? A.stepSec : 1 / 60;
      const stepMs = stepSec * 1000;

      if (this.airborne && P && typeof P.stepFlightSlice === 'function') {
        // 与移动预览同一固定步长、同一解析积分；空中不加水平阻力，才是标准抛物线。
        this.knockAccMs = (this.knockAccMs || 0) + dt * 1000;
        if (this.knockAccMs > stepMs * 5) { this.knockAccMs = stepMs * 5; }
        const world = (typeof this.bounceWorldProvider === 'function')
          ? (this.bounceWorldProvider(this) || {})
          : {};
        while (this.knockAccMs + 1e-9 >= stepMs && this.airborne) {
          this.knockAccMs -= stepMs;
          const slice = P.stepFlightSlice({
            x: this.x, y: this.y, vx: this.knockbackVx, vy: this.knockbackVy,
            g: D.gravityY, halfWidth: radius,
            priorBounceCount: this.bounceCount || 0
          }, stepSec, world);
          this.x = slice.x;
          this.y = slice.y;
          this.knockbackVx = slice.vx;
          this.knockbackVy = slice.vy;
          if (slice.bounced) { this.onBounced(slice); }
          if (this.knockbackVy >= 0 && typeof this.supportProvider === 'function') {
            this.landOnSupport(this.knockbackBaseY());
          }
        }
      } else {
        const dragX = D.unitDragX;
        const nextVx = dampAxis(this.knockbackVx, dragX, dt);
        const stepX = (this.knockbackVx + nextVx) / 2 * dt;
        this.knockbackVx = nextVx;
        if (Math.abs(this.knockbackVx) < D.knockStopSpeed) { this.knockbackVx = 0; }
        let stepY = 0;
        if (this.airborne) {
          const nextVy = this.knockbackVy + D.gravityY * dt;
          stepY = (this.knockbackVy + nextVy) / 2 * dt;
          this.knockbackVy = nextVy;
        }
        this.y += stepY;
        this.stepHorizontalBounce(stepX, dt);
      }

      if (typeof this.supportProvider === 'function') {
        if (this.airborne && this.knockbackVy >= 0) {
          this.landOnSupport(this.knockbackBaseY());
        } else if (!this.airborne && this.knockbackVy === 0) {
          this.groundY = null;
        }
      } else if (this.airborne && this.groundY !== null && this.knockbackVy > 0 && this.y >= this.groundY) {
        this.y = this.groundY;
        this.knockbackVy = 0;
        this.airborne = false;
      }
      if (!this.airborne && this.knockbackVy === 0 && typeof this.supportProvider !== 'function') {
        this.groundY = null;
      }

      this.clampToArena();
      this.syncBody();
    }

    /**
     * 击退落地的基准高度：起跳位置处的支撑面顶面（单位中心 = 顶面 − 半径）。
     * 没有支撑面时退回当前位置，行为与第 8 步一致。
     * @returns {number}
     */
    knockbackBaseY() {
      const supportY = this.querySupportY();
      if (typeof supportY === 'number' && isFinite(supportY)) { return supportY - RADIUS; }
      return this.y;
    }

    /**
     * 第 8.5 步：按支撑面落地（击退与主动移动共用同一套落地口径）。
     *   ① 有支撑面 → 落到「支撑面顶面 − 碰撞半径」；
     *   ② 没有支撑面（被击退 / 跳到平台之外的果汁池上方）→ **继续下坠**，
     *      越过水面后由 DeathSystem 判落水（与主动移动 stepActiveMove 完全同口径）。
     *
     * 第 8.6 步修复（Bug：被炸飞的单位停在半空不回地面）：
     *   旧实现在「当前位置没有支撑面」时把 `startY`（= 每帧都在变的当前 y）当成落地面，
     *   于是单位一进入下降段就立刻「落地」在空中——典型现象就是悬在中央平台上空不动。
     *   现在没有支撑面就返回 false（不落地），单位会一直下坠到台面或果汁池。
     * @param {number} startY 历史入参（保留签名兼容，已不再作为落地面；见上）
     * @returns {boolean} 本帧是否发生落地
     */
    landOnSupport(startY) {
      const supportY = this.querySupportY();
      void startY;
      if (supportY === null) { return false; }
      const landY = supportY - RADIUS;
      if (this.knockbackVy >= 0 && this.y >= landY) {
        this.y = landY;
        const D = (FK.Config && FK.Config.DAMAGE) ? FK.Config.DAMAGE : null;
        const K = (FK.Config && FK.Config.KNOCKBACK) ? FK.Config.KNOCKBACK : null;
        const rest = Math.max(0, Math.min(1, (K && typeof K.landRestitution === 'number')
          ? K.landRestitution
          : 0.42));
        const minBounce = (K && typeof K.minLandBounceSpeed === 'number')
          ? K.minLandBounceSpeed
          : 55;
        const maxLand = (K && typeof K.maxLandBounces === 'number')
          ? Math.max(0, Math.round(K.maxLandBounces))
          : 12;
        const bouncedVy = -this.knockbackVy * rest;
        const bouncedVx = this.knockbackVx * rest;
        this.landBounceCount = this.landBounceCount || 0;
        const safetyCap = (maxLand > 0) ? maxLand : 12;

        // 落地反弹：水平/垂直共用 landRestitution；贴地后才收进短滑行。
        if (this.landBounceCount < safetyCap && Math.abs(bouncedVy) >= minBounce) {
          this.landBounceCount += 1;
          this.knockbackVy = bouncedVy;
          this.knockbackVx = bouncedVx;
          this.airborne = true;
          this.groundY = landY;
          this.grounded = false;
          return true;
        }

        this.knockbackVy = 0;
        this.airborne = false;
        this.groundY = landY;
        this.applyLandSlideVx(this.knockbackVx);
        return true;
      }
      return false;
    }

    /**
     * 第 8.7 步：注入水面高度提供者 `() => 水面像素 y | null`（BattleScene 调用）
     * @param {Function} provider
     * @returns {UnitBase} this
     */
    setWaterLevelProvider(provider) {
      this.waterLevelProvider = (typeof provider === 'function') ? provider : null;
      return this;
    }

    /** 脚底是否已越过水面（落水优先判定；未注入水面数据时恒为 false） */
    isBelowWaterSafe() {
      if (typeof this.waterLevelProvider !== 'function') { return false; }
      return this.isBelowWater(this.waterLevelProvider());
    }

    /**
     * 第 8.7 步：悬空自愈 —— 保证「击退（或任何位移）结束后单位一定踩在东西上」。
     *
     * 逐条对应验收口径：
     *   ① **落水优先**：脚底已越过水面 → 不吸附，交给 DeathSystem 判死；
     *   ② 空中 / 主动移动中不处理（飞行由落地判定负责，主动移动由 stepActiveMove 负责），
     *      但**落地后仍在横向滑行**的单位必须继续检查支撑面，否则会卡在平台边缘不掉；
     *   ③ 下方有平台 / 木箱顶面：
     *        · 缝隙 ≤ DEATH.supportTolerancePx → 直接把脚底吸附到该顶面（消除视觉悬空）；
     *        · 缝隙更大                       → 恢复下坠（airborne = true），由落地判定精确落到顶面；
     *   ④ 下方什么都没有 → 恢复下坠，最终越过水面判落水，绝不允许永久悬停。
     *
     * @returns {boolean} 本帧是否修正了位置 / 运动状态
     */
    resolveHover() {
      if (this.alive === false) { return false; }
      if (this.moving) { return false; }
      // 没注入支撑面数据（Node 单测 / 单位刚创建）→ 不做任何推断
      if (typeof this.supportProvider !== 'function') { return false; }
      // 空中（含击退飞行段）→ 重力与落地由 update() 里的落地判定负责
      if (this.airborne) { return false; }
      if (this.isBelowWaterSafe()) { return false; }        // ① 落水优先

      const supportY = this.querySupportY();

      // ④ 脚下已经没有落脚点（滑出平台边缘 / 木箱到期）→ 立刻恢复下坠。
      //    第 8.9 步修复：本分支**不再要求速度归零**。
      //    旧版把 knockbackVx !== 0 一并挡在方法外，于是「落地后滑到平台边缘」的单位
      //    永远不会被重新检查支撑面 → 重力一直不恢复 → 卡在边缘横着滑出去也不掉。
      if (supportY === null) {
        this.airborne = true;
        this.grounded = false;
        return true;
      }

      const landY = supportY - RADIUS;                      // 脚底贴到顶面时的中心高度

      // 还在横向滑行（击退落地后的滑行段）：不吸附、不清速度；
      // 滑完自然停住；滑出边缘则由上面的分支接管，改为自由下坠。
      if (this.knockbackVx !== 0) {
        this.grounded = true;
        this.groundY = landY;
        return false;
      }

      const gap = landY - this.y;
      if (gap <= 0.5) {                                     // 已经贴住 → 只同步落地状态
        this.grounded = true;
        this.groundY = landY;
        return false;
      }
      const snapPx = (FK.Config && FK.Config.DEATH) ? FK.Config.DEATH.supportTolerancePx : RADIUS;
      if (gap <= snapPx) {                                  // ③ 小缝：直接吸附到顶面
        this.y = landY;
        this.groundY = landY;
        this.grounded = true;
        this.syncBody();
        return true;
      }
      this.airborne = true;                                 // ③ 大缝：先下坠，再由落地判定落到顶面
      this.grounded = false;
      return true;
    }

    /**
     * 第 8.5 步：主动移动的每帧推进（由 FK.MoveController.update 调用）。
     *   ① 与投掷**共用同一份积分原语**（TrajectoryPredictor.stepProjectile）；
     *   ② 水平方向撞木箱 / 撞墙 → 走 KnockbackPhysics 的弹性弹回（与击退同一套物理）；
     *   ③ 垂直方向不做障碍判定（规则：只检测水平方向）；
     *   ④ 落地 / 掉进果汁池即结束本次移动，落水判定仍由 BattleScene 每帧的 DeathSystem 负责。
     *
     * @param {number} dtMs 帧间隔（毫秒）
     * @returns {string|null} 结束原因（'landed'）或 null（仍在飞）
     */
    stepActiveMove(dtMs) {
      if (!this.moving) { return null; }
      const dt = ((typeof dtMs === 'number' && isFinite(dtMs) && dtMs > 0) ? dtMs : 0);
      if (dt <= 0) { return null; }

      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
      const stepSec = (typeof A.stepSec === 'number') ? A.stepSec : 1 / 60;
      const stepMs = stepSec * 1000;
      this.moveAccMs = (this.moveAccMs || 0) + dt;
      if (this.moveAccMs > stepMs * 8) { this.moveAccMs = stepMs * 8; }

      const g = (FK.Config && FK.Config.PHYSICS) ? FK.Config.PHYSICS.gravityY : 1500;
      const hw = (typeof this.getCollisionRadius === 'function') ? this.getCollisionRadius() : RADIUS;
      const P = FK.KnockbackPhysics;

      while (this.moveAccMs + 1e-9 >= stepMs && this.moving) {
        this.moveAccMs -= stepMs;
        const world = (typeof this.bounceWorldProvider === 'function')
          ? (this.bounceWorldProvider(this) || {})
          : {};

        if (P && typeof P.stepFlightSlice === 'function') {
          const M = (FK.Config && FK.Config.MOVE) ? FK.Config.MOVE : {};
          const r = P.stepFlightSlice({
            x: this.x, y: this.y, vx: this.moveVx, vy: this.moveVy,
            g: g, halfWidth: hw,
            priorBounceCount: this.moveBounces || 0
          }, stepSec, world, {
            restitution: (typeof M.restitution === 'number') ? M.restitution : 0.58,
            restitutionDecay: (typeof M.restitutionDecay === 'number') ? M.restitutionDecay : 0.78,
            minBounceSpeed: (typeof M.minBounceSpeed === 'number') ? M.minBounceSpeed : 28,
            maxBounceCount: (typeof M.maxBounces === 'number') ? M.maxBounces : 8
          });
          this.x = r.x;
          this.y = r.y;
          this.moveVx = r.vx;
          this.moveVy = r.vy;
          if (r.bounced) {
            this.moveBounces = (this.moveBounces || 0) + (r.bounceCount || 1);
            this.lastMoveBounce = { count: r.bounceCount || 1, hits: (r.hits || []).slice(), vx: this.moveVx };
          }
        } else {
          const next = this.integrateMoveStep(stepSec);
          this.y = next.y;
          const res = this.stepHorizontalWithVx(next.x - this.x, this.moveVx, stepSec);
          this.moveVx = res.vx;
        }

        if (typeof this.supportProvider === 'function') {
          const supportY = this.querySupportY();
          if (supportY !== null) {
            const landY = supportY - RADIUS;
            if (this.moveVy >= 0 && this.y >= landY) {
              this.y = landY;
              this.finishActiveMove('landed');
            }
          }
        } else if (this.moveVy >= 0 && typeof this.moveTargetY === 'number' && this.y >= this.moveTargetY) {
          this.y = this.moveTargetY;
          this.finishActiveMove('landed');
        }
      }

      this.syncBody();
      return this.moving ? null : (this.moveEndReason || 'landed');
    }

    /**
     * 单步积分：调用轨迹预测器的同一个原语，状态放在 this.moveVx / moveVy。
     * @param {number} dtSec
     * @returns {{x:number, y:number}} 积分后的位置
     */
    integrateMoveStep(dtSec) {
      const g = (FK.Config && FK.Config.PHYSICS) ? FK.Config.PHYSICS.gravityY : 1500;
      const predictor = FK.TrajectoryPredictor;
      if (predictor && typeof predictor.stepIntegrate === 'function') {
        const r = predictor.stepIntegrate(0, {
          x: this.x, y: this.y, vx: this.moveVx, vy: this.moveVy, g: g
        }, dtSec, true);
        this.moveVy = r.vy;
        return { x: r.x, y: r.y };
      }
      // 兜底（未加载预测器）：手写同一套公式，保证行为一致
      const r = {
        x: this.x + this.moveVx * dtSec,
        y: this.y + this.moveVy * dtSec + 0.5 * g * dtSec * dtSec,
        vy: this.moveVy + g * dtSec
      };
      this.moveVy = r.vy;
      return { x: r.x, y: r.y };
    }

    /**
     * 落地滑行：击退落地与主动移动落地共用。
     * 把剩余水平速度钳进 landSlidePx 预算（距离 = v² / (2·unitDragX)）。
     * @param {number} vx
     * @returns {UnitBase} this
     */
    applyLandSlideVx(vx) {
      const src = (typeof vx === 'number' && isFinite(vx)) ? vx : 0;
      const D = (FK.Config && FK.Config.DAMAGE) ? FK.Config.DAMAGE : null;
      const K = (FK.Config && FK.Config.KNOCKBACK) ? FK.Config.KNOCKBACK : null;
      const keep = (K && typeof K.landSlideKeepVx === 'number') ? Math.max(0, Math.min(1, K.landSlideKeepVx)) : 0.2;
      const first = !this.landSlideApplied;
      this.landSlideApplied = true;
      this.knockbackVx = first ? (src * keep) : src;
      const dragX = (D && typeof D.unitDragX === 'number' && D.unitDragX > 0) ? D.unitDragX : 300;
      const slidePx = (K && typeof K.landSlidePx === 'number') ? K.landSlidePx : RADIUS;
      const maxVx = Math.sqrt(2 * dragX * Math.max(0, slidePx));
      if (this.knockbackVx > maxVx) { this.knockbackVx = maxVx; }
      else if (this.knockbackVx < -maxVx) { this.knockbackVx = -maxVx; }
      return this;
    }

    /**
     * 结束主动移动（MoveController 负责广播 move:complete 与推进回合）
     * @param {string} reason 'landed' | 'wall' | 'cancel' | 'drown' | …
     * @returns {UnitBase} this
     */
    finishActiveMove(reason) {
      const why = reason || 'landed';
      const slideVx = (why === 'landed') ? this.moveVx : 0;
      this.moving = false;
      this.moveVx = 0;
      this.moveVy = 0;
      this.moveEndReason = why;
      this.knockbackVy = 0;
      this.airborne = false;
      this.grounded = true;
      this.groundY = this.y;
      if (why === 'landed') {
        this.applyLandSlideVx(slideVx);
      } else {
        this.knockbackVx = 0;
      }
      return this;
    }

    /**
     * 开始一次主动移动（单位只被赋速度，位置推进交给 MoveController 每帧调用 stepActiveMove）
     * @param {number} vx
     * @param {number} vy
     * @param {Object} [opts] { targetY }
     * @returns {UnitBase} this
     */
    beginActiveMove(vx, vy, opts) {
      const o = opts || {};
      this.moveVx = (typeof vx === 'number' && isFinite(vx)) ? vx : 0;
      this.moveVy = (typeof vy === 'number' && isFinite(vy)) ? vy : 0;
      this.moving = true;
      this.moveBounces = 0;
      this.lastMoveBounce = null;
      this.moveEndReason = null;
      this.moveTargetY = (typeof o.targetY === 'number' && isFinite(o.targetY)) ? o.targetY : null;
      // 移动期间清掉击退残留，避免两套运动叠加
      this.knockbackVx = 0;
      this.knockbackVy = 0;
      this.airborne = true;
      this.grounded = false;
      this.groundY = this.y;
      this.moveAccMs = 0;
      return this;
    }

    /** 是否正在主动移动 */
    isMoving() { return !!this.moving; }

    /** 本次移动已弹回次数 */
    getMoveBounceCount() { return this.moveBounces || 0; }

    /**
     * 销毁单位（Container.destroy 会递归销毁全部子对象）
     * @param {boolean} [fromScene] 是否由场景销毁触发
     */
    destroy(fromScene) {
      if (this.pulseTween) { this.pulseTween.stop(); this.pulseTween = null; }
      if (this.scene && this.scene.tweens) { this.scene.tweens.killTweensOf(this); }
      super.destroy(fromScene);
    }

    /* ==================================================================
     * 视觉构建（子类通过 buildDecor / getBodyColor 覆盖）
     * ================================================================== */

    /** 组装全部子对象 */
    buildVisuals() {
      const palette = this.getTeamPalette();
      const ally = this.isPlayerControlled();

      // ---- 常驻阵营圈：蓝=你能操控，红=敌方 ----
      this.teamRing = this.scene.add.graphics();
      this.teamRing.lineStyle(4, palette.fill, 1);
      this.teamRing.strokeCircle(0, 0, RADIUS + 3);

      // ---- 悬停描边 ----
      this.hoverRing = this.scene.add.graphics();
      this.hoverRing.lineStyle(3, 0xFFFFFF, 0.8);
      this.hoverRing.strokeCircle(0, 0, HOVER_RING_R);
      this.hoverRing.setVisible(false);

      // 选中不再叠第二圈，只脉冲阵营圈
      this.selectRing = null;

      // ---- 美术容器（悬停放大只影响这里，不影响血条与描边） ----
      this.art = this.scene.add.container(0, 0);

      this.bodyGfx = this.scene.add.graphics();
      this.bodyGfx.fillStyle(this.getBodyColor(), 1);
      this.bodyGfx.fillCircle(0, 0, RADIUS);
      this.bodyGfx.lineStyle(3, 0x0F172A, 0.55);
      this.bodyGfx.strokeCircle(0, 0, RADIUS);
      this.art.add(this.bodyGfx);

      this.decorGfx = this.scene.add.graphics();
      this.buildDecor(this.decorGfx, palette);
      this.art.add(this.decorGfx);

      // ---- 头顶血条 ----
      this.hpBg = this.scene.add.graphics();
      this.hpFill = this.scene.add.graphics();
      this.redrawHpBar();

      // ---- 瞄准准星（虚线圆，第 5 步） ----
      this.aimRing = this.scene.add.graphics();
      this.aimRing.lineStyle(3, 0xFFFFFF, 0.9);
      drawDashedCircle(this.aimRing, AIM_RING_R, 16, 0.45);
      this.aimRing.setVisible(false);

      this.teamTag = this.scene.add.text(0, HP_BAR.y - 14, ally ? '己方' : '敌方', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '13px',
        fontStyle: 'bold',
        color: palette.css || (ally ? '#93C5FD' : '#FCA5A5'),
        stroke: '#0B1220',
        strokeThickness: 5
      });
      if (typeof this.teamTag.setOrigin === 'function') { this.teamTag.setOrigin(0.5, 1); }

      this.add([this.teamRing, this.hoverRing, this.aimRing, this.art,
        this.hpBg, this.hpFill, this.teamTag]);
    }

    /**
     * 装饰图形（子类覆盖：皇冠 / 墨镜 / 果柄 / 葡萄粒……）
     * 基类默认画一个小圆点，保证任何单位至少有可辨认的细节
     * @param {Phaser.GameObjects.Graphics} g
     * @param {Object} palette 阵营配色
     */
    buildDecor(g, palette) {
      g.fillStyle(palette.light, 0.9);
      g.fillCircle(0, -RADIUS * 0.45, 4);
    }

    /** 身体填充色（子类可覆盖做深浅区分） */
    getBodyColor() {
      return this.getTeamPalette().fill;
    }

    /** 当前阵营配色 */
    getTeamPalette() {
      return TEAM_COLORS[this.team] || TEAM_COLORS.blue;
    }

    /** 是否为玩家可操控阵营（默认蓝色方） */
    isPlayerControlled() {
      const pt = (FK.Config && FK.Config.VICTORY && FK.Config.VICTORY.playerTeam)
        ? FK.Config.VICTORY.playerTeam : 'blue';
      return this.team === pt;
    }

    /** 重绘血条（阵营色底框 + 绿条，长度随血量变化） */
    redrawHpBar() {
      if (!this.hpBg || !this.hpFill) { return; }

      const w = HP_BAR.w;
      const h = HP_BAR.h;
      const y = HP_BAR.y;
      const palette = this.getTeamPalette();

      this.hpBg.clear();
      this.hpBg.fillStyle(0x0B1220, 0.92);
      this.hpBg.fillRoundedRect(-w / 2 - 2, y - 2, w + 4, h + 4, 3);
      this.hpBg.lineStyle(2, palette.fill, 1);
      this.hpBg.strokeRoundedRect(-w / 2 - 2, y - 2, w + 4, h + 4, 3);

      const ratio = this.getHpRatio();
      this.hpFill.clear();
      if (ratio > 0) {
        const color = ratio > 0.5 ? 0x22C55E : (ratio > 0.25 ? 0xFACC15 : 0xEF4444);
        this.hpFill.fillStyle(color, 1);
        this.hpFill.fillRoundedRect(-w / 2, y, Math.max(2, w * ratio), h, 2);
      }
    }

    /* ==================================================================
     * 物理
     * ================================================================== */

    /** 创建 Arcade 静态体（本步不参与碰撞，仅供后续步骤使用） */
    buildPhysics() {
      if (!this.scene || !this.scene.physics || !this.scene.physics.add) { return null; }

      this.scene.physics.add.existing(this, true);          // true = 静态体
      if (this.body) {
        this.body.setSize(RADIUS * 2, RADIUS * 2);
        this.body.position.set(this.x - RADIUS, this.y - RADIUS);
        if (typeof this.body.updateCenter === 'function') { this.body.updateCenter(); }
      }
      return this.body;
    }

    /* ==================================================================
     * 状态切换
     * ================================================================== */

    /**
     * 设置选中状态
     * @param {boolean} v
     * @returns {UnitBase} this
     */
    setSelected(v) {
      this.selected = !!v;

      const pulseTarget = this.teamRing || this.selectRing;
      if (this.selected && this.scene && this.scene.tweens && pulseTarget) {
        if (this.pulseTween) { this.pulseTween.stop(); }
        pulseTarget.setAlpha(1);
        this.pulseTween = this.scene.tweens.add({
          targets: pulseTarget,
          alpha: { from: 1, to: 0.45 },
          duration: 620,
          yoyo: true,
          repeat: -1
        });
      } else if (this.pulseTween) {
        this.pulseTween.stop();
        this.pulseTween = null;
        if (pulseTarget) { pulseTarget.setAlpha(1); }
      }
      // 选中时隐藏悬停描边，避免两个圈重叠
      if (this.hoverRing) { this.hoverRing.setVisible(this.hovered && !this.selected); }
      this.refreshArtTransform();
      return this;
    }

    /**
     * 设置悬停状态（描边 + 轻微放大）
     * @param {boolean} v
     * @returns {UnitBase} this
     */
    setHovered(v) {
      this.hovered = !!v;

      if (this.hoverRing) { this.hoverRing.setVisible(this.hovered && !this.selected); }
      this.refreshArtTransform();
      return this;
    }

    /**
     * 设置瞄准状态（第 5 步）
     *   视觉：美术轻微缩小（后仰）+ 周围出现一圈虚线准星
     *   不影响选中与悬停状态：三者由 refreshArtTransform() 统一裁决优先级
     * @param {boolean} v
     * @returns {UnitBase} this
     */
    setAiming(v) {
      this.aiming = !!v;

      if (this.aimRing) { this.aimRing.setVisible(this.aiming); }
      this.refreshArtTransform();
      return this;
    }

    /** 是否正在瞄准 */
    isAiming() { return this.aiming; }

    /**
     * 统一裁决美术容器的形变
     * 优先级：瞄准 > 悬停 > 常态
     */
    refreshArtTransform() {
      if (!this.art) { return; }

      if (this.aiming) {
        this.art.setScale(AIM_SCALE);
        this.art.setAlpha(1);
        this.art.y = 3;                       // 轻微后仰
      } else if (this.hovered) {
        this.art.setScale(HOVER_SCALE);
        this.art.setAlpha(1);
        this.art.y = 0;
      } else {
        this.art.setScale(1);
        this.art.setAlpha(0.96);
        this.art.y = 0;
      }
    }

    /* ==================================================================
     * 血量
     * ================================================================== */

    /** 当前血量 */
    getHp() { return this.hp; }

    /** 最大血量 */
    getMaxHp() { return this.maxHp; }

    /** 血量比例 0～1 */
    getHpRatio() {
      if (!this.maxHp || this.maxHp <= 0) { return 0; }
      return Math.max(0, Math.min(1, this.hp / this.maxHp));
    }

    /**
     * 扣血并刷新血条。
     * 注意：本步只扣血与刷新血条 + 受击闪白，**不做死亡判定**（第 8 步实现）。
     * @param {number} amount 伤害值，非正数会被忽略
     * @returns {number} 扣血后的当前血量
     */
    takeDamage(amount) {
      const n = (typeof amount === 'number' && isFinite(amount)) ? amount : 0;
      if (n <= 0) { return this.hp; }

      this.hp = Math.max(0, this.hp - n);
      this.redrawHpBar();
      this.flashHit();

      if (FK.EventBus && FK.EVENTS && FK.EVENTS.UNIT_DAMAGED) {
        FK.EventBus.emit(FK.EVENTS.UNIT_DAMAGED, {
          id: this.unitId, team: this.team, amount: n,
          hp: this.hp, maxHp: this.maxHp, unit: this
        });
      }
      return this.hp;
    }

    /* ==================================================================
     * 第 6 步：击退与存活查询
     *   本步只做「沿击退方向快速位移」的视觉与运动表现，
     *   不做落水判定、不做死亡移除（第 8 步）。
     * ================================================================== */

    /**
     * 第 7.10 步：推进这一帧的水平位移，撞到木箱 / 墙体时按弹性碰撞弹回。
     *
     * 碰撞世界由场景注入（`setBounceWorld(provider)`）：
     *   provider() → { rects: [木箱 AABB], bounds: { left, right, type } }
     * 未注入时退化为原来的「纯位移 + 边界钳制」，因此自检 / 单元测试可以脱场景运行。
     *
     * @param {number} stepX 这一帧的水平位移（px，右为正）
     * @param {number} dt    这一帧的秒数
     * @returns {boolean} 本帧是否发生了弹回
     */
    pinToSupportEdge() {
      const P = FK.KnockbackPhysics;
      if (!P || typeof P.bounceSupportEdge !== 'function') { return false; }
      const world = (typeof this.bounceWorldProvider === 'function')
        ? (this.bounceWorldProvider(this) || {})
        : {};
      const radius = (typeof this.getCollisionRadius === 'function') ? this.getCollisionRadius() : 24;
      const pin = P.bounceSupportEdge({
        x: this.x, vx: this.knockbackVx, halfWidth: radius, y: this.y, bodyHeight: radius * 2,
        priorBounceCount: this.bounceCount || 0
      }, world);
      if (!pin || !pin.bounced) { return false; }
      this.x = pin.x;
      this.knockbackVx = pin.vx;
      this.airborne = false;
      this.grounded = true;
      this.onBounced(pin);
      this.syncBody();
      return true;
    }

    stepHorizontalBounce(stepX, dt) {
      const res = this.stepHorizontalWithVx(stepX, this.knockbackVx, dt);
      this.knockbackVx = res.vx;
      if (res.bounced) { this.onBounced(res); }
      return !!res.bounced;
    }

    /**
     * 第 8.5 步：通用水平弹性推进（不改击退状态，速度由调用方持有）。
     *   击退滑行（stepHorizontalBounce）与主动移动（stepActiveMove）共用它，
     *   因此「撞木箱 / 撞墙弹回」两处只有一份物理。
     * @param {number} stepX 本步水平位移（px）
     * @param {number} vx 本步行进方向上的速度（px/s，用于反弹计算）
     * @param {number} dt 本步秒数
     * @returns {{x:number, vx:number, bounced:boolean, bounceCount:number, hits:Array, mode:string}}
     */
    stepHorizontalWithVx(stepX, vx, dt) {
      const P = FK.KnockbackPhysics;
      const curVx = (typeof vx === 'number' && isFinite(vx)) ? vx : 0;

      if (!P || typeof P.stepHorizontal !== 'function') {
        this.x += stepX || 0;
        return { x: this.x, vx: curVx, bounced: false, bounceCount: 0, hits: [], mode: 'none' };
      }
      // 空中 / 主动跳跃：即使本帧水平位移为 0，也要做平台侧面重叠推回
      if (!stepX && !this.airborne && !this.moving) {
        return { x: this.x, vx: curVx, bounced: false, bounceCount: 0, hits: [], mode: 'none' };
      }

      // 第 8.10 步：把单位本身传给 provider —— 场景据此决定是否把「地形平台侧面」
      // 加入横向碰撞（只对空中的单位加，站在台上滑行 / 跳跃沿用旧口径）。
      const world = (typeof this.bounceWorldProvider === 'function')
        ? (this.bounceWorldProvider(this) || {})
        : {};
      // 必须用碰撞半径，不能用鼠标拾取半径（28）：预览 halfWidth=24，实飞若用 28 会提前撞墙/台
      const radius = (typeof this.getCollisionRadius === 'function') ? this.getCollisionRadius() : 24;
      const res = P.stepHorizontal({
        x: this.x,
        vx: curVx,
        stepPx: stepX || 0,
        halfWidth: radius,
        y: this.y,
        bodyHeight: radius * 2,
        pinToSupport: false,
        priorBounceCount: this.moving ? (this.moveBounces || 0) : (this.bounceCount || 0)
      }, dt, world);
      this.x = (typeof res.x === 'number' && isFinite(res.x)) ? res.x : (this.x + (stepX || 0));
      return {
        x: this.x,
        vx: (typeof res.vx === 'number' && isFinite(res.vx)) ? res.vx : curVx,
        bounced: !!res.bounced,
        bounceCount: res.bounceCount || 0,
        hits: res.hits || [],
        mode: res.mode || ''
      };
    }

    /**
     * 弹回回调（默认只做记录 + 受击闪白；后续要做音效 / 烟尘时在这里接）。
     * @param {Object} res KnockbackPhysics.stepHorizontal 的返回值
     */
    onBounced(res) {
      this.bounceCount = (this.bounceCount || 0) + (res.bounceCount || 1);
      this.lastBounce = {
        count: res.bounceCount || 1,
        hits: (res.hits || []).slice(),
        vx: this.knockbackVx,
        x: this.x,
        turnNumber: this.lastBounceTurn || 0
      };
      this.flashHit();
    }

    /** 本帧是否处于「贴住碰撞面」状态（HUD / 自检用） */
    isBouncing() { return !!this.bounceCount && this.knockbackVx !== 0; }

    /** 累计弹回次数 */
    getBounceCount() { return this.bounceCount || 0; }

    /** 最近一次弹回信息（含撞到的是木箱还是墙） */
    getLastBounce() { return this.lastBounce || null; }

    /** 清空弹回统计（每次新的击退 / 回合开始时调用） */
    resetBounceStats() {
      this.bounceCount = 0;
      this.lastBounce = null;
      this.landBounceCount = 0;
      this.landSlideApplied = false;
      return this;
    }

    /**
     * 注入碰撞世界提供者（BattleScene 在创建单位后调用）。
     * @param {Function} provider () => { rects, bounds }
     */
    setBounceWorld(provider) {
      this.bounceWorldProvider = (typeof provider === 'function') ? provider : null;
      return this;
    }

    /** 是否已注入碰撞世界 */
    hasBounceWorld() { return typeof this.bounceWorldProvider === 'function'; }

    /* ==================================================================
     * 第 8 步：支撑面（落地 / 掉下平台 → 落水）
     * ================================================================== */

    /**
     * 注入支撑面提供者（BattleScene 在创建单位后调用）。
     * @param {Function} provider (x, y) => 支撑面顶面 y（像素）| null
     * @returns {UnitBase} this
     */
    setSupportProvider(provider) {
      this.supportProvider = (typeof provider === 'function') ? provider : null;
      return this;
    }

    /** 是否已注入支撑面数据 */
    hasSupportProvider() { return typeof this.supportProvider === 'function'; }

    /**
     * 当前 x 处的支撑面顶面 y（像素）；没有支撑面返回 null。
     * 未注入 provider 时返回 null（调用方会走旧的 groundY 分支）。
     */
    querySupportY() {
      if (typeof this.supportProvider !== 'function') { return null; }
      const v = this.supportProvider(this.x, this.y);
      return (typeof v === 'number' && isFinite(v)) ? v : null;
    }

    /* ==================================================================
     * 第 8 步：落水 / 死亡
     * ================================================================== */

    /** 碰撞半径（= 碰撞盒半宽 / 半高；与 buildPhysics 的 48×48 碰撞盒一致） */
    getCollisionRadius() { return RADIUS; }

    /** 碰撞盒底部 y（落水判定用：底部越过水面即落水） */
    getBottomY() { return this.y + RADIUS; }

    /**
     * 是否已落水
     * @param {number} waterLevelY 水面像素 y（来自 data/map.json → waterLevel）
     */
    isBelowWater(waterLevelY) {
      if (typeof waterLevelY !== 'number' || !isFinite(waterLevelY)) { return false; }
      return this.getBottomY() > waterLevelY;
    }

    /**
     * 标记死亡（由 FK.DeathSystem 调用；本方法只负责单位自身状态的收尾）。
     * 「谁死了 / 什么死因」由 DeathSystem 裁决，这里不重复判定。
     * @param {string} [reason] 'hp_zero' | 'drowned'
     * @returns {string} 死因
     */
    markDead(reason) {
      this.alive = false;
      this.deadReason = reason || 'hp_zero';
      // 落水 / 死亡瞬间冻结击退：不再滑行，动画在原地播放
      if (this.freezeOnDeath !== false) {
        this.knockbackVx = 0;
        this.knockbackVy = 0;
        this.airborne = false;
      }
      // 第 8.5 步：移动途中死亡（例如跳到果汁池上方落水）同样立即停住
      if (this.moving) { this.finishActiveMove('died'); }
      if (this.selected) { this.setSelected(false); }
      if (this.hovered) { this.setHovered(false); }
      if (this.aiming) { this.setAiming(false); }
      return this.deadReason;
    }

    /** 死因（未死亡时为空串） */
    getDeadReason() { return this.deadReason || ''; }

    /**
     * 复活 / 重置到出生点（「再来一局」用）
     * @param {Object} [spawnPoint] 缺省用创建时记录的出生点
     * @returns {UnitBase} this
     */
    revive(spawnPoint) {
      const sp = spawnPoint || this.spawnPoint || null;
      if (sp) {
        this.spawnPoint = sp;
        if (typeof this.setPosition === 'function') {
          this.setPosition(numOr(sp.worldX, this.x), numOr(sp.worldY, this.y));
        } else {
          this.x = numOr(sp.worldX, this.x);
          this.y = numOr(sp.worldY, this.y);
        }
      }
      this.hp = this.maxHp;
      this.alive = true;
      this.deadReason = null;
      this.knockbackVx = 0;
      this.knockbackVy = 0;
      this.airborne = false;
      this.grounded = true;
      this.groundY = null;
      this.hitFlashMs = 0;
      // 第 8.5 步：清掉主动移动残留（重开对局时单位不会「还在飞」）
      this.moving = false;
      this.moveVx = 0;
      this.moveVy = 0;
      this.moveBounces = 0;
      this.lastMoveBounce = null;
      this.moveEndReason = null;
      this.moveTargetY = null;
      this.resetBounceStats();
      this.setSelected(false);
      this.setHovered(false);
      this.setAiming(false);
      if (typeof this.setAlpha === 'function') { this.setAlpha(1); }
      if (typeof this.setScale === 'function') { this.setScale(1); }
      if (typeof this.setVisible === 'function') { this.setVisible(true); }
      if (this.art && typeof this.art.setScale === 'function') { this.art.setScale(1); }
      if (this.art && typeof this.art.setAlpha === 'function') { this.art.setAlpha(0.96); }
      this.redrawHpBar();
      this.syncBody();
      return this;
    }

    /**
     * 施加一次击退（爆炸由 DamageSystem 计算好速度后调用）
     * @param {number} dx 水平击退速度（px/s，右为正）
     * @param {number} dy 垂直击退速度（px/s，向上为负）
     * @returns {UnitBase} this
     */
    applyKnockback(dx, dy) {
      const D = (FK.Config && FK.Config.DAMAGE) ? FK.Config.DAMAGE : null;
      const maxSpeed = D ? D.maxKnockSpeed : 700;
      // 第 8 步：死亡单位不再接受任何击退（落水死亡不触发击退）
      if (!this.isAlive()) { return this; }
      let vx = (typeof dx === 'number' && isFinite(dx)) ? dx : 0;
      let vy = (typeof dy === 'number' && isFinite(dy)) ? dy : 0;

      /**
       * 第 8.8 步：**保证击退一定把单位抛到空中**（FK.Config.KNOCKBACK.minUpSpeed）。
       *
       * 旧行为：垂直分量完全由「径向 + upKick」决定，爆心在单位上方 / 同高时可能 ≥ 0，
       * 于是 applyKnockback 之后第一帧 landOnSupport 就判定落地（airborne = false），
       * 重力随之失效 —— 单位只剩水平阻尼滑行，滑到速度耗尽才「竖直掉下来」，
       * 看起来就是两段动画拼在一起（先平飞、再直落）。
       * 补一个向上初速度后，整个击退就是一条同时含水平与垂直分量的抛物线。
       */
      const K = (FK.Config && FK.Config.KNOCKBACK) ? FK.Config.KNOCKBACK : null;
      const minUp = (K && typeof K.minUpSpeed === 'number') ? K.minUpSpeed : 0;
      if (vy > -minUp) { vy = -minUp; }

      // 推力上限：防止多次叠加把单位瞬移出图
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > maxSpeed) {
        const k = maxSpeed / speed;
        vx *= k;
        vy *= k;
      }

      // 击退抗性：>1 更难被推动
      const resist = (typeof this.knockbackResist === 'number' && this.knockbackResist > 0)
        ? this.knockbackResist : 1.0;
      /**
       * 第 8.7 步修复（悬空 bug 的第二个成因）：必须**先**中断主动移动，**再**写入击退速度。
       * finishActiveMove() 会把 airborne / knockbackVx / knockbackVy 一起清零，
       * 旧顺序（先赋速度、后 finishActiveMove）会让「跳跃中被炸飞」的单位
       * 击退被整段抹掉，于是原地停在半空、再也不落地。
       */
      if (this.moving) { this.finishActiveMove('knockback'); }

      this.knockbackVx = vx / resist;
      this.knockbackVy = vy / resist;

      this.resetBounceStats();
      this.knockAccMs = 0;
      this.groundY = (typeof this.supportProvider === 'function') ? this.knockbackBaseY() : this.y;
      this.airborne = true;
      this.grounded = false;
      this.flashHit();
      return this;
    }

    /** 是否还有击退速度在生效（自检 / HUD 用） */
    isKnockbackActive() {
      return this.knockbackVx !== 0 || this.knockbackVy !== 0 || this.airborne;
    }

    /** 当前击退速度快照 */
    getKnockbackVelocity() {
      return { vx: this.knockbackVx, vy: this.knockbackVy };
    }

    /** 击退抗性倍率（1.0 = 标准） */
    getKnockbackResist() { return this.knockbackResist; }

    /**
     * 是否存活。
     * 注意：第 6 步不做死亡判定与移除，hp 归零的单位仍留在场上（第 8 步处理）。
     * @returns {boolean}
     */
    isAlive() {
      return this.alive !== false && this.hp > 0;
    }

    /** 受击闪白（表现层；不改变任何数值） */
    flashHit() {
      this.hitFlashMs = 150;
      if (this.art && typeof this.art.setAlpha === 'function') { this.art.setAlpha(1); }
    }

    /** 受击闪白计时衰减（update 中调用） */
    updateHitFlash(deltaMs) {
      this.hitFlashMs = Math.max(0, this.hitFlashMs - deltaMs);
    }

    /**
     * 把单位钳制在竞技场内（第 6 步的兜底保护：任何位移都不允许把单位推出地图）。
     *
     * 第 8.5 步调整：
     *   · 主动移动中（moving）横向边界交给 MoveController 的弹性弹回处理，
     *     这里只做位置钳制、不清零速度，避免「贴墙那一帧被清零」导致弹回失效；
     *   · 其余情况（击退 / 静止）行为与第 8 步完全一致。
     */
    clampToArena() {
      if (!FK.Config || !FK.Config.ARENA) { return; }
      const b = (typeof FK.Config.mapBoundsPx === 'function')
        ? FK.Config.mapBoundsPx()
        : null;
      const A = FK.Config.ARENA;
      const ppx = FK.Config.PX_PER_UNIT;
      const minX = b ? b.left : A.offsetX;
      const maxX = b ? b.right : (A.offsetX + A.widthUnits * ppx);
      const minY = b ? b.top : A.offsetY;
      const maxY = b ? b.bottom : (A.offsetY + A.heightUnits * ppx);
      // 移动中不横向钳制速度（弹性弹回优先）；位置仍然钳制，单位不会跑出世界
      const keepVx = !!this.moving;

      if (this.x < minX) { this.x = minX; if (!keepVx) { this.knockbackVx = 0; } }
      if (this.x > maxX) { this.x = maxX; if (!keepVx) { this.knockbackVx = 0; } }
      if (this.y < minY) { this.y = minY; this.knockbackVy = 0; }
      if (this.y > maxY) { this.y = maxY; this.knockbackVy = 0; }
      // 移动中同步位置钳制回移动速度所在的口径（避免外层继续用旧坐标推算）
      if (keepVx) {
        if (this.x <= minX && this.moveVx < 0) { this.moveVx = 0; }
        if (this.x >= maxX && this.moveVx > 0) { this.moveVx = 0; }
      }
    }

    /** 同步 Arcade 静态碰撞体的位置（本步不参与碰撞，仅保持数据一致） */
    syncBody() {
      if (!this.body || !this.body.position) { return; }
      this.body.position.set(this.x - RADIUS, this.y - RADIUS);
      if (typeof this.body.updateCenter === 'function') { this.body.updateCenter(); }
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /** 阵营（'blue' / 'red'） */
    getTeam() { return this.team; }

    /** 单位 id（与 data/units.json 一致） */
    getId() { return this.unitId; }

    /** 中文显示名 */
    getDisplayName() {
      return (this.config && this.config.name) ? this.config.name : this.unitId;
    }

    /** 鼠标拾取半径 */
    getHitRadius() { return HIT_RADIUS; }

    /**
     * 判断某个世界坐标是否落在本单位身上
     * @param {number} px
     * @param {number} py
     */
    containsPoint(px, py) {
      const dx = px - this.x;
      const dy = py - this.y;
      return (dx * dx + dy * dy) <= (HIT_RADIUS * HIT_RADIUS);
    }

    /** 状态摘要（日志 / 调试用） */
    describe() {
      return 'Unit(' + this.unitId + ', ' + this.getDisplayName() + ', team=' + this.team +
        ', hp=' + this.hp + '/' + this.maxHp + ', pos=' + Math.round(this.x) + ',' + Math.round(this.y) + ')';
    }
  }

  /**
   * 取数字，非法时回退默认值（只用于表现层兜底）
   * @param {*} v
   * @param {number} def
   * @returns {number}
   */
  function numOr(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  /**
   * 单轴恒定阻尼衰减（第 6 步）
   *   速度按 drag（px/s²）线性下降到 0，不会反向加速。
   *   v' = sign(v) × max(0, |v| − drag × dt)
   * @param {number} v 当前速度（px/s）
   * @param {number} drag 阻尼（px/s²）
   * @param {number} dt 时间步长（秒）
   * @returns {number} 衰减后的速度
   */
  function dampAxis(v, drag, dt) {
    const a = Math.abs(v) - drag * dt;
    if (a <= 0) { return 0; }
    return (v < 0 ? -a : a);
  }

  UnitBase.TEAM_COLORS = Object.freeze(TEAM_COLORS);
  UnitBase.RADIUS = RADIUS;
  UnitBase.HIT_RADIUS = HIT_RADIUS;
  UnitBase.HP_BAR = Object.freeze(HP_BAR);
  /** 暴露阻尼函数，供自检与后续步骤（AI 预判位移）复用 */
  UnitBase.dampAxis = dampAxis;

  FK.UnitBase = UnitBase;
})();
