import QRCode from 'qrcode';
import { config, wechatConfigured } from '../config.js';
import { serviceUnavailable } from '../lib/errors.js';
import { getOrCreateOrgCode, getOrCreateProjectCode } from './share-codes.js';
import { getUnlimitedCode } from './wechat.js';

export type QrTarget = 'organization' | 'project';
export type QrMode = 'wechat' | 'preview' | 'unavailable';

export interface QrPayload {
  target: QrTarget;
  code: string;
  page: string;
  scene: string;
  mode: QrMode;
  warning: string | null;
  /** Where the bytes actually point. For wechat mode this is a page path. */
  targetUrl: string | null;
}

export interface QrRender extends QrPayload {
  buffer: Buffer;
  contentType: 'image/png';
}

/**
 * Development allows a clearly-labelled H5 preview code so the whole scan →
 * landing page → submit flow can be exercised without WeChat credentials.
 * Production refuses rather than shipping something that looks like a
 * mini-program code but cannot open one.
 */
const allowPreview = process.env.QR_ALLOW_PREVIEW !== '0' && process.env.NODE_ENV !== 'production';

const PREVIEW_WARNING =
  '当前为开发预览码：扫码打开的是网页预览地址，不是微信小程序码。配置 WX_APPID / WX_APPSECRET 后，本页将自动改为生成真正的小程序码。';

const UNAVAILABLE_MESSAGE =
  '未配置微信小程序凭据，无法生成小程序码。请在服务端设置 WX_APPID 与 WX_APPSECRET。';

export function resolveQrTarget(target: QrTarget, organizationId: string, projectId?: string) {
  if (target === 'organization') {
    const row = getOrCreateOrgCode(organizationId);
    return { code: row.code, page: config.wechat.orgPage };
  }
  if (!projectId) throw serviceUnavailable('缺少项目标识');
  const row = getOrCreateProjectCode(projectId, organizationId);
  return { code: row.code, page: config.wechat.projectPage };
}

export function buildPreviewUrl(target: QrTarget, code: string): string {
  const path = target === 'organization' ? 'o' : 'p';
  return `${config.publicBaseUrl}/preview/${path}/${encodeURIComponent(code)}?t=${encodeURIComponent(config.wechat.previewToken)}`;
}

export function describeQr(target: QrTarget, organizationId: string, projectId?: string): QrPayload {
  const { code, page } = resolveQrTarget(target, organizationId, projectId);
  if (wechatConfigured) {
    return {
      target,
      code,
      page,
      scene: code,
      mode: 'wechat',
      warning: null,
      targetUrl: `${page}?scene=${encodeURIComponent(code)}`,
    };
  }
  if (!allowPreview) {
    // Production without WeChat credentials: say so rather than handing back
    // something that looks like a working code.
    return { target, code, page, scene: code, mode: 'unavailable', warning: UNAVAILABLE_MESSAGE, targetUrl: null };
  }
  return {
    target,
    code,
    page,
    scene: code,
    mode: 'preview',
    warning: PREVIEW_WARNING,
    targetUrl: buildPreviewUrl(target, code),
  };
}

export async function renderQr(
  target: QrTarget,
  organizationId: string,
  projectId?: string,
): Promise<QrRender> {
  const payload = describeQr(target, organizationId, projectId);

  if (payload.mode === 'wechat') {
    const buffer = await getUnlimitedCode({ scene: payload.scene, page: payload.page });
    return { ...payload, buffer, contentType: 'image/png' };
  }

  if (payload.mode === 'unavailable') {
    throw serviceUnavailable(payload.warning ?? '无法生成小程序码', {
      missing: ['WX_APPID', 'WX_APPSECRET'].filter((k) => !process.env[k]),
    });
  }

  const buffer = await QRCode.toBuffer(buildPreviewUrl(target, payload.code), {
    type: 'png',
    width: 1024,
    margin: 4,
    errorCorrectionLevel: 'M',
  });
  return { ...payload, buffer, contentType: 'image/png' };
}
