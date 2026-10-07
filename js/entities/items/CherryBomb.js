/**
 * ============================================================
 * CherryBomb.js —— 樱桃炸弹（道具模块 · 第 6 步完整实现）
 * ============================================================
 * 道具定位（文档 3 §5 冻结参数，全部来自 data/items.json）：
 *   力度系数 range = 1.00（满力 45° 射程 20.0 u，基准道具）
 *   中心伤害 damage = 35，满伤内圈 innerRadiusUnits = 0.8 u
 *   爆炸半径 radius = 2.5 u（120 px），边缘伤害系数 edgeDamageRatio = 0.40 → 边缘 14 点
 *   击退 knockback = 260 px/s，引爆延迟 fuseOnHitMs = 50 ms
 *   爆炸演出 explodeAnimMs = 350 ms
 *
 * 四个接口各自的职责（本模块**不硬编码任何数值，也不直接操作单位**）：
 *   onThrow(ctx)    记录出手信息；投掷物由 ProjectileController 按 ItemConfig 生成
 *   onLand(ctx)     语义：落地即点火（真实引信倒计时由控制器按 fuseOnHitMs 驱动）
 *   onExplode(ctx)  ① 委托 ctx.createExplosion() 画爆炸圆（表现）
 *                   ② 委托 ctx.controller.settle() 走 DamageSystem 结算伤害与击退（逻辑）
 *   onTurnEnd(ctx)  即时道具，无需处理
 *
 * 这样拆的好处：换特效不动伤害、换伤害曲线不动特效、第 7 步加西瓜/果箱
 * 只需复制这个骨架并改 JSON 数值。
 *
 * 对应 data/items.json 中的 id: "cherry_bomb"
 * 依赖：无（不引用 Phaser、不引用单位实现，一切通过 ctx 注入）
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.item = FK.ModuleFactories.item || {};

(function () {
  'use strict';

  /**
   * 道具模块工厂（无副作用纯函数）
   * 注册时会被 Registry 调用一次做接口契约校验，因此内部不得产生副作用。
   * @returns {{id:string, kind:string, displayName:string, onThrow:Function, onLand:Function, onExplode:Function, onTurnEnd:Function}}
   */
  FK.ModuleFactories.item.cherry_bomb = function createCherryBombModule() {
    return {
      id: 'cherry_bomb',
      kind: 'item',
      displayName: '樱桃炸弹',

      /**
       * 投掷出手。
       * 投掷物的创建与初速度设定已由 ProjectileController 按 ItemConfig.range 完成，
       * 本方法只做「道具自己的出手表现」——第 6 步先记录，第 7 步可在此挂音效/拖尾。
       * @param {Object} ctx { unit, item, projectile, vx, vy, predictedLanding, controller }
       */
      onThrow: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        const flight = {
          itemId: 'cherry_bomb',
          shooterId: (c.unit && typeof c.unit.getId === 'function') ? c.unit.getId() : '',
          vx: c.vx,
          vy: c.vy,
          predictedLanding: c.predictedLanding || null,
          // 数值只读自 ItemConfig，模块内不出现魔法数字
          range: c.item ? c.item.range : null,
          projectileRadiusPx: (c.item ? c.item.projectileRadiusUnits : 0) * c.pxPerUnit
        };
        if (typeof c.log === 'function') {
          c.log('出手：力度系数 ' + flight.range + '，预测落点 ' +
            (flight.predictedLanding ? '(' + Math.round(flight.predictedLanding.x) + ',' +
              Math.round(flight.predictedLanding.y) + ')' : '未预测'));
        }
        return flight;
      },

      /**
       * 落地 / 碰撞。
       * 语义：樱桃炸弹落地即点火，真实引信倒计时由 ProjectileController 按
       * ItemConfig.fuseOnHitMs 驱动（控制器统一计时，模块不自己 setTimeout）。
       * @param {Object} ctx { landing, x, y, hitType, hitTarget, item, fuseMs }
       */
      onLand: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        const info = {
          itemId: 'cherry_bomb',
          x: c.x,
          y: c.y,
          hitType: c.hitType,
          hitTargetId: c.hitTarget ? c.hitTarget.id : null,
          fuseMs: c.fuseMs
        };
        if (typeof c.log === 'function') {
          c.log('落地：' + info.hitType +
            (info.hitTargetId ? '（' + info.hitTargetId + '）' : '') +
            ' @(' + Math.round(info.x) + ',' + Math.round(info.y) + ')，引信 ' + info.fuseMs + 'ms');
        }
        return info;
      },

      /**
       * 爆炸。
       * ① 表现：创建爆炸圆（半径/时长都从 ItemConfig 读取，由控制器负责换算）
       * ② 逻辑：委托 DamageSystem 统一结算伤害与击退（本模块不碰单位）
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

        if (typeof c.log === 'function') {
          const n = result ? result.damaged.length : 0;
          c.log('爆炸：半径 ' + c.radiusUnits + 'u，中心伤害 ' + c.damage +
            '（内圈 ' + c.innerRadiusUnits + 'u，边缘系数 ' + c.edgeDamageRatio + '），' +
            '击退 ' + c.knockback + 'px/s → 命中 ' + n + ' 个单位');
        }
        return result;
      },

      /**
       * 回合结束。
       * 樱桃炸弹是即时道具（duration = 0），落地当回合就消失，无需处理。
       * @param {Object} ctx
       */
      onTurnEnd: function (ctx) {
        return null;
      }
    };
  };
})();
