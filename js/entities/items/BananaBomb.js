/**
 * ============================================================
 * BananaBomb.js —— 香蕉弹（第 14 步）
 * ============================================================
 * 地形高弹跳；动能耗尽或投掷者左键引爆；擦人默认不爆；
 * 落入果汁池 / 飞出边界直接消失、不爆炸。
 * 数值全部来自 data/items.json。
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.item = FK.ModuleFactories.item || {};

(function () {
  'use strict';

  const ITEM_ID = 'banana_bomb';

  FK.ModuleFactories.item.banana_bomb = function createBananaBombModule() {
    return {
      id: ITEM_ID,
      kind: 'item',
      displayName: '香蕉弹',

      onThrow: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        const flight = {
          itemId: ITEM_ID,
          shooterId: (c.unit && typeof c.unit.getId === 'function') ? c.unit.getId() : '',
          vx: c.vx,
          vy: c.vy,
          predictedLanding: c.predictedLanding || null,
          range: c.item ? c.item.range : null
        };
        if (typeof c.log === 'function') {
          c.log('出手：香蕉弹弹跳飞行，没动能或左键引爆');
        }
        return flight;
      },

      onLand: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        const info = {
          itemId: ITEM_ID,
          x: c.x,
          y: c.y,
          hitType: c.hitType,
          sunk: !!c.sunk,
          fuseMs: c.fuseMs
        };
        if (typeof c.log === 'function') {
          c.log((info.sunk ? '消失：' : '引爆：') + info.hitType +
            ' @(' + Math.round(info.x) + ',' + Math.round(info.y) + ')');
        }
        return info;
      },

      onExplode: function (ctx) {
        if (!ctx) { return null; }
        const c = ctx;
        if (typeof c.createExplosion === 'function') {
          c.createExplosion();
        }
        let result = c.result;
        if (c.controller && typeof c.controller.settle === 'function') {
          result = c.controller.settle(c);
        }
        if (typeof c.log === 'function') {
          const n = result ? result.damaged.length : 0;
          c.log('爆炸：半径 ' + c.radiusUnits + 'u，中心伤害 ' + c.damage + '，命中 ' + n + ' 个单位');
        }
        return result;
      },

      onTurnEnd: function () {
        return null;
      }
    };
  };
})();
