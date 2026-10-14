import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Each test file gets its own throwaway SQLite file.
 *
 * The environment is configured here, at module load, *before* anything
 * imports src/config.js — config reads process.env once at import time, so this
 * file must be the first import of every test file.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-test-'));
process.env.DATABASE_FILE = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'test';
process.env.TOKEN_SECRET = 'test-secret-value-0123456789';
process.env.AUTH_DEV_MODE = '1';
process.env.PREVIEW_TOKEN = 'dev-preview';
process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
process.env.QR_ALLOW_PREVIEW = '1';

export async function createTestApp(): Promise<FastifyInstance> {
  const { buildApp } = await import('../src/app.js');
  return buildApp({ logger: false });
}

export async function closeTestDb(): Promise<void> {
  const db = await import('../src/db/index.js');
  db.closeDb();
}

export function removeTestDir(): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export interface Session {
  userId: string;
  token: string;
  nickname: string;
}

export async function loginAsAdmin(app: FastifyInstance, nickname = '机构管理员'): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    payload: { nickname },
  });
  if (response.statusCode !== 200) {
    throw new Error(`dev-login failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json();
  return { userId: body.user.id, token: body.token, nickname };
}

export function auth(session: Session) {
  return { authorization: `Bearer ${session.token}` };
}

export async function createOrg(
  app: FastifyInstance,
  session: Session,
  payload: Record<string, unknown> = {},
): Promise<{ id: string; name: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    headers: auth(session),
    payload: { name: '测试机构', status: 'published', ...payload },
  });
  if (response.statusCode !== 201) {
    throw new Error(`create org failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().organization;
}

export async function createProject(
  app: FastifyInstance,
  session: Session,
  orgId: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/projects`,
    headers: auth(session),
    payload: { title: '测试项目', ...payload },
  });
  if (response.statusCode !== 201) {
    throw new Error(`create project failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().project;
}

export async function setForm(
  app: FastifyInstance,
  session: Session,
  orgId: string,
  projectId: string,
  fields: Record<string, unknown>[],
): Promise<void> {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/orgs/${orgId}/projects/${projectId}/form`,
    headers: auth(session),
    payload: { fields },
  });
  if (response.statusCode !== 200) {
    throw new Error(`set form failed: ${response.statusCode} ${response.body}`);
  }
}

export async function getQrCode(app: FastifyInstance, session: Session, orgId: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/qrcode`,
    headers: auth(session),
  });
  if (response.statusCode !== 200) {
    throw new Error(`qr failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().qr.code;
}

export async function getProjectQrCode(
  app: FastifyInstance,
  session: Session,
  orgId: string,
  projectId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/projects/${projectId}/qrcode`,
    headers: auth(session),
  });
  if (response.statusCode !== 200) {
    throw new Error(`project qr failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().qr.code;
}

export async function submit(
  app: FastifyInstance,
  code: string,
  answers: Record<string, unknown>,
  options: { token?: string; idempotencyKey?: string } = {},
): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/public/projects/${code}/registrations`,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    payload: { answers, idempotencyKey: options.idempotencyKey },
  });
  return { statusCode: response.statusCode, body: response.json() };
}

export const SIMPLE_FIELDS = [
  { key: 'name', label: '姓名', type: 'text', required: true, maxLength: 30 },
  { key: 'phone', label: '手机号', type: 'phone', required: true },
];

export const CAMP_FIELDS = [
  { key: 'child_name', label: '学员姓名', type: 'text', required: true },
  { key: 'guardian_phone', label: '监护人电话', type: 'phone', required: true },
  { key: 'age', label: '年龄', type: 'number', required: false, minValue: 5, maxValue: 18 },
  {
    key: 'sessions',
    label: '参加场次',
    type: 'checkbox',
    required: true,
    options: ['第一期', '第二期'],
  },
];
