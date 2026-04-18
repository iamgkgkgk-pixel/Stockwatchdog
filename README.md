# 📊 ETF择时决策辅助工具

一个纯前端的 ETF 多维度择时信号工具，覆盖 19 只 ETF，基于巴菲特/芒格四维度评分体系生成买卖信号，帮助个人投资者做辅助决策。

## ✨ 功能简介

- **19 只 ETF 覆盖**：A股价值/成长/行业 + 港股 + 美股 + 日股 + 黄金 + 债券 + 商品
- **四维度评分体系**：估值分位 × 安全边际 × 盈利质量 × 市场情绪 → 综合分 0-100
- **8 级买卖信号**：从"强烈买入"到"强烈卖出"，颜色直观
- **历史走势图**：日级别综合信号走势 + 新旧算法对比
- **综合分历史分位**：当前评分在历史中排第几？
- **智能解读**：芒格式决策矩阵，给出操作建议
- **零依赖部署**：浏览器直接打开 `index.html`，无需后端

## 🚀 快速开始

```bash
# 方法1：直接打开（推荐）
open index.html

# 方法2：用任意 HTTP 服务器
npx serve .
# 或
python3 -m http.server 8080
```

打开后自动加载默认 ETF（红利低波），点击顶部 Tab 栏切换品种。

## 🏗️ 技术架构

| 技术 | 说明 |
|------|------|
| 原生 JavaScript | 6 个 IIFE 模块，无框架无构建工具 |
| ECharts 5.5.0 | 图表渲染，三级 CDN fallback |
| 原生 CSS | 暗色金融仪表盘风格 |
| 东方财富 + 蛋卷基金 API | JSONP + CORS 代理获取实时数据 |
| GitHub Actions | 每月自动更新历史数据 |

## 📋 ETF 品种列表

| 品种 | 代码 | 类型 | 信号规则 |
|------|------|------|---------|
| 红利低波 | 512890 | A股价值 | buffett_value |
| 自由现金流 | 159201 | A股价值 | buffett_value |
| 沪深300 | 510300 | A股宽基 | buffett_broad |
| 科创创业50 | 588300 | A股成长 | buffett_growth |
| 创业板50 | 159949 | A股成长 | buffett_growth |
| 医药ETF | 512010 | A股行业 | buffett_pharma |
| 科创半导体 | 588170 | A股行业 | buffett_growth |
| 机器人 | 562500 | A股行业 | buffett_growth |
| 储能 | 159566 | A股行业 | buffett_growth |
| PCB电子 | 515260 | A股行业 | buffett_growth |
| 标普500 | 513650 | 美股QDII | buffett_us |
| 纳指100 | 513110 | 美股QDII | buffett_us_growth |
| 恒生科技 | 513180 | 港股QDII | buffett_hk |
| 港股央企红利 | 513901 | 港股QDII | buffett_hk_dividend |
| 日经225 | 513520 | 日股QDII | buffett_jp |
| 东证TOPIX | 513800 | 日股QDII | buffett_jp |
| 黄金 | 518850 | 避险 | gold_trend |
| 十年国债 | 511260 | 债券 | bond_yield |
| 豆粕 | 159985 | 商品 | commodity_trend |

## 📦 数据更新

### 自动更新
GitHub Actions 每月 1 日和 15 日自动运行 `scripts/auto_update_data.py` 更新 `data/*.json`。

### 手动更新
```bash
python3 scripts/auto_update_data.py
```

## 📁 目录结构

```
├── index.html              单页面入口
├── css/style.css           暗色主题样式
├── js/
│   ├── etf-config.js       ETF配置 + 评分规则
│   ├── signal.js           择时信号引擎
│   ├── main.js             应用主入口
│   ├── charts.js           ECharts图表
│   ├── api.js              数据获取
│   └── storage.js          本地存储
├── data/                   20个JSON历史数据
├── scripts/                Python数据更新脚本
├── lib/                    ECharts本地兜底
├── .github/workflows/      CI/CD
└── .ai-context/            AI开发文档
```

## 🤖 AI 开发者指南

如果你是 AI 接手此项目进行开发，请先阅读 `.ai-context/` 目录：

1. **[PROJECT.md](.ai-context/PROJECT.md)** — 项目全景速览（5 分钟建立全局认知）
2. **[ARCHITECTURE.md](.ai-context/ARCHITECTURE.md)** — 架构与算法深度文档
3. **[RULES.md](.ai-context/RULES.md)** — ⚠️ 开发红线（必读）
4. **[DECISION-LOG.md](.ai-context/DECISION-LOG.md)** — 历史决策记录（避免重蹈覆辙）
5. **[ITERATION-GUIDE.md](.ai-context/ITERATION-GUIDE.md)** — 常见任务 SOP

## 🌐 部署

- **本地**：浏览器直接打开 `index.html`
- **GitHub Pages**：推送到 GitHub，Settings → Pages → 选择分支
- **静态服务器**：Nginx/Apache/Caddy 直接托管

## 📄 License

个人项目，仅供学习参考。
