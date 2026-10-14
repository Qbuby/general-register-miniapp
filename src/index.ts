import { buildApp } from './app.js';
import { config, wechatConfigured } from './config.js';

const app = buildApp({ logger: true });

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(`服务已启动 http://${config.host}:${config.port}`);
    if (!wechatConfigured) {
      app.log.warn(
        '未配置 WX_APPID / WX_APPSECRET：小程序码将使用开发预览码，微信登录不可用。' +
          '生产部署前必须在服务端设置这两个环境变量（切勿写入小程序前端代码）。',
      );
    }
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
