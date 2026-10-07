/**
 * ============================================================
 * DeathSystem.js —— 单位落水判定 + 死亡判定（第 8 步新增）
 * ============================================================
 * 职责（纯逻辑 + EventBus，**不依赖 Phaser**，可在 Node 中完整单测）：
 *   ① 落水判定：单位**碰撞盒底部 y > 水面像素 y** → 判死，reason = 'drowned'
 *   ② 血量判定：单位 hp ≤ 0        → 判死，reason = 'hp_zero'
 *   ③ 死因裁决：同一帧内两个条件都满足 → 一律按 'drowned'（落水优先）
 *   ④ 事件广播：先 unit:died，落水时再补一条 unit:drowned（规则 5 的顺序）
 *   ⑤ 存活查询：给胜负判定（VictorySystem）用的按阵营存活统计
 *
 * 与调用方（BattleScene）的分工：
 *   · 本系统只负责「谁死了、为什么死、广播出去」，
 *     动画与移除（从各单位列表摘掉、缩小消失）由场景 + ui/DeathEffect 负责；
 *   · 本系统**不自己去轮询每一帧**：落水由场景每帧喂一次 checkDrowning()，
 *     血量归零由 DamageSystem 结算完伤害后喂一次 checkHpZero()（规则 2 的时机要求）。
 *
 * 依赖：FK.Config.DEATH、FK.EventBus、FK.EVENTS
 * 对外：FK.DeathSystem（含静态纯函数 bottomOf / isBelowWater）
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 死因常量（唯一取值来源，避免各处写字符串） */
  const REASON = Object.freeze({
    HP_ZERO: 'hp_zero',
    DROWNED: 'drowned'
  });

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function round(v) {
    return Math.round(num(v, 0));
  }

  /** 单位碰撞盒半高（像素）：真实 UnitBase 有 RADIUS 常量，缺省用 24（= 48px 碰撞盒的一半） */
  function halfHeightOf(unit, fallback) {
    if (!unit) { return num(fallback, 24); }
    if (typeof unit.getCollisionRadius === 'function') { return num(unit.getCollisionRadius(), num(fallback, 24)); }
    if (typeof unit.getHitRadius === 'function') { return num(unit.getHitRadius(), num(fallback, 24)); }
    return num(fallback, 24);
  }

  /** 单位碰撞盒底部 y（优先用单位自己的 getBottomY，保证与碰撞盒口径完全一致） */
  function bottomOf(unit, fallbackHalf) {
    if (!unit) { return 0; }
    if (typeof unit.getBottomY === 'function') { return num(unit.getBottomY(), 0); }
    return num(unit.y, 0) + halfHeightOf(unit, fallbackHalf);
  }

  /** 是否已越过水面（waterLevelY 为 null / 非数字时视为「本局没有水」） */
  function isBelowWater(unit, waterLevelY, fallbackHalf) {
    const w = num(waterLevelY, null);
    if (w === null) { return false; }
    return bottomOf(unit, fallbackHalf) > w;
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

  function hpOf(unit) {
    if (!unit) { return 0; }
    if (typeof unit.getHp === 'function') { return num(unit.getHp(), 0); }
    return num(unit.hp, 0);
  }

  class DeathSystem {

    /**
     * @param {Object} [opts]
     *   eventBus       事件总线（缺省 FK.EventBus）
     *   waterLevelY    水面像素 y（缺省 null = 不做落水判定；场景用 map.waterLevel 注入）
     *   unitHalfHeightPx 无 getBottomY / getHitRadius 的鸭子类型单位用的碰撞盒半高
     *   turnNumber     () => 当前回合数（写进事件负载）
     *   debug          是否输出调试日志
     */
    constructor(opts) {
      opts = opts || {};
      const D = (FK.Config && FK.Config.DEATH) ? FK.Config.DEATH : {};

      this.bus = opts.eventBus || FK.EventBus || null;
      this.waterLevelY = num(opts.waterLevelY, null);
      this.unitHalfHeightPx = num(opts.unitHalfHeightPx, 24);
      this.turnNumberProvider = (typeof opts.turnNumber === 'function') ? opts.turnNumber : null;
      this.debug = (opts.debug === undefined)
        ? !!((FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled))
        : !!opts.debug;
      this.freezeOnDeath = (D.freezeOnDeath === undefined) ? true : !!D.freezeOnDeath;

      /** 死亡的按时间顺序记录 */
      this.deaths = [];
      /** unitId → 记录 */
      this.byId = {};
      /** 统计 */
      this.stats = { total: 0, hpZero: 0, drowned: 0 };
    }

    /* ==================================================================
     * 水面 / 回合数
     * ================================================================== */

    /** 注入水面像素 y（来自 data/map.json → waterLevel → arenaY()） */
    setWaterLine(y) {
      this.waterLevelY = num(y, null);
      return this;
    }

    getWaterLine() { return this.waterLevelY; }

    /** 注入回合数提供者（写事件负载用） */
    setTurnNumberProvider(fn) {
      this.turnNumberProvider = (typeof fn === 'function') ? fn : null;
      return this;
    }

    /** 当前回合数（无提供者时为 0） */
    getTurnNumber() {
      return this.turnNumberProvider ? num(this.turnNumberProvider(), 0) : 0;
    }

    /* ==================================================================
     * 判定原语
     * ================================================================== */

    /** 碰撞盒底部 y */
    bottomOf(unit) { return bottomOf(unit, this.unitHalfHeightPx); }

    /** 是否已越过水面（落水判定条件本身） */
    isBelowWater(unit) { return isBelowWater(unit, this.waterLevelY, this.unitHalfHeightPx); }

    /** 是否已死亡 */
    isDead(unit) {
      if (!unit) { return false; }
      if (unit.alive === false) { return true; }
      return !!this.byId[idOf(unit)];
    }

    /** 死因（'hp_zero' | 'drowned' | ''） */
    reasonOf(unit) {
      const rec = unit ? this.byId[idOf(unit)] : null;
      return rec ? rec.reason : (unit && unit.deadReason ? unit.deadReason : '');
    }

    /** 死亡记录（无则 null） */
    getRecord(unitId) { return this.byId[unitId] || null; }

    /* ==================================================================
     * 判定入口
     * ================================================================== */

    /**
     * 每帧落水检测（规则 1：**任何位移**导致落水都要判，不只在击退时）
     * @param {Array} units 存活单位列表（通常是场景的 this.units）
     * @returns {Array} 本次新产生的死亡记录
     */
    checkDrowning(units) {
      const list = Array.isArray(units) ? units : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (!this.accepts(u)) { continue; }
        if (!this.isBelowWater(u)) { continue; }
        const rec = this.markDead(u, REASON.DROWNED);
        if (rec) { out.push(rec); }
      }
      return out;
    }

    /**
     * 伤害结算后的血量归零检测（规则 2：只在伤害事件后调用，不做每帧轮询）
     * @param {Array} units 本次被伤害到的单位（或任意单位列表）
     * @returns {Array} 本次新产生的死亡记录
     */
    checkHpZero(units) {
      const list = Array.isArray(units) ? units : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (!this.accepts(u)) { continue; }
        if (hpOf(u) > 0) { continue; }
        const rec = this.markDead(u, REASON.HP_ZERO);
        if (rec) { out.push(rec); }
      }
      return out;
    }

    /** 是否是需要判定、且尚未死亡的单位 */
    accepts(unit) {
      if (!unit) { return false; }
      if (unit.active === false) { return false; }
      return !this.isDead(unit);
    }

    /**
     * 判死（幂等）：写记录 → 标记单位 → 广播 unit:died（+ unit:drowned）
     *
     * 死因裁决（规则 6）：只要**判定当下**单位已越过水面，一律记为 'drowned'，
     * 于是「同一帧内血量归零 + 落水」天然按落水处理，不需要额外的时序仲裁。
     *
     * @param {Object} unit
     * @param {string} [hint] 期望死因（'hp_zero' | 'drowned'）
     * @returns {Object|null} 死亡记录；已死或非法单位返回 null
     */
    markDead(unit, hint) {
      if (!this.accepts(unit)) { return null; }

      const drowned = (hint === REASON.DROWNED) || this.isBelowWater(unit);
      const reason = drowned ? REASON.DROWNED : REASON.HP_ZERO;
      const unitId = idOf(unit);
      const team = teamOf(unit);

      // 落水死亡不触发击退：冻结击退速度（规则 1）
      if (this.freezeOnDeath || drowned) {
        unit.knockbackVx = 0;
        unit.knockbackVy = 0;
        unit.airborne = false;
      }
      unit.alive = false;
      if (typeof unit.markDead === 'function') { unit.markDead(reason); }

      const record = {
        unit: unit,
        unitId: unitId,
        team: team,
        reason: reason,
        position: { x: round(unit.x), y: round(unit.y) },
        turnNumber: this.getTurnNumber(),
        order: this.deaths.length + 1
      };

      this.deaths.push(record);
      this.byId[unitId] = record;
      this.stats.total += 1;
      if (drowned) { this.stats.drowned += 1; } else { this.stats.hpZero += 1; }

      // ---- 规则 5 广播顺序：先 unit:died，落水时再补 unit:drowned ----
      this.emit(this.eventOf('UNIT_DIED', 'unit:died'), {
        unit: unit,
        unitId: unitId,
        team: team,
        reason: reason,
        position: { x: record.position.x, y: record.position.y },
        turnNumber: record.turnNumber
      });
      if (drowned) {
        this.emit(this.eventOf('UNIT_DROWNED', 'unit:drowned'), {
          unit: unit,
          unitId: unitId,
          team: team,
          position: { x: record.position.x, y: record.position.y },
          turnNumber: record.turnNumber
        });
      }

      if (this.debug) {
        console.log('[DeathSystem] ' + unitId + '(' + team + ') 死亡：' + reason +
          ' @(' + record.position.x + ',' + record.position.y + ') 第 ' + record.turnNumber + ' 回合');
      }
      return record;
    }

    /* ==================================================================
     * 存活查询（胜负判定用）
     * ================================================================== */

    /** 存活单位（按阵营过滤；team 为空 = 全部） */
    aliveUnits(units, team) {
      const list = Array.isArray(units) ? units : [];
      return list.filter(function (u) {
        if (!u || u.active === false) { return false; }
        if (u.alive === false) { return false; }
        if (hpOf(u) <= 0) { return false; }
        if (team && teamOf(u) !== team) { return false; }
        return true;
      });
    }

    /** 存活单位的 id 列表 */
    aliveIds(units, team) {
      return this.aliveUnits(units, team).map(function (u) { return idOf(u); });
    }

    /** 按阵营的存活数：{ blue, red } */
    aliveByTeam(units, teams) {
      const order = (Array.isArray(teams) && teams.length > 0) ? teams : ['blue', 'red'];
      const out = {};
      order.forEach(function (t) { out[t] = 0; }, this);
      this.aliveUnits(units).forEach(function (u) {
        const t = teamOf(u);
        if (out[t] === undefined) { out[t] = 0; }
        out[t] += 1;
      }, this);
      return out;
    }

    /** 某阵营是否全灭 */
    isTeamWiped(units, team) { return this.aliveUnits(units, team).length === 0; }

    /* ==================================================================
     * 查询与复位
     * ================================================================== */

    getDeaths() { return this.deaths.slice(); }

    getLastDeath() { return this.deaths.length ? this.deaths[this.deaths.length - 1] : null; }

    getDeathIds() { return this.deaths.map(function (d) { return d.unitId; }); }

    getStats() {
      return {
        total: this.stats.total,
        hpZero: this.stats.hpZero,
        drowned: this.stats.drowned
      };
    }

    /** 重开对局：清空全部死亡记录 */
    reset() {
      this.deaths = [];
      this.byId = {};
      this.stats = { total: 0, hpZero: 0, drowned: 0 };
      return this;
    }

    /** 事件名（单一来源仍是 js/config/events.js；缺失时用同名字符串兜底） */
    eventOf(key, fallback) {
      return (FK.EVENTS && FK.EVENTS[key]) || fallback;
    }

    emit(type, payload) {
      if (!this.bus || !type) { return; }
      this.bus.emit(type, payload);
    }
  }

  /** 纯函数挂到类上，供场景 / 自检直接调用（无需实例） */
  DeathSystem.REASON = REASON;
  DeathSystem.bottomOf = bottomOf;
  DeathSystem.isBelowWater = isBelowWater;

  FK.DeathSystem = DeathSystem;
})();
