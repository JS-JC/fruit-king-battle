/**
 * ============================================================
 * KnockbackPhysics.js —— 击退 / 主动移动的水平弹性碰撞（第 7.10 步新增）
 * ============================================================
 * 为什么单独成模块：
 *   击退位移原来是「纯视觉位移 + 边界钳制」，单位会直接穿进木箱里。
 *   第 7.10 步要求按**物理弹性碰撞**处理（速度反向并保留惯性、可多次弹回、
 *   能量耗尽后停住），这套算法与 Phaser 无关，抽成纯函数后：
 *     · UnitBase 的击退滑行直接调用它（被动移动）
 *     · 未来的主动移动也调用同一个函数（规则先写好）
 *     · Node 自检可以脱离浏览器直接验证碰撞数学
 *
 * 规则（与策划第 7.10 步逐条对应）：
 *   ① 只检测水平方向：垂直方向沿用原逻辑（重力 + 落回基准高度）
 *   ② 只把「木箱矩形（ObstacleRegistry.getRects） + 地图边界（map.json bounds.type）」
 *      当作碰撞体；地形平台是"地面"，默认不参与横向碰撞。
 *      第 8.10 步：**单位在空中飞行时**，场景把地形平台矩形也一并放进 world.rects
 *      （矩形带 kind: 'platform'），于是撞到平台侧面 / 边缘会被挡住并按同一套弹性弹回；
 *      站在平台上滑行时平台不进列表，因此「滑到边缘掉下去」的正常物理不受影响。
 *   ③ 撞到多个木箱时取**行进方向上最近的那个面**，逐段推进，因此连续撞多个
 *      箱子会依次弹回（不会一次穿越两个）
 *   ④ 按弹性碰撞处理：撞上后 vx ← -vx × restitution（restitution 来自
 *      FK.Config.DAMAGE.knockRestitution，不硬编码），惯性保留
 *   ⑤ 停在碰撞面外侧（contactGapPx 缝隙），绝不进入箱子内部
 *   ⑥ 反弹速度低于 minBounceSpeed 或弹回次数超过 maxBounceCount → 直接停住
 *      （能量耗尽），保证一定会停下来
 *   ⑦ 边界类型数据驱动：map.json → bounds.type = 'wall' 时与木箱同规则反弹；
 *      'juice'（未来地图）本步按"不反弹"兜底，行为留待后续实现
 *
 * 算法：把一帧的水平位移拆成若干「不超过 maxStepPx 的小段」逐段推进，
 *   每小段先位移再检测，因此即使速度很高也不会穿透薄箱子（无隧穿）。
 *
 * 依赖：无（纯 JS）
 * 对外：FK.KnockbackPhysics
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 边界类型 → 行为（数据来自 map.json 的 bounds.type，缺省 wall） */
  const BOUNDARY_MODES = {
    wall: 'bounce',   // 实体墙：和撞木箱一样弹性弹回
    juice: 'none'     // 果汁边界：未来实现；本步不反弹（只钳制，不穿出地图）
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  /** 读取配置（全部来自 FK.Config.DAMAGE，测试可注入覆盖） */
  function readCfg(overrides) {
    const D = (FK.Config && FK.Config.DAMAGE) ? FK.Config.DAMAGE : {};
    const o = overrides || {};
    const restitution = num(o.restitution, num(D.knockRestitution, 0.45));
    const decay = num(o.restitutionDecay, num(D.knockRestitutionDecay, 0.6));
    return {
      restitution: Math.max(0, Math.min(1, restitution)),
      restitutionDecay: Math.max(0, Math.min(1, decay)),
      minBounceSpeed: num(o.minBounceSpeed, num(D.knockBounceMinSpeed, 40)),
      maxBounceCount: Math.max(0, Math.round(num(o.maxBounceCount, num(D.knockBounceMaxCount, 2)))),
      contactGapPx: num(o.contactGapPx, num(D.knockContactGapPx, 0.5)),
      maxStepPx: Math.max(0.5, num(o.maxStepPx, num(D.knockMaxStepPx, 4)))
    };
  }

  /**
   * 第 n 次接触的弹性系数（n 从 1 起，含跨帧累计）。
   * 第 1 次 = knockRestitution；第 2 次 × decay；超过 maxBounceCount 为 0（停住）。
   */
  function bounceRestitution(totalIndex, cfg) {
    const n = Math.max(0, Math.round(num(totalIndex, 0)));
    if (n <= 0 || n > cfg.maxBounceCount) { return 0; }
    if (n === 1) { return cfg.restitution; }
    return cfg.restitution * Math.pow(cfg.restitutionDecay, n - 1);
  }

  function reflectVx(vx, totalIndex, cfg) {
    const speed = Math.abs(vx);
    const rest = bounceRestitution(totalIndex, cfg);
    if (speed < cfg.minBounceSpeed || rest <= 0) {
      return { vx: 0, rest: 0, stopped: true };
    }
    return { vx: -vx * rest, rest: rest, stopped: false };
  }

  /** 边界行为：'bounce' | 'none' | 'off' */
  function boundaryMode(bounds, overrides) {
    if (!bounds || bounds.disabled) { return 'off'; }
    const type = bounds.type || 'wall';
    if (overrides && overrides.boundaryModes && overrides.boundaryModes[type]) {
      return overrides.boundaryModes[type];
    }
    return BOUNDARY_MODES[type] || 'bounce';
  }

  /**
   * 脚在顶面之上（或刚陷入一小段）且水平压在这块台上 → 是落地/站立，不当侧撞。
   * 否则起跳/下落会每帧撞自己脚下的台，轨迹一卡一卡，也和抛物线预览对不上。
   */
  function isFloorContact(rect, x, halfH, y, r, tol) {
    const rx = num(rect.x, 0);
    const rw = Math.max(0, num(rect.width, 0));
    const ry = num(rect.y, 0);
    if (rw <= 0) { return false; }
    if (x + r < rx || x - r > rx + rw) { return false; }
    return (y + halfH) <= ry + Math.max(0, tol);
  }

  function nearestFace(rects, ctx) {
    let best = null;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r) { continue; }
      const rx = num(r.x, 0);
      const rw = Math.max(0, num(r.width, 0));
      const ry = num(r.y, 0);
      const rh = Math.max(0, num(r.height, 0));
      if (rw <= 0 || rh <= 0) { continue; }
      /**
       * 垂直重叠判定（只检测水平方向，但仍要求两者在竖直方向上确实相邻）。
       * 第 8.5 步：主动移动是抛物线跳跃，单位在弧顶常常只是**贴着箱子顶边掠过**，
       * 严格不重叠会让「跳向木箱却不弹回」成为常见情况；
       * 因此加一个与接触缝隙同量级的容差，让「擦着箱体过去」也算撞上。
       */
      const tol = Math.max(0, num(ctx.tolerance, 8));
      if (ctx.yBottom <= ry - tol || ctx.yTop >= ry + rh + tol) { continue; }

      const centerX = num(ctx.x, (ctx.fromEdge + ctx.toEdge) / 2);
      const halfH = (ctx.yBottom - ctx.yTop) / 2;
      const bodyR = Math.max(0, halfH);
      if (isFloorContact(r, centerX, halfH, (ctx.yTop + ctx.yBottom) / 2, bodyR, tol)) { continue; }

      if (ctx.dir > 0) {
        const face = rx;                                  // 箱子 / 平台左面
        if (ctx.toEdge < face) { continue; }              // 还没碰到
        /**
         * 一高一低平台缝隙：单位从高台滑出后，身体已经压进低台左缘，
         * 但中心仍在立面外侧。旧口径把「前缘已越过立面」当成内部穿透直接跳过，
         * 于是侧撞永远不成立、人从缝里掉下去。
         * 中心仍在立面外侧 → 仍算迎面侧撞，把人推回面外并弹回。
         */
        if (ctx.fromEdge > face + 1e-6 && centerX >= face - 1e-6) { continue; }
        const dist = face - ctx.fromEdge;
        if (!best || dist < best.distance) { best = { rect: r, faceX: face, distance: dist }; }
      } else {
        const face = rx + rw;                             // 箱子 / 平台右面
        if (ctx.toEdge > face) { continue; }
        if (ctx.fromEdge < face - 1e-6 && centerX <= face + 1e-6) { continue; }
        const dist = ctx.fromEdge - face;
        if (!best || dist < best.distance) { best = { rect: r, faceX: face, distance: dist }; }
      }
    }
    return best;
  }

  /**
   * 空中坠落时：即使本帧水平位移为 0，只要身体已经卡进平台 / 木箱侧面，
   * 也要推回立面外侧（并可按弹性把速度弹开）。
   */
  function resolveEmbeddedSides(x, y, r, halfH, vx, rects, cfg, overrides, priorBounceCount) {
    const tol = Math.max(0, num(overrides && overrides.crateVerticalTolerancePx, 8));
    const yTop = y - halfH;
    const yBottom = y + halfH;
    let bounced = false;
    let bounceCount = 0;
    const hits = [];
    let newX = x;
    let newVx = vx;
    const prior = Math.max(0, Math.round(num(priorBounceCount, 0)));

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (!rect) { continue; }
      const rx = num(rect.x, 0);
      const rw = Math.max(0, num(rect.width, 0));
      const ry = num(rect.y, 0);
      const rh = Math.max(0, num(rect.height, 0));
      if (rw <= 0 || rh <= 0) { continue; }
      if (yBottom <= ry - tol || yTop >= ry + rh + tol) { continue; }
      if (isFloorContact(rect, newX, halfH, y, r, tol)) { continue; }

      const left = rx;
      const right = rx + rw;
      const unitLeft = newX - r;
      const unitRight = newX + r;

      if (newX < left - 1e-6 && unitRight > left) {
        newX = left - r - cfg.contactGapPx;
        bounced = true;
        bounceCount += 1;
        const ref = reflectVx(newVx > 0 ? newVx : 0, prior + bounceCount, cfg);
        hits.push({
          type: rect.kind || 'crate', id: rect.id || '', faceX: left,
          speed: Math.abs(newVx), index: prior + bounceCount, embedded: true, stopped: ref.stopped
        });
        if (newVx > 0) { newVx = ref.vx; }
      } else if (newX > right + 1e-6 && unitLeft < right) {
        newX = right + r + cfg.contactGapPx;
        bounced = true;
        bounceCount += 1;
        const ref = reflectVx(newVx < 0 ? newVx : 0, prior + bounceCount, cfg);
        hits.push({
          type: rect.kind || 'crate', id: rect.id || '', faceX: right,
          speed: Math.abs(newVx), index: prior + bounceCount, embedded: true, stopped: ref.stopped
        });
        if (newVx < 0) { newVx = ref.vx; }
      }
    }
    return { x: newX, vx: newVx, bounced: bounced, bounceCount: bounceCount, hits: hits };
  }

  /**
   * 贴地滑行时钉在当前支撑台左右沿外侧，速度按弹性反向。
   * 中心一旦滑出台面就会掉进缝隙；这里在脚还踩在顶面时就把人弹回来。
   */
  function bounceSupportEdge(s, world, overrides) {
    const cfg = readCfg(overrides);
    const st = s || {};
    let x = num(st.x, 0);
    let vx = num(st.vx, 0);
    const r = Math.max(0, num(st.halfWidth, 0));
    const y = num(st.y, 0);
    const halfH = Math.max(0, num(st.bodyHeight, r * 2)) / 2;
    const feet = y + halfH;
    const rects = (world && Array.isArray(world.rects)) ? world.rects : [];
    const footTol = Math.max(4, num(overrides && overrides.supportFootTolPx, 12));

    let stand = null;
    let bestGap = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (!rect) { continue; }
      const rx = num(rect.x, 0);
      const rw = Math.max(0, num(rect.width, 0));
      const ry = num(rect.y, 0);
      if (rw <= 0) { continue; }
      const gap = Math.abs(feet - ry);
      if (gap > footTol) { continue; }
      if (x < rx - r || x > rx + rw + r) { continue; }
      if (gap < bestGap) {
        bestGap = gap;
        stand = { x: rx, width: rw, y: ry, id: rect.id || '', kind: rect.kind || 'platform' };
      }
    }
    if (!stand) {
      return { x: x, vx: vx, bounced: false, bounceCount: 0, hits: [] };
    }

    const minX = stand.x + r + cfg.contactGapPx;
    const maxX = stand.x + stand.width - r - cfg.contactGapPx;
    if (minX >= maxX) {
      return { x: x, vx: vx, bounced: false, bounceCount: 0, hits: [] };
    }

    let bounced = false;
    let bounceCount = 0;
    const hits = [];
    let faceX = null;
    if (x < minX) {
      x = minX;
      faceX = stand.x;
      if (vx < 0) { bounced = true; }
    } else if (x > maxX) {
      x = maxX;
      faceX = stand.x + stand.width;
      if (vx > 0) { bounced = true; }
    }
    if (bounced) {
      bounceCount = 1;
      const prior = Math.max(0, Math.round(num(st.priorBounceCount, 0)));
      const speed = Math.abs(vx);
      const ref = reflectVx(vx, prior + 1, cfg);
      hits.push({
        type: stand.kind, id: stand.id, faceX: faceX, speed: speed,
        index: prior + 1, supportEdge: true, stopped: ref.stopped
      });
      vx = ref.vx;
    }
    return { x: x, vx: vx, bounced: bounced, bounceCount: bounceCount, hits: hits };
  }

  /**
   * 推进一帧的水平击退位移，并在撞到木箱 / 墙时做弹性反弹。
   *
   * @param {Object} s   状态 { x, vx, stepPx?, halfWidth, y, bodyHeight? }
   *   x          单位中心 x（px）
   *   vx         当前水平速度（px/s，右为正；只用于判方向与反弹，不重复积分位移）
   *   stepPx     这一帧要走的水平位移（px）；缺省 = vx × dtSec
   *   halfWidth  单位碰撞半径（px）——用于计算左右边缘
   *   y          单位中心 y（px）
   *   bodyHeight 单位竖直碰撞高度（px，缺省 2 × halfWidth）
   * @param {number} dtSec 这一帧的秒数
   * @param {Object} world { rects:[], bounds:{left,right,type,disabled} }
   * @param {Object} [overrides] 配置覆盖（自检用；正式流程读 FK.Config.DAMAGE）
   * @returns {{x:number, vx:number, bounced:boolean, bounceCount:number, hits:Array, mode:string}}
   */
  function stepHorizontal(s, dtSec, world, overrides) {
    const cfg = readCfg(overrides);
    const st = s || {};
    let x = num(st.x, 0);
    let vx = num(st.vx, 0);
    const r = Math.max(0, num(st.halfWidth, 0));
    const y = num(st.y, 0);
    const halfH = Math.max(0, num(st.bodyHeight, r * 2)) / 2;

    const world2 = world || {};
    const rects = Array.isArray(world2.rects) ? world2.rects : [];
    const bounds = world2.bounds || null;
    const mode = boundaryMode(bounds, overrides);

    const dt = (typeof dtSec === 'number' && isFinite(dtSec) && dtSec > 0) ? dtSec : 0;
    const hits = [];
    let bounceCount = 0;
    let bounced = false;
    const prior = Math.max(0, Math.round(num(st.priorBounceCount, 0)));

    // 本帧要走的位移：优先用调用方算好的（与阻尼积分口径一致）
    let budget = (typeof st.stepPx === 'number' && isFinite(st.stepPx)) ? st.stepPx : vx * dt;

    // 先把已经卡进侧面的身体推出去（高台→低台缝隙、竖直下落时 stepPx 常为 0）
    const embedded = resolveEmbeddedSides(x, y, r, halfH, vx, rects, cfg, overrides, prior);
    x = embedded.x;
    vx = embedded.vx;
    if (embedded.bounced) {
      bounced = true;
      bounceCount += embedded.bounceCount;
      for (let hi = 0; hi < embedded.hits.length; hi++) { hits.push(embedded.hits[hi]); }
      budget = 0; // 本帧已推回立面，避免同一帧再迎面弹一次把弹性打两次
    }

    if (!budget || !isFinite(budget)) {
      return { x: x, vx: vx, bounced: bounced, bounceCount: bounceCount, hits: hits, mode: mode };
    }

    // ---- 逐小段推进（每段位移 ≤ maxStepPx，防隧穿）----
    // 关键：撞上之后**剩下的行程也要反向并乘以弹性系数**，否则同一帧里会
    // 反复撞同一面墙（速度被连续打折），物理上不成立。
    const maxIter = Math.ceil(Math.abs(budget) / cfg.maxStepPx) + cfg.maxBounceCount * 2 + 4;
    let iter = 0;

    while (Math.abs(budget) > 1e-9 && iter++ < maxIter) {
      const step = (budget > cfg.maxStepPx) ? cfg.maxStepPx
        : ((budget < -cfg.maxStepPx) ? -cfg.maxStepPx : budget);
      const dir = (step > 0) ? 1 : -1;
      const fromX = x;
      const toX = x + step;
      const fromEdge = fromX + dir * r;             // 行进方向上的前缘
      const toEdge = toX + dir * r;
      const yTop = y - halfH;
      const yBottom = y + halfH;

      // ---- ① 木箱（多个时取行进方向上最近的那个面） ----
      const hit = nearestFace(rects, {
        dir: dir, fromEdge: fromEdge, toEdge: toEdge, yTop: yTop, yBottom: yBottom,
        x: fromX,
        // 第 8.5 步：抛物线跳跃时的「擦箱而过」也应当弹回（见 nearestFace 注释）
        tolerance: num(overrides && overrides.crateVerticalTolerancePx, 8)
      });
      if (hit) {
        // 停在箱子边缘外侧
        x = (dir > 0) ? (hit.faceX - r - cfg.contactGapPx) : (hit.faceX + r + cfg.contactGapPx);
        bounceCount += 1;
        bounced = true;
        const speed = Math.abs(vx);
        const ref = reflectVx(vx, prior + bounceCount, cfg);
        hits.push({
          type: hit.rect.kind || 'crate', id: hit.rect.id || '', faceX: hit.faceX,
          speed: speed, index: prior + bounceCount, stopped: ref.stopped
        });
        vx = ref.vx;
        if (ref.stopped) {
          budget = 0;
          break;
        }
        budget = -(budget - step) * ref.rest;
        continue;
      }

      // ---- ② 地图边界（类型来自 map.json） ----
      if (bounds && mode !== 'off') {
        const left = num(bounds.left, null);
        const right = num(bounds.right, null);
        let wallFace = null;
        if (dir > 0 && right !== null && toEdge >= right) { wallFace = right; }
        if (dir < 0 && left !== null && toEdge <= left) { wallFace = left; }
        if (wallFace !== null) {
          x = (dir > 0) ? (wallFace - r - cfg.contactGapPx) : (wallFace + r + cfg.contactGapPx);
          const speed = Math.abs(vx);
          if (mode === 'bounce') {
            bounceCount += 1;
            bounced = true;
            const ref = reflectVx(vx, prior + bounceCount, cfg);
            hits.push({
              type: 'wall', id: 'bounds', faceX: wallFace, speed: speed,
              index: prior + bounceCount, stopped: ref.stopped
            });
            vx = ref.vx;
            if (ref.stopped) {
              budget = 0;
              break;
            }
            budget = -(budget - step) * ref.rest;
          } else {
            // 果汁边界（未来地图）：本步不反弹，只停在地图内
            hits.push({ type: 'boundary-' + (bounds.type || 'wall'), id: 'bounds',
              faceX: wallFace, speed: speed, index: 0, stopped: true });
            vx = 0;
            budget = 0;
            break;
          }
          continue;
        }
      }

      // ---- ③ 无碰撞：正常推进 ----
      x = toX;
      budget -= step;
    }

    return { x: x, vx: vx, bounced: bounced, bounceCount: bounceCount, hits: hits, mode: mode };
  }

  /**
   * 预留：主动移动的碰撞入口（第 7.10 步只写规则，不接入操作）。
   * 与击退共用同一套弹性碰撞，因此「主动移动撞到木箱 / 墙也会弹回」天然成立。
   * @param {Object} opts { x, y, vx, halfWidth, bodyHeight, dtSec, world }
   */
  function stepActiveMove(opts) {
    const o = opts || {};
    return stepHorizontal(
      { x: o.x, vx: o.vx, halfWidth: o.halfWidth, y: o.y, bodyHeight: o.bodyHeight },
      num(o.dtSec, 0), o.world, o.overrides
    );
  }

  /**
   * 主动移动 / 预览共用的一帧：先积分高度，再水平弹性碰撞。
   * 预览 simulatePath 与 UnitBase.stepActiveMove 必须走这里，否则抛物线会对不上实飞。
   */
  function stepFlightSlice(s, dtSec, world, overrides) {
    const st = s || {};
    const g = num(st.g, 1500);
    const dt = (typeof dtSec === 'number' && isFinite(dtSec) && dtSec > 0) ? dtSec : 0;
    const hw = Math.max(0, num(st.halfWidth, 24));
    const x0 = num(st.x, 0);
    const y0 = num(st.y, 0);
    const vx0 = num(st.vx, 0);
    const vy0 = num(st.vy, 0);
    const nextX = x0 + vx0 * dt;
    const nextY = y0 + vy0 * dt + 0.5 * g * dt * dt;
    const nextVy = vy0 + g * dt;
    const hit = stepHorizontal({
      x: x0,
      vx: vx0,
      stepPx: nextX - x0,
      halfWidth: hw,
      y: nextY,
      bodyHeight: hw * 2,
      priorBounceCount: num(st.priorBounceCount, 0)
    }, dt, world, overrides);
    return {
      x: hit.x,
      y: nextY,
      vx: hit.vx,
      vy: nextVy,
      bounced: !!hit.bounced,
      bounceCount: hit.bounceCount || 0,
      hits: hit.hits || [],
      mode: hit.mode
    };
  }

  FK.KnockbackPhysics = {
    stepHorizontal: stepHorizontal,
    stepActiveMove: stepActiveMove,
    stepFlightSlice: stepFlightSlice,
    bounceSupportEdge: bounceSupportEdge,
    readCfg: readCfg,
    boundaryMode: boundaryMode,
    nearestFace: nearestFace,
    BOUNDARY_MODES: Object.freeze(Object.assign({}, BOUNDARY_MODES))
  };
})();
