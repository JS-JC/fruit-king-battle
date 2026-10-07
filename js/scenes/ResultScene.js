/**
 * ============================================================
 * ResultScene.js —— 结算场景（第 10 步）
 * ============================================================
 * Phaser 场景形态的结算页：512×320 面板、胜负文案、存活统计、
 * 「再战一局 / 返回标题」、200ms 淡入。
 *
 * 战斗内默认仍用 ResultPanel（保证第 8 步自检即时 isVisible）。
 * 本场景供「从标题页完整走完一局」与独立验收使用。
 *
 * 对外：FK.ResultScene
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class ResultScene extends Phaser.Scene {
    constructor() {
      super({ key: 'Result' });
      this.payload = null;
    }

    init(data) {
      this.payload = data || {};
    }

    create() {
      const R = (FK.Config && FK.Config.RESULT) ? FK.Config.RESULT : {};
      const W = FK.Config.CANVAS.width;
      const H = FK.Config.CANVAS.height;
      const pw = num(R.panelW, 512);
      const ph = num(R.panelH, 320);
      const px = Math.round((W - pw) / 2);
      const py = Math.round((H - ph) / 2);
      const fade = num(R.fadeInMs, 200);

      const overlay = this.add.graphics();
      overlay.fillStyle(num(R.overlayColor, 0), num(R.overlayAlpha, 0.7));
      overlay.fillRect(0, 0, W, H);

      const panel = this.add.graphics();
      panel.fillStyle(num(R.panelFill, 0x0F172A), num(R.panelFillAlpha, 0.94));
      panel.fillRoundedRect(px, py, pw, ph, 16);
      panel.lineStyle(2, num(R.panelBorder, 0xFDE047), 1);
      panel.strokeRoundedRect(px, py, pw, ph, 16);

      const labels = Object.assign({
        blue: '水果王获胜', red: '酸果军团获胜', draw: '平局',
        turnPrefix: '共 ', turnSuffix: ' 回合',
        restart: '再来一局', title: '返回标题',
        survivors: '存活 蓝 {blue} / 红 {red}'
      }, R.labels || {});

      const winner = this.payload.winner || '';
      const outcome = this.payload.outcome || (winner ? 'victory' : 'draw');
      const title = outcome === 'draw' ? labels.draw : (labels[winner] || labels.blue);
      const turnNumber = num(this.payload.turnNumber, 1);
      const blueAlive = num(this.payload.blueAlive, 0);
      const redAlive = num(this.payload.redAlive, 0);

      this.add.text(W / 2, py + 56, title, {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: num(R.titleFontSize, 42) + 'px',
        fontStyle: 'bold',
        color: outcome === 'draw' ? '#F8FAFC' : (winner === 'red' ? '#F87171' : '#60A5FA')
      }).setOrigin(0.5);

      this.add.text(W / 2, py + 118, labels.turnPrefix + turnNumber + labels.turnSuffix, {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: num(R.turnFontSize, 22) + 'px',
        color: '#CBD5E1'
      }).setOrigin(0.5);

      const surv = String(labels.survivors)
        .replace('{blue}', String(blueAlive))
        .replace('{red}', String(redAlive));
      this.add.text(W / 2, py + 152, surv, {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '18px',
        color: '#94A3B8'
      }).setOrigin(0.5);

      this.makeButton(W / 2 - num(R.buttonW, 200) - 8, py + ph - 72,
        labels.restart, num(R.buttonFill, 0x22C55E), () => this.scene.start('Battle'));
      this.makeButton(W / 2 + 8, py + ph - 72,
        labels.title, num(R.buttonTitleFill, 0x334155), () => this.scene.start('Boot'));

      this.cameras.main.fadeIn(fade, 0, 0, 0);
    }

    makeButton(x, y, label, fill, onClick) {
      const R = FK.Config.RESULT || {};
      const w = num(R.buttonW, 200);
      const h = num(R.buttonH, 48);
      const g = this.add.graphics();
      g.fillStyle(fill, 1);
      g.fillRoundedRect(x, y, w, h, 12);
      this.add.text(x + w / 2, y + h / 2, label, {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: num(R.buttonFontSize, 22) + 'px',
        fontStyle: 'bold',
        color: '#F8FAFC'
      }).setOrigin(0.5);
      const zone = this.add.zone(x, y, w, h).setOrigin(0).setInteractive();
      zone.on('pointerdown', onClick);
      return zone;
    }
  }

  FK.ResultScene = ResultScene;
})();
