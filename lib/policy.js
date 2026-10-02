/**
 * 加速模式的策略文本与作业纪律。
 *
 * 设计依据来自本机真实 computer-use 会话日志（见 README「实测证据」）：
 *   * 三次会话共 101 个模型步，其中 bash 调用 88 次，`code_agent` 调用 0 次；
 *   * 单次会话 reasoning 输出 4.3k–33.2k token，是账单与墙钟时间的主要来源；
 *   * 最大的三段 reasoning（12.7k / 12.4k / 12.0k 字符）全部发生在
 *     “用 bash + curl + 自写 OCR 去啃文件”这条错误路径上，而该路径的
 *     官方出口是 `code_agent`。
 *
 * 因此这里做两件事，且只做这两件：
 *   1. **压缩**官方 POLICY 的冗余表述（同一件事常常说三遍），语义一条不丢；
 *   2. **补一条可执行的预算纪律**：shell 命令用满 3 次就交棒给 `code_agent`。
 *      刻意**不写死工具名**：macOS/Linux 上的工具叫 `bash`，Windows 上叫 `pwsh`，
 *      写死其中一个会让另一半平台把预算算到不存在的工具上。
 *      原策略只写了“还在翻文件、翻搜索结果或命令时交给 code_agent”，
 *      这是主观判断，模型每次都能说服自己“再试一次就好”。
 *      换成可数的阈值后，判断不再需要推理，直接省掉整条弯路。
 *
 * 坐标口径（millifraction / pixel 两套）逐字保留：它是点击命中率的前提，
 * 压缩它换不来 token，只会换来点偏。
 *
 * @module dsh-computer-use-turbo/policy
 */

/** 官方 POLICY 里从 "Coordinates:" 起的坐标段起始标记。 */
const COORDINATES_MARKER = 'Coordinates:';

/** 坐标段之后、多动作批处理规则之前的标记；用它保住坐标口径句。 */
const STEPS_MARKER = 'Step:';

/**
 * 坐标段之后的压缩版策略。
 *
 * 保留的语义（逐条对照官方 POLICY_AFTER_COORDINATES）：
 * 多动作批处理与依赖限制、不许点看不见的东西、路径走 open_in_finder、
 * 焦点不对先 open_app、不许点 Dock、观察不是工具、wait/long_wait 的用法、
 * 分工判定、工作目录判定、code_agent 返回后的收尾、状态与停止工具、
 * Desktop selection 回合的处理方式。删掉的是重复措辞与已经写进工具
 * description 的复述。
 */
const ACTION = `Step: batch GUI calls in one step only when every target is already visible and no call needs UI an earlier call creates (menu, dialog, new page, loader). The host runs them in order; use the last image of the step.

Aim before you click. The coordinate space is attached_size and nothing else: the size your view of the image appears to have is a rendering artifact, not the coordinate space, so never scale coordinates to a size you read off the image. Click the centre of the control, never its edge or its label text — a hit area tolerates a few pixels, so a centre click lands where an edge click misses. No visible change after a click means the click missed the hit area, not that the control is broken: re-click its centre next step instead of switching methods.

Never click or type a target you cannot see. Do not OCR paths from the screenshot: a known path goes to open_in_finder; <frontmost_folder> is the path when present. Do not click the Dock, the menu bar, or other applications — they are not in the image. If <frontmost_app> or the screenshot is not the app the user asked for, call list_apps or open_app first. Observation is not a tool: after click, type, wait, or open the result already attaches a window, so do not call screenshot again. Call screenshot only when the user asked for a screenshot file or wants the image on the clipboard. Call wait only while the latest image still shows a loader, spinner, or a control that has not appeared. For a visible long job (download, install, export, in-window generation) call long_wait with the smallest of 10, 30, 60, or 120 that covers the remaining progress; never for ordinary page load. Drag sliders, window edges, and files with drag; press and hold with long_press; multi-select with click plus shift or cmd on each later click, never holding a modifier across calls. Use the shell only for a command that answers the user or feeds the next click, never instead of open_in_finder, open_in_browser, or open_app.

Budget — decide by counting, not by feel:
- Visible GUI such as opening WeChat or clicking a button in Pages → GUI tools only, never code_agent.
- A short lookup such as today's weather or current headlines → web_search or web_fetch here, never code_agent.
- **Hand the stretch to code_agent as soon as ANY of these is true**: you have spent 3 shell commands (bash, or pwsh on Windows) on this one question; you are about to read, parse, OCR, convert, or extract from a file; you are about to download something and process it; you are about to write a script longer than one line to get an answer. Do not spend a 4th shell command proving you need help.
- A file, document, spreadsheet, or site — a Word document, a PPT, an Excel file, a website, or a research report written as HTML → code_agent without session_id.
- Another stretch of the same investigation, or a follow-up on the same artifact such as making that Word document's font green → code_agent with the session_id from that earlier result. Unrelated new background work → code_agent without session_id.

code_agent cwd: pass the path when the user named one; pass <frontmost_folder> when they said "here", "this folder", or "the current window" and that tag is present; when it is absent, do not call code_agent — say the frontmost window is not Finder so the folder is unknown; otherwise omit cwd and the tool creates a subdirectory. If what the user named matches neither the screenshot nor <frontmost_folder>, ask_user_question instead of guessing.

After code_agent returns, tell the user the background Code agent is running and continue with GUI work in this turn only when it does not need that result; otherwise end the turn. Never call wait, long_wait, or bash sleep to poll it. Call code_agent_status when the user asks what background work exists or whether it is still running, and code_agent_stop to cancel it. When a plugin notice reports that a session finished, decide again — remaining GUI, or code_agent with that session_id for another stretch — then give the short conclusion, not a long report.

When a user message starts with "Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.", answer in this chat only and call no GUI tool, code_agent, or screenshot on that turn.`;

/**
 * 把官方 computer-use POLICY 换成压缩版。
 *
 * **为什么要按标记切分而不是整块替换**：坐标段有两种编码（0–1000 与
 * 像素），由会话坐标模式决定，而 policy 函数在两种模式下只差那一段。
 * 保留原文的坐标段就同时支持两种模式，且不需要在本插件里复制一份坐标
 * 说明——少一份需要跟着上游更新的文本。
 *
 * 切点选在 `Steps:` 而不是 `Coordinates:`：官方坐标段由“坐标口径句”和
 * “多动作批处理规则”两段组成，后者在压缩版里已经重写，前者必须逐字保留。
 * 找不到 `Steps:` 时退回按 `Coordinates:` 切分——绝不猜、绝不整块替换。
 *
 * @param original - 官方 POLICY 全文（或任何同构文本）。
 * @returns 压缩后的策略；输入不含坐标标记时原样返回。
 */
export function compressPolicy(original) {
  if (typeof original !== 'string' || original === '') return original;
  const coordinates = original.indexOf(COORDINATES_MARKER);
  if (coordinates === -1) return original;
  const steps = original.indexOf(STEPS_MARKER, coordinates);
  if (steps === -1) return `${original.slice(0, coordinates)}${ACTION}`;
  return `${original.slice(0, steps)}${ACTION}`;
}

/**
 * 追加到系统提示的作业纪律（与 {@link compressPolicy} 合并为一段使用）。
 *
 * 刻意短：它写进稳定前缀，只在第一次请求计费，之后全部走缓存。
 * 它约束的是“怎么说”和“怎么说停”，不改变任何目标或验收标准。
 */
export const DISCIPLINE = `Working style: act, do not narrate. Emit no preamble before a tool call. Never repeat in prose what a tool result already shows or what you already concluded. Read the latest screenshot once and decide; do not re-examine an image you have already acted on. When a control is visible, click it in this step instead of describing what you would click. Stop as soon as the user's goal is met — no extra verification clicks, no bonus tidy-up, no summary of your own reasoning.`;

/**
 * 组装本插件使用的完整策略段。
 *
 * @param original - 官方 POLICY 全文。
 * @param options - `{ policy: boolean, discipline: boolean }` 两个开关。
 * @returns 模型最终看到的策略段。
 */
export function buildPolicy(original, options = {}) {
  const policy = options.policy === false ? original : compressPolicy(original);
  if (options.discipline === false) return policy;
  return `${policy}\n\n${DISCIPLINE}`;
}
