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

/** Acceptance scenario E: dynamic per-project forms, validation, and history. */
let app: FastifyInstance;
let owner: Session;
let orgId: string;

/** A course with a simple name/phone form. */
let course: Record<string, any>;
let courseCode: string;
/** A camp with a completely different form: guardian, age, multi-select. */
let camp: Record<string, any>;
let campCode: string;

before(async () => {
  app = await createTestApp();
  owner = await loginAsAdmin(app, '机构管理员');
  orgId = (await createOrg(app, owner, { name: '星辰教育', status: 'published' })).id;

  course = await createProject(app, owner, orgId, {
    title: '少儿编程周末班',
    type: 'course',
    status: 'published',
    capacity: 10,
  });
  await setForm(app, owner, orgId, course.id, SIMPLE_FIELDS);
  courseCode = await getProjectQrCode(app, owner, orgId, course.id);

  camp = await createProject(app, owner, orgId, {
    title: '暑期军事训练营',
    type: 'camp',
    status: 'published',
  });
  await setForm(app, owner, orgId, camp.id, CAMP_FIELDS);
  campCode = await getProjectQrCode(app, owner, orgId, camp.id);
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

test('每个项目渲染各自的报名表', async () => {
  const coursePage = await app.inject({ method: 'GET', url: `/api/public/projects/${courseCode}` });
  const campPage = await app.inject({ method: 'GET', url: `/api/public/projects/${campCode}` });

  assert.deepEqual(coursePage.json().fields.map((f: any) => f.key), ['name', 'phone']);
  assert.deepEqual(campPage.json().fields.map((f: any) => f.key), [
    'child_name',
    'guardian_phone',
    'age',
    'sessions',
  ]);
  // The camp form really is a different form, not a relabelled copy.
  assert.equal(campPage.json().fields.find((f: any) => f.key === 'sessions').type, 'checkbox');
});

test('必填字段缺失时被拒绝，并指出具体字段', async () => {
  const result = await submit(app, courseCode, { name: '李四' });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, 'invalid_answers');
  assert.match(result.body.error.message, /手机号/);
  assert.ok(result.body.error.details.errors.phone);
});

test('手机号格式被服务端校验', async () => {
  const bad = await submit(app, courseCode, { name: '李四', phone: '12345' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error.message, /联系电话/);

  const notMobile = await submit(app, courseCode, { name: '李四', phone: '12345678901' });
  assert.equal(notMobile.statusCode, 400, '11 位但号段无效的号码应被拒绝');

  const validModernPrefix = await submit(app, courseCode, { name: '李四', phone: '19912345678' });
  assert.equal(validModernPrefix.statusCode, 201, '199 号段是真实号段，应被接受');
});

test('数字字段的取值范围被校验', async () => {
  const tooOld = await submit(app, campCode, {
    child_name: '王小明',
    guardian_phone: '13800138001',
    age: 30,
    sessions: ['第一期'],
  });
  assert.equal(tooOld.statusCode, 400);
  assert.match(tooOld.body.error.message, /年龄/);
});

test('多选字段只接受表单内配置的选项', async () => {
  const invalid = await submit(app, campCode, {
    child_name: '王小明',
    guardian_phone: '13800138002',
    sessions: ['第三期'],
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.error.message, /无效选项/);
});

test('提交不存在于该表单的字段会被拒绝', async () => {
  const result = await submit(app, courseCode, {
    name: '李四',
    phone: '13800138003',
    sessions: ['第一期'],
  });
  assert.equal(result.statusCode, 400);
  assert.ok(result.body.error.details.errors.sessions);
});

test('合法提交成功并返回明确结果与机构联系方式', async () => {
  const result = await submit(app, courseCode, { name: '李四', phone: '13800138004' });
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.receipt.submitted, true);
  assert.ok(result.body.receipt.receiptCode);
  assert.equal(result.body.project.title, '少儿编程周末班');
  assert.ok(result.body.organization, '报名成功页需要知道如何联系机构');
});

test('多个报名可代他人填写，字段由机构自行决定', async () => {
  const first = await submit(app, campCode, {
    child_name: '王小明',
    guardian_phone: '13800138005',
    age: 10,
    sessions: ['第一期', '第二期'],
  });
  const second = await submit(app, campCode, {
    child_name: '王小红',
    guardian_phone: '13800138006',
    age: 8,
    sessions: ['第二期'],
  });
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.notEqual(first.body.receipt.id, second.body.receipt.id);
});

test('报名记录落库，重新读取依然存在', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${course.id}`,
    headers: auth(owner),
  });
  assert.equal(response.statusCode, 200);
  const rows = response.json().rows;
  assert.ok(rows.length >= 2);
  const row = rows.find((r: any) => r.contactName === '李四');
  assert.ok(row, '报名记录应可通过接口查询');
  assert.equal(row.contactPhone, '13800138004');
  assert.equal(row.status, 'pending');
});

test('修改表单不会改变历史报名记录的含义', async () => {
  const beforeEdit = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${course.id}`,
    headers: auth(owner),
  });
  const target = beforeEdit.json().rows.find((r: any) => r.contactName === '李四');
  const snapshotBefore = JSON.parse(JSON.stringify(target.snapshot));

  // Rename the question, reorder it, drop one, add a new one.
  await setForm(app, owner, orgId, course.id, [
    { key: 'phone', label: '家长联系电话', type: 'phone', required: true },
    { key: 'name', label: '学员姓名', type: 'text', required: true },
    { key: 'grade', label: '当前年级', type: 'select', required: false, options: ['一', '二', '三'] },
  ]);

  const afterEdit = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations/${target.id}`,
    headers: auth(owner),
  });
  const record = afterEdit.json().registration;

  assert.equal(record.contactName, '李四', '历史报名人姓名不应被改写');
  assert.equal(record.contactPhone, '13800138004');
  assert.deepEqual(record.answers, { name: '李四', phone: '13800138004' }, '答案键仍绑定稳定字段标识');
  assert.deepEqual(record.snapshot, snapshotBefore, '历史快照必须保持提交时的样子');

  // The snapshot still shows the old labels, even though the form was rewritten.
  const labels = record.snapshot.map((f: any) => f.label);
  assert.deepEqual(labels, ['姓名', '手机号']);
});

test('新表单立刻对新提交生效，旧字段标识不再接受', async () => {
  const ok = await submit(app, courseCode, { phone: '13800138007', name: '赵六', grade: '三' });
  assert.equal(ok.statusCode, 201);

  const stale = await submit(app, courseCode, { name: '赵七', phone: '13800138008', grade: '四' });
  assert.equal(stale.statusCode, 400, '新选项之外的值应被拒绝');
});

test('同一微信用户重复报名被阻止，可按项目配置放开', async () => {
  const applicant = await loginAsAdmin(app, '报名家长');
  const first = await submit(app, campCode, {
    child_name: '王小明',
    guardian_phone: '13800138009',
    sessions: ['第一期'],
  }, { token: applicant.token });
  assert.equal(first.statusCode, 201);

  const again = await submit(app, campCode, {
    child_name: '王小明',
    guardian_phone: '13800138009',
    sessions: ['第一期'],
  }, { token: applicant.token });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error.code, 'duplicate_registration');

  // Same user, a different project: unaffected.
  const other = await submit(app, courseCode, { name: '王大明', phone: '13800138010' }, { token: applicant.token });
  assert.equal(other.statusCode, 201);
});

test('重复点击提交不会产生重复记录', async () => {
  const key = 'idem-key-double-tap-0001';
  const first = await submit(app, courseCode, { name: '孙八', phone: '13800138011' }, { idempotencyKey: key });
  const second = await submit(app, courseCode, { name: '孙八', phone: '13800138011' }, { idempotencyKey: key });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.receipt.id, first.body.receipt.id, '重复提交应返回同一条报名记录');
  assert.equal(second.body.receipt.submitted, false);

  const rows = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations?projectId=${course.id}&q=孙八`,
    headers: auth(owner),
  });
  assert.equal(rows.json().total, 1);
});

test('报名截止后仍可打开详情，但不能提交', async () => {
  const closed = await createProject(app, owner, orgId, {
    title: '已截止的公开课',
    status: 'published',
    signupEndAt: '2020-01-01T00:00:00Z',
  });
  await setForm(app, owner, orgId, closed.id, SIMPLE_FIELDS);
  const closedCode = await getProjectQrCode(app, owner, orgId, closed.id);

  const page = await app.inject({ method: 'GET', url: `/api/public/projects/${closedCode}` });
  assert.equal(page.statusCode, 200, '已截止项目仍应展示详情页');
  assert.equal(page.json().project.signup, 'ended');
  assert.match(page.json().project.signupReason, /报名已截止/);

  const attempt = await submit(app, closedCode, { name: '周九', phone: '13800138012' });
  assert.equal(attempt.statusCode, 409);
  assert.equal(attempt.body.error.code, 'signup_ended');
});

test('报名尚未开始时被拒绝', async () => {
  const upcoming = await createProject(app, owner, orgId, {
    title: '下期集训',
    status: 'published',
    signupStartAt: '2999-01-01T00:00:00Z',
  });
  await setForm(app, owner, orgId, upcoming.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, upcoming.id);

  const attempt = await submit(app, code, { name: '吴十', phone: '13800138013' });
  assert.equal(attempt.statusCode, 409);
  assert.equal(attempt.body.error.code, 'signup_not_started');
});

test('下架项目不再作为在招项目展示，且无法提交', async () => {
  const unlisted = await createProject(app, owner, orgId, {
    title: '临时下架的项目',
    status: 'published',
  });
  await setForm(app, owner, orgId, unlisted.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, unlisted.id);

  const orgCode = (await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode`, headers: auth(owner) })).json()
    .qr.code;
  const home = await app.inject({ method: 'GET', url: `/api/public/organizations/${orgCode}` });
  assert.ok(home.json().projects.some((p: any) => p.title === '临时下架的项目'));

  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/projects/${unlisted.id}`,
    headers: auth(owner),
    payload: { status: 'unlisted' },
  });

  const homeAfter = await app.inject({ method: 'GET', url: `/api/public/organizations/${orgCode}` });
  assert.ok(!homeAfter.json().projects.some((p: any) => p.title === '临时下架的项目'), '下架项目不应继续展示');

  const detail = await app.inject({ method: 'GET', url: `/api/public/projects/${code}` });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().project.signup, 'unlisted');

  const attempt = await submit(app, code, { name: '郑十一', phone: '13800138014' });
  assert.equal(attempt.statusCode, 409);
  assert.equal(attempt.body.error.code, 'project_unlisted');
});

test('未发布的项目对外不可见', async () => {
  const draft = await createProject(app, owner, orgId, { title: '草稿项目' });
  const code = await getProjectQrCode(app, owner, orgId, draft.id);
  const attempt = await submit(app, code, { name: '冯十二', phone: '13800138015' });
  assert.equal(attempt.statusCode, 409);
  assert.equal(attempt.body.error.code, 'project_unlisted');
});

test('机构暂停报名后详情页显示原因', async () => {
  const paused = await createProject(app, owner, orgId, { title: '暂停报名的项目', status: 'published' });
  await setForm(app, owner, paused.id ? orgId : orgId, paused.id, SIMPLE_FIELDS);
  const code = await getProjectQrCode(app, owner, orgId, paused.id);

  await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/projects/${paused.id}`,
    headers: auth(owner),
    payload: { signupEnabled: false },
  });

  const attempt = await submit(app, code, { name: '陈十三', phone: '13800138016' });
  assert.equal(attempt.statusCode, 409);
  assert.equal(attempt.body.error.code, 'signup_disabled');
});

test('无效分享码给出明确提示', async () => {
  const attempt = await submit(app, 'does-not-exist', { name: 'X', phone: '13800138017' });
  assert.equal(attempt.statusCode, 404);
  assert.match(attempt.body.error.message, /报名链接无效/);
});

test('报名回执可通过编号查询，且不泄露报名内容', async () => {
  const created = await submit(app, courseCode, { name: '褚十四', phone: '13800138018' });
  const receiptCode = created.body.receipt.receiptCode;

  const lookup = await app.inject({ method: 'GET', url: `/api/public/receipts/${receiptCode}` });
  assert.equal(lookup.statusCode, 200);
  assert.equal(lookup.json().receipt.projectTitle, '少儿编程周末班');
  assert.ok(lookup.body.includes('褚十四'));
  assert.ok(!lookup.body.includes('13800138018'), '回执查询不应回显完整联系方式');
});
