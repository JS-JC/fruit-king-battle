/**
 * ============================================================
 * units.data.js —— data/units.json 的运行时镜像
 * ============================================================
 * 【本文件由 tools/sync-data.js 自动生成，请勿手工编辑】
 *
 * 用途：单位数值配置。
 *   浏览器在 file:// 协议（双击 index.html）下会以 CORS 拦截
 *   fetch / XMLHttpRequest，导致 Phaser 的 this.load.json() 必然失败；
 *   而 <script src> 在 file:// 下不受限制，因此把同一份 JSON
 *   包成 JS 对象，通过 <script> 加载即可。
 *
 * 修改流程：
 *   1) 编辑 data/units.json（唯一策划源）
 *   2) 执行 node tools/sync-data.js  重新生成本文件
 *   3) 双击 tools/check-data.html 确认逐字段一致
 * ============================================================
 */
window.FK_DATA = window.FK_DATA || {};
window.FK_DATA.units = {
  "version": "0.2.0",
  "schema": "units",
  "description": "单位数值配置。第 2 步填充 MVP 示例数据（4 个单位），第 4 步开始实例化为游戏对象。team：blue = 己方水果军团，red = 敌方酸果军团。",
  "fields": {
    "id": "string 必填。唯一标识，必须与 js/registry/registerAll.js 中注册的 id 一致",
    "name": "string 必填。显示名（中文）",
    "team": "string 必填。阵营：'blue'（己方水果军团）或 'red'（敌方酸果军团）",
    "hp": "number 必填。血量，第 0 步冻结默认值 100",
    "sprite": "string 必填。纹理 key，遵循 assets/sprites/units 命名规范，例如 unit_blue_king_idle_48",
    "throwPower": "number 必填。投掷力度系数，1.0 为基准值",
    "moveRange": "number 必填。移动力（地图单位），第 0 步冻结 MVP 为 0"
  },
  "units": [
    {
      "id": "fruit_king",
      "name": "水果王",
      "team": "blue",
      "hp": 100,
      "sprite": "unit_blue_king_idle_48",
      "throwPower": 1,
      "moveRange": 0
    },
    {
      "id": "apple_guard",
      "name": "苹果卫士",
      "team": "blue",
      "hp": 100,
      "sprite": "unit_blue_guard_idle_48",
      "throwPower": 1,
      "moveRange": 0
    },
    {
      "id": "lemon_general",
      "name": "酸柠将军",
      "team": "red",
      "hp": 100,
      "sprite": "unit_red_general_idle_48",
      "throwPower": 1,
      "moveRange": 0
    },
    {
      "id": "grape_soldier",
      "name": "葡萄小兵",
      "team": "red",
      "hp": 100,
      "sprite": "unit_red_grape_idle_48",
      "throwPower": 1,
      "moveRange": 0
    }
  ]
};
