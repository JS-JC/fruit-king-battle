/**
 * ============================================================
 * TurnManager.js —— 回合状态机
 * ============================================================
 * 职责：
 *   驱动回合状态流转、维护 30 秒倒计时、轮转阵营，
 *   并通过 EventBus 广播所有关键节点。
 *
 * 设计原则：
 *   · 纯 JS，不依赖 Phaser，不硬引用任何单位 / 道具 / 地图
 *   · 状态定义与流转规则来自 js/config/turnStates.js（本类不定义规则）
 *   · 所有状态变化通过 EventBus 广播，事件名取自 js/config/events.js
 *   · 倒计时用毫秒精度累减，不受帧率影响
 *   · 永不卡回合：每个状态都有超时保护，tick 内部 try/catch，异常也会强制结束回合
 *   · **turn:end 的广播口径 = 「进入 TURN_END 状态」**（第 7.5 步修正）：
 *     无论状态是被 endTurn() 主动推进、还是被自动推进 / 超时保护推进过来，
 *     只要进入 TURN_END 就恰好广播一次。依赖它的模块（障碍物倒计时等）
 *     只认这一个事件，不会漏也不会重复。
 *
 * 对外方法：
 *   start()              开始第一回合（IDLE → TURN_START）
 *   tick(deltaTime)      每帧调用，传入距上一帧的毫秒数
 *   endTurn(reason)      主动结束当前回合（沿合法路径推进到 TURN_END）
 *   switchTeam()         切换阵营并开启下一回合（沿合法路径推进到 TURN_START）
 *   getState()           当前状态名
 *   getCurrentTeam()     当前阵营
 *   getRemainingTime()   剩余毫秒
 *   reset()              重置状态机（回到 IDLE）
 * 附加方法（调试 / 后续步骤使用）：
 *   gameOver(reason, winner)   进入终态并广播 game:over
 *   requestState(next, reason) 请求一步流转，非法即拒绝（不抛异常）
 *   canTransition(from, to)    查询流转表
 *   getTurnNumber() / getLog() / getStateMeta() / isRunning()
 *
 * 依赖：FK.EventBus、FK.EVENTS、FK.TurnStates
 * 对外：FK.TurnManager
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 阵营中文名（仅用于日志可读性） */
  const TEAM_LABELS = { blue: '蓝色方', red: '红色方' };

  /** 日志缓冲上限 */
  const DEFAULT_LOG_LIMIT = 20;

  /** 取数字，非法时回退默认值 */
  function num(v, def, min) {
    if (typeof v !== 'number' || !isFinite(v)) { return def; }
    if (typeof min === 'number' && v < min) { return def; }
    return v;
  }

  /**
   * 归一化回合配置（缺字段时用默认值，非法值回退默认）
   * @param {Object} config 通常来自 FK.Configs.turn
   */
  function normalizeConfig(config) {
    const cfg = config || {};
    const TS = FK.TurnStates;

    const teamOrder = (Array.isArray(cfg.teamOrder) && cfg.teamOrder.length > 0)
      ? cfg.teamOrder.slice()
      : ['blue', 'red'];

    const out = {
      turnTime: num(cfg.turnTime, 30000, 100),
      teamOrder: teamOrder,
      timeoutProtection: num(cfg.timeoutProtection, 5000, 0),
      stateDurations: Object.assign({}, TS.defaultStateDurations(), cfg.stateDurations || {}),
      logToConsole: cfg.logToConsole !== false,
      logLimit: num(cfg.logLimit, DEFAULT_LOG_LIMIT, 1),
      maxTurns: num(cfg.maxTurns, (FK.Config && FK.Config.TURN && FK.Config.TURN.maxTurns) || 40, 1)
    };

    // 初始阵营必须存在于 teamOrder，否则回退到第一个
    out.initialTeam = teamOrder.indexOf(cfg.initialTeam) >= 0 ? cfg.initialTeam : teamOrder[0];
    return out;
  }

  class TurnManager {

    /**
     * @param {Object} [config] 回合配置；缺省读取 FK.Configs.turn，再缺省用内置默认值
     * @param {Object} [eventBus] 事件总线；缺省使用 FK.EventBus
     */
    constructor(config, eventBus) {
      const S = FK.TurnStates.STATES;

      this._config = normalizeConfig(config || (FK.Configs && FK.Configs.turn) || null);
      this._bus = eventBus || FK.EventBus || null;

      this._state = S.IDLE;
      this._teamIndex = Math.max(0, this._config.teamOrder.indexOf(this._config.initialTeam));
      this._turnNumber = 0;
      this._remaining = this._config.turnTime;
      this._stateElapsed = 0;
      this._elapsedTotal = 0;
      this._lastWholeSecond = Math.ceil(this._config.turnTime / 1000);
      this._running = false;

      this._entries = [];
      this._seq = 0;
    }

    /* ==================================================================
     * 公开 API
     * ================================================================== */

    /**
     * 开始第一回合
     * @returns {boolean} 是否成功进入 TURN_START
     */
    start() {
      const S = FK.TurnStates.STATES;
      if (this._state !== S.IDLE) { this.reset(); }

      this._teamIndex = Math.max(0, this._config.teamOrder.indexOf(this._config.initialTeam));
      this._turnNumber = 1;
      this._remaining = this._config.turnTime;
      this._stateElapsed = 0;
      this._elapsedTotal = 0;
      this._lastWholeSecond = Math.ceil(this._config.turnTime / 1000);
      this._running = true;

      this._log('START', '对局开始：先手 ' + this._teamLabel() +
        '，回合时长 ' + this._config.turnTime + 'ms，阵营顺序 [' +
        this._config.teamOrder.join(' → ') + ']');

      return this.requestState(S.TURN_START, 'start');
    }

    /**
     * 每帧驱动
     * @param {number} deltaTime 距上一帧的毫秒数
     * @returns {TurnManager} this
     */
    tick(deltaTime) {
      const S = FK.TurnStates.STATES;
      const TS = FK.TurnStates;

      if (!this._running) { return this; }
      if (this._state === S.GAME_OVER) { return this; }

      const dt = (typeof deltaTime === 'number' && isFinite(deltaTime) && deltaTime > 0) ? deltaTime : 0;
      if (dt === 0) { return this; }

      this._elapsedTotal += dt;
      this._stateElapsed += dt;

      try {
        const meta = TS.metaOf(this._state);
        if (!meta) {
          this._log('ERROR', '未知状态 "' + this._state + '"，强制结束回合', 'warn');
          this.endTurn('unknown-state');
          return this;
        }

        /* ---------- 1) 倒计时状态：扣减剩余时间，每秒广播 ---------- */
        if (meta.countdown) {
          this._remaining -= dt;

          if (this._remaining <= 0) {
            this._remaining = 0;
            this._lastWholeSecond = 0;
            this._emit(FK.EVENTS.TURN_TICK, { secondsLeft: 0, remainingTime: 0 });
            this._log('TIMEOUT', '倒计时归零，自动结束回合（' + this._teamLabel() + '）');
            this._emit(FK.EVENTS.TURN_TIMEOUT, {});
            this.endTurn('timeout');
            return this;
          }

          const sec = Math.ceil(this._remaining / 1000);
          if (sec !== this._lastWholeSecond) {
            this._lastWholeSecond = sec;
            this._emit(FK.EVENTS.TURN_TICK, { secondsLeft: sec, remainingTime: Math.round(this._remaining) });
          }
        }

        /* ---------- 2) 自动推进状态：停留够时长即进入后继状态 ---------- */
        const autoMs = this._autoMsOf(this._state);
        if (autoMs !== null && this._stateElapsed >= autoMs) {
          if (this._state === S.SWITCH_TEAM) {
            this.switchTeam();                     // 轮转阵营 + 进入 TURN_START
          } else {
            const nexts = TS.nextStatesOf(this._state);
            if (nexts.length === 0) {
              this._log('WARN', '状态 ' + this._state + ' 没有后继状态，无法自动推进', 'warn');
            } else {
              this.requestState(nexts[0], 'auto');
            }
          }
          return this;
        }

        /* ---------- 3) 超时保护：任何状态停留过久都强制推进 ---------- */
        const protect = TS.resolveProtectMs(this._state, this._config);
        if (protect > 0 && this._stateElapsed >= protect) {
          this._log('PROTECT', '状态 ' + this._state + ' 停留 ' + Math.round(this._stateElapsed) +
            'ms 超过保护阈值 ' + protect + 'ms，强制推进到 ' + meta.protectNext, 'warn');
          this._forceThrough(meta.protectNext, 'protection');
          return this;
        }
      } catch (e) {
        // 任何异常都不允许让状态机停住
        this._log('ERROR', 'tick 抛出异常：' + ((e && e.message) ? e.message : String(e)) + '，强制结束回合', 'warn');
        try { this.endTurn('exception'); } catch (e2) { /* 最后一道防线：忽略 */ }
      }

      return this;
    }

    /**
     * 主动结束当前回合（沿合法路径推进到 TURN_END）
     * 说明：turn:end 由 _enterState 在进入 TURN_END 时统一广播，本方法不重复广播。
     * @param {string} [reason] 结束原因（timeout / manual / exception ...）
     * @returns {boolean}
     */
    endTurn(reason) {
      const S = FK.TurnStates.STATES;
      if (this._state === S.GAME_OVER) { return false; }
      if (this._state === S.TURN_END) { return true; }   // 幂等

      const path = this._pathTo(S.TURN_END);
      if (!path) {
        this._log('REJECT', '无法从 ' + this._state + ' 结束回合', 'warn');
        return false;
      }

      const why = reason || 'manual';
      path.forEach(function (s) { this.requestState(s, why); }, this);

      this._log('TURN_END', '回合 ' + this._turnNumber + '（' + this._teamLabel() + '）结束，原因：' + why);
      // 注意：turn:end 的广播已统一挪到 _enterState（进入 TURN_END 状态时），
      // 这里不再重复广播——否则「进入状态」与「主动结束」两条路径会各播一次。
      return true;
    }

    /**
     * 切换阵营并开启下一回合（沿合法路径推进到 TURN_START）
     * @returns {boolean}
     */
    switchTeam() {
      const S = FK.TurnStates.STATES;
      if (this._state === S.GAME_OVER) { return false; }
      if (!this._running) { return false; }

      // 容错推进：允许从任意非 SWITCH_TEAM 状态调用，沿途只走合法流转
      if (this._state !== S.SWITCH_TEAM) {
        if (this._state !== S.TURN_END) {
          if (!this.endTurn('switchTeam')) { return false; }
        }
        if (!this.requestState(S.SWITCH_TEAM, 'switchTeam')) { return false; }
      }

      const previousTeam = this._config.teamOrder[this._teamIndex];
      this._teamIndex = (this._teamIndex + 1) % this._config.teamOrder.length;
      this._turnNumber += 1;
      this._remaining = this._config.turnTime;
      const team = this._config.teamOrder[this._teamIndex];

      this._log('SWITCH', '阵营切换 ' + previousTeam + ' → ' + team + '，进入第 ' + this._turnNumber + ' 回合');
      this._emit(FK.EVENTS.TURN_SWITCH, { team: team, previousTeam: previousTeam });

      return this.requestState(S.TURN_START, 'team-switched');
    }

    /**
     * 进入终态并广播 game:over
     * 说明：本步只提供入口与事件，胜负判定留待第 8 步。
     * @param {string} [reason]
     * @param {string} [winner] 'blue' | 'red' | 'draw'
     */
    gameOver(reason, winner) {
      const S = FK.TurnStates.STATES;
      if (this._state === S.GAME_OVER) { return false; }

      const why = reason || 'manual';
      const win = winner || 'draw';

      this._log('GAME_OVER', '对局结束：胜方 ' + win + '，原因：' + why);
      this._forceThrough(S.GAME_OVER, why);
      this._running = false;
      this._emit(FK.EVENTS.GAME_OVER, { winner: win, reason: why });
      return true;
    }

    /**
     * 请求一步状态流转。非法流转只记录、不抛异常。
     * @returns {boolean} 是否流转成功
     */
    requestState(next, reason) {
      const TS = FK.TurnStates;
      const from = this._state;

      if (!TS.isState(next)) {
        this._log('REJECT', '未知状态 "' + next + '"，请求被忽略', 'warn');
        return false;
      }
      if (from === next) { return false; }
      if (!TS.canTransition(from, next)) {
        this._log('REJECT', '非法流转 ' + from + ' → ' + next +
          '（原因：' + (reason || '-') + '），请求被忽略', 'warn');
        return false;
      }

      this._enterState(next, reason);
      return true;
    }

    /* -------------------- 查询 -------------------- */

    /** 当前状态名 */
    getState() { return this._state; }

    /** 当前阵营（'blue' / 'red'） */
    getCurrentTeam() { return this._config.teamOrder[this._teamIndex]; }

    /** 剩余毫秒（倒计时状态才递减） */
    getRemainingTime() { return Math.max(0, Math.round(this._remaining)); }

    /** 剩余秒数（向上取整，用于 HUD 显示） */
    getRemainingSeconds() { return Math.max(0, Math.ceil(this._remaining / 1000)); }

    /** 当前行动回合序号（从 1 开始；未开始时为 0） */
    getTurnNumber() { return this._turnNumber; }

    /** 当前状态的元数据 */
    getStateMeta() { return FK.TurnStates.metaOf(this._state); }

    /** 对局是否运行中 */
    isRunning() { return this._running; }

    /** 当前状态已停留毫秒数 */
    getStateElapsed() { return Math.round(this._stateElapsed); }

    /** 只读配置副本 */
    getConfig() {
      return {
        turnTime: this._config.turnTime,
        teamOrder: this._config.teamOrder.slice(),
        initialTeam: this._config.initialTeam,
        timeoutProtection: this._config.timeoutProtection,
        maxTurns: this._config.maxTurns,
        stateDurations: Object.assign({}, this._config.stateDurations)
      };
    }

    /** from → to 是否为允许的一步流转 */
    canTransition(from, to) { return FK.TurnStates.canTransition(from, to); }

    /** 回合日志快照（最多 20 条，按时间顺序） */
    getLog() { return this._entries.slice(); }

    /** 回合日志文本数组（HUD 直接渲染） */
    getLogText() {
      return this._entries.map(function (e) { return e.text; });
    }

    /** 清空日志 */
    clearLog() { this._entries = []; return this; }

    /** 重置状态机（回到 IDLE，清空回合数与日志） */
    reset() {
      const S = FK.TurnStates.STATES;
      this._state = S.IDLE;
      this._teamIndex = Math.max(0, this._config.teamOrder.indexOf(this._config.initialTeam));
      this._turnNumber = 0;
      this._remaining = this._config.turnTime;
      this._stateElapsed = 0;
      this._elapsedTotal = 0;
      this._lastWholeSecond = Math.ceil(this._config.turnTime / 1000);
      this._running = false;
      this._entries = [];
      this._seq = 0;
      return this;
    }

    /* ==================================================================
     * 内部实现
     * ================================================================== */

    /** 进入新状态：重置停留计时、必要时重置倒计时，并广播 */
    _enterState(next, reason) {
      const S = FK.TurnStates.STATES;
      const from = this._state;

      this._state = next;
      this._stateElapsed = 0;

      const meta = FK.TurnStates.metaOf(next);
      const isTurnStart = (next === S.TURN_START);

      if (isTurnStart) {
        // 新回合：倒计时重置为完整回合时长
        this._remaining = this._config.turnTime;
      }
      if (meta && meta.countdown) {
        this._lastWholeSecond = Math.ceil(this._remaining / 1000);
      }

      this._log('STATE', from + ' → ' + next + '（' + (reason || '-') + '）');

      this._emit(FK.EVENTS.TURN_STATE_CHANGE, { from: from, to: next, reason: reason || '' });

      if (isTurnStart) {
        this._emit(FK.EVENTS.TURN_START, { remainingTime: this._config.turnTime });
      }

      /**
       * 第 7.5 步修复：turn:end 改为「**只要进入 TURN_END 状态**就广播」。
       *
       * 原来只在 endTurn() 里显式广播，于是 RESOLVING --自动推进/超时保护--> TURN_END
       * 这条**正常回合结束路径**（投掷结算之后的必经之路）一条 turn:end 都不发，
       * 依赖它的模块（障碍物倒计时 / 取消选中 / 取消瞄准）整局都不会被触发——
       * 表现就是「水果箱生成后回合结束不消失」。
       *
       * 现在：进入 TURN_END 是唯一广播点，无论谁把状态推进过来（endTurn / auto /
       * protection / _forceThrough），都恰好广播一次，语义变成「回合真的结束了」。
       */
      if (next === S.TURN_END) {
        this._emit(FK.EVENTS.TURN_END, { reason: reason || '' });
      }
    }

    /** 某状态的自动推进时长（turn.json 的 stateDurations 优先，否则用元数据默认值） */
    _autoMsOf(state) {
      const overridden = this._config.stateDurations[state];
      if (typeof overridden === 'number') { return overridden; }
      const meta = FK.TurnStates.metaOf(state);
      return (meta && typeof meta.autoMs === 'number') ? meta.autoMs : null;
    }

    /**
     * 在流转表上做 BFS，找一条从当前状态到 target 的合法路径
     * @returns {string[]|null} 需要依次进入的状态；已在 target 时返回 []
     */
    _pathTo(target) {
      const start = this._state;
      if (start === target) { return []; }

      const queue = [[start]];
      const visited = {};
      visited[start] = true;

      while (queue.length > 0) {
        const path = queue.shift();
        const last = path[path.length - 1];
        const nexts = FK.TurnStates.nextStatesOf(last);

        for (let i = 0; i < nexts.length; i++) {
          const n = nexts[i];
          if (visited[n]) { continue; }
          const np = path.concat(n);
          if (n === target) { return np; }
          visited[n] = true;
          queue.push(np);
        }
      }
      return null;
    }

    /** 沿合法路径强制推进到目标状态（永不抛异常） */
    _forceThrough(target, reason) {
      const path = this._pathTo(target);
      if (!path) {
        this._log('REJECT', '无法从 ' + this._state + ' 推进到 ' + target, 'warn');
        return false;
      }
      let ok = true;
      for (let i = 0; i < path.length; i++) {
        if (!this.requestState(path[i], reason)) { ok = false; }
      }
      return ok;
    }

    /** 事件公共负载 */
    _payload(extra) {
      const p = {
        team: this.getCurrentTeam(),
        turnNumber: this._turnNumber,
        state: this._state,
        remainingTime: this.getRemainingTime(),
        stateElapsed: this.getStateElapsed()
      };
      if (extra) {
        Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
      }
      return p;
    }

    /** 广播事件（无 EventBus 时静默） */
    _emit(type, extra) {
      if (!this._bus || !type) { return; }
      this._bus.emit(type, this._payload(extra));
    }

    /** 阵营中文名（日志用） */
    _teamLabel() {
      const t = this.getCurrentTeam();
      return TEAM_LABELS[t] || t;
    }

    /**
     * 写一条回合日志（同时进入 20 条环形缓冲，并按需输出到控制台）
     * 格式：#序号 t=累计毫秒 回合N 阵营 [状态] 消息
     */
    _log(kind, message, level) {
      const entry = {
        seq: ++this._seq,
        timeMs: Math.round(this._elapsedTotal),
        turnNumber: this._turnNumber,
        team: this.getCurrentTeam(),
        state: this._state,
        kind: kind,
        level: level || 'info',
        message: message
      };
      entry.text = '#' + String(entry.seq).padStart(3, '0') +
        ' t=' + String(entry.timeMs).padStart(6, ' ') + 'ms' +
        ' 回合' + entry.turnNumber +
        ' ' + entry.team +
        ' [' + entry.state + '] ' + message;

      this._entries.push(entry);
      while (this._entries.length > this._config.logLimit) { this._entries.shift(); }

      if (this._config.logToConsole && typeof console !== 'undefined') {
        if (entry.level === 'warn') { console.warn('[TurnManager] ' + entry.text); }
        else { console.log('[TurnManager] ' + entry.text); }
      }
      return entry;
    }
  }

  /** 阵营中文名表（HUD 与日志共用） */
  TurnManager.TEAM_LABELS = Object.freeze(Object.assign({}, TEAM_LABELS));

  FK.TurnManager = TurnManager;
})();
