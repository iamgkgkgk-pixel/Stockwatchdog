# 📊 ETF择时决策辅助工具 — 项目全景速览

> **阅读本文件后，你应该能在5分钟内建立对整个项目的全局认知。**

## 一句话描述

一个纯前端的 ETF 多维度择时信号工具，覆盖 19 只 ETF（A股/港股/美股/日股/黄金/债券/商品），通过巴菲特/芒格四维度评分体系（估值+安全边际+盈利质量+市场情绪）生成 0-100 综合分并映射为 8 级买卖信号，帮助个人投资者做"该不该买/该不该卖"的辅助决策。

## 核心用户

个人 ETF 投资者（项目作者自用），通过浏览器直接打开 `index.html` 使用，无需后端服务。

## 技术栈一览

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端框架 | 无框架，原生 JS | 6 个 IIFE 模块，浏览器直接加载 |
| 图表库 | ECharts 5.5.0 | 三级 CDN fallback + 本地 lib/ 兜底 |
| 样式 | 原生 CSS | 暗色金融仪表盘风格，响应式断点 576px/992px |
| 数据源 | 东方财富 API + 蛋卷基金 API | JSONP 绕过 CORS + 4 个 CORS 代理轮询 |
| 历史数据 | data/*.json (20 个文件) | 月度 PE/PB/股息率/国债收益率/利差/价格 |
| 自动更新 | GitHub Actions | 每月 1 日和 15 日运行 Python 脚本更新 JSON |
| 构建工具 | 无 | 零依赖，浏览器直接打开 index.html |
| 部署 | GitHub Pages 或本地文件 | 纯静态，无后端 |

## 文件地图

```
dividend-low-vol-timer/
│
├── index.html                 (307行) 单页面入口，ECharts三级CDN fallback
├── css/style.css              (1354行) 暗色金融仪表盘风格，主色 #1a1a2e
│
├── js/                        ← 6个IIFE模块（核心代码）
│   ├── etf-config.js          (1407行) ETF配置中心：19只ETF配置 + 12种SIGNAL_RULES
│   ├── signal.js              (1071行) 多维度择时信号引擎：评分算法/分位计算/历史回算
│   ├── main.js                (1854行) 应用主入口：数据管线/UI渲染/状态管理
│   ├── charts.js              (758行)  ECharts图表管理：仪表盘/走势图/分位图
│   ├── api.js                 (1129行) 数据获取：JSONP/CORS代理/东方财富/蛋卷/CNN F&G
│   └── storage.js             (90行)   localStorage存储：缓存/记录/设置/导出
│
├── data/                      ← 20个JSON历史数据文件
│   ├── dividend-low-vol.json  红利低波ETF
│   ├── history.json           红利低波副本（兼容旧版）
│   ├── sci-tech-50.json       科创创业50
│   ├── gem-50.json            创业板50
│   ├── free-cashflow.json     自由现金流
│   ├── sp500-cn.json          标普500
│   ├── nasdaq100-cn.json      纳指100
│   ├── hstech.json            恒生科技
│   ├── hk-soe-dividend.json   港股央企红利
│   ├── csi300.json            沪深300
│   ├── pharma.json            医药ETF
│   ├── gold.json              黄金ETF
│   ├── bond-10y.json          十年国债
│   ├── soybean-meal.json      豆粕ETF
│   ├── nikkei225.json         日经225
│   ├── topix.json             东证ETF
│   ├── sci-semi.json          科创半导体
│   ├── robot.json             机器人ETF
│   ├── energy-storage.json    储能ETF
│   └── pcb.json               PCB电子ETF
│
├── scripts/
│   └── auto_update_data.py    (800行) Python月度数据更新脚本
│
├── lib/
│   └── echarts.min.js         ECharts本地兜底文件
│
├── .github/workflows/
│   └── update-data.yml        (98行) GitHub Actions CI/CD 月度自动更新
│
├── .ai-context/               ← 🧠 AI知识传承目录（你正在读的）
│   ├── PROJECT.md             本文件 — 项目全景速览
│   ├── ARCHITECTURE.md        架构设计 — 模块关系/数据流/核心算法
│   ├── RULES.md               开发红线 — AI必须遵守的约束
│   ├── DECISION-LOG.md        决策日志 — 每个重大决策的Why
│   └── ITERATION-GUIDE.md     迭代指南 — 常见任务SOP
│
├── .codebuddy/memory/         CodeBuddy开发日志（IDE私有，参考用）
├── README.md                  项目README
├── CHANGELOG.md               版本变更日志
└── .gitignore                 Git忽略规则
```

## 19 只 ETF 品种清单

| # | ID | 代码 | 名称 | 类型 | 信号规则 | 估值权重 |
|---|-----|------|------|------|---------|---------|
| 1 | `dividend-low-vol` | 512890 | 红利低波ETF | Smart Beta | buffett_value | 估40/安30/质10/情20 |
| 2 | `sci-tech-50` | 588300 | 科创创业50ETF | A股成长 | buffett_growth | 估55/安10/质10/情25 |
| 3 | `gem-50` | 159949 | 创业板50ETF | A股成长 | buffett_growth | 估55/安10/质10/情25 |
| 4 | `free-cashflow` | 159201 | 自由现金流ETF | Smart Beta | buffett_value | 估35/安40/质10/情15 |
| 5 | `sp500-cn` | 513650 | 标普500ETF | 美股QDII | buffett_us | 估45/安15/质10/情30 |
| 6 | `nasdaq100-cn` | 513110 | 纳指ETF | 美股QDII | buffett_us_growth | 估45/安15/质10/情30 |
| 7 | `hstech` | 513180 | 恒生科技ETF | 港股QDII | buffett_hk | 估50/安15/质10/情25 |
| 8 | `csi300` | 510300 | 沪深300ETF | A股宽基 | buffett_broad | 估40/安30/质10/情20 |
| 9 | `pharma` | 512010 | 医药ETF | A股行业 | buffett_pharma | 估50/安20/质10/情20 |
| 10 | `gold` | 518850 | 黄金ETF | 避险 | gold_trend | 情100（纯趋势） |
| 11 | `bond-10y` | 511260 | 十年国债ETF | 债券 | bond_yield | 估40/安30/情30 |
| 12 | `soybean-meal` | 159985 | 豆粕ETF | 商品 | commodity_trend | 情100（纯趋势） |
| 13 | `hk-soe-dividend` | 513901 | 港股央企红利ETF | 港股QDII | buffett_hk_dividend | 估35/安35/质10/情20 |
| 14 | `nikkei225` | 513520 | 日经225ETF | 日股QDII | buffett_jp | 估45/安15/质10/情30 |
| 15 | `topix` | 513800 | 东证ETF | 日股QDII | buffett_jp | 估45/安15/质10/情30 |
| 16 | `sci-semi` | 588170 | 科创半导体ETF | A股行业 | buffett_growth | 估55/安10/质10/情25 |
| 17 | `robot` | 562500 | 机器人ETF | A股行业 | buffett_growth | 估55/安10/质10/情25 |
| 18 | `energy-storage` | 159566 | 储能ETF | A股行业 | buffett_growth | 估55/安10/质10/情25 |
| 19 | `pcb` | 515260 | PCB电子ETF | A股行业 | buffett_growth | 估55/安10/质10/情25 |

## 6 个 JS 模块依赖关系

```
index.html 加载顺序（有依赖关系，顺序不可变）：
  ① etf-config.js  → 零依赖，纯配置
  ② signal.js      → 依赖 ETF_CONFIG（读取 SIGNAL_RULES）
  ③ api.js         → 依赖 ETF_CONFIG（读取 ETF secid/trackIndex）
  ④ storage.js     → 零依赖
  ⑤ charts.js      → 依赖 echarts 全局变量 + SignalEngine（颜色/Zone函数）
  ⑥ main.js        → 依赖所有上述模块，编排完整数据管线

调用关系图：
  main.js ──→ ETF_CONFIG.getETFById()
         ──→ DataAPI.fetchAllData()
         ──→ SignalEngine.generateMultiDimSignal()
         ──→ SignalEngine.calcDailyHistoricalSignals()
         ──→ SignalEngine.calcScorePercentileSeries()
         ──→ ChartManager.initGauge() / updateGauge()
         ──→ ChartManager.initDailySignalHistoryChart()
         ──→ ChartManager.initScorePercentileChart()
         ──→ DataStorage.saveCurrentData() / getCurrentData()
```

## 部署方式

1. **本地使用**：浏览器直接打开 `index.html`（支持 `file://` 协议）
2. **GitHub Pages**：推送到 GitHub 仓库，开启 Pages 即可
3. **任何静态服务器**：Nginx/Apache/Caddy 直接托管

## 当前版本与状态

- **版本号**：`?v=20260416e`（在 index.html 的 JS 引用中标记）
- **版本号格式**：`YYYYMMDD` + 字母后缀（同一天内的第几次发布）
- **ETF 数量**：19 只
- **信号规则**：12 种
- **最后修改**：2026-04-16（修复医药 ETF 分位图表视觉 Bug）

---

> 📚 **深入了解**：
> - 架构与算法细节 → [ARCHITECTURE.md](./ARCHITECTURE.md)
> - 开发红线约束 → [RULES.md](./RULES.md)
> - 历史决策记录 → [DECISION-LOG.md](./DECISION-LOG.md)
> - 常见任务 SOP → [ITERATION-GUIDE.md](./ITERATION-GUIDE.md)
