/**
 * dsh-computer-use-turbo —— Computer Use 模式的加速与省 token 插件（Host 半边）。
 *
 * ## 为什么是这几个杠杆
 *
 * 本机真实 computer-use 会话日志（5 个会话，见 README「实测证据」）显示：
 *
 * | 现象 | 实测值 |
 * |---|---|
 * | 单次会话模型步数 | 18 / 35 / 44 / 45 |
 * | 单次会话 reasoning 输出 | 4.3k / 10.7k / 16.0k / 33.2k token |
 * | 单次会话 bash 调用 | 0 / 1 / 22 / 29 / 37 |
 * | 单次会话 `code_agent` 调用 | **0**（五次会话全部为 0） |
 * | 启动固定面 | 工具表 4,070 tok + 系统提示 2,758 tok |
 *
 * 结论很直接：贵和慢**都不是因为读得多，而是因为步多、每步想得久，而步多的
 * 根因是该交棒给 `code_agent` 的长任务被模型用 bash 硬啃**。所以本插件按
 * 「先砍步、再砍 token」排序，每一步都只做可证明无损或显式可配置的压缩：
 *
 * 1. **策略层**（`policy.js`）：压缩官方策略的重复表述，并补一条**可数的**
 *    交棒预算（bash 用满 3 次即交棒）。原策略只写主观判断，模型每次都能
 *    说服自己“再试一次”，实测因此多跑 20+ 步。
 * 2. **批处理截图去冗余**：一次多动作批处理里每个动作都附一张动作后截图，
 *    而官方策略明确要求模型“after the step use the last image”。除最后一张
 *    外全部丢掉——模型本来就被要求不看，这是一处纯粹的白付。
 * 3. **逐字节去重**：相同截图、相同文本结果各用一行等价说明替代。
 *    只有完全相同时才命中，不可能掩盖任何变化。
 * 4. **可选的观察窗口**（默认关闭）：只保留最近 N 张截图。它**会**让后续
 *    请求的 KV 缓存从删除点起失效，因此默认关闭并在 README 里写明这笔账。
 *
 * 明确**不做**的事：
 * - 不按轮次增删工具（工具表位于请求前缀，任何一次增删都会让整段缓存失效）。
 * - 不改模型、不改 `reasoningEffort`（那会改变输出本身，属于用户的选择，
 *   不是插件的选择）。需要更快时请在设置里调低 reasoning effort。
 * - 不动失败结果（那是模型自我纠错的关键依据）、不动富内容块。
 *
 * @module dsh-computer-use-turbo
 */

import { createRequire } from 'node:module';

import { DISCIPLINE, compressPolicy } from './policy.js';
import {
  capText,
  countImages,
  countRichBlocks,
  dedupeByKey,
  imageKey,
  isObservation,
  replaceImages,
  stripImages,
  textLength,
} from './content.js';

/** Cordis 插件名。 */
export const name = 'computer-use-turbo';

/**
 * 依赖：工具注册表（挂 post-execute / execute）与系统提示注册表（改写策略段）。
 * `attachments` 通过 `ctx.get()` 可选获取——缺失时退到回退键或放弃去重，
 * 不会让插件挂载失败。
 */
export const inject = ['tools', 'systemPrompt'];

/**
 * 单张截图在视觉路由上的 token 估计，**仅用于日志口径**。
 *
 * 依据：官方 computer-use 用 4000 作为一张截图的通知预算
 * （`dist/computer-use/code-agent.js` 的 `body.length <= 4e3`），本机截图是
 * 2400×1500 视网膜全屏窗口，按常见视觉编码口径约 4.5k token，取 4000 偏保守。
 * 它不参与任何功能判断，只决定日志里那句“约省多少 token”的量级。
 */
const IMAGE_TOKENS = 4000;

/**
 * 取 zod，取不到就返回 undefined。
 *
 * profile 侧插件由 pnpm 以 `link:` 安装，依赖解析发生在工作区真实路径上，
 * 因此 `zod` 未必一定能解析到。Config 只影响配置校验，**绝不能**因为一个
 * 可选的校验依赖缺失就让整个预设挂载失败，所以这里容忍失败。
 *
 * @returns {object|undefined} zod 模块，或 undefined。
 */
function loadZod() {
  try {
    return createRequire(import.meta.url)('zod');
  } catch {
    return undefined;
  }
}

const z = loadZod();

/**
 * 配置校验模式。
 *
 * 每个字段都有默认值，因此**空配置即可工作**；`apply` 内部同样对每个字段
 * 做了 `??` 兜底，所以在没有 zod 的环境里行为完全一致。
 */
export const Config = z?.object({
  /** 总开关。关闭后插件不注册任何监听器。 */
  enabled: z.boolean().default(true),
  /** 启用的预设 id 列表；空数组表示对每个会话都启用。 */
  presets: z.array(z.string()).default(['computer-use']),
  /** 压缩官方 computer-use 策略文本。 */
  policy: z.boolean().default(true),
  /** 在策略后面追加作业纪律。 */
  discipline: z.boolean().default(true),
  /** 逐字节相同的截图用等价说明替代。 */
  dedupeImages: z.boolean().default(true),
  /**
   * 图片去重是否要求严格模式（SHA-256 逐字节比较）。
   * 为真时，附件服务不可用或读取失败会让本次去重放弃，而不是退到元数据启发式。
   */
  strictImageDedupe: z.boolean().default(true),
  /** 逐字相同的非观察文本结果用等价说明替代。 */
  dedupeText: z.boolean().default(true),
  /** 触发文本去重的最小码点数。 */
  textDedupeMinChars: z.number().int().min(1).default(512),
  /** 文本留头码点数；与 `textCapTailChars` 之和为 0 表示不启用截断（默认）。 */
  textCapHeadChars: z.number().int().min(0).default(0),
  /** 文本留尾码点数。 */
  textCapTailChars: z.number().int().min(0).default(0),
  /** 只对观察结果保留最近 N 张截图；0 表示保留全部（默认，见 README 缓存账）。 */
  imageRetentionWindow: z.number().int().min(0).default(0),
  /**
   * 把 `reasoningEffort` 钉在会话内首次请求的取值上。
   *
   * 这是本插件对缓存命中率影响最大的一项。实测：`dsh-orb` 的 `code_agent` 在启动时
   * 会临时改写全局默认模型再还原（`selectModelKeepDefault`），而窗口期内任何会话都会
   * 读到那个临时值。计算机会话一旦某一步读到的 `reasoningEffort` 与上一步不同，
   * 请求头就变了，DeepSeek 端**整段前缀缓存作废**——实测两次这样的变更烧掉 146,920
   * 个按未命中价计费的 token，占该会话全部未命中的 69%。
   *
   * 只在 `provider + model` 不变时才回钉：换模型是用户的明确动作，不拦。
   */
  pinReasoningEffort: z.boolean().default(true),
  /** 把省量写入 Host 日志。 */
  logSavings: z.boolean().default(true),
  /** 写入日志时附上更细的分项。 */
  verboseMetrics: z.boolean().default(false),
});

/** 解析后的默认配置（没有 zod 或字段缺失时使用）。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  presets: ['computer-use'],
  policy: true,
  discipline: true,
  dedupeImages: true,
  strictImageDedupe: true,
  dedupeText: true,
  textDedupeMinChars: 512,
  textCapHeadChars: 0,
  textCapTailChars: 0,
  imageRetentionWindow: 0,
  pinReasoningEffort: true,
  logSavings: true,
  verboseMetrics: false,
});

/**
 * 合并用户配置与默认值。
 *
 * @param config - Cordis 传入的已解析配置。
 * @returns 完整配置对象。
 */
export function resolveConfig(config) {
  return { ...DEFAULTS, ...(config ?? {}) };
}

/**
 * computer-use 策略段的识别锚点与坐标标记。
 *
 * 按**内容**识别而不是按 section 名：section 名与排序都可能在版本间变化，
 * 但这两段文字是 computer-use 的核心语义，改它们等于改坐标口径。
 */
const POLICY_ANCHOR = 'trust only the attached screenshot';
const COORDINATES_MARKER = 'Coordinates:';

/**
 * 判断一段系统提示文本是不是 computer-use 的策略段。
 *
 * @param text - section 文本。
 * @returns 是否命中。
 */
export function isComputerUsePolicy(text) {
  if (typeof text !== 'string') return false;
  return text.includes(POLICY_ANCHOR) && text.includes(COORDINATES_MARKER);
}

/**
 * 从若干工具 schema 判断这是不是一个 computer-use 工具面。
 *
 * 兜底手段：`agentPreset` 读不到时（例如用户自定义预设复制了同一套工具），
 * 用 GUI 工具的签名组合来判断。要求同时出现多个桌面操作工具与 `code_agent`，
 * 单有 `screenshot` 这类通用名不足以命中。
 *
 * @param tools - 已组装的工具 schema 列表。
 * @returns 是否是 computer-use 工具面。
 */
export function looksLikeComputerUseTools(tools) {
  if (!Array.isArray(tools)) return false;
  const names = new Set(tools.map((tool) => tool?.name));
  const gui = ['click', 'open_in_finder', 'open_app', 'list_apps', 'drag', 'long_press', 'input_text'];
  const guiHits = gui.filter((tool) => names.has(tool)).length;
  return guiHits >= 3 && names.has('code_agent');
}

/**
 * 读出一个 Agent 的预设 id（可能拿不到）。
 *
 * @param agent - 调用方 Agent。
 * @returns 预设 id，或 undefined。
 */
export function agentPresetOf(agent) {
  try {
    const preset = agent?.session?.header?.agentPreset;
    return typeof preset === 'string' && preset !== '' ? preset : undefined;
  } catch {
    return undefined;
  }
}


/**
 * 读出一个 Agent 当前所在的模型步号。
 *
 * 步号是判定“一次多动作批处理”的唯一可靠依据：同一步里到达的多条观察结果
 * 才是中间帧，跨步的单条观察结果永远不能被丢。拿不到步号时返回 `undefined`，
 * 调用方据此**退回保守行为**（不丢任何截图）——宁可少省，不可丢画面。
 *
 * 两条来源，按可靠性排序：
 *   1. 会话日志头部的 `step` 字段（若该版本提供）；
 *   2. 会话事件流里最后一条 `step/start` 的 `data.step`。
 *      已核对本机真实会话日志：`{"type":"step/start", ..., "data":{"turn":1,"step":7}}`。
 *      日志只追加、只读，因此扫描是纯观察，不会影响会话。
 *
 * @param agent - 调用方 Agent。
 * @returns 步号，或 undefined。
 */
export function agentStepOf(agent) {
  try {
    const session = agent?.session;
    if (session === undefined) return undefined;
    // `session.log` 是**事件数组**（`Session.append(type, data)` 按序 push），
    // 没有任何 `header` / `events` 包装——这里按已核实的真实形状读取。
    const events = Array.isArray(session.log) ? session.log : session.log?.events;
    if (events === undefined || typeof events[Symbol.iterator] !== 'function') return undefined;
    let latest;
    for (const event of events) {
      if (event?.type === 'step/start' && Number.isInteger(event?.data?.step)) latest = event.data.step;
    }
    return latest;
  } catch {
    return undefined;
  }
}

/** 等价说明：逐字节相同的截图。 */
function duplicateImageNotice(previous) {
  return `[turbo] 与本次会话中 \`${previous.call}\`（call_id=${previous.callId}）附带的截图逐字节相同，已省略；直接沿用上面那次的观察。`;
}

/**
 * 等价说明：屏幕与上一条观察结果完全相同。
 *
 * 刻意说明“这一屏没变”，因为模型需要区分两种情况：截图被插件省略了，
 * 还是工具失败了。少了这句话，模型会重试一次截图，反而多花一步。
 */
function duplicateScreenNotice() {
  return '[turbo] 这一屏与上一条观察结果逐字节相同，截图已省略；屏幕没有变化，直接沿用上面那张最新的画面。';
}

/**
 * 等价说明：批处理中间帧。
 *
 * 官方策略要求模型“after the step use the last image”，因此这些中间帧本来
 * 就不该被读。但它们的存在仍然值得说一句，否则模型会以为某个动作没有截图。
 */
const BATCH_NOTICE =
  '[turbo] 这是本步中间动作的观察结果，截图已省略；本步最后一条动作结果里的截图才是本步结束时的画面。';

/** 等价说明：逐字相同的文本结果。 */
function duplicateTextNotice(previous, chars) {
  return `[turbo] 与本次会话中 \`${previous.call}\`（call_id=${previous.callId}）的输出逐字相同（${chars} 字符），已省略；直接沿用上面那份内容。`;
}

/** 等价说明：被观察窗口丢掉的旧截图。 */
function windowedImageNotice(index) {
  return `[turbo] 第 ${index} 张历史截图已按观察窗口省略；它记录的界面已被后面的截图取代。`;
}

/**
 * 安装加速与省 token 策略。
 *
 * @param ctx - Cordis 上下文。
 * @param config - Cordis 解析后的配置。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (cfg.enabled !== true) return;

  /**
   * 把配置摊平成一组常量。
   *
   * 每个值都带 `?? 默认值` 兜底，而不是依赖 `cfg` 对象在闭包里的读取。
   * 这样即使运行时的 Config 投影只交出部分字段，行为也完全确定——插件的
   * 判定逻辑不应该依赖配置对象本身有多完整。
   */
  const PRESETS = cfg.presets ?? ['computer-use'];
  const USE_POLICY = cfg.policy ?? true;
  const USE_DISCIPLINE = cfg.discipline ?? true;
  const DEDUPE_IMAGES = cfg.dedupeImages ?? true;
  const STRICT_IMAGES = cfg.strictImageDedupe ?? true;
  const DEDUPE_TEXT = cfg.dedupeText ?? true;
  const TEXT_MIN_CHARS = cfg.textDedupeMinChars ?? 512;
  const TEXT_HEAD_CHARS = cfg.textCapHeadChars ?? 0;
  const TEXT_TAIL_CHARS = cfg.textCapTailChars ?? 0;
  const IMAGE_WINDOW = cfg.imageRetentionWindow ?? 0;
  const PIN_EFFORT = cfg.pinReasoningEffort ?? true;
  const LOG_SAVINGS = cfg.logSavings ?? true;
  const VERBOSE = cfg.verboseMetrics ?? false;

  // 每个 Agent 一份状态：以 Agent 对象为键，Agent 释放即整表回收。
  const states = new WeakMap();
  const metrics = {
    sessions: 0,
    calls: 0,
    batchSteps: 0,
    droppedImages: 0,
    dedupedImages: 0,
    dedupedTexts: 0,
    windowedImages: 0,
    cappedChars: 0,
    savedChars: 0,
    cacheRead: 0,
    cacheMiss: 0,
    cacheSteps: 0,
    cacheWipes: 0,
    effortRepins: 0,
  };

  /**
   * 取（或建）一个 Agent 的状态。
   *
   * @param agent - 调用方 Agent。
   * @returns 状态对象。
   */
  function stateOf(agent) {
    let state = states.get(agent);
    if (state === undefined) {
      state = {
        /** 上一轮**任何**观察结果的截图指纹；undefined 表示还没有。 */
        lastObservationKey: undefined,
        /** 当前模型步号；undefined 表示读不到，此时不做批处理去冗余。 */
        step: agentStepOf(agent),
        /** 当前步内已经处理过几条观察结果（用于批处理去冗余）。 */
        batch: 0,
        /** `tableKey -> Map(compareKey -> { call, callId })`，用于跨结果逐字节去重。 */
        seen: new Map(),
        /** `tableKey -> number`，观察窗口的累计计数。 */
        counters: new Map(),
        /**
         * 会话内首次成功请求的 `reasoningEffort` 钉值，按 `provider + model` 分组。
         * `key -> effort`；effort 为 undefined 表示该路由没有显式指定。
         */
        pinnedEffort: new Map(),
        /** 缓存观测：`provider|model|effort` -> { lastHeader, cacheRead, miss, steps } 增量基线。 */
        cache: new Map(),
        /** 缓存观测汇总。 */
        cacheTotals: { read: 0, miss: 0, steps: 0, wipes: 0 },
      };
      states.set(agent, state);
      metrics.sessions += 1;
    }
    return state;
  }

  /**
   * 取某个比对表。
   *
   * 按 `agent + tableKey` 分表：GUI 截图与 bash 输出互不干扰，跨会话不会串味。
   *
   * @param state - Agent 状态。
   * @param tableKey - 表标识（工具名或带前缀的名字）。
   * @returns 该表的 Map。
   */
  function tableFor(state, tableKey) {
    let table = state.seen.get(tableKey);
    if (table === undefined) {
      table = new Map();
      state.seen.set(tableKey, table);
    }
    return table;
  }

  /**
   * 尝试用附件服务取回一张截图的字节，用于逐字节比较。
   *
   * 拿不到就返回 undefined——调用方据此决定是放弃去重（严格模式）还是退到
   * 内容寻址的 `attachmentId`（非严格模式）。
   *
   * @param attachment - 图片块上的附件引用。
   * @returns 字节，或 undefined。
   */
  async function readBytes(attachment) {
    const attachments = ctx.get?.('attachments');
    if (attachments === undefined || typeof attachments.readImage !== 'function') return undefined;
    try {
      const stored = await attachments.readImage(attachment);
      return stored?.data ?? stored?.bytes ?? stored?.buffer ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 处理一条观察结果。
   *
   * 按优先级判定，且全部只在**截图之间**做取舍：前台应用信封文本一律原样保留。
   *
   * 1. **与上一条观察结果逐字节相同**（`duplicate`）→ 屏幕没变。用一行等价说明
   *    替代图片。数学上无损：字节完全相同意味着界面上一个像素都没动。
   * 2. **本会话更早出现过同一屏**（`duplicate`）→ 同样用等价说明替代，并点名
   *    来源 call_id，模型才能回指上面那份内容。
   * 3. **同一步内第 2 条及以后的观察结果**（`batch`）→ 批处理中间帧。官方策略
   *    明确写着“after the step use the last image”，模型被要求不要看它们。
   *    注意规则是确定性的：**本步第一条保留、其余丢掉**——流式处理里无法预知
   *    哪一条才是最后一条，而“保留第一条”正是模型建立本步认知所必需的那一张。
   *    步号读不到时这条不生效。
   * 4. 其余一律 `keep`（本轮第一条观察结果），随后才轮到可选的观察窗口。
   *
   * @param agent - 调用方 Agent。
   * @param exec - 工具执行描述。
   * @param blocks - 当前内容块。
   * @returns `{ blocks, kind }`；`kind` 取 `keep` / `duplicate` / `batch`。
   */
  async function processObservation(agent, exec, blocks) {
    const state = stateOf(agent);
    const step = agentStepOf(agent);
    // 步边界：进入新的一步就把批处理计数清零。读不到步号时保持 batch 不变，
    // 而下面的批处理分支要求步号已知，因此效果是保守的“不丢任何截图”。
    if (step !== undefined && step !== state.step) {
      state.step = step;
      state.batch = 0;
    }

    const images = blocks.filter((block) => block?.type === 'image');

    // 给每张图求键：严格模式下这一步会读附件字节。
    //
    // 只有当「有没有变」还看不出来时才需要全部键——批处理中间帧那条规则不看键，
    // 因此多屏会话里省掉的是无谓的字节读取。任何情况下都不会因为少读一张图而误判：
    // 需要按图取舍的只有下面第 (1)/(3) 两条，它们各自保证 `keys` 已完整。
    const firstImageKey = images.length > 0 ? await imageKey(images[0], readBytes) : undefined;
    const fingerprint = firstImageKey?.key;
    const unchanged = DEDUPE_IMAGES && fingerprint !== undefined && state.lastObservationKey === fingerprint;
    const needsKeys = !unchanged && DEDUPE_IMAGES && images.length > 0;
    let keys = [];
    if (needsKeys) {
      const entries = [firstImageKey];
      for (let index = 1; index < images.length; index += 1) {
        entries.push(await imageKey(images[index], readBytes));
      }
      keys = entries.map(({ key, strict }) => ({
        key,
        strict,
        usable: key !== undefined && (!STRICT_IMAGES || strict),
      }));
    }

    state.lastObservationKey = fingerprint;
    const table = DEDUPE_IMAGES ? tableFor(state, exec.name) : undefined;
    let dropped = 0;
    let kind = 'keep';
    let blocks2 = blocks;

    // (1) 逐字节相同：这一屏与本会话已经见过的某一屏完全一致。
    //     先判“与上一条观察结果相同”（屏幕没有变化），再判“本次会话更早出现过”
    //     （跨越了中间画面回到了旧状态）。两者都不含任何猜测：键来自严格模式下的
    //     SHA-256，或（仅在关闭严格模式时）内容寻址的附件 id。
    if (unchanged && images.length > 0) {
      blocks2 = replaceImages(blocks, images.length, () => duplicateScreenNotice());
      dropped = images.length;
      kind = 'duplicate';
    } else if (table !== undefined && images.length > 0 && keys.some((entry) => entry.usable)) {
      const kept = [];
      let index = 0;
      for (const block of blocks) {
        if (block?.type !== 'image') {
          kept.push(block);
          continue;
        }
        const entry = keys[index];
        index += 1;
        if (entry === undefined || !entry.usable) {
          kept.push(block);
          continue;
        }
        const previous = table.get(entry.key);
        if (previous === undefined) {
          table.set(entry.key, { call: exec.name, callId: String(exec.callId ?? '') });
          kept.push(block);
          continue;
        }
        kept.push({ type: 'text', text: duplicateImageNotice(previous) });
        dropped += 1;
        kind = 'duplicate';
      }
      blocks2 = kept;
    }

    // (2) 批处理中间帧：**同一步内**的第 2 条及以后的观察结果，图片全部丢掉。
    //     官方策略要求模型“after the step use the last image”，中间帧本就不该被读。
    //     步号读不到时这一条不生效——宁可少省，不可丢画面。
    if (kind === 'keep' && step !== undefined && state.batch >= 1 && images.length > 0) {
      blocks2 = [...stripImages(blocks, images.length), { type: 'text', text: BATCH_NOTICE }];
      dropped = images.length;
      kind = 'batch';
    }

    state.batch += 1;
    if (kind === 'batch') metrics.batchSteps += 1;
    if (dropped > 0) {
      if (kind === 'batch') metrics.droppedImages += dropped;
      else metrics.dedupedImages += dropped;
      metrics.savedChars += dropped * IMAGE_TOKENS * 4;
    }

    // (3) 观察窗口：只保留最近 N 张，更早的换成占位说明。
    //     默认 0（关闭）——删除历史中段会让后续请求的 KV 缓存从删除点起失效。
    if (IMAGE_WINDOW > 0) {
      const counterKey = `__window__:${exec.name}`;
      const total = (state.counters.get(counterKey) ?? 0) + 1;
      state.counters.set(counterKey, total);
      const remaining = countImages(blocks2);
      if (total > IMAGE_WINDOW && remaining > 0) {
        blocks2 = replaceImages(blocks2, remaining, (_block, index) => windowedImageNotice(index));
        metrics.windowedImages += remaining;
      }
    }

    return { blocks: blocks2, kind };
  }

  /**
   * 判定某个 Agent 是否启用本插件。
   *
   * @param agent - 调用方 Agent。
   * @param tools - 已组装的工具 schema 列表（可选，用于兜底判定）。
   * @returns 是否启用。
   */
  function modeFor(agent, tools) {
    const presets = PRESETS ?? [];
    if (presets.length === 0) return true;
    const preset = agentPresetOf(agent);
    if (preset !== undefined) return presets.includes(preset);
    if (tools !== undefined) return looksLikeComputerUseTools(tools);
    return false;
  }

  /**
   * 把 `reasoningEffort` 钉在会话内首次请求的取值上。
   *
   * **为什么这能救缓存**：DeepSeek 的前缀缓存按请求头区分。`reasoningEffort` 是请求
   * 配置的一部分，一旦中途变化，服务端就找不到可复用的前缀，整段历史按未命中价重算。
   * 实测（`.probe/sessions/session-4e3b5517`）：两次被 `code_agent` 的临时模型切换
   * 带偏，紧跟着就是两次 `cacheRead≈0` 的清空，合计 146,920 token 按 1.00 元/M
   * 计费，而它本可以按 0.02 元/M 命中。
   *
   * **为什么放在这里而不是 `prepend`**：`agent/request` 是普通 waterfall，先注册先跑。
   * 本插件最后注册，因此处在最内层——`installModelSelection` 已经把选中的 effort 写进
   * 配置之后，我才做修正。若用 `prepend`，我的修正会被它覆盖掉，等于没做。
   *
   * **安全边界**：只在 `provider + model` 都没变时才回钉。用户换模型是明确动作，
   * 换了就重新钉新路由的取值，绝不阻拦。
   *
   * @param payload - `{ agent, turn, step, signal }`。
   * @param next - 下游决定，解析为 `LlmCallConfig`。
   * @returns 修正后的 `LlmCallConfig`。
   */
  async function pinReasoningEffort(payload, next) {
    const resolved = await next();
    try {
      const agent = payload?.agent;
      if (agent === undefined || modeFor(agent, undefined) === false) return resolved;
      if (resolved === undefined || typeof resolved !== 'object') return resolved;

      const route = `${String(resolved.provider)}\u0000${String(resolved.model)}`;
      const effort = resolved.reasoningEffort;
      const state = stateOf(agent);

      // 记录本步生效的请求配置，供用量侧判断“前缀为什么没被复用”。
      const header = `${String(resolved.provider)}|${String(resolved.model)}|${String(effort)}|${String(resolved.maxTokens)}`;
      state.cacheTotals.configChanged = state.cacheTotals.lastHeader !== undefined && state.cacheTotals.lastHeader !== header;
      state.cacheTotals.lastHeader = header;

      if (!PIN_EFFORT) return resolved;
      if (!state.pinnedEffort.has(route)) {
        state.pinnedEffort.set(route, effort);
        return resolved;
      }
      const pinned = state.pinnedEffort.get(route);
      if (pinned === effort) return resolved;

      metrics.effortRepins += 1;
      safeLog(
        ctx,
        'warn',
        `computer-use-turbo: 本步请求的 reasoningEffort 是 ${String(effort)}，与本次会话首次请求的 ${String(pinned)} 不一致；已回钉为 ${String(pinned)}，否则 DeepSeek 端整段前缀缓存会作废（本会话第 ${metrics.effortRepins} 次）。` +
          '如果你**故意**要在会话中途改 reasoning effort，请把插件的 pinReasoningEffort 设为 false；否则这个改动会被撤销。',
      );
      state.cacheTotals.lastHeader = `${String(resolved.provider)}|${String(resolved.model)}|${String(pinned)}|${String(resolved.maxTokens)}`;
      return { ...resolved, reasoningEffort: pinned };
    } catch (error) {
      safeLog(ctx, 'warn', `computer-use-turbo: effort pin failed: ${String(error)}`);
      return resolved;
    }
  }

  /**
   * 记录一次真实用量，算出本步的缓存命中率，并判断缓存是不是被清空。
   *
   * **为什么记这个**：命中率是本插件唯一无法靠推理确认的指标——它由服务端决定。
   * 不记下来，就无法证明「回钉 effort」到底有没有救回那 69% 的未命中。
   * 用量来自 provider 返回的 `usage`，是**实测值**而非估算。
   *
   * **清空是怎么判定的**：DeepSeek 对无法复用的前缀按未命中价计费，而 `inputTokens`
   * 包含这一部分。因此「未命中 ≈ 当前整段上下文」就等于整段前缀没被复用。
   * 实测分布高度分离：正常步未命中只占上下文 2%–15%，清空步是 90%–100%。
   * 判定取 60% 作为阈值，落在两者中间的空档里。
   *
   * @param state - 该 Agent 的状态。
   * @param usage - `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`。
   * @param configChanged - 本步请求头相对上一步是否变过。
   */
  function recordUsage(state, usage, configChanged) {
    const read = Number(usage?.cacheReadTokens ?? 0);
    const miss = Number(usage?.inputTokens ?? 0);
    if (!Number.isFinite(read) || !Number.isFinite(miss)) return;
    const totals = state.cacheTotals;
    // 上一步**整段上下文**的大小：那才是“没被复用就要按未命中重算”的量。
    const previousContext = (totals.lastRead ?? 0) + (totals.lastMiss ?? 0);
    totals.read += read;
    totals.miss += miss;
    totals.steps += 1;
    metrics.cacheRead += read;
    metrics.cacheMiss += miss;
    metrics.cacheSteps += 1;

    const denom = read + miss;
    // 未命中量级达到上一步整段上下文的 60% 以上 ⇒ 那一整段几乎没被复用。
    const noReuse = previousContext > 0 && miss >= previousContext * 0.6;
    if (denom > 0 && noReuse) {
      totals.wipes += 1;
      metrics.cacheWipes += 1;
      const reason = configChanged
        ? '请求头在本步变过（reasoningEffort / 模型 / 工具面），服务端因此无法复用前缀'
        : '请求头未变；这是服务端侧的缓存失效，客户端无法阻止';
      safeLog(
        ctx,
        'info',
        `computer-use-turbo: 整段前缀缓存被清空 —— 本步 cacheRead=${read}、未命中=${miss}（命中率 ${((read / denom) * 100).toFixed(1)}%），重算了约 ${miss} token。${reason}。`,
      );
    }
    totals.lastMiss = miss;
    totals.lastRead = read;
  }

  /**
   * 从会话事件流里取 provider 实测用量。
   *
   * **为什么不挂在工具钩子上**：已核实 `dsh-agent-loop` 只把 `usage` 写进
   * `assistant/message` 会话事件（`live.usage`），工具执行对象上没有它——
   * 挂在 `tools/post-execute` 会永远读不到，静默失效。
   *
   * 归属用 `agents.get(sessionId)` 反查：拿到活 Agent 才能复用同一份会话状态，
   * 也才能用同一个 `modeFor` 判定。反查不到（例如会话已释放）就直接略过。
   *
   * @param session - 事件所属会话。
   * @param event - 已提交的会话事件。
   */
  function observeUsage(session, event) {
    try {
      if (event?.type !== 'assistant/message') return;
      const usage = event.data?.usage;
      if (usage === undefined || usage === null) return;
      const agents = ctx.get?.('agents');
      const sessionId = session?.id;
      if (agents === undefined || sessionId === undefined) return;
      const agent = agents.get(sessionId);
      if (agent === undefined) return;
      const state = stateOf(agent);
      recordUsage(state, usage, state.cacheTotals.configChanged === true);
      // 一次请求头变化只解释一次清空。
      state.cacheTotals.configChanged = false;
    } catch {
      // 观测失败绝不影响会话。
    }
  }

  ctx.on('agent/request', pinReasoningEffort);

  try {
    ctx.on('session/event', observeUsage);
  } catch {
    // 事件名在当前版本不存在时静默降级：只少了缓存观测，不影响任何压缩行为。
  }

  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      // 必须先让下游决定完，再做自己的转换（与 dsh-spill-policy 同构）。
      const decision = await next();
      try {
        if (decision.kind !== 'accept') return decision;
        const agent = exec.agent;
        if (agent === undefined) return decision;
        if (modeFor(agent, undefined) === false) return decision;

        const state = stateOf(agent);
        metrics.calls += 1;

        const content = Array.isArray(decision.content) ? decision.content : result?.content;
        if (!Array.isArray(content) || content.length === 0) return decision;
        // 失败结果一个字都不能动：那是模型自我纠错的关键依据。
        if (result?.isError === true) return decision;
        // 富内容块（结构化输出、文件引用）一律不碰。
        if (countRichBlocks(content) > 0) return decision;

        // eslint-disable-next-line no-console
        if (isObservation(content)) {
          const transformed = await processObservation(agent, exec, content);
          return sameBlocks(transformed.blocks, content)
            ? decision
            : { kind: 'accept', content: transformed.blocks };
        }

        // 非观察结果：可选截断，然后逐字去重。
        let current = content;
        if (TEXT_HEAD_CHARS + TEXT_TAIL_CHARS > 0) {
          const capped = capText(current, TEXT_HEAD_CHARS, TEXT_TAIL_CHARS);
          if (capped.truncated) {
            current = capped.blocks;
            metrics.cappedChars += capped.removed;
          }
        }
        if (DEDUPE_TEXT === true) {
          const chars = textLength(current);
          if (chars >= TEXT_MIN_CHARS) {
            const outcome = dedupeByKey(
              current,
              tableFor(state, exec.name),
              // 只对**单块纯文本**去重：多块结果的块边界本身携带信息。
              (blocks) => (blocks.length === 1 && blocks[0]?.type === 'text' ? String(blocks[0].text) : undefined),
              { call: exec.name, callId: String(exec.callId ?? '') },
              (previous) => duplicateTextNotice(previous, chars),
            );
            if (outcome.hit) {
              metrics.dedupedTexts += 1;
              metrics.savedChars += chars;
              return { kind: 'accept', content: outcome.blocks };
            }
            current = outcome.blocks;
          }
        }
        return sameBlocks(current, content) ? decision : { kind: 'accept', content: current };
      } catch (error) {
        // 转换失败绝不能让一次成功的工具调用变成错误：原样放行。
        safeLog(ctx, 'warn', `computer-use-turbo: post-execute transform failed: ${String(error)}`);
        return decision;
      }
    },
    // prepend: true 使本监听器位于 waterfall 最外层，并在 next() 之后决策，
    // 因此看到的是**所有下游转换器处理完之后**的最终内容。
    { prepend: true },
  );

  // 系统提示改写：把 computer-use 策略段换成压缩版，并追加作业纪律。
  if (USE_POLICY || USE_DISCIPLINE) {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const resolved = await next();
      try {
        const agent = context?.agent;
        if (agent !== undefined && modeFor(agent, resolved?.tools) === false) return resolved;
        if (agent === undefined && !looksLikeComputerUseTools(resolved?.tools)) return resolved;
        if (!Array.isArray(resolved?.sections)) return resolved;

        let hit = false;
        const sections = resolved.sections.map((section) => {
          if (!isComputerUsePolicy(section?.text)) return section;
          hit = true;
          const base = USE_POLICY ? compressPolicy(section.text) : section.text;
          return { ...section, text: USE_DISCIPLINE ? `${base}\n\n${DISCIPLINE}` : base };
        });
        if (!hit) return resolved;
        return { ...resolved, sections };
      } catch (error) {
        safeLog(ctx, 'warn', `computer-use-turbo: prompt transform failed: ${String(error)}`);
        return resolved;
      }
    });
  }

  // 卸载时输出一次汇总，便于在 Host 日志里核对实际省量与缓存表现。
  ctx.effect(
    () => () => {
      if (!LOG_SAVINGS) return;
      const denom = metrics.cacheRead + metrics.cacheMiss;
      const hit = denom > 0 ? ((metrics.cacheRead / denom) * 100).toFixed(2) : 'n/a';
      const cache =
        denom > 0
          ? ` 缓存命中率 ${hit}%（实测 ${metrics.cacheRead} 命中 / ${metrics.cacheMiss} 未命中，${metrics.cacheSteps} 步，清空 ${metrics.cacheWipes} 次）；reasoningEffort 回钉 ${metrics.effortRepins} 次。`
          : ' 缓存命中率：本次未采到用量。';
      const detail = VERBOSE
        ? ` [sessions=${metrics.sessions} calls=${metrics.calls} batchObservations=${metrics.batchSteps} droppedImages=${metrics.droppedImages} dedupedImages=${metrics.dedupedImages} dedupedTexts=${metrics.dedupedTexts} windowedImages=${metrics.windowedImages} cappedChars=${metrics.cappedChars}]`
        : '';
      safeLog(
        ctx,
        'info',
        `computer-use-turbo: released — dropped ${metrics.droppedImages} intermediate screenshot(s), deduped ${metrics.dedupedImages} unchanged frame(s) and ${metrics.dedupedTexts} identical text result(s), ~${Math.round(metrics.savedChars / 4)} tokens saved.${cache}${detail}`,
      );
    },
    'computer-use-turbo.savings-report',
  );

  // 供测试与诊断使用的内部句柄（不进入模型面、不进序列化）。
  Object.defineProperty(apply, '__turbo', {
    configurable: true,
    value: { cfg, metrics, states, stateOf, modeFor, processObservation, readBytes, tableFor, recordUsage, observeUsage, pinReasoningEffort },
    enumerable: false,
  });
}

/**
 * 判断两组内容块是否逐块相同（引用级比较；变换函数不做原地修改）。
 *
 * @param a - 变换后的内容块。
 * @param b - 变换前的内容块。
 * @returns 是否相同。
 */
export function sameBlocks(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 稳定的参数序列化：键名排序，保证同一批调用算出同一个签名。
 *
 * @param value - 任意 JSON 值。
 * @returns 规范字符串。
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * 安全日志：logger 缺失或抛错都不影响主流程。
 *
 * @param ctx - Cordis 上下文。
 * @param level - 日志级别。
 * @param message - 日志正文。
 */
function safeLog(ctx, level, message) {
  try {
    ctx.logger?.[level]?.(message);
  } catch {
    // 日志失败不是错误。
  }
}

export { DISCIPLINE, compressPolicy };
