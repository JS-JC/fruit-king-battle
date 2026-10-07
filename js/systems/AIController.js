/**
 * ============================================================
 * AIController.js —— 敌方 AI 决策主控（第 9 步新增）
 * ============================================================
 * 职责：
 *   让**红色方（酸果军团）**在自己的回合里自动完成一次行动，玩家不需要任何操作：
 *     回合开始（turn:start，红方）
 *       → 延迟 AI.thinkDelayMs（默认 1~2 秒，随机）
 *       → 选单位（能打到敌人的优先，多个候选随机）
 *       → 选道具（按权重随机：樱桃 40 / 西瓜 30 / 果箱 20 / 移动 10）
 *       → 选目标（血最低的敌人）
 *       → 算参数（AIPlanner 用 TrajectoryPredictor 搜「力度 × 角度」）
 *       → 加误差（力度 ±8% / 角度 ±4°）
 *       → 执行（投掷 / 放置 / 移动：全部走既有链路）
 *       → 结束回合（投掷 / 放置由既有链路自动收尾；
 *          若先移动，落地后必须再补一次炸弹投掷，不再「只跳不打」）
 *
 * 关键纪律：
 *   · **AI 只调用既有入口**：ProjectileController.beginThrow / PlacementController.commit /
 *     MoveController.commitPlan，因此 AI 必须走真实抛物线飞行、真实伤害结算、
 *     真实回合流转 —— 不可能直接改血量、瞬移或绕开物理系统（规则 9）。
 *   · **蓝方回合完全不动**（规则 11）：turn:start 的阵营不是红方时立即取消；
 *     update() 在空闲态直接返回，不读鼠标、不发事件。
 *   · 依赖全部由构造参数注入（turnManager / 各控制器 / units / items / applyItem …），
 *     且不依赖 Phaser，因此可以在 Node 自检里用假控制器跑完整决策流程。
 *   · 数据驱动：延迟、误差、权重、搜索范围全部来自 FK.Config.AI（见 gameConfig.js），
 *     代码里没有魔法数字；难度分层留到第 13 步，本步只做「中等」一档。
 *
 * 事件（常量见 js/config/events.js）：
 *   ai:thinking  开始思考（含本次延迟毫秒数）
 *   ai:decided   决策完成（含单位 / 道具 / 目标 / 参数 / 预测落点）
 *   ai:acted     行动落地（含是否成功与出手参数）
 *
 * 对外方法：
 *   update(dt)         每帧驱动（BattleScene.update 调用）
 *   isAiTurn()         当前是否轮到 AI 阵营
 *   isWaiting() / isActing() / isBusy()
 *   getHintText()      HUD 文案
 *   getState() / getStats() / getLastPlan()
 *   forceDecide()      跳过剩余延迟立刻决策（自检 / 调试用）
 *   reset(reason) / cancel(reason) / setEnabled(v) / destroy()
 *
 * 依赖：FK.Config、FK.EVENTS、FK.EventBus、FK.TurnStates、FK.AIPlanner
 * 对外：FK.AIController
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  /** 动作中文名（日志 / HUD） */
  const ACTION_LABEL = { throw: '投掷', place: '放置木箱', move: '移动' };

  class AIController {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   turnManager           TurnManager（阵营 / 状态查询 + 收尾 endTurn）
     *   unitSelector          选区块（可选：仅用于把 AI 选中的单位同步到 HUD）
     *   projectileController  投掷控制器（beginThrow / hasThrownThisTurn / hasActiveProjectile）
     *   placementController   放置控制器（setItem / start / onPointerMove / probe / commit / stop）
     *   moveController        移动控制器（canUseMove / startPlan / updatePlan / commitPlan / isActive）
     *   predictor             TrajectoryPredictor（与实飞同源的弹道预测）
     *   units                 () => 单位列表
     *   items                 () => ItemConfig 列表
     *   applyItem             (ItemConfig) => void（BattleScene.applyItem，同步瞄准 / 投掷 / 放置）
     *   cooldown              (itemId) => 剩余冷却 turn 数（0 = 可用）
     *   canMove               () => 本回合还能不能移动（缺省问 moveController）
     *   eventBus / planner / config / rng / debug / enabled / team
     */
    constructor(scene, opts) {
      opts = opts || {};
      const C = (FK.Config && FK.Config.AI) ? FK.Config.AI : {};

      this.scene = scene || null;
      this.events = opts.eventBus || FK.EventBus || null;
      this.turnManager = opts.turnManager || null;
      this.unitSelector = opts.unitSelector || null;
      this.projectileController = opts.projectileController || null;
      this.placementController = opts.placementController || null;
      this.moveController = opts.moveController || null;
      this.predictor = opts.predictor || null;

      this.unitsProvider = (typeof opts.units === 'function') ? opts.units
        : function () { return []; };
      this.itemsProvider = (typeof opts.items === 'function') ? opts.items
        : function () { return (FK.Configs && FK.Configs.items) || []; };
      this.applyItemProvider = (typeof opts.applyItem === 'function') ? opts.applyItem : null;
      this.cooldownProvider = (typeof opts.cooldown === 'function') ? opts.cooldown : null;
      this.canMoveProvider = (typeof opts.canMove === 'function') ? opts.canMove : null;

      this.planner = opts.planner || FK.AIPlanner || null;
      this.rng = (typeof opts.rng === 'function') ? opts.rng : Math.random;
      this.config = this.planner
        ? this.planner.resolveConfig(opts.config)
        : null;

      this.team = opts.team || (this.config ? this.config.team : 'red');
      this.enabled = (opts.enabled === undefined)
        ? (C.enabled !== false) : !!opts.enabled;
      this.difficulty = (this.config ? this.config.difficulty : 'normal');
      this.debug = (opts.debug === undefined)
        ? !!(FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled) : !!opts.debug;

      /** 'idle'（不轮到我）| 'waiting'（延迟中）| 'acting'（已出手，等回合收尾） */
      this.state = 'idle';
      /** 本次行动的类型：'throw' | 'place' | 'move' */
      this.actKind = '';
      /** 本次延迟总量 / 已等待 / 已行动时长（毫秒） */
      this.delayMs = 0;
      this.waitMs = 0;
      this.actMs = 0;
      /** 正在执行的计划 / 最近一次完成的计划 */
      this.plan = null;
      this.lastPlan = null;
      /** 正在等待的回合号 */
      this.pendingTurn = 0;
      /** 决策重试计数（状态未就绪时最多重试几次，避免站桩） */
      this.retry = 0;
      /** 本回合是否已经「移动后再补投掷」（防止落地后循环再跳） */
      this.followedUpAfterMove = false;

      this.stats = {
        scheduled: 0, decided: 0, thrown: 0, placed: 0, moved: 0,
        ended: 0, aborted: 0, failed: 0
      };

      this.onTurnStartBound = this.onTurnStart.bind(this);
      this.onTurnEndBound = this.onTurnEnd.bind(this);
      this.onStateChangeBound = this.onStateChange.bind(this);
      this.onTurnSwitchBound = this.onTurnSwitch.bind(this);
      this.onGameOverBound = this.onGameOver.bind(this);

      this.bindEvents();
    }

    /* ==================================================================
     * 事件绑定
     * ================================================================== */

    bindEvents() {
      const E = FK.EVENTS;
      if (!this.events || !E) { return this; }
      this.events.on(E.TURN_START, this.onTurnStartBound);
      this.events.on(E.TURN_END, this.onTurnEndBound);
      this.events.on(E.TURN_SWITCH, this.onTurnSwitchBound);
      this.events.on(E.TURN_STATE_CHANGE, this.onStateChangeBound);
      if (E.GAME_OVER) { this.events.on(E.GAME_OVER, this.onGameOverBound); }
      return this;
    }

    /**
     * 回合开始（规则 1）：红方 → 排定一次「延迟 1~2 秒」的决策；
     * 蓝方（玩家）→ 立即取消，AI 完全不动（规则 11）。
     */
    onTurnStart(payload) {
      if (!this.enabled) { return false; }
      if (!payload || payload.team !== this.team) {
        this.cancel('not-my-turn');
        return false;
      }
      if (this.isGameOver()) { return false; }
      this.schedule(payload.turnNumber);
      return true;
    }

    /** 回合结束：AI 的本次行动窗口关闭 */
    onTurnEnd() {
      if (this.state !== 'idle') { this.cancel('turn-end'); }
      return true;
    }

    onTurnSwitch() {
      if (this.state !== 'idle') { this.cancel('team-switched'); }
      return true;
    }

    onStateChange(payload) {
      if (!payload) { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : {};
      if (payload.to === S.GAME_OVER) { this.cancel('game-over'); return true; }
      if (payload.to === S.TURN_END) { this.cancel('turn-end'); return true; }
      return false;
    }

    onGameOver() {
      this.cancel('game-over');
      return true;
    }

    /* ==================================================================
     * 排定与帧驱动
     * ================================================================== */

    /** 排定一次决策（延迟时间在 AI.thinkDelayMs 的 [min,max] 内随机） */
    schedule(turnNumber) {
      const cfg = this.config;
      if (!cfg) { return false; }

      this.pendingTurn = num(turnNumber, 0);
      this.state = 'waiting';
      this.actKind = '';
      this.plan = null;
      this.waitMs = 0;
      this.actMs = 0;
      this.retry = 0;
      this.followedUpAfterMove = false;
      this.delayMs = this.planner.randomBetween(cfg.thinkDelayMs.min, cfg.thinkDelayMs.max, this.rng);
      this.stats.scheduled += 1;

      this.emit(AI_EVENT.thinking, {
        team: this.team,
        turnNumber: this.pendingTurn,
        difficulty: this.difficulty,
        delayMs: Math.round(this.delayMs),
        unitCount: this.planner.aliveOf(this.unitsProvider(), this.team).length,
        enemyCount: this.planner.enemiesOf(this.unitsProvider(), this.team).length
      });

      this.log('红方 AI 开始思考：' + Math.round(this.delayMs) + 'ms 后行动（第 ' +
        this.pendingTurn + ' 回合）');
      return true;
    }

    /**
     * 每帧驱动（规则 1 / 10）
     * @param {number} deltaMs 毫秒
     */
    update(deltaMs) {
      if (!this.enabled) { return this; }
      if (this.state === 'idle') { return this; }

      const dt = Math.max(0, num(deltaMs, 0));

      if (this.isGameOver()) { this.cancel('game-over'); return this; }
      if (!this.isAiTurn()) { this.cancel('team-changed'); return this; }

      if (this.state === 'waiting') {
        this.waitMs += dt;
        if (this.waitMs >= this.delayMs) { this.decide(); }
        return this;
      }

      /* ---------- acting：等本次行动自然收尾 ---------- */
      this.actMs += dt;

      if (this.actKind === 'move') {
        const mc = this.moveController;
        const busy = !!(mc && typeof mc.isActive === 'function' && mc.isActive());
        if (!busy) {
          // 与玩家同一口径：移动不结束回合。落地后必须再打一发，避免「只跳不炸」。
          if (this.followUpThrowAfterMove()) { return this; }
          this.endTurn('ai-move');
          this.finish('move-complete');
          return this;
        }
      }

      // 兜底：任何异常导致长时间停不下 → 强制结束回合，绝不卡住对局
      if (this.config && this.actMs >= this.config.actTimeoutMs) {
        this.stats.aborted += 1;
        this.log('AI 行动超时（' + Math.round(this.actMs) + 'ms），强制结束回合');
        this.endTurn('ai-timeout');
        this.finish('timeout');
      }
      return this;
    }

    /* ==================================================================
     * 决策：选单位 → 选道具 → 选目标 → 算参数 → 加误差 → 执行
     * ================================================================== */

    /** 现在能不能决策（状态机就绪 + 本回合还没行动 + 没有投掷物在飞） */
    canDecideNow() {
      if (!this.enabled || !this.planner) { return false; }
      if (this.isGameOver()) { return false; }
      if (!this.isAiTurn()) { return false; }

      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : null;
      const tm = this.turnManager;
      if (S && tm && typeof tm.getState === 'function') {
        const st = tm.getState();
        const ok = (st === S.TURN_START || st === S.SELECT_UNIT || st === S.AIMING);
        if (!ok) { return false; }
      }

      const pc = this.projectileController;
      if (pc) {
        if (typeof pc.hasActiveProjectile === 'function' && pc.hasActiveProjectile()) { return false; }
        if (typeof pc.hasThrownThisTurn === 'function' && pc.hasThrownThisTurn()) { return false; }
      }
      return true;
    }

    /**
     * 决策主流程（规则 2）：选单位 → 选道具 → 选目标 → 算参数 → 加误差 → 执行 → 结束回合
     * @returns {boolean} 是否成功出手
     */
    decide() {
      try {
        return this.decideInner();
      } catch (e) {
        this.log('AI 决策异常，回退樱桃投掷：' + ((e && e.message) ? e.message : String(e)));
        return this.fallbackCherryThrow(null, null, 'exception');
      }
    }

    decideInner() {
      if (!this.planner) { this.stats.failed += 1; this.endTurn('ai-no-planner'); return false; }

      if (!this.canDecideNow()) {
        this.retry += 1;
        if (this.retry <= 3) {
          // 状态还没到位（例如还停在 TURN_START）：100ms 后重试，避免误判成「无法行动」
          this.waitMs = Math.max(0, this.delayMs - 100);
          return false;
        }
        this.stats.aborted += 1;
        this.log('AI 无法行动（重试 ' + this.retry + ' 次），结束回合');
        this.endTurn('ai-not-ready');
        this.finish('not-ready');
        return false;
      }

      const all = this.unitsProvider() || [];
      const myUnits = this.planner.aliveOf(all, this.team);
      const enemies = this.planner.enemiesOf(all, this.team);

      if (myUnits.length === 0 || enemies.length === 0) {
        this.log('AI 没有可行动单位或没有敌人，直接结束回合');
        this.endTurn('ai-no-target');
        this.finish('no-target');
        return false;
      }

      const cfg = this.config;
      const world = this.world();
      const ppx = (FK.Config ? FK.Config.PX_PER_UNIT : 48);
      const maxSpeed = ((FK.Config && FK.Config.AIM) ? FK.Config.AIM.maxSpeed : 1200);
      const self = this;

      const availableIds = this.availableItemIds();
      if (availableIds.length === 0) {
        this.log('AI 没有任何可用道具，结束回合');
        this.endTurn('ai-no-item');
        this.finish('no-item');
        return false;
      }

      const cherry = this.itemOf('cherry_bomb');
      const reachItem = (cherry && cherry.type !== 'obstacle') ? cherry : this.findFallbackItem();

      const unitPick = this.planner.pickUnit({
        units: myUnits,
        enemies: enemies,
        item: reachItem,
        predictor: this.predictor,
        world: world,
        config: cfg,
        rng: this.rng,
        maxSpeed: maxSpeed,
        pxPerUnit: ppx,
        launchOf: function (u) { return self.planner.launchPointOf(u, { pxPerUnit: ppx }); }
      });
      if (!unitPick || !unitPick.unit) {
        this.log('AI 选不出单位，结束回合');
        this.endTurn('ai-no-unit');
        this.finish('no-unit');
        return false;
      }
      const unit = unitPick.unit;
      const wild = this.rng() < num((cfg.itemChoice && cfg.itemChoice.randomFallbackChance), 0.15);
      const target = this.planner.pickTarget(enemies, {
        from: unit, world: world, config: cfg, pxPerUnit: ppx, preferSecond: wild
      });
      if (!target) {
        this.endTurn('ai-no-target');
        this.finish('no-target');
        return false;
      }

      const threat = this.planner.preserveReason(unit, myUnits, enemies, {
        world: world, config: cfg, pxPerUnit: ppx, item: null
      });
      const canMove = this.canUseMove();
      const moveBase = {
        unit: unit, target: target, config: cfg, world: world, rng: this.rng,
        predictor: this.predictor, pxPerUnit: ppx
      };

      if (threat && canMove && cfg.selfPreserve && cfg.selfPreserve.enabled &&
          this.rng() < num(cfg.selfPreserve.skipAttackChance, 0.7)) {
        const fleeX = this.planner.fleeDesiredX(unit, enemies, world, cfg, ppx);
        const fleeDir = fleeX >= (unit.x || 0) ? 1 : -1;
        let flee = this.planner.planMove(Object.assign({}, moveBase, {
          desiredX: fleeX, direction: fleeDir
        }));
        if (flee && Math.abs((flee.landing && flee.landing.x || unit.x) - unit.x) < 12) {
          flee = null;
        }
        if (flee) {
          flee.reason = 'self-preserve:' + threat;
          this.log('AI 自保：' + threat + '（HP ' + Math.round(this.planner.hpRatioOf(unit) * 100) + '%）→ 移动到安全区');
          const moved = this.commitDecidedPlan(flee, unitPick);
          if (moved) { return true; }
          this.log('AI 自保移动失败，转入攻击');
        } else {
          this.log('AI 自保无安全落点，跳过自保进入攻击');
        }
      }

      const inRange = !!unitPick.reachable;
      if (canMove && cfg.positionAdjust && cfg.positionAdjust.enabled && !inRange) {
        const approachT = target;
        const approach = this.planner.planMove(Object.assign({}, moveBase, {
          target: approachT,
          hitItem: reachItem,
          hitTarget: approachT,
          throwMaxSpeed: maxSpeed
        }));
        if (approach) {
          approach.reason = 'reposition-out-of-range';
          this.log('AI 调整位置：够不到敌人 → 跳向能打到 ' + this.planner.idOf(approachT) + ' 的落点');
          const moved = this.commitDecidedPlan(approach, unitPick);
          if (moved) { return true; }
          this.log('AI 靠近移动失败，转入攻击');
        } else {
          this.log('AI 找不到可接近落点，转入攻击');
        }
      }

      const itemPick = this.planner.pickItemByRules({
        availableIds: availableIds,
        target: target,
        unit: unit,
        world: world,
        config: cfg,
        rng: this.rng,
        pxPerUnit: ppx,
        crateCount: this.stats.placed,
        threatened: !!threat,
        followUp: false
      });
      let chosenId = itemPick.id;
      if (!chosenId) { chosenId = cfg.fallbackItemId || 'cherry_bomb'; }
      if (chosenId === 'move' && !canMove) { chosenId = (reachItem && reachItem.id) || cfg.fallbackItemId; }

      const chosenItem = (chosenId === 'move') ? null : this.itemOf(chosenId);
      let plan = null;
      if (chosenId === 'move' && mc && canMove) {
        plan = this.planner.planMove(moveBase);
      } else if (chosenItem && chosenItem.type === 'obstacle') {
        plan = {
          kind: 'place',
          team: this.team,
          unit: unit, unitId: this.planner.idOf(unit),
          item: chosenItem, itemId: chosenItem.id,
          target: target, targetId: this.planner.idOf(target),
          spots: this.planner.placementSpots({
            unit: unit, target: target, config: cfg, world: world, pxPerUnit: ppx
          })
        };
      } else if (chosenItem) {
        plan = this.planner.planThrow({
          unit: unit, item: chosenItem, target: target,
          predictor: this.predictor, world: world, config: cfg, rng: this.rng,
          maxSpeed: maxSpeed, pxPerUnit: ppx
        });
      }

      if (!plan && reachItem) {
        plan = this.planner.planThrow({
          unit: unit, item: reachItem, target: target,
          predictor: this.predictor, world: world, config: cfg, rng: this.rng,
          maxSpeed: maxSpeed, pxPerUnit: ppx
        });
        if (plan) { plan.fallbackFrom = chosenId; }
      }

      if (!plan) {
        this.log('AI 算不出方案，回退樱桃投掷');
        return this.fallbackCherryThrow(unit, target, 'no-plan');
      }

      plan.reason = plan.reason || ('attack:' + (itemPick.why || chosenId));
      plan.whyItem = itemPick.why || '';
      this.log('AI 攻击：目标 ' + this.planner.idOf(target) +
        ' HP ' + Math.round(this.planner.hpOf(target)) +
        ' · 道具 ' + (plan.itemId || chosenId) +
        '（' + (itemPick.why || '-') + (wild ? ', 故意犯错' : '') + '）');
      const ok = this.commitDecidedPlan(plan, unitPick);
      if (ok) { return true; }
      return this.fallbackCherryThrow(unit, target, 'attack-failed');
    }

    commitDecidedPlan(plan, unitPick) {
      const pick = unitPick || {};
      plan.turnNumber = this.pendingTurn;
      plan.action = plan.kind;
      plan.unitPick = {
        reachable: pick.reachable,
        distancePx: pick.distancePx,
        hittableCount: pick.hittableCount,
        candidateCount: pick.candidates ? pick.candidates.length : 0
      };
      this.plan = plan;
      this.lastPlan = plan;
      this.stats.decided += 1;

      this.emit(AI_EVENT.decided, {
        team: this.team,
        turnNumber: plan.turnNumber,
        difficulty: this.difficulty,
        action: plan.kind,
        actionLabel: ACTION_LABEL[plan.kind] || plan.kind,
        unitId: plan.unitId,
        itemId: plan.itemId || '',
        targetId: plan.targetId || '',
        reason: plan.reason || '',
        reachable: !!pick.reachable,
        hittableCount: pick.hittableCount,
        candidateCount: plan.unitPick.candidateCount,
        powerRatio: (plan.shot ? plan.shot.powerRatio : plan.powerRatio),
        angleDeg: (plan.shot ? plan.shot.angleDeg : plan.angleDeg),
        vx: (plan.shot ? plan.shot.vx : plan.vx),
        vy: (plan.shot ? plan.shot.vy : plan.vy),
        predictedLanding: (plan.shot ? plan.shot.landing : plan.landing) || null,
        hitType: (plan.shot ? plan.shot.hitType : plan.hitType) || 'none',
        distancePx: (plan.shot ? plan.shot.distancePx : plan.distanceFromDesiredPx) || null,
        error: plan.error || null,
        fallbackFrom: plan.fallbackFrom || ''
      });

      const ok = this.execute(plan);

      this.emit(AI_EVENT.acted, {
        team: this.team,
        turnNumber: plan.turnNumber,
        action: plan.kind,
        actionLabel: ACTION_LABEL[plan.kind] || plan.kind,
        unitId: plan.unitId,
        itemId: plan.itemId || '',
        targetId: plan.targetId || '',
        success: !!ok,
        reason: plan.reason || '',
        vx: (plan.shot ? plan.shot.vx : plan.vx) || 0,
        vy: (plan.shot ? plan.shot.vy : plan.vy) || 0,
        landing: (plan.shot ? plan.shot.landing : plan.landing) || null,
        powerRatio: (plan.shot ? plan.shot.powerRatio : plan.powerRatio) || 0,
        angleDeg: (plan.shot ? plan.shot.angleDeg : plan.angleDeg) || 0
      });

      if (!ok) {
        this.stats.failed += 1;
        this.log('AI 执行失败（' + plan.kind + '），交由上层回退');
        return false;
      }
      return ok;
    }

    fallbackCherryThrow(unit, target, why) {
      try {
        const all = this.unitsProvider() || [];
        const myUnits = this.planner.aliveOf(all, this.team);
        const enemies = this.planner.enemiesOf(all, this.team);
        const u = (unit && this.planner.isAlive(unit)) ? unit : (myUnits[0] || null);
        const t = (target && this.planner.isAlive(target))
          ? target
          : this.planner.pickTarget(enemies, { from: u });
        const item = this.itemOf('cherry_bomb') || this.findFallbackItem();
        if (!u || !t || !item) {
          this.endTurn('ai-fallback-empty');
          this.finish('fallback-empty');
          return false;
        }
        const ppx = (FK.Config ? FK.Config.PX_PER_UNIT : 48);
        const maxSpeed = ((FK.Config && FK.Config.AIM) ? FK.Config.AIM.maxSpeed : 1200);
        let plan = this.planner.planThrow({
          unit: u, item: item, target: t,
          predictor: this.predictor, world: this.world(), config: this.config,
          rng: this.rng, maxSpeed: maxSpeed, pxPerUnit: ppx
        });
        if (!plan) {
          const dir = this.planner.directionSign(u, t);
          const speed = maxSpeed * 0.55 * num(item.range, 1);
          const rad = 45 * Math.PI / 180;
          plan = {
            kind: 'throw', unit: u, unitId: this.planner.idOf(u),
            item: item, itemId: item.id, target: t, targetId: this.planner.idOf(t),
            shot: {
              powerRatio: 0.55, angleDeg: 45,
              vx: Math.cos(rad) * speed * dir,
              vy: -Math.sin(rad) * speed,
              launch: { x: u.x, y: u.y }
            }
          };
        }
        plan.reason = 'fallback-cherry:' + (why || '');
        plan.fallbackFrom = why || 'fallback';
        this.log('AI 兜底：樱桃炸弹 · ' + (why || ''));
        const ok = this.commitDecidedPlan(plan, { reachable: true, candidates: [] });
        if (!ok) {
          this.endTurn('ai-fallback-failed');
          this.finish('fallback-failed');
        }
        return ok;
      } catch (e) {
        this.log('AI 兜底也失败：' + ((e && e.message) ? e.message : String(e)));
        this.endTurn('ai-fallback-error');
        this.finish('fallback-error');
        return false;
      }
    }

    /** 执行一次行动：投掷 / 放置 / 移动（全部走既有链路） */
    execute(plan) {
      if (!plan) { return false; }
      if (plan.kind === 'move') { return this.executeMove(plan); }
      if (plan.kind === 'place') { return this.executePlace(plan); }
      return this.executeThrow(plan);
    }

    /** 投掷：同步道具 → 选中单位（HUD）→ ProjectileController.beginThrow（真实抛物线） */
    executeThrow(plan) {
      const pc = this.projectileController;
      if (!pc || typeof pc.beginThrow !== 'function' || !plan.item) { return false; }

      if (this.applyItemProvider) { this.applyItemProvider(plan.item); }
      this.selectUnitForHud(plan.unit);

      const shot = plan.shot || {};
      let ok = false;
      try {
        ok = pc.beginThrow({
          unit: plan.unit,
          team: this.team,
          source: 'ai',
          itemId: plan.item.id,
          startX: shot.launch ? shot.launch.x : plan.unit.x,
          startY: shot.launch ? shot.launch.y : plan.unit.y,
          powerRatio: num(shot.powerRatio, 0),
          angleDeg: num(shot.angleDeg, 0),
          vx: num(shot.vx, 0),
          vy: num(shot.vy, 0),
          landing: shot.landing || null,
          hitType: shot.hitType || 'none'
        });
      } catch (e) {
        this.log('投掷抛出异常：' + ((e && e.message) ? e.message : String(e)));
        ok = false;
      }

      if (!ok) { return false; }

      this.state = 'acting';
      this.actKind = 'throw';
      this.actMs = 0;
      this.stats.thrown += 1;
      this.log('AI 投掷：' + plan.item.id + ' by ' + plan.unitId +
        ' → ' + plan.targetId + ' · 力度 ' + Math.round(num(shot.powerRatio, 0) * 100) + '%' +
        ' · 角度 ' + Math.round(num(shot.angleDeg, 0)) + '°' +
        ' · 预测落点 ' + (shot.landing ? '(' + Math.round(shot.landing.x) + ',' + Math.round(shot.landing.y) + ')' : '-') +
        '（回合由现有投掷链路自动收尾）');
      return true;
    }

    /** 放置果箱：进入放置模式 → 依次探测候选点 → 合法即提交（真实自由落体 + 自动结束回合） */
    executePlace(plan) {
      const plc = this.placementController;
      if (!plc || !plan.item) { return false; }

      if (this.applyItemProvider) { this.applyItemProvider(plan.item); }
      if (typeof plc.setItem === 'function') { plc.setItem(plan.item); }
      if (typeof plc.start !== 'function' || !plc.start({ silent: true })) { return false; }

      const spots = plan.spots || [];
      let committed = false;
      for (let i = 0; i < spots.length && !committed; i++) {
        const spot = spots[i];
        try {
          plc.onPointerMove({ worldX: spot.x, worldY: spot.y });
          const st = (typeof plc.probe === 'function') ? plc.probe(spot.x, spot.y) : null;
          if (st && st.valid) { committed = !!plc.commit(); }
        } catch (e) {
          this.log('放置探测异常：' + ((e && e.message) ? e.message : String(e)));
        }
      }

      if (!committed) {
        if (typeof plc.stop === 'function') { plc.stop('ai-invalid', { silent: true }); }
        this.log('AI 放置失败：候选点全部不可放置（' + spots.length + ' 个）');
        return false;
      }

      this.state = 'acting';
      this.actKind = 'place';
      this.actMs = 0;
      this.stats.placed += 1;
      this.log('AI 放置木箱 → ' + plan.targetId + ' 附近，落点 ' +
        (plan.spots && plan.spots[0] ? '(' + Math.round(plan.spots[0].x) + ',' + Math.round(plan.spots[0].y) + ')' : '-') +
        '（木箱落地后自动结束回合）');
      return true;
    }

    /** 移动：按计划反推拖拽向量 → MoveController 规划 → 生效（真实抛物线跳跃） */
    executeMove(plan) {
      const mc = this.moveController;
      if (!mc || typeof mc.startPlan !== 'function' || typeof mc.updatePlan !== 'function') { return false; }
      const unit = plan.unit;
      if (!unit) { return false; }

      this.selectUnitForHud(unit);

      let ok = false;
      try {
        if (!mc.startPlan(unit, unit.x, unit.y)) { return false; }
        const pointer = plan.pointer || { x: unit.x + num(plan.dragX, 0), y: unit.y + num(plan.dragY, 0) };
        mc.updatePlan(pointer.x, pointer.y);
        ok = !!mc.commitPlan();
      } catch (e) {
        this.log('移动抛出异常：' + ((e && e.message) ? e.message : String(e)));
        ok = false;
      }

      if (!ok) {
        if (typeof mc.cancelPlan === 'function') { mc.cancelPlan('ai-failed'); }
        return false;
      }

      this.state = 'acting';
      this.actKind = 'move';
      this.actMs = 0;
      this.stats.moved += 1;
      this.log('AI 移动：' + plan.unitId + ' 跳向 ' + plan.targetId +
        ' 方向 · 力度 ' + Math.round(num(plan.powerRatio, 0) * 100) + '%' +
        ' · 角度 ' + Math.round(num(plan.angleDeg, 0)) + '°' +
        ' · 预计落点 ' + (plan.landing ? '(' + Math.round(plan.landing.x) + ',' + Math.round(plan.landing.y) + ')' : '-') +
        '（落地后补一次投掷）');
      return true;
    }

    /**
     * 移动落地后补一次炸弹投掷（不再抽「移动」、也不改放果箱）。
     * 用刚跳完的单位打血最低的敌人；算不出弹道则返回 false，由调用方结束回合。
     */
    followUpThrowAfterMove() {
      if (this.followedUpAfterMove) { return false; }
      this.followedUpAfterMove = true;
      if (!this.planner || this.isGameOver() || !this.isAiTurn()) { return false; }

      const all = this.unitsProvider() || [];
      const myUnits = this.planner.aliveOf(all, this.team);
      const enemies = this.planner.enemiesOf(all, this.team);
      if (myUnits.length === 0 || enemies.length === 0) { return false; }

      const bombIds = this.availableItemIds().filter((id) => {
        if (id === 'move') { return false; }
        const it = this.itemOf(id);
        return !!(it && it.type !== 'obstacle');
      });

      let unit = this.plan && this.plan.unit ? this.plan.unit : null;
      if (!unit || myUnits.indexOf(unit) < 0) {
        const pick = this.planner.pickUnit({
          units: myUnits,
          enemies: enemies,
          item: this.findFallbackItem(),
          predictor: this.predictor,
          world: this.world(),
          config: this.config,
          rng: this.rng,
          maxSpeed: ((FK.Config && FK.Config.AIM) ? FK.Config.AIM.maxSpeed : 1200)
        });
        unit = pick && pick.unit;
      }
      if (!unit) { return false; }

      const target = this.planner.pickTarget(enemies, {
        from: unit, world: this.world(), config: this.config,
        pxPerUnit: (FK.Config ? FK.Config.PX_PER_UNIT : 48)
      });
      if (!target) { return false; }

      const itemPick = this.planner.pickItemByRules({
        availableIds: bombIds,
        target: target,
        unit: unit,
        world: this.world(),
        config: this.config,
        rng: this.rng,
        pxPerUnit: (FK.Config ? FK.Config.PX_PER_UNIT : 48),
        crateCount: this.stats.placed,
        followUp: true
      });
      let item = this.itemOf(itemPick.id);
      if (!item) { item = bombIds.length ? this.itemOf(bombIds[0]) : this.findFallbackItem(); }
      if (!item) { return false; }

      const ppx = (FK.Config ? FK.Config.PX_PER_UNIT : 48);
      const maxSpeed = ((FK.Config && FK.Config.AIM) ? FK.Config.AIM.maxSpeed : 1200);
      const throwPlan = this.planner.planThrow({
        unit: unit, item: item, target: target,
        predictor: this.predictor, world: this.world(), config: this.config, rng: this.rng,
        maxSpeed: maxSpeed, pxPerUnit: ppx
      });
      if (!throwPlan) { return false; }

      throwPlan.turnNumber = this.pendingTurn;
      throwPlan.followUpFrom = 'move';
      this.plan = throwPlan;
      this.lastPlan = throwPlan;
      this.stats.decided += 1;

      this.emit(AI_EVENT.decided, {
        team: this.team,
        turnNumber: throwPlan.turnNumber,
        difficulty: this.difficulty,
        action: throwPlan.kind,
        actionLabel: ACTION_LABEL[throwPlan.kind] || throwPlan.kind,
        unitId: throwPlan.unitId,
        itemId: throwPlan.itemId || '',
        targetId: throwPlan.targetId || '',
        reachable: true,
        followUpFrom: 'move',
        powerRatio: throwPlan.shot ? throwPlan.shot.powerRatio : 0,
        angleDeg: throwPlan.shot ? throwPlan.shot.angleDeg : 0,
        vx: throwPlan.shot ? throwPlan.shot.vx : 0,
        vy: throwPlan.shot ? throwPlan.shot.vy : 0,
        predictedLanding: throwPlan.shot ? throwPlan.shot.landing : null,
        hitType: throwPlan.shot ? throwPlan.shot.hitType : 'none'
      });

      const ok = this.executeThrow(throwPlan);
      this.emit(AI_EVENT.acted, {
        team: this.team,
        turnNumber: throwPlan.turnNumber,
        action: throwPlan.kind,
        actionLabel: ACTION_LABEL[throwPlan.kind] || throwPlan.kind,
        unitId: throwPlan.unitId,
        itemId: throwPlan.itemId || '',
        targetId: throwPlan.targetId || '',
        success: !!ok,
        followUpFrom: 'move',
        vx: throwPlan.shot ? throwPlan.shot.vx : 0,
        vy: throwPlan.shot ? throwPlan.shot.vy : 0,
        landing: throwPlan.shot ? throwPlan.shot.landing : null,
        powerRatio: throwPlan.shot ? throwPlan.shot.powerRatio : 0,
        angleDeg: throwPlan.shot ? throwPlan.shot.angleDeg : 0
      });

      if (!ok) {
        this.log('移动后补投掷失败，结束回合');
        return false;
      }
      this.actMs = 0;
      this.log('移动落地后补投掷：' + item.id + ' by ' + throwPlan.unitId + ' → ' + throwPlan.targetId);
      return true;
    }

    /* ==================================================================
     * 可用性查询
     * ================================================================== */

    /** 按 itemId 取道具配置 */
    itemOf(itemId) {
      const items = this.itemsProvider() || [];
      for (let i = 0; i < items.length; i++) {
        if (items[i] && items[i].id === itemId) { return items[i]; }
      }
      return null;
    }

    /** 当前可用道具 id 列表（含虚拟槽位 'move'，受冷却 / 控制器存在性约束） */
    availableItemIds() {
      const cfg = this.config;
      if (!cfg) { return []; }
      const ids = [];

      Object.keys(cfg.itemWeights).forEach((id) => {
        if (id === 'move') {
          if (this.canUseMove()) { ids.push('move'); }
          return;
        }
        const item = this.itemOf(id);
        if (!item) { return; }
        if (item.type === 'obstacle' && !this.placementController) { return; }
        if (item.type !== 'obstacle' && !this.projectileController) { return; }
        if (this.cooldownProvider) {
          const cd = num(this.cooldownProvider(id), 0);
          if (cd > 0) { return; }
        }
        ids.push(id);
      });
      return ids;
    }

    /** 本回合还能不能移动 */
    canUseMove() {
      if (this.canMoveProvider) { return !!this.canMoveProvider(); }
      const mc = this.moveController;
      if (!mc || typeof mc.canUseMove !== 'function') { return false; }
      return !!mc.canUseMove();
    }

    /** 兜底投掷道具（配置的 fallbackItemId，冷却中则换一件可用爆炸道具） */
    findFallbackItem() {
      const items = (this.itemsProvider() || []).filter(function (it) {
        return it && it.type !== 'obstacle';
      });
      if (items.length === 0) { return null; }

      const cfg = this.config;
      const wantId = cfg ? cfg.fallbackItemId : 'cherry_bomb';
      let primary = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].id === wantId) { primary = items[i]; break; }
      }
      if (!primary) { primary = items[0]; }

      if (this.cooldownProvider && num(this.cooldownProvider(primary.id), 0) > 0) {
        for (let j = 0; j < items.length; j++) {
          if (items[j].id !== primary.id && num(this.cooldownProvider(items[j].id), 0) <= 0) {
            return items[j];
          }
        }
      }
      return primary;
    }

    /** 预测器的世界数据（地形 / 水面 / 边界），供 AIPlanner 搜索用 */
    world() {
      const p = this.predictor;
      if (p && typeof p.getWorld === 'function') {
        try { return p.getWorld() || {}; } catch (e) { return {}; }
      }
      return {};
    }

    /** 把 AI 选中的单位同步到选区（HUD 可见），失败不影响决策 */
    selectUnitForHud(unit) {
      const us = this.unitSelector;
      if (!us || typeof us.select !== 'function' || !unit) { return false; }
      try { return !!us.select(unit); } catch (e) { return false; }
    }

    /** 结束当前回合（仅用于「投掷 / 放置之外的收尾」：移动、兜底与保护） */
    endTurn(reason) {
      const tm = this.turnManager;
      if (!tm || typeof tm.endTurn !== 'function') { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : {};
      const st = (typeof tm.getState === 'function') ? tm.getState() : '';
      if (st === S.GAME_OVER) { return false; }
      if (st === S.TURN_END || st === S.SWITCH_TEAM) { return true; }
      this.stats.ended += 1;
      return !!tm.endTurn(reason || 'ai');
    }

    /* ==================================================================
     * 状态与查询
     * ================================================================== */

    /** 当前是否轮到 AI 阵营 */
    isAiTurn() {
      const tm = this.turnManager;
      if (!tm || typeof tm.getCurrentTeam !== 'function') { return false; }
      return tm.getCurrentTeam() === this.team;
    }

    isGameOver() {
      const tm = this.turnManager;
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : null;
      if (!tm || !S || typeof tm.getState !== 'function') { return false; }
      return tm.getState() === S.GAME_OVER;
    }

    isWaiting() { return this.state === 'waiting'; }
    isActing() { return this.state === 'acting'; }

    /** 是否正在「思考 / 行动」（HUD 需要让位给 AI 提示时用） */
    isBusy() { return this.state === 'waiting' || this.state === 'acting'; }

    /** 跳过剩余延迟立刻决策（自检 / 调试用；不改变对外行为） */
    forceDecide() {
      if (this.state !== 'waiting') { return false; }
      this.waitMs = this.delayMs;
      this.decide();
      return true;
    }

    /** 最近一次决策摘要 */
    getLastPlan() { return this.lastPlan; }

    getStats() {
      return Object.assign({}, this.stats);
    }

    /** HUD 文案 */
    getHintText() {
      if (!this.enabled) { return '敌方 AI 已关闭'; }
      const label = (this.team === 'red') ? '红方 AI' : '敌方 AI';
      if (this.state === 'waiting') {
        const left = Math.max(0, Math.round(this.delayMs - this.waitMs));
        return label + ' 思考中…（' + left + 'ms 后自动行动）';
      }
      if (this.state === 'acting') {
        const p = this.lastPlan;
        const what = p ? ((ACTION_LABEL[p.kind] || p.kind) + ' · ' + (p.itemId || '') +
          (p.targetId ? ' → ' + p.targetId : '')) : this.actKind;
        return label + ' 行动中：' + what;
      }
      return label + ' 待命';
    }

    getState() {
      return {
        enabled: !!this.enabled,
        team: this.team,
        difficulty: this.difficulty,
        state: this.state,
        actKind: this.actKind,
        pendingTurn: this.pendingTurn,
        delayMs: Math.round(this.delayMs),
        waitMs: Math.round(this.waitMs),
        actMs: Math.round(this.actMs),
        isAiTurn: this.isAiTurn(),
        lastPlan: this.lastPlan,
        stats: this.getStats()
      };
    }

    /** 复位（「再来一局」/ 场景关闭前）：回到空闲并清空统计 */
    reset(reason) {
      this.state = 'idle';
      this.actKind = '';
      this.plan = null;
      this.lastPlan = null;
      this.pendingTurn = 0;
      this.waitMs = 0;
      this.actMs = 0;
      this.delayMs = 0;
      this.retry = 0;
      this.followedUpAfterMove = false;
      this.stats = {
        scheduled: 0, decided: 0, thrown: 0, placed: 0, moved: 0,
        ended: 0, aborted: 0, failed: 0
      };
      this.log('AI 复位（' + (reason || 'reset') + '）');
      return this;
    }

    /** 取消本次决策 / 行动窗口（不改统计） */
    cancel(reason) {
      if (this.state === 'idle') { return false; }
      this.state = 'idle';
      this.actKind = '';
      this.plan = null;
      this.waitMs = 0;
      this.actMs = 0;
      this.retry = 0;
      this.followedUpAfterMove = false;
      this.log('AI 取消本次行动（' + (reason || 'cancel') + '）');
      return true;
    }

    /** 一次行动收尾：回到空闲，准备下一个红方回合 */
    finish(reason) {
      this.state = 'idle';
      this.actKind = '';
      this.plan = null;
      this.log('AI 本次行动结束（' + (reason || 'done') + '）');
      return this;
    }

    setEnabled(v) {
      this.enabled = !!v;
      if (!this.enabled) { this.cancel('disabled'); }
      return this;
    }

    isEnabled() { return !!this.enabled; }

    /* ---------------- 内部 ---------------- */

    emit(type, payload) {
      if (this.events && type) { this.events.emit(type, payload); }
    }

    log(msg) {
      if (!this.debug) { return; }
      if (typeof console !== 'undefined') { console.log('[AI] ' + msg); }
    }

    destroy() {
      const E = FK.EVENTS;
      if (this.events && E) {
        this.events.off(E.TURN_START, this.onTurnStartBound);
        this.events.off(E.TURN_END, this.onTurnEndBound);
        this.events.off(E.TURN_SWITCH, this.onTurnSwitchBound);
        this.events.off(E.TURN_STATE_CHANGE, this.onStateChangeBound);
        if (E.GAME_OVER) { this.events.off(E.GAME_OVER, this.onGameOverBound); }
      }
      this.state = 'idle';
      this.plan = null;
      this.projectileController = null;
      this.placementController = null;
      this.moveController = null;
      this.predictor = null;
      this.unitSelector = null;
      this.turnManager = null;
    }
  }

  /**
   * 事件名（events.js 中已集中定义；这里做一次兜底，保证即使常量缺失也不会裸炸）
   * 注意：正常路径一律走 FK.EVENTS，不允许在业务代码里裸写字符串。
   */
  const AI_EVENT = {
    thinking: (FK.EVENTS && FK.EVENTS.AI_THINKING) || 'ai:thinking',
    decided: (FK.EVENTS && FK.EVENTS.AI_DECIDED) || 'ai:decided',
    acted: (FK.EVENTS && FK.EVENTS.AI_ACTED) || 'ai:acted'
  };

  AIController.ACTION_LABEL = Object.freeze(Object.assign({}, ACTION_LABEL));
  AIController.EVENTS = Object.freeze(Object.assign({}, AI_EVENT));

  FK.AIController = AIController;
})();
