/**
 * 演示数据：一键生成两家互不相干的机构、多个项目、各不相同的报名表与样例报名记录。
 *
 * 运行：npm run seed
 * 用途：本地联调、演示、以及人工按验收清单走一遍流程。
 */
import { buildApp } from '../src/app.js';
import { getOrCreateOrgCode, getOrCreateProjectCode } from '../src/services/share-codes.js';
import { describeQr } from '../src/services/qr.js';
import { config } from '../src/config.js';
import { closeDb } from '../src/db/index.js';

const app = buildApp({ logger: false });

async function devLogin(nickname: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { nickname } });
  if (res.statusCode !== 200) throw new Error(`dev-login 失败: ${res.body}`);
  return res.json().token as string;
}

async function call(method: any, url: string, token: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} 失败(${res.statusCode}): ${res.body}`);
  return res.json();
}

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function main() {
  console.log('正在写入演示数据…\n');

  // ---------------------------------------------------------- 机构一：教育类
  const eduToken = await devLogin('星辰教育管理员');
  const eduOrg = (
    await call('POST', '/api/orgs', eduToken, {
      name: '星辰青少年教育',
      intro:
        '星辰青少年教育成立于 2016 年，专注 6-15 岁青少年的编程、科学与体适能教育。\n' +
        '我们在杭州设有 3 个校区，累计服务学员超过 6000 人次。',
      contactName: '王老师',
      contactPhone: '0571-88886666',
      wechatId: 'xingchenedu',
      address: '杭州市西湖区文三路 100 号 3 楼',
      status: 'published',
    })
  ).organization;

  const course = (
    await call('POST', `/api/orgs/${eduOrg.id}/projects`, eduToken, {
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
    })
  ).project;
  await call('PUT', `/api/orgs/${eduOrg.id}/projects/${course.id}/form`, eduToken, {
    fields: [
      { key: 'name', label: '学员姓名', type: 'text', required: true, maxLength: 30 },
      { key: 'phone', label: '家长手机号', type: 'phone', required: true },
      { key: 'grade', label: '当前年级', type: 'select', required: true, options: ['大班', '中班', '小班'] },
      { key: 'has_experience', label: '是否有编程基础', type: 'radio', required: false, options: ['有', '没有'] },
      { key: 'remark', label: '其他说明', type: 'textarea', required: false, maxLength: 300 },
    ],
  });

  const camp = (
    await call('POST', `/api/orgs/${eduOrg.id}/projects`, eduToken, {
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
    })
  ).project;
  await call('PUT', `/api/orgs/${eduOrg.id}/projects/${camp.id}/form`, eduToken, {
    fields: [
      { key: 'child_name', label: '学员姓名', type: 'text', required: true },
      { key: 'birthday', label: '出生日期', type: 'date', required: true },
      { key: 'guardian_phone', label: '监护人手机号', type: 'phone', required: true },
      { key: 'age', label: '年龄', type: 'number', required: false, minValue: 8, maxValue: 16 },
      { key: 'sessions', label: '意向场次', type: 'checkbox', required: false, options: ['第一期', '第二期'] },
      { key: 'diet', label: '饮食情况', type: 'select', required: false, options: ['无特殊要求', '素食', '过敏'] },
    ],
  });

  await call('POST', `/api/orgs/${eduOrg.id}/projects`, eduToken, {
    title: '寒假机器人竞赛集训（筹备中）',
    type: 'competition',
    summary: '2025 年冬季赛事的集训课程，方案筹备中。',
    status: 'draft',
  });

  // ---------------------------------------------------------- 机构二：职培类
  const jobToken = await devLogin('城北职培管理员');
  const jobOrg = (
    await call('POST', '/api/orgs', jobToken, {
      name: '城北职业培训中心',
      intro: '专注叉车、电工、焊工等特种作业操作证培训与复审，年培训量 2000 人次以上。',
      contactName: '李老师',
      contactPhone: '0571-85551234',
      wechatId: 'chengbeizy',
      address: '杭州市拱墅区石祥路 589 号',
      status: 'published',
    })
  ).organization;

  const forklift = (
    await call('POST', `/api/orgs/${jobOrg.id}/projects`, jobToken, {
      title: '叉车操作证（N1）培训与考试',
      type: 'vocational',
      summary: '理论与实操一体，培训后可直接在本省参加特种作业考试。',
      description: '理论 32 学时 + 实操 24 学时。费用含教材与考试费。',
      location: '石祥路校区实训场',
      startAt: futureDate(10),
      endAt: futureDate(45),
      signupEndAt: futureDate(8),
      capacity: 40,
      status: 'published',
    })
  ).project;
  await call('PUT', `/api/orgs/${jobOrg.id}/projects/${forklift.id}/form`, jobToken, {
    fields: [
      { key: 'name', label: '姓名', type: 'text', required: true },
      { key: 'phone', label: '手机号', type: 'phone', required: true },
      { key: 'id_tail', label: '身份证后四位', type: 'text', required: true, maxLength: 4, hint: '用于核对报名信息' },
      { key: 'shift', label: '意向班次', type: 'radio', required: true, options: ['白班', '夜班'] },
    ],
  });

  // -------------------------------------------------------------- 样例报名记录
  const courseCode = getOrCreateProjectCode(course.id as string, eduOrg.id as string).code;
  const campCode = getOrCreateProjectCode(camp.id as string, eduOrg.id as string).code;
  const forkliftCode = getOrCreateProjectCode(forklift.id as string, jobOrg.id as string).code;

  const samples = [
    { code: courseCode, answers: { name: '林小满', phone: '13800138001', grade: '中班', has_experience: '没有', remark: '' } },
    { code: courseCode, answers: { name: '陈子豪', phone: '13800138002', grade: '小班', has_experience: '有' } },
    { code: courseCode, answers: { name: '周悦', phone: '13800138003', grade: '大班', has_experience: '没有' } },
    {
      code: campCode,
      answers: {
        child_name: '赵一鸣',
        birthday: '2016-05-12',
        guardian_phone: '13900139001',
        age: 10,
        sessions: ['第一期'],
        diet: '无特殊要求',
      },
    },
    {
      code: campCode,
      answers: {
        child_name: '孙可欣',
        birthday: '2015-11-03',
        guardian_phone: '13900139002',
        age: 11,
        sessions: ['第一期', '第二期'],
        diet: '素食',
      },
    },
    { code: forkliftCode, answers: { name: '刘建军', phone: '13700137001', id_tail: '1234', shift: '白班' } },
  ];

  for (const sample of samples) {
    await app.inject({
      method: 'POST',
      url: `/api/public/projects/${sample.code}/registrations`,
      payload: { answers: sample.answers },
    });
  }

  // ------------------------------------------------------------------ 输出信息
  const eduOrgCode = getOrCreateOrgCode(eduOrg.id as string);
  const jobOrgCode = getOrCreateOrgCode(jobOrg.id as string);

  const print = (title: string, rows: [string, string][]) => {
    console.log(`\n${title}`);
    for (const [label, value] of rows) console.log(`  ${label.padEnd(12, '　')} ${value}`);
  };

  console.log('演示数据写入完成。\n');
  console.log('='.repeat(64));

  print('机构一：星辰青少年教育', [
    ['机构主页码', eduOrgCode.code],
    ['机构预览页', `${config.publicBaseUrl}/preview/o/${eduOrgCode.code}?t=${config.wechat.previewToken}`],
    ['课程分享码', courseCode],
    ['课程预览页', `${config.publicBaseUrl}/preview/p/${courseCode}?t=${config.wechat.previewToken}`],
    ['训练营分享码', campCode],
  ]);

  print('机构二：城北职业培训中心', [
    ['机构主页码', jobOrgCode.code],
    ['机构预览页', `${config.publicBaseUrl}/preview/o/${jobOrgCode.code}?t=${config.wechat.previewToken}`],
    ['叉车培训分享码', forkliftCode],
  ]);

  console.log('\n' + '='.repeat(64));
  console.log('在开发者工具中打开小程序，把 config.js 的 baseUrl 指向本服务即可联调。');
  console.log('若已配置 WX_APPID / WX_APPSECRET，把上面的分享码填入自定义编译条件即可模拟扫码进入。');
  console.log('');
}

main()
  .then(async () => {
    await app.close();
    closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('演示数据写入失败：', error);
    await app.close().catch(() => {});
    closeDb();
    process.exit(1);
  });
