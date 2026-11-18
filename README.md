# dsh-lazy-tools

> **TL;DR** — A zero-dependency DeepSeek Harness (DSH) bundle that keeps a
> curated tool surface resident and hides everything else behind a per-agent `tools.restrict({ deny })` restriction.
> Hidden tools are discovered with `toolbox_search` and activated with `toolbox_load`; the activation travels through
> the DeepSeek `tool_addition` channel, so no tool definition is ever resent. On the reference profile this cut the
> per-request tool declarations from **39,429 to 14,496 characters (−63%)** without removing any installed tool.
>
> Install: **Plugin Manager → Install bundle → `github:lain/dsh-lazy-tools#v0.1.0`**

## 它解决的问题

装满插件的 profile，工具声明（`request/header.tools`）很容易到 4 万字符：这些 schema 随每个请求一起发送，进了前缀缓存，
而绝大多数会话实际只用到其中 5–10 个工具。

`dsh-lazy-tools` 把工具面拆成两层：

- **常驻层**：按本机近 30 天 200 个会话、17,166 次工具调用的统计挑选，非延迟工具里月调用 ≥100 次且 schema <1.5k 字符的保留常驻
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
github:lain/dsh-lazy-tools#v0.1.0
```

**方式二：让 agent 装** — 对 agent 说「安装 `github:lain/dsh-lazy-tools#v0.1.0` 这个 bundle」，它会调用
`plugin_manager` 的 `install_bundle`（target 同上）。

**方式三：手动** — 往 `~/.dsh/profiles/<profile>/package.json` 加依赖与 bundle 条目：

```json
{
  "dependencies": {
    "dsh-lazy-tools": "github:lain/dsh-lazy-tools#v0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["...已有序列表...", "dsh-lazy-tools"]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`（或让 DSH 重启时补装），重启 DSH。

安装后**只影响新创建的 agent**：当前已存在的会话保持完整工具面，新开一个对话即可看到效果。

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

## 工具

| 工具 | 作用 |
| --- | --- |
| `toolbox_search(query, limit?)` | 在「已安装但未加载」的工具里按名称/描述搜索，返回名称、一句话描述、是否已加载 |
| `toolbox_load(names[])` | 激活指定工具；返回参数名与必填项，下一步即可调用 |
| `toolbox_status()` | 诊断：provider/model、路由 `toolUpdate` 能力、常驻/已加载/未加载清单 |

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

## 兼容性

- 在 `@deepseek-ai/dsh@0.2.2-rc.3` 上验证；插件只用到 `ctx.tools.restrict`、`ctx.systemPrompt.section`、
  `ctx.on('agent/created' | 'agent/disposed' | 'tools/change')`、`session.toolHistory()`、`agent.model.current()` 这些公开面；
- 路由的 `toolUpdate` 能力决定是否存在增量通道：
  - `addition-only` / `in-history`：`toolbox_load` 走 `tool_addition`，这是省字符的主路径；
  - `null`：加载仍然有效，只是工具在下一份完整工具表里生效。
- 其它平台（macOS / Linux）未实测；`bash` 只在存在该工具时才会留在常驻层，Windows 上不会出现。

## 已知限制

- **只影响新创建的 agent**。插件安装/启用前已经存在的会话不会被回溯限制。
- `tools.restrict()` 只能命名该 agent 继承链上的工具；agent 自身 scope 注册的工具无法被命名，插件会自动过滤掉这类名字
  （刻意保留的安全边界）。
- `addition-only` 路由会丢弃 `tool_removal`，所以**不提供卸载**：已加载的工具在本会话内保持可用。
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
├─ scripts/
│  ├─ check-package.mjs        # 清单/资源自检（npm run check）
│  └─ verify-session-tools.py  # 从会话日志验证效果
└─ .github/workflows/ci.yml
```

## 开发

```bash
npm run check     # node --check + 清单/资源自检
npm run verify    # 读取 ~/.dsh/sessions 最新日志，断言首个工具表足够小且出现 tool_addition
```

`verify` 需要 Python 3.10+ 与 `zstandard`（`pip install zstandard`），只读取 `*.jsonl.zstd` 会话日志，不写任何文件；
DSH_HOME 不在默认位置时用 `--sessions <path>` 指定。

本仓库以链接方式安装（`link:`）时改动立即生效，但要重载 bundle 才会重新加载 JS 模块。

## License

[MIT](LICENSE) © 2026 lain
