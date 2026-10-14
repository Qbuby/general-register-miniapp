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
 * 边界与异常场景联调。
 *
 * 这里刻意去踩那些平时不会想到、但机构真实运营中很可能发生的输入：
 * 搜索框里的 % 、把人数上限调到比已报名人数还小、空报名表、
 * 超长文本、表情符号、并发抢同一个邀请码……
 */
let app: FastifyInstance;
let owner: Session;
let orgId: string;

before(async () => {
  app = await createTestApp();
  owner = await loginAsAdmin(app, '边界测试管理员');
  orgId = (await createOrg(app, owner, { name: '边界测试机构', status: 'published' })).id;
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

test('搜索框里的 % 和 _ 不会变成通配符匹配全部', async () => {
  const project = await createProject(app, owner, orgId, { title: '搜索转义测试', status: 'published' });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  await submit(app, code, { name: '普通学员', phone: '13800138001' });
  await submit(app, code, { name: '张_三', phone: '13800138002' });

  // % 在 LIKE 里是「匹配任意」，若未转义会把所有行都搜出来
  const percent = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&q=${encodeURIComponent('%')}`,
    headers: auth(owner),
  });
  assert.equal(percent.json().total, 0, `搜索 "%%" 不应命中任何记录，实际命中 ${percent.json().total} 条`);

  // _ 在 LIKE 里是「匹配任意单字符」，张_三 应能精确命中，不应波及其他
  const underscore = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&q=${encodeURIComponent('张_三')}`,
    headers: auth(owner),
  });
  assert.equal(underscore.json().total, 1, `搜索 "张_三" 应精确命中 1 条，实际 ${underscore.json().total} 条`);

  // 正常的部分匹配仍然要能用
  const partial = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&q=${encodeURIComponent('普通')}`,
    headers: auth(owner),
  });
  assert.equal(partial.json().total, 1, '普通部分匹配应仍然有效');
});

test('人数上限调低到低于已报名人数时，不会出现负数或超额报名', async () => {
  const project = await createProject(app, owner, orgId, {
    title: '下调上限的项目',
    status: 'published',
    capacity: 5,
  });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  for (let i = 0; i < 4; i += 1) {
    const res = await submit(app, code, { name: `学员${i}`, phone: `1380013810${i}` });
    assert.equal(res.statusCode, 201);
  }

  // 运营把上限从 5 调到 2
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/projects/${project.id}`,
    headers: auth(owner),
    payload: { capacity: 2 },
  });
  assert.equal(patch.statusCode, 200);

  const detail = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${project.id}`,
    headers: auth(owner),
  });
  assert.equal(detail.json().project.signup, 'full', '超额后应判定为已满');
  assert.ok(detail.json().project.registered_count >= 2);

  const attempt = await submit(app, code, { name: '后来者', phone: '13800138199' });
  assert.equal(attempt.statusCode, 409, '已超额后不得继续接受报名');
  assert.equal(attempt.body.error.code, 'project_full');

  const publicPage = await app.inject({ method: 'GET', url: `/api/public/projects/${code}` });
  assert.ok(publicPage.json().project.remaining >= 0, '剩余名额不得为负数');
});

test('允许重复报名开关在已有报名后切换，不会产生重复或丢失数据', async () => {
  const project = await createProject(app, owner, orgId, {
    title: '重复报名开关测试',
    status: 'published',
  });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  const applicant = await loginAsAdmin(app, '开关测试用户');
  await submit(app, code, { name: '甲', phone: '13800138200' }, { token: applicant.token });

  // 允许重复后，同一用户应能再次报名
  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/projects/${project.id}`,
    headers: auth(owner),
    payload: { allowDuplicate: true },
  });
  const second = await submit(app, code, { name: '乙', phone: '13800138201' }, { token: applicant.token });
  assert.equal(second.statusCode, 201, '开启重复报名后应允许再次提交');

  // 关掉后，新的第三次报名应被拦截，但历史两条必须还在
  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/projects/${project.id}`,
    headers: auth(owner),
    payload: { allowDuplicate: false },
  });
  const third = await submit(app, code, { name: '丙', phone: '13800138202' }, { token: applicant.token });
  assert.equal(third.statusCode, 409);

  const rows = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}`,
    headers: auth(owner),
  });
  assert.equal(rows.json().total, 2, '历史报名不得丢失');
});

test('空报名表的项目不会导致崩溃，且拒绝任何提交', async () => {
  const project = await createProject(app, owner, orgId, { title: '空表单项目', status: 'published' });
  await setForm(app, owner, orgId, project.id, []);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  const page = await app.inject({ method: 'GET', url: `/api/public/projects/${code}` });
  assert.equal(page.statusCode, 200);
  assert.deepEqual(page.json().fields, []);

  const attempt = await submit(app, code, { name: '张三', phone: '13800138300' });
  assert.equal(attempt.statusCode, 400, '没有配置表单时不应接受任何答案');
  assert.equal(attempt.body.error.code, 'invalid_answers');
});

test('超长文本被截断或拒绝，而不是静默丢弃或撑爆存储', async () => {
  const project = await createProject(app, owner, orgId, { title: '超长输入测试', status: 'published' });
  await setForm(app, owner, orgId, project.id, [
    { key: 'name', label: '姓名', type: 'text', required: true, maxLength: 10 },
    { key: 'remark', label: '备注', type: 'textarea', required: false, maxLength: 200 },
  ]);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  const tooLong = await submit(app, code, { name: '这是一个非常非常非常长的姓名', remark: 'x' });
  assert.equal(tooLong.statusCode, 400, '超出 maxLength 应被拒绝');
  assert.match(tooLong.body.error.message, /不能超过/);

  const huge = await submit(app, code, { name: '正常姓名', remark: 'x'.repeat(100000) });
  assert.equal(huge.statusCode, 400, '超大 payload 应被拒绝');

  const ok = await submit(app, code, { name: '正常姓名', remark: 'x'.repeat(200) });
  assert.equal(ok.statusCode, 201, '边界长度应能通过');
});

test('中文、表情符号与特殊字符能正确存取并导出', async () => {
  const project = await createProject(app, owner, orgId, { title: '特殊字符测试', status: 'published' });
  await setForm(app, owner, orgId, project.id, [
    { key: 'name', label: '姓名', type: 'text', required: true, maxLength: 50 },
    { key: 'remark', label: '备注', type: 'textarea', required: false, maxLength: 200 },
  ]);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  const trickyName = '张三·丰"翼';
  const trickyRemark = '备注含 <script>alert(1)</script> 与 emoji 🎉🎯 和换行\n第二行';
  const created = await submit(app, code, { name: trickyName, remark: trickyRemark });
  assert.equal(created.statusCode, 201);

  // 原样存回
  const rows = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}`,
    headers: auth(owner),
  });
  const row = rows.json().rows[0];
  assert.equal(row.contactName, trickyName, '含引号的姓名应原样存取');
  assert.equal(row.answers.remark, trickyRemark, '含 HTML/emoji/换行的备注应原样存取');

  // 导出后仍能读回
  const csv = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv?projectId=${project.id}`,
    headers: auth(owner),
  });
  assert.ok(csv.body.includes('张三·丰'), 'CSV 应包含特殊字符姓名');
  assert.ok(csv.body.includes('🎉🎯'), 'CSV 应保留 emoji');
  assert.ok(csv.body.includes('<script>'), 'CSV 不应吞掉原文');
});

test('分页边界：最后一页、超出总页数、空结果', async () => {
  const project = await createProject(app, owner, orgId, { title: '分页测试', status: 'published' });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);
  for (let i = 0; i < 5; i += 1) {
    await submit(app, code, { name: `分页${i}`, phone: `1380013840${i}` });
  }

  const first = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&page=1&pageSize=2`,
    headers: auth(owner),
  });
  assert.equal(first.json().rows.length, 2);
  assert.equal(first.json().total, 5);

  const last = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&page=3&pageSize=2`,
    headers: auth(owner),
  });
  assert.equal(last.json().rows.length, 1, '最后一页应有剩余 1 条');
  assert.equal(last.json().total, 5, 'total 始终是全部命中数');

  const beyond = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&page=99&pageSize=2`,
    headers: auth(owner),
  });
  assert.equal(beyond.statusCode, 200);
  assert.deepEqual(beyond.json().rows, [], '超出范围应返回空数组而非报错');

  const noResult = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}&q=${encodeURIComponent('不存在的名字')}`,
    headers: auth(owner),
  });
  assert.equal(noResult.json().total, 0);
  assert.deepEqual(noResult.json().rows, []);
});

test('导出零条记录时仍返回合法 CSV', async () => {
  const project = await createProject(app, owner, orgId, { title: '空导出测试', status: 'published' });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);

  const csv = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/export.csv?projectId=${project.id}`,
    headers: auth(owner),
  });
  assert.equal(csv.statusCode, 200);
  assert.equal(csv.body.trim().split('\r\n').length, 1, '应只有表头一行');
  assert.ok(csv.body.includes('姓名'), '表头仍应包含动态字段列');
});

test('报名截止时间恰好等于当前时间时，已截止', async () => {
  const db = await import('../src/db/index.js');
  const project = await createProject(app, owner, orgId, { title: '截止边界', status: 'published' });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  // 把截止时间设为「刚刚」，边界上应为已截止
  db.run(
    'UPDATE projects SET signup_end_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(),
    project.id,
  );
  const attempt = await submit(app, code, { name: '迟到者', phone: '13800138500' });
  assert.equal(attempt.statusCode, 409);
  assert.equal(attempt.body.error.code, 'signup_ended');

  // 把开始时间设为「刚刚」，边界上应已开始
  const other = await createProject(app, owner, orgId, { title: '开始边界', status: 'published' });
  await setForm(app, owner, orgId, other.id, SIMPLE_FIELDS);
  const otherCode = await getProjectQrCode(app, owner, orgId, other.id);
  db.run(
    'UPDATE projects SET signup_start_at = ?, signup_end_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(),
    new Date(Date.now() + 3600000).toISOString(),
    other.id,
  );
  const ok = await submit(app, otherCode, { name: '准点报名', phone: '13800138501' });
  assert.equal(ok.statusCode, 201, '到达开始时间的瞬间应可报名');
});

test('并发接受同一个邀请码，有且只有一人成功', async () => {
  const invite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'operator' },
  });
  const code = invite.json().invite.code;

  const users = await Promise.all(
    Array.from({ length: 8 }, (_, i) => loginAsAdmin(app, `抢码用户${i}`)),
  );
  const results = await Promise.all(
    users.map((u) => app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: auth(u) })),
  );

  const ok = results.filter((r) => r.statusCode === 200);
  const rejected = results.filter((r) => r.statusCode === 409);
  assert.equal(ok.length, 1, `应恰好 1 人成功，实际 ${ok.length} 人`);
  assert.equal(rejected.length, 7, '其余应全部被拒绝');

  const members = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/members`, headers: auth(owner) });
  const invited = members.json().members.filter((m: any) => m.role === 'operator' && m.nickname.startsWith('抢码用户'));
  assert.equal(invited.length, 1, '失败者不得成为成员');
});

test('并发点击报名按钮（同一幂等键）只产生一条记录', async () => {
  const project = await createProject(app, owner, orgId, { title: '并发提交测试', status: 'published' });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      submit(app, code, { name: '并发学员', phone: '13800138600' }, { idempotencyKey: 'concurrent-key-abc123' }),
    ),
  );

  const created = results.filter((r) => r.statusCode === 201);
  assert.equal(created.length, 1, '只有一个请求应真正创建记录');
  const ids = new Set(results.filter((r) => r.statusCode < 400).map((r: any) => r.body.receipt.id));
  assert.equal(ids.size, 1, '所有成功响应应指向同一条记录');

  const rows = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}`,
    headers: auth(owner),
  });
  assert.equal(rows.json().total, 1, '数据库中只应有一条');
});

test('被拒绝的报名会释放名额，可以再次报名', async () => {
  const project = await createProject(app, owner, orgId, {
    title: '名额释放测试',
    status: 'published',
    capacity: 1,
  });
  await setForm(app, owner, orgId, project.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, project.id);

  const first = await submit(app, code, { name: '占位者', phone: '13800138700' });
  assert.equal(first.statusCode, 201);

  const blocked = await submit(app, code, { name: '后来者', phone: '13800138701' });
  assert.equal(blocked.statusCode, 409);

  const rows = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${project.id}`,
    headers: auth(owner),
  });
  const holder = rows.json().rows[0];

  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/registrations/${holder.id}`,
    headers: auth(owner),
    payload: { status: 'rejected' },
  });

  const retake = await submit(app, code, { name: '后来者', phone: '13800138701' });
  assert.equal(retake.statusCode, 201, '名额释放后应可再次报名');

  const detail = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${project.id}`,
    headers: auth(owner),
  });
  assert.equal(detail.json().project.registered_count, 1, '计数不应错乱');
});

test('非 JSON 的错误输入返回可读提示而不是 500', async () => {
  const garbage = await app.inject({
    method: 'POST',
    url: `/api/public/projects/invalid/registrations`,
    headers: { 'content-type': 'application/json' },
    payload: '{ 坏掉的 JSON',
  });
  assert.ok(garbage.statusCode >= 400 && garbage.statusCode < 500, `期望 4xx，实际 ${garbage.statusCode}`);
  assert.ok(
    garbage.json().error && garbage.json().error.message,
    '应返回可读的错误信息，而不是 HTML 或空响应',
  );

  // 未登录时优先报 401 而不是参数校验错误——不该给未认证的调用方泄露校验细节。
  const unauth = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 123 }),
  });
  assert.equal(unauth.statusCode, 401);

  // 已登录但参数类型不对，才是 400
  const wrongType = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    headers: { ...auth(owner), 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 123 }),
  });
  assert.equal(wrongType.statusCode, 400);
  assert.equal(wrongType.json().error.code, 'invalid_input');
});
