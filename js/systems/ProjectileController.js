/**
 * ============================================================
 * ProjectileController.js —— 投掷控制器（第 6 步新增）
 * ============================================================
 * 职责：
 *   把「瞄准松手」到「爆炸结算完成」这条链路串起来，是投掷链路的**编排者**。
 *
 *   aim:end ──► 取瞄准确认的初速度与道具
 *            ──► TurnFlowBridge 请求进入 PROJECTILE_FLYING
 *            ──► itemRegistry 取道具模块 → module.onThrow(ctx)
 *   每帧     ──► projectile.step(dt)（复用 TrajectoryPredictor 的积分与碰撞）
 *   落地     ──► FuseSystem 裁决：点火等引信？还是落水直接销毁？
 *            ──► module.onLand(ctx) → module.onExplode(ctx)
 *                  · 创建 Explosion 爆炸演出
 *                  · 调 DamageSystem 结算伤害与击退（广播 damage:applied / unit:knockback）
 *            ──► TurnFlowBridge 广播 turn:projectileResolved
 *            ──► TurnManager 进入 RESOLVING →（自动）TURN_END → SWITCH_TEAM
 *
 * 第 7 步拆分（对外接口与行为完全不变）：
 *   ┌──────────────────────── ProjectileController（本文件）────────────────────────┐
 *   │  只管编排：飞行推进、碰撞结果分发、表现创建、调用两个子系统                  │
 *   └───────┬───────────────────────────────────────────────┬─────────────────────┘
 *           │                                               │
 *   FK.FuseSystem                                    FK.TurnFlowBridge
 *   落地裁决 / 引信倒计时 / 落水销毁                  状态查询 / 流转路径 BFS /
 *                                                    thrownThisTurn / 结算兜底窗口
 *
 *   拆开的好处：第 8 步接入胜负判定只改 TurnFlowBridge，第 9 步调引信手感只改 FuseSystem，
 *   本文件不必再被打开。三个类都不依赖 Phaser，可在 Node 里各自单测。
 *
 * 防卡回合（三层保险，全部保留）：
 *   ① 投掷物有飞行硬上限 maxFlightMs，超时视为 timeout 落地并爆炸；
 *   ② TurnFlowBridge 的 resolveTimeoutMs 兜底，爆炸演出未按时结束也会强制结算；
 *   ③ TurnManager 原有保护：PROJECTILE_FLYING 8s → RESOLVING，RESOLVING 5s → TURN_END。
 *
 * 不依赖 Phaser 的类与输入：所有外部能力（场景、单位、回合、道具）都是注入的，
 * 因此可以在 Node 里用假对象把整条链路跑通（第 6/7 步自检就是这么做的）。
 *
 * 本步刻意不做：AI / 胜负判定 / 死亡移除 / 单位落水判定。
 *
 * 依赖：FK.EVENTS、FK.EventBus、FK.Projectile、FK.Explosion、FK.DamageSystem、
 *       FK.FuseSystem、FK.TurnFlowBridge、FK.ModuleFactory / FK.ItemRegistry、
 *       FK.TrajectoryPredictor
 * 对外：FK.ProjectileController
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class ProjectileController {

    /**
     * @param {Phaser.Scene} scene 战斗场景
     * @param {Object} opts
     *   unitSelector  提供 getSelected()（用于兜底取投掷者）
     *   units         单位列表（交给 DamageSystem 结算）
     *   turnManager   TurnManager 实例（状态流转）
     *   aimController AimController 实例（读取当前道具 / 瞄准状态）
     *   predictor     TrajectoryPredictor 实例（复用积分与碰撞）
     *   damageSystem  DamageSystem 实例（缺省自动创建）
     *   getItem       可选：() => ItemConfig，返回当前选中道具
     *   effects       可选：{ explosion(ctx), cleanup(ctx) } 表现层扩展点
     *   config        可选：覆盖 FK.Config.PROJECTILE 中的默认值
     */
    constructor(scene, opts) {
      opts = opts || {};
      const P = (FK.Config && FK.Config.PROJECTILE) ? FK.Config.PROJECTILE : {};
      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};

      this.scene = scene || null;
      this.unitSelector = opts.unitSelector || null;
      this.turnManager = opts.turnManager || null;
      this.aimController = opts.aimController || null;
      this.predictor = opts.predictor || null;
      this.getItem = (typeof opts.getItem === 'function') ? opts.getItem : null;
      this.effects = opts.effects || null;
      /**
       * 第 7 步：障碍物注册表。
       * 传入后，放置类道具（水果箱）可通过道具模块的 ctx 生成木箱，
       * 西瓜炸弹可清扫半径内的木箱。不传则相关玩法自动退化为「无木箱」。
       */
      this.obstacleRegistry = opts.obstacleRegistry || null;

      /** 当前道具（第 7 步接入道具栏后由玩家切换；本步固定为配置默认道具） */
      this.itemConfig = opts.itemConfig || (this.getItem ? this.getItem() : null);

      /** 单位列表：优先用函数，便于对局中动态增减（第 8 步移除阵亡单位） */
      this.unitsProvider = (typeof opts.units === 'function') ? opts.units : null;
      this.units = Array.isArray(opts.units) ? opts.units : [];

      this.damageSystem = opts.damageSystem || new FK.DamageSystem({
        eventBus: FK.EventBus,
        debug: !!(FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled),
        pxPerUnit: (FK.Config ? FK.Config.PX_PER_UNIT : 48)
      });

      /**
       * 第 8 步：胜负已分后的伤害开关。
       * false 时：已在飞的投掷物继续飞完、爆炸演出照播，但不结算任何伤害 / 击退。
       * 把开关交给 DamageSystem，是为了让「道具模块直接调 damageSystem」的路径也一并受控。
       */
      this.damageEnabled = (opts.damageEnabled === undefined) ? true : !!opts.damageEnabled;
      /** 是否保护「正在飞的投掷物」不被 TURN_END / GAME_OVER 中止（规则 3） */
      this.protectFlying = false;
      if (this.damageSystem && typeof this.damageSystem.setDamageGate === 'function') {
        this.damageSystem.setDamageGate(function () { return this.damageEnabled; }.bind(this));
      }

      /* ---------------- 物理参数 ---------------- */
      this.gravityY = num(opts.gravityY, (FK.Config ? FK.Config.PHYSICS.gravityY : 1500));
      this.stepSec = num(opts.stepSec, num(A.stepSec, 1 / 60));
      this.maxFlightMs = num(opts.maxFlightMs, num(P.maxFlightMs, 6000));
      this.maxStepMs = num(opts.maxStepMs, num(P.maxStepMs, 50));
      this.resolveDelayMs = num(opts.resolveDelayMs, num(P.resolveDelayMs, 120));
      /** 结算兜底：爆炸开始后最多再等多久就强制推进回合（毫秒） */
      this.resolveTimeoutMs = num(opts.resolveTimeoutMs, 3000);
      /** 第 7 步：落水是否直接销毁（不爆炸），来自 FK.Config.PROJECTILE.destroyOnWater */
      this.destroyOnWater = (opts.destroyOnWater === undefined)
        ? (P.destroyOnWater !== false) : !!opts.destroyOnWater;
      /** 落水销毁的结算缓冲（毫秒） */
      this.waterSplashMs = num(opts.waterSplashMs, num(P.waterSplashMs, 140));
      this.depth = num(opts.depth, num(P.depth, 20));
      this.explosionDepth = num(opts.explosionDepth, num(P.explosionDepth, 22));
      this.pxPerUnit = num(opts.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));

      /* ---------------- 第 7 步：两个被拆出来的协作系统 ---------------- */
      /**
       * 回合流转桥：状态判定 / 路径 BFS / thrownThisTurn / 结算兜底窗口。
       * 第 8 步接入胜负判定时只改它，投掷与伤害一行不动。
       */
      this.turnFlow = opts.turnFlow || new FK.TurnFlowBridge({
        turnManager: this.turnManager,
        controller: this,
        resolveDelayMs: this.resolveDelayMs,
        resolveTimeoutMs: this.resolveTimeoutMs,
        eventBus: FK.EventBus
      });

      /** 引信与落水判定：什么引信什么时候炸 / 落水要不要销毁 */
      this.fuseSystem = opts.fuseSystem || new FK.FuseSystem({
        controller: this,
        turnFlow: this.turnFlow,
        fuseMs: num(opts.fuseMs, 50),
        waterSplashMs: this.waterSplashMs,
        destroyOnWater: this.destroyOnWater,
        eventBus: FK.EventBus
      });

      /* ---------------- 运行状态 ---------------- */
      /** 当前飞行中的投掷物（null = 空闲） */
      this.current = null;
      /** 当前爆炸演出（null = 无） */
      this.explosion = null;
      /** 自增序号 */
      this._seq = 0;
      /** 最近一次投掷摘要（HUD / 自检用） */
      this.lastThrow = null;
      /** 最近一次结算摘要 */
      this.lastResolve = null;
      /** 统计（sunk = 第 7 步新增：落入果汁池销毁的次数，不计入 exploded） */
      this.stats = { thrown: 0, landed: 0, exploded: 0, resolved: 0, aborted: 0, sunk: 0 };
      /** 状态快照（HUD 直接读取，避免每帧拼字符串） */
      this.status = { phase: 'idle', label: '空闲', detail: '', x: 0, y: 0, step: 0 };

      this.onAimEndBound = this.onAimEnd.bind(this);
      this.onTurnStateChangeBound = this.onTurnStateChange.bind(this);

      this.bindEvents();
    }

    /* ==================================================================
     * 事件绑定
     * ================================================================== */

    bindEvents() {
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.on(FK.EVENTS.AIM_END, this.onAimEndBound);
        FK.EventBus.on(FK.EVENTS.TURN_STATE_CHANGE, this.onTurnStateChangeBound);
      }
    }

    /** 瞄准松手 → 开始投掷 */
    onAimEnd(payload) {
      return this.beginThrow(payload);
    }

    /** 回合状态变化：交给 TurnFlowBridge 裁决（新回合复位口令 / 强制结束则中止投掷） */
    onTurnStateChange(payload) {
      if (this.turnFlow && typeof this.turnFlow.onTurnStateChange === 'function') {
        this.turnFlow.onTurnStateChange(payload);
      }
    }

    /* ==================================================================
     * 投掷入口
     * ================================================================== */

    /**
     * 开始一次投掷
     * @param {Object} payload aim:end 的负载（含 unit / vx / vy / landing / hitType）
     * @returns {boolean} 是否成功生成投掷物
     */
    beginThrow(payload) {
      const p = payload || {};

      if (this.current) {
        this.log('已有一个投掷物在飞行中，本次投掷被忽略');
        return false;
      }
      if (this.turnFlow.hasThrown()) {
        this.log('本回合已经投掷过，本次投掷被忽略');
        return false;
      }

      const itemCfg = this.resolveItemConfig(p.itemId);
      if (!itemCfg) {
        this.log('找不到可用的道具配置，投掷取消');
        return false;
      }

      const unit = p.unit || (this.unitSelector ? this.unitSelector.getSelected() : null);
      if (!unit) {
        this.log('aim:end 未携带投掷单位且当前无选中单位，投掷取消');
        return false;
      }

      const start = this.resolveLaunchPoint(unit, p);
      const vx = num(p.vx, 0);
      const vy = num(p.vy, 0);

      // ---- 预演一次弹道：保证 projectile:flying 一定带着预测落点，便于一致性核对 ----
      const preflight = this.preflightPrediction(start, vx, vy, p);

      // ---- 状态流转：必须能进入 PROJECTILE_FLYING，否则不生成投掷物（避免脏状态） ----
      if (!this.enterFlyingState()) {
        this.log('当前回合状态不允许进入 PROJECTILE_FLYING，投掷取消');
        return false;
      }

      // ---- 通过道具注册表取模块（第 7 步换道具时这里零改动） ----
      let module = null;
      try {
        module = FK.ModuleFactory.createItem(itemCfg);
      } catch (e) {
        this.log('道具模块创建失败：' + ((e && e.message) ? e.message : String(e)));
        return false;
      }

      const projectile = new FK.Projectile(this.scene, {
        id: ++this._seq,
        itemId: itemCfg.id,
        itemConfig: itemCfg,
        team: (typeof unit.getTeam === 'function') ? unit.getTeam() : unit.team,
        shooterId: (typeof unit.getId === 'function') ? unit.getId() : (unit.unitId || ''),
        x: start.x, y: start.y,
        vx: vx, vy: vy,
        gravityY: this.gravityY,
        stepSec: this.stepSec,
        maxFlightMs: this.maxFlightMs,
        maxStepMs: this.maxStepMs,
        depth: this.depth,
        predictor: this.predictor,
        // 与预测同一个世界快照（当控制器没拿到预测器时也能独立碰撞）
        world: (this.predictor && typeof this.predictor.getWorld === 'function')
          ? this.predictor.getWorld() : null
      });
      projectile.create();

      const predicted = (p.landing && typeof p.landing.x === 'number')
        ? { x: p.landing.x, y: p.landing.y }
        : ((preflight && preflight.landing) ? { x: preflight.landing.x, y: preflight.landing.y }
          : this.predictedLanding());

      this.current = projectile;
      this.turnFlow.markThrown();
      this.fuseSystem.reset();
      this._exploded = false;        // 新投掷物：允许引爆
      this.stats.thrown += 1;
      this.setStatus('flying', '飞行中');

      const ctx = this.buildThrowContext(unit, itemCfg, module, projectile, predicted, p);

      // ---- 道具模块 onThrow（各道具只记录自己的出手信息，不做数值硬编码） ----
      this.safeCall(module, 'onThrow', ctx, itemCfg.id);

      this.emit(FK.EVENTS.PROJECTILE_SPAWNED, {
        id: projectile.projectileId,
        itemId: itemCfg.id,
        team: projectile.team,
        shooterId: projectile.shooterId,
        x: Math.round(start.x),
        y: Math.round(start.y),
        vx: Math.round(vx * 100) / 100,
        vy: Math.round(vy * 100) / 100,
        gravityY: this.gravityY,
        projectile: projectile
      });

      this.emit(FK.EVENTS.PROJECTILE_FLYING, {
        id: projectile.projectileId,
        itemId: itemCfg.id,
        team: projectile.team,
        shooterId: projectile.shooterId,
        x: Math.round(start.x),
        y: Math.round(start.y),
        vx: Math.round(vx * 100) / 100,
        vy: Math.round(vy * 100) / 100,
        predictedLanding: predicted,
        predictedHitType: p.hitType || 'none',
        flightTimeMs: 0,
        maxFlightMs: this.maxFlightMs
      });

      // 第 7 步：道具被真正消费（道具栏据此扣次数 / 播反馈）
      if (FK.EVENTS && FK.EVENTS.ITEM_USED) {
        this.emit(FK.EVENTS.ITEM_USED, {
          itemId: itemCfg.id,
          unitId: projectile.shooterId,
          team: projectile.team,
          turnNumber: this.turnFlow.getTurnNumber(),
          projectileId: projectile.projectileId
        });
      }

      this.lastThrow = {
        id: projectile.projectileId,
        itemId: itemCfg.id,
        unitId: projectile.shooterId,
        team: projectile.team,
        start: { x: start.x, y: start.y },
        vx: vx, vy: vy,
        predictedLanding: predicted
      };

      this.log('投掷出手：' + itemCfg.id + ' by ' + projectile.shooterId +
        ' v=(' + Math.round(vx) + ',' + Math.round(vy) + ') 预测落点 ' +
        (predicted ? '(' + Math.round(predicted.x) + ',' + Math.round(predicted.y) + ')' : '-'));
      return true;
    }

    /**
     * 请求进入 PROJECTILE_FLYING（第 7 步起委托 TurnFlowBridge）
     * @returns {boolean} 是否最终处于 PROJECTILE_FLYING
     */
    enterFlyingState() {
      return this.turnFlow.enterFlyingState();
    }

    /**
     * 在状态流转表上找一条合法路径（第 7 步起委托 TurnFlowBridge）
     * @param {string} target
     * @returns {string[]|null}
     */
    pathToState(target) {
      return this.turnFlow.pathToState(target);
    }

    /** 组装道具模块的 ctx（道具模块只读 ctx，不直接操作单位） */
    buildThrowContext(unit, itemCfg, module, projectile, predicted, payload) {
      const self = this;
      return {
        scene: this.scene,
        controller: this,
        unit: unit,
        shooter: unit,
        item: itemCfg,
        itemConfig: itemCfg,
        module: module,
        projectile: projectile,
        vx: projectile.vel.x,
        vy: projectile.vel.y,
        gravityY: this.gravityY,
        predictedLanding: predicted,
        predictedHitType: payload ? payload.hitType : 'none',
        pxPerUnit: this.pxPerUnit,
        damageSystem: this.damageSystem,
        /** 可控的伤害结算入口：道具模块按「先伤害、后击退」的顺序调用 */
        applyDamageTo: function (opts) { return self.damageSystem.applyDamage(unit, opts && opts.amount, opts); },
        /** 可控的击退入口 */
        applyKnockbackTo: function (dx, dy) {
          if (unit && typeof unit.applyKnockback === 'function') { unit.applyKnockback(dx, dy); }
        },
        emit: function (type, data) { self.emit(type, data); },
        log: function (msg) { self.log('[' + itemCfg.id + '] ' + msg); }
      };
    }

    /* ==================================================================
     * 每帧驱动
     * ================================================================== */

    /**
     * 每帧更新（BattleScene.update 调用）
     * @param {number} deltaMs 距上一帧毫秒数
     * @returns {ProjectileController} this
     */
    update(deltaMs) {
      const dt = Math.max(0, num(deltaMs, 0));

      // ---- 1) 投掷物飞行（含飞出画面上方：轨迹继续积分，仅视觉部分不可见） ----
      if (this.current && !this.current.hasLanded()) {
        this.current.step(dt);
        this.current.syncVisual(dt);
        this.status.x = this.current.pos.x;
        this.status.y = this.current.pos.y;
        this.status.step = this.current.stepCount;
        this.status.detail = 't=' + Math.round(this.current.flightTimeMs) + 'ms';

        if (this.current.hasLanded()) {
          this.stats.landed += 1;
          this.onLanded(this.current.getLanding());
        }
      }

      // ---- 2) 引信倒计时（落地 → 爆炸）；落水分支已在 FuseSystem 内部消化 ----
      // 注意：落地当帧不扣引信（引信从下一帧开始计算），
      // 否则「50ms 引信」会被落地那一帧的 delta 白白吃掉一部分。
      if (this.current && !this.turnFlow.isPendingResolve()) {
        this.fuseSystem.tick(dt, this.current);
      }

      // ---- 3) 爆炸演出 ----
      if (this.explosion) {
        const done = this.explosion.update(dt);
        if (done) {
          this.cleanupExplosion();
        }
      }

      // ---- 4) 结算倒计时（兜底：演出异常也不会卡回合） ----
      this.turnFlow.tick(dt);

      return this;
    }

    /**
     * 落地回调：交给 FuseSystem 裁决「点火爆炸」还是「落水销毁」
     * （引信时长来自 ItemConfig.fuseOnHitMs；落水规则来自 FK.Config.PROJECTILE.destroyOnWater）
     * @param {Object} landing { x, y, hitType, hitTarget }
     */
    onLanded(landing) {
      const proj = this.current;
      if (!proj) { return null; }
      return this.fuseSystem.onLanded(proj, landing);
    }

    /**
     * 组装落地 ctx 并调用道具模块的 onLand（从第 6 步的 onLanded 中提出来，
     * 因为第 7 步的「落水销毁」与「点火等引信」两条分支都要先通知模块）。
     * @param {FK.Projectile} proj
     * @param {Object} landing
     * @param {boolean} [sunk] 是否属于落水销毁
     * @returns {Object} 落地 ctx（自检与模块调试可直接读取）
     */
    notifyLandModule(proj, landing, sunk) {
      if (!proj) { return null; }
      const itemCfg = proj.itemConfig;
      const module = this.resolveModule(itemCfg);
      const ctx = this.buildLandContext(proj, itemCfg, module, landing);
      ctx.sunk = !!sunk;
      this.safeCall(module, 'onLand', ctx, proj.itemId);
      return ctx;
    }

    /**
     * 第 7 步：落水销毁（无爆炸路径，由 FuseSystem.sink 调用）
     *   ① 让道具模块的 onLand 看到这次落地（模块可据此决定「沉没」表现）
     *   ② 移除投掷物（projectile:removed，reason = 'water'）—— 不广播 exploded
     *   ③ 不进爆炸分支，但**照常推进回合**（PROJECTILE_FLYING → RESOLVING → TURN_END）
     *      「推进回合」由 FuseSystem 通过 TurnFlowBridge.beginResolve 完成
     * @param {FK.Projectile} proj
     * @param {Object} landing
     */
    resolveWaterLanding(proj, landing) {
      const itemCfg = proj.itemConfig;

      this.stats.sunk += 1;
      this.setStatus('sunk', '落水销毁');
      this.lastResolve = {
        itemId: itemCfg ? itemCfg.id : '',
        x: landing ? landing.x : proj.pos.x,
        y: landing ? landing.y : proj.pos.y,
        sunk: true,
        damaged: 0,
        knockbacked: 0,
        affected: 0
      };

      // 先让模块看到落地（此时投掷物还在，模块可读它的坐标做水花表现）
      this.notifyLandModule(proj, landing, true);

      // 只广播 projectile:removed（reason='water'），不新增事件常量：
      // 落水销毁对监听方来说就是「一次没有爆炸的移除」，用 reason 区分即可。
      const reason = (landing && landing.hitType === 'bounds') ? 'bounds' : 'water';
      this.cleanupProjectile(reason);

      this.log('投掷物' + (reason === 'bounds' ? '飞出边界' : '落入果汁池') +
        '，直接销毁（不爆炸）：' + proj.itemId +
        ' @(' + Math.round(landing.x) + ',' + Math.round(landing.y) + ')');
      return true;
    }

    /** 第 14 步：投掷者左键手动引爆（仅 manualDetonate 道具，飞行中） */
    tryManualDetonate(opts) {
      const o = opts || {};
      const proj = this.current;
      if (!proj || this._exploded) { return false; }
      if (typeof proj.hasLanded === 'function' && proj.hasLanded()) { return false; }
      const cfg = proj.itemConfig;
      if (!cfg || !cfg.manualDetonate) { return false; }
      const team = (typeof proj.getTeam === 'function') ? proj.getTeam() : proj.team;
      if (o.team && team && o.team !== team) { return false; }
      proj.landFrom({
        x: proj.pos.x,
        y: proj.pos.y,
        hitType: 'manual',
        hitTarget: null
      });
      this.stats.landed += 1;
      this.onLanded(proj.getLanding());
      return true;
    }

    /** 组装落地 ctx */
    buildLandContext(proj, itemCfg, module, landing) {
      const self = this;
      return {
        scene: this.scene,
        controller: this,
        projectile: proj,
        item: itemCfg,
        itemConfig: itemCfg,
        module: module,
        landing: landing,
        x: landing.x,
        y: landing.y,
        hitType: landing.hitType,
        hitTarget: landing.hitTarget,
        fuseMs: proj.getFuseMs(),
        pxPerUnit: this.pxPerUnit,
        damageSystem: this.damageSystem,
        units: this.getUnits(),
        /** 第 7 步：放置类道具（水果箱）在此生成障碍物 */
        obstacleRegistry: this.obstacleRegistry,
        /** 第 7 步：放置时记录是哪一回合放的（木箱倒计时口径） */
        turnNumber: this.turnFlow.getTurnNumber(),
        team: (typeof proj.getTeam === 'function') ? proj.getTeam() : proj.team,
        emit: function (type, data) { self.emit(type, data); },
        log: function (msg) { self.log('[' + itemCfg.id + '] ' + msg); }
      };
    }

    /* ==================================================================
     * 爆炸与结算
     * ================================================================== */

    /**
     * 引爆当前投掷物：
     *   ① 先移除投掷物图形（projectile:removed）
     *   ② 让道具模块 onExplode 决定「表现 + 结算方式」
     *   ③ 兜底结算：若模块没有自行结算，则由控制器按 ItemConfig 统一结算
     */
    explodeCurrent(reason) {
      const proj = this.current;
      if (!proj) { return false; }
      if (this._exploded) { return false; }

      const itemCfg = proj.itemConfig || this.itemConfig;
      const landing = proj.getLanding() || { x: proj.pos.x, y: proj.pos.y, hitType: 'timeout', hitTarget: null };
      const module = this.resolveModule(itemCfg);

      this.cleanupProjectile(reason || 'explode');
      this._exploded = true;
      this.stats.exploded += 1;
      this.setStatus('exploding', '爆炸中');

      const ctx = this.buildExplodeContext(proj, itemCfg, module, landing);

      // 先结算伤害与击退（保证 damage:applied 早于 unit:knockback 广播），再让模块决定表现
      this.settle(ctx);

      this.safeCall(module, 'onExplode', ctx, proj.itemId);

      // 模块若自行结算过，这里不会重复（settle 内部幂等）
      this.settle(ctx);
      this.emit(FK.EVENTS.PROJECTILE_EXPLODED, {
        id: proj.projectileId,
        itemId: proj.itemId,
        team: proj.team,
        shooterId: proj.shooterId,
        x: Math.round(ctx.x),
        y: Math.round(ctx.y),
        hitType: landing.hitType,
        radiusUnits: ctx.radiusUnits,
        radiusPx: ctx.radiusPx,
        damage: ctx.damage,
        knockback: ctx.knockback,
        explodeAnimMs: ctx.explodeAnimMs,
        reason: reason || 'explode'
      });

      // 进入结算倒计时：等爆炸演出播完（或兜底超时）再推进回合。
      // 窗口长度 = 演出时长 + 缓冲，由 TurnFlowBridge 统一持有（它才知道什么时候该收尾）。
      this.turnFlow.beginResolve(
        Math.max(0, ctx.explodeAnimMs) + this.resolveDelayMs, 'explode');

      return true;
    }

    /** 组装爆炸 ctx（含 onExplode 需要的全部信息，模块不硬编码任何数值） */
    buildExplodeContext(proj, itemCfg, module, landing) {
      const self = this;
      const cfg = itemCfg || {};
      const radiusUnits = num(cfg.radius, 0);
      const radiusPx = radiusUnits * this.pxPerUnit;
      const explodeAnimMs = num(cfg.explodeAnimMs, 300);

      const ctx = {
        scene: this.scene,
        controller: this,
        projectile: proj,
        item: cfg,
        itemConfig: cfg,
        module: module,
        x: landing.x,
        y: landing.y,
        hitType: landing.hitType,
        hitTarget: landing.hitTarget,
        radiusUnits: radiusUnits,
        radiusPx: radiusPx,
        innerRadiusUnits: num(cfg.innerRadiusUnits, 0),
        edgeDamageRatio: num(cfg.edgeDamageRatio, 1),
        damage: (proj && typeof proj.getExplodeDamage === 'function')
          ? proj.getExplodeDamage() : num(cfg.damage, 0),
        knockback: num(cfg.knockback, 0),
        explodeAnimMs: explodeAnimMs,
        pxPerUnit: this.pxPerUnit,
        damageSystem: this.damageSystem,
        units: this.getUnits(),
        /** 第 7 步：重炮（西瓜）在爆炸时按半径清扫障碍物 */
        obstacleRegistry: this.obstacleRegistry,
        /** 本爆炸的结算结果（由 settle 写入） */
        result: null,
        /** 幂等标记 */
        settled: false,
        /** 表现层：创建爆炸圆（返回 Explosion 实例，可重复调用只生效一次） */
        createExplosion: function (opts) { return self.createExplosion(ctx, opts); },
        /** 表现层：创建伤害飘字（第 7 步实现，本步为空实现，避免模块写渲染代码） */
        createDamageText: function () { return null; },
        emit: function (type, data) { self.emit(type, data); },
        log: function (msg) { self.log('[' + (cfg.id || 'item') + '] ' + msg); }
      };
      return ctx;
    }

    /**
     * 结算伤害与击退（幂等：同一个爆炸只会结算一次）
     * @param {Object} ctx 爆炸上下文
     * @returns {Object} DamageSystem 的结算结果
     */
    settle(ctx) {
      if (!ctx || ctx.settled) { return ctx ? ctx.result : null; }
      ctx.settled = true;

      const params = {
        x: ctx.x,
        y: ctx.y,
        radiusUnits: ctx.radiusUnits,
        radiusPx: ctx.radiusPx,
        innerRadiusUnits: ctx.innerRadiusUnits,
        edgeDamageRatio: ctx.edgeDamageRatio,
        damage: ctx.damage,
        knockback: ctx.knockback,
        units: ctx.units,
        source: ctx.item.id || ''
      };
      const result = this.damageSystem.applyExplosion(params);
      ctx.result = result;
      this.lastResolve = {
        itemId: ctx.item.id || '',
        x: ctx.x,
        y: ctx.y,
        radiusUnits: ctx.radiusUnits,
        damage: result.damaged.length,
        knockback: result.knockbacked.length,
        affected: result.affected.length
      };
      return result;
    }

    /** 创建爆炸演出对象（幂等；Node 自检里 scene 没有 add.graphics 时仍然创建逻辑对象） */
    createExplosion(ctx, opts) {
      if (this.explosion) { return this.explosion; }
      const exp = new FK.Explosion(this.scene, {
        id: this.stats.exploded,
        itemId: ctx.item ? ctx.item.id : '',
        x: ctx.x,
        y: ctx.y,
        radiusPx: num(opts && opts.radiusPx, ctx.radiusPx),
        radiusUnits: num(opts && opts.radiusUnits, ctx.radiusUnits),
        durationMs: num(opts && opts.durationMs, ctx.explodeAnimMs),
        damage: ctx.damage,
        knockback: ctx.knockback,
        depth: this.explosionDepth
      });
      exp.create();
      this.explosion = exp;
      if (this.effects && typeof this.effects.explosion === 'function') {
        this.effects.explosion({ explosion: exp, ctx: ctx, controller: this });
      }
      return exp;
    }

    /** 爆炸演出结束：销毁图形并推进回合 */
    cleanupExplosion() {
      if (this.explosion) {
        this.explosion.destroy();
        this.explosion = null;
      }
      this.finish();
    }

    /**
     * 结算完成：广播 turn:projectileResolved → TurnManager 进入 RESOLVING → 自动 TURN_END
     * （第 7 步起实际推进逻辑在 TurnFlowBridge.finish，本方法只负责准备摘要）
     * @returns {boolean} 是否成功推进
     */
    finish() {
      if (!this.turnFlow.isPendingResolve()) { return false; }

      const res = this.lastResolve || {};
      // 摘要交给桥：它负责广播事件 + 沿合法流转表推进状态
      return this.turnFlow.finish({
        id: this._seq,
        itemId: res.itemId || '',
        x: res.x,
        y: res.y,
        sunk: !!res.sunk,
        damaged: num(res.damage, 0),
        knockbacked: num(res.knockback, 0)
      });
    }

    /** 结算完成回调（由 TurnFlowBridge 调用一次，保证统计只加一遍） */
    onResolveComplete() {
      this.stats.resolved += 1;
      return this.stats.resolved;
    }

    /* ==================================================================
     * 清理与中止
     * ================================================================== */

    /** 移除投掷物视觉对象并广播 projectile:removed */
    cleanupProjectile(reason) {
      const proj = this.current;
      if (!proj) { return false; }

      const payload = {
        id: proj.projectileId,
        itemId: proj.itemId,
        team: proj.team,
        x: Math.round(proj.pos.x),
        y: Math.round(proj.pos.y),
        reason: reason || 'explode'
      };
      proj.destroy();
      this.current = null;
      this.emit(FK.EVENTS.PROJECTILE_REMOVED, payload);
      return true;
    }

    /**
     * 中止当前投掷（保护性清理：回合已被强制结束等）
     * @param {string} reason
     */
    abort(reason) {
      if (!this.current && !this.turnFlow.isPendingResolve()) { return false; }
      this.stats.aborted += 1;
      this.log('中止投掷（原因：' + (reason || 'unknown') + '）');
      this.cleanupProjectile(reason || 'abort');
      if (this.explosion) { this.explosion.destroy(); this.explosion = null; }
      // 引信与结算窗口一起复位（否则残留倒计时会在下一回合触发假爆炸）
      this.fuseSystem.reset();
      this.turnFlow.pendingResolve = false;
      this.turnFlow.resolveRemainMs = 0;
      this.setStatus('aborted', '已中止');
      return true;
    }

    /* ==================================================================
     * 第 8 步：胜负已分后的「停止伤害」与「让子弹飞完」
     * ================================================================== */

    /**
     * 开关伤害（false = 之后的爆炸只播放演出，不结算伤害与击退）
     * @param {boolean} v
     */
    setDamageEnabled(v) {
      this.damageEnabled = !!v;
      return this;
    }

    isDamageEnabled() { return !!this.damageEnabled; }

    /**
     * 对局结束：关掉伤害，并保护正在飞的投掷物不被中止（规则 3：
     * 「已在飞的投掷物继续飞完，但不再造成伤害」）。
     */
    suspendDamage() {
      this.damageEnabled = false;
      const V = (FK.Config && FK.Config.VICTORY) ? FK.Config.VICTORY : {};
      this.protectFlying = (V.letProjectileFinish !== false);
      return this;
    }

    /** 重新允许伤害（重开对局时调用；顺手把闸门重新装回控制器） */
    resumeDamage() {
      this.damageEnabled = true;
      this.protectFlying = false;
      if (this.damageSystem && typeof this.damageSystem.setDamageGate === 'function') {
        this.damageSystem.setDamageGate(function () { return this.damageEnabled; }.bind(this));
      }
      return this;
    }

    /** 正在飞的投掷物是否受保护（供 TurnFlowBridge 判断要不要中止） */
    isFlyingProtected() { return !!this.protectFlying; }

    /**
     * 重开对局：清空投掷物 / 结算窗口 / 回合口令 / 统计，并恢复伤害。
     * @returns {ProjectileController} this
     */
    resetForNewTurn() {
      this.abort('restart');
      if (this.turnFlow && typeof this.turnFlow.resetForNewTurn === 'function') {
        this.turnFlow.resetForNewTurn();
      }
      if (this.explosion) { this.explosion.destroy(); this.explosion = null; }
      this.resumeDamage();
      this.lastThrow = null;
      this.lastResolve = null;
      this.stats = { thrown: 0, landed: 0, exploded: 0, resolved: 0, aborted: 0, sunk: 0 };
      if (this.damageSystem && typeof this.damageSystem.resetStats === 'function') {
        this.damageSystem.resetStats();
      }
      this.setStatus('idle', '空闲', '');
      return this;
    }

    /* ==================================================================
     * 查询与工具
     * ================================================================== */

    /** 当前是否有投掷物在飞行 */
    hasActiveProjectile() { return !!this.current; }

    /** 当前投掷物（自检 / 调试） */
    getProjectile() { return this.current; }

    /** 当前爆炸对象（自检 / 调试） */
    getExplosion() { return this.explosion; }

    /** 本回合是否已投掷 */
    hasThrownThisTurn() { return this.turnFlow.hasThrown(); }

    /**
     * 第 7.5 步：占用「本回合行动口令」。
     * 放置模式与投掷共用同一个 thrownThisTurn —— 于是
     * 「投过了就不能再放」「放过了就不能再投」由同一处数据天然保证，
     * 不需要第二套回合口令。
     * @param {string} [reason]
     * @returns {ProjectileController} this
     */
    markTurnUsed(reason) {
      this.turnFlow.markThrown();
      this.log('本回合行动口令已占用（原因：' + (reason || 'unknown') + '）');
      return this;
    }

    /** 统计快照 */
    getStats() {
      return {
        thrown: this.stats.thrown,
        landed: this.stats.landed,
        exploded: this.stats.exploded,
        resolved: this.stats.resolved,
        aborted: this.stats.aborted,
        sunk: this.stats.sunk || 0,
        damaged: this.damageSystem ? this.damageSystem.getStats().damaged : 0,
        knockbacked: this.damageSystem ? this.damageSystem.getStats().knockbacked : 0
      };
    }

    /** HUD 用状态快照 */
    getStatus() {
      return {
        phase: this.status.phase,
        label: this.status.label,
        detail: this.status.detail,
        x: this.status.x,
        y: this.status.y,
        step: this.status.step,
        thrownThisTurn: this.turnFlow.hasThrown(),
        itemId: this.itemConfig ? this.itemConfig.id : '',
        pendingResolve: this.turnFlow.isPendingResolve(),
        /** 第 7 步：落水销毁次数（与 exploded 分开统计） */
        sunk: this.stats.sunk
      };
    }

    /** 最近一次结算结果（DamageSystem 原始结果） */
    getLastResolve() { return this.lastResolve; }

    /** 当前道具配置（第 7 步接入道具栏后由 setItem 更新） */
    setItem(itemConfig) {
      this.itemConfig = itemConfig || null;
      return this;
    }

    /** 取当前道具配置：优先显式设置，其次外部 getItem 回调 */
    resolveItemConfig(itemId) {
      if (itemId && FK.Configs && Array.isArray(FK.Configs.items)) {
        for (let i = 0; i < FK.Configs.items.length; i++) {
          if (FK.Configs.items[i].id === itemId) { return FK.Configs.items[i]; }
        }
      }
      if (this.itemConfig) { return this.itemConfig; }
      if (typeof this.getItem === 'function') {
        const cfg = this.getItem();
        if (cfg) { this.itemConfig = cfg; return cfg; }
      }
      // 最后兜底：配置里的默认道具
      const defaultId = (FK.Config && FK.Config.AIM) ? FK.Config.AIM.defaultItemId : '';
      if (defaultId && FK.Configs && Array.isArray(FK.Configs.items)) {
        for (let j = 0; j < FK.Configs.items.length; j++) {
          if (FK.Configs.items[j].id === defaultId) { return FK.Configs.items[j]; }
        }
      }
      return null;
    }

    /** 取道具模块（注册表缺失时返回 null，调用方需容错） */
    resolveModule(itemCfg) {
      if (!itemCfg) { return null; }
      try {
        return FK.ModuleFactory.createItem(itemCfg);
      } catch (e) {
        this.log('道具模块解析失败：' + ((e && e.message) ? e.message : String(e)));
        return null;
      }
    }

    /** 发射点：优先用 aim:end 携带的落点信息，其次用单位坐标 + AIM.launchOffsetYUnits */
    resolveLaunchPoint(unit, payload) {
      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
      const offset = num(A.launchOffsetYUnits, -0.3) * this.pxPerUnit;
      return {
        x: num(payload && payload.startX, num(unit.x, 0)),
        y: num(payload && payload.startY, num(unit.y, 0) + offset)
      };
    }

    /**
     * 出手前预演一次弹道（纯计算，不产生任何副作用）。
     * ① 给 projectile:flying 提供预测落点；
     * ② 让「预测 vs 实飞」的一致性在浏览器里一眼可查。
     * @param {{x:number,y:number}} start 发射点
     * @param {number} vx
     * @param {number} vy
     * @param {Object} [payload] aim:end 负载（含 landing 时直接采用，不重复计算）
     * @returns {Object|null} TrajectoryPredictor 的结果对象
     */
    preflightPrediction(start, vx, vy, payload) {
      const p = payload || {};
      if (p.landing && typeof p.landing.x === 'number') { return null; }   // 已有落点，无需重算
      if (!this.predictor || typeof this.predictor.predict !== 'function') { return null; }
      try {
        return this.predictor.predict(start.x, start.y, vx, vy);
      } catch (e) {
        this.log('预演弹道失败（不影响投掷）：' + ((e && e.message) ? e.message : String(e)));
        return null;
      }
    }

    /**
     * 取「瞄准阶段最后一次预测」的落点。
     * beginThrow 里已先做过一次 preflightPrediction，因此这里通常能拿到结果；
     * 极端情况下（预测器缺失 / 结果为原点）返回 null。
     * @returns {{x:number,y:number}|null}
     */
    predictedLanding() {
      const p = this.predictor;
      if (!p || typeof p.getLandingPoint !== 'function') { return null; }
      const land = p.getLandingPoint();
      if (!land || typeof land.x !== 'number') { return null; }
      if (land.x === 0 && land.y === 0) { return null; }
      return { x: land.x, y: land.y };
    }

    /** 单位列表（支持函数式提供，便于对局中增减） */
    getUnits() {
      if (this.unitsProvider) { return this.unitsProvider() || []; }
      return this.units || [];
    }

    /** 安全调用道具模块方法：模块抛异常也不允许中断投掷闭环 */
    safeCall(module, method, ctx, itemId) {
      if (!module || typeof module[method] !== 'function') { return null; }
      try {
        return module[method](ctx);
      } catch (e) {
        this.log('道具模块 ' + (itemId || '?') + '.' + method + ' 抛异常：' +
          ((e && e.message) ? e.message : String(e)) + '（已忽略，投掷流程继续）');
        return null;
      }
    }

    /** 更新 HUD 状态快照 */
    setStatus(phase, label, detail) {
      this.status.phase = phase;
      this.status.label = label;
      if (detail !== undefined) { this.status.detail = String(detail); }
      return this;
    }

    /** 广播 */
    emit(type, payload) {
      if (FK.EventBus && type) { FK.EventBus.emit(type, payload); }
    }

    /** 调试日志 */
    log(msg) {
      if (FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled) {
        console.log('[ProjectileController] ' + msg);
      }
    }

    /** 清理监听与场景对象 */
    destroy() {
      this.abort('destroy');
      if (this.explosion) { this.explosion.destroy(); this.explosion = null; }
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.off(FK.EVENTS.AIM_END, this.onAimEndBound);
        FK.EventBus.off(FK.EVENTS.TURN_STATE_CHANGE, this.onTurnStateChangeBound);
      }
      this.unitSelector = null;
      this.turnManager = null;
      this.aimController = null;
      this.predictor = null;
      this.obstacleRegistry = null;
      this.units = [];
      this.unitsProvider = null;
    }
  }

  FK.ProjectileController = ProjectileController;
})();
