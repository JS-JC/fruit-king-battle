/**
 * ============================================================
 * TimerDisplay.js —— 回合倒计时环 + 数字（第 10 步）
 * ============================================================
 * 职责：右上倒计时数字 + 环形进度；剩余 ≤ warnMs 时数字变红并每秒闪烁。
 * ui/ 只渲染，不改回合状态。
 *
 * 对外：FK.TimerDisplay
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class TimerDisplay {
    constructor(scene, opts) {
      opts = opts || {};
      const HUD = (FK.Config && FK.Config.HUD) ? FK.Config.HUD : {};
      const TURN = (FK.Config && FK.Config.TURN) ? FK.Config.TURN : {};
      const W = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.width : 1600;

      this.scene = scene || null;
      this.cx = num(opts.x, W - num(HUD.timerXOffset, 86));
      this.cy = num(opts.y, num(HUD.timerY, 41));
      this.radius = num(opts.radius, num(HUD.timerRadius, 28));
      this.warnMs = num(opts.warnMs, num(TURN.warnMs, num(HUD.timerWarnMs, 10000)));
      this.depth = num(opts.depth, num(HUD.depth, 60));
      this.remainMs = 30000;
      this.totalMs = 30000;
      this.seconds = 30;
      this.warn = false;
      this.blinkOn = true;
      this.ring = null;
      this.text = null;
      this.built = false;
    }

    build() {
      if (this.built) { return this; }
      this.built = true;
      const scene = this.scene;
      const canDraw = !!(scene && scene.add && typeof scene.add.graphics === 'function');
      if (!canDraw) { return this; }

      this.ring = scene.add.graphics();
      if (typeof this.ring.setDepth === 'function') { this.ring.setDepth(this.depth); }

      if (typeof scene.add.text === 'function') {
        this.text = scene.add.text(this.cx, this.cy, '30s', {
          fontFamily: 'Consolas, monospace',
          fontSize: '22px',
          fontStyle: 'bold',
          color: '#CBD5E1'
        });
        if (this.text.setOrigin) { this.text.setOrigin(0.5); }
        if (this.text.setDepth) { this.text.setDepth(this.depth + 1); }
      }
      this.redraw();
      return this;
    }

    /**
     * @param {number} remainMs
     * @param {number} totalMs
     * @param {number} [secondsLeft]
     */
    set(remainMs, totalMs, secondsLeft) {
      this.remainMs = Math.max(0, num(remainMs, 0));
      this.totalMs = Math.max(1, num(totalMs, 30000));
      const sec = (secondsLeft !== undefined) ? num(secondsLeft, 0)
        : Math.ceil(this.remainMs / 1000);
      this.seconds = Math.max(0, sec);
      this.warn = this.remainMs <= this.warnMs;
      this.blinkOn = !this.warn || (this.seconds % 2 === 0);
      this.redraw();
      return this;
    }

    redraw() {
      const ratio = Math.max(0, Math.min(1, this.remainMs / this.totalMs));
      if (this.ring && typeof this.ring.clear === 'function') {
        this.ring.clear();
        this.ring.lineStyle(6, 0x94A3B8, 0.3);
        this.ring.strokeCircle(this.cx, this.cy, this.radius);
        const color = this.warn ? 0xEF4444 : (ratio > 0.33 ? 0x22C55E : 0xFACC15);
        this.ring.lineStyle(6, color, this.warn && !this.blinkOn ? 0.35 : 1);
        this.ring.beginPath();
        const start = -Math.PI / 2;
        const end = start + Math.PI * 2 * ratio;
        this.ring.arc(this.cx, this.cy, this.radius, start, end, false);
        this.ring.strokePath();
      }
      if (this.text) {
        if (typeof this.text.setText === 'function') { this.text.setText(this.seconds + 's'); }
        if (typeof this.text.setColor === 'function') {
          this.text.setColor(this.warn ? '#EF4444' : '#CBD5E1');
        }
        if (typeof this.text.setAlpha === 'function') {
          this.text.setAlpha(this.warn && !this.blinkOn ? 0.35 : 1);
        }
      }
      return this;
    }

    getState() {
      return {
        remainMs: this.remainMs,
        totalMs: this.totalMs,
        seconds: this.seconds,
        warn: this.warn,
        blinkOn: this.blinkOn,
        ratio: this.remainMs / this.totalMs
      };
    }

    destroy() {
      if (this.ring && this.ring.destroy) { this.ring.destroy(); }
      if (this.text && this.text.destroy) { this.text.destroy(); }
      this.ring = null;
      this.text = null;
      this.scene = null;
    }
  }

  FK.TimerDisplay = TimerDisplay;
})();
