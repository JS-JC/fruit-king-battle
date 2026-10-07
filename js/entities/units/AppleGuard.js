/**
 * ============================================================
 * AppleGuard.js —— 苹果卫士（单位模块）
 * ============================================================
 * 本模块在第 4 步已实现「实例化 + 视觉 + 选中/悬停 + 血条」：
 *   create(scene, config, spawnPoint)  由 UnitSpawner 调用，生成单位实体
 *   update(unit, dt)                   每帧更新（基类为空实现）
 *   destroy(unit)                      移除单位与其绑定资源
 *
 * 视觉特征（程序化卡通）：
 *   红色圆润苹果 + 果柄绿叶 + 高光暗部 + 微笑五官与腮红
 *
 * 仍待后续步骤实现：拖拽 / 抛物线 / 投掷（第 5、6 步）
 * 对应 data/units.json 中的 id: "apple_guard"（己方 / blue / hp 100）
 * 依赖：FK.UnitBase
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.unit = FK.ModuleFactories.unit || {};

(function () {
  'use strict';

  /** 苹果卫士：己方兵种，出生点更靠前 */
  class AppleGuard extends FK.UnitBase {

    /** 身体色比首领浅一档，便于在战场上区分兵种 */
    getBodyColor() {
      return this.getTeamPalette().light;
    }

    /** 装饰：果柄 + 绿叶 + 高光 */
    buildDecor(g, palette) {
      // 圆润苹果：双圆叠合 + 底部微凹
      g.fillStyle(0xDC2626, 1);
      g.fillCircle(-6, 1, 16);
      g.fillCircle(6, 1, 16);
      g.fillEllipse(0, 2, 38, 34);
      g.fillStyle(0xB91C1C, 1);
      g.fillEllipse(0, 18, 12, 5);
      g.lineStyle(3, 0x7F1D1D, 1);
      g.strokeCircle(-6, 1, 16);
      g.strokeCircle(6, 1, 16);
      g.strokeEllipse(0, 2, 38, 34);

      // 右下暗部 + 左上高光（阵营浅色作一层柔光）
      g.fillStyle(0x7F1D1D, 0.4);
      g.fillEllipse(8, 10, 16, 12);
      g.fillStyle(0xFFFFFF, 0.7);
      g.fillEllipse(-8, -5, 10, 14);
      g.fillStyle(palette.light, 0.22);
      g.fillEllipse(-6, -3, 12, 10);

      // 棕色果柄 + 绿叶
      g.lineStyle(3, 0x78350F, 1);
      g.beginPath(); g.moveTo(0, -16); g.lineTo(3, -32); g.strokePath();
      g.fillStyle(0x22C55E, 1);
      g.fillEllipse(10, -26, 16, 8);
      g.lineStyle(2, 0x166534, 1);
      g.strokeEllipse(10, -26, 16, 8);
      g.beginPath(); g.moveTo(4, -26); g.lineTo(16, -26); g.strokePath();

      // 表情：圆眼 + 微笑 + 粉色腮红；叶尖用阵营强调色小点
      g.fillStyle(0xFFFFFF, 1);
      g.fillCircle(-6, -2, 4.2);
      g.fillCircle(6, -2, 4.2);
      g.fillStyle(0x0F172A, 1);
      g.fillCircle(-5.2, -1.2, 2.2);
      g.fillCircle(6.8, -1.2, 2.2);
      g.fillStyle(0xFFFFFF, 1);
      g.fillCircle(-6.6, -3, 1.3);
      g.fillCircle(5.4, -3, 1.3);
      g.fillStyle(0xFB7185, 0.5);
      g.fillCircle(-12, 6, 3.5);
      g.fillCircle(12, 6, 3.5);
      g.lineStyle(2, 0x7F1D1D, 1);
      g.beginPath();
      g.arc(0, 7, 6, 0.15, Math.PI - 0.15, false);
      g.strokePath();
      g.fillStyle(palette.accent, 1);
      g.fillCircle(16, -26, 1.6);
    }
  }

  /** 单位模块工厂（无副作用纯函数，注册时会被调用一次做接口契约校验） */
  FK.ModuleFactories.unit.apple_guard = function createAppleGuardModule() {
    return {
      id: 'apple_guard',
      kind: 'unit',
      displayName: '苹果卫士',

      create: function (scene, config, spawnPoint) {
        return new AppleGuard(scene, config, spawnPoint).create(scene, config, spawnPoint);
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
  FK.UnitClasses.AppleGuard = AppleGuard;
})();
