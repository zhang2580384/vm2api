# 实施顺序与验收计划

状态：待用户审阅设计；**未启动产品实现**。本文件中的未来命令/新文件不是已存在或已执行的实现。本轮实际执行见 [verification.md](verification.md)。

## 1. 约束和实施入口

- 权威交付位于当前仓库 `docs/redaction/`，Node 清洗阶段、可开启/关闭关键元素脱敏、Web 控制面板属于一个完整任务；不把 native/API/Codex 或面板任一部分当作可选后续工作。
- `task.py start` 只能在用户明确要求实施后执行。本轮没有启动。
- 先复用参考规则/JSON 行为，再完成必要的状态隔离与流恢复改造；不要先做 UI 开关却仍允许未受保护路径外发。
- 原始参考 ZIP 和其 manifest 不改。迁移源文件保留 MIT、来源 hash 和项目约定；不从 `.local-src-303`、旧 workspace 或不存在的 crates 路径取源码。

## 2. 分步清单（实施阶段才执行）

### P1：移植纯 Go 核心，建立正确所有权

- [ ] 新模块建议为 `redact/`，module 跟随既有 `github.com/dofastted/kin-gateway/...` 命名；子目录 `internal/engine`、`internal/server`、`cmd/kin-redact`。明确迁移清单/许可和依赖，先使用与参考一致的 Go 1.26.8，不声称已经验证更低版本兼容。
- [ ] 整包迁移生产算法与有行为价值的现有 fixtures/tests，不复制 settings/pluginrt/pii/GUI。
- [ ] 将 values/kinds/key/known/sentKnown/shape 等关联状态全部改为 Scope-owned；不保留第二套全局入口或兼容 re-export。未启用 Shape/模型不在外部配置暴露。
- [ ] 新 token 格式、长度分隔的 HMAC 域、来源验证、碰撞比较，以及全部 parser/tail/restore 同步迁移；不只改 `tag`。
- [ ] Scope 原值预算、idle/active 引用、Lease 授权集合、取消和完整预检先实现，再接网络。
- [ ] 签名区采用“原样保留/命中拒绝”策略；返回 signed thinking 不还原。普通 JSON 参数继续正确转义。
- [ ] 永久用例只保护消费者可见行为：跨 key/会话不得还原、未知标签不能获取原值、碰撞拒绝、活跃流不得被 idle/容量淘汰、策略更新不复用旧明文缓存。

门槛：核心 smoke 能观察处理后文本、JSON、原值作用域、通道隔离及明确错误；不是只断言 no-throw 或字段存在。

### P2：本机 helper 和 Node 请求租约

- [ ] 新 `kin-redact` 子进程与受限 UDS，严格内部协议版本/能力；只对可信 Node 调用开放，不提供公网或管理原值接口。
- [ ] Node 侧新增 `src/lib/redaction/`，集中策略归一化/快照、principal→Scope、helper 客户端、Lease 生命周期；一个请求上下文传递所有分支，禁止进程级 currentMapping/currentClassifier。
- [ ] 在 Node 协议内容归一化/用途识别之后接共享 `sanitizeSensitiveContent`，其后工作视图用于 personaIn/canonicalBody；保留原 `sanitizeInboundBody` 的同步指纹/设置清理职责与原始身份识别视图。
- [ ] 流还原采用单连接有背压的响应通道，Go 按响应/item/block/path 持有 tail；支持一事件多字段和多路交错，不照搬单 pending。
- [ ] 只保留单份必要正文/事件缓冲；字节预算、排队、helper 崩溃、输入未完结、输出背压、客户端取消均实际演练。
- [ ] restore delta/done/terminal/body 同用一个授权与解析规则；终态处理恰好一次。

门槛：Node→真实 helper 的实际 UDS smoke；不是把 helper mock 成回显映射。

### P3：统一配置发布与管理 API

- [ ] `src/lib/admin/routing-runtime.mjs`：redaction 的 schema/merge/load/reload；候选快照预验证、资源准备、落盘后 publication；串行保存，避免共享对象先变更。
- [ ] `src/lib/admin/panel-routes.mjs` 的 `/api/panel/routing` 和 `/admin/routing`、恢复/引导 profile 写路由调用方统一使用准备/发布入口；用 LSP references 找导出符号全部调用方后再改。
- [ ] `src/lib/vm/vm-file.mjs` 既有 atomic write 模式按当前接口复用，不新增第二套磁盘写法；不更改 VM/CLI 配置投影契约。
- [ ] enabled=false 不启动新可逆处理；关闭保留 active lease；失败保持旧策略。开启运行态遇 helper 故障只 fail closed。
- [ ] `src/lib/admin/panel-api.mjs` 的 buildRouting 显式投影新 redaction 配置与只读 redaction_runtime；前端 GET 解码分离可编辑配置/运行态，PUT 不持久化运行态。admin/master 可写，普通用户/推理 key 不得读写敏感策略或 bypass。

门槛：真实临时 routing 文件的保存/失败/重新加载及重叠变更；不能只测试 normalizer 返回值。

### P4：覆盖所有真实出站入口

- [ ] 初次 Node 内容清洗与最终出站复核复用同一策略/Lease/算法，不建立两套规则；Claude native/HTTP 在 `src/lib/transport/go-worker-client.mjs` 普通/显式 envelope 汇合后复核，覆盖 handle-protocol 的 per-attempt rerender 和流/非流收口，必要上下文经 kernel-router 传递。
- [ ] 将最后正文变化、脱敏、CCH、dump/report、发送的次序统一。native 不在 Node 提前最终密封，CLI 最终 CCH 保持现有逻辑；HTTP 密封必须在脱敏之后。
- [ ] `src/lib/pool/api-protocol.mjs`：Anthropic 与 Responses upstream 转换后都 mask，回复在转换/聚合前恢复；classifier API 分支不例外。
- [ ] `src/lib/protocol/handle-codex.mjs`：推理 HTTP/WS envelope、search JSON、images 文本 JSON 均走相同策略；multipart 在既有归一化之后处理。非正文图片和 URL 等边界保持文档一致。
- [ ] `src/lib/protocol/responses-ws.mjs`：每 create 新 Lease、full replay 重遮、续接代际校验；不要跨连接共享可恢复状态。
- [ ] `src/lib/protocol/codex-convert.mjs` 及 Claude converter/assembler 的输入顺序核查：所有有关 delta/done/final 快照已恢复，usage 和真实终态不变。
- [ ] 参考 `thinking-owner.mjs` 当前事实，保护 signature/encrypted/data；不为绕过脱敏故障触发修复重试或账号处罚。
- [ ] 对 request_context、personaIn、hidden retries、credentials retry 实际核查，确保不能从旧 raw 对象重新引入敏感正文。

门槛：`design.md` 全覆盖矩阵逐行通过“真实最终上游捕获＋客户端还原”。暂时不支持的运行能力必须拒绝，不能发原文也不能把整个模块永久从完成定义排除。

### P5：日志、界面和发布闭环

- [ ] `src/lib/admin/request-log.mjs` 与 handler 的响应 tap：在捕获正文前有可信 redaction 标记；on 请求只持久化 allowlisted 元数据，不记录恢复后正文。refusal preview、summary、错误以及 dump 也核查。
- [ ] 保留 off 状态下既有 redactSecrets；不把新功能当作关闭日志安全的权限，不修订旧历史数据。
- [ ] Web 控制面板是必交付：`web/src/types/panel-routing.ts` 增加 RedactionConfig/RedactionRuntime；settings queries/index/ProtocolPane 用受控 props 接顶层 redaction，支持总开关、类别/词/规则、规则就近错误、草稿/保存/放弃及只读运行态。不新增导航，不把 runtime 放入草稿或让其它设置页保存重置此配置。
- [ ] 接到 `src/server.mjs` 启动和退出；helper 的排空不重启共享 kernel。Docker/安装/payload/各 CPU 架构产物以当前发布流程接入，不能只写死一个本机路径。
- [ ] 更新 `docs/PANEL_API.md`、`docs/PROTOCOL.md` 的新增行为和本任务涉及的两处旧描述；补协议 spec 和 CHANGELOG，准确说明开启默认、签名视图、边界和升级条件。

门槛：实际浏览器管理页验收＋helper/Node 真实进程排空、重启和磁盘配置恢复。不下载模型，不连接真实供应商来代替本地可判定的阻断证明。

## 3. 验收矩阵

以下**尚未执行**，是插件完成条件；本轮核心 smoke 不可勾选替代它们。

| ID | 场景 | 必须观察的结果 |
| --- | --- | --- |
| V01 | 无 redaction 配置、显式 off、重复 off | Node 既有身份/协议清洗仍执行；新增内容脱敏旁路、正文/流/usage 与未启用基线一致，无可逆 helper 调用 |
| V02 | Web 总开关 off→on→off、分类/词/规则、保存/放弃/刷新/Node 重启 | 草稿、已存值、runtime 分离；失败保留草稿，子项关闭不清空，schema 错误就近显示；375px/桌面、键盘和主题实际可用，保存后刷新与磁盘一致 |
| V03 | 非 boolean、无效 RE2、空有效保护、超限词；保存磁盘失败 | 明确 400/503、零部分 publication；旧有效配置不损坏 |
| V04 | 两个并发保存、排队 off 请求、on 长流时关闭 | 快照语义与文案一致；旧 on 流全部还原并结束，helper 不被早停 |
| V05 | 启用时 helper 缺失/版本不符/key 权限或写入失败；运行中 helper 死亡 | 开启保存失败或推理 503；capture 上游请求数为 0，无明文 fallback |
| V06 | 两个 key 使用同 session ID；同 key 不同会话；外域标签/猜标签 | 不得到其他域/不在 Lease 授权集中的原值；只允许本次授权绑定 |
| V07 | Unicode、嵌套 JSON、tool args 中 name/signature/user_id 同名键 | 该参数值按数据处理且 JSON 有效；协议 ID、工具/schema/grammar 不变 |
| V08 | 新标签长格式；人为注入可控 digest 碰撞；假标签中含敏感值 | parser/tail 一致，冲突阻断，伪造外形不能绕过检测；不错误恢复成别人的值 |
| V09 | 同域重复历史、跨 VM/账号重试、规则 revision 更新 | 同策略标签稳定；更新不复用旧 known 明文决定；允许且如实记录冷写，不造 cache hit |
| V10 | Node 初次清洗、persona 重渲染、Claude native/HTTP 普通/显式 envelope | 工作视图不再传播目标合成原值，最终 Node 复核和上游 capture 都无原值；CCH/Content-Length 正确，markers/TTL 原样；初次/末次不重复统计 |
| V11 | API backend Anthropic 与 Responses upstream、流/非流 | 同上；真实 api-kernel 转发实际捕获，不能用伪 Unix kernel 证明 |
| V12 | Codex 下游 HTTP/SSE/WS × 上游 HTTP/WS | 原 Responses delta/done/full output 一致恢复；HTTP zstd 解码后无原值；真实 socket 取消可见 |
| V13 | classifier native/API、主任务与 classifier 并发 | 原结构/预算/anchors 保留，transcript/action 被处理；两条流的 mapping 不混用 |
| V14 | search、images generation、JSON/multipart edit | 文本字段均处理，图片字节不破坏；非正文保护边界准确显示，不假称图片内能还原 |
| V15 | 标签跨 chunk/事件、CRLF、keepalive、多 item/tool 交错、多字段 | 各通道恢复正确；不能跨 block 拼标签；keepalive 不被长时间扣留 |
| V16 | partial arguments + done、terminal response.output；错误/EOF/取消 | 参数前缀一致、无标签回退快照；真实失败保持，不伪造 completed；Lease 释放 |
| V17 | signed thinking 重放；从 off 历史开启且敏感明文仍签名 | 签名字段/文本不变、thinking 返回保留标签；无法安全重放则明确 409，零该次发送 |
| V18 | previous_response_id 同域同代、跨域、启停/策略/helper 重启跨代 | 仅可信匹配续接；其余 409；full replay 在满足签名条件时可重新开始 |
| V19 | 容量上限、idle 清理、长流、未分帧超大输入、背压 | 内存/队列有界、不淘汰活跃绑定；明确错误、无半遮发送/跨请求原值 |
| V20 | debug/header overrides、入站/出站/回复/错误/refusal/dump | on 请求的原值不进入持久化正文或管理原值接口；关闭不弱化原有日志清理 |
| V21 | 主体类别/词组合、禁用保留、管理员/普通用户权限 | 业务状态与真实执行一致，普通推理 key/用户不可绕过总策略 |
| V22 | 计费/TTFT/max_tokens/stop/上游429与中断 | 原供应商 usage/cost 分类和生成时间边界不因恢复缓冲改变；插件失败不罚账号 |

## 4. 验证命令与工具

### 已存在、实施时可复用的入口

- `test/e2e/helpers/real-chain.mjs` 的 `startRealChain({kernelBin,cliBin,...})`：实际 kernel/CLI＋loopback capture；只证明该单次 adapter 链，不代表池并发。
- `test/e2e/auto-mode.e2e.test.mjs`：classifier 的现有真实链路基础。
- `api-kernel/internal/server/server_test.go`：Go handler 真实回环转发基础；最终验收另跑实际打包 api-kernel。
- `test/unit/responses-ws.test.mjs`：真实 WS surface 基础，必须再连真实 Codex kernel 的 HTTP/WS capture，不能把 injectable ops 通过当作最终 wire 证明。

### 新实现存在后才可执行的建议命令

```sh
# cwd: redact/（未来新增模块）
go test -race ./internal/engine ./internal/server
go build -o ../bin/kin-redact ./cmd/kin-redact

# cwd: 仓库根；以下 redaction 文件名为未来新增目标
node --test test/unit/redaction.test.mjs test/unit/redaction-routing.test.mjs
node --test test/e2e/redaction.e2e.test.mjs

# cwd: web/
npm run build
```

这些命令本轮未执行。首次实施先确认项目当时 package scripts/工具链，按现有 conventions 调整；构建/测试统一在集成后运行，不在并行编辑中反复执行。

最终仍须使用实际 helper、Node、kernel/CLI/API/Codex ELF 和仅回环上游执行一次场景驱动 smoke，直接观察：发送 body、解码后的压缩 body、流与客户端输出、错误时请求数、进程/连接关闭和日志落盘。临时运行目录必须隔离 PROJECT/data/routing/HOME 等所有写路径，并在 smoke 后删除；不用生产请求/凭据作为 fixture。

## 5. 发布、回滚和阻断条件

- 任何 V01–V22 未满足均不能宣布完成，也不能仅把开关藏在 UI 中当修复。
- 迁移后的算法 tests 要测真实隔离/边界/状态转换；删除仅依赖措辞/实现复制/默认常量的旧测试，不把它们重新钉死。
- 发布需要 helper 的构建、许可证、Linux 架构与安装路径齐全；本轮不改 manifest、不生成二进制、不部署。
- 首次启用前上游捕获和保存失败/原值泄漏/取消测试是硬门槛；真实厂商签名接受和 cache_read 可作为单独环境验收，不用伪造本地数值补齐。
- 回滚：显式关闭并保存 → 让旧 on 请求排空 → 作废受保护 continuation → 才卸载 helper 或回到不认识此配置的旧版本。运行态故障不能自动走这条“明文回滚”。
