/**
 * ============================================================
 * PlacementPreview.js —— 放置预览视觉（第 7.5 步新增）
 * ============================================================
 * 职责：
 *   把 PlacementController 算出来的「放置预览状态」画出来，只做渲染：
 *     · 鼠标位置显示半透明木箱轮廓（跟随指针）
 *     · 合法 → 绿色；非法 → 红色 + 一个 ✗
 *     · 从箱底到落点画一条竖直虚线，让玩家看清会掉到哪一层
 *     · 下落过程中由同一套轮廓跟随箱体下落（placement:complete 前）
 *     · 顺便把鼠标光标切成 crosshair / not-allowed，形成「鼠标变叉」的反馈
 *
 * 分层纪律（见 README 分层规则）：
 *   ui/ 只画不判：任何合法性都由 PlacementController 决定，
 *   本类拿到的 state 里已经带好了 valid / reason，不再自己算物理。
 *
 * 依赖：Phaser（Graphics）、FK.Config.OBSTACLE
 * 对外：FK.PlacementPreview
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 配色：合法绿 / 非法红 */
  const COLOR = {
    valid: { fill: 0x22C55E, line: 0x4ADE80, guide: 0x86EFAC },
    invalid: { fill: 0xEF4444, line: 0xF87171, guide: 0xFCA5A5 },
    boxTop: 0xD97706,
    boxSlat: 0x92400E
  };

  /** 光标形状（真实 DOM 光标由 Phaser 的 setDefaultCursor 设置） */
  const CURSOR = {
    idle: 'default',
    valid: 'crosshair',          // 合法：十字（准星）
    invalid: 'not-allowed'       // 非法：禁止符号（配合画出来的 ✗）
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class PlacementPreview {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} [opts]
     *   depth      渲染深度（缺省 FK.Config.OBSTACLE.depth，略高于障碍物自身）
     *   alpha      填充透明度（缺省 FK.Config.OBSTACLE.previewAlpha）
     *   lineWidth  描边宽度（缺省 FK.Config.OBSTACLE.previewLineWidth）
     *   cornerRadiusPx 圆角（缺省 FK.Config.OBSTACLE.cornerRadiusPx）
     */
    constructor(scene, opts) {
      opts = opts || {};
      const O = (FK.Config && FK.Config.OBSTACLE) ? FK.Config.OBSTACLE : {};

      this.scene = scene || null;
      this.depth = num(opts.depth, num(O.depth, 8) + 1);
      this.alpha = num(opts.alpha, num(O.previewAlpha, 0.28));
      this.lineWidth = num(opts.lineWidth, num(O.previewLineWidth, 3));
      this.cornerRadiusPx = num(opts.cornerRadiusPx, num(O.cornerRadiusPx, 6));

      /** 绘制对象（无渲染管线时为 null，逻辑依然可测） */
      this.gfx = null;
      this.guideGfx = null;
      this.build();

      /** 最近一次渲染的状态（调试 / 自检 / 浏览器验证用） */
      this.lastRender = {
        visible: false,
        mode: 'idle',              // 'idle' | 'preview' | 'falling'
        valid: false,
        reason: '',
        outcome: '',
        x: 0, y: 0,
        sizePx: 0,
        color: 'none',             // 'valid' | 'invalid' | 'none'
        cross: false,              // 是否画了 ✗
        guide: false,
        cursor: CURSOR.idle
      };
    }

    /* ==================================================================
     * 构建与销毁
     * ================================================================== */

    build() {
      const canDraw = !!(this.scene && this.scene.add &&
        typeof this.scene.add.graphics === 'function');
      if (!canDraw) { return this; }

      this.guideGfx = this.scene.add.graphics();
      this.gfx = this.scene.add.graphics();
      if (typeof this.guideGfx.setDepth === 'function') { this.guideGfx.setDepth(this.depth - 1); }
      if (typeof this.gfx.setDepth === 'function') { this.gfx.setDepth(this.depth); }
      return this;
    }

    /* ==================================================================
     * 渲染
     * ================================================================== */

    /**
     * 渲染一帧放置预览
     * @param {Object} state PlacementController.getState() 的结果
     *   { x, y, sizePx, valid, reason, outcome, surfaceY, falling }
     */
    render(state) {
      const s = state || {};
      const sizePx = num(s.sizePx, 0);
      const x = num(s.x, 0);
      const y = num(s.y, 0);
      const valid = !!s.valid;
      const palette = valid ? COLOR.valid : COLOR.invalid;
      // 「会掉进果汁池」属于合法操作，但结果是被销毁：用合法色 + 虚线提示，
      // 避免玩家以为「红色 = 不能点」而误解规则。
      const falling = !!s.falling;

      this.lastRender.visible = true;
      this.lastRender.mode = falling ? 'falling' : 'preview';
      this.lastRender.valid = valid;
      this.lastRender.reason = s.reason || '';
      this.lastRender.outcome = s.outcome || '';
      this.lastRender.x = x;
      this.lastRender.y = y;
      this.lastRender.sizePx = sizePx;
      this.lastRender.color = valid ? 'valid' : 'invalid';
      this.lastRender.cross = !valid;
      this.lastRender.guide = !falling && typeof s.surfaceY === 'number';
      this.lastRender.cursor = valid ? CURSOR.valid : CURSOR.invalid;

      this.setCursor(this.lastRender.cursor);
      if (!this.gfx) { return this; }

      const half = sizePx / 2;
      const left = x - half;
      const top = y - half;
      const r = this.cornerRadiusPx;

      // ---- 引导虚线：从箱底竖直指到落点 ----
      if (this.guideGfx) {
        this.guideGfx.clear();
        if (this.lastRender.guide && s.surfaceY > y + half) {
          this.guideGfx.lineStyle(2, palette.guide, 0.55);
          const from = y + half;
          const to = num(s.surfaceY, from);
          for (let seg = from; seg < to; seg += 14) {
            this.guideGfx.beginPath();
            this.guideGfx.moveTo(x, seg);
            this.guideGfx.lineTo(x, Math.min(seg + 7, to));
            this.guideGfx.strokePath();
          }
        }
      }

      // ---- 木箱轮廓（半透明填充 + 描边 + 顶面高光） ----
      const g = this.gfx;
      g.clear();
      g.fillStyle(palette.fill, this.alpha);
      g.fillRoundedRect(left, top, sizePx, sizePx, r);
      g.fillStyle(COLOR.boxTop, Math.min(0.5, this.alpha + 0.15));
      g.fillRoundedRect(left, top, sizePx, Math.max(3, sizePx * 0.22), r);
      g.lineStyle(this.lineWidth, palette.line, 0.95);
      g.strokeRoundedRect(left, top, sizePx, sizePx, r);

      // ---- 非法：在箱子中间画一个 ✗ ----
      if (!valid) {
        const c = 12;
        g.lineStyle(Math.max(3, this.lineWidth), palette.line, 1);
        g.beginPath();
        g.moveTo(x - c, y - c);
        g.lineTo(x + c, y + c);
        g.moveTo(x + c, y - c);
        g.lineTo(x - c, y + c);
        g.strokePath();
      }
      return this;
    }

    /** 隐藏预览并恢复默认光标 */
    hide() {
      if (this.gfx) { this.gfx.clear(); }
      if (this.guideGfx) { this.guideGfx.clear(); }
      this.lastRender.visible = false;
      this.lastRender.cross = false;
      this.lastRender.guide = false;
      this.lastRender.color = 'none';
      this.lastRender.mode = 'idle';
      this.setCursor(CURSOR.idle);
      return this;
    }

    /** 切换鼠标光标形状（真实 DOM 光标；无输入系统时静默忽略） */
    setCursor(cursor) {
      const input = this.scene && this.scene.input;
      if (input && typeof input.setDefaultCursor === 'function') {
        try { input.setDefaultCursor(cursor); } catch (e) { /* 忽略：光标只是表现 */ }
      }
      return this;
    }

    /** 当前是否可见 */
    isVisible() { return this.lastRender.visible; }

    /** 调试 / 自检快照 */
    getInfo() {
      return Object.assign({}, this.lastRender);
    }

    destroy() {
      if (this.gfx && typeof this.gfx.destroy === 'function') { this.gfx.destroy(); }
      if (this.guideGfx && typeof this.guideGfx.destroy === 'function') { this.guideGfx.destroy(); }
      this.gfx = null;
      this.guideGfx = null;
      this.scene = null;
    }
  }

  PlacementPreview.COLOR = Object.freeze(COLOR);
  PlacementPreview.CURSOR = Object.freeze(CURSOR);

  FK.PlacementPreview = PlacementPreview;
})();
