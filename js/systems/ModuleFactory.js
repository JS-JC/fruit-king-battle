/**
 * ============================================================
 * ModuleFactory.js —— 模块工厂
 * ============================================================
 * 职责：
 *   把「配置对象（UnitConfig / ItemConfig / MapConfig）」与
 *   「注册表（UnitRegistry / ItemRegistry / MapRegistry）」对接起来，
 *   产出可实例化的模块对象。
 *
 *   它是数据层与模块层之间唯一的桥：
 *       JSON → Config 类 → ModuleFactory → Registry 中的模块工厂 → 模块实例
 *
 * 关键约定：
 *   · 本工厂**不实例化任何游戏对象**（不 new Unit、不加精灵、不碰 Phaser）
 *     只负责把模块对象取出来交给调用方，真正的 create(scene, config)
 *     由后续步骤（第 4 / 6 / 7 / 8 步）在场景里调用。
 *   · 对应 id 未注册模块时，抛出带指引的明确错误（不是静默返回 null）。
 *   · 纯 JS，不依赖 Phaser（事件走 FK.EventBus，其自带无 Phaser 回退实现）。
 *
 * 依赖：FK.EventBus、FK.EVENTS、各 Registry（运行期通过参数或默认值取得）
 * 对外：FK.ModuleFactory
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 三类模块的接口契约（与各 Registry 中登记的一致） */
  const REQUIRED = {
    unit: ['create', 'update', 'destroy'],
    item: ['onThrow', 'onLand', 'onExplode', 'onTurnEnd'],
    map: ['build', 'getSpawnPoints', 'getWaterLevel', 'destroy']
  };

  /** 类型中文名，用于错误信息 */
  const KIND_LABEL = { unit: '单位', item: '道具', map: '地图' };

  /** 按类型取默认注册表（延迟读取，避免加载顺序问题） */
  function defaultRegistry(kind) {
    if (kind === 'unit') { return FK.UnitRegistry; }
    if (kind === 'item') { return FK.ItemRegistry; }
    if (kind === 'map') { return FK.MapRegistry; }
    return null;
  }

  /** 从 config 推断类型 */
  function kindOf(config) {
    if (!config || typeof config !== 'object') { return null; }
    if (config.kind === 'unit' || config.kind === 'item' || config.kind === 'map') {
      return config.kind;
    }
    return null;
  }

  /** 二次契约校验（注册表已校验过一次，这里防御模块工厂被中途替换） */
  function assertContract(module, kind, id) {
    if (!module || typeof module !== 'object') {
      throw new Error('[ModuleFactory] ' + KIND_LABEL[kind] + ' 模块工厂返回了非对象：id="' + id +
        '"，实际 ' + typeof module);
    }
    const missing = REQUIRED[kind].filter(function (m) {
      return typeof module[m] !== 'function';
    });
    if (missing.length > 0) {
      throw new Error('[ModuleFactory] ' + KIND_LABEL[kind] + ' 模块 "' + id +
        '" 缺少接口方法：' + missing.join(', ') +
        '（必须实现：' + REQUIRED[kind].join(' / ') + '）');
    }
  }

  /**
   * 通用创建入口
   * @param {Object} config UnitConfig | ItemConfig | MapConfig
   * @param {Object} [registry] 目标注册表；不传则按 config.kind 自动选择
   * @returns {Object} 模块实例
   * @throws {TypeError} config 或 registry 类型不对
   * @throws {Error} 对应 id 未注册，或模块工厂执行失败
   */
  function create(config, registry) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('[ModuleFactory] create 失败：config 必须是 UnitConfig / ItemConfig / MapConfig 实例，实际 ' +
        (config === null ? 'null' : typeof config));
    }

    const kind = kindOf(config);
    if (kind === null) {
      throw new TypeError('[ModuleFactory] create 失败：无法识别 config 类型（缺少 kind 字段）。' +
        '请使用 UnitConfig / ItemConfig / MapConfig 的 fromJSON() 构造配置对象。');
    }

    if (!FK.ConfigUtils.isNonEmptyString(config.id)) {
      throw new TypeError('[ModuleFactory] create 失败：' + KIND_LABEL[kind] + ' config.id 缺失或为空');
    }

    const reg = registry || defaultRegistry(kind);
    if (!reg || typeof reg.has !== 'function' || typeof reg.get !== 'function') {
      throw new TypeError('[ModuleFactory] create 失败：' + KIND_LABEL[kind] + ' 注册表不可用' +
        '（期望具有 has() / get() 方法的注册表对象）');
    }

    const id = config.id;

    if (!reg.has(id)) {
      const msg = '[ModuleFactory] 未注册的' + KIND_LABEL[kind] + '模块：id="' + id +
        '"。请在 js/registry/registerAll.js 中登记对应模块工厂，' +
        '并确认模块文件已在 index.html 的脚本区引入。';
      emitError(kind, id, msg);
      throw new Error(msg);
    }

    const factory = reg.get(id);
    let module;
    try {
      module = (typeof factory === 'function') ? factory() : factory;
    } catch (e) {
      const msg = '[ModuleFactory] 创建' + KIND_LABEL[kind] + '模块 "' + id + '" 失败：' + e.message;
      emitError(kind, id, msg);
      throw new Error(msg);
    }

    assertContract(module, kind, id);

    if (FK.EventBus && FK.EVENTS) {
      FK.EventBus.emit(FK.EVENTS.MODULE_CREATED, {
        kind: kind, id: id, module: module, config: config
      });
    }
    return module;
  }

  function emitError(kind, id, message) {
    if (FK.EventBus && FK.EVENTS) {
      FK.EventBus.emit(FK.EVENTS.MODULE_ERROR, { kind: kind, id: id, message: message });
    }
  }

  /* ---------------- 便捷入口 ---------------- */

  /** 创建单位模块 @param {UnitConfig} cfg */
  function createUnit(cfg, registry) {
    return create(cfg, registry || FK.UnitRegistry);
  }

  /** 创建道具模块 @param {ItemConfig} cfg */
  function createItem(cfg, registry) {
    return create(cfg, registry || FK.ItemRegistry);
  }

  /** 创建地图模块 @param {MapConfig} cfg */
  function createMap(cfg, registry) {
    return create(cfg, registry || FK.MapRegistry);
  }

  /**
   * 批量创建
   * @param {Array} configs 配置数组
   * @param {string} kind 'unit' | 'item' | 'map'
   * @returns {{created:Object[], failed:{id:string,message:string}[]}} 逐个容错，不整体失败
   */
  function createAll(configs, kind) {
    const created = [];
    const failed = [];
    (configs || []).forEach(function (cfg) {
      try {
        created.push(create(cfg, defaultRegistry(kind)));
      } catch (e) {
        failed.push({ id: (cfg && cfg.id) || '(未知)', message: e.message });
      }
    });
    return { created: created, failed: failed };
  }

  /**
   * 从加载好的 FK.Configs 一次性创建全部模块
   * @returns {{units:Object[], items:Object[], map:Object|null, failed:Object[]}}
   */
  function createFromConfigs(configs) {
    configs = configs || FK.Configs || { units: [], items: [], map: null };
    const units = createAll(configs.units || [], 'unit');
    const items = createAll(configs.items || [], 'item');
    let mapModule = null;
    let mapFailed = [];
    if (configs.map) {
      try {
        mapModule = createMap(configs.map);
      } catch (e) {
        mapFailed.push({ id: configs.map.id, message: e.message });
      }
    }
    return {
      units: units.created,
      items: items.created,
      map: mapModule,
      failed: units.failed.concat(items.failed, mapFailed)
    };
  }

  FK.ModuleFactory = {
    REQUIRED: Object.freeze({
      unit: REQUIRED.unit.slice(),
      item: REQUIRED.item.slice(),
      map: REQUIRED.map.slice()
    }),
    create: create,
    createUnit: createUnit,
    createItem: createItem,
    createMap: createMap,
    createAll: createAll,
    createFromConfigs: createFromConfigs
  };
})();
