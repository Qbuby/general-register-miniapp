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
    request.log.error(error);
    reply.code(500).send({ error: { code: 'internal_error', message: '服务器内部错误' } });
  });

  app.get('/api/health', async () => ({
    ok: true,
    time: new Date().toISOString(),
    wechat: wechatStatus(),
  }));

  app.register(authRoutes);
  app.register(publicRoutes);
  app.register(orgRoutes);
  app.register(previewRoutes);

  return app;
}
