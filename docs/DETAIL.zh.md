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
- **延迟层**：其余全部全局工具。它们不在初始工具表里，只在系统提示词里留一句目录，模型用
  `toolbox_search` 查找、用 `toolbox_load` 激活。

## 工作机制

1. `agent/created` 时，插件先读取 **该 agent 自己的工具视图**（此时还没有本插件的限制），把「不在常驻层」的名字组成 deny 表，
   再调用 `agent.ctx.tools.restrict({ deny })`。用 deny 而不是 allow：preset 以 scope 局部注册的核心工具（`read`/`write`/`pwsh` 等）
   不在全局注册表里，allow-list 会连它们一起藏掉；deny 只针对确实该隐藏的名字，且重建时会跳过本会话已激活的工具；
2. 模型调用 `toolbox_load(["name"])` 后，插件把名字加入该会话的激活集合，先撤销旧限制、重新读取该 agent 的工具视图，再按新集合重建 deny 表；
3. 工具表发生变化，agent-loop 自动写入一条 `developer/message`（source: `tool-registry`，含 `tool-addition` 块）；
4. 路由声明了 `toolUpdate` 能力时，DeepSeek 适配器把该块序列化为 `tool_addition`，并给本次请求加
   `anthropic-beta` 的 tool-changes 头；不是重写前缀，而是追加激活块；
5. 若路由没有声明该能力，DSH 会剥掉 developer 消息、让工具直接在下一次工具表里生效 —— 功能仍然可用，只是没有增量通道。

激活状态不落盘：恢复会话时从 `session.toolHistory()` 推导（会话日志是唯一真相），因此续聊、fork 都一致。
为避免「续聊后突然全隐藏」，`resumePreserve` 默认开启：会话历史里已声明过的非常驻工具会被视为已加载。

## 工具

| 工具 | 作用 |
| --- | --- |
| `toolbox_search(query, limit?)` | 在「已安装但未加载」的工具里按名称/描述搜索，返回名称、一句话描述、是否已加载 |
| `toolbox_load(names[])` | 激活指定工具；返回参数名与必填项，下一步即可调用 |
| `toolbox_status()` | 诊断：当前 provider/model、路由 `toolUpdate` 能力、常驻/已加载/未加载清单 |

## 配置（`cordis.patch.yml` 的 `lazy-tools` 行）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `visible` | `[]` | 追加到常驻层的工具名；不存在的名字会被忽略 |
| `promptSection` | `true` | 是否注入「延迟工具目录」提示词段 |
| `promptOrder` | `3150` | 该段的排序号（在 MCP_SERVERS 与 TOOLS_SDK 之间） |
| `searchLimit` | `8` | `toolbox_search` 默认返回条数，上限 50 |
| `statusTool` | `true` | 是否注册 `toolbox_status` |
| `resumePreserve` | `true` | 续聊时把历史里已声明的工具视为已加载 |

示例：把 `subagent` 与 `web_search` 也留在常驻层：

```yaml
- id: lazy-tools
  config:
    visible: [subagent, web_search]
```

常驻层默认值来自作者环境的一份 30 天统计，**装好后请按自己的用量调整**：跑
`python scripts/tool-census.py --days 30` 得到自己的日均调用次数与 schema 大小，把标为 `resident` 的工具加进
`visible`，新会话用 `toolbox_status` 核对是否生效（写错的名字会被静默忽略）。

## 实测数据（测试环境：DSH Desktop 2.0.23-next、`@deepseek-ai/dsh@0.2.2-rc.3`、Windows）

- 基线（未启用插件的新会话）：42 个工具、**39,429 字符**；
- 其中 14 个常驻工具占 13,034 字符，可隐藏的候选工具占约 26,300 字符；
- 启用插件后的新会话：**首个请求 18 个工具、14,496 字符**（16 项常驻里的 15 项 + 3 个 toolbox；`exit_plan_mode`
  在首个请求后由 preset 注册），隐藏约 24 个工具；
- 模型路由实测 `toolUpdate: addition-only`，`toolbox_load` 后日志出现 `developer/message(tool-addition)`，
  被加载工具随即可调用。

## 已知限制

- **只影响新创建的 agent**。插件安装/启用前已经存在的会话不会被回溯限制，需要新开对话。
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
