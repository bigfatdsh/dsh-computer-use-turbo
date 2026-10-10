# 分发指南

这份文档回答一个问题：**怎么把这个插件给别人、或装到你的另一台电脑上。**

---

## 前提

对方需要：

1. 装了 **DeepSeek Harness**（DSH）
2. 一个能调 `plugin_manager` 工具的 agent 会话
3. **已经装了 `dsh-orb`**（Computer Use 模式本身来自它）

**不需要**单独装 Node、pnpm、npm。DSH 自带运行时，`install_bundle` 会用它自己的
pnpm 完成安装；`@deepseek-ai/*` 依赖由 DSH 本身提供。

---

## 一个必须先讲清楚的点

**本插件不新增预设。** 它挂在 root 层，自己按 `agentPreset` 判定，只对
`computer-use` 会话生效。

这意味着装完之后：

- ✅ **什么都不用选** —— 打开 Computer Use 模式就直接生效
- ✅ 其它预设（standard / minimal / ptc / 生存模式 …）**完全不受影响**
- ❌ 你在预设选择器里**找不到**「Computer Use 加速」这个名字，这是对的

这一点和 `dsh-survival-mode` 相反——那个是新增一个预设，要手动选。

---

## 方式 A：tarball 分发（离线 / 内网 / 不想用 GitHub）

```bash
cd dsh-computer-use-turbo
node --test lib/index.test.js     # 先自检，112 项应全绿
pnpm pack                          # 产出 dsh-computer-use-turbo-1.0.0.tgz
```

产物约 **30 KB、10 个文件**：

```
package.json  cordis.patch.yml  README.md  DISTRIBUTION.md  LICENSE
lib/index.js  lib/policy.js     lib/content.js
lib/index.test.js
lib/__fixtures__/policy.js      lib/__fixtures__/usage.js
locale/en.json  locale/zh.json
```

把 tgz 发给对方（微信 / 邮件 / U 盘均可），然后让对方对 agent 说：

> 从 `/path/to/dsh-computer-use-turbo-1.0.0.tgz` 安装插件

或者放到任意 HTTP 服务上，给它 URL。

---

## 方式 B：本地目录（开发自己用）

```bash
git clone https://github.com/bigfatdsh/dsh-computer-use-turbo.git
```

然后让 agent 用 `install_bundle` 指向该目录的**绝对路径**：

> 从 `/绝对路径/dsh-computer-use-turbo` 安装插件

pnpm 会用软链接安装，**改源码立刻生效**，不用重装。代价是路径不能动。

---

## 方式 C：从 GitHub 安装（推荐，只要对方能联网）

仓库：**<https://github.com/bigfatdsh/dsh-computer-use-turbo>**

对方只需对 agent 说：

> 从 `https://github.com/bigfatdsh/dsh-computer-use-turbo` 安装插件

`install_bundle` 的 target 直接交给 pnpm，所以 git URL 与 tarball 走同一条取包路径。
装完不用选预设——本插件对 Computer Use 会话自动生效。

## 方式 D：从 git 仓库安装（任意来源）

`install_bundle` 的 `target` 直接交给 pnpm，因此支持 pnpm 认识的所有形式：

| target 形式 | 说明 |
|---|---|
| `http(s)://.../x.tgz` | 远端 tarball |
| `https://github.com/bigfatdsh/dsh-computer-use-turbo` | 本仓库（pnpm 直接吃 git URL） |
| 本地目录绝对路径 | 软链接，改代码即时生效 |
| `file:...tgz` | 本地 tarball |

---

## 装完怎么确认

### 1. 看激活状态

让 agent 调 `plugin_manager` 的 `list_plugins`，在列表末尾应看到：

```json
{ "entryId": "include:computer-use-turbo",
  "moduleName": "dsh-computer-use-turbo",
  "enabled": true,
  "fiberPhase": "active",
  "patchId": "computer-use-turbo" }
```

`fiberPhase: "active"` 是关键——它证明 `apply()` 真的跑起来了，而不是加载失败。

> 注意：`list_bundles` 里 `dsh-computer-use-turbo` 的 `rows` 是**空的**，
> 这是正常的：本插件的行来自自己的 `cordis.patch.yml`（bundle patch），
> 而不是 profile 的 `bundles` 列表展开出来的。

### 2. 看它有没有干活

打开一个 Computer Use 会话，跑一个「多点几下控件」的任务，然后看两处：

**a) 截图说明**——动作结果里出现带 `[turbo]` 前缀的一行，说明中间帧被省掉了：

```
[turbo] 这是本步中间动作的观察结果，截图已省略；本步最后一条动作结果里的截图才是本步结束时的画面。
```

**b) Host 日志**——插件重载/卸载时会打印一行实测汇总：

```
computer-use-turbo: released — dropped 12 intermediate screenshot(s), deduped 3 unchanged
frame(s) and 1 identical text result(s), ~61000 tokens saved. 缓存命中率 96.11%
（实测 7065216 命中 / 291666 未命中，165 步，清空 0 次）；reasoningEffort 回钉 2 次。
```

### 3. 看缓存有没有被救回来

日志里如果出现下面这条，说明插件的回钉生效了，帮你挡掉了一次本该发生的缓存清空：

```
computer-use-turbo: 本步请求的 reasoningEffort 是 high，与本次会话首次请求的 max
不一致；已回钉为 max，否则 DeepSeek 端整段前缀缓存会作废（本会话第 1 次）。
```

反之，如果出现这条，说明缓存**仍然**被清空了，日志会告诉你原因是客户端可修的、
还是服务端侧的：

```
computer-use-turbo: 整段前缀缓存被清空 —— 本步 cacheRead=0、未命中=72328
（命中率 0.0%），重算了约 72328 token。请求头在本步变过（reasoningEffort /
模型 / 工具面），服务端因此无法复用前缀。
```

---

## 更新与卸载

| 操作 | 做法 |
|---|---|
| 更新（远端 / tarball） | 让 agent 重新 `install_bundle` 指向同一 URL 或新 tgz |
| 更新（本地目录） | 改源码即可，软链接下**立即生效**；改了 `cordis.patch.yml` 需重载 |
| 卸载 | 让 agent `remove_bundle`，target 为 `dsh-computer-use-turbo` |
| 临时停用 | `set_bundle`，target `dsh-computer-use-turbo`，`enabled: false` |
| 只关某一项 | 改 profile 的 `cordis.patch.yml` 里 `computer-use-turbo` 那一行的 `config` |

**改了模块代码后建议重启 DSH**：bundle 行的变更会立即应用，但已加载的模块
不保证被 HMR 重新求值。

---

## Windows

**能用。** 详细说明见 [`WINDOWS.md`](WINDOWS.md)，这里只列要点：

- Computer Use 本身支持 macOS 与 Windows（Linux 才是不支持的），上游
  `createUnsupportedDesktopBackend()` 的注释写得很明确。
- 本插件零平台分支、零第三方依赖，Windows 上行为一致。
- **唯一差异**：Windows 上没有 `bash` 工具，换成了 `pwsh`。所以策略里的预算规则
  刻意写成工具无关的「3 shell commands (bash, or pwsh on Windows)」，有测试守着。
- 安装用 **tarball**：不需要符号链接权限，最省事。本地目录方式在 Windows 上
  `link:` 需要管理员权限或开发者模式。
- 给对方就发 tgz。profile 里记的是绝对路径，整个 profile 拷过去会失效。

## 已知限制

- **只对 Computer Use 生效**。标准模式、生存模式等预设完全不受影响
  （这是设计目标，不是缺陷）。
- **回钉 `reasoningEffort` 会撤销「会话中途改 effort」这个动作**。
  这是刻意的：实测证明中途改它就是拿整段缓存去换。如果对方确实需要在会话
  中途改 effort，把 `pinReasoningEffort` 设为 `false`。
- **预设不能中途切换**：已存在的会话保持启动时的插件版本。
- **profile 级安装**：装一次影响该 profile 下所有 Computer Use 会话，跨重启保留。
- **不发布到 npm**：`package.json` 没有 `publishConfig`，作为 bundle 分发即可。
- **测试是自包含的**：`lib/__fixtures__/` 里内嵌了真实的 computer-use POLICY
  与六个会话的实测用量序列，所以 `node --test lib/index.test.js` 在任何机器上
  都能跑，不依赖打包机上的任何取证数据。

---

## 本机实测记录

在本机 `~/.dsh/profiles/desktop` 上做过完整安装：

```
install_bundle target=link:/Users/.../dsh-computer-use-turbo
→ stage: enable   enabled: true   changed: true   application: applied   warnings: []

list_plugins:
  include:computer-use-turbo   dsh-computer-use-turbo   enabled=true   fiberPhase="active"

listConfigs(name=dsh-computer-use-turbo):
  { id: "include:computer-use-turbo", patchId: "computer-use-turbo",
    name: "dsh-computer-use-turbo", status: "absent" }
```

两点说明：

- `fiberPhase: "active"` 证明 `apply()` 成功执行。插件不注册任何 Service
  （只用 `inject: ['tools', 'systemPrompt']` 消费别人的），所以在 Config
  目录里的 `status` 显示为 `absent` 属正常——它没有自己的 Config 投影。
- `dsh-survival-mode`（纯插件、无 Service）的表现完全相同，可交叉印证。
