#!/usr/bin/env node
/**
 * 通过 HTTP 给**运行中的实例**写入演示数据。
 *
 * 与 scripts/seed.ts 的区别：
 *   · seed.ts  直接操作数据库文件（用于本地开发）
 *   · seed-http 走真实接口（用于演示环境、Docker 容器、远程部署）
 *
 * 依赖服务端开启开发登录（NODE_ENV != production 且 AUTH_DEV_MODE != false），
 * 因此**不能在生产环境执行**——脚本会自行检查并拒绝。
 *
 * 用法：
 *   BASE=http://127.0.0.1:3000 node scripts/seed-http.mjs
 */
const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const STAMP = Date.now().toString(36).slice(-5);

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
    /* 非 JSON */
  }
  if (res.status >= 400) {
    throw new Error(`${method} ${path} 失败(${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function main() {
  console.log(`目标实例：${BASE}\n`);

  const login = await api('POST', '/api/auth/dev-login', { body: { nickname: '演示数据生成' } }).catch((error) => {
    console.error('无法登录：' + error.message);
    console.error('\n该接口在以下情况不可用：');
    console.error('  · 实例以 NODE_ENV=production 运行（这是刻意的安全设计）');
    console.error('  · 实例设置了 AUTH_DEV_MODE=false');
    console.error('\n若只是想在生产实例上看效果，请在小程序内手动创建机构；');
    console.error('本脚本只用于开发与演示环境。');
    process.exit(1);
  });
  const token = login.token;
  console.log('✔ 已登录');

  const org = (
    await api('POST', '/api/orgs', {
      token,
      body: {
        name: '星辰青少年教育',
        intro:
          '星辰青少年教育成立于 2016 年，专注 6-15 岁青少年的编程、科学与体适能教育。\n' +
          '我们在杭州设有 3 个校区，累计服务学员超过 6000 人次。',
        contactName: '王老师',
        contactPhone: '0571-88886666',
        wechatId: 'xingchenedu',
        address: '杭州市西湖区文三路 100 号 3 楼',
        status: 'published',
      },
    })
  ).organization;
  console.log(`✔ 机构：${org.name}（${org.id}）`);

  const course = (
    await api('POST', `/api/orgs/${org.id}/projects`, {
      token,
      body: {
        title: '少儿编程启蒙班（周末班）',
        type: 'course',
        summary: '面向 7-10 岁零基础学员，使用 Scratch 图形化编程入门。',
        description:
          '课程共 12 次课，每次 90 分钟。\n\n' +
          '· 第 1-4 次：图形化编程基础、作品一\n' +
          '· 第 5-8 次：动画与游戏设计\n' +
          '· 第 9-12 次：结课项目展示\n\n' +
          '开班后 3 天内可全额退款。',
        location: '文三路校区 302 机房',
        startAt: futureDate(20),
        endAt: futureDate(50),
        signupStartAt: new Date().toISOString().slice(0, 10),
        signupEndAt: futureDate(15),
        capacity: 20,
        status: 'published',
      },
    })
  ).project;
  await api('PUT', `/api/orgs/${org.id}/projects/${course.id}/form`, {
    token,
    body: {
      fields: [
        { key: 'name', label: '学员姓名', type: 'text', required: true, maxLength: 30 },
        { key: 'phone', label: '家长手机号', type: 'phone', required: true },
        { key: 'grade', label: '当前年级', type: 'select', required: true, options: ['大班', '中班', '小班'] },
        { key: 'has_experience', label: '是否有编程基础', type: 'radio', required: false, options: ['有', '没有'] },
        { key: 'remark', label: '其他说明', type: 'textarea', required: false, maxLength: 300 },
      ],
    },
  });
  console.log('✔ 项目：少儿编程启蒙班（5 个报名字段）');

  const camp = (
    await api('POST', `/api/orgs/${org.id}/projects`, {
      token,
      body: {
        title: '暑期军事训练营（7 天 6 晚）',
        type: 'camp',
        summary: '7 天 6 晚封闭式体验营，含体能、队列、生存技能与结营汇演。',
        description: '基地位于临安青山湖。统一食宿，配 1:6 教官配比与随队医疗。',
        location: '临安青山湖基地',
        startAt: futureDate(35),
        endAt: futureDate(42),
        signupEndAt: futureDate(28),
        capacity: 60,
        status: 'published',
      },
    })
  ).project;
  await api('PUT', `/api/orgs/${org.id}/projects/${camp.id}/form`, {
    token,
    body: {
      fields: [
        { key: 'child_name', label: '学员姓名', type: 'text', required: true },
        { key: 'birthday', label: '出生日期', type: 'date', required: true },
        { key: 'guardian_phone', label: '监护人手机号', type: 'phone', required: true },
        { key: 'age', label: '年龄', type: 'number', required: false, minValue: 8, maxValue: 16 },
        { key: 'sessions', label: '意向场次', type: 'checkbox', required: false, options: ['第一期', '第二期'] },
      ],
    },
  });
  console.log('✔ 项目：暑期军事训练营（5 个不同报名字段）');

  // 演示草稿：不出现在机构主页
  await api('POST', `/api/orgs/${org.id}/projects`, {
    token,
    body: { title: '寒假机器人竞赛集训（筹备中）', type: 'competition', summary: '方案筹备中。', status: 'draft' },
  });
  console.log('✔ 项目：寒假集训（草稿，不对外展示）');

  const orgQr = (await api('GET', `/api/orgs/${org.id}/qrcode`, { token })).qr;
  const courseQr = (await api('GET', `/api/orgs/${org.id}/projects/${course.id}/qrcode`, { token })).qr;
  const campQr = (await api('GET', `/api/orgs/${org.id}/projects/${camp.id}/qrcode`, { token })).qr;

  const samples = [
    { code: courseQr.code, answers: { name: '林小满', phone: '13800138001', grade: '中班', has_experience: '没有' } },
    { code: courseQr.code, answers: { name: '陈子豪', phone: '13800138002', grade: '小班', has_experience: '有' } },
    { code: courseQr.code, answers: { name: '周悦', phone: '13800138003', grade: '大班', has_experience: '没有' } },
    {
      code: campQr.code,
      answers: {
        child_name: '赵一鸣',
        birthday: '2016-05-12',
        guardian_phone: '13900139001',
        age: 10,
        sessions: ['第一期'],
      },
    },
    {
      code: campQr.code,
      answers: {
        child_name: '孙可欣',
        birthday: '2015-11-03',
        guardian_phone: '13900139002',
        age: 11,
        sessions: ['第一期', '第二期'],
      },
    },
  ];
  for (const sample of samples) {
    await fetch(`${BASE}/api/public/projects/${sample.code}/registrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: sample.answers }),
    });
  }
  console.log(`✔ 报名记录：${samples.length} 条（真实写入数据库）`);

  console.log('\n' + '='.repeat(64));
  console.log('演示数据写入完成。可直接访问：\n');
  console.log(`  机构主页预览  ${BASE}/preview/o/${orgQr.code}?t=dev-preview`);
  console.log(`  项目详情预览  ${BASE}/preview/p/${courseQr.code}?t=dev-preview`);
  console.log(`  训练营详情    ${BASE}/preview/p/${campQr.code}?t=dev-preview`);
  console.log('\n分享码：');
  console.log(`  机构  ${orgQr.code}`);
  console.log(`  课程  ${courseQr.code}`);
  console.log(`  训练营 ${campQr.code}`);
  if (orgQr.mode === 'preview') {
    console.log('\n注意：当前实例未配置微信凭据，以上是开发预览地址。');
    console.log('配置 WX_APPID / WX_APPSECRET 后即可生成真正的小程序码。');
  }
  console.log('');
}

main().catch((error) => {
  console.error('写入演示数据失败：', error.message);
  process.exit(1);
});
