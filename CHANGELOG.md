# Changelog

所有重要变更都记录在此文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [2026-04-25]

### Added
- 新增 **中证红利ETF**（515080）追踪，跟踪中证红利指数(000922)
  - 蛋卷有覆盖(SH000922)，PE/PB/股息率/分位实时获取
  - 使用价值型多维估值法(buffett_value)，含股债利差安全边际
- 新增 **港股通红利ETF**（513820）追踪，跟踪中证港股通高股息投资指数(930914)
  - 蛋卷无覆盖，使用行情反推PE + 手动数据
  - 使用港股高股息央企估值法(buffett_hk_dividend)
- 两只ETF位置在纳指(513110)之后，ETF总数从19只增至21只
- 新增 `data/csi-dividend.json` 和 `data/hk-dividend.json` 历史数据文件
- Python月度更新脚本同步添加两只ETF配置

---

## [2026-04-23]

### Changed
- 创业板50/科创创业50 估值数据源统一为蛋卷基金（代理指数：创业板指 SZ399006）
  - 移除 `danjuanPeRatio` 修正系数和 `isProxyIndex` 代理标记机制
  - 移除 K线累计涨跌幅反推PE逻辑（不再需要，PE直接从蛋卷获取）
  - 代理指数的 PE/PB/股息率/分位数全部统一使用蛋卷数据，与其他ETF保持一致
- 行情反推PE仅保留给完全无蛋卷覆盖的ETF（如自由现金流、科创半导体等）
- Python月度更新脚本同步更新：科创创业50/创业板50 的 danjuanCode 统一为 SZ399006

---

## [2026-04-16e]

### Added
- 综合分历史分位指标：`calcScorePercentileSeries()`, `calcScoreHistoricalPercentile()`, `getScorePercentileZone()`
- 综合分历史分位图表：`initScorePercentileChart()` 在 charts.js
- 分位摘要卡片：显示当前综合分在历史中的排名

### Fixed
- 医药 ETF 分位图表视觉 Bug：曲线最后一个点与摘要分位值不一致
  - 根因：图表用 marketTemp=50 基准，摘要用实时综合分（含真实 marketTemp）
  - 修复：摘要和标记点统一使用图表同基准的 lastSignal.score

---

## [2026-03-22]

### Added
- 多维度智能解读：芒格决策矩阵（`generateInterpretation()` in signal.js）
- 日级别信号走势图（`calcDailyHistoricalSignals()` + `initDailySignalHistoryChart()`）
- 新旧算法对比线（偏离度 vs 纯分位）
- 5 只新 ETF：港股央企红利、日经225、东证TOPIX、科创半导体、机器人
- 3 只新 ETF：储能、PCB电子、自由现金流
- PE 均值偏离度估值：`calcDeviationScore()`, `calcHybridValuationScore()`
- 利率环境因子：低利率时压缩利差安全边际虚高

### Changed
- PE 分位计算统一为本地 calcPercentile（方案B，DEC-001）
- 历史走势图 marketTemp 统一为 50（DEC-003）
- 安全边际公式从线性改为 E/P 倒数（DEC-004）
- 科创创业50 标的从 159781 切换到 588300（DEC-005）
- quality 维度权重从 5% 升至 10%（DEC-002）
- 自动刷新频率从 60 秒改为 300 秒（DEC-007）
- 去除标普500 +10 分美股溢价（DEC-008）

### Fixed
- PE 分位计算方式不一致（实时用 API 10年数据 vs 历史用本地 63 个月，差 22.6 个百分点）
- `||` 短路 Bug（0 值被跳过，pePercentile=0 和 marketTemp=0 被当作无数据）
- 科创创业指数错配（蛋卷 SH000688 是科创50 PE~164，非科创创业50 PE~40）
- 国债 ETF 信号历史走势图不显示（日期收集未包含 bondYieldHistory）
- 恒生科技实时信号与历史走势评分不一致

---

## [2026-03-15]

### Added
- 项目初始化：19 只 ETF 配置
- 巴菲特/芒格四维度评分体系
- 12 种 SIGNAL_RULES 评分规则
- ECharts 仪表盘 + 信号走势图
- 东方财富 JSONP + 蛋卷基金 CORS 代理
- GitHub Actions 月度数据自动更新
- localStorage 数据持久化
- 暗色金融仪表盘 UI
