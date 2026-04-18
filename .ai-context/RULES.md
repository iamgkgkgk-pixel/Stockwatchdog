# 🚨 AI 开发约束规则

> 本文件定义了任何 AI 在此项目中开发时必须遵守的硬性约束。违反红线可能导致项目功能损坏。

---

## 🔴 绝对红线（违反 = 项目损坏）

### R-01: 不得将 IIFE 模块改为 ES Module

- 项目无构建工具（Webpack/Vite/Rollup），浏览器直接通过 `<script>` 标签加载
- 改为 `import/export` 后 `file://` 协议无法使用，GitHub Pages 也需要额外配置
- **正确做法**: 保持 `const ModuleName = (() => { ... return { ... }; })();` 模式

### R-02: 不得修改信号分界线

- `≥80 强烈买入, 70-80 买入, 55-70 持有加仓, 40-55 持有观望, 25-40 减仓预警, 15-25 卖出, <15 强烈卖出`
- 用户长期投资决策依赖这些阈值，已形成肌肉记忆
- **如需调整**: 必须用户明确确认，并在 DECISION-LOG.md 中记录

### R-03: 不得删除 JSONP 逻辑

- 东方财富 API 不支持 CORS（无 `Access-Control-Allow-Origin` 响应头）
- 删除 JSONP 后所有实时行情数据将获取失败
- **正确做法**: 修改 API 请求时保留 JSONP 作为必选方案

### R-04: data/*.json 的 peHistory 数据不可随意删减

- 全量 PE 历史是 `calcPercentile()` 的计算基准
- 删减数据会导致所有历史走势图和分位计算结果偏移
- `valuationAnchor` (peMean/peStd) 是均值偏离度的锚点，不可删除

### R-05: calcPercentile 必须用本地全量 PE 计算

- **不能换回 API 的 pePercentile**（基于 10 年+全市场数据，与本地 JSON 63-74 个月数据基准不同）
- 换回会导致实时信号与历史走势图分位差 20+ 个百分点
- 详见 [DEC-001](./DECISION-LOG.md#dec-001-使用方案b统一基准)

### R-06: 19 只 ETF 的 id 不可变

- localStorage key、JSON 文件名、URL hash 全部依赖 `etfConfig.id`
- 改 id 后用户本地缓存全部失效，历史记录丢失
- **如需修改**: 必须同步迁移 localStorage、重命名 JSON 文件、更新所有引用

### R-07: 图表数据不得混入实时综合分

- 历史走势图全部使用 `marketTemp=50`（中性基准），保证数据一致性
- 实时综合分含真实 marketTemp（如 CNN F&G=30），与图表基准不同
- **不可混用**: 如果图表中混入实时综合分，会导致最后一个点与历史数据不可比
- 详见 [DEC-003](./DECISION-LOG.md#dec-003-历史走势图markettemp统一为50) 和 2026-04-16 医药 ETF Bug 修复经验

---

## 🟡 风格约束（保持一致性）

### S-01: 模块模式

- 所有 JS 模块统一使用 IIFE + `return` 公开 API 模式
- 私有函数不暴露，公开 API 在 `return` 对象中列出

### S-02: 命名规范

- 变量/函数: `camelCase`（如 `calcPercentile`, `pePercentile`）
- 常量: `UPPER_SNAKE_CASE`（如 `SIGNAL_LEVELS`, `ETF_TYPE`）
- ETF ID: `kebab-case`（如 `dividend-low-vol`, `sci-tech-50`）

### S-03: 注释风格

- 模块头: JSDoc `/** */` 格式，含模块功能、设计哲学
- 段落分隔: `// ========== 段落名 ==========`
- 重要决策: 用 `// 【方案B】` 或 `// 【重要】` 前缀标注

### S-04: HTML 版本号格式

- 格式: `?v=YYYYMMDD` + 字母后缀
- 示例: `?v=20260416e`（2026年4月16日，当天第5次发布）
- 所有 JS/CSS 引用统一使用同一版本号

### S-05: CSS 色系

- 暗色主题: 背景 `#1a1a2e`，卡片 `#16213e`
- 文字: 主文 `#e2e8f0`，次级 `#a0aec0`
- 信号色系与 `SIGNAL_LEVELS` 中定义的颜色一致
- 响应式断点: 576px（手机）/ 992px（平板）

### S-06: 0 值安全

- `||` 运算符会将 `0` 当作 falsy 跳过
- **优先使用 `??`（空值合并）** 或严格比较 `!== null && !== undefined`
- 特别注意: pePercentile=0、marketTemp=0、score=0 都是合法值

---

## 🟢 鼓励的做法

### G-01: 新功能的模块归属

- **计算逻辑** → 放在 `signal.js` 中，导出新函数
- **图表渲染** → 放在 `charts.js` 中，导出新函数
- **数据获取** → 放在 `api.js` 中
- **编排调用** → 放在 `main.js` 中

### G-02: 始终保留 Fallback 机制

- CDN 加载: 保持三级 fallback 链
- API 请求: 保持 CORS 代理轮询
- 数据来源: API 失败时从 localStorage 或 JSON 预设值回退

### G-03: 修改评分规则前数学验证边界值

- 测试 PE=0, PE=200, PE=均值
- 测试 marketTemp=0, 50, 100
- 测试 dividendYield=0, bondYield=0
- 确认所有维度输出都在 0-100 范围内

### G-04: 每次修改后浏览器验证

- F12 检查无 console 错误
- 至少切换 3 种不同类型 ETF（价值型+成长型+趋势型）验证
- 检查图表渲染是否正常

### G-05: 维护文档同步更新

- 添加新 ETF → 更新 `PROJECT.md` 品种清单
- 改评分规则 → 更新 `ARCHITECTURE.md` + 添加 `DECISION-LOG.md` 条目
- 每次发版 → 更新 `CHANGELOG.md`

---

## ⚠️ 常见陷阱

| 陷阱 | 说明 | 正确做法 |
|------|------|---------|
| `pePercentile \|\| 50` | 0 被跳过 → 用 50 替代 | `pePercentile ?? 50` |
| 用 API 的 pePercentile | 基准不一致 | 用 `calcPercentile(pe, allPeValues)` |
| 历史图最后一天混入实时分 | 基准不一致 | 使用 `dailySignals` 最后一条的 score |
| 修改 ETF id | localStorage 全部失效 | 不改，或写迁移脚本 |
| ECharts 初始化时机 | 容器不可见时 init 会宽高为 0 | 确保容器 `display:block` 后再 init |
| `scores.quality = null` 处理 | null 维度权重自动跳过 | 不要把 null 改成 0（语义不同） |
