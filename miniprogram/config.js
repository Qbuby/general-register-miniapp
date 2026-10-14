/**
 * 本地配置。
 *
 * 重要：这里只放“公开可分发”的东西（接口域名、小程序页面路径）。
 * AppSecret、数据库口令等机密一律只存在服务端，前端不得出现。
 *
 * 上线前需要做的三件事：
 *  1. 把 baseUrl 改成已备案、已在小程序后台配置为 request 合法域名的 https 域名；
 *  2. 在微信公众平台配置业务域名 / 服务器域名白名单；
 *  3. 把 pages 配置与后台 wxacode 的 page 字段保持一致。
 */
module.exports = {
  // 开发阶段请在微信开发者工具中勾选「不校验合法域名」，或直接用本机局域网地址。
  baseUrl: 'http://127.0.0.1:3000',

  // 与服务端 config.ts 中的 WX_ORG_PAGE / WX_PROJECT_PAGE 保持一致。
  // 二维码扫码后微信会带着 scene 参数打开这两个页面。
  pages: {
    orgHome: 'pages/org-home/index',
    projectDetail: 'pages/project-detail/index',
    // 邀请链接落地页：由 owner 生成邀请码后分享给被邀请人
    inviteAccept: 'pages/invite-accept/index',
  },
};
