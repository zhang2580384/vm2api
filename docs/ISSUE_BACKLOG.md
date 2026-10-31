# Issue 待办清单（2026-10-28 复核）

本清单记录 2026-10-28 对全部 open issue 的复核结论中**暂不修复**的部分。P0（#738 / #763 Key 记账）与 P1（#722–#725 Codex 可靠性、#768 槽终端 claude 崩溃）已另开 PR，不在此列。

复核方式：`omp -p --model antigravity/gemini-3.8-flash-tiered` 只读（read / grep / glob）逐个审阅 23 个 issue，基于 main `f149ef02`（1.4.016）；报在 1.4.x 上的和严重度高的再人工对照代码、`git blame` 与复现。下文「已复核」表示人工核对过代码；「Gemini」表示仅有模型结论，动手前需先核实。行号以 `f149ef02` 为准，之后的提交可能使其偏移。

结论：除 #741（1.4.009 已修）外，没有 1.4.x 新引入的问题；下列均为 1.3.x 遗留。

## P2：确认存在，后续排期

| Issue | 问题 | 依据 | 方向 / 量级 |
|---|---|---|---|
| #772 | GPT 槽界面上没有可调的优先级 | 已复核：Codex 选槽只看 `weight`（`src/lib/pool/codex-slot-pool.mjs:198`），web 没有编辑 weight 的入口；`vm-scheduling.tsx:416/735` 以 `!codex` 隐藏调度等级（`cf12e909`，1.3.117）；列表页 `vm-list-table.tsx:162` 仍对 Codex 显示「优先级-1」 | 给 Codex 加 weight 设置项，列表页对 Codex 隐藏 `PriorityChip`；可考虑 PATCH 拒绝对 Codex 写 `schedule_level`。S |
| #684 | 正文为空的 403 让账号暂停 5 分钟；内核日志丢失 | Gemini：`handle-codex.mjs:331` 的 `codexFailureHold` 对 403 一律 5 分钟；`codex-kernel-supervisor.mjs:244` 以 `stdio: 'ignore'` 启动内核 | 无详情 403 改短冷却；内核 stderr 落盘。S |
| #689 | 流式偶发 `job stream overflow`，报成 502，控制面无日志 | Gemini：256 帧 / 2 MiB 上限写死在闭源 kin-kernel；`stream-truncation.mjs` 归类为 502 `upstream_error`，错误帧无 request_id | 控制面先补日志、request_id 并单独归类；放大上限需重编内核。M |
| #524 | 换号后长会话 rewrite 丢掉调用方稳定缓存断点 | Gemini：`outbound-attempt.mjs:195-224` 的 `officialMessageMarker` 先清掉已有断点再固定打点；1.4.016 的 #778 只覆盖 zero 档 | 非 zero 档保留调用方已有消息断点（不超额时）。S–M |
| #681 | KVM 槽升级后 `kin-worker` SIGSEGV（exit 139） | Gemini：`docker/kin-kvm/guest/kin-guest-setup:195` 以 9p `cache=loose` 挂载并直接软链执行；升级时宿主 `rename` 替换二进制 | 改为拷到 guest 本地磁盘执行，或升级后 drop_caches / 重载。S |
| #737 | GPT 约 50 并发卡死，面板也打不开 | 已复核热路径：每次选槽同步读写全部 `vms/*.json`（`handle-codex.mjs:237-242`，`cf12e909`，1.3.117）。issue 无日志，**根因未确认** | 先向报告人要日志与并发场景；方向是把 `syncCodexQuotaSchedule` 移出选槽热路径。M |

## P3：非网关缺陷

| Issue | 结论 |
|---|---|
| #777 | `service_tier: fast` 返回 `default`。网关（`codex-convert.mjs:255`）与 codex 内核都把 fast 改写为 `priority` 并带 `x-codex-routing-hint`，返回档位来自上游，应为账号无 Fast 权益。已处理：计费按发出档位，上游回显存 `upstream_service_tier`，日志标记「Fast 未生效」。 |

## 建议关闭

| Issue | 理由 |
|---|---|
| #741 | 1.4.009（#757）已修：`scripts/fleet-services.mjs` 改经控制面执行（`4b2d98aa`） |
| #702 | 已修：`request-rectifier.test.mjs:190` 有 #702 回归测试 |
| #678 | 已修：pricing / request-log / cache-ttl 三处有 #678 测试 |
| #714 | Gemini 判为 2 GB 内存、无 swap 的宿主机内存颠簸，非代码问题；与报告人确认后关闭 |

## 功能需求（不计入修复）

| Issue | 现状 | 量级 |
|---|---|---|
| #672 账号列表显示订阅到期 | 列表接口已下发 `chatgpt_subscription_active_until`，仅详情页「账号」Tab 显示 | M |
| #464 按会话分流 | 1.4.x 席位键已优先 `sessionId`，但 `pool-scheduler.mjs` 新会话仍先命中设备亲和 VM | M |
| #648 Kubernetes / 多副本 | 单进程 SQLite + 进程内并发 / RPM / 席位状态，需整体改造 | L |
| #647 PostgreSQL | 21 个 repo 绑定同步 `node:sqlite` 与 SQLite 方言 | L |
| #376 控制面主备 | 无租约 / 摘流，SIGTERM 不排空在途连接 | L |
