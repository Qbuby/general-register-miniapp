import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  auth,
  closeTestDb,
  createOrg,
  createProject,
  createTestApp,
  getProjectQrCode,
  getQrCode,
  loginAsAdmin,
  removeTestDir,
  setForm,
  SIMPLE_FIELDS,
  submit,
  type Session,
} from './helpers.js';

/**
 * Acceptance scenarios C and D: institution and project QR codes.
 *
 * These run without WeChat credentials, so the service falls back to a clearly
 * labelled development preview code. What is verified here is the part that
 * must not regress either way: stable codes, correct target mapping, and a
 * scannable PNG that actually resolves to the right page.
 */
let app: FastifyInstance;
let owner: Session;
let orgId: string;
let projectA: Record<string, any>;
let projectB: Record<string, any>;

before(async () => {
  app = await createTestApp();
  owner = await loginAsAdmin(app, '机构管理员');
  orgId = (await createOrg(app, owner, { name: '扫码测试机构', status: 'published' })).id;
  projectA = await createProject(app, owner, orgId, { title: '项目甲', type: 'course', status: 'published' });
  projectB = await createProject(app, owner, orgId, { title: '项目乙', type: 'camp', status: 'published' });
  await setForm(app, owner, orgId, projectA.id, SIMPLE_FIELDS);
  await setForm(app, owner, orgId, projectB.id, SIMPLE_FIELDS);
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

test('机构二维码可用、指向机构主页', async () => {
  const info = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode`, headers: auth(owner) });
  assert.equal(info.statusCode, 200);
  const { qr, imageUrl } = info.json();
  assert.ok(qr.code);
  assert.equal(qr.target, 'organization');
  assert.equal(imageUrl, `/api/orgs/${orgId}/qrcode.png`);

  const image = await app.inject({ method: 'GET', url: imageUrl, headers: auth(owner) });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  // PNG magic number.
  assert.equal(image.rawPayload.subarray(0, 4).toString('hex'), '89504e47');
  assert.ok(image.rawPayload.length > 2000, '二维码图片应有足够分辨率');

  // The code resolves to this institution's home page.
  const home = await app.inject({ method: 'GET', url: `/api/public/organizations/${qr.code}` });
  assert.equal(home.statusCode, 200);
  assert.equal(home.json().organization.name, '扫码测试机构');
});

test('机构主页二维码展示的二维码指向真实小程序页面路径', async () => {
  const info = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode`, headers: auth(owner) });
  const { qr } = info.json();
  assert.equal(qr.page, 'pages/org-home/index');
  assert.equal(qr.scene, qr.code);
});

test('未配置微信凭据时明确标注为开发预览码，而不是伪装成功', async () => {
  const info = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode`, headers: auth(owner) });
  const { qr } = info.json();
  assert.equal(qr.mode, 'preview');
  assert.ok(qr.warning, '必须明确告知当前不是小程序码');
  assert.match(qr.warning!, /不是微信小程序码/);

  const image = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode.png`, headers: auth(owner) });
  assert.equal(image.headers['x-qr-mode'], 'preview');
});

test('每个项目有各自不同的二维码，且直接进入对应项目详情', async () => {
  const codeA = await getProjectQrCode(app, owner, orgId, projectA.id);
  const codeB = await getProjectQrCode(app, owner, orgId, projectB.id);

  assert.notEqual(codeA, codeB, '不同项目必须有不同的二维码');
  assert.notEqual(codeA, (await getQrCode(app, owner, orgId)), '项目码不得与机构码相同');

  const pageA = await app.inject({ method: 'GET', url: `/api/public/projects/${codeA}` });
  const pageB = await app.inject({ method: 'GET', url: `/api/public/projects/${codeB}` });
  assert.equal(pageA.json().project.title, '项目甲');
  assert.equal(pageB.json().project.title, '项目乙');
  assert.equal(pageA.json().project.id, projectA.id);
  assert.equal(pageB.json().project.id, projectB.id);
});

test('项目二维码指向项目详情页路径，而不是机构主页', async () => {
  const info = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${projectA.id}/qrcode`,
    headers: auth(owner),
  });
  const { qr } = info.json();
  assert.equal(qr.page, 'pages/project-detail/index');
});

test('反复获取二维码不会更换已印刷的码', async () => {
  const first = await getProjectQrCode(app, owner, orgId, projectA.id);
  const second = await getProjectQrCode(app, owner, orgId, projectA.id);
  const third = await getProjectQrCode(app, owner, orgId, projectA.id);
  assert.equal(first, second);
  assert.equal(second, third);
});

test('刷新二维码图片不影响已印刷的码继续可用', async () => {
  const before = await getProjectQrCode(app, owner, orgId, projectA.id);
  await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/projects/${projectA.id}/qrcode.png`, headers: auth(owner) });
  await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/projects/${projectA.id}/qrcode.png`, headers: auth(owner) });
  const after = await getProjectQrCode(app, owner, orgId, projectA.id);
  assert.equal(before, after);

  const page = await app.inject({ method: 'GET', url: `/api/public/projects/${after}` });
  assert.equal(page.statusCode, 200);
});

test('已下架项目的二维码仍能打开状态页并说明原因', async () => {
  const code = await getProjectQrCode(app, owner, orgId, projectB.id);
  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/projects/${projectB.id}`,
    headers: auth(owner),
    payload: { status: 'unlisted' },
  });

  const page = await app.inject({ method: 'GET', url: `/api/public/projects/${code}` });
  assert.equal(page.statusCode, 200, '印刷的二维码不应因为下架而失效');
  assert.equal(page.json().project.signup, 'unlisted');
  assert.match(page.json().project.signupReason!, /已下架/);

  const attempt = await submit(app, code, { name: '测试', phone: '13800138000' });
  assert.equal(attempt.statusCode, 409);
});

test('二维码无法被用于越权访问管理功能', async () => {
  const other = await loginAsAdmin(app, '另一机构管理员');
  const otherOrg = await createOrg(app, other, { name: '另一机构' });

  // Knowing a share code grants nothing.
  const code = await getQrCode(app, owner, orgId);
  assert.ok(code);

  for (const url of [
    `/api/orgs/${orgId}`,
    `/api/orgs/${orgId}/projects`,
    `/api/orgs/${orgId}/registrations`,
    `/api/orgs/${orgId}/qrcode.png`,
  ]) {
    const response = await app.inject({ method: 'GET', url: `${url}?scene=${code}`, headers: auth(other) });
    assert.equal(response.statusCode, 404, `${url}?scene=... 不得绕过权限`);
  }

  // The code is not an identity either: submitting as anonymous is fine, but
  // it never grants access to the workbench of either institution.
  const anonymous = await app.inject({ method: 'GET', url: `/api/orgs/${otherOrg.id}?code=${code}` });
  assert.equal(anonymous.statusCode, 401);
});

test('机构二维码图片无法跨机构获取', async () => {
  const other = await loginAsAdmin(app, '第三方管理员');
  const otherOrg = await createOrg(app, other, { name: '无关机构' });
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${projectA.id}/qrcode.png`,
    headers: auth(other),
  });
  assert.equal(response.statusCode, 404);
  void otherOrg;
});
