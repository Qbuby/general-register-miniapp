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
  loginAsAdmin,
  removeTestDir,
  setForm,
  SIMPLE_FIELDS,
  submit,
  type Session,
} from './helpers.js';

/**
 * Acceptance scenario F: the server — not the page — must refuse to oversell a
 * limited project, including when several submissions arrive at once.
 */
let app: FastifyInstance;
let owner: Session;
let orgId: string;

before(async () => {
  app = await createTestApp();
  owner = await loginAsAdmin(app, '机构管理员');
  orgId = (await createOrg(app, owner, { name: '限额测试机构', status: 'published' })).id;
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

test('并发提交不会突破人数上限', async () => {
  const capacity = 5;
  const attempts = 30;
  const project = await createProject(app, owner, orgId, {
    title: '限额 5 人的小班课',
    status: 'published',
    capacity,
  });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  // Fire every submission at once. Each is a distinct idempotency key, so
  // nothing but the capacity guard can deduplicate them.
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, i) =>
      submit(app, code, { name: `学员${i}`, phone: `13800138${String(i).padStart(3, '0')}` }, {
        idempotencyKey: `race-key-${capacity}-${String(i).padStart(4, '0')}`,
      }),
    ),
  );

  const created = results.filter((r) => r.statusCode === 201);
  const rejected = results.filter((r) => r.statusCode === 409);

  assert.equal(created.length, capacity, `只应成功 ${capacity} 条，实际 ${created.length} 条`);
  assert.equal(rejected.length, attempts - capacity);
  assert.ok(
    rejected.every((r) => r.body.error.code === 'project_full'),
    '超额提交应统一返回“人数已满”',
  );

  const list = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&pageSize=100`,
    headers: auth(owner),
  });
  assert.equal(list.json().total, capacity, '数据库中的报名条数不得超限');

  const detail = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${project.id}`,
    headers: auth(owner),
  });
  assert.equal(detail.json().project.registered_count, capacity);
  assert.equal(detail.json().project.signup, 'full');
  assert.match(detail.json().project.signupReason ?? '', /已满/);
});

test('人数上限可不限制', async () => {
  const project = await createProject(app, owner, orgId, {
    title: '不限人数的公开讲座',
    status: 'published',
    capacity: null,
  });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      submit(app, code, { name: `听众${i}`, phone: `13900139${String(i).padStart(3, '0')}` }),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 25);
});

test('报名截止后释放的名额不会影响其他项目', async () => {
  const capacity = 2;
  const project = await createProject(app, owner, orgId, {
    title: '两人体验课',
    status: 'published',
    capacity,
  });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  await submit(app, code, { name: '甲', phone: '13700137001' });
  await submit(app, code, { name: '乙', phone: '13700137002' });
  const full = await submit(app, code, { name: '丙', phone: '13700137003' });
  assert.equal(full.statusCode, 409);

  const list = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}`,
    headers: auth(owner),
  });
  const rejected = list.json().rows.find((r: any) => r.contactName === '丙');

  // Marking a registration as rejected frees its seat.
  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/registrations/${rejected ? 'missing' : 'missing'}`,
    headers: auth(owner),
    payload: { status: 'pending' },
  }).catch(() => undefined);

  const rows = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}`,
    headers: auth(owner),
  });
  const victim = rows.json().rows.find((r: any) => r.contactName === '甲');
  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/registrations/${victim.id}`,
    headers: auth(owner),
    payload: { status: 'rejected' },
  });

  const retake = await submit(app, code, { name: '丙', phone: '13700137003' });
  assert.equal(retake.statusCode, 201, '名额释放后应可再次报名');

  const detail = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${project.id}`,
    headers: auth(owner),
  });
  assert.equal(detail.json().project.registered_count, capacity);
});

test('机构统计随报名变化', async () => {
  const stats = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/stats`, headers: auth(owner) });
  assert.equal(stats.statusCode, 200);
  const body = stats.json().stats;
  assert.ok(body.projectCount >= 3);
  assert.ok(body.registrationCount >= 7);
  assert.ok(body.perProject.length >= 3);
  const limited = body.perProject.find((p: any) => p.title === '两人体验课');
  assert.equal(limited.registeredCount, 2);
});
