# 贡献 / 维护

这个仓库主要自用，但下面的流程对任何改它的人都适用。

## 本地检查

```bash
npm run check     # node --check + 清单/资源自检（package.json、locale、docs、patch、icon）
npm test          # 内存 harness 行为测试（13 个用例）
```

`npm run verify` 会读取 `~/.dsh/sessions` 里的真实会话日志，断言首个工具表足够小、且出现 `tool_addition`。
它需要 Python 3.10+ 与 `zstandard`（`pip install zstandard`），只读、不写文件；DSH_HOME 不在默认位置时用
`--sessions <path>` 指定。

改了 `index.js` 后必须对 bundle 做一次 disable → enable：已装载的 JS 模块不会热替换。

## 版本号规则

| 情况 | 做法 | 例子 |
| --- | --- | --- |
| 小修（文案、提示词、边界、单个工具的返回值） | 留在当前线上打补丁 tag，`package.json` 的 `version` **不动** | `v0.1.5.1`、`v0.1.5.2` |
| 大问题（工具面算错、限制丢失、激活失效、破坏兼容） | 提升 `version` 的次版本号，README 安装片段一起改 | `v0.1.6` |

`package.json` 只写主/次/补丁三段（`0.1.5`），四段号只出现在 git tag 与 CHANGELOG 标题里——npm/pnpm
不接受四段 semver，而这个仓库是用 git tag 分发的。也就是说「0.1.5.x」这一线在包清单里始终显示 `0.1.5`，
区分点只有 tag。

README 顶部与「安装」里的 `#vX.Y.Z` 始终指向**最新**的可安装 tag，每次发（补丁）版都要一起改。

## 发新版本

只通过 GitHub tag 分发（没有发 npm：`npm publish` 要求 OTP，见 CHANGELOG 0.1.4）。

```bash
# 1) 更新 CHANGELOG；跨次要版本时改 package.json 的 version
# 2) 把 README 顶部与「安装」里的 github:lain312ly/dsh-lazy-tools#vX.Y.Z 指到新 tag
npm run check && npm test
git add -A && git commit -m "release: X.Y.Z"
git tag vX.Y.Z          # 小修：v0.1.5.1 这样四段
git push origin main --tags
```

安装方用 `github:lain312ly/dsh-lazy-tools#vX.Y.Z` 即可。`package.json` 保持 `private: true`，避免误发 npm。

如果 tag 已经推错（比如忘了改安装片段），在**没人装过**的前提下修正：

```bash
git tag -f vX.Y.Z
git push --force origin vX.Y.Z
```

已经有人装过的版本不要重指 tag——直接发下一个补丁版本。

## 每周维护（定时任务跑的东西）

每周六 08:00 的会话任务按下面顺序走，报告追加到 `docs/MAINTENANCE.md` 并推到 `main`：

1. **环境**：记下 DSH 版本（`$env:DSH_INSTALL_DIR/package.json`）、Desktop 版本、Node 版本，和上一行报告对比；
   变了就说明有新版，重点测它。
2. **静态**：`npm run check && npm test`；失败先修，修不了就在报告里写明失败用例和原因。
3. **真实会话冒烟**：起一个子会话（cordis 预设），确认
   - 首个 `request/header.tools` 明显小于全量工具表；
   - `toolbox_status` 报 `restricted: true`，`visible ⊆ agentToolCount`；
   - `toolbox_search` 能搜到、`toolbox_load` 能让下一个请求的工具表 +1，并出现 `tool-addition`；
   - 系统提示词里的目录是「Deferred tools of your preset」（按 agent 生成），不是安装级清单；
   - 子会话里没有 `unknown tool` 报错。
   日志位置：`~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`，
   用 `scripts/verify-session-tools.py` 或同样的 zstd 读法取值，别凭记忆断言。
4. **修 bug**：能复现、能修的就地修 + 补一个会失败的用例；按上面的版本号规则决定发 `v0.1.5.x` 还是 `v0.1.6`。
   修不动的大问题不硬发版本，写进报告并标 `blocked`。
5. **报告**：在 `docs/MAINTENANCE.md` 顶部新增一行表格（日期 / DSH 版本 / 结论 / 是否发版 / 提交号），
   详情写在该行下的分节里；然后 `git add -A && git commit && git push origin main`（有版本就 `--tags`）。

报告口径：先写结论（可用 / 有 bug / 阻塞），再写证据（会话 id、数字、文件路径）。没验证的事就写「未验证」，
不要用推测填表。

## 测试数据从哪来

`scripts/tool-census.py` 按本机 `~/.dsh/sessions` 的真实调用记录给出 `visible` 建议，`npm run verify` 则用最新
会话日志验证插件效果。两者都只读日志，可以放心在别人的机器上跑。
