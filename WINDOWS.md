# Windows 支持说明

**结论：能用。** 插件代码零平台分支，Windows 上行为与 macOS 一致。

但有几件事必须先讲清楚，否则容易踩坑。

---

## 1. Computer Use 本身支持 Windows

这不是本插件的判断，是上游 `dsh-orb` 的实现事实：

```js
// dist/computer-use/backend-B_ZdDdeT.js
/** Fixed execute-time error for hosts other than macOS and Windows. */
const UNSUPPORTED_DESKTOP_MESSAGE =
  "computer-use: desktop control is implemented only on macOS and Windows";
function createUnsupportedDesktopBackend() { /* Linux CI 用，每个方法都抛错 */ }
```

也就是说：**macOS 与 Windows 都实现了桌面控制，Linux 才是不支持的那个。**

`dsh-orb` 的发行产物里也带了 Windows 原生实现（`dist/computer-use/windows-native-CbW3XrZs.js`），
随包编译。

预设本身按平台二选一（`dsh-orb/cordis.patch.yml`）：

```yaml
- id: tool-bash
  disabled: !!js process.platform === 'win32'     # 非 Windows 才有 bash
- id: tool-pwsh
  disabled: !!js process.platform !== 'win32'     # 只有 Windows 才有 pwsh
```

**唯一差异**：Windows 上没有 `bash` 工具，取而代之的是 `pwsh`。所以本插件的
预算规则刻意**不写死工具名**：

```text
you have spent 3 shell commands (bash, or pwsh on Windows) on this one question
```

这一条是有回归测试守着的（`预算规则不写死工具名`）。如果它被写回
「3 bash calls」，Windows 上模型的预算判断会指着不存在的工具，整条交棒纪律失效。

---

## 2. 代码层的平台审计结果

| 检查项 | 结果 |
|---|---|
| `process.platform` / `process.arch` | **无** |
| `os.*` / `homedir` / `__dirname` | **无** |
| 硬编码路径分隔符 / 盘符 | **无** |
| `node:` 内置模块 | 只有 `node:crypto`、`node:module` —— 跨平台 |
| 第三方依赖 | **零**（`zod` 是可选校验，缺失也能正常工作） |
| `package.json` 的 `os` / `cpu` / `engines` | 未声明（即不限制平台） |

插件不读文件、不碰路径、不 spawn 进程——它只做文字变换和事件记账。
这是它能跨平台的根本原因。

唯一的运行时路径操作在测试里：`new URL('./__fixtures__/...', import.meta.url)`
读内嵌夹具。`import.meta.url` 是 `file://` URL，`URL` 与 `readFileSync` 都能跨平台处理。

---

## 3. Windows 上怎么装

### 推荐：tarball（对方只需一个文件）

```powershell
# 对方在 DSH 会话里对 agent 说：
#   从 C:\Users\你\Downloads\dsh-computer-use-turbo-1.0.0.tgz 安装插件
```

pnpm 会解包成真实目录。**不需要符号链接权限**，这是 Windows 上最省事的方式。

### 本地目录开发

```powershell
# 对 agent 说（注意 Windows 路径写法）：
#   从 C:\dev\dsh-computer-use-turbo 安装插件
```

Windows 上 `link:` 需要**管理员权限或开启开发者模式**（否则符号链接创建失败）。
如果只是想装来用，走 tarball 就好；确实要改源码再考虑本地目录。

### 相对路径不要跨机器复制

profile 的 `package.json` 里记的是**绝对路径**：

```json
"dsh-computer-use-turbo": "link:C:\\dev\\dsh-computer-use-turbo"
```

把 profile 目录整个拷给另一台机器，这个路径大概率失效。**给别人就发 tgz**，
让 pnpm 在对方机器上自己解析。

---

## 4. 装完怎么验证（与 macOS 同一套）

对 agent 说「查一下 plugin_manager 的 list_plugins」，找这一行：

```json
{ "entryId": "include:computer-use-turbo",
  "moduleName": "dsh-computer-use-turbo",
  "enabled": true,
  "fiberPhase": "active" }
```

`fiberPhase: "active"` 是关键。`list_bundles` 里它的 `rows` 为空、
Config 里 status 显示 `absent`，都属正常（不注册 Service 的纯插件都这样）。

跑一个 Computer Use 任务后看两处：

- 截图结果里出现 `[turbo] ...截图已省略...` → 中间帧去冗余生效
- Host 日志里出现 `computer-use-turbo: released — ... 缓存命中率 XX%` → 全部生效

如果日志里出现 `reasoningEffort` 被回钉的 `warn`，说明缓存保住了。

---

## 5. 自检（不需要装，解包即可）

```powershell
# 解包后用 DSH 自带的 Node 跑
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" `
  --test lib/index.test.js
```

预期 **112 项全绿**。测试自包含（真实 POLICY 与用量序列都内嵌在
`lib/__fixtures__/`），所以任何机器上结果都一样，不依赖打包机的取证数据。

---

## 6. 尚未在真机 Windows 上验证的部分

诚实说明边界：

| 项 | 状态 |
|---|---|
| 代码无平台分支、无第三方依赖 | ✅ 已审计 |
| Windows 桌面控制由上游实现 | ✅ 已读上游源码确认 |
| 预算规则工具无关 | ✅ 已修 + 有测试守着 |
| 测试在 Windows 上全绿 | ⚠️ **未实测**（本机是 macOS） |
| tarball 在 Windows 上的 pnpm 安装链路 | ⚠️ **未实测**（与 `dsh-survival-mode` 同一条代码路径，那个已验证过 HTTP/tarball 方式） |

测试与安装链路走的是与 `dsh-survival-mode` **完全相同**的机制，而那个包在
macOS 上验证过完整的 tarball/HTTP 安装。Windows 的差异只在于 pnpm 的路径解析，
这属于 pnpm 自身的成熟行为。

如果你在 Windows 上跑出任何问题，最可能的两处是：

1. `lib/__fixtures__` 的 `import()` 路径（若解包工具改写了目录结构）
2. plugin_manager 传给 pnpm 的 spec 形式（用**绝对 Windows 路径**而不是相对路径即可规避）
