/**
 * ============================================================
 * BattleScene.js —— 战斗场景（第 4 步起：单位与阵营 2v2；第 8 步补齐死亡与胜负）
 * ============================================================
 * 本场景当前展示内容：
 *   · 地图占位：左右高台 / 中央果冻台 / 两侧饼干台 / 果汁池（半透明蓝）
 *   · 4 个水果单位按 MapConfig 的 spawnPoints 落位（2 蓝 2 红）
 *   · 每个单位头顶血条 + 鼠标悬停 / 点击选中（仅当前回合阵营）
 *   · 拖拽抛物线瞄准 → 投掷 → 爆炸 / 击退 / 撞木箱与墙体弹回
 *   · 第 8 步：落水判定（每帧）、死亡判定（伤害结算后）、胜负结算与「再来一局」
 *   · HUD：回合条（阵营/回合数/倒计时/状态）+ 选中单位 + 存活数（第 8.7 步起不再显示回合日志）
 *
 * 仍未实现（留给后续步骤）：
 *   · 第 9 步：简单 AI        第 10 步：完整 HUD / 标题页 / 结算面板 / DoD
 *
 * 版面（逻辑分辨率 1600×800）：
 *   0..74     顶部回合条
 *   78..106   信息行（标题 / 选中单位 / 配置摘要）
 *   112..688  竞技场（1440×576，1 单位 = 48px）
 *   692..748  底部状态面板（操作提示 / 投掷状态 / FPS；已移除回合日志显示）
 *
 * 依赖：FK.Config、FK.EVENTS、FK.EventBus、FK.TurnManager、
 *       FK.UnitSpawner、FK.UnitSelector、FK.Configs、
 *       FK.DeathSystem、FK.VictorySystem、FK.DeathEffect、FK.ResultPanel
 * 对外：FK.BattleScene
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const Config = FK.Config;

  /** 配色 */
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

  /** 阵营显示名 */
  const TEAM_LABEL = { blue: '蓝色方', red: '红色方' };

  /** 地形材质配色（第 8 步将迁到地图模块内） */
  const MATERIAL_COLOR = {
    rock: { fill: 0x6B7280, edge: 0x374151, top: 0x9CA3AF },
    cookie: { fill: 0xD9A566, edge: 0x78350F, top: 0xF3D5A5 },
    jelly: { fill: 0x7C3AED, edge: 0xC4B5FD, top: 0xA78BFA }
  };

  /**
   * 渲染深度
   *   第 8.8 步：新增 STATUS（底部状态条：操作提示 / FPS）。
   *   它必须**低于道具栏**（ItemBar 用 DEPTH.TOAST = 50）：
   *   这样即使版面变化让两者重叠，道具格也永远画在状态条之上，不会被遮挡。
   */
  const DEPTH = { MAP: 0, UNIT: 10, STATUS: 48, TOAST: 50, HUD: 60 };

  class BattleScene extends Phaser.Scene {

    constructor() {
      super({ key: 'Battle' });

      this.fpsText = null;
      this.fpsAccumulator = 0;
      this.lastFrameTime = null;

      this.disposables = [];

      /** 第 3 步：回合状态机 */
      this.turnManager = null;
      /** 第 4 步：单位实例化与选择 */
      this.unitSpawner = null;
      this.unitSelector = null;
      this.units = [];

      /** 第 5 步：瞄准（预测 / 控制 / 渲染） */
      this.trajectoryPredictor = null;
      this.aimController = null;
      this.trajectoryRenderer = null;
      /** 世界碰撞数据（从 MapConfig 换算，供预测器使用） */
      this.worldColliders = null;

      /** 第 6 步：伤害结算 + 投掷闭环 */
      this.damageSystem = null;
      this.projectileController = null;

      /** 第 7 步：道具栏 + 障碍物注册表 */
      this.itemBar = null;
      this.obstacleRegistry = null;

      /** 第 7.5 步：放置模式（水果箱点击放置）+ 放置预览视觉 */
      this.placementController = null;
      this.placementPreview = null;

      /** 第 7.8 步：道具冷却（按阵营独立计算；水果箱 = 1 个自己的行动回合） */
      this.itemCooldown = null;

      /** 第 8 步：落水 / 死亡判定 + 胜负判定 + 死亡占位动画 + 结算界面 */
      this.deathSystem = null;
      this.victorySystem = null;
      this.deathEffect = null;
      this.resultPanel = null;

      /** 第 8.5 步：单位主动移动（控制器 + 轨迹预览；入口是道具栏第 4 格「移动」） */
      this.moveController = null;
      this.moveRenderer = null;
      /** 拖拽是否已「拖出去」（用于「拖回单位 = 取消移动」的判定） */
      this.dragArmed = false;

      /** 第 9 步：敌方（红色方）AI —— 决策主控 + 最近一次决策摘要（HUD / 自检用） */
      this.aiController = null;
      this.lastAiDecided = null;
      this.lastAiActed = null;

      /** 本局是否已经分出胜负（终态后不再判定 / 不再接受输入） */
      this.lastVictory = null;
      /** 最近一次胜负事件的原始负载（调试 / 自检用） */
      this.lastVictoryPayload = null;
      /** 阵亡单位的残留引用（正在播放 / 已播完死亡动画的），供重开对局时统一清理 */
      this.dying = [];

      /** HUD 引用 */
      this.hud = {
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

      this.toastContainer = null;
    }

    /** @param {Object} data { step, dataSources, registerSummary } */
    init(data) {
      this.bootContext = data || {};
      this.units = [];
    }

    /* ==================================================================
     * 生命周期
     * ================================================================== */

    create() {
      this.events.once('shutdown', this.shutdown, this);
      this.lastFrameTime = null;

      this.buildBackdrop();
      this.buildMapPlaceholder();     // 第 4 步：地图可视化占位
      this.buildTurnHud();            // 第 10 步：FK.HUD（顶部回合条 + 倒计时环 + 切换提示）
      this.buildInfoRow();            // 标题 / 选中单位 / 配置摘要（HUD 已建则跳过）
      this.buildBottomPanel();        // 底部状态面板（HUD 已建则只保留版面常量）

      this.subscribeTurnEvents();
      this.setupTurnManager();        // 先有状态机，单位选择才能做阵营限制

      this.spawnUnits();              // 第 4 步：实例化 4 个单位并接入选区
      this.setupAiming();             // 第 5 步：预测器 + 瞄准控制器 + 轨迹渲染器
      this.setupObstacles();          // 第 7 步：障碍物注册表（挂到预测器的碰撞世界）
      // 第 8 步：落水 / 死亡判定与胜负判定（必须晚于 setupAiming —— 水面来自 map.waterLevel）
      this.setupDeaths();
      this.injectSupportWorld();      // 第 8 步：给单位注入支撑面（掉下平台 → 落水）
      this.setupProjectiles();        // 第 6 步：伤害系统 + 投掷控制器（监听 aim:end）
      this.setupItemCooldown();       // 第 7.8 步：道具冷却表（放置模式与道具栏都要读）
      this.setupPlacement();          // 第 7.5 步：放置模式（水果箱点击放置）
      this.setupItemBar();            // 第 7 步：底部道具栏（点击切换道具）
      this.setupMove();               // 第 8.5 步：单位移动 + 移动/投掷模式切换条
      this.setupAI();                 // 第 9 步：敌方 AI（必须晚于投掷 / 放置 / 移动 —— 它只调用它们的入口）
      this.setupResultPanel();        // 第 8 步：胜负结算界面（「再来一局」按钮）
      this.setupAudio();              // 第 12 步：程序化音效 + 喇叭静音

      this.refreshInfoRow();
      this.updateThrowHud();

      this.log('BattleScene 就绪：拖拽选中单位瞄准，松手投掷当前道具');

      /* ============================================================
       * ↓↓↓ 后续步骤的扩展位（本步不实现，仅标注插入位置）↓↓↓
       *
       * 第 9 步：敌方 AI 已接入（见 setupAI()）：红方回合开始 → 延迟 1~2 秒 →
       *          选单位 / 选道具 / 选目标 / 算参数 / 加误差 → 出手 → 自动结束回合；
       *          蓝方回合 AI 完全不动（见 AIController.onTurnStart）。
       * 第 10 步：this.hudView = new FK.HUD(this) 已在 buildTurnHud() 接入。
       * ============================================================ */
    }

    /**
     * 每帧更新
     *
     * 倒计时精度说明：
     *   Phaser 的 `delta` 有上限钳制（默认 50ms），掉帧或降频时会拖慢回合时钟。
     *   这里用 `time`（performance.now 基准）相邻两帧之差驱动状态机，
     *   并钳制到 1000ms，保证「30 秒回合」严格等于真实 30 秒。
     */
    update(time, delta) {
      this.updateFps(delta);

      const dt = this.computeRealDelta(time, delta);

      // ---- 单位逐帧更新（走模块接口，BattleScene 不关心单位内部实现） ----
      // 第 8 步起这一步还承担「击退滑行 / 弹性弹回 / 掉下平台继续下坠」。
      for (let i = 0; i < this.units.length; i++) {
        const u = this.units[i];
        if (!u) { continue; }
        if (u.module && typeof u.module.update === 'function') { u.module.update(u, dt); }
        else if (typeof u.update === 'function') { u.update(dt); }
      }

      // ---- 第 8 步（规则 1 / 规则 3）：死亡结算 + 胜负判定 ----
      // 每帧检测所有存活单位是否落水（任何位移导致落水都要判）；
      // 放在回合状态机之前：倒计时归零的同一帧里若有单位死亡，
      // 先完成死亡结算并判胜负，就不会再走进「超时切换回合」。
      // 第 8.5 步：移动途中落水也走这条链路（单位在 stepActiveMove 里继续下坠）。
      this.settleDeaths();

      if (this.turnManager) { this.turnManager.tick(dt); }

      /**
       * 第 9 步：敌方 AI 驱动（红方回合）——
       *   进入 TURN_START 后延迟 1~2 秒决策并出手；蓝方回合它处于空闲态、完全不动。
       *   放在回合状态机之后、各系统推进之前：AI 一旦出手，
       *   同一帧里投掷物 / 移动就会开始推进，玩家看到的是「AI 出手 → 立刻飞」。
       */
      if (this.aiController) { this.aiController.update(dt); }

      // 悬停检测
      if (this.unitSelector) { this.unitSelector.update(dt); }

      // 第 5 步：瞄准驱动 + 轨迹绘制
      if (this.aimController) { this.aimController.update(dt); }
      if (this.trajectoryRenderer) { this.trajectoryRenderer.update(); }

      // 第 8.5 步：单位移动推进 + 移动轨迹绘制
      // 放在投掷物之前：移动与投掷互斥，同一帧不会两边都在跑
      if (this.moveController) { this.moveController.update(dt); }
      if (this.moveRenderer) { this.moveRenderer.update(); }

      // 第 6 步：投掷物飞行 / 引信 / 爆炸演出 / 结算兜底
      if (this.projectileController) { this.projectileController.update(dt); }

      // 第 7 步：障碍物生成动画（纯表现）
      if (this.obstacleRegistry) { this.obstacleRegistry.update(dt); }

      // 第 7.5 步：木箱自由落体（放置模式）；落地后生成障碍物并结束回合
      if (this.placementController) { this.placementController.update(dt); }

      // 第 7 步：道具栏悬停/点击的场景级兜底（Zone 之外的指针移动也要能高亮）
      if (this.itemBar && this.input && this.input.activePointer) {
        this.itemBar.onPointerMove(this.input.activePointer);
      }

      // 第 7.8 步：冷却状态变化时刷新道具栏（内部做了签名比较，不会每帧重画）
      if (this.itemBar) { this.itemBar.refreshCooldown(); }

      this.updateTurnHud();
      this.updateAimHud();
      this.updateThrowHud();
      if (this.hudView && this.hudView.aim) {
        const aimSt = this.aimController && this.aimController.getAimState
          ? this.aimController.getAimState() : null;
        const mvSt = this.moveController && this.moveController.getState
          ? this.moveController.getState() : null;
        if (aimSt && aimSt.aiming) { this.hudView.aim.sync(aimSt); }
        else if (mvSt && mvSt.planning) { this.hudView.aim.sync(mvSt); }
        else { this.hudView.aim.sync(null); }
      }
    }

    /** 计算真实帧间隔（毫秒，钳制 0～1000） */
    computeRealDelta(time, delta) {
      let realDelta = delta;
      if (typeof time === 'number' && typeof this.lastFrameTime === 'number') {
        realDelta = time - this.lastFrameTime;
      }
      this.lastFrameTime = time;
      return Math.min(Math.max(realDelta, 0), 1000);
    }

    shutdown() {
      // 第 8.5 步：移动系统最先摘（它持有指针监听与单位引用）
      if (this.moveRenderer) { this.moveRenderer.destroy(); this.moveRenderer = null; }
      if (this.moveController) { this.moveController.destroy(); this.moveController = null; }
      // 第 9 步：AI 主控同样先摘（持有 EventBus 监听与各控制器引用，避免监听泄漏）
      if (this.aiController) { this.aiController.destroy(); this.aiController = null; }
      this.lastAiDecided = null;
      this.lastAiActed = null;
      // 第 7.5 / 7 / 7.8 步：先摘事件监听与 UI，再清空障碍物与冷却，最后关掉投掷链路
      // 第 8 步：再补上结算界面 / 死亡动画 / 判定系统的清理
      if (this.hudView) { this.hudView.destroy(); this.hudView = null; }
      if (this.deathEffect) { this.deathEffect.destroy(); this.deathEffect = null; }
      if (this.placementController) { this.placementController.destroy(); this.placementController = null; }
      if (this.placementPreview) { this.placementPreview.destroy(); this.placementPreview = null; }
      if (this.itemCooldown) { this.itemCooldown.clear(); this.itemCooldown = null; }
      if (this.itemBar) { this.itemBar.destroy(); this.itemBar = null; }
      if (this.obstacleRegistry) { this.obstacleRegistry.clear('destroy'); this.obstacleRegistry = null; }
      if (this.projectileController) { this.projectileController.destroy(); this.projectileController = null; }
      this.damageSystem = null;
      if (this.trajectoryRenderer) { this.trajectoryRenderer.destroy(); this.trajectoryRenderer = null; }
      if (this.aimController) { this.aimController.destroy(); this.aimController = null; }
      this.trajectoryPredictor = null;
      this.worldColliders = null;
      if (this.unitSelector) { this.unitSelector.destroy(); this.unitSelector = null; }
      if (this.unitSpawner) { this.unitSpawner.destroyAll(); this.unitSpawner = null; }
      this.units = [];
      this.dying = [];
      this.deathSystem = null;
      this.victorySystem = null;
      this.lastVictory = null;
      this.lastVictoryPayload = null;
      if (this.turnManager) { this.turnManager.reset(); }
      if (FK.EventBus) { FK.EventBus.clear(); }

      this.disposables.forEach(function (d) {
        if (d && typeof d.destroy === 'function') { d.destroy(); }
      });
      this.disposables.length = 0;
    }

    /* ==================================================================
     * 第 3 步：回合状态机接入
     * ================================================================== */

    setupTurnManager() {
      const turnConfig = (FK.Configs && FK.Configs.turn) ? FK.Configs.turn : null;
      this.turnManager = new FK.TurnManager(turnConfig);

      this.turnManager.start();

      this.refreshLogPanel();
      this.updateTurnHud();
    }

    setupAudio() {
      const S = FK.SoundSystem;
      if (!S) { return; }
      S.init();
      const self = this;
      const unlock = function () { S.unlock(); };
      if (this.input) {
        this.input.on('pointerdown', unlock);
      }
      if (this.input && this.input.keyboard) {
        this.input.keyboard.on('keydown', unlock);
      }

      const E = FK.EVENTS;
      const play = function (name) { S.play(name); };
      FK.EventBus.on(E.AIM_END, function () { play('throw'); }, this);
      FK.EventBus.on(E.PROJECTILE_EXPLODED, function (p) {
        const id = p && p.itemId;
        if (id === 'watermelon_bomb') { play('explode_watermelon'); }
        else { play('explode_cherry'); }
      }, this);
      FK.EventBus.on(E.UNIT_DROWNED, function () { play('splash'); }, this);
      FK.EventBus.on(E.PROJECTILE_REMOVED, function (p) {
        if (p && p.reason === 'water') { play('splash'); }
      }, this);
      FK.EventBus.on(E.OBSTACLE_SPAWNED, function () { play('crate_land'); }, this);
      FK.EventBus.on(E.MOVE_END, function () { play('move'); }, this);
      FK.EventBus.on(E.TURN_SWITCH, function () { play('turn_switch'); }, this);
      FK.EventBus.on(E.SLOT_SELECTED, function () { play('click'); }, this);

      this.buildMuteButton();
    }

    drawMuteIcon(muted) {
      const g = this.muteGfx;
      if (!g) { return; }
      const W = Config.CANVAS.width;
      const cx = W - 48;
      const cy = 41;
      g.clear();
      g.fillStyle(muted ? 0x64748B : 0xFDE047, 1);
      g.fillTriangle(cx - 10, cy, cx - 2, cy - 8, cx - 2, cy + 8);
      g.fillRect(cx - 14, cy - 4, 6, 8);
      g.lineStyle(2, muted ? 0x94A3B8 : 0xF8FAFC, 1);
      g.beginPath();
      g.arc(cx - 1, cy, 6, -0.6, 0.6, false);
      g.strokePath();
      if (muted) {
        g.lineStyle(3, 0xEF4444, 1);
        g.beginPath();
        g.moveTo(cx - 16, cy - 12);
        g.lineTo(cx + 12, cy + 12);
        g.strokePath();
      }
    }

    buildMuteButton() {
      const W = Config.CANVAS.width;
      const S = FK.SoundSystem;
      this.muteGfx = this.add.graphics().setDepth(DEPTH.HUD + 2);
      this.drawMuteIcon(S && S.isMuted());
      const zone = this.add.zone(W - 48, 41, 40, 40).setOrigin(0.5).setInteractive();
      zone.setDepth(DEPTH.HUD + 3);
      const self = this;
      zone.on('pointerdown', function () {
        if (!S) { return; }
        S.unlock();
        S.setMuted(!S.isMuted());
        self.drawMuteIcon(S.isMuted());
      });
      this.disposables.push(this.muteGfx, zone);
    }

    subscribeTurnEvents() {
      const E = FK.EVENTS;
      FK.EventBus.on(E.TURN_STATE_CHANGE, this.onTurnStateChange, this);
      FK.EventBus.on(E.TURN_START, this.onTurnStarted, this);
      FK.EventBus.on(E.TURN_TICK, this.onTurnTick, this);
      FK.EventBus.on(E.TURN_TIMEOUT, this.onTurnTimeout, this);
      FK.EventBus.on(E.TURN_END, this.onTurnEnded, this);
      FK.EventBus.on(E.TURN_SWITCH, this.onTeamSwitched, this);
      FK.EventBus.on(E.GAME_OVER, this.onGameOver, this);
    }

    onTurnStateChange(payload) {
      if (this.hud.stateText) {
        this.hud.stateText.setText('状态：' + payload.to + (payload.reason ? '  ← ' + payload.reason : ''));
      }
      this.refreshLogPanel();
    }

    onTurnStarted(payload) {
      const maxTurns = (this.turnManager && this.turnManager.getConfig)
        ? (this.turnManager.getConfig().maxTurns || Config.TURN.maxTurns)
        : Config.TURN.maxTurns;
      if (payload.turnNumber > maxTurns) {
        this.endByTurnLimit();
        return;
      }
      const style = this.teamStyle(payload.team);
      if (this.hudView) {
        this.hudView.setTurn(payload.team, payload.turnNumber, payload.state);
      } else {
        if (this.hud.turnText) { this.hud.turnText.setText('第 ' + payload.turnNumber + ' 回合'); }
        if (this.hud.teamText) {
          this.hud.teamText.setText('轮到' + style.label);
          this.hud.teamText.setColor(style.color);
        }
      }
      this.showTeamToast(style.label, style.color);
      this.syncPlayerControls();
      this.refreshLogPanel();
    }

    endByTurnLimit() {
      if (!this.victorySystem || this.victorySystem.isSettled()) { return; }
      const result = this.victorySystem.settleTimeout(this.units || []);
      if (!result || !result.outcome) { return; }
      this.lastVictory = result;
      this.enterGameOver(result);
    }

    /**
     * 第 9 步：AI 回合锁死玩家操作面（道具栏灰显）。
     * 选中 / 瞄准 / 移动 / 放置的指针锁在各自控制器的 isPlayerInputBlocked。
     */
    syncPlayerControls() {
      if (!this.itemBar) { return; }
      if (this.isGameOver()) {
        this.itemBar.setEnabled(false);
        return;
      }
      const aiTurn = !!(FK.Config && typeof FK.Config.isAiTurn === 'function' &&
        FK.Config.isAiTurn(this.turnManager));
      this.itemBar.setEnabled(!aiTurn);
    }

    onTurnTick(payload) {
      // 秒数文本由 updateTurnHud() 每帧刷新，这里只做「最后 10 秒」的预警接入
      if (payload.secondsLeft <= 10 && this.hud.timeText) {
        this.hud.timeText.setColor(COLOR.fail);
      }
    }

    onTurnTimeout() {
      this.flashToast('时间到！', COLOR.fail);
      this.refreshLogPanel();
    }

    onTurnEnded(payload) {
      // 第 7.8 步：道具冷却推进（只推进「刚行动的那一方」——蓝方冷却不受红方回合影响）
      if (this.itemCooldown) {
        this.itemCooldown.onTurnEnd(this.turnManager.getTurnNumber(), this.turnManager.getCurrentTeam());
      }
      // 第 7 步：回合结束 → 障碍物倒计时 -1 并广播 turn:obstacleTick
      if (this.obstacleRegistry) { this.obstacleRegistry.onTurnEnd(this.turnManager.getTurnNumber()); }
      this.refreshLogPanel();
    }

    onTeamSwitched() { this.refreshLogPanel(); }

    onGameOver(payload) {
      this.flashToast('对局结束：' + payload.winner, COLOR.step);
      this.refreshLogPanel();
    }

    /* ==================================================================
     * 第 4 步：单位实例化与选择
     * ================================================================== */

    /** 用 UnitSpawner 按 MapConfig 的出生点创建 4 个单位 */
    spawnUnits() {
      const mapCfg = (FK.Configs && FK.Configs.map) || null;
      const unitCfgs = (FK.Configs && FK.Configs.units) || [];

      if (!mapCfg || unitCfgs.length === 0) {
        console.error('[Battle] 无法实例化单位：缺少 MapConfig 或 UnitConfig');
        return;
      }

      const turnCfg = (FK.Configs && FK.Configs.turn) || {};
      this.unitSpawner = new FK.UnitSpawner(this, unitCfgs, mapCfg, { teamOrder: turnCfg.teamOrder });

      this.subscribeUnitEvents();

      this.units = this.unitSpawner.spawn();
      this.units.forEach(function (u) { u.setDepth(DEPTH.UNIT); });

      // 第 7.10 步：给每个单位注入碰撞世界（木箱 + 地图边界类型）
      // 用 provider 而不是快照：木箱会随回合生成 / 到期，必须每帧读最新数据。
      this.injectBounceWorld();

      // 选区块：只允许选中当前回合阵营
      this.unitSelector = new FK.UnitSelector(this, this.units, this.turnManager);

      if (this.unitSpawner.failed.length > 0) {
        console.error('[Battle] 有 ' + this.unitSpawner.failed.length + ' 个单位创建失败');
      }
    }

    /* ==================================================================
     * 第 7.10 步：击退 / 主动移动的弹性碰撞世界
     *   · 木箱矩形  → ObstacleRegistry.getRects()（只含未到期的木箱）
     *   · 地图边界   → worldColliders.bounds（类型来自 data/map.json 的 bounds.type）
     *   · 地形平台   → 第 8.10 步起：**仅当单位在空中飞行时**作为横向障碍参与碰撞
     *     （撞到平台侧面 / 边缘被挡住并按同一套弹性弹回，不会从平台缝隙斜穿下去）
     * ================================================================== */

    /**
     * 供 UnitBase 每帧查询的碰撞世界（木箱 + 地图边界 + 空中时的地形平台）
     *
     * 第 8.10 步（Bug：单位穿过平台边缘）：被炸飞的单位在空中撞到紫色平台的侧面时
     * 没有被挡住，直接从平台之间的缝隙斜穿下去 —— 因为碰撞世界里只有木箱和墙。
     * 现在把地形平台也交给 FK.KnockbackPhysics（**同一份弹性弹回物理，不新写第二份**）：
     *   · 单位「迎面」撞到平台侧面 → 停在面外侧并弹回（复用 crate 的同一分支）；
     *   · 单位已经在平台的横向范围内（站在台上滑行 / 从上方落下）→ 现有算法本就会跳过
     *     该矩形（迎面判定要求「前缘还没越过该面」），因此不会影响落地与边缘掉落。
     *
     * 地形平台始终加入横向碰撞：贴地滑行撞到台沿 / 邻台立面要弹回，不能顺着台面滑下去。
     * 主动移动预览走同一份 platforms（predictor.world），实飞也用这份，抛物线才对得上。
     *
     * @param {Object} [unit] 查询碰撞世界的单位（缺省只返回木箱 + 边界）
     */
    buildBounceWorld(unit) {
      const rects = this.obstacleRegistry ? this.obstacleRegistry.getRects() : [];
      const b = this.worldColliders ? this.worldColliders.bounds : null;
      const bounds = b ? { left: b.left, right: b.right, type: b.type || 'wall' } : null;
      const plats = (this.worldColliders && this.worldColliders.platforms) ? this.worldColliders.platforms : [];
      const air = (unit && unit.airborne) ? plats.map(function (p) {
        return { id: p.id, x: p.x, y: p.y, width: p.width, height: p.height, kind: 'platform' };
      }) : [];
      return { rects: rects.concat(air), bounds: bounds };
    }

    /** 把碰撞世界注入全部单位（场景创建单位后调用一次） */
    injectBounceWorld() {
      const self = this;
      if (!this.units) { return; }
      this.units.forEach(function (u) {
        if (u && typeof u.setBounceWorld === 'function') {
          // 第 8.10 步：把单位本身传给 provider —— 只有空中的单位才会拿到平台矩形
          u.setBounceWorld(function (unit) { return self.buildBounceWorld(unit); });
        }
      });
    }

    subscribeUnitEvents() {
      const E = FK.EVENTS;
      FK.EventBus.on(E.UNIT_SPAWNED, this.onUnitSpawned, this);
      FK.EventBus.on(E.UNIT_SELECTED, this.onUnitSelected, this);
      FK.EventBus.on(E.UNIT_DESELECTED, this.onUnitDeselected, this);
      FK.EventBus.on(E.UNIT_DAMAGED, this.onUnitDamaged, this);
    }

    onUnitSpawned(payload) {
      if (!FK.Config.DEBUG.enabled) { return; }
      console.log('[Battle] unit:spawned → ' + payload.id + ' (' + payload.team + ') @ ' +
        payload.x + ',' + payload.y + ' hp ' + payload.hp + '/' + payload.maxHp);
    }

    onUnitSelected(payload) {
      if (this.hud.selectedText) {
        const style = this.teamStyle(payload.team);
        this.hud.selectedText.setText('选中：' + payload.id + '（' + this.displayNameOf(payload.unit) +
          '）· ' + style.label + ' · ' + payload.hp + '/' + payload.maxHp);
        this.hud.selectedText.setColor(style.color);
      }
      this.refreshLogPanel();
    }

    onUnitDeselected() {
      if (this.hud.selectedText) {
        this.hud.selectedText.setText('选中：未选择');
        this.hud.selectedText.setColor(COLOR.value);
      }
      this.refreshLogPanel();
    }

    onUnitDamaged(payload) {
      const sel = this.unitSelector ? this.unitSelector.getSelected() : null;
      if (this.hud.selectedText && payload.unit === sel) {
        this.onUnitSelected({
          id: payload.id, team: payload.team,
          hp: payload.hp, maxHp: payload.maxHp, unit: payload.unit
        });
      }
      this.refreshLogPanel();
    }

    displayNameOf(unit) {
      return (unit && typeof unit.getDisplayName === 'function') ? unit.getDisplayName() : '';
    }

    teamStyle(team) {
      return { label: TEAM_LABEL[team] || team, color: team === 'red' ? COLOR.red : COLOR.blue };
    }

    /* ==================================================================
     * 第 5 步：拖拽抛物线瞄准
     *   数据来源全部是配置：
     *     · 重力 / 步长 / 力度上限  → FK.Config.AIM
     *     · 平台矩形 / 水面高度     → FK.Configs.map（MapConfig）
     *     · 预警圈半径 / 力度系数   → FK.Configs.items（ItemConfig，第 7 步接入道具栏）
     * ================================================================== */

    /** 初始化预测器、瞄准控制器与轨迹渲染器 */
    setupAiming() {
      const map = (FK.Configs && FK.Configs.map) || null;
      if (!map) {
        console.error('[Battle] 缺少 MapConfig，无法初始化瞄准系统');
        return;
      }

      this.worldColliders = this.buildWorldColliders(map);

      const A = FK.Config.AIM;
      this.trajectoryPredictor = new FK.TrajectoryPredictor({
        gravityY: FK.Config.PHYSICS.gravityY,
        stepSec: A.stepSec,
        maxSteps: A.maxSteps,
        sampleEvery: A.sampleEvery,
        integration: A.integration,
        platforms: this.worldColliders.platforms,
        waterLevel: this.worldColliders.waterLevel,
        bounds: this.worldColliders.bounds
      });

      this.aimController = new FK.AimController(this, {
        unitSelector: this.unitSelector,
        predictor: this.trajectoryPredictor,
        turnManager: this.turnManager,
        // 第 8.6 步：道具栏第 4 格「移动」被选中时，瞄准控制器完全不接管鼠标
        isMoveActive: () => !!(this.itemBar && this.itemBar.isMoveSlotActive())
      });

      // 默认道具：第 7 步接入道具栏后由玩家选择，本步取配置里的默认 id
      const item = this.pickDefaultItem();
      if (item) { this.aimController.setItem(item); }

      this.trajectoryRenderer = new FK.TrajectoryRenderer(this, {
        predictor: this.trajectoryPredictor,
        aimController: this.aimController,
        // 第 8.6 步：选中「移动」格时投掷轨迹 / 落点圈一律擦除（双抛物线 bug 的渲染侧修复）
        isMoveActive: () => !!(this.itemBar && this.itemBar.isMoveSlotActive()),
        radiusPx: item ? item.radius * map.pxPerUnit : 0,
        alpha: A.trajectoryAlpha
      });

      this.subscribeAimEvents();
      this.updateAimHud();
    }

    /**
     * 把 MapConfig 换算成世界像素级的碰撞数据
     * @param {FK.MapConfig} map
     * @returns {{platforms:Array, waterLevel:number, bounds:Object}}
     */
    buildWorldColliders(map) {
      const platforms = (map.platforms || []).map(function (p) {
        return {
          id: p.id,
          x: FK.Config.arenaX(p.x),
          y: FK.Config.arenaY(p.y),
          width: p.width * map.pxPerUnit,
          height: p.height * map.pxPerUnit,
          material: p.material
        };
      });

      return {
        platforms: platforms,
        waterLevel: FK.Config.arenaY(map.waterLevel),
        bounds: {
          left: FK.Config.arenaX(0),
          right: FK.Config.arenaX(map.width),
          top: FK.Config.arenaY(0),
          // 第 7 步：允许抛物线越过屏幕上边界（高抛），由配置一键开关
          ignoreTop: FK.Config.PROJECTILE.ignoreTopBound !== false,
          // 第 7.10 步：边界类型来自 data/map.json 的 bounds.type（当前 demo = 实体墙）
          type: map.boundsType || 'wall'
        }
      };
    }

    /** 取默认道具（AIM.defaultItemId 未命中时回退到第 1 个道具） */
    pickDefaultItem() {
      const items = (FK.Configs && FK.Configs.items) || [];
      if (items.length === 0) { return null; }
      const wantId = FK.Config.AIM.defaultItemId;
      for (let i = 0; i < items.length; i++) {
        if (items[i].id === wantId) { return items[i]; }
      }
      return items[0];
    }

    /* ==================================================================
     * 第 6 步：投掷闭环（伤害系统 + 投掷控制器）
     *   数据来源全部是配置：
     *     · damage / radius / knockback / innerRadiusUnits / edgeDamageRatio
     *       / fuseOnHitMs / explodeAnimMs  → FK.Configs.items（ItemConfig）
     *     · 重力 / 步长 / 飞行上限 / 结算兜底 → FK.Config（PHYSICS / AIM / PROJECTILE）
     *     · 地形与水面                   → FK.Configs.map（由 setupAiming 换算）
     * ================================================================== */

    /** 初始化伤害系统与投掷控制器；控制器自己监听 aim:end，场景不介入投掷流程 */
    setupProjectiles() {
      if (!FK.DamageSystem || !FK.ProjectileController) {
        console.error('[Battle] 投掷系统未加载：请确认 DamageSystem.js / Projectile.js / Explosion.js / ProjectileController.js 已在 index.html 中引入');
        return;
      }

      this.damageSystem = new FK.DamageSystem({
        eventBus: FK.EventBus,
        pxPerUnit: FK.Configs.map ? FK.Configs.map.pxPerUnit : FK.Config.PX_PER_UNIT,
        debug: FK.Config.DEBUG.enabled,
        // 第 8 步（规则 2）：每次爆炸结算完伤害后立即检查「血量归零」→ 死亡判定
        onDamageSettled: (units) => this.handleDamageSettled(units)
      });

      this.projectileController = new FK.ProjectileController(this, {
        unitSelector: this.unitSelector,
        turnManager: this.turnManager,
        aimController: this.aimController,
        predictor: this.trajectoryPredictor,
        damageSystem: this.damageSystem,
        // 第 7 步：放置类道具要生成障碍物、西瓜要清扫障碍物，都走这一个注册表
        obstacleRegistry: this.obstacleRegistry,
        // 单位列表用函数提供，第 8 步移除阵亡单位后无需重建控制器
        units: () => this.units,
        // 当前道具由道具栏驱动（第 7 步）：itemBar 是唯一真相源
        getItem: () => (this.itemBar ? this.itemBar.getSelected() : this.pickDefaultItem())
      });

      this.subscribeProjectileEvents();
    }

    /* ==================================================================
     * 第 7 步：障碍物（水果箱落地生成的静态方块）
     *   数据来源全部是配置：
     *     · 边长 / 持续回合  → data/items.json（crateSizeUnits / duration）
     *     · 渲染深度 / 圆角  → FK.Config.OBSTACLE
     *   注册表把障碍物矩形同步进 TrajectoryPredictor 的 platforms，
     *   于是「预测轨迹」与「投掷物实飞」都认得木箱，无需第二份碰撞代码。
     * ================================================================== */

    /** 初始化障碍物注册表并挂到预测器上 */
    setupObstacles() {
      if (!FK.ObstacleRegistry || !FK.Obstacle) {
        console.error('[Battle] 障碍物系统未加载：请确认 Obstacle.js / ObstacleRegistry.js 已在 index.html 中引入');
        return;
      }

      this.obstacleRegistry = new FK.ObstacleRegistry({ eventBus: FK.EventBus });
      // attach 会把「地形平台 + 障碍物」合并后写回预测器（此刻还没有障碍物）
      this.obstacleRegistry.attach(this.trajectoryPredictor, this.worldColliders);

      this.subscribeObstacleEvents();
    }

    /* ==================================================================
     * 第 7.8 步：道具冷却（按阵营独立计算）
     *   数值来源：data/items.json → ItemConfig.cooldownTurns（水果箱 = 1）
     *   计时来源：既有 turn:end 事件（在 onTurnEnded 里按「刚行动的一方」推进）
     *   使用登记：既有 item:used 事件（投掷与放置两条路径都会发）
     *   语义：第 N 个 turn 用了 → 该方第 N+2 个 turn（下次行动）不能用 → 第 N+4 恢复
     * ================================================================== */

    /** 创建冷却表；必须早于 setupPlacement / setupItemBar */
    setupItemCooldown() {
      if (!FK.ItemCooldown) {
        console.error('[Battle] 道具冷却未加载：请确认 js/systems/ItemCooldown.js 已在 index.html 中引入');
        return;
      }
      this.itemCooldown = new FK.ItemCooldown({ eventBus: FK.EventBus });
    }

    /** 当前行动方的某道具剩余冷却（0 = 可用）；道具栏与 HUD 共用 */
    itemCooldownRemaining(itemId) {
      if (!this.itemCooldown || !this.turnManager) { return 0; }
      return this.itemCooldown.getRemaining(this.turnManager.getCurrentTeam(), itemId);
    }

    /**
     * 按 itemId 取道具配置（登记冷却时要知道 cooldownTurns）
     * @returns {FK.ItemConfig|null}
     */
    itemConfigOf(itemId) {
      const items = (FK.Configs && FK.Configs.items) || [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].id === itemId) { return items[i]; }
      }
      return null;
    }

    /**
     * 第 7.8 步：登记一次道具使用 → 该方进入冷却
     * @param {Object} payload item:used 负载 { itemId, unitId, team, turnNumber }
     */
    startItemCooldown(payload) {
      if (!this.itemCooldown || !payload || !payload.itemId) { return; }
      const cfg = this.itemConfigOf(payload.itemId);
      const turns = cfg ? cfg.cooldownTurns : 0;
      if (!turns || turns <= 0) { return; }
      const team = payload.team || (this.turnManager ? this.turnManager.getCurrentTeam() : '');
      this.itemCooldown.start(team, payload.itemId, turns, payload.turnNumber);
      this.log('item:cooldownStart → ' + team + ' 的 ' + payload.itemId +
        ' 进入冷却（' + turns + ' 个自己的行动回合）');
    }

    /** 订阅障碍物事件（只用于日志与 HUD，不参与障碍物逻辑） */
    subscribeObstacleEvents() {
      const E = FK.EVENTS;
      FK.EventBus.on(E.OBSTACLE_SPAWNED, this.onObstacleSpawned, this);
      FK.EventBus.on(E.OBSTACLE_REMOVED, this.onObstacleRemoved, this);
      FK.EventBus.on(E.TURN_OBSTACLE_TICK, this.onObstacleTick, this);
    }

    onObstacleSpawned(payload) {
      this.log('obstacle:spawned → #' + payload.id + ' ' + payload.itemId +
        ' ' + payload.sizeUnits + 'u @(' + payload.x + ',' + payload.y + ')，剩余 ' +
        payload.remainingTurns + ' 回合');
      this.refreshLogPanel();
    }

    onObstacleRemoved(payload) {
      this.log('obstacle:removed → #' + payload.id + '（' + payload.reason + '）');
      this.refreshLogPanel();
    }

    /** 每回合结束：障碍物倒计时 -1（这一步由 EventBus 的 turn:end 驱动，见 onTurnEnded） */
    onObstacleTick(payload) {
      this.log('turn:obstacleTick → 第 ' + payload.turnNumber + ' 回合结束，场上木箱 ' +
        payload.count + ' 个' + (payload.removed.length ? '，移除 ' + payload.removed.length + ' 个' : ''));
      this.refreshLogPanel();
    }

    /* ==================================================================
     * 第 7.5 步：放置模式（水果箱点击放置）
     *   数据来源全部是配置：
     *     · 木箱边长 / 存活 turn / 冷却 turn → data/items.json
     *       （crateSizeUnits / duration / cooldownTurns）
     *     · 预览样式 → FK.Config.OBSTACLE（第 7.9 步起不再有数量上限）
     *     · 下落重力 / 单帧步长 → FK.Config.PHYSICS.gravityY / PROJECTILE.maxStepMs
     *   放置与投掷**共用同一个回合口令**（projectileController.turnFlow），
     *   因此「本回合已投掷」与「本回合已放置」天然互斥，不需要第二套计数。
     *   第 7.8 步起再加一层「按阵营的道具冷却」（FK.ItemCooldown）。
     * ================================================================== */

    /** 初始化放置预览 + 放置控制器 */
    setupPlacement() {
      if (!FK.PlacementController || !FK.PlacementPreview) {
        console.error('[Battle] 放置模式未加载：请确认 PlacementController.js / PlacementPreview.js 已在 index.html 中引入');
        return;
      }
      if (!this.obstacleRegistry) {
        console.error('[Battle] 缺少障碍物注册表，放置模式不可用');
        return;
      }

      // 预览画在单位之上：非法原因常常就是「路径上有单位」，
      // 若画在单位之下，红色 ✗ 会被挡住，玩家看不到「为什么不能放」。
      this.placementPreview = new FK.PlacementPreview(this, { depth: DEPTH.UNIT + 2 });
      this.placementController = new FK.PlacementController(this, {
        item: this.itemBar ? this.itemBar.getSelected() : this.pickDefaultItem(),
        turnManager: this.turnManager,
        obstacleRegistry: this.obstacleRegistry,
        preview: this.placementPreview,
        units: () => this.units,
        pxPerUnit: FK.Configs.map ? FK.Configs.map.pxPerUnit : FK.Config.PX_PER_UNIT,
        // 第 7.8 步：按阵营的道具冷却（水果箱用完后自己下一个行动回合不能再用）
        itemCooldown: this.itemCooldown,
        // 与投掷共享「本回合是否已行动」，两个入口不会同时生效
        turnGate: {
          canAct: () => !(this.projectileController && this.projectileController.hasThrownThisTurn()),
          markActed: () => {
            if (this.projectileController) { this.projectileController.markTurnUsed('place'); }
          }
        },
        // 点在道具栏上不算放置（道具栏自己会处理点击 → 切换道具）
        blocksPoint: (x, y) => !!(this.itemBar && this.itemBar.hitTest(x, y))
      });

      this.subscribePlacementEvents();
    }

    /** 订阅放置事件：只用于日志与 HUD，不参与放置逻辑 */
    subscribePlacementEvents() {
      const E = FK.EVENTS;
      FK.EventBus.on(E.PLACEMENT_START, this.onPlacementStart, this);
      FK.EventBus.on(E.PLACEMENT_INVALID, this.onPlacementInvalid, this);
      FK.EventBus.on(E.PLACEMENT_COMPLETE, this.onPlacementComplete, this);
      FK.EventBus.on(E.PLACEMENT_CANCELLED, this.onPlacementCancelled, this);
    }

    onPlacementStart(payload) {
      this.log('placement:start → ' + payload.itemId + '（点击地图放置，木箱 ' +
        payload.sizeUnits + 'u，场上 ' + payload.count + '/' + payload.max + '）');
      this.refreshLogPanel();
    }

    onPlacementInvalid(payload) {
      this.log('placement:invalid → ' + payload.reason + '（' + payload.message + '）');
      this.refreshLogPanel();
    }

    onPlacementComplete(payload) {
      this.log('placement:complete → ' + payload.outcome +
        ' @(' + payload.x + ',' + payload.y + ')' +
        (payload.obstacleId === null ? '（落入果汁池，未生成木箱）' : ' 木箱 #' + payload.obstacleId) +
        '，本回合结束');
      this.refreshLogPanel();
    }

    onPlacementCancelled(payload) {
      this.log('placement:cancelled → ' + payload.itemId + '（原因：' + payload.reason + '）');
      this.refreshLogPanel();
    }

    /* ==================================================================
     * 第 7 步：道具栏
     *   单向数据流：ItemBar 只广播 item:selected，本场景负责把选中道具
     *   下发给瞄准系统（决定力度系数与预警圈半径）、投掷系统（决定生成什么）
     *   与放置系统（决定是否进入放置模式）。
     * ================================================================== */

    /** 构建底部道具栏，并把「默认道具」同步给瞄准 / 投掷系统 */
    setupItemBar() {
      if (!FK.ItemBar) {
        console.error('[Battle] 道具栏未加载：请确认 js/ui/ItemBar.js 已在 index.html 中引入');
        return;
      }
      if (!FK.Configs || !FK.Configs.items || FK.Configs.items.length === 0) {
        console.error('[Battle] 缺少道具配置，无法构建道具栏');
        return;
      }

      this.itemBar = new FK.ItemBar(this, {
        items: FK.Configs.items,
        depth: DEPTH.TOAST,
        // 第 7.8 步：冷却中的格子显示为灰色 / 禁用，悬停提示「冷却中（还需 n 个 turn）」
        cooldown: (itemId) => this.itemCooldownRemaining(itemId),
        // 第 8.6 步：第 4 格「移动」每回合只能用一次（移完置灰，仍可投掷）
        canMove: () => !!(this.moveController && this.moveController.canUseMove()),
        moveUsed: () => !!(this.moveController && this.moveController.isMoveUsed())
      });
      this.itemBar.build();

      FK.EventBus.on(FK.EVENTS.SLOT_SELECTED, this.onItemSelected, this);
      FK.EventBus.on(FK.EVENTS.SLOT_ACTIVATED, this.onMoveSlotToggled, this);
      FK.EventBus.on(FK.EVENTS.ITEM_USED, this.onItemUsed, this);

      // 默认道具（cherry_bomb）下发：瞄准预警圈与力度系数立即生效
      this.applyItem(this.itemBar.getSelected());
      this.log('道具栏就绪（4 格）：' + this.itemBar.ids().join(' / ') +
        '，默认 ' + this.itemBar.getSelectedId());
    }

    /** 道具栏切换（含第 4 格「移动」）→ 下发给瞄准与投掷系统 */
    onItemSelected(payload) {
      this.applyItem(payload.item);
      this.log('slot:selected → ' + payload.itemId + '（' + payload.name + '）' +
        (payload.previousId ? ' ← ' + payload.previousId : ''));
      this.refreshLogPanel();
    }

    /**
     * 第 8.6 步：道具栏第 4 格「移动」被选中 / 取消。
     * 单向数据流：ItemBar 只广播意图，实际接管鼠标由 MoveController 完成；
     * 进入移动时顺手取消正在进行的瞄准与放置，三种交互不会叠加。
     */
    onMoveSlotToggled(payload) {
      if (!payload || !this.moveController) { return; }
      if (payload.active) {
        if (this.aimController && this.aimController.isAiming()) { this.aimController.cancelAim('move-selected'); }
        if (this.placementController && this.placementController.isActive()) {
          this.placementController.stop('move-selected', { silent: true });
        }
        this.moveController.setMoveActive(true);
      } else {
        this.moveController.setMoveActive(false);
      }
      this.refreshLogPanel();
    }

    /** 道具真正出手 / 被放置（本回合被消费） */
    onItemUsed(payload) {
      this.log('item:used → ' + payload.itemId + ' by ' + (payload.unitId || '-') +
        '（第 ' + payload.turnNumber + ' 回合，' +
        (payload.source === 'placement'
          ? '放置，木箱 #' + (payload.obstacleId === null || payload.obstacleId === undefined ? '-' : payload.obstacleId)
          : '投掷，#projectile ' + payload.projectileId) + '）');
      // 第 7.8 步：按阵营登记该道具的冷却
      this.startItemCooldown(payload);
      this.refreshLogPanel();
    }

    /** 把选中道具同时交给瞄准系统、投掷系统与放置系统（唯一的道具下发入口） */
    applyItem(itemConfig) {
      if (!itemConfig) { return; }
      if (this.aimController) { this.aimController.setItem(itemConfig); }
      if (this.projectileController) { this.projectileController.setItem(itemConfig); }
      // 第 7.5 步：放置类道具（type='obstacle'）由放置控制器接管鼠标
      if (this.placementController) { this.placementController.setItem(itemConfig); }
      if (this.trajectoryRenderer) {
        const ppx = (FK.Configs && FK.Configs.map) ? FK.Configs.map.pxPerUnit : FK.Config.PX_PER_UNIT;
        this.trajectoryRenderer.setRadiusPx(itemConfig.radius * ppx);
      }
      /**
       * 第 8.5 / 8.6 步：**点任意道具格 = 退出「移动」选择**。
       * 道具栏是唯一真相源：它只在真正切换格子时才广播，因此这里不会把
       * 「刚点亮的移动格」误关掉（移动期间道具选中态为空，selectedId 不变）。
       */
      if (this.itemBar && this.itemBar.isMoveSlotActive()) {
        this.itemBar.setMoveSlotActive(false, { silent: true, force: true, reason: 'switch-item' });
      }
      if (this.moveController) { this.moveController.setMoveActive(false); }
    }

    /* ==================================================================
     * 第 8.5 / 8.6 步：单位移动（MoveController + MoveRenderer）
     *
     *   数据来源全部是配置：
     *     · 移动力度 / 角度 / 拖拽距离 / 起跳偏移 / 飞行上限 → FK.Config.MOVE
     *     · 弹性系数（撞木箱 / 撞墙）                        → FK.Config.KNOCKBACK
     *     · 重力 / 步长（与投掷同源）                         → FK.Config.PHYSICS / AIM
     *     · 地形与水面 / 木箱矩形                             → predictor 的世界数据
     *   单向数据流（第 8.6 步起**没有「模式」概念**）：
     *     ItemBar 第 4 格 --slot:activated--> BattleScene --setMoveActive()--> MoveController
     *     MoveController --move:*--> BattleScene（只做日志 / HUD）
     *   每回合只能移动一次：移完仍可投掷，但「移动」格置灰，再次点击不生效。
     * ================================================================== */

    /** 初始化移动控制器与移动轨迹渲染器（「移动」入口在道具栏第 4 格） */
    setupMove() {
      if (!FK.MoveController || !FK.MoveRenderer) {
        console.error('[Battle] 移动系统未加载：请确认 MoveController.js / MoveRenderer.js 已在 index.html 中引入');
        return;
      }

      const canvas = FK.Config.CANVAS;

      this.moveController = new FK.MoveController(this, {
        unitSelector: this.unitSelector,
        turnManager: this.turnManager,
        predictor: this.trajectoryPredictor,
        units: () => this.units,
        // 第 8.6 步：移动选择态由道具栏第 4 格持有（道具栏是唯一真相源）
        isMoveActive: () => !!(this.itemBar && this.itemBar.isMoveSlotActive()),
        // 与投掷 / 放置共享「本回合是否已行动」；移动本身另有「每回合一次」的口令
        turnGate: {
          canAct: () => !(this.projectileController && this.projectileController.hasThrownThisTurn()),
          markActed: () => {
            if (this.projectileController) { this.projectileController.markTurnUsed('move'); }
          }
        },
        obstacles: () => (this.obstacleRegistry ? this.obstacleRegistry.getRects() : []),
        canvas: { left: 0, top: 0, right: canvas.width, bottom: canvas.height }
      });

      this.moveRenderer = new FK.MoveRenderer(this, {
        moveController: this.moveController,
        viewport: { left: 0, top: 0, right: canvas.width, bottom: canvas.height }
      });

      this.subscribeMoveEvents();

      this.log('移动系统就绪：点道具栏第 4 格「移动」→ 拖拽己方单位起跳（每回合限一次，移完仍可投掷）');
    }

    /** 订阅移动事件：只用于日志与 HUD，不参与移动逻辑 */
    subscribeMoveEvents() {
      const E = FK.EVENTS;
      if (!E || !E.MOVE_END) { return; }
      FK.EventBus.on(E.MOVE_END, this.onMoveEnd, this);
      FK.EventBus.on(E.MOVE_COMPLETE, this.onMoveComplete, this);
      FK.EventBus.on(E.MOVE_CANCEL, this.onMoveCancel, this);
    }

    onMoveEnd(payload) {
      if (FK.SoundSystem) { FK.SoundSystem.play('move'); }
      this.lastMoveEnd = payload;
      const land = payload.landing
        ? ('(' + payload.landing.x + ',' + payload.landing.y + ')') : '-';
      this.log('move:end → ' + payload.unitId + ' 力度 ' + Math.round(payload.powerRatio * 100) +
        '% · 角度 ' + Math.round(payload.angleDeg) + '° · 速度 ' + Math.round(payload.speed) +
        'px/s · 预计落点 ' + land + ' · 弹回 ' + payload.bounces + ' 次（本回合行动已用）');
      this.refreshLogPanel();
    }

    onMoveComplete(payload) {
      this.lastMoveComplete = payload;
      this.log('move:complete → ' + payload.unitId + ' 位移 ' + payload.distance +
        'px（' + payload.distanceUnits + 'u）· 弹回 ' + payload.bounces + ' 次 · ' + payload.reason +
        ' → 本回合仍可投掷，但不能再次移动');
      this.refreshLogPanel();
    }

    onMoveCancel(payload) {
      this.log('move:cancel → ' + (payload.unitId || '-') + '（原因：' + payload.reason + '）');
      this.refreshLogPanel();
    }

    /** 订阅投掷 / 伤害事件：只用于日志与 HUD，不参与投掷逻辑 */
    subscribeProjectileEvents() {
      const E = FK.EVENTS;
      FK.EventBus.on(E.PROJECTILE_SPAWNED, this.onProjectileSpawned, this);
      FK.EventBus.on(E.PROJECTILE_LANDED, this.onProjectileLanded, this);
      FK.EventBus.on(E.PROJECTILE_EXPLODED, this.onProjectileExploded, this);
      FK.EventBus.on(E.PROJECTILE_REMOVED, this.onProjectileRemoved, this);
      FK.EventBus.on(E.DAMAGE_APPLIED, this.onDamageApplied, this);
      FK.EventBus.on(E.UNIT_KNOCKBACK, this.onUnitKnockback, this);
      FK.EventBus.on(E.TURN_PROJECTILE_RESOLVED, this.onProjectileResolved, this);
    }

    onProjectileSpawned(payload) {
      if (this.hud.hintText) { this.hud.hintText.setColor(COLOR.warn); }
      this.log('projectile:spawned → #' + payload.id + ' ' + payload.itemId +
        ' by ' + payload.shooterId + ' v=(' + Math.round(payload.vx) + ',' + Math.round(payload.vy) + ')');
      this.refreshLogPanel();
    }

    onProjectileLanded(payload) {
      this.log('projectile:landed → #' + payload.id + ' ' + payload.hitType +
        ' @(' + payload.x + ',' + payload.y + ') t=' + payload.flightTimeMs + 'ms');
      this.refreshLogPanel();
    }

    onProjectileExploded(payload) {
      this.log('projectile:exploded → #' + payload.id + ' r=' + payload.radiusUnits + 'u(' +
        Math.round(payload.radiusPx) + 'px) 伤害 ' + payload.damage + ' 击退 ' + payload.knockback);
      this.refreshLogPanel();
    }

    onProjectileRemoved(payload) {
      if (payload && payload.reason === 'water' && FK.SoundSystem) {
        FK.SoundSystem.play('splash');
      }
      this.log('projectile:removed → #' + payload.id + '（' + payload.reason + '）');
      this.refreshLogPanel();
    }

    /** 单个单位被伤害：同步血条相关 HUD（UnitBase.takeDamage 已刷新血条本身） */
    onDamageApplied(payload) {
      this.log('damage:applied → ' + payload.id + ' -' + payload.amount +
        '（距离 ' + payload.distance + 'u，衰减 ' + Math.round(payload.falloff * 100) + '%）→ ' +
        payload.hp + '/' + payload.maxHp);
      this.refreshLogPanel();
    }

    onUnitKnockback(payload) {
      this.log('unit:knockback → ' + payload.id + ' speed=' + Math.round(payload.speed) +
        'px/s dir=(' + Math.round(payload.vx) + ',' + Math.round(payload.vy) + ')');
      this.refreshLogPanel();
    }

    onProjectileResolved(payload) {
      this.log('turn:projectileResolved → 伤害 ' + payload.damaged + ' 个 · 击退 ' +
        payload.knockbacked + ' 个，回合继续流转');
      this.refreshLogPanel();
    }

    /** 订阅瞄准事件（只用于 HUD 刷新与日志，不参与瞄准逻辑） */
    subscribeAimEvents() {
      const E = FK.EVENTS;
      FK.EventBus.on(E.AIM_START, this.onAimStart, this);
      FK.EventBus.on(E.AIM_UPDATE, this.onAimUpdate, this);
      FK.EventBus.on(E.AIM_TRAJECTORY_READY, this.onAimTrajectoryReady, this);
      FK.EventBus.on(E.AIM_END, this.onAimEnd, this);
      FK.EventBus.on(E.AIM_CANCEL, this.onAimCancel, this);
    }

    onAimStart(payload) {
      if (this.hud.hintText) {
        this.hud.hintText.setColor(COLOR.step);
      }
      this.log('aim:start → ' + payload.id + ' (' + payload.team + ')');
    }

    onAimUpdate(payload) {
      this.lastAimUpdate = payload;
    }

    onAimTrajectoryReady(payload) {
      this.lastTrajectory = payload;
    }

    onAimEnd(payload) {
      this.log('aim:end → 力度 ' + Math.round(payload.powerRatio * 100) + '% · 角度 ' +
        Math.round(payload.angleDeg) + '° · 落点 (' +
        (payload.landing ? payload.landing.x + ',' + payload.landing.y : '-') + ') · ' + payload.hitType);
      this.lastAimEnd = payload;
    }

    onAimCancel(payload) {
      this.log('aim:cancel → ' + payload.id + '（原因：' + payload.reason + '）');
    }

    /** 每帧刷新底部提示行：瞄准中显示力度 / 角度 / 预计落点 */
    updateAimHud() {
      const hint = this.hud.hintText;
      if (!hint) { return; }
      if (!(Config.DEBUG && Config.DEBUG.enabled)) { return; }

      // 第 8 步：对局已结束 → 只提示结算界面（输入已全部禁止）
      if (this.isGameOver()) {
        const label = this.getVictoryLabel();
        hint.setText('对局结束 · ' + label + ' · 点击「再来一局」重新开始');
        hint.setColor(COLOR.step);
        return;
      }

      /**
       * 第 9 步：红方 AI 回合 —— 优先显示 AI 状态（此时玩家不需要任何操作）。
       * 放在放置 / 移动 / 瞄准提示之前：AI 回合里这些交互本就不该发生。
       */
      const aiTip = this.aiHintText();
      if (aiTip) {
        hint.setText(aiTip);
        hint.setColor(COLOR.red);
        return;
      }

      const state = this.aimController ? this.aimController.getAimState() : null;

      /**
       * 第 8.5 / 8.6 步：移动提示（优先级仅次于放置模式与投掷流程）
       *   · 规划中：力度 / 角度 / 速度 / 预计落点 / 弹回次数（拖到画布外也照常更新）
       *   · 单位正在飞：显示「移动中」
       *   · 待操作：提示拖拽方式；本回合已移动过则提示「移完可投掷，不能再移动」
       */
      const mc = this.moveController;
      if (mc && (mc.isMoveActive() || mc.isPlanning() || mc.activeUnit)) {
        const ms = mc.getState();
        if (ms.flying) {
          hint.setText('移动中：' + (ms.unitId || '单位') + ' 正在飞行 → 落地后本回合仍可投掷');
          hint.setColor(COLOR.warn);
          return;
        }
        if (!mc.isPlanning()) {
          if (!mc.canAct()) {
            hint.setText('已选中「移动」· 本回合行动已用完（等待对方回合）');
            hint.setColor(COLOR.label);
            return;
          }
          if (mc.isMoveUsed()) {
            hint.setText('本回合已经移动过（每回合限一次）· 现在可以投掷，或点其它道具格');
            hint.setColor(COLOR.label);
            return;
          }
          hint.setText('已选中「移动」：按住己方单位向后拖拽决定跳跃方向与力度 · 松手起跳 · ' +
            '撞木箱 / 墙体弹回 · 每回合限一次，移完仍可投掷');
          hint.setColor(COLOR.step);
          return;
        }
        const hitLabel = { water: '果汁池（落水判死）', bounds: '撞墙停下', platform: '平台', timeout: '-', none: '-' };
        const mland = ms.landing
          ? '(' + Math.round(ms.landing.x) + ', ' + Math.round(ms.landing.y) + ')' : '-';
        if (Config.DEBUG && Config.DEBUG.enabled) {
          hint.setText('移动瞄准中 ' + ms.unitId +
            ' · 力度 ' + Math.round(ms.powerRatio * 100) + '%' +
            ' · 角度 ' + Math.round(ms.angleDeg) + '°' +
            ' · 速度 ' + Math.round(ms.speed) + 'px/s' +
            ' · 落点 ' + mland + ' · 命中 ' + (hitLabel[ms.hitType] || ms.hitType) +
            ' · 弹回 ' + ms.bounces + ' 次' +
            ' · 轨迹点 ' + ms.pointCount);
        } else {
          hint.setText('移动瞄准中 · 力度 ' + Math.round(ms.powerRatio * 100) + '%' +
            ' · 角度 ' + Math.round(ms.angleDeg) + '°');
        }
        hint.setColor(ms.hitType === 'water' ? COLOR.fail : COLOR.step);
        return;
      }

      // 第 7.5 步：放置模式（水果箱）——不显示抛物线，显示放置合法性
      // 第 7.9 步：不再有「场上木箱已满」，只提示冷却 / 砸到单位 / 已行动
      const plc = this.placementController;
      if (plc && plc.isActive()) {
        const st = plc.getState();
        const onField = '场上木箱 ' + st.count;
        if (st.falling) {
          hint.setText((Config.DEBUG && Config.DEBUG.enabled)
            ? ('放置中：木箱下落 → ' + st.outcome + ' @(' + Math.round(st.x) + ', ' + Math.round(st.y) + ')')
            : '放置中：木箱下落');
          hint.setColor(COLOR.warn);
          return;
        }
        if (st.cooldownRemaining > 0) {
          hint.setText('放置模式：' + onField + ' · ' + (st.message || '道具冷却中'));
          hint.setColor(COLOR.fail);
          return;
        }
        if (!plc.canAct()) {
          hint.setText('放置模式：' + onField + ' · 本回合已行动，等待对方回合');
          hint.setColor(COLOR.label);
          return;
        }
        const outcomeLabel = {
          platform: '落到平台顶面', obstacle: '落到已有木箱顶面',
          inside: '直接放到平台顶面', water: '会落入果汁池（木箱销毁）', bounds: '落到场底'
        };
        hint.setText('放置模式：移动鼠标选点 · 左键放置 · 右键 / ESC 取消 · ' + onField +
          (st.valid ? ' · 可放置（' + (outcomeLabel[st.outcome] || st.outcome) + '）'
            : ' · 禁止放置：' + (st.message || st.reason)));
        hint.setColor(st.valid ? COLOR.step : COLOR.fail);
        return;
      }

      // 投掷流程进行中（飞行 / 引信 / 落水 / 爆炸）由投掷状态行接管提示
      const pcStatus = this.projectileController ? this.projectileController.getStatus() : null;
      if (pcStatus && pcStatus.phase !== 'idle' && pcStatus.phase !== 'resolved' &&
          pcStatus.phase !== 'aborted') {
        hint.setText('投掷中：' + pcStatus.label + ' ' + pcStatus.detail);
        hint.setColor(COLOR.warn);
        return;
      }

      if (!state || !state.aiming) {
        // 第 8.8 步：文案收紧到一行，保证底部状态条（x 80~1180）装得下、不侵入道具栏
        hint.setText('悬停高亮 · 点击选中 · 拖拽选中单位瞄准 · 点第 4 格「移动」跳跃 · 拖回 / 右键 / ESC 取消');
        hint.setColor(COLOR.label);
        return;
      }

      const land = state.landing
        ? '(' + Math.round(state.landing.x) + ', ' + Math.round(state.landing.y) + ')'
        : '-';
      const hitLabel = { platform: '平台', water: '水面', bounds: '边界', timeout: '超时', none: '-' };
      const hit = hitLabel[state.hitType] || state.hitType;
      const target = (this.trajectoryPredictor && this.trajectoryPredictor.getHitTarget())
        ? '（' + this.trajectoryPredictor.getHitTarget().id + '）' : '';

      hint.setText('瞄准中 ' + state.unitId +
        ' · 力度 ' + Math.round(state.powerRatio * 100) + '%' +
        ' · 角度 ' + Math.round(state.angleDeg) + '°' +
        ' · 速度 ' + Math.round(state.speed) + 'px/s' +
        ' · 落点 ' + land + ' · 命中 ' + hit + target +
        ' · 轨迹点 ' + state.pointCount +
        // 第 7.7 步：还没拖出取消区时提醒玩家「这样松手会取消」
        (state.armed === false ? ' · 拖出单位范围才算有效投掷' : ' · 拖回单位 = 取消'));
      hint.setColor(state.hitType === 'water' ? COLOR.fail : COLOR.step);
    }

    /**
     * 第 8.8 步：**移除屏幕上的「投掷」调试日志行**
     * （原「投掷：空闲 · 道具 · 本回合可投掷 · 出手/落地/爆炸 · 伤害/击退」）。
     * 保留空实现：create() 与每帧 update() 都在调用它，无需改动调用点；
     * 需要这些数据时用 `projectileController.getStatus()` / `getStats()`（控制台可查）。
     */
    updateThrowHud() {
      return false;
    }

    /** 刷新信息行（配置摘要 + 选中单位 + 第 8 步：双方存活数） */
    refreshInfoRow() {
      const cfgs = FK.Configs || { units: [], items: [], map: null };
      const mapId = cfgs.map ? cfgs.map.id : '未配置';
      if (this.hud.infoText) {
        const alive = this.deathSystem
          ? this.deathSystem.aliveByTeam(this.units || [])
          : { blue: (this.units || []).length, red: 0 };
        this.hud.infoText.setText('单位 ' + (cfgs.units || []).length +
          ' · 道具 ' + (cfgs.items || []).length +
          ' · 地图 ' + mapId +
          ' · 已实例化 ' + this.units.length +
          ' · 存活 蓝 ' + alive.blue + ' / 红 ' + alive.red);
      }
      const hasSelection = this.unitSelector && this.unitSelector.getSelected();
      if (this.hud.selectedText && !hasSelection) {
        this.hud.selectedText.setText('选中：未选择');
        this.hud.selectedText.setColor(COLOR.value);
      }
    }

    /* ==================================================================
     * 第 4 步：地图可视化占位
     *   数据全部来自 FK.Configs.map（不写死任何地图尺寸/坐标）
     *   第 8 步会迁到 FK.ModuleFactories.map.fruit_king_arena.build()
     * ================================================================== */

    buildMapPlaceholder() {
      const map = (FK.Configs && FK.Configs.map) || null;
      if (!map) {
        console.error('[Battle] 缺少 MapConfig，无法绘制地图占位');
        return;
      }

      const factories = FK.ModuleFactories && FK.ModuleFactories.map;
      const make = factories && factories.fruit_king_arena;
      if (typeof make !== 'function') {
        console.error('[Battle] 缺少 fruit_king_arena 地图模块');
        return;
      }

      const self = this;
      this.arenaMap = make();
      this.arenaMap.build(this, map);
      this.disposables.push({
        destroy: function () {
          if (self.arenaMap && typeof self.arenaMap.destroy === 'function') {
            self.arenaMap.destroy();
          }
          self.arenaMap = null;
        }
      });
    }

    /* ==================================================================
     * HUD：顶部回合条
     * ================================================================== */

    buildTurnHud() {
      const W = Config.CANVAS.width;
      if (FK.HUD) {
        this.hudView = new FK.HUD(this);
        this.hudView.build({ panelX: 80, panelW: 1060 });
        this.hud = this.hudView.refs;
        this.toastContainer = this.hudView.toastContainer;
        return;
      }
      const h = this.hud;

      const bar = this.add.graphics().setDepth(DEPTH.HUD);
      bar.fillStyle(COLOR.panelBg, 0.94);
      bar.fillRoundedRect(16, 8, W - 32, 66, 12);
      bar.lineStyle(2, COLOR.panelBorder, 1);
      bar.strokeRoundedRect(16, 8, W - 32, 66, 12);
      this.disposables.push(bar);

      h.turnText = this.add.text(48, 18, '第 1 回合', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '24px', fontStyle: 'bold', color: COLOR.title
      }).setDepth(DEPTH.HUD);

      h.stateText = this.add.text(48, 48, '状态：IDLE', {
        fontFamily: 'Consolas, monospace', fontSize: '14px', color: COLOR.label
      }).setDepth(DEPTH.HUD);

      h.teamText = this.add.text(W / 2, 22, '轮到蓝色方', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '28px', fontStyle: 'bold', color: COLOR.blue
      }).setOrigin(0.5, 0).setDepth(DEPTH.HUD);

      h.timeText = this.add.text(W - 40, 12, '30s', {
        fontFamily: 'Consolas, monospace', fontSize: '28px', fontStyle: 'bold', color: COLOR.value
      }).setOrigin(1, 0).setDepth(DEPTH.HUD);

      h.barBg = this.add.graphics().setDepth(DEPTH.HUD);
      h.barBg.fillStyle(0x0F172A, 1);
      h.barBg.fillRoundedRect(W - 310, 54, 270, 10, 5);
      this.disposables.push(h.barBg);

      h.barFill = this.add.graphics().setDepth(DEPTH.HUD);
      this.disposables.push(h.barFill);

      // ---- 回合切换提示（初始隐藏，位于竞技场上部、单位上方） ----
      h.toastBg = this.add.graphics();
      h.toastBg.fillStyle(0x0F172A, 0.94);
      h.toastBg.fillRoundedRect(-210, -28, 420, 56, 14);
      h.toastBg.lineStyle(3, 0xFDE047, 1);
      h.toastBg.strokeRoundedRect(-210, -28, 420, 56, 14);

      h.toastText = this.add.text(0, 0, '', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '32px', fontStyle: 'bold', color: COLOR.step
      }).setOrigin(0.5);

      // 位置选在竞技场上部：既不遮住站在高台上的单位（顶部约 y=197），也不越出竞技场
      this.toastContainer = this.add.container(W / 2, 160, [h.toastBg, h.toastText]);
      this.toastContainer.setAlpha(0).setDepth(DEPTH.TOAST);

      this.disposables.push(this.toastContainer, h.toastBg, h.toastText,
        h.turnText, h.stateText, h.teamText, h.timeText);
    }

    /* ==================================================================
     * HUD：信息行
     * ================================================================== */

    buildInfoRow() {
      if (this.hudView) { return; }
      const W = Config.CANVAS.width;
      const h = this.hud;

      // 左：标题 + 版本 + 步骤（左对齐，宽度约 420px）
      h.titleText = this.add.text(48, 82,
        Config.GAME_TITLE + ' v' + Config.VERSION + ' · ' + Config.STEP_LABEL, {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '15px', color: COLOR.step
        }).setDepth(DEPTH.HUD);

      // 中：当前选中单位（居中，宽度约 450px）
      h.selectedText = this.add.text(W / 2, 80, '选中：未选择', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '18px', fontStyle: 'bold', color: COLOR.value
      }).setOrigin(0.5, 0).setDepth(DEPTH.HUD);

      // 右：配置与实例化摘要（右对齐，宽度约 320px）
      h.infoText = this.add.text(W - 40, 83, '', {
        fontFamily: 'Consolas, "Microsoft YaHei", monospace', fontSize: '14px', color: COLOR.label
      }).setOrigin(1, 0).setDepth(DEPTH.HUD);

      this.disposables.push(h.titleText, h.selectedText, h.infoText);
    }

    /* ==================================================================
     * HUD：底部状态条
     *   第 8.7 步：移除屏幕上的「回合日志」显示（标题 + 最近 3 条日志行）。
     *   第 8.8 步：**改成左侧窄条 + 压在道具栏之下，彻底不遮挡道具**：
     *     · 道具栏占右下角 x 1206~1540、y 708~764
     *       （ItemBar：4 格 ×76px + 3×10px 间距，右边距 60、下边距 92）
     *       —— 旧版状态面板整幅横跨 80~1520 且深度 60 > 道具栏 50，
     *          于是面板底色与右对齐的 FPS 正好糊在道具格上；
     *     · 现在面板只占 x 80~1180（与道具栏留 26px 间隙），
     *       深度 STATUS(48) < 道具栏(50)，几何 + 层级双保险；
     *     · 第 8.8 步同时移除了「投掷」调试日志行，面板只剩：操作提示 + FPS。
     * ================================================================== */

    buildBottomPanel() {
      const h = this.hud;
      const panelX = 80;
      const panelW = 1060;               // 80 ~ 1140：给右下角 96px 四格道具栏让位
      if (this.hudView) { return; }
      const panelY = 692;
      const panelH = 56;

      const g = this.add.graphics().setDepth(DEPTH.STATUS);
      g.fillStyle(COLOR.panelBg, 0.9);
      g.fillRoundedRect(panelX, panelY, panelW, panelH, 12);
      g.lineStyle(2, COLOR.panelBorder, 1);
      g.strokeRoundedRect(panelX, panelY, panelW, panelH, 12);
      this.disposables.push(g);

      // 操作提示：左对齐（不再居中，避免长文案伸进右下角道具栏区域）
      h.hintText = this.add.text(panelX + 20, panelY + 8,
        '悬停高亮 · 点击选中 · 拖拽选中单位瞄准 · 点第 4 格「移动」跳跃 · 拖回 / 右键 / ESC 取消', {
          fontFamily: '"Microsoft YaHei", sans-serif', fontSize: '14px', color: COLOR.label
        }).setOrigin(0, 0).setDepth(DEPTH.STATUS);

      // FPS：收在状态条左下角（旧版贴画布右边缘，正好压在道具格上）
      h.fpsText = this.add.text(panelX + 20, panelY + 32, 'FPS --', {
        fontFamily: 'Consolas, monospace', fontSize: '13px', color: COLOR.ok
      }).setOrigin(0, 0).setDepth(DEPTH.STATUS);

      this.disposables.push(h.hintText, h.fpsText);
      this.applyDebugHud();
    }

    applyDebugHud() {
      const dbg = !!(Config.DEBUG && Config.DEBUG.enabled);
      const fps = dbg && Config.DEBUG.showFps !== false;
      const h = this.hud || {};
      if (h.stateText && h.stateText.setVisible) { h.stateText.setVisible(dbg); }
      if (h.titleText && h.titleText.setVisible) { h.titleText.setVisible(dbg); }
      if (h.infoText && h.infoText.setVisible) { h.infoText.setVisible(dbg); }
      if (h.fpsText && h.fpsText.setVisible) { h.fpsText.setVisible(fps); }
      if (h.hintText && h.hintText.setVisible) { h.hintText.setVisible(dbg); }
    }

    /**
     * 第 8.7 步：回合日志不再显示到画面上 → 本方法保留为空实现。
     * 之所以保留：① 场景里 30+ 处调用点无需改动；② 后续若要加「回放 / 调试面板」，
     * 直接在这里重新接上 HUD 文本即可。回合日志数据仍在 TurnManager.getLogText()。
     */
    refreshLogPanel() {
      return false;
    }

    /* ==================================================================
     * HUD：每帧刷新
     * ================================================================== */

    /** 倒计时秒数与进度条同源刷新，避免状态切换瞬间不一致 */
    updateTurnHud() {
      if (!this.turnManager) { return; }
      const cfg = this.turnManager.getConfig();
      const remainMs = this.turnManager.getRemainingTime();
      const secs = this.turnManager.getRemainingSeconds();
      if (this.hudView) {
        this.hudView.updateTimer(remainMs, cfg.turnTime, secs);
        return;
      }
      if (!this.hud.barFill) { return; }

      const ratio = Math.max(0, Math.min(1, remainMs / cfg.turnTime));

      if (this.hud.timeText) {
        this.hud.timeText.setText(secs + 's');
        this.hud.timeText.setColor(secs <= 10 ? COLOR.fail : COLOR.value);
      }

      const W = Config.CANVAS.width;
      const fullW = 270;
      const x = W - 310;
      const y = 54;

      const g = this.hud.barFill;
      g.clear();
      const color = ratio > 0.33 ? 0x22C55E : (ratio > 0.1 ? 0xFACC15 : 0xEF4444);
      g.fillStyle(color, 1);
      g.fillRoundedRect(x, y, Math.max(2, fullW * ratio), 10, 5);
    }

    updateFps(delta) {
      if (!(Config.DEBUG && Config.DEBUG.enabled && Config.DEBUG.showFps !== false)) { return; }
      if (!this.hud.fpsText || (this.hud.fpsText.visible === false)) { return; }
      this.fpsAccumulator += delta;
      if (this.fpsAccumulator < 500) { return; }
      this.fpsAccumulator = 0;
      const fps = Math.round(this.game.loop.actualFps);
      this.hud.fpsText.setText('FPS ' + fps);
      this.hud.fpsText.setColor(fps >= 55 ? COLOR.ok : (fps >= 40 ? COLOR.warn : COLOR.fail));
    }

    /** 显示阵营切换提示（1.2 秒后自动淡出） */
    showTeamToast(label, color) {
      if (this.hudView) { this.hudView.showToast('轮到' + label, color); return; }
      const c = this.toastContainer;
      if (!c) { return; }

      this.hud.toastText.setText('轮到' + label);
      this.hud.toastText.setColor(color);
      this.hud.toastText.setFontSize(32);

      this.tweens.killTweensOf(c);
      c.setAlpha(0).setScale(0.9);
      this.tweens.add({
        targets: c, alpha: 1, scale: 1, duration: 160, ease: 'Back.easeOut',
        onComplete: () => { this.tweens.add({ targets: c, alpha: 0, duration: 400, delay: 700 }); }
      });
    }

    /** 强调提示（超时 / 结束） */
    flashToast(text, color) {
      if (this.hudView) { this.hudView.flashToast(text, color); return; }
      const c = this.toastContainer;
      if (!c) { return; }

      this.hud.toastText.setText(text);
      this.hud.toastText.setColor(color);
      this.hud.toastText.setFontSize(30);

      this.tweens.killTweensOf(c);
      c.setAlpha(1).setScale(1.05);
      this.tweens.add({ targets: c, alpha: 0, duration: 700, delay: 500 });
    }

    /* ==================================================================
     * 第 9 步：敌方 AI（红色方自动决策 / 自动行动）
     *
     *   数据来源全部是配置：
     *     · 决策延迟 / 误差 / 道具权重 / 搜索范围 → FK.Config.AI（gameConfig.js）
     *     · 弹道预测 → FK.TrajectoryPredictor（与投掷实飞同一份积分与碰撞）
     *     · 道具 / 单位 / 冷却 → FK.Configs 与场景既有 provider
     *
     *   单向数据流（与道具栏 / 移动系统同一套纪律）：
     *     TurnManager --turn:start(red)--> AIController --延迟 1~2 秒--> 决策
     *       → ProjectileController.beginThrow / PlacementController.commit / MoveController.commitPlan
     *       → 既有投掷 / 放置 / 移动链路（真实抛物线 + 真实伤害 + 真实回合流转）
     *     AIController --ai:thinking / ai:decided / ai:acted--> BattleScene（只做日志与 HUD）
     *
     *   规则 9：AI 只调用上述既有入口，**不直接改血量、不瞬移、不绕开物理系统**。
     *   规则 11：蓝方（玩家）回合 AI 完全不动（AIController.onTurnStart 会直接取消）。
     * ================================================================== */

    /** 创建敌方 AI 主控（红方）并订阅它的事件 */
    setupAI() {
      if (!FK.AIController || !FK.AIPlanner) {
        console.error('[Battle] AI 未加载：请确认 js/systems/AIPlanner.js 与 js/systems/AIController.js 已在 index.html 中引入');
        return;
      }

      this.aiController = new FK.AIController(this, {
        turnManager: this.turnManager,
        unitSelector: this.unitSelector,
        projectileController: this.projectileController,
        placementController: this.placementController,
        moveController: this.moveController,
        predictor: this.trajectoryPredictor,
        units: () => this.units,
        items: () => (FK.Configs && FK.Configs.items) || [],
        // 道具下发走场景的唯一入口：瞄准力度系数 / 预警圈 / 投掷模块 / 放置模式一起同步
        applyItem: (itemConfig) => this.applyItemForAi(itemConfig),
        // 按阵营的道具冷却（AI 只在红方回合行动，因此这里拿到的就是红方口径）
        cooldown: (itemId) => this.itemCooldownRemaining(itemId),
        canMove: () => !!(this.moveController && this.moveController.canUseMove())
      });

      this.subscribeAIEvents();
      this.log('AI 就绪：红方回合开始后延迟 ' + FK.Config.AI.thinkDelayMs.min + '~' +
        FK.Config.AI.thinkDelayMs.max + 'ms 自动决策（中等难度）');
    }

    /**
     * 第 9 步：AI 的道具下发（比 applyItem 多一步「把道具栏高亮同步过去」）。
     * 道具栏是「选中道具」的唯一真相源：AI 换了道具却不更新它，
     * 玩家回合里格子高亮就会和实际生效的道具不一致。
     * @param {FK.ItemConfig} itemConfig
     */
    applyItemForAi(itemConfig) {
      this.applyItem(itemConfig);
      if (this.itemBar && itemConfig && itemConfig.id && !this.itemBar.isMoveSlotActive()) {
        this.itemBar.select(itemConfig.id, { silent: true, force: true });
      }
    }

    /** 订阅 AI 事件：只用于日志与 HUD，不参与 AI 逻辑 */
    subscribeAIEvents() {
      const E = FK.EVENTS;
      if (!E || !E.AI_THINKING) { return; }
      FK.EventBus.on(E.AI_THINKING, this.onAiThinking, this);
      FK.EventBus.on(E.AI_DECIDED, this.onAiDecided, this);
      FK.EventBus.on(E.AI_ACTED, this.onAiActed, this);
    }

    onAiThinking(payload) {
      this.log('ai:thinking → ' + payload.team + ' 第 ' + payload.turnNumber + ' 回合：' +
        payload.delayMs + 'ms 后行动（己方 ' + payload.unitCount + ' / 敌方 ' +
        payload.enemyCount + '，难度 ' + payload.difficulty + '）');
      if (this.hudView) {
        this.hudView.showToast((FK.HUD.COPY() || {}).aiThinking || '敌方思考中…', '#F87171');
      }
    }

    onAiDecided(payload) {
      this.lastAiDecided = payload;
      const land = payload.predictedLanding
        ? ('(' + Math.round(payload.predictedLanding.x) + ',' + Math.round(payload.predictedLanding.y) + ')')
        : '-';
      const dist = (payload.distancePx === null || payload.distancePx === undefined)
        ? '-' : (Math.round(payload.distancePx) + 'px');
      this.log('ai:decided → ' + (payload.actionLabel || payload.action) +
        ' · ' + (payload.itemId || '-') +
        ' · 单位 ' + (payload.unitId || '-') + ' → 目标 ' + (payload.targetId || '-') +
        ' · 力度 ' + Math.round((payload.powerRatio || 0) * 100) + '%' +
        ' · 角度 ' + Math.round(payload.angleDeg || 0) + '°' +
        ' · 预测落点 ' + land + ' · 落点误差 ' + dist +
        (payload.reachable ? '（在容忍范围内）' : '（超出容忍范围）') +
        ' · 候选 ' + payload.candidateCount + ' 个 / 能打到 ' + payload.hittableCount + ' 个');
    }

    onAiActed(payload) {
      this.lastAiActed = payload;
      this.log('ai:acted → ' + (payload.actionLabel || payload.action) +
        ' ' + (payload.success ? '成功' : '失败') +
        ' · v=(' + Math.round(payload.vx || 0) + ',' + Math.round(payload.vy || 0) + ')' +
        ' · 落点 ' + (payload.landing
          ? '(' + Math.round(payload.landing.x) + ',' + Math.round(payload.landing.y) + ')' : '-'));
    }

    /** 底部状态条：AI 回合的提示文案（玩家此时无需操作） */
    aiHintText() {
      const ai = this.aiController;
      if (!ai || !ai.isBusy()) { return ''; }
      return '轮到红色方：' + ai.getHintText() +
        (ai.isWaiting() ? ' · 玩家无需操作' : '');
    }

    /* ==================================================================
     * 第 8 步：落水判定 / 死亡判定 / 胜负结算
     *
     *   数据来源全部是配置与地图数据（不硬编码）：
     *     · 水面高度        → data/map.json → waterLevel → worldColliders.waterLevel
     *     · 支撑面（地形）  → worldColliders.platforms（掉下平台才会落水）
     *     · 动画时长 / 颜色 / 缩放倍数 / 闪红次数 → FK.Config.DEATH
     *     · 覆盖层透明度 / 文案 / 按钮尺寸        → FK.Config.RESULT
     *     · 玩家阵营（胜负分流）                  → FK.Config.VICTORY.playerTeam
     *   编排：
     *     DamageSystem 结算完伤害 → handleDamageSettled()（规则 2：只在伤害后检查血量）
     *     update() 每帧         → settleDeaths()    （规则 1：任何位移导致落水都要判）
     *     有单位死亡            → judgeVictory()    （规则 3：每次死亡后立即检查胜负）
     * ================================================================== */

    /** 创建落水/死亡判定系统、胜负判定系统与死亡占位动画（必须晚于 setupAiming） */
    setupDeaths() {
      if (!FK.DeathSystem || !FK.VictorySystem) {
        console.error('[Battle] 判定系统未加载：请确认 DeathSystem.js / VictorySystem.js 已在 index.html 中引入');
        return;
      }

      this.deathSystem = new FK.DeathSystem({
        eventBus: FK.EventBus,
        // 水面像素 y：来自 data/map.json 的 waterLevel（经 buildWorldColliders 换算）
        waterLevelY: this.worldColliders ? this.worldColliders.waterLevel : null,
        turnNumber: () => (this.turnManager ? this.turnManager.getTurnNumber() : 0),
        debug: FK.Config.DEBUG.enabled
      });

      this.victorySystem = new FK.VictorySystem({
        eventBus: FK.EventBus,
        playerTeam: FK.Config.VICTORY.playerTeam,
        turnNumber: () => (this.turnManager ? this.turnManager.getTurnNumber() : 0),
        debug: FK.Config.DEBUG.enabled
      });

      if (FK.DeathEffect) {
        this.deathEffect = new FK.DeathEffect(this, { debug: FK.Config.DEBUG.enabled });
      } else {
        console.error('[Battle] 死亡动画未加载：请确认 js/ui/DeathEffect.js 已在 index.html 中引入');
      }

      this.dying = [];
      this.lastVictory = null;
      this.subscribeDeathEvents();
    }

    /** 结算界面（监听 game:victory / game:defeat / game:draw；按钮回调本场景重置） */
    setupResultPanel() {
      if (!FK.ResultPanel) {
        console.error('[Battle] 结算界面未加载：请确认 js/ui/ResultPanel.js 已在 index.html 中引入');
        return;
      }
      this.resultPanel = new FK.ResultPanel(this, {
        onRestart: () => this.restartBattle(),
        onTitle: () => this.returnToTitle()
      });
    }

    returnToTitle() {
      this.scene.start('Boot');
    }

    /** 订阅死亡 / 胜负事件（只用于日志与 HUD，判定与结算在各自的系统里） */
    subscribeDeathEvents() {
      const E = FK.EVENTS;
      if (E.UNIT_DIED) { FK.EventBus.on(E.UNIT_DIED, this.onUnitDied, this); }
      if (E.UNIT_DROWNED) { FK.EventBus.on(E.UNIT_DROWNED, this.onUnitDrowned, this); }
      if (E.GAME_VICTORY) { FK.EventBus.on(E.GAME_VICTORY, this.onGameResult, this); }
      if (E.GAME_DEFEAT) { FK.EventBus.on(E.GAME_DEFEAT, this.onGameResult, this); }
      if (E.GAME_DRAW) { FK.EventBus.on(E.GAME_DRAW, this.onGameResult, this); }
    }

    onUnitDied(payload) {
      if (payload && payload.reason === 'drowned' && FK.SoundSystem) {
        FK.SoundSystem.play('splash');
      }
      const pos = payload.position || {};
      this.log('unit:died → ' + payload.unitId + '(' + payload.team + ') 原因 ' + payload.reason +
        ' @(' + pos.x + ',' + pos.y + ') 第 ' + payload.turnNumber + ' 回合');
      this.refreshLogPanel();
    }

    onUnitDrowned(payload) {
      if (FK.SoundSystem) { FK.SoundSystem.play('splash'); }
      const pos = payload.position || {};
      this.log('unit:drowned → ' + payload.unitId + ' 落入果汁池 @(' + pos.x + ',' + pos.y + ')');
      this.refreshLogPanel();
    }

    onGameResult(payload) {
      this.lastVictoryPayload = payload;
      this.refreshLogPanel();
    }

    /* ---------------- 判定 ---------------- */

    /** 是否已进入 GAME_OVER 终态（输入禁止、倒计时停止的判据） */
    isGameOver() {
      const tm = this.turnManager;
      if (!tm || typeof tm.getState !== 'function') { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : null;
      return !!(S && tm.getState() === S.GAME_OVER);
    }

    /** 结算文案（与结算界面同源：FK.Config.RESULT.labels） */
    getVictoryLabel() {
      const L = (FK.Config.RESULT && FK.Config.RESULT.labels) ? FK.Config.RESULT.labels : {};
      if (this.lastVictory) {
        if (this.lastVictory.outcome === 'draw') { return L.draw || '平局'; }
        return L[this.lastVictory.winner] || '';
      }
      if (this.resultPanel && this.resultPanel.getTitle()) { return this.resultPanel.getTitle(); }
      return L.draw || '平局';
    }

    /** 每帧落水检测（规则 1）：任何位移导致落水都要判，不只在击退时 */
    settleDeaths() {
      if (!this.deathSystem) { return 0; }
      return this.handleDeaths(this.deathSystem.checkDrowning(this.units || []));
    }

    /** 伤害结算后的血量归零检查（规则 2：由 DamageSystem 的回调触发，不每帧轮询） */
    handleDamageSettled(units) {
      if (!this.deathSystem) { return 0; }
      return this.handleDeaths(this.deathSystem.checkHpZero(units || []));
    }

    /**
     * 一批死亡记录的落地处理：
     *   ① 先把它们从「参战列表」里全部摘掉（规则 2：不能成为后续目标、不参与碰撞）
     *   ② 播放占位动画（落水 200ms 半透明蓝缩小 / 血量归零 400ms 闪红两次再缩小）
     *   ③ 摘完之后再判胜负（规则 3），保证存活统计已经是死亡之后的口径
     * @returns {number} 本批死亡数量
     */
    handleDeaths(records) {
      const list = records || [];
      if (list.length === 0) { return 0; }
      list.forEach(function (rec) { this.detachUnit(rec.unit, rec.reason); }, this);
      this.judgeVictory();
      this.refreshInfoRow();
      return list.length;
    }

    /**
     * 阵亡单位出列（规则 2 的四张列表）：
     *   · 单位列表（UnitSpawner 管理的数组）
     *   · UnitSelector 的可选列表
     *   · 投掷物碰撞检测的单位列表   ← 与场景 `this.units` 同源（`() => this.units`）
     *   · PlacementController 的单位列表 ← 同上
     *   三处列表在创建单位时共享同一个数组引用，因此这里只需要 splice 一次。
     */
    detachUnit(unit, reason) {
      if (!unit) { return false; }
      const i = this.units ? this.units.indexOf(unit) : -1;
      if (i >= 0) { this.units.splice(i, 1); }
      if (this.unitSpawner) { this.unitSpawner.removeUnit(unit); }
      if (this.unitSelector) { this.unitSelector.removeUnit(unit); }
      if (this.aimController && typeof this.aimController.getUnit === 'function' &&
          this.aimController.getUnit() === unit) {
        this.aimController.cancelAim('unit-died');
      }
      this.dying.push(unit);

      const self = this;
      if (this.deathEffect) {
        this.deathEffect.play(unit, reason, function (u) { self.removeFromField(u); });
      } else {
        this.removeFromField(unit);
      }
      return true;
    }

    /** 死亡动画播完：把单位真正从战场移除（位置数据不清空，只是不再显示） */
    removeFromField(unit) {
      if (!unit) { return; }
      const i = this.dying.indexOf(unit);
      if (i >= 0) { this.dying.splice(i, 1); }
      this.log('单位退场：' + this.displayNameOf(unit) +
        (unit.getDeadReason ? '（' + unit.getDeadReason() + '）' : ''));
      if (typeof unit.destroy === 'function') { unit.destroy(); }
      else if (unit.module && typeof unit.module.destroy === 'function') { unit.module.destroy(unit); }
    }

    /**
     * 胜负判定（规则 3）：每次有单位死亡后立即调用一次。
     * 有结果 → 广播 game:victory / game:defeat / game:draw（由 VictorySystem 负责），
     * 随后进入 GAME_OVER 终态：停倒计时、停输入、停止后续伤害。
     * @returns {Object|null} 判定结果
     */
    judgeVictory() {
      if (!this.victorySystem || !this.turnManager) { return null; }
      if (this.isGameOver() || this.victorySystem.isSettled()) {
        return this.victorySystem.getLastResult();
      }

      const result = this.victorySystem.settle(this.units || []);
      if (!result.outcome) { return result; }

      this.lastVictory = result;
      this.log('胜负判定：' + result.outcome + '（蓝存活 ' + result.blueAlive +
        ' / 红存活 ' + result.redAlive + '）');
      this.enterGameOver(result);
      return result;
    }

    enterGameOver(result) {
      if (this.aimController && typeof this.aimController.isAiming === 'function' && this.aimController.isAiming()) {
        this.aimController.cancelAim('game-over');
      }
      if (this.unitSelector) { this.unitSelector.deselect('game-over'); }
      if (this.itemBar) { this.itemBar.setEnabled(false); }
      if (this.moveController) {
        if (this.moveController.isPlanning()) { this.moveController.cancelPlan('game-over'); }
        this.moveController.setMoveActive(false);
      }
      if (this.projectileController) { this.projectileController.suspendDamage(); }
      if (this.damageSystem) { this.damageSystem.setDamageEnabled(false); }
      if (this.turnManager) { this.turnManager.gameOver(result.outcome, result.winner || 'draw'); }
      this.refreshLogPanel();
      return result;
    }

    /* ---------------- 支撑面（掉下平台 → 落水） ---------------- */

    /**
     * 当前 x 处的支撑面顶面 y（像素）；没有支撑面返回 null。
     * 第 8.7 步起：**地形平台 + 木箱顶面**都算落脚点（同一份世界像素 AABB 口径），
     * 因此「击退结束后单位会被吸附到下方最近的平台 / 木箱顶面」，不会再悬空。
     */
    buildSupportY(x, y) {
      const platforms = (this.worldColliders && this.worldColliders.platforms) || [];
      const crates = (this.obstacleRegistry && typeof this.obstacleRegistry.getRects === 'function')
        ? this.obstacleRegistry.getRects() : [];
      const tolerance = FK.Config.DEATH.supportTolerancePx;
      let best = null;
      const consider = function (left, top, width) {
        if (x < left || x > left + width) { return; }   // 不在该落脚点的横向范围内
        if (top < y - tolerance) { return; }            // 顶面明显在单位上方 → 不是落脚点
        if (best === null || top < best) { best = top; }
      };
      for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        consider(p.x, p.y, p.width);
      }
      for (let j = 0; j < crates.length; j++) {
        const c = crates[j];
        consider(c.x, c.y, c.width);
      }
      return best;
    }

    /** 把支撑面 + 水面高度注入全部单位（场景创建 / 重建单位后调用一次） */
    injectSupportWorld() {
      const self = this;
      if (!this.units) { return; }
      this.units.forEach(function (u) {
        if (!u) { return; }
        if (typeof u.setSupportProvider === 'function') {
          u.setSupportProvider(function (x, y) { return self.buildSupportY(x, y); });
        }
        // 第 8.7 步：水面高度（悬空自愈时的「落水优先」判据，与 DeathSystem 同源）
        if (typeof u.setWaterLevelProvider === 'function') {
          u.setWaterLevelProvider(function () {
            return self.worldColliders ? self.worldColliders.waterLevel : null;
          });
        }
      });
    }

    /* ---------------- 「再来一局」 ---------------- */

    /**
     * 重置对局（结算界面的「再来一局」按钮 → ResultPanel.onRestart → 这里）：
     *   · 所有单位恢复满血（阵亡单位一并复活回出生点）
     *   · 所有木箱清除 / 冷却清空 / 投掷与放置收尾
     *   · 回合数重置为 1、当前阵营回到先手（蓝方）、状态回到 SELECT_UNIT
     */
    restartBattle() {
      if (!this.turnManager) { return false; }
      if (FK.SoundSystem) { FK.SoundSystem.play('click'); }
      this.log('再来一局：重置对局');

      // ① 停掉进行中的一切（死亡动画 / 瞄准 / 放置 / 投掷 / 移动 / 木箱 / 冷却 / 结算界面）
      if (this.deathEffect) { this.deathEffect.finishAll(); }
      if (this.aimController && typeof this.aimController.isAiming === 'function' && this.aimController.isAiming()) {
        this.aimController.cancelAim('restart');
      }
      // 第 8.5 步：移动状态复位（正在飞的单位立刻停下）
      if (this.moveController) { this.moveController.reset(); }
      // 第 9 步：AI 复位（清空待决策 / 正在行动的计划与统计；随后 turn:start 会重新排定）
      if (this.aiController) { this.aiController.reset('restart'); }
      this.lastAiDecided = null;
      this.lastAiActed = null;
      if (this.placementController) { this.placementController.stop('restart', { silent: true }); }
      if (this.projectileController) { this.projectileController.resetForNewTurn(); }
      // 解除 GAME_OVER 期间设下的伤害硬开关（控制器的闸门此时已由 resumeDamage 复位）
      if (this.damageSystem) { this.damageSystem.setDamageEnabled(null); }
      if (this.obstacleRegistry) { this.obstacleRegistry.clear('restart'); }
      if (this.itemCooldown) { this.itemCooldown.clear(); }
      if (this.resultPanel) { this.resultPanel.hide(); }

      // ② 重建全部单位（全满血、全部回到出生点；阵亡的也一起复活）
      this.dying.forEach(function (u) {
        if (u && typeof u.destroy === 'function') { u.destroy(); }
      });
      this.dying = [];
      if (this.unitSpawner) {
        this.unitSpawner.destroyAll();
        this.unitSpawner.clearFailed();
        this.unitSpawner.resetSpawnKeys();
        const units = this.unitSpawner.spawn();
        this.units = units;
        units.forEach(function (u) { u.setDepth(DEPTH.UNIT); });
        if (this.unitSelector) { this.unitSelector.setUnits(units); }
        this.injectBounceWorld();
        this.injectSupportWorld();
      }

      // ③ 判定系统 / 道具栏 / 模式条 / 冷却复位
      if (this.deathSystem) { this.deathSystem.reset(); }
      if (this.victorySystem) { this.victorySystem.reset(); }
      this.lastVictory = null;
      this.lastVictoryPayload = null;
      // 第 8.5 / 8.6 步：道具栏恢复可用并回到「樱桃炸弹」；「移动」格次数复位
      if (this.moveController) { this.moveController.reset(); }
      if (this.itemBar) {
        this.itemBar.setEnabled(true);
        this.itemBar.setMoveSlotActive(false, { silent: true, force: true, reason: 'restart' });
        this.itemBar.refresh();
        this.itemBar.select(FK.Config.AIM.defaultItemId, { force: true, silent: true });
        this.applyItem(this.itemBar.getSelected());
      }

      // ④ 回合复位：第 1 回合、蓝方先手、TURN_START → SELECT_UNIT
      this.turnManager.reset();
      this.turnManager.start();

      this.refreshInfoRow();
      this.refreshLogPanel();
      this.updateThrowHud();
      return true;
    }

    /* ==================================================================
     * 其他
     * ================================================================== */

    buildBackdrop() {
      const bg = Config.BACKGROUND;
      const photo = !!(bg && bg.enabled !== false);
      const img = (typeof document !== 'undefined') ? document.getElementById('battle-bg') : null;
      if (img) { img.style.display = 'none'; }
      if (!photo) {
        this.cameras.main.setBackgroundColor(Config.CANVAS.backgroundColor);
        return;
      }
      this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
      this.drawProceduralOrchard();
    }

    drawProceduralOrchard() {
      const W = Config.CANVAS.width;
      const H = Config.CANVAS.height;
      const g = this.add.graphics();
      g.setDepth(-100);
      g.setScrollFactor(0);

      let i;
      for (i = 0; i < 20; i++) {
        const t = i / 19;
        const col = Phaser.Display.Color.GetColor(
          Math.round(110 + 70 * t),
          Math.round(175 + 45 * t),
          Math.round(245 - 8 * t)
        );
        g.fillStyle(col, 1);
        g.fillRect(0, Math.floor(H * 0.58 * t), W, Math.ceil(H * 0.58 / 20) + 2);
      }

      g.fillStyle(0xFFFFFF, 0.92);
      const clouds = [
        [180, 90, 70], [420, 70, 90], [780, 110, 80], [1100, 60, 100], [1420, 95, 75]
      ];
      for (i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        g.fillCircle(c[0], c[1], c[2]);
        g.fillCircle(c[0] - c[2] * 0.7, c[1] + 10, c[2] * 0.62);
        g.fillCircle(c[0] + c[2] * 0.75, c[1] + 8, c[2] * 0.68);
      }

      g.fillStyle(0x5F9A4A, 1);
      g.fillCircle(280, H * 0.72, 260);
      g.fillStyle(0x4E8A3E, 1);
      g.fillCircle(900, H * 0.76, 300);
      g.fillStyle(0x3F7A34, 1);
      g.fillCircle(1450, H * 0.74, 240);

      g.fillStyle(0x8ED46A, 1);
      g.fillRect(0, H * 0.55, W, H * 0.45);
      g.fillStyle(0x6FBF55, 1);
      g.fillRect(0, H * 0.68, W, H * 0.32);
      g.fillStyle(0x5EAA48, 1);
      g.fillRect(0, H * 0.82, W, H * 0.18);

      const trees = [
        [120, H * 0.62, 0xEF4444],
        [260, H * 0.58, 0xF59E0B],
        [480, H * 0.64, 0xA855F7],
        [1280, H * 0.60, 0xF97316],
        [1460, H * 0.63, 0xEAB308]
      ];
      for (i = 0; i < trees.length; i++) {
        const t = trees[i];
        g.fillStyle(0x8B5A2B, 1);
        g.fillRect(t[0] - 8, t[1], 16, 70);
        g.fillStyle(0x4ADE80, 1);
        g.fillCircle(t[0], t[1] - 10, 42);
        g.fillStyle(0x22C55E, 1);
        g.fillCircle(t[0] - 22, t[1] + 6, 26);
        g.fillCircle(t[0] + 24, t[1] + 4, 24);
        g.fillStyle(t[2], 1);
        g.fillCircle(t[0] - 12, t[1] - 8, 7);
        g.fillCircle(t[0] + 14, t[1] - 2, 7);
        g.fillCircle(t[0] + 2, t[1] + 12, 6);
      }

      const veil = this.add.rectangle(W * 0.5, H * 0.5, W, H, 0x000000, 0.35);
      veil.setDepth(-99);
      veil.setScrollFactor(0);
    }

    log(msg) {
      if (Config.DEBUG.enabled) { console.log('[Battle] ' + msg); }
    }
  }

  FK.BattleScene = BattleScene;
})();
