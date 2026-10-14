import { get, run } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';

export interface UserRow {
  id: string;
  openid: string | null;
  unionid: string | null;
  nickname: string;
  avatar_url: string | null;
  token_version: number;
  created_at: string;
  updated_at: string;
}

export function getUser(userId: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
}

export function upsertUserByOpenid(openid: string, unionid: string | null, nickname?: string) {
  const existing = get<UserRow>('SELECT * FROM users WHERE openid = ?', openid);
  const now = nowIso();
  if (existing) {
    if (unionid && existing.unionid !== unionid) {
      run('UPDATE users SET unionid = ?, updated_at = ? WHERE id = ?', unionid, now, existing.id);
    }
    return getUser(existing.id)!;
  }
  const id = newId('usr');
  run(
    `INSERT INTO users (id, openid, unionid, nickname, avatar_url, token_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    id,
    openid,
    unionid,
    nickname ?? '微信用户',
    now,
    now,
  );
  return getUser(id)!;
}

export function createDevUser(nickname: string): UserRow {
  const id = newId('usr');
  const now = nowIso();
  const openid = `dev_${newId()}`;
  run(
    `INSERT INTO users (id, openid, unionid, nickname, avatar_url, token_version, created_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, 1, ?, ?)`,
    id,
    openid,
    nickname,
    now,
    now,
  );
  return getUser(id)!;
}

export function updateProfile(userId: string, nickname?: string | null, avatarUrl?: string | null) {
  if (nickname) run('UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?', nickname, nowIso(), userId);
  if (avatarUrl) run('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?', avatarUrl, nowIso(), userId);
  return getUser(userId)!;
}

export function toUserDto(user: UserRow) {
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
  };
}
