# 🔄 迭代开发操作指南

> 新 AI 接手项目后最常做的 5 类任务的标准操作流程 (SOP)。
> 按照 SOP 操作可以避免 90% 的常见错误。

---

## SOP-1: 添加新 ETF 品种

### 前置条件
- 确认新 ETF 的代码、类型、跟踪指数
- 确定使用哪种 SIGNAL_RULES（可复用现有 12 种之一，或新建）

### 步骤

1. **在 `etf-config.js` 添加配置**
   - 在 `ETF_LIST` 数组末尾添加新 ETF 对象
   - 复制最接近类型的现有 ETF 作为模板
   - 必填字段: `id`(kebab-case, 全局唯一), `code`, `name`, `shortName`, `type`, `market`, `secid`, `color`, `icon`, `trackIndex`, `signalRules`, `dimWeights`
   - ⚠️ `id` 一旦确定不可更改（见 RULES R-06）

2. **选择或新建 signalRules**
   - 如果已有规则适用（如成长股用 `buffett_growth`），直接引用
   - 如果需要新规则，在 `SIGNAL_RULES` 对象中添加，必须包含 `calcScores()` 和 `generate()` 函数
   - 新规则需数学验证: PE=0, PE=200, marketTemp=0/50/100 边界值

3. **创建 `data/{id}.json` 历史数据文件**
   - 格式参考 `ARCHITECTURE.md` 中的 JSON 数据文件结构
   - 至少需要 `peHistory`（12+ 个月）
   - 如果是价值型 ETF，还需要 `spreadHistory`, `dividendYieldHistory`, `bondYieldHistory`
   - 必须包含 `valuationAnchor: { peMean, peStd }` 用于均值偏离度计算

4. **更新 `scripts/auto_update_data.py`**
   - 在脚本中添加新 ETF 的数据源配置
   - 确保蛋卷基金/东方财富 API 能正确获取该指数的估值数据

5. **更新文档**
   - `.ai-context/PROJECT.md`: 品种清单表格
   - 如新建了规则: `.ai-context/ARCHITECTURE.md`: SIGNAL_RULES 表格

6. **验证**
   - 浏览器打开 → 切换到新 ETF
   - 检查: 信号卡片是否有值、仪表盘是否渲染、走势图是否有曲线
   - 检查: F12 无 console 错误
   - 检查: URL hash 切换是否正常（`#new-etf-id`）

---

## SOP-2: 修改评分规则 / 权重

### 步骤

1. **定位规则**
   - 在 `etf-config.js` 的 `SIGNAL_RULES` 中找到目标规则
   - 确认哪些 ETF 使用该规则（搜索 `signalRules: 'rule_key'`）

2. **修改 `calcScores` 或 `dimWeights`**
   - 修改维度权重: 在对应 ETF 的 `dimWeights` 对象中调整
   - 修改评分公式: 在 `SIGNAL_RULES.xxx.calcScores()` 中调整
   - ⚠️ 确保权重之和 = 100（如果不是 100，generate 函数中的加权求和会自动归一化，但保持 100 更清晰）

3. **数学验证边界值**
   - PE = 0, 5, 均值, 2×均值, 200
   - marketTemp = 0, 25, 50, 75, 100
   - dividendYield = 0, bondYield = 0
   - 确认所有 scores 输出在 0-100 范围内
   - 确认 null 处理正确（无数据时返回 null，不返回 0）

4. **更新 `DECISION-LOG.md`**
   - 添加新决策条目: 背景 + 决策 + 影响

5. **验证**
   - 至少检查 3 只使用该规则的 ETF
   - 对比修改前后的综合分变化是否合理

---

## SOP-3: 添加新图表

### 步骤

1. **在 `index.html` 添加 DOM 容器**
   ```html
   <div class="chart-container" id="chart-{name}" style="height:300px;"></div>
   ```

2. **在 `charts.js` 创建渲染函数**
   - 函数命名: `initXxxChart(containerId, data, ...)`
   - 使用 `checkECharts(dom)` 检查库可用性
   - 使用项目 THEME 保持视觉一致
   - 在 `return` 中导出函数

3. **在 `main.js` 添加调用**
   - 在 `updateUI` 或独立的 `renderXxxChart` 函数中调用
   - 传递正确的数据

4. **在 `css/style.css` 添加样式**
   - 响应式适配: 576px 断点下调整高度/字体

5. **验证**
   - 检查图表在不同 ETF 切换时是否正确更新
   - 检查窗口 resize 后图表是否自适应
   - 检查数据为空时是否有友好提示

---

## SOP-4: 修复数据不一致问题

> 这是最常见的 Bug 类型，需要系统排查。

### 排查流程

1. **优先检查 localStorage 缓存是否有脏数据**
   - F12 → Application → Local Storage → 搜索 `etf_timer_`
   - 比对缓存值与 JSON 文件的值是否一致
   - 如有疑问: `DataStorage.clearETFData('etf-id')` 清除该 ETF 缓存

2. **对比三个数据源**
   - JSON 预设值: `data/{etfId}.json` 中的最新月份数据
   - API 实时值: F12 → Network → 搜索 `eastmoney` 或 `danjuan` 请求
   - localStorage 缓存值: 同步骤 1

3. **确认 calcPercentile 的输入数据集**
   - 当前 PE 值是否正确？
   - 历史 PE 数组是否完整？（不应有 NaN、undefined）
   - 分位计算结果是否合理？

4. **检查 normalizeData 的数据覆盖优先级**
   - 正确优先级: API 实时 > JSON 预设 > localStorage 缓存
   - 确认没有错误的优先级覆盖

5. **检查 marketTemp 相关**
   - 实时信号: marketTemp 应来自 CNN F&G 或 A 股广度
   - 历史走势: marketTemp 应统一为 50
   - 分位图表: 摘要应使用图表同基准的 score，不使用实时 currentTotal

---

## SOP-5: 月度数据更新（手动）

### 自动方式

GitHub Actions 每月 1 日和 15 日自动运行，无需手动操作。

### 手动方式

1. **运行更新脚本**
   ```bash
   cd scripts/
   python3 auto_update_data.py
   ```

2. **检查更新结果**
   - 查看 `data/*.json` 文件是否有新增月份数据
   - 确认 peHistory 最后一条的 date 是否为当前月
   - 确认 valuationAnchor 是否需要更新（如果 PE 分布发生重大变化）

3. **更新版本号**
   - 在 `index.html` 中更新所有 `?v=YYYYMMDD` 后缀
   - 每次发布用新的字母后缀（a/b/c...）

4. **更新 CHANGELOG.md**
   - 记录数据更新内容

5. **验证**
   - 浏览器刷新，检查各 ETF 的 PE 数据是否为最新
   - 检查走势图是否延伸到最新月份

---

## SOP-6: 发布新版本

### 步骤

1. **更新版本号**
   - `index.html` 中所有 JS/CSS 引用的 `?v=` 后缀

2. **更新 CHANGELOG.md**
   - 按 [Keep a Changelog](https://keepachangelog.com/) 格式记录变更
   - 分类: Added / Changed / Fixed / Removed

3. **更新 .ai-context/ 文档（如有变更）**
   - 新增 ETF → `PROJECT.md`
   - 改算法 → `ARCHITECTURE.md` + `DECISION-LOG.md`
   - 改规则 → `RULES.md`

4. **浏览器全量验证**
   - 每种类型至少验证 1 只 ETF
   - F12 无 console 错误
   - 图表渲染正常

5. **Git commit + push**
   - Commit message 格式建议: `feat: 简述` / `fix: 简述` / `docs: 简述`

---

> **📌 通用原则**: 
> - 改之前先理解，理解之前先读 `.ai-context/` 目录
> - 改完后先验证，验证通过后再记录
> - 不确定时不要改，先问用户
