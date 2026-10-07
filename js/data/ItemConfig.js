/**
 * ============================================================
 * ItemConfig.js —— 道具配置数据结构
 * ============================================================
 * 职责：
 *   把 data/items.json 中的一条道具记录，转换成一个**类型安全、只读**
 *   的纯 JS 配置对象，供注册表与模块工厂使用。
 *
 * 字段：id / name / type / range / damage / radius / knockback / duration / cooldownTurns / sprite
 *       + 第 6 步新增：innerRadiusUnits / edgeDamageRatio / projectileRadiusUnits
 *                      / fuseOnHitMs / explodeAnimMs
 * 方法：ItemConfig.fromJSON(json)  静态构造，非法时抛 TypeError
 *       itemConfig.validate()      返回 { valid, errors, warnings }，不抛异常
 *       itemConfig.toJSON()        还原为普通对象
 *       itemConfig.falloffAt(d)    爆炸衰减系数（纯查询，供 HUD / 自检复用）
 *
 * 行为约定：
 *   · range 是「力度系数」而非像素射程：1.0 对应满力 45° 射程 20.0 地图单位
 *   · explosive（爆炸类）必须有 damage 或 radius；obstacle（放置类）必须有 duration，
 *     否则给出 warning（不阻断加载，方便策划边填边试）
 *   · innerRadiusUnits / edgeDamageRatio 决定衰减曲线：
 *       距离 ≤ innerRadiusUnits          → 100% 伤害
 *       innerRadiusUnits < 距离 ≤ radius → 由 100% 线性降到 edgeDamageRatio
 *       距离 > radius                    → 0（不在爆炸范围）
 *
 * 依赖：FK.ConfigUtils（纯 JS，不依赖 Phaser）
 * 对外：FK.ItemConfig
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const U = FK.ConfigUtils;

  /** 道具类型枚举 */
  const TYPES = ['explosive', 'obstacle'];

  class ItemConfig {

    /**
     * 直接构造：不做异常抛出，只收集错误（供 validate() 使用）
     * @param {Object} raw data/items.json 中的一条记录
     */
    constructor(raw) {
      raw = U.isPlainObject(raw) ? raw : {};

      this._errors = [];
      this._warnings = [];

      /** 配置类型标识（模块工厂用于路由到对应注册表） */
      this.kind = 'item';

      this.id = U.readString(raw, 'id', '', {
        required: true, label: 'id', errors: this._errors
      });

      this.name = U.readString(raw, 'name', this.id || '(未命名道具)', {
        label: 'name', errors: this._errors
      });

      // 除 id 外全部字段都可缺省：缺省即采用默认值，只有「类型错误 / 取值非法」才报错
      this.type = U.readEnum(raw, 'type', TYPES, 'explosive', {
        label: 'type', errors: this._errors
      });

      /** 射程力度系数，1.0 = 基准（樱桃炸弹） */
      this.range = U.readNumber(raw, 'range', 1.0, {
        label: 'range', exclusiveMin: 0, errors: this._errors
      });

      /** 中心伤害 */
      this.damage = U.readNumber(raw, 'damage', 0, {
        label: 'damage', min: 0, errors: this._errors
      });

      /** 爆炸半径（地图单位 u） */
      this.radius = U.readNumber(raw, 'radius', 0, {
        label: 'radius', min: 0, errors: this._errors
      });

      /** 击退初速度（px/s） */
      this.knockback = U.readNumber(raw, 'knockback', 0, {
        label: 'knockback', min: 0, errors: this._errors
      });

      /** 持续回合数（放置类道具使用） */
      this.duration = U.readNumber(raw, 'duration', 0, {
        label: 'duration', min: 0, errors: this._errors
      });

      /* ---------- 第 6 步新增：投掷与爆炸表现参数（默认值来自文档 3 §5～§7） ---------- */

      /**
       * 满伤内圈半径（地图单位 u）：距爆心 ≤ 该值 → 100% 伤害。
       * 缺省 0 = 没有满伤内圈（全半径线性衰减）。
       */
      this.innerRadiusUnits = U.readNumber(raw, 'innerRadiusUnits', 0, {
        label: 'innerRadiusUnits', min: 0, errors: this._errors
      });

      /**
       * 边缘伤害系数（0～1）：爆炸半径边缘处的伤害 = damage × edgeDamageRatio。
       * 缺省 1 = 不衰减（中心与边缘同伤害）。
       */
      this.edgeDamageRatio = U.readNumber(raw, 'edgeDamageRatio', 1, {
        label: 'edgeDamageRatio', min: 0, max: 1, errors: this._errors
      });

      /** 投掷物视半径（地图单位 u）：占位图形大小，正式素材替换后仅保留作参考 */
      this.projectileRadiusUnits = U.readNumber(raw, 'projectileRadiusUnits', 0.3, {
        label: 'projectileRadiusUnits', min: 0, errors: this._errors
      });

      /** 引爆延迟（毫秒）：碰撞后到爆炸之间的引信时长 */
      this.fuseOnHitMs = U.readNumber(raw, 'fuseOnHitMs', 50, {
        label: 'fuseOnHitMs', min: 0, errors: this._errors
      });

      /** 爆炸演出时长（毫秒）：圆环从 0 放大到 radius 的时长 */
      this.explodeAnimMs = U.readNumber(raw, 'explodeAnimMs', 300, {
        label: 'explodeAnimMs', min: 0, errors: this._errors
      });

      /* ---------- 第 7 步新增：障碍物尺寸与道具栏说明 ---------- */

      /**
       * 障碍物边长（地图单位 u）：type="obstacle" 的道具落地生成的方块尺寸。
       * 文档 3 §7 冻结值 1.5u（= 72px）。缺省 1.5。
       */
      this.crateSizeUnits = U.readNumber(raw, 'crateSizeUnits', 1.5, {
        label: 'crateSizeUnits', exclusiveMin: 0, errors: this._errors
      });

      /** 道具栏悬停提示用的简短说明（纯展示文本，缺省空串） */
      this.desc = U.readString(raw, 'desc', '', {
        label: 'desc', errors: this._errors
      });

      /* ---------- 第 7.8 步新增：道具冷却 ---------- */

      /**
       * 冷却回合数（turn）：第 N 个 turn 使用后，第 N+1 个 turn 不可再用，
       * 第 N+2 个 turn 恢复可用（水果箱 = 1）。缺省 0 = 无冷却。
       * 计时由 FK.ItemCooldown 统一维护，本字段只描述规则。
       */
      this.cooldownTurns = U.readNumber(raw, 'cooldownTurns', 0, {
        label: 'cooldownTurns', min: 0, errors: this._errors
      });

      this.sprite = U.readString(raw, 'sprite', '', {
        label: 'sprite', errors: this._errors
      });
      if (!U.isNonEmptyString(this.sprite)) {
        this._warnings.push('字段 "sprite" 为空，第 6 步生成投掷物时将没有纹理可用（当前会回退到占位图形）');
      }

      // 类型与数值的一致性提示（不阻断加载）
      if (this.type === 'explosive' && this.damage <= 0 && this.radius <= 0) {
        this._warnings.push('type="explosive" 但 damage 与 radius 均为 0，该道具落地后不会产生任何效果');
      }
      if (this.type === 'obstacle' && this.duration <= 0) {
        this._warnings.push('type="obstacle" 但 duration=0，放置物会在落地当回合立即消失');
      }
      // 第 6 步新增：衰减参数自洽性检查
      if (this.innerRadiusUnits > this.radius && this.radius > 0) {
        this._warnings.push('innerRadiusUnits(' + this.innerRadiusUnits +
          ') 大于 radius(' + this.radius + ')，衰减曲线会被压缩到整个爆炸半径');
      }
      if (this.edgeDamageRatio > 0 && this.edgeDamageRatio < 1 && this.damage > 0 && this.radius <= 0) {
        this._warnings.push('配置了边缘伤害衰减但 radius=0，衰减不会生效');
      }

      this.raw = U.deepFreeze(JSON.parse(JSON.stringify(raw)));
      U.deepFreeze(this);
    }

    /** 默认值表（策划对照用） */
    static defaults() {
      return {
        id: '',
        name: '(未命名道具)',
        type: 'explosive',
        range: 1.0,
        damage: 0,
        radius: 0,
        knockback: 0,
        duration: 0,
        innerRadiusUnits: 0,
        edgeDamageRatio: 1,
        projectileRadiusUnits: 0.3,
        fuseOnHitMs: 50,
        explodeAnimMs: 300,
        crateSizeUnits: 1.5,
        cooldownTurns: 0,
        desc: '',
        sprite: ''
      };
    }

    /**
     * 从 JSON 构造（严格模式）
     * @param {Object} json
     * @returns {ItemConfig}
     * @throws {TypeError} 字段类型错误或取值非法时
     */
    static fromJSON(json) {
      const cfg = new ItemConfig(json);
      const r = cfg.validate();
      if (!r.valid) {
        throw new TypeError(U.buildErrorMessage('ItemConfig', cfg.id, r.errors));
      }
      return cfg;
    }

    /**
     * 校验（非严格，永不抛异常）
     * @returns {{valid:boolean, errors:string[], warnings:string[]}}
     */
    validate() {
      return {
        valid: this._errors.length === 0,
        errors: this._errors.slice(),
        warnings: this._warnings.slice()
      };
    }

    /** 是否为爆炸类道具 */
    isExplosive() {
      return this.type === 'explosive';
    }

    /** 是否为放置类道具 */
    isObstacle() {
      return this.type === 'obstacle';
    }

    /** 还原为普通对象（字段顺序与 JSON 一致） */
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        type: this.type,
        range: this.range,
        damage: this.damage,
        radius: this.radius,
        knockback: this.knockback,
        duration: this.duration,
        innerRadiusUnits: this.innerRadiusUnits,
        edgeDamageRatio: this.edgeDamageRatio,
        projectileRadiusUnits: this.projectileRadiusUnits,
        fuseOnHitMs: this.fuseOnHitMs,
        explodeAnimMs: this.explodeAnimMs,
        crateSizeUnits: this.crateSizeUnits,
        cooldownTurns: this.cooldownTurns,
        desc: this.desc,
        sprite: this.sprite
      };
    }

    /**
     * 爆炸衰减曲线（纯查询，不修改状态）
     * @param {number} distanceUnits 距爆心距离（地图单位）
     * @returns {number} 0～1 的伤害系数（内圈内 1，半径边缘 edgeDamageRatio，之外 0）
     */
    falloffAt(distanceUnits) {
      return FK.DamageSystem
        ? FK.DamageSystem.computeFalloff(distanceUnits, this.innerRadiusUnits, this.radius, this.edgeDamageRatio)
        : falloffLocal(distanceUnits, this.innerRadiusUnits, this.radius, this.edgeDamageRatio);
    }

    toString() {
      return 'ItemConfig(' + this.id + ', ' + this.name + ', type=' + this.type +
        ', dmg=' + this.damage + ', r=' + this.radius + 'u)';
    }
  }

  /** 本地衰减实现（FK.DamageSystem 尚未加载时的等价回退，保证纯数据层可独立加载） */
  function falloffLocal(distance, innerRadiusUnits, radiusUnits, edgeDamageRatio) {
    const d = (typeof distance === 'number' && isFinite(distance)) ? distance : Infinity;
    const inner = (typeof innerRadiusUnits === 'number' && innerRadiusUnits > 0) ? innerRadiusUnits : 0;
    const outer = (typeof radiusUnits === 'number' && radiusUnits > 0) ? radiusUnits : 0;
    const edge = (typeof edgeDamageRatio === 'number' && isFinite(edgeDamageRatio)) ? edgeDamageRatio : 1;
    if (outer <= 0) { return 0; }
    if (d >= outer) { return 0; }
    if (d <= inner) { return 1; }
    const t = (outer - d) / Math.max(1e-6, outer - inner);
    return edge + (1 - edge) * t;
  }

  ItemConfig.TYPES = Object.freeze(TYPES.slice());

  FK.ItemConfig = ItemConfig;
})();
