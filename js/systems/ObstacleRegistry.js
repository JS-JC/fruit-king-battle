/**
 * ============================================================
 * ObstacleRegistry.js —— 障碍物注册表（第 7 步新增）
 * ============================================================
 * 职责：
 *   ① 登记 / 移除场上的静态障碍物（水果箱放置生成，到期消失）
 *   ② **把障碍物矩形同步进 TrajectoryPredictor 的碰撞世界**——
 *      这是「障碍物参与后续投掷物碰撞」的全部实现：箱子与地形平台
 *      在预测与实飞里走同一条碰撞路径，不需要第二份碰撞代码
 *   ③ 每回合结束广播 turn:obstacleTick，并把所有障碍物倒计时 -1，
 *      到期的发 obstacle:removed 并销毁
 *   ④ 给放置模式读的碰撞世界快照（getColliders）
 *      （第 7.9 步已去掉「场上最多 2 个」的放置数量上限：冷却 + 存活时长已天然限制数量，
 *       maxCount 仅作为内存 / 碰撞安全阀保留）
 *
 * 倒计时口径（第 7.6 步定稿）：
 *   `duration` = **存活 turn 数，放置回合也计入**。每回合结束扣 1，归零即移除。
 *   例：蓝方 Turn 1 放置（fruit_crate.duration = 4）→ 木箱在 Turn 1/2/3/4 都存在，
 *   Turn 4 结束时归零被移除 → Turn 5 蓝方开始时已经消失。
 *
 * 事件（常量见 js/config/events.js）：
 *   obstacle:spawned     新增一个障碍物
 *   obstacle:removed     一个障碍物到期 / 被清理
 *   turn:obstacleTick    每回合结束一次，payload 带全部障碍物的剩余回合
 *
 * 依赖：FK.EVENTS、FK.EventBus、FK.Obstacle（纯逻辑，不依赖 Phaser）
 * 对外：FK.ObstacleRegistry
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  class ObstacleRegistry {

    /**
     * @param {Object} [opts]
     *   eventBus      事件总线（缺省 FK.EventBus）
     *   maxCount      场上障碍物**硬上限**（内存 / 碰撞安全阀；超限时移除最老的）。
     *                 第 7.9 步起这里**不再是玩法规则**——「场上最多 2 个木箱」的
     *                 放置数量上限已按策划要求去掉（冷却 + 存活时长已经天然限制了数量）。
     */
    constructor(opts) {
      opts = opts || {};
      this.eventBus = opts.eventBus || FK.EventBus || null;
      this.maxCount = Math.max(1, Math.round(num(opts.maxCount, 12)));

      /** 障碍物列表（按放置顺序，老的在前面） */
      this.obstacles = [];
      /** 自增序号 */
      this._seq = 0;
      /** 已同步碰撞世界的预测器（可为 null：无预测器时只做登记） */
      this.predictor = null;
      /** 地形基础平台（不含障碍物）——每次同步都是「基础 + 障碍物」重建，避免累积重复 */
      this.basePlatforms = [];
      /** 基础水面高度 */
      this.baseWaterLevel = null;
      /** 基础边界 */
      this.baseBounds = null;
      /** 统计 */
      this.stats = { spawned: 0, removed: 0, expired: 0, ticks: 0 };
    }

    /* ==================================================================
     * 碰撞世界绑定
     * ================================================================== */

    /**
     * 绑定预测器与地形基础数据。
     * 之后每次 spawn / remove 都会自动重建 predictor 的世界数据：
     *   platforms = 地形平台 + 全部障碍物矩形
     * @param {FK.TrajectoryPredictor} predictor
     * @param {Object} [world] { platforms, waterLevel, bounds } 地形基础（不含障碍物）
     */
    attach(predictor, world) {
      this.predictor = predictor || null;
      if (world) {
        this.basePlatforms = Array.isArray(world.platforms) ? world.platforms.slice() : [];
        if (Object.prototype.hasOwnProperty.call(world, 'waterLevel')) { this.baseWaterLevel = world.waterLevel; }
        if (Object.prototype.hasOwnProperty.call(world, 'bounds')) { this.baseBounds = world.bounds; }
      } else if (this.predictor && typeof this.predictor.getWorld === 'function') {
        // 未显式给基础数据时，从预测器当前世界快照反推（首次挂载的常见用法）
        const w = this.predictor.getWorld() || {};
        this.basePlatforms = Array.isArray(w.platforms) ? w.platforms.slice() : [];
        this.baseWaterLevel = (w.waterLevel === undefined) ? null : w.waterLevel;
        this.baseBounds = w.bounds || null;
      }
      this.sync();
      return this;
    }

    /**
     * 第 7.9 步：**已取消放置数量上限**（原「场上最多 2 个木箱」）。
     * 保留一个同名只读方法只为兼容旧调用点：现在恒为 true（除安全阀 maxCount 外不再限制）。
     * @returns {boolean}
     */
    canPlace() { return this.obstacles.length < this.maxCount; }

    /**
     * 障碍物数量快照（HUD / 自检读它，不再有 max / remaining 这类玩法上限字段）
     * @returns {{total:number, count:number, cap:number}}
     */
    getPlacementStatus() {
      return { total: this.obstacles.length, count: this.obstacles.length, cap: this.maxCount };
    }

    /**
     * 当前碰撞世界（地形 + 全部障碍物 + 水面 + 边界）的第 7.5 步读法。
     * 与 sync() 写回预测器用的是同一份数据——放置模式的「向下射线找最近平台」
     * 因此和弹道碰撞看到的世界**完全一致**，不存在第二份地形数据。
     * @returns {{platforms:Array, waterLevel:number|null, bounds:Object|null}}
     */
    getColliders() {
      return {
        platforms: this.basePlatforms.concat(this.getRects()),
        waterLevel: this.baseWaterLevel,
        bounds: this.baseBounds
      };
    }

    /** 把所有障碍物矩形同步进预测器的碰撞世界（预测与实飞共用） */
    sync() {
      if (!this.predictor || typeof this.predictor.setWorld !== 'function') { return this; }
      const world = this.getColliders();
      this.predictor.setWorld({
        platforms: world.platforms,
        waterLevel: world.waterLevel,
        bounds: world.bounds
      });
      return this;
    }

    /** 全部障碍物矩形（世界像素 AABB，格式与地图平台一致） */
    getRects() {
      const out = [];
      for (let i = 0; i < this.obstacles.length; i++) {
        if (!this.obstacles[i].isExpired()) { out.push(this.obstacles[i].getRect()); }
      }
      return out;
    }

    /* ==================================================================
     * 增删
     * ================================================================== */

    /**
     * 生成一个障碍物
     * @param {Object} spec
     *   scene / itemId / team / ownerId / x / y / sizeUnits / duration / turnNumber
     *   pxPerUnit / depth
     * @returns {FK.Obstacle|null}
     */
    spawn(spec) {
      const s = spec || {};
      if (!FK.Obstacle) { return null; }

      // 超上限：移除最老的一个（避免无限堆积）
      while (this.obstacles.length >= this.maxCount) {
        this.remove(this.obstacles[0], 'overflow');
      }

      const obstacle = new FK.Obstacle(s.scene || null, {
        id: ++this._seq,
        itemId: s.itemId || '',
        team: s.team || '',
        ownerId: s.ownerId || '',
        x: num(s.x, 0),
        y: num(s.y, 0),
        sizeUnits: num(s.sizeUnits, 1.5),
        duration: num(s.duration, 4),
        turnNumber: num(s.turnNumber, 0),
        pxPerUnit: s.pxPerUnit,
        depth: s.depth
      });
      obstacle.create();

      this.obstacles.push(obstacle);
      this.stats.spawned += 1;
      this.sync();

      this.emit(this.eventOf('OBSTACLE_SPAWNED'), {
        id: obstacle.obstacleId,
        itemId: obstacle.itemId,
        team: obstacle.team,
        ownerId: obstacle.ownerId,
        x: Math.round(obstacle.center.x),
        y: Math.round(obstacle.center.y),
        width: obstacle.sizePx,
        height: obstacle.sizePx,
        sizeUnits: obstacle.sizeUnits,
        remainingTurns: obstacle.remainingTurns,
        obstacle: obstacle
      });
      return obstacle;
    }

    /**
     * 移除一个障碍物（到期 / 被清理）
     * @param {FK.Obstacle} obstacle
     * @param {string} [reason] 'expired' | 'cleared' | 'overflow' | 'destroy'
     */
    remove(obstacle, reason) {
      if (!obstacle) { return false; }
      const i = this.obstacles.indexOf(obstacle);
      if (i < 0) { return false; }

      this.obstacles.splice(i, 1);
      const isExpire = (reason === 'expired');
      this.stats.removed += 1;
      if (isExpire) { this.stats.expired += 1; }

      const payload = {
        id: obstacle.obstacleId,
        itemId: obstacle.itemId,
        team: obstacle.team,
        reason: reason || 'removed',
        x: Math.round(obstacle.center.x),
        y: Math.round(obstacle.center.y),
        obstacle: obstacle
      };
      obstacle.destroy();
      this.sync();
      this.emit(this.eventOf('OBSTACLE_REMOVED'), payload);
      return true;
    }

    /* ==================================================================
     * 回合倒计时
     * ================================================================== */

    /**
     * 回合结束：所有障碍物剩余回合 -1，到期的消失，并广播一次 turn:obstacleTick
     *
     * 第 7.6 步口径：`duration` = 存活 turn 数（放置回合计入），
     * 因此这里对每一次 turn:end 都扣减；无论有没有到期，**每次都广播**，
     * HUD 因此总能看到倒计时。
     *
     * @param {number} [turnNumber] 当前回合号（payload 用）
     * @returns {{turnNumber:number, count:number, removed:string[], obstacles:Array}}
     */
    onTurnEnd(turnNumber) {
      const snapshot = this.obstacles.slice();
      const removedIds = [];
      const turn = num(turnNumber, 0);

      for (let i = 0; i < snapshot.length; i++) {
        const ob = snapshot[i];
        if (ob.isExpired()) { continue; }
        const expired = ob.tickTurn(turn);
        if (expired) {
          removedIds.push(ob.getRect().id);
          this.remove(ob, 'expired');
        }
      }

      this.stats.ticks += 1;
      const payload = {
        turnNumber: turn,
        count: this.obstacles.length,
        removed: removedIds,
        obstacles: this.list()
      };
      this.emit(this.eventOf('TURN_OBSTACLE_TICK'), payload);
      return payload;
    }

    /** 每帧推进生成动画（纯表现） */
    update(deltaMs) {
      for (let i = 0; i < this.obstacles.length; i++) {
        this.obstacles[i].update(deltaMs);
      }
      return this;
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /** 场上障碍物快照（含 id / 位置 / 剩余回合），HUD 与自检用 */
    list() {
      const out = [];
      for (let i = 0; i < this.obstacles.length; i++) {
        const ob = this.obstacles[i];
        out.push({
          id: ob.obstacleId,
          itemId: ob.itemId,
          team: ob.team,
          x: Math.round(ob.center.x),
          y: Math.round(ob.center.y),
          sizeUnits: ob.sizeUnits,
          remainingTurns: ob.remainingTurns
        });
      }
      return out;
    }

    /** 场上障碍物数量 */
    count() { return this.obstacles.length; }

    /** 是否还有障碍物 */
    isEmpty() { return this.obstacles.length === 0; }

    /** 按序号取障碍物 */
    getById(id) {
      for (let i = 0; i < this.obstacles.length; i++) {
        if (this.obstacles[i].obstacleId === id) { return this.obstacles[i]; }
      }
      return null;
    }

    /** 清空全部障碍物 */
    clear(reason) {
      const snapshot = this.obstacles.slice();
      for (let i = 0; i < snapshot.length; i++) {
        this.remove(snapshot[i], reason || 'cleared');
      }
      return this;
    }

    /** 统计快照 */
    getStats() {
      return {
        spawned: this.stats.spawned,
        removed: this.stats.removed,
        expired: this.stats.expired,
        ticks: this.stats.ticks,
        alive: this.obstacles.length
      };
    }

    /* ---------------- 内部 ---------------- */

    /** 取事件名（FK.EVENTS 未加载时回退到本地字符串，保证纯 JS 可单测） */
    eventOf(key) {
      if (FK.EVENTS && FK.EVENTS[key]) { return FK.EVENTS[key]; }
      return '';
    }

    emit(type, payload) {
      if (this.eventBus && type) { this.eventBus.emit(type, payload); }
    }
  }

  FK.ObstacleRegistry = ObstacleRegistry;
})();
