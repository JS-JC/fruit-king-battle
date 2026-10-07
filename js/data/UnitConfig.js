/**
 * ============================================================
 * UnitConfig.js —— 单位配置数据结构
 * ============================================================
 * 职责：
 *   把 data/units.json 中的一条单位记录，转换成一个**类型安全、只读**
 *   的纯 JS 配置对象，供注册表与模块工厂使用。
 *
 * 字段：id / name / team / hp / sprite / throwPower / moveRange
 * 方法：UnitConfig.fromJSON(json)  静态构造，非法时抛 TypeError
 *       unitConfig.validate()      返回 { valid, errors, warnings }，不抛异常
 *       unitConfig.toJSON()        还原为普通对象
 *
 * 行为约定：
 *   · 字段缺失 → 使用合理默认值（见 defaults()）
 *   · 类型错误 / 取值非法 → fromJSON 抛出带字段名的明确错误
 *   · MVP 阶段所有单位数值一致，首领仅皮肤差异
 *
 * 依赖：FK.ConfigUtils（纯 JS，不依赖 Phaser）
 * 对外：FK.UnitConfig
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const U = FK.ConfigUtils;

  /** 阵营枚举：blue = 己方水果军团，red = 敌方酸果军团 */
  const TEAMS = ['blue', 'red'];

  class UnitConfig {

    /**
     * 直接构造：不做异常抛出，只收集错误（供 validate() 使用）
     * @param {Object} raw data/units.json 中的一条记录
     */
    constructor(raw) {
      raw = U.isPlainObject(raw) ? raw : {};

      this._errors = [];
      this._warnings = [];

      /** 配置类型标识（模块工厂用于路由到对应注册表） */
      this.kind = 'unit';

      this.id = U.readString(raw, 'id', '', {
        required: true, label: 'id', errors: this._errors
      });

      // name 缺失时回退为 id，保证日志里总能看出是哪个单位
      this.name = U.readString(raw, 'name', this.id || '(未命名单位)', {
        label: 'name', errors: this._errors
      });

      // 除 id 外全部字段都可缺省：缺省即采用默认值，只有「类型错误 / 取值非法」才报错
      this.team = U.readEnum(raw, 'team', TEAMS, 'blue', {
        label: 'team', errors: this._errors
      });

      this.hp = U.readNumber(raw, 'hp', 100, {
        label: 'hp', min: 1, errors: this._errors
      });

      this.sprite = U.readString(raw, 'sprite', '', {
        label: 'sprite', errors: this._errors
      });
      if (!U.isNonEmptyString(this.sprite)) {
        this._warnings.push('字段 "sprite" 为空，第 4 步生成实体时将没有纹理可用（当前会回退到占位图形）');
      }

      this.throwPower = U.readNumber(raw, 'throwPower', 1.0, {
        label: 'throwPower', exclusiveMin: 0, errors: this._errors
      });

      this.moveRange = U.readNumber(raw, 'moveRange', 0, {
        label: 'moveRange', min: 0, errors: this._errors
      });

      // 原始数据留档，便于第 4 步读取本结构未覆盖的扩展字段
      this.raw = U.deepFreeze(JSON.parse(JSON.stringify(raw)));

      // 冻结整个配置对象，保证运行期只读
      // （_errors / _warnings 数组也被冻结，但 validate() 只读不写，故安全）
      U.deepFreeze(this);
    }

    /** 默认值表（策划对照用） */
    static defaults() {
      return {
        id: '',
        name: '(未命名单位)',
        team: 'blue',
        hp: 100,
        sprite: '',
        throwPower: 1.0,
        moveRange: 0
      };
    }

    /**
     * 从 JSON 构造（严格模式）
     * @param {Object} json
     * @returns {UnitConfig}
     * @throws {TypeError} 字段类型错误或取值非法时
     */
    static fromJSON(json) {
      const cfg = new UnitConfig(json);
      const r = cfg.validate();
      if (!r.valid) {
        throw new TypeError(U.buildErrorMessage('UnitConfig', cfg.id, r.errors));
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

    /** 是否为指定阵营 */
    isTeam(team) {
      return this.team === team;
    }

    /** 还原为普通对象（字段顺序与 JSON 一致） */
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        team: this.team,
        hp: this.hp,
        sprite: this.sprite,
        throwPower: this.throwPower,
        moveRange: this.moveRange
      };
    }

    toString() {
      return 'UnitConfig(' + this.id + ', ' + this.name + ', team=' + this.team + ', hp=' + this.hp + ')';
    }
  }

  UnitConfig.TEAMS = Object.freeze(TEAMS.slice());

  FK.UnitConfig = UnitConfig;
})();
