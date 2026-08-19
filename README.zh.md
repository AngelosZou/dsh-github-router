# dsh-github-router

[English](README.md) | **中文**

> 为 DeepSeek Harness 项目提供只读的 GitHub 访问——通过内部多路由（API、gh CLI、git 协议、页面 HTML、镜像）的工具加载 PR、issue、文件与 API 数据，agent 不再需要在终端里反复对抗 TLS 或代理故障。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20.18](https://img.shields.io/badge/Node.js-%3E%3D20.18-brightgreen)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/dsh-github-router)](https://www.npmjs.com/package/dsh-github-router)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件捆绑包，为 agent 提供无需终端重试的 GitHub 读取能力：

- **五个只读工具** —— `github_probe`、`github_pr`、`github_issue`、`github_file`、`github_api`，外加 `github-router` 技能与系统提示引导段落。整个包内不存在任何写入、推送、评论或变更能力。
- **工具内路由** —— 每个请求都在宿主进程侧执行（不受沙箱 TLS/代理限制），并按路由阶梯回退：`api.github.com`（直连 → 代理）→ `gh` CLI（只读子命令）→ git 协议（插件自有 fetch 缓存，或对本地克隆仅做 log/diff/show 读取）→ PR/issue 页面 HTML（严格 JSON 岛提取）→ 用户配置的 raw 镜像。
- **一次调用、结构化结果** —— PR 一次返回元数据、讨论、评审、提交、变更文件与 diff，每个部件标注来源路由；失败时返回路由矩阵，而不是十几条重试过的终端命令。
- **连通性探针** —— `github_probe` 一次调用报告宿主侧哪些路由存活，附耗时与推荐路由链。
- **零运行时依赖** —— peer 依赖由 DSH profile 解析；代理请求走插件自带的 CONNECT 隧道（不依赖第三方 HTTP 栈），因此可以完全离线安装。
- **独立设置页** —— 设置中出现独立的「GitHub 路由」入口（与「通知」同机制）：`dsh-github-router` 设置命名空间（secret token、代理、路由开关、缓存 TTL、字节上限），编辑暂存、保存/放弃、覆盖徽标。
- **上下文效率** —— 按类别 TTL 的响应缓存、全局字节上限、带截断注记的列表上限，以及限流余量提示。

## 环境要求

- Node.js >= 20.18
- 由 `@deepseek-ai/dsh-base` 组合的 DSH profile（提供插件使用的 `tools`、`subprocess`、`skills`、`settings`、`credentials` 服务）
- 可选：gh 路由需要已安装且认证的 `gh` CLI；git 路由需要 `git`

## 安装

从 npm：

```bash
dsh plugin --profile web add dsh-github-router
```

从本地检出（开发）：

```bash
dsh plugin --profile web add link:<本仓库的绝对路径>
```

从 git 仓库：

```bash
dsh plugin --profile web add github:<owner>/dsh-github-router
```

然后**重启 DSH 后端**——宿主组合在进程启动时装载。新会话中即可使用
`github_probe`、`github_pr`、`github_issue`、`github_file`、`github_api`，
以及 `github-router` 技能。

## 使用

Agent 侧：

| 工具 | 作用 |
| ---- | ---- |
| `github_probe` | 一次性连通性矩阵（api 直连/代理、gh 安装/认证、git ls-remote、页面直连/代理、镜像、token 有无），附耗时与推荐路由链。访问失败或变慢时先调用它。 |
| `github_pr` | PR 全貌：元数据、描述、讨论（issue 评论 + 行内评审评论）、评审、提交、变更文件与统一 diff，各部分标注来源路由。可用 `includeDiscussion`/`includeReviews`/`includeCommits`/`includeFiles`/`includeDiff` 开关部件，用 `maxDiffBytes`/`maxItems` 限幅。传 `localRepo`（或自动探测会话 cwd）可从本地克隆零网络读取提交与 diff。 |
| `github_issue` | issue 元数据、正文、标签与评论，附路由归属。 |
| `github_file` | 指定分支/标签/commit 的文件内容（或目录列表），经 api contents → raw → 镜像 → git 依次路由；返回大小、截断状态与 serving 路由。 |
| `github_api` | 校验后的 **GET-only** 逃生舱，可访问任意 `api.github.com` 端点；查询值净化、响应缓存、限流头提示、错误带稳定代码。 |

```text
github_probe                                                  # 当前哪些路由存活
github_pr { owner: "o", repo: "r", number: 12 }               # PR 全貌
github_pr { owner: "o", repo: "r", number: 12, localRepo: "C:/src/r" }  # 从本地克隆读提交与 diff
github_issue { owner: "o", repo: "r", number: 34 }
github_file { owner: "o", repo: "r", path: "src/index.js", ref: "main" }
github_api { path: "/repos/o/r/commits", query: { per_page: 5 } }
```

行为说明：

- 路由顺序按部件类型固定：先 API（直连后代理），再 gh，再页面 HTML（代理优先——直连 TLS 被重置的机器通常能经代理取到页面），再 git，最后镜像。每个部件记录其 serving 路由。
- 匿名 API 使用受限流（每 IP 60 次/小时）；配置 token（设置项或 `GITHUB_TOKEN`）后为 5000 次/小时。响应缓存可省配额；`forceRefresh` 绕过缓存。
- 镜像**默认关闭**——它们是会看到请求路径的第三方；只有在接受这一点时才在设置中启用。
- git 路由绝不写入用户仓库：本地克隆只做 `git log`/`diff`/`show` 读取，fetch 仅发生在插件自有缓存目录 `<DSH_HOME>/storages/dsh-github-router/` 下。

## 配置

设置 → **GitHub 路由** 打开独立设置页（注册进 `settings.section` 的导航
入口，与「通知」区块同机制）：编辑内容先本地暂存、点保存才落盘，被用户
覆盖的字段带标记，留空字段回退到下方默认值。同样的值也可以在组合
（profile 的 `cordis.patch.yml`）中作为插件基础配置写入；设置 UI 按用户
覆盖。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `token` | — | 字面 GitHub token（secret；线上脱敏、只写输入）。优先用 `tokenEnv`。 |
| `tokenEnv` | `GITHUB_TOKEN` | 指向 token 的环境变量 / 凭据引用。 |
| `proxy` | `''` | 代理地址。`''` 继承环境变量 `HTTP(S)_PROXY`；`direct` 永不代理。 |
| `directTimeoutMs` / `proxyTimeoutMs` | 8000 / 15000 | 单次尝试超时。 |
| `retries` | 1 | 幂等 GET 在 429/5xx 上的重试次数（尊重 `Retry-After`）。 |
| `routesApi` / `routesGh` / `routesGit` / `routesHtml` / `routesMirror` | 开 / 开 / 开 / 开 / **关** | 各路由开关（卡片中以复选框展示）。 |
| `mirrors` | `[]` | raw 镜像基址，如 `["https://ghproxy.net"]`。 |
| `cacheTtlMeta` / `cacheTtlContent` | 300 / 86400 | 响应缓存 TTL（PR/issue 元数据 / 近似不可变内容），单位秒。 |
| `maxBytes` | 1048576 | 插件读取的每个响应体的字节上限。 |
| `repos` | `[]` | 授权只读 git 路由使用的本地仓库路径。 |
| `gitCacheDir` | `''` | 插件 fetch 缓存目录；`''` = `<DSH_HOME>/storages/dsh-github-router/git`。 |

## 工作原理

- **宿主侧执行** —— 插件代码运行在宿主进程，沙箱的 TLS 凭据重置与代理错乱完全不适用。这一不受限的令牌由 [SECURITY.md](SECURITY.md) 中的约束模型补偿，而不是削弱沙箱。
- **显式代理决策** —— 全局 `fetch` 不继承环境代理；每次尝试显式选择直连或代理，代理请求走零依赖 CONNECT 隧道（`node:http`/`node:tls`），TLS 对目标主机名校验，`accept-encoding: identity`。
- **严格解析** —— 页面 HTML 路由只提取 `react-app.embeddedData` JSON 岛并执行 `JSON.parse`（绝不求值）；有界 BFS 只拷贝白名单字段，CSRF token 与原始载荷绝不进入模型。
- **纯 argv 子进程** —— 每次 `gh`/`git` 调用都是固定参数列表的 argv 数组；用户输入经正则校验后才进入 argv，全插件无 shell 插值。
- **工具契约** —— 规范值为无损失 JSON（数组不挂侧属性）、字节受限，并渲染为带路由归属的紧凑文本。
- **技能与引导** —— `github-router` 技能教授工具优先用法与"GitHub 读取不升级沙箱权限"规则；一条系统提示段落（`dsh-github-router:guidance`，order 118）提醒每个会话 github_* 工具是合规路径。

## 项目结构

| 路径 | 用途 |
| ---- | ---- |
| `cordis.patch.yml` | 插入 `dsh-github-router` 行的 profile patch 层 |
| `lib/index.js` | 宿主插件：设置段、五个工具、技能、引导 |
| `lib/client.js` | 浏览器半边：独立设置页（手写工厂包，无构建步骤） |
| `lib/config.js` | 设置 schema、默认值、运行时选项解析 |
| `lib/net.js`、`lib/tunnel.js` | 路由感知 HTTP 层；零依赖 CONNECT 代理隧道 |
| `lib/routes/` | 每条路由一个模块：`api`（GET-only REST）、`gh`（CLI）、`git`（协议）、`html`（页面解析）、`mirror`（raw 镜像） |
| `lib/core/` | 每次调用的运行时装配与 `pr`/`issue`/`file`/`probe` 聚合器 |
| `lib/tools/` | 五个模型工具 |
| `lib/cache.js`、`lib/render.js`、`lib/util.js` | TTL 缓存、文本渲染、守卫与整形 |
| `lib/skill.js`、`lib/guidance.js` | 技能内容与提示注入段落 |
| `test/` | 无运行时依赖的行为测试（见 开发） |
| `docs/` | 设计与分析文档 |

## 开发

无构建步骤：插件是纯 ESM，测试直接用 Node 运行（mock ctx 代替 DSH
服务；真实的 `defineTool` 校验每个 schema）：

```bash
npm test
# 或：node --test --test-isolation=none "test/*.test.js"
```

测试完全离线——覆盖 JSON 岛提取、入参守卫、URL 构建、TTL 缓存、提交日志
解析、隧道请求头与 apply() 装配。开发循环与离线 peer 解析见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

构造上只读：不存在写入动词；token 只附加到 `api.github.com` 且在每条
边界脱敏；页面载荷按白名单提取；唯一的磁盘写入是
`<DSH_HOME>/storages/dsh-github-router/` 下的两个插件自有缓存。完整威胁
模型与缓解清单见 [SECURITY.md](SECURITY.md)。

## 文档

- [docs/design.md](docs/design.md) — 架构、路由阶梯、缓存与约束模型、已知局限
- [SECURITY.md](SECURITY.md) — 威胁模型与补偿控制
- [CHANGELOG.md](CHANGELOG.md) — 版本历史

## 许可证

MIT
