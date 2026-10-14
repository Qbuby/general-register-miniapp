// 小程序入口
const session = require('./utils/session.js');

App({
  globalData: {
    baseUrl: '', // 由 /api/config 或本地配置决定，见 config.js
  },

  onLaunch() {
    session.warmUp();
  },
});
