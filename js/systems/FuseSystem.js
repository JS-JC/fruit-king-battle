/**
 * ============================================================
 * FuseSystem.js —— 引信与落水判定（第 7 步从 ProjectileController 拆出）
 * ============================================================
 * 职责（只做「落地之后、爆炸之前」这一段）：
 *   ① 落地语义裁决：这次落地该「点火爆炸」还是「落水销毁」
 *   ② 引信倒计时：落地当帧不计入，保证 ItemConfig.fuseOnHitMs 足额
 *   ③ 落水销毁：广播 projectile:removed(reason='water') 后交给回合桥推进
 *
 * 为什么单独拆出来：
 *   第 6 步的 ProjectileController 同时管「飞行 / 引信 / 爆炸 / 结算 / 回合流转」，
 *   第 7 步又加了「落水即销毁」这条分支，再堆下去会变成一个什么都知道的上帝类。
 *   拆开之后：
 *     · FuseSystem        —— 只回答「什么时候炸 / 要不要炸」
 *     · TurnFlowBridge    —— 只回答「现在允不允许投 / 结算完怎么推进回合」
 *     · ProjectileController —— 只做编排（飞行推进 + 把上面两个的结论发给世界）
 *   三者都是**纯逻辑对象**，不引用 Phaser，可在 Node 里单独跑。
 *
 * 引信计时的两条硬规则（第 6 步验证过、第 7 步保持不变）：
 *   · 落地当帧只做「上膛」，不扣时间——否则 50ms 引信会被落地那一帧的 delta 吃掉一截；
 *   · fuseMs ≤ 0 的道具视为瞬时引爆，不进入等待分支。
 *
 * 依赖：无（FK.Config 仅用于读取默认值，缺失时全部走本地兜底）
 * 对外：FK.FuseSystem
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 引信阶段枚举（ProjectileController.status.phase 与它一一对应） */
  const PHASE = {
    IDLE: 'idle',
    FLYING: 'flying',
    FUSE: 'fuse',
    SUNK: 'sunk',
    EXPLODING: 'exploding',
    RESOLVED: 'resolved',
    ABORTED: 'aborted'
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class FuseSystem {

    /**
     * @param {Object} [opts]
     *   controller        FK.ProjectileController 实例（回调爆炸 / 落水 / 状态）
     *   turnFlow          FK.TurnFlowBridge 实例（落水后推进回合）
     *   fuseMs            默认引信时长（道具未提供时的兜底）
     *   waterSplashMs     落水销毁的结算缓冲（毫秒）
     *   destroyOnWater    落水是否直接销毁（默认取 FK.Config.PROJECTILE.destroyOnWater）
     *   eventBus          事件总线（缺省 FK.EventBus）
     */
    constructor(opts) {
      opts = opts || {};
      const P = (FK.Config && FK.Config.PROJECTILE) ? FK.Config.PROJECTILE : {};

      this.controller = opts.controller || null;
      this.turnFlow = opts.turnFlow || null;
      this.eventBus = opts.eventBus || FK.EventBus || null;

      this.defaultFuseMs = num(opts.fuseMs, 50);
      this.waterSplashMs = num(opts.waterSplashMs, num(P.waterSplashMs, 140));
      this.destroyOnWater = (opts.destroyOnWater === undefined)
        ? (P.destroyOnWater !== false) : !!opts.destroyOnWater;

      /** 剩余引信（毫秒） */
      this.remainMs = 0;
      /** 是否已上膛（落地当帧为 false，下一帧才开始扣时间） */
      this.armed = false;
      /** 落地当帧的一次性跳过标记（防止落地帧的 delta 吃掉引信） */
      this.skipNextTick = false;
      /** 是否已经引爆过（防止重复引爆） */
      this.exploded = false;
      /** 是否已经落水销毁（防止重复销毁） */
      this.sunk = false;
      /** 当前引信时长快照（HUD / 自检用） */
      this.fuseMs = this.defaultFuseMs;
      /** 统计 */
      this.stats = { armed: 0, exploded: 0, sunk: 0, instant: 0 };
    }

    /* ==================================================================
     * 落地裁决
     * ================================================================== */

    /** 该落地类型是否属于「落水销毁」 */
    isWaterHit(landing) {
      return !!(landing && landing.hitType === 'water');
    }

    /**
     * 落地处理（由 ProjectileController.onLanded 调用）
     * @param {FK.Projectile} proj 已落地的投掷物
     * @param {Object} landing { x, y, hitType, hitTarget }
     * @returns {{action:'explode'|'sunk'|'fuse', fuseMs:number}} 结论（便于自检与日志）
     */
    onLanded(proj, landing) {
      if (!proj) { return { action: 'none', fuseMs: 0 }; }

      // ---- ① 落水：直接销毁，不触发爆炸（第 7 步规则） ----
      if (this.destroyOnWater && this.isWaterHit(landing)) {
        this.sink(proj, landing);
        return { action: 'sunk', fuseMs: 0 };
      }

      // ---- ② 点火：先让道具模块看到这次落地，再进入引信等待 ----
      // 顺序与第 6 步一致：onLand 一定在 onExplode 之前被调用
      //（水果箱就是靠 onLand 生成障碍物的，绝不能漏）
      if (this.controller && typeof this.controller.notifyLandModule === 'function') {
        this.controller.notifyLandModule(proj, landing, false);
      }

      this.armed = true;
      /**
       * 落地当帧不扣引信：置一次性标记，让紧随其后的那次 tick 只「跳过」不扣时间。
       * 否则「50ms 引信」会被落地那一帧的 delta 白白吃掉一部分（第 6 步踩过的坑）。
       */
      this.skipNextTick = true;
      this.exploded = false;
      this.sunk = false;
      this.fuseMs = Math.max(0, num(
        (typeof proj.getFuseMs === 'function') ? proj.getFuseMs() : proj.fuseMs,
        this.defaultFuseMs));
      this.remainMs = this.fuseMs;
      this.stats.armed += 1;

      // 引信为 0 → 瞬时引爆（不进等待分支）
      if (this.fuseMs <= 0) {
        this.stats.instant += 1;
        this.explode(proj, 'instant');
        return { action: 'explode', fuseMs: 0 };
      }

      this.setStatus(PHASE.FUSE, '引信中', Math.round(this.remainMs));
      this.log(proj, '落地：' + (landing ? landing.hitType : '?') + ' @(' +
        Math.round(num(landing && landing.x, proj.pos.x)) + ',' +
        Math.round(num(landing && landing.y, proj.pos.y)) + ')，引信 ' + this.remainMs + 'ms');
      return { action: 'fuse', fuseMs: this.fuseMs };
    }

    /* ==================================================================
     * 每帧推进
     * ================================================================== */

    /**
     * 引信倒计时（由 ProjectileController.update 每帧调用）
     * @param {number} deltaMs
     * @param {FK.Projectile} proj 当前投掷物（必须已落地）
     * @returns {boolean} 本帧是否触发了引爆
     */
    tick(deltaMs, proj) {
      if (!proj || this.exploded || this.sunk) { return false; }
      if (!this.armed) { return false; }               // 还没落地
      if (this.skipNextTick) {                          // 落地当帧：只跳过，不扣时间
        this.skipNextTick = false;
        return false;
      }
      if (typeof proj.hasLanded === 'function' && !proj.hasLanded()) { return false; }
      if (typeof proj.isRemoved === 'function' && proj.isRemoved()) { return false; }

      this.remainMs -= Math.max(0, num(deltaMs, 0));
      if (this.remainMs <= 0) {
        this.setStatus(PHASE.FUSE, '引信中', 0);
        this.explode(proj, 'fuse');
        return true;
      }
      this.setStatus(PHASE.FUSE, '引信中', Math.round(this.remainMs));
      return false;
    }

    /* ==================================================================
     * 两个出口：爆炸 / 落水销毁
     * ================================================================== */

    /** 引爆（交给控制器完成移除 + 表现 + 结算） */
    explode(proj, reason) {
      if (this.exploded || this.sunk) { return false; }
      this.exploded = true;
      this.armed = false;
      this.remainMs = 0;
      this.stats.exploded += 1;
      if (this.controller && typeof this.controller.explodeCurrent === 'function') {
        return this.controller.explodeCurrent(reason || 'fuse');
      }
      return false;
    }

    /**
     * 落水销毁：无爆炸、无伤害、无击退，只把投掷物从场景移除
     * @param {FK.Projectile} proj
     * @param {Object} landing
     */
    sink(proj, landing) {
      if (this.sunk || this.exploded) { return false; }
      this.sunk = true;
      this.armed = false;
      this.remainMs = 0;
      this.stats.sunk += 1;
      this.setStatus(PHASE.SUNK, '落水销毁');

      const c = this.controller;
      if (c) {
        // 让道具模块看到这次「没有爆炸的落地」（模块可据此决定沉没表现）
        if (typeof c.resolveWaterLanding === 'function') {
          c.resolveWaterLanding(proj, landing);
        } else if (typeof c.cleanupProjectile === 'function') {
          c.cleanupProjectile('water');
        }
      }

      this.log(proj, '落入果汁池 → 直接销毁（不爆炸）@(' +
        Math.round(num(landing && landing.x, proj.pos.x)) + ',' +
        Math.round(num(landing && landing.y, proj.pos.y)) + ')');

      // 没有爆炸演出，但仍然走「结算缓冲 → 推进回合」这一条唯一出口，保证不卡回合
      if (this.turnFlow && typeof this.turnFlow.beginResolve === 'function') {
        this.turnFlow.beginResolve(this.waterSplashMs);
      }
      return true;
    }

    /* ==================================================================
     * 复位与查询
     * ================================================================== */

    /** 新回合 / 新一次投掷前复位 */
    reset() {
      this.remainMs = 0;
      this.armed = false;
      this.skipNextTick = false;
      this.exploded = false;
      this.sunk = false;
      return this;
    }

    /** 是否正在等引信 */
    isPending() { return this.armed && !this.exploded && !this.sunk; }

    /** 剩余引信（毫秒） */
    getRemainMs() { return Math.max(0, Math.round(this.remainMs)); }

    /** 引信时长快照 */
    getFuseMs() { return this.fuseMs; }

    /** 统计快照 */
    getStats() {
      return {
        armed: this.stats.armed,
        exploded: this.stats.exploded,
        sunk: this.stats.sunk,
        instant: this.stats.instant
      };
    }

    /* ---------------- 内部 ---------------- */

    setStatus(phase, label, detail) {
      const c = this.controller;
      if (c && typeof c.setStatus === 'function') { c.setStatus(phase, label, detail); }
      return this;
    }

    log(proj, msg) {
      const c = this.controller;
      const itemId = (proj && proj.itemId) ? proj.itemId : '?';
      if (c && typeof c.log === 'function') { c.log('[' + itemId + '] ' + msg); }
    }
  }

  FuseSystem.PHASE = Object.freeze(PHASE);

  FK.FuseSystem = FuseSystem;
})();
