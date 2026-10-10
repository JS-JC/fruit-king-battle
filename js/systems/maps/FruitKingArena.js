/**
 * ============================================================
 * FruitKingArena.js —— 水果王竞技场（地图布局模块）
 * ============================================================
 * 职责：按 map.json 程序化绘制岩石高台 / 果冻台 / 饼干台 / 果汁池。
 * 不改碰撞、出生点坐标、水面高度口径；仅负责视觉。
 * 对应 data/map.json 中的 id: "fruit_king_arena"
 * 依赖：Phaser Graphics（无渲染管线时 build 只登记配置）
 * ============================================================
 */
window.FK = window.FK || {};
FK.ModuleFactories = FK.ModuleFactories || {};
FK.ModuleFactories.map = FK.ModuleFactories.map || {};

(function () {
  'use strict';

  /** 地图绘制常量（颜色 / 尺寸集中，方便调） */
  const STYLE = {
    arenaFill: 0x0B1220,
    arenaEdge: 0x334155,
    rockFill: 0x374151,
    rockTop: 0x6B7280,
    rockEdge: 0x1F2937,
    rockVein: 0x111827,
    rockSpot: 0x0F172A,
    rockTopH: 5,
    jellyFill: 0xA855F7,
    jellyAlpha: 0.75,
    jellyHi: 0xD8B4FE,
    jellyEdge: 0x6B21A8,
    jellyBubble: 0xF3E8FF,
    cookieFill: 0xB45309,
    cookieTop: 0xFBBF24,
    cookieEdge: 0x78350F,
    cookieChip: 0x431407,
    cookieTopH: 4,
    juice: 0x0EA5E9,
    juiceAlpha: 0.55,
    juiceDeep: 0x0369A1,
    juiceWave: 0x7DD3FC,
    juiceShine: 0xFFFFFF,
    juiceBubble: 0xE0F2FE,
    depth: 0
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function seedFrom(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function nextRand(state) {
    state[0] = (Math.imul(state[0], 1664525) + 1013904223) >>> 0;
    return state[0] / 4294967296;
  }

  function strokeWave(g, x, y, w, amp, segs) {
    const n = Math.max(4, segs | 0);
    g.beginPath();
    g.moveTo(x, y);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      g.lineTo(x + w * t, y + Math.sin(t * Math.PI * 5) * amp);
    }
    g.strokePath();
  }

  function drawRock(g, x, y, w, h, id) {
    g.fillStyle(STYLE.rockFill, 1);
    g.fillRoundedRect(x, y, w, h, 4);
    g.fillStyle(STYLE.rockTop, 1);
    g.fillRect(x, y, w, Math.min(STYLE.rockTopH, Math.max(3, h * 0.18)));
    g.lineStyle(1.5, STYLE.rockVein, 0.55);
    const n = 4;
    for (let i = 0; i < n; i++) {
      const yy = y + h * (0.38 + i * 0.14);
      if (yy >= y + h - 3) { continue; }
      g.beginPath();
      g.moveTo(x + 6, yy);
      g.lineTo(x + w - 6, yy + ((i % 2) ? 2 : -1));
      g.strokePath();
    }
    const st = [seedFrom(id + ':rock')];
    g.fillStyle(STYLE.rockSpot, 0.5);
    for (let i = 0; i < 8; i++) {
      const px = x + 8 + nextRand(st) * (w - 16);
      const py = y + 10 + nextRand(st) * Math.max(8, h - 14);
      g.fillCircle(px, py, 1.2 + nextRand(st) * 1.4);
    }
    g.lineStyle(2, STYLE.rockEdge, 0.95);
    g.strokeRoundedRect(x, y, w, h, 4);
  }

  function drawJelly(g, x, y, w, h) {
    g.fillStyle(STYLE.jellyFill, STYLE.jellyAlpha);
    g.fillRoundedRect(x, y, w, h, 8);
    g.fillStyle(STYLE.jellyHi, 0.45);
    g.fillRoundedRect(x + 4, y + 2, w - 8, Math.max(4, h * 0.28), 6);
    g.fillStyle(STYLE.jellyBubble, 0.35);
    g.fillCircle(x + w * 0.22, y + h * 0.55, 3.5);
    g.fillCircle(x + w * 0.55, y + h * 0.42, 2.6);
    g.fillCircle(x + w * 0.78, y + h * 0.68, 3.0);
    g.lineStyle(2, STYLE.jellyHi, 0.85);
    strokeWave(g, x + 4, y + 3, w - 8, 2.2, 12);
    g.lineStyle(2, STYLE.jellyEdge, 0.8);
    g.strokeRoundedRect(x, y, w, h, 8);
  }

  function drawCookie(g, x, y, w, h, id) {
    g.fillStyle(STYLE.cookieFill, 1);
    g.fillRoundedRect(x, y, w, h, 5);
    g.fillStyle(STYLE.cookieTop, 0.9);
    g.fillRect(x, y, w, Math.min(STYLE.cookieTopH, Math.max(3, h * 0.22)));
    const st = [seedFrom(id + ':cookie')];
    g.fillStyle(STYLE.cookieChip, 0.95);
    const chips = 10;
    for (let i = 0; i < chips; i++) {
      const px = x + 6 + nextRand(st) * (w - 12);
      const py = y + 8 + nextRand(st) * Math.max(6, h - 12);
      g.fillCircle(px, py, 1.4 + nextRand(st) * 1.8);
    }
    g.lineStyle(2.5, STYLE.cookieEdge, 1);
    g.strokeRoundedRect(x, y, w, h, 5);
  }

  function drawJuice(g, left, poolTop, w, poolH) {
    if (poolH <= 0) { return; }
    g.fillStyle(STYLE.juiceDeep, 0.7);
    g.fillRect(left, poolTop + poolH * 0.45, w, poolH * 0.55);
    g.fillStyle(STYLE.juice, STYLE.juiceAlpha);
    g.fillRect(left, poolTop, w, poolH);
    g.fillStyle(STYLE.juiceShine, 0.18);
    g.fillRect(left, poolTop, w, Math.min(10, poolH));
    g.lineStyle(2, STYLE.juiceWave, 0.9);
    strokeWave(g, left, poolTop, w, 3, 28);
    g.lineStyle(1.5, STYLE.juiceShine, 0.7);
    strokeWave(g, left, poolTop + 3, w, 2, 28);
    g.fillStyle(STYLE.juiceBubble, 0.4);
    const bubbles = [
      [0.12, 0.28, 3], [0.28, 0.62, 2.2], [0.45, 0.4, 2.8],
      [0.61, 0.72, 2.4], [0.78, 0.35, 3.2], [0.9, 0.58, 2]
    ];
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      g.fillCircle(left + w * b[0], poolTop + poolH * b[1], b[2]);
    }
  }

  FK.ModuleFactories.map.fruit_king_arena = function createFruitKingArenaModule() {
    const state = { mapConfig: null, gfx: null, scene: null };

    return {
      id: 'fruit_king_arena',
      kind: 'map',
      displayName: '水果王竞技场',

      /**
       * 构建地形视觉
       * @param {Phaser.Scene} scene
       * @param {FK.MapConfig} mapConfig
       */
      build: function (scene, mapConfig) {
        state.mapConfig = mapConfig || null;
        state.scene = scene || null;
        if (state.gfx && typeof state.gfx.destroy === 'function') {
          state.gfx.destroy();
          state.gfx = null;
        }

        const map = state.mapConfig;
        const canDraw = !!(scene && scene.add && typeof scene.add.graphics === 'function' && map);
        if (!canDraw) { return null; }

        const Config = FK.Config;
        if (!Config || typeof Config.arenaX !== 'function') { return null; }

        const ppx = num(map.pxPerUnit, 48);
        const g = scene.add.graphics();
        if (typeof g.setDepth === 'function') { g.setDepth(STYLE.depth); }
        state.gfx = g;

        const left = Config.arenaX(0);
        const top = Config.arenaY(0);
        const w = map.width * ppx;
        const h = map.height * ppx;

        const usePhotoBg = !!(Config.BACKGROUND && Config.BACKGROUND.enabled);
        if (!usePhotoBg) {
          g.fillStyle(STYLE.arenaFill, 1);
          g.fillRect(left, top, w, h);
        }

        const poolTop = Config.arenaY(map.waterLevel);
        const poolH = Config.arenaY(map.height) - poolTop;
        drawJuice(g, left, poolTop, w, poolH);

        (map.platforms || []).forEach(function (p) {
          const x = Config.arenaX(p.x);
          const y = Config.arenaY(p.y);
          const pw = p.width * ppx;
          const ph = p.height * ppx;
          const mat = p.material || 'rock';
          if (mat === 'jelly') { drawJelly(g, x, y, pw, ph); }
          else if (mat === 'cookie') { drawCookie(g, x, y, pw, ph, p.id); }
          else { drawRock(g, x, y, pw, ph, p.id); }
        });

        g.lineStyle(2, STYLE.arenaEdge, 1);
        g.strokeRect(left, top, w, h);
        return g;
      },

      getSpawnPoints: function () {
        const map = state.mapConfig;
        return (map && Array.isArray(map.spawnPoints)) ? map.spawnPoints.slice() : [];
      },

      getWaterLevel: function () {
        const map = state.mapConfig;
        return map && typeof map.waterLevel === 'number' ? map.waterLevel : 0;
      },

      destroy: function () {
        if (state.gfx && typeof state.gfx.destroy === 'function') { state.gfx.destroy(); }
        state.gfx = null;
        state.scene = null;
        state.mapConfig = null;
      }
    };
  };

  FK.ModuleFactories.map.jam_canyon = function createJamCanyonModule() {
    const inner = FK.ModuleFactories.map.fruit_king_arena();
    inner.id = 'jam_canyon';
    inner.displayName = '果酱峡谷';
    return inner;
  };
})();
