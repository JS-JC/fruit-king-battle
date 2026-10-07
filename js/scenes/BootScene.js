/**
 * ============================================================
 * BootScene.js —— 启动 + 标题页（第 10 步完整版）
 * ============================================================
 * 1. 加载并解析配置、注册模块
 * 2. 标题页：游戏名 + 3 行操作说明 +「开始对局」
 *    URL ?skipTitle=1 时直接进 Battle（自检 / 无头浏览器）
 *
 * 对外：FK.BootScene
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const Config = FK.Config;

  class BootScene extends Phaser.Scene {

    constructor() {
      super({ key: 'Boot' });
      this.loadingText = null;
      this.bootPayload = null;
    }

    preload() {
      FK.ConfigLoader.queueLoads(this);
      if (!FK.ConfigLoader.isFileProtocol()) {
        this.loadingText = this.add.text(
          Config.CANVAS.width / 2,
          Config.CANVAS.height / 2,
          '正在加载配置…',
          { fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '28px', color: '#CBD5E1' }
        ).setOrigin(0.5);
      }
    }

    create() {
      if (this.loadingText) {
        this.loadingText.destroy();
        this.loadingText = null;
      }

      const data = FK.ConfigLoader.resolve(this);
      Config.applyRuntime({
        dataLoaded: true,
        unitCount: data.units.length,
        itemCount: data.items.length,
        mapId: (data.map && data.map.id) ? data.map.id : '',
        turnTime: data.turn ? data.turn.turnTime : 0,
        dataSources: data.meta.sources,
        dataProtocol: data.meta.protocol
      });

      const reg = FK.RegisterAll.run();
      Config.applyRuntime({
        moduleCounts: {
          units: reg.units.length,
          items: reg.items.length,
          maps: reg.maps.length
        }
      });

      if (Config.DEBUG.enabled && Config.DEBUG.logDataSummary) {
        console.log('[Boot] ' + Config.GAME_TITLE + ' v' + Config.VERSION + ' 启动');
        console.log('[Boot] ' + FK.ConfigLoader.summary());
      }

      this.bootPayload = {
        step: Config.STEP,
        dataSources: data.meta.sources,
        registerSummary: reg
      };

      if (Config.shouldSkipTitle()) {
        this.enterBattle();
        return;
      }
      this.buildTitle();
    }

    enterBattle() {
      this.scene.start('Battle', this.bootPayload || {});
    }

    buildTitle() {
      const W = Config.CANVAS.width;
      const H = Config.CANVAS.height;
      const copy = (Config.HUD && Config.HUD.copy) ? Config.HUD.copy : {};

      this.cameras.main.setBackgroundColor(Config.CANVAS.backgroundColor);

      const g = this.add.graphics();
      g.fillStyle(0x1E293B, 0.55);
      g.fillRoundedRect(W / 2 - 420, 80, 840, 640, 24);
      g.lineStyle(3, 0xFDE047, 0.9);
      g.strokeRoundedRect(W / 2 - 420, 80, 840, 640, 24);

      this.add.text(W / 2, 150, Config.GAME_TITLE, {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '56px', fontStyle: 'bold', color: '#FDE047'
      }).setOrigin(0.5);

      this.add.text(W / 2, 214, 'IAmFruitKing  ·  v' + Config.VERSION, {
        fontFamily: 'Consolas, sans-serif', fontSize: '18px', color: '#94A3B8'
      }).setOrigin(0.5);

      const lines = [
        copy.how1 || '点击己方水果选中，按住拖拽瞄准，松手投出炸弹',
        copy.how2 || '底部四格：樱桃炸弹 / 西瓜炸弹 / 水果箱 / 移动',
        copy.how3 || '把敌人打空血量，或炸下高台落入果汁池即可获胜'
      ];
      const icons = ['①', '②', '③'];
      for (let i = 0; i < 3; i++) {
        const y = 300 + i * 72;
        const card = this.add.graphics();
        card.fillStyle(0x0F172A, 0.85);
        card.fillRoundedRect(W / 2 - 360, y - 28, 720, 56, 12);
        this.add.text(W / 2 - 336, y, icons[i], {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '22px', color: '#FDE047'
        }).setOrigin(0, 0.5);
        this.add.text(W / 2 - 300, y, lines[i], {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '20px', color: '#E2E8F0'
        }).setOrigin(0, 0.5);
      }

      const bw = 280;
      const bh = 64;
      const bx = W / 2 - bw / 2;
      const by = 580;
      const btn = this.add.graphics();
      const drawBtn = function (hover) {
        btn.clear();
        btn.fillStyle(hover ? 0x16A34A : 0x22C55E, 1);
        btn.fillRoundedRect(bx, by, bw, bh, 14);
        btn.lineStyle(3, 0x064E3B, 1);
        btn.strokeRoundedRect(bx, by, bw, bh, 14);
      };
      drawBtn(false);
      this.add.text(W / 2, by + bh / 2, copy.start || '开始对局', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '28px', fontStyle: 'bold', color: '#052E16'
      }).setOrigin(0.5);

      const zone = this.add.zone(bx, by, bw, bh).setOrigin(0).setInteractive();
      zone.on('pointerover', function () { drawBtn(true); });
      zone.on('pointerout', function () { drawBtn(false); });
      zone.on('pointerdown', () => {
        if (FK.SoundSystem) {
          FK.SoundSystem.init();
          FK.SoundSystem.unlock();
          FK.SoundSystem.play('click');
        }
        this.enterBattle();
      });

      this.add.text(W / 2, 680, copy.startHint || '点击按钮开始', {
        fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '16px', color: '#64748B'
      }).setOrigin(0.5);
    }
  }

  FK.BootScene = BootScene;
})();
