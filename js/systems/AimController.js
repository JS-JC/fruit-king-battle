/**
 * ============================================================
 * AimController.js —— 瞄准控制器
 * ============================================================
 * 职责：
 *   把「鼠标拖拽」翻译成「投掷参数（力度 / 角度 / 初速度）」，
 *   并驱动 TrajectoryPredictor 计算轨迹，其余全部通过 EventBus 广播。
 *
 * 交互流程：
 *   pointerdown（左键，在已选中单位上） → aim:start
 *   pointermove                          → 重算参数与轨迹 → aim:update + aim:trajectoryReady
 *   pointerup                            → aim:end（本步不投掷）
 *   pointerdown（右键）/ ESC             → aim:cancel
 *   **拖回起始单位附近（第 7.7 步）**     → aim:cancel（reason='drag-back'，等同 ESC）
 *   turn:switch / turn:end / turn:timeout / unit:selected / unit:deselected
 *                                        → aim:cancel（自动取消，防呆）
 *
 * 第 7.7 步：瞄准取消的第三种方式（阈值全部读 FK.Config.AIM，不硬编码）
 *   · 判据①：拖拽距离 < AIM.cancelDragPx（默认 20px）→ 认为「拖回来了」
 *   · 判据②：指针回到单位碰撞半径 × AIM.cancelRadiusFactor（默认 1.2 倍）以内
 *   两者任一命中就取消本次瞄准，复用同一个 aim:cancel 事件（不新增事件常量）。
 *   关键点：必须先「拖出去」（armed）才会触发取消——
 *   所以「按下去没动」不会误取消，而拖出去之后松手仍是正常投掷；
 *   反过来，拖出去又拖回来，抛物线立即消失，此时松手不会投掷。
 *   放置类道具（水果箱）根本不进入本类的瞄准分支，因此不受影响。
 *
 * 第 7.5 步：按道具类型分流（isPlacementItem / getInteractionMode）
 *   · type = 'explosive'（樱桃、西瓜）→ 走本类的抛物线分支（原逻辑不变）
 *   · type = 'obstacle'（水果箱）      → **不进入瞄准**，鼠标交给
 *     FK.PlacementController 的点击放置分支，因此也不会画出抛物线轨迹
 *
 * 映射规则（核心手感）：
 *   拖拽方向与投掷方向**相反**（弹弓手感）：向后拉 → 向前上方飞出
 *   力度 = clamp(拖拽距离 / maxDragPx, 0, 1)，并带 minPowerRatio 下限保护
 *   角度 = 投掷方向（拖拽反向）与水平面的夹角，覆盖 360°（不再受单位朝向限制）
 *   速度 = maxSpeed × 道具 range 系数 × 力度
 *
 * 依赖：FK.Config、FK.EventBus、FK.EVENTS、FK.TrajectoryPredictor、Phaser 输入事件
 * 对外：FK.AimController（含静态方法 computeShot）
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const EPS = 1e-9;

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /**
   * 纯函数：拖拽向量 → 投掷参数（不依赖 Phaser，可单独测试）
   *
   * 第 7 步变更：**支持 360° 全向投掷**。
   *   投掷方向 = 拖拽方向的反向（弹弓手感），方向向量直接决定 vx/vy，
   *   不再乘单位朝向、不再把角度钳制到 ±90°。
   *   因此「向上高抛」「向左平抛」等任意方向都能投出（抛物线允许飞到屏幕上方）。
   *
   * @param {Object} input
   *   dragX, dragY      拖拽向量（世界像素，y 向下为正）
   *   maxDragPx         最大拖拽距离
   *   minPowerRatio     力度下限
   *   maxSpeed          满力基准速度（px/s）
   *   itemRange         道具力度系数（ItemConfig.range）
   *   angleLimitDeg     角度安全上限（度），默认 180（全平面）
   * @returns {Object} { dist, powerRatio, effectivePower, angleDeg, speed, vx, vy, dirX, dirY }
   */
  function computeShot(input) {
    const dragX = num(input.dragX, 0);
    const dragY = num(input.dragY, 0);
    const maxDragPx = Math.max(1, num(input.maxDragPx, 180));
    const minPowerRatio = clamp(num(input.minPowerRatio, 0.15), 0, 1);
    const maxSpeed = num(input.maxSpeed, 1200);
    const itemRange = num(input.itemRange, 1);
    const speedScale = num(input.speedScale, 1);
    const angleLimitDeg = num(input.angleLimitDeg, 180);

    const dist = Math.sqrt(dragX * dragX + dragY * dragY);

    // 力度：钳制到 [0, 1]
    const powerRatio = clamp(dist / maxDragPx, 0, 1);

    // 投掷方向 = 拖拽方向的反向（360°，无朝向限制）
    let dirX = 0;
    let dirY = 0;
    if (dist > EPS) {
      dirX = -dragX / dist;
      dirY = -dragY / dist;
    } else {
      // 零距离（刚按下还没拖）：给一个水平向右的兜底方向，配合 minPowerRatio 出一点速度
      dirX = 1;
      dirY = 0;
    }

    // 角度：与水平方向的夹角，向上为正，范围 [-180, 180]（覆盖全平面）
    let angleDeg = Math.atan2(-dirY, dirX) * 180 / Math.PI;
    angleDeg = clamp(angleDeg, -angleLimitDeg, angleLimitDeg);

    // 初速度：满力速度 × 道具系数 × 力度（带下限保护，避免原地掉落）
    const effectivePower = Math.max(powerRatio, minPowerRatio);
    const speed = maxSpeed * itemRange * effectivePower * Math.max(0.05, speedScale);
    const rad = angleDeg * Math.PI / 180;

    return {
      dist: dist,
      powerRatio: powerRatio,
      effectivePower: effectivePower,
      angleDeg: angleDeg,
      speed: speed,
      vx: Math.cos(rad) * speed,
      vy: -Math.sin(rad) * speed,
      dirX: dirX,
      dirY: dirY
    };
  }

  class AimController {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   unitSelector 选区块（提供 getSelected）
     *   predictor    TrajectoryPredictor 实例
     *   turnManager  TurnManager 实例（提供 getCurrentTeam）
     */
    constructor(scene, opts) {
      opts = opts || {};
      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};

      this.scene = scene;
      this.unitSelector = opts.unitSelector || null;
      this.predictor = opts.predictor || null;
      this.turnManager = opts.turnManager || null;

      this.maxDragPx = num(opts.maxDragPx, num(A.maxDragPx, 180));
      this.minPowerRatio = num(opts.minPowerRatio, num(A.minPowerRatio, 0.15));
      this.angleLimitDeg = num(opts.angleLimitDeg, num(A.angleLimitDeg, 180));
      this.maxSpeed = num(opts.maxSpeed, num(A.maxSpeed, 1200));
      this.launchOffsetYUnits = num(opts.launchOffsetYUnits, num(A.launchOffsetYUnits, -0.3));
      this.pxPerUnit = num(opts.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));

      /** 第 7.7 步：拖回单位附近即取消瞄准的两个阈值（来自 FK.Config.AIM） */
      this.cancelDragPx = num(opts.cancelDragPx, num(A.cancelDragPx, 20));
      this.cancelRadiusFactor = num(opts.cancelRadiusFactor, num(A.cancelRadiusFactor, 1.2));

      /** 当前道具配置（提供 range 与 radius）；第 7 步起由道具栏切换 */
      this.item = opts.item || null;

      /**
       * 第 8.6 步：() => boolean —— 道具栏第 4 格「移动」是否被选中。
       * 选中移动时本控制器完全不接管鼠标（拖拽归 MoveController），
       * 保证「拖拽时只会出现一条抛物线」，且樱桃 / 西瓜的投掷不会被抢输入。
       */
      this.isMoveActive = (typeof opts.isMoveActive === 'function') ? opts.isMoveActive : null;

      this.aiming = false;
      this.unit = null;
      this.dragStart = { x: 0, y: 0 };
      this.lastPointer = { x: 0, y: 0 };
      this.shot = null;
      this.trajectory = null;
      this.elapsedMs = 0;
      /**
       * 第 7.7 步：本次拖拽是否已经「拖出去」（离开取消区）。
       * 只有 armed 之后回到取消区才会取消瞄准，避免按下瞬间（拖拽距离为 0）被误判。
       */
      this.dragArmed = false;

      this.onPointerDownBound = this.onPointerDown.bind(this);
      this.onPointerMoveBound = this.onPointerMove.bind(this);
      this.onPointerUpBound = this.onPointerUp.bind(this);
      this.onEscBound = this.onEsc.bind(this);
      this.onTurnChangeBound = this.onTurnChange.bind(this);
      this.onSelectionChangeBound = this.onSelectionChange.bind(this);

      this.bindInput();
    }

    /** 注册鼠标 / 键盘监听 */
    bindInput() {
      const input = this.scene && this.scene.input;
      if (!input) { return; }

      input.on('pointerdown', this.onPointerDownBound);
      input.on('pointermove', this.onPointerMoveBound);
      input.on('pointerup', this.onPointerUpBound);

      // 右键要用来取消瞄准，先关掉浏览器右键菜单
      if (input.mouse && typeof input.mouse.disableContextMenu === 'function') {
        input.mouse.disableContextMenu();
      }
      if (input.keyboard && typeof input.keyboard.on === 'function') {
        input.keyboard.on('keydown-ESC', this.onEscBound);
      }

      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.on(FK.EVENTS.TURN_SWITCH, this.onTurnChangeBound);
        FK.EventBus.on(FK.EVENTS.TURN_END, this.onTurnChangeBound);
        FK.EventBus.on(FK.EVENTS.TURN_TIMEOUT, this.onTurnChangeBound);
        FK.EventBus.on(FK.EVENTS.UNIT_SELECTED, this.onSelectionChangeBound);
        FK.EventBus.on(FK.EVENTS.UNIT_DESELECTED, this.onSelectionChangeBound);
      }
    }

    /* ==================================================================
     * 输入处理
     * ================================================================== */

    /** 左键在「已选中单位」上按下 → 进入瞄准 */
    onPointerDown(pointer) {
      if (!pointer) { return; }

      // 右键：取消瞄准
      if (typeof pointer.rightButtonDown === 'function' && pointer.rightButtonDown()) {
        if (this.aiming) { this.cancelAim('right-click'); }
        return;
      }
      if (this.isPlayerInputBlocked()) { return; }
      // 只响应左键
      if (typeof pointer.leftButtonDown === 'function' && !pointer.leftButtonDown()) { return; }

      /**
       * 第 7.5 步：放置类道具（水果箱）**不进入抛物线瞄准**。
       * 它的鼠标交互由 FK.PlacementController 全权接管（点击放置），
       * 这里直接放行，保证「选中水果箱后不再显示抛物线轨迹」。
       */
      if (this.isPlacementItem()) { return; }

      /**
       * 第 8.6 步：道具栏第 4 格「移动」被选中时，鼠标交给 MoveController。
       * 若这里也进入瞄准，同一次拖拽会同时画出投掷与移动两条抛物线（旧版 bug）。
       */
      if (this.isMoveSelected()) { return; }

      if (this.aiming) { return; }

      const unit = this.unitSelector ? this.unitSelector.getSelected() : null;
      if (!unit) { return; }
      if (!this.canAim(unit)) { return; }

      const wx = num(pointer.worldX, unit.x);
      const wy = num(pointer.worldY, unit.y);

      // 必须按在选中单位身上
      if (typeof unit.containsPoint === 'function' && !unit.containsPoint(wx, wy)) { return; }

      this.startAim(unit, wx, wy);
    }

    /** 拖拽中：更新参数与轨迹 */
    onPointerMove(pointer) {
      if (!this.aiming || !pointer) { return; }
      this.lastPointer.x = num(pointer.worldX, this.lastPointer.x);
      this.lastPointer.y = num(pointer.worldY, this.lastPointer.y);
      this.updateAim(this.lastPointer.x, this.lastPointer.y);
    }

    /** 松手：结束瞄准（本步不投掷） */
    onPointerUp() {
      if (!this.aiming) { return; }
      this.endAim();
    }

    /** ESC：取消瞄准 */
    onEsc() {
      if (!this.aiming) { return; }
      this.cancelAim('escape');
    }

    /** 回合切换 / 结束 / 超时 → 自动取消 */
    onTurnChange(payload) {
      if (!this.aiming) { return; }
      const reason = (payload && payload.reason) ? ('turn-' + payload.reason) : 'turn-change';
      this.cancelAim(reason);
    }

    /** 选中单位变化 → 自动取消 */
    onSelectionChange() {
      if (!this.aiming) { return; }
      this.cancelAim('selection-changed');
    }

    /* ==================================================================
     * 瞄准生命周期
     * ================================================================== */

    /** 是否允许瞄准该单位（只允许当前回合阵营；第 8 步起 GAME_OVER 后一律禁止） */
    canAim(unit) {
      if (!unit) { return false; }
      if (unit.alive === false) { return false; }
      if (this.isInputBlocked()) { return false; }
      const team = (this.turnManager && typeof this.turnManager.getCurrentTeam === 'function')
        ? this.turnManager.getCurrentTeam() : null;
      if (team !== null && unit.getTeam() !== team) { return false; }
      const lock = (this.unitSelector && typeof this.unitSelector.getActionLockUnit === 'function')
        ? this.unitSelector.getActionLockUnit() : null;
      if (lock && unit !== lock) { return false; }
      return true;
    }

    /**
     * 第 8 步：是否处于「禁止输入」状态。
     * 判据 = 回合状态机的终态 GAME_OVER，因此重开对局后无需额外复位。
     */
    isInputBlocked() {
      const tm = this.turnManager;
      if (!tm || typeof tm.getState !== 'function') { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : null;
      return !!(S && tm.getState() === S.GAME_OVER);
    }

    /** 玩家指针锁定：终态或 AI 回合（不影响 beginThrow 程序入口） */
    isPlayerInputBlocked() {
      if (this.isInputBlocked()) { return true; }
      if (FK.Config && typeof FK.Config.isPaused === 'function' && FK.Config.isPaused()) { return true; }
      return !!(FK.Config && typeof FK.Config.isAiTurn === 'function' &&
        FK.Config.isAiTurn(this.turnManager));
    }

    /**
     * 第 7.5 步：当前道具是否为「放置类」（ItemConfig.type === 'obstacle'）。
     * 放置类道具走 FK.PlacementController 的点击放置分支，与抛物线投掷互斥。
     *   ✓ 按下道具时切回投掷模式（道具栏是唯一真相源）
     */
    isPlacementItem(itemConfig) {
      const it = itemConfig || this.item;
      return !!(it && it.type === 'obstacle');
    }

    /**
     * 第 8.6 步：道具栏第 4 格「移动」是否被选中。
     * 选中移动时，鼠标完全交给 FK.MoveController（拖拽单位起跳），
     * **本控制器不再进入瞄准、也不再画投掷抛物线** ——
     * 这是「拖拽时只出现一条抛物线」的根因修复（旧版两个控制器抢同一个拖拽）。
     * @returns {boolean}
     */
    isMoveSelected() {
      if (typeof this.isMoveActive === 'function') {
        try { return !!this.isMoveActive(); } catch (e) { return false; }
      }
      return false;
    }

    /**
     * 当前鼠标交互模式（HUD / 自检用）
     * @returns {'move'|'place'|'throw'}
     */
    getInteractionMode() {
      if (this.isMoveSelected()) { return 'move'; }
      return this.isPlacementItem() ? 'place' : 'throw';
    }

    /**
     * 进入瞄准
     * @param {FK.UnitBase} unit
     * @param {number} worldX
     * @param {number} worldY
     */
    startAim(unit, worldX, worldY) {
      if (!unit || this.aiming) { return false; }
      if (!this.canAim(unit)) { return false; }
      // 第 7.5 步：放置类道具没有抛物线瞄准
      if (this.isPlacementItem()) { return false; }

      this.aiming = true;
      this.unit = unit;
      this.dragStart.x = num(worldX, unit.x);
      this.dragStart.y = num(worldY, unit.y);
      this.lastPointer.x = this.dragStart.x;
      this.lastPointer.y = this.dragStart.y;
      this.elapsedMs = 0;
      this.dragArmed = false;          // 第 7.7 步：刚按下时还没有拖出去

      if (typeof unit.setAiming === 'function') { unit.setAiming(true); }

      this.emit(FK.EVENTS && FK.EVENTS.AIM_START, {
        id: unit.getId(), team: unit.getTeam(),
        x: Math.round(unit.x), y: Math.round(unit.y), unit: unit
      });

      // 立即算一次（此时拖拽距离为 0）
      this.updateAim(this.dragStart.x, this.dragStart.y);
      return true;
    }

    /**
     * 更新瞄准参数并重算轨迹
     * @param {number} worldX 指针世界 X
     * @param {number} worldY 指针世界 Y
     */
    updateAim(worldX, worldY) {
      if (!this.aiming || !this.unit) { return null; }

      const dragX = num(worldX, this.dragStart.x) - this.dragStart.x;
      const dragY = num(worldY, this.dragStart.y) - this.dragStart.y;

      const shot = computeShot({
        dragX: dragX,
        dragY: dragY,
        maxDragPx: this.maxDragPx,
        minPowerRatio: this.minPowerRatio,
        maxSpeed: this.maxSpeed,
        itemRange: this.getItemRange(),
        speedScale: this.getItemSpeedScale(),
        angleLimitDeg: this.angleLimitDeg
      });
      shot.dragX = dragX;
      shot.dragY = dragY;
      this.shot = shot;

      // ---- 第 7.7 步：拖回起始单位附近 → 取消本次瞄准（等同 ESC） ----
      // 先判断「是否已拖出去」：只有 armed 之后回到取消区才算「拖回来了」，
      // 否则按下瞬间（拖拽距离 0）就会被误判成取消。
      if (this.updateDragCancel(shot.dist, num(worldX, this.dragStart.x), num(worldY, this.dragStart.y))) {
        return null;
      }

      // 轨迹计算（纯 JS，不渲染）
      let result = null;
      if (this.predictor) {
        const start = this.getLaunchPoint();
        const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
        const base = (typeof A.previewMaxSteps === 'number') ? A.previewMaxSteps : 52;
        const range = Math.max(0.2, this.getItemRange());
        const power = Math.max(0.12, num(shot.powerRatio, 0));
        const previewSteps = Math.max(14, Math.min(96, Math.round(base * range * (0.42 + 0.58 * power))));
        result = this.predictor.predict(start.x, start.y, shot.vx, shot.vy, {
          platforms: [],
          waterLevel: null,
          bounds: null,
          ignoreObstacles: true,
          maxSteps: previewSteps
        });
        this.trajectory = result;
      }

      this.emit(FK.EVENTS && FK.EVENTS.AIM_UPDATE, {
        id: this.unit.getId(),
        powerRatio: round3(shot.powerRatio),
        angleDeg: round3(shot.angleDeg),
        vx: round3(shot.vx),
        vy: round3(shot.vy),
        speed: round3(shot.speed)
      });

      if (result) {
        this.emit(FK.EVENTS && FK.EVENTS.AIM_TRAJECTORY_READY, {
          id: this.unit.getId(),
          pointCount: result.points.length,
          landing: result.landing,
          hitType: result.hitType,
          hitTarget: result.hitTarget
        });
      }
      return result;
    }

    /**
     * 第 7.7 步：拖拽取消瞄准的核心判定（纯判定，不改状态）
     *
     * 取消区 = 「拖拽距离 < AIM.cancelDragPx」 ∪ 「指针在单位半径 × AIM.cancelRadiusFactor 内」。
     * @param {number} dist 当前拖拽距离（px）
     * @param {number} worldX 指针世界 X
     * @param {number} worldY 指针世界 Y
     * @returns {boolean} 是否取消（true = 已取消，调用方不应再画轨迹）
     */
    updateDragCancel(dist, worldX, worldY) {
      const inset = this.isPointerInCancelZone(dist, worldX, worldY);
      if (!this.dragArmed) {
        // 还没拖出去：离开取消区就记为「已拖出去」，然后才开始判定取消
        if (!inset) { this.dragArmed = true; }
        return false;
      }
      if (!inset) { return false; }
      this.cancelAim('drag-back');
      return true;
    }

    /**
     * 指针是否落在「取消区」内（拖拽距离过小，或回到单位身上）
     * @param {number} dist 拖拽距离（px）
     * @param {number} worldX 指针世界 X
     * @param {number} worldY 指针世界 Y
     * @returns {boolean}
     */
    isPointerInCancelZone(dist, worldX, worldY) {
      if (num(dist, 0) < this.cancelDragPx) { return true; }
      const u = this.unit;
      if (!u) { return false; }
      const r = (typeof u.getHitRadius === 'function')
        ? num(u.getHitRadius(), 0) : num(u.hitRadius, 0);
      const limit = r * this.cancelRadiusFactor;
      if (limit <= 0) { return false; }
      const dx = num(worldX, u.x) - u.x;
      const dy = num(worldY, u.y) - u.y;
      return (dx * dx + dy * dy) <= (limit * limit);
    }

    /** 生效的取消半径（px）：单位半径 × AIM.cancelRadiusFactor；HUD / 自检用 */
    getCancelRadiusPx() {
      const u = this.unit;
      const r = (u && typeof u.getHitRadius === 'function')
        ? num(u.getHitRadius(), 0) : (u ? num(u.hitRadius, 0) : 0);
      return r * this.cancelRadiusFactor;
    }

    /**
     * 松手结束瞄准（第 6 步起由 ProjectileController 监听 aim:end 生成投掷物）
     * 第 7.7 步：**从未拖出去就松手**（等于原地点击）同样视为取消，不投掷。
     */
    endAim() {
      if (!this.aiming || !this.unit) { return false; }
      if (!this.dragArmed) { return this.cancelAim('drag-back'); }
      const unit = this.unit;
      const shot = this.shot || {};
      const result = this.trajectory || null;
      // 第 6 步：把发射点一并带出，保证投掷物的起点与预测轨迹的起点完全一致
      const launch = this.getLaunchPoint();

      this.aiming = false;
      this.unit = null;
      if (typeof unit.setAiming === 'function') { unit.setAiming(false); }

      this.emit(FK.EVENTS && FK.EVENTS.AIM_END, {
        id: unit.getId(),
        team: unit.getTeam(),
        unit: unit,                                  // 第 6 步：投掷者引用
        startX: launch.x,                            // 第 6 步：发射点（与预测同源）
        startY: launch.y,
        itemId: (this.item && this.item.id) ? this.item.id : '',
        powerRatio: round3(shot.powerRatio || 0),
        angleDeg: round3(shot.angleDeg || 0),
        vx: round3(shot.vx || 0),
        vy: round3(shot.vy || 0),
        landing: result ? result.landing : null,
        hitType: result ? result.hitType : 'none'
      });

      this.clearTrajectory();
      return true;
    }

    /**
     * 取消瞄准
     * @param {string} [reason] escape / right-click / turn-change / selection-changed / unit-lost
     */
    cancelAim(reason) {
      if (!this.aiming || !this.unit) { return false; }
      const unit = this.unit;

      this.aiming = false;
      this.unit = null;
      this.dragArmed = false;
      if (typeof unit.setAiming === 'function') { unit.setAiming(false); }

      this.emit(FK.EVENTS && FK.EVENTS.AIM_CANCEL, {
        id: unit.getId(),
        reason: reason || 'manual'
      });

      this.clearTrajectory();
      return true;
    }

    /** 清空预测结果（渲染器会在下一帧自动擦除） */
    clearTrajectory() {
      this.shot = null;
      this.trajectory = null;
      if (this.predictor && typeof this.predictor.reset === 'function') {
        this.predictor.reset();
      }
    }

    /* ==================================================================
     * 帧驱动
     * ================================================================== */

    /**
     * 每帧调用：只做「目标单位消失」的兜底检测，参数更新全部由 pointermove 驱动
     * @param {number} deltaTime
     */
    update(deltaTime) {
      this.elapsedMs += num(deltaTime, 0);
      if (!this.aiming) { return; }
      // 第 8 步：瞄准中的单位阵亡（alive=false）也要立刻取消，避免「对着死人瞄准」
      if (!this.unit || this.unit.active === false || this.unit.alive === false) {
        this.cancelAim('unit-lost');
      }
    }

    /* ==================================================================
     * 查询与配置
     * ================================================================== */

    /** 当前是否在瞄准 */
    isAiming() { return this.aiming; }

    /** 当前瞄准的单位 */
    getUnit() { return this.unit; }

    /** 当前投掷参数（未瞄准时返回 null） */
    getShot() { return this.shot; }

    /** 当前轨迹结果（未瞄准时返回 null） */
    getTrajectory() { return this.trajectory; }

    /** HUD 用的瞄准状态快照 */
    getAimState() {
      return {
        aiming: this.aiming,
        /** 第 7.5 步：'throw' = 抛物线瞄准；'place' = 放置模式（无轨迹） */
        mode: this.getInteractionMode(),
        itemId: this.item ? this.item.id : '',
        /** 第 7.7 步：是否已拖出取消区（false = 此时松手会取消本次瞄准） */
        armed: this.dragArmed,
        /** 第 7.7 步：本次瞄准生效的「拖回即取消」半径（px） */
        cancelRadiusPx: this.getCancelRadiusPx(),
        unitId: this.unit ? this.unit.getId() : '',
        team: this.unit ? this.unit.getTeam() : '',
        powerRatio: this.shot ? round3(this.shot.powerRatio) : 0,
        angleDeg: this.shot ? round3(this.shot.angleDeg) : 0,
        speed: this.shot ? round3(this.shot.speed) : 0,
        vx: this.shot ? round3(this.shot.vx) : 0,
        vy: this.shot ? round3(this.shot.vy) : 0,
        landing: this.trajectory ? this.trajectory.landing : null,
        hitType: this.trajectory ? this.trajectory.hitType : 'none',
        pointCount: this.trajectory ? this.trajectory.points.length : 0
      };
    }

    /**
     * 设置当前道具（决定力度系数与预警圈半径）
     *
     * 第 7.5 步：切成放置类道具时，**立刻取消正在进行的瞄准并清空轨迹**
     * （放置模式没有抛物线，留着上一件道具的轨迹会误导玩家）。
     * @param {FK.ItemConfig} itemConfig
     */
    setItem(itemConfig) {
      const next = itemConfig || null;
      if (this.aiming && this.isPlacementItem(next)) {
        this.cancelAim('item-changed');
      }
      this.item = next;
      if (this.aiming) { this.updateAim(this.lastPointer.x, this.lastPointer.y); }
      return this;
    }

    /** 当前道具的力度系数（ItemConfig.range） */
    getItemRange() {
      return (this.item && typeof this.item.range === 'number') ? this.item.range : 1;
    }

    /** 当前道具的飞行速度系数（ItemConfig.speedScale，缺省 1） */
    getItemSpeedScale() {
      const s = this.item && this.item.speedScale;
      return (typeof s === 'number' && s > 0) ? s : 1;
    }

    /** 当前道具的爆炸半径（地图单位；未设置道具时为 0） */
    getItemRadiusUnits() {
      return (this.item && typeof this.item.radius === 'number') ? this.item.radius : 0;
    }

    /** 发射点（单位中心 + 垂直偏移，地图单位 → 像素） */
    getLaunchPoint() {
      const u = this.unit || { x: 0, y: 0 };
      return { x: u.x, y: u.y + this.launchOffsetYUnits * this.pxPerUnit };
    }

    /* ==================================================================
     * 清理
     * ================================================================== */

    destroy() {
      const input = this.scene && this.scene.input;
      if (this.aiming) { this.cancelAim('destroy'); }

      if (input) {
        input.off('pointerdown', this.onPointerDownBound);
        input.off('pointermove', this.onPointerMoveBound);
        input.off('pointerup', this.onPointerUpBound);
        if (input.keyboard && typeof input.keyboard.off === 'function') {
          input.keyboard.off('keydown-ESC', this.onEscBound);
        }
      }
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.off(FK.EVENTS.TURN_SWITCH, this.onTurnChangeBound);
        FK.EventBus.off(FK.EVENTS.TURN_END, this.onTurnChangeBound);
        FK.EventBus.off(FK.EVENTS.TURN_TIMEOUT, this.onTurnChangeBound);
        FK.EventBus.off(FK.EVENTS.UNIT_SELECTED, this.onSelectionChangeBound);
        FK.EventBus.off(FK.EVENTS.UNIT_DESELECTED, this.onSelectionChangeBound);
      }
      this.unitSelector = null;
      this.predictor = null;
      this.turnManager = null;
    }

    /* ---------------- 内部 ---------------- */

    emit(type, payload) {
      if (FK.EventBus && type) { FK.EventBus.emit(type, payload); }
    }
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  // 第 7 步：不再有「阵营朝向」概念——投掷方向完全由拖拽方向决定（360° 全向）。
  // 仅保留纯函数入口，签名向后兼容（多余入参会被忽略）。
  AimController.computeShot = computeShot;

  FK.AimController = AimController;
})();
