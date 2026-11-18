# dsh-lazy-tools

**定位：本插件不改变任何工具的可用性，只改变它何时出现在工具表里** —— 被藏起来的工具，模型下一步就能用
`toolbox_load` 装回来，不需要人工干预。

> **TL;DR** — A zero-dependency DeepSeek Harness (DSH) bundle that keeps a
> curated tool surface resident and hides everything else behind a per-agent `tools.restrict({ deny })` restriction.
> Hidden tools are discovered with `toolbox_search` and activated with `toolbox_load`; the activation travels through
> the DeepSeek `tool_addition` channel, so no tool definition is ever resent. On the reference profile this cut the
> per-request tool declarations from **39,429 to 14,496 characters (−63%)** without removing any installed tool.
> It never makes a tool unavailable: it only changes when a tool appears in the tool table, and the model can restore
> any hidden tool in one step.
>
> Install: **Plugin Manager → Install bundle → `github:lain312ly/dsh-lazy-tools#v0.1.5`**

## 它解决的问题

装满插件的 profile，工具声明（`request/header.tools`）很容易到 4 万字符：这些 schema 随每个请求一起发送，进了前缀缓存，
而绝大多数会话实际只用到其中 5–10 个工具。

`dsh-lazy-tools` 把工具面拆成两层：

- **常驻层**：按参考环境近 30 天 200 个会话、17,166 次工具调用的统计挑选，非延迟工具里月调用 ≥100 次且 schema <1.5k 字符的保留常驻
  （`read` `write` `edit` `glob` `grep` `pwsh` `bash` `read_image` `web_fetch` `todo_write` `ask_user_question` `skill`
  `present` `job_list` `job_output` `job_kill` `exit_plan_mode`），可用 `visible` 增补；
- **延迟层**：其余全部已安装工具。它们不在初始工具表里，只在系统提示词里留一段紧凑目录，模型用 `toolbox_search` 查找、
  用 `toolbox_load` 激活。

`run_code`（PTC 传输层）无法被 `tools.restrict()` 命名，因此天然常驻。

## 工作机制

1. `agent/created` 时，插件先读取**该 agent 自己的**工具视图（此时还没有本插件的限制），把「不在常驻层」的名字组成 deny 表，
   再调用 `agent.ctx.tools.restrict({ deny })`。用 deny 而不是 allow：preset 以 scope 局部注册的核心工具
   （`read`/`write`/`pwsh` 等）不在全局注册表里，allow-list 会把它们一起藏掉；
2. 模型调用 `toolbox_load(["name"])` 后，名字进入该会话的激活集合，插件撤销旧限制、重新读取该 agent 的工具视图，按新集合重建 deny 表；
3. 工具表变化后，agent-loop 自动写入一条 `developer/message`（source `tool-registry`，含 `tool-addition` 块）；
4. 路由声明了 `toolUpdate` 能力时，DeepSeek 适配器把该块序列化为 `tool_addition` 并给本次请求加上
   `anthropic-beta` 的 tool-changes 头——追加激活块，而不是重写前缀；
5. 路由没有声明该能力时，DSH 会剥掉 developer 消息、让工具直接在下一次的工具表里生效：功能仍然可用，只是省下的是
   初始工具表而非增量通道。

激活状态不落盘：恢复会话时从 `session.toolHistory()` 推导（会话日志是唯一真相），因此续聊、fork 都一致。
`resumePreserve`（默认开启）把历史里已声明过的非常驻工具视为已加载，避免续聊后工具突然消失。

不修改 DSH 内核，不引入任何依赖，工具定义就是 `ctx.tools.register` 认识的普通对象。

## 安装

前置条件：DeepSeek Harness Desktop 或 `dsh web`，且会话使用 DeepSeek 路由（只要路由支持工具更新即可，见「兼容性」）。

**方式一：GUI**（推荐）— 打开插件管理，安装 bundle，填：

```
github:lain312ly/dsh-lazy-tools#v0.1.5
```

**方式二：让 agent 装** — 对 agent 说「安装 `github:lain312ly/dsh-lazy-tools#v0.1.5` 这个 bundle」，
它会调用 `plugin_manager` 的 `install_bundle`（target 同上）。

**方式三：手动** — 往 `~/.dsh/profiles/<profile>/package.json` 加依赖与 bundle 条目：

```json
{
  "dependencies": {
    "dsh-lazy-tools": "github:lain312ly/dsh-lazy-tools#v0.1.5"
  },
  "dsh": {
    "profile": {
      "bundles": ["...已有序列表...", "dsh-lazy-tools"]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`（或让 DSH 重启时补装），重启 DSH。

安装后，**新对话立刻**生效；已经开着的会话会在插件加载时被补上限制（0.1.2 起），但如果该会话日志里已经声明过
全量工具，这些工具会按「已加载」保留（`resumePreserve`，否则模型手里有名字却调不动）。想看到完整的「首请求只剩
常驻层」，新开一个对话即可。

## 配置

默认值写在 `cordis.patch.yml` 的 `lazy-tools` 行；在 profile 级 patch 里覆盖同一个 `id` 会整体替换该行的 `config`：

```yaml
- id: lazy-tools
  config:
    visible: [subagent, web_search]
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `visible` | `[]` | 追加到常驻层的工具名；不存在的名字会被忽略 |
| `promptSection` | `true` | 是否注入「延迟工具目录」提示词段 |
| `promptOrder` | `3150` | 该段的排序号（在 MCP_SERVERS 与 TOOLS_SDK 之间） |
| `searchLimit` | `8` | `toolbox_search` 默认返回条数，上限 50 |
| `statusTool` | `true` | 是否注册 `toolbox_status` |
| `resumePreserve` | `true` | 续聊时把历史里已声明的工具视为已加载 |

## 按自己的情况调常驻层（重要）

**默认的 17 个常驻工具是作者按自己机器的一份 30 天统计挑的**（200 个会话、17,166 次工具调用），你的工具组合几乎肯定不一样：你可能没有 `job_*`、可能天天用 `subagent`、可能装了 20 个 MCP 工具。所以装好之后建议花两分钟核一遍。

三步：

1. **用自带的普查脚本看自己的真实调用分布**（只读：只打开 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，
   不联网、不写任何文件）：

   ```bash
   python scripts/tool-census.py            # 最近 30 天，日均 ≥3 次算 resident
   python scripts/tool-census.py --days 60 --min-calls-per-day 5
   python scripts/tool-census.py --json     # 机器可读，便于自己再加工
   ```

   | 参数 | 默认 | 作用 |
   | --- | --- | --- |
   | `--days` | `30` | 统计窗口（天） |
   | `--min-calls-per-day` | `3` | 日均调用低于此值 → `defer` |
   | `--max-schema-chars` | `1500` | schema 超过此值就不常驻（除非满足下一条） |
   | `--dominant-calls-per-day` | `50` | 日均高于此值 → 无论 schema 多大都 `resident` |
   | `--sessions` | `~/.dsh/sessions` | 日志根目录（DSH_HOME 不在默认位置时用） |
   | `--json` | 关 | 输出完整 JSON（含每个工具的 `rows`） |

   输出示例（本机 2026-11-18 实测节选，`schema` 单位字符）：

   ```
   # tool census — last 30 days, 188 sessions

   tool                              calls  calls/day   schema  suggestion
   ----------------------------------------------------------------------------
   pwsh                               3729      124.3     3543  resident
   edit                               2307       76.9     1195  resident
   read                               1993      66.43      462  resident
   write                               901      30.03      887  resident
   grep                                636       21.2      726  resident
   todo_write                          248       8.27      893  resident
   web_fetch                           140       4.67      256  resident
   send_message                         89       2.97      547  defer
   subagent                             80       2.67     2155  defer

   resident (put these in the plugin's `visible`):
     pwsh, edit, read, write, grep, todo_write, web_fetch
   ```

   判定规则：
   - 日均 ≥3 次且 schema ≤1500 字符 → `resident`（常驻，省的加载步骤比省下的字符更值钱）
   - 日均 ≥50 次 → 无论 schema 多大都 `resident`（比如 `pwsh` 3.5k 字符，但一天用 100 次）
   - 其余 → `defer`（留在延迟层，需要时 `toolbox_load` 一次）
   - `run_code` 永远常驻且不能写进 `visible`；`toolbox_*` 三件套自动可用

   > 脚本在仓库的 `scripts/tool-census.py`；从 GitHub 安装的 bundle 里它位于
   > `~/.dsh/profiles/<profile>/node_modules/dsh-lazy-tools/scripts/`（0.1.5 起随包发布）。
   > 需要 Python 3.10+ 与 `zstandard`（`pip install zstandard`）。

2. **把你确实每次都要用的写进 `visible`**：

   ```yaml
   - id: lazy-tools
     config:
       visible: [present, send_message, web_search]
   ```

3. **新开一个会话核对**：调 `toolbox_status`，看返回的 `visible` 是否包含你加的名字、`awaitingCount` 是否下降。写错的名字会被静默忽略。

几条实操建议：

- **延迟层最划算的是「schema 大、频率低」的工具**（`subagent` 2.1k、`cua_driver_native__*` 6.6k、`office_*`、`workflow`）——它们一年也用不了几次，却每次都在占位置；
- **不要为了省字符把高频小工具藏起来**：`read`/`grep`/`todo_write` 这种几百字符、一天几十次的，藏了只会多一步加载；
- 统计窗口里可能包含**已经卸载的插件**（`ops_*`、`compress` 之类），以 `toolbox_status` 的 `awaiting` 名单为准；
- 连「延迟工具目录」提示词段都不想要可以设 `promptSection: false`，但模型就不知道还有哪些工具可加载，只会在明确知道名字时才 `toolbox_load`——通常不建议。

## 工具

| 工具 | 作用 |
| --- | --- |
| `toolbox_search(query, limit?)` | 在**当前预设能拿到的**已隐藏工具里按分词后的关键词搜索，返回名称、一句话描述 |
| `toolbox_load(names[])` | 激活指定工具；返回参数名与必填项，下一步即可调用。本预设没装配的名字会出现在 `unavailable` 里，不会被伪造成"已激活" |
| `toolbox_status()` | 诊断：provider/model、路由 `toolUpdate` 能力、`composedToolCount`（本会话真实工具面）、`visible`（本步真能调用的常驻工具，`visible ⊆ agentToolCount`）、常驻/已加载/未加载清单、`dropped`（因切预设而失效的激活） |

名字已经知道时只需一步：`toolbox_load(["schedule_list"])`。`toolbox_search` 是「只知道意图、不知道名字」时的兜底。

## 实测数据

测试环境：DSH Desktop 2.0.23-next、`@deepseek-ai/dsh@0.2.2-rc.3`、Windows、`desktop` profile。

| 场景 | 首个 `request/header` | 字符 |
| --- | --- | --- |
| 未启用插件 | 42 个工具 | 39,429 |
| 已启用插件 | 18 个工具 | 14,496 |
| 禁用回归 | 41 个工具 | 38,941 |

- 18 = 常驻层 16 项里当时已注册的 15 项 + 3 个 toolbox 工具（`exit_plan_mode` 由 preset 在首个请求后注册）；
  其余约 24 个工具进入延迟层，`toolbox_status` 报告 `awaitingCount: 87`（含只在其它 agent 视图里的工具）；
- 路由能力实测 `toolUpdate: "addition-only"`，`toolbox_load` 后会话日志出现 `developer/message(tool-addition)`，
  被加载的工具紧接着就能调用；
- 单轮 `inputTokens` 约 6,795（子会话实测）。

完整证据（22 条事实、10 项自检、复现命令）见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

**PTC 预设（`ptc`）实测**（2026-11-18，同一任务跑两次 + 一次对照）：`request/header.tools` 恒为 `[run_code]`，
工具面在系统提示词的 `ToolArgsMap` SDK 块里——对照 57,065 字符 / 31 个工具，开插件后 **19,907 字符 / 16 个工具
（−65.1% / −59% 系统提示词）**；每步平均 input token 从 1,506.9 降到 891.3 / 1,123.3，三个会话的工件（测试、报告）
全部通过。细节与偏差记录见 `_lazy-test/EVAL.md`（工作区，不随仓库发布）。

## 兼容性

**先看你的预设是哪种工具呈现方式**，这决定插件能省在哪里、怎么省：

| 呈现方式 | 典型预设 | 模型看到的工具面 | 插件的作用 |
| --- | --- | --- | --- |
| **native**（默认） | `standard`、`cordis`、`minimal`，以及没声明 executor 的自定义预设 | 每个工具一个 schema，进 `request/header.tools` | 首条请求直接少发几十个 schema；`toolbox_load` 走**增量 `tool_addition`**，追加而不重写前缀 |
| **PTC** | `ptc`（挂 `tool-executor-ptc`）、`flash-lean-ptc-v3`（挂 `tool-presentation: {mode: ptc}`） | 只有 `run_code`，其余工具以 `ToolArgsMap` SDK 块写在**系统提示词**里 | 省的是系统提示词（实测 −59%）；header 不变，**没有 `tool_addition` 可用**，每次 load 会改写一次系统提示词 → 触发一次前缀缓存失效，建议集中加载 |

- 在 `@deepseek-ai/dsh@0.2.2-rc.3` 上验证；插件只用到 `ctx.tools.restrict`、`ctx.systemPrompt.section`、
  `ctx.on('agent/created' | 'agent/disposed' | 'tools/change')`、`ctx.agents.list()`、`session.toolHistory()`、
  `agent.model.current()` 这些公开面；
- native 呈现下路由的 `toolUpdate` 能力决定增量通道形态：`addition-only` / `in-history` 走 `tool_addition`；
  `null` 时加载仍然有效，只是工具在下一份完整工具表里生效；
- `tools.restrict()` 只能**取消隐藏**本预设已装配的工具，不能创造工具——所以 `toolbox_load` 只对本会话的工具面生效，
  其余名字会返回 `unavailable`（这就是 0.1.1 修掉的那个坑）；
- 其它平台（macOS / Linux）未实测；`bash` 只在存在该工具时才会留在常驻层，Windows 上不会出现。

## 已知限制

- **能不能立刻省，取决于会话里已经声明过什么。** 插件加载时会扫描 `ctx.agents.list()`，给当时活着的 agent 补上限制
  （0.1.2 起）；但 `resumePreserve` 会把会话日志里已经声明过的工具视为已加载（否则模型手里有名字却调不动），
  所以插件启用前就已经见过全量工具表的老会话不会被「倒扣」回去——想要完整节省，新开一个对话。
- `tools.restrict()` 只能命名该 agent 继承链上的工具；agent 自身 scope 注册的工具无法被命名，插件会自动过滤掉这类名字
  （刻意保留的安全边界）。
- `addition-only` 路由会丢弃 `tool_removal`，所以**已加载的工具在本会话内无法再收回**（没有会话内 unload）：
  它只在本次对话里占用常驻额度，对后续对话没有影响。注意这与「卸载插件」无关——插件随时可以在插件管理里禁用或移除，
  见下方「卸载插件」。
- 与其它同样使用 `tools.restrict` 的插件叠加时，限制取交集，可能过度隐藏；出现异常禁用本插件即可恢复。
- `visible` 里写错的名字会被静默忽略（用 `toolbox_status` 的 `visible` 字段核对）。

## 排障

1. 新会话里调用 `toolbox_status`，确认 `restricted: true`、`toolUpdate` 为 `addition-only` 或 `in-history`；
2. 若 `toolUpdate` 是 `null`，在 profile 的 `cordis.patch.yml` 给路由声明能力后重载：

```yaml
- id: llm-deepseek-account
  config:
    modelOverrides:
      deepseek-flash:
        toolUpdate: 'addition-only'
```

3. 若出现 HTTP 400 或 `tool_addition` 相关报错，先禁用本插件并删除上面的 override；
4. 改了 `index.js` 后必须对 bundle 做一次 disable → enable：已装载的 JS 模块不会热替换。
   启停会释放所有已有 agent 上的限制，0.1.2 起插件加载时会自动给它们补回（`ctx.agents.list()`）；
   如果某个老会话日志里已经声明过全量工具，它会按「已加载」保留，看起来就像没生效——那是对该会话的正确行为；
5. `toolbox_status` 的 `restricted` / `composedToolCount` 是**调用那一刻**的读数，不是配置快照：切预设后
   `composedToolCount` 会跟着变；`activated` 里列出一堆名字，通常说明该会话日志里已经声明过它们
   （`resumePreserve`，用于恢复会话），不是插件乱激活。

## 卸载插件

插件管理里禁用或移除 `lazy-tools` 行即可，随时可做，不需要改任何代码：

- 每个 agent 上的限制随插件 fiber 与 agent scope 一起销毁，**新开一个对话就恢复完整工具面**
  （实测：禁用后新会话 41 个工具 / 38,941 字符）；
- 当前已存在的会话不受影响，它们本来就没被本插件限制过，或在禁用时保持原样；
- 用链接方式（`link:`）安装的，删除 profile `package.json` 里对应的 `dependencies` 与 `bundles` 条目后重装依赖即可。

## 目录结构

```
dsh-lazy-tools/
├─ index.js                    # 插件本体（单文件、零依赖）
├─ cordis.patch.yml            # bundle 默认行配置
├─ locale/{en,zh}.json         # 插件管理里的标题/描述/详情文档指针
├─ icon.svg                    # 插件图标
├─ docs/
│  ├─ DETAIL.zh.md             # 中文设计文档（插件详情页）
│  ├─ DETAIL.en.md             # 英文设计文档
│  └─ VERIFICATION.md          # 实测证据与复现步骤
├─ test/
│  └─ lazy-tools.test.mjs      # 内存 harness 的行为测试（npm test）
├─ scripts/
│  ├─ check-package.mjs        # 清单/资源自检（npm run check）
│  ├─ tool-census.py           # 按自己的用量算 visible 建议
│  └─ verify-session-tools.py  # 从会话日志验证效果
├─ CONTRIBUTING.md             # 本地检查与发版流程（维护者文档，不随包发布）
└─ .github/workflows/ci.yml
```

## 开发

```bash
npm run check     # node --check + 清单/资源自检
npm test          # 内存 harness 行为测试：隐藏/激活/unavailable/分词搜索/切预设清理/重载补限制
npm run verify    # 读取 ~/.dsh/sessions 最新日志，断言首个工具表足够小且出现 tool_addition
python scripts/tool-census.py --days 30   # 按自己的历史调用频率，给出 visible 建议
```

`verify` 需要 Python 3.10+ 与 `zstandard`（`pip install zstandard`），只读取 `*.jsonl.zstd` 会话日志，不写任何文件；
DSH_HOME 不在默认位置时用 `--sessions <path>` 指定。

本仓库以链接方式安装（`link:`）时改动立即生效，但要重载 bundle 才会重新加载 JS 模块。

发版流程（改版本号、打 tag、推送）见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE) © 2026 lain
