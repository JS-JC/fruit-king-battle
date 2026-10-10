/**
 * ============================================================
 * HUD.js —— 战斗 HUD 总控（第 10 步完整版）
 * ============================================================
 * 顶部回合条、回合计数「N / 40」、提示气泡、倒计时环、底部提示。
 * 力度/角度交给 AimIndicator；倒计时环交给 TimerDisplay。
 *
 * 对外：FK.HUD
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const COLOR = {
    panelBg: 0x1E293B,
    panelBorder: 0x334155,
    label: '#64748B',
    value: '#CBD5E1',
    ok: '#22C55E',
    fail: '#EF4444',
    warn: '#FACC15',
    title: '#F8FAFC',
    step: '#FDE047',
    blue: '#60A5FA',
    red: '#F87171'
  };

  function copyOf() {
    const HUD = (FK.Config && FK.Config.HUD) ? FK.Config.HUD : {};
    return Object.assign({
      allyAct: '你的回合（蓝色方可操作）',
      enemyAct: '敌方回合（红色方 AI）',
      turnOf: '第 {n} 回合',
      turnCap: '回合 {n} / {max}',
      aiThinking: '敌方思考中…'
    }, HUD.copy || {});
  }

  function fmt(tpl, map) {
    let s = String(tpl || '');
    Object.keys(map || {}).forEach(function (k) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(map[k]));
    });
    return s;
  }

  class HUD {
    constructor(scene, opts) {
      opts = opts || {};
      this.scene = scene;
      this.copy = copyOf();
      this.playerTeam = (FK.Config && FK.Config.VICTORY) ? FK.Config.VICTORY.playerTeam : 'blue';
      this.maxTurns = (FK.Config && FK.Config.TURN) ? FK.Config.TURN.maxTurns : 40;
      const HUDC = (FK.Config && FK.Config.HUD) ? FK.Config.HUD : {};
      this.depth = HUDC.depth || 60;

      /** 与旧 BattleScene.hud 兼容的引用袋 */
      this.refs = {
        turnText: null,
        stateText: null,
        teamText: null,
        timeText: null,
        barBg: null,
        barFill: null,
        toastBg: null,
        toastText: null,
        titleText: null,
        selectedText: null,
        infoText: null,
        hintText: null,
        fpsText: null
      };
      this.timer = null;
      this.aim = null;
      this.toastContainer = null;
      this.disposables = [];
    }

    build(layout) {
      layout = layout || {};
      this.buildTop();
      this.buildInfoRow();
      this.buildBottom(layout.panelX || 80, layout.panelW || 1060);
      this.timer = new FK.TimerDisplay(this.scene, { depth: this.depth });
      this.timer.build();
      this.aim = new FK.AimIndicator(this.scene, { x: 100, y: 732, depth: 48 });
      this.aim.build();
      this.pinToCamera();
      this.applyDebugVisibility();
      return this;
    }

    pinToCamera() {
      const pin = function (o) {
        if (o && typeof o.setScrollFactor === 'function') { o.setScrollFactor(0); }
      };
      (this.disposables || []).forEach(pin);
      pin(this.toastContainer);
      if (this.timer && this.timer.disposables) { this.timer.disposables.forEach(pin); }
      if (this.aim && this.aim.disposables) { this.aim.disposables.forEach(pin); }
      const h = this.refs || {};
      Object.keys(h).forEach(function (k) { pin(h[k]); });
      return this;
    }

    buildTop() {
      const scene = this.scene;
      const W = FK.Config.CANVAS.width;
      const h = this.refs;
      const bar = scene.add.graphics().setDepth(this.depth);
      bar.fillStyle(COLOR.panelBg, 0.94);
      bar.fillRoundedRect(16, 8, W - 32, 66, 12);
      bar.lineStyle(2, COLOR.panelBorder, 1);
      bar.strokeRoundedRect(16, 8, W - 32, 66, 12);
      this.disposables.push(bar);

      h.turnText = scene.add.text(48, 18, fmt(this.copy.turnCap, { n: 1, max: this.maxTurns }), {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '20px', fontStyle: 'bold', color: COLOR.title
      }).setDepth(this.depth);

      h.stateText = scene.add.text(48, 48, '状态：IDLE', {
        fontFamily: 'Consolas, monospace', fontSize: '14px', color: COLOR.label
      }).setDepth(this.depth);

      h.teamText = scene.add.text(W / 2, 22, fmt(this.copy.turnOf, { n: 1 }) + ' · ' + this.copy.allyAct, {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '26px', fontStyle: 'bold', color: COLOR.blue
      });
      if (h.teamText.setOrigin) { h.teamText.setOrigin(0.5, 0); }
      if (h.teamText.setDepth) { h.teamText.setDepth(this.depth); }

      // 旧线性进度条保留为隐藏兼容（倒计时改走环形 TimerDisplay）
      h.timeText = null;
      h.barBg = scene.add.graphics().setDepth(this.depth).setVisible(false);
      h.barFill = scene.add.graphics().setDepth(this.depth).setVisible(false);

      h.toastBg = scene.add.graphics();
      h.toastBg.fillStyle(0x0F172A, 0.94);
      h.toastBg.fillRoundedRect(-210, -28, 420, 56, 14);
      h.toastBg.lineStyle(3, 0xFDE047, 1);
      h.toastBg.strokeRoundedRect(-210, -28, 420, 56, 14);
      h.toastText = scene.add.text(0, 0, '', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '32px', fontStyle: 'bold', color: COLOR.step
      }).setOrigin(0.5);
      this.toastContainer = (typeof scene.add.container === 'function')
        ? scene.add.container(W / 2, 160, [h.toastBg, h.toastText])
        : { setAlpha: function () { return this; }, setScale: function () { return this; }, setDepth: function () { return this; } };
      if (this.toastContainer.setAlpha) { this.toastContainer.setAlpha(0); }
      if (this.toastContainer.setDepth) { this.toastContainer.setDepth(50); }
      this.disposables.push(this.toastContainer, h.toastBg, h.toastText,
        h.turnText, h.stateText, h.teamText, h.barBg, h.barFill);
    }

    buildInfoRow() {
      const scene = this.scene;
      const W = FK.Config.CANVAS.width;
      const h = this.refs;
      h.titleText = scene.add.text(48, 82,
        FK.Config.GAME_TITLE + ' v' + FK.Config.VERSION + ' · ' + FK.Config.STEP_LABEL, {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '15px', color: COLOR.step
        }).setDepth(this.depth);
      h.selectedText = scene.add.text(W / 2, 80, '选中：未选择', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '18px', fontStyle: 'bold', color: COLOR.value
      }).setOrigin(0.5, 0).setDepth(this.depth);
      h.infoText = scene.add.text(W - 40, 83, '', {
        fontFamily: 'Consolas, "Microsoft YaHei", monospace', fontSize: '14px', color: COLOR.label
      }).setOrigin(1, 0).setDepth(this.depth);
      this.disposables.push(h.titleText, h.selectedText, h.infoText);
    }

    buildBottom(panelX, panelW) {
      const scene = this.scene;
      const h = this.refs;
      const panelY = 692;
      const panelH = 56;
      const g = scene.add.graphics().setDepth(48);
      g.fillStyle(COLOR.panelBg, 0.9);
      g.fillRoundedRect(panelX, panelY, panelW, panelH, 12);
      g.lineStyle(2, COLOR.panelBorder, 1);
      g.strokeRoundedRect(panelX, panelY, panelW, panelH, 12);
      this.disposables.push(g);

      h.hintText = scene.add.text(panelX + 20, panelY + 8,
        '悬停高亮 · 点击选中 · 拖拽瞄准 · 第 5 格移动 · 香蕉弹飞行中左键引爆 · 拖回 / 右键 / ESC 取消', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '14px', color: COLOR.label
        }).setOrigin(0, 0).setDepth(48);
      h.fpsText = scene.add.text(panelX + 20, panelY + 32, 'FPS --', {
        fontFamily: 'Consolas, monospace', fontSize: '13px', color: COLOR.ok
      }).setOrigin(0, 0).setDepth(48);
      this.disposables.push(h.hintText, h.fpsText);
    }

    applyDebugVisibility() {
      const dbg = !!(FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled);
      const fps = dbg && FK.Config.DEBUG.showFps !== false;
      const h = this.refs;
      if (h.stateText && h.stateText.setVisible) { h.stateText.setVisible(dbg); }
      if (h.titleText && h.titleText.setVisible) { h.titleText.setVisible(dbg); }
      if (h.infoText && h.infoText.setVisible) { h.infoText.setVisible(dbg); }
      if (h.fpsText && h.fpsText.setVisible) { h.fpsText.setVisible(fps); }
      if (h.hintText && h.hintText.setVisible) { h.hintText.setVisible(dbg); }
      return this;
    }

    setTurn(team, turnNumber, stateName) {
      const n = turnNumber || 1;
      const max = this.maxTurns;
      const ally = team === this.playerTeam;
      const act = ally ? this.copy.allyAct : this.copy.enemyAct;
      const color = team === 'red' ? COLOR.red : COLOR.blue;
      if (this.refs.turnText) {
        this.refs.turnText.setText(fmt(this.copy.turnCap, { n: n, max: max }));
      }
      if (this.refs.teamText) {
        this.refs.teamText.setText(fmt(this.copy.turnOf, { n: n }) + ' · ' + act);
        this.refs.teamText.setColor(color);
      }
      if (stateName && this.refs.stateText) {
        this.refs.stateText.setText('状态：' + stateName);
      }
      return this;
    }

    updateTimer(remainMs, totalMs, seconds) {
      if (this.timer) { this.timer.set(remainMs, totalMs, seconds); }
      return this;
    }

    showToast(text, color) {
      const c = this.toastContainer;
      if (!c || !this.scene || !this.scene.tweens) { return this; }
      this.refs.toastText.setText(text);
      this.refs.toastText.setColor(color || COLOR.step);
      this.refs.toastText.setFontSize(30);
      this.scene.tweens.killTweensOf(c);
      c.setAlpha(0).setScale(0.9);
      const tw = this.scene.tweens;
      tw.add({
        targets: c, alpha: 1, scale: 1, duration: 160, ease: 'Back.easeOut',
        onComplete: function () { tw.add({ targets: c, alpha: 0, duration: 400, delay: 700 }); }
      });
      return this;
    }

    flashToast(text, color) {
      const c = this.toastContainer;
      if (!c || !this.scene || !this.scene.tweens) { return this; }
      this.refs.toastText.setText(text);
      this.refs.toastText.setColor(color || COLOR.fail);
      this.scene.tweens.killTweensOf(c);
      c.setAlpha(1).setScale(1.05);
      this.scene.tweens.add({ targets: c, alpha: 0, duration: 700, delay: 500 });
      return this;
    }

    static COPY() { return copyOf(); }

    destroy() {
      if (this.timer) { this.timer.destroy(); this.timer = null; }
      if (this.aim) { this.aim.destroy(); this.aim = null; }
      this.disposables.forEach(function (d) {
        if (d && d.destroy) { d.destroy(); }
      });
      this.disposables.length = 0;
    }
  }

  HUD.COPY = copyOf;
  FK.HUD = HUD;
})();
