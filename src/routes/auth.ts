import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, wechatConfigured } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { signToken } from '../lib/token.js';
import { code2Session } from '../services/wechat.js';
import { createDevUser, toUserDto, upsertUserByOpenid } from '../services/users.js';
import { requireUser } from '../plugins/auth.js';
import { listUserOrganizations } from '../lib/tenant.js';
import { toOrganizationDto } from '../services/organizations.js';
import { wechatStatus } from '../services/wechat.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * WeChat login. The mini program sends the one-time `wx.login` code; the
   * AppSecret stays here and only a session token is returned.
   */
  app.post('/api/auth/wechat/login', async (request) => {
    const body = z
      .object({ code: z.string().trim().min(1).max(200) })
      .safeParse(request.body ?? {});
    if (!body.success) throw badRequest('缺少登录凭证');
    if (!wechatConfigured) {
      throw badRequest(
        '服务端尚未配置微信小程序凭据（WX_APPID / WX_APPSECRET），无法完成微信登录。开发环境可使用 POST /api/auth/dev-login。',
        'wechat_not_configured',
      );
    }
    const session = await code2Session(body.data.code);
    const user = upsertUserByOpenid(session.openid, session.unionid);
    return {
      token: signToken(user.id, user.token_version),
      user: toUserDto(user),
    };
  });

  /**
   * Development-only login. Guarded by AUTH_DEV_MODE, which is forced off when
   * NODE_ENV=production, so this can never be reached on a live deployment.
   */
  app.post('/api/auth/dev-login', async (request) => {
    if (!config.auth.devMode || process.env.NODE_ENV === 'production') {
      throw badRequest('开发登录未启用', 'dev_login_disabled');
    }
    const body = z
      .object({ nickname: z.string().trim().min(1).max(30).default('机构管理员') })
      .safeParse(request.body ?? {});
    if (!body.success) throw badRequest('参数不正确');
    const user = createDevUser(body.data.nickname);
    return {
      token: signToken(user.id, user.token_version),
      user: toUserDto(user),
      notice: '开发登录：未接入微信开放平台，仅用于本地联调',
    };
  });

  app.get('/api/me', async (request) => {
    const user = requireUser(request);
    return {
      user: toUserDto(user),
      organizations: listUserOrganizations(user.id).map(toOrganizationDto),
    };
  });

  app.get('/api/config', async () => ({
    wechat: wechatStatus(),
    devLogin: config.auth.devMode && process.env.NODE_ENV !== 'production',
    projectPages: {
      organization: config.wechat.orgPage,
      project: config.wechat.projectPage,
    },
  }));
}
