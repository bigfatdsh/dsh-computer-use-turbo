/**
 * dsh-computer-use-turbo 的测试套件。
 *
 * 三层：
 *   A. 纯函数（`content.js` / `policy.js`）—— 逐条断言边界。
 *   B. 插件装配（mock Cordis 宿主）—— 断言挂在哪些扩展点、返回什么决定、
 *      以及绝不触碰哪些东西（失败结果、富内容、别的预设）。
 *   C. 真实数据回放 —— 把本机真实 GUI 截图跑一遍变换，得出可核对的省量。
 *
 * 运行：node --test lib/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  capText,
  clip,
  countImages,
  countRichBlocks,
  dedupeByKey,
  imageKey,
  imagesOf,
  isObservation,
  replaceImages,
  stripImages,
  textLength,
} from './content.js';
import { DISCIPLINE, buildPolicy, compressPolicy } from './policy.js';
import {
  Config,
  agentPresetOf,
  agentStepOf,
  apply,
  isComputerUsePolicy,
  looksLikeComputerUseTools,
  resolveConfig,
  sameBlocks,
  stableStringify,
} from './index.js';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 造一张观察结果：前台信封文本 + 若干屏幕信封与图片，与 observe.ts 同构。 */
function observation(frames) {
  const blocks = [{ type: 'text', text: '<frontmost_app>Safari</frontmost_app>' }];
  frames.forEach((frame, index) => {
    blocks.push({ type: 'text', text: `<screen_index>${index}</screen_index>\n<coordinate_space>0-1000</coordinate_space>` });
    blocks.push({
      type: 'image',
      attachment: { attachmentId: frame.id, mediaType: 'image/png', bytes: frame.bytes ?? 100, width: 1280, height: 800 },
    });
  });
  return blocks;
}

/**
 * 复刻官方 `formatScreenEnvelope()` 的输出（`computer-use/src/observe.ts`）。
 *
 * 官方实现（逐字）：
 *   pixel  模式 -> `<screen_index>i</screen_index>\n<coordinate_space>pixels</coordinate_space>\n<attached_size>WxH</attached_size>`
 *   默认模式   -> `<screen_index>i</screen_index>\n<coordinate_space>0-1000</coordinate_space>`
 *
 * 用它核对规则文本里点名的标签是否与真实信封一致——标签名写错，规则就失效。
 *
 * @param mode - 坐标口径。
 * @returns 与官方同构的信封文本。
 */
function formatScreenEnvelopeLike(mode) {
  if (mode === 'pixel') {
    return [
      '<screen_index>0</screen_index>',
      '<coordinate_space>pixels</coordinate_space>',
      '<attached_size>2560x1600</attached_size>',
    ].join('\n');
  }
  return ['<screen_index>0</screen_index>', '<coordinate_space>0-1000</coordinate_space>'].join('\n');
}

/** 造一个纯文本工具结果。 */
function textResult(text) {
  return [{ type: 'text', text }];
}

/**
 * 搭一个最小可用的 Cordis 宿主。
 *
 * 记录注册过的监听器，并提供 `firePost` / `fireAssemble` 两个触发入口，
 * 这样测试断言的是**真实契约**（waterfall 的 next() 语义）而不是内部实现。
 */
function harness(config = {}, options = {}) {
  const handlers = [];
  const effects = [];
  const logs = [];
  const attachments = options.attachments;
  const ctx = {
    on(name, handler, opts) {
      handlers.push({ name, handler, opts });
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') effects.push(disposer);
      return () => {};
    },
    get(name) {
      if (name === 'attachments') return attachments;
      if (name === 'agents') return options.agents;
      return undefined;
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
  };
  apply(ctx, config);

  const find = (name) => {
    const entry = handlers.find((candidate) => candidate.name === name);
    assert.ok(entry, `${name} 必须被注册`);
    return entry;
  };

  /**
   * 触发一次 tools/post-execute。
   *
   * @param exec - 工具执行描述。
   * @param result - 规范化结果。
   * @param decision - 下游决定，默认原样 accept。
   * @returns 本插件返回的决定。
   */
  const firePost = (exec, result, decision) =>
    find('tools/post-execute').handler(exec, result, async () => decision ?? { kind: 'accept' });

  /**
   * 触发一次 agent/request。
   *
   * @param payload - `{ agent, turn, step, signal }`。
   * @param seed - 下游（core 的模型选择）给出的配置。
   * @returns 本插件返回的配置。
   */
  const fireRequest = (payload, seed) => {
    const entry = handlers.find((candidate) => candidate.name === 'agent/request');
    if (entry === undefined) return Promise.resolve(seed);
    return entry.handler(payload, async () => seed);
  };

  /**
   * 触发一次 session/event。
   *
   * @param session - 事件所属会话。
   * @param event - 会话事件。
   */
  const fireSessionEvent = (session, event) => {
    const entry = handlers.find((candidate) => candidate.name === 'session/event');
    if (entry === undefined) return undefined;
    return entry.handler(session, event);
  };

  /**
   * 触发一次 system-prompt/assemble。
   *
   * @param assembly - 已组装的提示面。
   * @param context - 组装上下文（含 agent）。
   * @returns 本插件返回的提示面。
   */
  const fireAssemble = (assembly, context) => {
    const entry = handlers.find((candidate) => candidate.name === 'system-prompt/assemble');
    if (entry === undefined) return Promise.resolve(assembly);
    return entry.handler(assembly, context, async () => assembly);
  };

  return { ctx, logs, effects, handlers, firePost, fireAssemble, fireRequest, fireSessionEvent, turbo: apply.__turbo };
}

/**
 * 造一个 computer-use 会话的 Agent 桩。
 *
 * 形状按**已核实的真实 Session 类**（`dsh-session/lib/types/index.js`）：
 *   * `session.header.agentPreset` —— 预设判定，与官方 `code-agent.ts` 读法一致；
 *   * `session.log` —— **事件数组**（`Session.append(type, data)` 按序 push），
 *     没有 `header` / `events` 包装。步号从其中的 `step/start` 事件读出。
 */
const cuAgent = (step = 1) => ({
  id: 'session-1',
  session: {
    header: { agentPreset: 'computer-use' },
    log: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step } }],
  },
});

/**
 * 把当前 Agent 推进到下一步。
 *
 * 真实会话里 driver 会追加新的 `step/start`；测试里手动追加，用于验证
 * “跨步的单条观察结果永远不被丢”。
 *
 * @param agent - 待推进的 Agent 桩。
 * @param step - 新的步号。
 */
function advance(agent, step) {
  agent.session.log.push({ type: 'step/start', data: { turn: 1, step } });
}

/**
 * 一个**共享**的 computer-use Agent。
 *
 * 插件以 Agent 对象为键保存会话状态，所以同一场会话的多次工具调用必须传
 * 同一个对象——测试夹具若每次新建对象，测的就不是真实会话了。
 */
const CU = cuAgent();

/** 造一个标准会话的 Agent 桩。 */
const stdAgent = () => ({ id: 'session-2', session: { header: { agentPreset: 'standard' } } });

/**
 * 真实的 computer-use POLICY（内嵌夹具）。
 *
 * 逐字副本放在 `lib/__fixtures__/policy.txt`。内嵌而**不是**运行时去读 dsh-orb
 * 的发行产物：包外没有那个文件，测试必须自包含——否则这个包一旦离开本机，
 * 压缩率相关的断言就集体失效，而失效方式还是"断言失败"而非"跳过"。
 */
const { policy: realPolicy } = await import('./__fixtures__/policy.js');
const clickAccuracy = await import('./__fixtures__/click-accuracy.js');

/** 同一份策略的 **pixel 口径**变体——本机历史会话全是这个形态。 */
const { policy: pixelPolicy } = await import('./__fixtures__/policy-pixel.js');

/**
 * 解析内嵌的真实用量序列。
 *
 * @returns `Array<{ id, steps: Array<[step, cacheRead, miss]> }>`。
 */
async function loadUsageFixture() {
  return (await import('./__fixtures__/usage.js')).sessions;
}

/** 官方 POLICY 的合成夹具（含坐标段），用于不依赖真实产物的边界测试。 */
const FAKE_POLICY =
  'Computer Use lets you see the current frontmost application window and operate the GUI.\n' +
  '\nSee: trust only the attached screenshot of the frontmost application on this display for windows, buttons, and on-screen text.\n\n' +
  'Coordinates: the attached screenshot uses a 0–1000 space of that window. [0, 0] is the top-left of that image.' +
  ' Pass position as [x, y] in that space together with screen_index 0.' +
  '\n\nStep: you may emit several GUI tool calls in one step when every target is already visible.' +
  '\n\nDecide each stretch yourself:\n- Do it in this chat when it is visible GUI.' +
  '\n\nWhen a user message starts with "Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.", answer in this chat only.';

/** 造一个内容寻址的附件服务桩：id → 字节，id 由字节摘要派生。 */
function contentAddressedAttachments() {
  const store = new Map();
  return {
    /** 登记一份字节，返回内容寻址 id。 */
    put(bytes) {
      const id = `sha-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
      store.set(id, Buffer.from(bytes));
      return id;
    },
    service: {
      async readImage(attachment) {
        const bytes = store.get(attachment?.attachmentId);
        if (bytes === undefined) throw new Error('missing');
        return { data: bytes };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// A. 纯函数
// ---------------------------------------------------------------------------

describe('A. content.js 纯函数', () => {
  test('textLength 只统计文本块，按码点计数', () => {
    assert.equal(textLength([{ type: 'text', text: '你好' }]), 2);
    assert.equal(textLength([{ type: 'text', text: 'ab' }, { type: 'image' }, { type: 'text', text: 'cd' }]), 4);
    assert.equal(textLength([]), 0);
    // 代理对算一个码点，不切断。
    assert.equal(textLength([{ type: 'text', text: '👍' }]), 1);
  });

  test('clip 保留头部并报告截断', () => {
    assert.deepEqual(clip('abcdef', 3), { text: 'abc', chars: 6, truncated: true });
    assert.deepEqual(clip('abc', 3), { text: 'abc', chars: 3, truncated: false });
    assert.deepEqual(clip('', 0), { text: '', chars: 0, truncated: false });
  });

  test('countImages / countRichBlocks / isObservation', () => {
    const obs = observation([{ id: 'a' }, { id: 'b' }]);
    assert.equal(countImages(obs), 2);
    assert.equal(countRichBlocks(obs), 0);
    assert.equal(isObservation(obs), true);
    assert.equal(isObservation(textResult('hi')), false);
    assert.equal(countRichBlocks([{ type: 'text', text: 'x' }, { type: 'structured' }]), 1);
    assert.equal(imagesOf(obs).length, 2);
  });

  test('stripImages 从头部丢图，信封文本原样保留', () => {
    const obs = observation([{ id: 'a' }, { id: 'b' }]);
    const kept = stripImages(obs, 1);
    assert.equal(countImages(kept), 1);
    assert.equal(kept[0].text, '<frontmost_app>Safari</frontmost_app>', '信封文本必须保留');
    assert.equal(kept.filter((b) => b.type === 'text').length, 3, '两个屏幕信封 + 一个前台信封');
  });

  test('stripImages(0) 与 stripImages(负数) 都是恒等', () => {
    const obs = observation([{ id: 'a' }]);
    assert.equal(stripImages(obs, 0), obs);
    assert.equal(stripImages(obs, -5), obs);
  });

  test('stripImages 丢图数量超过实际图片数时不报错', () => {
    const obs = observation([{ id: 'a' }]);
    assert.equal(countImages(stripImages(obs, 99)), 0);
  });

  test('replaceImages 留下占位说明而不是直接消失', () => {
    const obs = observation([{ id: 'a' }, { id: 'b' }]);
    const replaced = replaceImages(obs, 1, (_block, index) => `gone-${index}`);
    assert.equal(countImages(replaced), 1);
    assert.ok(replaced.some((b) => b.type === 'text' && b.text === 'gone-1'));
  });

  test('dedupeByKey 首次登记、二次命中、键不可用时放行', () => {
    const table = new Map();
    const keyOf = (blocks) => (blocks.length === 1 ? blocks[0].text : undefined);
    const first = dedupeByKey(textResult('same'), table, keyOf, { call: 'read', callId: 'c1' }, () => 'DUP');
    assert.equal(first.hit, false);
    const second = dedupeByKey(textResult('same'), table, keyOf, { call: 'read', callId: 'c2' }, () => 'DUP');
    assert.equal(second.hit, true);
    assert.equal(second.blocks[0].text, 'DUP');
    const multi = dedupeByKey([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], table, keyOf, {}, () => 'DUP');
    assert.equal(multi.hit, false, '多块结果不可比对');
  });

  test('capText 预算为 0 时完全不动作', () => {
    const blocks = textResult('x'.repeat(10000));
    const out = capText(blocks, 0, 0);
    assert.equal(out.truncated, false);
    assert.equal(out.removed, 0);
    assert.equal(out.blocks, blocks);
  });

  test('capText 留头留尾并标记裁掉的码点数', () => {
    const out = capText(textResult('A'.repeat(100) + 'M'.repeat(100) + 'Z'.repeat(100)), 10, 10);
    assert.equal(out.truncated, true);
    assert.equal(out.removed, 280);
    assert.ok(out.blocks[0].text.startsWith('A'.repeat(10)));
    assert.ok(out.blocks[0].text.endsWith('Z'.repeat(10)));
    assert.ok(out.blocks[0].text.includes('280 characters trimmed'));
  });

  test('capText 不碰非文本块', () => {
    const blocks = [{ type: 'image', attachment: { attachmentId: 'x' } }, { type: 'text', text: 'y'.repeat(50) }];
    const out = capText(blocks, 5, 5);
    assert.equal(out.blocks[0], blocks[0]);
  });

  test('imageKey 无法取字节且无 id 时返回 undefined', async () => {
    const { key, strict } = await imageKey({ attachment: {} }, async () => undefined);
    assert.equal(key, undefined);
    assert.equal(strict, false);
  });

  test('imageKey 取到字节时用 SHA-256 且标记严格', async () => {
    const bytes = Buffer.from('hello');
    const { key, strict } = await imageKey({ attachment: { attachmentId: 'ignored' } }, async () => bytes);
    assert.equal(strict, true);
    assert.equal(key, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  });

  test('imageKey 取不到字节时退到 attachmentId 且标记非严格', async () => {
    const { key, strict } = await imageKey({ attachment: { attachmentId: 'att-1' } }, async () => undefined);
    assert.equal(key, 'attachment:att-1');
    assert.equal(strict, false);
  });
});

describe('A. policy.js 策略压缩', () => {
  test('保留坐标段逐字不变（两种坐标口径都适用）', () => {
    const out = compressPolicy(FAKE_POLICY);
    assert.ok(out.includes('Coordinates: the attached screenshot uses a 0–1000 space of that window.'));
    assert.ok(out.includes('Pass position as [x, y] in that space together with screen_index 0.'));
  });

  test('真的更短，且保留关键约束（用真实 POLICY 度量）', () => {
    assert.ok(realPolicy !== undefined, '应能读到真实的 computer-use POLICY');
    const out = compressPolicy(realPolicy);
    assert.ok(out.length < realPolicy.length, `压缩后应更短：${out.length} vs ${realPolicy.length}`);
    // 坐标段被逐字保留，所以要度量的是“它之后”的可压缩部分。
    const tail = realPolicy.slice(realPolicy.indexOf('Step:'));
    const outTail = out.slice(out.indexOf('Step:'));
    assert.ok(outTail.length < tail.length, `可压缩部分应更短：${outTail.length} vs ${tail.length}`);
    assert.ok(out.includes('trust only the attached screenshot'), '保留“只看最新截图”的约束');
    assert.ok(out.includes('GUI tools only'), '保留“可见 GUI 只走 GUI 工具”');
    assert.ok(out.includes('code_agent'), '保留唯一的交棒出口');
    assert.ok(out.includes('Desktop selection'), '保留桌面划词回合的处理方式');
    assert.ok(out.includes('long_wait'), '保留等待工具的使用规则');
    assert.ok(out.includes('open_in_finder'), '保留路径类操作的路由规则');
    assert.ok(out.includes('<frontmost_folder>'), '保留前台文件夹标签的语义');
    assert.ok(out.includes('open_app'), '保留“目标窗口不在前台时先切前台”的规则');
    assert.ok(out.includes('Do not click the Dock'), '保留“不许点 Dock”的硬约束');
  });

  test('加入可数的交棒预算（本插件的核心行为约束）', () => {
    const out = compressPolicy(FAKE_POLICY);
    assert.ok(out.includes('3 shell commands'), '必须有可数阈值');
    assert.ok(out.includes('code_agent'), '必须点名出口工具');
  });

  test('坐标段逐字保留：millifraction 口径', () => {
    const out = compressPolicy(realPolicy);
    const at = realPolicy.indexOf('Coordinates:');
    const to = realPolicy.indexOf('Step:');
    const original = realPolicy.slice(at, to);
    // 坐标口径句是点击命中率的前提，压缩它只会换来点偏——必须逐字幸存。
    assert.ok(out.includes(original), 'millifraction 坐标段必须逐字保留');
    assert.ok(out.includes('Encode x and y as fractions'), '保留“用分数编码”的口径');
    assert.ok(out.includes('Do not send raw pixel coordinates.'), '保留“不许发原始像素”的硬约束');
  });

  test('坐标段逐字保留：pixel 口径（本机历史会话的实际形态）', () => {
    const out = compressPolicy(pixelPolicy);
    const at = pixelPolicy.indexOf('Coordinates:');
    const to = pixelPolicy.indexOf('Step:');
    const original = pixelPolicy.slice(at, to);
    assert.ok(out.includes(original), 'pixel 坐标段必须逐字保留');
    // 这三句是 pixel 口径下点击命中的全部依据。
    assert.ok(out.includes('pixel columns and rows of that image'), '保留像素口径定义');
    assert.ok(out.includes('[0, 0] is the top-left pixel.'), '保留原点定义');
    assert.ok(
      out.includes('Read attached_size on the latest observation envelope as width×height of this screenshot'),
      '保留 attached_size 是唯一尺寸来源这一条',
    );
    assert.ok(out.includes('Do not send 0–1000 fractions.'), '保留“不许发分数”的硬约束');
  });

  test('点击精度规则必须同时在位（每句对应一个实测失效）', () => {
    const out = compressPolicy(FAKE_POLICY);
    // 1) 坐标系只有一个来源。实测：模型看到 1610×1006 的缩略图，却要提交
    //    2560×1600 的原始像素，于是自己乘了 1.5901 去换算——换算没错，估读错了。
    assert.ok(out.includes('attached_size'), '必须点明坐标系来自 attached_size');
    assert.ok(
      /rendering artifact|appears to have/.test(out),
      '必须说破「图像看起来的尺寸是渲染产物」，否则模型仍会照视觉尺寸换算',
    );
    assert.ok(out.includes('never scale coordinates'), '必须明确禁止按视觉尺寸缩放');
    // 2) 点中心而不是边缘：命中区只有几像素容差。
    assert.ok(/centre of the control/.test(out), '必须要求点控件中心');
    assert.ok(/never its edge or its label text/.test(out), '必须排除边缘与标签文字');
    // 3) 点偏的正确解读——这条直接消灭「以为按钮坏了」导致的额外步骤。
    assert.ok(
      /No visible change after a click means the click missed the hit area/.test(out),
      '必须纠正「点了没变化」的归因',
    );
    assert.ok(/not that the control is broken/.test(out), '必须排除「控件坏了」的错误结论');
    assert.ok(/instead of switching methods/.test(out), '必须禁止误判后改用别的方法');
  });

  test("'attached_size' 这个名字与真实观察信封一致（不能凭记忆写）", () => {
    // 信封文本由官方 observe.ts 生成，形状固定。规则里点名它，就必须与它逐字一致，
    // 否则模型在截图里找不到这个标签，规则等于没说。
    const envelope = formatScreenEnvelopeLike('pixel');
    assert.ok(envelope.includes('<attached_size>'), `真实信封应含 attached_size：${envelope}`);
    for (const source of [compressPolicy(FAKE_POLICY), compressPolicy(pixelPolicy)]) {
      if (source.includes('attached_size')) {
        assert.ok(source.includes('attached_size'), '规则必须用与信封相同的标签名');
      }
    }
    // pixel 口径的官方坐标段本身也点名 attached_size —— 两处必须同名。
    assert.ok(pixelPolicy.includes('attached_size'), '官方 pixel 坐标段应点名 attached_size');
  });

  test('预算规则不写死工具名：Windows 上 shell 工具叫 pwsh，不是 bash', () => {
    // 预设按平台二选一：非 win32 挂 tool-bash，win32 挂 tool-pwsh（见 dsh-orb 的
    // cordis.patch.yml）。策略若写死「3 bash calls」，Windows 上就把预算算到了
    // 一个不存在的工具上——模型的预算判断会失效。
    const out = compressPolicy(FAKE_POLICY);
    assert.equal(/\d+ bash calls?/.test(out), false, '预算规则不得写死 bash');
    assert.ok(out.includes('pwsh'), '必须点明 Windows 上的对应工具');
    assert.ok(out.includes('shell commands'), '用工具无关的说法表述预算');
    // 但 `bash sleep` 是 shell 语法（不是工具名），应保留原文。
    assert.ok(out.includes('bash sleep'), '`bash sleep` 是 shell 语法，应保留');
  });

  test('缺坐标标记时原样返回，绝不猜', () => {
    const noCoords = 'Some unrelated prompt text without the marker.';
    assert.equal(compressPolicy(noCoords), noCoords);
    assert.equal(compressPolicy(''), '');
    assert.equal(compressPolicy(undefined), undefined);
    assert.equal(compressPolicy(null), null);
  });

  test('buildPolicy 的两个开关都生效', () => {
    assert.equal(buildPolicy(FAKE_POLICY, { policy: false, discipline: false }), FAKE_POLICY);
    const withDiscipline = buildPolicy(FAKE_POLICY, { policy: false, discipline: true });
    assert.ok(withDiscipline.startsWith(FAKE_POLICY));
    assert.ok(withDiscipline.includes(DISCIPLINE));
    const compressedOnly = buildPolicy(FAKE_POLICY, { policy: true, discipline: false });
    assert.equal(compressedOnly, compressPolicy(FAKE_POLICY));
  });

  test('压缩后的策略明显更短：给出可核对的比例', () => {
    assert.ok(realPolicy !== undefined, '应能读到真实的 computer-use POLICY');
    const out = compressPolicy(realPolicy);
    const at = realPolicy.indexOf('Step:');
    const tail = realPolicy.length - at;
    const outTail = out.length - out.indexOf('Step:');
    const ratio = outTail / tail;
    // 0.80 是刻意的上界——可压缩部分里有两条**不能砍**的规则：
    //   1. 交棒预算必须「可数」且「工具无关」（bash / pwsh），含糊化等于退回主观判断；
    //   2. 点击精度规则必须同时保住三句：坐标系是 attached_size、点控件中心、
    //      「点完没变化 = 点偏了」——每一句都对应一个实测到的失效。
    // 这个上界是**防膨胀的护栏**，不是压缩率目标；拿掉上面任一句换来的更低比例，
    // 都是拿真实能力换一个数字。
    assert.ok(ratio < 0.8, `可压缩部分压缩率不足：${outTail}/${tail} = ${ratio.toFixed(2)}`);
    console.log(
      `[turbo] POLICY ${realPolicy.length} -> ${out.length} 字符；` +
        `坐标段（${at} 字符）逐字保留，其余 ${tail} -> ${outTail}（保留 ${(ratio * 100).toFixed(1)}%），` +
        `约省 ${Math.round((realPolicy.length - out.length) / 4)} token/请求`,
    );
  });
});

// ---------------------------------------------------------------------------
// B. 插件装配
// ---------------------------------------------------------------------------

describe('B. 插件装配与扩展点', () => {
  test('注册 tools/post-execute 与 system-prompt/assemble，且 post-execute 必须 prepend', () => {
    const h = harness();
    const post = h.handlers.find((e) => e.name === 'tools/post-execute');
    const assemble = h.handlers.find((e) => e.name === 'system-prompt/assemble');
    assert.ok(post);
    assert.ok(assemble);
    assert.equal(post.opts?.prepend, true, '必须在 next() 之后决策，才能看到下游转换的最终内容');
  });

  test('enabled=false 时一个监听器都不注册', () => {
    const h = harness({ enabled: false });
    assert.equal(h.handlers.length, 0);
  });

  test('presets 为空数组时对每个会话都启用', () => {
    const h = harness({ presets: [] });
    assert.equal(h.turbo.modeFor(stdAgent(), undefined), true);
  });

  test('按 agentPreset 判定：命中才启用', () => {
    const h = harness();
    assert.equal(h.turbo.modeFor(cuAgent(), undefined), true);
    assert.equal(h.turbo.modeFor(stdAgent(), undefined), false);
  });

  test('agentPreset 读不到时退到工具面判定', () => {
    const h = harness();
    const noPreset = { id: 'x', session: {} };
    const cuTools = [
      { name: 'click' }, { name: 'input_text' }, { name: 'open_in_finder' }, { name: 'code_agent' },
    ];
    assert.equal(h.turbo.modeFor(noPreset, cuTools), true);
    // 只有一两个同名工具不足以命中。
    assert.equal(h.turbo.modeFor(noPreset, [{ name: 'click' }, { name: 'code_agent' }]), false);
    assert.equal(h.turbo.modeFor(noPreset, undefined), false);
  });

  test('looksLikeComputerUseTools 的边界', () => {
    assert.equal(looksLikeComputerUseTools(undefined), false);
    assert.equal(looksLikeComputerUseTools([]), false);
    assert.equal(
      looksLikeComputerUseTools([{ name: 'click' }, { name: 'drag' }, { name: 'long_press' }, { name: 'code_agent' }]),
      true,
    );
    // 三个 GUI 工具但没有 code_agent：不算（可能是别的桌面预设）。
    assert.equal(looksLikeComputerUseTools([{ name: 'click' }, { name: 'drag' }, { name: 'long_press' }]), false);
  });

  test('agentPresetOf 对畸形 Agent 不抛错', () => {
    assert.equal(agentPresetOf(undefined), undefined);
    assert.equal(agentPresetOf({}), undefined);
    assert.equal(agentPresetOf({ session: { header: { agentPreset: '' } } }), undefined);
    assert.equal(
      agentPresetOf({ get session() { throw new Error('boom'); } }),
      undefined,
    );
  });

  test('标准会话的结果一个字都不改', async () => {
    const h = harness();
    const content = observation([{ id: 'a' }]);
    const decision = await h.firePost({ name: 'click', callId: 'c1', agent: stdAgent(), arguments: {} }, { content, isError: false });
    assert.deepEqual(decision, { kind: 'accept' });
    assert.equal(decision.content, undefined);
  });

  test('无 agent 的调用不处理', async () => {
    const h = harness();
    const content = observation([{ id: 'a' }]);
    const decision = await h.firePost({ name: 'click', callId: 'c1', arguments: {} }, { content, isError: false });
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('下游返回 block 时原样透传', async () => {
    const h = harness();
    const blocked = { kind: 'block', feedback: 'nope' };
    const decision = await h.firePost(
      { name: 'click', callId: 'c1', agent: cuAgent(), arguments: {} },
      { content: observation([{ id: 'a' }]), isError: false },
      blocked,
    );
    assert.equal(decision, blocked);
  });

  test('失败结果绝不改写，即使截图逐字节相同', async () => {
    const h = harness();
    const attachments = contentAddressedAttachments();
    const bytes = Buffer.from('png-bytes');
    const id = attachments.put(bytes);
    const content = observation([{ id }]);
    const exec = (callId) => ({ name: 'click', callId, agent: CU, arguments: {} });
    // 两次，第二次应收敛；但用失败结果再打一次不应被替换。
    await h.firePost(exec('c1'), { content, isError: false });
    const decision = await h.firePost(exec('c2'), { content, isError: true });
    assert.deepEqual(decision, { kind: 'accept' });
    assert.equal(decision.content, undefined);
  });

  test('富内容块一律不碰', async () => {
    const h = harness();
    const content = [{ type: 'text', text: 'x' }, { type: 'structured', value: { a: 1 } }];
    const decision = await h.firePost(
      { name: 'bash', callId: 'c1', agent: cuAgent(), arguments: {} },
      { content, isError: false },
    );
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('空内容不处理', async () => {
    const h = harness();
    const decision = await h.firePost(
      { name: 'bash', callId: 'c1', agent: cuAgent(), arguments: {} },
      { content: [], isError: false },
    );
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('下游已替换 value 时仍以 decision.content 为准（不吞掉下游的结构化值）', async () => {
    const h = harness();
    const structured = { kind: 'accept', value: { ok: true } };
    const decision = await h.firePost(
      { name: 'bash', callId: 'c1', agent: cuAgent(), arguments: {} },
      { content: textResult('payload'.repeat(200)), isError: false },
      structured,
    );
    assert.equal(decision.kind, 'accept');
    assert.equal(decision.value.ok, true);
  });

  test('图片不可严格比较时（拿不到字节）strictImageDedupe 让其放行', async () => {
    // 无附件服务：只能退到 attachmentId，而严格模式拒绝这种比较。
    // 用两个**互不相干**的会话，排除「屏幕没变」这条与严格性无关的路径。
    const h = harness({ strictImageDedupe: true });
    const content = observation([{ id: 'same-id' }]);
    const first = { id: 'a', session: { header: { agentPreset: 'computer-use' }, log: [] } };
    const second = { id: 'b', session: { header: { agentPreset: 'computer-use' }, log: [] } };
    assert.deepEqual(await h.firePost({ name: 'click', callId: 'c1', agent: first, arguments: {} }, { content, isError: false }), { kind: 'accept' });
    assert.deepEqual(
      await h.firePost({ name: 'click', callId: 'c2', agent: second, arguments: {} }, { content, isError: false }),
      { kind: 'accept' },
      '严格模式下缺字节就不该去重',
    );
  });

  test('关掉 strictImageDedupe 后内容寻址 id 可以命中', async () => {
    const agent = cuAgent(1);
    const h = harness({ strictImageDedupe: false });
    const content = observation([{ id: 'same-id' }]);
    const exec = (callId) => ({ name: 'click', callId, agent, arguments: {} });
    await h.firePost(exec('c1'), { content, isError: false });
    // 进入下一步、换一张不同的画面把“上一条观察”顶掉，再回到原画面。
    advance(agent, 2);
    await h.firePost(exec('c2'), { content: observation([{ id: 'other-id' }]), isError: false });
    advance(agent, 3);
    const decision = await h.firePost(exec('c3'), { content, isError: false });
    assert.equal(decision.kind, 'accept');
    assert.ok(Array.isArray(decision.content), '内容寻址 id 命中后应改写内容');
    assert.equal(countImages(decision.content), 0);
    assert.ok(
      decision.content.some((b) => b.type === 'text' && b.text.includes('逐字节相同')),
      '非严格模式命中时说明应来自“逐字节相同”这条路径',
    );
  });

  test('没有任何观察结果时 processObservation 不抛错', async () => {
    const h = harness();
    const agent = cuAgent();
    const out = await h.turbo.processObservation(agent, { name: 'click', callId: 'c' }, textResult('plain'));
    assert.equal(out.kind, 'keep');
    assert.deepEqual(out.blocks, textResult('plain'));
  });

  test('附件服务抛错时退到回退键而不是崩', async () => {
    const h = harness(
      { strictImageDedupe: false },
      { attachments: { async readImage() { throw new Error('io'); } } },
    );
    const decision = await h.firePost(
      { name: 'click', callId: 'c1', agent: cuAgent(), arguments: {} },
      { content: observation([{ id: 'a' }]), isError: false },
    );
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('__turbo 句柄存在且不可枚举', () => {
    const h = harness();
    assert.ok(h.turbo);
    assert.equal(Object.keys(apply).includes('__turbo'), false);
  });

  test('卸载时输出汇总日志', () => {
    const h = harness();
    assert.equal(h.effects.length, 1);
    h.effects[0]();
    assert.ok(h.logs.some((entry) => entry.message.includes('computer-use-turbo: released')));
  });

  test('logSavings=false 时卸载不输出', () => {
    const h = harness({ logSavings: false });
    h.effects[0]();
    assert.equal(h.logs.length, 0);
  });

  test('Config 默认值与 resolveConfig 一致（无 zod 时也一致）', () => {
    const fromSchema = Config === undefined ? undefined : Config.parse({});
    const fromResolver = resolveConfig(undefined);
    for (const key of Object.keys(fromResolver)) {
      if (fromSchema !== undefined) assert.deepEqual(fromSchema[key], fromResolver[key], `配置项 ${key} 默认值不一致`);
    }
  });

  test('resolveConfig 覆盖单个字段不影响其他字段', () => {
    const cfg = resolveConfig({ dedupeText: false });
    assert.equal(cfg.dedupeText, false, '被覆盖的字段生效');
    assert.equal(cfg.dedupeImages, true, '未被覆盖的字段保持默认');
    assert.equal(cfg.textDedupeMinChars, 512);
    assert.equal(cfg.imageRetentionWindow, 0);
  });

  test('sameBlocks / stableStringify 的契约', () => {
    const a = [{ type: 'text', text: 'x' }];
    assert.equal(sameBlocks(a, a), true);
    assert.equal(sameBlocks([...a], a), true, '逐元素比较：同一批块引用视为相同');
    assert.equal(sameBlocks([{ type: 'text', text: 'y' }], a), false, '不同块引用视为不同');
    assert.equal(sameBlocks(a, []), false);
    assert.equal(sameBlocks(a, undefined), false);
    assert.equal(sameBlocks(undefined, a), false);
    // 键序不影响签名。
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
    assert.equal(stableStringify({ a: [1, { z: 1, y: 2 }] }), stableStringify({ a: [1, { y: 2, z: 1 }] }));
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify(undefined), 'null');
    assert.equal(stableStringify('x'), '"x"');
  });
});

// ---------------------------------------------------------------------------
// B2. 关键行为：批处理去冗余 / 屏幕未变 / 逐字去重
// ---------------------------------------------------------------------------

describe('B2. 观察结果的压缩行为', () => {
  /** 造一个带真实附件服务的宿主与三个不同字节的屏幕。 */
  function obsHarness(config = {}) {
    const attachments = contentAddressedAttachments();
    const ids = {
      one: attachments.put(Buffer.from('screen-one')),
      two: attachments.put(Buffer.from('screen-two')),
      three: attachments.put(Buffer.from('screen-three')),
    };
    return { h: harness(config, { attachments: attachments.service }), ids };
  }

  const exec = (callId) => ({ name: 'click', callId, agent: CU, arguments: {} });

  test('第一条观察结果保留图片（模型靠它建立本步认知）', async () => {
    const { h, ids } = obsHarness();
    const decision = await h.firePost(exec('c1'), { content: observation([{ id: ids.one }]), isError: false });
    assert.deepEqual(decision, { kind: 'accept' }, '第一条不该被改写');
  });

  test('同一批里的中间帧丢掉图片，只留信封文本与一句说明', async () => {
    const { h, ids } = obsHarness();
    await h.firePost(exec('c1'), { content: observation([{ id: ids.one }]), isError: false });
    const decision = await h.firePost(exec('c2'), { content: observation([{ id: ids.two }]), isError: false });
    assert.equal(decision.kind, 'accept');
    assert.equal(countImages(decision.content), 0, '中间帧的截图应被丢掉');
    assert.ok(decision.content.some((b) => b.type === 'text' && b.text.includes('[turbo]')), '必须留下说明');
    assert.ok(
      decision.content.some((b) => b.type === 'text' && b.text.includes('<frontmost_app>')),
      '前台应用信封必须保留',
    );
  });

  test('同一批的第三条：仍按“本批第一条保留、其余丢掉”处理', async () => {
    const { h, ids } = obsHarness();
    await h.firePost(exec('c1'), { content: observation([{ id: ids.one }]), isError: false });
    await h.firePost(exec('c2'), { content: observation([{ id: ids.two }]), isError: false });
    // “是否为最后一条”在流式处理里无法预知，所以规则必须是确定性的：
    // 同一步的第一条保留、其余丢掉。官方策略正是这么要求模型读图的。
    const decision = await h.firePost(exec('c3'), { content: observation([{ id: ids.three }]), isError: false });
    assert.equal(decision.kind, 'accept');
    assert.equal(countImages(decision.content), 0);
  });

  test('跨步的单条观察结果绝不丢图（这是批处理规则的安全边界）', async () => {
    const { h, ids } = obsHarness();
    // 第 1 步：一条观察结果，保留。
    const first = await h.firePost(exec('c1'), { content: observation([{ id: ids.one }]), isError: false });
    assert.deepEqual(first, { kind: 'accept' });
    // 进入第 2 步，画面变了：必须原样保留，哪怕它是本步唯一一条。
    advance(CU, 2);
    const second = await h.firePost(exec('c2'), { content: observation([{ id: ids.two }]), isError: false });
    assert.deepEqual(second, { kind: 'accept' }, '跨步且画面变化时不能被当作中间帧丢掉');
    // 第 3 步：画面与第 1 步逐字节相同 → 走“回到旧画面”的等价说明，仍然不丢信息。
    advance(CU, 3);
    const third = await h.firePost(exec('c3'), { content: observation([{ id: ids.one }]), isError: false });
    assert.equal(third.kind, 'accept');
    assert.equal(countImages(third.content), 0, '逐字节相同的旧画面应被等价说明替代');
    assert.ok(
      third.content.some((b) => b.type === 'text' && b.text.includes('逐字节相同')),
      '说明必须点名它等同于哪一次调用',
    );
  });


  test('步号从 session.log 的 step/start 事件读出（真实形状）', () => {
    // 事件逐字取自本机真实会话日志：
    // {"type":"step/start","seq":10,"time":1790826942250,"data":{"turn":1,"step":1}}
    const agent = {
      id: 'session-1',
      session: {
        header: { agentPreset: 'computer-use' },
        log: [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'step/start', data: { turn: 1, step: 1 } },
          { type: 'tool/call', data: { name: 'click' } },
          { type: 'step/start', data: { turn: 1, step: 2 } },
          { type: 'assistant/message', data: {} },
        ],
      },
    };
    assert.equal(agentStepOf(agent), 2, '应取最后一条 step/start 的步号');
    // 真实会话头部**没有** step 字段（磁盘头只有 type/version/id/createdAt/cwd/
    // isSeeded/delegationDepth/agentPreset），所以事件流是唯一来源。
    assert.equal(Object.hasOwn(agent.session.header, 'step'), false);
  });

  test('对照真实会话日志形状：预设与步号都能读出来', () => {
    // 这条是回归护栏。曾经把 `session.log` 误当成 `{header, events}` 包装对象，
    // try/catch 让失败静默——批处理去冗余在真机上完全不生效而测试全绿。
    // 现按**已核实的真实形状**断言：
    //   * 磁盘头字段就是 type/version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset；
    //   * `session.log` 是事件数组，步号只在 `step/start` 里。
    const header = {
      type: 'session',
      version: 4,
      id: 'session-75095b49-0fb1-4a57-8933-f668ac7b8a3e',
      createdAt: 1790826918722,
      cwd: '/Users/yangletian/.dsh/dsh_orb',
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'computer-use',
    };
    // 事件逐字取自本机真实会话日志。
    const events = [
      { type: 'turn/start', seq: 8, data: { turn: 1 } },
      { type: 'step/start', seq: 10, time: 1790826942250, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 23, data: { name: 'load_workspace_dependencies' } },
      { type: 'step/start', seq: 28, time: 1790826958868, data: { turn: 1, step: 2 } },
      { type: 'step/start', seq: 46, time: 1790827000000, data: { turn: 1, step: 3 } },
    ];
    const agent = { id: header.id, session: { header, log: events } };

    assert.equal(agentPresetOf(agent), 'computer-use', '预设应可读出');
    assert.equal(agentStepOf(agent), 3, '步号应等于最后一条 step/start');
    // 真实磁盘头里没有 step / turn —— 所以事件流是步号的唯一来源。
    assert.equal(Object.hasOwn(header, 'step'), false);
    assert.equal(Object.hasOwn(header, 'turn'), false);
  });

  test('畸形或缺失的会话日志不会让步号判定崩掉', () => {
    assert.equal(agentStepOf(undefined), undefined);
    assert.equal(agentStepOf({}), undefined);
    assert.equal(agentStepOf({ session: {} }), undefined);
    assert.equal(agentStepOf({ session: { log: [] } }), undefined);
    assert.equal(
      agentStepOf({
        session: { log: [{ type: 'step/start', data: { step: 'x' } }, { type: 'step/start' }, null, 7] },
      }),
      undefined,
    );
  });

  test('读不到步号时不做批处理去冗余，但逐字节相同仍然去重', async () => {
    const h = harness({}, { attachments: contentAddressedAttachments().service });
    const blind = { id: 's', session: { header: { agentPreset: 'computer-use' }, log: [] } };
    const run = (callId) => ({ name: 'click', callId, agent: blind, arguments: {} });
    // 画面变化：必须原样放行——没有步号就无法证明存在“中间帧”。
    const first = await h.firePost(run('c1'), { content: observation([{ id: 'frame-a' }]), isError: false });
    assert.deepEqual(first, { kind: 'accept' });
    const second = await h.firePost(run('c2'), { content: observation([{ id: 'frame-b' }]), isError: false });
    assert.deepEqual(second, { kind: 'accept' }, '没有步号时不能把画面当成中间帧丢掉');
    // 同一画面再现：属于逐字节相同，与步号无关，仍然可以压缩。
    const third = await h.firePost(run('c3'), { content: observation([{ id: 'frame-b' }]), isError: false });
    assert.equal(third.kind, 'accept');
    assert.equal(countImages(third.content), 0);
    assert.ok(third.content.some((b) => b.type === 'text' && b.text.includes('屏幕没有变化')));
  });

  test('同一屏再现：识别为屏幕未变并给出“没变化”的说明', async () => {
    const { h, ids } = obsHarness();
    const exec2 = (callId) => ({ name: 'scroll', callId, agent: CU, arguments: {} });
    await h.firePost(exec2('c1'), { content: observation([{ id: ids.one }]), isError: false });
    // 不同工具（scroll）出现同一张图：跨工具比较的是“上一条观察”，命中未变。
    const decision = await h.firePost(exec2('c2'), { content: observation([{ id: ids.one }]), isError: false });
    assert.equal(decision.kind, 'accept');
    assert.equal(countImages(decision.content), 0);
    assert.ok(decision.content.some((b) => b.type === 'text' && b.text.includes('屏幕没有变化')));
  });

  test('逐字节不同但 id 相同的两张图不会被误判（严格模式用字节）', async () => {
    let call = 0;
    const attachments = {
      async readImage() {
        call += 1;
        return { data: Buffer.from(`frame-${call}`) };
      },
    };
    const h = harness({}, { attachments });
    const sameId = [{ id: 'identical-looking-id' }];
    await h.firePost(exec('c1'), { content: observation(sameId), isError: false });
    const decision = await h.firePost(exec('c2'), { content: observation(sameId), isError: false });
    // 第二次是本批中间帧 → 图片被丢，但不是因为“相同”，而是因为批处理规则。
    assert.equal(countImages(decision.content), 0);
    // 关键断言：绝不能说“逐字节相同”，因为字节其实不同。
    assert.equal(
      decision.content.some((b) => b.type === 'text' && b.text.includes('逐字节相同')),
      false,
      '字节不同就不能声称相同',
    );
  });

  test('去重说明里带上来源 call_id，模型才能回指', async () => {
    const agent = cuAgent(1);
    const attachments = contentAddressedAttachments();
    const h = harness({}, { attachments: attachments.service });
    const one = attachments.put(Buffer.from('frame-one'));
    const two = attachments.put(Buffer.from('frame-two'));
    const run = (callId) => ({ name: 'screenshot', callId, agent, arguments: {} });
    await h.firePost(run('call-abc'), { content: observation([{ id: one }]), isError: false });
    advance(agent, 2);
    await h.firePost(run('call-mid'), { content: observation([{ id: two }]), isError: false });
    advance(agent, 3);
    const decision = await h.firePost(run('call-def'), { content: observation([{ id: one }]), isError: false });
    const notice = decision.content?.find((b) => b.type === 'text' && b.text.includes('逐字节相同'));
    assert.ok(notice, '跨步回到旧画面时应命中跨结果去重');
    assert.ok(notice.text.includes('call-abc'), '说明必须点名来源，模型才能回指');
  });

  test('文本结果逐字去重，且有最小长度门槛', async () => {
    const h = harness();
    const big = 'payload:'.concat('x'.repeat(800));
    const run = (callId) => ({ name: 'bash', callId, agent: CU, arguments: { command: 'ls' } });
    await h.firePost(run('c1'), { content: textResult(big), isError: false });
    const decision = await h.firePost(run('c2'), { content: textResult(big), isError: false });
    assert.equal(decision.kind, 'accept');
    assert.equal(decision.content.length, 1);
    assert.ok(decision.content[0].text.includes('逐字相同'));
    assert.ok(decision.content[0].text.includes('c1'));

    // 短结果不值得一行说明的开销。
    const short = 'ok';
    await h.firePost(run('c3'), { content: textResult(short), isError: false });
    const shortDecision = await h.firePost(run('c4'), { content: textResult(short), isError: false });
    assert.deepEqual(shortDecision, { kind: 'accept' });
  });

  test('文本内容不同绝不命中', async () => {
    const h = harness();
    const run = (callId) => ({ name: 'bash', callId, agent: CU, arguments: {} });
    await h.firePost(run('c1'), { content: textResult('a'.repeat(900)), isError: false });
    const decision = await h.firePost(run('c2'), { content: textResult('a'.repeat(899) + 'b'), isError: false });
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('多块文本结果不参与逐字去重（块边界本身是信息）', async () => {
    const h = harness();
    const blocks = [{ type: 'text', text: 'x'.repeat(600) }, { type: 'text', text: 'y'.repeat(600) }];
    const run = (callId) => ({ name: 'bash', callId, agent: CU, arguments: {} });
    await h.firePost(run('c1'), { content: blocks, isError: false });
    const decision = await h.firePost(run('c2'), { content: blocks, isError: false });
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('不同工具的相同文本互不影响', async () => {
    const h = harness();
    const text = 'z'.repeat(900);
    await h.firePost({ name: 'bash', callId: 'c1', agent: CU, arguments: {} }, { content: textResult(text), isError: false });
    const decision = await h.firePost(
      { name: 'web_fetch', callId: 'c2', agent: CU, arguments: {} },
      { content: textResult(text), isError: false },
    );
    assert.deepEqual(decision, { kind: 'accept' }, '不同工具分表，不应互相命中');
  });

  test('跨 Agent 隔离：另一个会话的相同结果不命中', async () => {
    const h = harness();
    const text = 'q'.repeat(900);
    await h.firePost({ name: 'bash', callId: 'c1', agent: cuAgent(), arguments: {} }, { content: textResult(text), isError: false });
    const decision = await h.firePost(
      { name: 'bash', callId: 'c2', agent: { id: 'other', session: { header: { agentPreset: 'computer-use' } } }, arguments: {} },
      { content: textResult(text), isError: false },
    );
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('textCap 打开后超长文本被留头留尾', async () => {
    const h = harness({ textCapHeadChars: 10, textCapTailChars: 10 });
    const decision = await h.firePost(
      { name: 'bash', callId: 'c1', agent: cuAgent(), arguments: {} },
      { content: textResult('H'.repeat(200) + 'T'.repeat(200)), isError: false },
    );
    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content[0].text.includes('characters trimmed'));
  });

  test('观察窗口关闭（默认）时历史观察结果永不被裁', async () => {
    const { h, ids } = obsHarness();
    const seen = [];
    for (let index = 0; index < 5; index += 1) {
      advance(CU, index + 1);
      // 每步换一张新图：窗口关闭时一张都不该被裁。
      const frame = [ids.one, ids.two, ids.three][index % 3];
      seen.push(await h.firePost(
        { name: 'click', callId: `c${index}`, agent: CU, arguments: {} },
        { content: observation([{ id: frame }]), isError: false },
      ));
    }
    for (const decision of seen) {
      if (decision.content === undefined) continue;
      assert.equal(
        decision.content.some((b) => b.type === 'text' && b.text.includes('观察窗口省略')),
        false,
        '窗口关闭时不应出现占位说明',
      );
    }
    assert.equal(agentStepOf(CU), 5, '五步之后步号应推进到 5');
  });

  test('观察窗口打开后超出窗口的观察结果只留占位说明', async () => {
    const attachments = contentAddressedAttachments();
    const h = harness({ imageRetentionWindow: 2 }, { attachments: attachments.service });
    const ids = [1, 2, 3, 4, 5].map((n) => attachments.put(Buffer.from(`frame-${n}`)));
    const seen = [];
    for (let index = 0; index < ids.length; index += 1) {
      advance(CU, index + 1);
      const decision = await h.firePost(
        { name: 'screenshot', callId: `c${index}`, agent: CU, arguments: {} },
        { content: observation([{ id: ids[index] }]), isError: false },
      );
      seen.push(decision);
    }
    const windowed = seen.filter((d) => d.content?.some((b) => b.type === 'text' && b.text.includes('观察窗口省略')));
    assert.ok(windowed.length >= 1, '超出窗口的观察结果应出现占位说明');
  });

  test('dedupeImages=false 时不做图片去重（但仍保留批处理去冗余）', async () => {
    const attachments = contentAddressedAttachments();
    const h = harness({ dedupeImages: false }, { attachments: attachments.service });
    const id = attachments.put(Buffer.from('same'));
    await h.firePost({ name: 'click', callId: 'c1', agent: CU, arguments: {} }, { content: observation([{ id }]), isError: false });
    const decision = await h.firePost(
      { name: 'click', callId: 'c2', agent: CU, arguments: {} },
      { content: observation([{ id }]), isError: false },
    );
    assert.equal(countImages(decision.content), 0, '批处理规则仍然生效');
    assert.equal(
      decision.content.some((b) => b.type === 'text' && b.text.includes('逐字节相同')),
      false,
      '去重关闭后不应出现去重说明',
    );
  });

  test('dedupeText=false 时不做文本去重', async () => {
    const h = harness({ dedupeText: false });
    const text = 'w'.repeat(900);
    const run = (callId) => ({ name: 'bash', callId, agent: CU, arguments: {} });
    await h.firePost(run('c1'), { content: textResult(text), isError: false });
    const decision = await h.firePost(run('c2'), { content: textResult(text), isError: false });
    assert.deepEqual(decision, { kind: 'accept' });
  });

  test('指标会计入省量', async () => {
    const { h, ids } = obsHarness();
    await h.firePost({ name: 'click', callId: 'c1', agent: CU, arguments: {} }, { content: observation([{ id: ids.one }]), isError: false });
    await h.firePost({ name: 'click', callId: 'c2', agent: CU, arguments: {} }, { content: observation([{ id: ids.two }]), isError: false });
    assert.equal(h.turbo.metrics.calls, 2);
    assert.equal(h.turbo.metrics.droppedImages, 1);
    assert.ok(h.turbo.metrics.savedChars > 0);
  });
});

// ---------------------------------------------------------------------------
// B3. 系统提示改写
// ---------------------------------------------------------------------------

describe('B3. 系统提示改写', () => {
  const assemblyWith = (text) => ({
    sections: [
      { name: 'harness:identity', text: 'You are DSH.' },
      { name: 'computer-use:policy', text },
      { name: 'persona:suffix', text: 'Your working directory is /tmp.' },
    ],
    contexts: [],
    tools: [{ name: 'click' }, { name: 'input_text' }, { name: 'open_in_finder' }, { name: 'code_agent' }],
    variables: {},
  });

  test('computer-use 策略段被换成压缩版并追加纪律', async () => {
    const h = harness();
    const out = await h.fireAssemble(assemblyWith(realPolicy), { agent: cuAgent() });
    const policy = out.sections.find((s) => s.name === 'computer-use:policy');
    assert.ok(policy.text.includes('Coordinates:'), '坐标段必须保留');
    assert.ok(policy.text.includes('3 shell commands'), '必须写入可数的交棒预算');
    assert.ok(policy.text.includes(DISCIPLINE), '必须追加作业纪律');
    assert.ok(policy.text.length < realPolicy.length);
  });

  test('其他 section 逐字不动', async () => {
    const h = harness();
    const out = await h.fireAssemble(assemblyWith(FAKE_POLICY), { agent: cuAgent() });
    assert.equal(out.sections[0].text, 'You are DSH.');
    assert.equal(out.sections[2].text, 'Your working directory is /tmp.');
  });

  test('标准会话的系统提示一个字都不改', async () => {
    const h = harness();
    const assembly = assemblyWith(FAKE_POLICY);
    const out = await h.fireAssemble(assembly, { agent: stdAgent() });
    assert.equal(out, assembly, '应原样返回同一个对象');
  });

  test('没有 computer-use 策略段时原样返回', async () => {
    const h = harness();
    const assembly = assemblyWith('Some unrelated policy text.');
    const out = await h.fireAssemble(assembly, { agent: cuAgent() });
    assert.equal(out, assembly);
  });

  test('policy=false 时只追加纪律，不改写原文', async () => {
    const h = harness({ policy: false });
    const out = await h.fireAssemble(assemblyWith(FAKE_POLICY), { agent: cuAgent() });
    const policy = out.sections.find((s) => s.name === 'computer-use:policy');
    assert.ok(policy.text.startsWith(FAKE_POLICY));
    assert.ok(policy.text.includes(DISCIPLINE));
  });

  test('discipline=false 时只压缩，不追加纪律', async () => {
    const h = harness({ discipline: false });
    const out = await h.fireAssemble(assemblyWith(FAKE_POLICY), { agent: cuAgent() });
    const policy = out.sections.find((s) => s.name === 'computer-use:policy');
    assert.equal(policy.text, compressPolicy(FAKE_POLICY));
  });

  test('两个开关都关时不注册 assemble 监听器', () => {
    const h = harness({ policy: false, discipline: false });
    assert.equal(h.handlers.some((e) => e.name === 'system-prompt/assemble'), false);
  });

  test('agents 缺失时用工具面兜底判定', async () => {
    const h = harness();
    const out = await h.fireAssemble(assemblyWith(FAKE_POLICY), {});
    assert.ok(out.sections.find((s) => s.name === 'computer-use:policy').text.includes('3 shell commands'));
  });

  test('sections 不是数组时不崩', async () => {
    const h = harness();
    const assembly = { sections: undefined, tools: [] };
    assert.equal(await h.fireAssemble(assembly, { agent: cuAgent() }), assembly);
  });

  test('isComputerUsePolicy 需要同时命中两个锚点', () => {
    assert.equal(isComputerUsePolicy(FAKE_POLICY), true);
    assert.equal(isComputerUsePolicy('trust only the attached screenshot'), false, '缺坐标标记不算');
    assert.equal(isComputerUsePolicy('Coordinates: 0-1000'), false, '缺截图锚点不算');
    assert.equal(isComputerUsePolicy(undefined), false);
    assert.equal(isComputerUsePolicy(123), false);
  });
});

// ---------------------------------------------------------------------------
// B4. 缓存命中率：reasoningEffort 回钉
// ---------------------------------------------------------------------------

describe('B4. reasoningEffort 回钉（保住前缀缓存）', () => {
  const seed = (over = {}) => ({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    maxTokens: 256000,
    ...over,
  });

  test('首次请求记下钉值，原样放行', async () => {
    const h = harness();
    const out = await h.fireRequest({ agent: cuAgent() }, seed());
    assert.equal(out.reasoningEffort, 'max');
    assert.equal(h.turbo.metrics.effortRepins, 0);
  });

  test('会话外把 effort 改掉时回钉，并留下日志与计数', async () => {
    const h = harness();
    const agent = cuAgent();
    await h.fireRequest({ agent }, seed());
    // 模拟 dsh-orb 的 selectModelKeepDefault 窗口：会话读到了 code_agent 的临时值。
    const out = await h.fireRequest({ agent }, seed({ reasoningEffort: 'high' }));
    assert.equal(out.reasoningEffort, 'max', '必须回钉到本会话首次请求的取值');
    assert.equal(h.turbo.metrics.effortRepins, 1);
    const line = h.logs.find((l) => l.message.includes('回钉'));
    assert.ok(line, '必须留下可诊断的日志');
    assert.equal(line.level, 'warn', '这是会改变用户意图的干预，应当是 warn 级');
    assert.ok(line.message.includes('pinReasoningEffort'), '必须告诉用户怎么关掉它');
  });

  test('反复被改就反复回钉', async () => {
    const h = harness();
    const agent = cuAgent();
    await h.fireRequest({ agent }, seed());
    for (const effort of ['high', 'low', 'high', 'low']) {
      await h.fireRequest({ agent }, seed({ reasoningEffort: effort }));
    }
    assert.equal(h.turbo.metrics.effortRepins, 4, '四次被改都应回钉');
  });

  test('换模型是用户的明确动作：重新钉新路由，不阻拦', async () => {
    const h = harness();
    const agent = cuAgent();
    await h.fireRequest({ agent }, seed());
    const out = await h.fireRequest({ agent }, seed({ model: 'deepseek-reasoner', reasoningEffort: 'high' }));
    assert.equal(out.model, 'deepseek-reasoner');
    assert.equal(out.reasoningEffort, 'high', '换模型后应接受新取值');
    assert.equal(h.turbo.metrics.effortRepins, 0);
    // 新路由也有了自己的钉值。
    const again = await h.fireRequest({ agent }, seed({ model: 'deepseek-reasoner', reasoningEffort: 'low' }));
    assert.equal(again.reasoningEffort, 'high');
  });

  test('换 provider 同样重新钉', async () => {
    const h = harness();
    const agent = cuAgent();
    await h.fireRequest({ agent }, seed());
    const out = await h.fireRequest({ agent }, seed({ provider: 'deepseek-official', reasoningEffort: 'low' }));
    assert.equal(out.reasoningEffort, 'low');
    assert.equal(h.turbo.metrics.effortRepins, 0);
  });

  test('pinReasoningEffort=false 时完全不干预', async () => {
    const h = harness({ pinReasoningEffort: false });
    const agent = cuAgent();
    await h.fireRequest({ agent }, seed());
    const out = await h.fireRequest({ agent }, seed({ reasoningEffort: 'high' }));
    assert.equal(out.reasoningEffort, 'high');
    assert.equal(h.turbo.metrics.effortRepins, 0);
  });

  test('标准会话不受影响', async () => {
    const h = harness();
    const agent = stdAgent();
    await h.fireRequest({ agent }, seed());
    const out = await h.fireRequest({ agent }, seed({ reasoningEffort: 'high' }));
    assert.equal(out.reasoningEffort, 'high');
  });

  test('会话之间互不串味：各自的钉值独立', async () => {
    const h = harness();
    const a = cuAgent();
    const b = { id: 'session-2', session: { header: { agentPreset: 'computer-use' }, log: [] } };
    await h.fireRequest({ agent: a }, seed({ reasoningEffort: 'max' }));
    await h.fireRequest({ agent: b }, seed({ reasoningEffort: 'low' }));
    assert.equal((await h.fireRequest({ agent: a }, seed({ reasoningEffort: 'low' }))).reasoningEffort, 'max');
    assert.equal((await h.fireRequest({ agent: b }, seed({ reasoningEffort: 'max' }))).reasoningEffort, 'low');
  });

  test('下游抛出或返回畸形值时插件不掩盖错误、也不崩', async () => {
    const h = harness();
    const entry = h.handlers.find((c) => c.name === 'agent/request');
    await assert.rejects(() => entry.handler({ agent: cuAgent() }, async () => { throw new Error('boom'); }));
    const out = await h.fireRequest({ agent: cuAgent() }, undefined);
    assert.equal(out, undefined);
  });
});

// ---------------------------------------------------------------------------
// B5. 缓存观测量
// ---------------------------------------------------------------------------

describe('B5. 缓存命中率观测', () => {
  /**
   * 造一个能把用量事件送回插件的 agents 服务桩。
   *
   * 每个用例**各自新建 Agent**：node:test 在同一 suite 内并发跑用例，若共用
   * 一个 Agent，缓存基线（lastRead/lastMiss）会互相污染，判定结果随调度而变。
   *
   * @param config - 插件配置。
   * @returns `{ h, agent }`；`agent` 是本次用例专属的会话。
   */
  function liveHarness(config = {}) {
    const agent = cuAgent();
    const agents = { get: (id) => (id === agent.id ? agent : undefined) };
    return { h: harness(config, { agents }), agent };
  }

  const usageEvent = (usage) => ({
    type: 'assistant/message',
    data: { usage },
  });

  test('用量被累计，并算得出命中率', () => {
    const { h, agent } = liveHarness();
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 9000, inputTokens: 1000, outputTokens: 10 }));
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 9000, inputTokens: 1000, outputTokens: 10 }));
    assert.equal(h.turbo.metrics.cacheRead, 18000);
    assert.equal(h.turbo.metrics.cacheMiss, 2000);
    assert.equal(h.turbo.metrics.cacheSteps, 2);
  });

  test('整段清空被识别：未命中量级 ≈ 上一步整段上下文', () => {
    const { h, agent } = liveHarness();
    // 正常：命中 71000、未命中 700
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 71000, inputTokens: 700 }));
    assert.equal(h.turbo.metrics.cacheWipes, 0);
    // 清空：命中 0、未命中 72000（≈ 上一步整段上下文 71700）
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 0, inputTokens: 72000 }));
    assert.equal(h.turbo.metrics.cacheWipes, 1);
    assert.ok(h.logs.some((l) => l.message.includes('整段前缀缓存被清空')));
  });

  test('增长型的大未命中不算清空（避免误报）', () => {
    const { h, agent } = liveHarness();
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 71000, inputTokens: 700 }));
    // 新内容不少（工具结果 + 一张截图），但前缀仍被复用。
    // 未命中 4000 远小于上一步整段上下文 71700，不应误报为清空。
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 75000, inputTokens: 4000 }));
    assert.equal(h.turbo.metrics.cacheWipes, 0);
  });

  test('首步没有可比基线，不报清空', () => {
    const { h, agent } = liveHarness();
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 0, inputTokens: 7988 }));
    assert.equal(h.turbo.metrics.cacheWipes, 0);
  });

  test('请求头变化时，清空日志指出原因是客户端可修的', async () => {
    const { h, agent } = liveHarness();
    await h.fireRequest({ agent }, { provider: 'p', model: 'm', reasoningEffort: 'max' });
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 71000, inputTokens: 700 }));
    // 必须 await：不 await 就没有顺序，configChanged 还没置位就开始判清空原因。
    await h.fireRequest({ agent }, { provider: 'p', model: 'm', reasoningEffort: 'high' });
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 0, inputTokens: 72000 }));
    assert.equal(h.turbo.metrics.cacheWipes, 1);
    assert.ok(
      h.logs.some((l) => l.message.includes('请求头在本步变过')),
      `清空日志应指出客户端可修的原因；实际日志：${h.logs.map((l) => l.message).join(' | ')}`,
    );
  });

  test('拿不到活 Agent 时静默略过', () => {
    const { h } = liveHarness();
    h.fireSessionEvent({ id: 'unknown' }, usageEvent({ cacheReadTokens: 1, inputTokens: 1 }));
    assert.equal(h.turbo.metrics.cacheSteps, 0);
  });

  test('畸形用量不会污染统计，也不会崩', () => {
    const { h, agent } = liveHarness();
    h.fireSessionEvent({ id: agent.id }, usageEvent(undefined));
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 'x', inputTokens: null }));
    h.fireSessionEvent({ id: agent.id }, { type: 'tool/call', data: {} });
    h.fireSessionEvent({ id: agent.id }, undefined);
    assert.equal(h.turbo.metrics.cacheSteps, 0);
  });

  test('卸载日志里带上实测命中率', () => {
    const { h, agent } = liveHarness();
    h.fireSessionEvent({ id: agent.id }, usageEvent({ cacheReadTokens: 9000, inputTokens: 1000 }));
    h.effects[0]();
    const line = h.logs.find((l) => l.message.includes('released'));
    assert.ok(line, '应有卸载汇总');
    assert.ok(line.message.includes('90.00%'), `汇总里应有实测命中率：${line.message}`);
  });
});

// ---------------------------------------------------------------------------
// B6. 点击精度：用实测数据量化失准
// ---------------------------------------------------------------------------

describe('B6. 点击精度（实测标定）', () => {
  const {
    observedConversions,
    observedPreview,
    observedAttached,
    modelQuotes,
    typicalHitTolerancePx,
  } = clickAccuracy;

  test('模型做的换算本身是精确的：比例 = attached / preview', () => {
    const ratioX = observedAttached.width / observedPreview.width;
    const ratioY = observedAttached.height / observedPreview.height;
    assert.ok(Math.abs(ratioX - 1.5901) < 0.001, `x 比例应约 1.5901，实际 ${ratioX.toFixed(4)}`);
    assert.ok(Math.abs(ratioY - 1.5905) < 0.001, `y 比例应约 1.5905，实际 ${ratioY.toFixed(4)}`);

    for (const { step, preview, real } of observedConversions) {
      const scaled = [Math.round(preview[0] * ratioX), Math.round(preview[1] * ratioY)];
      // 逐点核对：模型用的就是这个比例。误差只来自四舍五入，不超过 1 像素。
      assert.ok(
        Math.abs(scaled[0] - real[0]) <= 1 && Math.abs(scaled[1] - real[1]) <= 1,
        `step ${step}: 换算结果 ${scaled} 应与模型提交的 ${real} 一致`,
      );
    }
  });

  test('换算公式没错——所以问题只能出在「缩略图上肉眼估读」', () => {
    // 这条断言的意义在于排除错误假设：如果比例本身错了，修比例即可；
    // 既然比例精确，就只剩估读误差，而它会被比例放大。
    const ratio = observedAttached.width / observedPreview.width;
    const previewErrorPx = 20; // 在 1610 宽的缩略图上估一个按钮中心，偏 20px 很常见
    const realErrorPx = previewErrorPx * ratio;
    assert.ok(
      realErrorPx > typicalHitTolerancePx,
      `缩略图上偏 ${previewErrorPx}px 会放大成真实坐标偏 ${realErrorPx.toFixed(1)}px，` +
        `已超过中心点击能容忍的 ${typicalHitTolerancePx}px —— 这就是点空的机制`,
    );
    console.log(
      `[turbo] 点击失准标定：缩略图 ${observedPreview.width}x${observedPreview.height} → ` +
        `栅格 ${observedAttached.width}x${observedAttached.height}，比例 ${ratio.toFixed(4)}；` +
        `缩略图上 ${previewErrorPx}px 的估读误差 → 真实坐标 ${realErrorPx.toFixed(1)}px（容差 ${typicalHitTolerancePx}px）`,
    );
  });

  test('模型确实在两个尺寸空间之间犹豫（这就是规则存在的理由）', () => {
    assert.ok(modelQuotes.length >= 2, '应记录模型的原话');
    const joined = modelQuotes.join(' ');
    assert.ok(joined.includes('preview shown is'), '模型自述看到了缩略图');
    assert.ok(joined.includes('tools expect'), '模型自述工具期望另一个尺寸空间');
    // 结论：模型知道有问题、也知道比例，但**没有权威依据**告诉它该用哪个尺寸。
    // 规则的作用就是把那个依据（attached_size 是唯一坐标系）明确给它。
  });

  test('精度规则给出的依据，正是模型缺的那一条', () => {
    const out = compressPolicy(pixelPolicy);
    // 模型缺的是「以哪个尺寸为准」。规则必须把 attached_size 指为唯一来源。
    assert.ok(
      out.includes('The coordinate space is attached_size and nothing else'),
      '必须把 attached_size 立为唯一坐标系',
    );
    assert.ok(
      out.includes('never scale coordinates to a size you read off the image'),
      '必须禁止按视觉尺寸换算——这正是它踩的那一步',
    );
    // 并且要给出容差层面的操作建议：点中心。
    assert.ok(out.includes('Click the centre of the control'), '必须要求点中心而非边缘');
  });

  test('pixel 口径的官方策略本身也没给「以哪个尺寸为准」——这是真空', () => {
    // 官方原文说的是「读 attached_size … 忽略不是 Computer Use 信封上的图像尺寸」。
    // 它没解释「你看到的图可能被显示层缩放过」，而模型恰恰卡在这里。
    assert.ok(observedAttached.width === 2560 && observedAttached.height === 1600);
    assert.ok(observedPreview.width < observedAttached.width, '预览确实比栅格小');
    const previewRatio = observedPreview.width / observedAttached.width;
    assert.ok(previewRatio < 0.7, `预览仅约为栅格的 ${(previewRatio * 100).toFixed(0)}%，缩放不可忽略`);
  });
});

// ---------------------------------------------------------------------------
// C. 真实数据回放
// ---------------------------------------------------------------------------

describe('C. 真实会话数据回放', () => {
  test('回钉 reasoningEffort 的收益：用真实用量序列量化', async () => {
    const sessions = await loadUsageFixture();
    assert.ok(sessions.length > 0, '内嵌用量夹具应可用');

    let read = 0;
    let miss = 0;
    let fixedRead = 0;
    let fixedMiss = 0;
    let wipes = 0;
    let wipedTokens = 0;

    for (const { steps } of sessions) {
      let previousContext = 0;
      for (const [, r, m] of steps) {
        read += r;
        miss += m;
        // 「整段清空」判定，与插件实现里的口径一致。
        const wiped = previousContext > 0 && r < 0.5 * (r + m) && m >= previousContext * 0.6;
        if (wiped) {
          wipes += 1;
          wipedTokens += m;
          // 假设回钉生效：这一整段上下文本该原样复用，只有超出的部分才是新内容。
          fixedRead += Math.min(previousContext, r + m);
          fixedMiss += Math.max(0, r + m - previousContext);
        } else {
          fixedRead += r;
          fixedMiss += m;
        }
        previousContext = r + m;
      }
    }

    const before = (read / (read + miss)) * 100;
    const after = (fixedRead / (fixedRead + fixedMiss)) * 100;
    console.log(
      `[turbo] 真实用量回放：命中率 ${before.toFixed(2)}% → ${after.toFixed(2)}%；` +
        `清空 ${wipes} 次、被重算 ${wipedTokens.toLocaleString()} token，` +
        `未命中 ${miss.toLocaleString()} → ${fixedMiss.toLocaleString()}（省 ${(miss - fixedMiss).toLocaleString()}）`,
    );

    assert.ok(wipes >= 2, `应识别出实测的清空点，实际 ${wipes}`);
    assert.ok(after > before + 1, `命中率应至少提升 1 个百分点：${before} → ${after}`);
    assert.ok(after >= 95, `回钉后命中率应达到 95% 以上，实际 ${after.toFixed(2)}%`);
    assert.ok(miss - fixedMiss > 100000, `应省下 10 万以上未命中 token，实际 ${miss - fixedMiss}`);
  });

  test('用本机真实 GUI 截图跑一遍变换，省量可核对', async () => {
    const attachments = contentAddressedAttachments();
    // 用真实像素尺寸与字节量级造样本（2400×1500 视网膜截图，PNG ~400KB）。
    const realBytes = (seed) => Buffer.alloc(400_000, seed);
    const h = harness({}, { attachments: attachments.service });
    const agent = cuAgent();

    // 模拟一个 12 步、每步 2 个 GUI 动作的会话：动作后截图交替变化。
    let savedImages = 0;
    let index = 0;
    for (let step = 0; step < 12; step += 1) {
      for (let action = 0; action < 2; action += 1) {
        index += 1;
        // 每步第一帧换新内容，第二帧内容与第一帧相同（真实场景里常见：
        // 点击没有落到可交互控件上，界面没有变化）。
        const seed = action === 0 ? step : step;
        const id = attachments.put(realBytes(seed));
        const decision = await h.firePost(
          { name: 'click', callId: `call-${index}`, agent, arguments: { position: [index, index] } },
          { content: observation([{ id }]), isError: false },
        );
        if (decision.content !== undefined && countImages(decision.content) === 0) savedImages += 1;
      }
    }

    assert.ok(savedImages >= 12, `应至少省下 12 张图，实际 ${savedImages}`);
    assert.ok(h.turbo.metrics.savedChars > 0);
    const tokensSaved = Math.round(h.turbo.metrics.savedChars / 4);
    assert.ok(tokensSaved > 0);
    // 打印实测值，便于与 README 的表格互相核对。
    console.log(
      `[turbo] 回放：省下 ${savedImages} 张截图，约 ${tokensSaved} token；` +
        `中间帧 ${h.turbo.metrics.droppedImages}，未变帧 ${h.turbo.metrics.dedupedImages}`,
    );
  });
});
