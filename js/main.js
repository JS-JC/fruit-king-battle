/**
 * ============================================================
 * main.js —— 游戏入口
 * ============================================================
 * 职责：
 *   1. 把 FK.Config 中的常量翻译成 Phaser 的游戏配置
 *   2. 注册 BootScene / BattleScene
 *   3. new Phaser.Game(...) 启动游戏
 *   4. Phaser 缺失时显示友好提示（不白屏、不抛异常）
 *
 * 依赖：Phaser、FK.Config、FK.BootScene、FK.BattleScene
 * 对外：FK.boot()、FK.game
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const Config = FK.Config;

  /**
   * 字符串形式缩放模式 → Phaser 常量
   * （写成字符串是为了让 gameConfig.js 不依赖 Phaser）
   */
  function mapScaleMode(name) {
    switch (name) {
      case 'ENVELOP': return Phaser.Scale.ENVELOP;
      case 'RESIZE': return Phaser.Scale.RESIZE;
      case 'NONE': return Phaser.Scale.NONE;
      case 'FIT':
      default: return Phaser.Scale.FIT;
    }
  }

  /** 字符串形式居中方式 → Phaser 常量 */
  function mapCenterMode(name) {
    switch (name) {
      case 'CENTER_HORIZONTALLY': return Phaser.Scale.CENTER_HORIZONTALLY;
      case 'CENTER_VERTICALLY': return Phaser.Scale.CENTER_VERTICALLY;
      case 'NO_CENTER': return Phaser.Scale.NO_CENTER;
      case 'CENTER_BOTH':
      default: return Phaser.Scale.CENTER_BOTH;
    }
  }

  /**
   * 组装 Phaser 游戏配置。
   * 所有数值都来自 gameConfig.js，这里不出现任何魔法数字。
   */
  function isPhotoBgEnabled() {
    const bg = Config.BACKGROUND;
    return !!(bg && bg.enabled !== false);
  }

  function syncHtmlBattleBg() {
    const img = (typeof document !== 'undefined') ? document.getElementById('battle-bg') : null;
    if (!img) { return; }
    img.style.display = isPhotoBgEnabled() ? '' : 'none';
  }

  function buildGameConfig() {
    const photo = isPhotoBgEnabled();
    syncHtmlBattleBg();
    return {
      type: Phaser.AUTO,                       // WebGL 优先，不可用时自动回退 Canvas
      width: Config.CANVAS.width,
      height: Config.CANVAS.height,
      parent: Config.CANVAS.parent,
      transparent: photo,
      backgroundColor: photo ? 'rgba(0,0,0,0)' : Config.CANVAS.backgroundColor,

      // 等比缩放铺满窗口，居中显示，不变形
      scale: {
        mode: mapScaleMode(Config.SCALE.mode),
        autoCenter: mapCenterMode(Config.SCALE.autoCenter),
        width: Config.CANVAS.width,
        height: Config.CANVAS.height
      },

      // Arcade 物理：世界重力固定为 0，重力由实体各自施加
      physics: {
        default: 'arcade',
        arcade: {
          gravity: { x: 0, y: Config.PHYSICS.worldGravityY },
          fps: Config.PHYSICS.stepFps,          // 固定步长，必须与抛物线预测步长一致
          fixedStep: Config.PHYSICS.fixedStep,
          debug: Config.DEBUG.enabled && Config.DEBUG.showPhysics
        }
      },

      // 帧率：固定步长物理已保证精度，这里用 requestAnimationFrame 以获得更平滑的画面
      fps: {
        target: 60,
        forceSetTimeOut: Config.PHYSICS.forceSetTimeOut
      },

      render: {
        antialias: true,
        transparent: photo,
        roundPixels: false                      // 抛物线要平滑，不做像素取整
      },

      banner: false,                            // 关闭 Phaser 控制台横幅，保持控制台干净

      // 场景按注册顺序启动，第一个（Boot）会自动运行
      scene: [FK.BootScene, FK.BattleScene, FK.ResultScene]
    };
  }

  /** Phaser 未加载时显示 index.html 中的兜底提示层 */
  function showFallback() {
    const fb = document.getElementById('fallback');
    const root = document.getElementById('game-root');
    if (fb) { fb.style.display = 'flex'; }
    if (root) { root.style.display = 'none'; }
    console.warn('[Main] Phaser 未加载，已显示兜底提示。请联网刷新，或将 phaser.min.js 放入 lib/ 目录。');
  }

  /** 启动游戏 */
  function boot() {
    if (typeof Phaser === 'undefined' || !window.Phaser) {
      showFallback();
      return null;
    }

    if (Config.DEBUG.enabled) {
      console.log('[Main] Phaser ' + Phaser.VERSION + ' · ' + Config.GAME_TITLE +
        ' v' + Config.VERSION + ' · 逻辑分辨率 ' +
        Config.CANVAS.width + '×' + Config.CANVAS.height +
        ' · 1 单位 = ' + Config.PX_PER_UNIT + 'px');
    }

    FK.game = new Phaser.Game(buildGameConfig());
    return FK.game;
  }

  FK.buildGameConfig = buildGameConfig;
  FK.boot = boot;

  // index.html 把 main.js 放在 </body> 前，DOM 已就绪；此处仍做一次兼容判断
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
