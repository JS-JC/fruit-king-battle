/**
 * ============================================================
 * EventBus.js —— 全局事件总线（系统解耦基础）
 * ============================================================
 * 职责：
 *   为 TurnManager / DamageSystem / AIController / HUD 等模块提供
 *   唯一的通信通道，使各系统之间**不产生硬引用**，可单独替换与测试。
 *
 * 约束：
 *   · 系统之间禁止互相 require / 直接调用
 *   · 需要通知别人时 emit，需要被通知时 on
 *   · 事件名统一取自 js/config/events.js 的 FK.EVENTS，禁止裸写字符串
 *
 * 实现说明（第 2 步增强）：
 *   优先使用 Phaser.Events.EventEmitter；当 Phaser 不存在时（Node 单元测试、
 *   纯数据层脚本）自动回退到内置的轻量 EventEmitter 实现。
 *   这样「数据结构 / 注册表 / 模块工厂」这三层可以在完全没有 Phaser 的
 *   环境中被加载和测试。
 *
 * 依赖：无（Phaser 可选）
 * 对外：FK.EventBus
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 事件发射器实例（首次访问时才创建，防止加载顺序问题） */
  let _emitter = null;

  /** 事件名 → 监听器数组 */
  let _map = null;

  /**
   * 内置轻量 EventEmitter（与 Phaser 同名 API 的最小交集实现）
   * 不使用 class，避免与 Phaser 的类产生命名混淆。
   */
  function createFallbackEmitter() {
    _map = {};

    function bucket(event) {
      if (!_map[event]) { _map[event] = []; }
      return _map[event];
    }

    return {
      on: function (event, fn, context) {
        if (typeof fn !== 'function') { return this; }
        bucket(event).push({ fn: fn, ctx: context, once: false });
        return this;
      },
      once: function (event, fn, context) {
        if (typeof fn !== 'function') { return this; }
        bucket(event).push({ fn: fn, ctx: context, once: true });
        return this;
      },
      off: function (event, fn, context) {
        if (!_map[event]) { return this; }
        _map[event] = _map[event].filter(function (h) {
          // 不传 fn 表示清空该事件；传了则按 fn（必要时连同 context）匹配
          if (fn === undefined) { return false; }
          if (h.fn !== fn) { return true; }
          if (context !== undefined && h.ctx !== context) { return true; }
          return false;
        });
        return this;
      },
      emit: function (event) {
        const args = Array.prototype.slice.call(arguments, 1);
        const list = (_map[event] || []).slice();
        for (let i = 0; i < list.length; i++) {
          const h = list[i];
          if (h.once) { this.off(event, h.fn, h.ctx); }
          h.fn.apply(h.ctx, args);
        }
        return this;
      },
      listenerCount: function (event) {
        return (_map[event] || []).length;
      },
      removeAllListeners: function () {
        _map = {};
        return this;
      }
    };
  }

  /** 懒创建发射器：有 Phaser 用 Phaser 的，没有就用内置的 */
  function emitter() {
    if (_emitter === null) {
      const hasPhaser = (typeof Phaser !== 'undefined') && Phaser &&
        Phaser.Events && typeof Phaser.Events.EventEmitter === 'function';
      _emitter = hasPhaser ? new Phaser.Events.EventEmitter() : createFallbackEmitter();
    }
    return _emitter;
  }

  FK.EventBus = {
    /**
     * 订阅事件
     * @param {string} event 事件名（建议用 FK.EVENTS.xxx）
     * @param {Function} fn 回调
     * @param {Object} [context] 回调上下文
     */
    on: function (event, fn, context) {
      emitter().on(event, fn, context);
      return this;
    },

    /** 订阅一次 */
    once: function (event, fn, context) {
      emitter().once(event, fn, context);
      return this;
    },

    /** 取消订阅。不传 fn 时移除该事件的全部监听 */
    off: function (event, fn, context) {
      emitter().off(event, fn, context);
      return this;
    },

    /**
     * 派发事件
     * @param {string} event 事件名
     * @param {...*} args 参数
     */
    emit: function (event) {
      const args = Array.prototype.slice.call(arguments, 1);
      emitter().emit.apply(emitter(), [event].concat(args));
      return this;
    },

    /** 某事件的监听数量（调试用） */
    listenerCount: function (event) {
      return emitter().listenerCount(event);
    },

    /** 清空全部监听（场景切换 / 对局重开时调用，防止监听泄漏） */
    clear: function () {
      emitter().removeAllListeners();
      return this;
    },

    /** 当前使用的是 Phaser 发射器还是内置回退实现（自检用） */
    backend: function () {
      const hasPhaser = (typeof Phaser !== 'undefined') && Phaser &&
        Phaser.Events && typeof Phaser.Events.EventEmitter === 'function';
      return hasPhaser ? 'phaser' : 'builtin';
    }
  };
})();
