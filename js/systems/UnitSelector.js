/**
 * ============================================================
 * UnitSelector.js —— 单位选择系统
 * ============================================================
 * 职责：
 *   · 鼠标悬停 → 高亮单位（update() 中每帧做圆形拾取，稳定且易测试）
 *   · 鼠标点击 → 选中单位（只允许选中当前回合阵营）
 *   · 选中新单位时自动取消旧选中（同一时刻只有 1 个选中）
 *   · 回合切换 / 回合结束时自动取消选中（与 TurnManager 联动）
 *   · 全部关键节点通过 EventBus 广播：unit:hover / unit:selected / unit:deselected
 *
 * 与 TurnManager 的关系：
 *   UnitSelector 只读 TurnManager 的 getCurrentTeam()，不反过来调用它，
 *   因此 TurnManager 可以独立替换与测试。
 *
 * 依赖：FK.EventBus、FK.EVENTS、Phaser（场景与指针）
 * 对外：FK.UnitSelector
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  class UnitSelector {

    /**
     * @param {Phaser.Scene} scene 战斗场景
     * @param {Array} units 已实例化的单位列表
     * @param {FK.TurnManager} [turnManager] 回合状态机（用于阵营限制）
     */
    constructor(scene, units, turnManager) {
      this.scene = scene;
      this.units = units || [];
      this.turnManager = turnManager || null;

      /** 当前选中的单位 */
      this.selected = null;
      /** 当前悬停的单位 */
      this.hovered = null;
      /** () => Unit|null：本回合已移动的单位，锁定后只能选它行动 */
      this.actionLockProvider = null;

      /** 点击是否允许冒泡给后续步骤（第 5 步拖拽会用到） */
      this.enabled = true;

      this.onPointerDownBound = this.onPointerDown.bind(this);
      this.onTurnSwitchBound = this.onTurnChange.bind(this);
      this.onTurnEndBound = this.onTurnEnd.bind(this);

      if (this.scene && this.scene.input) {
        this.scene.input.on('pointerdown', this.onPointerDownBound);
      }
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.on(FK.EVENTS.TURN_SWITCH, this.onTurnSwitchBound);
        FK.EventBus.on(FK.EVENTS.TURN_END, this.onTurnEndBound);
      }
    }

    /* ==================================================================
     * 每帧：悬停检测
     * ================================================================== */

    /**
     * @param {number} [deltaTime] 距上一帧毫秒数（本步未使用，保留接口）
     */
    update(deltaTime) {
      if (!this.scene || !this.scene.input) { return; }
      // 第 8 步：GAME_OVER 后不再接受鼠标输入（悬停高亮一并停掉）
      if (this.isPlayerInputBlocked()) {
        this.setHovered(null);
        return;
      }
      const p = this.scene.input.activePointer;
      this.setHovered(this.hitTest(p.worldX, p.worldY));
    }

    /**
     * 第 8 步：是否处于「禁止输入」状态。
     * 判据是回合状态机的终态 GAME_OVER（meta.acceptsInput === false），
     * 因此重开对局（reset + start）后无需任何额外复位就自动恢复可点。
     */
    isInputBlocked() {
      if (!this.enabled) { return true; }
      const tm = this.turnManager;
      if (!tm || typeof tm.getState !== 'function') { return false; }
      const S = (FK.TurnStates && FK.TurnStates.STATES) ? FK.TurnStates.STATES : null;
      return !!(S && tm.getState() === S.GAME_OVER);
    }

    /**
     * 玩家鼠标是否被锁（GAME_OVER 或 AI 回合）。
     * 不并入 isInputBlocked / canSelect：AI 仍要用 select() 同步 HUD。
     */
    isPlayerInputBlocked() {
      if (this.isInputBlocked()) { return true; }
      if (FK.Config && typeof FK.Config.isPaused === 'function' && FK.Config.isPaused()) { return true; }
      return !!(FK.Config && typeof FK.Config.isAiTurn === 'function' &&
        FK.Config.isAiTurn(this.turnManager));
    }

    /**
     * 圆形拾取：从后往前（后创建的在视觉上层）
     * 第 8 步起同时跳过已阵亡单位（死亡单位不能成为选中 / 投掷目标）
     * @param {number} x 世界坐标
     * @param {number} y 世界坐标
     * @returns {FK.UnitBase|null}
     */
    hitTest(x, y) {
      for (let i = this.units.length - 1; i >= 0; i--) {
        const u = this.units[i];
        if (!u || u.active === false) { continue; }
        if (u.alive === false) { continue; }
        if (typeof u.containsPoint === 'function' && u.containsPoint(x, y)) { return u; }
      }
      return null;
    }

    /**
     * 设置悬停单位（状态变化时才广播）
     * @param {FK.UnitBase|null} unit
     */
    setHovered(unit) {
      if (this.hovered === unit) { return; }

      if (this.hovered) {
        this.hovered.setHovered(false);
        this.emit(FK.EVENTS && FK.EVENTS.UNIT_HOVER, {
          id: this.hovered.getId(), team: this.hovered.getTeam(), hovered: false
        });
      }

      this.hovered = unit || null;

      if (this.hovered) {
        this.hovered.setHovered(true);
        this.emit(FK.EVENTS && FK.EVENTS.UNIT_HOVER, {
          id: this.hovered.getId(), team: this.hovered.getTeam(), hovered: true
        });
      }
    }

    /* ==================================================================
     * 点击：选中
     * ================================================================== */

    /** 鼠标按下（只响应左键；右键留给 AimController 取消瞄准） */
    onPointerDown(pointer) {
      if (!this.enabled) { return; }
      if (!pointer) { return; }
      // 第 8 步：GAME_OVER 后选中被禁止（点击不再选中 / 取消选中）
      if (this.isPlayerInputBlocked()) { return; }
      if (typeof pointer.rightButtonDown === 'function' && pointer.rightButtonDown()) { return; }
      if (typeof pointer.leftButtonDown === 'function' && !pointer.leftButtonDown()) { return; }

      const wx = numOr(pointer.worldX, numOr(pointer.x, -1));
      const wy = numOr(pointer.worldY, numOr(pointer.y, -1));
      const sx = numOr(pointer.x, wx);
      const sy = numOr(pointer.y, wy);

      /**
       * 第 8.5 步：点在**底部 UI**（模式条 / 道具栏）上时不算「点空白」。
       * 道具栏是镜头 HUD 坐标，必须用 pointer.x/y，不能用世界坐标。
       */
      if (this.isOverBottomUI(sx, sy)) { return; }

      const unit = this.hitTest(wx, wy);
      if (!unit) {
        this.deselect('empty-click');       // 点空白处取消选中
        return;
      }

      if (!this.canSelect(unit)) {
        this.log('拒绝选中：' + unit.getId() + ' 属于 ' + unit.getTeam() +
          '，当前回合阵营为 ' + this.getCurrentTeam());
        return;
      }

      this.select(unit);
    }

    /**
     * 第 8.5 / 8.6 步：坐标是否落在底部 UI 控件上（道具栏 4 格，含第 4 格「移动」）。
     * 该控件是场景级坐标命中，不是 GameObject 交互区，因此直接调用它的 hitTest。
     * 拿不到场景引用（Node 自检）时返回 false，行为与第 8 步完全一致。
     * @param {number} x 世界坐标
     * @param {number} y 世界坐标
     * @returns {boolean}
     */
    isOverBottomUI(x, y) {
      const scene = this.scene;
      if (!scene) { return false; }
      const itemBar = scene.itemBar;
      if (itemBar && typeof itemBar.hitTest === 'function' && itemBar.hitTest(x, y)) { return true; }
      return false;
    }

    /** 当前回合阵营（无 TurnManager 时不限制） */
    getCurrentTeam() {
      if (!this.turnManager || typeof this.turnManager.getCurrentTeam !== 'function') { return null; }
      return this.turnManager.getCurrentTeam();
    }

    /**
     * 是否允许选中该单位（只允许当前回合阵营）
     * @param {FK.UnitBase} unit
     */
    setActionLockProvider(fn) {
      this.actionLockProvider = (typeof fn === 'function') ? fn : null;
      return this;
    }

    getActionLockUnit() {
      if (typeof this.actionLockProvider !== 'function') { return null; }
      const u = this.actionLockProvider();
      if (!u || u.alive === false) { return null; }
      return u;
    }

    canSelect(unit) {
      if (!unit) { return false; }
      // 第 8 步：死亡单位不可选；GAME_OVER 后任何单位都不可选
      if (unit.alive === false) { return false; }
      if (this.isInputBlocked()) { return false; }
      const team = this.getCurrentTeam();
      if (team !== null && unit.getTeam() !== team) { return false; }
      const lock = this.getActionLockUnit();
      if (lock && unit !== lock) { return false; }
      return true;
    }

    /**
     * 选中单位
     * @param {FK.UnitBase} unit
     * @returns {boolean} 是否选中成功
     */
    select(unit) {
      if (!unit) { return false; }
      if (this.selected === unit) { return true; }
      if (!this.canSelect(unit)) { return false; }

      if (this.selected) { this.deselect('switch'); }

      this.selected = unit;
      unit.setSelected(true);

      this.emit(FK.EVENTS && FK.EVENTS.UNIT_SELECTED, {
        id: unit.getId(),
        team: unit.getTeam(),
        hp: unit.getHp(),
        maxHp: unit.getMaxHp(),
        turnNumber: (this.turnManager && this.turnManager.getTurnNumber) ? this.turnManager.getTurnNumber() : 0,
        unit: unit
      });
      this.log('已选中 ' + (typeof unit.describe === 'function' ? unit.describe() : unit.getId()));
      return true;
    }

    /**
     * 取消选中
     * @param {string} [reason] 取消原因（switch / empty-click / turn-switch / turn-end / destroy）
     * @returns {boolean} 是否发生了取消
     */
    deselect(reason) {
      if (!this.selected) { return false; }

      const unit = this.selected;
      this.selected = null;
      unit.setSelected(false);

      this.emit(FK.EVENTS && FK.EVENTS.UNIT_DESELECTED, {
        id: unit.getId(),
        team: unit.getTeam(),
        reason: reason || 'manual',
        unit: unit
      });
      this.log('已取消选中 ' + unit.getId() + '（原因：' + (reason || 'manual') + '）');
      return true;
    }

    /** 回合切换 → 取消选中（与 TurnManager 联动） */
    onTurnChange() {
      this.deselect('turn-switch');
    }

    /** 回合结束 → 取消选中 */
    onTurnEnd() {
      this.deselect('turn-end');
    }

    /* ==================================================================
     * 查询与清理
     * ================================================================== */

    /** 当前选中的单位 */
    getSelected() { return this.selected; }

    /** 当前悬停的单位 */
    getHovered() { return this.hovered; }

    /** 被选中的单位 id（HUD 直接使用） */
    getSelectedId() { return this.selected ? this.selected.getId() : ''; }

    /** 更换单位列表（对局重开时使用） */
    setUnits(units) {
      this.setHovered(null);
      this.deselect('units-changed');
      this.units = units || [];
    }

    /**
     * 第 8 步：阵亡单位出列（幂等）。
     * 若它正被悬停 / 选中，先清掉状态再摘掉引用，保证不会有「选中一个死人」的悬空状态。
     * @param {FK.UnitBase} unit
     * @returns {boolean} 本次是否真的移除了
     */
    removeUnit(unit) {
      if (!unit) { return false; }
      if (this.hovered === unit) { this.setHovered(null); }
      if (this.selected === unit) { this.deselect('died'); }
      const i = this.units.indexOf(unit);
      if (i < 0) { return false; }
      this.units.splice(i, 1);
      return true;
    }

    /** 清理监听与状态 */
    destroy() {
      if (this.scene && this.scene.input) {
        this.scene.input.off('pointerdown', this.onPointerDownBound);
      }
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.off(FK.EVENTS.TURN_SWITCH, this.onTurnSwitchBound);
        FK.EventBus.off(FK.EVENTS.TURN_END, this.onTurnEndBound);
      }
      this.setHovered(null);
      this.deselect('destroy');
      this.units = [];
      this.enabled = false;
    }

    /* ==================================================================
     * 内部工具
     * ================================================================== */

    emit(type, payload) {
      if (FK.EventBus && type) { FK.EventBus.emit(type, payload); }
    }

    log(msg) {
      if (FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled) {
        console.log('[UnitSelector] ' + msg);
      }
    }
  }

  /** 取数字，非法时回退默认值（第 8.5 步：兼容只有 x/y 没有 worldX/worldY 的指针） */
  function numOr(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  FK.UnitSelector = UnitSelector;
})();
