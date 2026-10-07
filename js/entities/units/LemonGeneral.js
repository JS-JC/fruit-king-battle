/**
 * ============================================================
 * LemonGeneral.js —— 酸柠将军（柠檬首领 · 单位模块）
 * ============================================================
 * 本模块在第 4 步已实现「实例化 + 视觉 + 选中/悬停 + 血条」：
 *   create(scene, config, spawnPoint)  由 UnitSpawner 调用，生成单位实体
 *   update(unit, dt)                   每帧更新（基类为空实现）
 *   destroy(unit)                      移除单位与其绑定资源
 *
 * 视觉特征（程序化卡通）：
 *   黄色椭圆柠檬 + 两端微尖 + 墨镜 + 将星 + 坏笑
 *
 * 仍待后续步骤实现：拖拽 / 抛物线 / 投掷（第 5、6 步）
 * 对应 data/units.json 中的 id: "lemon_general"（敌方 / red / hp 100）
 * 依赖：FK.UnitBase
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.unit = FK.ModuleFactories.unit || {};

(function () {
  'use strict';

  /** 酸柠将军：敌方首领（MVP 阶段仅皮肤差异，数值与普通单位一致） */
  class LemonGeneral extends FK.UnitBase {

    /** 装饰：墨镜 + 柠檬尖角 + 将星 */
    buildDecor(g, palette) {
      // 柠檬身：椭圆 + 两端微尖（尖角不超出 x±22）
      g.fillStyle(0xFACC15, 1);
      g.fillEllipse(0, 1, 38, 30);
      g.fillTriangle(-17, -6, -22, 1, -17, 8);
      g.fillTriangle(17, -6, 22, 1, 17, 8);
      g.fillStyle(0xCA8A04, 0.4);
      g.fillEllipse(7, 8, 18, 12);
      g.fillStyle(0xFFFFFF, 0.28);
      g.fillEllipse(-7, -5, 12, 8);
      g.lineStyle(3, 0x966D0C, 1);
      g.strokeEllipse(0, 1, 38, 30);
      g.beginPath(); g.moveTo(-17, -5); g.lineTo(-22, 1); g.lineTo(-17, 7); g.strokePath();
      g.beginPath(); g.moveTo(17, -5); g.lineTo(22, 1); g.lineTo(17, 7); g.strokePath();

      // 标志小尖角（两侧）
      g.fillStyle(0xEAB308, 1);
      g.fillTriangle(-14, -12, -10, -18, -6, -12);
      g.fillTriangle(14, -12, 10, -18, 6, -12);

      // 墨镜：横跨脸部 + 两侧镜腿
      g.fillStyle(0x0F172A, 0.95);
      g.fillRoundedRect(-16, -10, 32, 11, 3);
      g.fillRect(-22, -6, 7, 3);
      g.fillRect(15, -6, 7, 3);
      g.fillStyle(0x1E293B, 1);
      g.fillRoundedRect(-15, -9, 13, 8, 2);
      g.fillRoundedRect(2, -9, 13, 8, 2);
      g.fillStyle(palette.light, 0.45);
      g.fillRect(-13, -8, 5, 2);
      g.fillRect(4, -8, 5, 2);
      g.fillStyle(0xFFFFFF, 0.35);
      g.fillRect(-12, -7, 3, 1.5);

      // 胸前将星（阵营强调金）
      g.fillStyle(palette.accent, 1);
      g.fillTriangle(0, 7, 5, 16, -5, 16);
      g.fillTriangle(0, 19, 5, 10, -5, 10);
      g.lineStyle(1.5, 0x92400E, 0.9);
      g.strokeCircle(0, 13, 2);

      // 墨镜遮眼；嘴角下撇的坏笑 + 腮红
      g.fillStyle(0xFB7185, 0.4);
      g.fillCircle(-11, 4, 2.8);
      g.fillCircle(11, 4, 2.8);
      g.lineStyle(2, 0x78350F, 1);
      g.beginPath();
      g.moveTo(-7, 12);
      g.lineTo(-2, 10);
      g.lineTo(4, 11);
      g.lineTo(9, 14);
      g.strokePath();
    }
  }

  /** 单位模块工厂（无副作用纯函数，注册时会被调用一次做接口契约校验） */
  FK.ModuleFactories.unit.lemon_general = function createLemonGeneralModule() {
    return {
      id: 'lemon_general',
      kind: 'unit',
      displayName: '酸柠将军',

      create: function (scene, config, spawnPoint) {
        return new LemonGeneral(scene, config, spawnPoint).create(scene, config, spawnPoint);
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
  FK.UnitClasses.LemonGeneral = LemonGeneral;
})();
