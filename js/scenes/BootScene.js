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
      this.chosenMapId = 'fruit_king_arena';
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
        this.chosenMapId = 'fruit_king_arena';
        this.enterBattle();
        return;
      }
      this.buildTitle();
    }

    enterBattle() {
      const mapId = this.chosenMapId || 'fruit_king_arena';
      if (FK.ConfigLoader && typeof FK.ConfigLoader.selectMap === 'function') {
        FK.ConfigLoader.selectMap(mapId);
      }
      const payload = Object.assign({}, this.bootPayload || {}, { mapId: mapId });
      this.scene.start('Battle', payload);
    }

    buildTitle() {
      const W = Config.CANVAS.width;
      const H = Config.CANVAS.height;
      const copy = (Config.HUD && Config.HUD.copy) ? Config.HUD.copy : {};

      this.cameras.main.setBackgroundColor(Config.CANVAS.backgroundColor);

      const g = this.add.graphics();
      g.fillStyle(0x1E293B, 0.55);
      g.fillRoundedRect(W / 2 - 420, 48, 840, 704, 24);
      g.lineStyle(3, 0xFDE047, 0.9);
      g.strokeRoundedRect(W / 2 - 420, 48, 840, 704, 24);

      this.add.text(W / 2, 110, Config.GAME_TITLE, {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '52px', fontStyle: 'bold', color: '#FDE047'
      }).setOrigin(0.5);

      this.add.text(W / 2, 168, 'IAmFruitKing  ·  v' + Config.VERSION, {
        fontFamily: 'Consolas, sans-serif', fontSize: '18px', color: '#94A3B8'
      }).setOrigin(0.5);

      const lines = [
        copy.how1 || '点击己方水果选中，按住拖拽瞄准，松手投出炸弹',
        copy.how2 || '底部五格：樱桃 / 西瓜 / 香蕉弹 / 水果箱 / 移动',
        copy.how3 || '把敌人打空血量，或炸下高台落入果汁池即可获胜'
      ];
      const icons = ['①', '②', '③'];
      for (let i = 0; i < 3; i++) {
        const y = 232 + i * 58;
        const card = this.add.graphics();
        card.fillStyle(0x0F172A, 0.85);
        card.fillRoundedRect(W / 2 - 360, y - 24, 720, 48, 12);
        this.add.text(W / 2 - 336, y, icons[i], {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '20px', color: '#FDE047'
        }).setOrigin(0, 0.5);
        this.add.text(W / 2 - 300, y, lines[i], {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '18px', color: '#E2E8F0'
        }).setOrigin(0, 0.5);
      }

      this.buildMapPicker(W);

      const bw = 280;
      const bh = 64;
      const bx = W / 2 - bw / 2;
      const by = 610;
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

      this.add.text(W / 2, 700, copy.startHint || '先选地图，再开始对局', {
        fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '16px', color: '#64748B'
      }).setOrigin(0.5);
    }

    buildMapPicker(W) {
      const maps = (FK.Configs && FK.Configs.maps && FK.Configs.maps.length)
        ? FK.Configs.maps
        : [(FK.Configs && FK.Configs.map) || { id: 'fruit_king_arena', name: '水果王竞技场' }];
      this.chosenMapId = this.chosenMapId || (maps[0] && maps[0].id) || 'fruit_king_arena';

      this.add.text(W / 2, 420, '选择地图（整场有效）', {
        fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '18px', color: '#FDE047'
      }).setOrigin(0.5);

      const self = this;
      const cardW = 320;
      const cardH = 88;
      const gap = 24;
      const total = maps.length * cardW + Math.max(0, maps.length - 1) * gap;
      const left = W / 2 - total / 2;
      const y = 478;
      this._mapCardGfx = [];

      const redraw = function () {
        for (let i = 0; i < maps.length; i++) {
          const selected = maps[i].id === self.chosenMapId;
          const gfx = self._mapCardGfx[i];
          if (!gfx) { continue; }
          gfx.clear();
          gfx.fillStyle(selected ? 0x14532D : 0x0F172A, 0.95);
          gfx.fillRoundedRect(left + i * (cardW + gap), y, cardW, cardH, 14);
          gfx.lineStyle(selected ? 3 : 2, selected ? 0xFDE047 : 0x334155, 1);
          gfx.strokeRoundedRect(left + i * (cardW + gap), y, cardW, cardH, 14);
        }
      };

      for (let i = 0; i < maps.length; i++) {
        const map = maps[i];
        const gx = this.add.graphics();
        this._mapCardGfx.push(gx);
        const sub = (map.id === 'jam_canyon')
          ? (map.width + '×' + map.height + 'u  镜头滚动大地图')
          : (map.width + '×' + map.height + 'u  经典对战');
        this.add.text(left + i * (cardW + gap) + cardW / 2, y + 28, map.name || map.id, {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '22px', fontStyle: 'bold', color: '#F8FAFC'
        }).setOrigin(0.5);
        this.add.text(left + i * (cardW + gap) + cardW / 2, y + 58, sub, {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '14px', color: '#94A3B8'
        }).setOrigin(0.5);
        const zone = this.add.zone(left + i * (cardW + gap), y, cardW, cardH).setOrigin(0).setInteractive();
        zone.on('pointerdown', function () {
          self.chosenMapId = map.id;
          if (FK.SoundSystem) {
            FK.SoundSystem.init();
            FK.SoundSystem.unlock();
            FK.SoundSystem.play('click');
          }
          redraw();
        });
      }
      redraw();
    }
  }

  FK.BootScene = BootScene;
})();
