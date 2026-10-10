/**
 * ============================================================
 * registerAll.js —— 模块统一注册入口
 * ============================================================
 * 职责：
 *   把 js/entities/units、js/entities/items、js/systems/maps 下的
 *   模块工厂，逐一登记到对应的注册表里。BootScene 启动时调用一次。
 *
 * 【新增一个模块时，只需要在这里加一行】：
 *   单位  —— reg('unit', FK.UnitRegistry, '<id>', pick('unit', '<id>'), summary.units, summary.errors);
 *   道具  —— reg('item', FK.ItemRegistry, '<id>', pick('item', '<id>'), summary.items, summary.errors);
 *   地图  —— reg('map',  FK.MapRegistry,  '<id>', pick('map',  '<id>'), summary.maps,  summary.errors);
 *   （同时确认新模块文件已在 index.html 的脚本区引入）
 *
 * 额外做的两件防错检查：
 *   1. 模块工厂缺失 → 记录明确错误（而不是静默跳过）
 *   2. 数据 ↔ 模块 交叉校验：units.json / map.json 里出现、但没有对应模块的 id → 记录错误
 *
 * 依赖：FK.EventBus、FK.EVENTS、三个 Registry（纯 JS，不依赖 Phaser）
 * 对外：FK.RegisterAll
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const KIND_LABEL = { unit: '单位', item: '道具', map: '地图' };

  /** 是否已完成过一次注册 */
  let _done = false;
  /** 上一次注册的结果摘要 */
  let _summary = null;

  /** 从 FK.ModuleFactories[kind][id] 安全取出工厂（不会因命名空间缺失而抛错） */
  function pick(kind, id) {
    const bag = (FK.ModuleFactories && FK.ModuleFactories[kind]) || {};
    return bag[id];
  }

  /** 登记一个模块，失败只记录不中断，保证其余模块仍能注册 */
  function reg(kind, registry, id, factory, bucket, errors) {
    if (typeof factory !== 'function') {
      errors.push('[RegisterAll] 未找到' + KIND_LABEL[kind] + '模块工厂：' + id +
        '（请确认模块文件已在 index.html 的脚本区引入，且使用了 FK.ModuleFactories.' +
        kind + '.' + id + ' 这个键名）');
      return;
    }
    try {
      registry.register(id, factory);
      bucket.push(id);
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.emit(FK.EVENTS.REGISTRY_REGISTERED, { kind: kind, id: id });
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  /** 数据 ↔ 模块 交叉校验：JSON 里配了但没写模块，或写了模块但 JSON 没配 */
  function crossCheck(summary) {
    const configs = FK.Configs;
    if (!configs) { return; }

    (configs.units || []).forEach(function (u) {
      if (!FK.UnitRegistry.has(u.id)) {
        summary.errors.push('[RegisterAll] data/units.json 中的单位 "' + u.id + '" 没有对应的模块工厂');
      }
    });
    (configs.items || []).forEach(function (it) {
      if (!FK.ItemRegistry.has(it.id)) {
        summary.errors.push('[RegisterAll] data/items.json 中的道具 "' + it.id + '" 没有对应的模块工厂');
      }
    });
    const mapList = (configs.maps && configs.maps.length) ? configs.maps : (configs.map ? [configs.map] : []);
    mapList.forEach(function (m) {
      if (m && m.id && !FK.MapRegistry.has(m.id)) {
        summary.errors.push('[RegisterAll] data/map.json 中的地图 "' + m.id + '" 没有对应的模块工厂');
      }
    });

    FK.UnitRegistry.list().forEach(function (id) {
      const found = (configs.units || []).some(function (u) { return u.id === id; });
      if (!found) {
        summary.warnings.push('[RegisterAll] 单位模块 "' + id + '" 已注册，但 data/units.json 中没有对应配置');
      }
    });
    FK.ItemRegistry.list().forEach(function (id) {
      const found = (configs.items || []).some(function (it) { return it.id === id; });
      if (!found) {
        summary.warnings.push('[RegisterAll] 道具模块 "' + id + '" 已注册，但 data/items.json 中没有对应配置');
      }
    });
    const mapIds = {};
    ((configs.maps && configs.maps.length) ? configs.maps : (configs.map ? [configs.map] : [])).forEach(function (m) {
      if (m && m.id) { mapIds[m.id] = true; }
    });
    FK.MapRegistry.list().forEach(function (id) {
      if (!mapIds[id]) {
        summary.warnings.push('[RegisterAll] 地图模块 "' + id + '" 已注册，但 data/map.json 中没有对应配置');
      }
    });
  }

  /**
   * 执行全部注册
   * @param {Object} [opts] { force:true 强制重跑, reset:true 先清空注册表 }
   * @returns {{units:string[], items:string[], maps:string[], errors:string[], warnings:string[]}}
   */
  function run(opts) {
    opts = opts || {};

    if (_done && !opts.force) {
      return _summary;
    }
    if (opts.reset || opts.force) {
      reset();
    }

    const summary = { units: [], items: [], maps: [], errors: [], warnings: [] };

    /* ---------------- 单位模块 ---------------- */
    reg('unit', FK.UnitRegistry, 'fruit_king',     pick('unit', 'fruit_king'),     summary.units, summary.errors);
    reg('unit', FK.UnitRegistry, 'apple_guard',    pick('unit', 'apple_guard'),    summary.units, summary.errors);
    reg('unit', FK.UnitRegistry, 'lemon_general',  pick('unit', 'lemon_general'),  summary.units, summary.errors);
    reg('unit', FK.UnitRegistry, 'grape_soldier',  pick('unit', 'grape_soldier'),  summary.units, summary.errors);

    /* ---------------- 道具模块 ---------------- */
    reg('item', FK.ItemRegistry, 'cherry_bomb',     pick('item', 'cherry_bomb'),     summary.items, summary.errors);
    reg('item', FK.ItemRegistry, 'watermelon_bomb', pick('item', 'watermelon_bomb'), summary.items, summary.errors);
    reg('item', FK.ItemRegistry, 'banana_bomb',     pick('item', 'banana_bomb'),     summary.items, summary.errors);
    reg('item', FK.ItemRegistry, 'fruit_crate',     pick('item', 'fruit_crate'),     summary.items, summary.errors);

    /* ---------------- 地图模块 ---------------- */
    reg('map', FK.MapRegistry, 'fruit_king_arena', pick('map', 'fruit_king_arena'), summary.maps, summary.errors);
    reg('map', FK.MapRegistry, 'jam_canyon',      pick('map', 'jam_canyon'),      summary.maps, summary.errors);

    /* ---------------- 交叉校验 ---------------- */
    crossCheck(summary);

    _done = true;
    _summary = summary;

    if (summary.errors.length > 0) {
      console.error('[RegisterAll] 注册过程存在 ' + summary.errors.length + ' 个错误：');
      summary.errors.forEach(function (m) { console.error('  - ' + m); });
    }
    if (summary.warnings.length > 0) {
      summary.warnings.forEach(function (m) { console.warn('  ' + m); });
    }

    if (FK.EventBus && FK.EVENTS) {
      FK.EventBus.emit(FK.EVENTS.REGISTRY_ALL_READY, summary);
    }
    return summary;
  }

  /** 清空三个注册表并重置状态（对局重开 / 单元测试使用） */
  function reset() {
    FK.UnitRegistry.clear();
    FK.ItemRegistry.clear();
    FK.MapRegistry.clear();
    _done = false;
    _summary = null;
  }

  /** 是否已注册过 */
  function isDone() {
    return _done;
  }

  /** 取得上一次的摘要（未注册过返回 null） */
  function summary() {
    return _summary;
  }

  FK.RegisterAll = {
    run: run,
    reset: reset,
    isDone: isDone,
    summary: summary,
    pick: pick
  };
})();
