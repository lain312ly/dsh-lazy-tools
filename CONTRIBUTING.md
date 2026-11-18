# 贡献 / 维护

这个仓库主要自用，但下面的流程对任何改它的人都适用。

## 本地检查

```bash
npm run check     # node --check + 清单/资源自检（package.json、locale、docs、patch、icon）
npm test          # 内存 harness 行为测试（9 个用例）
```

`npm run verify` 会读取 `~/.dsh/sessions` 里的真实会话日志，断言首个工具表足够小、且出现 `tool_addition`。
它需要 Python 3.10+ 与 `zstandard`（`pip install zstandard`），只读、不写文件；DSH_HOME 不在默认位置时用
`--sessions <path>` 指定。

改了 `index.js` 后必须对 bundle 做一次 disable → enable：已装载的 JS 模块不会热替换。

## 发新版本

只通过 GitHub tag 分发（没有发 npm：`npm publish` 要求 OTP，见 CHANGELOG 0.1.4）。

```bash
# 1) 改 package.json 的 version，更新 CHANGELOG
# 2) 把 README 顶部与「安装」里的 github:lain312ly/dsh-lazy-tools#vX.Y.Z 指到新版本
npm run check && npm test
git add -A && git commit -m "release: X.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

安装方用 `github:lain312ly/dsh-lazy-tools#vX.Y.Z` 即可。`package.json` 保持 `private: true`，避免误发 npm。

如果 tag 已经推错（比如忘了改安装片段），在**没人装过**的前提下修正：

```bash
git tag -f vX.Y.Z
git push --force origin vX.Y.Z
```

已经有人装过的版本不要重指 tag——直接发下一个补丁版本。

## 测试数据从哪来

`scripts/tool-census.py` 按本机 `~/.dsh/sessions` 的真实调用记录给出 `visible` 建议，`npm run verify` 则用最新
会话日志验证插件效果。两者都只读日志，可以放心在别人的机器上跑。
