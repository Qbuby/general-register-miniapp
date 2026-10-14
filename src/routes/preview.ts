import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { forbidden } from '../lib/errors.js';
import { resolveTarget, findProjectCodes } from '../services/share-codes.js';
import {
  getFormFields,
  listPublishedProjects,
  PROJECT_TYPE_LABELS,
  resolveSignupState,
  toPublicProject,
  type ProjectType,
} from '../services/projects.js';
import { submitRegistration } from '../services/registrations.js';
import { AppError } from '../lib/errors.js';
import { formatDateTime } from '../lib/time.js';
import type { FormField } from '../lib/form.js';

/**
 * Server-rendered preview of the public pages.
 *
 * Two jobs:
 *  1. It is the target of the development QR code, so the scan → landing →
 *     submit flow can be exercised end to end without WeChat DevTools.
 *  2. It renders the same database rows the mini program reads, so what you
 *     verify here is what a WeChat visitor sees.
 *
 * It is not a substitute for the mini program and is never used when
 * WX_APPID/WX_APPSECRET are configured.
 */

const BANNER = `
  <div class="dev-banner">
    开发预览页 · 数据来自真实数据库，但不是微信小程序页面。
    正式环境配置 WX_APPID / WX_APPSECRET 后，生成的将是真正的小程序码。
  </div>`;

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  *{box-sizing:border-box}body{margin:0;font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1c1f23}
  .wrap{max-width:640px;margin:0 auto;padding:0 0 48px}
  .dev-banner{background:#fff4d6;color:#8a6100;padding:10px 16px;font-size:12px;border-bottom:1px solid #ffe6a8}
  .hero{background:#fff;padding:24px 20px;text-align:center}
  .hero img{max-width:100%;border-radius:10px}.logo{width:64px;height:64px;border-radius:50%;object-fit:cover}
  h1{font-size:20px;margin:12px 0 6px}.muted{color:#6b7280;font-size:13px}
  .section{background:#fff;margin-top:10px;padding:16px 20px}
  .card{background:#fff;border-radius:10px;padding:14px;margin:10px 10px 0;border:1px solid #eceef1}
  .card h3{margin:0 0 6px;font-size:16px}.tag{display:inline-block;background:#eef4ff;color:#2b62d9;border-radius:4px;padding:2px 8px;font-size:12px;margin-right:6px}
  .tag.warn{background:#fff1f0;color:#c0392b}.tag.ok{background:#eafaf0;color:#1e8e4e}
  a{color:#2b62d9}
  .field{margin:14px 0}.field label{display:block;font-weight:600;margin-bottom:6px}.req{color:#e5484d}
  input[type=text],input[type=tel],input[type=number],input[type=date],select,textarea{width:100%;padding:10px;border:1px solid #d9dde3;border-radius:8px;font-size:15px;background:#fff}
  textarea{min-height:80px}.opts{display:flex;flex-wrap:wrap;gap:10px}
  .opts label{font-weight:400;display:flex;align-items:center;gap:4px}
  button{width:100%;padding:13px;background:#2b62d9;color:#fff;border:0;border-radius:8px;font-size:16px;margin-top:12px}
  button:disabled{background:#aeb4bd}
  .state{padding:12px 14px;border-radius:8px;background:#fff1f0;color:#c0392b;margin-bottom:12px}
  .state.ok{background:#eafaf0;color:#1e8e4e}
  table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:8px;border-bottom:1px solid #eceef1}
  .kv{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed #eceef1;font-size:14px}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">${BANNER}${body}</div></body>
</html>`;
}

function checkToken(token: string | undefined): void {
  const expected = config.wechat.previewToken;
  if (!expected) return;
  if (token !== expected) throw forbidden('预览链接无效');
}

function renderField(field: FormField): string {
  const name = `f_${field.key}`;
  const label = `<label for="${esc(name)}">${esc(field.label)}${field.required ? ' <span class="req">*</span>' : ''}</label>`;
  const ph = esc(field.placeholder ?? '');
  let control = '';
  switch (field.type) {
    case 'textarea':
      control = `<textarea id="${esc(name)}" name="${esc(name)}" placeholder="${ph}"></textarea>`;
      break;
    case 'phone':
      control = `<input type="tel" id="${esc(name)}" name="${esc(name)}" placeholder="${ph}">`;
      break;
    case 'number':
      control = `<input type="number" id="${esc(name)}" name="${esc(name)}" placeholder="${ph}">`;
      break;
    case 'date':
      control = `<input type="date" id="${esc(name)}" name="${esc(name)}">`;
      break;
    case 'radio':
      control = `<div class="opts">${field.options
        .map((o, i) => `<label><input type="radio" name="${esc(name)}" value="${esc(o)}"> ${esc(o)}</label>`)
        .join('')}</div>`;
      break;
    case 'checkbox':
      control = `<div class="opts">${field.options
        .map((o) => `<label><input type="checkbox" name="${esc(name)}" value="${esc(o)}"> ${esc(o)}</label>`)
        .join('')}</div>`;
      break;
    case 'select':
      control = `<select id="${esc(name)}" name="${esc(name)}"><option value="">请选择</option>${field.options
        .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
        .join('')}</select>`;
      break;
    default:
      control = `<input type="text" id="${esc(name)}" name="${esc(name)}" placeholder="${ph}">`;
  }
  return `<div class="field">${label}${control}${field.hint ? `<div class="muted">${esc(field.hint)}</div>` : ''}</div>`;
}

export async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode);
      return reply.type('text/html; charset=utf-8').send(
        layout('预览页', `<div class="section"><div class="state">${esc(error.message)}</div></div>`),
      );
    }
    app.log.error(error);
    reply.code(500);
    return reply.type('text/html; charset=utf-8').send(
      layout('预览页', `<div class="section"><div class="state">预览页发生错误</div></div>`),
    );
  });

  app.get('/preview/o/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const { t } = request.query as { t?: string };
    checkToken(t);
    const target = resolveTarget(code);
    if (!target || target.project) throw forbidden('链接无效或已失效');
    const org = target.organization;
    if (org.status === 'draft') throw forbidden('该机构主页尚未发布');

    const projects = listPublishedProjects(org.id as string);
    const codeMap = findProjectCodes(projects.map((p) => p.id as string));
    const tokenQuery = `?t=${encodeURIComponent(config.wechat.previewToken)}`;
    const cards = projects
      .map((project) => {
        const signup = resolveSignupState(project, org);
        const projectCode = codeMap.get(project.id as string);
        const link = projectCode
          ? `<a href="/preview/p/${encodeURIComponent(projectCode)}${tokenQuery}">查看详情并报名 →</a>`
          : '<span class="muted">该项目的报名码尚未生成</span>';
        return `<div class="card">
        <h3>${esc(project.title)}</h3>
        <div class="muted">${esc(project.summary || '暂无简介')}</div>
        <div style="margin-top:8px">
          <span class="tag">${esc(PROJECT_TYPE_LABELS[project.type as ProjectType] ?? '其他')}</span>
          <span class="tag ${signup.canSubmit ? 'ok' : 'warn'}">${signup.canSubmit ? '报名中' : esc(signup.reason ?? '暂未开放')}</span>
        </div>
        <div style="margin-top:10px">${link}</div>
      </div>`;
      })
      .join('');

    reply.type('text/html; charset=utf-8');
    return layout(
      org.name,
      `<div class="hero">
        ${org.logo_url ? `<img class="logo" src="${esc(org.logo_url)}" alt="">` : ''}
        <h1>${esc(org.name)}</h1>
        ${org.address ? `<div class="muted">${esc(org.address)}</div>` : ''}
      </div>
      <div class="section"><h3 style="margin-top:0">机构介绍</h3><div class="muted" style="white-space:pre-wrap">${esc(org.intro || '该机构暂未填写介绍')}</div></div>
      <div class="section"><h3 style="margin-top:0">在招项目（${projects.length}）</h3></div>
      ${cards || '<div class="section muted">该机构暂未发布招生项目。</div>'}
      <div class="section">
        <h3 style="margin-top:0">联系方式</h3>
        <div class="kv"><span>联系人</span><span>${esc(org.contact_name ?? '—')}</span></div>
        <div class="kv"><span>联系电话</span><span>${esc(org.contact_phone ?? '—')}</span></div>
        <div class="kv"><span>微信号</span><span>${esc(org.wechat_id ?? '—')}</span></div>
      </div>`,
    );
  });

  app.get('/preview/p/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const { t } = request.query as { t?: string };
    checkToken(t);
    const target = resolveTarget(code);
    if (!target || !target.project) throw forbidden('链接无效或已失效');
    if (target.organization.status === 'draft') throw forbidden('该机构主页尚未发布');

    const project = target.project;
    const signup = resolveSignupState(project, target.organization);
    const fields = getFormFields(project.id as string);
    const dto = toPublicProject(project, signup);

    const rows: string[] = [];
    if (project.start_at) rows.push(`<div class="kv"><span>项目时间</span><span>${esc(formatDateTime(project.start_at))}${project.end_at ? ` — ${esc(formatDateTime(project.end_at))}` : ''}</span></div>`);
    if (project.signup_end_at) rows.push(`<div class="kv"><span>报名截止</span><span>${esc(formatDateTime(project.signup_end_at))}</span></div>`);
    if (project.capacity != null) rows.push(`<div class="kv"><span>人数</span><span>${project.registered_count}/${project.capacity}</span></div>`);
    rows.push(`<div class="kv"><span>报名状态</span><span>${signup.canSubmit ? '报名中' : esc(signup.reason ?? '—')}</span></div>`);

    const form = signup.canSubmit
      ? `<form id="reg-form" class="section">
          ${fields.length === 0 ? '<div class="muted">该机构未配置报名表。</div>' : fields.map(renderField).join('')}
          <div id="form-error" class="state" style="display:none"></div>
          <button type="submit">立即报名</button>
        </form>`
      : `<div class="section"><div class="state">当前不可报名：${esc(signup.reason ?? '状态未知')}</div></div>`;

    reply.type('text/html; charset=utf-8');
    return layout(
      project.title,
      `<div class="hero">
        ${project.cover_url ? `<img src="${esc(project.cover_url)}" alt="">` : ''}
        <h1>${esc(project.title)}</h1>
        <div class="muted">${esc(target.organization.name)}</div>
      </div>
      <div class="section">
        <span class="tag">${esc(dto.typeLabel)}</span>
        ${signup.canSubmit ? '<span class="tag ok">报名中</span>' : `<span class="tag warn">${esc(signup.reason ?? '')}</span>`}
        <div class="muted" style="margin-top:8px;white-space:pre-wrap">${esc(project.summary || '')}</div>
      </div>
      <div class="section">${rows.join('')}</div>
      <div class="section"><h3 style="margin-top:0">项目详情</h3><div class="muted" style="white-space:pre-wrap">${esc(project.description || '暂无详细介绍')}</div></div>
      ${form}
      <script>
        const form = document.getElementById('reg-form');
        if (form) {
          const idempotencyKey = 'prev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
          // 分享码是路径最后一段；预览令牌在查询串里，两者都要带上。
          const shareCode = location.pathname.split('/').filter(Boolean).pop();
          const submitUrl = '/api/preview/' + encodeURIComponent(shareCode) + '/registrations' + location.search;
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const box = document.getElementById('form-error');
            box.style.display = 'none';
            const fd = new FormData(form);
            const answers = {};
            for (const [key, value] of fd.entries()) {
              const field = key.replace(/^f_/, '');
              if (answers[field] === undefined) answers[field] = value;
              else if (Array.isArray(answers[field])) answers[field].push(value);
              else answers[field] = [answers[field], value];
            }
            const btn = form.querySelector('button');
            btn.disabled = true; btn.textContent = '提交中…';
            try {
              const res = await fetch(submitUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answers, idempotencyKey })
              });
              const data = await res.json();
              if (!res.ok) {
                const err = (data.error && data.error.details && data.error.details.errors) || null;
                box.textContent = (data.error && data.error.message) || '提交失败，请稍后重试';
                box.innerHTML += err ? '<ul>' + Object.values(err).map(m => '<li>' + m + '</li>').join('') + '</ul>' : '';
                box.style.display = 'block';
                btn.disabled = false; btn.textContent = '立即报名';
                return;
              }
              form.outerHTML = '<div class="section"><div class="state ok">报名成功！</div>' +
                '<div class="kv"><span>报名编号</span><span>' + data.receipt.receiptCode + '</span></div>' +
                '<div class="kv"><span>报名项目</span><span>' + data.project.title + '</span></div>' +
                '<div class="muted" style="margin-top:8px">请等待机构联系：' + (data.organization.contactPhone || '—') + '</div></div>';
            } catch (err) {
              box.textContent = '网络异常，请重试';
              box.style.display = 'block';
              btn.disabled = false; btn.textContent = '立即报名';
            }
          });
        }
      </script>`,
    );
  });

  /** Submission endpoint used only by the preview page's own form. */
  app.post('/api/preview/:code/registrations', async (request, reply) => {
    const { code } = request.params as { code: string };
    const { t } = request.query as { t?: string };
    checkToken(t);
    const body = (request.body ?? {}) as { answers?: unknown; idempotencyKey?: string };
    const result = submitRegistration({
      code,
      answers: body.answers ?? {},
      userId: null,
      idempotencyKey: body.idempotencyKey ?? null,
      submitIp: request.ip,
    });
    reply.code(result.duplicated ? 200 : 201);
    return {
      receipt: { receiptCode: result.registration.receipt_code, createdAt: result.registration.created_at },
      project: { title: result.project.title },
      organization: { contactPhone: result.organization.contact_phone },
    };
  });
}
