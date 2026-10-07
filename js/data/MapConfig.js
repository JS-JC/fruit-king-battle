/**
 * ============================================================
 * MapConfig.js —— 地图配置数据结构
 * ============================================================
 * 职责：
 *   把 data/map.json 中的地图记录，转换成一个**类型安全、只读**的
 *   纯 JS 配置对象，供注册表、模块工厂与地图布局模块使用。
 *
 * 字段：id / name / width / height / pxPerUnit / platforms / waterLevel / bounds / spawnPoints
 * 方法：MapConfig.fromJSON(json)   静态构造，非法时抛 TypeError
 *       mapConfig.validate()       返回 { valid, errors, warnings }，不抛异常
 *       mapConfig.toJSON()         还原为普通对象
 *       mapConfig.unitToPxX/Y(u)   单位 → 像素换算（纯计算，不依赖 Phaser）
 *
 * 坐标约定（与第 0 步冻结文档一致）：
 *   原点在竞技场左上角，x 向右为正，y 向下为正，单位是「地图单位 u」。
 *   平台 { x, y } 指平台**左上角**；waterLevel 是果汁池液面高度。
 *
 * 依赖：FK.ConfigUtils（纯 JS，不依赖 Phaser）
 * 对外：FK.MapConfig
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const U = FK.ConfigUtils;

  /** 阵营枚举（与 UnitConfig.TEAMS 保持一致） */
  const TEAMS = ['blue', 'red'];

  /** 地形材质枚举 */
  const MATERIALS = ['rock', 'cookie', 'jelly'];

  /** 第 7.10 步：竞技场边界类型枚举（wall = 实体墙；juice = 果汁边界，未来实现） */
  const BOUNDARY_TYPES = ['wall', 'juice'];

  class MapConfig {

    /**
     * 直接构造：不做异常抛出，只收集错误（供 validate() 使用）
     * @param {Object} raw data/map.json 中的 map 对象
     */
    constructor(raw) {
      raw = U.isPlainObject(raw) ? raw : {};

      this._errors = [];
      this._warnings = [];

      /** 配置类型标识（模块工厂用于路由到对应注册表） */
      this.kind = 'map';

      this.id = U.readString(raw, 'id', '', {
        required: true, label: 'id', errors: this._errors
      });

      this.name = U.readString(raw, 'name', this.id || '(未命名地图)', {
        label: 'name', errors: this._errors
      });

      // 除 id 外全部字段都可缺省：缺省即采用默认值，只有「类型错误 / 取值非法」才报错
      this.width = U.readNumber(raw, 'width', 30, {
        label: 'width', exclusiveMin: 0, errors: this._errors
      });

      this.height = U.readNumber(raw, 'height', 12, {
        label: 'height', exclusiveMin: 0, errors: this._errors
      });

      this.pxPerUnit = U.readNumber(raw, 'pxPerUnit', 48, {
        label: 'pxPerUnit', exclusiveMin: 0, errors: this._errors
      });

      // ---------- 平台列表 ----------
      this.platforms = U.readArray(raw, 'platforms', [], {
        label: 'platforms', errors: this._errors, warnings: this._warnings,
        validateItem: function (item, index, errors, warnings) {
          const label = 'platforms[' + index + ']';
          if (!U.isPlainObject(item)) {
            errors.push('字段 "' + label + '" 类型错误：期望 object，实际 ' + U.describe(item));
            return null;
          }
          const out = {
            id: U.readString(item, 'id', 'platform_' + index, { label: label + '.id', errors: errors }),
            x: U.readNumber(item, 'x', 0, { required: true, label: label + '.x', errors: errors }),
            y: U.readNumber(item, 'y', 0, { required: true, label: label + '.y', errors: errors }),
            width: U.readNumber(item, 'width', 1, { required: true, label: label + '.width', exclusiveMin: 0, errors: errors }),
            height: U.readNumber(item, 'height', 1, { required: true, label: label + '.height', exclusiveMin: 0, errors: errors }),
            material: U.readEnum(item, 'material', MATERIALS, 'rock', { label: label + '.material', errors: errors })
          };
          if (out.width <= 0 || out.height <= 0) {
            warnings.push(label + ' 尺寸为 0，该平台不会有任何碰撞效果');
          }
          return out;
        }
      });

      // ---------- 果汁池液面（默认贴地图底部） ----------
      this.waterLevel = U.readNumber(raw, 'waterLevel', this.height, {
        label: 'waterLevel', min: 0, errors: this._errors
      });
      if (U.isNumber(this.waterLevel) && U.isNumber(this.height) && this.waterLevel > this.height) {
        this._warnings.push('waterLevel(' + this.waterLevel + ') 超出地图高度(' + this.height + ')，实际不会存在果汁池');
      }

      // ---------- 第 7.10 步：竞技场边界类型（数据驱动） ----------
      // wall = 实体墙（撞上去弹性弹回）；juice = 果汁边界（未来实现，本步兜底）
      const boundsRaw = U.isPlainObject(raw.bounds) ? raw.bounds : {};
      this.boundsType = U.readEnum(boundsRaw, 'type', BOUNDARY_TYPES, 'wall', {
        label: 'bounds.type', errors: this._errors
      });

      // ---------- 出生点列表 ----------
      const self = this;
      this.spawnPoints = U.readArray(raw, 'spawnPoints', [], {
        label: 'spawnPoints', errors: this._errors, warnings: this._warnings,
        validateItem: function (item, index, errors, warnings) {
          const label = 'spawnPoints[' + index + ']';
          if (!U.isPlainObject(item)) {
            errors.push('字段 "' + label + '" 类型错误：期望 object，实际 ' + U.describe(item));
            return null;
          }
          const out = {
            team: U.readEnum(item, 'team', TEAMS, 'blue', { required: true, label: label + '.team', errors: errors }),
            unitId: U.readString(item, 'unitId', '', { required: true, label: label + '.unitId', errors: errors }),
            x: U.readNumber(item, 'x', 0, { required: true, label: label + '.x', errors: errors }),
            y: U.readNumber(item, 'y', 0, { required: true, label: label + '.y', errors: errors })
          };
          // 越界只提示不报错：方便策划先摆位置后调地图尺寸
          if (out.x < 0 || out.x > self.width || out.y < 0 || out.y > self.height) {
            warnings.push(label + ' 坐标 (' + out.x + ', ' + out.y + ') 超出地图范围 ' +
              self.width + '×' + self.height);
          }
          return out;
        }
      });

      // 空列表只提示不报错：方便策划先建地图壳子再逐步补平台与出生点
      if (this.platforms.length === 0) {
        this._warnings.push('platforms 为空，地图上不会有任何可站立地形');
      }
      if (this.spawnPoints.length === 0) {
        this._warnings.push('spawnPoints 为空，第 4 步将没有单位出生位置');
      }

      this.raw = U.deepFreeze(JSON.parse(JSON.stringify(raw)));
      U.deepFreeze(this);
    }

    /** 默认值表（策划对照用） */
    static defaults() {
      return {
        id: '',
        name: '(未命名地图)',
        width: 30,
        height: 12,
        pxPerUnit: 48,
        platforms: [],
        waterLevel: 12,
        bounds: { type: 'wall' },
        spawnPoints: []
      };
    }

    /**
     * 从 JSON 构造（严格模式）
     * @param {Object} json
     * @returns {MapConfig}
     * @throws {TypeError} 字段类型错误或取值非法时
     */
    static fromJSON(json) {
      const cfg = new MapConfig(json);
      const r = cfg.validate();
      if (!r.valid) {
        throw new TypeError(U.buildErrorMessage('MapConfig', cfg.id, r.errors));
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

    /* ---------------- 纯计算辅助（不依赖 Phaser） ---------------- */

    /** 地图单位 X → 像素 X */
    unitToPxX(unitsX) {
      return unitsX * this.pxPerUnit;
    }

    /** 地图单位 Y → 像素 Y */
    unitToPxY(unitsY) {
      return unitsY * this.pxPerUnit;
    }

    /** 地图像素宽度 */
    worldWidthPx() {
      return this.width * this.pxPerUnit;
    }

    /** 地图像素高度 */
    worldHeightPx() {
      return this.height * this.pxPerUnit;
    }

    /** 按阵营取出出生点；不传阵营则返回全部 */
    getSpawnPoints(team) {
      if (!team) { return this.spawnPoints.slice(); }
      return this.spawnPoints.filter(function (s) { return s.team === team; });
    }

    /** 按 id 取平台 */
    getPlatform(id) {
      const found = this.platforms.filter(function (p) { return p.id === id; });
      return found.length > 0 ? found[0] : null;
    }

    /** 还原为普通对象（字段顺序与 JSON 一致） */
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        width: this.width,
        height: this.height,
        pxPerUnit: this.pxPerUnit,
        platforms: this.platforms.map(function (p) {
          return { id: p.id, x: p.x, y: p.y, width: p.width, height: p.height, material: p.material };
        }),
        waterLevel: this.waterLevel,
        bounds: { type: this.boundsType },
        spawnPoints: this.spawnPoints.map(function (s) {
          return { team: s.team, unitId: s.unitId, x: s.x, y: s.y };
        })
      };
    }

    toString() {
      return 'MapConfig(' + this.id + ', ' + this.name + ', ' + this.width + '×' + this.height +
        'u, ' + this.pxPerUnit + 'px/u, platforms=' + this.platforms.length +
        ', spawns=' + this.spawnPoints.length + ')';
    }
  }

  MapConfig.TEAMS = Object.freeze(TEAMS.slice());
  MapConfig.MATERIALS = Object.freeze(MATERIALS.slice());

  FK.MapConfig = MapConfig;
})();
