/**
 * ============================================================
 * events.js —— 全局事件名常量
 * ============================================================
 * 职责：
 *   集中定义 EventBus 上流转的所有事件名，避免各系统各写各的字符串，
 *   导致改名时漏改、或拼写错误静默失效。
 *
 * 命名规范：'域:动作'，例如 'config:loaded'、'module:created'
 *
 * 依赖：无（必须最先加载，供所有系统引用）
 * 对外：FK.EVENTS
 *
 * 本步实际会派发的事件见下方「第 2 步使用中」标注；
 * 后续步骤新增事件时，在这里追加一行即可。
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const EVENTS = {

    /* ---------------- 配置数据域（第 2 步使用中） ---------------- */

    /** 配置加载并完成类型化解析：payload = { unitCount, itemCount, mapId, configs } */
    CONFIG_LOADED: 'config:loaded',

    /** 配置加载或类型化解析出错：payload = { scope, message, raw } */
    CONFIG_ERROR: 'config:error',

    /* ---------------- 注册表域（第 2 步使用中） ---------------- */

    /** 单个模块注册成功：payload = { kind, id } */
    REGISTRY_REGISTERED: 'registry:registered',

    /** 全部模块注册完成：payload = { units:[], items:[], maps:[], errors:[] } */
    REGISTRY_ALL_READY: 'registry:allReady',

    /* ---------------- 模块工厂域（第 2 步使用中） ---------------- */

    /** 由配置成功创建出一个模块实例：payload = { kind, id, module, config } */
    MODULE_CREATED: 'module:created',

    /** 模块创建失败：payload = { kind, id, message } */
    MODULE_ERROR: 'module:error',

    /* ---------------- 回合域（第 3 步使用中） ---------------- */

    /** 回合开始：payload = { team, turnNumber, state, remainingTime } */
    TURN_START: 'turn:start',

    /** 倒计时每秒触发一次：payload = { team, turnNumber, secondsLeft, remainingTime } */
    TURN_TICK: 'turn:tick',

    /** 倒计时结束：payload = { team, turnNumber, state } */
    TURN_TIMEOUT: 'turn:timeout',

    /** 回合结束：payload = { team, turnNumber, reason, state } */
    TURN_END: 'turn:end',

    /** 切换阵营：payload = { team, previousTeam, turnNumber, state } */
    TURN_SWITCH: 'turn:switch',

    /** 状态变化（每次进入新状态都广播）：payload = { from, to, reason, team, turnNumber, remainingTime, state } */
    TURN_STATE_CHANGE: 'turn:stateChange',

    /* ---------------- 对局域（第 3 步使用中，判定逻辑见第 8 步） ---------------- */

    /** 游戏结束（进入 GAME_OVER 终态）：payload = { winner, reason, turnNumber, team } */
    GAME_OVER: 'game:over',

    /* ---------------- 第 8 步：死亡 / 落水 / 胜负 ---------------- */

    /**
     * 单位死亡（唯一死因广播点，落水与血量归零都会先发它）：
     * payload = { unitId, team, reason, position: { x, y }, turnNumber, unit }
     * reason ∈ 'hp_zero' | 'drowned'（同一帧两个条件都满足时按 drowned 处理）
     */
    UNIT_DIED: 'unit:died',

    /**
     * 单位落水（仅在 reason = 'drowned' 时紧随 unit:died 之后广播）：
     * payload = { unitId, team, position: { x, y }, turnNumber, unit }
     */
    UNIT_DROWNED: 'unit:drowned',

    /** 玩家阵营获胜：payload = { winner, turnNumber, survivors: [unitId...] } */
    GAME_VICTORY: 'game:victory',

    /** 玩家阵营失败（对方获胜）：payload = { loser, turnNumber } */
    GAME_DEFEAT: 'game:defeat',

    /** 双方同时清空：payload = { turnNumber } */
    GAME_DRAW: 'game:draw',

    /* ---------------- 单位域（第 4 步使用中） ---------------- */

    /** 单位实例化成功：payload = { id, team, x, y, hp, maxHp, unit } */
    UNIT_SPAWNED: 'unit:spawned',

    /** 鼠标悬停状态变化：payload = { id, team, hovered } */
    UNIT_HOVER: 'unit:hover',

    /** 单位被选中：payload = { id, team, hp, maxHp, unit, turnNumber } */
    UNIT_SELECTED: 'unit:selected',

    /** 单位取消选中：payload = { id, team, reason, unit } */
    UNIT_DESELECTED: 'unit:deselected',

    /** 单位扣血：payload = { id, team, amount, hp, maxHp, unit } */
    UNIT_DAMAGED: 'unit:damaged',

    /* ---------------- 瞄准域（第 5 步使用中） ---------------- */

    /** 开始瞄准：payload = { id, team, x, y, unit } */
    AIM_START: 'aim:start',

    /** 瞄准参数更新：payload = { id, powerRatio, angleDeg, vx, vy, speed } */
    AIM_UPDATE: 'aim:update',

    /** 瞄准结束（松手）：payload = { id, powerRatio, angleDeg, vx, vy, landing, hitType } */
    AIM_END: 'aim:end',

    /** 瞄准取消（ESC / 右键 / 换边 / 选中变化 / 倒计时结束）：payload = { id, reason } */
    AIM_CANCEL: 'aim:cancel',

    /** 抛物线计算完成：payload = { id, pointCount, landing, hitType, hitTarget } */
    AIM_TRAJECTORY_READY: 'aim:trajectoryReady',

    /* ---------------- 投掷域（第 6 步使用中） ---------------- */

    /** 投掷物已生成：payload = { id, itemId, team, shooterId, x, y, vx, vy, projectile } */
    PROJECTILE_SPAWNED: 'projectile:spawned',

    /** 投掷物飞行中（起飞时广播一次，携带预测落点供比对）：payload = { id, vx, vy, predictedLanding, flightTimeMs } */
    PROJECTILE_FLYING: 'projectile:flying',

    /** 投掷物落地/撞到地形与单位：payload = { id, itemId, x, y, hitType, hitTarget, landing } */
    PROJECTILE_LANDED: 'projectile:landed',

    /** 投掷物爆炸：payload = { id, itemId, x, y, radiusPx, radiusUnits, damage, knockback, explodeAnimMs } */
    PROJECTILE_EXPLODED: 'projectile:exploded',

    /** 投掷物已从场景移除（引信/爆炸演出结束，或保护性清理）：payload = { id, itemId, reason } */
    PROJECTILE_REMOVED: 'projectile:removed',

    /* ---------------- 伤害域（第 6 步使用中） ---------------- */

    /** 对一个单位结算了伤害：payload = { unit, id, team, amount, hp, maxHp, distance, falloff, source } */
    DAMAGE_APPLIED: 'damage:applied',

    /** 对一个单位施加了击退：payload = { unit, id, team, vx, vy, speed, knockback, distance, falloff } */
    UNIT_KNOCKBACK: 'unit:knockback',

    /* ---------------- 投掷结算（第 6 步使用中） ---------------- */

    /** 一次投掷的爆炸结算全部完成（可安全进入 RESOLVING/TURN_END）：payload = { id, itemId, exploded, damaged, knockbacked } */
    TURN_PROJECTILE_RESOLVED: 'turn:projectileResolved',

    /* ---------------- 道具域（第 7 步使用中，第 8.6 步并入「移动」格） ---------------- */

    /** 道具栏切换槽位（含第 4 格「移动」）：payload = { itemId, name, item, previousId, desc, isMoveSlot } */
    SLOT_SELECTED: 'slot:selected',

    /** 道具栏第 4 格「移动」被选中 / 取消：payload = { active, reason, label } */
    SLOT_ACTIVATED: 'slot:activated',

    /** 一次投掷真正出手（道具被消费）：payload = { itemId, unitId, team, turnNumber, projectileId } */
    ITEM_USED: 'item:used',

    /* ---------------- 障碍物域（第 7 步使用中） ---------------- */

    /** 障碍物生成（水果箱落地）：payload = { id, itemId, x, y, width, height, remainingTurns, obstacle } */
    OBSTACLE_SPAWNED: 'obstacle:spawned',

    /** 障碍物移除（到期 / 手动清理）：payload = { id, itemId, reason, obstacle } */
    OBSTACLE_REMOVED: 'obstacle:removed',

    /** 回合结束障碍物倒计时一次：payload = { turnNumber, count, removed:[], skipped:[], obstacles:[] } */
    TURN_OBSTACLE_TICK: 'turn:obstacleTick',

    /* ---------------- 放置域（第 7.5 步使用中） ---------------- */

    /** 进入放置模式（选中放置类道具）：payload = { itemId, name, sizeUnits, sizePx, max, count, turnNumber } */
    PLACEMENT_START: 'placement:start',

    /** 当前位置不可放置：payload = { itemId, reason, message, x, y, count, max } */
    PLACEMENT_INVALID: 'placement:invalid',

    /** 放置完成（木箱落地）：payload = { itemId, outcome, obstacleId, x, y, sizeUnits, remainingTurns, turnNumber, ownerId, team } */
    PLACEMENT_COMPLETE: 'placement:complete',

    /** 退出 / 取消放置模式：payload = { itemId, reason, placed } */
    PLACEMENT_CANCELLED: 'placement:cancelled',

    /* ---------------- 移动域（第 8.5 步新增，第 8.6 步并入道具栏第 4 格） ---------------- */

    /** 选中「移动」格并开始拖拽规划：payload = { unitId, team, turnNumber, unit } */
    MOVE_START: 'move:start',

    /**
     * 拖拽中实时更新（与瞄准同一手感）：payload =
     *   { unitId, team, powerRatio, angleDeg, vx, vy, speed, bounces, pointCount,
     *     landing, hitType, waypoints, preview }
     */
    MOVE_UPDATE: 'move:update',

    /**
     * 松手，移动正式生效（本回合的「移动」次数已用掉，但仍可投掷）：
     * payload = { unitId, team, vx, vy, speed, powerRatio, angleDeg, bounces, landing, hitType, turnNumber }
     */
    MOVE_END: 'move:end',

    /**
     * 移动执行完毕（落地停下）：
     * payload = { unitId, team, fromX, fromY, x, y, distance, distanceUnits, bounces, reason, turnNumber }
     */
    MOVE_COMPLETE: 'move:complete',

    /** 取消移动（未生效 / 回合被打断）：payload = { unitId, reason, x, y, committed } */
    MOVE_CANCEL: 'move:cancel',

    /* ---------------- AI 域（第 9 步新增） ---------------- */

    /**
     * 敌方 AI 开始思考（进入红方回合 TURN_START 后，排定 1~2 秒决策延迟时广播）：
     * payload = { team, turnNumber, difficulty, delayMs, unitCount, enemyCount }
     */
    AI_THINKING: 'ai:thinking',

    /**
     * 敌方 AI 决策完成（选单位 / 选道具 / 选目标 / 算参数 / 加误差之后，执行之前）：
     * payload = { team, turnNumber, difficulty, action, actionLabel, unitId, itemId, targetId,
     *             reachable, hittableCount, candidateCount, powerRatio, angleDeg, vx, vy,
     *             predictedLanding, hitType, distancePx, error, fallbackFrom }
     * action ∈ 'throw'（投掷）| 'place'（放置水果箱）| 'move'（移动）
     */
    AI_DECIDED: 'ai:decided',

    /**
     * 敌方 AI 行动已落地（走完既有链路入口：投掷 / 放置 / 移动）：
     * payload = { team, turnNumber, action, actionLabel, unitId, itemId, targetId,
     *             success, vx, vy, landing, powerRatio, angleDeg }
     */
    AI_ACTED: 'ai:acted',

    /* ---------------- 音效域（第 12 步） ---------------- */

    /** 静音：payload = { muted: true } */
    AUDIO_MUTED: 'audio:muted',

    /** 取消静音：payload = { muted: false } */
    AUDIO_UNMUTED: 'audio:unmuted'
  };

  FK.EVENTS = Object.freeze(EVENTS);

  /** 反向查表：'config:loaded' → 'CONFIG_LOADED'（调试与日志用） */
  FK.eventKeyOf = function (value) {
    const keys = Object.keys(EVENTS);
    for (let i = 0; i < keys.length; i++) {
      if (EVENTS[keys[i]] === value) { return keys[i]; }
    }
    return value;
  };
})();
