/**
 * ============================================================
 * unitRegistry.js —— 单位注册表（第 2 步增强：支持模块工厂）
 * ============================================================
 * 职责：
 *   登记「单位 id → 单位模块工厂」的映射。
 *   data/units.json 只描述数值（hp / team / sprite / throwPower / moveRange），
 *   单位的行为与外观由本注册表指向的模块提供，二者通过 id 关联。
 *   新增单位 = 新建一个模块文件 + registerAll.js 加一行。
 *
 * 单位模块必须实现的统一接口：
 *   create(scene, config)  生成单位实体（第 4 步使用）
 *   update(unit, dt)       每帧更新（第 4 步使用）
 *   destroy(unit)          移除单位与绑定资源（第 4 步使用）
 *
 * register 的两种入参形式与错误约定，见 js/registry/itemRegistry.js 顶部注释
 * （三个注册表行为完全一致）。
 *
 * 依赖：无（纯 JS）
 * 对外：FK.UnitRegistry
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const REGISTRY_NAME = 'UnitRegistry';
  const KIND = 'unit';

  /** 单位模块必须实现的方法名（接口契约） */
  const REQUIRED_METHODS = ['create', 'update', 'destroy'];

  /** id → 模块工厂函数 */
  const _modules = new Map();

  function isFactory(x) {
    return typeof x === 'function';
  }

  function isModuleObject(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  function normalize(id, moduleFactory) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      console.warn('[' + REGISTRY_NAME + '] register 失败：id 必须是非空字符串');
      return null;
    }
    if (isFactory(moduleFactory)) {
      return moduleFactory;
    }
    if (isModuleObject(moduleFactory)) {
      return function singletonModuleFactory() { return moduleFactory; };
    }
    console.warn('[' + REGISTRY_NAME + '] register 失败：moduleFactory 必须是函数或对象，id=' + id);
    return null;
  }

  function assertContract(factory, id) {
    let sample;
    try {
      sample = factory();
    } catch (e) {
      throw new Error('[' + REGISTRY_NAME + '] 注册失败：id="' + id +
        '" 的 moduleFactory 执行时抛出异常 → ' + e.message);
    }
    if (!isModuleObject(sample)) {
      throw new Error('[' + REGISTRY_NAME + '] 注册失败：id="' + id +
        '" 的 moduleFactory 必须返回一个对象，实际返回 ' + (sample === null ? 'null' : typeof sample));
    }
    const missing = REQUIRED_METHODS.filter(function (m) {
      return typeof sample[m] !== 'function';
    });
    if (missing.length > 0) {
      throw new Error('[' + REGISTRY_NAME + '] 注册失败：id="' + id + '" 的单位模块缺少接口方法 → ' +
        missing.join(', ') + '（必须实现：' + REQUIRED_METHODS.join(' / ') + '）');
    }
  }

  /**
   * 登记一个单位模块工厂
   * @param {string} id 单位唯一 id，需与 data/units.json 中的 id 一致
   * @param {Function|Object} moduleFactory 返回模块对象的工厂函数
   * @returns {Function|null} 规范化后的工厂；非法入参返回 null
   */
  function register(id, moduleFactory) {
    const factory = normalize(id, moduleFactory);
    if (factory === null) { return null; }

    if (_modules.has(id)) {
      console.warn('[' + REGISTRY_NAME + '] 单位 id 重复登记，后者覆盖前者：' + id);
    }

    assertContract(factory, id);
    _modules.set(id, factory);
    return factory;
  }

  function get(id) {
    if (!_modules.has(id)) {
      console.warn('[' + REGISTRY_NAME + '] 未找到单位：' + id);
      return null;
    }
    return _modules.get(id);
  }

  function has(id) {
    return _modules.has(id);
  }

  function create(id) {
    if (!_modules.has(id)) {
      console.warn('[' + REGISTRY_NAME + '] 无法创建，未登记的单位：' + id);
      return null;
    }
    const factory = _modules.get(id);
    return isFactory(factory) ? factory() : factory;
  }

  function list() {
    return Array.from(_modules.keys());
  }

  function ids() {
    return list();
  }

  function count() {
    return _modules.size;
  }

  function getAll() {
    const out = {};
    _modules.forEach(function (v, k) { out[k] = v; });
    return out;
  }

  function clear() {
    _modules.clear();
  }

  FK.UnitRegistry = {
    NAME: REGISTRY_NAME,
    KIND: KIND,
    INTERFACE: Object.freeze(REQUIRED_METHODS.slice()),
    register: register,
    get: get,
    has: has,
    create: create,
    list: list,
    ids: ids,
    count: count,
    getAll: getAll,
    clear: clear
  };
})();
