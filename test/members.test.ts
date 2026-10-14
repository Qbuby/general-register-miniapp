import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  auth,
  closeTestDb,
  createOrg,
  createProject,
  createTestApp,
  loginAsAdmin,
  removeTestDir,
  setForm,
  SIMPLE_FIELDS,
  submit,
  getProjectQrCode,
  type Session,
} from './helpers.js';

/**
 * 机构成员与角色权限。
 *
 * 数据模型从 v1 起就有 organization_members，但如果没有可用的管理入口，
 * 整张表和 operator 角色就是死能力——所以这里既测「能不能管」，也测
 * 「权限边界是否真的生效」。
 */
let app: FastifyInstance;
let owner: Session;
let orgId: string;
let projectId: string;

before(async () => {
  app = await createTestApp();
  owner = await loginAsAdmin(app, '机构所有者');
  orgId = (await createOrg(app, owner, { name: '多成员测试机构', status: 'published' })).id;
  const project = await createProject(app, owner, orgId, { title: '共享项目', status: 'published' });
  projectId = project.id;
  await setForm(app, owner, orgId, projectId, SIMPLE_FIELDS);
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

/** owner 邀请一个成员并让其接受，返回该成员的会话。 */
async function addMember(nickname: string, role: 'admin' | 'operator'): Promise<{ session: Session; memberId: string }> {
  const invite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role },
  });
  assert.equal(invite.statusCode, 201, invite.body);
  const code = invite.json().invite.code;

  const session = await loginAsAdmin(app, nickname);
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/invites/${code}/accept`,
    headers: auth(session),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const members = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/members`, headers: auth(owner) });
  const member = members.json().members.find((m: any) => m.userId === session.userId);
  assert.ok(member, '接受后应出现在成员列表中');
  return { session, memberId: member.id };
}

test('owner 可以生成邀请码', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'operator' },
  });
  assert.equal(response.statusCode, 201);
  const invite = response.json().invite;
  assert.equal(invite.role, 'operator');
  assert.equal(invite.status, 'pending');
  assert.ok(invite.code);
  assert.ok(new Date(invite.expiresAt) > new Date(), '邀请码应有有效期');
});

test('邀请码不能授予所有者', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'owner' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_role');
});

test('接受邀请后成为该机构成员，并立即获得对应权限', async () => {
  const { session } = await addMember('新运营', 'operator');

  const members = await app.inject({ method: 'GET', url: '/api/orgs', headers: auth(session) });
  assert.ok(
    members.json().organizations.some((o: any) => o.name === '多成员测试机构'),
    '成员应能在「我的」里看到这个机构',
  );

  // operator 允许查看报名记录与二维码
  const list = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/registrations`, headers: auth(session) });
  assert.equal(list.statusCode, 200);
  const qr = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode`, headers: auth(session) });
  assert.equal(qr.statusCode, 200);
});

test('operator 不能修改机构资料、项目、报名表', async () => {
  const { session } = await addMember('受限运营', 'operator');

  const editOrg = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}`,
    headers: auth(session),
    payload: { name: '被篡改的名称' },
  });
  assert.equal(editOrg.statusCode, 403, 'operator 无权编辑机构资料');
  assert.equal(editOrg.json().error.code, 'forbidden');

  const createProjectRes = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/projects`,
    headers: auth(session),
    payload: { title: '越权项目' },
  });
  assert.equal(createProjectRes.statusCode, 403);

  const setFormRes = await app.inject({
    method: 'PUT',
    url: `/api/orgs/${orgId}/projects/${projectId}/form`,
    headers: auth(session),
    payload: { fields: [{ label: '恶意字段', type: 'text', required: true }] },
  });
  assert.equal(setFormRes.statusCode, 403);
});

test('operator 不能管理成员', async () => {
  const { session } = await addMember('无权成员', 'operator');

  const list = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/members`, headers: auth(session) });
  assert.equal(list.statusCode, 200, '查看成员列表是允许的');

  const createInvite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(session),
    payload: { role: 'admin' },
  });
  assert.equal(createInvite.statusCode, 403, 'operator 无权邀请他人');

  const members = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/members`, headers: auth(owner) });
  const victim = members.json().members.find((m: any) => m.role === 'owner');
  const remove = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${orgId}/members/${victim.id}`,
    headers: auth(session),
  });
  assert.equal(remove.statusCode, 403, 'operator 无权移除他人');
});

test('admin 可以改机构资料与项目，但不能管理成员', async () => {
  const { session } = await addMember('新管理员', 'admin');

  const editOrg = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}`,
    headers: auth(session),
    payload: { intro: '管理员更新的介绍' },
  });
  assert.equal(editOrg.statusCode, 200);

  const createProjectRes = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/projects`,
    headers: auth(session),
    payload: { title: '管理员创建的项目' },
  });
  assert.equal(createProjectRes.statusCode, 201);

  const createInvite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(session),
    payload: { role: 'operator' },
  });
  assert.equal(createInvite.statusCode, 403, '只有 owner 能邀请成员');
});

test('同一个邀请码不能被使用两次', async () => {
  const invite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'operator' },
  });
  const code = invite.json().invite.code;

  const first = await loginAsAdmin(app, '接受者甲');
  const firstRes = await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: auth(first) });
  assert.equal(firstRes.statusCode, 200);

  const second = await loginAsAdmin(app, '接受者乙');
  const secondRes = await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: auth(second) });
  assert.equal(secondRes.statusCode, 409);
  assert.equal(secondRes.json().error.code, 'invite_used');

  // 乙不应因此成为成员
  const members = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/members`, headers: auth(owner) });
  assert.ok(!members.json().members.some((m: any) => m.userId === second.userId));
});

test('接受邀请需要登录，跨机构不能代答', async () => {
  const invite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'operator' },
  });
  const code = invite.json().invite.code;

  const anon = await app.inject({ method: 'POST', url: `/api/invites/${code}/accept` });
  assert.equal(anon.statusCode, 401);

  const inviteWithOrgId = await app.inject({
    method: 'POST',
    url: `/api/invites/${code}/accept?orgId=${orgId}`,
    headers: auth(await loginAsAdmin(app, '陌生人')),
  });
  assert.equal(inviteWithOrgId.statusCode, 200, '邀请码本身就是凭据，不应再依赖 orgId');
  void inviteWithOrgId;
});

test('无请求体的接口容忍空的 JSON body', async () => {
  // 接受邀请本来就不需要请求体。有些客户端（如 fetch 手动设置 content-type
  // 却不带 body）会因此收到莫名其妙的 400，这里锁定该行为不被改回去。
  const invite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'operator' },
  });
  const code = invite.json().invite.code;
  const session = await loginAsAdmin(app, '空 body 接受者');

  const response = await app.inject({
    method: 'POST',
    url: `/api/invites/${code}/accept`,
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    payload: '',
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().role, 'operator');
});

test('非法的 JSON body 仍应被拒绝', () => {
  // 容忍空 body 不等于放行垃圾内容。
  return app
    .inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      payload: '{ 这不是 JSON',
    })
    .then((response) => {
      assert.ok(response.statusCode >= 400, `期望 4xx，实际 ${response.statusCode}`);
    });
});

test('无效与过期邀请码给出明确原因', async () => {
  const unknown = await app.inject({ method: 'POST', url: '/api/invites/nosuchcode/accept', headers: auth(owner) });
  assert.equal(unknown.statusCode, 404);

  const db = await import('../src/db/index.js');
  const invite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'operator' },
  });
  const code = invite.json().invite.code;
  db.run('UPDATE organization_invites SET expires_at = ? WHERE code = ?', '2000-01-01T00:00:00.000Z', code);

  const expired = await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: auth(owner) });
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().error.code, 'invite_expired');
});

test('已撤销的邀请码不能接受', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/invites`,
    headers: auth(owner),
    payload: { role: 'operator' },
  });
  const inviteId = created.json().invite.id;
  const code = created.json().invite.code;

  const revoke = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${orgId}/invites/${inviteId}`,
    headers: auth(owner),
  });
  assert.equal(revoke.statusCode, 200);

  const accept = await app.inject({
    method: 'POST',
    url: `/api/invites/${code}/accept`,
    headers: auth(await loginAsAdmin(app, '晚到的接受者')),
  });
  assert.equal(accept.statusCode, 409);
  assert.equal(accept.json().error.code, 'invite_revoked');
});

test('owner 可以调整成员角色与移除成员', async () => {
  const { memberId, session } = await addMember('待调整成员', 'operator');

  const promote = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/members/${memberId}`,
    headers: auth(owner),
    payload: { role: 'admin' },
  });
  assert.equal(promote.statusCode, 200);
  assert.equal(promote.json().member.role, 'admin');

  // 提升后可以编辑机构资料
  const edit = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}`,
    headers: auth(session),
    payload: { intro: '提升为管理员后可以编辑' },
  });
  assert.equal(edit.statusCode, 200);

  const remove = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${orgId}/members/${memberId}`,
    headers: auth(owner),
  });
  assert.equal(remove.statusCode, 200);

  // 移除后立即失去权限
  const afterRemove = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/registrations`, headers: auth(session) });
  assert.equal(afterRemove.statusCode, 404);
});

test('不能移除自己，也不能移除最后一个所有者', async () => {
  const members = await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/members`, headers: auth(owner) });
  const ownerMember = members.json().members.find((m: any) => m.role === 'owner');
  assert.ok(ownerMember);

  const removeSelf = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${orgId}/members/${ownerMember.id}`,
    headers: auth(owner),
  });
  assert.equal(removeSelf.statusCode, 400);
  assert.equal(removeSelf.json().error.code, 'cannot_remove_self');

  const demoteOwner = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${orgId}/members/${ownerMember.id}`,
    headers: auth(owner),
    payload: { role: 'admin' },
  });
  assert.equal(demoteOwner.statusCode, 409);
  assert.equal(demoteOwner.json().error.code, 'last_owner');
});

test('成员只能看到自己所属机构的数据', async () => {
  const { session } = await addMember('隔离检查成员', 'operator');

  const stranger = await loginAsAdmin(app, '另一个机构的人');
  const otherOrg = await createOrg(app, stranger, { name: '完全无关的机构' });

  const cross = await app.inject({
    method: 'GET',
    url: `/api/orgs/${otherOrg.id}/registrations`,
    headers: auth(session),
  });
  assert.equal(cross.statusCode, 404);

  const crossInvite = await app.inject({
    method: 'POST',
    url: `/api/orgs/${otherOrg.id}/invites`,
    headers: auth(session),
    payload: { role: 'operator' },
  });
  assert.equal(crossInvite.statusCode, 404, '不能用 A 机构成员身份操作 B 机构');
});

test('成员能看到同一批报名数据（数据模型未按用户隔离）', async () => {
  const { session } = await addMember('共享数据成员', 'operator');
  const code = await getProjectQrCode(app, owner, orgId, projectId);
  await submit(app, code, { name: '成员可见的报名人', phone: '13800138222' });

  const viaOwner = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations`,
    headers: auth(owner),
  });
  const viaMember = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/registrations`,
    headers: auth(session),
  });
  assert.equal(viaMember.json().total, viaOwner.json().total);
  assert.ok(viaMember.json().total > 0);
});
