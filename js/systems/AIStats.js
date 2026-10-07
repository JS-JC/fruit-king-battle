/**
 * ============================================================
 * AIStats.js —— AI 命中率 / 对局统计（第 10 步，纯逻辑）
 * ============================================================
 * 不依赖 Phaser。供 tools/ai-stats.html 与 Node 自检共用。
 *
 * 对外：FK.AIStats.runThrows / runMatches / summarize
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function lcg(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function itemById(id) {
    const items = (FK.Configs && FK.Configs.items) || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id) { return items[i]; }
    }
    return null;
  }

  function makeWorld() {
    const map = FK.Configs && FK.Configs.map;
    if (!map) { return { platforms: [], waterLevel: 568, bounds: { left: 80, right: 1520, top: 112, bottom: 688 } }; }
    const ppx = map.pxPerUnit || 48;
    const platforms = (map.platforms || []).map(function (p) {
      return {
        id: p.id,
        x: FK.Config.arenaX(p.x),
        y: FK.Config.arenaY(p.y),
        width: p.width * ppx,
        height: p.height * ppx
      };
    });
    return {
      platforms: platforms,
      waterLevel: FK.Config.arenaY(map.waterLevel),
      bounds: {
        left: FK.Config.arenaX(0),
        right: FK.Config.arenaX(map.width),
        top: FK.Config.arenaY(0),
        bottom: FK.Config.arenaY(map.height),
        ignoreTop: true
      }
    };
  }

  function makePredictor() {
    const world = makeWorld();
    const A = FK.Config.AIM;
    const P = new FK.TrajectoryPredictor({
      gravityY: FK.Config.PHYSICS.gravityY,
      stepSec: A.stepSec,
      maxSteps: A.maxSteps,
      sampleEvery: A.sampleEvery,
      integration: A.integration,
      platforms: world.platforms,
      waterLevel: world.waterLevel,
      bounds: world.bounds
    });
    return P;
  }

  function dummy(id, team, x, y, hp) {
    return {
      id: id, unitId: id, team: team, x: x, y: y, hp: hp, maxHp: hp, alive: true,
      getId: function () { return id; },
      getTeam: function () { return team; },
      getHp: function () { return this.hp; },
      getMaxHp: function () { return this.maxHp; },
      isAlive: function () { return this.hp > 0 && this.alive !== false; }
    };
  }

  function spawn() {
    const map = FK.Configs.map;
    const out = [];
    (map.spawnPoints || []).forEach(function (sp) {
      out.push(dummy(sp.unitId, sp.team, FK.Config.arenaX(sp.x), FK.Config.arenaY(sp.y), 100));
    });
    return out;
  }

  function pick(units, team) {
    return units.filter(function (u) { return u.team === team && u.hp > 0; });
  }

  function applyBlast(item, blast, targets) {
    const PX = FK.Config.PX_PER_UNIT;
    const outer = item.radius;
    const inner = item.innerRadiusUnits;
    const edge = item.edgeDamageRatio;
    let damaged = 0;
    let drownedLike = 0;
    targets.forEach(function (u) {
      if (u.hp <= 0) { return; }
      const d = Math.sqrt((blast.x - u.x) * (blast.x - u.x) + (blast.y - u.y) * (blast.y - u.y)) / PX;
      let falloff = 0;
      if (d <= inner) { falloff = 1; }
      else if (d < outer) { falloff = edge + (1 - edge) * (outer - d) / (outer - inner); }
      if (falloff <= 0) { return; }
      const amount = Math.max(1, Math.round(item.damage * falloff));
      u.hp = Math.max(0, u.hp - amount);
      damaged += 1;
      const kb = (item.knockback || 0) * falloff;
      if (kb > 80 && u.x > 1000) {
        u.x += kb * 0.15;
        if (u.x > FK.Config.arenaX(21.5)) { drownedLike += 1; u.hp = 0; }
      }
    });
    return { damaged: damaged, knockDrown: drownedLike };
  }

  /**
   * 连续 N 次 AI 投掷（固定对位：红方右台 → 蓝方左台），统计命中率。
   */
  function runThrows(n, seed) {
    const N = n || 200;
    const world = makeWorld();
    const predictor = makePredictor();
    const shooter = dummy('grape_soldier', 'red', 1256, 232, 100);
    const target = dummy('apple_guard', 'blue', 344, 232, 100);
    const cherry = itemById('cherry_bomb');
    const rng = lcg(seed || 20261005);
    const tol = FK.Config.AI.error.landingTolerancePx;
    const shared = {
      unit: shooter, item: cherry, target: target, predictor: predictor,
      world: world, config: FK.Config.AI
    };
    const base = FK.AIPlanner.searchThrow(shared);
    let hits = 0;
    let sum = 0;
    const distances = [];
    for (let i = 0; i < N; i++) {
      const plan = FK.AIPlanner.planThrow(Object.assign({}, shared, { base: base, rng: rng }));
      const d = plan && plan.shot ? plan.shot.distancePx : 9999;
      distances.push(d);
      sum += d;
      if (d <= tol) { hits += 1; }
    }
    return {
      n: N,
      hits: hits,
      misses: N - hits,
      hitRate: hits / N,
      meanDistancePx: sum / N,
      tolerancePx: tol,
      baseDistancePx: base && base.distancePx,
      distances: distances
    };
  }

  /**
   * 离线推演若干局：红方 AI 行动、蓝方被动。统计回合数与取胜路径占比。
   */
  function runMatches(count, seed0) {
    const M = count || 20;
    const out = [];
    for (let i = 0; i < M; i++) {
      out.push(simulateMatch((seed0 || 11) + i * 97));
    }
    return out;
  }

  function simulateMatch(seed) {
    const predictor = makePredictor();
    const world = predictor.getWorld ? predictor.getWorld() : makeWorld();
    const units = spawn();
    const W = FK.Config.AI.itemWeights;
    const rng = lcg(seed);
    const cooldown = {};
    let redTurns = 0;
    let throws = 0;
    let crates = 0;
    let hpKills = 0;
    let knockDrown = 0;

    while (redTurns < 60) {
      const blues = pick(units, 'blue');
      if (blues.length === 0) { break; }
      redTurns += 1;
      Object.keys(cooldown).forEach(function (k) {
        cooldown[k] = Math.max(0, cooldown[k] - 1);
      });
      const reds = pick(units, 'red');
      const ids = Object.keys(W).filter(function (id) {
        if (id === 'move') { return true; }
        const it = itemById(id);
        if (!it) { return false; }
        return !(cooldown[id] > 0);
      });
      if (ids.length === 0) { break; }
      const chosen = FK.AIPlanner.weightedPick(W, ids, rng);
      const item = (chosen === 'move') ? itemById('cherry_bomb') : itemById(chosen);
      const unitPick = FK.AIPlanner.pickUnit({
        units: reds, enemies: blues, item: item, predictor: predictor,
        world: world, config: FK.Config.AI, rng: rng
      });
      if (!unitPick) { break; }
      const unit = unitPick.unit;
      const target = FK.AIPlanner.pickTarget(blues, { from: unit });
      if (!target) { break; }

      if (chosen === 'move') {
        const mv = FK.AIPlanner.planMove({
          unit: unit, target: target, config: FK.Config.AI,
          predictor: predictor, world: world, pxPerUnit: FK.Config.PX_PER_UNIT, rng: rng
        });
        if (mv && mv.landing) { unit.x = mv.landing.x; unit.y = mv.landing.y; }
        continue;
      }
      if (item && item.type === 'obstacle') {
        crates += 1;
        const cd = item.cooldownTurns || 0;
        if (cd > 0) { cooldown[item.id] = cd; }
        continue;
      }
      const plan = FK.AIPlanner.planThrow({
        unit: unit, item: item, target: target, predictor: predictor,
        world: world, config: FK.Config.AI, rng: rng
      });
      const cd = item.cooldownTurns || 0;
      if (cd > 0) { cooldown[item.id] = cd; }
      if (!plan) { continue; }
      throws += 1;
      const before = pick(units, 'blue').map(function (u) { return u.hp; });
      const blast = applyBlast(item, plan.shot.landing, pick(units, 'blue'));
      knockDrown += blast.knockDrown;
      pick(units, 'blue').forEach(function (u, idx) {
        if (before[idx] > 0 && u.hp <= 0 && blast.knockDrown === 0) { hpKills += 1; }
      });
    }

    const path = knockDrown > 0 ? 'drown' : (crates > 0 ? 'crate' : 'hp');
    return {
      winner: pick(units, 'blue').length === 0 ? 'red' : 'blue',
      redTurns: redTurns,
      throws: throws,
      crates: crates,
      hpKills: hpKills,
      knockDrown: knockDrown,
      path: path,
      actionTurns: redTurns * 2
    };
  }

  function summarize(throwStats, matches) {
    const hitRate = throwStats.hitRate;
    let sumTurns = 0;
    const paths = { hp: 0, drown: 0, crate: 0 };
    matches.forEach(function (m) {
      sumTurns += m.actionTurns;
      paths[m.path] = (paths[m.path] || 0) + 1;
    });
    const n = matches.length || 1;
    return {
      hitRate: hitRate,
      hitRatePct: Math.round(hitRate * 1000) / 10,
      meanActionTurns: sumTurns / n,
      pathShare: {
        hp: paths.hp / n,
        drown: paths.drown / n,
        crate: paths.crate / n
      },
      throws: throwStats,
      matches: matches
    };
  }

  function run(opts) {
    opts = opts || {};
    const t = runThrows(opts.throws || 200, opts.seed);
    const m = runMatches(opts.matches || 20, (opts.seed || 1) + 99);
    return summarize(t, m);
  }

  FK.AIStats = {
    runThrows: runThrows,
    runMatches: runMatches,
    simulateMatch: simulateMatch,
    summarize: summarize,
    run: run
  };
})();
