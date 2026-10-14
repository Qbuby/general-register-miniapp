import Fastify from 'fastify';
import { AppError } from './lib/errors.js';
import { attachUser } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/org.js';
import { publicRoutes } from './routes/public.js';
import { previewRoutes } from './routes/preview.js';
import { getDb } from './db/index.js';
import { wechatStatus } from './services/wechat.js';

export interface BuildOptions {
  logger?: boolean;
}

export function buildApp(options: BuildOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
  });

  // Opening the database also applies any pending migrations.
  getDb();

  app.addHook('onRequest', attachUser);

  /**
   * 允许空 JSON body。
   *
   * Fastify 默认会对「声明了 content-type: application/json 但没有 body」的
   * 请求直接报错，但本服务里有些接口（接受邀请、标记报名状态）本来就不需要
   * 请求体。不做这个处理，不同客户端的调用方式差异就会变成莫名其妙的 400。
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'not_found', message: '接口不存在' } });
      return;
    }
    reply.code(404).send({ error: { code: 'not_found', message: '页面不存在' } });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
      return;
    }
    if ((error as { validation?: unknown }).validation) {
      reply.code(400).send({ error: { code: 'invalid_input', message: '请求参数不合法' } });
      return;
    }
    // Fastify 自身的解析错误（body 不是合法 JSON、payload 超限等）会带 4xx 的
    // statusCode。不处理的话它们会掉进下面的 500 分支——用户发了个格式错误的
    // 请求却看到「服务器内部错误」，既误导也掩盖了真实原因。
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      reply.code(status).send({
        error: { code: 'invalid_input', message: '请求内容不合法' },
      });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: { code: 'internal_error', message: '服务器内部错误' } });
  });

  app.get('/api/health', async () => ({
    ok: true,
    time: new Date().toISOString(),
    wechat: wechatStatus(),
  }));

  /**
   * Service index. Without this the root path is a dead end returning raw JSON,
   * which is a poor first impression for whoever just deployed the service.
   * It deliberately exposes nothing but the service's own public capabilities.
   */
  app.get('/', async (_request, reply) => {
    const wechat = wechatStatus();
    reply.type('text/html; charset=utf-8');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>通用机构招生报名服务</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1c1f23}
  .wrap{max-width:680px;margin:0 auto;padding:40px 24px 64px}
  h1{font-size:24px;margin:0 0 8px}
  .sub{color:#6b7280;margin:0 0 28px}
  .card{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:16px}
  .card h2{font-size:16px;margin:0 0 12px}
  .kv{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f1f3;font-size:14px}
  .kv:last-child{border-bottom:none}
  .ok{color:#1e8e4e}.warn{color:#ad6800}
  code{background:#f2f3f5;padding:2px 7px;border-radius:4px;font-size:13px}
  a{color:#2b62d9}
  ul{margin:8px 0 0;padding-left:20px}
  li{margin:4px 0}
  .note{background:#fff7e6;color:#8a6100;border-radius:10px;padding:14px 18px;font-size:14px}
</style>
</head>
<body><div class="wrap">
  <h1>通用机构招生报名服务</h1>
  <p class="sub">一个统一的小程序服务多家机构：机构主页、项目发布、动态报名表、二维码推广、报名管理。</p>

  <div class="card">
    <h2>服务状态</h2>
    <div class="kv"><span>状态</span><span class="ok">运行中</span></div>
    <div class="kv"><span>运行模式</span><span>${process.env.NODE_ENV ?? 'development'}</span></div>
    <div class="kv"><span>微信小程序码</span><span class="${wechat.configured ? 'ok' : 'warn'}">${
      wechat.configured
        ? '已配置，生成正式小程序码'
        : '未配置 WX_APPID / WX_APPSECRET，二维码接口在生产模式下返回 503'
    }</span></div>
    <div class="kv"><span>健康检查</span><span><a href="/api/health">/api/health</a></span></div>
  </div>

  <div class="card">
    <h2>怎么访问</h2>
    <p style="margin:0">公众页面<b>必须带着机构的分享码访问</b>，这是有意的设计：</p>
    <ul>
      <li>扫描<b>机构二维码</b> → 打开该机构主页</li>
      <li>扫描<b>项目二维码</b> → 直接打开该项目详情页并报名</li>
      <ul>
        <li>机构主页：<code>/preview/o/&lt;分享码&gt;</code>（仅开发模式）</li>
        <li>项目详情：<code>/preview/p/&lt;分享码&gt;</code>（仅开发模式）</li>
      </ul>
      <li>正式环境中上述入口由小程序页面承载：<code>pages/org-home/index</code>、<code>pages/project-detail/index</code></li>
    </ul>
  </div>

  <div class="card">
    <h2>机构工作台</h2>
    <p style="margin:0">管理端在微信小程序内，<b>没有独立的网页后台</b>（这是产品范围决定的，不是遗漏）。</p>
    <p style="margin:8px 0 0">用微信开发者工具打开 <code>miniprogram/</code> 目录，登录后即可创建机构、发布项目、配置报名表、查看二维码与报名记录。</p>
  </div>

  <div class="card">
    <h2>常用接口</h2>
    <ul>
      <li><code>GET /api/health</code> — 健康检查</li>
      <li><code>GET /api/config</code> — 客户端配置</li>
      <li><code>GET /api/public/organizations/:code</code> — 机构主页数据</li>
      <li><code>GET /api/public/projects/:code</code> — 项目详情与报名表</li>
      <li><code>POST /api/public/projects/:code/registrations</code> — 提交报名</li>
      <li><code>/api/orgs/*</code> — 机构工作台（需登录，跨机构访问一律 404）</li>
    </ul>
  </div>

  <p class="sub" style="margin-top:28px">完整文档见仓库 <code>README.md</code> 与 <code>docs/</code>。</p>
</div></body>
</html>`;
  });

  app.register(authRoutes);
  app.register(publicRoutes);
  app.register(orgRoutes);
  app.register(previewRoutes);

  return app;
}
