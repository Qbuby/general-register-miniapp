import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  auth,
  CAMP_FIELDS,
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

/** Acceptance scenario F: exports must contain the real submitted records. */
let app: FastifyInstance;
let owner: Session;
let orgId: string;
let course: Record<string, any>;
let courseCode: string;
let camp: Record<string, any>;
let campCode: string;

before(async () => {
  app = await createTestApp();
  owner = await loginAsAdmin(app, '机构管理员');
  orgId = (await createOrg(app, owner, {
    name: '导出测试机构',
    status: 'published',
    contactName: '张老师',
    contactPhone: '0571-88886666',
  })).id;

  course = await createProject(app, owner, orgId, { title: '导出用课程', status: 'published' });
  await setForm(app, owner, orgId, course.id, SIMPLE_FIELDS);
  courseCode = await getProjectQrCode(app, owner, orgId, course.id);

  camp = await createProject(app, owner, orgId, { title: '导出用训练营', status: 'published' });
  await setForm(app, owner, orgId, camp.id, CAMP_FIELDS);
  campCode = await getProjectQrCode(app, owner, orgId, camp.id);

  await submit(app, courseCode, { name: '甲同学', phone: '13800138001' });
  await submit(app, courseCode, { name: '乙同学', phone: '13800138002' });
  await submit(app, campCode, { child_name: '丙学员', guardian_phone: '13800138003', age: 12, sessions: ['第一期', '第二期'] });
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

test('导出的 CSV 包含真实报名记录', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv?projectId=${course.id}`,
    headers: auth(owner),
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] as string, /text\/csv/);
  assert.match(response.headers['content-disposition'] as string, /attachment/);
  assert.equal(response.headers['cache-control'], 'no-store');

  const csv = response.body;
  assert.ok(csv.startsWith('﻿'), '应带 UTF-8 BOM，Excel 才能正确显示中文');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3, '表头 + 2 条报名记录');

  assert.match(lines[0]!, /报名编号,报名时间,报名项目,姓名,联系电话,报名状态/);
  assert.match(lines[0]!, /姓名,手机号/, '动态字段应成为独立列');
  assert.ok(csv.includes('甲同学'));
  assert.ok(csv.includes('13800138001'));
  assert.ok(csv.includes('导出用课程'));
});

test('不同项目的导出列结构随各自的报名表变化', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv?projectId=${camp.id}`,
    headers: auth(owner),
  });
  const csv = response.body;
  assert.ok(csv.includes('学员姓名'), '训练营导出应使用自己的字段名');
  assert.ok(csv.includes('监护人电话'));
  assert.ok(csv.includes('参加场次'));
  assert.ok(!csv.includes('甲同学'), '不应混入其他项目的报名人');
  assert.ok(csv.includes('第一期 / 第二期'), '多选答案应全部导出');
});

test('导出全部项目时保留各项目字段', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv`,
    headers: auth(owner),
  });
  const csv = response.body;
  assert.ok(csv.includes('甲同学'));
  assert.ok(csv.includes('丙学员'));
  assert.ok(csv.includes('导出用训练营'));
});

test('导出可按状态筛选', async () => {
  const list = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${course.id}`,
    headers: auth(owner),
  });
  const target = list.json().rows[0];
  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/registrations/${target.id}`,
    headers: auth(owner),
    payload: { status: 'confirmed' },
  });

  const confirmed = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv?projectId=${course.id}&status=confirmed`,
    headers: auth(owner),
  });
  const csv = confirmed.body;
  assert.equal(csv.trim().split('\r\n').length, 2, '只导出一条');
  assert.ok(csv.includes('已确认'));
});

test('历史字段在当前表单已删除后仍出现在导出中', async () => {
  const extra = await createProject(app, owner, orgId, { title: '字段变更项目', status: 'published' });
  await setForm(app, owner, orgId, extra.id, [
    { key: 'name', label: '姓名', type: 'text', required: true },
    { key: 'age', label: '年龄', type: 'number', required: false },
  ]);
  const code = await getProjectQrCode(app, owner, orgId, extra.id);
  await submit(app, code, { name: '丁同学', age: 15 });

  // Drop the age question from the form.
  await setForm(app, owner, orgId, extra.id, [{ key: 'name', label: '姓名', type: 'text', required: true }]);

  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv?projectId=${extra.id}`,
    headers: auth(owner),
  });
  const csv = response.body;
  assert.ok(csv.includes('年龄（历史）'), '历史字段列不应消失');
  assert.ok(csv.includes('15'), '历史答案必须保留');
});

test('导出内容可防止 Excel 公式注入', async () => {
  const evil = await createProject(app, owner, orgId, { title: '公式注入测试', status: 'published' });
  await setForm(app, owner, orgId, evil.id, [{ key: 'name', label: '姓名', type: 'text', required: true }]);
  const code = await getProjectQrCode(app, owner, orgId, evil.id);
  await submit(app, code, { name: '=1+1' });

  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv?projectId=${evil.id}`,
    headers: auth(owner),
  });
  assert.ok(!response.body.includes(',=1+1'), '以 = 开头的单元格必须被转义');
  assert.ok(response.body.includes("'=1+1"));
});

test('导出操作被记入审计日志', async () => {
  const db = await import('../src/db/index.js');
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND action = 'registrations.export'`,
    orgId,
  );
  assert.ok((row?.n ?? 0) >= 1, '导出属于个人数据导出，应留痕');
});

test('报名记录支持搜索与状态流转', async () => {
  const search = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?q=丙学员`,
    headers: auth(owner),
  });
  assert.equal(search.json().total, 1);
  assert.equal(search.json().rows[0].contactName, '丙学员');

  const byPhone = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?q=13800138003`,
    headers: auth(owner),
  });
  assert.equal(byPhone.json().total, 1);

  const pending = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?status=pending`,
    headers: auth(owner),
  });
  assert.ok(pending.json().total >= 1);
  assert.ok(pending.json().rows.every((r: any) => r.status === 'pending'));
});
