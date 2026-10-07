lib/ 目录说明
========================================
phaser.min.js  —— Phaser 3.80.1 本地副本（已内置，约 1.15 MB）

来源：https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js
备用：https://unpkg.com/phaser@3.80.1/dist/phaser.min.js

作用：
  index.html 优先从 CDN 加载 Phaser；若 CDN 不可用（断网 / 被墙 / 企业策略），
  会自动 document.write 加载本目录下的 phaser.min.js 作为兜底。
  因此无论有没有网络，双击 index.html 都能正常启动。

如果想改成「完全离线、永不访问 CDN」：
  删掉 index.html 中那一行 CDN <script>，只保留本地兜底脚本即可。
