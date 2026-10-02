/**
 * 内容变换：全部是**纯函数**，不碰 Cordis、不碰 I/O，因此可以被穷举测试。
 *
 * 这里只做三类在数学上可证明无损的压缩：
 *
 * 1. `stripRedundantImages` —— 一次多动作批处理里，每个 GUI 动作都会附一张
 *    动作后截图，而官方策略明确写着“after the step use the last image”。
 *    也就是说除最后一张外，其余截图模型被要求不要看。它们照样要付读入费。
 * 2. `dedupeImages` —— 逐字节相同的截图用一行等价说明替代。
 * 3. `dedupeText` —— 逐字相同的文本结果用一行等价说明替代。
 *
 * 以及两类**有损但可配置**的压缩，默认关闭或保守：
 * 4. `capText` —— 超长文本留头留尾；默认 `headChars + tailChars === 0`
 *    表示不启用。
 * 5. `windowImages` —— 只保留最近 N 张截图，更早的换成占位说明。
 *    默认关闭，因为删除历史中段会让后续每一步的 KV 缓存从删除点起失效。
 *
 * @module dsh-computer-use-turbo/content
 */

/** 文本块的码点数（按 Unicode 码点，不切断代理对）。 */
export function textLength(blocks) {
  let total = 0;
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    total += Array.from(String(block.text ?? '')).length;
  }
  return total;
}

/** 按 Unicode 码点截取，返回 `{ text, chars, truncated }`。 */
export function clip(text, maxChars) {
  const points = Array.from(String(text));
  if (points.length <= maxChars) return { text: String(text), chars: points.length, truncated: false };
  return { text: points.slice(0, maxChars).join(''), chars: points.length, truncated: true };
}

/** 内容里有多少个图片块。 */
export function countImages(blocks) {
  let total = 0;
  for (const block of blocks) if (block?.type === 'image') total += 1;
  return total;
}

/** 内容里有多少个非文本、非图片的富块（结构化块、文件引用等）。 */
export function countRichBlocks(blocks) {
  return blocks.filter((block) => block?.type !== 'text' && block?.type !== 'image').length;
}

/**
 * 判断一块内容是否“以观察为主”。
 *
 * computer-use 的 `observeDesktop()` 只产出两类块：文本（前台应用信封）与
 * 图片（逐屏观察）。因此“含图”就是观察结果的充要条件——这是官方实现写死
 * 的形状，不是猜测。
 *
 * @param blocks - 工具结果内容块。
 * @returns 是否含至少一个图片块。
 */
export function isObservation(blocks) {
  return countImages(blocks) > 0;
}

/**
 * 丢掉富块之外的一切，只留图片，用于构造“哪几张图变了”的判断输入。
 *
 * @param blocks - 待筛选内容块。
 * @returns 只含图片块的新数组。
 */
export function imagesOf(blocks) {
  return blocks.filter((block) => block?.type === 'image');
}

/**
 * 从内容里去掉前 `drop` 个图片块，其余块（含信封文本）原样保留。
 *
 * @param blocks - 原内容块。
 * @param drop - 要去掉的图片个数；`<= 0` 时原样返回。
 * @returns 变换后的内容块数组。
 */
export function stripImages(blocks, drop) {
  if (drop <= 0) return blocks;
  const kept = [];
  let seen = 0;
  for (const block of blocks) {
    if (block?.type === 'image') {
      seen += 1;
      if (seen <= drop) continue;
    }
    kept.push(block);
  }
  return kept;
}

/**
 * 用等价说明替换前 `drop` 个图片块。
 *
 * 与 {@link stripImages} 的区别：这里留下“曾经有一张图、它是什么”的痕迹。
 * 用于窗口模式——被丢掉的是历史截图，模型需要知道那一屏看过了，而不是
 * 以为观察结果本来就缺一块。
 *
 * @param blocks - 原内容块。
 * @param drop - 要替换的图片个数。
 * @param notice - 每张被替换的图对应的说明文本。
 * @returns 变换后的内容块数组。
 */
export function replaceImages(blocks, drop, notice) {
  if (drop <= 0) return blocks;
  const out = [];
  let seen = 0;
  for (const block of blocks) {
    if (block?.type === 'image') {
      seen += 1;
      if (seen <= drop) {
        out.push({ type: 'text', text: notice(block, seen) });
        continue;
      }
    }
    out.push(block);
  }
  return out;
}

/**
 * 逐字节相同的结果用一行等价说明替代。
 *
 * 与生存模式同构，但按 `agent + tool` 分表：GUI 截图与 bash 输出互不干扰，
 * 也绝不会把 A 会话的截图认成 B 会话的。
 *
 * @param blocks - 规范化后的内容块。
 * @param table - 该 `agent + tool` 的 `key -> { callId, call }` 表。
 * @param keyOf - 从内容块算出可比对键；返回 undefined 表示不可比对。
 * @param call - `{ callId, call }` 本次调用标识。
 * @param notice - 生成等价说明的函数 `(previous) => string`。
 * @returns `{ blocks, hit: boolean }`；`hit` 为真表示发生替换。
 */
export function dedupeByKey(blocks, table, keyOf, call, notice) {
  const key = keyOf(blocks);
  if (key === undefined) return { blocks, hit: false };
  const previous = table.get(key);
  if (previous === undefined) {
    table.set(key, call);
    return { blocks, hit: false };
  }
  return { blocks: [{ type: 'text', text: notice(previous) }], hit: true };
}

/**
 * 留头留尾的保守截断。
 *
 * **有损**：中段被换成一行标记。因此默认阈值之和为 0（不启用），
 * 且即使启用也只作用于非观察结果（观察结果走图片路径，不走这里）。
 *
 * @param blocks - 原内容块。
 * @param headChars - 头部保留码点数。
 * @param tailChars - 尾部保留码点数。
 * @returns `{ blocks, removed, truncated }`。
 */
export function capText(blocks, headChars, tailChars) {
  const budget = headChars + tailChars;
  if (budget <= 0) return { blocks, removed: 0, truncated: false };
  let removed = 0;
  let truncated = false;
  const out = [];
  for (const block of blocks) {
    if (block?.type !== 'text') {
      out.push(block);
      continue;
    }
    const points = Array.from(String(block.text ?? ''));
    if (points.length <= budget) {
      out.push(block);
      continue;
    }
    truncated = true;
    removed += points.length - budget;
    const head = points.slice(0, headChars).join('');
    const tail = points.slice(points.length - tailChars).join('');
    out.push({
      type: 'text',
      text: `${head}\n\n[... ${points.length - budget} characters trimmed by computer-use-turbo; re-run with a narrower command to see the middle ...]\n\n${tail}`,
    });
  }
  return { blocks: out, removed, truncated };
}

/**
 * 从图片块算出一个“这一屏是否变过”的键。
 *
 * 两级：
 *   1. 严格模式（默认）：附件服务能交出字节时，用 SHA-256——逐字节相同才命中，
 *      数学上不可能把变化过的屏幕判成没变。
 *   2. 回退模式：附件服务不可用或读取失败时，退到内容寻址的 `attachmentId`。
 *      本机日志显示computer-use 写入的是内容寻址附件（同名截图复用同一 id），
 *      但这属于实现细节，所以回退模式会标记 `strict: false`，调用方据此决定
 *      是否仍然压缩（配置 `strictImageDedupe` 默认为真，即回退模式不压缩）。
 *
 * @param block - 图片块。
 * @param resolve - `async (attachment) => Buffer | Uint8Array | undefined`。
 * @returns `{ key, strict }`；`key` 为 undefined 表示无法判断。
 */
export async function imageKey(block, resolve) {
  const attachment = block?.attachment;
  if (attachment === undefined || attachment === null) return { key: undefined, strict: false };
  const bytes = await resolve(attachment);
  if (bytes !== undefined && bytes !== null) {
    const digest = await sha256(bytes);
    return { key: `sha256:${digest}`, strict: true };
  }
  const id = attachment.attachmentId;
  if (typeof id === 'string' && id !== '') return { key: `attachment:${id}`, strict: false };
  return { key: undefined, strict: false };
}

/**
 * 计算 SHA-256（十六进制）。
 *
 * 用 `node:crypto` 的同步入口：需要摘要的是单张 PNG（几百 KB 量级），
 * 同步开销远小于一次截图本身，换来的是不必在纯函数里处理异步错误路径。
 *
 * @param bytes - 任意字节。
 * @returns 十六进制摘要。
 */
export async function sha256(bytes) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}
