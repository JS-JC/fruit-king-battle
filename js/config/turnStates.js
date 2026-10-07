/**
 * ============================================================
 * turnStates.js —— 回合状态定义与流转表
 * ============================================================
 * 职责：
 *   集中定义回合状态机的「状态枚举」「状态元数据」「允许的流转关系」，
 *   让 TurnManager 只负责驱动，不负责定义规则。
 *   新增一个状态 = 在本文件加一项 + 在 TURN_TRANSITIONS 补一行流转。
 *
 * 设计要点：
 *   · 每个状态都带超时保护（protectMs / protectNext），保证「永不卡回合」
 *   · protectMs 三种写法：
 *       数字        → 固定毫秒
 *       null        → 使用 turn.json 的 timeoutProtection
 *       'TURN'      → turnTime + timeoutProtection（受 30 秒倒计时约束的状态）
 *   · countdown: true 的状态由 TurnManager 每帧扣减剩余时间
 *   · autoMs 非空的状态由 tick 自动推进到后继状态（时长可被 turn.json 的 stateDurations 覆盖）
 *
 * 纯 JS，不依赖 Phaser。
 * 依赖：无
 * 对外：FK.TURN_STATES / FK.TURN_STATE_META / FK.TURN_TRANSITIONS / FK.TurnStates
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. 状态枚举（冻结不可变）
   * ------------------------------------------------------------------ */
  const TURN_STATES = {
    IDLE: 'IDLE',                               // 空闲，等待开始
    TURN_START: 'TURN_START',                   // 回合开始，播放提示
    SELECT_UNIT: 'SELECT_UNIT',                 // 等待玩家选择单位
    AIMING: 'AIMING',                           // 瞄准中，等待拖拽
    PROJECTILE_FLYING: 'PROJECTILE_FLYING',     // 投掷物飞行中
    RESOLVING: 'RESOLVING',                     // 结算中，处理伤害和位移
    TURN_END: 'TURN_END',                       // 回合结束，清理临时状态
    SWITCH_TEAM: 'SWITCH_TEAM',                 // 切换阵营
    GAME_OVER: 'GAME_OVER'                      // 游戏结束（终态）
  };

  const S = TURN_STATES;

  /* ------------------------------------------------------------------
   * 2. 允许的流转关系
   *    只列「合法的一步流转」，TurnManager 会据此拒绝非法跳转。
   * ------------------------------------------------------------------ */
  const TURN_TRANSITIONS = {
    [S.IDLE]:              [S.TURN_START],
    [S.TURN_START]:        [S.SELECT_UNIT],
    [S.SELECT_UNIT]:       [S.AIMING, S.TURN_END],
    [S.AIMING]:            [S.PROJECTILE_FLYING, S.SELECT_UNIT, S.TURN_END],
    [S.PROJECTILE_FLYING]: [S.RESOLVING, S.TURN_END],
    [S.RESOLVING]:         [S.TURN_END],
    [S.TURN_END]:          [S.SWITCH_TEAM, S.GAME_OVER],
    [S.SWITCH_TEAM]:       [S.TURN_START, S.GAME_OVER],
    [S.GAME_OVER]:         []                   // 终态：只能通过 reset() 回到 IDLE
  };

  /* ------------------------------------------------------------------
   * 3. 状态元数据
   * ------------------------------------------------------------------ */
  const TURN_STATE_META = {
    [S.IDLE]: {
      key: S.IDLE, label: '空闲',
      autoMs: null, protectMs: null, protectNext: S.TURN_START,
      countdown: false, acceptsInput: false, terminal: false,
      hint: '对局未开始（start() 之前）'
    },
    [S.TURN_START]: {
      key: S.TURN_START, label: '回合开始',
      autoMs: 400, protectMs: 2000, protectNext: S.SELECT_UNIT,
      countdown: false, acceptsInput: false, terminal: false,
      hint: '播放「轮到 X 方」提示，随后自动进入选择单位'
    },
    [S.SELECT_UNIT]: {
      key: S.SELECT_UNIT, label: '选择单位',
      autoMs: null, protectMs: 'TURN', protectNext: S.TURN_END,
      countdown: true, acceptsInput: true, terminal: false,
      hint: '30 秒倒计时；超时自动结束回合'
    },
    [S.AIMING]: {
      key: S.AIMING, label: '瞄准中',
      autoMs: null, protectMs: 'TURN', protectNext: S.TURN_END,
      countdown: true, acceptsInput: true, terminal: false,
      hint: '拖拽瞄准中；倒计时照常流逝（第 5 步接入）'
    },
    [S.PROJECTILE_FLYING]: {
      key: S.PROJECTILE_FLYING, label: '投掷物飞行',
      autoMs: null, protectMs: 8000, protectNext: S.RESOLVING,
      countdown: false, acceptsInput: false, terminal: false,
      hint: '等投掷物落地/引爆后转结算（第 6 步接入）；8 秒未响应强制转结算'
    },
    [S.RESOLVING]: {
      key: S.RESOLVING, label: '结算中',
      autoMs: null, protectMs: 5000, protectNext: S.TURN_END,
      countdown: false, acceptsInput: false, terminal: false,
      hint: '处理伤害/位移/落水（第 6～8 步接入）；5 秒未响应强制结束回合'
    },
    [S.TURN_END]: {
      key: S.TURN_END, label: '回合结束',
      autoMs: 300, protectMs: 2000, protectNext: S.SWITCH_TEAM,
      countdown: false, acceptsInput: false, terminal: false,
      hint: '清理临时状态（含到期水果箱）、判定胜负'
    },
    [S.SWITCH_TEAM]: {
      key: S.SWITCH_TEAM, label: '切换阵营',
      autoMs: 300, protectMs: 2000, protectNext: S.TURN_START,
      countdown: false, acceptsInput: false, terminal: false,
      hint: '轮转阵营并开启下一回合'
    },
    [S.GAME_OVER]: {
      key: S.GAME_OVER, label: '游戏结束',
      autoMs: null, protectMs: 0, protectNext: S.GAME_OVER,
      countdown: false, acceptsInput: false, terminal: true,
      hint: '终态；只能通过 reset() 回到 IDLE'
    }
  };

  /* ------------------------------------------------------------------
   * 4. 工具方法
   * ------------------------------------------------------------------ */

  /** 全部状态名（按定义顺序） */
  const ALL_STATES = Object.keys(TURN_STATES).map(function (k) { return S[k]; });

  /** 是否为合法状态名 */
  function isState(state) {
    return ALL_STATES.indexOf(state) >= 0;
  }

  /** 取状态元数据；未知状态返回 null */
  function metaOf(state) {
    return Object.prototype.hasOwnProperty.call(TURN_STATE_META, state)
      ? TURN_STATE_META[state] : null;
  }

  /** 是否为终态 */
  function isTerminal(state) {
    const m = metaOf(state);
    return !!(m && m.terminal);
  }

  /** 某状态允许的直接后继 */
  function nextStatesOf(state) {
    return (TURN_TRANSITIONS[state] || []).slice();
  }

  /** 判断 from → to 是否为允许的一步流转 */
  function canTransition(from, to) {
    if (!isState(from) || !isState(to)) { return false; }
    return nextStatesOf(from).indexOf(to) >= 0;
  }

  /** 默认的自动推进时长（可被 turn.json 的 stateDurations 覆盖） */
  function defaultStateDurations() {
    const out = {};
    ALL_STATES.forEach(function (s) {
      if (TURN_STATE_META[s].autoMs !== null) { out[s] = TURN_STATE_META[s].autoMs; }
    });
    return out;
  }

  /** 计算某状态的超时保护毫秒数 */
  function resolveProtectMs(state, config) {
    const m = metaOf(state);
    if (!m) { return 0; }
    const cfg = config || {};
    const p = m.protectMs;
    if (p === 'TURN') {
      return (cfg.turnTime || 0) + (cfg.timeoutProtection || 0);
    }
    if (p === null || p === undefined) {
      return cfg.timeoutProtection || 0;
    }
    return p;
  }

  /* ------------------------------------------------------------------
   * 5. 导出（全部深冻结）
   * ------------------------------------------------------------------ */
  function deepFreeze(o) {
    Object.getOwnPropertyNames(o).forEach(function (k) {
      const v = o[k];
      if (v && typeof v === 'object' && !Object.isFrozen(v)) { deepFreeze(v); }
    });
    return Object.freeze(o);
  }

  FK.TURN_STATES = Object.freeze(TURN_STATES);
  FK.TURN_TRANSITIONS = deepFreeze(TURN_TRANSITIONS);
  FK.TURN_STATE_META = deepFreeze(TURN_STATE_META);

  FK.TurnStates = {
    STATES: FK.TURN_STATES,
    META: FK.TURN_STATE_META,
    TRANSITIONS: FK.TURN_TRANSITIONS,
    ALL: Object.freeze(ALL_STATES.slice()),
    isState: isState,
    metaOf: metaOf,
    isTerminal: isTerminal,
    nextStatesOf: nextStatesOf,
    canTransition: canTransition,
    defaultStateDurations: defaultStateDurations,
    resolveProtectMs: resolveProtectMs
  };
})();
