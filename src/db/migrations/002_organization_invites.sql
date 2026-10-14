-- 002_organization_invites.sql — 机构成员邀请。
--
-- 为什么需要这张表：微信无法直接拿到「别人的 openid」，所以添加成员不能写成
-- 「输入对方 openid」。正确做法是由 owner 生成一个邀请码发给对方，对方在自己
-- 登录状态下接受邀请，成员关系由此建立——这也让「谁把谁拉进来」是可追溯的。
--
-- 邀请码刻意不允许授予 owner：所有权不是随手可给的东西。

CREATE TABLE organization_invites (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  code             TEXT NOT NULL UNIQUE,
  -- owner 不可通过邀请授予，避免实例的所有权被随意扩散
  role             TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  -- 接受后置为已用；同一码只能被接受一次
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_by       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  accepted_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
  accepted_at      TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_invites_org ON organization_invites (organization_id, status);
CREATE INDEX idx_invites_expire ON organization_invites (expires_at);
