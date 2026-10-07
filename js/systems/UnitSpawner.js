/**
 * ============================================================
 * UnitSpawner.js —— 单位实例化系统
 * ============================================================
 * 职责：
 *   把 UnitConfig 列表 + MapConfig 变成场景里真实存在的单位实体。
 *   负责「配置 → 出生点匹配 → 模块创建」的全过程，BattleScene 只调用不关心细节。
 *
 * 出生点分配规则：
 *   1) 优先使用 map.json 中 unitId 与本单位 id 完全一致的出生点
 *   2) 否则占用该阵营下一个未被使用的出生点
 *   3) 都找不到 → 记录失败并跳过（不崩溃）
 *
 * 坐标换算：
 *   地图单位 → 世界像素 = 竞技场原点偏移 + 单位坐标 × 地图 pxPerUnit
 *   （竞技场原点来自 FK.Config.ARENA，缩放来自 MapConfig.pxPerUnit）
 *
 * 依赖：FK.Config、FK.ModuleFactory、FK.EventBus、FK.EVENTS、Phaser（场景）
 * 对外：FK.UnitSpawner
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  class UnitSpawner {

    /**
     * @param {Phaser.Scene} scene 战斗场景
     * @param {Array} unitConfigs UnitConfig 列表（来自 FK.Configs.units）
     * @param {FK.MapConfig} mapConfig 地图配置（提供 spawnPoints / pxPerUnit）
     * @param {Object} [opts] { teamOrder: ['blue','red'] } 决定创建顺序
     */
    constructor(scene, unitConfigs, mapConfig, opts) {
      opts = opts || {};
      this.scene = scene;
      this.unitConfigs = unitConfigs || [];
      this.mapConfig = mapConfig || null;
      this.teamOrder = opts.teamOrder || ['blue', 'red'];

      /** 创建成功的单位实例 */
      this.units = [];
      /** 创建失败的记录 { id, message } */
      this.failed = [];
      /** 使用过的出生点 key */
      this.usedSpawnKeys = {};
    }

    /**
     * 执行实例化
     * @returns {Array} 创建成功的单位实例列表（失败项见 this.failed）
     */
    spawn() {
      if (!this.scene) {
        this.failed.push({ id: '(spawner)', message: '缺少 scene' });
        return this.units;
      }
      if (!this.mapConfig) {
        this.failed.push({ id: '(spawner)', message: '缺少 MapConfig，无法确定出生点' });
        this.log('缺少 MapConfig，实例化中止');
        return this.units;
      }

      const pools = this.buildSpawnPools();
      const ordered = this.sortByTeamOrder(this.unitConfigs);

      ordered.forEach(function (config) {
        this.spawnOne(config, pools);
      }, this);

      this.log('单位实例化完成：成功 ' + this.units.length + ' 个，失败 ' + this.failed.length + ' 个');
      return this.units;
    }

    /**
     * 创建单个单位（独立 try/catch，单个失败不影响其他单位）
     * @param {FK.UnitConfig} config
     * @param {Object} pools 按阵营分组的出生点池
     */
    spawnOne(config, pools) {
      try {
        if (!config || !config.id) {
          throw new Error('UnitConfig 缺少 id');
        }

        const spawnPoint = this.pickSpawnPoint(config, pools);
        if (!spawnPoint) {
          throw new Error('没有可用的出生点（阵营 ' + config.team + '，地图 ' +
            (this.mapConfig.id || '?') + '）');
        }

        // 通过模块工厂取得单位模块，再调用其 create() 生成实体
        const module = FK.ModuleFactory.createUnit(config);
        const unit = module.create(this.scene, config, spawnPoint);

        if (!unit) {
          throw new Error('单位模块 create() 未返回单位实例');
        }

        this.units.push(unit);
        // 保留模块引用：BattleScene 通过模块接口驱动单位，不直接碰内部实现
        unit.module = module;
        this.emitSpawned(unit, spawnPoint);
        this.log('已创建 ' + unit.describe() + ' @ 出生点(' + spawnPoint.x + ', ' + spawnPoint.y + 'u)');

        return unit;
      } catch (e) {
        const message = (e && e.message) ? e.message : String(e);
        this.failed.push({ id: config ? config.id : '(未知)', message: message });
        console.error('[UnitSpawner] 创建单位失败：' + (config ? config.id : '(未知)') + ' → ' + message);
        return null;
      }
    }

    /**
     * 按阵营归类出生点，并预先换算世界坐标
     * @returns {Object} { blue: [spawnPoint...], red: [...] }
     */
    buildSpawnPools() {
      const pools = {};
      const ppx = this.mapConfig.pxPerUnit;
      const originX = FK.Config.ARENA.offsetX;
      const originY = FK.Config.ARENA.offsetY;

      (this.mapConfig.spawnPoints || []).forEach(function (sp, i) {
        if (!pools[sp.team]) { pools[sp.team] = []; }
        pools[sp.team].push({
          key: sp.team + ':' + i,
          team: sp.team,
          unitId: sp.unitId,
          x: sp.x,
          y: sp.y,
          // 地图单位 → 世界像素
          worldX: originX + sp.x * ppx,
          worldY: originY + sp.y * ppx
        });
      });

      return pools;
    }

    /**
     * 为该单位挑一个出生点
     * @param {FK.UnitConfig} config
     * @param {Object} pools
     * @returns {Object|null}
     */
    pickSpawnPoint(config, pools) {
      const pool = pools[config.team] || [];
      const self = this;

      const free = function (sp) { return !self.usedSpawnKeys[sp.key]; };

      // 1) 精确匹配 unitId（map.json 里显式指定了出生点）
      let picked = pool.filter(function (sp) { return sp.unitId === config.id && free(sp); })[0] || null;

      // 2) 退化为该阵营的下一个空闲出生点
      if (!picked) { picked = pool.filter(free)[0] || null; }

      if (picked) { this.usedSpawnKeys[picked.key] = true; }
      return picked;
    }

    /** 按 teamOrder 排序，保证蓝方先创建（视觉与日志顺序稳定） */
    sortByTeamOrder(configs) {
      const order = this.teamOrder;
      return configs.slice().sort(function (a, b) {
        const ia = order.indexOf(a.team);
        const ib = order.indexOf(b.team);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    }

    /** 广播 unit:spawned */
    emitSpawned(unit, spawnPoint) {
      if (!FK.EventBus || !FK.EVENTS || !FK.EVENTS.UNIT_SPAWNED) { return; }
      FK.EventBus.emit(FK.EVENTS.UNIT_SPAWNED, {
        id: unit.getId(),
        team: unit.getTeam(),
        x: Math.round(unit.x),
        y: Math.round(unit.y),
        spawnUnitX: spawnPoint.x,
        spawnUnitY: spawnPoint.y,
        hp: unit.getHp(),
        maxHp: unit.getMaxHp(),
        unit: unit
      });
    }

    /** 按 id 取已创建的单位 */
    getUnit(id) {
      return this.units.filter(function (u) { return u.getId() === id; })[0] || null;
    }

    /* ==================================================================
     * 第 8 步：阵亡单位出列 / 单位列表交接（「再来一局」要重建整份列表）
     * ================================================================== */

    /**
     * 把某个单位从「本系统管理的单位列表」里摘掉（第 8 步：阵亡单位不再参战）。
     * 说明：BattleScene、UnitSpawner、UnitSelector 通常共享同一个数组，
     * 因此本方法做成幂等——已在别处摘掉时返回 false，不会误删别的单位。
     * @param {FK.UnitBase} unit
     * @returns {boolean} 本次是否真的移除了
     */
    removeUnit(unit) {
      if (!unit) { return false; }
      const i = this.units.indexOf(unit);
      if (i < 0) { return false; }
      this.units.splice(i, 1);
      this.log('单位出列：' + ((typeof unit.getId === 'function') ? unit.getId() : '?') +
        '，剩余 ' + this.units.length + ' 个');
      return true;
    }

    /** 用一份新数组接管单位列表（重开对局时调用；保证三处共享同一引用） */
    setUnits(units) {
      this.units = Array.isArray(units) ? units : [];
      return this;
    }

    /**
     * 清空「已占用出生点」记录（重开对局时调用）。
     * 不销毁单位，只让 spawn() 能重新按 map.json 的出生点分配。
     */
    resetSpawnKeys() {
      this.usedSpawnKeys = {};
      return this;
    }

    /** 创建失败记录（重开对局时可清空） */
    clearFailed() {
      this.failed = [];
      return this;
    }

    /** 按阵营取已创建的单位 */
    getUnitsByTeam(team) {
      return this.units.filter(function (u) { return u.getTeam() === team; });
    }

    /** 销毁全部已创建单位（走模块的 destroy 接口） */
    destroyAll() {
      this.units.forEach(function (u) {
        if (!u) { return; }
        if (u.module && typeof u.module.destroy === 'function') { u.module.destroy(u); }
        else if (typeof u.destroy === 'function') { u.destroy(); }
      });
      this.units = [];
      this.usedSpawnKeys = {};
    }

    log(msg) {
      if (FK.Config && FK.Config.DEBUG && FK.Config.DEBUG.enabled) {
        console.log('[UnitSpawner] ' + msg);
      }
    }
  }

  FK.UnitSpawner = UnitSpawner;
})();
