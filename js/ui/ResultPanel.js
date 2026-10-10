/**
 * ============================================================
 * ResultPanel.js —— 胜负结算界面（第 8 步新增，纯表现层）
 * ============================================================
 * 职责（ui/ = 只渲染 + 只读查询，不改任何玩法数值）：
 *   · 监听 game:victory / game:defeat / game:draw 三个事件
 *   · 弹出**全屏半透明黑**覆盖层（透明度来自 FK.Config.RESULT.overlayAlpha = 0.7）
 *   · 中央显示结果文字：
 *       蓝方获胜 → 「水果王获胜」  红方获胜 → 「酸果军团获胜」  平局 → 「平局」
 *   · 文字下方显示本局总回合数（「共 X 回合」）
 *   · 再下方是「再来一局」按钮：点击后回调 opts.onRestart（重置由 BattleScene 负责）
 *
 * 本文件不认识 TurnManager / UnitBase：重置流程全部在 BattleScene.restartBattle()，
 * 面板只负责「显示结果 + 把点击转成一次回调」。
 *
 * 依赖：FK.Config.RESULT、FK.EVENTS、FK.EventBus、Phaser（缺失时只保留逻辑状态）
 * 对外：FK.ResultPanel
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class ResultPanel {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} [opts]
     *   onRestart  点击「再来一局」时的回调
     *   result     覆盖 FK.Config.RESULT（自检用）
     *   eventBus   事件总线（缺省 FK.EventBus）
     *   autoBuild  是否立即构建（缺省 true）
     */
    constructor(scene, opts) {
      opts = opts || {};
      const R = opts.result || ((FK.Config && FK.Config.RESULT) ? FK.Config.RESULT : {});

      this.scene = scene || null;
      this.eventBus = opts.eventBus || FK.EventBus || null;
      this.onRestart = (typeof opts.onRestart === 'function') ? opts.onRestart : null;

      this.cfg = {
        overlayColor: num(R.overlayColor, 0x000000),
        overlayAlpha: num(R.overlayAlpha, 0.7),
        depth: num(R.depth, 200),
        titleFontSize: num(R.titleFontSize, 64),
        turnFontSize: num(R.turnFontSize, 28),
        buttonW: num(R.buttonW, 260),
        buttonH: num(R.buttonH, 64),
        buttonGapY: num(R.buttonGapY, 56),
        buttonFill: num(R.buttonFill, 0x22C55E),
        buttonFillHover: num(R.buttonFillHover, 0x16A34A),
        buttonBorder: num(R.buttonBorder, 0x064E3B),
        buttonFontSize: num(R.buttonFontSize, 28),
        labels: Object.assign({
          blue: '水果王获胜', red: '酸果军团获胜', draw: '平局',
          turnPrefix: '共 ', turnSuffix: ' 回合', restart: '再来一局',
          title: '返回标题', survivors: '存活 蓝 {blue} / 红 {red}'
        }, R.labels || {}),
        panelW: num(R.panelW, 512),
        panelH: num(R.panelH, 320),
        panelFill: num(R.panelFill, 0x0F172A),
        panelFillAlpha: num(R.panelFillAlpha, 0.94),
        panelBorder: num(R.panelBorder, 0xFDE047),
        fadeInMs: num(R.fadeInMs, 200),
        buttonGapX: num(R.buttonGapX, 16),
        buttonTitleFill: num(R.buttonTitleFill, 0x334155),
        buttonTitleFillHover: num(R.buttonTitleFillHover, 0x475569)
      };

      this.playerTeam = (FK.Config && FK.Config.VICTORY) ? FK.Config.VICTORY.playerTeam : 'blue';
      this.onTitle = (typeof opts.onTitle === 'function') ? opts.onTitle : null;

      /** 状态 */
      this.visible = false;
      this.outcome = '';
      this.winner = '';
      this.title = '';
      this.turnNumber = 0;
      this.buttonHover = false;

      /** 渲染对象 */
      this.overlay = null;
      this.panelGfx = null;
      this.titleText = null;
      this.turnText = null;
      this.survText = null;
      this.buttonBg = null;
      this.buttonText = null;
      this.titleBtnBg = null;
      this.titleBtnText = null;
      this.blueAlive = 0;
      this.redAlive = 0;
      this.titleHover = false;
      this.built = false;

      this.onPointerDownBound = this.onPointerDown.bind(this);
      this.onPointerMoveBound = this.onPointerMove.bind(this);

      this.bindEvents();
      if (opts.autoBuild !== false) { this.build(); }
    }

    /* ==================================================================
     * 事件绑定
     * ================================================================== */

    bindEvents() {
      const E = FK.EVENTS;
      if (this.eventBus && E) {
        if (E.GAME_VICTORY) { this.eventBus.on(E.GAME_VICTORY, this.onResult, this); }
        if (E.GAME_DEFEAT) { this.eventBus.on(E.GAME_DEFEAT, this.onResult, this); }
        if (E.GAME_DRAW) { this.eventBus.on(E.GAME_DRAW, this.onResult, this); }
      }
      const input = this.scene && this.scene.input;
      if (input && typeof input.on === 'function') {
        input.on('pointerdown', this.onPointerDownBound);
        input.on('pointermove', this.onPointerMoveBound);
      }
      return this;
    }

    /** 三个结果事件共用入口（事件名由负载里的字段自行区分） */
    onResult(payload) {
      const p = payload || {};
      if (typeof p.winner === 'string' && p.winner) { return this.show(p.winner, 'victory', p); }
      if (typeof p.loser === 'string' && p.loser) {
        const winner = (p.loser === 'blue') ? 'red' : 'blue';
        return this.show(winner, 'defeat', p);
      }
      return this.show('', 'draw', p);
    }

    /* ==================================================================
     * 构建
     * ================================================================== */

    /** 构建界面（幂等；无 Phaser 渲染管线时只保留逻辑状态） */
    build() {
      if (this.built) { return this; }
      this.built = true;

      const scene = this.scene;
      const canDraw = !!(scene && scene.add && typeof scene.add.graphics === 'function');
      if (!canDraw) { return this; }

      const W = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.width : 1600;
      const H = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.height : 800;
      this.canvasW = W;
      this.canvasH = H;

      // ---- 全屏半透明黑覆盖层 ----
      this.overlay = scene.add.graphics();
      this.overlay.fillStyle(this.cfg.overlayColor, this.cfg.overlayAlpha);
      this.overlay.fillRect(0, 0, W, H);
      this.setDepth(this.overlay, this.cfg.depth);

      this.panelGfx = scene.add.graphics();
      this.setDepth(this.panelGfx, this.cfg.depth + 1);
      this.drawPanel();

      const pr = this.panelRect();
      if (typeof scene.add.text === 'function') {
        this.titleText = scene.add.text(W / 2, pr.y + 58, '', {
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: this.cfg.titleFontSize + 'px',
          fontStyle: 'bold',
          color: '#F8FAFC'
        }).setOrigin(0.5);
        this.setDepth(this.titleText, this.cfg.depth + 2);

        this.turnText = scene.add.text(W / 2, pr.y + 118, '', {
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: this.cfg.turnFontSize + 'px',
          color: '#CBD5E1'
        }).setOrigin(0.5);
        this.setDepth(this.turnText, this.cfg.depth + 2);

        this.survText = scene.add.text(W / 2, pr.y + 152, '', {
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: '18px',
          color: '#94A3B8'
        }).setOrigin(0.5);
        this.setDepth(this.survText, this.cfg.depth + 2);

        this.buttonText = scene.add.text(this.buttonRect().x + this.cfg.buttonW / 2,
          this.buttonRect().y + this.cfg.buttonH / 2, this.cfg.labels.restart, {
            fontFamily: '"Microsoft YaHei", sans-serif',
            fontSize: this.cfg.buttonFontSize + 'px',
            fontStyle: 'bold',
            color: '#052E16'
          }).setOrigin(0.5);
        this.setDepth(this.buttonText, this.cfg.depth + 3);

        this.titleBtnText = scene.add.text(this.titleButtonRect().x + this.cfg.buttonW / 2,
          this.titleButtonRect().y + this.cfg.buttonH / 2, this.cfg.labels.title, {
            fontFamily: '"Microsoft YaHei", sans-serif',
            fontSize: this.cfg.buttonFontSize + 'px',
            fontStyle: 'bold',
            color: '#F8FAFC'
          }).setOrigin(0.5);
        this.setDepth(this.titleBtnText, this.cfg.depth + 3);
      }

      this.buttonBg = scene.add.graphics();
      this.setDepth(this.buttonBg, this.cfg.depth + 2);
      this.titleBtnBg = scene.add.graphics();
      this.setDepth(this.titleBtnBg, this.cfg.depth + 2);
      this.drawButton();

      this.setVisible(false);
      return this;
    }

    setDepth(obj, depth) {
      if (obj && typeof obj.setDepth === 'function') { obj.setDepth(depth); }
      if (obj && typeof obj.setScrollFactor === 'function') { obj.setScrollFactor(0); }
      return obj;
    }

    panelRect() {
      const W = this.canvasW || ((FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.width : 1600);
      const H = this.canvasH || ((FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.height : 800);
      const pw = this.cfg.panelW;
      const ph = this.cfg.panelH;
      return {
        x: Math.round((W - pw) / 2),
        y: Math.round((H - ph) / 2),
        width: pw,
        height: ph
      };
    }

    drawPanel() {
      if (!this.panelGfx || typeof this.panelGfx.clear !== 'function') { return this; }
      const r = this.panelRect();
      this.panelGfx.clear();
      this.panelGfx.fillStyle(this.cfg.panelFill, this.cfg.panelFillAlpha);
      this.panelGfx.fillRoundedRect(r.x, r.y, r.width, r.height, 16);
      this.panelGfx.lineStyle(2, this.cfg.panelBorder, 1);
      this.panelGfx.strokeRoundedRect(r.x, r.y, r.width, r.height, 16);
      return this;
    }

    /** 「再来一局」按钮矩形（世界坐标） */
    buttonRect() {
      const pr = this.panelRect();
      const y = pr.y + pr.height - this.cfg.buttonH - 28;
      return {
        x: pr.x + 36,
        y: y,
        width: this.cfg.buttonW,
        height: this.cfg.buttonH
      };
    }

    titleButtonRect() {
      const pr = this.panelRect();
      const y = pr.y + pr.height - this.cfg.buttonH - 28;
      return {
        x: pr.x + pr.width - 36 - this.cfg.buttonW,
        y: y,
        width: this.cfg.buttonW,
        height: this.cfg.buttonH
      };
    }

    drawButton() {
      const r = this.buttonRect();
      if (this.buttonBg && typeof this.buttonBg.clear === 'function') {
        this.buttonBg.clear();
        this.buttonBg.fillStyle(this.buttonHover ? this.cfg.buttonFillHover : this.cfg.buttonFill, 1);
        this.buttonBg.fillRoundedRect(r.x, r.y, r.width, r.height, 12);
        this.buttonBg.lineStyle(3, this.cfg.buttonBorder, 1);
        this.buttonBg.strokeRoundedRect(r.x, r.y, r.width, r.height, 12);
      }
      const t = this.titleButtonRect();
      if (this.titleBtnBg && typeof this.titleBtnBg.clear === 'function') {
        this.titleBtnBg.clear();
        this.titleBtnBg.fillStyle(this.titleHover ? this.cfg.buttonTitleFillHover : this.cfg.buttonTitleFill, 1);
        this.titleBtnBg.fillRoundedRect(t.x, t.y, t.width, t.height, 12);
        this.titleBtnBg.lineStyle(2, 0x94A3B8, 0.8);
        this.titleBtnBg.strokeRoundedRect(t.x, t.y, t.width, t.height, 12);
      }
      return this;
    }

    /* ==================================================================
     * 显示 / 隐藏
     * ================================================================== */

    /**
     * 显示结算界面
     * @param {string} winner 'blue' | 'red' | ''（平局）
     * @param {string} outcome 'victory' | 'defeat' | 'draw'
     * @param {Object} [payload] 事件负载（读 turnNumber）
     */
    show(winner, outcome, payload) {
      const p = payload || {};
      this.outcome = outcome || 'draw';
      this.winner = winner || '';
      this.title = (this.outcome === 'draw')
        ? this.cfg.labels.draw
        : (this.cfg.labels[this.winner] || this.cfg.labels.blue);
      this.turnNumber = num(p.turnNumber, this.turnNumber);
      this.blueAlive = num(p.blueAlive, this.blueAlive);
      this.redAlive = num(p.redAlive, this.redAlive);
      this.visible = true;

      if (this.titleText) {
        this.titleText.setText(this.title);
        this.titleText.setColor(this.outcome === 'draw' ? '#F8FAFC'
          : (this.winner === 'red' ? '#F87171' : '#60A5FA'));
      }
      if (this.turnText) {
        this.turnText.setText(this.cfg.labels.turnPrefix + this.turnNumber + this.cfg.labels.turnSuffix);
      }
      if (this.survText) {
        const tpl = this.cfg.labels.survivors || '存活 蓝 {blue} / 红 {red}';
        this.survText.setText(tpl.replace('{blue}', String(this.blueAlive)).replace('{red}', String(this.redAlive)));
      }
      if (this.buttonText) { this.buttonText.setText(this.cfg.labels.restart); }
      if (this.titleBtnText) { this.titleBtnText.setText(this.cfg.labels.title); }
      this.setVisible(true);
      this.playFadeIn();
      return this;
    }

    playFadeIn() {
      const scene = this.scene;
      const ms = this.cfg.fadeInMs;
      if (!scene || !scene.tweens || !ms) { return this; }
      const objs = [this.overlay, this.panelGfx, this.titleText, this.turnText, this.survText,
        this.buttonBg, this.buttonText, this.titleBtnBg, this.titleBtnText];
      objs.forEach(function (o) {
        if (o && typeof o.setAlpha === 'function') { o.setAlpha(0); }
      });
      scene.tweens.add({ targets: objs.filter(Boolean), alpha: 1, duration: ms });
      return this;
    }

    hide() {
      this.visible = false;
      this.setVisible(false);
      return this;
    }

    setVisible(v) {
      const show = !!v;
      [this.overlay, this.panelGfx, this.titleText, this.turnText, this.survText,
        this.buttonBg, this.buttonText, this.titleBtnBg, this.titleBtnText].forEach(function (o) {
        if (o && typeof o.setVisible === 'function') { o.setVisible(show); }
      });
      return this;
    }

    /* ==================================================================
     * 输入
     * ================================================================== */

    /** 命中判定：按钮矩形 */
    hitRect(r, worldX, worldY) {
      return worldX >= r.x && worldX <= r.x + r.width &&
        worldY >= r.y && worldY <= r.y + r.height;
    }

    hitButton(worldX, worldY) {
      if (!this.visible) { return false; }
      return this.hitRect(this.buttonRect(), worldX, worldY);
    }

    hitTitleButton(worldX, worldY) {
      if (!this.visible) { return false; }
      return this.hitRect(this.titleButtonRect(), worldX, worldY);
    }

    onPointerDown(pointer) {
      if (!this.visible || !pointer) { return false; }
      const x = num(pointer.x, -1);
      const y = num(pointer.y, -1);
      if (this.hitButton(x, y)) { return this.pressRestart(); }
      if (this.hitTitleButton(x, y)) { return this.pressTitle(); }
      return false;
    }

    onPointerMove(pointer) {
      if (!this.visible || !pointer) { return false; }
      const x = num(pointer.x, -1);
      const y = num(pointer.y, -1);
      const hover = this.hitButton(x, y);
      const tHover = this.hitTitleButton(x, y);
      if (hover === this.buttonHover && tHover === this.titleHover) { return false; }
      this.buttonHover = hover;
      this.titleHover = tHover;
      this.drawButton();
      return true;
    }

    /**
     * 点击「再来一局」：隐藏面板 → 回调场景执行重置
     * @returns {boolean} 是否触发了重置回调
     */
    pressRestart() {
      if (!this.visible) { return false; }
      this.hide();
      if (this.onRestart) {
        this.onRestart();
        return true;
      }
      return false;
    }

    pressTitle() {
      if (!this.visible) { return false; }
      this.hide();
      if (this.onTitle) {
        this.onTitle();
        return true;
      }
      return false;
    }

    /* ==================================================================
     * 查询与清理
     * ================================================================== */

    isVisible() { return this.visible; }

    getOutcome() { return this.outcome; }

    getWinner() { return this.winner; }

    getTitle() { return this.title; }

    getTurnNumber() { return this.turnNumber; }

    getTurnLabel() {
      return this.cfg.labels.turnPrefix + this.turnNumber + this.cfg.labels.turnSuffix;
    }

    getRestartLabel() { return this.cfg.labels.restart; }

    getState() {
      return {
        visible: this.visible,
        outcome: this.outcome,
        winner: this.winner,
        title: this.title,
        turnNumber: this.turnNumber,
        turnLabel: this.getTurnLabel(),
        restartLabel: this.cfg.labels.restart,
        titleLabel: this.cfg.labels.title,
        blueAlive: this.blueAlive,
        redAlive: this.redAlive,
        panel: this.panelRect(),
        button: this.buttonRect(),
        titleButton: this.titleButtonRect()
      };
    }

    destroy() {
      const E = FK.EVENTS;
      if (this.eventBus && E) {
        if (E.GAME_VICTORY) { this.eventBus.off(E.GAME_VICTORY, this.onResult, this); }
        if (E.GAME_DEFEAT) { this.eventBus.off(E.GAME_DEFEAT, this.onResult, this); }
        if (E.GAME_DRAW) { this.eventBus.off(E.GAME_DRAW, this.onResult, this); }
      }
      const input = this.scene && this.scene.input;
      if (input && typeof input.off === 'function') {
        input.off('pointerdown', this.onPointerDownBound);
        input.off('pointermove', this.onPointerMoveBound);
      }
      [this.overlay, this.panelGfx, this.titleText, this.turnText, this.survText,
        this.buttonBg, this.buttonText, this.titleBtnBg, this.titleBtnText].forEach(function (o) {
        if (o && typeof o.destroy === 'function') { o.destroy(); }
      });
      this.overlay = null;
      this.panelGfx = null;
      this.titleText = null;
      this.turnText = null;
      this.survText = null;
      this.buttonBg = null;
      this.buttonText = null;
      this.titleBtnBg = null;
      this.titleBtnText = null;
      this.visible = false;
      this.scene = null;
      return this;
    }
  }

  FK.ResultPanel = ResultPanel;
})();
