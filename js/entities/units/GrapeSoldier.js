/**
 * ============================================================
 * GrapeSoldier.js —— 葡萄小兵（单位模块）
 * ============================================================
 * 本模块在第 4 步已实现「实例化 + 视觉 + 选中/悬停 + 血条」：
 *   create(scene, config, spawnPoint)  由 UnitSpawner 调用，生成单位实体
 *   update(unit, dt)                   每帧更新（基类为空实现）
 *   destroy(unit)                      移除单位与其绑定资源
 *
 * 视觉特征（程序化卡通）：
 *   紫葡萄 3-2-1 串 + 果梗 + 每粒高光 + 搞怪歪嘴
 *
 * 仍待后续步骤实现：拖拽 / 抛物线 / 投掷（第 5、6 步）
 * 对应 data/units.json 中的 id: "grape_soldier"（敌方 / red / hp 100）
 * 依赖：FK.UnitBase
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.unit = FK.ModuleFactories.unit || {};

(function () {
  'use strict';

  /** 葡萄小兵：敌方兵种 */
  class GrapeSoldier extends FK.UnitBase {

    /** 身体色比首领浅一档，便于在战场上区分兵种 */
    getBodyColor() {
      return this.getTeamPalette().light;
    }

    /** 装饰：一串葡萄粒 + 果梗 */
    buildDecor(g, palette) {
      // 绿色果梗
      g.lineStyle(3, 0x16A34A, 1);
      g.beginPath(); g.moveTo(0, -16); g.lineTo(-3, -32); g.strokePath();
      g.fillStyle(0x22C55E, 1);
      g.fillEllipse(6, -30, 12, 6);
      g.lineStyle(2, 0x166534, 1);
      g.strokeEllipse(6, -30, 12, 6);

      // 葡萄串 3-2-1：圆身 + 描边 + 左上高光
      const berries = [
        [-11, -6, 8], [0, -10, 8], [11, -6, 8],
        [-7, 5, 8], [7, 5, 8],
        [0, 14, 6]
      ];
      let i;
      for (i = 0; i < berries.length; i++) {
        const b = berries[i];
        g.fillStyle(0x7E22CE, 1);
        g.fillCircle(b[0], b[1], b[2]);
        g.fillStyle(0x4C1D95, 0.35);
        g.fillCircle(b[0] + 2, b[1] + 2, b[2] * 0.55);
        g.lineStyle(2, 0x4C1D95, 1);
        g.strokeCircle(b[0], b[1], b[2]);
        g.fillStyle(0xFFFFFF, 0.7);
        g.fillCircle(b[0] - 2.5, b[1] - 2.5, 2);
      }
      g.fillStyle(palette.light, 0.35);
      g.fillCircle(11, -6, 4);

      // 表情：圆眼落在上排中果 + 搞怪歪嘴
      g.fillStyle(0xFFFFFF, 1);
      g.fillCircle(-4, -10, 3.6);
      g.fillCircle(4, -10, 3.6);
      g.fillStyle(0x0F172A, 1);
      g.fillCircle(-3.2, -9.4, 1.9);
      g.fillCircle(5, -10.6, 1.9);
      g.fillStyle(0xFFFFFF, 1);
      g.fillCircle(-4.6, -11, 1.1);
      g.fillCircle(3.2, -11.2, 1.1);
      g.fillStyle(0xFB7185, 0.45);
      g.fillCircle(-10, -1, 2.6);
      g.fillCircle(10, -1, 2.6);
      g.lineStyle(2, 0x3B0764, 1);
      g.beginPath();
      g.moveTo(-4, 1);
      g.lineTo(1, 4);
      g.lineTo(8, 0);
      g.strokePath();
      g.fillStyle(palette.accent, 1);
      g.fillCircle(0, 14, 1.4);
    }
  }

  /** 单位模块工厂（无副作用纯函数，注册时会被调用一次做接口契约校验） */
  FK.ModuleFactories.unit.grape_soldier = function createGrapeSoldierModule() {
    return {
      id: 'grape_soldier',
      kind: 'unit',
      displayName: '葡萄小兵',

      create: function (scene, config, spawnPoint) {
        return new GrapeSoldier(scene, config, spawnPoint).create(scene, config, spawnPoint);
      },

      update: function (unit, dt) {
        if (unit && typeof unit.update === 'function') { unit.update(dt); }
      },

      destroy: function (unit) {
        if (unit && typeof unit.destroy === 'function') { unit.destroy(); }
      }
    };
  };

  FK.UnitClasses = FK.UnitClasses || {};
  FK.UnitClasses.GrapeSoldier = GrapeSoldier;
})();
