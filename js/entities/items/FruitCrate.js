/**
 * ============================================================
 * FruitCrate.js —— 水果箱（道具模块 · 第 7 步完整实现）
 * ============================================================
 * 道具定位（全部来自 data/items.json）：
 *   力度系数 range = 0.92（介于樱桃 1.0 与西瓜 0.72 之间）
 *   伤害 damage = 0、半径 radius = 0、击退 knockback = 0  → 非伤害道具
 *   持续 duration = 4 回合（放置当回合免计），边长 crateSizeUnits = 1.5 u（= 72 px）
 *   fuseOnHitMs = 0（放置类道具落地即生效，没有引信）
 *
 * 玩法（第 7.5 步起改为「点击放置」）：
 *   选中水果箱 → 进入放置模式（**不再显示抛物线**）→ 点击地图任意位置
 *   → 木箱从该位置自由落体 → 落到最近的地面 / 平台 / 已有木箱顶面
 *   → 生成 1.5u 木箱（duration = 4：放置当回合免计 → 存活 4 个回合）
 *   → 自动结束回合、轮到对方。
 *
 *   时间线（蓝方放置为例）：Turn 1 放置出现 → Turn 2/3/4 都在 → Turn 5 消失。
 *
 *   整条放置链路（预览 / 射线找落点 / 下落动画 / 合法性判定 / 事件）
 *   在 FK.PlacementController 里，本模块只负责**落地这一刻**的表现与生成。
 *   投掷入口（onThrow）保留但不再被鼠标触发——因为 AimController 对
 *   type='obstacle' 的道具直接拒绝进入瞄准，投掷路径成为兜底（例如脚本调用）。
 *
 * 特别规则：
 *   · 落入果汁池不生成木箱（onLand 里先看 ctx.sunk / hitType）
 *   · 第 7.9 步起**没有数量上限**：落地即生成（节奏由「按阵营冷却 1 个 turn」控制）
 *
 * 四接口职责：
 *   onThrow(ctx)    记录出手信息（兜底路径）
 *   onLand(ctx)     生成障碍物（落水则放弃；无数量上限）
 *   onExplode(ctx)  无伤害、无击退，只做「放置完成」的表现说明
 *   onTurnEnd(ctx)  本期不自行倒计时（倒计时统一由 ObstacleRegistry 每回合广播
 *                   turn:obstacleTick 推进），这里把结论透出来便于自检
 *
 * 对应 data/items.json 中的 id: "fruit_crate"
 * 依赖：无（不引用 Phaser；障碍物的创建与倒计时都交给系统层）
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.item = FK.ModuleFactories.item || {};

(function () {
  'use strict';

  const ITEM_ID = 'fruit_crate';

  /**
   * 道具模块工厂（无副作用纯函数）
   * @returns {{id:string, kind:string, displayName:string, onThrow:Function, onLand:Function, onExplode:Function, onTurnEnd:Function}}
   */
  FK.ModuleFactories.item.fruit_crate = function createFruitCrateModule() {
    /** 本模块放置过的箱子 id（仅用于日志与自检，不影响玩法） */
    let lastObstacleId = null;

    return {
      id: ITEM_ID,
      kind: 'item',
      displayName: '水果箱',

      /**
       * 投掷出手。
       * @param {Object} ctx { unit, item, projectile, vx, vy, predictedLanding, pxPerUnit }
       */
      onThrow: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        const flight = {
          itemId: ITEM_ID,
          shooterId: (c.unit && typeof c.unit.getId === 'function') ? c.unit.getId() : '',
          vx: c.vx,
          vy: c.vy,
          predictedLanding: c.predictedLanding || null,
          range: c.item ? c.item.range : null,
          duration: c.item ? c.item.duration : null,
          sizeUnits: c.item ? c.item.crateSizeUnits : null
        };
        if (typeof c.log === 'function') {
          c.log('投出果箱：射程系数 ' + flight.range + '，落地将生成 ' +
            flight.sizeUnits + 'u 木箱（持续 ' + flight.duration + ' 回合）');
        }
        return flight;
      },

      /**
       * 落地：生成静态障碍物。
       * ① 落水 → 放弃放置（由果汁池吞掉，与第 7 步落水规则一致）
       * ② 落在地形 / 边界 / 超时 → 吸附生成木箱，箱子**底边对齐落点**，
       *    这样箱子正好「坐」在平台表面上，后续投掷物的碰撞面也就在表面。
       * @param {Object} ctx { landing, x, y, hitType, item, pxPerUnit, obstacleRegistry, turnNumber, unit }
       */
      onLand: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        const item = c.item || {};
        const sizeUnits = (typeof item.crateSizeUnits === 'number') ? item.crateSizeUnits : 1.5;
        const sizePx = sizeUnits * c.pxPerUnit;

        const info = {
          itemId: ITEM_ID,
          x: c.x,
          y: c.y,
          hitType: c.hitType,
          sunk: !!c.sunk,
          sizeUnits: sizeUnits,
          duration: item.duration,
          obstacleId: null
        };

        // ---- ① 落水：不生成箱子 ----
        if (c.sunk || c.hitType === 'water') {
          info.sunk = true;
          if (typeof c.log === 'function') {
            c.log('果箱落入果汁池 → 不生成木箱（落水即销毁）');
          }
          return info;
        }

        // ---- ② 吸附：箱子中心 = 落点向上抬半个箱子高度 ----
        const centerX = c.x;
        const centerY = c.y - sizePx / 2;

        const reg = c.obstacleRegistry;
        if (!reg || typeof reg.spawn !== 'function') {
          if (typeof c.log === 'function') {
            c.log('障碍物注册表不可用，果箱落地后未生成木箱');
          }
          return info;
        }

        const obstacle = reg.spawn({
          scene: c.scene,
          itemId: ITEM_ID,
          team: c.team || (c.unit && typeof c.unit.getTeam === 'function' ? c.unit.getTeam() : ''),
          ownerId: (c.unit && typeof c.unit.getId === 'function') ? c.unit.getId() : '',
          x: centerX,
          y: centerY,
          sizeUnits: sizeUnits,
          duration: item.duration,
          turnNumber: c.turnNumber
        });

        if (obstacle) {
          lastObstacleId = obstacle.obstacleId;
          info.obstacleId = obstacle.obstacleId;
        }
        if (typeof c.log === 'function') {
          c.log('落地生成木箱：' + sizeUnits + 'u × ' + sizeUnits + 'u @(' +
            Math.round(centerX) + ',' + Math.round(centerY) + ')，持续 ' + item.duration +
            ' 回合，已加入弹道碰撞');
        }
        return info;
      },

      /**
       * 「爆炸」：水果箱无伤害、无击退、无爆炸半径，
       * 走到这里只代表「道具已被消费、木箱已放置完成」。
       * @param {Object} ctx
       */
      onExplode: function (ctx) {
        const c = ctx || {};
        if (typeof c.log === 'function') {
          c.log('无爆炸效果（damage=' + (c.damage || 0) + '，radius=' + (c.radiusUnits || 0) +
            '），本道具的意义是把木箱放到场上当掩体');
        }
        return { itemId: ITEM_ID, obstacleId: lastObstacleId, noDamage: true };
      },

      /**
       * 回合结束。
       * 木箱的倒计时由 FK.ObstacleRegistry.onTurnEnd() 统一推进并广播
       * turn:obstacleTick（倒计时 -1，归零即 obstacle:removed），
       * 模块自身不持有计时器——避免「模块与场景各记一份回合数」而漂移。
       * @param {Object} ctx { obstacleRegistry, turnNumber }
       */
      onTurnEnd: function (ctx) {
        const c = ctx || {};
        const reg = c.obstacleRegistry;
        if (!reg || typeof reg.onTurnEnd !== 'function') {
          return { itemId: ITEM_ID, ticked: false };
        }
        const result = reg.onTurnEnd(c.turnNumber);
        return {
          itemId: ITEM_ID,
          ticked: true,
          alive: result.count,
          removed: result.removed
        };
      }
    };
  };
})();
