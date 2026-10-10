/**
 * ============================================================
 * AIPlanner.js —— 敌方 AI 的候选搜索与评分（第 9 步新增）
 * ============================================================
 * 职责（**纯 JS：不依赖 Phaser、不依赖场景、不改任何游戏状态**）：
 *   把「AI 该怎么打」拆成一组可单独测试的纯函数：
 *     · pickItem        按权重随机选道具（樱桃 40 / 西瓜 30 / 果箱 20 / 移动 10）
 *     · pickTarget      优先打「血最低」的敌人
 *     · pickUnit        能打到敌人的单位优先，多个候选随机
 *     · searchThrow     力度 × 角度 候选搜索，取「落点离目标最近」的一组参数
 *     · applyError      加误差（力度 ±8% / 角度 ±4°）
 *     · planThrow       一次完整投掷方案（含误差后的初速度 + 重新预测的落点）
 *     · planMove        一次完整移动方案（搜索跳跃参数，落点尽量靠近对手）
 *     · placementSpots  果箱放置候选点（离目标由近到远依次尝试）
 *
 * 设计口径：
 *   · **只做中等难度一档**：误差 / 决策延迟 / 道具权重全部来自 FK.Config.AI，
 *     本文件没有任何硬编码数值；难度分层留到第 13 步（见 gameConfig.AI 注释）。
 *   · AI 只产出「参数」，不碰游戏状态：飞行 / 伤害 / 回合流转全部交给既有链路
 *     （ProjectileController / PlacementController / MoveController），
 *     因此 AI 不可能绕开物理系统直接改血量或瞬移（规则 9）。
 *   · 搜索用的弹道与投掷实飞**同源**：优先复用注入的 TrajectoryPredictor
 *     （与玩家瞄准、投掷物实飞共用同一份积分与碰撞代码）。
 *   · 落点容忍度（AI.error.landingTolerancePx，默认 60px）既是「算不算打得到」的
 *     判据（选单位 / 评分），也是日志里 reachable 的来源。
 *
 * 依赖：FK.Config（AI / AIM / MOVE / KNOCKBACK / PHYSICS）、FK.TrajectoryPredictor、
 *       FK.MoveController.simulatePath（可选，缺失时退化为无地形的解析解模拟）
 * 对外：FK.AIPlanner
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /* ==================================================================
   * 0) 小工具
   * ================================================================== */

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  function hypot(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

  function distBetween(a, b) {
    return hypot(num(b && b.x, 0) - num(a && a.x, 0), num(b && b.y, 0) - num(a && a.y, 0));
  }

  /* ==================================================================
   * 1) 单位访问层
   *    实体（UnitBase）与测试用的普通对象都能读，AI 因此可以在 Node 里跑。
   * ================================================================== */

  function teamOf(u) {
    if (!u) { return ''; }
    if (typeof u.getTeam === 'function') { return u.getTeam() || ''; }
    return u.team || '';
  }

  function idOf(u) {
    if (!u) { return ''; }
    if (typeof u.getId === 'function') { return u.getId() || ''; }
    return u.unitId || u.id || '';
  }

  function hpOf(u) {
    if (!u) { return 0; }
    if (typeof u.getHp === 'function') { return num(u.getHp(), 0); }
    return num(u.hp, 0);
  }

  function isAlive(u) {
    if (!u) { return false; }
    if (u.alive === false) { return false; }
    if (typeof u.isAlive === 'function') { return !!u.isAlive(); }
    return hpOf(u) > 0;
  }

  /** 单位是否处于「不能行动」的运动状态（击退飞行 / 主动移动中） */
  function isBusy(u) {
    if (!u) { return true; }
    if (u.moving) { return true; }
    if (u.airborne) { return true; }
    if (num(u.knockbackVx, 0) !== 0 || num(u.knockbackVy, 0) !== 0) { return true; }
    return false;
  }

  function posOf(u) {
    return { x: num(u && u.x, 0), y: num(u && u.y, 0) };
  }

  /** 某阵营的存活单位 */
  function aliveOf(units, team) {
    const out = [];
    (units || []).forEach(function (u) {
      if (!isAlive(u)) { return; }
      if (team && teamOf(u) !== team) { return; }
      out.push(u);
    });
    return out;
  }

  /** 与指定阵营敌对的存活单位 */
  function enemiesOf(units, team) {
    const out = [];
    (units || []).forEach(function (u) {
      if (!isAlive(u)) { return; }
      if (team && teamOf(u) === team) { return; }
      out.push(u);
    });
    return out;
  }

  /* ==================================================================
   * 2) 配置：与 gameConfig.AI 同形（配置缺失时用同一份默认值兜底）
   * ================================================================== */

  const DEFAULTS = {
    team: 'red',
    difficulty: 'normal',
    thinkDelayMs: { min: 1000, max: 2000 },
    actTimeoutMs: 6000,
    error: { powerRatio: 0.08, angleDeg: 4, landingTolerancePx: 60 },
    itemWeights: { cherry_bomb: 32, watermelon_bomb: 24, banana_bomb: 24, fruit_crate: 12, move: 8 },
    fallbackItemId: 'cherry_bomb',
    search: {
      powerMin: 0.22, powerMax: 1, powerSteps: 18,
      angleMinDeg: 12, angleMaxDeg: 82, angleSteps: 15,
      maxCandidates: 300,
      refineRounds: 3
    },
    move: {
      powerMin: 0.35, powerMax: 1, powerSteps: 8,
      angleMinDeg: 18, angleMaxDeg: 72, angleSteps: 9,
      standoffPx: 336, edgePadPx: 60
    },
    placement: { offsetUnits: [2, 1.5, 2.5, 1, 3], sideStandoffPx: 96 },
    selfPreserve: {
      enabled: true,
      hpThreshold: 0.3,
      edgeDangerUnits: 1.0,
      skipAttackChance: 0.7
    },
    positionAdjust: {
      enabled: true,
      maxSearchSteps: 8
    },
    itemChoice: {
      rules: [
        { condition: 'enemy_hp_gt_40_and_near', item: 'watermelon_bomb' },
        { condition: 'enemy_hp_le_40', item: 'cherry_bomb' },
        { condition: 'enemy_on_edge', item: 'watermelon_bomb' },
        { condition: 'mid_range', item: 'banana_bomb' },
        { condition: 'crates_placed_and_safe', item: 'fruit_crate' },
        { condition: 'fallback', item: 'cherry_bomb' }
      ],
      randomFallbackChance: 0.15
    }
  };

  /** 归一化 AI 配置（任何字段缺失都回退到默认值） */
  function resolveConfig(cfg) {
    const c = cfg || (FK.Config && FK.Config.AI) || {};
    const d = DEFAULTS;
    const delay = c.thinkDelayMs || {};
    const err = c.error || {};
    const s = c.search || {};
    const m = c.move || {};
    const p = c.placement || {};
    const sp = c.selfPreserve || {};
    const pa = c.positionAdjust || {};
    const ic = c.itemChoice || {};

    return {
      team: c.team || d.team,
      difficulty: c.difficulty || d.difficulty,
      enabled: (c.enabled === undefined) ? true : !!c.enabled,
      thinkDelayMs: {
        min: num(delay.min, d.thinkDelayMs.min),
        max: num(delay.max, d.thinkDelayMs.max)
      },
      actTimeoutMs: num(c.actTimeoutMs, d.actTimeoutMs),
      error: {
        powerRatio: num(err.powerRatio, d.error.powerRatio),
        angleDeg: num(err.angleDeg, d.error.angleDeg),
        landingTolerancePx: num(err.landingTolerancePx, d.error.landingTolerancePx)
      },
      itemWeights: Object.assign({}, d.itemWeights, c.itemWeights || {}),
      fallbackItemId: c.fallbackItemId || d.fallbackItemId,
      search: {
        powerMin: num(s.powerMin, d.search.powerMin),
        powerMax: num(s.powerMax, d.search.powerMax),
        powerSteps: Math.max(2, Math.round(num(s.powerSteps, d.search.powerSteps))),
        angleMinDeg: num(s.angleMinDeg, d.search.angleMinDeg),
        angleMaxDeg: num(s.angleMaxDeg, d.search.angleMaxDeg),
        angleSteps: Math.max(2, Math.round(num(s.angleSteps, d.search.angleSteps))),
        maxCandidates: Math.max(4, Math.round(num(s.maxCandidates, d.search.maxCandidates)))
      },
      move: {
        powerMin: num(m.powerMin, d.move.powerMin),
        powerMax: num(m.powerMax, d.move.powerMax),
        powerSteps: Math.max(2, Math.round(num(m.powerSteps, d.move.powerSteps))),
        angleMinDeg: num(m.angleMinDeg, d.move.angleMinDeg),
        angleMaxDeg: num(m.angleMaxDeg, d.move.angleMaxDeg),
        angleSteps: Math.max(2, Math.round(num(m.angleSteps, d.move.angleSteps))),
        standoffPx: num(m.standoffPx, d.move.standoffPx),
        edgePadPx: num(m.edgePadPx, d.move.edgePadPx)
      },
      placement: {
        offsetUnits: (Array.isArray(p.offsetUnits) && p.offsetUnits.length > 0)
          ? p.offsetUnits.slice() : d.placement.offsetUnits.slice(),
        sideStandoffPx: num(p.sideStandoffPx, d.placement.sideStandoffPx)
      },
      selfPreserve: {
        enabled: (sp.enabled === undefined) ? d.selfPreserve.enabled : !!sp.enabled,
        hpThreshold: num(sp.hpThreshold, d.selfPreserve.hpThreshold),
        edgeDangerUnits: num(sp.edgeDangerUnits, d.selfPreserve.edgeDangerUnits),
        skipAttackChance: num(sp.skipAttackChance, d.selfPreserve.skipAttackChance)
      },
      positionAdjust: {
        enabled: (pa.enabled === undefined) ? d.positionAdjust.enabled : !!pa.enabled,
        maxSearchSteps: Math.max(1, Math.round(num(pa.maxSearchSteps, d.positionAdjust.maxSearchSteps)))
      },
      itemChoice: {
        rules: (Array.isArray(ic.rules) && ic.rules.length > 0) ? ic.rules.slice() : d.itemChoice.rules.slice(),
        randomFallbackChance: num(ic.randomFallbackChance, d.itemChoice.randomFallbackChance)
      }
    };
  }

  /* ==================================================================
   * 3) 随机与权重
   * ================================================================== */

  function defaultRng() { return Math.random(); }

  /**
   * 按权重随机取一个 id（权重 ≤ 0 的候选直接排除；全部为 0 时退化为均匀随机）
   * @param {Object} weights id → 权重
   * @param {string[]} ids 候选 id
   * @param {Function} [rng] 返回 [0,1) 的随机源（自检可注入固定序列）
   * @returns {string|null}
   */
  function weightedPick(weights, ids, rng) {
    const w = weights || {};
    const list = (ids || []).slice();
    if (list.length === 0) { return null; }

    const r = (typeof rng === 'function') ? rng : defaultRng;

    let total = 0;
    for (let i = 0; i < list.length; i++) {
      total += Math.max(0, num(w[list[i]], 0));
    }
    if (total <= 0) {
      return list[Math.min(list.length - 1, Math.floor(r() * list.length))];
    }

    let t = r() * total;
    for (let i = 0; i < list.length; i++) {
      t -= Math.max(0, num(w[list[i]], 0));
      if (t <= 0) { return list[i]; }
    }
    return list[list.length - 1];
  }

  /** 在 [min,max] 内取随机数（自检可注入 rng） */
  function randomBetween(min, max, rng) {
    const r = (typeof rng === 'function') ? rng : defaultRng;
    const a = num(min, 0);
    const b = num(max, a);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo + r() * (hi - lo);
  }

  function maxHpOf(u) {
    if (!u) { return 100; }
    if (typeof u.getMaxHp === 'function') { return Math.max(1, num(u.getMaxHp(), 100)); }
    return Math.max(1, num(u.hpMax, num(u.maxHp, 100)));
  }

  function hpRatioOf(u) {
    return hpOf(u) / maxHpOf(u);
  }

  function platformOf(unit, world) {
    const plats = (world && world.platforms) ? world.platforms : [];
    const p = posOf(unit);
    let best = null;
    let bestDy = Infinity;
    for (let i = 0; i < plats.length; i++) {
      const r = plats[i];
      const left = num(r.x, 0);
      const top = num(r.y, 0);
      const w = num(r.width, 0);
      if (p.x < left - 4 || p.x > left + w + 4) { continue; }
      const dy = top - p.y;
      if (dy < -40 || dy > 80) { continue; }
      if (Math.abs(dy) < bestDy) { bestDy = Math.abs(dy); best = r; }
    }
    return best;
  }

  function isOnEdge(unit, world, ppx, edgeUnits) {
    const plat = platformOf(unit, world);
    if (!plat) { return false; }
    const edgePx = Math.max(8, num(edgeUnits, 1) * num(ppx, 48));
    const p = posOf(unit);
    const left = num(plat.x, 0);
    const right = left + num(plat.width, 0);
    return (p.x - left) < edgePx || (right - p.x) < edgePx;
  }

  function juiceBelow(unit, world) {
    const water = (world && typeof world.waterLevel === 'number') ? world.waterLevel : null;
    if (water === null) { return false; }
    return posOf(unit).y < water;
  }

  function nearestOf(from, list) {
    if (!from || !list || list.length === 0) { return null; }
    let best = list[0];
    let bestD = distBetween(posOf(from), posOf(list[0]));
    for (let i = 1; i < list.length; i++) {
      const d = distBetween(posOf(from), posOf(list[i]));
      if (d < bestD) { best = list[i]; bestD = d; }
    }
    return best;
  }

  function isFocusedByEnemies(unit, allies, enemies) {
    const mine = (allies || []).filter(isAlive);
    const foes = (enemies || []).filter(isAlive);
    if (!unit || mine.length === 0 || foes.length === 0) { return false; }
    let top = -1;
    let topCount = 0;
    for (let i = 0; i < mine.length; i++) {
      const h = hpOf(mine[i]);
      if (h > top) { top = h; topCount = 1; }
      else if (h === top) { topCount += 1; }
    }
    if (hpOf(unit) < top - 0.5 || topCount !== 1) { return false; }
    let focus = 0;
    for (let j = 0; j < foes.length; j++) {
      if (nearestOf(foes[j], mine) === unit) { focus += 1; }
    }
    return focus >= Math.max(1, Math.ceil(foes.length * 0.5));
  }

  function throwReachable(opts) {
    const cand = searchThrow(opts);
    return !!(cand && cand.ok && cand.reachable);
  }

  function anyEnemyCanHit(enemies, unit, opts) {
    const o = opts || {};
    const item = o.item;
    if (!item || !unit) { return false; }
    for (let i = 0; i < (enemies || []).length; i++) {
      if (throwReachable({
        unit: enemies[i], item: item, target: unit,
        predictor: o.predictor, simulate: o.simulate, world: o.world,
        config: o.config, maxSpeed: o.maxSpeed, pxPerUnit: o.pxPerUnit
      })) { return true; }
    }
    return false;
  }

  function anyReachableFrom(unit, enemies, opts) {
    const o = opts || {};
    const item = o.item;
    if (!item || !unit) { return false; }
    for (let i = 0; i < (enemies || []).length; i++) {
      if (throwReachable({
        unit: unit, item: item, target: enemies[i],
        predictor: o.predictor, simulate: o.simulate, world: o.world,
        config: o.config, maxSpeed: o.maxSpeed, pxPerUnit: o.pxPerUnit
      })) { return true; }
    }
    return false;
  }

  function preserveReason(unit, allies, enemies, opts) {
    const o = opts || {};
    const cfg = resolveConfig(o.config);
    const sp = cfg.selfPreserve;
    if (!sp || !sp.enabled || !unit) { return ''; }
    const ppx = num(o.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));
    if (hpRatioOf(unit) < sp.hpThreshold) {
      return 'low-hp';
    }
    if (isOnEdge(unit, o.world, ppx, sp.edgeDangerUnits) && juiceBelow(unit, o.world) &&
        hpRatioOf(unit) < 0.55) {
      return 'edge';
    }
    if (isFocusedByEnemies(unit, allies, enemies)) {
      return 'focused';
    }
    return '';
  }

  function fleeDesiredX(unit, enemies, world, cfg, ppx) {
    const p = posOf(unit);
    if (!cfg || !cfg.selfPreserve) { return p.x; }
    if (isOnEdge(unit, world, ppx, cfg.selfPreserve.edgeDangerUnits)) {
      const plat = platformOf(unit, world);
      if (plat) { return num(plat.x, 0) + num(plat.width, 0) * 0.5; }
    }
    const foe = nearestOf(unit, enemies);
    if (!foe) { return p.x; }
    const away = p.x < posOf(foe).x ? -1 : 1;
    let x = p.x + away * Math.max(80, cfg.move.standoffPx * 0.45);
    const bounds = (world && world.bounds) ? world.bounds : null;
    const pad = cfg.move.edgePadPx;
    if (bounds && typeof bounds.left === 'number') {
      x = clamp(x, bounds.left + pad, bounds.right - pad);
    }
    return x;
  }

  /**
   * 按场景选道具（不再纯权重）。followUp 时不用果箱。
   */
  function pickItemByRules(opts) {
    const o = opts || {};
    const cfg = resolveConfig(o.config);
    const rng = (typeof o.rng === 'function') ? o.rng : defaultRng;
    const ids = (o.availableIds || []).filter(function (id) { return !!id; });
    const followUp = !!o.followUp;
    const usable = followUp ? ids.filter(function (id) { return id !== 'move' && id !== 'fruit_crate'; }) : ids;
    const bombs = usable.filter(function (id) { return id !== 'move' && id !== 'fruit_crate'; });
    const has = function (id) { return usable.indexOf(id) >= 0; };

    if (usable.length === 0) { return { id: null, why: 'none-available', wild: false }; }

    const wild = rng() < cfg.itemChoice.randomFallbackChance;
    if (wild) {
      const pool = (followUp || bombs.length === 0) ? usable : bombs.concat(has('fruit_crate') ? ['fruit_crate'] : []);
      const id = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
      return { id: id, why: 'wild-15%', wild: true };
    }

    const target = o.target;
    const unit = o.unit;
    const ppx = num(o.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));
    const hp = hpOf(target);
    const distUnits = (unit && target && ppx > 0) ? distBetween(posOf(unit), posOf(target)) / ppx : 99;
    const onEdge = !!(target && isOnEdge(target, o.world, ppx, cfg.selfPreserve.edgeDangerUnits));
    const crates = Math.max(0, Math.round(num(o.crateCount, 0)));
    const threatened = !!o.threatened;

    const want = function (id, why) {
      if (has(id)) { return { id: id, why: why, wild: false }; }
      return null;
    };

    let picked = null;
    if (onEdge && (hp > 40 || distUnits < 5)) {
      picked = want('watermelon_bomb', 'enemy-on-edge');
    }
    if (!picked && hp > 40 && distUnits < 3) {
      picked = want('watermelon_bomb', 'high-hp-near');
    }
    if (!picked && hp > 0 && hp <= 40) {
      picked = want('cherry_bomb', 'low-hp');
    }
    if (!picked && distUnits >= 5 && distUnits <= 14) {
      picked = want('banana_bomb', 'mid-range');
    }
    if (!picked && !followUp && crates >= 2 && !threatened) {
      picked = want('fruit_crate', 'crates-and-safe');
    }
    if (!picked) {
      picked = want('cherry_bomb', 'fallback-cherry') ||
        want('banana_bomb', 'fallback-banana') ||
        want('watermelon_bomb', 'fallback-melon');
    }
    if (!picked) {
      const id = usable[0];
      picked = { id: id, why: 'first-available', wild: false };
    }
    return picked;
  }

  /**
   * 选目标（规则 5）：**血最低的敌人优先**；血量相同时取离射手更近的那个
   * @param {Array} enemies 敌人列表
   * @param {Object} [opts] { from: 射手单位 }
   * @returns {Object|null}
   */
  function pickTarget(enemies, opts) {
    const o = opts || {};
    const list = (enemies || []).filter(isAlive);
    if (list.length === 0) { return null; }

    const from = o.from || null;
    const ppx = num(o.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));
    const edgeU = (o.config && o.config.selfPreserve) ? o.config.selfPreserve.edgeDangerUnits : 1;
    const ranked = list.slice().sort(function (a, b) {
      const hpA = hpOf(a);
      const hpB = hpOf(b);
      if (hpA !== hpB) { return hpA - hpB; }
      const eA = isOnEdge(a, o.world, ppx, edgeU) ? 0 : 1;
      const eB = isOnEdge(b, o.world, ppx, edgeU) ? 0 : 1;
      if (eA !== eB) { return eA - eB; }
      const dA = from ? distBetween(posOf(from), posOf(a)) : 0;
      const dB = from ? distBetween(posOf(from), posOf(b)) : 0;
      return dA - dB;
    });
    if (o.preferSecond && ranked.length > 1) { return ranked[1]; }
    return ranked[0];
  }

  /** 投掷方向：由「射手 → 目标」的水平方向决定；完全同 x 时按阵营朝向兜底 */
  function directionSign(unit, target) {
    const dx = posOf(target).x - posOf(unit).x;
    if (Math.abs(dx) >= 1) { return dx > 0 ? 1 : -1; }
    return teamOf(unit) === 'red' ? -1 : 1;
  }

  /* ==================================================================
   * 5) 弹道模拟（与投掷实飞同源）
   * ================================================================== */

  /**
   * 造一个「(x,y,vx,vy) → 预测结果」的模拟函数。
   * 优先级：注入的 simulate → 注入的 predictor → 按 world 自建 TrajectoryPredictor
   * @returns {Function|null} 无可用物理时返回 null
   */
  function makeSimulator(opts) {
    const o = opts || {};
    if (typeof o.simulate === 'function') { return o.simulate; }

    if (o.predictor && typeof o.predictor.predict === 'function') {
      const p = o.predictor;
      return function (x, y, vx, vy) { return p.predict(x, y, vx, vy); };
    }

    const P = FK.TrajectoryPredictor;
    if (!P || typeof P !== 'function') { return null; }

    const world = o.world || {};
    const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
    const PH = (FK.Config && FK.Config.PHYSICS) ? FK.Config.PHYSICS : {};
    const inst = new P({
      gravityY: num(o.gravityY, num(PH.gravityY, 1500)),
      stepSec: num(o.stepSec, num(A.stepSec, 1 / 60)),
      maxSteps: num(o.maxSteps, num(A.maxSteps, 240)),
      sampleEvery: num(o.sampleEvery, num(A.sampleEvery, 3)),
      integration: o.integration || A.integration || 'analytic',
      platforms: world.platforms || [],
      waterLevel: (typeof world.waterLevel === 'number') ? world.waterLevel : null,
      bounds: world.bounds || null
    });
    return function (x, y, vx, vy) { return inst.predict(x, y, vx, vy); };
  }

  /** 投掷发射点：与 AimController.getLaunchPoint 同口径（单位中心 + 配置偏移） */
  function launchPointOf(unit, opts) {
    const o = opts || {};
    const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
    const ppx = num(o.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));
    const offUnits = num(o.launchOffsetYUnits, num(A.launchOffsetYUnits, -0.3));
    const p = posOf(unit);
    return { x: p.x, y: p.y + offUnits * ppx };
  }

  /**
   * 力度 × 角度 候选搜索（规则 6）：选「落点离目标最近」的一组参数。
   *
   *   力度 power ∈ [search.powerMin, search.powerMax]
   *   角度 angle ∈ [search.angleMinDeg, search.angleMaxDeg]（向上为正，抛物线）
   *   初速度 speed = AIM.maxSpeed × item.range × power
   *        vx = cos(angle) × speed × direction（红方通常为 -1 = 向左投）
   *        vy = -sin(angle) × speed
   *
   * @param {Object} opts
   *   unit / item / target  三要素
   *   predictor | simulate | world  模拟来源（三者任一）
   *   config                 AI 配置覆盖
   *   maxSpeed / pxPerUnit / launchOffsetYUnits  物理与几何覆盖
   * @returns {Object} 最佳候选（含 ok / distancePx / reachable / landing / hitType…）
   */
  function searchThrow(opts) {
    const o = opts || {};
    const unit = o.unit;
    const item = o.item;
    const target = o.target;
    const cfg = resolveConfig(o.config);

    if (!unit || !item || !target) {
      return { ok: false, reason: 'missing-input', distancePx: Infinity, reachable: false };
    }

    const sim = makeSimulator(o);
    if (!sim) {
      return { ok: false, reason: 'no-simulator', distancePx: Infinity, reachable: false };
    }

    const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
    const maxSpeed = num(o.maxSpeed, num(A.maxSpeed, 1200));
    const itemRange = num(item.range, 1);
    const launch = o.launch || launchPointOf(unit, o);
    const tp = posOf(target);
    const dir = (o.direction !== undefined) ? o.direction : directionSign(unit, target);

    const s = cfg.search;
    const powerStep = (s.powerMax - s.powerMin) / (s.powerSteps - 1);
    const angleStep = (s.angleMaxDeg - s.angleMinDeg) / (s.angleSteps - 1);

    let tried = 0;
    let samples = 0;
    let best = null;         // 最佳「有效」候选（排除落水）
    let bestAny = null;      // 最佳候选（含落水，兜底）

    /** 评估一组参数：返回候选对象（wasted = 落水）或 null */
    function evaluate(power, angleDeg) {
      tried += 1;
      const speed = maxSpeed * itemRange * power * Math.max(0.05, num(item.speedScale, 1));
      const rad = angleDeg * Math.PI / 180;
      const vx = Math.cos(rad) * speed * dir;
      const vy = -Math.sin(rad) * speed;

      let res = null;
      try { res = sim(launch.x, launch.y, vx, vy); } catch (e) { res = null; }
      if (!res || !res.landing) { return null; }
      samples += 1;

      const landing = { x: num(res.landing.x, launch.x), y: num(res.landing.y, launch.y) };
      return {
        ok: true,
        powerRatio: round3(power),
        angleDeg: round3(angleDeg),
        vx: round3(vx),
        vy: round3(vy),
        speed: round3(speed),
        landing: { x: round2(landing.x), y: round2(landing.y) },
        hitType: res.hitType || 'none',
        distancePx: round2(distBetween(landing, tp)),
        direction: dir,
        launch: { x: round2(launch.x), y: round2(launch.y) },
        wasted: (res.hitType === 'water')
      };
    }

    /** 收录候选：落水只进兜底池，其余进最优池 */
    function keep(cand) {
      if (!cand) { return; }
      if (!bestAny || cand.distancePx < bestAny.distancePx) { bestAny = cand; }
      if (cand.wasted) { return; }
      if (!best || cand.distancePx < best.distancePx) { best = cand; }
    }

    /* ---------- ① 粗搜：力度 × 角度 全网格 ---------- */
    for (let i = 0; i < s.powerSteps && tried < s.maxCandidates; i++) {
      const power = s.powerMin + powerStep * i;
      for (let j = 0; j < s.angleSteps && tried < s.maxCandidates; j++) {
        keep(evaluate(power, s.angleMinDeg + angleStep * j));
      }
    }

    /* ---------- ② 精修：在粗搜最优点附近做局部搜索（每轮步长减半） ----------
     * 粗网格的落点间距约 50~150px，只取网格点是「差几十像素」的常见原因；
     * 局部精修把参数细化到约 1%，落点精度因此能进入落点容忍度（默认 60px）之内。
     * 代价只有 refineRounds × 8 次额外预测，完全发生在 AI 思考的 1~2 秒里。 */
    const REFINE_ROUNDS = 3;                       // 局部搜索轮数（精度旋钮，非玩法数值）
    const cfgRefine = (o.config && o.config.search) ? o.config.search.refineRounds : undefined;
    const rounds = Math.max(0, Math.round(num(cfgRefine, REFINE_ROUNDS)));
    let stepP = powerStep / 2;
    let stepA = angleStep / 2;

    for (let r = 0; r < rounds; r++) {
      const anchor = best || bestAny;
      if (!anchor) { break; }
      const baseP = anchor.powerRatio;
      const baseA = anchor.angleDeg;
      for (let dp = -1; dp <= 1; dp++) {
        for (let da = -1; da <= 1; da++) {
          if (dp === 0 && da === 0) { continue; }
          keep(evaluate(clamp(baseP + dp * stepP, 0.02, 1), clamp(baseA + da * stepA, 1, 89)));
        }
      }
      stepP /= 2;
      stepA /= 2;
    }

    const chosen = best || bestAny;
    if (!chosen) { return { ok: false, reason: 'no-candidate', distancePx: Infinity, reachable: false }; }

    chosen.ok = true;
    chosen.tried = tried;
    chosen.samples = samples;
    chosen.waterFallback = !best;
    chosen.reachable = chosen.distancePx <= cfg.error.landingTolerancePx;
    return chosen;
  }

  /**
   * 加误差（规则 7）：力度 ±powerRatio（相对值，默认 8%）、角度 ±angleDeg（默认 4°）。
   * 误差加在「参数」上，再用同一套映射公式算出初速度 —— 绝不直接改落点。
   * @param {Object} base searchThrow 的候选
   * @param {Object} opts { config, rng, item, maxSpeed, direction }
   * @returns {Object} { powerRatio, angleDeg, vx, vy, powerDeltaPct, angleDeltaDeg }
   */
  function applyError(base, opts) {
    const o = opts || {};
    const cfg = resolveConfig(o.config);
    const rng = (typeof o.rng === 'function') ? o.rng : defaultRng;
    const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
    const maxSpeed = num(o.maxSpeed, num(A.maxSpeed, 1200));
    const itemRange = num((o.item || {}).range, 1);
    const dir = num(o.direction, num(base && base.direction, 1));

    const err = cfg.error;
    const kPower = (rng() * 2 - 1) * err.powerRatio;
    const dAngle = (rng() * 2 - 1) * err.angleDeg;

    const basePower = num(base && base.powerRatio, 0.6);
    const baseAngle = num(base && base.angleDeg, 45);

    const powerRatio = clamp(basePower * (1 + kPower), 0.05, 1);
    const angleDeg = clamp(baseAngle + dAngle, 1, 89);
    const speed = maxSpeed * itemRange * powerRatio *
      Math.max(0.05, num((o.item || {}).speedScale, 1));
    const rad = angleDeg * Math.PI / 180;

    return {
      powerRatio: round3(powerRatio),
      angleDeg: round3(angleDeg),
      vx: round3(Math.cos(rad) * speed * dir),
      vy: round3(-Math.sin(rad) * speed),
      speed: round3(speed),
      powerDeltaPct: round3(kPower * 100),
      angleDeltaDeg: round3(dAngle),
      direction: dir
    };
  }

  /**
   * 完整投掷方案（规则 2 / 6 / 7）：搜参数 → 加误差 → 用带误差的参数重新预测落点
   * @returns {Object|null} { kind:'throw', unit, item, target, base, shot, reachable … }
   */
  function planThrow(opts) {
    const o = opts || {};
    const base = (o.base && o.base.ok) ? o.base : searchThrow(o);
    if (!base || !base.ok) { return null; }

    const shot = applyError(base, {
      config: o.config,
      rng: o.rng,
      item: o.item,
      maxSpeed: o.maxSpeed,
      direction: base.direction
    });

    const sim = makeSimulator(o);
    const launch = base.launch || launchPointOf(o.unit, o);
    let landing = base.landing;
    let hitType = base.hitType;
    let flightMs = 0;

    if (sim) {
      try {
        const res = sim(launch.x, launch.y, shot.vx, shot.vy);
        if (res && res.landing) {
          landing = { x: round2(res.landing.x), y: round2(res.landing.y) };
          hitType = res.hitType || hitType;
          flightMs = num(res.flightTimeMs, 0);
        }
      } catch (e) { /* 预测失败：沿用搜索阶段的落点 */ }
    }

    const targetPos = posOf(o.target);
    return {
      kind: 'throw',
      team: teamOf(o.unit),
      unit: o.unit,
      unitId: idOf(o.unit),
      item: o.item,
      itemId: (o.item && o.item.id) || '',
      target: o.target,
      targetId: idOf(o.target),
      base: base,
      baseDistancePx: base.distancePx,
      reachable: !!base.reachable,
      shot: {
        powerRatio: shot.powerRatio,
        angleDeg: shot.angleDeg,
        vx: shot.vx,
        vy: shot.vy,
        speed: shot.speed,
        launch: { x: round2(launch.x), y: round2(launch.y) },
        landing: landing,
        hitType: hitType,
        flightTimeMs: flightMs,
        distancePx: round2(distBetween(landing, targetPos))
      },
      error: { powerDeltaPct: shot.powerDeltaPct, angleDeltaDeg: shot.angleDeltaDeg }
    };
  }

  /**
   * 选单位（规则 3）：**能打到敌人的单位优先，多个候选随机**。
   *   · 是否「能打到」= 用参考投掷道具搜索一次，落点距敌人 ≤ 落点容忍度；
   *   · 优先在「能打到」的单位里随机（规则要求随机，避免每局都一样）；
   *   · 一个都打不到 → 在全部可行动单位里随机（AI 仍会出手，不会站着不动）。
   * @param {Object} opts { units, enemies, item, predictor/simulate/world, config, rng, maxSpeed, pxPerUnit }
   * @returns {Object|null} { unit, reachable, distancePx, targetId, candidates:[…] }
   */
  function pickUnit(opts) {
    const o = opts || {};
    const rng = (typeof o.rng === 'function') ? o.rng : defaultRng;
    const cfg = resolveConfig(o.config);

    const units = (o.units || []).filter(function (u) { return isAlive(u) && !isBusy(u); });
    const enemies = (o.enemies || []).filter(isAlive);
    if (units.length === 0) { return null; }

    const item = o.item || null;
    const report = [];

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      let bestD = Infinity;
      let bestTargetId = '';

      if (item && enemies.length > 0) {
        for (let j = 0; j < enemies.length; j++) {
          const cand = searchThrow({
            unit: u,
            item: item,
            target: enemies[j],
            predictor: o.predictor,
            simulate: o.simulate,
            world: o.world,
            config: o.config,
            maxSpeed: o.maxSpeed,
            pxPerUnit: o.pxPerUnit,
            launchOffsetYUnits: o.launchOffsetYUnits,
            launch: (typeof o.launchOf === 'function') ? o.launchOf(u) : undefined
          });
          if (cand && cand.ok && cand.distancePx < bestD) {
            bestD = cand.distancePx;
            bestTargetId = idOf(enemies[j]);
          }
        }
      }

      report.push({
        unit: u,
        unitId: idOf(u),
        distancePx: isFinite(bestD) ? round2(bestD) : null,
        reachable: isFinite(bestD) && bestD <= cfg.error.landingTolerancePx,
        nearestEnemyId: bestTargetId
      });
    }

    const hittable = report.filter(function (r) { return r.reachable; });
    const pool = hittable.length > 0 ? hittable : report;
    const picked = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];

    return {
      unit: picked.unit,
      unitId: picked.unitId,
      reachable: picked.reachable,
      distancePx: picked.distancePx,
      nearestEnemyId: picked.nearestEnemyId,
      hittableCount: hittable.length,
      candidates: report
    };
  }

  /* ==================================================================
   * 6) 移动方案（道具栏第 4 格「移动」的 AI 版本）
   * ================================================================== */

  /** 移动模拟：优先复用 MoveController.simulatePath（与实飞同源），否则退化为无地形解析解 */
  function resolveMoveSimulator(opts) {
    const o = opts || {};
    if (typeof o.simulatePath === 'function') { return o.simulatePath; }

    const MC = FK.MoveController;
    const world = o.world || {};
    const M = (FK.Config && FK.Config.MOVE) ? FK.Config.MOVE : {};
    const K = (FK.Config && FK.Config.KNOCKBACK) ? FK.Config.KNOCKBACK : {};
    const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
    const PH = (FK.Config && FK.Config.PHYSICS) ? FK.Config.PHYSICS : {};
    const unit = o.unit || null;

    if (MC && typeof MC.simulatePath === 'function') {
      const stepSec = num(A.stepSec, 1 / 60);
      const maxFlightMs = num(M.maxFlightMs, 4000);
      const maxSteps = Math.max(4, Math.round(maxFlightMs / 1000 / stepSec));
      const halfWidth = num(o.halfWidth, 24);
      const supportProvider = (unit && typeof unit.supportProvider === 'function') ? unit.supportProvider : null;

      return function (input) {
        return MC.simulatePath({
          x: input.x, y: input.y, vx: input.vx, vy: input.vy,
          gravityY: num(PH.gravityY, 1500),
          stepSec: stepSec,
          maxSteps: maxSteps,
          maxFlightMs: maxFlightMs,
          sampleEvery: 4,
          bounds: world.bounds ? { left: world.bounds.left, right: world.bounds.right } : null,
          rects: Array.isArray(world.platforms) ? world.platforms : [],
          restitution: num(K.restitution, 0.42),
          minBounceSpeed: num(K.minBounceSpeed, 45),
          maxBounces: num(M.maxBounces, 6),
          halfWidth: halfWidth,
          contactGapPx: num(K.knockContactGapPx, 0.5),
          supportAt: supportProvider
            ? function (px, py) {
              const sy = supportProvider(px, py);
              return (typeof sy === 'number' && isFinite(sy)) ? sy : null;
            }
            : null,
          landingY: supportProvider ? null : (num(unit && unit.y, input.y) + halfWidth),
          waterLevelY: (typeof world.waterLevel === 'number') ? world.waterLevel : null
        });
      };
    }

    // 兜底：无地形数据的解析解（只为自检 / 无 MoveController 环境服务）
    const g = num(PH.gravityY, 1500);
    const stepSec = num(A.stepSec, 1 / 60);
    return function (input) {
      const water = (typeof world.waterLevel === 'number') ? world.waterLevel : null;
      let x = input.x;
      let y = input.y;
      let vy = input.vy;
      let hitType = 'timeout';
      let landing = { x: x, y: y };
      for (let i = 0; i < 240; i++) {
        x += input.vx * stepSec;
        y += vy * stepSec + 0.5 * g * stepSec * stepSec;
        vy += g * stepSec;
        landing = { x: x, y: y };
        if (water !== null && y >= water) { hitType = 'water'; break; }
        if (vy > 0 && y >= input.y) { hitType = 'landed'; break; }
      }
      return { points: [], landing: landing, hitType: hitType, bounces: 0, flightTimeMs: 0 };
    };
  }

  /** 由初速度反推「拖拽向量」（MoveController 的手感映射：拖拽方向与起跳方向相反） */
  function dragFromVelocity(vx, vy, opts) {
    const o = opts || {};
    const M = (FK.Config && FK.Config.MOVE) ? FK.Config.MOVE : {};
    const maxSpeed = num(o.maxSpeed, num(M.maxSpeed, 954));
    const maxDragPx = num(o.maxDragPx, num(M.maxDragPx, 180));
    const minPowerRatio = num(o.minPowerRatio, num(M.minPowerRatio, 0.08));

    const speed = hypot(vx, vy);
    const effective = maxSpeed > 0 ? clamp(speed / maxSpeed, 0, 1) : 0;
    const powerRatio = Math.max(effective, minPowerRatio);
    const dragDist = powerRatio * maxDragPx;
    const dx = speed > 1e-6 ? vx / speed : 1;
    const dy = speed > 1e-6 ? vy / speed : 0;

    return {
      powerRatio: round3(powerRatio),
      dragX: round2(-dx * dragDist),
      dragY: round2(-dy * dragDist),
      dragDist: round2(dragDist)
    };
  }

  /**
   * 完整移动方案：搜索跳跃参数，让落点尽量接近「目标附近的安全站位」
   *   desiredX = 目标 x − 方向 × standoffPx（即停在对手的射手侧，保持射程内）
   * 落水候选直接排除；找不到合法解时返回 null（AI 会退化为投掷）。
   * @returns {Object|null}
   */
  function planMove(opts) {
    const o = opts || {};
    const unit = o.unit;
    const target = o.target;
    if (!unit || !target) { return null; }

    const cfg = resolveConfig(o.config);
    const m = cfg.move;
    const M = (FK.Config && FK.Config.MOVE) ? FK.Config.MOVE : {};
    const maxSpeed = num(o.maxSpeed, num(M.maxSpeed, 954));
    const world = o.world || {};
    const sim = resolveMoveSimulator(o);
    if (!sim) { return null; }

    const launch = {
      x: num(unit.x, 0),
      y: num(unit.y, 0) + num(o.launchOffsetUnits, num(M.launchOffsetYUnits, -0.2)) * num(o.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48))
    };
    const dir = (typeof o.direction === 'number') ? (o.direction >= 0 ? 1 : -1) : directionSign(unit, target);
    const tp = posOf(target);
    const bounds = world.bounds || null;
    const pad = m.edgePadPx;

    let desiredX = (typeof o.desiredX === 'number' && isFinite(o.desiredX))
      ? o.desiredX
      : (tp.x - dir * m.standoffPx);
    if (bounds && typeof bounds.left === 'number' && typeof bounds.right === 'number') {
      desiredX = clamp(desiredX, bounds.left + pad, bounds.right - pad);
    }

    const dp = (m.powerMax - m.powerMin) / (m.powerSteps - 1);
    const da = (m.angleMaxDeg - m.angleMinDeg) / (m.angleSteps - 1);

    let best = null;
    const landings = [];
    for (let i = 0; i < m.powerSteps; i++) {
      const power = m.powerMin + dp * i;
      const speed = maxSpeed * power;

      for (let j = 0; j < m.angleSteps; j++) {
        const angleDeg = m.angleMinDeg + da * j;
        const rad = angleDeg * Math.PI / 180;
        const vx = Math.cos(rad) * speed * dir;
        const vy = -Math.sin(rad) * speed;

        let path = null;
        try { path = sim({ x: launch.x, y: launch.y, vx: vx, vy: vy }); } catch (e) { path = null; }
        if (!path || !path.landing) { continue; }
        if (path.hitType === 'water') { continue; }

        const landing = { x: num(path.landing.x, launch.x), y: num(path.landing.y, launch.y) };
        const row = {
          score: Math.abs(landing.x - desiredX),
          powerRatio: round3(power),
          angleDeg: round3(angleDeg),
          vx: round3(vx),
          vy: round3(vy),
          landing: { x: round2(landing.x), y: round2(landing.y) },
          hitType: path.hitType || 'none',
          bounces: num(path.bounces, 0),
          flightTimeMs: num(path.flightTimeMs, 0)
        };
        landings.push(row);
        if (!best || row.score < best.score) { best = row; }
      }
    }

    if (o.hitItem && o.hitTarget && landings.length > 0) {
      landings.sort(function (a, b) { return a.score - b.score; });
      const limit = Math.max(1, Math.round(num(cfg.positionAdjust.maxSearchSteps, 8)));
      const ghostTeam = teamOf(unit);
      let hitBest = null;
      for (let k = 0; k < Math.min(limit, landings.length); k++) {
        const cand = landings[k];
        const ghost = { x: cand.landing.x, y: cand.landing.y, team: ghostTeam, hp: hpOf(unit), maxHp: maxHpOf(unit) };
        if (throwReachable({
          unit: ghost, item: o.hitItem, target: o.hitTarget,
          predictor: o.predictor, simulate: o.simulate, world: world,
          config: o.config, maxSpeed: o.throwMaxSpeed, pxPerUnit: o.pxPerUnit
        })) {
          hitBest = cand;
          break;
        }
      }
      if (hitBest) { best = hitBest; }
    }

    if (!best) { return null; }

    const drag = dragFromVelocity(best.vx, best.vy, o);
    return {
      kind: 'move',
      team: teamOf(unit),
      unit: unit,
      unitId: idOf(unit),
      itemId: 'move',
      target: target,
      targetId: idOf(target),
      direction: dir,
      desiredX: round2(desiredX),
      startX: round2(launch.x),
      startY: round2(launch.y),
      powerRatio: best.powerRatio,
      angleDeg: best.angleDeg,
      vx: best.vx,
      vy: best.vy,
      landing: best.landing,
      hitType: best.hitType,
      bounces: best.bounces,
      distanceFromDesiredPx: round2(best.score),
      dragX: drag.dragX,
      dragY: drag.dragY,
      pointer: { x: round2(launch.x + drag.dragX), y: round2(launch.y + drag.dragY) },
      reachable: true
    };
  }

  /* ==================================================================
   * 7) 果箱放置候选点（离目标由近到远，交给 PlacementController 依次探测合法性）
   * ================================================================== */

  /**
   * @param {Object} opts { unit, target, config, pxPerUnit, world }
   * @returns {Array<{x:number,y:number}>} 候选落点（y 为「木箱顶边起始高度」）
   */
  function placementSpots(opts) {
    const o = opts || {};
    const target = o.target;
    if (!target) { return []; }

    const cfg = resolveConfig(o.config);
    const ppx = num(o.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));
    const tp = posOf(target);
    const dir = directionSign(o.unit || target, target);
    const bounds = (o.world && o.world.bounds) || null;

    const spots = [];
    cfg.placement.offsetUnits.forEach(function (offUnits) {
      let x = tp.x - dir * num(offUnits, 2) * ppx;
      if (bounds && typeof bounds.left === 'number' && typeof bounds.right === 'number') {
        x = clamp(x, bounds.left + ppx, bounds.right - ppx);
      }
      spots.push({ x: round2(x), y: round2(tp.y) });
    });
    return spots;
  }

  /* ==================================================================
   * 8) 导出
   * ================================================================== */

  const AIPlanner = {
    DEFAULTS: DEFAULTS,
    resolveConfig: resolveConfig,
    makeSimulator: makeSimulator,
    launchPointOf: launchPointOf,
    directionSign: directionSign,
    dragFromVelocity: dragFromVelocity,
    resolveMoveSimulator: resolveMoveSimulator,
    randomBetween: randomBetween,
    weightedPick: weightedPick,
    pickItemByRules: pickItemByRules,
    throwReachable: throwReachable,
    anyReachableFrom: anyReachableFrom,
    preserveReason: preserveReason,
    fleeDesiredX: fleeDesiredX,
    isOnEdge: isOnEdge,
    hpRatioOf: hpRatioOf,
    pickTarget: pickTarget,
    pickUnit: pickUnit,
    searchThrow: searchThrow,
    applyError: applyError,
    planThrow: planThrow,
    planMove: planMove,
    placementSpots: placementSpots,
    aliveOf: aliveOf,
    enemiesOf: enemiesOf,
    isAlive: isAlive,
    isBusy: isBusy,
    teamOf: teamOf,
    idOf: idOf,
    hpOf: hpOf,
    posOf: posOf,
    distance: distBetween,
    clamp: clamp
  };

  FK.AIPlanner = AIPlanner;
})();
