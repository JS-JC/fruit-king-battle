/**
 * ============================================================
 * FruitKing.js —— 水果王（菠萝首领 · 单位模块）
 * ============================================================
 * 本模块在第 4 步已实现「实例化 + 视觉 + 选中/悬停 + 血条」：
 *   create(scene, config, spawnPoint)  由 UnitSpawner 调用，生成单位实体
 *   update(unit, dt)                   每帧更新（基类为空实现）
 *   destroy(unit)                      移除单位与其绑定资源
 *
 * 视觉特征（程序化卡通）：
 *   黄橙圆角菠萝身 + 交叉斜纹 + 放射绿叶 + 金色三尖皇冠 + 五官
 *
 * 仍待后续步骤实现：拖拽 / 抛物线 / 投掷（第 5、6 步）
 * 对应 data/units.json 中的 id: "fruit_king"（己方 / blue / hp 100）
 * 依赖：FK.UnitBase
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.unit = FK.ModuleFactories.unit || {};

(function () {
  'use strict';

  /** 水果王：己方首领（MVP 阶段仅皮肤差异，数值与普通单位一致） */
  class FruitKing extends FK.UnitBase {

    /**
     * 装饰：金色三尖皇冠 + 菠萝斜纹
     * 绘制范围限制在 y ∈ [-34, +20]、x ∈ [-22, 22]（见 UnitBase 约定）
     */
    buildDecor(g, palette) {
      // 放射绿叶（先画，被皇冠盖住基部）
      g.fillStyle(0x22C55E, 1);
      g.fillTriangle(-3, -14, -16, -30, 1, -16);
      g.fillTriangle(-2, -14, -8, -32, 2, -16);
      g.fillTriangle(-2, -14, 0, -33, 2, -14);
      g.fillTriangle(-2, -16, 8, -32, 2, -14);
      g.fillTriangle(-1, -16, 16, -30, 3, -14);
      g.lineStyle(2, 0x166534, 1);
      g.beginPath(); g.moveTo(-3, -14); g.lineTo(-16, -30); g.strokePath();
      g.beginPath(); g.moveTo(0, -14); g.lineTo(0, -33); g.strokePath();
      g.beginPath(); g.moveTo(3, -14); g.lineTo(16, -30); g.strokePath();

      // 菠萝身：黄橙圆角矩形
      g.fillStyle(0xF59E0B, 1);
      g.fillRoundedRect(-18, -12, 36, 32, 10);
      g.fillStyle(0xD97706, 0.45);
      g.fillEllipse(6, 8, 22, 16);
      g.fillStyle(0xFFFFFF, 0.28);
      g.fillEllipse(-7, -4, 14, 10);
      g.lineStyle(3, 0x935F07, 1);
      g.strokeRoundedRect(-18, -12, 36, 32, 10);

      // 交叉斜纹（两组平行线）
      g.lineStyle(2, 0xB45309, 0.95);
      g.beginPath(); g.moveTo(-14, -4); g.lineTo(8, 16); g.strokePath();
      g.beginPath(); g.moveTo(-10, -8); g.lineTo(14, 14); g.strokePath();
      g.beginPath(); g.moveTo(-6, -10); g.lineTo(16, 10); g.strokePath();
      g.beginPath(); g.moveTo(12, -6); g.lineTo(-10, 16); g.strokePath();
      g.beginPath(); g.moveTo(16, -2); g.lineTo(-6, 18); g.strokePath();
      g.beginPath(); g.moveTo(8, -10); g.lineTo(-14, 12); g.strokePath();

      // 金色三尖皇冠（中心尖最高）+ 顶面高光；宝石用阵营色
      g.fillStyle(palette.accent, 1);
      g.fillTriangle(-14, -16, -8, -30, -2, -16);
      g.fillTriangle(-6, -16, 0, -34, 6, -16);
      g.fillTriangle(2, -16, 8, -30, 14, -16);
      g.fillRoundedRect(-14, -18, 28, 5, 2);
      g.lineStyle(2, 0x92400E, 1);
      g.strokeRoundedRect(-14, -18, 28, 5, 2);
      g.fillStyle(0xFFFFFF, 0.55);
      g.fillTriangle(-2, -20, 0, -32, 2, -20);
      g.fillStyle(palette.fill, 1);
      g.fillCircle(0, -17, 2);

      // 表情：圆眼 + 高光 + 自信上扬嘴角 + 腮红
      g.fillStyle(0xFFFFFF, 1);
      g.fillCircle(-6, -1, 4.5);
      g.fillCircle(6, -1, 4.5);
      g.fillStyle(0x0F172A, 1);
      g.fillCircle(-5, 0, 2.4);
      g.fillCircle(7, 0, 2.4);
      g.fillStyle(0xFFFFFF, 1);
      g.fillCircle(-6.5, -2, 1.4);
      g.fillCircle(5.5, -2, 1.4);
      g.fillStyle(0xFB7185, 0.45);
      g.fillCircle(-12, 5, 3.2);
      g.fillCircle(12, 5, 3.2);
      g.lineStyle(2, 0x7C2D12, 1);
      g.beginPath();
      g.arc(1, 8, 6, 0.2, Math.PI - 0.05, false);
      g.strokePath();
    }
  }

  /**
   * 单位模块工厂（无副作用纯函数，注册时会被调用一次做接口契约校验）
   */
  FK.ModuleFactories.unit.fruit_king = function createFruitKingModule() {
    return {
      id: 'fruit_king',
      kind: 'unit',
      displayName: '水果王',

      /** @param {Phaser.Scene} scene @param {FK.UnitConfig} config @param {Object} spawnPoint */
      create: function (scene, config, spawnPoint) {
        return new FruitKing(scene, config, spawnPoint).create(scene, config, spawnPoint);
      },

      /** @param {FK.UnitBase} unit @param {number} dt */
      update: function (unit, dt) {
        if (unit && typeof unit.update === 'function') { unit.update(dt); }
      },

      /** @param {FK.UnitBase} unit */
      destroy: function (unit) {
        if (unit && typeof unit.destroy === 'function') { unit.destroy(); }
      }
    };
  };

  /** 类引用（自检与调试用） */
  FK.UnitClasses = FK.UnitClasses || {};
  FK.UnitClasses.FruitKing = FruitKing;
})();
