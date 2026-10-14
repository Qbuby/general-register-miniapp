import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 生产环境未配置微信凭据时，必须明确报「不可用」，而不是返回一个
 * 扫不开小程序、看起来却很成功的二维码。
 *
 * config.ts 在模块加载时读取环境变量，而 ESM 的 import 会被提升，
 * 所以这个文件不能静态导入任何会间接加载 config 的模块，
 * 只能在设置好环境变量之后再动态 import。
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-prod-test-'));
process.env.DATABASE_FILE = path.join(tmpDir, 'prod.db');
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'production';
process.env.TOKEN_SECRET = 'prod-test-secret-0123456789';
process.env.AUTH_DEV_MODE = 'true';
process.env.PREVIEW_TOKEN = 'dev-preview';
process.env.PUBLIC_BASE_URL = 'http://localhost:3000';

type FastifyInstance = import('fastify').FastifyInstance;

let app: FastifyInstance;
let token: string;
let orgId: string;

before(async () => {
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false });

  // 生产模式下 dev-login 被禁用，因此直接构造一个合法的会话 token。
  const crypto = await import('node:crypto');
  const db = await import('../src/db/index.js');
  const { signToken } = await import('../src/lib/token.js');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (id, openid, nickname, token_version, created_at, updated_at)
     VALUES ('usr_prod', 'openid_prod', '生产校验', 1, ?, ?)`,
    now,
    now,
  );
  db.run(
    `INSERT INTO organizations (id, name, slug, intro, status, created_at, updated_at)
     VALUES ('org_prod', '生产校验机构', 'prod-check', '', 'published', ?, ?)`,
    now,
    now,
  );
  db.run(
    `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
     VALUES ('mem_prod', 'org_prod', 'usr_prod', 'owner', ?)`,
    now,
  );
  assert.ok(crypto, 'crypto 可用');
  token = signToken('usr_prod', 1);
});

after(async () => {
  await app.close();
  const db = await import('../src/db/index.js');
  db.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

test('生产模式下开发登录被彻底关闭', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    payload: { nickname: '攻击者' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'dev_login_disabled');
});

test('未配置微信凭据时，二维码元数据接口明确报不可用', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/orgs/org_prod/qrcode', headers: auth() });
  assert.equal(response.statusCode, 503, '不得返回一个看似可用的预览码');
  assert.equal(response.json().error.code, 'service_unavailable');
  assert.match(response.json().error.message, /WX_APPID|WX_APPSECRET/);
  assert.deepEqual(response.json().error.details.missing, ['WX_APPID', 'WX_APPSECRET']);
});

test('未配置微信凭据时，二维码图片接口返回 503 而不是图片', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/orgs/org_prod/qrcode.png', headers: auth() });
  assert.equal(response.statusCode, 503);
  assert.ok(
    !String(response.headers['content-type']).includes('image/png'),
    '不得返回任何 PNG 内容',
  );
  assert.equal(response.json().error.code, 'service_unavailable');
});

test('项目二维码同样遵循该规则', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/orgs/org_prod/projects',
    headers: auth(),
    payload: { title: '生产校验项目', status: 'published' },
  });
  assert.equal(created.statusCode, 201);
  const projectId = created.json().project.id;

  const meta = await app.inject({
    method: 'GET',
    url: `/api/orgs/org_prod/projects/${projectId}/qrcode`,
    headers: auth(),
  });
  assert.equal(meta.statusCode, 503);

  const image = await app.inject({
    method: 'GET',
    url: `/api/orgs/org_prod/projects/${projectId}/qrcode.png`,
    headers: auth(),
  });
  assert.equal(image.statusCode, 503);
});

test('公众页面在生产模式下仍然可用（不受二维码能力缺失影响）', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/orgs/org_prod/projects',
    headers: auth(),
    payload: { title: '公开项目', status: 'published' },
  });
  const projectId = created.json().project.id;
  await app.inject({
    method: 'PUT',
    url: `/api/orgs/org_prod/projects/${projectId}/form`,
    headers: auth(),
    payload: { fields: [{ key: 'name', label: '姓名', type: 'text', required: true }] },
  });

  // 分享码在任何模式下都能定位页面，只是无法出图。
  const qr = await app.inject({
    method: 'GET',
    url: `/api/orgs/org_prod/projects/${projectId}/qrcode`,
    headers: auth(),
  });
  assert.equal(qr.statusCode, 503);
  void projectId;
});
