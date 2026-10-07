/**
 * ============================================================
 * ItemCooldown.js —— 道具冷却（第 7.8 步新增，按阵营独立记账 · 第 7.9 步对齐口径）
 * ============================================================
 * 职责：
 *   维护「**某一方的某个道具**还有几个自己的行动回合不能用」这一件事，供三处查询：
 *     · PlacementController —— 放置类道具（水果箱）冷却中禁止放置
 *     · ItemBar             —— 道具栏格子显示「冷却中 / 灰色不可点」
 *     · BattleScene / HUD   —— 底部提示行显示冷却状态
 *
 * 冷却语义（与 items.json → cooldownTurns 一一对应）：
 *   某一方在第 N 个 turn 使用道具后，**第 N+1 个 turn 内不能再用**（该 turn 结束时归零），
 *   第 N+2 个 turn 已恢复可用。例：蓝方 Turn 1 放箱子 → Turn 2 处于冷却 →
 *   Turn 3 蓝方行动时已恢复（"中间隔 1 个回合"就能再放）。
 *
 * 为什么要按阵营分别记账：
 *   双方轮流行动，且道具栏是共用的。若只有一份全局冷却，
 *   蓝方用完就会把红方也一起卡住（红方 Turn 2 想放却放不了）。
 *   因此冷却键是 team + itemId：每一方只受自己那一次使用的影响，
 *   别人用不用水果箱与自己无关（蓝方冷却不影响红方 = 红方可照常放）。
 *
 * 计时细节（两个坑，都有自检覆盖）：
 *   ① 使用当回合不扣自己的冷却：使用那一刻只登记 pending，
 *      等这个 turn 的 turn:end 到来才转成正式冷却（remaining = cooldownTurns）；
 *      否则「放完箱子当回合结束就扣完」，等于没有冷却。
 *   ② 冷却按 turn 递减（每经过一个 turn:end 扣 1）：因此冷却最多持续
 *      cooldownTurns 个 turn；1 个 turn 的冷却会被对方那个回合"用掉"，
 *      这正是策划要的效果——**同一方连续两次行动都能放箱子**，
 *      真正把每方同时在场数量压到 2 个的是「存活 4 个 turn」这条规则。
 *
 * 计时驱动：
 *   由 BattleScene 在既有 `turn:end` 事件里调用 onTurnEnd(turnNumber, team)，
 *   与障碍物倒计时共用同一个回合节拍；**不新增事件常量**。
 *
 * 纯逻辑：不依赖 Phaser，可在 Node 里独立单测。
 *
 * 依赖：无
 * 对外：FK.ItemCooldown
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  /** 冷却键：阵营 + 道具（红蓝各自记账，互不影响） */
  function keyOf(team, itemId) {
    return (team || '') + '|' + (itemId || '');
  }

  class ItemCooldown {

    /**
     * @param {Object} [opts]
     *   eventBus  事件总线（保留：本步不广播冷却变化，UI 直接查询）
     */
    constructor(opts) {
      opts = opts || {};
      this.eventBus = opts.eventBus || FK.EventBus || null;

      /** 正式冷却中的剩余本人回合数：{ 'team|itemId': number } */
      this.remaining = {};
      /** 本回合刚使用、等这个 turn 结束才转正的冷却：{ 'team|itemId': number } */
      this.pending = {};
      /** 每个 阵营+道具 最近一次使用的回合号：{ 'team|itemId': number } */
      this.usedTurn = {};
      /** 最近一次推进所属的回合号 */
      this.lastTurnNumber = 0;
      /** 统计（自检 / HUD 用） */
      this.stats = { started: 0, ticked: 0, expired: 0 };
    }

    /* ==================================================================
     * 写入
     * ================================================================== */

    /**
     * 登记一次「使用」（由 BattleScene 在 item:used 时调用）
     * @param {string} team 'blue' | 'red'（使用方阵营）
     * @param {string} itemId
     * @param {number} turns 冷却回合数（来自 ItemConfig.cooldownTurns；≤0 表示无冷却）
     * @param {number} [turnNumber] 使用时的回合号（HUD / 自检用）
     * @returns {ItemCooldown} this
     */
    start(team, itemId, turns, turnNumber) {
      if (!itemId) { return this; }
      const k = keyOf(team, itemId);
      const t = Math.max(0, Math.round(num(turns, 0)));
      this.usedTurn[k] = num(turnNumber, 0);

      if (t <= 0) {
        // 无冷却的道具：清掉历史状态，避免残留
        this.pending[k] = 0;
        this.remaining[k] = 0;
        return this;
      }
      // 使用当回合不立即进入冷却，等本人回合的 turn:end 转正（见文件头 ①）
      this.pending[k] = t;
      this.remaining[k] = 0;
      this.stats.started += 1;
      return this;
    }

    /**
     * 回合结束（由 BattleScene 在 turn:end 调用）
     *   · 本回合使用过的道具：pending 转正为 remaining（使用当回合不计入）
     *   · 已冷却中的道具：-1（按 turn 递减，因此会被对方那个回合"用掉"）
     * @param {number} [turnNumber] 本次 turn:end 所属回合号
     * @param {string} [team] 刚结束回合的阵营（缺省 = 不推进任何一方）
     * @returns {ItemCooldown} this
     */
    onTurnEnd(turnNumber, team) {
      const t = team || '';
      this.lastTurnNumber = num(turnNumber, 0);
      if (!t) { return this; }

      const ids = Object.keys(this.pending);
      const justArmed = {};
      for (let i = 0; i < ids.length; i++) {
        const k = ids[i];
        if (k.indexOf(t + '|') !== 0) { continue; }          // 只处理这一方
        if (this.pending[k] > 0) {
          this.remaining[k] = this.pending[k];               // 转正：使用当回合不计入冷却
          this.pending[k] = 0;
          justArmed[k] = true;                               // 本次刚转正，本回合不再递减
          this.stats.ticked += 1;
        } else {
          delete this.pending[k];
        }
      }

      const cooling = Object.keys(this.remaining);
      for (let i = 0; i < cooling.length; i++) {
        const k = cooling[i];
        if (justArmed[k]) { continue; }                       // 转正的那一次不递减
        if (this.remaining[k] <= 0) { delete this.remaining[k]; continue; }
        this.remaining[k] -= 1;
        if (this.remaining[k] <= 0) {
          this.remaining[k] = 0;
          this.stats.expired += 1;
        }
      }
      return this;
    }

    /**
     * 清空冷却状态
     * @param {string} [team] 只清某一方；缺省清全部（对局重置 / 场景销毁）
     */
    clear(team) {
      if (!team) {
        this.remaining = {};
        this.pending = {};
        this.usedTurn = {};
        return this;
      }
      const prefix = team + '|';
      [this.remaining, this.pending, this.usedTurn].forEach(function (bag) {
        Object.keys(bag).forEach(function (k) {
          if (k.indexOf(prefix) === 0) { delete bag[k]; }
        });
      });
      return this;
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /** 该方该道具是否可用（未在使用当回合的 pending 中、也不在冷却中） */
    isReady(team, itemId) {
      return this.getRemaining(team, itemId) <= 0;
    }

    /** 该方该道具剩余冷却（自己还有几个行动回合不能用；0 = 可用） */
    getRemaining(team, itemId) {
      if (!itemId) { return 0; }
      return Math.max(0, num(this.remaining[keyOf(team, itemId)], 0));
    }

    /** 该方该道具是否刚在本回合使用过（等这个 turn 结束才进入冷却） */
    isPending(team, itemId) {
      if (!itemId) { return false; }
      return num(this.pending[keyOf(team, itemId)], 0) > 0;
    }

    /** 该方该道具最近一次使用的回合号（从未使用返回 -1） */
    getUsedTurn(team, itemId) {
      const k = keyOf(team, itemId);
      return (typeof this.usedTurn[k] === 'number') ? this.usedTurn[k] : -1;
    }

    /** 某一方冷却中的道具快照：{ itemId: remainingTurns } */
    snapshot(team) {
      const out = {};
      const prefix = (team || '') + '|';
      const ids = Object.keys(this.remaining);
      for (let i = 0; i < ids.length; i++) {
        const k = ids[i];
        if (k.indexOf(prefix) !== 0) { continue; }
        if (this.remaining[k] > 0) { out[k.slice(prefix.length)] = this.remaining[k]; }
      }
      return out;
    }

    /** 全部阵营的冷却快照：{ 'team|itemId': remaining } */
    snapshotAll() {
      const out = {};
      const ids = Object.keys(this.remaining);
      for (let i = 0; i < ids.length; i++) {
        if (this.remaining[ids[i]] > 0) { out[ids[i]] = this.remaining[ids[i]]; }
      }
      return out;
    }

    /** 某一方是否有道具在冷却中 */
    hasCooling(team) {
      return Object.keys(this.snapshot(team)).length > 0;
    }

    /** 统计快照 */
    getStats() {
      return {
        started: this.stats.started,
        ticked: this.stats.ticked,
        expired: this.stats.expired,
        cooling: Object.keys(this.snapshotAll()).length
      };
    }
  }

  ItemCooldown.keyOf = keyOf;
  FK.ItemCooldown = ItemCooldown;
})();
