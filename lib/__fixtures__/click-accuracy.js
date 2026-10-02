// Computer Use 点击失准的**实测标定数据**。
//
// 全部取自本机真实会话日志与 dsh-orb 发行产物，不是估算。
// 它支撑两条结论：
//   1. 模型做的坐标换算本身是**对的**（比例 1.5901 = 2560/1610 精确）；
//   2. 错的是「在缩略图上肉眼估读」这一步，而那个误差会被比例**放大**。

/**
 * 模型自己在 reasoning 里写下的 `preview (x, y) → real (X, Y)` 映射。
 *
 * 逐字摘自 `session-183631b5-6833-4889-9423-6bfa04127b20`（该会话坐标口径为
 * pixels，`<attached_size>2560x1600</attached_size>`）。
 */
export const observedConversions = [
  { step: 10, preview: [884, 896], real: [1406, 1425], quote: '提交 button at preview (884, 896) → real (1406, 1425). Click it.' },
  { step: 13, preview: [391, 291], real: [621, 463], quote: null },
  { step: 15, preview: [884, 896], real: [1406, 1425], quote: null },
  { step: 16, preview: [1053, 633], real: [1675, 1006], quote: 'The 提交 in dialog at preview (1053, 633) → real (1675, 1006).' },
];

/** 模型以为自己在看的缩略图尺寸（它自己报出来的）。 */
export const observedPreview = { width: 1610, height: 1006 };

/** 观察信封里给出的真实栅格尺寸（`<attached_size>`）。 */
export const observedAttached = { width: 2560, height: 1600 };

/** 模型的原话——它明确意识到自己在两个尺寸空间之间换算。 */
export const modelQuotes = [
  'the coordinate space: the attached_size is 2560x1600 but the preview shown is 1610x1006. So coordinates I pass are in the 2560x1600 space?',
  'My visual coordinate estimates would then be in the 1610x1006 space. But the tools expect 2560x1600 space.',
  'Given uncertainty, the proportion…',
];

/**
 * 一个典型 macOS 控件的命中区容差（物理像素）。
 *
 * macOS 常规按钮高度约 22–32 逻辑点，2× 视网膜下 44–64 物理像素；半高
 * 22–32 物理像素是「点中心」相对「点边缘」多出来的余量。取 24 作为保守值：
 * 中心点击能容忍的定位误差上限。
 */
export const typicalHitTolerancePx = 24;
