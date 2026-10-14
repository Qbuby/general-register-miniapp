# 通用机构招生报名小程序

一个统一的微信小程序服务多家机构。机构在其中创建自己的主页、发布多个招生项目、
配置各自的报名表、打印两级二维码，并在小程序内管理收到的报名信息。

一个机构发布什么项目、报名人填什么字段，全部由机构自己配置；系统不绑定任何
具体行业，也没有「课程/课时/排课」这类教务系统概念。

**当前仓库为全新项目（此前目录为空），全部代码为本次实现。**

---

## 目录

- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [核心概念](#核心概念)
- [配置项](#配置项)
- [数据库结构](#数据库结构)
- [接口一览](#接口一览)
- [二维码](#二维码)
- [测试](#测试)
- [部署](#部署)
- [已知限制](#已知限制)

---

## 快速开始

环境要求：**Node.js ≥ 22.5**（使用内置 `node:sqlite`，无需任何原生编译）。

```bash
npm install                # 安装依赖
cp .env.example .env       # 首次运行复制配置（Windows: copy .env.example .env）
npm run seed               # 可选：写入两家机构的演示数据，会打印各项目的分享码
npm start                  # 启动服务，默认 http://localhost:3000
```

打开小程序：用微信开发者工具导入 `miniprogram/` 目录（`project.config.json` 里
把 `appid` 换成你自己的），然后把 `miniprogram/config.js` 的 `baseUrl` 指向本服务。
开发者工具中勾选「不校验合法域名」即可联调。

服务启动后访问根路径 `/` 会看到一个服务索引页，说明当前模式与各入口。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动服务 |
| `npm run dev` | 带热重载启动 |
| `npm test` | 运行自动化测试（60 项） |
| `npm run smoke` | 对运行中的服务做端到端验证（43 项，需先 `npm start`） |
| `npm run seed` | 写入演示数据 |
| `npm run migrate` | 只执行数据库迁移 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build` | 编译到 `dist/` |
| `node scripts/check-miniprogram.mjs` | 小程序静态自检（事件绑定、组件路径、页面完整性） |

---

## 项目结构

```
src/                        后端服务（Node + TypeScript + Fastify）
  app.ts                    应用装配、错误处理
  index.ts                  启动入口
  config.ts                 环境变量
  db/
    index.ts                node:sqlite 封装、事务、迁移执行器
    migrations/001_init.sql 数据库结构
  lib/
    form.ts                 动态报名表的类型定义与服务端校验引擎
    tenant.ts               多租户访问控制（唯一的租户闸门）
    token.ts                会话 token 签发与校验
    csv.ts                  CSV 生成（含 BOM 与公式注入防护）
    errors.ts               统一错误类型
  services/
    organizations.ts        机构与成员
    projects.ts             项目与报名状态判定
    forms.ts                报名表定义替换
    registrations.ts        报名提交（事务 + 人数上限）、列表、导出、统计
    share-codes.ts          稳定分享码
    qr.ts                   二维码生成（微信小程序码 / 开发预览码）
    wechat.ts               微信登录与 access_token（服务端专用）
    users.ts                用户
  routes/
    public.ts               公众端接口
    org.ts                  机构工作台接口
    auth.ts                 登录
    preview.ts              开发预览页（服务端渲染）
  plugins/auth.ts           登录态注入

miniprogram/                微信小程序（原生，无构建步骤）
  app.js / app.json / app.wxss
  config.js                 小程序本地配置（只放公开信息）
  utils/                    request / session / form / format
  components/form-field/    动态报名字段渲染组件
  pages/
    org-home/               公众：机构主页
    project-detail/         公众：项目详情 + 报名表
    register-success/       公众：报名结果
    mine/                   我的（机构入口）
    workbench/              机构工作台
    org-edit/               机构资料
    project-edit/           项目编辑 + 报名表配置器
    registrations/          报名记录管理
    qrcode/                 二维码查看与保存

test/                       自动化测试
scripts/                    seed / smoke / 小程序静态检查
docs/                       补充文档
```

---

## 核心概念

### 多租户

一个系统服务多家机构。每条租户数据都带 `organization_id`，权限只从**登录用户的
成员关系**推导，绝不从客户端传入的机构 ID 推导。

关键实现是 `src/lib/tenant.ts` 里的 `requireMembership()`：所有 `/api/orgs/:orgId/*`
接口都必须先过这一关。它每次都**重新读数据库**确认成员关系（而不是信任 token 里
的信息），因此撤销成员资格立即生效；没有成员关系时返回 **404 而不是 403**，
因为 403 等于告诉对方「这个机构存在」。

即便如此，查询本身也带租户条件（`WHERE id = ? AND organization_id = ?`），
租户过滤写在 SQL 里面，而不是先查出来再判断。

### 成员与角色

多租户权限挂在 `organization_members` 上，而不是某个全局管理员账号。
创建机构的人自动成为 `owner`，之后可通过邀请码添加成员：

| 角色 | 权限 |
| --- | --- |
| `owner` 所有者 | 全部权限，**唯一**可以管理成员、生成/撤销邀请的角色 |
| `admin` 管理员 | 编辑机构资料、项目、报名表；查看报名与二维码 |
| `operator` 运营 | 查看与处理报名记录、查看二维码；不能改资料和项目 |

约束：邀请码**不能授予 owner**；不能移除或降级唯一的所有者；不能移除自己。
邀请码 7 天过期、单次使用、可撤销。

### 报名表

每个项目独立配置报名表，字段类型包括单行文本、多行文本、手机号、数字、单选、多选、
下拉、日期。

字段有两个身份：

- **`field_key`** —— 稳定的机器标识，决定答案归属于哪个问题。改名、改顺序都不会
  让历史数据错位。
- **`label`** —— 展示给用户看的名称，随便改。

提交时服务端会把**当时的整份表单定义**写入 `registrations.form_snapshot`，
答案写入 `answers`（按 `field_key` 索引）。之后机构再怎么改表单，历史报名记录的
含义都不会变。这是本项目相对参考项目的一处补强——被参考的几个开源项目都只存了一份
JSON 答案，改表单会让历史记录失去可读性。

### 二维码与稳定分享码

每个机构、每个项目各有一个 12 位不透明分享码，**一经生成永不更换**。
二维码里放的是分享码，不是机构 ID，也不是任何凭证。

扫码后所有状态都在**扫码那一刻**重新判定：项目下架、报名截止、人数已满、未发布，
都会打开同一个详情页并显示具体原因，而不是报错或空白。

详见 [docs/QR-CODES.md](docs/QR-CODES.md)。

### 报名提交的事务顺序

`src/services/registrations.ts` 的 `submitRegistration()` 顺序是：

1. 用分享码解析出机构和项目（纯查询，不授权）
2. `BEGIN IMMEDIATE` —— 立即拿到写锁
3. 幂等键命中已有记录 → 直接返回原记录（重复点击不会产生第二条）
4. 在锁内重新读取项目行，判定发布状态、报名窗口、人数上限
5. 载入当前表单定义，用**服务端**规则校验答案（不信任前端）
6. 插入报名记录，并把 `registered_count + 1`
7. `COMMIT`

人数上限比较的是**同一事务内维护的计数器**，而不是 `COUNT(*)`。
`BEGIN IMMEDIATE` 让「检查」和「写入」之间不可能插入其他写入
（Postgres 下等价于 `SELECT ... FOR UPDATE` 锁住项目行）。
数据库上还有一条 `UNIQUE(project_id, user_id)` 部分索引作为「一个微信用户一个名额」
的第二道防线，唯一键冲突会被翻译成「您已报名过该项目」而不是 500。

测试里有一条用例会**同时发起 30 次提交**去抢 5 个名额，断言恰好 5 条成功、25 条
返回「人数已满」，并且数据库里的实际条数同样是 5。

---

## 配置项

全部配置见 [.env.example](.env.example)。生产环境**必须**设置：

| 变量 | 说明 |
| --- | --- |
| `TOKEN_SECRET` | 会话 token 签名密钥，至少 16 位；生产环境缺失时服务直接拒绝启动 |
| `PUBLIC_BASE_URL` | 对外 https 域名 |
| `WX_APPID` / `WX_APPSECRET` | 微信小程序凭据，**只存在于服务端** |

小程序页面路径必须与服务端一致，否则小程序码会指向不存在的页面：

- `WX_ORG_PAGE` ↔ `miniprogram/pages/org-home/index`
- `WX_PROJECT_PAGE` ↔ `miniprogram/pages/project-detail/index`

---

## 数据库结构

7 张表，见 `src/db/migrations/001_init.sql`：

| 表 | 作用 |
| --- | --- |
| `users` | 微信用户；`token_version` 可一次性作废全部 token |
| `organizations` | 机构资料与主页状态（draft / published / hidden） |
| `organization_members` | 机构成员与角色（owner / admin / operator） |
| `projects` | 项目；展示状态与报名开关分开，含人数上限与计数器 |
| `form_fields` | 当前报名表定义；`field_key` 稳定标识 |
| `registrations` | 报名记录；含表单快照、答案、状态、幂等键 |
| `share_codes` | 机构与项目的稳定分享码 |
| `audit_logs` | 导出等敏感操作留痕 |

数据库使用 SQLite（`node:sqlite`，零原生依赖）。迁移在服务启动时自动执行。

---

## 接口一览

### 公众端（无需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/public/organizations/:code` | 机构主页（仅已发布项目） |
| GET | `/api/public/projects/:code` | 项目详情 + 当前表单 + 报名状态 |
| POST | `/api/public/projects/:code/registrations` | 提交报名 |
| GET | `/api/public/receipts/:receiptCode` | 报名回执（不返回联系方式） |

### 登录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/wechat/login` | `wx.login` code 换会话 token |
| POST | `/api/auth/dev-login` | 开发登录（`AUTH_DEV_MODE`，生产强制关闭） |
| GET | `/api/me` | 当前用户与其机构 |

### 机构工作台（需成员权限）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/orgs` | 我的机构 / 创建机构 |
| GET / PATCH | `/api/orgs/:orgId` | 机构资料 |
| GET | `/api/orgs/:orgId/members` | 成员列表（含各角色权限说明） |
| POST / GET | `/api/orgs/:orgId/invites` | 生成 / 查看邀请（仅 owner） |
| DELETE | `/api/orgs/:orgId/invites/:inviteId` | 撤销邀请（仅 owner） |
| PATCH / DELETE | `/api/orgs/:orgId/members/:memberId` | 调整角色 / 移出（仅 owner） |
| GET / POST | `/api/invites/:code` · `/accept` | 预览并接受邀请（接受需登录） |
| GET | `/api/orgs/:orgId/stats` | 报名统计 |
| GET / POST | `/api/orgs/:orgId/projects` | 项目列表 / 创建项目 |
| GET / PATCH | `/api/orgs/:orgId/projects/:projectId` | 项目详情 / 修改 |
| GET / PUT | `/api/orgs/:orgId/projects/:projectId/form` | 报名表读取 / 整体替换 |
| GET | `/api/orgs/:orgId/registrations` | 报名列表（支持 `q`、`status`、`projectId`、分页） |
| GET | `/api/orgs/:orgId/registrations/:registrationId` | 单条详情 |
| PATCH | `/api/orgs/:orgId/registrations/:registrationId` | 标记状态 |
| GET | `/api/orgs/:orgId/registrations/export.csv` | 导出 CSV |
| GET | `/api/orgs/:orgId/qrcode` / `.png` | 机构二维码 |
| GET | `/api/orgs/:orgId/projects/:projectId/qrcode` / `.png` | 项目二维码 |

---

## 二维码

- 每个机构一个「机构主页码」，每个项目一个「项目详情码」，两级独立。
- 分享码稳定不变，重复获取只重新出图，不换码，印刷品长期有效。
- 配置了 `WX_APPID` / `WX_APPSECRET` 时走微信官方 `getwxacodeunlimit`，
  生成真正的小程序码，宽度 1280px 满足印刷。
- **未配置微信凭据时不会伪装成功**：开发环境下接口返回 `mode: "preview"` 并附带
  `warning`，PNG 响应头带 `X-QR-Mode: preview`，小程序工作台也会显示醒目提示。
  **生产环境**（`NODE_ENV=production`）下预览码被禁用，元数据接口与图片接口**都**
  返回 503 并说明缺少哪些环境变量——不存在「线上返回一个扫不开的码」这种情况。
  这条行为有专门的测试锁定：`test/qr-production.test.ts`。

详见 [docs/QR-CODES.md](docs/QR-CODES.md)。

---

## 测试

```bash
npm test     # 60 项：多租户隔离、动态表单、名额并发、导出、二维码
npm run smoke  # 43 项：对真实 HTTP 服务跑验收场景 A–G
```

自动化测试覆盖的重点：

- **租户隔离**：机构 B 用伪造机构 ID、项目 ID、组合 ID、分享码去访问/修改/导出
  机构 A 的数据，全部被拒；未登录与伪造 token 被拒。
- **动态表单**：两个项目两套表单、必填/类型/选项/范围校验、提交多余字段被拒。
- **历史数据**：改名 + 改顺序 + 删字段 + 加字段之后，历史快照与答案保持原样。
- **名额控制**：30 个并发请求抢 5 个名额，恰好 5 成功。
- **重复提交**：幂等键重复提交返回同一条记录；同一微信用户重复报名被拒。
- **状态门禁**：下架 / 未发布 / 已截止 / 未开始 / 已暂停 / 已满，全部在服务端拦截。
- **二维码**：稳定性、目标映射、跨机构不可取、已下架扫码仍能打开并说明原因。
- **导出**：真实数据、按各项目表单生成列、已删除的历史字段仍导出、公式注入被转义。

详见 [docs/TESTING.md](docs/TESTING.md)。

---

## 部署

### Docker（推荐）

仓库自带 `Dockerfile` 与 `docker-compose.yml`，四阶段构建，运行层不含编译工具链与开发依赖：

```bash
cp .env.example .env      # 至少填 TOKEN_SECRET
docker compose up -d --build
curl http://localhost:3000/api/health
```

关键约定：

- 基础镜像 `node:24-slim`（需要 `node:sqlite`，即 Node ≥ 22.5）。
- 构建阶段执行 `npm run build`，其中包含 `scripts/copy-assets.mjs`——
  **`tsc` 不会搬运 `.sql` 迁移文件**，少了这一步容器启动即失败。
- 以非 root 的 `node` 用户运行，`/app/data` 声明为卷，SQLite 数据持久化。
- `TOKEN_SECRET` / `WX_APPID` / `WX_APPSECRET` 全部运行时注入，镜像里不含任何机密。
- compose 文件对 `TOKEN_SECRET` 做了必填校验，缺失时直接报错而不是让容器起来后崩。

**国内网络拉取基础镜像**：若 `docker pull` 卡住或 DNS 解析异常，可先走镜像加速器
拉取再打回标准标签，Dockerfile 无需改动：

```bash
docker pull docker.m.daocloud.io/library/node:24-slim
docker tag  docker.m.daocloud.io/library/node:24-slim node:24-slim
docker compose up -d --build
```

### 传统部署

1. 构建：`npm run build && npm run prune --omit=dev`，入口 `dist/index.js`。
2. 设置环境变量：`NODE_ENV=production`、`TOKEN_SECRET`、`PUBLIC_BASE_URL`、
   `WX_APPID`、`WX_APPSECRET`、`PREVIEW_TOKEN`。
3. 挂载持久化目录指向 `DATABASE_FILE`（SQLite 需要持久化存储）。
4. 用进程守护（pm2 / systemd）启动。
5. 微信公众平台配置 request 合法域名，与 `PUBLIC_BASE_URL` 一致。

多实例部署需要注意：当前人数上限的并发保护依赖 SQLite 的写事务，
多实例共享同一个 SQLite 文件不成立。横向扩展前需要把存储换成 Postgres，
把 `BEGIN IMMEDIATE` 换成 `SELECT ... FOR UPDATE`（`src/services/registrations.ts`
的注释里标注了这个位置）。

---

## 已知限制

- **微信真实环境未验证**。本机没有可用的微信小程序 AppID 与已备案域名，因此
  `getwxacodeunlimit` 的真实调用、微信登录的 `jscode2session`、以及小程序内的
  真机扫码都没有跑过。相关代码已按官方接口实现，但**首次接入时需要你用真实凭据
  验证一次**。未配置凭据时二维码会明确降级为开发预览码，不会假装成功。
- **小程序前端未经真机运行**。`miniprogram/` 的代码通过了语法检查与静态自检
  （事件绑定、组件路径、页面完整性），页面逻辑与后端接口逐一对齐，但没有在
  微信开发者工具和真机上执行过。
- **SQLite 单机**。见上文「部署」。
- **成员之间没有更细的数据权限**。同一机构的成员看到的报名数据完全相同，
  没有「只看我负责的项目」这类划分。角色只区分「能不能改」，
  不区分「能看到谁的数据」。
- **图片只能填 URL**。Logo、封面、项目封面目前是手填图片地址，还没有做小程序端上传。
  对非技术背景的机构经营者来说这是明显的体验短板。
- **报名状态回执**是给报名人看的公开回执，不等于电子票或签到凭证。
- 首版按需求明确不含：在线支付、排课与课时、直播、审批流、电子票核销、
  独立 PC 管理系统、为每家机构单独开发小程序。
