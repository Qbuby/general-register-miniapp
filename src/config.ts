import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function envStr(key: string, fallback = ''): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDir, '..');
const dataDir = path.resolve(rootDir, envStr('DATA_DIR', 'data'));

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  databaseFile: string;
  port: number;
  host: string;
  /** Public origin used when rendering share URLs / preview pages / CSV filenames. */
  publicBaseUrl: string;
  /** HMAC secret for session tokens. MUST be set in production. */
  tokenSecret: string;
  tokenTtlSeconds: number;
  /** WeChat mini program credentials. Never exposed to any client. */
  wechat: {
    appId: string;
    appSecret: string;
    /** Page the unlimited mini-program code opens for an organization code. */
    orgPage: string;
    /** Page the unlimited mini-program code opens for a project code. */
    projectPage: string;
    /** Shared secret appended to preview links so they are not open to the world. */
    previewToken: string;
  };
  auth: {
    /** Allows POST /api/auth/dev-login. Refuses to run in production. */
    devMode: boolean;
  };
  /** Cap on registration answer payload. */
  maxAnswerBytes: number;
  /** Hard cap on CSV rows returned by a single export. */
  maxExportRows: number;
}

function loadDotEnv(): void {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const isProd = envStr('NODE_ENV', 'development') === 'production';

const tokenSecret = envStr('TOKEN_SECRET', '');
if (isProd && tokenSecret.length < 16) {
  throw new Error(
    'TOKEN_SECRET is required in production and must be at least 16 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  );
}

export const config: AppConfig = {
  rootDir,
  dataDir,
  databaseFile: path.resolve(rootDir, envStr('DATABASE_FILE', path.join(dataDir, 'app.db'))),
  port: envInt('PORT', 3000),
  host: envStr('HOST', '0.0.0.0'),
  publicBaseUrl: envStr('PUBLIC_BASE_URL', `http://localhost:${envInt('PORT', 3000)}`).replace(/\/+$/, ''),
  tokenSecret: tokenSecret || 'dev-insecure-secret-do-not-use-in-production',
  tokenTtlSeconds: envInt('TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
  wechat: {
    appId: envStr('WX_APPID', ''),
    appSecret: envStr('WX_APPSECRET', ''),
    orgPage: envStr('WX_ORG_PAGE', 'pages/org-home/index'),
    projectPage: envStr('WX_PROJECT_PAGE', 'pages/project-detail/index'),
    previewToken: envStr('PREVIEW_TOKEN', 'dev-preview'),
  },
  auth: {
    devMode: envBool('AUTH_DEV_MODE', !isProd),
  },
  maxAnswerBytes: envInt('MAX_ANSWER_BYTES', 64 * 1024),
  maxExportRows: envInt('MAX_EXPORT_ROWS', 20000),
};

export const wechatConfigured = Boolean(config.wechat.appId && config.wechat.appSecret);
