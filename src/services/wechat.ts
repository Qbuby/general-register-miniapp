import { config, wechatConfigured } from '../config.js';
import { serviceUnavailable } from '../lib/errors.js';

/**
 * All WeChat traffic lives here, on the server.
 *
 * WX_APPSECRET never reaches a client: the mini program only ever receives a
 * short-lived session token from /api/auth/wechat/login.
 */

export interface WeChatSession {
  openid: string;
  unionid: string | null;
}

function requireConfig(): void {
  if (!wechatConfigured) {
    throw serviceUnavailable(
      '未配置微信小程序凭据：请在服务端环境变量中设置 WX_APPID 与 WX_APPSECRET 后重启服务',
      { missing: ['WX_APPID', 'WX_APPSECRET'].filter((k) => !process.env[k]) },
    );
  }
}

export async function code2Session(code: string): Promise<WeChatSession> {
  requireConfig();
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', config.wechat.appId);
  url.searchParams.set('secret', config.wechat.appSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');

  const response = await fetch(url, { method: 'GET' });
  const body = (await response.json()) as Record<string, any>;
  if (body.errcode) {
    throw serviceUnavailable(`微信登录失败（${body.errcode}）：${body.errmsg ?? '未知错误'}`);
  }
  if (!body.openid) throw serviceUnavailable('微信登录失败：未返回 openid');
  return { openid: body.openid, unionid: body.unionid ?? null };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  requireConfig();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', config.wechat.appId);
  url.searchParams.set('secret', config.wechat.appSecret);

  const response = await fetch(url, { method: 'GET' });
  const body = (await response.json()) as Record<string, any>;
  if (body.errcode || !body.access_token) {
    cachedToken = null;
    throw serviceUnavailable(`获取微信 access_token 失败（${body.errcode ?? '未知'}）：${body.errmsg ?? ''}`);
  }
  cachedToken = {
    token: body.access_token as string,
    // WeChat returns expires_in in seconds; refresh a minute early.
    expiresAt: Date.now() + Number(body.expires_in ?? 7200) * 1000,
  };
  return cachedToken.token;
}

export function resetAccessTokenCache(): void {
  cachedToken = null;
}

/**
 * getUnlimited — the only mini-program code API that can produce a QR leading
 * to an arbitrary detail page (scene carries our share code, page names the
 * target). Returns raw PNG bytes.
 */
export async function getUnlimitedCode(params: {
  scene: string;
  page: string;
  width?: number;
}): Promise<Buffer> {
  const accessToken = await getAccessToken();
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scene: params.scene,
      page: params.page,
      // false keeps codes working for pages not yet published to the release
      // version, which is what an institution needs while onboarding.
      check_path: false,
      env_version: process.env.WX_ENV_VERSION || 'release',
      width: params.width ?? 1280,
    }),
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  // WeChat answers with a JSON error document instead of an image on failure.
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    let message = '未知错误';
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as Record<string, any>;
      message = `${parsed.errcode ?? '?'} ${parsed.errmsg ?? ''}`.trim();
    } catch {
      message = buffer.toString('utf8').slice(0, 200);
    }
    throw serviceUnavailable(`生成微信小程序码失败：${message}`);
  }
  return buffer;
}

export function wechatStatus() {
  return {
    configured: wechatConfigured,
    appIdMasked: config.wechat.appId ? `${config.wechat.appId.slice(0, 6)}***` : null,
  };
}
