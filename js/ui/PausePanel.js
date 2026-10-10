/**
 * ============================================================
 * PausePanel.js —— 暂停界面
 * ============================================================
 * 全屏压暗 + 中央面板：继续 / 音效 / 音乐 / 返回标题。
 * ui/ 只渲染与点击回调，不改玩法数值。
 * 对外：FK.PausePanel
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function hit(rect, x, y) {
    if (!rect) { return false; }
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  class PausePanel {
    constructor(scene, opts) {
      opts = opts || {};
      this.scene = scene || null;
      this.onResume = (typeof opts.onResume === 'function') ? opts.onResume : null;
      this.onTitle = (typeof opts.onTitle === 'function') ? opts.onTitle : null;
      this.onSfx = (typeof opts.onSfx === 'function') ? opts.onSfx : null;
      this.onMusic = (typeof opts.onMusic === 'function') ? opts.onMusic : null;

      const W = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.width : 1600;
      const H = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.height : 800;
      this.canvasW = W;
      this.canvasH = H;
      this.depth = 190;

      this.visible = false;
      this.hover = '';
      this.built = false;
      this.sfxOn = true;
      this.musicOn = true;

      this.overlay = null;
      this.panelGfx = null;
      this.titleText = null;
      this.hintText = null;
      this.resumeText = null;
      this.titleBtnText = null;
      this.sfxLabel = null;
      this.sfxValue = null;
      this.musicLabel = null;
      this.musicValue = null;
      this.buttonGfx = null;

      this.onPointerDownBound = this.onPointerDown.bind(this);
      this.onPointerMoveBound = this.onPointerMove.bind(this);

      if (opts.autoBuild !== false) { this.build(); }
    }

    build() {
      if (this.built) { return this; }
      this.built = true;
      const scene = this.scene;
      if (!scene || !scene.add || typeof scene.add.graphics !== 'function') { return this; }

      const W = this.canvasW;
      const H = this.canvasH;
      const d = this.depth;

      this.overlay = scene.add.graphics();
      this.overlay.fillStyle(0x020617, 0.62);
      this.overlay.fillRect(0, 0, W, H);
      this.pin(this.overlay, d);

      this.panelGfx = scene.add.graphics();
      this.pin(this.panelGfx, d + 1);
      this.buttonGfx = scene.add.graphics();
      this.pin(this.buttonGfx, d + 2);

      if (typeof scene.add.text === 'function') {
        this.titleText = scene.add.text(W / 2, 0, '暂停', {
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: '42px',
          fontStyle: 'bold',
          color: '#F8FAFC'
        }).setOrigin(0.5);
        this.pin(this.titleText, d + 3);

        this.hintText = scene.add.text(W / 2, 0, 'Esc 也可继续', {
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: '16px',
          color: '#94A3B8'
        }).setOrigin(0.5);
        this.pin(this.hintText, d + 3);

        this.sfxLabel = scene.add.text(0, 0, '音效', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '22px', color: '#E2E8F0'
        }).setOrigin(0, 0.5);
        this.sfxValue = scene.add.text(0, 0, '开', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '20px', fontStyle: 'bold', color: '#052E16'
        }).setOrigin(0.5);
        this.musicLabel = scene.add.text(0, 0, '音乐（暂无）', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '22px', color: '#E2E8F0'
        }).setOrigin(0, 0.5);
        this.musicValue = scene.add.text(0, 0, '开', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '20px', fontStyle: 'bold', color: '#052E16'
        }).setOrigin(0.5);
        this.resumeText = scene.add.text(0, 0, '继续游戏', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '26px', fontStyle: 'bold', color: '#052E16'
        }).setOrigin(0.5);
        this.titleBtnText = scene.add.text(0, 0, '返回标题', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '24px', fontStyle: 'bold', color: '#F8FAFC'
        }).setOrigin(0.5);
        this.pin(this.sfxLabel, d + 3);
        this.pin(this.sfxValue, d + 3);
        this.pin(this.musicLabel, d + 3);
        this.pin(this.musicValue, d + 3);
        this.pin(this.resumeText, d + 3);
        this.pin(this.titleBtnText, d + 3);
      }

      const input = scene.input;
      if (input && typeof input.on === 'function') {
        input.on('pointerdown', this.onPointerDownBound);
        input.on('pointermove', this.onPointerMoveBound);
      }

      this.layout();
      this.setVisible(false);
      return this;
    }

    pin(obj, depth) {
      if (!obj) { return obj; }
      if (typeof obj.setDepth === 'function') { obj.setDepth(depth); }
      if (typeof obj.setScrollFactor === 'function') { obj.setScrollFactor(0); }
      return obj;
    }

    panelRect() {
      const pw = 460;
      const ph = 420;
      return {
        x: Math.round((this.canvasW - pw) / 2),
        y: Math.round((this.canvasH - ph) / 2),
        width: pw,
        height: ph
      };
    }

    resumeRect() {
      const p = this.panelRect();
      return { x: p.x + 50, y: p.y + 118, width: p.width - 100, height: 56 };
    }

    sfxRect() {
      const p = this.panelRect();
      return { x: p.x + 50, y: p.y + 194, width: p.width - 100, height: 52 };
    }

    musicRect() {
      const p = this.panelRect();
      return { x: p.x + 50, y: p.y + 256, width: p.width - 100, height: 52 };
    }

    titleRect() {
      const p = this.panelRect();
      return { x: p.x + 50, y: p.y + 328, width: p.width - 100, height: 52 };
    }

    toggleKnob(row) {
      return { x: row.x + row.width - 92, y: row.y + 8, width: 80, height: row.height - 16 };
    }

    layout() {
      const p = this.panelRect();
      if (this.panelGfx) {
        this.panelGfx.clear();
        this.panelGfx.fillStyle(0x0F172A, 0.96);
        this.panelGfx.fillRoundedRect(p.x, p.y, p.width, p.height, 18);
        this.panelGfx.lineStyle(2, 0xFDE047, 1);
        this.panelGfx.strokeRoundedRect(p.x, p.y, p.width, p.height, 18);
      }
      if (this.titleText) { this.titleText.setPosition(this.canvasW / 2, p.y + 48); }
      if (this.hintText) { this.hintText.setPosition(this.canvasW / 2, p.y + 86); }
      this.redrawButtons();
      return this;
    }

    redrawButtons() {
      const g = this.buttonGfx;
      if (!g) { return this; }
      g.clear();
      const resume = this.resumeRect();
      const sfx = this.sfxRect();
      const music = this.musicRect();
      const title = this.titleRect();
      const sfxK = this.toggleKnob(sfx);
      const musK = this.toggleKnob(music);

      this.roundBtn(g, resume, this.hover === 'resume' ? 0xFACC15 : 0xFDE047, 0x854D0E);
      this.roundBtn(g, sfx, 0x1E293B, this.hover === 'sfx' ? 0x93C5FD : 0x334155);
      this.roundBtn(g, music, 0x1E293B, this.hover === 'music' ? 0x93C5FD : 0x334155);
      this.roundBtn(g, title, this.hover === 'title' ? 0x475569 : 0x334155, 0x1E293B);

      this.roundBtn(g, sfxK, this.sfxOn ? 0x4ADE80 : 0x64748B, this.sfxOn ? 0x166534 : 0x334155);
      this.roundBtn(g, musK, this.musicOn ? 0x4ADE80 : 0x64748B, this.musicOn ? 0x166534 : 0x334155);

      if (this.resumeText) {
        this.resumeText.setPosition(resume.x + resume.width / 2, resume.y + resume.height / 2);
      }
      if (this.titleBtnText) {
        this.titleBtnText.setPosition(title.x + title.width / 2, title.y + title.height / 2);
      }
      if (this.sfxLabel) { this.sfxLabel.setPosition(sfx.x + 22, sfx.y + sfx.height / 2); }
      if (this.musicLabel) { this.musicLabel.setPosition(music.x + 22, music.y + music.height / 2); }
      if (this.sfxValue) {
        this.sfxValue.setText(this.sfxOn ? '开' : '关');
        this.sfxValue.setColor(this.sfxOn ? '#052E16' : '#F8FAFC');
        this.sfxValue.setPosition(sfxK.x + sfxK.width / 2, sfxK.y + sfxK.height / 2);
      }
      if (this.musicValue) {
        this.musicValue.setText(this.musicOn ? '开' : '关');
        this.musicValue.setColor(this.musicOn ? '#052E16' : '#F8FAFC');
        this.musicValue.setPosition(musK.x + musK.width / 2, musK.y + musK.height / 2);
      }
      return this;
    }

    roundBtn(g, r, fill, border) {
      g.fillStyle(fill, 1);
      g.fillRoundedRect(r.x, r.y, r.width, r.height, 12);
      g.lineStyle(2, border, 1);
      g.strokeRoundedRect(r.x, r.y, r.width, r.height, 12);
    }

    syncAudio() {
      const S = FK.SoundSystem;
      this.sfxOn = !(S && typeof S.isMuted === 'function' && S.isMuted());
      this.musicOn = !(S && typeof S.isMusicMuted === 'function' && S.isMusicMuted());
      this.redrawButtons();
      return this;
    }

    show() {
      this.syncAudio();
      this.setVisible(true);
      return this;
    }

    hide() {
      this.hover = '';
      this.setVisible(false);
      return this;
    }

    setVisible(v) {
      this.visible = !!v;
      const list = [this.overlay, this.panelGfx, this.buttonGfx, this.titleText, this.hintText,
        this.resumeText, this.titleBtnText, this.sfxLabel, this.sfxValue, this.musicLabel, this.musicValue];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && typeof list[i].setVisible === 'function') { list[i].setVisible(this.visible); }
      }
      return this;
    }

    isVisible() { return !!this.visible; }

    hitId(x, y) {
      if (hit(this.resumeRect(), x, y)) { return 'resume'; }
      if (hit(this.sfxRect(), x, y)) { return 'sfx'; }
      if (hit(this.musicRect(), x, y)) { return 'music'; }
      if (hit(this.titleRect(), x, y)) { return 'title'; }
      return '';
    }

    onPointerMove(pointer) {
      if (!this.visible || !pointer) { return; }
      const next = this.hitId(num(pointer.x, -1), num(pointer.y, -1));
      if (next === this.hover) { return; }
      this.hover = next;
      this.redrawButtons();
    }

    onPointerDown(pointer) {
      if (!this.visible || !pointer) { return; }
      if (pointer.button && pointer.button !== 0) { return; }
      const id = this.hitId(num(pointer.x, -1), num(pointer.y, -1));
      /* 点在面板外的压暗层 = 继续，避免以为关掉了其实还在暂停、道具全锁 */
      if (!id) {
        if (FK.SoundSystem) { FK.SoundSystem.play('click'); }
        if (this.onResume) { this.onResume(); }
        return;
      }
      if (id === 'sfx') {
        if (this.onSfx) { this.onSfx(); }
        this.syncAudio();
        if (this.sfxOn && FK.SoundSystem) { FK.SoundSystem.play('click'); }
        return;
      }
      if (id === 'music') {
        if (this.onMusic) { this.onMusic(); }
        this.syncAudio();
        return;
      }
      if (FK.SoundSystem) { FK.SoundSystem.play('click'); }
      if (id === 'resume' && this.onResume) { this.onResume(); }
      else if (id === 'title' && this.onTitle) { this.onTitle(); }
    }

    destroy() {
      const input = this.scene && this.scene.input;
      if (input && typeof input.off === 'function') {
        input.off('pointerdown', this.onPointerDownBound);
        input.off('pointermove', this.onPointerMoveBound);
      }
      const list = [this.overlay, this.panelGfx, this.buttonGfx, this.titleText, this.hintText,
        this.resumeText, this.titleBtnText, this.sfxLabel, this.sfxValue, this.musicLabel, this.musicValue];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && typeof list[i].destroy === 'function') { list[i].destroy(); }
      }
      this.visible = false;
      this.scene = null;
      return this;
    }
  }

  FK.PausePanel = PausePanel;
})();
