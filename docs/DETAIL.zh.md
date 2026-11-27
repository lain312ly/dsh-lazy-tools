# 渐进式工具加载（dsh-lazy-tools）

把「不常用的工具」从每次模型请求的工具表里移走，模型需要时再按需加载。加载动作本身走 DeepSeek 的
`tool_addition` / `defer_loading` 通道，属于 DSH 已经实现的动态工具更新机制，不修改内核、不引入依赖。

## 它解决的问题

一个装满插件的 profile，工具声明（`request/header.tools`）很容易到 4 万字符上下。实测某个 42 工具的会话是
**39,429 字符**，这些字符每次请求都随前缀发送，也会被反复写入/读取缓存。绝大多数会话只用到其中 5–10 个工具。

本插件把工具面拆成两层：

- **常驻层**：`read` `write` `edit` `glob` `grep` `pwsh` `bash` `read_image` `web_fetch` `todo_write`
  `ask_user_question` `skill` `present` `job_list` `job_output` `job_kill` `exit_plan_mode`（可用 `visible` 增补）。
  这份清单不是拍脑袋：它来自 200 个会话、17,166 次工具调用的统计——非延迟工具里月调用 ≥100 次且 schema
  <1.5k 字符的保持常驻，其余全部延迟；`run_code` 因 `restrict()` 无法命名而天然常驻；
- **延迟层**：其余全部已安装工具。它们不在初始工具表里，只在系统提示词里留一句目录，模型用
  `toolbox_search` 查找、用 `toolbox_load` 激活。这句目录按 **该 agent 自己的**工具表生成（不列别的预设才有的工具，
  也不列本会话已加载的），并在会话首次组装时固定下来：DSH 对变化的系统提示词是「追加」而非原地重写，目录若随每次
  激活一起缩水，每激活一次就要多付一份完整提示词。

## 工作机制

1. `agent/created` 时，插件先读取 **该 agent 自己的工具视图**（此时还没有本插件的限制），把「不在常驻层」的名字组成 deny 表，
   再调用 `agent.ctx.tools.restrict({ deny })`。用 deny 而不是 allow：preset 以 scope 局部注册的核心工具（`read`/`write`/`pwsh` 等）
   不在全局注册表里，allow-list 会连它们一起藏掉；deny 只针对确实该隐藏的名字，且重建时会跳过本会话已激活的工具。
   插件加载时（启停、更新、hot reload）还会对 `ctx.agents.list()` 里已经活着的 agent 各做一次同样的事——否则卸载时释放掉的
   限制再也不会有人补回来，老会话会静默地跑在全量工具面上；
2. 模型调用 `toolbox_load(["name"])` 后，插件先撤销旧限制、重新读取该 agent 的工具视图，得到**该会话真实装配的工具面**；
   名字不在其中就返回 `unavailable`（只被别的预设装配、本会话没有），不会伪造成"已激活"——`restrict()` 只能取消隐藏，不能创造工具；
3. 工具表发生变化，agent-loop 自动写入一条 `developer/message`（source: `tool-registry`，含 `tool-addition` 块）；
4. 路由声明了 `toolUpdate` 能力时，DeepSeek 适配器把该块序列化为 `tool_addition`，并给本次请求加
   `anthropic-beta` 的 tool-changes 头；不是重写前缀，而是追加激活块；
5. 若路由没有声明该能力，DSH 会剥掉 developer 消息、让工具直接在下一次工具表里生效 —— 功能仍然可用，只是没有增量通道；
6. 切预设、装卸插件会触发 `tools/change`：插件重算工具面，已激活但新预设不再装配的名字从激活集合里移除，并出现在
   `toolbox_status.dropped`。

**注意呈现方式**：以上第 3–5 步只发生在 **native 呈现**（`standard`/`cordis`/`minimal` 以及没有声明 executor 的自定义预设）——
工具逐个进 `request/header.tools`，才有增量可追加。**PTC 呈现**（`ptc`、`flash-lean-ptc-v3`）下 header 恒为 `[run_code]`，
工具面在系统提示词的 `ToolArgsMap` SDK 块里，因此没有 `tool-addition`；每次 load 会让下一次请求的系统提示词变大，
相当于重写前缀（缓存失效），应集中加载。

激活状态不落盘：恢复会话时从 `session.toolHistory()` 推导（会话日志是唯一真相），因此续聊、fork 都一致。
为避免「续聊后突然全隐藏」，`resumePreserve` 默认开启：会话历史里已声明过的非常驻工具会被视为已加载。

## 工具

| 工具 | 作用 |
| --- | --- |
| `toolbox_search(query, limit?)` | 在当前预设装配、但被隐藏的工具里按分词后的关键词搜索 |
| `toolbox_load(names[])` | 激活指定工具；返回参数名与必填项。本会话没装配的名字进 `unavailable`，安装里根本不存在的进 `unknown` |
| `toolbox_status()` | 诊断：provider/model、路由 `toolUpdate`、`composedToolCount`、常驻/已加载/未加载、`dropped`、`census` |
| `toolbox_census(dryRun?)` | 立刻普查一次并重算常驻层；`dryRun` 只报不改 |

## 常驻层的自动校准（每月）

常驻层不再是写死的常量，而是**按本机真实用量定期重算**：

- 数据来源是 DSH 的 `sessionQuery` 服务：`listSessions()` 取会话、`inspectSession()` 读事件，
  统计 `tool/call` 与 `tool/ptc-dispatch` 的次数（PTC 预设下后者才有内层工具名）；
- 只读、只统计窗口（`windowDays`，默认 30 天）内、最近 `maxSessions`（默认 200）个会话；会话之间 `setImmediate` 让出，
  不阻塞 agent loop。本机实测 109 会话 / 10,069 次调用 / 3.7 秒；
- 分母是**实际覆盖天数**（最早一条计数事件到现在，上限为窗口），所以历史很短的新机器不会因为「除以 30」把所有工具
  都判成低频；
- schema 大小取自插件自己观测到的真实工具声明（`universe`），不依赖日志里的 `request/header.tools`；
- 计时锚在「跑完一次普查」：结果带 `lastAt`，下次到期 = `lastAt + intervalDays`。没有记录时（全新安装）在加载后
  `startDelayMs`（默认 30 秒）跑第一次。周期可配（1–365 天），`0` = 只手动；
- 阈值（`windowDays`/`minCallsPerDay`/`maxSchemaChars`/`dominantCallsPerDay`）一变，旧结果作废，下次按新规则重算；
- 结果写到 `$DSH_HOME/lazy-tools/census.json`，重启后直接采用，不会重扫；
- 生效时会重建每个活着的 agent 的限制，并让已冻结的提示词目录在下一次组装时重算；
- `visible` 始终是叠加项：用户钉住的工具不会被普查挤掉；`census.apply: false` 只记录不改动。

## 配置（`cordis.patch.yml` 的 `lazy-tools` 行）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `visible` | `[]` | 追加到常驻层的工具名；不存在的名字会被忽略 |
| `promptSection` | `true` | 是否注入「延迟工具目录」提示词段 |
| `promptOrder` | `3150` | 该段的排序号（在 MCP_SERVERS 与 TOOLS_SDK 之间） |
| `searchLimit` | `8` | `toolbox_search` 默认返回条数，上限 50 |
| `statusTool` | `true` | 是否注册 `toolbox_status` |
| `resumePreserve` | `true` | 续聊时把历史里已声明的工具视为已加载 |
| `census.enabled` | `true` | 是否定期自动普查 |
| `census.intervalDays` | `30` | 间隔天数，`0` = 只手动 |
| `census.windowDays` | `30` | 统计窗口 |
| `census.minCallsPerDay` | `3` | 日均低于此值 → 延迟 |
| `census.maxSchemaChars` | `1500` | schema 大于此值不常驻（除非高频） |
| `census.dominantCallsPerDay` | `50` | 日均高于此值无条件常驻 |
| `census.maxSessions` | `200` | 最近会话样本上限 |
| `census.apply` | `true` | 结果是否真的写进常驻层 |
| `census.startDelayMs` | `30000` | 首次普查在加载后多久开跑 |

示例：把 `subagent` 与 `web_search` 也留在常驻层：

```yaml
- id: lazy-tools
  config:
    visible: [subagent, web_search]
```

常驻层的初始值来自作者环境的一份 30 天统计，**装好之后由每月普查按你自己的用量重算**；想固定某些工具仍然用
`visible`（它是叠加项，不会被普查覆盖）。不开 DSH 也可以先手动看：`python scripts/tool-census.py --days 30`
直接读日志、不写文件，把标为 `resident` 的工具加进 `visible`，新会话用 `toolbox_status` 核对是否生效（写错的名字会被静默忽略）。

普查脚本只读 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，不联网、不写文件；需要 Python 3.10+ 与
`zstandard`（`pip install zstandard`）。它统计每个工具被调用的次数（native 的 `tool/call` 与 PTC 的
`tool/ptc-dispatch`）、schema 字符数（取自 native 会话的 `request/header.tools`），按「日均 ≥3 次且
schema ≤1500 字符」判 `resident`，日均 ≥50 次的工具无论 schema 多大都常驻。常用参数：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `--days` | `30` | 统计窗口 |
| `--min-calls-per-day` | `3` | 低于此值的工具判 `defer` |
| `--max-schema-chars` | `1500` | schema 超过此值不常驻（除非高频） |
| `--dominant-calls-per-day` | `50` | 高于此值无条件 `resident` |
| `--sessions` | `~/.dsh/sessions` | 日志根目录 |
| `--json` | 关 | 机器可读输出 |

脚本在仓库的 `scripts/tool-census.py`；从 GitHub 安装的 bundle 里位于
`~/.dsh/profiles/<profile>/node_modules/dsh-lazy-tools/scripts/`（0.1.5 起随包发布）。

## 实测数据（测试环境：DSH Desktop 2.0.23-next / 2.0.24-next、`@deepseek-ai/dsh@0.2.2-rc.3` / `0.2.2-rc.5`、Windows）

- 基线（未启用插件的新会话）：42 个工具、**39,429 字符**；
- 其中 14 个常驻工具占 13,034 字符，可隐藏的候选工具占约 26,300 字符；
- 启用插件后的新会话：**首个请求 18 个工具、14,496 字符**（16 项常驻里的 15 项 + 3 个 toolbox；`exit_plan_mode`
  在首个请求后由 preset 注册），隐藏约 24 个工具；
- 模型路由实测 `toolUpdate: addition-only`，`toolbox_load` 后日志出现 `developer/message(tool-addition)`，
  被加载工具随即可调用。

## 已知限制

- **能不能立刻省，取决于会话里已经声明过什么**。插件加载时会扫描 `ctx.agents.list()`，给当时活着的 agent 补上限制；
  但 `resumePreserve` 会把会话日志里已经声明过的工具视为已加载（否则模型手里有名字却调不动），所以插件启用前
  就已经见过全量工具表的老会话不会被「倒扣」回去——想要完整节省，新开一个对话。
- `tools.restrict()` 只作用于该 agent 继承链上的工具；由 agent 自身 scope 注册的工具无法被命名，插件会自动过滤掉这类名字，
  这是刻意保留的安全边界。
- `addition-only` 路由会丢弃 `tool_removal`，所以已加载的工具**在本会话内**无法再收回（没有会话内 unload）：它只在本次对话里保持常驻。
  这与「卸载插件」无关——插件随时可以禁用或移除，见下方「卸载插件」。
- 与其它同样使用 `tools.restrict` 的插件叠加时，限制取交集，可能「过度隐藏」。出现异常时禁用本插件即可恢复。
- 路由没有 `toolUpdate` 能力时，加载仍然有效，但不会出现 `tool_addition` 块，节省的是「初始工具表」而不是「增量更新」。
  可用 `toolbox_status` 查看能力值。

## 排障

1. 新会话里调用 `toolbox_status`，确认 `toolUpdate` 为 `addition-only` / `in-history`，且 `restricted: true`；
2. 若 `toolUpdate` 为 `null`，在 profile 的 `cordis.patch.yml` 里为 account 路由声明能力后重载：

```yaml
- id: llm-deepseek-account
  config:
    modelOverrides:
      deepseek-flash:
        toolUpdate: 'addition-only'
```

3. 若出现 HTTP 400 / `tool_addition` 相关报错，立即禁用本插件（`set_plugin enabled:false`）并删除上面的 override。
4. 修改 `index.js` 后需要对 bundle 做一次 disable → enable，已装载的 JS 模块不会热替换。

## 卸载插件

插件管理器禁用或移除 `lazy-tools` 行即可：每个 agent 上的限制会随插件 fiber 与 agent scope 一起销毁，
新会话恢复完整工具面。
