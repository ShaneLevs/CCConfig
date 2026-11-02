// 开发/测试时指向共享实现；`npm run build:app` 的 prepare-sidecar 会用
// public/preload/services/local-db.js 覆盖本文件，打包后的 sidecar 里只有真实实现。
module.exports = require("../../public/preload/services/local-db");
