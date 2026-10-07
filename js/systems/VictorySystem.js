/**
 * ============================================================
 * VictorySystem.js —— 胜负判定与结果广播（第 8 步新增）
 * ============================================================
 * 职责（纯逻辑 + EventBus，**不依赖 Phaser**）：
 *   ① 统计存活单位：蓝方存活数 / 红方存活数
 *   ② 判定结果（规则 3）：
 *        蓝 = 0 且 红 > 0  → 红方获胜
 *        红 = 0 且 蓝 > 0  → 蓝方获胜
 *        蓝 = 0 且 红 = 0  → 平局（双方同时清空）
 *        双方都 > 0        → 无结果，继续游戏
 *   ③ 按「玩家阵营」分流广播（规则 5）：
 *        winner === playerTeam → game:victory { winner, turnNumber, survivors }
 *        winner !== playerTeam → game:defeat  { loser:  playerTeam, turnNumber }
 *        平局                  → game:draw    { turnNumber }
 *
 * 时机（规则 3）：每次有单位死亡后由 BattleScene 立即调用 settle()，
 * **不做每帧轮询**；调用顺序上一定是「先 unit:died，再 game:victory/defeat/draw」。
 *
 * 依赖：FK.Config.VICTORY、FK.EventBus、FK.EVENTS
 * 对外：FK.VictorySystem（含静态纯函数 judge）
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 结果常量 */
  const OUTCOME = Object.freeze({
    VICTORY: 'victory',
    DEFEAT: 'defeat',
    DRAW: 'draw'
  });

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function count(v) {
    return Math.max(0, Math.floor(num(v, 0)));
  }

  function idOf(unit) {
    if (!unit) { return ''; }
    if (typeof unit.getId === 'function') { return unit.getId(); }
    return unit.unitId || unit.id || '';
  }

  function teamOf(unit) {
    if (!unit) { return ''; }
    if (typeof unit.getTeam === 'function') { return unit.getTeam(); }
    return unit.team || '';
  }

  function isAliveUnit(u) {
    if (!u || u.active === false) { return false; }
    if (u.alive === false) { return false; }
    const hp = (typeof u.getHp === 'function') ? u.getHp() : u.hp;
    return num(hp, 0) > 0;
  }

  /**
   * 纯函数：按阵营存活数判定结果
   * @param {Object} counts { blue, red }
   * @param {Object} [opts] { playerTeam }
   * @returns {{outcome:string|null, winner:string, loser:string, blueAlive:number, redAlive:number}}
   */
  function judge(counts, opts) {
    const c = counts || {};
    const blue = count(c.blue);
    const red = count(c.red);
    const playerTeam = (opts && opts.playerTeam) || ((FK.Config && FK.Config.VICTORY)
      ? FK.Config.VICTORY.playerTeam : 'blue');

    const base = { outcome: null, winner: '', loser: '', blueAlive: blue, redAlive: red };

    if (blue === 0 && red === 0) {
      return Object.assign(base, { outcome: OUTCOME.DRAW, winner: '', loser: '' });
    }
    if (blue === 0 || red === 0) {
      const winner = (blue === 0) ? 'red' : 'blue';
      const loser = (winner === 'blue') ? 'red' : 'blue';
      return Object.assign(base, {
        outcome: (winner === playerTeam) ? OUTCOME.VICTORY : OUTCOME.DEFEAT,
        winner: winner,
        loser: loser
      });
    }
    return base;
  }

  function hpOf(unit) {
    if (!unit) { return 0; }
    if (typeof unit.getHp === 'function') { return Math.max(0, num(unit.getHp(), 0)); }
    return Math.max(0, num(unit.hp, 0));
  }

  function sumHp(units, team) {
    let s = 0;
    (Array.isArray(units) ? units : []).forEach(function (u) {
      if (!isAliveUnit(u)) { return; }
      if (team && teamOf(u) !== team) { return; }
      s += hpOf(u);
    });
    return s;
  }

  /**
   * 回合上限到点：双方都还有人 → 比总血量；相同则平局。
   */
  function judgeTimeout(units, opts) {
    const list = Array.isArray(units) ? units : [];
    const counts = { blue: 0, red: 0 };
    list.forEach(function (u) {
      if (!isAliveUnit(u)) { return; }
      const t = teamOf(u);
      if (t === 'blue' || t === 'red') { counts[t] += 1; }
    });
    if (counts.blue === 0 || counts.red === 0) { return judge(counts, opts); }
    const playerTeam = (opts && opts.playerTeam) || ((FK.Config && FK.Config.VICTORY)
      ? FK.Config.VICTORY.playerTeam : 'blue');
    const blueHp = sumHp(list, 'blue');
    const redHp = sumHp(list, 'red');
    if (blueHp === redHp) {
      return { outcome: OUTCOME.DRAW, winner: '', loser: '', blueAlive: counts.blue, redAlive: counts.red, reason: 'max-turns' };
    }
    const winner = blueHp > redHp ? 'blue' : 'red';
    const loser = winner === 'blue' ? 'red' : 'blue';
    return {
      outcome: (winner === playerTeam) ? OUTCOME.VICTORY : OUTCOME.DEFEAT,
      winner: winner,
      loser: loser,
      blueAlive: counts.blue,
      redAlive: counts.red,
      reason: 'max-turns'
    };
  }

  class VictorySystem {

    /**
     * @param {Object} [opts]
     *   eventBus    事件总线（缺省 FK.EventBus）
     *   playerTeam  玩家阵营（缺省 FK.Config.VICTORY.playerTeam = 'blue'）
     *   turnNumber  () => 当前回合数
     *   debug       是否输出调试日志
     */
    constructor(opts) {
      opts = opts || {};
      const V = (FK.Config && FK.Config.VICTORY) ? FK.Config.VICTORY : {};

      this.bus = opts.eventBus || FK.EventBus || null;
      this.playerTeam = opts.playerTeam || V.playerTeam || 'blue';
      this.turnNumberProvider = (typeof opts.turnNumber === 'function') ? opts.turnNumber : null;
      this.debug = (opts.debug === undefined)
        ? !!((FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled))
        : !!opts.debug;

      /** 最近一次判定结果 */
      this.lastResult = null;
      /** 已经判定出的结果次数（0 = 尚未分出胜负） */
      this.settledCount = 0;
      /** 最后一次广播的事件名 */
      this.lastEventName = '';
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    getPlayerTeam() { return this.playerTeam; }

    getTurnNumber() {
      return this.turnNumberProvider ? num(this.turnNumberProvider(), 0) : 0;
    }

    /** 存活统计（按阵营） */
    countByTeam(units, teams) {
      const order = (Array.isArray(teams) && teams.length > 0) ? teams : ['blue', 'red'];
      const out = {};
      order.forEach(function (t) { out[t] = 0; });
      (Array.isArray(units) ? units : []).forEach(function (u) {
        if (!isAliveUnit(u)) { return; }
        const t = teamOf(u);
        if (out[t] === undefined) { out[t] = 0; }
        out[t] += 1;
      });
      return out;
    }

    /** 某阵营的存活单位 id 列表（game:victory 的 survivors） */
    survivorsOf(units, team) {
      return (Array.isArray(units) ? units : [])
        .filter(function (u) { return isAliveUnit(u) && (!team || teamOf(u) === team); })
        .map(function (u) { return idOf(u); });
    }

    isSettled() { return !!this.lastResult && !!this.lastResult.outcome; }

    getLastResult() { return this.lastResult; }

    /* ==================================================================
     * 判定 + 广播
     * ================================================================== */

    /**
     * 判定（不广播）
     * @param {Array} units 当前存活单位列表
     * @returns {Object} judge() 的结果
     */
    evaluate(units) {
      const counts = this.countByTeam(units);
      return judge(counts, { playerTeam: this.playerTeam });
    }

    /**
     * 结算一次胜负：判定 → 有结果则广播结果事件
     * @param {Array} units 当前存活单位列表（死亡单位**必须已经**从列表里摘掉）
     * @returns {Object} 判定结果（outcome 为 null 表示继续游戏）
     */
    settle(units) {
      const result = this.evaluate(units);
      this.lastResult = result;
      if (!result.outcome) { return result; }

      const payload = this.buildPayload(result, units);
      const eventName = this.emitResult(result, payload);

      this.settledCount += 1;
      this.lastEventName = eventName;
      if (this.debug) {
        console.log('[VictorySystem] ' + result.outcome + '：winner=' + (result.winner || '-') +
          ' 存活 蓝 ' + result.blueAlive + ' / 红 ' + result.redAlive +
          ' → ' + eventName);
      }
      return result;
    }

    /** 第 10 步：回合上限按总血量判胜 */
    settleTimeout(units) {
      const result = Object.assign(judgeTimeout(units, { playerTeam: this.playerTeam }), { reason: 'max-turns' });
      if (result.winner && result.blueAlive === undefined) { /* keep */ }
      this.lastResult = result;
      if (!result.outcome) { return result; }
      const payload = this.buildPayload(result, units);
      payload.reason = 'max-turns';
      const eventName = this.emitResult(result, payload);
      this.settledCount += 1;
      this.lastEventName = eventName;
      return result;
    }

    /** 组装事件负载（字段与规则 5 一致） */
    buildPayload(result, units) {
      const turnNumber = this.getTurnNumber();
      if (result.outcome === OUTCOME.DRAW) {
        return { turnNumber: turnNumber, blueAlive: 0, redAlive: 0 };
      }
      if (result.outcome === OUTCOME.VICTORY) {
        return {
          winner: result.winner,
          turnNumber: turnNumber,
          survivors: this.survivorsOf(units, result.winner),
          blueAlive: result.blueAlive,
          redAlive: result.redAlive
        };
      }
      return {
        loser: result.loser,
        turnNumber: turnNumber,
        blueAlive: result.blueAlive,
        redAlive: result.redAlive
      };
    }

    /**
     * 广播结果事件
     * @returns {string} 实际广播的事件名
     */
    emitResult(result, payload) {
      const E = FK.EVENTS || {};
      let name;
      if (result.outcome === OUTCOME.VICTORY) { name = E.GAME_VICTORY || 'game:victory'; }
      else if (result.outcome === OUTCOME.DEFEAT) { name = E.GAME_DEFEAT || 'game:defeat'; }
      else { name = E.GAME_DRAW || 'game:draw'; }
      this.emit(name, payload);
      return name;
    }

    /** 直接广播一个结果（重开 / 自检可用） */
    emit(name, payload) {
      if (!this.bus || !name) { return; }
      this.bus.emit(name, payload);
    }

    /** 重开对局：清空结果 */
    reset() {
      this.lastResult = null;
      this.settledCount = 0;
      this.lastEventName = '';
      return this;
    }
  }

  /** 供外部拼事件名时复用（防止别处再写一遍字符串） */
  VictorySystem.OUTCOME = OUTCOME;
  VictorySystem.judge = judge;
  VictorySystem.judgeTimeout = judgeTimeout;
  VictorySystem.sumHp = sumHp;

  FK.VictorySystem = VictorySystem;
})();
