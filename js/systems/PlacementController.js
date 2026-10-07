/**
 * ============================================================
 * PlacementController.js —— 放置模式控制器（第 7.5 步新增）
 * ============================================================
 * 背景：水果箱（type = 'obstacle'）从「拖拽投掷」改为「**点击放置**」。
 *   投掷类道具仍然走 AimController 的抛物线分支；
 *   放置类道具由本类接管鼠标，全程不显示抛物线。
 *
 * 玩法（与策划 PRD 一致）：
 *   ① 选中水果箱 → 进入放置模式（广播 placement:start）
 *   ② 鼠标移动 → 指针位置就是木箱的**起始位置**，实时预览
 *   ③ 左键点击 → 木箱从该位置**自由落体**到最近的地面 / 平台 / 已有木箱顶面
 *   ④ 下方是果汁池 → 木箱落水销毁，不生成实体
 *   ⑤ 下落路径或落点会砸到任何单位 → 禁止放置（鼠标变叉，预览变红 + ✗）
 *   ⑥ 木箱之间允许重叠（后放的可以落在先放的箱子顶上）
 *   ⑦ 第 7.8 步：道具冷却中禁止放置（按阵营独立计算，见 FK.ItemCooldown）
 *   ⑧ 第 7.9 步：**已去掉「场上最多 2 个」的放置数量上限**
 *      （冷却 1 个自己的回合 + 存活 4 个 turn 已天然限制数量，总数上限只会让双方互相卡格子）
 *   ⑦ 放置占用一个回合：落地生成木箱后自动结束回合、轮到对方
 *
 * 分层与依赖：
 *   · 本类是**纯逻辑**（不画任何东西）：预览由注入的 FK.PlacementPreview 绘制
 *   · 碰撞世界来自 FK.ObstacleRegistry.getColliders()——与弹道碰撞**同一份数据**，
 *     所以放置预览看到的平台/木箱，和投掷物实飞看到的完全一致
 *   · 重力直接读 FK.Config.PHYSICS.gravityY，不新造第二个重力常量
 *   · 单帧步长钳制沿用 FK.Config.PROJECTILE.maxStepMs（与投掷物同一口径）
 *
 * 事件（常量见 js/config/events.js）：
 *   placement:start      进入放置模式
 *   placement:invalid    当前位置不可放置（原因见 payload.reason）
 *   placement:complete   放置完成（含 outcome = platform/obstacle/water/bounds）
 *   placement:cancelled  退出 / 取消放置模式
 *   item:used            道具被真正消费（与投掷路径同一事件，道具栏据此反馈）
 *
 * 本步刻意不做：AI、胜负判定、单位落水判定、死亡动画。
 *
 * 依赖：FK.EVENTS、FK.EventBus、FK.TurnStates、FK.Config、FK.ObstacleRegistry（注入）
 * 对外：FK.PlacementController
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 禁止放置的原因（同时是 HUD 提示的 key） */
  const REASON = {
    NONE: '',
    COOLDOWN: 'cooldown',    // 第 7.8 步：该方该道具还在冷却中
    USED: 'used',            // 本回合已经行动过（放置与投掷共用同一口令）
    TURN: 'turn',            // 当前回合状态不接受输入
    UNIT: 'unit',            // 下落路径 / 落点会砸到单位（第 7.9 步起唯一的「变叉」原因）
    NO_ITEM: 'no-item'       // 没有选中放置类道具
  };

  /** 落点类型 */
  const OUTCOME = {
    PLATFORM: 'platform',    // 落在地形平台顶面
    OBSTACLE: 'obstacle',    // 落在已有木箱顶面（允许重叠）
    INSIDE: 'inside',        // 点在平台内部 → 直接坐到该平台顶面
    WATER: 'water',          // 落入果汁池 → 销毁，不生成
    BOUNDS: 'bounds'         // 场底兜底
  };

  /** 中文提示（HUD 直接显示，避免各处各写一套文案） */
  const MESSAGE = {
    cooldown: '道具冷却中，本回合不能放置',
    used: '本回合已经行动过，等待对方回合',
    turn: '当前回合状态不允许放置',
    unit: '下落路径上有单位，不能放置',
    'no-item': '当前道具不是放置类'
  };

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  class PlacementController {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   item            初始道具配置（缺省由 setItem 下发）
     *   turnManager     TurnManager 实例（回合状态 / 结束回合）
     *   obstacleRegistry ObstacleRegistry 实例（生成木箱 + 读取碰撞世界）
 *   itemCooldown    FK.ItemCooldown 实例（按阵营判冷却，缺省 = 无冷却）
     *   units           单位数组或 () => 单位数组（下落路径合法性检测）
     *   preview         FK.PlacementPreview 实例（视觉，可缺省）
     *   turnGate        { canAct(), markActed() } 本回合行动口令
     *                   （BattleScene 注入 ProjectileController 的同一个口令，
     *                     保证「本回合已投掷」与「本回合已放置」互斥）
     *   blocksPoint     (x,y) => boolean，命中 UI（如道具栏）时不触发放置
     *   pxPerUnit       1 地图单位 = 多少像素
     *   gravityY        下落重力（缺省 FK.Config.PHYSICS.gravityY，不另造常量）
     *   eventBus        事件总线（缺省 FK.EventBus）
     */
    constructor(scene, opts) {
      opts = opts || {};
      const P = (FK.Config && FK.Config.PROJECTILE) ? FK.Config.PROJECTILE : {};
      const A = (FK.Config && FK.Config.AIM) ? FK.Config.AIM : {};
      const O = (FK.Config && FK.Config.OBSTACLE) ? FK.Config.OBSTACLE : {};
      const CFG = FK.Config || {};

      this.scene = scene || null;
      this.eventBus = opts.eventBus || FK.EventBus || null;
      this.turnManager = opts.turnManager || null;
      this.obstacleRegistry = opts.obstacleRegistry || null;
      this.preview = opts.preview || null;
      this.turnGate = opts.turnGate || null;
      this.blocksPoint = (typeof opts.blocksPoint === 'function') ? opts.blocksPoint : null;

      this.pxPerUnit = num(opts.pxPerUnit, num(CFG.PX_PER_UNIT, 48));
      /** 物理一致：直接复用实体重力，绝不新写一个 1500 */
      this.gravityY = num(opts.gravityY, (CFG.PHYSICS ? CFG.PHYSICS.gravityY : 1500));
      /** 单帧最大步进（与投掷物同源），避免掉帧穿地 */
      this.maxStepMs = num(opts.maxStepMs, num(P.maxStepMs, 50));
      /** 下落硬上限（与投掷物飞行上限同源），防止永远落不了地 */
      this.maxFallMs = num(opts.maxFallMs, num(P.maxFlightMs, 6000));
      /** 最大拖出竞技场的容差（0 = 必须完整落在场内） */
      this.arenaMarginPx = num(opts.arenaMarginPx, 0);

      this.unitsProvider = (typeof opts.units === 'function')
        ? opts.units
        : function () { return opts.units || []; };
      /** 注册表缺失时的兜底碰撞世界（自检可用） */
      this.world = opts.world || null;
      /**
       * 第 7.8 步：道具冷却表（FK.ItemCooldown）。注入后，冷却中的道具禁止放置；
       * 不注入则视为「无冷却」，玩法自动退化（纯逻辑仍可单测）。
       */
      this.itemCooldown = opts.itemCooldown || null;

      /* ---------------- 运行状态 ---------------- */
      /** 是否处于放置模式 */
      this.active = false;
      /** 当前道具配置与派生尺寸 */
      this.item = null;
      this.itemId = '';
      this.sizeUnits = num(opts.sizeUnits, 1.5);
      this.sizePx = this.sizeUnits * this.pxPerUnit;
      /** 本回合是否已经放置过（未注入 turnGate 时的兜底口令） */
      this.actedThisTurn = false;
      /** 本回合是否真的放成了木箱（用于「放置成功后自然退出」不广播 cancelled） */
      this.placedThisTurn = false;
      /** 指针世界坐标 */
      this.pointer = { x: 0, y: 0 };
      /** 指针是否已在竞技场里移动过（决定是否画预览） */
      this.hasPointer = false;
      /** 当前预览状态（getState 直接返回它的快照） */
      this.previewState = null;
      /** 正在下落的木箱（null = 没有下落） */
      this.fall = null;
      /** 最近一次完成 / 取消的原因 */
      this.lastReason = '';
      /** 统计 */
      this.stats = { started: 0, cancelled: 0, invalid: 0, placed: 0, drowned: 0 };

      this.onPointerMoveBound = this.onPointerMove.bind(this);
      this.onPointerDownBound = this.onPointerDown.bind(this);
      this.onEscBound = this.onEsc.bind(this);
      this.onTurnStateChangeBound = this.onTurnStateChange.bind(this);

      if (opts.item) { this.setItem(opts.item, { silent: true }); }
      this.bindInput();
    }

    /* ==================================================================
     * 输入与事件绑定
     * ================================================================== */

    bindInput() {
      const input = this.scene && this.scene.input;
      if (input && typeof input.on === 'function') {
        input.on('pointermove', this.onPointerMoveBound);
        input.on('pointerdown', this.onPointerDownBound);
        if (input.mouse && typeof input.mouse.disableContextMenu === 'function') {
          input.mouse.disableContextMenu();
        }
        if (input.keyboard && typeof input.keyboard.on === 'function') {
          input.keyboard.on('keydown-ESC', this.onEscBound);
        }
      }
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.on(FK.EVENTS.TURN_STATE_CHANGE, this.onTurnStateChangeBound);
      }
      return this;
    }

    /** 当前道具是否放置类（type === 'obstacle'）——AimController 用同一判据 */
    isPlacementItem(itemConfig) {
      const it = itemConfig || this.item;
      return !!(it && it.type === 'obstacle');
    }

    /* ==================================================================
     * 道具切换 / 模式启停
     * ================================================================== */

    /**
     * 下发当前道具（BattleScene 的唯一道具下发入口会调用它）
     *   放置类 → 进入放置模式；投掷类 → 退出放置模式
     * @param {FK.ItemConfig} itemConfig
     * @param {Object} [opts] { silent:true 不广播 }
     * @returns {PlacementController} this
     */
    setItem(itemConfig, opts) {
      const next = itemConfig || null;
      const nextId = next ? next.id : '';

      if (this.active && nextId !== this.itemId) { this.stop('item-changed', opts); }

      this.item = next;
      this.itemId = nextId;
      const units = num(next ? next.crateSizeUnits : null, this.sizeUnits);
      this.sizeUnits = units;
      this.sizePx = units * this.pxPerUnit;

      if (this.isPlacementItem(next)) {
        this.start(opts);
      } else if (this.active) {
        this.stop('item-changed', opts);
      }
      return this;
    }

    /**
     * 进入放置模式
     * @param {Object} [opts] { silent:true 不广播 }
     * @returns {boolean} 是否成功进入
     */
    start(opts) {
      const o = opts || {};
      if (!this.isPlacementItem()) { return false; }
      if (this.active) { return true; }

      this.active = true;
      this.stats.started += 1;
      this.hasPointer = false;

      if (!o.silent) {
        const st = this.getPlacementStatus();
        this.emit(FK.EVENTS && FK.EVENTS.PLACEMENT_START, {
          itemId: this.itemId,
          name: this.item ? this.item.name : '',
          sizeUnits: this.sizeUnits,
          sizePx: this.sizePx,
          count: st.count,
          cooldownRemaining: this.getCooldownRemaining(),
          turnNumber: this.getTurnNumber()
        });
      }
      this.refreshPreview();
      return true;
    }

    /**
     * 退出放置模式
     * @param {string} reason 'item-changed' | 'turn-end' | 'escape' | 'right-click' | 'destroy'
     * @param {Object} [opts] { silent:true 不广播；placed:true 是「放置成功后自然退出」}
     * @returns {boolean}
     */
    stop(reason, opts) {
      const o = opts || {};
      if (!this.active) { return false; }

      this.active = false;
      this.hasPointer = false;
      this.previewState = null;
      this.lastReason = reason || '';
      if (!o.silent) {
        this.stats.cancelled += 1;
        this.emit(FK.EVENTS && FK.EVENTS.PLACEMENT_CANCELLED, {
          itemId: this.itemId,
          reason: reason || '',
          placed: !!o.placed
        });
      }
      if (this.preview && typeof this.preview.hide === 'function' && !this.fall) {
        this.preview.hide();
      }
      return true;
    }

    /** 取消（ESC / 右键 / 回合变化）：与 stop 同义，语义更贴玩家操作 */
    cancel(reason) { return this.stop(reason || 'manual'); }

    /* ==================================================================
     * 指针输入
     * ================================================================== */

    isLivePointer(pointer) {
      return !!(pointer && typeof pointer.leftButtonDown === 'function');
    }

    /** 玩家指针锁定：AI 回合不接受真实鼠标（合成指针仍给 AI 探测用） */
    isPlayerInputBlocked() {
      return !!(FK.Config && typeof FK.Config.isAiTurn === 'function' &&
        FK.Config.isAiTurn(this.turnManager));
    }

    onPointerMove(pointer) {
      if (!pointer) { return false; }
      if (this.isLivePointer(pointer) && this.isPlayerInputBlocked()) { return false; }
      const p = this.resolvePointer(pointer);
      if (p === null) { return false; }
      if (!this.active || this.fall) { return false; }

      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.hasPointer = true;
      this.refreshPreview();
      return true;
    }

    onPointerDown(pointer) {
      if (!pointer) { return false; }
      // 右键：取消放置模式（与瞄准的右键取消保持一致的手感）
      if (typeof pointer.rightButtonDown === 'function' && pointer.rightButtonDown()) {
        if (this.active) { this.cancel('right-click'); }
        return false;
      }
      if (this.isLivePointer(pointer) && this.isPlayerInputBlocked()) { return false; }
      if (typeof pointer.leftButtonDown === 'function' && !pointer.leftButtonDown()) { return false; }
      if (!this.active || this.fall) { return false; }

      const p = this.resolvePointer(pointer);
      if (p === null) { return false; }
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.hasPointer = true;
      this.refreshPreview();

      return this.commit();
    }

    onEsc() {
      if (!this.active) { return false; }
      return this.cancel('escape');
    }

    /**
     * 指针 → 世界坐标；命中 UI（道具栏等）或超出画布时返回 null（视为与放置无关）
     * @returns {{x:number,y:number}|null}
     */
    resolvePointer(pointer) {
      const x = num(pointer.worldX, num(pointer.x, null));
      const y = num(pointer.worldY, num(pointer.y, null));
      if (x === null || y === null) { return null; }
      if (this.blocksPoint && this.blocksPoint(x, y)) { return null; }
      const canvas = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS : { width: 1600, height: 800 };
      if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) { return null; }
      return { x: x, y: y };
    }

    /* ==================================================================
     * 合法性判定（纯几何，可单独测试）
     * ================================================================== */

    /** 场上木箱数量快照（第 7.9 步：只是数量，不再是「上限 / 剩余名额」） */
    getPlacementStatus() {
      const reg = this.obstacleRegistry;
      if (reg && typeof reg.getPlacementStatus === 'function') { return reg.getPlacementStatus(); }
      const n = (reg && typeof reg.count === 'function') ? reg.count() : 0;
      return { total: n, count: n, cap: 0 };
    }

    /** 当前碰撞世界（地形 + 木箱），注册表缺失时用注入的 world 兜底 */
    getColliders() {
      const reg = this.obstacleRegistry;
      if (reg && typeof reg.getColliders === 'function') { return reg.getColliders(); }
      return this.world || { platforms: [], waterLevel: null, bounds: null };
    }

    /* ==================================================================
     * 第 7.8 步：道具冷却（按阵营独立计算）
     * ================================================================== */

    /** 当前行动方阵营（冷却按阵营分别记账） */
    getCurrentTeam() {
      const tm = this.turnManager;
      return (tm && typeof tm.getCurrentTeam === 'function') ? tm.getCurrentTeam() : '';
    }

    /** 当前行动方的该道具剩余冷却（自己还有几个行动回合不能用；0 = 可用） */
    getCooldownRemaining(itemId) {
      const id = itemId || this.itemId;
      if (!this.itemCooldown || typeof this.itemCooldown.getRemaining !== 'function') { return 0; }
      return Math.max(0, num(this.itemCooldown.getRemaining(this.getCurrentTeam(), id), 0));
    }

    /** 当前行动方的该道具是否已过冷却（可用） */
    isItemReady(itemId) {
      return this.getCooldownRemaining(itemId) <= 0;
    }

    /** 竞技场边界（夹紧预览位置用） */
    getBounds() {
      const w = this.getColliders();
      if (w && w.bounds && typeof w.bounds.left === 'number') { return w.bounds; }
      const CFG = FK.Config || {};
      const A = CFG.ARENA || { widthUnits: 30, heightUnits: 12 };
      return {
        left: CFG.arenaX ? CFG.arenaX(0) : 80,
        right: CFG.arenaX ? CFG.arenaX(A.widthUnits) : 1520,
        top: CFG.arenaY ? CFG.arenaY(0) : 112,
        bottom: CFG.arenaY ? CFG.arenaY(A.heightUnits) : 688
      };
    }

    /**
     * 单位碰撞盒：优先用 getBounds()，但它必须**有有效尺寸**才采用——
     * 本项目的单位是 Phaser Container（内部用 Graphics 画），
     * `Container.getBounds()` 在图形没有显式尺寸时会返回空矩形 (0,0,0,0)，
     * 直接采用会导致「下落路径压到单位」永远判不出来（第 7.5 步浏览器验证发现）。
     * 因此尺寸无效时回退到单位自己声明的拾取半径 getHitRadius()。
     */
    unitBounds(unit) {
      if (!unit) { return null; }
      if (typeof unit.getBounds === 'function') {
        const b = unit.getBounds();
        if (b && num(b.width, 0) > 0 && num(b.height, 0) > 0) {
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        }
      }
      const r = (typeof unit.getHitRadius === 'function')
        ? num(unit.getHitRadius(), 24) : num(unit.hitRadius, 24);
      return { x: num(unit.x, 0) - r, y: num(unit.y, 0) - r, width: r * 2, height: r * 2 };
    }

    /**
     * 从指针位置向下探测落点（纯函数：不改任何状态，供预览与自检直接调用）
     *
     * 探测规则（自上而下依次比较，谁更高谁先接住木箱）：
     *   ① 水平方向与木箱有重叠的矩形（地形平台 + 已有木箱）的顶面
     *   ② 果汁池液面（比上面①更靠上时，水先接住 → 落水销毁）
     *   ③ 都没有 → 竞技场底部兜底
     * 起点判定：木箱**底边**从 startBottom = y + sizePx/2 开始下落；
     *   若点在某个矩形内部（用户在平台里点的），直接坐到该矩形顶面（零距离落下）。
     *
     * @param {number} x 指针世界 X
     * @param {number} y 指针世界 Y
     * @returns {Object} 探测结果（见下方 return 字段）
     */
    probeGeometry(x, y) {
      const sizePx = this.sizePx;
      const half = sizePx / 2;
      const bounds = this.getBounds();
      const world = this.getColliders();
      const platforms = Array.isArray(world.platforms) ? world.platforms : [];
      const waterLevel = (typeof world.waterLevel === 'number') ? world.waterLevel : null;

      const px = clamp(num(x, 0), num(bounds.left, 0) + half, num(bounds.right, 0) - half);
      const py = num(y, 0);
      const startBottom = py + half;
      const left = px - half;
      const right = px + half;

      let target = null;   // { surfaceY, id, kind }
      let embedded = false;

      for (let i = 0; i < platforms.length; i++) {
        const r = platforms[i];
        if (!r) { continue; }
        const rw = num(r.width, 0);
        const rh = num(r.height, 0);
        if (right <= r.x || left >= r.x + rw) { continue; }        // 水平不重叠
        const top = num(r.y, 0);
        const isCrate = String(r.id || '').indexOf('obstacle_') === 0;
        const kind = isCrate ? OUTCOME.OBSTACLE : OUTCOME.PLATFORM;

        if (top >= startBottom - 0.001) {
          // 正常情况：木箱底边在平台顶面之上，向下掉落
          if (!target || top < target.surfaceY) { target = { surfaceY: top, id: r.id, kind: kind }; }
        } else if (startBottom <= top + rh) {
          // 点在平台内部：直接坐到这个平台的顶面（零距离落下）
          if (!target || top < target.surfaceY) {
            target = { surfaceY: top, id: r.id, kind: OUTCOME.INSIDE };
            embedded = true;
          }
        }
      }

      let outcome = target ? target.kind : OUTCOME.BOUNDS;
      let surfaceY = target ? target.surfaceY : num(bounds.bottom, py + 400);
      let hitId = target ? target.id : '';

      // 果汁池：比平台顶面更靠上时，水先接住
      if (waterLevel !== null && waterLevel < surfaceY) {
        outcome = OUTCOME.WATER;
        surfaceY = waterLevel;
        hitId = 'water';
      }
      if (!target && waterLevel === null) { outcome = OUTCOME.BOUNDS; }

      // ---- 下落路径（木箱起始顶边 → 落点）是否压到单位 ----
      // 第 8 步：已阵亡单位不再占位、也不参与任何碰撞，因此直接跳过
      const corridorTop = py - half;
      let hitUnit = null;
      const units = this.unitsProvider() || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || u.alive === false) { continue; }
        const b = this.unitBounds(u);
        if (!b) { continue; }
        const overlapX = right > b.x && left < b.x + b.width;
        const overlapY = surfaceY > b.y && corridorTop < b.y + b.height;
        if (overlapX && overlapY) { hitUnit = u; break; }
      }

      return {
        x: px,
        y: py,
        sizePx: sizePx,
        startBottom: startBottom,
        surfaceY: surfaceY,
        centerY: surfaceY - half,
        fallPx: Math.max(0, (surfaceY - half) - py),
        outcome: outcome,
        embedded: embedded,
        hitId: hitId,
        left: left,
        right: right,
        hitUnit: hitUnit,
        hitUnitId: hitUnit ? ((typeof hitUnit.getId === 'function') ? hitUnit.getId() : '') : ''
      };
    }

    /**
     * 完整合法性判定 = 几何结果 + 道具冷却 + 回合口令
     * 第 7.9 步起**不再有数量上限判定**（场上放多少个由冷却 + 存活时长天然限制）
     * @returns {Object} 预览状态（同时写入 this.previewState）
     */
    probe(x, y) {
      const g = this.probeGeometry(x, y);
      const st = this.getPlacementStatus();
      const cd = this.getCooldownRemaining();

      let valid = true;
      let reason = REASON.NONE;

      if (!this.isPlacementItem()) { valid = false; reason = REASON.NO_ITEM; }
      else if (cd > 0) { valid = false; reason = REASON.COOLDOWN; }
      else if (!this.canAct()) { valid = false; reason = REASON.USED; }
      else if (g.hitUnit) { valid = false; reason = REASON.UNIT; }

      const state = {
        active: this.active,
        itemId: this.itemId,
        x: g.x,
        y: g.y,
        sizePx: g.sizePx,
        sizeUnits: this.sizeUnits,
        valid: valid,
        reason: reason,
        message: cd > 0
          ? ('「' + (this.item && this.item.name ? this.item.name : this.itemId) +
             '」冷却中，还需等待 ' + cd + ' 个 turn')
          : (MESSAGE[reason] || ''),
        cooldownRemaining: cd,
        outcome: g.outcome,
        surfaceY: g.surfaceY,
        centerY: g.centerY,
        fallPx: g.fallPx,
        hitId: g.hitId,
        hitUnitId: g.hitUnitId,
        embedded: g.embedded,
        count: st.count,
        cap: st.cap,
        falling: false,
        placedPx: this.fall ? this.fall.y : null
      };
      this.previewState = state;
      return state;
    }

    /**
     * 本回合是否还能行动（未行动 + 回合状态接受输入）
     * 口令优先取注入的 turnGate——它与投掷共享同一个 thrownThisTurn，
     * 于是「投过了就不能再放」「放过了就不能再投」天然互斥。
     */
    canAct() {
      const gateOk = this.turnGate && typeof this.turnGate.canAct === 'function'
        ? !!this.turnGate.canAct()
        : !this.actedThisTurn;
      if (!gateOk) { return false; }

      const tm = this.turnManager;
      if (!tm || typeof tm.getState !== 'function') { return true; }
      const TS = FK.TurnStates;
      if (!TS || typeof TS.metaOf !== 'function') { return true; }
      const meta = TS.metaOf(tm.getState());
      return !meta || meta.acceptsInput !== false;
    }

    /** 占用本回合口令（放置成功后调用） */
    markActed() {
      this.actedThisTurn = true;
      if (this.turnGate && typeof this.turnGate.markActed === 'function') {
        this.turnGate.markActed();
      }
      return this;
    }

    /* ==================================================================
     * 提交与下落
     * ================================================================== */

    /**
     * 左键提交：合法则开始自由落体（视觉），落地后生成木箱
     * @returns {boolean} 是否开始下落
     */
    commit() {
      if (this.fall) { return false; }
      const p = this.previewState || (this.hasPointer ? this.probe(this.pointer.x, this.pointer.y) : null);
      if (!p) { return false; }

      if (!p.valid) {
        this.stats.invalid += 1;
        this.emit(FK.EVENTS && FK.EVENTS.PLACEMENT_INVALID, {
          itemId: this.itemId,
          reason: p.reason,
          message: p.message,
          x: Math.round(p.x),
          y: Math.round(p.y),
          count: p.count,
          turnNumber: this.getTurnNumber()
        });
        return false;
      }

      this.fall = {
        x: p.x,
        y: p.y,
        vy: 0,
        elapsedMs: 0,
        sizePx: p.sizePx,
        surfaceY: p.surfaceY,
        outcome: p.outcome,
        targetCenterY: p.centerY,
        hitId: p.hitId
      };
      p.falling = true;
      this.syncPreview();
      return true;
    }

    /**
     * 每帧驱动下落（自由落体，使用与投掷物同一个重力常量）
     * @param {number} deltaMs
     */
    update(deltaMs) {
      if (this.fall) { this.stepFall(num(deltaMs, 0)); }
      return this;
    }

    stepFall(deltaMs) {
      const f = this.fall;
      if (!f) { return false; }

      // 单帧步长钳制：掉帧 / 切后台回来不允许一帧穿地
      const ms = Math.min(Math.max(0, num(deltaMs, 0)), this.maxStepMs);
      const dt = ms / 1000;

      f.elapsedMs += ms;
      f.vy += this.gravityY * dt;
      f.y += f.vy * dt;

      const reached = (f.y >= f.targetCenterY);
      const timedOut = f.elapsedMs >= this.maxFallMs;
      if (reached || timedOut) {
        f.y = f.targetCenterY;
        this.syncPreview();
        return this.finishFall(timedOut && !reached);
      }
      this.syncPreview();
      return false;
    }

    /** 落地：生成木箱（落水则销毁），广播 placement:complete，并结束回合 */
    finishFall(timedOut) {
      const f = this.fall;
      if (!f) { return false; }
      this.fall = null;

      const reg = this.obstacleRegistry;
      const owner = this.ownerUnit();
      let obstacle = null;
      let outcome = f.outcome;

      if (outcome === OUTCOME.WATER) {
        this.stats.drowned += 1;                 // 落水：木箱被果汁池吞掉，不生成
      } else if (reg && typeof reg.spawn === 'function') {
        // 第 7.9 步：不再有数量上限，落地即生成（冷却是唯一的节奏限制）
        {
          obstacle = reg.spawn({
            scene: this.scene,
            itemId: this.itemId,
            team: owner ? ((typeof owner.getTeam === 'function') ? owner.getTeam() : '') : '',
            ownerId: owner ? ((typeof owner.getId === 'function') ? owner.getId() : '') : '',
            x: f.x,
            y: f.targetCenterY,
            sizeUnits: this.sizeUnits,
            duration: this.item ? this.item.duration : undefined,
            turnNumber: this.getTurnNumber()
          });
          if (obstacle) { this.stats.placed += 1; }
        }
      }

      const payload = {
        itemId: this.itemId,
        outcome: outcome,
        destroyed: outcome === OUTCOME.WATER,
        obstacleId: obstacle ? obstacle.obstacleId : null,
        x: Math.round(f.x),
        y: Math.round(f.targetCenterY),
        sizeUnits: this.sizeUnits,
        remainingTurns: obstacle ? obstacle.getRemainingTurns() : 0,
        turnNumber: this.getTurnNumber(),
        ownerId: owner ? ((typeof owner.getId === 'function') ? owner.getId() : '') : '',
        team: owner ? ((typeof owner.getTeam === 'function') ? owner.getTeam() : '') : '',
        timedOut: !!timedOut
      };

      this.emit(FK.EVENTS && FK.EVENTS.PLACEMENT_COMPLETE, payload);
      this.emitItemUsed(obstacle);

      // 放置占用一个回合：无论落水还是生成木箱，道具都已消费、回合立刻结束
      this.placedThisTurn = true;
      this.markActed();
      this.stop('placed', { silent: true, placed: true });
      this.endTurn();

      this.log('放置完成：' + outcome +
        ' @(' + payload.x + ',' + payload.y + ') 木箱 #' + (payload.obstacleId === null ? '-' : payload.obstacleId) +
        '，本回合结束');
      return true;
    }

    /** 广播 item:used（与投掷路径同一事件：道具被真正消费） */
    emitItemUsed(obstacle) {
      const owner = this.ownerUnit();
      if (!(FK.EVENTS && FK.EVENTS.ITEM_USED)) { return this; }
      this.emit(FK.EVENTS.ITEM_USED, {
        itemId: this.itemId,
        unitId: owner ? ((typeof owner.getId === 'function') ? owner.getId() : '') : '',
        team: owner ? ((typeof owner.getTeam === 'function') ? owner.getTeam() : '') : '',
        turnNumber: this.getTurnNumber(),
        source: 'placement',
        obstacleId: obstacle ? obstacle.obstacleId : null,
        projectileId: null
      });
      return this;
    }

    /** 结束当前回合（放置占用一个回合，放完自动轮到对方） */
    endTurn() {
      const tm = this.turnManager;
      if (!tm || typeof tm.endTurn !== 'function') { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : {};
      if (typeof tm.getState === 'function' && tm.getState() === S.TURN_END) { return true; }
      return tm.endTurn('placed');
    }

    /** 放置方（当前回合阵营里第一个还活着的单位；找不到则返回 null） */
    ownerUnit() {
      const team = (this.turnManager && typeof this.turnManager.getCurrentTeam === 'function')
        ? this.turnManager.getCurrentTeam() : '';
      const units = this.unitsProvider() || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u) { continue; }
        const t = (typeof u.getTeam === 'function') ? u.getTeam() : u.team;
        if (team && t !== team) { continue; }
        if (typeof u.isAlive === 'function' && !u.isAlive()) { continue; }
        return u;
      }
      return null;
    }

    /* ==================================================================
     * 预览同步与回合事件
     * ================================================================== */

    /** 重算预览并推给视觉层 */
    refreshPreview() {
      if (!this.active || this.fall) { return this.previewState; }
      if (!this.hasPointer) {
        if (this.preview && typeof this.preview.hide === 'function') { this.preview.hide(); }
        return this.previewState;
      }
      const before = this.previewState ? this.previewState.valid : null;
      const st = this.probe(this.pointer.x, this.pointer.y);
      // 只在「合法性发生变化」时广播，避免鼠标一动就刷屏
      if (before === null || before !== st.valid) {
        if (!st.valid) {
          this.emit(FK.EVENTS && FK.EVENTS.PLACEMENT_INVALID, {
            itemId: this.itemId, reason: st.reason, message: st.message,
            x: Math.round(st.x), y: Math.round(st.y),
            count: st.count, turnNumber: this.getTurnNumber()
          });
        }
      }
      this.syncPreview();
      return st;
    }

    /** 把当前状态推给预览视觉（无视觉对象时静默） */
    syncPreview() {
      if (!this.preview || typeof this.preview.render !== 'function') { return this; }
      const st = this.previewState;
      if (this.fall) {
        this.preview.render({
          x: this.fall.x, y: this.fall.y, sizePx: this.fall.sizePx,
          valid: true, reason: '', outcome: this.fall.outcome,
          falling: true, surfaceY: this.fall.surfaceY
        });
        return this;
      }
      if (!this.active || !st) {
        if (typeof this.preview.hide === 'function') { this.preview.hide(); }
        return this;
      }
      this.preview.render(st);
      return this;
    }

    /**
     * 回合状态变化：
     *   · 进入 TURN_START：复位本回合口令；若当前仍是放置类道具则重新进入放置模式
     *   · 进入 TURN_END：退出放置模式（放置成功导致的收尾不再广播 cancelled）
     *   · 进入 GAME_OVER（第 8 步）：对局已结束 → 立即退出放置模式并清掉预览
     */
    onTurnStateChange(payload) {
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : {};
      if (!payload) { return; }
      if (payload.to === S.TURN_START) {
        this.actedThisTurn = false;
        this.placedThisTurn = false;
        if (this.isPlacementItem() && !this.active) { this.start(); }
      } else if (payload.to === S.TURN_END) {
        if (this.active) { this.stop('turn-end', { silent: this.placedThisTurn }); }
      } else if (payload.to === S.GAME_OVER) {
        if (this.active) { this.stop('game-over', { silent: true }); }
        if (this.preview && typeof this.preview.hide === 'function') { this.preview.hide(); }
      }
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    isActive() { return this.active; }

    /** 当前预览状态快照（未移动过指针时为 null） */
    getPreview() {
      return this.previewState ? Object.assign({}, this.previewState) : null;
    }

    /** HUD / 自检用状态快照（含下落进度） */
    getState() {
      const st = this.previewState ? Object.assign({}, this.previewState) : {
        active: this.active, itemId: this.itemId, valid: false, reason: REASON.NONE,
        outcome: '', x: 0, y: 0, sizePx: this.sizePx, count: 0, cap: this.getPlacementStatus().cap
      };
      st.active = this.active;
      st.falling = !!this.fall;
      if (this.fall) {
        st.x = Math.round(this.fall.x);
        st.y = Math.round(this.fall.y);
        st.surfaceY = this.fall.surfaceY;
        st.outcome = this.fall.outcome;
      }
      st.canAct = this.canAct();
      st.cooldownRemaining = this.getCooldownRemaining();
      st.gravityY = this.gravityY;
      st.lastReason = this.lastReason;
      return st;
    }

    getTurnNumber() {
      const tm = this.turnManager;
      return (tm && typeof tm.getTurnNumber === 'function') ? tm.getTurnNumber() : 0;
    }

    getStats() {
      return {
        started: this.stats.started,
        cancelled: this.stats.cancelled,
        invalid: this.stats.invalid,
        placed: this.stats.placed,
        drowned: this.stats.drowned,
        active: this.active,
        falling: !!this.fall
      };
    }

    /* ---------------- 内部 ---------------- */

    emit(type, payload) {
      if (this.eventBus && type) { this.eventBus.emit(type, payload); }
    }

    log(msg) {
      if (FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled) {
        console.log('[PlacementController] ' + msg);
      }
    }

    /** 销毁：解绑输入与事件，清掉预览 */
    destroy() {
      const input = this.scene && this.scene.input;
      if (input && typeof input.off === 'function') {
        input.off('pointermove', this.onPointerMoveBound);
        input.off('pointerdown', this.onPointerDownBound);
        if (input.keyboard && typeof input.keyboard.off === 'function') {
          input.keyboard.off('keydown-ESC', this.onEscBound);
        }
      }
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.off(FK.EVENTS.TURN_STATE_CHANGE, this.onTurnStateChangeBound);
      }
      this.stop('destroy', { silent: true });
      this.fall = null;
      this.previewState = null;
      this.item = null;
      this.turnManager = null;
      this.obstacleRegistry = null;
      this.preview = null;
      this.turnGate = null;
      this.itemCooldown = null;
      this.blocksPoint = null;
      this.scene = null;
    }
  }

  PlacementController.REASON = Object.freeze(REASON);
  PlacementController.OUTCOME = Object.freeze(OUTCOME);
  PlacementController.MESSAGE = Object.freeze(MESSAGE);

  FK.PlacementController = PlacementController;
})();
