/**
 * ============================================================
 * configUtils.js —— 配置字段读取与校验工具
 * ============================================================
 * 职责：
 *   为 UnitConfig / ItemConfig / MapConfig 提供统一的字段读取、
 *   默认值填充、类型检查与错误收集能力，避免三份配置类各写一套。
 *
 * 设计约定：
 *   · 读取函数**不抛异常**，只把错误推进传入的 errors 数组，
 *     这样 validate() 可以一次性列出全部问题，而不是遇到第一个就中断。
 *   · 由调用方（Config 类的 fromJSON）决定是否把 errors 升级为异常。
 *   · 纯 JS，不依赖 Phaser。
 *
 * 依赖：无
 * 对外：FK.ConfigUtils
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  /** 人类可读的值描述，用于错误信息 */
  function describe(v) {
    if (v === undefined) { return 'undefined'; }
    if (v === null) { return 'null'; }
    if (typeof v === 'string') { return 'string("' + v + '")'; }
    if (typeof v === 'number') { return 'number(' + v + ')'; }
    if (typeof v === 'boolean') { return 'boolean(' + v + ')'; }
    if (Array.isArray(v)) { return 'array(len=' + v.length + ')'; }
    if (typeof v === 'object') { return 'object'; }
    return typeof v;
  }

  /** 是否为普通对象（排除数组与 null） */
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  /**
   * 读取字符串字段
   * @param {Object} raw 原始 JSON 对象
   * @param {string} key 字段名
   * @param {string|null} def 默认值
   * @param {Object} opts { errors, required, label }
   */
  function readString(raw, key, def, opts) {
    opts = opts || {};
    const errors = opts.errors || [];
    const label = opts.label || key;
    const v = raw[key];

    if (v === undefined || v === null) {
      if (opts.required) { errors.push('缺少必填字段 "' + label + '"'); }
      return def;
    }
    if (typeof v !== 'string') {
      errors.push('字段 "' + label + '" 类型错误：期望 string，实际 ' + describe(v));
      return def;
    }
    if (opts.required && v.trim().length === 0) {
      errors.push('字段 "' + label + '" 不能为空字符串');
      return def;
    }
    return v;
  }

  /**
   * 读取数字字段（含范围校验）
   * @param {Object} opts { errors, required, label, min, max, exclusiveMin }
   */
  function readNumber(raw, key, def, opts) {
    opts = opts || {};
    const errors = opts.errors || [];
    const label = opts.label || key;
    const v = raw[key];

    if (v === undefined || v === null) {
      if (opts.required) { errors.push('缺少必填字段 "' + label + '"'); }
      return def;
    }
    if (!isNumber(v)) {
      errors.push('字段 "' + label + '" 类型错误：期望 number，实际 ' + describe(v));
      return def;
    }
    if (opts.min !== undefined && v < opts.min) {
      errors.push('字段 "' + label + '" 取值非法：' + v + ' 应 ≥ ' + opts.min);
      return def;
    }
    if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) {
      errors.push('字段 "' + label + '" 取值非法：' + v + ' 应 > ' + opts.exclusiveMin);
      return def;
    }
    if (opts.max !== undefined && v > opts.max) {
      errors.push('字段 "' + label + '" 取值非法：' + v + ' 应 ≤ ' + opts.max);
      return def;
    }
    return v;
  }

  /**
   * 读取枚举字段
   * @param {Object} opts { errors, required, label, allowed:[] }
   */
  function readEnum(raw, key, allowed, def, opts) {
    opts = opts || {};
    const errors = opts.errors || [];
    const label = opts.label || key;
    const v = raw[key];

    if (v === undefined || v === null) {
      if (opts.required) { errors.push('缺少必填字段 "' + label + '"'); }
      return def;
    }
    if (typeof v !== 'string' || allowed.indexOf(v) < 0) {
      errors.push('字段 "' + label + '" 取值非法：期望 ' + allowed.map(function (a) {
        return "'" + a + "'";
      }).join(' | ') + '，实际 ' + describe(v));
      return def;
    }
    return v;
  }

  /**
   * 读取数组字段
   * @param {Object} opts { errors, required, label, validateItem(item, index, errors, warnings) }
   */
  function readArray(raw, key, def, opts) {
    opts = opts || {};
    const errors = opts.errors || [];
    const warnings = opts.warnings || [];
    const label = opts.label || key;
    const v = raw[key];

    if (v === undefined || v === null) {
      if (opts.required) { errors.push('缺少必填字段 "' + label + '"'); }
      return def;
    }
    if (!Array.isArray(v)) {
      errors.push('字段 "' + label + '" 类型错误：期望 array，实际 ' + describe(v));
      return def;
    }
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const item = v[i];
      if (opts.validateItem) {
        const parsed = opts.validateItem(item, i, errors, warnings);
        if (parsed !== null && parsed !== undefined) { out.push(parsed); }
      } else {
        out.push(item);
      }
    }
    return out;
  }

  /** 递归冻结对象与数组，保证配置在运行期只读 */
  function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) { return obj; }
    Object.getOwnPropertyNames(obj).forEach(function (k) {
      const v = obj[k];
      if (v && typeof v === 'object') { deepFreeze(v); }
    });
    return Object.freeze(obj);
  }

  /** 把 errors 数组拼成一条可读的异常信息 */
  function buildErrorMessage(className, id, errors) {
    return '[' + className + '] 配置非法' + (id ? '（id="' + id + '"）' : '') +
      '：\n  - ' + errors.join('\n  - ');
  }

  FK.ConfigUtils = {
    describe: describe,
    isPlainObject: isPlainObject,
    isNumber: isNumber,
    isNonEmptyString: isNonEmptyString,
    readString: readString,
    readNumber: readNumber,
    readEnum: readEnum,
    readArray: readArray,
    deepFreeze: deepFreeze,
    buildErrorMessage: buildErrorMessage
  };
})();
