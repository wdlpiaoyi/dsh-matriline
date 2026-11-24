# Matriline（宗正寺鲸）

> 一窝子代理，各有边界。

`@wdlpiaoyi/dsh-matriline` is an unofficial community plugin for the DeepSeek Harness (DSH). It trims the tool surface and system prompt a delegated subagent receives, enforces capability tiers and write-scope leases, judges a child's status from its own session log, and renders the parent/child topology in the right sidebar.

[English](README.en.md) · 中文

DSH 子代理委派与工具裁剪插件：降低委派开销、限制子代理能力，并在右侧栏展示子代理运行拓扑。

> 本插件是非官方社区插件，与 DeepSeek 无隶属关系，也未获其认可或背书。

## 核心能力

1. **工具与提示词裁剪**：按任务裁剪子代理工具集和系统提示词，减少首请求 token。
2. **能力分级**：提供只读、写入、验证三类能力集；权限单调，子代理不能通过再次委派提权。
3. **写域保护**：通过写域租约、工具守卫和可选的 git worktree 隔离，降低并发写入冲突。
4. **结构化结果**：根据子会话日志判定执行状态，不依赖子代理自述。
5. **运行可视化**：右侧栏「子代理拓扑」展示父子关系、消息、token 和上下文占用。

## 环境要求

- Node.js `>=22.15`：与 DSH 自带运行时一致；本包只使用 Node 标准库，无运行期依赖。
- DSH `>=0.2.0-rc.1 <0.3.0`：与 `package.json` 的 `engines.dsh` 一致；已在 `0.2.2-rc.5` 实测，兼容承诺详见[兼容性](#兼容性)。
- 可选：宿主编排中的 worktrees bundle，用于 `isolate: true` 的物理隔离。

> DSH 会按 `engines.dsh` 拒绝不兼容版本。升级到 DSH 0.3.x 前，必须先发布放宽兼容窗口的插件版本。

## 安装

通过 `plugin_manager` → `install_bundle` 安装。本包没有运行期依赖，也没有构建步骤：`files` 中的源码直接运行，克隆或解压后无需 `npm install`。

### 从本地目录安装

适用于开发和离线环境。Windows：

```text
action: install_bundle
target: C:\path\to\dsh-matriline
```

macOS / Linux：

```text
action: install_bundle
target: /path/to/dsh-matriline
```

安装目录必须包含：

- `package.json`
- `index.js`
- `client.js`
- `cordis.patch.yml`
- `state/`（`matriline-state` 行的模块，作为 `./state` 子路径随包一起安装）

### 从 Git 安装

仓库为公开仓库，克隆无需凭据：

```text
action: install_bundle
target: git+https://github.com/wdlpiaoyi/dsh-matriline.git
```

仓库变更后需要核对的事项见 [CONTRIBUTING.md 的发布检查清单](CONTRIBUTING.md#release-checklist)。

### 从 npm 安装

```text
action: install_bundle
target: @wdlpiaoyi/dsh-matriline
```

`@wdlpiaoyi/dsh-matriline` 已发布到 npm；需要钉住具体版本时写成 `@wdlpiaoyi/dsh-matriline@<version>`。

### 配置会话开关

模型菜单开关依赖 profile 里的一个 state 条目：

- 条目 id：`matriline-state`
- 模块：`@wdlpiaoyi/dsh-matriline/state`（本包的 `./state` 子路径，不再是独立包）
- 配置：`config.sessions`
- 存储方式：volatile
- 主插件通过进程内 state store 读取配置

该条目由**本包的 bundle patch 自己插入**（见根目录 `cordis.patch.yml`），和 `matriline` 条目同属**一张**插件卡。所以既不需要手工插入条目，也不需要第二个包：

```yaml
- insert:
    - id: matriline
      name: '@wdlpiaoyi/dsh-matriline'
      config: {}
    - id: matriline-state
      name: '@wdlpiaoyi/dsh-matriline/state'
      config:
        sessions: {}
```

profile 的 `cordis.patch.yml` 里只保留 Settings 编辑器维护的 `config.sessions` 覆盖行，不要写 `insert`，也不要写 `name`：`name` 只用于**断言**已有行的模块名，写错会让整行补丁被跳过并告警（开关状态也就不生效）。

```yaml
- id: matriline-state
  config:
    sessions: {}
```

首次写入开关时 Settings 编辑器会自己补上这一行，`sessions` 可以为空。

### 重启与卸载

- 支持 HMR 或 host-module 热载的部署通常无需重启，客户端模块也会热更新。
- 不支持热载时，按 `install_bundle` 返回的 `restart-required` 和 `nextStep` 重启宿主。
- 卸载：`plugin_manager` → `remove_bundle`，target 为 `@wdlpiaoyi/dsh-matriline`。

## 开关与命令

| 控制项 | 行为 |
|---|---|
| 默认状态 | 开启，新会话自动生效 |
| 模型菜单「启用子代理工具裁剪」 | 控制当前会话的默认裁剪；与官方「启用智能体团队协作」相互独立 |
| 数据目录下存在 `matriline.paused` | 全局暂停默认裁剪 |
| 数据目录下存在 `matriline.noprompt` | 关闭紧凑提示词；删除文件后恢复 |

切换模型菜单开关会刷新工具表，并使该会话下一次请求的提示词缓存失效一次。不要频繁切换。

`matriline.paused` 只影响未显式指定 `kind` 的子代理，包括官方 `subagent`、`subagent_fork` 或其他创建者派发的子代理。它不影响：

- `delegate`、`delegate_many`、`deliberate` 中显式指定的 `kind`；
- Tier 1 写域租约；
- Tier 2 `tools` 守卫；
- Tier 3 `isolate` worktree。

本插件不注册斜杠命令。开关写入 `config.sessions = { <sessionId>: boolean }`，随后更新工具面并追加 `plugin:matriline/gate` 投影记录，不产生聊天消息。

## 委派 API

### 单任务委派

```text
delegate(task, kind, name?, wait?, budgetMs?, scope?, isolate?, skills?, tools?, timeoutAction?, maxRuntimeMs?, model?, provider?, reasoningEffort?)
```

#### 能力集

| `kind` | 用途 | 默认能力 |
|---|---|---|
| `read` | 只读任务，默认值 | 只读沙箱；`read`、`grep`、`glob`、`read_image`、`list_agents`、`send_message`、`delegate`、`cancel_subagent` |
| `verify` | 独立复核 | 与 `read` 相同 |
| `write` | 文件修改和命令执行 | 默认最小工具集；沙箱为 `workspace-write` |

`write` 的 `WRITE_MINIMAL_TOOLS` 名单包含 16 项：

- 文件：`read`、`write`、`edit`、`apply_patch`
- 搜索：`grep`、`glob`、`read_image`
- Shell：`pwsh`、`bash`
- 子代理：`delegate`、`cancel_subagent`、`send_message`
- 其他：`todo_write`、`working_directory`、`web_fetch`、`web_search`

实际工具集是该名单与子代理可见工具的交集。宿主未注册的工具会被静默移除。

需要更多工具时，使用：

```text
delegate(kind="write", tools="full")
```

或精确指定：

```text
tools=["plugin_manager", "schedule_create"]
```

`write` 默认移除 `skill` 工具，`read` / `verify` 的工具集本来也不含它。`skills: true` 会把它留在工具表里，技能目录随之以一条额外的 `user/message` 注入该会话——这改变请求前缀，**破坏该会话的提示词缓存**。所以 `skills` 必须在派发那一刻定死，默认不传。

#### 返回结构

```jsonc
{
  "status": "ok|partial|denied|error|timeout|interrupted|depth-exhausted|running",
  "summary": "…",
  "child": "<子会话 id>",
  "denials": [{ "tool": "write", "code": "FS_SANDBOX_DENIED" }],
  "usage": { "totalTokens": 0 },
  "elapsedMs": 0
}
```

状态语义：

- `ok`、`partial`、`denied`、`error`、`timeout`、`interrupted`、`depth-exhausted` 是七种终态。
- `running` 只出现在 `wait: false` 的未等待结果中，表示任务已启动，结果稍后通过消息送达。
- `denied` 只用于派发前的策略拒绝，例如写域冲突、提权、整批原子拒绝，或子代理模型选择开关关闭/不在允许列表。
- 子代理启动后的沙箱或守卫拒绝记录在 `denials[]`，不会单独把状态改为 `denied`。
- 最终状态由子会话日志中的 `stopReason` 和 `turn/end` 判定；已恢复的工具错误不会把成功完成误判为失败。

#### 等待与超时

- `wait` 默认为 `true`，等待子代理结束；长任务建议使用 `wait: false`，避免阻塞主对话。
- `budgetMs` 是 `wait: true` 的等待上限，不是任务寿命。
- 等待超时后返回 `status: "timeout"` 和 `child`；子代理默认继续运行并继续持有写域。
- 超时后不要以相同 `scope` 重派任务，否则可能被仍在运行的写租约拒绝。
- 可通过 `send_message` 续接，或用 `cancel_subagent(childId)` 停止。
- `timeoutAction: "interrupt"` 表示等待超时即中断。
- `maxRuntimeMs` 是任务寿命上限，对 `wait: false` 同样生效；默认 `0` 表示不限。

#### 续跑状态恢复

子代理结束后可通过 `send_message` 续跑。resume 会重放 `agent/created`，并恢复以下状态：

| 状态 | 会话日志记录 | 未恢复时的影响 |
|---|---|---|
| `kind` | `plugin:matriline/kind` | 门控开启时按 `read` 最小集重新裁剪（写能力被剥离）；门控关闭时保持原样、不裁剪，续跑的子代理可能仍持有写能力 |
| `tools` profile | `plugin:matriline/tools` | `tools: "full"` 可能缩回 minimal |
| `skills` | `plugin:matriline/skills` | `skills: true` 的记录丢失后按默认 `false` 处理：`skill` 工具与技能目录被剥离 |
| 写域租约 | `plugin:matriline/lease` | 守卫无法识别写域；缺少记录的写者会被 fail-closed 拒绝 |

恢复顺序为：内存 Map → 会话日志记录 → 默认值。子会话的 `kind` 默认回退为 `read`，写域按 fail-closed 处理。

### 批量委派

```text
delegate_many(tasks[], maxConcurrent?, wait?, budgetMs?, reconcile?, reconcileQuestion?)
```

- “设置 kind → 启动”阶段串行执行，因为 `pendingKind` 是单槽；任务等待阶段并行执行。
- 创建窗口排队可能使后续子代理延迟启动，不代表等待阶段被串行化。
- 写域执行整批原子预检，详见[写域互斥](#写域互斥)。

`reconcile: true` 会执行“合成 → 冲突检测 → 内部裁判”，并增加：

- `merged`：合并后的结论。
- `findings[]`：`{ claim, evidence[] }`，最多 8 条。
- `conflicts[].verdict`：仅记录真正互相矛盾的冲突，措辞差异不计入。

`findings[].evidence` 的提示词要求只填写结果中真实存在的 `path:line`，但代码不核验路径，因此这是软约束。

### 多方讨论

```text
deliberate(topic, participants=3, rounds=2, budgetMs=180000)
```

执行流程：

1. N 个只读子代理分别给出独立结论。
2. 将其他参与者的立场摘要回灌给同一个子代理进行第二轮续跑。
3. 合并为 `consensus` 和 `disagreements`。
4. 最多两条真正矛盾的分歧会触发内部裁判；每个裁判都是新的子代理。

约束与返回：

- `participants` 范围为 `2..5`，`rounds` 范围为 `1..2`，超限直接拒绝。
- 仅支持 `kind="read"`。
- 请求成本约为 `N × (rounds + 1)`，不应用它代替普通批量读取。
- 适用于存在争议、需要多方视角复核的方案选择。
- `rounds` 是请求轮数，`roundsSkipped` 是因预算耗尽或无可用参与者而跳过的轮数。
- 第二轮被 `denied` 或 `error` 截断时返回 `partial`，不会伪装成 `ok`。
- 无法可靠等待续跑结束时，会降级为“重新派发参与者并写入他人立场”，并返回 `resumeUnsupported: true`。

### 模型选择

```text
delegate(task, kind, model?, provider?, reasoningEffort?)
```

- **跟随官方开关**：只有当 DSH 设置 → 子智能体设置 →「允许 Agent 为子智能体选择模型」（`subagentModelSelection`）**可读且开启**时，`delegate` / `delegate_many` 才接受显式的 `model`、`provider`、`reasoningEffort`。开关关闭时整组字段一律拒绝，子代理继承本会话的模型——关闭就是关闭，不会因为白名单不可用而变成“什么模型都能选”（旧行为在开关关闭时移除白名单，让任意路由都能被选中）。
- 拒绝发生在派发前：`status: "denied"`，`denials` 带 `MODEL_SELECTION_CLOSED`（开关关闭）、`MODEL_NOT_ALLOWED`（不在允许列表，或允许列表为空）或 `MODEL_POLICY_UNUSABLE`（本会话记录的策略里没有可用条目——它由官方在会话创建时写入，改设置不会影响它）。
- 开关开启时，可选模型受允许列表限制；允许列表为空等于一个都不允许，连只改 `reasoningEffort` 的请求也会被拒绝。
- 会话若已有记录的 `subagent/model-selection-policy`（官方在会话创建时写入），按该记录执行：和官方投影一致，事后关闭开关不会追溯吊销已有会话的授权；fork 出来的会话继承父会话记录的策略（扫描整个会话日志，而不只看 fork 之后的事件）。
- 没有记录的会话按当前开关执行，所以之后开启开关时这些会话也按允许列表放行。
- 官方设置行未挂载，或 `enabled` 读不出布尔值时，不做白名单判定——校验从不把 `delegate` 变成不可用。
- 省略 `model` 时继承当前会话模型。
- 可以只设置 `reasoningEffort`，模型仍继承当前会话；它同样受官方开关与允许列表管辖。
- 模型名无效时，返回该 provider 实际可用的模型列表。
- 不提供价格或成本统计；宿主只暴露模型的 `id`、`name`、`description`，没有可靠的价格元数据。

## 写入安全与隔离

### 写域互斥

```text
delegate(kind="write", scope=["src/foo/**", "docs/b.md"])
```

规则：

- 未声明 `scope` 的写者默认租用整个 workspace，同一父会话同时只能有一个此类写者。
- 两个租约重叠时，派发返回 `denied` 和 `WRITE_SCOPE_OVERLAP`。
- `delegate_many` 在启动任何子代理前，检查批内租约两两交集以及与现有租约的交集；任一冲突都会拒绝整批，返回 `results: []`。
- 排队任务和尚未 promote 的 pending 租约也参与冲突检测。
- resume 的写者从 `plugin:matriline/lease` 恢复租约。
- 运行期由全局 `tools.guard` 拦截落入其他租约的 `write`、`edit`、`apply_patch`。

支持的 `scope` 形式：

- 裸文件或目录；
- `dir/**`；
- `dir/*`；
- `dir/`。

其他通配符形式（例如单独的 `**`、`*.ts`）会返回 `WRITE_SCOPE_INVALID`，不会展开。

> `scope` 是写者之间的互斥声明，不是自身写入边界。守卫只拒绝落入他人租约的路径，不拒绝写者超出自身 scope 的操作。需要限制可写文件范围时，使用 `isolate: true`。

### 三层防护

| 层 | 拦截 `write` / `edit` / `apply_patch` | 拦截 shell 写入 |
|---|---|---|
| Tier 1：派发租约 | 是 | 否 |
| Tier 2：工具守卫 | 是 | 否 |
| Tier 3：worktree | 是 | 是，依赖文件系统隔离 |

工具守卫根据 `write`、`edit`、`apply_patch` 的明确文件参数判断租约归属。`pwsh` 和 `bash` 只提供命令文本，目标可能位于重定向、脚本内部、相对路径或构建工具中，无法可靠枚举，因此工具层不解析 shell 命令并默认放行。

需要覆盖 shell 写入时，必须使用 `isolate: true` 的独立 git worktree。

### worktree 隔离与写门控

`isolate: true` 的写者在私有 worktree 中运行：

- worktree 之外的 `write`、`edit`、`apply_patch` 一律拒绝。
- shell 的隔离依赖独立检出，而不是命令解析。
- 未安装 worktrees bundle 时，子代理仍运行，但不隔离；结果包含 `worktreeError: "worktree service unavailable"`。

worktree 只能在子代理第一个 `turn/start` 时创建。`agent/created` 阶段 context 尚未激活，直接创建会抛出 `cannot create effect on inactive context`。创建前的窗口由两层机制处理：

1. **硬门控**：全局 `tools/pre-execute` 钩子挂起 `write`、`edit`、`apply_patch`、`pwsh`、`bash`，直到 worktree 就绪，每次等待上限 10 秒。超时、失败或中断时放行并记录日志；门控条目只在 worktree 就绪后删除，后续写入仍会执行有界等待。
2. **软提示**：在任务前提示子代理，写文件前确认当前目录包含 `.agents/worktrees/`；不满足时等待 2 秒再检查。

## 可观测性

### 子代理拓扑

右侧栏「子代理拓扑」展示父子拓扑、消息往来、token 和上下文占用。

自动隐藏只是展示过滤，不删除数据。节点同时满足以下条件时自动隐藏：

1. **处于终态**：七种标准终态之一；客户端也将 `failed`、`idle` 视为终态。`running` 和 `waiting` 永不隐藏。
2. **结束超过 2 小时**：优先使用 `endedAt`，缺失时回退到 `updatedAt`。
3. **不在最近完成的 8 个节点中**：按 `endedAt` 倒序排列，前 8 个始终可见。

其他规则：

- 根节点永不隐藏。
- 「显示已隐藏（N）」可展开自动隐藏节点。
- 展开后的自动隐藏节点使用约 0.45 透明度和虚线框。

### 上下文告警

子代理结束时，以最后一条请求的上下文占用计算比例：

```text
(inputTokens + cacheReadTokens) / contextWindow
```

其中 `contextWindow` 来自该模型在 `request/context` 事件中的声明。

- 超过阈值时，结果包含 `contextWarning`，渲染行尾显示 `⚠ ctx 82%` 一类标记。
- 子代理未发送请求或无法取得 `contextWindow` 时不告警。
- 默认阈值为 `0.8`，合法范围为 `(0, 1]`。

编辑插件数据目录下的 `config.json`：

```json
{ "contextWarnRatio": 0.8 }
```

配置缺失、损坏或值非法时回退到 `0.8`，不报错。

## 运行期文件

默认数据目录：

- Windows：`%USERPROFILE%\.dsh\matriline`
- macOS / Linux：`~/.dsh/matriline`
- 设置 `DSH_HOME` 时：`$DSH_HOME/matriline`
- 设置 `MATRILINE_HOME` 时：完全覆盖上述目录；主插件与 `./state` 子模块都按同一变量解析，共用这个目录

| 用途 | 路径或文件 |
|---|---|
| 日志 | `matriline.log`；超过 5 MB 轮转为 `matriline.log.<时间戳>` |
| 会话开关状态 | `state.json`（迁移期的旧镜像） |
| 告警阈值等配置 | `config.json` |
| 全局暂停标记 | `matriline.paused` |
| 紧凑提示词关闭标记 | `matriline.noprompt` |
| 运行记录 | `runs.jsonl`；超过 5 MB 轮转为 `runs.<时间戳>.jsonl` |

启动日志中的 `apply: loaded (data dir: ...)` 会记录实际数据目录。删除 `matriline.paused` 可恢复默认裁剪。

`state.json` 是迁移期的旧镜像，不是开关的权威存储。要恢复某个会话的默认行为，请用模型菜单开关切换一次，或从 profile 中该 state 行的 `config.sessions` 删除这个会话的条目；直接删除 `state.json` 不能撤销真实的开关状态（旧值可能被重新写出）。

### 会话日志记录

以下 ignorable 插件记录写入会话日志，而不是插件数据目录：

- 子会话：`plugin:matriline/kind`、`plugin:matriline/tools`、`plugin:matriline/skills`、写域租约记录。

这些记录不进入模型上下文，只用于续跑状态恢复，不应手动删除。

## 宿主依赖与降级

| 依赖 | 缺失时的行为 |
|---|---|
| `sidebarRightTabs` | 客户端重试约 10 秒后放弃注册「子代理拓扑」；委派、日志和开关不受影响 |
| `sidebarRight.openTab()` / `openResource()` 与 `subagentchat` 侧栏页 | 影响「打开会话」；优先在右侧栏新标签页打开，不支持时退回主栏并提示 |
| `@deepseek-ai/dsh-client-ui-primitives` | 客户端回退到内置控件（`Switch` / `Modal` / `Button`）；功能不变，外观可能与官方控件不同 |
| 宿主会话模块的 `appendPluginRecord` | 无法把 `plugin:matriline/*` 记录写进会话日志：续跑状态（kind / tools / skills / 租约）与 gate 记录都写不进去；内存态与默认值仍然生效，开关本身走 state 条目，不受影响 |
| worktrees bundle | `isolate: true` 不隔离，子代理继续运行并返回 `worktreeError` |
| HMR / host-module 热载 | 安装后需要按宿主提示重启 |

`appendPluginRecord` 是宿主会话 API 的可选能力：本插件在安装目录内尽力解析宿主提供的会话模块来使用它，属于 best-effort；不可用时执行上表所列降级，委派、日志与开关均不受影响。

## 已知限制

1. 不提供 token 价格或成本统计。
2. 合成或裁决失败时，相关字段降级为 `null` 或 `[]`，不会使整批失败。
3. 状态只有七种终态和 `running`，没有更细的失败原因分类。
4. `bash` 和 `pwsh` 可绕过工具层写域守卫；需要硬隔离时使用 `isolate: true`。
5. `scope` 只提供写者间互斥，不限制写者自身的写入边界。
6. 缺少 `plugin:matriline/lease` 记录的写子代理（例如会话日志被裁剪后）续跑时，`write`、`edit`、`apply_patch` 会被 fail-closed 拒绝并返回 `WRITE_SCOPE_VIOLATION`；应重新 `delegate`。
7. `wait: true` 超时默认只结束等待，不停止子代理；子代理继续运行、发送结果并持有写域，直到完成或被显式停止。
8. `findings[].evidence` 的 `path:line` 真实性只由提示词约束，代码不核验。
9. 本插件自身的数据目录和包目录受写域保护：带租约的写子代理不能写入它们（包括任务本身就是修改本插件时）；根会话不受此限制，仍可写入。
10. `worktreeError` 的清理会解析 worktrees 服务返回的 “Any created checkout and branch are retained” 错误文案来还原检出路径，因此依赖该文案格式；清理前会用 `git rev-parse --show-toplevel` 复核仓库身份，误判通常是 no-op，但服务端文案变化会让自动清理失效（检出会被保留）。
11. 客户端半部期望宿主提供 `@deepseek-ai/dsh-client-ui-primitives`；宿主未暴露该模块时回退到内置控件，功能不受影响，外观可能与官方控件有差异。

## 兼容性

- `package.json` 的 `engines.dsh`（`>=0.2.0-rc.1 <0.3.0`）是声明的兼容窗口，也是唯一的兼容承诺；DSH 会按它拒绝不兼容版本。
- 已在 `0.2.2-rc.5` 上实测。
- 下限以下的 0.2.x 宿主可能仍能运行：本插件对宿主服务按可用性探测并降级（见[宿主依赖与降级](#宿主依赖与降级)），但这些版本不在支持范围内，不保证可用。
- 升级到 DSH 0.3.x 前，必须先发布放宽兼容窗口的插件版本。
- 调整兼容窗口即改变兼容承诺，`engines.dsh` 与本文必须同步修改。

## 安全与贡献

- 安全策略与漏洞报告方式：[SECURITY.md](SECURITY.md)
- 开发环境、测试与发布检查清单：[CONTRIBUTING.md](CONTRIBUTING.md)
- 版本变更记录：[CHANGELOG.md](CHANGELOG.md)

## 许可证

MIT 许可证，全文见 [LICENSE](LICENSE)。版权行：`Copyright (c) 2026 wdlpiaoyi`。
