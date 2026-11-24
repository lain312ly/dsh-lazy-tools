# 维护记录

每周六 08:00 有一个会话任务做插件可用性检测：跑 `npm run check` / `npm test`、用真实会话冒烟、
把结论写回这里并推到 `main`；发现 bug 就修，小修发 `v0.1.5.x`，大问题发 `v0.1.6`（规则见
[CONTRIBUTING](../CONTRIBUTING.md#版本号规则)）。

**新记录加在表格顶部**，详情写在该行对应的分节里。表格只放结论与证据指针，长内容进分节。

| 日期 | DSH / Desktop | 结论 | 发版 | 详情 |
| --- | --- | --- | --- | --- |
| 2026-11-24（手动，非定时） | 0.2.2-rc.5 / 2.0.24-next | 可用；顺手修掉提示词目录的误报 | `v0.1.5.1` | 本节 |

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
