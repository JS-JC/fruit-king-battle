/**
 * ============================================================
 * DamageSystem.js —— 范围伤害与击退系统（第 6 步新增）
 * ============================================================
 * 职责：
 *   给定「爆心 + 半径 + 中心伤害 + 击退力度 + 单位列表」，一次性结算：
 *     ① 按距离衰减伤害 → 调 UnitBase.takeDamage()
 *     ② 按距离衰减击退 → 调 UnitBase.applyKnockback()
 *     ③ 广播 damage:applied / unit:knockback
 *
 * 设计原则：
 *   · 纯逻辑 + EventBus，**不依赖 Phaser**，可在 Node 中完整单测；
 *   · 道具模块不直接碰单位：樱桃炸弹只负责「在哪炸、炸多大」，
 *     「扣多少血、推多远」一律由本系统按 ItemConfig 的数值统一处理；
 *   · 死亡判定（血量归零）在第 8 步接入：结算完伤害后回调一次 onDamageSettled，
 *     由 FK.DeathSystem 裁决生死；本系统自身仍然不写任何死亡逻辑。
 *   · GAME_OVER 之后（第 8 步）由 damageGate 拦下全部伤害与击退。
 *
 * 伤害与击退公式（距离衰减，参数全部来自 data/items.json）：
 *
 *   设  d       = 单位中心到爆心的距离（地图单位）
 *       inner   = innerRadiusUnits     满伤内圈半径
 *       outer   = radius               爆炸半径
 *       edge    = edgeDamageRatio      边缘伤害系数（0～1）
 *
 *   falloff(d) =
 *      d ≤ inner            → 1                                     （100%）
 *      inner < d ≤ outer    → edge + (1 − edge) × (outer − d) / (outer − inner)
 *      d > outer            → 0                                     （不在范围内）
 *
 *   damage  = round(damage_center × falloff(d))
 *   speed   = knockback × falloff(d)          ← 与伤害同一条衰减曲线
 *             direction = 单位中心 − 爆心（归一化，纯径向）
 *             vy 再额外 −20%（爆炸把单位轻微掀起，不会把人压进地里）
 *
 *   命中中心（falloff = 1）时的水平位移（单位阻尼 unitDragX = 300 px/s²）：
 *     位移 = v² / (2 × dragX)
 *   例：樱桃炸弹 260 px/s → 260² / 600 = 112.7 px ≈ 2.35 u（爆炸正中心）
 *       实战中爆心在平台表面、单位中心高 1 u，falloff ≈ 0.86
 *       → v ≈ 224 px/s，水平位移 ≈ 83 px ≈ 1.7 u
 *
 * 依赖：FK.Config.DAMAGE、FK.EventBus、FK.EVENTS
 * 对外：FK.DamageSystem（含静态纯函数 computeFalloff / computeKnockback / computeDamage）
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  /** 取数字，非法时返回 undefined（供「未传即读配置」的覆盖参数使用） */
  function numOrUndef(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : undefined;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 保留 n 位小数（仅用于事件负载与日志的可读性，不参与物理计算） */
  function round(v, n) {
    const k = Math.pow(10, n === undefined ? 2 : n);
    return Math.round(v * k) / k;
  }

  /** 事件名（单一来源仍是 js/config/events.js；缺失时用同名字符串兜底） */
  const DAMAGE_EVENT = (FK.EVENTS && FK.EVENTS.DAMAGE_APPLIED) || 'damage:applied';
  const KB_EVENT = (FK.EVENTS && FK.EVENTS.UNIT_KNOCKBACK) || 'unit:knockback';

  /** 取单位世界坐标（兼容真实 UnitBase 与鸭子类型假单位） */
  function posOf(unit) {
    if (!unit) { return { x: 0, y: 0 }; }
    if (unit.pos && typeof unit.pos.x === 'number') { return { x: unit.pos.x, y: unit.pos.y }; }
    return { x: num(unit.x, 0), y: num(unit.y, 0) };
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

  /**
   * 纯函数：距离 → 伤害/击退衰减系数
   *
   * 曲线（见文件头公式）：
   *   d < inner          → 1
   *   inner ≤ d < outer  → edge + (1 − edge) × (outer − d) / (outer − inner)
   *   d ≥ outer          → 0
   *
   * 说明：因为采用严格不等号，距离恰好等于半径时算「不在范围内」（系数 0），
   *       与 TrajectoryPredictor「越过即算碰撞」的边界口径保持一致；
   *       因此最靠近半径内的伤害系数收敛到 edgeDamageRatio
   *       （樱桃炸弹为 0.40 → 边缘 14 点，文档 3 §5）。
   *       这里额外加 EPS 容差，避免浮点误差把「恰好等于内圈」算成「略大于内圈」。
   *
   * @param {number} distanceUnits 距爆心距离（地图单位）
   * @param {number} innerRadiusUnits 满伤内圈半径（u）
   * @param {number} radiusUnits 爆炸半径（u）
   * @param {number} edgeDamageRatio 边缘伤害系数（0～1）
   * @returns {number} 0～1
   */
  function computeFalloff(distanceUnits, innerRadiusUnits, radiusUnits, edgeDamageRatio) {
    const EPS = 1e-9;
    const d = num(distanceUnits, Infinity);
    const outer = num(radiusUnits, 0);
    const edge = clamp(num(edgeDamageRatio, 1), 0, 1);
    const inner = clamp(num(innerRadiusUnits, 0), 0, outer > 0 ? outer : 0);

    if (outer <= 0) { return 0; }
    if (d >= outer - EPS) { return 0; }
    if (d <= inner + EPS) { return 1; }
    const t = (outer - d) / Math.max(1e-6, outer - inner);
    return clamp(edge + (1 - edge) * t, 0, 1);
  }

  /**
   * 纯函数：距离 → 实际伤害
   * @param {number} centerDamage 中心伤害
   * @param {number} falloff 0～1 衰减系数
   * @returns {number} 取整后的伤害（最小 1，只要在范围内就至少造成 1 点，避免“擦边没伤害”）
   */
  function computeDamage(centerDamage, falloff) {
    const dmg = num(centerDamage, 0) * clamp(num(falloff, 0), 0, 1);
    if (dmg <= 0) { return 0; }
    return Math.max(1, Math.round(dmg));
  }

  /**
   * 纯函数：距离 → 击退速度分量（纯径向，远离爆心）
   * @param {Object} input
   *   dx, dy          单位中心 − 爆心（px，y 向下为正）
   *   knockback       中心击退力度（px/s，文档 3 knockback）
   *   falloff         0～1 衰减系数
   *   maxSpeed        推力上限（px/s）
   *   dragX           单位水平阻尼（px/s²，用于中心命中时的兜底方向）
   *   upBias          垂直额外系数（默认 0.8 = 向上预留 20%，避免压进地面）
   * @returns {{vx:number, vy:number, speed:number, dirX:number, dirY:number, falloff:number}}
   */
  function computeKnockback(input) {
    const i = input || {};
    const dx = num(i.dx, 0);
    const dy = num(i.dy, 0);
    const knockback = num(i.knockback, 0);
    const falloff = clamp(num(i.falloff, 0), 0, 1);
    const maxSpeed = num(i.maxSpeed, 700);

    const dist = Math.sqrt(dx * dx + dy * dy);

    let dirX;
    let dirY;
    if (dist > 1e-6) {
      dirX = dx / dist;
      dirY = dy / dist;
    } else {
      // 单位正好站在爆心：方向退化为「水平 + 上抛」，避免零向量导致无击退
      dirX = 1;
      dirY = -1;
      const inv = 1 / Math.sqrt(2);
      dirX *= inv;
      dirY *= inv;
    }

    const speed = Math.min(maxSpeed, knockback * falloff);
    // 爆炸把单位轻微掀起（向上为负），水平分量不做额外缩放
    const vyScale = (dirY < 0) ? num(i.upBias, 0.8) : 1;

    return {
      vx: dirX * speed,
      vy: dirY * speed * vyScale,
      speed: speed,
      dirX: dirX,
      dirY: dirY,
      falloff: falloff,
      distancePx: dist
    };
  }

  /**
   * 第 8.5 步：把「径向击退分量」换算成最终冲量（纯函数，可单测）。
   *
   * 与第 6 步口径的三点区别：
   *   ① 先按 `knockbackScale` 放大冲量，再做 `maxKnockSpeed` 钳制
   *      —— 旧口径直接钳制原始击退值，西瓜炸弹满伤位移只有约 1.5u，弹飞感严重不足；
   *   ② 叠加一份「与水平分量成正比的上抛冲量」`upKick`：爆心与单位几乎同高时，
   *      纯径向推力会让单位贴地滑行，加上这一份才有弧线与滞空；
   *   ③ 垂直分量单独受 `maxVerticalSpeed` 限制，防止斜向叠加把单位顶出画面上方。
   *
   * 所有系数来自 FK.Config.KNOCKBACK（数据驱动，不硬编码）。
   *
   * @param {Object} input { kb, knockbackScale, upKick, maxVerticalSpeed, upBias }
   * @returns {{vx:number, vy:number, speed:number}}
   */
  function shapeKnockback(input) {
    const i = input || {};
    const kb = i.kb || { vx: 0, vy: 0, speed: 0, dirX: 1, dirY: 0 };
    const K = (FK.Config && FK.Config.KNOCKBACK) ? FK.Config.KNOCKBACK : {};

    const scale = Math.max(0, num(i.knockbackScale, num(K.knockbackScale, 1)));
    const upKick = Math.max(0, num(i.upKick, num(K.upKick, 0)));
    const maxVy = Math.max(0, num(i.maxVerticalSpeed, num(K.maxVerticalSpeed, 1200)));
    const upBias = num(i.upBias, 0.8);

    // ① 放大冲量并重新钳制
    const speed = Math.min(num(i.maxSpeed, 700), num(kb.speed, 0) * scale);

    // 方向：沿用径向单位向量（爆心重合时 computeKnockback 已给出 45° 兜底方向）
    let dirX = num(kb.dirX, 0);
    let dirY = num(kb.dirY, 0);
    const mag = Math.sqrt(dirX * dirX + dirY * dirY);
    if (mag > 1e-9) { dirX /= mag; dirY /= mag; } else { dirX = 1; dirY = 0; }

    const vyScale = (dirY < 0) ? upBias : 1;
    const vx = dirX * speed;
    // ②③ 上抛冲量 + 垂直钳制
    let vy = dirY * speed * vyScale - Math.abs(vx) * upKick;
    if (vy < -maxVy) { vy = -maxVy; }
    if (vy > maxVy) { vy = maxVy; }

    // 对外报告的「击退速度」= 最终合速度（含上抛分量），与实际位移口径一致
    const resultSpeed = Math.sqrt(vx * vx + vy * vy);
    return { vx: vx, vy: vy, speed: resultSpeed, impulse: speed };
  }

  class DamageSystem {

    /**
     * @param {Object} [opts]
     *   pxPerUnit    1 地图单位 = 多少像素（默认 FK.Config.PX_PER_UNIT）
     *   eventBus     事件总线（默认 FK.EventBus）
     *   debug        是否输出调试日志
     */
    constructor(opts) {
      opts = opts || {};
      const D = (FK.Config && FK.Config.DAMAGE) ? FK.Config.DAMAGE : {};

      this.pxPerUnit = num(opts.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));
      this.bus = opts.eventBus || FK.EventBus || null;
      this.debug = (opts.debug === undefined) ? !!((FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled)) : !!opts.debug;

      /** 默认参数（全部可被 ItemConfig / 调用参数覆盖） */
      this.defaults = {
        innerRadiusUnits: 0,
        edgeDamageRatio: 1,
        maxKnockSpeed: num(D.maxKnockSpeed, 700),
        /**
         * 径向垂直分量系数（默认 0.8，文档 3 冻结值）。
         * 第 8.5 步起「弹飞感」主要来自 KNOCKBACK.upKick，本系数保持径向口径不变。
         */
        upBias: 0.3
      };

      /**
       * 第 8 步：伤害开关（`() => boolean`）。
       * 进入 GAME_OVER 后由 ProjectileController / BattleScene 关掉：
       * 已在飞的投掷物继续飞完、爆炸动画照播，但**不再造成任何伤害与击退**（规则 3）。
       * 不注入 = 恒开。
       */
      this.damageGate = (typeof opts.damageGate === 'function') ? opts.damageGate : null;

      /**
       * 第 8 步：硬开关（null = 交给 damageGate 决定）。
       * `setDamageEnabled(false)` 会压过一切闸门；`setDamageEnabled(true)` 只解除硬开关，
       * 控制器的 damageGate 依旧生效——这样「重开对局」不会把控制器的闸门永久顶掉。
       */
      this.damageEnabledOverride = null;

      /**
       * 第 8 步：一次爆炸的伤害结算完成后回调一次 `(damagedUnits, result)`。
       * 「血量归零 → 死亡判定」的**唯一触发点**（规则 2：只在伤害事件后检查，不每帧轮询）。
       */
      this.onDamageSettled = (typeof opts.onDamageSettled === 'function') ? opts.onDamageSettled : null;

      /** 统计（HUD / 自检用） */
      this.stats = { explosions: 0, damaged: 0, knockbacked: 0, totalDamage: 0, gated: 0 };
    }

    /* ==================================================================
     * 第 8 步：伤害开关
     * ================================================================== */

    /** 注入伤害开关（返回 false 时爆炸不再结算任何伤害 / 击退） */
    setDamageGate(fn) {
      this.damageGate = (typeof fn === 'function') ? fn : null;
      return this;
    }

    /** 快捷写法：直接开关伤害（false 为硬关闭，压过控制器注入的闸门） */
    setDamageEnabled(v) {
      this.damageEnabledOverride = (v === undefined || v === null) ? null : !!v;
      return this;
    }

    /** 当前是否允许造成伤害（硬开关优先，其次看注入的闸门） */
    isDamageEnabled() {
      if (this.damageEnabledOverride === false) { return false; }
      if (this.damageEnabledOverride === true) { return true; }
      return this.damageGate ? !!this.damageGate() : true;
    }

    /** 注入「伤害结算完成」回调（血量归零判定入口） */
    setDamageSettledHandler(fn) {
      this.onDamageSettled = (typeof fn === 'function') ? fn : null;
      return this;
    }

    /**
     * 结算一次爆炸
     * @param {Object} params
     *   x, y            爆心世界坐标（px）
     *   radiusUnits     爆炸半径（地图单位）
     *   radiusPx        爆炸半径（px），缺省时由 radiusUnits 换算
     *   damage          中心伤害
     *   knockback       击退力度（px/s）
     *   innerRadiusUnits 满伤内圈半径（u）
     *   edgeDamageRatio 边缘伤害系数
     *   units           单位列表（真实 UnitBase 或鸭子类型）
     *   teams           只对哪些阵营生效（不传 = 全部，友伤在第 7 步的道具上决定）
     *   source          来源描述（'cherry_bomb' 等，仅用于事件与日志）
     * @returns {{explosion:Object, damaged:Array, knockbacked:Array, affected:Array, maxDistancePx:number}}
     */
    applyExplosion(params) {
      const p = params || {};
      const x = num(p.x, 0);
      const y = num(p.y, 0);
      const ppx = this.pxPerUnit;

      const radiusUnits = num(p.radiusUnits, 0);
      const radiusPx = num(p.radiusPx, radiusUnits * ppx);
      const innerRadiusUnits = num(p.innerRadiusUnits, this.defaults.innerRadiusUnits);
      const edgeDamageRatio = num(p.edgeDamageRatio, this.defaults.edgeDamageRatio);
      const centerDamage = num(p.damage, 0);
      const knockback = num(p.knockback, 0);
      const maxKnockSpeed = num(p.maxKnockSpeed, this.defaults.maxKnockSpeed);
      const upBias = num(p.upBias, this.defaults.upBias);
      /**
       * 第 8.5 步：冲量成形参数覆盖（留空 → 读 FK.Config.KNOCKBACK）。
       * 单独放出来是为了让自检 / 后续 AI 预判可以注入不同系数做对比，
       * 而不必改动全局配置。
       */
      const knockbackScale = numOrUndef(p.knockbackScale);
      const upKick = numOrUndef(p.upKick);
      const maxVerticalSpeed = numOrUndef(p.maxVerticalSpeed);
      const source = p.source || '';
      const teams = Array.isArray(p.teams) && p.teams.length > 0 ? p.teams : null;
      const units = Array.isArray(p.units) ? p.units : [];

      const result = {
        explosion: {
          x: x, y: y,
          radiusUnits: radiusUnits,
          radiusPx: radiusPx,
          innerRadiusUnits: innerRadiusUnits,
          edgeDamageRatio: edgeDamageRatio,
          damage: centerDamage,
          knockback: knockback,
          source: source
        },
        damaged: [],
        knockbacked: [],
        affected: [],
        maxDistancePx: 0
      };

      if (radiusPx <= 0 && centerDamage <= 0 && knockback <= 0) {
        // 空爆（例如水果箱）：直接返回，不产生任何事件
        return result;
      }

      // 第 8 步（规则 3 / 规则 6）：GAME_OVER 之后到达的投掷物
      // 爆炸演出照常播放，但不再结算任何伤害与击退。
      if (!this.isDamageEnabled()) {
        this.stats.gated += 1;
        if (this.debug) { console.log('[DamageSystem] 已分出胜负，本次爆炸不结算伤害'); }
        return result;
      }

      this.stats.explosions += 1;

      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        if (!unit) { continue; }
        if (unit.active === false) { continue; }
        if (teams && teams.indexOf(teamOf(unit)) < 0) { continue; }
        if (typeof unit.isAlive === 'function' && !unit.isAlive()) { continue; }

        const up = posOf(unit);
        const dx = up.x - x;
        const dy = up.y - y;
        const distancePx = Math.sqrt(dx * dx + dy * dy);
        const distanceUnits = distancePx / ppx;
        const falloff = computeFalloff(distanceUnits, innerRadiusUnits, radiusUnits, edgeDamageRatio);

        if (distancePx > result.maxDistancePx) { result.maxDistancePx = distancePx; }

        const amount = computeDamage(centerDamage, falloff);
        const kb = computeKnockback({
          dx: dx, dy: dy, knockback: knockback, falloff: falloff,
          maxSpeed: maxKnockSpeed, upBias: upBias
        });
        /**
         * 第 8.5 步：径向分量 → 最终冲量
         *   · knockbackScale 放大（配置来自 FK.Config.KNOCKBACK）
         *   · upKick 追加向上的弧线冲量
         *   · 垂直分量单独钳制
         */
        const shaped = shapeKnockback({
          kb: kb, maxSpeed: maxKnockSpeed, upBias: upBias,
          knockbackScale: p.knockbackScale, upKick: p.upKick,
          maxVerticalSpeed: p.maxVerticalSpeed
        });

        const record = {
          unit: unit,
          id: idOf(unit),
          team: teamOf(unit),
          distancePx: round(distancePx, 2),
          distanceUnits: round(distanceUnits, 3),
          falloff: round(falloff, 3),
          amount: amount,
          knockback: round(shaped.speed, 2),
          vx: round(shaped.vx, 2),
          vy: round(shaped.vy, 2),
          inRange: falloff > 0
        };

        if (amount > 0) {
          this.applyDamage(unit, amount, {
            distancePx: distancePx, distanceUnits: distanceUnits,
            falloff: falloff, source: source, explosion: result.explosion
          });
          result.damaged.push(record);
          this.stats.damaged += 1;
          this.stats.totalDamage += amount;
        }

        if (shaped.speed > 0 && amount > 0 && typeof unit.applyKnockback === 'function') {
          // 只有真正被伤害到的单位才会被击退（falloff=0 表示在范围外）
          unit.applyKnockback(shaped.vx, shaped.vy);
          this.emit(KB_EVENT, {
            unit: unit, id: record.id, team: record.team,
            vx: record.vx, vy: record.vy, speed: record.knockback,
            knockback: round(shaped.speed, 2), distance: record.distanceUnits,
            falloff: record.falloff, source: source
          });
          result.knockbacked.push(record);
          this.stats.knockbacked += 1;
        }

        if (record.inRange) { result.affected.push(record); }
      }

      // ---- 第 8 步（规则 2）：伤害结算完成后立即检查血量归零 ----
      // 只把**本次真的被伤害到的单位**交给回调（不在这里做每帧轮询）。
      if (this.onDamageSettled) {
        const hitUnits = result.damaged.map(function (r) { return r.unit; });
        try {
          this.onDamageSettled(hitUnits, result);
        } catch (e) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[DamageSystem] 伤害结算回调异常：' + ((e && e.message) ? e.message : String(e)));
          }
        }
      }

      if (this.debug) {
        console.log('[DamageSystem] ' + (source || 'explosion') + ' @(' + Math.round(x) + ',' + Math.round(y) +
          ') r=' + radiusUnits + 'u(' + Math.round(radiusPx) + 'px) → 伤害 ' + result.damaged.length +
          ' 个 · 击退 ' + result.knockbacked.length + ' 个');
      }

      return result;
    }

    /**
     * 对单个单位结算伤害（扣血 + 广播 damage:applied）
     * @param {Object} unit
     * @param {number} amount 已经过衰减的实际伤害
     * @param {Object} [info] { distancePx, distanceUnits, falloff, source }
     * @returns {number} 扣血后的血量
     */
    applyDamage(unit, amount, info) {
      const i = info || {};
      const n = Math.max(0, num(amount, 0));
      if (!unit || n <= 0) { return unit && typeof unit.getHp === 'function' ? unit.getHp() : 0; }

      let hp = 0;
      if (typeof unit.takeDamage === 'function') {
        hp = unit.takeDamage(n);
      } else {
        hp = Math.max(0, num(unit.hp, 0) - n);
        unit.hp = hp;
      }

      this.emit(DAMAGE_EVENT, {
        unit: unit,
        id: idOf(unit),
        team: teamOf(unit),
        amount: n,
        hp: hp,
        maxHp: (typeof unit.getMaxHp === 'function') ? unit.getMaxHp() : num(unit.maxHp, hp),
        distance: num(i.distanceUnits, 0),
        distancePx: num(i.distancePx, 0),
        falloff: num(i.falloff, 0),
        source: i.source || '',
        // 兼容约定：unit:damaged 由 UnitBase.takeDamage 内部广播，这里广播的是 damage:applied
        explosion: i.explosion || null
      });

      return hp;
    }

    /** 统计快照 */
    getStats() {
      return {
        explosions: this.stats.explosions,
        damaged: this.stats.damaged,
        knockbacked: this.stats.knockbacked,
        totalDamage: this.stats.totalDamage,
        /** 第 8 步：因 GAME_OVER 被拦下的爆炸次数（不影响已有字段） */
        gated: this.stats.gated || 0
      };
    }

    /** 清空统计（重开对局时调用） */
    resetStats() {
      this.stats = { explosions: 0, damaged: 0, knockbacked: 0, totalDamage: 0, gated: 0 };
      return this;
    }

    /** 广播（无 EventBus 时静默） */
    emit(type, payload) {
      if (!this.bus || !type) { return; }
      this.bus.emit(type, payload);
    }
  }

  /** 三个纯函数挂到类上，供 ItemConfig / HUD / 自检直接调用（无需实例） */
  DamageSystem.computeFalloff = computeFalloff;
  DamageSystem.computeDamage = computeDamage;
  DamageSystem.computeKnockback = computeKnockback;
  /* 第 8.5 步：径向击退 → 最终冲量（放大 / 上抛 / 垂直钳制） */
  DamageSystem.shapeKnockback = shapeKnockback;

  FK.DamageSystem = DamageSystem;
})();
