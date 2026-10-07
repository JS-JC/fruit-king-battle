/**
 * ============================================================
 * turn.data.js —— data/turn.json 的运行时镜像
 * ============================================================
 * 【本文件由 tools/sync-data.js 自动生成，请勿手工编辑】
 *
 * 用途：回合状态机配置（第 3 步新增）。
 *   浏览器在 file:// 协议（双击 index.html）下会以 CORS 拦截
 *   fetch / XMLHttpRequest，导致 Phaser 的 this.load.json() 必然失败；
 *   而 <script src> 在 file:// 下不受限制，因此把同一份 JSON
 *   包成 JS 对象，通过 <script> 加载即可。
 *
 * 修改流程：
 *   1) 编辑 data/turn.json（唯一策划源）
 *   2) 执行 node tools/sync-data.js  重新生成本文件
 *   3) 双击 tools/check-data.html 确认逐字段一致
 * ============================================================
 */
window.FK_DATA = window.FK_DATA || {};
window.FK_DATA.turn = {
  "version": "0.3.0",
  "schema": "turn",
  "description": "回合状态机配置。第 3 步新增。所有时间单位均为毫秒。改动本文件后执行 node tools/sync-data.js 同步镜像。",
  "fields": {
    "turnTime": "number 必填。每个行动回合的倒计时总时长（毫秒），默认 30000 = 30 秒",
    "teamOrder": "array 必填。阵营轮转顺序，元素取值 'blue'（己方）| 'red'（敌方）。新增阵营只需在此加一项",
    "initialTeam": "string 必填。开局先手的阵营，必须是 teamOrder 中的元素，默认 'blue'",
    "timeoutProtection": "number 必填。状态超时保护阈值（毫秒）。任何状态停留超过该值都会被强制推进到安全状态，默认 5000",
    "maxTurns": "number 可选。行动回合上限，达到后按双方总血量判胜，默认 40",
    "stateDurations": "object 必填。可由 tick 自动推进的状态其停留时长（毫秒）：TURN_START / TURN_END / SWITCH_TEAM。未列出的状态需外部事件或超时保护驱动"
  },
  "turn": {
    "turnTime": 30000,
    "teamOrder": [
      "blue",
      "red"
    ],
    "initialTeam": "blue",
    "timeoutProtection": 5000,
    "maxTurns": 40,
    "stateDurations": {
      "TURN_START": 400,
      "TURN_END": 300,
      "SWITCH_TEAM": 300
    }
  }
};
