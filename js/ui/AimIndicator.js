/**
 * ============================================================
 * AimIndicator.js —— 力度条 + 角度文本（第 10 步）
 * ============================================================
 * 轨迹点列与落点圈仍由 TrajectoryRenderer / MoveRenderer 绘制。
 * 本组件只负责底部力度条（绿→黄→红）与角度数字。
 *
 * 对外：FK.AimIndicator
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class AimIndicator {
    constructor(scene, opts) {
      opts = opts || {};
      const HUD = (FK.Config && FK.Config.HUD) ? FK.Config.HUD : {};
      this.scene = scene || null;
      this.x = num(opts.x, 80);
      this.y = num(opts.y, 724);
      this.barW = num(opts.barW, num(HUD.powerBarW, 200));
      this.barH = num(opts.barH, num(HUD.powerBarH, 18));
      this.depth = num(opts.depth, 48);
      this.visible = false;
      this.powerRatio = 0;
      this.angleDeg = 0;
      this.bg = null;
      this.fill = null;
      this.label = null;
      this.built = false;
    }

    build() {
      if (this.built) { return this; }
      this.built = true;
      const scene = this.scene;
      if (!(scene && scene.add && typeof scene.add.graphics === 'function')) { return this; }

      this.bg = scene.add.graphics();
      this.fill = scene.add.graphics();
      if (this.bg.setDepth) { this.bg.setDepth(this.depth); }
      if (this.fill.setDepth) { this.fill.setDepth(this.depth + 1); }

      if (typeof scene.add.text === 'function') {
        this.label = scene.add.text(this.x + this.barW + 12, this.y - 2, '', {
          fontFamily: '"Microsoft YaHei", Consolas, sans-serif',
          fontSize: '16px',
          color: '#FDE047'
        });
        if (this.label.setDepth) { this.label.setDepth(this.depth + 1); }
      }
      this.setVisible(false);
      return this;
    }

    /**
     * @param {Object|null} state { powerRatio, angleDeg }；null = 隐藏
     */
    sync(state) {
      if (!state || typeof state.powerRatio !== 'number') {
        this.visible = false;
        this.setVisible(false);
        return this;
      }
      this.visible = true;
      this.powerRatio = Math.max(0, Math.min(1, state.powerRatio));
      this.angleDeg = num(state.angleDeg, 0);
      this.redraw();
      this.setVisible(true);
      return this;
    }

    redraw() {
      const x = this.x;
      const y = this.y;
      const w = this.barW;
      const h = this.barH;
      const p = this.powerRatio;
      if (this.bg && this.bg.clear) {
        this.bg.clear();
        this.bg.fillStyle(0x1E293B, 0.92);
        this.bg.fillRoundedRect(x, y, w, h, 6);
        this.bg.lineStyle(2, 0x334155, 1);
        this.bg.strokeRoundedRect(x, y, w, h, 6);
      }
      if (this.fill && this.fill.clear) {
        this.fill.clear();
        const color = p < 0.4 ? 0x22C55E : (p < 0.75 ? 0xFACC15 : 0xEF4444);
        this.fill.fillStyle(color, 1);
        this.fill.fillRoundedRect(x + 2, y + 2, Math.max(2, (w - 4) * p), h - 4, 4);
      }
      if (this.label && this.label.setText) {
        this.label.setText('力度 ' + Math.round(p * 100) + '%  ·  角度 ' + Math.round(this.angleDeg) + '°');
      }
      return this;
    }

    setVisible(v) {
      const show = !!v;
      [this.bg, this.fill, this.label].forEach(function (o) {
        if (o && typeof o.setVisible === 'function') { o.setVisible(show); }
      });
      return this;
    }

    getState() {
      return { visible: this.visible, powerRatio: this.powerRatio, angleDeg: this.angleDeg };
    }

    destroy() {
      [this.bg, this.fill, this.label].forEach(function (o) {
        if (o && o.destroy) { o.destroy(); }
      });
      this.bg = this.fill = this.label = null;
      this.scene = null;
    }
  }

  FK.AimIndicator = AimIndicator;
})();
