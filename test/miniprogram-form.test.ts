import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  validateAnswers as serverValidate,
  type FormField,
} from '../src/lib/form.js';

/**
 * 小程序端表单校验与**服务端**规则的一致性测试。
 *
 * miniprogram/utils/form.js 是给用户即时反馈用的副本，服务端会用
 * src/lib/form.ts 再校验一遍。两份实现必须表达同一套规则——否则会出现
 * 「前端放行、后端拒绝」这种最难排查的不一致。
 *
 * 小程序的 utils 是纯 CommonJS，不依赖 wx 运行时，因此可以直接在 Node 里测。
 */
const require = createRequire(import.meta.url);
const client = require('../miniprogram/utils/form.js') as {
  validateAll(fields: any[], answers: any): Record<string, string>;
  cleanAnswers(fields: any[], answers: any): Record<string, unknown>;
};

function field(overrides: Partial<FormField> & { type: FormField['type'] }): FormField {
  return {
    id: 'f1',
    projectId: 'p1',
    key: 'f1',
    label: '字段',
    required: false,
    sortOrder: 0,
    placeholder: null,
    hint: null,
    options: [],
    minLength: null,
    maxLength: null,
    minValue: null,
    maxValue: null,
    ...overrides,
  };
}

/** 两端对一组合法/非法输入的判定必须一致。 */
function assertSameRules(fieldDef: FormField, value: unknown) {
  const answers = { [fieldDef.key]: value };

  const serverResult = serverValidate([fieldDef], answers);
  const clientErrors = client.validateAll([fieldDef], answers);

  const serverFailed = !serverResult.ok;
  const clientFailed = Object.keys(clientErrors).length > 0;

  assert.equal(
    serverFailed,
    clientFailed,
    `两端判定不一致 · 字段=${fieldDef.key}(${fieldDef.type}) 值=${JSON.stringify(value)} · 服务端=${serverFailed ? '拒绝' : '通过'} 客户端=${clientFailed ? '拒绝' : '通过'}`,
  );
}

test('文本类字段：前后端对长度规则的判定一致', () => {
  const def = field({ key: 'name', label: '姓名', type: 'text', minLength: 2, maxLength: 5 });
  for (const value of ['a', 'ab', 'abcde', 'abcdef', '', '  ', '中文名']) {
    assertSameRules(def, value);
  }
});

test('手机号：前后端对号码格式的判定一致', () => {
  const def = field({ key: 'phone', label: '手机号', type: 'phone' });
  for (const value of ['13800138000', '19912345678', '12345', '12345678901', 'abcdefghijk', '', '0571-88886666', '400-820-8820']) {
    assertSameRules(def, value);
  }
});

test('数字：前后端对取值范围与非法值的判定一致', () => {
  const def = field({ key: 'age', label: '年龄', type: 'number', minValue: 5, maxValue: 18 });
  for (const value of [1, 5, 10, 18, 30, 'abc', '', -1, 0]) {
    assertSameRules(def, value);
  }
});

test('多选：前后端对选项合法性与数量限制的判定一致', () => {
  const def = field({
    key: 'sessions',
    label: '场次',
    type: 'checkbox',
    options: ['第一期', '第二期', '第三期'],
  });
  for (const value of [[], ['第一期'], ['第一期', '第二期'], ['第一期', '第九期'], ['第一期', '第一期']]) {
    assertSameRules(def, value);
  }
});

test('单选与下拉：前后端对选项合法性的判定一致', () => {
  const radio = field({ key: 'r', label: '性别', type: 'radio', options: ['男', '女'] });
  const select = field({ key: 's', label: '年级', type: 'select', options: ['一', '二'] });
  for (const value of ['男', '女', '其他', '']) {
    assertSameRules(radio, value);
    assertSameRules(select, value);
  }
});

test('日期：前后端对格式的判定一致', () => {
  const def = field({ key: 'birthday', label: '出生日期', type: 'date' });
  for (const value of ['2016-05-12', '2016-13-45', '2016/05/12', '昨天', '']) {
    assertSameRules(def, value);
  }
});

test('必填：前后端一致，空字符串与空白都不算已填', () => {
  const def = field({ key: 'name', label: '姓名', type: 'text', required: true });
  for (const value of ['', '   ', '张三']) {
    assertSameRules(def, value);
  }
});

test('多选字段的 minLength/maxLength 被复用为选择数量上下限', () => {
  const def = field({
    key: 'sessions',
    label: '场次',
    type: 'checkbox',
    options: ['A', 'B', 'C'],
    minLength: 2,
    maxLength: 3,
  });
  for (const value of [['A'], ['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C', 'A']]) {
    assertSameRules(def, value);
  }
});

test('前后端都拒绝报名表之外的字段', () => {
  const def = field({ key: 'name', label: '姓名', type: 'text' });
  const serverResult = serverValidate([def], { name: '张三', injected: 'x' });
  assert.equal(serverResult.ok, false);
  assert.ok(serverResult.errors.injected);

  const clientErrors = client.validateAll([def], { name: '张三', injected: 'x' });
  assert.ok(clientErrors.injected, '客户端也应提示存在未知字段');
});

test('cleanAnswers 只保留已填写的字段', () => {
  const fields = [
    field({ key: 'name', label: '姓名', type: 'text' }),
    field({ key: 'remark', label: '备注', type: 'textarea' }),
    field({ key: 'sessions', label: '场次', type: 'checkbox', options: ['A'] }),
  ];
  const cleaned = client.cleanAnswers(fields, { name: '张三', remark: '   ', sessions: [] });
  assert.deepEqual(cleaned, { name: '张三' });
});

test('幂等键格式满足服务端约束（至少 8 位）', () => {
  const form = require('../miniprogram/utils/form.js');
  const key = form.newIdempotencyKey();
  assert.ok(typeof key === 'string' && key.length >= 8, `幂等键过短：${key}`);
  // 两次调用不应相同，否则双击提交会被误判成幂等重复
  assert.notEqual(form.newIdempotencyKey(), form.newIdempotencyKey());
});

test('真实场景：训练营表单在两端得到相同的判定', () => {
  const fields: FormField[] = [
    field({ key: 'child_name', label: '学员姓名', type: 'text', required: true, maxLength: 30 }),
    field({ key: 'birthday', label: '出生日期', type: 'date', required: true }),
    field({ key: 'guardian_phone', label: '监护人手机号', type: 'phone', required: true }),
    field({ key: 'age', label: '年龄', type: 'number', required: false, minValue: 8, maxValue: 16 }),
    field({ key: 'sessions', label: '意向场次', type: 'checkbox', required: false, options: ['第一期', '第二期'] }),
  ];

  const cases: Record<string, unknown>[] = [
    { child_name: '赵一鸣', birthday: '2016-05-12', guardian_phone: '13900139001', age: 10, sessions: ['第一期'] },
    { child_name: '', birthday: '2016-05-12', guardian_phone: '13900139001' },
    { child_name: '赵一鸣', birthday: '2016-05-12', guardian_phone: '123' },
    { child_name: '赵一鸣', birthday: '2016-05-12', guardian_phone: '13900139001', age: 30 },
    { child_name: '赵一鸣', birthday: '2016/05/12', guardian_phone: '13900139001' },
  ];

  for (const answers of cases) {
    const serverResult = serverValidate(fields, answers);
    const clientErrors = client.validateAll(fields, answers);
    assert.equal(
      Object.keys(clientErrors).length === 0,
      serverResult.ok,
      `判定不一致：${JSON.stringify(answers)} 服务端=${serverResult.ok ? '通过' : '拒绝'} 客户端=${
        Object.keys(clientErrors).length === 0 ? '通过' : '拒绝'
      }`,
    );
  }
});
