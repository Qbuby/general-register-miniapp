-- 001_init.sql — core schema for the multi-tenant enrollment platform.
--
-- Design notes:
--  * Every tenant-scoped table carries its own organization_id even when it is
--    derivable through a parent, so a JOIN can never silently drop the scope.
--  * form_fields are the *current* form definition. The definition that a
--    registration was submitted against is copied into
--    registrations.form_snapshot, so editing a form never rewrites history.

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  openid         TEXT,
  unionid        TEXT,
  nickname       TEXT NOT NULL DEFAULT '',
  avatar_url     TEXT,
  token_version  INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_users_openid ON users (openid) WHERE openid IS NOT NULL;

-- Session tokens are stateless HMAC tokens; token_version lets us revoke all of
-- them for a user at once (mirrors the "revocable sessions" pattern used by
-- mature multi-tenant products).
CREATE TABLE organizations (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  logo_url       TEXT,
  cover_url      TEXT,
  intro          TEXT NOT NULL DEFAULT '',
  contact_name   TEXT,
  contact_phone  TEXT,
  wechat_id      TEXT,
  address        TEXT,
  -- draft: not reachable publicly; published: publicly reachable; hidden: reachable by code only
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE organization_members (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator')),
  created_at       TEXT NOT NULL,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_members_user ON organization_members (user_id);

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'other'
                    CHECK (type IN ('course', 'camp', 'study_tour', 'competition', 'vocational', 'other')),
  cover_url         TEXT,
  summary           TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  location          TEXT,
  start_at          TEXT,
  end_at            TEXT,
  signup_start_at   TEXT,
  signup_end_at     TEXT,
  capacity          INTEGER CHECK (capacity IS NULL OR capacity > 0),
  -- Visibility of the project itself, independent of whether signups are open.
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unlisted')),
  signup_enabled    INTEGER NOT NULL DEFAULT 1,
  -- When 0, the same WeChat user may only register once per project.
  allow_duplicate   INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  form_version      INTEGER NOT NULL DEFAULT 1,
  -- Denormalized count of seat-consuming registrations, maintained inside the
  -- same transaction as the insert. Capacity is never decided from COUNT(*).
  registered_count  INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_projects_org ON projects (organization_id, status, sort_order);
CREATE INDEX idx_projects_org_signup ON projects (organization_id, signup_enabled);

CREATE TABLE form_fields (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Stable machine identifier. Survives renames of `label`, so historical
  -- answers stay attached to the right question.
  field_key    TEXT NOT NULL,
  label        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN
                 ('text', 'textarea', 'phone', 'number', 'radio', 'checkbox', 'select', 'date')),
  required     INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL,
  placeholder  TEXT,
  hint         TEXT,
  options      TEXT,            -- JSON array of strings, choice types only
  min_length   INTEGER,
  max_length   INTEGER,
  min_value    REAL,
  max_value    REAL,
  created_at   TEXT NOT NULL,
  UNIQUE (project_id, field_key)
);
CREATE UNIQUE INDEX idx_form_fields_order ON form_fields (project_id, sort_order);

CREATE TABLE registrations (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
  form_version      INTEGER NOT NULL,
  form_snapshot     TEXT NOT NULL,   -- JSON array of the field definitions used at submit time
  answers           TEXT NOT NULL,   -- JSON object: field_key -> value
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'contacted', 'confirmed', 'rejected')),
  -- Short human-facing code shown on the success screen and in the workbench.
  receipt_code      TEXT NOT NULL UNIQUE,
  contact_name      TEXT,
  contact_phone     TEXT,
  idempotency_key   TEXT,
  -- Set to the user id when the project forbids duplicate signups, NULL
  -- otherwise. This makes the "one WeChat user, one seat" rule a database
  -- invariant rather than an application-level check that races.
  unique_slot       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_reg_project ON registrations (project_id, created_at);
CREATE INDEX idx_reg_org ON registrations (organization_id, created_at);
CREATE UNIQUE INDEX idx_reg_idempotency
  ON registrations (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_reg_unique_slot
  ON registrations (project_id, unique_slot) WHERE unique_slot IS NOT NULL;

-- Stable, opaque public codes. The code in a printed QR never changes, so a
-- poster stays valid forever; the target's *state* is re-resolved at scan time.
CREATE TABLE share_codes (
  code             TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('organization', 'project')),
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id       TEXT REFERENCES projects (id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_share_org ON share_codes (organization_id) WHERE kind = 'organization';
CREATE UNIQUE INDEX idx_share_project ON share_codes (project_id) WHERE kind = 'project';

-- Exports move personal data out of the system; we keep a record of that.
CREATE TABLE audit_logs (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users (id) ON DELETE SET NULL,
  action           TEXT NOT NULL,
  target_type      TEXT,
  target_id        TEXT,
  meta             TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_audit_org ON audit_logs (organization_id, created_at);
