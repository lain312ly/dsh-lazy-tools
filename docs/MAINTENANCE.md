# 维护记录

每周六 08:00 有一个会话任务做插件可用性检测：跑 `npm run check` / `npm test`、用真实会话冒烟、
把结论写回这里并推到 `main`；发现 bug 就修，小修在当前次版本线上发四段 tag（现在 `v0.1.6.x`），
大问题发下一个次版本（现在 `v0.1.7`），规则见 [CONTRIBUTING](../CONTRIBUTING.md#版本号规则)。

**新记录加在表格顶部**，详情写在该行对应的分节里。表格只放结论与证据指针，长内容进分节。

| 日期 | DSH / Desktop | 结论 | 发版 | 详情 |
| --- | --- | --- | --- | --- |
| 2026-11-28（定时） | 0.2.2-rc.5 / 2.0.24-next（未变） | 可用，无改动 | 未发版 | 本节 |
| 2026-11-24（手动，非定时） | 0.2.2-rc.5 / 2.0.24-next | 可用；顺手修掉提示词目录的误报 | `v0.1.5.1` | 本节 |

## 2026-11-28 — 定时周检（首跑）

**结论**：可用，没有需要修的东西，因此没有发版。这周唯一的代码变动是上一轮（11-27）的两次发布
（`v0.1.6` 每月自动普查、`v0.1.6.1` 装插件后重建提示词目录），都是手写功能/修复，不是本周检出的问题。

**环境**：`dsh-desktop-next 2.0.24-next`、`@deepseek-ai/dsh 0.2.2-rc.5`、Electron 44.7.0（宿主 Node 24.21.0），
与上次记录一致，没有升级。

**静态**：`npm run check` 通过；`npm test` 22/22（含 7 个普查用例、2 个目录重建用例）。

**真实会话冒烟**（子会话 `bd3e672a`，cordis 预设，按 CONTRIBUTING 第 3 条逐项做）：

| 检查 | 观察 |
| --- | --- |
| 首个工具表 | **13 个工具 / 10,741 字符**，正好是普查出的 9 项常驻 + 4 个 toolbox 工具（未启用插件的基线是 42 工具 / 39,429 字符，见本会话首条 header） |
| 限制生效 | `toolbox_status`：`restricted: true`、`agentToolCount: 13`、`composedToolCount: 50`、`visible` 9 项、`awaitingCount: 37` |
| 搜索 | `toolbox_search("list subagent models")` → `total: 17`，第一个结果是 `list_subagent_models` |
| 激活 | `toolbox_load(["list_subagent_models"])` → `activated: [list_subagent_models]`、`unavailable: []` |
| 增量通道 | 第二个 `request/header` 由 13 → **14** 个工具（`laterAdded: [list_subagent_models]`），日志里 `developer/message` 携 `tool-addition`（seq 31） |
| 加载后可用 | `list_subagent_models()` 返回 `deepseek-account — DeepSeek Account` |
| 提示词目录 | 子会话贴出的是「Deferred tools of your preset …」共 37 个名字，与 `awaitingCount: 37` 一致 |
| 报错 | 子会话 4 个工具的 5 次调用，`errors: 0` |
| 形式化验收 | `verify-session-tools.py --check --max-tools 20 --max-chars 16000 --require-tools read,write,pwsh --expect-addition` → `PASS … tools=13 chars=10741 additions=1` |

**普查自洽**（`toolbox_census({dryRun: true})`，只报不改）：111 会话 / 10,611 次调用 / 覆盖 30.0 天 / 3.9 秒 / 0 失败，
按当前阈值算出的常驻层与正在生效的 9 项**完全一致**（`added: []`、`removed: []`）；`lastRunAt` 11-27 22:45、
`nextRunAt` 12-27 22:45，间隔 30 天，记录文件在 `C:\Users\lain\.dsh\lazy-tools\census.json`。

**未验证**：本周没有跑 PTC 呈现（`flash-lean-ptc-v3`）的冒烟——子代理固定走 `cordis`；`v0.1.6.1` 的目录重建
仍只有单测证据（没在真实会话运行期间装插件）；真实 30 天普查跨越仍未发生（第一次到期是 12-27）。

## 2026-11-24 — 提示词目录按 agent 生成

**结论**：可用。这一轮不是新版兼容性问题（rc.5 的冒烟在 2026-11-19 已经过了，见
[VERIFICATION](VERIFICATION.md#compatibility-smoke--dsh-022-rc5--desktop-202024-next-2026-11-19)），
而是那次冒烟结尾记下的既有瑕疵，用户要求修掉。

**问题**：`lazy-tools-catalog` 提示词段在插件加载时用「进程级工具全集」生成，于是

1. 本会话**已经激活**的工具也被列进「不在你的工具列表里」的名单；
2. 别的 preset 装配、本会话根本装不了的也列进去（`subagent` 之类），模型照着去装只会得到 `unavailable`。

**修法**：`systemPrompt.section` 的 `text` provider 改为读取组装上下文里的 `{ agent, scope }`
（`assembleContextFor()` 两个字段都是同一个 agent 对象），按该 agent 自己的工具表生成清单；
并把结果在会话首次组装时固定——DSH 对变化的系统提示词是「追加整份重渲染结果」，
目录若随每次激活缩水，每激活一次就要多付一份完整提示词。没有 agent 的组装退回措辞明确的安装级清单。

**证据**：

- 单测 13/13（新增 4 个：只列本 preset、固定不变、无 agent 时退回安装级、无延迟工具时为空）；
- 本会话重载后系统提示词变为
  `Deferred tools of your preset, hidden from your tool list to save context: team_task_create, team_task_get, team_task_list, team_task_update.`
  —— 正好是 `toolbox_status.awaiting` 报的 4 项，已激活的 26 个工具不再出现，也没有别 preset 的名字；
- 新会话（非恢复）子代理 `catalog-check`（cordis 预设）：目录 30 个名字，自己可直接调用 18 个，两者交集为空；
- `npm run check` 通过（Node 24.19.0）。

**发版**：`v0.1.5.1`（提示词文案/边界修正，按规则留在 0.1.5 线，`package.json` 的 `version` 仍是 `0.1.5`）。

**没做的事**：没有验证「路由不支持 `in-history` 系统提示词」时的表现（当前 `deepseek-flash` 走 `in-history`）；
没有在 PTC 呈现下单独复测目录文案（PTC 下系统提示词本来就每次可变，结论应不差，但未实测）。
