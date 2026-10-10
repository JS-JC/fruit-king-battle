/**
 * ============================================================
 * gameConfig.js —— 全局常量与默认参数
 * ============================================================
 * 职责：
 *   集中存放「引擎引导级」常量与「玩法参数默认值」，
 *   供 main.js / 各场景 / 各系统统一读取，禁止在业务代码里写魔法数字。
 *
 * 依赖：无（必须最先加载）
 * 对外：window.FK.Config
 *
 * 与 data/game.json 的关系（重要）：
 *   本文件提供的是**引导默认值**——在 JSON 尚未加载前（例如 main.js
 *   创建 Phaser.Game 时）就必须能读到画布尺寸、物理参数等。
 *   第 2 步会把 data/game.json 中的同名玩法参数合并覆盖到
 *   FK.Config.runtime 上，届时以 JSON（策划源）为准，避免两处数值打架。
 *   因此：改玩法数值请改 JSON；改结构性常量（画布/缩放）才改本文件。
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. 版本与文案
   * ------------------------------------------------------------------ */
  const VERSION = '1.0.0';                       // 项目版本
  const STEP = 14;                               // 当前开发步骤
  const GAME_TITLE = '我是水果王';
  const GAME_TITLE_EN = 'IAmFruitKing';
  const STEP_LABEL = '第 14 步：香蕉弹 / 大地图 / 选图';

  /* ------------------------------------------------------------------
   * 2. 画布与缩放
   *
   * 分辨率取值说明（为什么是 1600×800，而不是 1280×720）：
   *   第 0 步已冻结「1 地图单位 = 48 px」，竞技场为 30×12 单位。
   *   → 竞技场像素尺寸 = 30×48 : 12×48 = 1440 × 576
   *   → 画布需要装下 1440 宽 + 左右留白，上下还要留 HUD 带
   *   → 1600×800 满足：左右各留 80px，上下各留 112px，比例 2:1
   *
   *   若改用 1280×720：
   *     · 横向只能容纳 1280/30 ≈ 42.67 px/单位 —— 非整数，
   *       会破坏「纹理尺寸必须是 48 的倍数/约数」的命名规范（R4）；
   *     · 若改 pxPerUnit = 32，则 48/32 = 1.5，占位纹理尺寸不再是 48 的
   *       约数，后期替换正式素材时全部要重做尺寸。
   *   故保持 1600×800 / 48 px 与第 0 步冻结文档一致。
   *
   *   如需切成 1280×720，只改下面 4 个常量即可（无其他联动）：
   *     CANVAS.width = 1280, CANVAS.height = 720,
   *     PX_PER_UNIT = 32, ARENA.offsetX = 160, ARENA.offsetY = 168
   * ------------------------------------------------------------------ */
  const CANVAS = {
    width: 1600,
    height: 800,
    parent: 'game-root',
    backgroundColor: '#0F172A'
  };

  const SCALE = {
    mode: 'FIT',          // 等比缩放铺满窗口，留黑边也不变形
    autoCenter: 'CENTER_BOTH'
  };

  /* ------------------------------------------------------------------
   * 3. 坐标系统与竞技场
   * ------------------------------------------------------------------ */
  const PX_PER_UNIT = 48;                        // 1 地图单位 = 48 像素（第 0 步冻结）

  const ARENA = {
    widthUnits: 30,                              // FruitKingArena 横向 30 单位
    heightUnits: 12,                             // FruitKingArena 纵向 12 单位
    offsetX: 80,                                 // 竞技场左上角在画布中的 X（像素）
    offsetY: 112                                 // 竞技场左上角在画布中的 Y（像素）
  };

  /* ------------------------------------------------------------------
   * 4. 物理（Arcade Physics）
   *
   * 注意：worldGravityY 固定为 0。
   *   重力由「投掷物 / 单位」各自用 body.setGravityY() 单独施加，
   *   这样水平方向的击退速度不受世界重力干扰，也方便后续给不同
   *   道具做差异化重力。第 5、6 步的抛物线预测必须与这里完全一致。
   * ------------------------------------------------------------------ */
  const PHYSICS = {
    worldGravityY: 0,
    gravityY: 1500,                              // 实体自身重力（px/s²），第 0 步冻结值
    stepFps: 60,                                 // 物理固定步长，必须与预测步长一致
    fixedStep: true,
    maxDeltaMs: 33,                              // 切后台回来时防止穿透
    // 是否用 setTimeout 替代 requestAnimationFrame 驱动主循环。
    // 设为 false：固定步长物理已保证 1/60 的积分精度，用 rAF 画面更平滑。
    forceSetTimeOut: false,
    debug: false                                 // 物理调试线框（仅在 DEBUG.enabled 时生效）
  };

  /* ------------------------------------------------------------------
   * 5. 回合（本步不实现逻辑，仅登记默认值，供第 3 步使用）
   * ------------------------------------------------------------------ */
  const TURN = {
    timeMs: 30000,                               // 每回合 30 秒倒计时
    warnMs: 10000,                               // 剩余 ≤10s 时进入预警显示
    maxTurns: 40                                 // 回合上限（40 个行动回合）
  };

  /* ------------------------------------------------------------------
   * 5.5 瞄准与抛物线（第 5 步新增）
   *   本组参数同时供：TrajectoryPredictor（纯 JS 计算）、
   *   AimController（力度/角度映射）、TrajectoryRenderer（绘制）使用。
   * ------------------------------------------------------------------ */
  const AIM = {
    /** 最大拖拽距离（屏幕逻辑像素）：拖到这么远即为满力 */
    maxDragPx: 180,
    /** 力度下限：拖拽距离接近 0 时仍给一点初速度，避免原地掉落 */
    minPowerRatio: 0.15,
    /**
     * 投掷角度安全上限（度）。第 7 步起瞄准改为 360° 全向：
     * 投掷方向由拖拽方向的反向决定，不再受单位朝向限制。
     * 取 360（> 180）时 clamp 对 [-180, 180] 的实际取值恒等，即「不做角度钳制」，
     * 因此「向下平抛 / 越过屏幕上边界的高抛」都能投出来。
     */
    angleLimitDeg: 360,
    /**
     * 满力时樱桃炸弹（range = 1.0）的初速度（px/s）。
     *
     * 第 8.6 步按「前方单位最远要能打到对面」重新标定：1010 → 1200。
     *   标定口径：开局时蓝方前排单位（apple_guard，x = 5.5u / 344px、站在左高台上），
     *   满力 45° 抛出 → 无地形射程 = v² / g = 1200² / 1500 = 960px ≈ 20u；
     *   实际弹道在右高台前沿（x = 22.5u / 1160px、台面 y = 3.0u / 256px）上方约 20px 掠过，
     *   随即撞到台面 → 爆心约 x ≈ 1181px，与红方前排单位中心
     *   （grape_soldier，x = 24.5u / 1256px）相距约 77px，
     *   落在樱桃炸弹半径 2.5u（120px）内 → **打得到对面并击退**。
     *   （旧值 1010 → 满力落点仅约 13.7u，连中场都过不去；
     *     实测 2000 会直接飞过对面单位 1700px 落地，属于「打过头」。）
     *   改动只影响「射程」，力度→速度的映射公式、手感比例完全不变。
     */
    maxSpeed: 1200,
    /** 发射点相对单位中心的垂直偏移（地图单位）：负值表示从中心上方发出 */
    launchOffsetYUnits: -0.3,
    /** 轨迹积分步长（秒），必须与 physics.stepFps 对齐 */
    stepSec: 1 / 60,
    /** 轨迹最大步数（240 步 = 4 秒，实飞 / AI 仍用这个） */
    maxSteps: 240,
    /** 瞄准预览基准步数（range=1.0、满力）；实际步数再乘道具 range 与当前力度 */
    previewMaxSteps: 52,
    /** 显示点抽稀：每 N 步取一个渲染点 */
    sampleEvery: 2,
    /** 轨迹点透明度 */
    trajectoryAlpha: 0.55,
    /** 未选道具时的默认道具 id（第 7 步接入道具栏后由玩家选择） */
    defaultItemId: 'cherry_bomb',
    /**
     * 第 7.7 步：**拖回起始单位附近即取消瞄准**的判据（瞄准取消的第三种方式）。
     *   ① 拖拽距离 < cancelDragPx          → 视为「拖回来了」
     *   ② 指针回到单位碰撞半径 × cancelRadiusFactor 以内 → 视为「回到单位身上」
     *   两者任一命中即取消（等同 ESC，同样广播 aim:cancel）。
     *   注意：只有**先拖出这两个范围之外**（armed）才会触发取消，
     *   因此「按下去没动」不会误取消，而真正拖出去后松手仍是正常投掷。
     */
    cancelDragPx: 20,
    cancelRadiusFactor: 1.2,
    /** 轨迹积分方式：'analytic' = 斜抛运动方程（精确）；'euler' = 半隐式欧拉（贴近 Arcade 逐帧积分） */
    integration: 'analytic'
  };

  /* ------------------------------------------------------------------
   * 5.5.1 主动移动（第 8.5 步新增）
   *
   *   单位移动 = 与投掷**同一套手感**的拖拽抛物线（弹弓式：向后拉 → 向前飞），
   *   但参数与投掷**完全独立**，因此调移动手感不会影响投掷射程。
   *
   *   物理：复用 TrajectoryPredictor 的同一份积分原语（stepProjectile /
   *         stepIntegrate），保证「移动的落点预览」与「单位真实飞行」逐帧一致。
   *   射程：满力 45° 无地形射程 = maxSpeed² / gravityY = 954² / 1500 ≈ 607px ≈ 12.6u
   *         （相对原先 1140 缩短约 30% 水平距离）。
   *   碰撞：水平方向撞木箱 / 撞墙 → 按 KNOCKBACK.restitution 弹性弹回（可多次），
   *         逐段推进防隧穿；垂直方向不做障碍判定（规则：只检测水平方向）。
   *   落水：飞行结束落到无支撑面的位置 → 继续下坠 → 越过水面判死（复用第 8 步链路）。
   * ------------------------------------------------------------------ */
  const MOVE = {
    /** 移动力度上限（px/s）：满力基准速度（与 AIM.maxSpeed 同量纲、互相独立） */
    maxSpeed: 954,
    /** 最大拖拽距离（屏幕逻辑像素）：拖到这么远即为满力（与瞄准同一手感） */
    maxDragPx: 180,
    /** 力度下限：拖拽距离接近 0 时仍给一点初速度，避免原地掉落 */
    minPowerRatio: 0.08,
    /**
     * 移动角度上限（度）：360 = 不做钳制（与投掷一致，全向可跳）。
     * 想要「只能向前上方跳」时可以调到 90。
     */
    angleLimitDeg: 360,
    /** 移动起跳点相对单位中心的垂直偏移（地图单位）：负数表示从中心上方起跳 */
    launchOffsetYUnits: -0.2,
    /**
     * 移动水平阻尼（px/s²）：0 = 不衰减（纯抛体，落点 = 预览）。
     * 做成配置是为了将来做「空中阻力 / 滑行」手感时只改这一个数。
     */
    airDragX: 0,
    /** 移动飞行硬上限（毫秒）：超过即视为落地，防止任何情况下卡住不动 */
    maxFlightMs: 4000,
    /** 单帧最大步进（毫秒）：掉帧 / 切后台回来时钳制，避免穿透木箱 */
    maxStepMs: 50,
    /** 垂直速度上限（px/s）：防止拖到极端角度时单位飞出画面上方太久 */
    maxSpeedY: 1180,
    /**
     * 主动跳跃撞箱 / 撞墙的弹性（只影响 MOVE，不改击退）。
     * 击退用 DAMAGE.knockRestitution=0.08 几乎贴死；跳跃需要弹开才跟得上预览。
     */
    restitution: 0.58,
    restitutionDecay: 0.78,
    minBounceSpeed: 28,
    /** 同一次跳跃最多弹回几次（撞障后仍能滑出去，避免刚碰到就钉死） */
    maxBounces: 8,
    /** 每次移动渲染的最大轨迹点数（超过即抽稀，保证绘制开销恒定） */
    maxPreviewPoints: 36,
    /** 移动预览最长飞行（毫秒）：只影响弧线显示，实飞仍用 maxFlightMs */
    previewMaxFlightMs: 900,
    /** 预览点抽稀步长（与投掷白点同一节奏） */
    previewSampleEvery: 2,
    /* ---- 表现层（占位美术） ---- */
    /** 轨迹预览深度：与投掷轨迹一致（低于 HUD） */
    previewDepth: 40,
    /** 落地落点圈半径（像素） */
    previewRadiusPx: 22,
    /** 轨迹点透明度 */
    previewAlpha: 0.6,
    /** 落点圈透明度 */
    landingAlpha: 0.85,
    /**
     * 移动执行期间的视觉挤压：单位沿运动方向轻微拉伸（1 = 关闭）。
     * 只影响 art 容器，不影响位置与碰撞。
     */
    stretch: 1.06
  };

  /* ------------------------------------------------------------------
   * 5.6 投掷物与伤害（第 6 步新增）
   *   PROJECTILE 组：投掷物实飞 / 爆炸演出 / 结算兜底的全局参数。
   *     道具自身的数值（damage / radius / knockback / fuseOnHitMs …）
   *     一律从 data/items.json → ItemConfig 读取，这里只放「与道具无关」的常量。
   *   DAMAGE 组：爆炸伤害与击退的通用常量（单位阻尼、推力上限等）。
   * ------------------------------------------------------------------ */
  const PROJECTILE = {
    /** 投掷物渲染深度：高于单位（10），低于轨迹（40）与 HUD（60） */
    depth: 20,
    /** 爆炸范围圈：高于单位，低于 HUD */
    explosionDepth: 34,
    /** 飞行硬上限（毫秒）：超过即视为超时落地，防止投掷物永远不落地 */
    maxFlightMs: 6000,
    /** 单帧最大步进时间（毫秒）：掉帧/切后台回来时钳制，避免穿透平台 */
    maxStepMs: 50,
    /** 爆炸结算完成后，停留多久再进入 TURN_END（毫秒，留出爆炸演出时间） */
    resolveDelayMs: 120,
    /** 投掷物图形旋转速度（度/秒），仅表现层 */
    spinDegPerSec: 720,
    /** 投掷物引线火花闪烁周期（毫秒），仅表现层 */
    fuseBlinkMs: 120,
    /**
     * 第 7 步：抛物线是否允许越过画面上边界（y < bounds.top 继续计算）。
     * true  = 上边界不再截断弹道，飞出去继续算，直到落回有效区域或超时；
     * false = 恢复第 6 步行为（撞上边界即落地）。
     * 预测与实飞共用这一个开关（都走 TrajectoryPredictor 的同一份碰撞代码）。
     */
    ignoreTopBound: true,
    /**
     * 第 7 步：投掷物落入果汁池是否「直接销毁、不触发爆炸」。
     * true = 落水即消失（无爆炸、无伤害、无击退），只广播 projectile:removed(reason='water')。
     */
    destroyOnWater: true,
    /** 落水销毁的结算缓冲（毫秒）：给 HUD / 音效留一点反应时间 */
    waterSplashMs: 140
  };

  /* ------------------------------------------------------------------
   * 5.7 障碍物（第 7 步新增，第 7.5 步补放置规则，第 7.9 步去掉数量上限）
   *   水果箱放置后生成的静态方块。数值（尺寸 / 存活 turn 数 / 冷却 turn 数）
   *   来自 data/items.json → ItemConfig（crateSizeUnits / duration / cooldownTurns），
   *   这里只放「与具体道具无关」的常量。
   *   第 7.9 步已移除 maxPlacement（场上最多 2 个的玩法上限）：
   *   冷却 1 个自己的行动回合 + 存活 4 个 turn 已天然限制数量。
   * ------------------------------------------------------------------ */
  const OBSTACLE = {
    /** 障碍物渲染深度：高于地图（0），低于单位（10）——单位应当站在箱子前面 */
    depth: 8,
    /** 障碍物方块圆角半径（像素），纯表现 */
    cornerRadiusPx: 6,
    /** 刚生成时的弹出动画时长（毫秒），纯表现 */
    spawnAnimMs: 150,
    /** 第 7.5 步：放置预览轮廓的填充透明度与描边宽度（纯表现） */
    previewAlpha: 0.28,
    previewLineWidth: 3
  };

  const DAMAGE = {
    /** 单位被击退后的水平阻尼（px/s²），与文档 3 §1 unitDragX 冻结值一致 */
    unitDragX: 300,
    /** 单位垂直阻尼（px/s²），文档 3 冻结为 0（不做垂直拖拽阻力） */
    unitDragY: 0,
    /** 击退方向分配：水平 + 垂直各 0.707（文档 3 §5 knockDirSplit） */
    knockDirSplit: 0.707,
    /** 单次击退速度上限（px/s；第 8.5 步 700 → 1200，西瓜炸弹才能炸飞约半屏） */
    maxKnockSpeed: 1200,
    /** 速度低于该值即认为击退结束（px/s） */
    knockStopSpeed: 4,
    /** 空中重力加速度（px/s²）：与 PHYSICS.gravityY 保持一致 */
    gravityY: 1500,

    /* ---------- 第 7.10 步：击退 / 主动移动的弹性碰撞（撞木箱、撞墙） ---------- */

    /**
     * 弹性系数（0～1）：撞到木箱或地图墙体后 `vx ← -vx × knockRestitution`。
     * 1 = 完全弹性（速度不损失），0 = 完全非弹性（撞上就停）。
     * 木箱与墙共用这一个系数（未来要分材质再加）。
     *
     * 被动位移（击退）弹性：撞箱 / 撞墙 / 撞平台侧面后 `vx ← -vx × knockRestitution`。
     * 侧撞弹回约一半速度；落地垂直弹跳用更低的 landRestitution，只跳一下。
     */
    knockRestitution: 0.08,
    /**
     * 第 2 次弹跳相对第 1 次的衰减：vx ← -vx × knockRestitution × knockRestitutionDecay。
     * 第 1 次用满系数；第 2 次约 20%（几乎立刻停）；第 3 次接触不再弹。
     */
    knockRestitutionDecay: 0.2,
    /** 撞击瞬间速度低于该值（px/s）→ 不再反弹，直接停住（能量耗尽） */
    knockBounceMinSpeed: 45,
    /** 同一次击退 / 移动最多弹回几次（第 3 次接触即停，故默认 2） */
    knockBounceMaxCount: 2,
    /** 停在碰撞面外侧留的缝隙（px）：保证看起来停在箱子边缘而不是插进去 */
    knockContactGapPx: 0.5,
    /** 碰撞推进的单段位移上限（px）：拆帧防隧穿（高速也不会穿过薄箱子） */
    knockMaxStepPx: 4,
    /**
     * 地图边界类型 → 行为。类型本身来自 data/map.json 的 `bounds.type`（数据驱动）：
     *   'wall'  = 实体墙：撞上去与撞木箱完全同规则（弹性弹回）
     *   'juice' = 果汁边界：未来地图，行为另定；本步按「不反弹、只停在地图内」兜底
     */
    boundaryModes: { wall: 'bounce', juice: 'none' }
  };

  /* ------------------------------------------------------------------
   * 5.7.1 击退与弹性（第 8.5 步新增的集中配置组）
   *
   *   策划要求「击退距离明显增大、撞箱弹回明显，两者共用同一套弹性系数（K 值）」，
   *   因此把可调项集中到这一组；实现侧：
   *     · 击退冲量倍率 knockbackScale      → DamageSystem（爆炸结算）
   *     · 上抛系数 upKick                  → DamageSystem（保证有弧线、有滞空）
   *     · 空气阻力 airDragX                → UnitBase（击退飞行段的水平阻尼）
   *     · 弹性系数 restitution             → 与 DAMAGE.knockRestitution 同源（单一真相）
   *     · 主动移动的弹回                   → MoveController 读同一组
   *
   *   标定（v0.9.1）：灰台 rock height = 1.2u = 57.6px。
   *     弹飞高度 h = vy² / (2g)，maxVerticalSpeed = 400 → h ≤ 53.3px < 57.6px。
   *     侧向炸开时人贴着台面飞/滑，推到台沿就会掉进果汁池，而不会飞过缺口落到对面。
   * ------------------------------------------------------------------ */
  const KNOCKBACK = {
    /**
     * 击退冲量倍率：实际初速度 = min(maxKnockSpeed, items.knockback × 本系数 × falloff)。
     * 第 8.5 步标定：西瓜满伤合速度 ≈1000px/s，水平位移约半屏（knockbackScale × 上抛）。
     */
    knockbackScale: 2.7,
    /**
     * 上抛系数：在「径向垂直分量」之外，再按水平分量的比例补一份向上冲量，
     * 保证被炸飞的单位一定有弧线与滞空（纯水平推力会贴地滑行、看起来不「飞」）。
     */
    upKick: 0.5,
    /**
     * 第 8.8 步：**最小上抛速度**（px/s）——任何击退都至少以这个速度把单位抛起来。
     *
     * 为什么需要它：击退的垂直分量 = 「径向垂直分量」+「upKick 补量」。
     * 当爆心在单位上方、或与单位基本同高时，径向垂直分量为 0 或向下，
     * 合成结果可能 ≥ 0 → 单位「出生即落地」（airborne 立刻变 false），
     * 之后只剩水平阻尼滑行（不再受重力）→ 视觉上就是
     * 「先水平平移到空中，再竖直下落」的两段式动画。
     * 保证一个向上初速度后，水平与垂直在同一帧内同时积分，
     * 轨迹就是一条完整抛物线。
     */
    minUpSpeed: 400,
    /** 击退飞行段的空气阻力（px/s²）：越小飞得越远；落地后的滑行仍用 DAMAGE.unitDragX */
    airDragX: 0,
    /**
     * 第 8.9 步：**落地滑行距离上限**（px。默认 24 = 半个身位 = 碰撞半径）。
     *
     * 空中阻力（airDragX = 60）很小，单位落地时往往还带着 ~800px/s 的水平速度；
     * 若原样进入地面滑行（unitDragX = 300），滑距 = v²/(2·unitDragX) 会超过一千像素。
     * 因此落地瞬间把剩余水平速度收进「滑行预算」：
     *   maxVx = sqrt(2 × DAMAGE.unitDragX × landSlidePx)
     * 滑行距离因此恒 ≤ landSlidePx。当前 15px（相对 30 再减半，空中飞行不受影响）。
     */
    landSlidePx: 15,
    /** 落地瞬间保留的水平速度比例（空中 vx 直接打到 20% 再进滑行预算，避免“被水平弹飞”） */
    landSlideKeepVx: 0.2,
    /** 击退垂直速度上限（px/s）：防止斜向叠加把单位顶出画面上方 */
    maxVerticalSpeed: 400,
    /** 弹性系数（K 值）：与 DAMAGE.knockRestitution 同源，木箱 / 墙体 / 平台侧面共用 */
    restitution: 0.08,
    /** 落地反弹弹性（水平+垂直同一系数）：首跳约 1 格高、1.5～2 格远，再自然衰减 */
    landRestitution: 0.42,
    /** 安全上限（防止 restitution≥1 死循环）；正常由能量耗尽停 */
    maxLandBounces: 12,
    /** 反弹后垂直速度低于该值（px/s）视为动能耗尽（约第三次落地贴地） */
    minLandBounceSpeed: 55,
    /** 撞击速度低于该值（px/s）→ 不再反弹，直接停住（与 DAMAGE.knockBounceMinSpeed 同源） */
    minBounceSpeed: 45,
    /** 同一次击退 / 移动最多弹回几次（与 DAMAGE.knockBounceMaxCount 同源） */
    maxBounceCount: 8
  };

  /* ------------------------------------------------------------------
   * 5.8 单位落水与死亡（第 8 步新增）
   *
   *   落水判定条件：**单位碰撞盒底部 y > 水面像素 y**。
   *   水面来自 data/map.json → map.waterLevel（地图单位）→ arenaY() 换算成像素，
   *   本文件只放「与地图无关」的动画 / 遮挡常量。
   *
   *   动画是占位表现（正式美术不做）：落水 200ms、血量归零 400ms，
   *   时长集中在这里，实体与 UI 一律读配置，不写魔法数字。
   * ------------------------------------------------------------------ */
  const DEATH = {
    /** 落水占位动画总时长（毫秒）：半透明蓝 → 缩小至消失 */
    drownMs: 200,
    /** 落水时叠加在单位上的蓝色遮罩透明度（半透明蓝） */
    drownOverlayAlpha: 0.55,
    /** 落水遮罩颜色（果汁蓝，与果汁池同一色系） */
    drownTint: 0x38BDF8,
    /** 血量归零占位动画总时长（毫秒）：闪红 hpZeroFlashCount 次 → 缩小消失 */
    hpZeroMs: 400,
    /** 血量归零时闪红次数 */
    hpZeroFlashCount: 2,
    /** 血量归零闪红颜色 */
    hpZeroTint: 0xEF4444,
    /** 血量归零闪红时红色遮罩的峰值透明度 */
    hpZeroOverlayAlpha: 0.85,
    /** 消失动画结束时缩到的倍数（越小越像「缩没了」） */
    shrinkScale: 0.05,
    /** 蓝色遮罩半径增量（像素）：略大于碰撞半径，盖住整个身体 */
    overlayRadiusPadPx: 4,
    /**
     * 支撑面判定的回溯容差（像素）：平台顶面最多可比单位中心高这么多，
     * 仍然算作它的落脚点（防止高速下坠时一帧跨过平台顶面而穿下去）。
     * 取一个碰撞半径（24px）即可覆盖本项目最大落速的单帧位移。
     */
    supportTolerancePx: 24,
    /** 死亡瞬间是否冻结击退速度（落水不触发击退、也不再继续滑行） */
    freezeOnDeath: true
  };

  /* ------------------------------------------------------------------
   * 5.9 胜负与结算界面（第 8 步新增）
   *
   *   playerTeam 是「玩家阵营」，决定结果事件的分流：
   *     winner === playerTeam → game:victory（水果王获胜）
   *     winner !== playerTeam → game:defeat （酸果军团获胜）
   *     双方清空              → game:draw    （平局）
   * ------------------------------------------------------------------ */
  const VICTORY = {
    /** 玩家阵营（与 turn.json 的 initialTeam 一致：蓝方先手） */
    playerTeam: 'blue',
    /**
     * 进入 GAME_OVER 后，已在飞的投掷物是否继续飞完。
     * true = 继续飞完但不再造成任何伤害（第 8 步规则 3）；
     * false = 立即中止（第 7 步的旧行为，仅作配置开关保留）。
     */
    letProjectileFinish: true
  };

  const RESULT = {
    /** 全屏覆盖层颜色与透明度（0.7 = 半透明黑，能看见战场但明显压暗） */
    overlayColor: 0x000000,
    overlayAlpha: 0.7,
    /** 结算界面渲染深度：压在 HUD（60）之上 */
    depth: 200,
    titleFontSize: 42,
    turnFontSize: 22,
    /** 第 10 步：居中结算面板 512×320 + 200ms 淡入 */
    panelW: 512,
    panelH: 320,
    panelFill: 0x0F172A,
    panelFillAlpha: 0.94,
    panelBorder: 0xFDE047,
    fadeInMs: 200,
    /** 逻辑上收到胜负事件即显示（自检 / 浏览器回归要求即时 isVisible）；视觉淡入见 fadeInMs */
    panelDelayMs: 0,
    /** 「再来一局 / 返回标题」按钮尺寸 */
    buttonW: 200,
    buttonH: 48,
    buttonGapX: 16,
    buttonGapY: 28,
    buttonFill: 0x22C55E,
    buttonFillHover: 0x16A34A,
    buttonBorder: 0x064E3B,
    buttonTitleFill: 0x334155,
    buttonTitleFillHover: 0x475569,
    buttonFontSize: 22,
    /** 文案（集中一处，改文案不动逻辑） */
    labels: {
      blue: '水果王获胜',
      red: '酸果军团获胜',
      draw: '平局',
      turnPrefix: '共 ',
      turnSuffix: ' 回合',
      restart: '再来一局',
      title: '返回标题',
      survivors: '存活 蓝 {blue} / 红 {red}'
    }
  };

  /* ------------------------------------------------------------------
   * 5.11 HUD / 标题页（第 10 步）
   * ------------------------------------------------------------------ */
  const BACKGROUND = {
    enabled: true,
    imageKey: 'battle_bg',
    imagePath: 'assets/backgrounds/battle_bg.png',
    overlayAlpha: 0.15
  };

  const AUDIO = {
    enabled: true,
    volume: 0.5,
    maxSameSfxMs: 100,
    sounds: {
      throw: { enabled: true },
      explode_cherry: { enabled: true },
      explode_watermelon: { enabled: true },
      explode_banana: { enabled: true },
      splash: { enabled: true },
      crate_land: { enabled: true },
      move: { enabled: true },
      turn_switch: { enabled: true },
      click: { enabled: true }
    }
  };

  const CAMERA = {
    edgePx: 44,
    panSpeed: 860,
    arrowSize: 54,
    arrowDepth: 72,
    followLerp: 0.16,
    /** 玩家回合开始时镜头挪向角色的插值（越大越快） */
    turnFocusLerp: 0.14
  };

  const HUD = {
    depth: 60,
    toastDepth: 50,
    statusDepth: 48,
    timerWarnMs: 10000,
    timerRadius: 28,
    timerXOffset: 86,
    timerY: 41,
    powerBarW: 200,
    powerBarH: 18,
    selectedSlotScale: 1.08,
    copy: {
      allyAct: '你的回合（蓝色方可操作）',
      enemyAct: '敌方回合（红色方 AI）',
      turnOf: '第 {n} 回合',
      turnCap: '回合 {n} / {max}',
      aiThinking: '敌方思考中…',
      startHint: '点击「开始对局」进入战场',
      how1: '点击己方水果选中，按住拖拽瞄准，松手投出炸弹',
      how2: '底部五格：樱桃 / 西瓜 / 香蕉弹 / 水果箱 / 移动；香蕉弹地形弹跳，没动能或左键引爆',
      how3: '把敌人打空血量，或炸下高台落入果汁池即可获胜',
      start: '开始对局'
    }
  };

  /* ------------------------------------------------------------------
   * 5.10 敌方 AI（第 9 步新增）
   *
   *   红色方（酸果军团）回合由 FK.AIController 自动打完，玩家不需要操作。
   *   本组是 AI 的**唯一数值来源**（决策延迟 / 误差 / 道具权重 / 搜索范围），
   *   AIPlanner 与 AIController 里没有任何魔法数字。
   *
   *   规则口径（第 9 步）：
   *     · 回合开始后延迟 thinkDelayMs（1~2 秒随机）再决策；
   *     · 选单位：能打到敌人的优先，多个候选随机；
   *     · 选道具：按 itemWeights 权重随机（樱桃 40 / 西瓜 30 / 果箱 20 / 移动 10）；
   *     · 选目标：优先血最低的敌人；
   *     · 算参数：AIPlanner 用 TrajectoryPredictor 搜「力度 × 角度」，
   *               取落点离目标最近的一组；
   *     · 加误差：力度 ±error.powerRatio（8%）、角度 ±error.angleDeg（4°），
   *               落点 tolerance = error.landingTolerancePx（60px）算「打得中」；
     *     · 投掷 / 放置由既有链路收尾；若本回合先移动，落地后必须再补一次炸弹投掷。
   *
   *   ⚠️ 难度分层（简单 / 中等 / 困难）留到**第 13 步**：
   *      届时在 difficultyLevels 里加档位并覆盖 error / thinkDelayMs 即可，
   *      本步只做「中等」一档（difficulty: 'normal'）。
   * ------------------------------------------------------------------ */
  const AI = {
    /** 总开关：false 时红方回合不会自动行动（调试用） */
    enabled: true,
    /** AI 控制的阵营（turn.json 的 teamOrder 里必须存在该阵营） */
    team: 'red',
    /** 难度档位：第 9 步只实现 'normal' 一档（分层留第 13 步） */
    difficulty: 'normal',
    /** 决策延迟（毫秒）：每次在 [min, max] 内随机 → 表现「像人一样想了下」 */
    thinkDelayMs: { min: 1000, max: 2000 },
    /**
     * 行动兜底（毫秒）：出手后若这么久还没收尾（异常 / 极端弹道），
     * 强制结束回合，保证对局永不卡住。取值需大于「飞行 6s + 结算」的总时长。
     */
    actTimeoutMs: 12000,
    /**
     * 误差（规则 7）：力度按相对值抖动 ±8%，角度绝对抖动 ±4°。
     * landingTolerancePx = 落点容忍（60px）：搜出来的落点距目标 ≤ 该值才算「打得中」，
     * 也是「这个单位能不能打到敌人」的判据。
     */
    error: { powerRatio: 0.08, angleDeg: 4, landingTolerancePx: 60 },
    /** 道具权重（规则 4）：樱桃 40 / 西瓜 30 / 果箱 20 / 移动 10（总权重 100） */
    itemWeights: { cherry_bomb: 32, watermelon_bomb: 24, banana_bomb: 24, fruit_crate: 12, move: 8 },
    /** 兜底投掷道具：主选道具不可用时用它，保证 AI 不会站着不动 */
    fallbackItemId: 'cherry_bomb',
    /**
     * 投掷参数搜索（规则 6）：力度 × 角度 的候选网格 + 局部精修。
     *   候选数 = powerSteps × angleSteps（默认 18 × 15 = 270 ≤ maxCandidates）
     *   粗网格的落点间距约 50~150px，因此再用 refineRounds 轮「步长减半」的
     *   局部搜索把参数细化到约 1%，落点精度进入 error.landingTolerancePx 之内。
     */
    search: {
      powerMin: 0.22, powerMax: 1, powerSteps: 18,
      angleMinDeg: 12, angleMaxDeg: 82, angleSteps: 15,
      maxCandidates: 300,
      refineRounds: 3
    },
    /**
     * 移动参数搜索：跳跃落点尽量靠近「对手射手侧 standoffPx 处」，
     * 落水候选直接排除（AI 不会自己跳进果汁池）。
     */
    move: {
      powerMin: 0.35, powerMax: 1, powerSteps: 8,
      angleMinDeg: 18, angleMaxDeg: 72, angleSteps: 9,
      standoffPx: 336, edgePadPx: 60
    },
    /** 果箱放置：在目标「射手侧」按 offsetUnits 由近到远给候选点，逐个探测合法性 */
    placement: { offsetUnits: [2, 1.5, 2.5, 1, 3], sideStandoffPx: 96 },
    selfPreserve: {
      enabled: true,
      hpThreshold: 0.3,
      edgeDangerUnits: 1.0,
      skipAttackChance: 0.7
    },
    positionAdjust: {
      enabled: true,
      maxSearchSteps: 8
    },
    itemChoice: {
      rules: [
        { condition: 'enemy_hp_gt_40_and_near', item: 'watermelon_bomb' },
        { condition: 'enemy_hp_le_40', item: 'cherry_bomb' },
        { condition: 'enemy_on_edge', item: 'watermelon_bomb' },
        { condition: 'mid_range', item: 'banana_bomb' },
        { condition: 'crates_placed_and_safe', item: 'fruit_crate' },
        { condition: 'fallback', item: 'cherry_bomb' }
      ],
      randomFallbackChance: 0.15
    },
    /** 难度分层占位（第 13 步实现；本步只有 normal 一档） */
    difficultyLevels: { normal: 1 }
  };

  /* ------------------------------------------------------------------
   * 6. 调试开关
   * ------------------------------------------------------------------ */
  const DEBUG = {
    enabled: false,                               // 默认开发模式；发布改为 false 隐藏调试文字
    showFps: true,                               // 右上角显示 FPS
    showPhysics: false,                          // 显示 Arcade 物理碰撞体线框
    logLevel: 'DEBUG',                           // DEBUG | INFO | WARN | ERROR
    logDataSummary: true,                        // 启动时打印配置摘要
    /**
     * 跳过标题页直接进战斗。默认 false（玩家看到标题）。
     * 自检 / 无头浏览器在 URL 加 ?skipTitle=1 即可，不必改这个开关。
     */
    skipTitle: false
  };

  /* ------------------------------------------------------------------
   * 7. 数据文件路径
   *   json  —— 策划编辑的数据源（http(s) 下直接读取）
   *   mirror—— 运行时镜像（file:// 下唯一可用方式，见 index.html 注释）
   * ------------------------------------------------------------------ */
  const DATA = {
    basePath: 'data/',
    files: [
      { key: 'units', json: 'data/units.json', mirror: 'data/units.data.js', globalKey: 'units' },
      { key: 'items', json: 'data/items.json', mirror: 'data/items.data.js', globalKey: 'items' },
      { key: 'map', json: 'data/map.json', mirror: 'data/map.data.js', globalKey: 'map' },
      // 第 3 步新增：回合状态机配置（turnTime / teamOrder / initialTeam / timeoutProtection）
      { key: 'turn', json: 'data/turn.json', mirror: 'data/turn.data.js', globalKey: 'turn' }
    ]
  };

  /* ------------------------------------------------------------------
   * 8. 导出
   *   Config          —— 只读的结构常量（冻结）
   *   Config.runtime  —— 可被 JSON 覆盖的运行时参数（第 2 步填充）
   * ------------------------------------------------------------------ */
  FK.Config = {
    VERSION: VERSION,
    STEP: STEP,
    GAME_TITLE: GAME_TITLE,
    GAME_TITLE_EN: GAME_TITLE_EN,
    STEP_LABEL: STEP_LABEL,

    CANVAS: Object.freeze(CANVAS),
    SCALE: Object.freeze(SCALE),
    PX_PER_UNIT: PX_PER_UNIT,
    ARENA: Object.freeze(ARENA),
    PHYSICS: Object.freeze(PHYSICS),
    TURN: Object.freeze(TURN),
    AIM: Object.freeze(AIM),
    MOVE: Object.freeze(MOVE),
    PROJECTILE: Object.freeze(PROJECTILE),
    OBSTACLE: Object.freeze(OBSTACLE),
    DAMAGE: Object.freeze(DAMAGE),
    KNOCKBACK: Object.freeze(KNOCKBACK),
    DEATH: Object.freeze(DEATH),
    VICTORY: Object.freeze(VICTORY),
    RESULT: Object.freeze(RESULT),
    CAMERA: Object.freeze(CAMERA),
    HUD: Object.freeze(HUD),
    BACKGROUND: Object.freeze(BACKGROUND),
    AUDIO: Object.freeze(AUDIO),
    AI: Object.freeze(AI),
    DEBUG: Object.freeze(DEBUG),
    DATA: Object.freeze(DATA),

    /**
     * 运行时参数容器：所有可被 JSON 覆盖的玩法参数都合并到这里，
     * 业务代码一律读 FK.Config.runtime.xxx，绝不直接改结构常量。
     * （本步由 ConfigLoader 写入统计信息；第 2 步接入 data/game.json）
     */
    runtime: {},

    /**
     * 浅合并运行时参数。
     * 只允许覆盖 runtime，不允许修改 CANVAS / PHYSICS 等结构常量，
     * 从机制上保证「策划改 JSON 也改不坏引擎配置」。
     * @param {Object} params 待合并的参数对象
     * @returns {Object} 合并后的 runtime
     */
    applyRuntime: function (params) {
      if (!params || typeof params !== 'object') { return FK.Config.runtime; }
      Object.keys(params).forEach(function (k) {
        FK.Config.runtime[k] = params[k];
      });
      return FK.Config.runtime;
    },

    /** 读取运行时参数，缺失时回退到给定默认值 */
    getRuntime: function (key, fallback) {
      const v = FK.Config.runtime[key];
      return (v === undefined || v === null) ? fallback : v;
    },

    /* ---------------- 便捷方法（供全项目复用，避免魔法数字） ---------------- */

    /** 地图单位 → 世界像素 */
    u2px: function (units) {
      return units * PX_PER_UNIT;
    },

    /** 世界像素 → 地图单位 */
    px2u: function (px) {
      return px / PX_PER_UNIT;
    },

    /** 地图单位 X → 画布世界像素 X */
    arenaX: function (unitsX) {
      return ARENA.offsetX + unitsX * PX_PER_UNIT;
    },

    /** 地图单位 Y → 画布世界像素 Y */
    arenaY: function (unitsY) {
      return ARENA.offsetY + unitsY * PX_PER_UNIT;
    },

    /** 竞技场像素宽 */
    arenaWidthPx: function () {
      const map = (window.FK.Configs && window.FK.Configs.map) || null;
      const w = (map && map.width) || ARENA.widthUnits;
      return w * ((map && map.pxPerUnit) || PX_PER_UNIT);
    },

    /** 竞技场像素高 */
    arenaHeightPx: function () {
      const map = (window.FK.Configs && window.FK.Configs.map) || null;
      const h = (map && map.height) || ARENA.heightUnits;
      return h * ((map && map.pxPerUnit) || PX_PER_UNIT);
    },

    /** 当前地图世界像素边界（选图后以 MapConfig 为准，不再写死 30×12） */
    mapBoundsPx: function () {
      const map = (window.FK.Configs && window.FK.Configs.map) || null;
      const w = (map && typeof map.width === 'number') ? map.width : ARENA.widthUnits;
      const h = (map && typeof map.height === 'number') ? map.height : ARENA.heightUnits;
      return {
        left: FK.Config.arenaX(0),
        right: FK.Config.arenaX(w),
        top: FK.Config.arenaY(0),
        bottom: FK.Config.arenaY(h)
      };
    },

    /**
     * 第 9 步：当前是否轮到 AI 阵营（且 AI 总开关打开）。
     * 玩家指针 / 道具栏在此期间必须锁死；AI 自己的 beginThrow / commit / select
     * 走程序入口，不走这条判定。
     * @param {{ getCurrentTeam?: Function }} turnManager
     * @returns {boolean}
     */
    isAiTurn: function (turnManager) {
      const ai = FK.Config.AI;
      if (!ai || ai.enabled === false) { return false; }
      if (!turnManager || typeof turnManager.getCurrentTeam !== 'function') { return false; }
      const team = turnManager.getCurrentTeam();
      return !!team && team === (ai.team || 'red');
    },

    /** 战斗是否处于暂停（暂停界面打开时为 true） */
    isPaused: function () {
      return !!FK.Config._battlePaused;
    },

    setPaused: function (v) {
      FK.Config._battlePaused = !!v;
      return FK.Config._battlePaused;
    },

    /**
     * 第 10 步：是否跳过标题页。
     * URL `?skipTitle=1` / `?autostart=1` 优先；否则读 DEBUG.skipTitle。
     */
    shouldSkipTitle: function () {
      try {
        const search = (typeof location !== 'undefined' && location.search) ? String(location.search) : '';
        if (/[?&](skipTitle|autostart)=1\b/.test(search)) { return true; }
      } catch (e) { /* 无 location */ }
      return !!(FK.Config.DEBUG && FK.Config.DEBUG.skipTitle);
    }
  };

  FK.Debug = {
    objectCount: function () {
      const g = FK.game;
      if (!g || !g.scene || typeof g.scene.getScenes !== 'function') { return 0; }
      const scenes = g.scene.getScenes(true) || [];
      let n = 0;
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        const list = s && s.children && s.children.list;
        if (list && list.length) { n += list.length; }
      }
      return n;
    },
    skipTitle: function () { return FK.Config.shouldSkipTitle(); }
  };

  // 说明：只冻结各结构常量对象本身（CANVAS / PHYSICS / ARENA ...）；
  //       FK.Config 整体不冻结，因为 runtime 与 applyRuntime 需要可写。
})();
