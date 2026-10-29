# 自维护发行版

本仓库为 `zhang2580384/vm2api`，首个独立发行版为 **v2.0.0**，上游基线为 `dofastted/vm2api` 的 **v1.3.226**（`7cd52501c03c03e36493c38e39edc349de7d0c99`）。保留上游版权及 LICENSE。

当前发行版 **v2.4.2** 选择性同步上游 **v1.4.006**（`07edb2cdc0576da1ea9a64bc2d27c00fb4c15aff`），通过 merge 保留双方提交历史。Claude 协议及匹配 payload 保留 v2.0.2 / v1.3.226 兼容实现，不表示与上游完整等价；暂缓项目及验收条件见 [同步记录](UPSTREAM_SYNC_1.4.006.md)。首次独立版本的来源记录保持不变。

## 维护和发布规则

- `main` 为经过 CI 验证的稳定源码；修复和功能使用分支及 PR 合并，不强制覆盖历史。
- `origin` 指向本仓库，`upstream` 指向 `https://github.com/dofastted/vm2api.git`。同步上游前先评估，选择发布基线或独立提交，避免不经验证直接覆盖自有补丁。
- 版本采用三段数字：修复递增补丁号（2.0.1），新增功能递增次版本（2.1.0），不兼容改动递增主版本。上游基线独立记录，不与本仓库版本号混用。
- 发布时同步 `VERSION`、`CHANGELOG.md`、`.env.example` 默认镜像标签、`docs/releases/vX.Y.Z.md`，以及版本接口中的上游基线（基线改变时）。Git 标签必须是 `v` 加 VERSION。
- 先合并通过 CI 的 PR，再创建发布标签。release 工作流重新执行验证；二进制附件和镜像全部成功后才公开 Release。不要移动已发布标签；发布错误用下一个补丁版本纠正。
- 发布会生成 `ghcr.io/zhang2580384/vm2api:vX.Y.Z` 多架构镜像，并生成 amd64/arm64 标签。生产优先固定版本或摘要，不跟随 `edge`。
- 本仓库的 Releases、镜像及面板更新源是本维护分支的正式发行渠道。欢迎 PR 回流；修改与再分发遵循现有 LICENSE，保留上游及贡献者署名，并明确标注发行来源及改动，不将第三方改版标作本仓库正式版。
- 控制面“检查更新”、升级脚本、前端仓库入口及默认镜像均指向本仓库。槽位 OS 镜像保持兼容的上游来源；CLI/kernel payload 独立固定在 `deploy/payload.json`，带尺寸和 SHA-256 校验，不能全局替换仓库地址。
- 发布产物成功不等于生产验收。生产部署另行安排，保留原镜像摘要、Compose、override 及数据备份；分别检查本地健康、公共 HTTPS、账号池和实际业务。禁止把服务器 `.env`、账号、数据库或浏览器 profiles 提交到仓库。

## v2.0.0 补丁来源

| 改动 | 来源及处理 |
| --- | --- |
| GPT 等待队列按账号唤醒 | 上游 PR [#665](https://github.com/dofastted/vm2api/pull/665)，提交 `d994ef0148e4b165e51300595fe46039436c368f`，保留作者和原始改动 |
| 设置改变后的有界唤醒 | 本仓库追加修复：一次广播仅重新检查当时等待的请求，未获取座位不继续传递无账号唤醒；包含满载、增加并发回归测试 |
| 账号密码导入和槽位登录 | 从 [ohno1007 的提交](https://github.com/ohno1007/vm2api/commit/f6512155fe3d6230c4178c4f262408b44f211f06) 提取账号池、加密存储、绑定、密码/TOTP/微软邮箱登录及人工验证码接管；保留来源和作者署名 |
| IPv6 地理位置 | 原自有补丁 `d54e2c2` 的生产代码及测试已经包含在 v1.3.226 基线中，无须重复应用；保留 `KIN_PROXY_GEO_V6_LOOKUP_MODE=control-plane` 配置兼容性 |

ohno1007 的原提交还包含协议、计费、模型指纹、订阅管理等改动；本版不引入这些无关功能。登录辅助模块保留原有内部支持代码，但不开放订阅付费管理或自动 Session 导出接口。v2.4.2 提供官网 Session 页面快捷入口，由操作者在当前槽位网页会话中手动复制。

## 账号密码导入

在导航“智能运维 → 账号凭据”中导入，每批 1–100 个账号：

```text
fixture@outlook.com---mailbox-fixture-password
fixture@example.com----gpt-fixture-password----JBSWY3DPEHPK3PXP
```

两列为微软邮箱登录，三列为 GPT 密码和 TOTP；支持原始 TOTP 密钥、otpauth URI 或 `https://2fa.run/2fa/<密钥>`，链接只在本地解析，不访问第三方取得验证码。示例均为虚构凭据。

导入和绑定不会启动浏览器。选择槽位并明确点击“登录”后才开始授权；首次成功前不自动重新登录。保存的数据使用现有数据库密钥加密，列表不返回密码或 TOTP。设置数据库密钥是必需的，不能通过关闭加密来导入。租户只能查看和使用自己的凭据、操作自己的槽位；只管理调度的 super 角色没有凭据操作权限。

自 v2.0.2，手动登录需要槽位已开机并绑定可用出口，无需开启调度；自动任务仍要求开启调度。验证码或人工验证可通过该槽位的远程屏幕接管；不使用控制面网络代替槽位网络。首次启用空槽位需要明确点击登录，关闭调度的现有槽位不被自动开启。

自 v2.0.1，登录和远程浏览器的语言、时区取所选槽位的 `locale` / `timezone`（旧记录其次取槽位 fingerprint，仍缺少则从槽内 LANG/LC_ALL/TZ 或系统时区解析），不会取控制面或操作者电脑设置。`zh_CN.UTF-8`、`ja_JP.UTF-8` 等转为浏览器语言标签；C/POSIX 没有地区语言，对应 Chromium 英文 `en-US`。浏览器使用槽位原有透明代理网络，显式忽略额外系统代理，不重复叠加 SOCKS。网络必须与绑定出口对应，否则拒绝登录。OAuth 最后换票仍由控制面经所选槽位对应出口执行，本补丁没有改变换票路径。

### 浏览器运行时前提

“导入/保存/绑定”不依赖浏览器。v2.4.1 的显式登录使用原生 Chromium 与 X11 远程操作；自动注册和后台自动重登仍依赖 Playwright 1.64.1。原贡献中的浏览器运行包不在 Git 内，**本版控制面镜像也不附带该大型运行包**。登录时按需准备，或通过槽位详情安装/升级按钮构建匹配发行版、架构和 Python ABI 的 r5 portable 包，支持只读根目录槽位，不关闭只读限制或重建槽位。

提供的 `scripts/build-mailbox-portable.py` 在目标匹配的 Ubuntu / Debian 构建容器中执行：预装 `/opt/kin-mailbox/venv`、Playwright 1.64.1、`/opt/kin-mailbox/browsers` 的 Chromium 及系统依赖后，以 root 执行并将标准输出保存为 tar.gz。直接执行时需保留同目录的 `mailbox-display.py`。图形组件使用发行版官方源码构建；源码不包含账号或 profile。

面板管理的包缓存于 `share/kin-mailbox-runtime/managed/<系统>-<版本>-<架构>-py<Python版本>-1.64.1-r5.tar.gz`，同名 `.json` 记录系统信息、版本和真实 `sha256`。包将校验后放入槽位原有可写 home，保留 profiles。旧手工缓存与 r3/r4 缓存不会代替 r5 包。不要把 Ubuntu 包部署到 Debian 槽位；支持矩阵与实测边界见 [浏览器环境文档](BROWSER_ENVIRONMENT.md)。

## 首次从官方版本切换

官方 1.x 的更新按钮仍查询官方仓库，不能靠它自动发现本仓库的 2.x。首次部署必须明确切换控制面镜像到 `ghcr.io/zhang2580384/vm2api:v2.0.0`，保留现有 Compose override、环境变量、端口和数据挂载。此后 2.x 的更新按钮才使用本仓库 Release 和镜像。

原环境显式设置的 `VM2API_IMAGE` 也应切换。自有更新脚本会对齐镜像仓库，避免只改 tag 后拉取不存在的官方 2.x 镜像。挂载的 IPv6 补丁应先比对内容，再决定是否移除；不要直接删除 override。

## v2.0.2 新增能力

槽位注册与恢复见 [CODEX_REGISTRATION.md](CODEX_REGISTRATION.md)，运行包管理见 [BROWSER_ENVIRONMENT.md](BROWSER_ENVIRONMENT.md)，质量运维配置预览和执行边界见 [OPERATIONS_PREVIEW.md](OPERATIONS_PREVIEW.md)。糖果题原文及判定参考 [ranxi2001/sub2api v2.17.3](https://github.com/ranxi2001/sub2api/tree/v2.17.3)，保留来源说明；门票探针尚未移植。

后续版本已接通真实质量检测、定时任务及独立调度恢复开关，当前行为以 [质量运维说明](OPERATIONS_PREVIEW.md)为准。v2.4.2 的授权后保留窗口、手动关闭与卸载边界见 [发行说明](releases/v2.4.2.md)。

出口网络从显式地址池分配 /24，并避开已有 Docker 网络及宿主路由。站点自有保留范围通过 `KIN_EGRESS_RESERVED_CIDRS` 配置，逗号分隔 IPv4 CIDR；公开版本不内置某一部署的内网拓扑。已有冲突网络会拒绝使用，不自动迁移。内网部署升级前应在私有环境文件设置保留范围。

## v2.3.0 备份与恢复

完整范围、COS / OSS 配置、上传后本地清理、异机扫描恢复及中断处理见 [BACKUP_RESTORE.md](BACKUP_RESTORE.md)。本版新增数据库迁移 `043_backup_remote.sql`；升级前保留可验证的备份，回退程序时恢复匹配版本的数据。备份只包含控制面可见的持久资料，远程节点独立磁盘和未挂载资料需单独保护。
