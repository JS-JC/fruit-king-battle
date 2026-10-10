/**
 * ============================================================
 * MoveController.js —— 单位主动移动系统（第 8.5 步新增）
 * ============================================================
 * 职责：
 *   把「道具栏第 4 格『移动』的拖拽」翻译成一次**抛物线跳跃**，并与回合状态机联动：
 *     ① 选择：点道具栏第 4 格「移动」（与樱桃 / 西瓜 / 果箱并列，**没有模式概念**）；
 *     ② 拖拽：与投掷瞄准**同一手感**（弹弓式，向后拉 → 向前跳），
 *        参数全部读 FK.Config.MOVE（与 AIM 完全独立，调移动不影响投掷）；
 *     ③ 预览：每一步用 TrajectoryPredictor.stepProjectile 算抛物线，
 *        水平方向撞墙按 KNOCKBACK.restitution 弹回（与击退共用同一套弹性），
 *        得到**真实落点**（预览与实飞逐帧同源，不会出现「预览这里、落点那里」）；
 *     ④ 生效：松手 → 单位按预览的初速度起飞（UnitBase.stepActiveMove 每帧推进），
 *        落地 / 撞墙停下 → move:complete；
 *     ⑤ 次数：**每回合只能移动一次**——移动完本回合仍可投掷，但不能再次移动
 *        （moveUsedThisTurn，在 TURN_START / TURN_SWITCH 复位）；
 *     ⑥ 落水：跳到果汁池上方 → 没有支撑面 → 继续下坠 → 越过水面由
 *        BattleScene 每帧的 DeathSystem 判死（复用第 8 步的落水 / 胜负链路）。
 *
 * 模块化纪律：
 *   · 本文件不碰投掷链路（ProjectileController / AimController 一行不改）；
 *   · 移动选择态由 **ItemBar 第 4 格**持有（isMoveActive provider），
 *     AimController 在选择移动期间完全不接管鼠标，因此拖拽时**只会出现一条抛物线**；
 *   · 只读 TurnManager 的阵营与状态，自身不推进回合（移动不结束回合）。
 *
 * 事件（常量见 js/config/events.js）：
 *   move:start / move:update / move:end / move:complete / move:cancel
 *
 * 依赖：FK.Config、FK.EVENTS、FK.EventBus、FK.TrajectoryPredictor、各系统实例（构造注入）
 * 对外：FK.MoveController（含静态纯函数 computeMove / simulatePath）
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

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  /**
   * 纯函数：拖拽向量 → 移动参数（与 AimController.computeShot 同一套映射口径）
   *
   *   拖拽向量 drag = 指针当前位置 − 按下位置（世界像素）
   *   起跳方向 dir = −drag                       （弹弓手感）
   *   力度     powerRatio = clamp(|drag| / maxDragPx, 0, 1)
   *   有效力度 effectivePower = max(powerRatio, minPowerRatio)
   *   角度     angleDeg = atan2(−dirY, dirX)     （向上为正，可全向）
   *   初速度   speed = maxSpeed × effectivePower
   *
   * @param {Object} input { dragX, dragY, maxDragPx, minPowerRatio, maxSpeed, angleLimitDeg }
   * @returns {Object} { dist, powerRatio, effectivePower, angleDeg, speed, vx, vy, dirX, dirY }
   */
  function computeMove(input) {
    const i = input || {};
    const dragX = num(i.dragX, 0);
    const dragY = num(i.dragY, 0);
    const maxDragPx = Math.max(1, num(i.maxDragPx, 180));
    const minPowerRatio = clamp(num(i.minPowerRatio, 0.08), 0, 1);
    const maxSpeed = num(i.maxSpeed, 954);
    const angleLimitDeg = num(i.angleLimitDeg, 360);

    const dist = Math.sqrt(dragX * dragX + dragY * dragY);
    const powerRatio = clamp(dist / maxDragPx, 0, 1);

    let dirX = 0;
    let dirY = 0;
    if (dist > EPS) {
      dirX = -dragX / dist;
      dirY = -dragY / dist;
    } else {
      dirX = 1;
      dirY = 0;
    }

    let angleDeg = Math.atan2(-dirY, dirX) * 180 / Math.PI;
    angleDeg = clamp(angleDeg, -angleLimitDeg, angleLimitDeg);

    const effectivePower = Math.max(powerRatio, minPowerRatio);
    const speed = maxSpeed * effectivePower;
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

  /**
   * 纯函数：模拟一次移动的完整落点（预览与实飞同源）
   *
   *   位置用**解析解**逐段推进，与 TrajectoryPredictor.predict 共用同一份公式：
   *       x = x0 + vx·t，y = y0 + vy0·t + ½g·t²
   *   实飞侧（UnitBase.stepActiveMove）直接复用 TrajectoryPredictor.stepIntegrate，
   *   因此「移动的落点预览」与「单位真实飞行」逐帧同源，不会出现预览与落点漂移。
   *   每段结束时检查与左右墙体的相遇：撞上后 `vx ← -vx × restitution`，
   *   新段以撞点重新计时（可多次弹回、能量递减）。
   *   撞点向外留 `contactGapPx` 缝隙，避免「贴在墙面上反复触发同一帧碰撞」
   *   ——与 KnockbackPhysics 的 `knockContactGapPx` 同一口径。
   *
   * @param {Object} input
   *   x, y                 起点（世界像素）
   *   vx, vy               初速度（px/s）
   *   gravityY             重力（px/s²）
   *   stepSec              积分步长（秒），须与 PHYSICS.stepFps 对齐
   *   maxSteps             最大步数（预览可以比实飞少，避免过度绘制）
   *   bounds               { left, right } 水平边界（可为 null）
   *   restitution          弹性系数（撞墙反弹比例）
   *   minBounceSpeed       撞击速度低于该值不再反弹
   *   maxBounces           最多弹回次数
   *   halfWidth            单位碰撞半径（撞墙按边缘判定）
   *   contactGapPx         撞点外侧留的缝隙（px）
   *   waterLevelY          水面像素 y（预览落水用；null 表示不判）
   *   landingY             落点高度（px）：越过即认为落地；null 表示不判（自检用）
   *   sampleEvery          点列抽稀步长
   * @returns {Object} { points, allPoints, landing:{x,y}, hitType, bounces, flightTimeMs, endVx, apexY }
   */
  function simulatePath(input) {
    const i = input || {};
    const stepSec = Math.max(1e-4, num(i.stepSec, 1 / 60));
    const maxSteps = Math.max(1, Math.round(num(i.maxSteps, 600)));
    const g = num(i.gravityY, 1500);
    const restitution = clamp(num(i.restitution, 0.58), 0, 1);
    const restitutionDecay = clamp(num(i.restitutionDecay, 0.78), 0, 1);
    const minBounceSpeed = Math.max(0, num(i.minBounceSpeed, 28));
    const maxBounces = Math.max(0, Math.round(num(i.maxBounces, 8)));
    const halfWidth = Math.max(0, num(i.halfWidth, 24));
    const contactGapPx = Math.max(0, num(i.contactGapPx, 0.5));
    const bounds = i.bounds || null;
    const waterLevelY = (typeof i.waterLevelY === 'number' && isFinite(i.waterLevelY)) ? i.waterLevelY : null;
    const landingY = (typeof i.landingY === 'number' && isFinite(i.landingY)) ? i.landingY : null;
    const rects = Array.isArray(i.rects) ? i.rects
      : (Array.isArray(i.crates) ? i.crates : []);
    /**
     * 第 8.6 步：逐点支撑面查询 `(x, y) => 支撑面顶面 y | null`。
     * 传入时「落地」按**当前位置**的支撑面判定（与 UnitBase.stepActiveMove 完全同口径），
     * 于是弧线会一路画到真实落点（低台 / 池面），不会再被统一的 landingY 在中途截断。
     */
    const supportAt = (typeof i.supportAt === 'function') ? i.supportAt : null;
    // 飞行时间硬上限：与 MOVE.maxFlightMs 同源（避免「没有地面时无限飞」）
    const maxStepsByTime = Math.max(1, Math.round(num(i.maxFlightMs, 4000) / 1000 / stepSec));
    const limit = Math.min(maxSteps, maxStepsByTime);

    const startX = num(i.x, 0);
    const startY = num(i.y, 0);
    let vx = num(i.vx, 0);
    let vy = num(i.vy, 0);
    let x = startX;
    let y = startY;

    let apexY = startY;
    let bounces = 0;
    let hitType = 'timeout';
    let landing = { x: startX, y: startY };
    let steps = 0;
    let endVy = vy;

    const all = [{ x: startX, y: startY }];
    const every = Math.max(1, Math.round(num(i.sampleEvery, 2)));
    const phys = (FK.KnockbackPhysics && typeof FK.KnockbackPhysics.stepFlightSlice === 'function')
      ? FK.KnockbackPhysics : null;
    const world = {
      rects: rects,
      bounds: bounds
        ? { left: bounds.left, right: bounds.right, type: bounds.type || 'wall' }
        : { disabled: true }
    };
    const physCfg = {
      restitution: restitution,
      restitutionDecay: restitutionDecay,
      minBounceSpeed: minBounceSpeed,
      maxBounceCount: maxBounces,
      contactGapPx: contactGapPx
    };

    for (let step = 1; step <= limit; step++) {
      steps = step;
      let nx;
      let ny;
      let nvy;
      let bounced = false;
      let bounceCount = 0;
      if (phys) {
        const hit = phys.stepFlightSlice({
          x: x, y: y, vx: vx, vy: vy, g: g, halfWidth: halfWidth,
          priorBounceCount: bounces
        }, stepSec, world, physCfg);
        nx = hit.x;
        ny = hit.y;
        nvy = hit.vy;
        vx = hit.vx;
        bounced = !!hit.bounced;
        bounceCount = hit.bounceCount || 0;
      } else {
        nx = x + vx * stepSec;
        ny = y + vy * stepSec + 0.5 * g * stepSec * stepSec;
        nvy = vy + g * stepSec;
      }
      function crossingTime(target) {
        if (!(y < target)) { return null; }
        const a = 0.5 * g;
        const b = vy;
        const c = y - target;
        const disc = b * b - 4 * a * c;
        if (disc < 0) { return null; }
        const sq = Math.sqrt(disc);
        const t1 = (-b - sq) / (2 * a);
        const t2 = (-b + sq) / (2 * a);
        const cands = [t1, t2].filter(function (t) { return t > 0 && t <= stepSec; });
        if (cands.length === 0) { return null; }
        let t = cands[0];
        for (let k = 1; k < cands.length; k++) { if (cands[k] < t) { t = cands[k]; } }
        return t;
      }
      if (bounced) {
        bounces += bounceCount;
        all.push({ x: nx, y: ny, bounce: true });
        if (Math.abs(vx) < minBounceSpeed || bounces > maxBounces) {
          x = nx;
          y = ny;
          endVy = nvy;
          landing = { x: x, y: y };
          hitType = 'bounds';
          break;
        }
      }
      if (supportAt && nvy >= 0) {
        const sy = supportAt(nx, ny);
        if (typeof sy === 'number' && isFinite(sy)) {
          const landUnitY = sy - halfWidth;
          if (ny >= landUnitY) {
            x = nx;
            y = landUnitY;
            landing = { x: x, y: y };
            hitType = 'landed';
            endVy = nvy;
            if (y < apexY) { apexY = y; }
            all.push({ x: x, y: y });
            break;
          }
        }
      }
      if (!supportAt && landingY !== null && nvy >= 0 && ny >= landingY && y < landingY) {
        const t = crossingTime(landingY);
        x = (t !== null) ? (x + vx * t) : nx;
        y = landingY;
        landing = { x: x, y: y };
        hitType = 'landed';
        endVy = (t !== null) ? (vy + g * t) : nvy;
        if (y < apexY) { apexY = y; }
        all.push({ x: x, y: y });
        break;
      }
      if (waterLevelY !== null && ny >= waterLevelY && y < waterLevelY) {
        const t = crossingTime(waterLevelY);
        x = (t !== null) ? (x + vx * t) : nx;
        y = waterLevelY;
        landing = { x: x, y: y };
        hitType = 'water';
        endVy = (t !== null) ? (vy + g * t) : nvy;
        if (y < apexY) { apexY = y; }
        all.push({ x: x, y: y });
        break;
      }
      x = nx;
      y = ny;
      vy = nvy;
      endVy = nvy;
      if (y < apexY) { apexY = y; }
      if (step % every === 0 || step === limit) { all.push({ x: x, y: y }); }
      landing = { x: x, y: y };
      hitType = 'timeout';
    }

    return {
      points: all,
      allPoints: all,
      landing: { x: round2(landing.x), y: round2(landing.y) },
      start: { x: round2(startX), y: round2(startY) },
      hitType: hitType,
      bounces: bounces,
      flightTimeMs: Math.round(steps * stepSec * 1000),
      endVx: vx,
      endVy: endVy,
      apexY: round2(apexY),
      apexRise: round2(startY - apexY)
    };
  }

  class MoveController {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   isMoveActive  () => boolean 第 8.6 步：由**道具栏第 4 格**决定是否处于移动选择态
     *                 （道具栏是唯一真相源；本控制器不再自己持有「模式」）
     *   unitSelector  选区块（getSelected）
     *   turnManager   TurnManager（阵营 / 状态判定）
     *   predictor     TrajectoryPredictor（提供 stepProjectile / 世界数据）
     *   turnGate      { canAct(), markActed() } 与投掷共享的回合口令（缺省从 turnManager 推导）
     *   obstacles     () => [AABB] 场上木箱矩形（预览落点判定用；可空）
     *   units         () => [unit] 单位列表（用于广播时带上引用）
     *   canvas        可视区域 { left, top, right, bottom }（预览只画可见部分）
     *   events        事件总线（缺省 FK.EventBus）
     *   config        覆盖 FK.Config.MOVE
     */
    constructor(scene, opts) {
      opts = opts || {};
      const M = (FK.Config && FK.Config.MOVE) ? FK.Config.MOVE : {};
      const K = (FK.Config && FK.Config.KNOCKBACK) ? FK.Config.KNOCKBACK : {};

      this.scene = scene || null;
      this.unitSelector = opts.unitSelector || null;
      this.turnManager = opts.turnManager || null;
      this.predictor = opts.predictor || null;
      this.turnGate = opts.turnGate || null;
      this.obstacles = (typeof opts.obstacles === 'function') ? opts.obstacles : null;
      this.unitsProvider = (typeof opts.units === 'function') ? opts.units : null;
      this.events = opts.events || FK.EventBus || null;
      this.cfg = opts.config || M;

      /* ---------------- 可调参数（全部来自配置） ---------------- */
      this.maxSpeed = num(opts.maxSpeed, num(this.cfg.maxSpeed, 954));
      this.maxDragPx = num(opts.maxDragPx, num(this.cfg.maxDragPx, 180));
      this.minPowerRatio = num(opts.minPowerRatio, num(this.cfg.minPowerRatio, 0.08));
      this.angleLimitDeg = num(opts.angleLimitDeg, num(this.cfg.angleLimitDeg, 360));
      this.launchOffsetYUnits = num(opts.launchOffsetYUnits, num(this.cfg.launchOffsetYUnits, -0.2));
      this.airDragX = num(opts.airDragX, num(this.cfg.airDragX, 0));
      this.maxFlightMs = num(opts.maxFlightMs, num(this.cfg.maxFlightMs, 4000));
      this.maxStepMs = num(opts.maxStepMs, num(this.cfg.maxStepMs, 50));
      this.maxBounces = num(opts.maxBounces, num(this.cfg.maxBounces, 8));
      this.maxPreviewPoints = Math.max(4, Math.round(num(this.cfg.maxPreviewPoints, 90)));
      this.restitution = num(opts.restitution, num(this.cfg.restitution, num(K.restitution, 0.58)));
      this.restitutionDecay = num(opts.restitutionDecay, num(this.cfg.restitutionDecay, 0.78));
      this.minBounceSpeed = num(opts.minBounceSpeed, num(this.cfg.minBounceSpeed, num(K.minBounceSpeed, 28)));
      this.contactGapPx = num(opts.contactGapPx, num(this.cfg.contactGapPx, 0.5));
      this.pxPerUnit = num(opts.pxPerUnit, (FK.Config ? FK.Config.PX_PER_UNIT : 48));

      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
      this.stepSec = num(opts.stepSec, num(A.stepSec, 1 / 60));
      const C = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS : { width: 1600, height: 800 };
      this.viewport = Object.assign({ left: 0, top: 0, right: C.width, bottom: C.height }, opts.canvas || {});

      /* ---------------- 状态 ---------------- */
      /**
       * 第 8.6 步：「移动」是道具栏的第 4 格（与樱桃 / 西瓜 / 果箱并列），
       * 因此移动选择态由 ItemBar 持有（isMoveActiveProvider），本类不再自持模式。
       */
      this.isMoveActiveProvider = (typeof opts.isMoveActive === 'function') ? opts.isMoveActive : null;
      /**
       * 本回合是否已经移动过（每回合只能移动一次：移完可投掷，不能再移动）。
       * 由 TURN_START / TURN_SWITCH 复位，由 commitPlan 置位。
       */
      this.moveUsedThisTurn = false;
      /** 本回合已经移动过的单位（移完只能由该单位投掷 / 放置） */
      this.movedUnit = null;
      /** 是否正在拖拽制定移动方案 */
      this.planning = false;
      /** 正在规划的单位 */
      this.unit = null;
      /** 正在执行移动的单位（起飞后） */
      this.activeUnit = null;
      this.dragStart = { x: 0, y: 0 };
      this.lastPointer = { x: 0, y: 0 };
      this.shot = null;
      this.path = null;
      this.elapsedMs = 0;
      this.moveWindowMs = 0;
      /** 统计（HUD / 自检用） */
      this.stats = { started: 0, committed: 0, completed: 0, cancelled: 0, bounces: 0 };
      /** 最近一次移动摘要 */
      this.lastMove = null;

      this.onPointerDownBound = this.onPointerDown.bind(this);
      this.onPointerMoveBound = this.onPointerMove.bind(this);
      this.onPointerUpBound = this.onPointerUp.bind(this);
      this.onEscBound = this.onEsc.bind(this);
      this.onTurnChangeBound = this.onTurnChange.bind(this);
      this.onStateChangedBound = this.onStateChanged.bind(this);

      this.bindInput();
    }

    /* ==================================================================
     * 输入绑定
     * ================================================================== */

    bindInput() {
      const input = this.scene && this.scene.input;
      if (input && typeof input.on === 'function') {
        input.on('pointerdown', this.onPointerDownBound);
        input.on('pointermove', this.onPointerMoveBound);
        input.on('pointerup', this.onPointerUpBound);
        if (input.keyboard && typeof input.keyboard.on === 'function') {
          input.keyboard.on('keydown-ESC', this.onEscBound);
        }
      }
      if (this.events && FK.EVENTS) {
        this.events.on(FK.EVENTS.TURN_SWITCH, this.onTurnChangeBound);
        this.events.on(FK.EVENTS.TURN_END, this.onTurnChangeBound);
        this.events.on(FK.EVENTS.TURN_TIMEOUT, this.onTurnChangeBound);
        this.events.on(FK.EVENTS.TURN_STATE_CHANGE, this.onStateChangedBound);
      }
    }

    /* ==================================================================
     * 移动选择态（由道具栏第 4 格「移动」驱动，没有独立「模式」概念）
     * ================================================================== */

    /**
     * 切换移动选择态（幂等）
     *   进入：要求本回合还能行动，且本回合**还没移动过**；
     *   退出：清掉拖拽规划，但**不**回收「本回合已移动」的标记（移完就不能再移）。
     * @param {boolean} active
     * @returns {boolean} 切换后是否处于移动选择态
     */
    setMoveActive(active) {
      if (!active) { this.exitMoveMode('slot-off'); return false; }
      if (this.isMoveActive()) { return true; }
      // 对局已结束 / 本回合已行动 / 本回合已移动过：不允许再次选择移动
      if (this.isInputBlocked()) { return false; }
      if (!this.canAct() || this.isMoveUsed()) {
        this.log('本回合不能再移动（已移动过 或 本回合行动已用）');
        return false;
      }
      this.setCursor('move');
      this.emit(FK.EVENTS && FK.EVENTS.MOVE_START, {
        unitId: '',
        team: this.getCurrentTeam(),
        x: 0, y: 0,
        turnNumber: this.getTurnNumber(),
        canAct: this.canAct()
      });
      this.log('已选中「移动」格：拖拽己方单位决定跳跃方向与力度（每回合限一次）');
      return true;
    }

    /** 退出移动选择态（点其它道具 / ESC / 回合切换 / 对局结束） */
    exitMoveMode(reason) {
      if (this.planning) { this.cancelPlan(reason || 'exit-move'); }
      this.setCursor('default');
      return true;
    }

    /** 是否处于移动选择态（道具栏第 4 格被选中） */
    isMoveMode() { return this.isMoveActive(); }

    /** 是否处于移动选择态（读道具栏） */
    isMoveActive() {
      if (this.isMoveActiveProvider) { return !!this.isMoveActiveProvider(); }
      return false;
    }

    /** 是否正在拖拽制定移动方案 */
    isPlanning() { return !!this.planning; }

    /** 本回合是否已经移动过 */
    isMoveUsed() { return !!this.moveUsedThisTurn; }

    /** 本回合已移动的单位；阵亡则解锁 */
    getMovedUnit() {
      const u = this.movedUnit;
      if (!u || u.alive === false) { return null; }
      return u;
    }

    /** 本回合是否已经投掷 / 放置过（与投掷链路共用的回合口令） */
    isTurnUsed() {
      if (this.turnGate && typeof this.turnGate.canAct === 'function') {
        return !this.turnGate.canAct();
      }
      return false;
    }

    /** 「移动」格现在能不能点（本回合未行动、未移动过、非终态、非飞行） */
    canUseMove() {
      if (this.isInputBlocked()) { return false; }
      if (this.isMoveUsed() || this.planning) { return false; }
      return this.canAct();
    }

    /** 本回合是否已经移动完（移动格置灰的判据） */
    isLockedForTurn() { return this.isMoveUsed(); }

    /* ==================================================================
     * 拖拽 → 移动方案
     * ================================================================== */

    onPointerDown(pointer) {
      if (!pointer || !this.isMoveActive()) { return false; }
      if (this.planning || this.activeUnit) { return false; }
      if (typeof pointer.rightButtonDown === 'function' && pointer.rightButtonDown()) {
        this.cancelPlan('right-click');
        return false;
      }
      if (typeof pointer.leftButtonDown === 'function' && !pointer.leftButtonDown()) { return false; }
      if (this.isPlayerInputBlocked()) { return false; }

      const unit = this.pickUnit(pointer);
      if (!unit) { return false; }
      if (!this.canMove(unit)) {
        this.log('该单位现在不能移动（阵营 / 已行动 / 本回合已移动 / 已死亡）');
        return false;
      }

      const wx = num(pointer.worldX, unit.x);
      const wy = num(pointer.worldY, unit.y);
      this.startPlan(unit, wx, wy);
      return true;
    }

    onPointerMove(pointer) {
      if (!this.planning || !pointer) { return false; }
      // 第 8.5 步（任务 B）：直接采用指针世界坐标，**不做画布边界钳制**，
      // 因此指针拖到画布外仍然继续更新力度与角度（松手才结算）。
      this.lastPointer.x = num(pointer.worldX, this.lastPointer.x);
      this.lastPointer.y = num(pointer.worldY, this.lastPointer.y);
      this.updatePlan(this.lastPointer.x, this.lastPointer.y);
      return true;
    }

    onPointerUp() {
      if (!this.planning) { return false; }
      return this.commitPlan();
    }

    onEsc() {
      if (this.planning) { this.cancelPlan('escape'); return true; }
      return false;
    }

    /** 回合切换 / 结束 / 超时：清掉拖拽与飞行，并复位「本回合已移动」 */
    onTurnChange(payload) {
      const reason = (payload && payload.reason) ? ('turn-' + payload.reason) : 'turn-change';
      if (this.planning) { this.cancelPlan(reason); }
      this.setCursor('default');
      this.moveUsedThisTurn = false;
      this.movedUnit = null;
      if (this.activeUnit) {
        if (typeof this.activeUnit.finishActiveMove === 'function') {
          this.activeUnit.finishActiveMove(reason);
        }
        this.finishMove(this.activeUnit, reason);
      }
      this.resumeTurnTimer();
    }

    onStateChanged(payload) {
      if (!payload) { return; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : {};
      // 新回合：每回合只能移动一次 → 复位口令
      if (payload.to === S.TURN_START || payload.to === S.SWITCH_TEAM) {
        this.moveUsedThisTurn = false;
        this.movedUnit = null;
      }
      if (payload.to === S.GAME_OVER) {
        if (this.planning) { this.cancelPlan('game-over'); }
        this.moveUsedThisTurn = false;
        this.movedUnit = null;
      }
    }

    /* ==================================================================
     * 规划生命周期
     * ================================================================== */

    /**
     * 取本次拖拽要移动的单位：优先用已选中单位（需在指针附近按下），
     * 没有选中时退化为「按在哪个己方单位身上就移动哪个」。
     */
    pickUnit(pointer) {
      const sel = this.unitSelector ? this.unitSelector.getSelected() : null;
      if (sel && sel.alive !== false) {
        const r = (typeof sel.getHitRadius === 'function') ? sel.getHitRadius() : 28;
        const dx = num(pointer.worldX, sel.x) - sel.x;
        const dy = num(pointer.worldY, sel.y) - sel.y;
        if ((dx * dx + dy * dy) <= (r * r)) { return sel; }
      }
      return null;
    }

    /** 是否允许移动该单位（当前阵营 + 存活 + 本回合未行动 + 本回合未移动 + 非终态） */
    canMove(unit) {
      if (!unit) { return false; }
      if (unit.alive === false) { return false; }
      if (unit.moving) { return false; }
      // 第 8.6 步：每回合只能移动一次（移完还能投掷，但不能再移动）
      if (this.isMoveUsed()) { return false; }
      if (this.isInputBlocked()) { return false; }
      if (!this.canAct()) { return false; }
      const team = this.getCurrentTeam();
      if (team === null) { return true; }
      return unit.getTeam() === team;
    }

    /** 本回合是否还能行动（与投掷 / 放置共享同一个回合口令） */
    canAct() {
      if (this.turnGate && typeof this.turnGate.canAct === 'function') {
        return !!this.turnGate.canAct();
      }
      return true;
    }

    /** 占用本回合行动口令 */
    markActed() {
      if (this.turnGate && typeof this.turnGate.markActed === 'function') {
        this.turnGate.markActed();
      }
    }

    getCurrentTeam() {
      const tm = this.turnManager;
      return (tm && typeof tm.getCurrentTeam === 'function') ? tm.getCurrentTeam() : null;
    }

    getTurnNumber() {
      const tm = this.turnManager;
      return (tm && typeof tm.getTurnNumber === 'function') ? tm.getTurnNumber() : 0;
    }

    /** 是否处于禁止输入状态（GAME_OVER 终态） */
    isInputBlocked() {
      const tm = this.turnManager;
      if (!tm || typeof tm.getState !== 'function') { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : null;
      return !!(S && tm.getState() === S.GAME_OVER);
    }

    /** 玩家拖拽锁定：终态或 AI 回合（不影响 startPlan / commitPlan 程序入口） */
    isPlayerInputBlocked() {
      if (this.isInputBlocked()) { return true; }
      if (FK.Config && typeof FK.Config.isPaused === 'function' && FK.Config.isPaused()) { return true; }
      return !!(FK.Config && typeof FK.Config.isAiTurn === 'function' &&
        FK.Config.isAiTurn(this.turnManager));
    }

    /** 进入拖拽规划 */
    startPlan(unit, worldX, worldY) {
      if (!unit || this.planning) { return false; }
      // 本回合已行动 / 终态 / 阵营不符：拒绝开始规划（与 onPointerDown 双重保险）
      if (!this.canMove(unit)) { return false; }
      this.planning = true;
      this.unit = unit;
      this.dragStart.x = num(worldX, unit.x);
      this.dragStart.y = num(worldY, unit.y);
      this.lastPointer.x = this.dragStart.x;
      this.lastPointer.y = this.dragStart.y;
      this.elapsedMs = 0;
      this.stats.started += 1;
      if (typeof unit.setAiming === 'function') { unit.setAiming(true); }
      this.updatePlan(this.dragStart.x, this.dragStart.y);
      return true;
    }

    /** 拖拽中：重算参数与落点预览 */
    updatePlan(worldX, worldY) {
      if (!this.planning || !this.unit) { return null; }
      const unit = this.unit;
      // 指针世界坐标始终同步（任务 B：不钳制到画布，指针拖到画布外也照常更新）
      this.lastPointer.x = num(worldX, this.lastPointer.x);
      this.lastPointer.y = num(worldY, this.lastPointer.y);
      const dragX = this.lastPointer.x - this.dragStart.x;
      const dragY = this.lastPointer.y - this.dragStart.y;

      const shot = computeMove({
        dragX: dragX, dragY: dragY,
        maxDragPx: this.maxDragPx,
        minPowerRatio: this.minPowerRatio,
        maxSpeed: this.maxSpeed,
        angleLimitDeg: this.angleLimitDeg
      });
      shot.dragX = dragX;
      shot.dragY = dragY;
      if (this.cfg.maxSpeedY) {
        shot.vy = clamp(shot.vy, -this.cfg.maxSpeedY, this.cfg.maxSpeedY);
      }
      this.shot = shot;

      const path = this.buildPath(unit, shot);
      this.path = path;

      this.emit(FK.EVENTS && FK.EVENTS.MOVE_UPDATE, {
        unitId: unit.getId(),
        team: unit.getTeam(),
        powerRatio: Math.round(shot.powerRatio * 1000) / 1000,
        angleDeg: Math.round(shot.angleDeg * 1000) / 1000,
        vx: Math.round(shot.vx * 100) / 100,
        vy: Math.round(shot.vy * 100) / 100,
        speed: Math.round(shot.speed * 100) / 100,
        bounces: path.bounces,
        pointCount: path.points.length,
        landing: path.landing,
        hitType: path.hitType,
        waypoints: path.points,
        preview: {
          points: path.points,
          landing: path.landing,
          hitType: path.hitType,
          viewport: this.viewport
        }
      });
      return path;
    }

    /** 起跳点（单位中心 + 配置的垂直偏移） */
    getLaunchPoint(unit) {
      const u = unit || this.unit || { x: 0, y: 0 };
      return { x: u.x, y: u.y + this.launchOffsetYUnits * this.pxPerUnit };
    }

    /** 水平边界（来自预测器的世界数据；没有时用竞技场换算） */
    getBounds() {
      const p = this.predictor;
      if (p && typeof p.getWorld === 'function') {
        const w = p.getWorld() || {};
        if (w.bounds && typeof w.bounds.left === 'number' && typeof w.bounds.right === 'number') {
          return { left: w.bounds.left, right: w.bounds.right };
        }
      }
      if (FK.Config && typeof FK.Config.mapBoundsPx === 'function') {
        const b = FK.Config.mapBoundsPx();
        return { left: b.left, right: b.right };
      }
      const A = (FK.Config && FK.Config.ARENA) ? FK.Config.ARENA : null;
      if (!A) { return null; }
      return {
        left: FK.Config.arenaX(0),
        right: FK.Config.arenaX(A.widthUnits)
      };
    }

    /** 预览 / 实飞共用的横向障碍：地形平台 + 木箱（世界像素 AABB） */
    getBounceRects() {
      const p = this.predictor;
      if (!p || typeof p.getWorld !== 'function') { return []; }
      const w = p.getWorld() || {};
      const list = Array.isArray(w.platforms) ? w.platforms : [];
      return list.map(function (r) {
        return {
          id: r.id || '',
          x: r.x, y: r.y, width: r.width, height: r.height,
          kind: r.kind || 'platform'
        };
      });
    }

    /** 水面像素 y（来自预测器的世界数据；没有则 null） */
    getWaterLevelY() {
      const p = this.predictor;
      if (!p || typeof p.getWorld !== 'function') { return null; }
      const w = p.getWorld() || {};
      return (typeof w.waterLevel === 'number') ? w.waterLevel : null;
    }

    /**
     * 用同一个物理原语算出「有墙弹回」的完整路径（预览与实飞同源）
     * @param {FK.UnitBase} unit
     * @param {Object} shot computeMove 的结果
     */
    /** 预览落地：跳过木箱顶面，弧线按能跨过去画，撞箱不截断 */
    previewSupportAt(unit) {
      const supportProvider = (unit && typeof unit.supportProvider === 'function')
        ? unit.supportProvider : null;
      if (!supportProvider) { return null; }
      const self = this;
      const isObs = (FK.TrajectoryPredictor && FK.TrajectoryPredictor.isObstacleRect)
        ? FK.TrajectoryPredictor.isObstacleRect
        : function (r) {
          return !!(r && (r.material === 'crate' || r.kind === 'crate' ||
            (typeof r.id === 'string' && r.id.indexOf('obstacle_') === 0)));
        };
      return function (px, py) {
        let probeY = py;
        for (let n = 0; n < 8; n++) {
          const sy = supportProvider(px, probeY);
          if (typeof sy !== 'number' || !isFinite(sy)) { return null; }
          const crates = (typeof self.obstacles === 'function') ? (self.obstacles() || []) : [];
          let crate = null;
          for (let i = 0; i < crates.length; i++) {
            const r = crates[i];
            if (!isObs(r)) { continue; }
            if (px < r.x || px > r.x + r.width) { continue; }
            if (Math.abs(sy - r.y) <= 6) { crate = r; break; }
          }
          if (!crate) { return sy; }
          probeY = crate.y + crate.height + 8;
        }
        return null;
      };
    }

    /**
     * 预览弧线：纯抛体，忽略木箱 / 侧撞反弹（实飞仍走碰撞）。
     * @param {FK.UnitBase} unit
     * @param {Object} shot computeMove 的结果
     */
    buildPath(unit, shot) {
      const launch = this.getLaunchPoint(unit);
      const g = (FK.Config && FK.Config.PHYSICS) ? FK.Config.PHYSICS.gravityY : 1500;
      const dt = this.stepSec;
      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
      const base = (typeof A.previewMaxSteps === 'number') ? A.previewMaxSteps : 52;
      const aimSpeed = Math.max(1, num(A.maxSpeed, 1200));
      const speedScale = (this.maxSpeed || 954) / aimSpeed;
      const power = Math.max(0.12, num(shot.powerRatio, 0));
      const maxSteps = Math.max(14, Math.min(96, Math.round(base * speedScale * (0.42 + 0.58 * power))));
      const every = Math.max(1, Math.round(num(this.cfg.previewSampleEvery, 2)));
      const hw = (typeof unit.getCollisionRadius === 'function') ? unit.getCollisionRadius() : 24;
      const supportAt = this.previewSupportAt(unit);
      const waterY = this.getWaterLevelY();
      const vx = num(shot.vx, 0);
      const vy = num(shot.vy, 0);
      const points = [{ x: launch.x, y: launch.y }];
      let landing = { x: launch.x, y: launch.y };
      let hitType = 'timeout';
      let apexY = launch.y;

      for (let step = 1; step <= maxSteps; step++) {
        const t = step * dt;
        const x = launch.x + vx * t;
        const y = launch.y + vy * t + 0.5 * g * t * t;
        const nvy = vy + g * t;
        if (y < apexY) { apexY = y; }
        landing = { x: x, y: y };
        if (supportAt && nvy >= 0) {
          const sy = supportAt(x, y);
          if (typeof sy === 'number' && isFinite(sy) && y >= sy - hw) {
            landing = { x: x, y: sy - hw };
            hitType = 'landed';
            if (step % every === 0) { points.push({ x: landing.x, y: landing.y }); }
            break;
          }
        }
        if (waterY !== null && y >= waterY) {
          landing = { x: x, y: waterY };
          hitType = 'water';
          if (step % every === 0) { points.push({ x: landing.x, y: landing.y }); }
          break;
        }
        if (step % every === 0) { points.push({ x: x, y: y }); }
      }

      return {
        points: points,
        allPoints: points,
        landing: { x: round2(landing.x), y: round2(landing.y) },
        start: { x: round2(launch.x), y: round2(launch.y) },
        hitType: hitType,
        bounces: 0,
        flightTimeMs: Math.round(Math.max(0, points.length * every) * dt * 1000),
        endVx: vx,
        endVy: vy,
        apexY: round2(apexY),
        apexRise: round2(launch.y - apexY)
      };
    }

    /**
     * 预览用的落地高度：起跳点正下方的支撑面顶面 − 碰撞半径。
     * 拿不到支撑面时返回 null（预览只能靠 maxFlightMs 截断）。
     * @param {FK.UnitBase} unit
     * @param {number} radius
     * @returns {number|null}
     */
    queryLandingY(unit, radius) {
      const launch = this.getLaunchPoint(unit);
      const provider = unit && unit.supportProvider;
      if (typeof provider !== 'function') { return null; }
      const r = num(radius, 24);
      // 从起跳点向下找支撑面（与 BattleScene.buildSupportY 同口径）
      const supportY = provider(launch.x, launch.y + r);
      return (typeof supportY === 'number' && isFinite(supportY)) ? (supportY - r) : null;
    }

    /* ==================================================================
     * 生效：松手 → 单位起跳
     * ================================================================== */

    /**
     * 松手，移动正式生效。
     *   ① 占用本回合行动口令（与投掷互斥）；
     *   ② 单位按预览的初速度起跳（落地由 UnitBase.stepActiveMove 每帧推进）；
     *   ③ 广播 move:end。
     * @returns {boolean} 是否成功生效
     */
    commitPlan() {
      if (!this.planning || !this.unit) { return false; }
      // 双重保险：规划期间回合已被占用（投掷 / 放置）/ 已进入终态 → 本次不生效
      if (!this.canAct() || this.isInputBlocked()) {
        this.cancelPlan('turn-used');
        return false;
      }
      const unit = this.unit;
      const shot = this.shot || computeMove({ dragX: 0, dragY: 0, maxSpeed: this.maxSpeed });
      const path = this.path || this.buildPath(unit, shot);
      const launch = this.getLaunchPoint(unit);
      const dragDist = Math.sqrt(
        (this.lastPointer.x - this.dragStart.x) * (this.lastPointer.x - this.dragStart.x) +
        (this.lastPointer.y - this.dragStart.y) * (this.lastPointer.y - this.dragStart.y)
      );
      // 拖拽距离过小 → 视为取消（与瞄准「拖回起始点即取消」同一套手感）
      const cancelDragPx = num((FK.Config && FK.Config.AIM) ? FK.Config.AIM.cancelDragPx : 20, 20);
      if (dragDist < cancelDragPx) {
        this.cancelPlan('drag-back');
        return false;                      // 未生效：不占回合、不移动
      }

      this.planning = false;
      this.unit = null;
      if (typeof unit.setAiming === 'function') { unit.setAiming(false); }

      // ① 本回合口令：移动每回合**只能一次**（移完还能投掷，但不能再移动）
      this.moveUsedThisTurn = true;
      this.movedUnit = unit;

      // ② 单位起跳（位置推进交给 UnitBase.stepActiveMove）
      unit.setPosition(launch.x, launch.y);
      unit.beginActiveMove(shot.vx, shot.vy, { targetY: path.landing.y });
      unit.moveTargetY = path.landing.y;
      // 记录起点，供 move:complete 统计位移
      unit.moveFromX = launch.x;
      unit.moveFromY = launch.y;

      this.activeUnit = unit;
      this.moveWindowMs = 0;
      this.pauseTurnTimer();
      this.stats.committed += 1;
      this.stats.bounces += path.bounces;

      this.emit(FK.EVENTS && FK.EVENTS.MOVE_END, {
        unitId: unit.getId(),
        team: unit.getTeam(),
        x: round2(unit.x), y: round2(unit.y),
        vx: Math.round(shot.vx * 100) / 100,
        vy: Math.round(shot.vy * 100) / 100,
        speed: Math.round(shot.speed * 100) / 100,
        powerRatio: Math.round(shot.powerRatio * 1000) / 1000,
        angleDeg: Math.round(shot.angleDeg * 1000) / 1000,
        bounces: path.bounces,
        landing: path.landing,
        hitType: path.hitType,
        waypoints: path.points,
        turnNumber: this.getTurnNumber()
      });

      this.log('移动生效：' + unit.getId() + ' v=(' + Math.round(shot.vx) + ',' +
        Math.round(shot.vy) + ') 预计落点 (' + Math.round(path.landing.x) + ',' +
        Math.round(path.landing.y) + ') 弹回 ' + path.bounces + ' 次');

      return true;
    }

    /**
     * 取消本次拖拽（不占用回合、不移动单位）
     * @param {string} [reason]
     * @returns {boolean} 恒为 false —— 取消 = 本次「提交」没有生效，
     *                   调用方（含自检）只需要用返回值判断「有没有真的移动」
     */
    cancelPlan(reason) {
      if (!this.planning) { return false; }
      const unit = this.unit;
      this.planning = false;
      this.unit = null;
      this.shot = null;
      this.path = null;
      if (unit && typeof unit.setAiming === 'function') { unit.setAiming(false); }
      this.stats.cancelled += 1;
      this.emit(FK.EVENTS && FK.EVENTS.MOVE_CANCEL, {
        unitId: unit ? unit.getId() : '',
        reason: reason || 'manual',
        x: unit ? Math.round(unit.x) : 0,
        y: unit ? Math.round(unit.y) : 0,
        committed: false
      });
      this.log('移动取消（原因：' + (reason || 'manual') + '）');
      return true;
    }

    /* ==================================================================
     * 执行：每帧推进
     * ================================================================== */

    /**
     * 每帧推进（BattleScene.update 调用）
     *   · 单位由 UnitBase.stepActiveMove 推进（与投掷共用同一份积分原语 + 弹性碰撞）；
     *   · 落地 / 撞墙停下 / 超时 → move:complete，并让回合继续流转；
     *   · 落水 → 单位已被 BattleScene 的 DeathSystem 判死，这里只负责收尾事件。
     * @param {number} deltaMs
     * @returns {MoveController} this
     */
    update(deltaMs) {
      const dt = Math.max(0, num(deltaMs, 0));
      this.elapsedMs += dt;
      if (this.planning) {
        // 规划中：单位阵亡 → 取消
        if (!this.unit || this.unit.alive === false || this.unit.active === false) {
          this.cancelPlan('unit-lost');
        }
        return this;
      }

      const unit = this.activeUnit;
      if (!unit) { return this; }
      this.moveWindowMs += dt;

      if (unit.alive === false) {
        // 落水 / 阵亡：单位自己已停住，这里补一次收尾事件
        this.finishMove(unit, 'drowned');
        return this;
      }

      if (typeof unit.stepActiveMove === 'function') { unit.stepActiveMove(dt); }

      if (!unit.moving) {
        this.finishMove(unit, unit.moveEndReason || 'landed');
        return this;
      }
      if (this.moveWindowMs >= this.maxFlightMs) {
        // 兜底：任何情况下都不会卡在「移动中」
        unit.finishActiveMove('timeout');
        this.finishMove(unit, 'timeout');
      }
      return this;
    }

    /**
     * 移动收尾：广播 move:complete，并把回合推进到 TURN_END（→ 自动轮到对方）
     * @param {FK.UnitBase} unit
     * @param {string} reason
     */
    pauseTurnTimer() {
      const tm = this.turnManager;
      if (tm && typeof tm.pauseTimer === 'function') { tm.pauseTimer(); }
    }

    resumeTurnTimer() {
      const tm = this.turnManager;
      if (tm && typeof tm.resumeTimer === 'function') { tm.resumeTimer(); }
    }

    finishMove(unit, reason) {
      if (!unit || this.activeUnit !== unit) { return false; }
      this.activeUnit = null;
      this.resumeTurnTimer();

      const fromX = num(unit.moveFromX, unit.x);
      const fromY = num(unit.moveFromY, unit.y);
      const payload = {
        unitId: unit.getId(),
        team: unit.getTeam(),
        fromX: fromX,
        fromY: fromY,
        x: round2(unit.x),
        y: round2(unit.y),
        distance: round2(Math.sqrt((unit.x - fromX) * (unit.x - fromX) + (unit.y - fromY) * (unit.y - fromY))),
        distanceUnits: round2(Math.abs(unit.x - fromX) / this.pxPerUnit),
        bounces: unit.getMoveBounceCount ? unit.getMoveBounceCount() : 0,
        reason: reason || 'landed',
        turnNumber: this.getTurnNumber()
      };
      this.lastMove = payload;
      this.stats.completed += 1;
      this.stats.bounces += payload.bounces;

      this.emit(FK.EVENTS && FK.EVENTS.MOVE_COMPLETE, payload);
      this.log('移动完成：' + payload.unitId + ' @(' + payload.x + ',' + payload.y +
        ') 位移 ' + payload.distance + 'px（' + payload.distanceUnits + 'u）· 弹回 ' +
        payload.bounces + ' 次 · ' + payload.reason +
        ' → 本回合仍可投掷，但不能再次移动');

      // 第 8.6 步：移动**不结束回合** —— 「每回合只能移动一次，移完可投掷，不能再移动」
      // 因此这里不推进 TURN_END；回合仍由投掷 / 放置或倒计时正常收尾。
      return true;
    }

    /**
     * 让回合继续流转：SELECT_UNIT / AIMING → TURN_END →（自动）SWITCH_TEAM → 下一回合。
     * 与投掷链路同源（FK.TurnStates 的流转表），不走任何「跨回合」的捷径。
     * @returns {boolean} 是否成功推进
     */
    advanceTurn() {
      const tm = this.turnManager;
      if (!tm || typeof tm.requestState !== 'function') { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : {};
      const st = (typeof tm.getState === 'function') ? tm.getState() : '';
      if (st === S.GAME_OVER) { return false; }
      if (st === S.TURN_END || st === S.SWITCH_TEAM) { return true; }
      if (tm.requestState(S.TURN_END, 'moved')) { return true; }
      if (typeof tm.endTurn === 'function') { tm.endTurn('moved'); }
      return false;
    }

    /* ==================================================================
     * 查询 / 清理
     * ================================================================== */

    /** 当前是否在移动的任意阶段（拖拽中 / 单位飞行中） */
    isActive() { return !!(this.planning || this.activeUnit); }

    /** HUD 用状态快照 */
    getState() {
      const shot = this.shot || {};
      const path = this.path || {};
      return {
        enabled: true,
        active: this.isMoveActive(),
        moveMode: this.isMoveActive(),
        planning: !!this.planning,
        flying: !!this.activeUnit,
        moveUsed: this.isMoveUsed(),
        canUseMove: this.canUseMove(),
        unitId: this.unit ? this.unit.getId() : (this.activeUnit ? this.activeUnit.getId() : ''),
        powerRatio: this.planning ? (shot.powerRatio || 0) : 0,
        angleDeg: this.planning ? (shot.angleDeg || 0) : 0,
        speed: this.planning ? (shot.speed || 0) : 0,
        vx: this.planning ? (shot.vx || 0) : 0,
        vy: this.planning ? (shot.vy || 0) : 0,
        landing: this.planning ? (path.landing || null) : null,
        hitType: this.planning ? (path.hitType || 'none') : 'none',
        bounces: this.planning ? (path.bounces || 0) : 0,
        pointCount: this.planning ? ((path.points || []).length) : 0,
        maxSpeed: this.maxSpeed,
        restitution: this.restitution,
        stats: {
          started: this.stats.started,
          committed: this.stats.committed,
          completed: this.stats.completed,
          cancelled: this.stats.cancelled,
          bounces: this.stats.bounces
        },
        lastMove: this.lastMove
      };
    }

    /** 统计快照 */
    getStats() {
      return {
        started: this.stats.started,
        committed: this.stats.committed,
        completed: this.stats.completed,
        cancelled: this.stats.cancelled,
        bounces: this.stats.bounces
      };
    }

    /** 重开对局：清掉全部移动状态 */
    reset() {
      if (this.planning) { this.cancelPlan('reset'); }
      if (this.activeUnit) {
        if (typeof this.activeUnit.finishActiveMove === 'function') { this.activeUnit.finishActiveMove('reset'); }
        this.activeUnit = null;
      }
      this.resumeTurnTimer();
      this.moveUsedThisTurn = false;
      this.movedUnit = null;
      this.unit = null;
      this.shot = null;
      this.path = null;
      this.lastMove = null;
      this.stats = { started: 0, committed: 0, completed: 0, cancelled: 0, bounces: 0 };
      this.setCursor('default');
      return this;
    }

    /** 销毁：解绑全部监听 */
    destroy() {
      if (this.planning) { this.cancelPlan('destroy'); }
      const input = this.scene && this.scene.input;
      if (input && typeof input.off === 'function') {
        input.off('pointerdown', this.onPointerDownBound);
        input.off('pointermove', this.onPointerMoveBound);
        input.off('pointerup', this.onPointerUpBound);
        if (input.keyboard && typeof input.keyboard.off === 'function') {
          input.keyboard.off('keydown-ESC', this.onEscBound);
        }
      }
      if (this.events && FK.EVENTS) {
        this.events.off(FK.EVENTS.TURN_SWITCH, this.onTurnChangeBound);
        this.events.off(FK.EVENTS.TURN_END, this.onTurnChangeBound);
        this.events.off(FK.EVENTS.TURN_TIMEOUT, this.onTurnChangeBound);
        this.events.off(FK.EVENTS.TURN_STATE_CHANGE, this.onStateChangedBound);
      }
      this.activeUnit = null;
      this.unit = null;
      this.predictor = null;
      this.turnManager = null;
      this.unitSelector = null;
    }

    /* ---------------- 内部 ---------------- */

    /** 切换鼠标光标（移动模式给个提示；不改变任何游戏状态） */
    setCursor(name) {
      const input = this.scene && this.scene.input;
      if (input && typeof input.setDefaultCursor === 'function') {
        try { input.setDefaultCursor(name === 'move' ? 'crosshair' : 'default'); } catch (e) { /* 忽略 */ }
      }
    }

    emit(type, payload) {
      if (this.events && type) { this.events.emit(type, payload); }
    }

    log(msg) {
      if (FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled) {
        console.log('[MoveController] ' + msg);
      }
    }
  }

  /* 静态纯函数入口（自检 / AI 预判复用） */
  MoveController.computeMove = computeMove;
  MoveController.simulatePath = simulatePath;

  FK.MoveController = MoveController;
})();
