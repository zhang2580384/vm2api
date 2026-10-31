# 本轮验证记录

日期：2026-10-28。验证对象是参考归档的既有 Go 核心及设计证据，不是已实现的 vm2api 插件。

## 1. 资料与环境

- 参考 ZIP SHA-256：`b1ce4b6fcdad1096dcf914394b008e60a990451204aafc36ef2690eefc4c81c2`，与包外 `ARCHIVE.sha256` 相同。
- ZIP 355 个唯一成员；CRC 通过；无绝对/`..` 路径；解包到新建 `/tmp/vm2api-redact-design-as3lkxyq`。
- 四目标目录内共 54 个归档文件与当前参考源码逐字节相同。
- 全局 `go version` 实际为 `go1.25.1 linux/amd64`；归档要求 Go 1.26.8，本机存在缓存的对应工具链。
- 首次使用全局 `go run` 并设置 `GOSUMDB=off` 时失败：`verifying module: checksum database disabled by GOSUMDB=off`。未修改 go.mod 或降低版本；改用缓存的 Go 1.26.8 可执行文件与 `GOTOOLCHAIN=local`。

## 2. 实际合成 smoke

在隔离解包模块内新增一次性命令 `engine/cmd/vm2api-design-smoke/main.go`。只 import 标准库和 `github.com/yetone/magpie/internal/redact`；没有 import settings/pluginrt/pii，没有持久化 key 路径。

实际命令（cwd 为临时解包后的 `engine/`）：

```sh
env -u MAGPIE_EVAL_CACHE \
  GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
  XDG_CONFIG_HOME=/tmp/vm2api-redact-design-as3lkxyq/config \
  XDG_CACHE_HOME=/tmp/vm2api-redact-design-as3lkxyq/cache \
  GOCACHE=/home/mci777/.cache/go-build \
  /home/mci777/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.8.linux-amd64/bin/go \
  run -tags nogui ./cmd/vm2api-design-smoke
```

退出码：0。原样 stdout：

```text
TEXT hits=2 roundtrip=true stable=true masked=credential={{SYNTH_f2g3jcdl}}; project={{TERM_32yrevwg}}
JSON hits=1 valid=true nested_arguments_roundtrip=true protocol_id_kept=true stale_length_removed=true
SSE fragments=6 content_events=3 placeholder_splits=2 keepalive_immediate=true restored_equal=true
GLOBAL_API tenant_parameter=false unscoped_lookup_returns_original=true
SMOKE PASS: archived core only; synthetic inputs; no vm2api integration or model execution
```

输入与断言：

- 自定义规则 `Kind=SYNTH, Prefix=demo_` 经 `CheckRules` 校验；合成原值 `demo_ABCDEF0123456789` 与中文词 `夜莺计划` 均被替换；Restore 后与原文相同；重复输入得到相同标签。
- Chat 形状的 tool_calls.function.arguments 为嵌套 JSON 字符串，含引号、反斜线和合成值；MaskJSON 后 JSON 有效、工具 ID 不变；经普通响应 Writer＋Finish 后与原始 JSON 字节相同；旧 Content-Length 删除。
- 同一标签分成三个 `content_block_delta`，每个事件再分成两个 Write 片段，共六片；中间 keepalive 当场可见；客户端拼接文本与合成原值相同。
- 直接调用全局 Restore 可恢复已登记标签，API 没有租户参数。这证明其本身不提供作用域授权，不等同于已演示某个线上越权漏洞。

后缀来自临时进程随机 key，不能在未来复测时固定匹配。合成命令及解包目录在交付前删除，不作为可安装插件、永久测试或现成生产入口。

## 3. 没有执行或证明的事项

- 没有修改/启动 vm2api、AgentDock 产品服务，没有访问生产节点或真实供应商。
- 没有运行单元/集成测试、完整构建、formatter、Windows/macOS 构建或桌面/浏览器验收。
- 没有下载/调用模型；GOPROXY=off，使用本机已缓存工具链与模块。
- 没有证明新总开关、helper RPC、租户隔离、新标签格式、policy 热切换、多路交错恢复、WS、压缩、所有推理路由或最终 CCH 正确；这些都是实施验收项。
- 没有给出吞吐、精度、额外延迟或 cache_read 命中率的实测承诺。
- 没有构造 HMAC 碰撞，没有进行完整安全审计。

## 4. 交付检查

初版已检查 73 处源码文件/行号引用、12 个 Markdown 相对链接、11 个 implement/check manifest 条目，均存在且范围有效；已删除本轮临时解包目录和 smoke 命令。后续按用户补充修订 Node 清洗和 Web 控制面板设计，并将唯一权威资料迁至当前仓库 docs/redaction。最终引用/链接/编码检查结果以本轮收尾命令输出为准；文档检查不替代插件运行验收。

原先仅由本轮创建的外部 vm2api-design 副本经逐字节确认后删除，未改原参考资料。当前仓库 FILES.sha256 仅包含六个设计文档、不包含自身。公开设计是本次唯一提交逻辑单元；本地 Trellis 只保留任务状态/链接，不强制提交被忽略的代理目录。

格式化范围：本轮持久改动只有 Markdown、校验清单和本地任务元数据；项目 docs/FORMAT.md 规定 Biome 覆盖 Node 源码/配置、gofmt 覆盖 worker、Prettier 覆盖 web，没有根 docs Markdown 格式器。因此跳过会处理全仓业务代码的 npm run format，只检查本轮文件的 UTF-8 无 BOM、LF、结尾换行和空白；不擅自转码原有文件。

修订后的实际检查：80 处源码文件/行号引用、9 个设计文档相对链接、11 个本地实现/检查 manifest 条目均有效；本轮涉及的 13 个文档/任务文件均为 UTF-8 无 BOM、LF、无行尾空白且有结尾换行。已补齐本轮生成 task.json 的结尾换行并按两空格缩进格式化，未修改原有非 UTF-8 文件。

本轮未改运行代码，因此跳过 Node/Go/Web 的全量 lint、类型检查、构建和测试；参考 Go 核心的已执行 smoke 结果仍见上文，未重复执行或冒称新插件/面板已通过。Git 提交仅包含 docs/redaction 与 docs/README.md 的本轮文档变更，不包含用户原有删除、私有 Trellis 文件、密钥或二进制。
