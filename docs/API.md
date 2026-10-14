# 接口文档

所有接口以 `/api` 为前缀，请求与响应均为 `application/json; charset=utf-8`。
时间字段一律 ISO 8601 字符串（`2026-03-01T08:00:00.000Z`）。

## 错误格式

```json
{ "error": { "code": "signup_ended", "message": "报名已截止", "details": null } }
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_input` | 参数不合法，`details.issues` 给出逐字段原因 |
| 400 | `invalid_answers` | 报名资料未通过校验，`details.errors` 为 `{字段key: 提示}` |
| 401 | `unauthorized` | 未登录或 token 失效 |
| 403 | `forbidden` | 已登录但无权限（角色不足） |
| 404 | `not_found` | 不存在**或**不属于当前机构（刻意不区分，避免泄露存在性） |
| 409 | `signup_ended` / `signup_not_started` / `project_full` / `signup_disabled` / `project_unlisted` / `org_unpublished` | 报名被业务规则拦截 |
| 409 | `duplicate_registration` | 同一微信用户重复报名 |
| 503 | `service_unavailable` | 能力未配置（如未配置微信凭据），`details.missing` 列出缺失的环境变量 |

## 认证

登录后拿到 `token`，之后每个请求带：

```
Authorization: Bearer <token>
```

需要认证的接口在收到 401 时应先重新登录再重试一次。
小程序里的 `utils/request.js` 已经封装了这个行为。

## 公众端

### GET /api/public/organizations/:code

机构主页。只返回 `status = 'published'` 的项目；`status = 'draft'` 的机构返回 404。

```json
{
  "code": "njv89b3imfc3",
  "organization": {
    "name": "星辰青少年教育", "logoUrl": null, "coverUrl": null,
    "intro": "...", "contactName": "王老师", "contactPhone": "0571-88886666",
    "wechatId": "xingchenedu", "address": "...", "status": "published"
  },
  "projects": [{
    "id": "prj_...", "title": "少儿编程启蒙班（周末班）",
    "type": "course", "typeLabel": "课程培训",
    "summary": "...", "description": "...",
    "location": "...", "startAt": "...", "endAt": "...",
    "signupStartAt": "...", "signupEndAt": "...",
    "capacity": 20, "remaining": 17, "registeredCount": 3,
    "signupEnabled": true, "allowDuplicate": false,
    "status": "published",
    "signup": "open", "signupReason": null, "canSubmit": true,
    "shareCode": "cun4cc5ywffy"
  }]
}
```

`signup` 取值：`open` / `not_started` / `ended` / `disabled` / `full` / `unlisted` / `org_hidden`。
`signupReason` 是可以直接展示给用户的中文原因。

### GET /api/public/projects/:code

项目详情。**即使项目已下架或已截止也返回 200**，这样扫码进来的用户能看到完整页面
和不可报名的原因。`fields` 始终返回。

### POST /api/public/projects/:code/registrations

```json
{ "answers": { "name": "张三", "phone": "13800138000" }, "idempotencyKey": "mp-xxx" }
```

- `answers` 的键必须是该项目当前表单中的 `field_key`；出现未知键会被拒绝。
- `idempotencyKey` 建议客户端每次填写生成一个，重复提交同一键不会产生第二条记录，
  而是返回原记录并把 `submitted` 置为 `false`。
- 带 `Authorization` 时会参与「一个微信用户一个名额」的判定；不带则只有幂等键保护。

成功返回 201（新建）或 200（幂等命中）：

```json
{
  "receipt": { "id": "reg_...", "receiptCode": "D3SU5CK3", "createdAt": "...", "status": "pending", "contactName": "张三", "submitted": true },
  "project": { "id": "prj_...", "title": "..." },
  "organization": { "name": "...", "contactName": "...", "contactPhone": "...", "wechatId": "...", "address": "..." }
}
```

### GET /api/public/receipts/:receiptCode

按报名编号查询结果，用于结果页。**不返回报名内容，也不回显完整联系方式。**

## 机构工作台

所有接口形如 `/api/orgs/:orgId/...`，需要登录且必须是该机构成员。
越权一律返回 404（不是 403），见 README「多租户」。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/orgs` | 我参与的机构列表（含我的角色） |
| POST | `/api/orgs` | 创建机构，创建者自动成为 `owner` |
| GET | `/api/orgs/:orgId` | 机构资料 + 机构二维码信息 |
| PATCH | `/api/orgs/:orgId` | 修改资料/状态（需 admin） |
| GET | `/api/orgs/:orgId/stats` | 总报名、待处理、项目数、每个项目的报名明细统计 |
| GET | `/api/orgs/:orgId/projects` | 项目列表（含草稿与已下架） |
| POST | `/api/orgs/:orgId/projects` | 创建项目；不传 `fields` 时套用默认姓名/手机号/备注表单 |
| GET | `/api/orgs/:orgId/projects/:projectId` | 项目详情 + 表单 + 项目二维码信息 |
| PATCH | `/api/orgs/:orgId/projects/:projectId` | 修改项目（需 admin） |
| GET | `/api/orgs/:orgId/projects/:projectId/form` | 当前表单定义 |
| PUT | `/api/orgs/:orgId/projects/:projectId/form` | 整体替换表单（需 admin） |
| GET | `/api/orgs/:orgId/registrations` | 报名列表 |
| GET | `/api/orgs/:orgId/registrations/export.csv` | 导出 CSV |
| GET | `/api/orgs/:orgId/registrations/:registrationId` | 单条详情 |
| PATCH | `/api/orgs/:orgId/registrations/:registrationId` | 修改状态 |
| GET | `/api/orgs/:orgId/members` | 成员列表 |
| POST / GET | `/api/orgs/:orgId/invites` | 生成 / 查看邀请（仅 owner） |
| DELETE | `/api/orgs/:orgId/invites/:inviteId` | 撤销邀请（仅 owner） |
| PATCH / DELETE | `/api/orgs/:orgId/members/:memberId` | 调整角色 / 移出（仅 owner） |
| GET / POST | `/api/invites/:code` · `/:code/accept` | 预览并接受邀请（接受需登录） |
| GET | `/api/orgs/:orgId/qrcode` · `.png` | 机构二维码信息 / 图片 |
| GET | `/api/orgs/:orgId/projects/:projectId/qrcode` · `.png` | 项目二维码信息 / 图片 |

### 报名列表查询参数

| 参数 | 说明 |
| --- | --- |
| `projectId` | 按项目筛选 |
| `status` | `pending` / `contacted` / `confirmed` / `rejected` |
| `q` | 在姓名、联系电话、答案 JSON 中模糊搜索 |
| `page` / `pageSize` | 分页，`pageSize` 上限 200 |

返回 `{ total, rows, statusLabels }`，每条记录带 `snapshot`（提交时的表单）与
`answers`（按键索引的答案）。

### 替换表单

`PUT .../form` 的 `fields` 数组里：

- 传 `key` 表示沿用已有字段（改标签、改顺序都不会影响历史数据）；
- 不传 `key` 表示新增字段，服务端生成稳定标识；
- `key` 重复会被拒绝；
- 整个替换在一个事务里完成，同时把 `projects.form_version` 加一。

选择类字段（`radio` / `checkbox` / `select`）必须给 `options`，且不能重复；
非选择类字段给了 `options` 会被拒绝。

### 导出 CSV

- 列 = 固定列（报名编号、报名时间、报名项目、姓名、联系电话、报名状态）
  \+ 当前表单的每个字段一列
  \+ 已经在表单里删掉、但历史报名里出现过的字段（列名后缀「（历史）」）。
- 带 UTF-8 BOM，Excel 直接双击可正确显示中文。
- 以 `=`、`+`、`-`、`@` 开头的单元格会被前置单引号，防止公式注入。
- 响应头 `Cache-Control: no-store`，并写入 `audit_logs`。

### 修改报名状态

`pending` / `contacted` / `confirmed` 占名额，`rejected` 不占。
把一条记录改成 `rejected` 会在同一事务里释放名额（`registered_count - 1`）。

## 健康检查

`GET /api/health` 返回 `{ ok, time, wechat: { configured, appIdMasked } }`。
`appIdMasked` 只回显前 6 位，便于确认配置是否生效而不泄露完整 AppID。


## 成员与邀请

### 角色

| 角色 | 可做 |
| --- | --- |
| `owner` | 全部；且是**唯一**能管理成员与邀请的角色 |
| `admin` | 编辑机构资料、项目、报名表；查看报名与二维码 |
| `operator` | 查看与处理报名记录、查看二维码 |

角色越权返回 403，跨机构返回 404。

### 邀请

微信无法直接取得他人 openid，因此添加成员必须走邀请：

```
POST /api/orgs/:orgId/invites   { "role": "admin" | "operator" }   → 邀请码
POST /api/invites/:code/accept                                      → 成为成员
```

约束（均由服务端强制）：

- 邀请**不能授予 owner**——所有权不是随手可给的东西；
- 邀请码 7 天过期、单次使用、可随时撤销；
- 接受需要登录；接受者成为邀请指定的角色；
- 不能移除或降级唯一的所有者，也不能移除自己。

接受邀请的接口不接受请求体，但允许空 body（服务端已放宽 Fastify 的
空 JSON 解析限制，避免不同客户端的调用方式差异变成莫名其妙的 400）。
