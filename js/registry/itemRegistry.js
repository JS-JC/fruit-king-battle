/**
 * ============================================================
 * itemRegistry.js —— 道具注册表（第 2 步增强：支持模块工厂）
 * ============================================================
 * 职责：
 *   登记「道具 id → 道具模块工厂」的映射，让 BattleScene 只认 id，
 *   不认具体道具，从而实现「新增一个道具 = 新建一个模块文件 +
 *   在 registerAll.js 加一行」，核心逻辑零改动。
 *
 * 道具模块必须实现的统一接口：
 *   onThrow(ctx)    投掷出手时调用（生成投掷物、设定初速度）
 *   onLand(ctx)     落地/碰撞时调用（决定是爆炸还是放置障碍）
 *   onExplode(ctx)  爆炸结算时调用（伤害范围、击退、特效）
 *   onTurnEnd(ctx)  回合结束时调用（持续型道具的倒计时与销毁，如水果箱）
 *
 * register 的两种入参形式：
 *   1) register(id, factory)  ← 推荐。factory 是**无副作用纯函数**，
 *                               调用后返回实现了上述接口的模块对象。
 *                               注册时会被调用一次做契约校验。
 *   2) register(id, module)   ← 兼容。直接给对象，内部包装成单例工厂。
 *
 * 错误约定：
 *   · 非法入参（id 非字符串 / module 既不是函数也不是对象）→ 告警 + 返回 null，不抛异常
 *   · 模块缺少接口方法 / 工厂执行抛错 → 抛出带 id 与缺失方法名的明确 Error
 *   · get 未注册 id → 告警 + 返回 null，不抛异常
 *
 * 依赖：无（纯 JS）
 * 对外：FK.ItemRegistry
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const REGISTRY_NAME = 'ItemRegistry';
  const KIND = 'item';

  /** 道具模块必须实现的方法名（接口契约） */
  const REQUIRED_METHODS = ['onThrow', 'onLand', 'onExplode', 'onTurnEnd'];

  /** id → 模块工厂函数 */
  const _modules = new Map();

  /** 是否为函数 */
  function isFactory(x) {
    return typeof x === 'function';
  }

  /** 是否为可用作模块对象的普通对象 */
  function isModuleObject(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  /**
   * 把入参规范成「工厂函数」。
   * 非法入参返回 null（不抛异常）。
   */
  function normalize(id, moduleFactory) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      console.warn('[' + REGISTRY_NAME + '] register 失败：id 必须是非空字符串');
      return null;
    }
    if (isFactory(moduleFactory)) {
      return moduleFactory;
    }
    if (isModuleObject(moduleFactory)) {
      // 兼容写法：直接给对象 → 包装成始终返回同一实例的单例工厂
      return function singletonModuleFactory() { return moduleFactory; };
    }
    console.warn('[' + REGISTRY_NAME + '] register 失败：moduleFactory 必须是函数或对象，id=' + id);
    return null;
  }

  /**
   * 契约校验：调用一次工厂，检查返回对象是否实现全部接口方法。
   * 不满足则抛出带 id 与缺失方法名的明确错误。
   */
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
      throw new Error('[' + REGISTRY_NAME + '] 注册失败：id="' + id + '" 的道具模块缺少接口方法 → ' +
        missing.join(', ') + '（必须实现：' + REQUIRED_METHODS.join(' / ') + '）');
    }
  }

  /**
   * 登记一个道具模块工厂
   * @param {string} id 道具唯一 id，需与 data/items.json 中的 id 一致
   * @param {Function|Object} moduleFactory 返回模块对象的工厂函数
   * @returns {Function|null} 规范化后的工厂；非法入参返回 null
   */
  function register(id, moduleFactory) {
    const factory = normalize(id, moduleFactory);
    if (factory === null) { return null; }

    if (_modules.has(id)) {
      console.warn('[' + REGISTRY_NAME + '] 道具 id 重复登记，后者覆盖前者：' + id);
    }

    assertContract(factory, id);   // 契约不满足 → 抛明确错误
    _modules.set(id, factory);
    return factory;
  }

  /**
   * 取出该 id 的模块工厂
   * @param {string} id
   * @returns {Function|null} 未登记时返回 null 并告警
   */
  function get(id) {
    if (!_modules.has(id)) {
      console.warn('[' + REGISTRY_NAME + '] 未找到道具：' + id);
      return null;
    }
    return _modules.get(id);
  }

  /** 是否已登记 */
  function has(id) {
    return _modules.has(id);
  }

  /**
   * 直接创建一个模块实例（等价于 get(id)()）
   * @returns {Object|null} 未登记时返回 null
   */
  function create(id) {
    if (!_modules.has(id)) {
      console.warn('[' + REGISTRY_NAME + '] 无法创建，未登记的道具：' + id);
      return null;
    }
    const factory = _modules.get(id);
    return isFactory(factory) ? factory() : factory;
  }

  /** 已登记的 id 列表（等价于 ids()，第 2 步新增） */
  function list() {
    return Array.from(_modules.keys());
  }

  /** 已登记的 id 列表（第 1 步 API，保留兼容） */
  function ids() {
    return list();
  }

  /** 已登记数量 */
  function count() {
    return _modules.size;
  }

  /** id → 工厂 的快照 */
  function getAll() {
    const out = {};
    _modules.forEach(function (v, k) { out[k] = v; });
    return out;
  }

  /** 清空（对局重开或单元测试时使用） */
  function clear() {
    _modules.clear();
  }

  FK.ItemRegistry = {
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
