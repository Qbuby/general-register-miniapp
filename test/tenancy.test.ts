import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  auth,
  closeTestDb,
  createOrg,
  createProject,
  createTestApp,
  getQrCode,
  getProjectQrCode,
  loginAsAdmin,
  removeTestDir,
  setForm,
  SIMPLE_FIELDS,
  submit,
  type Session,
} from './helpers.js';

/**
 * Scenario F / acceptance: institution A must not be able to read, change or
 * export institution B's data — not through the UI, not by editing a URL, not
 * by swapping an id in the request body.
 */
let app: FastifyInstance;
let alice: Session;
let bob: Session;
let orgA: { id: string; name: string };
let orgB: { id: string; name: string };
let projectA: Record<string, any>;
let projectB: Record<string, any>;
let codeA: string;
let projectCodeA: string;

before(async () => {
  app = await createTestApp();
  alice = await loginAsAdmin(app, '机构A管理员');
  bob = await loginAsAdmin(app, '机构B管理员');
  orgA = await createOrg(app, alice, { name: '机构A', intro: 'A 的介绍' });
  orgB = await createOrg(app, bob, { name: '机构B', intro: 'B 的介绍' });

  projectA = await createProject(app, alice, orgA.id, { title: 'A 的课程', status: 'published' });
  projectB = await createProject(app, bob, orgB.id, { title: 'B 的训练营', status: 'published' });
  await setForm(app, alice, orgA.id, projectA.id, SIMPLE_FIELDS);
  await setForm(app, bob, orgB.id, projectB.id, SIMPLE_FIELDS);

  codeA = await getQrCode(app, alice, orgA.id);
  projectCodeA = await getProjectQrCode(app, alice, orgA.id, projectA.id);
  await submit(app, projectCodeA, { name: '张三', phone: '13800138000' });
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

test('机构 B 无法读取机构 A 的机构资料', async () => {
  const response = await app.inject({ method: 'GET', url: `/api/orgs/${orgA.id}`, headers: auth(bob) });
  assert.equal(response.statusCode, 404, '跨租户访问应返回 404，避免泄露机构是否存在');
});

test('机构 B 无法在机构 A 下创建项目', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgA.id}/projects`,
    headers: auth(bob),
    payload: { title: '恶意项目' },
  });
  assert.equal(response.statusCode, 404);
});

test('机构 B 无法列出或修改机构 A 的项目', async () => {
  const list = await app.inject({ method: 'GET', url: `/api/orgs/${orgA.id}/projects`, headers: auth(bob) });
  assert.equal(list.statusCode, 404);

  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgA.id}/projects/${projectA.id}`,
    headers: auth(bob),
    payload: { title: '被篡改的标题' },
  });
  assert.equal(patch.statusCode, 404);

  // The project must be untouched.
  const owner = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgA.id}/projects/${projectA.id}`,
    headers: auth(alice),
  });
  assert.equal(owner.json().project.title, 'A 的课程');
});

test('伪造机构 ID 与项目 ID 组合无法越权', async () => {
  // Correct session, but Bob's org combined with Alice's project id.
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgB.id}/projects/${projectA.id}`,
    headers: auth(bob),
  });
  assert.equal(response.statusCode, 404);

  const asAlice = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgB.id}/projects/${projectB.id}`,
    headers: auth(alice),
  });
  assert.equal(asAlice.statusCode, 404);
});

test('机构 B 无法读取机构 A 的报名记录', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgA.id}/registrations`,
    headers: auth(bob),
  });
  assert.equal(response.statusCode, 404);
});

test('机构 B 无法导出机构 A 的报名数据', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgA.id}/registrations/export.csv`,
    headers: auth(bob),
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['content-type']?.includes('text/csv'), false);
});

test('机构 B 无法修改机构 A 的报名状态', async () => {
  const owner = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgA.id}/registrations`,
    headers: auth(alice),
  });
  const registrationId = owner.json().rows[0].id;

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgA.id}/registrations/${registrationId}`,
    headers: auth(bob),
    payload: { status: 'confirmed' },
  });
  assert.equal(response.statusCode, 404);
});

test('机构 B 无法获取机构 A 的二维码，也无法用 A 的码替自己取码', async () => {
  const foreign = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgA.id}/qrcode.png`,
    headers: auth(bob),
  });
  assert.equal(foreign.statusCode, 404);

  // Alice asking for org B's project QR must fail the same way.
  const crossProject = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgB.id}/projects/${projectA.id}/qrcode.png`,
    headers: auth(bob),
  });
  assert.equal(crossProject.statusCode, 404);
});

test('机构 B 无法修改机构 A 的报名表', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/orgs/${orgA.id}/projects/${projectA.id}/form`,
    headers: auth(bob),
    payload: { fields: [{ key: 'hacked', label: '恶意字段', type: 'text', required: true }] },
  });
  assert.equal(response.statusCode, 404);

  const owner = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgA.id}/projects/${projectA.id}/form`,
    headers: auth(alice),
  });
  assert.deepEqual(
    owner.json().fields.map((f: any) => f.key),
    ['name', 'phone'],
  );
});

test('未登录用户无法访问任何机构管理接口', async () => {
  for (const url of [
    '/api/orgs',
    `/api/orgs/${orgA.id}`,
    `/api/orgs/${orgA.id}/projects`,
    `/api/orgs/${orgA.id}/registrations`,
    `/api/orgs/${orgA.id}/qrcode.png`,
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401, `${url} 应要求登录`);
  }
});

test('伪造 token 无法访问管理接口', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgA.id}`,
    headers: { authorization: 'Bearer not.a.real.token' },
  });
  assert.equal(response.statusCode, 401);
});

test('机构 A 主页只展示自己的已发布项目', async () => {
  const response = await app.inject({ method: 'GET', url: `/api/public/organizations/${codeA}` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.organization.name, '机构A');
  assert.deepEqual(body.projects.map((p: any) => p.title), ['A 的课程']);
  assert.ok(!JSON.stringify(body).includes('B 的训练营'), '主页不得出现其他机构的项目');
});

test('机构工作台只列出自己名下的机构', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/orgs', headers: auth(alice) });
  assert.deepEqual(response.json().organizations.map((o: any) => o.name), ['机构A']);
});
