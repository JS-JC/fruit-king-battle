/**
 * ============================================================
 * ConfigLoader.js —— 配置加载与校验
 * ============================================================
 * 职责：
 *   把 data/ 下的 JSON 配置装载成统一的运行时数据对象 FK.Data，
 *   并解决「双击 index.html（file:// 协议）无法用 XHR 读 JSON」的问题。
 *
 * 双通道加载策略：
 *   ┌ http(s) 协议（本地服务器 / 在线部署）
 *   │   → 用 Phaser Loader 真实读取 data/*.json（策划源，唯一真相）
 *   └ file:// 协议（双击 index.html）
 *       → 浏览器会以 CORS 拦截 fetch/XHR，load.json 必然失败
 *       → 改读 data/*.data.js 镜像（<script> 加载，100% 可用）
 *
 *   两条通道产出完全相同的对象结构，业务代码无感知。
 *   镜像与 JSON 的一致性由 tools/check-data.html / tools/sync-data.js 保证。
 *
 * 第 2 步新增：
 *   · raw JSON → 类型化配置对象（UnitConfig / ItemConfig / MapConfig），落到 FK.Configs
 *   · 关键节点通过 EventBus 广播：config:loaded / config:error
 *
 * 第 3 步新增：
 *   · 加载并归一化 data/turn.json（turnTime / teamOrder / initialTeam / timeoutProtection）
 *
 * 依赖：FK.Config、FK.UnitConfig/ItemConfig/MapConfig、FK.EventBus、FK.EVENTS
 * 对外：
 *   FK.ConfigLoader.isFileProtocol()      是否为 file:// 协议
 *   FK.ConfigLoader.queueLoads(scene)     在 preload() 中登记待加载的 JSON
 *   FK.ConfigLoader.resolve(scene)        在 create() 中解析出 FK.Data 与 FK.Configs
 *   FK.ConfigLoader.summary()             返回配置摘要字符串
 *   FK.ConfigLoader.sources()             返回每个配置的来源（json / mirror）
 *   FK.ConfigLoader.configs()             返回类型化配置（FK.Configs 的安全访问器）
 * ============================================================
 */
window.FK = window.FK || {};
window.FK_DATA = window.FK_DATA || {};   // 镜像数据的全局容器（由 data/*.data.js 填充）

/** 类型化配置容器：raw JSON 经 Config 类解析后的结果 */
window.FK.Configs = window.FK.Configs || { units: [], items: [], map: null, turn: null };

(function () {
  'use strict';

  const Config = FK.Config;

  /** 每个配置项最终采用的来源：'json' | 'mirror' | 'missing' */
  let _sources = {};

  /** 是否处于 file:// 协议（双击打开） */
  function isFileProtocol() {
    return (typeof location !== 'undefined' && location.protocol === 'file:');
  }

  /**
   * 在 BootScene.preload() 中调用。
   * http(s) 下登记真实 JSON 加载；file:// 下不做任何网络请求，直接返回。
   * @param {Phaser.Scene} scene
   */
  function queueLoads(scene) {
    if (isFileProtocol()) {
      // file:// 下刻意不发起任何请求，避免控制台出现 CORS 红字报错
      return;
    }
    Config.DATA.files.forEach(function (f) {
      scene.load.json(f.key, f.json);
    });
  }

  /**
   * 从 data/*.data.js 镜像里取数据。
   * @param {Object} file 配置项描述
   * @returns {*|null}
   */
  function readMirror(file) {
    const bag = window.FK_DATA || {};
    const v = bag[file.globalKey];
    return (v === undefined) ? null : v;
  }

  /**
   * 在 BootScene.create() 中调用（此时 preload 已完成）。
   * 逐项决定数据来源，产出统一的 FK.Data。
   * @param {Phaser.Scene} scene
   * @returns {Object} FK.Data
   */
  function resolve(scene) {
    const raw = {};
    _sources = {};

    Config.DATA.files.forEach(function (f) {
      let value = null;
      let from = 'missing';

      // 通道 1：真实 JSON（仅 http(s) 下尝试过加载）
      if (!isFileProtocol() && scene && scene.cache && scene.cache.json) {
        const cached = scene.cache.json.get(f.key);
        if (cached !== undefined && cached !== null) {
          value = cached;
          from = 'json';
        }
      }

      // 通道 2：镜像兜底
      if (value === null) {
        const mirrored = readMirror(f);
        if (mirrored !== null) {
          value = mirrored;
          from = 'mirror';
        }
      }

      _sources[f.key] = from;
      raw[f.key] = value;
    });

    // 归一化成业务代码可直接使用的结构
    const data = {
      units: normalizeList(raw.units, 'units'),
      items: normalizeList(raw.items, 'items'),
      map: normalizeMap(raw.map),
      turn: normalizeTurn(raw.turn),
      meta: {
        sources: Object.assign({}, _sources),
        protocol: isFileProtocol() ? 'file' : (typeof location !== 'undefined' ? location.protocol : 'unknown'),
        loadedAt: Date.now()
      }
    };

    FK.Data = data;

    // ---------- 第 2 步新增：raw JSON → 类型化 Config 类 ----------
    const configErrors = [];
    buildTypedConfigs(configErrors);
    data.meta.configErrors = configErrors;

    if (configErrors.length > 0) {
      configErrors.forEach(function (m) { warn(m); });
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.emit(FK.EVENTS.CONFIG_ERROR, { scope: 'typed', messages: configErrors });
      }
    }

    // ---------- 第 2 步新增：关键节点事件广播 ----------
    if (FK.EventBus && FK.EVENTS) {
      FK.EventBus.emit(FK.EVENTS.CONFIG_LOADED, {
        unitCount: data.units.length,
        itemCount: data.items.length,
        mapId: (data.map && data.map.id) ? data.map.id : '',
        turnTime: data.turn.turnTime,
        configs: FK.Configs
      });
    }

    return data;
  }

  /**
   * 归一化回合配置（第 3 步新增）。
   * 缺字段用默认值，类型错误回退默认值并记录错误；返回值深冻结。
   * @param {Object} rawValue data/turn.json 的 turn 对象
   * @returns {Object} { turnTime, teamOrder, initialTeam, timeoutProtection, stateDurations }
   */
  function normalizeTurn(rawValue) {
    const src = (rawValue && typeof rawValue === 'object' && rawValue.turn && typeof rawValue.turn === 'object')
      ? rawValue.turn
      : (rawValue && typeof rawValue === 'object' ? rawValue : {});

    const errors = [];
    const out = {
      turnTime: 30000,
      teamOrder: ['blue', 'red'],
      initialTeam: 'blue',
      timeoutProtection: 5000,
      maxTurns: (FK.Config && FK.Config.TURN && FK.Config.TURN.maxTurns) || 40,
      stateDurations: { TURN_START: 400, TURN_END: 300, SWITCH_TEAM: 300 }
    };

    if (typeof src.turnTime === 'number' && isFinite(src.turnTime) && src.turnTime >= 100) {
      out.turnTime = src.turnTime;
    } else if (src.turnTime !== undefined) {
      errors.push('turn.turnTime 非法（应为 ≥100 的数字），已回退默认值 ' + out.turnTime);
    }

    if (Array.isArray(src.teamOrder) && src.teamOrder.length > 0 &&
        src.teamOrder.every(function (t) { return typeof t === 'string' && t.length > 0; })) {
      out.teamOrder = src.teamOrder.slice();
    } else if (src.teamOrder !== undefined) {
      errors.push('turn.teamOrder 非法（应为非空字符串数组），已回退默认值 ' + JSON.stringify(out.teamOrder));
    }

    if (typeof src.maxTurns === 'number' && isFinite(src.maxTurns) && src.maxTurns >= 1) {
      out.maxTurns = Math.floor(src.maxTurns);
    } else if (src.maxTurns !== undefined) {
      errors.push('turn.maxTurns 非法（应为 ≥1 的数字），已回退默认值 ' + out.maxTurns);
    }

    if (typeof src.timeoutProtection === 'number' && isFinite(src.timeoutProtection) && src.timeoutProtection >= 0) {
      out.timeoutProtection = src.timeoutProtection;
    } else if (src.timeoutProtection !== undefined) {
      errors.push('turn.timeoutProtection 非法（应为 ≥0 的数字），已回退默认值 ' + out.timeoutProtection);
    }

    out.initialTeam = (out.teamOrder.indexOf(src.initialTeam) >= 0) ? src.initialTeam : out.teamOrder[0];
    if (src.initialTeam !== undefined && out.teamOrder.indexOf(src.initialTeam) < 0) {
      errors.push('turn.initialTeam "' + src.initialTeam + '" 不在 teamOrder 中，已回退为 ' + out.initialTeam);
    }

    if (src.stateDurations && typeof src.stateDurations === 'object') {
      Object.keys(src.stateDurations).forEach(function (k) {
        const v = src.stateDurations[k];
        if (typeof v === 'number' && isFinite(v) && v >= 0) { out.stateDurations[k] = v; }
      });
    }

    if (!FK.TurnStates) {
      errors.push('回合状态定义未加载：请确认 js/config/turnStates.js 已在 index.html 中引入');
    }

    if (errors.length > 0) {
      errors.forEach(function (m) { warn(m); });
    }

    return Object.freeze(out);
  }

  /**
   * 把 raw JSON 转成类型安全的配置对象，落到 FK.Configs。
   * 单条配置失败只记录、不中断，保证其余配置仍可用。
   * @param {string[]} errors 错误收集数组
   * @returns {{units:Array, items:Array, map:Object|null, turn:Object}}
   */
  function buildTypedConfigs(errors) {
    const units = [];
    const items = [];
    let map = null;

    if (!FK.UnitConfig || !FK.ItemConfig || !FK.MapConfig) {
      errors.push('配置数据结构未加载：请确认 js/data/UnitConfig.js、ItemConfig.js、MapConfig.js 已在 index.html 中引入');
      FK.Configs = { units: units, items: items, map: map, turn: FK.Data.turn };
      return FK.Configs;
    }

    (FK.Data.units || []).forEach(function (raw, i) {
      try { units.push(FK.UnitConfig.fromJSON(raw)); }
      catch (e) { errors.push('units[' + i + '] ' + e.message); }
    });

    (FK.Data.items || []).forEach(function (raw, i) {
      try { items.push(FK.ItemConfig.fromJSON(raw)); }
      catch (e) { errors.push('items[' + i + '] ' + e.message); }
    });

    if (FK.Data.map && Object.keys(FK.Data.map).length > 0) {
      try { map = FK.MapConfig.fromJSON(FK.Data.map); }
      catch (e) { errors.push('map ' + e.message); }
    } else {
      errors.push('data/map.json 中没有地图配置，第 8 步将无地图可用');
    }

    FK.Configs = { units: units, items: items, map: map, turn: FK.Data.turn };
    return FK.Configs;
  }

  /** 把 { xxx: [...] } 或 [...] 统一成数组，解析失败返回空数组并告警 */
  function normalizeList(rawValue, listKey) {
    if (!rawValue) { return []; }
    if (Array.isArray(rawValue)) { return rawValue; }
    if (Array.isArray(rawValue[listKey])) { return rawValue[listKey]; }
    warn('data/' + listKey + ' 结构异常，已回退为空数组');
    return [];
  }

  /** 把 map 配置统一成对象，解析失败返回空对象 */
  function normalizeMap(rawValue) {
    if (!rawValue || typeof rawValue !== 'object') { return {}; }
    if (rawValue.map && typeof rawValue.map === 'object') { return rawValue.map; }
    return rawValue;
  }

  /** 统一告警出口（避免直接依赖 Logger，第 2 步会接入完整日志） */
  function warn(msg) {
    if (typeof console !== 'undefined') {
      console.warn('[ConfigLoader] ' + msg);
    }
  }

  /** 配置摘要，供启动时打印与验收核对 */
  function summary() {
    const d = FK.Data || { units: [], items: [], map: {}, turn: {} };
    const t = d.turn || {};
    return '[Data] units=' + d.units.length +
      ' items=' + d.items.length +
      ' map=' + (d.map && d.map.id ? d.map.id : '(未配置)') +
      ' turn=' + (t.turnTime || '?') + 'ms/' + ((t.teamOrder || []).join('→') || '?') +
      ' protocol=' + (d.meta ? d.meta.protocol : '?') +
      ' source=' + (d.meta ? JSON.stringify(d.meta.sources) : '{}');
  }

  /** 各配置来源 */
  function sources() {
    return Object.assign({}, _sources);
  }

  /** 类型化配置（第 2 步新增），未解析时返回空结构 */
  function configs() {
    return FK.Configs || { units: [], items: [], map: null };
  }

  FK.ConfigLoader = {
    isFileProtocol: isFileProtocol,
    queueLoads: queueLoads,
    resolve: resolve,
    summary: summary,
    sources: sources,
    configs: configs
  };
})();
