/**
 * ============================================================
 * ItemBar.js —— 道具栏 UI（第 7 步新增；第 8.6 步并入「移动」格）
 * ============================================================
 * 职责：
 *   在画布底部横排显示 **5 个格子**（第 14 步起）：
 *     [樱桃炸弹] [西瓜炸弹] [香蕉弹] [水果箱] [移动]
 *   提供「当前选中高亮 / 悬停显示名称 / 点击切换」三件事，并把选择结果
 *   通过事件广播出去。
 *
 * 第 8.6 步（本轮重做）：
 *   · 「移动」不再是独立的模式条，而是**道具栏的第 4 格**（与三个道具并列）；
 *   · 点第 4 格 → 选中态 = 移动（广播 slot:activated { active:true }）；
 *     点任意道具格 → 移动选中态自动取消（广播 slot:activated { active:false }）；
 *   · 每回合**只能移动一次**：移动完第 4 格置灰（canMove 由场景注入），
 *     但仍可选择道具正常投掷；再次点击被拒绝。
 *   · 全程没有「模式」概念：格子只有「选中 / 未选中」，交互模式由选中格决定。
 *
 * 分层纪律（见 README 分层规则）：
 *   ui/ 只读状态 + 渲染 + emit 事件，**绝不直接改游戏状态**。
 *   因此本类不持有 AimController / MoveController / ProjectileController，
 *   切换格子只广播事件，由 BattleScene 负责把选中结果下发给各系统（单向数据流）。
 *
 * 图标绘制：
 *   本步仍用程序化几何占位（爆炸类 = 圆炸弹 + 引线；放置类 = 木箱；移动 = 弧形箭头），
 *   与 assets/sprites/items/ 的纹理 key 一一对应，正式素材替换时只改 drawIcon。
 *
 * 依赖：Phaser（Graphics / Text / Zone）、FK.EVENTS、FK.EventBus
 * 对外：FK.ItemBar
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 配色（与 BattleScene 的面板配色保持一致） */
  const COLOR = {
    slotBg: 0x0F172A,
    /** 第 8.6 步：第 4 格「移动」的底板色（略偏蓝，与道具区分） */
    moveBg: 0x11294A,
    slotBorder: 0x334155,
    slotActive: 0xFDE047,
    slotHover: 0x93C5FD,
    slotCooling: 0x475569,
    cooldownMask: 0x0B1220,
    label: '#94A3B8',
    labelActive: '#FDE047',
    labelCooling: '#64748B',
    cdText: '#FCA5A5',
    tipBg: 0x1E293B,
    tipText: '#F8FAFC'
  };

  /** 布局常量（画布逻辑像素） */
  const LAYOUT = {
    slotW: 88,
    slotH: 88,
    gap: 8,
    selectedScale: 1.08,
    /** 底栏相对画布右下角的边距 */
    marginRight: 28,
    marginBottom: 104,
    tipAbovePx: 12,
    tipPadX: 16,
    tipPadY: 8,
    tipMinW: 88,
    tipMinH: 32
  };

  /** 第 8.6 步：「移动」格的虚拟槽位定义（不是 ItemConfig，不参与道具冷却 / 消费） */
  const MOVE_SLOT = Object.freeze({
    id: 'move',
    name: '移动',
    desc: '跳跃移动，每回合一次',
    type: 'move',
    isMoveSlot: true
  });

  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  /** 气泡宽度：优先用 Phaser 实测，自检环境按中文 14px / 英文 8px 估算 */
  function measureTipText(textObj, str) {
    const s = str || '';
    if (textObj) {
      const pw = num(textObj.width, 0);
      const ph = num(textObj.height, 0);
      if (pw > 0) { return { w: pw, h: ph > 0 ? ph : 18 }; }
      if (typeof textObj.getBounds === 'function') {
        const b = textObj.getBounds();
        if (b && num(b.width, 0) > 0) {
          return { w: b.width, h: num(b.height, 0) > 0 ? b.height : 18 };
        }
      }
    }
    let w = 0;
    for (let i = 0; i < s.length; i++) {
      w += (s.charCodeAt(i) > 127) ? 14 : 8;
    }
    return { w: w, h: 18 };
  }

  class ItemBar {

    /**
     * @param {Phaser.Scene} scene
     * @param {Object} opts
     *   items        ItemConfig 数组（缺省读 FK.Configs.items）
     *   selectedId   初始选中道具 id（缺省读 FK.Config.AIM.defaultItemId）
     *   x, y         第一个槽位的左上角（缺省按右下角边距自动排布）
     *   eventBus      事件总线（缺省 FK.EventBus）
     *   depth         渲染深度
     *   cooldown      第 7.8 步：(itemId) => 当前阵营的剩余冷却 turn 数
     *   canMove       第 8.6 步：() => 本回合还能不能移动（false → 第 4 格置灰）
     *   moveUsed      第 8.6 步：() => 本回合是否已经移动过（置灰 + 提示）
     */
    constructor(scene, opts) {
      opts = opts || {};
      this.scene = scene || null;
      this.eventBus = opts.eventBus || FK.EventBus || null;

      this.items = Array.isArray(opts.items) ? opts.items.slice()
        : ((FK.Configs && Array.isArray(FK.Configs.items)) ? FK.Configs.items.slice() : []);

      /** 「移动」格开关：on 时它会成为第 4 个格子（默认开） */
      this.withMoveSlot = (opts.withMoveSlot === false) ? false : true;
      /** 第 8.6 步：第 4 格「移动」当前是否被选中（移动选择态的唯一真相源） */
      this.moveSlotActive = false;
      /** 第 8.6 步：本回合还能不能移动（由场景注入；缺省恒为可移动） */
      this.canMoveProvider = (typeof opts.canMove === 'function') ? opts.canMove : null;
      /** 第 8.6 步：本回合是否已经移动过（置灰文案用） */
      this.moveUsedProvider = (typeof opts.moveUsed === 'function') ? opts.moveUsed : null;

      const defaultId = (FK.Config && FK.Config.AIM) ? FK.Config.AIM.defaultItemId : '';
      this.selectedId = opts.selectedId || defaultId || (this.items[0] ? this.items[0].id : '');
      this.lastItemId = this.selectedId;

      /** 渲染深度：HUD 之下、场景之上 */
      this.depth = num(opts.depth, 55);

      /** 第 8.6 步：第 4 格「移动」与三个道具并列（同一个槽位结构，只是没有 ItemConfig） */
      this.defs = this.items.slice();
      if (this.withMoveSlot) { this.defs.push(MOVE_SLOT); }

      const W = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.width : 1600;
      const H = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.height : 800;
      const totalW = this.defs.length * LAYOUT.slotW + Math.max(0, this.defs.length - 1) * LAYOUT.gap;
      this.originX = num(opts.x, W - LAYOUT.marginRight - totalW);
      this.originY = num(opts.y, H - LAYOUT.marginBottom);

      /** 每个槽位的 { item, x, y, gfx, label, active } */
      this.slots = [];
      /** 名称提示气泡 */
      this.tipBg = null;
      this.tipText = null;
      this.hoveredId = '';
      this.built = false;
      /** 第 7.8 步：冷却查询函数 itemId → 当前阵营剩余冷却（0 = 可用） */
      this.cooldownProvider = (typeof opts.cooldown === 'function') ? opts.cooldown : null;
      /** 上一次绘制时的冷却签名（变化才重绘） */
      this.cooldownSig = '';
      /**
       * 第 8 步：整栏是否可用。
       * GAME_OVER 后由 BattleScene 置 false（禁止再切换道具）；
       * 「再来一局」复位时置回 true。
       */
      this.enabled = (opts.enabled === undefined) ? true : !!opts.enabled;

      this.onPointerDownBound = this.onPointerDown.bind(this);
      this.onPointerMoveBound = this.onPointerMove.bind(this);
      this.onPointerOutBound = this.onPointerOut.bind(this);
    }

    /* ==================================================================
     * 构建
     * ================================================================== */

    /** 构建 UI（幂等）。没有 Phaser 渲染管线时只建逻辑槽位，便于自检 */
    build() {
      if (this.built) { return this; }
      this.built = true;

      // 第 8.6 步：第 4 格「移动」与三个道具并列（同一个槽位结构，只是没有 ItemConfig）
      const defs = this.defs;

      for (let i = 0; i < defs.length; i++) {
        const item = defs[i];
        const x = this.originX + i * (LAYOUT.slotW + LAYOUT.gap);
        const y = this.originY;
        const slot = {
          item: item,
          x: x, y: y,
          gfx: null, label: null, iconGfx: null,
          isMoveSlot: !!(item && item.isMoveSlot)
        };

        const canDraw = !!(this.scene && this.scene.add && typeof this.scene.add.graphics === 'function');
        if (canDraw) {
          slot.gfx = this.scene.add.graphics();
          if (typeof slot.gfx.setDepth === 'function') { slot.gfx.setDepth(this.depth); }
          if (typeof slot.gfx.setScrollFactor === 'function') { slot.gfx.setScrollFactor(0); }

          slot.iconGfx = this.scene.add.graphics();
          if (typeof slot.iconGfx.setDepth === 'function') { slot.iconGfx.setDepth(this.depth + 1); }
          if (typeof slot.iconGfx.setScrollFactor === 'function') { slot.iconGfx.setScrollFactor(0); }

          if (typeof this.scene.add.text === 'function') {
            slot.label = this.scene.add.text(x + LAYOUT.slotW / 2, y + LAYOUT.slotH - 14,
              (item && item.name) ? item.name : '', {
                fontFamily: '"Microsoft YaHei", sans-serif',
                fontSize: '13px',
                color: COLOR.label
              });
            if (typeof slot.label.setOrigin === 'function') { slot.label.setOrigin(0.5, 0.5); }
            if (typeof slot.label.setDepth === 'function') { slot.label.setDepth(this.depth + 2); }
            if (typeof slot.label.setScrollFactor === 'function') { slot.label.setScrollFactor(0); }

            // 第 7.8 步：冷却剩余回合文本（默认隐藏）
            slot.cdText = this.scene.add.text(x + LAYOUT.slotW / 2, y + LAYOUT.slotH / 2 - 2, '', {
              fontFamily: '"Microsoft YaHei", sans-serif',
              fontSize: '13px',
              fontStyle: 'bold',
              color: COLOR.cdText
            });
            if (typeof slot.cdText.setOrigin === 'function') { slot.cdText.setOrigin(0.5, 0.5); }
            if (typeof slot.cdText.setDepth === 'function') { slot.cdText.setDepth(this.depth + 3); }
            if (typeof slot.cdText.setVisible === 'function') { slot.cdText.setVisible(false); }
            if (typeof slot.cdText.setScrollFactor === 'function') { slot.cdText.setScrollFactor(0); }
          }
        }

        this.slots.push(slot);
        this.drawSlot(slot, i);
      }

      this.buildTip();
      this.bindInput();
      return this;
    }

    /**
     * 注册场景级指针监听（坐标命中，不用 Phaser Zone）。
     * 与 UnitSelector 的做法一致：命中判定走自己的 hitTest，
     * 不依赖 GameObject 的交互区，缩放/嵌套下更稳，也便于 Node 自检驱动。
     */
    bindInput() {
      const input = this.scene && this.scene.input;
      if (!input || typeof input.on !== 'function') { return this; }
      input.on('pointerdown', this.onPointerDownBound);
      input.on('pointermove', this.onPointerMoveBound);
      input.on('pointerout', this.onPointerOutBound);
      return this;
    }

    /**
     * 画一个槽位（边框 + 高亮 + 图标）
     *   第 7.8 步：冷却中额外画灰色遮罩与剩余回合
     *   第 8 步：整栏禁用（GAME_OVER）时同样走灰色遮罩
     *   第 8.6 步：第 4 格「移动」用自己的选中态（moveSlotActive）与可用判定
     */
    drawSlot(slot, index) {
      if (!slot.gfx) { return; }
      const isMove = !!slot.isMoveSlot;
      const itemId = slot.item ? slot.item.id : '';
      const cooldown = isMove ? 0 : this.getCooldownRemaining(itemId);
      const barOff = !this.enabled;
      const moveLocked = isMove && this.canUseMove() === false;
      const dim = barOff || cooldown > 0 || moveLocked;
      const selected = !dim &&
        (isMove ? this.isMoveSlotActive() : (!!itemId && itemId === this.selectedId));
      const hovered = !!itemId && itemId === this.hoveredId;
      const g = slot.gfx;
      const scale = selected ? LAYOUT.selectedScale : 1;
      const dw = LAYOUT.slotW * scale;
      const dh = LAYOUT.slotH * scale;
      const x = slot.x - (dw - LAYOUT.slotW) / 2;
      const y = slot.y - (dh - LAYOUT.slotH) / 2;

      g.clear();
      // 底板（移动格用略深的蓝底，便于与三个道具区分）
      g.fillStyle(isMove ? COLOR.moveBg : COLOR.slotBg, 0.92);
      g.fillRoundedRect(x, y, dw, dh, 12);
      const bc = dim ? COLOR.slotCooling
        : (selected ? COLOR.slotActive : (hovered ? COLOR.slotHover : COLOR.slotBorder));
      g.lineStyle(selected ? 3 : 2, bc, 1);
      g.strokeRoundedRect(x, y, dw, dh, 12);

      this.drawIcon(slot, selected, dw, dh, x, y);

      if (dim) {
        g.fillStyle(COLOR.cooldownMask, 0.62);
        g.fillRoundedRect(x, y, dw, dh, 12);
      }
      if (slot.cdText) {
        const text = moveLocked ? '已移动' : (cooldown > 0 ? ('冷却 ' + cooldown) : '');
        slot.cdText.setText(text);
        if (typeof slot.cdText.setVisible === 'function') { slot.cdText.setVisible(!!text); }
        if (typeof slot.cdText.setColor === 'function' && text) {
          slot.cdText.setColor(moveLocked ? COLOR.cdText : COLOR.cdText);
        }
      }

      if (slot.label && typeof slot.label.setColor === 'function') {
        slot.label.setColor(dim ? COLOR.labelCooling : (selected ? COLOR.labelActive : COLOR.label));
      }
      slot.cooling = cooldown > 0;
      slot.disabled = dim;
      slot.barOff = barOff;
      slot.selected = selected;
    }

    /* ==================================================================
     * 第 8.6 步：第 4 格「移动」的选中态 / 可用态
     * ================================================================== */

    /** 「移动」格当前是否被选中（移动选择态的唯一真相源） */
    isMoveSlotActive() { return !!this.moveSlotActive; }

    /** 本回合还能不能移动（由场景注入；缺省恒为 true） */
    canUseMove() {
      if (!this.enabled) { return false; }
      if (!this.canMoveProvider) { return true; }
      return !!this.canMoveProvider();
    }

    /** 本回合是否已经移动过（hover 提示文案用） */
    isMoveUsed() {
      if (!this.moveUsedProvider) { return false; }
      return !!this.moveUsedProvider();
    }

    /** 「移动」格的槽位（没有则 null） */
    getMoveSlot() {
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].isMoveSlot) { return this.slots[i]; }
      }
      return null;
    }

    /**
     * 切换「移动」选中态（广播 slot:activated；不直接调用 MoveController）
     * @param {boolean} active
     * @param {Object} [opts] { silent:true 只改状态不广播（自检 / 脚本用）, force:true 无视可用性 }
     * @returns {boolean} 切换后是否处于选中的移动态
     */
    setMoveSlotActive(active, opts) {
      const o = opts || {};
      const next = !!active;
      if (next && !o.force && !this.canUseMove()) {
        if (this.isMoveUsed()) { this.showTip('move'); }
        return false;
      }
      if (next === this.moveSlotActive) { this.refresh(); return next; }

      this.moveSlotActive = next;
      this.refresh();

      if (!o.silent) {
        this.emit((FK.EVENTS && FK.EVENTS.SLOT_ACTIVATED) || 'slot:activated', {
          active: next,
          reason: o.reason || (next ? 'click' : 'switch-item'),
          label: MOVE_SLOT.name
        });
      }
      return next;
    }

    /**
     * 第 7.8 步：该道具在当前行动方的剩余冷却 turn 数（0 = 可用）
     * provider 由 BattleScene 注入：itemId → 当前阵营的剩余冷却
     */
    getCooldownRemaining(itemId) {
      if (!this.cooldownProvider || !itemId) { return 0; }
      const n = this.cooldownProvider(itemId);
      return (typeof n === 'number' && isFinite(n) && n > 0) ? Math.floor(n) : 0;
    }

    /** 该槽位是否处于「灰色 / 禁用」状态 */
    isDisabled(itemId) {
      return this.getCooldownRemaining(itemId) > 0;
    }

    /** 第 8 步：整栏启用 / 禁用（GAME_OVER → false；「再来一局」→ true） */
    setEnabled(v) {
      const next = !!v;
      if (next === this.enabled) { return this; }
      this.enabled = next;
      // 整栏禁用时连带灰显（复用冷却的深色遮罩，不新增视觉分支）
      if (this.hoveredId) { this.onPointerOut(); }
      this.refresh();
      return this;
    }

    /** 整栏是否可用 */
    isEnabled() { return !!this.enabled; }

    /** 注入 / 更换冷却查询函数（第 7.8 步；BattleScene 在创建后调用） */
    setCooldownProvider(fn) {
      this.cooldownProvider = (typeof fn === 'function') ? fn : null;
      this.cooldownSig = '';
      this.refresh();
      return this;
    }

    /** 每帧调用：冷却状态变化时才重绘（避免每帧重画 3 个槽位） */
    refreshCooldown() {
      const self = this;
      const sig = this.slots.map(function (s) {
        return self.getCooldownRemaining(s.item ? s.item.id : '');
      }).join(',');
      if (sig === this.cooldownSig) { return false; }
      this.cooldownSig = sig;
      this.refresh();
      return true;
    }

    /**
     * 画道具图标（程序化占位：爆炸类 = 炸弹，放置类 = 木箱，移动 = 弧形箭头）。
     * 正式素材接入后改成 sprite 即可，槽位与交互逻辑一行不动。
     */
    drawIcon(slot, active, dw, dh, x, y) {
      const g = slot.iconGfx;
      if (!g) { return; }
      const item = slot.item || {};
      const boxW = dw || LAYOUT.slotW;
      const boxH = dh || LAYOUT.slotH;
      const cx = (x !== undefined ? x : slot.x) + boxW / 2;
      const cy = (y !== undefined ? y : slot.y) + boxH / 2 - 8;
      const r = 18;

      g.clear();
      if (slot.isMoveSlot) {
        // 移动：一条抛物线弧 + 落点圆点（与轨迹预览同一视觉语言）
        g.lineStyle(3, 0x7DD3FC, 1);
        g.beginPath();
        g.moveTo(cx - r, cy + r * 0.6);
        g.lineTo(cx - r * 0.4, cy - r * 0.7);
        g.lineTo(cx + r * 0.5, cy - r * 0.8);
        g.lineTo(cx + r, cy + r * 0.6);
        g.strokePath();
        g.fillStyle(0x22D3EE, 1);
        g.fillCircle(cx + r, cy + r * 0.6, 3.6);
        g.fillStyle(0x93C5FD, 1);
        g.fillCircle(cx - r, cy + r * 0.6, 3.6);
      } else if (item.type === 'obstacle') {
        // 木箱：方体 + 十字木条
        g.fillStyle(0xB45309, 1);
        g.fillRoundedRect(cx - r, cy - r, r * 2, r * 2, 4);
        g.fillStyle(0xD97706, 0.9);
        g.fillRoundedRect(cx - r, cy - r, r * 2, r * 0.42, 4);
        g.fillStyle(0x92400E, 1);
        g.fillRect(cx - r * 0.8, cy - r * 0.1, r * 1.6, r * 0.24);
        g.lineStyle(2, 0x7C2D12, 1);
        g.strokeRoundedRect(cx - r, cy - r, r * 2, r * 2, 4);
      } else {
        // 炸弹：圆身 + 引线 + 高光；西瓜（半径 ≥3）用绿皮红瓤区分
        const isBanana = item.id === 'banana_bomb';
        const isMelon = !isBanana && num(item.radius, 0) >= 3;
        if (isBanana) {
          g.fillStyle(0xFACC15, 1);
          g.fillCircle(cx - 8, cy + 4, 11);
          g.fillCircle(cx, cy - 2, 12);
          g.fillCircle(cx + 9, cy + 5, 11);
          g.lineStyle(2, 0xCA8A04, 1);
          g.beginPath();
          g.moveTo(cx - 14, cy + 4);
          g.lineTo(cx, cy - 12);
          g.lineTo(cx + 14, cy + 6);
          g.strokePath();
          g.fillStyle(0x78350F, 1);
          g.fillCircle(cx - 16, cy + 6, 3);
        } else {
          g.fillStyle(isMelon ? 0x16A34A : 0xDC2626, 1);
          g.fillCircle(cx, cy, r);
          g.lineStyle(2, isMelon ? 0x065F46 : 0x7F1D1D, 1);
          g.strokeCircle(cx, cy, r);
          g.fillStyle(0xFCA5A5, 0.85);
          g.fillCircle(cx - r * 0.3, cy - r * 0.3, r * 0.3);
          g.lineStyle(2, 0x78350F, 1);
          g.beginPath();
          g.moveTo(cx, cy - r);
          g.lineTo(cx + 3, cy - r - 7);
          g.strokePath();
        }
      }
      if (active && typeof g.setAlpha === 'function') { g.setAlpha(1); }
    }

    /** 名称提示气泡（悬停时显示「名称 · desc」） */
    buildTip() {
      const canDraw = !!(this.scene && this.scene.add && typeof this.scene.add.graphics === 'function');
      if (!canDraw) { return this; }

      this.tipBg = this.scene.add.graphics();
      if (this.tipBg.setDepth) { this.tipBg.setDepth(this.depth + 3); }
      if (this.tipBg.setScrollFactor) { this.tipBg.setScrollFactor(0); }
      this.tipBg.setVisible(false);

      if (this.scene.add.text) {
        this.tipText = this.scene.add.text(0, 0, '', {
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: '14px',
          color: COLOR.tipText
        });
        if (this.tipText.setOrigin) { this.tipText.setOrigin(0.5, 0.5); }
        if (this.tipText.setDepth) { this.tipText.setDepth(this.depth + 4); }
        if (this.tipText.setScrollFactor) { this.tipText.setScrollFactor(0); }
        this.tipText.setVisible(false);
      }
      return this;
    }

    /* ==================================================================
     * 交互
     * ================================================================== */

    /**
     * 悬停：显示名称 + 描述
     *   第 7.8 步：冷却中追加「冷却中」
     *   第 8.6 步：第 4 格「移动」追加「本回合已移动」状态
     */
    showTip(itemId) {
      this.hoveredId = itemId || '';
      this.refresh();
      const slot = this.findSlot(itemId);
      if (!slot || !this.tipBg || !this.tipText) { return this; }

      const item = slot.item || {};
      let text;
      if (slot.isMoveSlot) {
        text = (item.name || itemId) + (item.desc ? ' · ' + item.desc : '') +
          (this.isMoveUsed() ? ' · 本回合已移动' : '');
      } else {
        const cd = this.getCooldownRemaining(itemId);
        text = (item.name || itemId) + (item.desc ? ' · ' + item.desc : '') +
          (cd > 0 ? ' · 冷却中' : '');
      }
      this.tipText.setText(text);
      slot.tipText = text;

      const size = measureTipText(this.tipText, text);
      const w = Math.max(LAYOUT.tipMinW, size.w + LAYOUT.tipPadX * 2);
      const h = Math.max(LAYOUT.tipMinH, size.h + LAYOUT.tipPadY * 2);
      const canvasW = (FK.Config && FK.Config.CANVAS) ? FK.Config.CANVAS.width : 1600;
      let left = slot.x + LAYOUT.slotW / 2 - w / 2;
      if (left < 8) { left = 8; }
      if (left + w > canvasW - 8) { left = canvasW - 8 - w; }
      const cx = left + w / 2;
      const bottom = slot.y - LAYOUT.tipAbovePx;
      const warn = slot.isMoveSlot ? this.isMoveUsed() : (this.getCooldownRemaining(itemId) > 0);

      this.tipBg.clear();
      this.tipBg.fillStyle(COLOR.tipBg, 0.96);
      this.tipBg.fillRoundedRect(left, bottom - h, w, h, 8);
      this.tipBg.lineStyle(2, warn ? COLOR.slotCooling : COLOR.slotBorder, 1);
      this.tipBg.strokeRoundedRect(left, bottom - h, w, h, 8);
      this.tipBg.setVisible(true);
      this.tipText.setPosition(cx, bottom - h / 2);
      this.tipText.setVisible(true);
      return this;
    }

    /** 移出：隐藏气泡 */
    onPointerOut() {
      this.hoveredId = '';
      if (this.tipBg) { this.tipBg.setVisible(false); }
      if (this.tipText) { this.tipText.setVisible(false); }
      this.refresh();
      return this;
    }

    /** 指针按下（整栏兜底：不在 Zone 上也支持按坐标判定） */
    onPointerDown(pointer) {
      if (!pointer || !this.enabled) { return false; }
      if (FK.Config && typeof FK.Config.isPaused === 'function' && FK.Config.isPaused()) { return false; }
      const hit = this.hitTest(num(pointer.x, -1), num(pointer.y, -1));
      if (!hit) { return false; }
      return this.select(hit.item ? hit.item.id : '');
    }

    /** 指针移动（整栏兜底：悬停判定） */
    onPointerMove(pointer) {
      if (!pointer) { return false; }
      if (FK.Config && typeof FK.Config.isPaused === 'function' && FK.Config.isPaused()) { return false; }
      const hit = this.hitTest(num(pointer.x, -1), num(pointer.y, -1));
      if (hit) { return this.showTip(hit.item ? hit.item.id : ''); }
      if (this.hoveredId) { return this.onPointerOut(); }
      return false;
    }

    /** 命中测试：世界坐标 → 槽位 */
    hitTest(worldX, worldY) {
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (worldX >= s.x && worldX <= s.x + LAYOUT.slotW &&
            worldY >= s.y && worldY <= s.y + LAYOUT.slotH) {
          return s;
        }
      }
      return null;
    }

    /* ==================================================================
     * 选择
     * ================================================================== */

    /**
     * 切换选中槽位（广播 slot:selected / slot:activated）
     *   第 7.8 步：冷却中的格子是**灰色禁用**的，点击不生效（并弹一次「冷却中」提示）
     *   第 8.6 步：第 4 格「移动」——点击即选中移动（广播 slot:activated {active:true}）；
     *              点击任意道具格会先取消移动选中态，再切换道具（每回合只能移动一次）。
     * @param {string} slotId 道具 id 或 'move'
     * @param {Object} [opts] { silent:true 只改状态不广播；force:true 无视冷却 / 可用性（自检 / 脚本用） }
     * @returns {boolean} 是否发生了切换
     */
    select(slotId, opts) {
      const o = opts || {};
      const slot = this.findSlot(slotId);
      if (!slot || !slot.item) { return false; }

      // 第 8 步：GAME_OVER 后整栏禁用（force 供自检 / 脚本绕过）
      if (!this.enabled && !o.force) { return false; }

      // 第 8.6 步：第 4 格「移动」
      if (slot.isMoveSlot) {
        // 选中移动会占用本回合的移动次数 → 先清掉道具选中态（投掷与移动不再并存）
        if (this.selectedId) {
          const previous = this.selectedId;
          this.lastItemId = previous;
          this.selectedId = '';
          if (!o.silent) {
            this.emit((FK.EVENTS && FK.EVENTS.SLOT_SELECTED) || 'slot:selected', {
              itemId: '', name: '', desc: '', item: null,
              previousId: previous, isMoveSlot: false
            });
          }
        }
        return this.setMoveSlotActive(true, { silent: o.silent, force: o.force, reason: 'click-move' });
      }

      if (!o.force && this.isDisabled(slotId)) {
        this.showTip(slotId);                 // 禁用状态：只显示「冷却中」，不切换
        return false;
      }
      // 切回道具 = 退出移动选择态
      if (this.moveSlotActive) {
        this.setMoveSlotActive(false, { silent: o.silent, force: true, reason: 'switch-item' });
      }
      if (slotId === this.selectedId) {
        // 重复点击同一格：不重复广播（与 UnitSelector 的规则一致）
        if (!o.silent) { this.refresh(); }
        return false;
      }

      const previousId = this.selectedId;
      this.selectedId = slotId;
      this.lastItemId = slotId;
      this.refresh();

      if (!o.silent) {
        this.emit((FK.EVENTS && FK.EVENTS.SLOT_SELECTED) || 'slot:selected', {
          itemId: slotId,
          name: slot.item.name || '',
          desc: slot.item.desc || '',
          item: slot.item,
          previousId: previousId,
          isMoveSlot: false
        });
      }
      return true;
    }

    /** 重绘全部槽位 */
    refresh() {
      for (let i = 0; i < this.slots.length; i++) { this.drawSlot(this.slots[i], i); }
      return this;
    }

    /* ==================================================================
     * 查询
     * ================================================================== */

    /** 当前选中道具配置（ItemConfig 或 null） */
    getSelected() {
      const s = this.findSlot(this.selectedId);
      return s ? s.item : null;
    }

    /** 当前选中道具 id */
    getSelectedId() { return this.selectedId; }

    /** 槽位数量 */
    count() { return this.slots.length; }

    /** id 列表 */
    ids() {
      return this.slots.map(function (s) { return s.item ? s.item.id : ''; });
    }

    /** 按 id 找槽位 */
    findSlot(itemId) {
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].item && this.slots[i].item.id === itemId) { return this.slots[i]; }
      }
      return null;
    }

    /** 调试快照 */
    getInfo() {
      return {
        count: this.slots.length,
        selectedId: this.selectedId,
        hoveredId: this.hoveredId,
        ids: this.ids(),
        /** 第 8.6 步：第 4 格「移动」是否选中 / 是否可用 */
        moveSlotActive: !!this.moveSlotActive,
        canUseMove: this.canUseMove(),
        moveUsed: this.isMoveUsed(),
        disabled: this.slots.filter(function (s) { return s.disabled; })
          .map(function (s) { return s.item ? s.item.id : ''; }),
        enabled: !!this.enabled,
        origin: { x: this.originX, y: this.originY },
        slotSize: { w: LAYOUT.slotW, h: LAYOUT.slotH },
        selectedScale: LAYOUT.selectedScale
      };
    }

    /* ---------------- 内部 ---------------- */

    emit(type, payload) {
      if (this.eventBus && type) { this.eventBus.emit(type, payload); }
    }

    /** 销毁：移除全部图形与文本，解除输入监听 */
    destroy() {
      const input = this.scene && this.scene.input;
      if (input && typeof input.off === 'function') {
        input.off('pointerdown', this.onPointerDownBound);
        input.off('pointermove', this.onPointerMoveBound);
        input.off('pointerout', this.onPointerOutBound);
      }
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (s.gfx && typeof s.gfx.destroy === 'function') { s.gfx.destroy(); }
        if (s.iconGfx && typeof s.iconGfx.destroy === 'function') { s.iconGfx.destroy(); }
        if (s.label && typeof s.label.destroy === 'function') { s.label.destroy(); }
        if (s.cdText && typeof s.cdText.destroy === 'function') { s.cdText.destroy(); }
      }
      this.slots = [];
      this.moveSlotActive = false;
      if (this.tipBg && typeof this.tipBg.destroy === 'function') { this.tipBg.destroy(); }
      if (this.tipText && typeof this.tipText.destroy === 'function') { this.tipText.destroy(); }
      this.tipBg = null;
      this.tipText = null;
      this.built = false;
      this.scene = null;
    }
  }

  ItemBar.LAYOUT = Object.freeze(LAYOUT);
  ItemBar.COLOR = Object.freeze(COLOR);
  /** 第 8.6 步：第 4 格「移动」的槽位定义（自检 / 其他 UI 复用） */
  ItemBar.MOVE_SLOT = MOVE_SLOT;

  FK.ItemBar = ItemBar;
})();
