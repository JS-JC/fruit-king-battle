/**
 * ============================================================
 * TurnFlowBridge.js —— 回合流转桥（第 7 步从 ProjectileController 拆出）
 * ============================================================
 * 职责（ProjectileController 与 TurnManager 之间的**唯一桥**）：
 *   ① 回合状态查询：能不能投、要不要中止当前投掷
 *   ② 状态推进：沿合法流转表找路径进入 PROJECTILE_FLYING / RESOLVING
 *   ③ 回合口令：本回合是否已投掷（thrownThisTurn）的读写与复位
 *   ④ 结算兜底窗口：爆炸（或落水）后的 resolveRemainMs 倒计时，超时强制推进
 *
 * 为什么单独拆出来：
 *   「怎么算一次爆炸」和「什么时候能进下一个状态」是两件独立的事。
 *   拆开之后第 8 步接入胜负判定时，只要改本文件里的状态路径，
 *   不需要动投掷物 / 引信 / 伤害的任何一行。
 *
 * 两条不可动摇的规则（第 6 步踩过的坑，第 7 步保留）：
 *   · **pathToState 禁止经过 SWITCH_TEAM**
 *     TURN_END → SWITCH_TEAM → TURN_START 在流转表上合法，但那等于开启下一回合；
 *     堵死它，否则会出现「回合都结束了还能把炸弹塞出去」。
 *   · **BFS 找不到路径就不投**，宁可不投也不进脏状态。
 *
 * 依赖：FK.TurnStates（流转表）、EventBus（广播 turn:projectileResolved）
 * 对外：FK.TurnFlowBridge
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class TurnFlowBridge {

    /**
     * @param {Object} [opts]
     *   turnManager    FK.TurnManager 实例（缺省时全部判定退化为「允许」）
     *   controller     FK.ProjectileController 实例（回调 finish / log / setStatus）
     *   resolveDelayMs 爆炸演出结束后的缓冲（毫秒）
     *   resolveTimeoutMs 结算硬上限（毫秒），超时强制推进回合
     *   eventBus       事件总线（缺省 FK.EventBus）
     */
    constructor(opts) {
      opts = opts || {};
      const P = (FK.Config && FK.Config.PROJECTILE) ? FK.Config.PROJECTILE : {};

      this.turnManager = opts.turnManager || null;
      this.controller = opts.controller || null;
      this.eventBus = opts.eventBus || FK.EventBus || null;

      this.resolveDelayMs = num(opts.resolveDelayMs, num(P.resolveDelayMs, 120));
      this.resolveTimeoutMs = num(opts.resolveTimeoutMs, 3000);

      /** 本回合是否已经投掷过 */
      this.thrownThisTurn = false;
      /** 是否处于「已爆炸 / 已落水、等待结算完成」阶段 */
      this.pendingResolve = false;
      /** 结算倒计时（毫秒） */
      this.resolveRemainMs = 0;
      /** 已经走完的结算次数（自检 / HUD 用） */
      this.resolveCount = 0;
      /** 最近一次结算开始的原因（'explode' / 'water'） */
      this.lastResolveReason = '';
    }

    /* ==================================================================
     * 查询：现在能不能投
     * ================================================================== */

    /** 当前回合状态（无 TurnManager 时返回 ''） */
    getState() {
      const tm = this.turnManager;
      return (tm && typeof tm.getState === 'function') ? tm.getState() : '';
    }

    /** 当前阵营 */
    getTeam() {
      const tm = this.turnManager;
      return (tm && typeof tm.getCurrentTeam === 'function') ? tm.getCurrentTeam() : '';
    }

    /** 当前回合数 */
    getTurnNumber() {
      const tm = this.turnManager;
      return (tm && typeof tm.getTurnNumber === 'function') ? tm.getTurnNumber() : 0;
    }

    /** 是否允许在本回合投掷（未投掷过 + 存在合法路径进入飞行态） */
    canThrow() {
      if (this.thrownThisTurn) { return false; }
      const tm = this.turnManager;
      if (!tm || typeof tm.requestState !== 'function') { return true; }
      if (typeof tm.getState !== 'function') { return true; }
      if (tm.getState() === this.states().PROJECTILE_FLYING) { return true; }
      return !!this.pathToState(this.states().PROJECTILE_FLYING);
    }

    /** TurnStates.STATES 的短别名（每处都写 FK.TurnStates.STATES 太啰嗦） */
    states() {
      return (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : {};
    }

    /* ==================================================================
     * 推进：进入飞行态 / 结算态
     * ================================================================== */

    /**
     * 请求进入 PROJECTILE_FLYING。
     * 已在该状态时视为成功（幂等）；否则沿合法流转表走一条最短路径
     * （例如 SELECT_UNIT → AIMING → PROJECTILE_FLYING），
     * 避免因为多等一帧或状态保护推进导致「松手了却没投出去」。
     * @returns {boolean} 是否最终处于 PROJECTILE_FLYING
     */
    enterFlyingState() {
      const tm = this.turnManager;
      if (!tm || typeof tm.requestState !== 'function') { return true; }

      const S = this.states();
      if (tm.getState() === S.PROJECTILE_FLYING) { return true; }

      const path = this.pathToState(S.PROJECTILE_FLYING);
      if (!path) { return false; }

      for (let i = 0; i < path.length; i++) {
        if (!tm.requestState(path[i], 'throw')) { return false; }
      }
      return tm.getState() === S.PROJECTILE_FLYING;
    }

    /**
     * 在状态流转表上找一条从当前状态到 target 的合法路径（BFS）。
     * 重要约束：**不允许经过 SWITCH_TEAM**（见文件头说明）。
     * @param {string} target
     * @returns {string[]|null} 依次需要进入的状态（不含当前状态）；已在 target 时返回 []
     */
    pathToState(target) {
      const TS = FK.TurnStates;
      const S = this.states();
      const tm = this.turnManager;
      if (!TS || !tm || typeof tm.getState !== 'function') { return null; }

      const start = tm.getState();
      if (start === target) { return []; }

      const queue = [[start]];
      const visited = {};
      visited[start] = true;

      while (queue.length > 0) {
        const path = queue.shift();
        const last = path[path.length - 1];
        const nexts = TS.nextStatesOf(last);
        for (let i = 0; i < nexts.length; i++) {
          const n = nexts[i];
          if (visited[n]) { continue; }
          if (n === S.SWITCH_TEAM) { continue; }        // 不允许跨回合
          const np = path.concat(n);
          if (n === target) { return np.slice(1); }
          visited[n] = true;
          queue.push(np);
        }
      }
      return null;
    }

    /* ==================================================================
     * 回合口令（thrownThisTurn）
     * ================================================================== */

    /** 标记本回合已出手 */
    markThrown() {
      this.thrownThisTurn = true;
      return this;
    }

    /** 新回合开始：允许再次投掷 */
    resetForNewTurn() {
      this.thrownThisTurn = false;
      return this;
    }

    /** 本回合是否已投掷 */
    hasThrown() { return this.thrownThisTurn; }

    /* ==================================================================
     * 结算窗口
     * ================================================================== */

    /**
     * 开始结算倒计时（爆炸演出时长 + 缓冲，或落水缓冲）
     * @param {number} durationMs 本次结算需要等待的毫秒数
     * @param {string} [reason] 'explode' / 'water'
     */
    beginResolve(durationMs, reason) {
      this.pendingResolve = true;
      this.resolveRemainMs = Math.max(0, num(durationMs, 0));
      this.lastResolveReason = reason || 'explode';
      return this;
    }

    /** 是否正在等结算 */
    isPendingResolve() { return this.pendingResolve; }

    /** 剩余结算时间（毫秒） */
    getResolveRemainMs() { return Math.max(0, this.resolveRemainMs); }

    /**
     * 结算倒计时推进（由 ProjectileController.update 每帧调用）
     * @param {number} deltaMs
     * @returns {boolean} 是否本帧触发了「强制推进回合」
     */
    tick(deltaMs) {
      if (!this.pendingResolve) { return false; }
      this.resolveRemainMs -= Math.max(0, num(deltaMs, 0));
      if (this.resolveRemainMs <= 0) {
        this.log('结算兜底触发，强制推进回合');
        this.finish();
        return true;
      }
      return false;
    }

    /**
     * 结算完成：广播 turn:projectileResolved → TurnManager 进入 RESOLVING →（自动）TURN_END
     * @param {Object} [summary] 结算摘要（受击数 / 击退数等）
     * @returns {boolean} 是否成功推进
     */
    finish(summary) {
      if (!this.pendingResolve) { return false; }
      const s = summary || {};
      this.pendingResolve = false;
      this.resolveRemainMs = 0;
      this.resolveCount += 1;

      const c = this.controller;
      if (c && typeof c.setStatus === 'function') { c.setStatus('resolved', '结算完成'); }
      // 统计口径仍然留在控制器（stats.resolved），由它自己记一次，避免两处各加一遍
      if (c && typeof c.onResolveComplete === 'function') { c.onResolveComplete(); }

      this.emit((FK.EVENTS && FK.EVENTS.TURN_PROJECTILE_RESOLVED) || 'turn:projectileResolved', {
        id: num(s.id, 0),
        itemId: s.itemId || '',
        x: s.x,
        y: s.y,
        sunk: !!s.sunk,
        exploded: s.sunk ? false : true,
        damaged: num(s.damaged, 0),
        knockbacked: num(s.knockbacked, 0),
        turnNumber: this.getTurnNumber(),
        team: this.getTeam()
      });

      this.log('投掷结算完成：伤害 ' + num(s.damaged, 0) + ' 个 · 击退 ' +
        num(s.knockbacked, 0) + ' 个，回合继续流转');

      this.advanceToResolving();
      return true;
    }

    /** 从飞行态推进到 RESOLVING（失败则直接结束回合，绝不卡住） */
    advanceToResolving() {
      const tm = this.turnManager;
      if (!tm || typeof tm.requestState !== 'function') { return false; }

      const S = this.states();
      if (tm.getState() !== S.PROJECTILE_FLYING) { return false; }

      if (tm.requestState(S.RESOLVING, 'projectile-resolved')) { return true; }
      this.log('无法进入 RESOLVING，尝试直接结束回合');
      if (typeof tm.endTurn === 'function') { tm.endTurn('projectile-resolved'); }
      return false;
    }

    /* ==================================================================
     * 回合事件
     * ================================================================== */

    /**
     * 回合状态变化：新回合复位口令；飞行中被强制结束则中止投掷
     *
     * 第 8 步补充（规则 3）：
     *   · 进入 GAME_OVER → 关掉伤害，但**不中止**正在飞的投掷物
     *     （它继续飞完，只是爆炸不再造成任何伤害）；
     *   · 因此「TURN_END 中止飞行」这条规则在 controller 声明
     *     isFlyingProtected() 为真时让行（胜负已分的那次强制 TURN_END 属于此列）。
     * @param {Object} payload { from, to, reason }
     */
    onTurnStateChange(payload) {
      const S = this.states();
      if (!payload) { return; }

      if (payload.to === S.TURN_START) { this.resetForNewTurn(); }

      if (payload.to === S.GAME_OVER && payload.from !== S.GAME_OVER) {
        if (this.controller && typeof this.controller.suspendDamage === 'function') {
          this.controller.suspendDamage();
        }
      }

      // 投掷物在飞行中被强制结束回合（超时保护 / 手动结束）：不允许它拖到下一回合
      if (payload.from === S.PROJECTILE_FLYING &&
          (payload.to === S.TURN_END || payload.to === S.GAME_OVER)) {
        const protectedFlying = !!(this.controller &&
          typeof this.controller.isFlyingProtected === 'function' &&
          this.controller.isFlyingProtected());
        if (!protectedFlying && this.controller && typeof this.controller.abort === 'function') {
          this.controller.abort('turn-ended-' + payload.to);
        }
      }
    }

    /** 广播（payload 由调用方准备好；事件常量由调用方从 FK.EVENTS 取，本文件不裸写） */
    emit(type, payload) {
      if (this.eventBus && type) { this.eventBus.emit(type, payload); }
    }

    log(msg) {
      const c = this.controller;
      if (c && typeof c.log === 'function') { c.log(msg); }
    }
  }

  FK.TurnFlowBridge = TurnFlowBridge;
})();
