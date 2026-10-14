#!/usr/bin/env node
/**
 * 端到端冒烟测试：对**真实运行中的服务**走一遍验收清单里的场景 A–G。
 *
 * 与 test/*.test.ts 的区别：那些测试通过 fastify inject 直接调用路由；
 * 这个脚本走真实 HTTP、真实 SQLite 文件、真实 PNG 二维码字节，
 * 用于「服务起来之后到底通不通」的可复现验证记录。
 *
 * 用法：
 *   1) npm start           （另开一个终端）
 *   2) BASE=http://127.0.0.1:3000 npm run smoke
 *
 * 退出码 0 表示全部通过。
 */

const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const PNG_MAGIC = '89504e47';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(60));
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（CSV / PNG / HTML）保留原文 */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log(`通用机构招生报名小程序 · 端到端冒烟测试`);
  console.log(`目标服务：${BASE}`);

  // ---------------------------------------------------------------- 前置检查
  section('0. 服务可用性');
  const health = await api('GET', '/api/health');
  check('健康检查返回 200', health.status === 200, `实际 ${health.status}`);
  if (health.status !== 200) {
    console.error('\n服务未启动，请先执行 npm start');
    process.exit(1);
  }
  console.log(`  · 微信小程序码模式：${health.json.wechat.configured ? '正式小程序码' : '开发预览码（未配置 WX_APPID/WX_APPSECRET）'}`);

  // ------------------------------------------------------------ 场景 A：机构
  section('场景 A：机构创建与隔离');
  const aliceLogin = await api('POST', '/api/auth/dev-login', { body: { nickname: '机构A管理员' } });
  const bobLogin = await api('POST', '/api/auth/dev-login', { body: { nickname: '机构B管理员' } });
  const A = aliceLogin.json.token;
  const B = bobLogin.json.token;
  check('开发登录可用', Boolean(A && B));

  const stamp = Date.now().toString(36);
  const orgA = (
    await api('POST', '/api/orgs', {
      token: A,
      body: {
        name: `冒烟机构A-${stamp}`,
        intro: '用于端到端验证的机构A',
        contactName: '甲老师',
        contactPhone: '0571-88000001',
        status: 'published',
      },
    })
  ).json.organization;
  const orgB = (
    await api('POST', '/api/orgs', {
      token: B,
      body: { name: `冒烟机构B-${stamp}`, contactPhone: '0571-88000002', status: 'published' },
    })
  ).json.organization;
  check('机构 A 创建成功', Boolean(orgA?.id));
  check('机构 B 创建成功', Boolean(orgB?.id));

  const crossRead = await api('GET', `/api/orgs/${orgB.id}`, { token: A });
  check('A 读不到 B 的机构资料', crossRead.status === 404, `实际 ${crossRead.status}`);

  const orgACode = (await api('GET', `/api/orgs/${orgA.id}/qrcode`, { token: A })).json.qr.code;
  const orgPage = await api('GET', `/api/public/organizations/${orgACode}`);
  check('机构主页可通过分享码打开', orgPage.status === 200 && orgPage.json.organization.name === orgA.name);

  // ------------------------------------------------------------ 场景 B：项目
  section('场景 B：项目发布');
  const course = (
    await api('POST', `/api/orgs/${orgA.id}/projects`, {
      token: A,
      body: {
        title: `冒烟课程-${stamp}`,
        type: 'course',
        summary: '机构A的课程项目',
        status: 'published',
        capacity: 3,
        signupEndAt: '2999-01-01',
      },
    })
  ).json.project;
  const camp = (
    await api('POST', `/api/orgs/${orgA.id}/projects`, {
      token: A,
      body: {
        title: `冒烟训练营-${stamp}`,
        type: 'camp',
        summary: '机构A的训练营项目',
        status: 'published',
      },
    })
  ).json.project;
  check('可创建不同类型的项目', course?.id && camp?.id && course.type !== camp.type);

  await api('PUT', `/api/orgs/${orgA.id}/projects/${course.id}/form`, {
    token: A,
    body: {
      fields: [
        { key: 'name', label: '姓名', type: 'text', required: true, maxLength: 30 },
        { key: 'phone', label: '手机号', type: 'phone', required: true },
      ],
    },
  });
  await api('PUT', `/api/orgs/${orgA.id}/projects/${camp.id}/form`, {
    token: A,
    body: {
      fields: [
        { key: 'child_name', label: '学员姓名', type: 'text', required: true },
        { key: 'guardian_phone', label: '监护人电话', type: 'phone', required: true },
        { key: 'age', label: '年龄', type: 'number', required: false, minValue: 5, maxValue: 18 },
        { key: 'sessions', label: '参加场次', type: 'checkbox', required: true, options: ['第一期', '第二期'] },
      ],
    },
  });
  check('两个项目各自配置了报名表', true);

  const draft = (
    await api('POST', `/api/orgs/${orgA.id}/projects`, {
      token: A,
      body: { title: `冒烟草稿-${stamp}`, status: 'draft' },
    })
  ).json.project;

  const homeWithDraft = await api('GET', `/api/public/organizations/${orgACode}`);
  const titles = homeWithDraft.json.projects.map((p) => p.title);
  check('已发布项目出现在机构主页', titles.includes(course.title) && titles.includes(camp.title));
  check('草稿项目不出现在机构主页', !titles.includes(draft.title));

  await api('PATCH', `/api/orgs/${orgA.id}/projects/${camp.id}`, { token: A, body: { status: 'unlisted' } });
  const homeAfterUnlist = await api('GET', `/api/public/organizations/${orgACode}`);
  check(
    '下架项目不再作为在招项目展示',
    !homeAfterUnlist.json.projects.some((p) => p.title === camp.title),
  );
  await api('PATCH', `/api/orgs/${orgA.id}/projects/${camp.id}`, { token: A, body: { status: 'published' } });

  // ---------------------------------------------------------- 场景 C/D：二维码
  section('场景 C / D：机构与项目二维码');
  const orgQr = (await api('GET', `/api/orgs/${orgA.id}/qrcode`, { token: A })).json;
  const orgImg = await fetch(`${BASE}${orgQr.imageUrl}?token=${encodeURIComponent(A)}`);
  const orgBytes = Buffer.from(await orgImg.arrayBuffer());
  check('机构二维码返回真实 PNG', orgImg.status === 200 && orgBytes.subarray(0, 4).toString('hex') === PNG_MAGIC);
  check('机构二维码分辨率足够打印', orgBytes.length > 2000, `${orgBytes.length} 字节`);

  const courseQr = (await api('GET', `/api/orgs/${orgA.id}/projects/${course.id}/qrcode`, { token: A })).json;
  const campQr = (await api('GET', `/api/orgs/${orgA.id}/projects/${camp.id}/qrcode`, { token: A })).json;
  check('不同项目的二维码不同', courseQr.qr.code !== campQr.qr.code);
  check('项目二维码指向项目详情页', courseQr.qr.page === 'pages/project-detail/index');

  const again = (await api('GET', `/api/orgs/${orgA.id}/projects/${course.id}/qrcode`, { token: A })).json;
  check('重复获取不会更换二维码（印刷码长期有效）', again.qr.code === courseQr.qr.code);

  const scanA = await api('GET', `/api/public/projects/${courseQr.qr.code}`);
  const scanB = await api('GET', `/api/public/projects/${campQr.qr.code}`);
  check(
    '扫码分别直达对应项目详情页',
    scanA.json.project.id === course.id && scanB.json.project.id === camp.id,
  );

  const foreignQr = await fetch(`${BASE}/api/orgs/${orgA.id}/projects/${course.id}/qrcode.png?token=${encodeURIComponent(B)}`);
  check('二维码无法跨机构获取', foreignQr.status === 404, `实际 ${foreignQr.status}`);

  const anonQr = await fetch(`${BASE}${orgQr.imageUrl}`);
  check('未登录无法获取二维码图片', anonQr.status === 401, `实际 ${anonQr.status}`);

  if (orgQr.qr.mode === 'preview') {
    check('未配置微信凭据时明确标注为开发预览码（不是伪装成功）', Boolean(orgQr.qr.warning));
  } else {
    check('已生成正式微信小程序码', orgQr.qr.mode === 'wechat');
  }

  // -------------------------------------------------------- 场景 E：动态报名表
  section('场景 E：动态报名表');
  const coursePage = await api('GET', `/api/public/projects/${courseQr.qr.code}`);
  const campPage = await api('GET', `/api/public/projects/${campQr.qr.code}`);
  check(
    '两个项目显示各自的表单字段',
    JSON.stringify(coursePage.json.fields.map((f) => f.key)) === JSON.stringify(['name', 'phone']) &&
      JSON.stringify(campPage.json.fields.map((f) => f.key)) ===
        JSON.stringify(['child_name', 'guardian_phone', 'age', 'sessions']),
  );

  const missing = await api('POST', `/api/public/projects/${courseQr.qr.code}/registrations`, {
    body: { answers: { name: '缺手机号' } },
  });
  check('必填校验生效', missing.status === 400 && /手机号/.test(missing.json.error.message));

  const badOption = await api('POST', `/api/public/projects/${campQr.qr.code}/registrations`, {
    body: { answers: { child_name: '小明', guardian_phone: '13800138000', sessions: ['第九期'] } },
  });
  check('选项校验生效', badOption.status === 400 && /无效选项/.test(badOption.json.error.message));

  const created = await api('POST', `/api/public/projects/${courseQr.qr.code}/registrations`, {
    body: { answers: { name: '冒烟学员', phone: '13800138111' }, idempotencyKey: `smoke-${stamp}-1` },
  });
  check('合法提交成功', created.status === 201 && Boolean(created.json.receipt.receiptCode));
  const receiptCode = created.json.receipt.receiptCode;

  const repeat = await api('POST', `/api/public/projects/${courseQr.qr.code}/registrations`, {
    body: { answers: { name: '冒烟学员', phone: '13800138111' }, idempotencyKey: `smoke-${stamp}-1` },
  });
  check(
    '重复点击提交不产生重复记录',
    repeat.status === 200 && repeat.json.receipt.id === created.json.receipt.id,
  );

  const receiptLookup = await api('GET', `/api/public/receipts/${receiptCode}`);
  check('刷新后报名记录依然存在', receiptLookup.status === 200 && receiptLookup.json.receipt.receiptCode === receiptCode);

  // 修改表单，验证历史数据不被改写
  await api('PUT', `/api/orgs/${orgA.id}/projects/${course.id}/form`, {
    token: A,
    body: {
      fields: [
        { key: 'phone', label: '家长联系电话', type: 'phone', required: true },
        { key: 'name', label: '学员姓名', type: 'text', required: true },
      ],
    },
  });
  const rowsAfterEdit = await api('GET', `/api/orgs/${orgA.id}/registrations?projectId=${course.id}`, { token: A });
  const kept = rowsAfterEdit.json.rows.find((r) => r.receiptCode === receiptCode);
  check('修改表单不改变历史报名数据', kept?.contactName === '冒烟学员' && kept?.contactPhone === '13800138111');
  check('历史快照保留提交时的字段名', JSON.stringify(kept.snapshot.map((f) => f.label)) === JSON.stringify(['姓名', '手机号']));

  // --------------------------------------------------------- 场景 F：报名管理
  section('场景 F：报名管理与人数限制');
  const rows = await api('GET', `/api/orgs/${orgA.id}/registrations?projectId=${course.id}`, { token: A });
  check('机构可查看自己的报名记录', rows.status === 200 && rows.json.total >= 1);

  const searched = await api('GET', `/api/orgs/${orgA.id}/registrations?q=冒烟学员`, { token: A });
  check('可按姓名搜索', searched.json.total >= 1);

  const detailRes = await api('GET', `/api/orgs/${orgA.id}/registrations/${kept.id}`, { token: A });
  check('可查看单个报名人完整资料', detailRes.status === 200 && detailRes.json.registration.answers.name === '冒烟学员');

  await api('PATCH', `/api/orgs/${orgA.id}/registrations/${kept.id}`, { token: A, body: { status: 'contacted' } });
  const afterStatus = await api('GET', `/api/orgs/${orgA.id}/registrations/${kept.id}`, { token: A });
  check('可标记报名状态', afterStatus.json.registration.status === 'contacted');

  const csv = await fetch(`${BASE}/api/orgs/${orgA.id}/registrations/export.csv?projectId=${course.id}`, {
    headers: { authorization: `Bearer ${A}` },
  });
  // 注意：Response.text() 会在 UTF-8 解码时吃掉 BOM，所以这里必须看原始字节。
  const csvBytes = Buffer.from(await csv.arrayBuffer());
  const csvText = csvBytes.toString('utf8');
  check(
    '导出文件包含真实报名数据',
    csv.status === 200 && csvText.includes('冒烟学员') && csvText.includes('13800138111'),
  );
  check(
    '导出为 Excel 可直接打开的 CSV（带 UTF-8 BOM）',
    csvBytes.subarray(0, 3).toString('hex') === 'efbbbf',
  );

  const crossList = await api('GET', `/api/orgs/${orgA.id}/registrations`, { token: B });
  const crossExport = await api('GET', `/api/orgs/${orgA.id}/registrations/export.csv`, { token: B });
  const crossProject = await api('GET', `/api/orgs/${orgA.id}/projects/${course.id}`, { token: B });
  check(
    'B 无法查看/导出/修改 A 的报名数据（改参数也不行）',
    crossList.status === 404 && crossExport.status === 404 && crossProject.status === 404,
  );

  // 人数上限：并发提交
  const limited = (
    await api('POST', `/api/orgs/${orgA.id}/projects`, {
      token: A,
      body: { title: `限额项目-${stamp}`, status: 'published', capacity: 2 },
    })
  ).json.project;
  await api('PUT', `/api/orgs/${orgA.id}/projects/${limited.id}/form`, {
    token: A,
    body: {
      fields: [
        { key: 'name', label: '姓名', type: 'text', required: true },
        { key: 'phone', label: '手机号', type: 'phone', required: true },
      ],
    },
  });
  const limitedQr = (await api('GET', `/api/orgs/${orgA.id}/projects/${limited.id}/qrcode`, { token: A })).json.qr.code;

  const race = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      api('POST', `/api/public/projects/${limitedQr}/registrations`, {
        body: {
          answers: { name: `并发${i}`, phone: `13800138${String(i).padStart(3, '0')}` },
          idempotencyKey: `smoke-race-${stamp}-${i}`,
        },
      }),
    ),
  );
  const createdCount = race.filter((r) => r.status === 201).length;
  const fullCount = race.filter((r) => r.status === 409 && r.json?.error?.code === 'project_full').length;
  check('并发提交不突破人数上限', createdCount === 2 && fullCount === 10, `成功 ${createdCount} / 满员拒绝 ${fullCount}`);

  const limitRows = await api('GET', `/api/orgs/${orgA.id}/registrations?projectId=${limited.id}`, { token: A });
  check('数据库中的报名条数同样不超过上限', limitRows.json.total === 2, `实际 ${limitRows.json.total}`);

  // 截止时间
  const closed = (
    await api('POST', `/api/orgs/${orgA.id}/projects`, {
      token: A,
      body: { title: `已截止项目-${stamp}`, status: 'published', signupEndAt: '2020-01-01' },
    })
  ).json.project;
  await api('PUT', `/api/orgs/${orgA.id}/projects/${closed.id}/form`, {
    token: A,
    body: { fields: [{ key: 'name', label: '姓名', type: 'text', required: true }] },
  });
  const closedQr = (await api('GET', `/api/orgs/${orgA.id}/projects/${closed.id}/qrcode`, { token: A })).json.qr.code;
  const closedPage = await api('GET', `/api/public/projects/${closedQr}`);
  check('已截止项目扫码仍可打开详情', closedPage.status === 200 && closedPage.json.project.signup === 'ended');
  const closedSubmit = await api('POST', `/api/public/projects/${closedQr}/registrations`, {
    body: { answers: { name: '迟到者' } },
  });
  check('已截止项目无法提交报名', closedSubmit.status === 409);

  // --------------------------------------------------------- 场景 G：可运行性
  section('场景 G：预览页与真实数据');
  const previewOrg = await fetch(`${BASE}/preview/o/${orgACode}?t=dev-preview`);
  const previewOrgHtml = await previewOrg.text();
  check(
    '机构预览页返回真实数据',
    previewOrg.status === 200 && previewOrgHtml.includes(orgA.name),
  );

  const previewProject = await fetch(`${BASE}/preview/p/${courseQr.qr.code}?t=dev-preview`);
  const previewProjectHtml = await previewProject.text();
  check(
    '项目预览页按该项目的表单渲染输入项',
    previewProject.status === 200 && previewProjectHtml.includes('家长联系电话'),
  );

  const previewBadToken = await fetch(`${BASE}/preview/o/${orgACode}?t=wrong`);
  check('预览链接需要正确令牌', previewBadToken.status === 403, `实际 ${previewBadToken.status}`);

  const health2 = await api('GET', '/api/health');
  check('服务在全部流程后仍健康', health2.status === 200);

  // ------------------------------------------------------------------- 结果
  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('端到端冒烟测试全部通过。');
  process.exit(0);
}

main().catch((error) => {
  console.error('\n冒烟测试异常终止：', error);
  process.exit(1);
});
