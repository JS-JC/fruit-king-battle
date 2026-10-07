/**
 * ============================================================
 * DeathEffect.js —— 死亡占位动画（第 8 步新增，纯表现层）
 * ============================================================
 * 职责（ui/ = 只渲染、不改数值、不参与判定）：
 *   · 落水：单位叠一层**半透明蓝**，整体**缩小至消失**（默认 200ms）
 *   · 血量归零：单位**闪红 2 次**，然后**缩小消失**（默认 400ms）
 *   · 动画结束回调一次，由 BattleScene 负责把单位真正从战场移除
 *
 * 时长 / 颜色 / 缩放倍数 / 闪红次数全部来自 FK.Config.DEATH（不写魔法数字）。
 *
 * 在没有渲染管线（Node 自检 / 无 Phaser）时会**立即完成**并回调，
 * 因此「判定 → 动画 → 移除」这条链路在无头环境下也能被完整验证。
 *
 * 依赖：FK.Config.DEATH、Phaser（场景 add.graphics / tweens，缺失时降级）
 * 对外：FK.DeathEffect
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const REASON = { HP_ZERO: 'hp_zero', DROWNED: 'drowned' };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class DeathEffect {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} [opts]
     *   death        覆盖 FK.Config.DEATH（自检用）
     *   onFinish     动画结束的默认回调（play() 未传 done 时使用）
     *   debug        是否输出调试日志
     */
    constructor(scene, opts) {
      opts = opts || {};
      const D = opts.death || ((FK.Config && FK.Config.DEATH) ? FK.Config.DEATH : {});

      this.scene = scene || null;
      this.D = {
        drownMs: num(D.drownMs, 200),
        drownOverlayAlpha: num(D.drownOverlayAlpha, 0.55),
        drownTint: num(D.drownTint, 0x38BDF8),
        hpZeroMs: num(D.hpZeroMs, 400),
        hpZeroFlashCount: Math.max(1, Math.floor(num(D.hpZeroFlashCount, 2))),
        hpZeroTint: num(D.hpZeroTint, 0xEF4444),
        hpZeroOverlayAlpha: num(D.hpZeroOverlayAlpha, 0.85),
        shrinkScale: num(D.shrinkScale, 0.05),
        overlayRadiusPadPx: num(D.overlayRadiusPadPx, 4)
      };
      this.onFinish = (typeof opts.onFinish === 'function') ? opts.onFinish : null;
      this.debug = (opts.debug === undefined)
        ? !!((FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled))
        : !!opts.debug;

      /** 进行中的动画 { unit, reason, overlay, done, finished } */
      this.active = [];
      this.stats = { played: 0, drowned: 0, hpZero: 0, finished: 0, immediate: 0 };
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /** 占位动画时长（毫秒，全部来自配置） */
    durationFor(reason) {
      return (reason === REASON.DROWNED) ? this.D.drownMs : this.D.hpZeroMs;
    }

    /** 当前单位碰撞半径（画蓝色遮罩用） */
    radiusOf(unit) {
      if (unit && typeof unit.getCollisionRadius === 'function') { return num(unit.getCollisionRadius(), 24); }
      if (unit && typeof unit.getHitRadius === 'function') { return num(unit.getHitRadius(), 24); }
      return 24;
    }

    /** 是否具备播放真实动画的条件 */
    canAnimate(unit) {
      return !!(unit && this.scene && this.scene.tweens && typeof this.scene.tweens.add === 'function');
    }

    isPlaying(unit) {
      return this.active.some(function (e) { return e.unit === unit && !e.finished; });
    }

    getStats() {
      return {
        played: this.stats.played,
        drowned: this.stats.drowned,
        hpZero: this.stats.hpZero,
        finished: this.stats.finished,
        immediate: this.stats.immediate,
        active: this.active.filter(function (e) { return !e.finished; }).length
      };
    }

    /* ==================================================================
     * 播放
     * ================================================================== */

    /**
     * 播放死亡占位动画
     * @param {Object} unit 死亡单位（真实 UnitBase / 鸭子类型）
     * @param {string} reason 'drowned' | 'hp_zero'
     * @param {Function} [done] 动画结束回调（恰好一次）
     * @returns {Object} { reason, durationMs, immediate } 便于自检断言
     */
    play(unit, reason, done) {
      const r = (reason === REASON.DROWNED) ? REASON.DROWNED : REASON.HP_ZERO;
      const durationMs = this.durationFor(r);
      const callback = (typeof done === 'function') ? done : this.onFinish;
      const entry = { unit: unit, reason: r, overlay: null, done: callback, finished: false, durationMs: durationMs };

      const finish = function () {
        if (entry.finished) { return; }
        entry.finished = true;
        entry.overlay = null;
        this.stats.finished += 1;
        if (callback) { callback(unit, r); }
      }.bind(this);

      this.stats.played += 1;
      if (r === REASON.DROWNED) { this.stats.drowned += 1; } else { this.stats.hpZero += 1; }

      if (!this.canAnimate(unit)) {
        // 无渲染管线：立即完成（保证无头环境下链路可验证）
        this.stats.immediate += 1;
        entry.immediate = true;
        finish();
        return { reason: r, durationMs: 0, immediate: true, configuredMs: durationMs };
      }

      entry.immediate = false;
      this.active.push(entry);

      const tweens = this.scene.tweens;
      if (typeof tweens.killTweensOf === 'function') { tweens.killTweensOf(unit); }

      if (r === REASON.DROWNED) {
        // ---- 落水：半透明蓝 + 缩小至消失（一个 tween 同时做淡出与缩小） ----
        this.attachOverlay(entry, this.D.drownTint, this.D.drownOverlayAlpha);
        tweens.add({
          targets: unit,
          alpha: 0,
          scaleX: this.D.shrinkScale,
          scaleY: this.D.shrinkScale,
          duration: durationMs,
          ease: 'Quad.easeIn',
          onComplete: finish
        });
      } else {
        // ---- 血量归零：先闪红 N 次，再缩小消失（两段 tween 串联） ----
        const overlay = this.attachOverlay(entry, this.D.hpZeroTint, 0);
        const flashTotalMs = durationMs / 2;
        const shrinkMs = durationMs - flashTotalMs;
        const perFlashMs = Math.max(30, flashTotalMs / (2 * this.D.hpZeroFlashCount));

        const shrink = function () {
          tweens.add({
            targets: unit,
            alpha: 0,
            scaleX: this.D.shrinkScale,
            scaleY: this.D.shrinkScale,
            duration: shrinkMs,
            ease: 'Quad.easeIn',
            onComplete: finish
          });
        }.bind(this);

        if (overlay) {
          if (typeof overlay.setAlpha === 'function') { overlay.setAlpha(0); }
          tweens.add({
            targets: overlay,
            alpha: { from: 0, to: this.D.hpZeroOverlayAlpha },
            duration: perFlashMs,
            yoyo: true,
            repeat: this.D.hpZeroFlashCount - 1,
            onComplete: shrink
          });
        } else {
          tweens.add({
            targets: unit,
            alpha: 0,
            scaleX: this.D.shrinkScale,
            scaleY: this.D.shrinkScale,
            duration: durationMs,
            ease: 'Quad.easeIn',
            onComplete: finish
          });
        }
      }

      if (this.debug) {
        console.log('[DeathEffect] ' + ((unit && unit.getId) ? unit.getId() : '?') +
          ' 死亡表现：' + r + ' ' + durationMs + 'ms');
      }
      return { reason: r, durationMs: durationMs, immediate: false };
    }

    /**
     * 在单位身上叠一层颜色遮罩（做「半透明蓝 / 闪红」用）
     * 取不到渲染管线时返回 null（动画仍然继续，只是少了颜色层）
     */
    attachOverlay(entry, color, alpha) {
      const unit = entry.unit;
      const scene = this.scene;
      if (!unit || !scene || !scene.add || typeof scene.add.graphics !== 'function') { return null; }
      if (typeof unit.add !== 'function') { return null; }

      try {
        const g = scene.add.graphics();
        g.fillStyle(color, 1);
        g.fillCircle(0, 0, this.radiusOf(unit) + this.D.overlayRadiusPadPx);
        if (typeof g.setAlpha === 'function') { g.setAlpha(num(alpha, 1)); }
        unit.add(g);
        entry.overlay = g;
        return g;
      } catch (e) {
        return null;
      }
    }

    /** 立即结束全部进行中的动画（重开对局 / 场景关闭时用） */
    finishAll() {
      const list = this.active.slice();
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.finished) { continue; }
        if (this.scene && this.scene.tweens && typeof this.scene.tweens.killTweensOf === 'function') {
          this.scene.tweens.killTweensOf(e.unit);
          if (e.overlay) { this.scene.tweens.killTweensOf(e.overlay); }
        }
        e.finished = true;
        this.stats.finished += 1;
        if (e.done) { e.done(e.unit, e.reason); }
      }
      this.active = [];
      return list.length;
    }

    destroy() {
      this.finishAll();
      this.active = [];
      this.scene = null;
      return this;
    }
  }

  DeathEffect.REASON = Object.freeze(Object.assign({}, REASON));

  FK.DeathEffect = DeathEffect;
})();
