/**
 * ============================================================
 * WatermelonBomb.js —— 西瓜炸弹（道具模块 · 第 7 步完整实现）
 * ============================================================
 * 道具定位（文档 3 冻结参数，全部来自 data/items.json）：
 *   力度系数 range = 0.72 → 射程明显短于樱桃炸弹（满力 45° 约 14.4 单位）
 *   中心伤害 damage = 60，满伤内圈 innerRadiusUnits = 1.2 u
 *   爆炸半径 radius = 3.5 u（168 px），边缘系数 edgeDamageRatio = 0.50 → 边缘 30 点
 *   击退 knockback = 460 px/s（樱桃 260 的 1.77 倍，「重炮」手感）
 *   引信 fuseOnHitMs = 30 ms（比樱桃 50ms 更短，落地几乎立刻炸）
 *   爆炸演出 explodeAnimMs = 450 ms
 *
 * 四维差异化一句话总结：
 *   射程更短 · 伤害更高 · 半径更大 · 击退更强 · 引信更短
 *   —— 这五项**一个都不写在代码里**，全部读 ItemConfig；
 *      改 items.json 就能重新配平，模块本身零改动。
 *
 * 与樱桃炸弹的唯一结构差异：
 *   樱桃炸弹是「基准弹」，西瓜是「重炮」。本模块因此额外做一件事——
 *   在 onExplode 里把爆炸范围一并交给 DamageSystem 时，顺带把落在半径内的
 *   障碍物（水果箱）扫掉（用 ctx.obstacleRegistry）。这是「重炮砸碎木箱」的
 *   玩法差异，逻辑仍然只调系统接口，不自己算伤害。
 *
 * 对应 data/items.json 中的 id: "watermelon_bomb"
 * 依赖：无（不引用 Phaser、不引用单位实现，一切通过 ctx 注入）
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.item = FK.ModuleFactories.item || {};

(function () {
  'use strict';

  const ITEM_ID = 'watermelon_bomb';

  /** 取障碍物矩形中心到爆心的距离（地图单位） */
  function distanceUnits(a, b, pxPerUnit) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy) / Math.max(1e-6, pxPerUnit);
  }

  /**
   * 道具模块工厂（无副作用纯函数）
   * 注册时会被 Registry 调用一次做接口契约校验，因此内部不得产生副作用。
   * @returns {{id:string, kind:string, displayName:string, onThrow:Function, onLand:Function, onExplode:Function, onTurnEnd:Function}}
   */
  FK.ModuleFactories.item.watermelon_bomb = function createWatermelonBombModule() {
    return {
      id: ITEM_ID,
      kind: 'item',
      displayName: '西瓜炸弹',

      /**
       * 投掷出手。
       * 投掷物的创建与初速度（含 range 0.72 的射程折减）已由
       * ProjectileController 按 ItemConfig 完成，这里只记录本次出手的特征值，
       * 供 HUD 与自检核对「射程短」是否真的生效。
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
          speed: Math.sqrt((c.vx || 0) * (c.vx || 0) + (c.vy || 0) * (c.vy || 0)),
          predictedLanding: c.predictedLanding || null,
          // 数值只读自 ItemConfig，模块内不出现魔法数字
          range: c.item ? c.item.range : null,
          projectileRadiusPx: (c.item ? c.item.projectileRadiusUnits : 0) * c.pxPerUnit
        };
        if (typeof c.log === 'function') {
          c.log('重炮出手：射程系数 ' + flight.range + '（樱桃为 1.0），初速度 ' +
            Math.round(flight.speed) + 'px/s，预测落点 ' +
            (flight.predictedLanding ? '(' + Math.round(flight.predictedLanding.x) + ',' +
              Math.round(flight.predictedLanding.y) + ')' : '未预测'));
        }
        return flight;
      },

      /**
       * 落地 / 碰撞。
       * 西瓜引信极短（ItemConfig.fuseOnHitMs = 30），语义上就是「落地即炸」；
       * 真实倒计时仍由 FuseSystem 统一驱动（模块不自己 setTimeout）。
       * @param {Object} ctx { landing, x, y, hitType, hitTarget, item, fuseMs, sunk }
       */
      onLand: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        const info = {
          itemId: ITEM_ID,
          x: c.x,
          y: c.y,
          hitType: c.hitType,
          hitTargetId: c.hitTarget ? c.hitTarget.id : null,
          fuseMs: c.fuseMs,
          sunk: !!c.sunk
        };
        if (typeof c.log === 'function') {
          if (info.sunk) {
            c.log('西瓜落入果汁池 → 直接销毁，不爆炸');
          } else {
            c.log('落地：' + info.hitType +
              (info.hitTargetId ? '（' + info.hitTargetId + '）' : '') +
              ' @(' + Math.round(info.x) + ',' + Math.round(info.y) + ')，短引信 ' + info.fuseMs + 'ms');
          }
        }
        return info;
      },

      /**
       * 爆炸。
       * ① 表现：创建爆炸圆（半径 3.5u / 时长 450ms，全部来自 ItemConfig）
       * ② 逻辑：委托 DamageSystem 结算伤害与击退（本模块不碰单位血量）
       * ③ 重炮特性：顺带清扫爆炸半径内的障碍物（水果箱）
       * @param {Object} ctx 爆炸上下文（见 ProjectileController.buildExplodeContext）
       */
      onExplode: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;

        // ---------- ① 表现 ----------
        if (typeof c.createExplosion === 'function') {
          c.createExplosion();                       // radiusPx / durationMs 均取自 ctx（= ItemConfig）
        }

        // ---------- ② 逻辑（伤害 + 击退，统一由 DamageSystem 处理） ----------
        let result = c.result;
        if (c.controller && typeof c.controller.settle === 'function') {
          result = c.controller.settle(c);
        }

        // ---------- ③ 重炮清扫：半径内的水果箱被震碎 ----------
        const crushed = this.crushObstaclesInRadius(c);

        if (typeof c.log === 'function') {
          const n = result ? result.damaged.length : 0;
          c.log('爆炸：半径 ' + c.radiusUnits + 'u（' + Math.round(c.radiusPx) + 'px）' +
            '，中心伤害 ' + c.damage + '（内圈 ' + c.innerRadiusUnits + 'u，边缘系数 ' +
            c.edgeDamageRatio + '，边缘伤害 ' + Math.round(c.damage * c.edgeDamageRatio) + '）' +
            '，击退 ' + c.knockback + 'px/s → 命中 ' + n + ' 个单位' +
            (crushed > 0 ? '，震碎 ' + crushed + ' 个水果箱' : ''));
        }
        return result;
      },

      /**
       * 震碎爆心半径内的水果箱（重炮专属玩法差异）。
       * 只通过 ObstacleRegistry 的公开接口操作，不直接改场景对象。
       * @param {Object} c 爆炸上下文
       * @returns {number} 被震碎的箱子数量
       */
      crushObstaclesInRadius: function (c) {
        const reg = c.obstacleRegistry;
        if (!reg || typeof reg.list !== 'function' || typeof reg.getById !== 'function' ||
            typeof reg.remove !== 'function') {
          return 0;
        }
        const radiusUnits = (typeof c.radiusUnits === 'number') ? c.radiusUnits : 0;
        if (radiusUnits <= 0) { return 0; }

        const center = { x: c.x, y: c.y };
        const list = reg.list();
        let crushed = 0;
        for (let i = 0; i < list.length; i++) {
          const info = list[i];
          if (distanceUnits(info, center, c.pxPerUnit) >= radiusUnits) { continue; }
          const ob = reg.getById(info.id);
          if (ob && reg.remove(ob, 'crushed')) { crushed += 1; }
        }
        return crushed;
      },

      /**
       * 回合结束。
       * 西瓜炸弹是即时道具（duration = 0），落地当回合就消失，无需处理。
       * @param {Object} ctx
       */
      onTurnEnd: function (ctx) {
        return null;
      }
    };
  };
})();
