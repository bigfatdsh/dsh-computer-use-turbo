# Computer Use 加速 · dsh-computer-use-turbo

给 Computer Use 模式提速、省 token 的 DSH 插件。它不改任务目标、不降验收标准，
只做两件事：**把步数砍下来，把不该付的 token 去掉。**

```bash
node --test lib/index.test.js   # 112 项，全部通过（自包含，不需要任何外部数据）
```

---

## 1. 先看真实账单（本机 5 个 computer-use 会话）

优化之前先把账算清楚。下表全部来自本机 `~/.dsh/sessions/` 里的真实会话日志
（解压后的 `session.v4.jsonl`，用本仓库的 `.probe/surface.mjs` 逐条统计）：

| 会话 | 模型步数 | reasoning 输出 | bash 调用 | `code_agent` 调用 | 会话墙钟 |
|---|---:|---:|---:|---:|---:|
| `…698d09c7` | 44 | 16.0k token | **37** | **0** | 2051s |
| `…75095b49` | 45 | 33.2k token | **29** | **0** | 455s |
| `…4e3b5517` | 35 | 10.7k token | **22** | **0** | 334s |
| `…febb4454` | 21 | 11.1k token | 1 | **0** | 239s |
| `…183631b5` | 18 | 4.3k token | 0 | **0** | 693s |

启动固定面（每次请求都发，不走对话）。这里有**两个时期**的数字，因为工具表
后来被别的插件加了东西：

| 启动固定面 | 分析时（dsh-orb 0.0.0） | 当前（dsh-orb 0.1.6） |
|---|---:|---:|
| 工具表 | 21 个，4,070 tok | **35 个，6,951 tok** |
| 系统提示 | 11,029 字符（2,758 tok） | 9,516 字符（2,379 tok） |
| **合计** | **~6,830 tok** | **~9,330 tok** |

多出来的 14 个是 `univer_*`（11,511 字符 ≈ 2,878 tok，占工具表的 **41%**）——
预设本身没变（`code_agent` 的 schema 逐字未变），是同进程里别的插件往全局
注册表加的工具**自动出现在每个预设的工具表里**。见下面「摘工具的账」。

### 两个结论

**第一，慢和贵的主因不是读得多，是步多、每步想得久。**
45 步 / 33.2k reasoning token 的那次会话里，reasoning 一项按 `deepseek-flash`
输出价（8 元/M）就是 0.27 元，而且每一步都是一次完整的模型往返——步数直接就是墙钟。
把 45 步拆开看，最大的一段 thinking 是 12.7k 字符，内容是在纠结“帮学生做在线测验
算不算学术不端”。**这是提示词缺陷，不是模型缺陷**：computer-use 预设的 persona
只配了 `suffix`、没有 `prefix`，会话里没有一句身份声明，模型只能靠猜。

**第二，五次会话里 `code_agent` 一次都没被调用，`bash` 被调用了 88 次。**
这个数字是整份分析里最重要的一个：

| 会话 | 那几十次 bash 在干什么 |
|---|---|
| `…75095b49` | 用 `curl` 下载题库 PDF、自己写 OCR 脚本、再对答案 |
| `…698d09c7` | 同类路径：抓取 → 解析 → 比对 |
| `…4e3b5517` | 同类路径 |

而 computer-use 预设**专门**为这条路径准备了一个出口——`code_agent`：它把这段
调查交给一个标准会话去做，GUI 会话只需等一条完成通知。原策略确实写了这件事：

> Hand the stretch to code_agent when you are still digging through files, searches, or commands.

问题是这句是**主观判断**。模型每次都能说服自己“再试一次就好”，于是 37 次 bash、
20+ 个本该不存在的模型步就这么产生了。本插件把它换成一条**可数的**规则：

> **Hand the stretch to code_agent as soon as ANY of these is true**: you have spent
> **3 bash calls** on this one question; you are about to read, parse, OCR, convert, or
> extract from a file; you are about to download something and process it; you are about
> to write a script longer than one line to get an answer. Do not spend a 4th bash call
> proving you need help.

“用满 3 次”不需要任何推理即可判定。这是本插件最大的一笔收益，也是唯一一处
**改变模型行为**的地方——所以它被放在策略文本里、默认开启、并可以被配置关掉。

## 1.5 缓存命中率：真正的钱在这里

命中率从 provider 返回的 `usage` 里直接读，不靠估算。六个会话的真实值：

| 会话 | cacheRead | 未命中 | 命中率 |
|---|---:|---:|---:|
| …75095b49 | 2,752,768 | 62,132 | 97.79% |
| …698d09c7 | 1,150,080 | 32,846 | 97.22% |
| …febb4454 | 921,728 | 61,063 | 93.79% |
| …183631b5 | 715,136 | 57,497 | 92.56% |
| …4e3b5517 | 1,517,184 | 213,696 | **87.65%** |
| …c778d3c6 | 8,320 | 9,570 | 46.51% |
| **合计** | **7,065,216** | **436,804** | **94.18%** |

单价（元/M token）：**命中 0.02 / 未命中 1.00 / 输出 4.00**。未命中是命中的 **50 倍**。
所以「命中率掉 7 个点」不是小事——它比省几千个缓存 token 重要得多。

### 掉的那 7 个点是一次竞态，不是自然衰减

把 `4e3b5517` 逐步拆开，两个异常点的形态完全一样：某一步 `cacheRead` 几乎归零，
而未命中量级恰好等于**上一步的整段上下文**：

| 步 | cacheRead | 未命中 | 命中率 |
|---:|---:|---:|---:|
| 22 | 71,936 | 242 | 99.7% |
| **23** | **0** | **72,328** | **0.0%** |
| 24 | 72,320 | 173 | 99.8% |
| … | | | |
| 33 | 79,744 | 381 | 99.5% |
| **34** | **6,528** | **74,592** | **8.0%** |
| 35 | 81,792 | 168 | 99.8% |

对应事件（`session-4e3b5517`）：

```text
seq=187  tool/call bash            ← 其实是 code_agent 在后台启动
seq=188  model/selection -> reasoningEffort: high   ← 临时改全局默认
seq=189  model/selection -> reasoningEffort: max    ← 还原
seq=195  assistant/message step=23  read=0  miss=72,328   ← 整段缓存作废
```

`dsh-orb` 的 `selectModelKeepDefault()` 在给后台 `code_agent` 会话选模型时，
会先把选择写进**全局默认**再还原。窗口期内计算机会话正好发了一次请求，
读到了临时值 `high`（本会话一直是 `max`）。**请求头一变，DeepSeek 端就找不到
可复用的前缀**，整段历史按未命中价重算。

两次变更 ↔ 两次清空，一一对应；**其余 33 步全是 99%+**。
这 163,458 个被重算的 token 占该会话全部未命中的 77%。

### 修复：把 `reasoningEffort` 钉在会话内首次请求的取值上

新增 `agent/request` 钩子（普通 waterfall，本插件最后注册 ⇒ 处于最内层，
在 core 的模型选择之后执行，因此能覆盖它）：

- 首次请求记下 `provider + model + reasoningEffort` 的钉值；
- 后续请求若 `provider + model` 未变而 `reasoningEffort` 变了，**回钉**并写一条 `warn`；
- `provider` 或 `model` 变了就重新钉——换模型是用户的明确动作，绝不阻拦；
- 想故意中途改 effort，把 `pinReasoningEffort` 设为 `false`（日志里会告诉你这一句）。

**实测收益（真实用量序列回放，由测试打印）：**

```text
命中率 94.18% → 96.11%；清空 3 次、被重算 163,458 token，
未命中 436,804 → 291,666（省 145,138）
```

### 附带：命中率现在可观测

新增 `session/event` 监听，从 `assistant/message` 的 `usage`（provider 实测值）累计
每一步的命中和未命中，并在**整段清空**时写日志。判据是「未命中 ≥ 上一步整段上下文的 60%」——
实测分布高度分离：正常步未命中只占上下文 2%–15%，清空步是 90%–100%。

插件重载时会打印实测值：

```text
computer-use-turbo: released — … 缓存命中率 96.11%（实测 6,910,078 命中 / 291,666 未命中，
N 步，清空 0 次）；reasoningEffort 回钉 2 次。
```

## 1.6 点击坐标：失准的机制与修法

用户反馈「鼠标点击会位置错误，然后以为点了没反应」。查真实日志找到了确切机制。

### 证据：模型自己记下了换算，而且算得**完全正确**

`session-183631b5` 的 reasoning 原文：

> the coordinate space: the attached_size is **2560x1600 but the preview shown is 1610x1006**.
> My visual coordinate estimates would then be in the 1610x1006 space. But the tools expect 2560x1600 space.

> 提交 button at preview (884, 896) → real (1406, 1425). Click it.

把模型用过的四组映射全部反解：

| 缩略图坐标 | 提交的真实坐标 | 比例 x | 比例 y |
|---|---|---|---:|---:|
| (884, 896) | (1406, 1425) | 1.590 | 1.590 |
| (391, 291) | (621, 463) | 1.588 | 1.591 |
| (1053, 633) | (1675, 1006) | 1.591 | 1.589 |

平均 **1.5900 / 1.5903**，而 `2560/1610 = 1.5901`。**换算公式精确，误差只来自四舍五入。**

### 所以错在哪：估读误差被比例放大

比例没错，那问题只能在**「先肉眼在缩略图上估一个坐标」**这一步。而在缩略图上估一个按钮中心偏 20px 是很正常的：

```text
缩略图上偏 20px  ×  1.5901  =  真实坐标偏 31.8px
```

**典型 macOS 控件的中心点击容差约 24px**（按钮高 22–32 逻辑点，2× 视网膜下 44–64 物理像素，半高 22–32）。31.8 > 24 —— **点空。** 界面没有变化，模型于是得出「按钮没反应」的结论，接着去试别的方法，白烧好几步。

### 修法

坐标段在插件里是**逐字保留**的（压缩它只会换来点偏），所以精度规则加在同为稳定前缀的纪律段里，三句话各治一个病：

| 句子 | 治什么 |
|---|---|
| `The coordinate space is attached_size and nothing else: the size your view of the image appears to have is a rendering artifact … never scale coordinates to a size you read off the image.` | 官方 pixel 口径**没解释**「你看到的图被显示层缩放过」，模型只能自己猜比例。这句把唯一依据立起来——而这正是它缺的那一条 |
| `Click the centre of the control, never its edge or its label text — a hit area tolerates a few pixels` | 中心点击自带半个控件的容差，是抵抗估读误差最便宜的手段 |
| `No visible change after a click means the click missed the hit area, not that the control is broken: re-click its centre next step instead of switching methods.` | 直接消灭「以为按钮坏了 → 换别的方法」这条弯路 |

代价：+555 字符（约 139 token/请求）。压缩率因此从 65.2% 退到 74.9%——**这是有意接受的**，因为拿掉任一句换来的更低比例，都是拿真实能力换一个数字。测试阈值同步提到 0.80 并写明了理由。

**没有做的事**：没有去改坐标段本身（它是命中率的根基，动它风险大于收益），也没有在插件里做「坐标自动纠正」——那需要知道模型的意图，而插件只能看到它提交的数字，猜错会把点击挪到更糟的位置。

## 1.7 适配 dsh-orb 0.1.6（本机当前版本）

本机 profile 装的是 **`dsh-orb@0.1.6`**（我最初分析的是 0.0.0）。逐项核对结果：

| 我依赖的东西 | 0.1.6 状态 |
|---|---|
| `POLICY_BEFORE_COORDINATES` / `MILLIFRACTION_COORDINATES` / `PIXEL_COORDINATES` / `POLICY_AFTER_COORDINATES` | **四段全部逐字未变** |
| `code_agent` 工具 schema | **逐字未变**（2,824 字符） |
| 预设的 persona 前缀 | 加了一句「用户停掉后台会话时简短告知、别再调 code_agent」——只影响 persona 文本，与插件无关 |
| 新增 `orb-code-agent-registry` | 跨会话协调（多个 Computer Use 抢屏幕/键鼠时避免打架），**不注册任何工具** |
| `selectModelKeepDefault`（我回钉补丁针对的根因） | **仍在**——所以 `pinReasoningEffort` 依然必要 |
| `session.log` 是事件数组、`session.header.agentPreset` | 未变（已核对当前 `dsh-session` 类型声明） |

结论：**插件的每一条逻辑都仍然成立**，无需改写。变的只有**基线数字**——见上表。

### 摘工具的账（`denyTools`）

工具表 41% 被无关工具占着，看起来该摘。但把账算清楚：

| | 数值 |
|---|---:|
| 摘掉 14 个 `univer_*` 省下的**读入** | 2,878 tok/请求 |
| 按缓存命中价（0.02 元/M）折算 | 0.00006 元/请求 |
| 工具表变化导致的**一次性**缓存失效 | 约 5,336 tok × 1.00 元/M = **0.0053 元** |

也就是说**单看 token，摘工具是亏的**：省下的读入太便宜，而那次失效按 50 倍价付。
45 步会话里净省约 0.0026 元，可以忽略。

**但真正的收益不在 token，在行为**：模型手里握着 `univer_worktree`、
`univer_compile_svg` 这类工具时，可能去调它们——那是整步浪费（5–40 秒 + 一次
全上下文重读），而 Computer Use 的职责本来就是操作界面，不是生产 Office 文件。

所以 `denyTools` **默认留空**（行为与不配置完全一致），需要时在 profile 里取消注释。
它逐个工具提交限制而不是一次提交整个列表：`restrict()` 对不认识的名字会抛错，
逐个提交时一个错别字只影响它自己，不会废掉整份配置（有测试守着）。

**没有用「改 `assembly.tools`」这条捷径**：那只骗得过目录，模型照旧调得到，
结果是「被拒绝才知道」——比不摘更糟。

## 2. 插件做的四件事

### 2.1 策略压缩 + 交棒预算（`lib/policy.js`）

官方 computer-use 策略 6,761 字符，其中 **1,056 字符是坐标口径**，两种会话模式下
只差这一段。本插件按 `Coordinates:` … `Step:` 切分，**坐标段逐字保留**，其余压缩重写：

```text
POLICY 6761 -> 5329 字符；坐标段（1056 字符）逐字保留，
其余 5705 -> 4273（保留 74.9%）；净省 240 token/请求（已扣掉 118 token 的纪律段）
```

（这行数字由测试直接打印，可复核。）压缩掉的是同一件事说三遍的重复表述；
“不许点看不见的控件”“路径走 open_in_finder”“不许点 Dock”“`long_wait` 的用法”
“桌面划词回合的处理方式”等**一条语义都没删**，测试逐条断言了这些约束仍然存在。

另外追加一段约 160 字符的作业纪律：不复述、不重复看同一张图、达成即停。
它写进**稳定前缀**，只在第一次计费，之后全部走缓存。

### 2.2 批处理中间帧不再入账（`lib/index.js`）

官方策略明确要求模型：

> Step: you may emit several GUI tool calls in one step … **after the step use the last image**.

而实现上每个 GUI 动作都会 `recapture` 一张动作后截图（`postActionWaitMs`，默认 600ms）。
于是“一步 3 个动作”= 3 张截图入账，其中 2 张模型被明确要求不要看。本插件把
**同一步内第 2 条及以后的观察结果**里的截图去掉，只留前台应用信封文本和一句说明。

**安全边界**：只有在**步号已知**且确认是**同一步**时才动手。步号从会话日志头部读；
读不到就退回 `step/start` 事件流（形状逐字取自真实日志：
`{"type":"step/start","data":{"turn":1,"step":7}}`）；两者都拿不到时**一张截图都不丢**——
宁可少省，不可丢画面。这条边界有专门的测试。

### 2.3 逐字节去重（`lib/index.js` + `lib/content.js`）

截图或文本结果与本次会话中已经出现过的**逐字节完全相同**时，用一行等价说明替代：

```text
[turbo] 这一屏与上一条观察结果逐字节相同，截图已省略；屏幕没有变化，直接沿用上面那张最新的画面。
[turbo] 与本次会话中 `bash`（call_id=c1）的输出逐字相同（808 字符），已省略；直接沿用上面那份内容。
```

说明里刻意写明“屏幕没有变化”，否则模型会以为工具失败并重拍一张，反而多花一步。

**为什么这不可能丢信息**：键来自 `node:crypto` 的 SHA-256，只有字节完全相同才命中。
取不到字节时（附件服务不可用）**放弃去重**而不是退到启发式——`strictImageDedupe`
默认开启说的就是这件事。

### 2.4 可选的观察窗口（默认关闭）

只保留最近 N 张截图，更早的换成占位说明。**默认关闭，因为它通常会亏钱**：

> 删除历史中段会让后续每一步请求的 KV 缓存从删除点起失效。一个模型步只有**一次**
> 请求，所以删掉的内容在同一步内没有任何机会省下来，却要让下一步按未命中价重建整段尾部。

打开它的唯一理由是上下文压力：长会话里它能推迟甚至避免一次摘要压缩（那是一次完整的
额外模型调用，远比重建缓存贵）。需要时设 `imageRetentionWindow: 2~3`。

## 3. 明确不做的事

| 不做 | 为什么 |
|---|---|
| 不按轮次增删工具 | 工具表位于请求前缀，任何一次增删都会让整段 KV 缓存失效 |
| 不改模型、不改 `reasoningEffort` | 那会改变输出本身，是用户的选择不是插件的选择。要更快请在设置里调低 reasoning effort |
| 不动失败结果 | 那是模型自我纠错的关键依据 |
| 不动富内容块（结构化输出、文件引用） | 它们不是“可省略的重复” |
| 不动多块文本结果 | 块边界本身携带信息 |
| 不动坐标说明 | 压缩它换不来 token，只会换来点偏 |
| 不给 `bash` 输出做强截断 | 有损，且会让模型看不到关键报错。需要时自己打开 |

## 4. 配置

在 profile 的 `cordis.patch.yml` 里改 `computer-use-turbo` 这一行：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `presets` | `['computer-use']` | 生效的预设；留空 = 全部会话 |
| `policy` | `true` | 压缩策略文本 |
| `discipline` | `true` | 追加作业纪律 |
| `dedupeImages` | `true` | 同一步中间帧去冗余 + 逐字节相同的截图去重 |
| `strictImageDedupe` | `true` | 要求 SHA-256 逐字节比较；取不到字节就放弃去重 |
| `dedupeText` | `true` | 逐字相同的纯文本结果去重 |
| `textDedupeMinChars` | `512` | 触发文本去重的最小码点数 |
| `textCapHeadChars` | `0` | 文本留头码点数（**有损**，默认关） |
| `textCapTailChars` | `0` | 文本留尾码点数 |
| `imageRetentionWindow` | `0` | 只保留最近 N 张截图（默认关，见 2.4 的缓存账） |
| `pinReasoningEffort` | `true` | 把 `reasoningEffort` 钉在会话内首次请求的取值上（见 1.5，命中率 94.18%→96.11%） |
| `logSavings` | `true` | 把省量写进 Host 日志 |
| `verboseMetrics` | `false` | 日志里附分项统计 |

**怎么确认它在工作**：插件卸载/重载时会在 Host 日志里写一行

```text
computer-use-turbo: released — dropped N intermediate screenshot(s), deduped M unchanged
frame(s) and K identical text result(s), ~T tokens saved.
```

想在 GUI 里直接看到效果，跑一个“多点几下控件”的任务：动作前的截图里若出现带
`[turbo]` 前缀的说明，就说明中间帧被省掉了。

缓存相关的两条日志更值得盯：

- `computer-use-turbo: 整段前缀缓存被清空 —— …`：出现了就说明缓存被作废，
  日志会直接告诉你原因是「请求头在本步变过」（客户端可修）还是服务端侧失效。
- `computer-use-turbo: 本步请求的 reasoningEffort 是 …；已回钉为 …`：说明插件的
  回钉生效了，帮你挡掉了一次本该发生的清空。

## 5. 诚实的边界

- **省量不是“账单打三折”。** 截图在后续请求里大多命中 KV 缓存（0.04 元/M），
  所以丢掉重复截图省的主要是**上下文压力与注意力占用**，直接省下的钱有限。
  真正的钱和真正的时间在 2.1 那条交棒预算上——它砍掉的是**整趟模型往返**。
- **`~T tokens saved` 里的每张图按 4,000 token 折算。** 依据是官方 computer-use 自己
  用的 4,000 通知预算，以及本机 2400×1500 视网膜截图的量级。它是日志口径，不参与
  任何功能判断。
- **本插件的收益取决于会话形态。** 一个“点一下就完事”的任务几乎省不到东西；
  一个“翻半天文件最后才点一下”的任务能省掉一半以上的步数。
- **策略改写会让 computer-use 会话的缓存前缀一次性失效。** 之后每一步都是稳定的，
  所以只付一次；但如果同时还在标准模式里干活，两边的缓存互不共享。
- **测试是自包含的**：真实的 computer-use POLICY 与六个会话的实测用量序列都内嵌在
  `lib/__fixtures__/` 里，因此 `node --test lib/index.test.js` 在任何机器上都能跑，
  不依赖打包机上的取证数据。
- **测试覆盖的是逻辑与契约，不是 GUI 真机行为。** 112 项测试用 mock Cordis 宿主复现了
  `tools/post-execute` / `system-prompt/assemble` 的真实 waterfall 语义；另有两条测试
  直接读磁盘上的真实会话日志：一条逐行核对 `agentPreset` 与步号能不能从真实形状读出来，
  一条做省量回放。它不驱动真实窗口。真机验证请在 Computer Use 模式里跑一次任务，
  看日志里那行汇总。**已验证**：插件在 desktop profile 里 `fiberPhase: active`，
  即 `apply()` 成功执行、`zod` 依赖解析正常。
- **回钉 `reasoningEffort` 会撤销“会话中途改 effort”这个动作。** 这是刻意的：
  实测证明中途改它就是拿整段缓存去换。但它是**对用户意图的干预**，所以默认开启、
  以 `warn` 级日志说明、并给了 `pinReasoningEffort: false` 这个出口。
  如果你从未在会话中途改过 effort，这个开关不会有任何可感知影响。
- **1.5 里的 96.11% 是“如果回钉生效”的回算值**，不是改后真机测出来的。
  回算用的是同一批真实用量序列，把清空步还原成“前缀被复用”的样子。
  真机验证请看插件重载日志里那行实测命中率。
- **曾经踩过的坑（已写成回归测试）。** 最初把 `session.log` 误当成 `{header, events}`
  包装对象，而 `agentStepOf` 外层有 try/catch——结果是真机上批处理去冗余**完全不生效**，
  测试却全绿。核对了 `dsh-session/lib/types/index.js` 才确认：`session.log` 是**事件数组**
  （`Session.append(type, data)` 按序 push），`session.header` 才是创作元数据，且磁盘头里
  **没有** `step` / `turn` 字段。现在那条护栏直接拿真实 JSONL 断言，静默失效不再可能。

## 6. 与「生存模式」的关系

互不冲突也互不依赖：两者都以 `prepend: true` 挂在 `tools/post-execute` 的 waterfall
外层，各自只在自己的范围内改写内容。重叠部分（逐字相同的纯文本结果）最多被压缩两次，
结果等价。`presets` 默认只含 `computer-use`，所以生存模式的标准会话不受本插件影响。

## 7. 验证与复现

**这个仓库里能跑的验证只有一条，但它足够**：

```bash
node --test lib/index.test.js     # 112 项
```

它是**自包含**的——所有结论所依赖的真实数据都内嵌在 `lib/__fixtures__/`：

| 夹具 | 内容 | 支撑哪些结论 |
|---|---|---|
| `policy.js` | 真实 computer-use POLICY（millifraction 口径）逐字副本 | 策略压缩率、坐标段逐字保留 |
| `policy-pixel.js` | 同一份策略的 pixel 口径变体 | 本机历史会话全是这个形态，两种口径都要测 |
| `usage.js` | 6 个会话、165 步的 provider 实测用量 | 命中率 94.18% → 96.11%、省 145,138 未命中 token |
| `click-accuracy.js` | 四组 `preview → real` 换算、缩略图与栅格尺寸 | 点击失准的量化：20px × 1.5901 = 31.8px > 24px 容差 |

所以**不需要**我的会话日志也能复核每一条数字。

### 本机的取证管道（不随仓库发布）

上面那些原始数据是用一套一次性脚本从会话日志里挖出来的，它们**不在这个仓库里**，
因为依赖本机的目录结构：

| 脚本 | 用途 |
|---|---|
| `unzstd.mjs` | 把 append-only 的多帧 zstd 会话日志逐帧解压 |
| `surface.mjs` | 从会话日志重建每次请求的面：工具表、系统提示、逐步 reasoning 与墙钟 |
| `narrate.mjs` | 打印最长的几段 reasoning，用于定位「模型在纠结什么」 |
| `analyze.mjs` | 按块类型统计会话面 |
| `prefix.mjs` | 重建每一步发出的前缀规模，定位缓存断点 |

想在自己的机器上重跑，思路是：会话日志在
`~/.dsh/sessions/--<工作目录 slug>--/session-*/session.v4.jsonl.zstd`，是**多帧 zstd**
（每帧以 `28 b5 2f fd` 开头），用 Node 24 的 `zlib.zstdDecompressSync` 逐帧解压即可；
解出来的 JSONL 里 `assistant/message` 事件带 `usage`（`cacheReadTokens` /
`inputTokens`），这就是全部命中率数字的来源。

## 8. 安装与分发

**给别人用**：见 [`DISTRIBUTION.md`](DISTRIBUTION.md)（打包、安装、验证、卸载全流程）。

一句话版本——把 tarball 发给对方，让对方对 agent 说：

> 从 `/path/to/dsh-computer-use-turbo-1.0.0.tgz` 安装插件

**注意**：本插件**不新增预设**，它自己按 `agentPreset` 判定，只对 `computer-use`
会话生效。装完后预设选择器里**找不到**新名字是正常的——打开 Computer Use 就直接生效，
其它预设完全不受影响。

## 9. 许可

MIT。
