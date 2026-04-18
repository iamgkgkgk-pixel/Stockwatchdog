# 🏗️ 架构设计文档

## 一、模块架构

### IIFE 模式说明

所有 JS 模块使用 **立即执行函数表达式 (IIFE)** + `return` 公开 API 模式：

```javascript
const ModuleName = (() => {
    'use strict';
    // 私有变量和函数...
    
    return {
        publicMethod1,
        publicMethod2,
    };
})();
```

**为什么不用 ES Module？** 项目无任何构建工具（Webpack/Vite/Rollup），浏览器直接通过 `<script>` 标签加载。IIFE 是唯一无需构建工具的模块化方案。**这是绝对红线，不可更改。**

---

### 6 个模块详细说明

#### 1. `ETF_CONFIG` — ETF 配置中心 (etf-config.js, 1407行)

**职责**：定义全部 ETF 品种配置和评分规则。纯数据+纯函数，无副作用。

**公开 API**：
| API | 说明 |
|-----|------|
| `ETF_TYPE` | ETF 类型枚举（a_share_index/us_share_index/hk_share_index/commodity/smart_beta/gold/bond） |
| `VALUATION_METHOD` | 估值方法枚举（multi_dim_value/growth/us/hk/broad/jp/pharma/trend_follow/bond_yield） |
| `ETF_LIST` | 19 只 ETF 的完整配置数组 |
| `SIGNAL_RULES` | 12 种信号评分规则对象（每种含 calcScores + generate 函数） |
| `getETFById(id)` | 按 ID 查找 ETF 配置 |
| `getETFByCode(code)` | 按基金代码查找 |
| `getSignalRules(key)` | 获取指定信号规则，不存在时回退 buffett_growth |
| `getAllETFIds()` | 返回全部 ETF ID 数组 |

**内部数据结构（每只 ETF 配置）**：
```javascript
{
    id: 'dividend-low-vol',       // 唯一ID（localStorage/JSON文件名/URL hash全依赖它）
    code: '512890',               // 基金代码
    name: '红利低波ETF',           // 显示名称
    shortName: '红利低波',         // Tab短名
    fullName: '华泰柏瑞红利低波动ETF', // 全名
    type: ETF_TYPE.SMART_BETA,    // 类型
    market: 'SH',                 // 交易所（SH/SZ）
    secid: '1.512890',            // 东方财富 secid（上证=1, 深证=0, 债券=171）
    color: '#28a745',             // 主题色
    icon: '💰',                   // 图标
    trackIndex: {                 // 跟踪指数
        name: '中证红利低波动指数',
        code: 'CSIH30269',
        danjuanCode: 'CSIH30269', // 蛋卷基金代码（null=不可用）
        danjuanName: '红利低波',
    },
    valuationMethod: VALUATION_METHOD.MULTI_DIM_VALUE,
    useBondSpread: true,          // 是否使用股债利差
    signalRules: 'buffett_value', // 信号规则 key
    dimWeights: { valuation: 40, safety: 30, quality: 10, sentiment: 20 }, // 四维度权重
}
```

---

#### 2. `SignalEngine` — 择时信号引擎 (signal.js, 1071行)

**职责**：所有评分计算、分位计算、历史信号回算、智能解读生成。

**公开 API**：
| API | 说明 |
|-----|------|
| `SIGNAL_LEVELS` | 10 级信号定义（STRONG_BUY→DATA_INCOMPLETE） |
| `calcSpread(divY, bondY)` | 计算股债利差 |
| `calcPercentile(value, array)` | 计算分位数（0-100） |
| `calcDeviationScore(pe, mean, std)` | PE 均值偏离度评分 |
| `calcHybridValuationScore(pe, mean, std, pctl)` | 混合估值分 = 偏离度×0.7 + 分位×0.3 |
| `generateMultiDimSignal(data, config)` | 核心：四维度综合评分 → 返回 {signal, scores, total} |
| `calcHistoricalSignals(history, config, months)` | 月级别历史信号回算 |
| `calcDailyHistoricalSignals(history, config, days)` | 日级别历史信号回算（含插值） |
| `calcScorePercentileSeries(dailySignals)` | 综合分历史分位走势 |
| `calcScoreHistoricalPercentile(score, dailySignals)` | 当前综合分在历史中的分位 |
| `getScorePercentileZone(pctl, detailed)` | 分位安全等级判定 |
| `getPercentileZone(pctl)` | 利差分位区间描述 |
| `getPEPercentileZone(pctl)` | PE 分位区间描述 |
| `getCompositeScoreZone(score)` | 综合评分区间描述 |
| `getMarketTempDesc(temp)` | 市场温度描述 |
| `generateInterpretation(scores, weights, data, config)` | 芒格式智能解读生成 |

---

#### 3. `DataAPI` — 数据获取模块 (api.js, 1129行)

**职责**：从外部 API 获取实时数据，处理 CORS 限制，数据标准化。

**核心机制**：
- **东方财富 API**：使用 JSONP 绕过 CORS（不支持 CORS 头）
- **蛋卷基金 API**：通过 4 个 CORS 代理轮询（allorigins/cors-anywhere 等）
- **CNN Fear & Greed**：用于美股/港股市场情绪
- **A 股市场广度**：上证涨跌家数比（非交易时段回退到 localStorage 缓存）

**数据标准化**：`normalizeData(rawData, jsonData, etfConfig)` 将 API 原始数据 + JSON 预设数据合并为统一的 `signalData` 对象。

---

#### 4. `DataStorage` — 存储模块 (storage.js, 90行)

**职责**：localStorage 读写，数据持久化。

**5 种 key 模式**：
| Key 模式 | 用途 |
|---------|------|
| `etf_timer_{etfId}_current` | 当前实时数据快照 |
| `etf_timer_{etfId}_history` | 历史数据缓存 |
| `etf_timer_{etfId}_records` | 用户手动记录（最多365条） |
| `etf_timer_settings` | 全局设置（刷新间隔等） |
| `dvt_a_share_breadth_last_valid` | A 股市场广度缓存（非交易时段回退用） |

---

#### 5. `ChartManager` — 图表管理模块 (charts.js, 758行)

**职责**：ECharts 图表创建和更新。

**公开 API**：
| API | 说明 |
|-----|------|
| `initGauge(id, name, reverse)` | 初始化仪表盘 |
| `updateGauge(id, value, text, color)` | 更新仪表盘数值 |
| `initLineChart(id, title, data)` | 通用折线图 |
| `initSignalHistoryChart(id, data)` | 月级别信号历史走势 |
| `initDailySignalHistoryChart(id, data, config)` | 日级别信号走势（含算法对比线） |
| `initAlgoCompareChart(id, data, config)` | 算法对比图 |
| `initScorePercentileChart(id, data, summary)` | 综合分历史分位图 |
| `resizeAll()` | 窗口 resize 时重绘所有图表 |

---

#### 6. `App` — 应用主入口 (main.js, 1854行)

**职责**：编排完整数据管线，连接所有模块。

**状态**：`currentETFId`, `etfDataCache`, `autoRefreshTimer`

**核心方法链**：
```
init() → renderTabBar() → switchETF(id) → loadETFData(config) → applyData(data, config)
         └→ bindGlobalEvents()              ├→ loadHistoryData(config)
         └→ startAutoRefresh()              └→ updateUI(data, signal, config)
                                                 ├→ renderSignalCard()
                                                 ├→ renderDimensionScores()
                                                 ├→ renderDataCards()
                                                 ├→ renderSignalHistoryChart()
                                                 ├→ renderDailySignalHistoryChart()
                                                 └→ renderScorePercentileChart()
```

---

## 二、数据流全链路

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: 初始化                                                  │
│  App.init() → 渲染TabBar → 读取URL hash → switchETF(defaultId)  │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: 加载历史数据                                             │
│  fetch(`data/${etfId}.json`) → 月度 PE/PB/股息率/利差/价格历史     │
│  → 含 valuationAnchor (peMean, peStd) 用于均值偏离度计算          │
│  失败时：从 localStorage 读取缓存                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: 获取实时API数据                                          │
│  DataAPI.fetchAllData(config) 并行获取：                           │
│    ├→ 东方财富 JSONP: ETF实时行情(价格/涨跌幅)                      │
│    ├→ 蛋卷基金 CORS: 指数PE/PB/股息率/ROE                         │
│    ├→ 东方财富 JSONP: 10Y国债收益率                                │
│    ├→ CNN Fear & Greed: 市场恐惧贪婪指数（美股/港股/日股）           │
│    └→ 上证涨跌家数: A股市场广度（A股/Smart Beta ETF）               │
│  每个请求有独立超时和fallback                                       │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: 数据标准化                                               │
│  normalizeData(apiData, jsonData, config) →                       │
│    ├→ PE分位: calcPercentile(当前PE, JSON全量PE历史) ← 【方案B】    │
│    ├→ 利差分位: calcPercentile(当前利差, JSON全量利差历史)           │
│    ├→ 混合估值分: calcHybridValuationScore(PE, mean, std, pctl)   │
│    └→ 输出统一 signalData 对象                                     │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 5: 信号计算                                                 │
│  SignalEngine.generateMultiDimSignal(signalData, config) →        │
│    ├→ rules.calcScores(data, weights) → 四维度分数                 │
│    ├→ 加权求和 → 总分 0-100                                       │
│    ├→ rules.generate(data, weights) → 8级信号关键字                │
│    └→ 返回 {signal, scores, total}                                │
│                                                                    │
│  同时回算历史：                                                     │
│    ├→ calcDailyHistoricalSignals() → 日级别走势（marketTemp统一50） │
│    └→ calcScorePercentileSeries() → 综合分历史分位走势              │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 6: UI渲染                                                   │
│    ├→ 信号卡片（颜色/文字/仪表盘）                                  │
│    ├→ 四维度评分条 + 智能解读（芒格决策矩阵）                        │
│    ├→ 数据面板（PE/PB/股息率/国债/利差/分位...）                     │
│    ├→ 图表: 日级别综合信号走势（含新旧算法对比线）                    │
│    ├→ 图表: 月级别信号历史                                          │
│    └→ 图表: 综合分历史分位                                          │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 7: 持久化                                                   │
│  DataStorage.saveCurrentData(etfId, data) → localStorage           │
│  300秒后自动刷新 → 回到 Step 3                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、核心算法

### 3.1 四维度评分体系

每只 ETF 按 `dimWeights` 配置加权四个维度（总权重 100）：

| 维度 | 计算方式 | 方向 | 权重范围 |
|------|---------|------|---------|
| **估值 (valuation)** | `calcHybridValuationScore(PE, mean, std, percentile)` | PE 越低 → 分越高 | 35-55 |
| **安全边际 (safety)** | 股债利差 或 E/P 盈利收益率 | 边际越厚 → 分越高 | 10-40 |
| **盈利质量 (quality)** | ROE + PB 修正 | ROE 越高+PB 合理 → 分越高 | 0-10 |
| **市场情绪 (sentiment)** | `100 - marketTemp` | 市场越恐惧 → 分越高 | 15-100 |

**特殊品种**：
- 黄金/商品：只有 sentiment 维度（100%趋势跟踪）
- 债券：无 quality 维度，valuation 基于收益率水平

### 3.2 calcHybridValuationScore — 混合估值分

```
混合估值分 = 偏离度分 × 0.7 + 分位分 × 0.3
```

- **偏离度分** = `50 - ((PE - peMean) / peStd) × 22.5`
  - 均值 → 50 分，-2σ → 95 分（极便宜），+2σ → 5 分（极贵）
- **分位分** = `100 - pePercentile`
  - pePercentile 是 PE 在全量历史 PE 中的百分位排名

理论依据：芒格"多把尺子"理论 — 偏离度回答"离正常水平多远"，分位回答"在历史中排第几"。

### 3.3 12 种 SIGNAL_RULES

| 规则 key | 名称 | 适用 ETF | 核心差异 |
|---------|------|---------|---------|
| `buffett_value` | 巴菲特多维估值法（价值型） | 红利低波、自由现金流 | 利差安全边际 + 利率环境因子 |
| `buffett_growth` | 芒格成长价值法 | 科创创业50、创业板50、半导体、机器人、储能、PCB | E/P 倒数安全评估 |
| `buffett_us` | 巴菲特美股估值法（宽基） | 标普500 | E/P vs 美债利差 |
| `buffett_us_growth` | 芒格美股成长法 | 纳指100 | E/P + 创新溢价 |
| `buffett_hk` | 港股多维估值法 | 恒生科技 | E/P 安全代理 |
| `buffett_hk_dividend` | 港股高股息央企估值法 | 港股央企红利 | 股息利差 + 深度破净加分 |
| `buffett_jp` | 巴菲特日股估值法 | 日经225、东证 | E/P vs 日债（低利率环境） |
| `buffett_broad` | 巴菲特宽基估值法 | 沪深300 | 股债利差 + 利率因子 |
| `buffett_pharma` | 医药行业多维估值法 | 医药ETF | E/P 绝对安全性（PE 20-50 区间） |
| `gold_trend` | 趋势跟踪法（黄金） | 黄金ETF | 纯趋势分，无估值维度 |
| `bond_yield` | 国债收益率择时法 | 十年国债 | 收益率水平 + 利率趋势 + 股市反向 |
| `commodity_trend` | 趋势跟踪法（商品） | 豆粕ETF | 纯趋势分，无估值维度 |

### 3.4 8 级信号分界线

| 总分区间 | 信号 | 颜色 | 建议 |
|---------|------|------|------|
| ≥ 80 | STRONG_BUY 强烈买入 | 🟢 深绿 `#0d7337` | 分批建仓 50%+ |
| 70-80 | BUY 买入 | 🟢 绿色 `#28a745` | 建仓 30-40% |
| 55-70 | HOLD_ADD 持有/加仓 | 🔵 浅绿 `#9be3b0` | 维持仓位 |
| 40-55 | HOLD 持有观望 | 🟡 黄色 `#ffc107` | 不加不减 |
| 25-40 | REDUCE_WARN 减仓预警 | 🟠 橙色 `#fd7e14` | 减仓至 30% |
| 15-25 | SELL 卖出 | 🔴 红色 `#dc3545` | 减仓至 20% 以下 |
| < 15 | STRONG_SELL 强烈卖出 | 🔴 深红 `#85182a` | 分批清仓 |
| 估值 ≤ 5 | OVERHEAT 估值过热 | 🔥 深红 | 停止加仓 |

另有 `NEUTRAL` (中性) 和 `DATA_INCOMPLETE` (数据不足) 两个状态。

---

## 四、数据源架构

### 4.1 东方财富 API (JSONP)

- **实时行情**: `push2.eastmoney.com/api/qt/stock/get` — ETF 价格/涨跌幅
- **历史 K 线**: `push2his.eastmoney.com/api/qt/stock/kline/get` — 历史价格
- **数据中心**: `datacenter-web.eastmoney.com/api/data/v1/get` — 估值数据
- **为什么用 JSONP**: 东方财富 API 不设置 CORS 响应头，纯前端只能用 JSONP

### 4.2 蛋卷基金 API (CORS 代理)

- **指数估值**: `danjuanfunds.com/djapi/index_eva/` — PE/PB/ROE/股息率/分位
- **为什么用代理**: 蛋卷基金 API 有 CORS 限制
- **4 个代理轮询**: allorigins → cors-anywhere → corsproxy → api.codetabs，任一可用即停

### 4.3 CNN Fear & Greed Index

- **用途**: 美股/港股/日股 ETF 的市场情绪维度
- **获取方式**: 通过 CORS 代理获取 CNN API JSON

### 4.4 A 股市场广度

- **用途**: A 股 ETF 的市场情绪维度
- **数据源**: 上证指数涨跌家数比
- **非交易时段**: 回退到 localStorage 缓存 `dvt_a_share_breadth_last_valid`

### 4.5 三级 CDN Fallback (ECharts)

```
bootcdn.net → staticfile.net → jsdelivr.net → lib/echarts.min.js (本地)
```

每级失败后通过 `onerror` 自动触发下一级加载。

---

## 五、JSON 数据文件结构

每个 `data/{etfId}.json` 包含：

```javascript
{
    // PE 历史（月度）
    "peHistory": [
        { "date": "2019-01", "value": 12.5 },
        ...
    ],
    // 利差历史（月度，部分ETF有）
    "spreadHistory": [
        { "date": "2019-01", "value": 1.23 },
        ...
    ],
    // 股息率历史
    "dividendYieldHistory": [...],
    // 国债收益率历史
    "bondYieldHistory": [...],
    // 价格历史
    "priceHistory": [...],
    // PE 均值偏离度锚定（用于 calcDeviationScore）
    "valuationAnchor": {
        "peMean": 13.2,    // PE 历史均值
        "peStd": 2.8,      // PE 历史标准差
        "updateDate": "2026-03"
    }
}
```

---

## 六、GitHub Actions CI/CD

**文件**: `.github/workflows/update-data.yml`

**触发**:
- 定时: 每月 1 日和 15 日 UTC 02:00（北京时间 10:00）
- 手动: `workflow_dispatch`（支持 `force` 参数强制更新）

**流程**:
1. checkout 仓库
2. 安装 Python 3 + 依赖
3. 运行 `scripts/auto_update_data.py`
4. 脚本从蛋卷基金/东方财富获取最新月度数据
5. 更新 `data/*.json` 文件
6. 如有变更，自动 commit + push

---

## 七、关键设计约束

1. **方案 B 统一基准**: 所有 PE 分位计算统一用 `calcPercentile(当前PE, JSON全量PE)`，不依赖 API 返回的 pePercentile
2. **历史走势图 marketTemp=50**: 历史月份无法获取真实市场情绪，统一用中性 50 保证数据一致性
3. **实时综合分 ≠ 图表基准分**: 实时含真实 marketTemp，图表统一用 50，两者基准不同不可混用
4. **null 自动跳权重**: 任何维度分数为 null 时，该维度权重自动分配给其他维度
5. **NaN 防护**: signal.js 在输入层和输出层双重清理 NaN

> 📌 这些约束的详细 Why 见 [DECISION-LOG.md](./DECISION-LOG.md)
