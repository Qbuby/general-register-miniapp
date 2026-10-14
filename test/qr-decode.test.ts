import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jsQRModule from 'jsqr';
import { PNG } from 'pngjs';
import type { FastifyInstance } from 'fastify';
import {
  auth,
  closeTestDb,
  createOrg,
  createProject,
  createTestApp,
  loginAsAdmin,
  removeTestDir,
  type Session,
} from './helpers.js';

/** jsqr 是 CommonJS 包，ESM 默认导入拿到的是模块对象。 */
const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ??
  jsQRModule) as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

/**
 * 真正把生成的二维码 PNG 解码回文本。
 *
 * 其他测试只断言「返回了一张 PNG」和「字节数够大」，那并不能证明这张图
 * 真的能被扫出来——payload 写错、编码方式不对、对比度不足，字节数都照样正常。
 * 这里用独立的解码库反解一遍，断言它指向的确实是预期的落地地址。
 *
 * 依赖 jsQR + pngjs（均为纯 JS，仅测试期使用）。
 */
let app: FastifyInstance;
let owner: Session;
let orgId: string;
let projectA: Record<string, any>;
let projectB: Record<string, any>;

function decodePng(buffer: Buffer): { text: string; width: number; height: number } {
  const png = PNG.sync.read(buffer);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return { text: result ? result.data : '', width: png.width, height: png.height };
}

async function fetchQrPng(path: string, token: string) {
  const response = await app.inject({
    method: 'GET',
    url: `${path}?token=${encodeURIComponent(token)}`,
    headers: auth({ token, userId: '', nickname: '' } as Session),
  });
  assert.equal(response.statusCode, 200, `二维码获取失败：${response.statusCode} ${response.body}`);
  assert.equal(response.headers['content-type'], 'image/png');
  return response.rawPayload;
}

before(async () => {
  app = await createTestApp();
  owner = await loginAsAdmin(app, '二维码解码校验');
  orgId = (await createOrg(app, owner, { name: '解码校验机构', status: 'published' })).id;
  projectA = await createProject(app, owner, orgId, { title: '解码项目甲', status: 'published' });
  projectB = await createProject(app, owner, orgId, { title: '解码项目乙', status: 'published' });
});

after(async () => {
  await app.close();
  await closeTestDb();
  removeTestDir();
});

test('机构二维码能解码出正确的落地地址', async () => {
  const meta = (await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode`, headers: auth(owner) })).json();
  const png = await fetchQrPng(meta.imageUrl, owner.token);
  const decoded = decodePng(png);

  assert.ok(decoded.text, '二维码必须能被解码，当前无法识别');
  assert.equal(decoded.width, 1024, '应按 1024px 输出以保证打印清晰度');
  assert.ok(
    decoded.text.includes(`/preview/o/${meta.qr.code}`),
    `解码内容应指向机构主页，实际：${decoded.text}`,
  );
  assert.ok(decoded.text.startsWith('http'), `应为绝对地址，实际：${decoded.text}`);
});

test('每个项目的二维码解码后指向各自的项目详情页', async () => {
  const codeA = (await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${projectA.id}/qrcode`,
    headers: auth(owner),
  })).json().qr.code;
  const codeB = (await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${projectB.id}/qrcode`,
    headers: auth(owner),
  })).json().qr.code;

  const textA = decodePng(await fetchQrPng(`/api/orgs/${orgId}/projects/${projectA.id}/qrcode.png`, owner.token)).text;
  const textB = decodePng(await fetchQrPng(`/api/orgs/${orgId}/projects/${projectB.id}/qrcode.png`, owner.token)).text;

  assert.ok(textA.includes(`/preview/p/${codeA}`), `项目甲二维码指向错误：${textA}`);
  assert.ok(textB.includes(`/preview/p/${codeB}`), `项目乙二维码指向错误：${textB}`);
  assert.notEqual(textA, textB, '不同项目的二维码内容必须不同');
  assert.ok(!textA.includes(codeB), '项目甲的码不得混入项目乙的标识');
  assert.ok(!textB.includes(codeA), '项目乙的码不得混入项目甲的标识');
});

test('解码出的地址可以直接打开对应的页面', async () => {
  const meta = (await app.inject({ method: 'GET', url: `/api/orgs/${orgId}/qrcode`, headers: auth(owner) })).json();
  const decoded = decodePng(await fetchQrPng(meta.imageUrl, owner.token));

  // 从解码结果里取出路径，直接请求——模拟「扫码后真的能打开」
  const url = new URL(decoded.text);
  const page = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
  assert.equal(page.statusCode, 200, '扫码落地地址应能打开');
  assert.ok(page.body.includes('解码校验机构'), '落地页应渲染出该机构');

  const projectMeta = (await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${projectA.id}/qrcode`,
    headers: auth(owner),
  })).json();
  const projectUrl = new URL(
    decodePng(await fetchQrPng(`/api/orgs/${orgId}/projects/${projectA.id}/qrcode.png`, owner.token)).text,
  );
  const projectPage = await app.inject({ method: 'GET', url: `${projectUrl.pathname}${projectUrl.search}` });
  assert.equal(projectPage.statusCode, 200);
  assert.ok(projectPage.body.includes('解码项目甲'), '项目落地页应渲染出该项目');
  void projectMeta;
});

test('连续多次获取返回的是可解码的同一张码（印刷品可重复使用）', async () => {
  const url = `/api/orgs/${orgId}/projects/${projectA.id}/qrcode.png`;
  const first = decodePng(await fetchQrPng(url, owner.token));
  const second = decodePng(await fetchQrPng(url, owner.token));
  const third = decodePng(await fetchQrPng(url, owner.token));

  assert.ok(first.text && second.text && third.text);
  assert.equal(first.text, second.text);
  assert.equal(second.text, third.text);
  assert.equal(first.width, 1024, '每次生成的分辨率都必须足够打印');
});

test('分享码在二维码中完整无损（未被截断）', async () => {
  const meta = (await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${projectB.id}/qrcode`,
    headers: auth(owner),
  })).json();
  const decoded = decodePng(await fetchQrPng(`/api/orgs/${orgId}/projects/${projectB.id}/qrcode.png`, owner.token));

  // 分享码出现在解码文本中必须是完整的一段，不能因为长度被截断
  assert.ok(decoded.text.includes(meta.qr.code), `分享码不完整：${decoded.text}`);
  assert.ok(meta.qr.code.length >= 10 && meta.qr.code.length <= 32, '分享码长度需适配微信 scene 上限');
});
