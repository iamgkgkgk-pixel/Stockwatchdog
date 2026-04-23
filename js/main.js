/**
 * main.js - 多ETF择时助手 主逻辑模块（巴菲特多维度版）
 * 支持Tab切换不同ETF，多维度评分+信号
 */

const App = (() => {
    'use strict';

    // ========== 状态管理 ==========
    let currentETFId = null;
    let etfDataCache = {};
    let autoRefreshTimer = null;

    // ========== 初始化 ==========

    async function init() {
        showLoading(true);
        try {
            renderTabBar();
            bindGlobalEvents();
            const hash = window.location.hash.replace('#', '');
            const initialETF = (ETF_CONFIG.getETFById(hash) || ETF_CONFIG.isVIXDashboard(hash)) ? hash : ETF_CONFIG.ETF_LIST[0].id;
            await switchETF(initialETF);
            startAutoRefresh();
        } catch (e) {
            console.error('初始化失败:', e);
            showError('初始化失败，请刷新页面重试');
        } finally {
            showLoading(false);
        }
    }

    // ========== Tab Bar ==========

    function renderTabBar() {
        const tabBar = document.getElementById('tab-bar');
        if (!tabBar) return;

        const vix = ETF_CONFIG.VIX_DASHBOARD;
        const insertAfterId = vix.insertAfterETFId;

        let html = '';
        ETF_CONFIG.ETF_LIST.forEach(etf => {
            html += `
            <div class="tab-item" data-etf-id="${etf.id}" title="${etf.fullName} (${etf.code})">
                <span class="tab-icon">${etf.icon}</span>
                <span class="tab-name">${etf.shortName}</span>
                <span class="tab-signal-dot" id="tab-dot-${etf.id}" style="background:transparent;"></span>
            </div>
            `;
            // 在纳指后面插入VIX Tab
            if (etf.id === insertAfterId) {
                html += `
                <div class="tab-item tab-item-vix" data-etf-id="${vix.id}" title="VIX恐惧指数仪表盘（不参与信号计算）">
                    <span class="tab-icon">${vix.icon}</span>
                    <span class="tab-name">${vix.shortName}</span>
                    <span class="tab-vix-badge">仪表盘</span>
                </div>
                `;
            }
        });

        tabBar.innerHTML = html;

        tabBar.querySelectorAll('.tab-item').forEach(tab => {
            tab.addEventListener('click', () => {
                const etfId = tab.dataset.etfId;
                if (etfId !== currentETFId) switchETF(etfId);
            });
        });
    }

    function updateTabDot(etfId, color) {
        const dot = document.getElementById(`tab-dot-${etfId}`);
        if (dot) dot.style.background = color || 'transparent';
    }

    // ========== ETF切换 ==========

    async function switchETF(etfId) {
        // VIX 恐惧仪表盘特殊处理
        if (ETF_CONFIG.isVIXDashboard(etfId)) {
            currentETFId = etfId;
            window.location.hash = etfId;

            document.querySelectorAll('.tab-item').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.etfId === etfId);
            });

            // 切换到VIX仪表盘模式
            showVIXDashboard();
            await loadVIXDashboardData();
            return;
        }

        // 如果从VIX切换回ETF，恢复正常视图
        hideVIXDashboard();

        const etfConfig = ETF_CONFIG.getETFById(etfId);
        if (!etfConfig) return;

        currentETFId = etfId;
        window.location.hash = etfId;

        document.querySelectorAll('.tab-item').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.etfId === etfId);
        });

        document.documentElement.style.setProperty('--accent-color', etfConfig.color);
        updateHeader(etfConfig);
        renderGauges(etfConfig);
        renderDataGrid(etfConfig);
        renderStrategyContent(etfConfig);
        updateChartTitles(etfConfig);

        if (etfDataCache[etfId] && etfDataCache[etfId].loaded) {
            displayCachedData(etfId, etfConfig);
        } else {
            await loadETFData(etfId, etfConfig);
        }
    }

    function updateHeader(etfConfig) {
        const logoIcon = document.getElementById('header-logo-icon');
        const title = document.getElementById('header-title');
        const subtitle = document.getElementById('header-subtitle');

        if (logoIcon) {
            logoIcon.textContent = etfConfig.icon;
            logoIcon.style.background = `linear-gradient(135deg, ${etfConfig.color}, ${adjustColor(etfConfig.color, -40)})`;
        }
        if (title) title.textContent = `${etfConfig.name}择时助手`;
        if (subtitle) subtitle.textContent = `${etfConfig.code} · ${etfConfig.fullName}`;
    }

    function updateChartTitles(etfConfig) {
        const chart1Title = document.getElementById('chart1-title');
        const chart2Title = document.getElementById('chart2-title');
        const section2 = document.getElementById('chart-section-2');

        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.BOND) {
            if (chart1Title) chart1Title.textContent = '国债收益率历史走势';
            if (section2) section2.style.display = 'none';
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD || etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY) {
            if (chart1Title) chart1Title.textContent = '价格历史走势';
            if (section2) section2.style.display = 'none';
        } else if (etfConfig.useBondSpread) {
            if (chart1Title) chart1Title.textContent = '股债利差历史走势（近5年）';
            if (chart2Title) chart2Title.textContent = 'PE历史走势（近10年）';
            if (section2) section2.style.display = '';
        } else {
            if (chart1Title) chart1Title.textContent = 'PE历史走势';
            if (section2) section2.style.display = 'none';
        }
    }

    // ========== 动态渲染 ==========

    /**
     * 根据ETF类型返回对应的市场情绪指标配置
     * A股 → A股市场广度（涨跌家数比）
     * 美股/港股 → CNN Fear & Greed
     * 债券 → A股市场广度（反向逻辑）
     */
    function getMarketTempConfig(etfConfig) {
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.US_SHARE_INDEX) {
            return {
                label: '🌡️ 市场温度 (CNN F&G)',
                desc: '自动获取CNN恐惧贪婪指数(美股情绪)',
                source: 'cnn',
                market: '美股'
            };
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.HK_SHARE_INDEX) {
            return {
                label: '🌡️ 市场温度 (CNN F&G)',
                desc: '参考美股情绪(港股联动性强)',
                source: 'cnn',
                market: '港股(参考美股)'
            };
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.BOND) {
            return {
                label: '🌡️ A股温度 (涨跌广度)',
                desc: 'A股恐惧→利好债券(反向指标)',
                source: 'a_share_breadth',
                market: 'A股(反向)'
            };
        } else {
            // A股价值/成长/宽基/行业 (a_share_index, smart_beta)
            return {
                label: '🌡️ A股温度 (涨跌广度)',
                desc: '自动获取A股涨跌家数比',
                source: 'a_share_breadth',
                market: 'A股'
            };
        }
    }

    function renderGauges(etfConfig) {
        const section = document.getElementById('gauges-section');
        if (!section) return;

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);

        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            section.innerHTML = `
                <div class="card">
                    <div class="card-title"><span class="card-title-icon">📊</span>趋势强度</div>
                    <div class="gauge-container" id="chart-gauge-1"></div>
                    <div class="gauge-footer"><span>弱势 0%</span><span>震荡</span><span>偏强</span><span>100% 强势</span></div>
                </div>
            `;
        } else {
            // 多维度：左侧综合评分仪表盘 + 右侧四维度雷达
            section.innerHTML = `
                <div class="card">
                    <div class="card-title"><span class="card-title-icon">🎯</span>综合投资评分</div>
                    <div class="gauge-container" id="chart-gauge-1"></div>
                    <div class="gauge-footer"><span>卖出 0</span><span>减仓</span><span>持有</span><span>买入</span><span>100 强买</span></div>
                </div>
                <div class="card">
                    <div class="card-title"><span class="card-title-icon">📐</span>四维度分析</div>
                    <div class="gauge-container" id="chart-radar"></div>
                    <div class="dim-scores" id="dim-scores-list"></div>
                </div>
            `;
        }
    }

    function renderDataGrid(etfConfig) {
        const grid = document.getElementById('data-grid');
        if (!grid) return;

        let html = '';

        if (etfConfig.useBondSpread) {
            html = `
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.trackIndex.name} 股息率</div>
                    <div class="data-item-value" id="val-dividend-yield">--</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">十年期国债收益率</div>
                    <div class="data-item-value" id="val-bond-yield">--</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">股债利差（安全边际）</div>
                    <div class="data-item-value" id="val-spread">--</div>
                    <div class="data-item-sub">
                        历史分位: <span id="val-spread-percentile">--</span>
                        <span class="zone-label" id="zone-spread">--</span>
                    </div>
                    <div class="progress-bar" id="progress-spread">
                        <div class="progress-fill" style="width:0%;"></div>
                    </div>
                    <div class="progress-labels"><span>0%</span><span>20%</span><span>50%</span><span>80%</span><span>100%</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.trackIndex.name} PE</div>
                    <div class="data-item-value" id="val-pe">--</div>
                    <div class="data-item-sub">
                        历史分位: <span id="val-pe-percentile">--</span>
                        <span class="zone-label" id="zone-pe">--</span>
                    </div>
                    <div class="progress-bar" id="progress-pe">
                        <div class="progress-fill" style="width:0%;"></div>
                    </div>
                    <div class="progress-labels"><span>0%</span><span>20%</span><span>50%</span><span>80%</span><span>100%</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.trackIndex.name} PB</div>
                    <div class="data-item-value" id="val-pb">--</div>
                    <div class="data-item-sub">历史分位: <span id="val-pb-percentile">--</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.code} ETF 最新价</div>
                    <div class="data-item-value" id="val-price-card">--</div>
                    <div class="data-item-sub" id="val-change-card">日涨跌幅: --</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${getMarketTempConfig(etfConfig).label}</div>
                    <div class="data-item-value" id="val-market-temp">--</div>
                    <div class="data-item-sub" id="val-market-temp-desc">${getMarketTempConfig(etfConfig).desc}</div>
                </div>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            html = `
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.code} 最新价</div>
                    <div class="data-item-value" id="val-price-card">--</div>
                    <div class="data-item-sub" id="val-change-card">日涨跌幅: --</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">趋势判断</div>
                    <div class="data-item-value" id="val-trend">--</div>
                    <div class="data-item-sub">趋势强度: <span id="val-trend-score">--</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">说明</div>
                    <div class="data-item-value" style="font-size:13px;color:var(--text-secondary);">黄金为避险资产，<br/>无PE估值，采用趋势跟踪法</div>
                </div>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.BOND) {
            html = `
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.code} 最新价</div>
                    <div class="data-item-value" id="val-price-card">--</div>
                    <div class="data-item-sub" id="val-change-card">日涨跌幅: --</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">十年期国债收益率</div>
                    <div class="data-item-value" id="val-bond-yield">--</div>
                    <div class="data-item-sub">收益率越高=债券越便宜</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">利率趋势</div>
                    <div class="data-item-value" id="val-trend">--</div>
                    <div class="data-item-sub">趋势强度: <span id="val-trend-score">--</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${getMarketTempConfig(etfConfig).label}</div>
                    <div class="data-item-value" id="val-market-temp">--</div>
                    <div class="data-item-sub" id="val-market-temp-desc">${getMarketTempConfig(etfConfig).desc}</div>
                </div>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY) {
            html = `
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.code} 最新价</div>
                    <div class="data-item-value" id="val-price-card">--</div>
                    <div class="data-item-sub" id="val-change-card">日涨跌幅: --</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">趋势判断</div>
                    <div class="data-item-value" id="val-trend">--</div>
                    <div class="data-item-sub">趋势强度: <span id="val-trend-score">--</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">说明</div>
                    <div class="data-item-value" style="font-size:13px;color:var(--text-secondary);">商品期货无PE估值，<br/>采用趋势跟踪法</div>
                </div>
            `;
        } else {
            // 非利差类（成长/美股/港股）
            html = `
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.trackIndex.name} PE</div>
                    <div class="data-item-value" id="val-pe">--</div>
                    <div class="data-item-sub">
                        历史分位: <span id="val-pe-percentile">--</span>
                        <span class="zone-label" id="zone-pe">--</span>
                    </div>
                    <div class="progress-bar" id="progress-pe">
                        <div class="progress-fill" style="width:0%;"></div>
                    </div>
                    <div class="progress-labels"><span>0%</span><span>20%</span><span>50%</span><span>80%</span><span>100%</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.trackIndex.name} PB</div>
                    <div class="data-item-value" id="val-pb">--</div>
                    <div class="data-item-sub">历史分位: <span id="val-pb-percentile">--</span></div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${etfConfig.code} ETF 最新价</div>
                    <div class="data-item-value" id="val-price-card">--</div>
                    <div class="data-item-sub" id="val-change-card">日涨跌幅: --</div>
                </div>
                <div class="data-item">
                    <div class="data-item-label">${getMarketTempConfig(etfConfig).label}</div>
                    <div class="data-item-value" id="val-market-temp">--</div>
                    <div class="data-item-sub" id="val-market-temp-desc">${getMarketTempConfig(etfConfig).desc}</div>
                </div>
            `;
        }

        grid.innerHTML = html;
    }

    function renderStrategyContent(etfConfig) {
        const el = document.getElementById('strategy-content');
        if (!el) return;

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        const weights = etfConfig.dimWeights || {};

        let html = `
            <p><strong>当前ETF：</strong>${etfConfig.fullName} (${etfConfig.code})</p>
            <p><strong>跟踪指数：</strong>${etfConfig.trackIndex.name}</p>
            <p><strong>估值方法：</strong>${rules.name}</p>
            <p><strong>策略说明：</strong>${etfConfig.description}</p>
        `;

        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            html += `
                <p>黄金作为避险资产，没有PE/PB估值概念，采用<strong>趋势跟踪法</strong>。</p>
                <p>💡 <strong>配置逻辑：</strong>黄金与股票/债券低相关，是资产组合中的"保险"。当全球不确定性上升（地缘冲突、通胀预期）时黄金走强，当风险偏好回升时黄金回落。</p>
                <p><strong>信号规则：</strong>趋势强度 ≥85% → 过热 | ≥70% → 减仓预警 | 50-70% → 持有 | 30-50% → 加仓 | <30% → 买入 | <15% → 强烈买入</p>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.BOND) {
            html += `
                <p>国债ETF采用<strong>收益率择时法</strong>，综合3个维度评分：</p>
                <table class="signal-matrix">
                    <thead><tr><th>维度</th><th>权重</th><th>评分逻辑</th><th>策略理念</th></tr></thead>
                    <tbody>
                        <tr>
                            <td>📊 收益率水平</td>
                            <td style="font-weight:700;">${weights.valuation || 0}%</td>
                            <td>国债收益率越高=债券越便宜=分越高</td>
                            <td>高收益率时配置债券锁定收益</td>
                        </tr>
                        <tr>
                            <td>🛡️ 利率趋势</td>
                            <td style="font-weight:700;">${weights.safety || 0}%</td>
                            <td>利率下行=债券涨=分高</td>
                            <td>顺势而为，利率下行周期持有债券</td>
                        </tr>
                        <tr>
                            <td>🌡️ 股市温度(反向)</td>
                            <td style="font-weight:700;">${weights.sentiment || 0}%</td>
                            <td>股市恐慌→资金流向债券→分高</td>
                            <td>股债跷跷板：股市越冷→越利好债券</td>
                        </tr>
                    </tbody>
                </table>
                <p style="margin-top:12px;font-size:12px;color:var(--text-muted);line-height:1.7;">
                    💡 <strong>核心逻辑：</strong>十年国债ETF是"风险晴雨表"。当国债收益率高→锁定高息；利率下行周期→债券价格上涨获资本利得；股市恐慌→资金避险流入债券。三者共振时为最佳配置窗口。
                </p>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY) {
            html += `
                <p>商品ETF没有PE/PB估值概念，采用<strong>趋势跟踪法</strong>。</p>
                <p><strong>信号规则：</strong>趋势强度 ≥85% → 过热 | ≥70% → 减仓预警 | 50-70% → 持有 | 30-50% → 加仓 | <30% → 买入 | <15% → 强烈买入</p>
            `;
        } else {
            html += `
                <h4 style="margin:16px 0 8px;color:var(--text-primary);">📐 巴菲特多维度评分体系</h4>
                <p>本工具采用巴菲特/芒格投资哲学，综合4个维度加权评分，而非仅看PE分位：</p>
                <table class="signal-matrix">
                    <thead><tr><th>维度</th><th>权重</th><th>评分逻辑</th><th>巴菲特/芒格理念</th></tr></thead>
                    <tbody>
                        <tr>
                            <td>📊 估值分位</td>
                            <td style="font-weight:700;">${weights.valuation || 0}%</td>
                            <td>100 - PE历史分位</td>
                            <td>"以合理的价格买入优质公司"</td>
                        </tr>
                        <tr>
                            <td>🛡️ 安全边际</td>
                            <td style="font-weight:700;">${weights.safety || 0}%</td>
                            <td>${etfConfig.useBondSpread ? '股息率 - 国债收益率' : 'E/P收益率 vs 无风险利率'}</td>
                            <td>"永远不要亏损"</td>
                        </tr>
                        <tr>
                            <td>💪 盈利质量</td>
                            <td style="font-weight:700;">${weights.quality || 0}%</td>
                            <td>ROE + PB合理性</td>
                            <td>"买入拥有持久竞争优势的公司"</td>
                        </tr>
                        <tr>
                            <td>🌡️ 市场温度</td>
                            <td style="font-weight:700;">${weights.sentiment || 0}%</td>
                            <td>100 - 市场贪婪指数</td>
                            <td>"在别人恐惧时贪婪"</td>
                        </tr>
                    </tbody>
                </table>

                <h4 style="margin:16px 0 8px;color:var(--text-primary);">🎯 综合评分 → 信号映射</h4>
                <table class="signal-matrix">
                    <thead><tr><th>总分区间</th><th>信号</th><th>建议</th></tr></thead>
                    <tbody>
                        <tr><td>≥80</td><td style="color:#0d7337;font-weight:700;">强烈买入</td><td>分批建仓50%+</td></tr>
                        <tr><td>70-80</td><td style="color:#28a745;font-weight:700;">买入</td><td>建仓30-40%</td></tr>
                        <tr><td>55-70</td><td style="color:#9be3b0;font-weight:700;">持有/加仓</td><td>维持仓位</td></tr>
                        <tr><td>40-55</td><td style="color:#ffc107;font-weight:700;">持有观望</td><td>不加不减</td></tr>
                        <tr><td>25-40</td><td style="color:#fd7e14;font-weight:700;">减仓预警</td><td>减仓至30%</td></tr>
                        <tr><td>15-25</td><td style="color:#dc3545;font-weight:700;">卖出</td><td>减仓至20%以下</td></tr>
                        <tr><td><15</td><td style="color:#85182a;font-weight:700;">强烈卖出</td><td>尽快撤出</td></tr>
                    </tbody>
                </table>

                <p style="margin-top:12px;font-size:12px;color:var(--text-muted);line-height:1.7;">
                    💡 <strong>市场温度</strong>已自动获取：${
                        etfConfig.type === ETF_CONFIG.ETF_TYPE.US_SHARE_INDEX || etfConfig.type === ETF_CONFIG.ETF_TYPE.HK_SHARE_INDEX
                        ? 'CNN Fear & Greed Index（综合VIX恐慌指数 + 市场动量 + 看跌/看涨期权比 + 股市广度 + 垃圾债需求 + 安全港需求 + 市场强度共7个维度加权，反映<strong>美股情绪</strong>）'
                        : 'A股市场广度指标（上证涨跌家数比，反映<strong>A股实际情绪</strong>——涨多跌少=贪婪，跌多涨少=恐惧）'
                    }。0=极度恐惧，50=中性，100=极度贪婪。也可在"补充数据"中手动覆盖。
                </p>
            `;
        }

        el.innerHTML = html;
    }

    // ========== 数据加载 ==========

    async function loadETFData(etfId, etfConfig) {
        updateDataSourceStatus('fetching');

        if (!etfDataCache[etfId]) {
            etfDataCache[etfId] = { loaded: false, historyData: null, currentSignal: null, lastApiData: null, currentData: null };
        }

        try {
            const historyData = await loadHistoryData(etfId);
            etfDataCache[etfId].historyData = historyData;
            initChartsForETF(etfConfig, historyData);

            const apiData = await DataAPI.fetchAllDataForETF(etfConfig);
            etfDataCache[etfId].lastApiData = apiData;

            if (apiData.success) {
                let savedManual = DataStorage.getCurrentData(etfId);
                const fallback = historyData ? historyData.currentData : {};
                const manualOverride = {};

                // 辅助函数：安全取第一个有效数值（区分0和undefined/null）
                const _pickValid = (...vals) => {
                    for (const v of vals) {
                        if (v !== null && v !== undefined && v !== '' && !isNaN(v)) return v;
                    }
                    return undefined;
                };

                // ========== 缓存数据合理性校验（防止旧缓存污染信号）==========
                // 仅检查PE值偏差（PE是客观值，不受基准影响）
                // 【方案B】移除pePercentile偏差检查：API和本地calcPercentile基准不同，差异是正常的
                if (savedManual && fallback && fallback.pe > 0) {
                    const cachedPE = savedManual.pe || 0;
                    const presetPE = fallback.pe || 0;

                    let cacheStale = false;
                    // 检查PE偏差：如果缓存PE与预设PE差异>50%，判定为过期缓存
                    if (cachedPE > 0 && presetPE > 0 && Math.abs(cachedPE - presetPE) / presetPE > 0.5) {
                        console.warn(`⚠️ [${etfId}] localStorage缓存PE(${cachedPE.toFixed(1)})与JSON预设PE(${presetPE.toFixed(1)})偏差过大，清除旧缓存`);
                        cacheStale = true;
                    }

                    if (cacheStale) {
                        console.info(`🧹 [${etfId}] 清除过期localStorage缓存，使用JSON预设数据`);
                        DataStorage.clearETFData(etfId);
                        savedManual = null; // 不再使用旧缓存
                    }
                }

                // 【方案B】API成功获取估值时，同步更新historyData中的currentData锚点
                // 这样即使下次API不可用，回退到JSON预设时也能用到最新值
                if (apiData.valuation && historyData && historyData.currentData) {
                    const v = apiData.valuation;
                    if (v.pe > 0) historyData.currentData.pe = v.pe;
                    if (v.pePercentile > 0) historyData.currentData.pePercentile = v.pePercentile;
                    if (v.pb > 0) historyData.currentData.pb = v.pb;
                    if (v.pbPercentile > 0) historyData.currentData.pbPercentile = v.pbPercentile;
                    if (v.dividendYield > 0) historyData.currentData.dividendYield = v.dividendYield;
                    historyData.currentData.updateTime = new Date().toISOString().slice(0, 10);
                    console.info(`🔄 [${etfId}] API估值已同步到historyData.currentData: PE=${v.pe}, pePercentile=${v.pePercentile}%`);
                }

                if (!apiData.valuation) {
                    // 优先级调整：JSON预设(fallback) 优先于 localStorage缓存(savedManual)
                    // 原因：JSON是开发者校准的基准数据，localStorage可能因切换ETF代码等原因残留旧值
                    const dv = _pickValid(fallback && fallback.dividendYield, savedManual && savedManual.dividendYield);
                    const pe = _pickValid(fallback && fallback.pe, savedManual && savedManual.pe);
                    const pb = _pickValid(fallback && fallback.pb, savedManual && savedManual.pb);
                    const pePct = _pickValid(fallback && fallback.pePercentile, savedManual && savedManual.pePercentile);
                    const pbPct = _pickValid(fallback && fallback.pbPercentile, savedManual && savedManual.pbPercentile);
                    if (dv !== undefined) manualOverride.dividendYield = dv;
                    if (pe !== undefined) manualOverride.pe = pe;
                    if (pb !== undefined) manualOverride.pb = pb;
                    if (pePct !== undefined) manualOverride.pePercentile = pePct;
                    if (pbPct !== undefined) manualOverride.pbPercentile = pbPct;
                    console.info(`📊 [${etfId}] 估值数据来源: PE=${pe}, pePercentile=${pePct}% (来自${fallback && fallback.pe > 0 ? 'JSON预设' : 'localStorage缓存'})`);
                }

                const normalized = DataAPI.normalizeData(apiData, manualOverride);

                // 合并手动保存的趋势分数 / ROE
                if (savedManual) {
                    // 市场温度：API自动获取优先，手动设置仅在API未获取时使用
                    if (!normalized.marketTempAutoFetched && savedManual.marketTemp !== null && savedManual.marketTemp !== undefined) {
                        normalized.marketTemp = savedManual.marketTemp;
                    }
                    if (savedManual.trendScore !== null && savedManual.trendScore !== undefined) normalized.trendScore = savedManual.trendScore;
                    if (savedManual.roe) normalized.roe = savedManual.roe;
                }

                applyData(etfId, etfConfig, normalized, historyData);
                updateDataSourceStatus('success', apiData);

                const hasVal = apiData.valuation && (apiData.valuation.pe > 0 || apiData.valuation.dividendYield > 0);
                const hasSentiment = (apiData.fearGreed && apiData.fearGreed.score !== null) || (apiData.aShareBreadth && apiData.aShareBreadth.score !== null);
                let toastMsg = '实时数据已自动获取 ✅';
                if (!hasVal && !hasSentiment) toastMsg = '行情已获取（估值/情绪使用预设值）';
                else if (!hasVal) toastMsg = '行情+市场情绪已获取（估值使用预设值）';
                else if (!hasSentiment) toastMsg = '行情+估值已获取（市场情绪使用预设值）';
                showToast(toastMsg, 'success');
            } else {
                const savedData = DataStorage.getCurrentData(etfId);
                if (savedData) applyData(etfId, etfConfig, savedData, historyData);
                else if (historyData && historyData.currentData) applyData(etfId, etfConfig, historyData.currentData, historyData);
                updateDataSourceStatus('error', apiData);
                showToast('数据获取失败，显示缓存/预设数据', 'error');
            }

            etfDataCache[etfId].loaded = true;
            updateTimestamp(etfId);

        } catch (e) {
            console.error(`加载 ${etfId} 数据失败:`, e);
            showToast('数据加载异常: ' + e.message, 'error');
            try {
                const savedData = DataStorage.getCurrentData(etfId);
                const historyData = etfDataCache[etfId].historyData;
                if (savedData) applyData(etfId, etfConfig, savedData, historyData);
                else if (historyData && historyData.currentData) applyData(etfId, etfConfig, historyData.currentData, historyData);
            } catch (_) {}
        }
    }

    function displayCachedData(etfId, etfConfig) {
        const cache = etfDataCache[etfId];
        if (!cache) return;
        initChartsForETF(etfConfig, cache.historyData);
        if (cache.currentData) applyData(etfId, etfConfig, cache.currentData, cache.historyData, true);
        if (cache.lastApiData) updateDataSourceStatus('success', cache.lastApiData);
        updateTimestamp(etfId);
    }

    async function loadHistoryData(etfId) {
        try {
            const resp = await fetch(`data/${etfId}.json`);
            if (resp.ok) {
                const data = await resp.json();
                console.log(`[loadHistoryData] ${etfId}: 加载成功`, {
                    peHistory: data.peHistory ? data.peHistory.length : 0,
                    spreadHistory: data.spreadHistory ? data.spreadHistory.length : 0,
                    bondYieldHistory: data.bondYieldHistory ? data.bondYieldHistory.length : 0,
                    dividendYieldHistory: data.dividendYieldHistory ? data.dividendYieldHistory.length : 0,
                    priceHistory: data.priceHistory ? data.priceHistory.length : 0,
                });
                DataStorage.saveHistoryData(etfId, data);
                return data;
            } else {
                console.warn(`[loadHistoryData] ${etfId}: fetch返回 ${resp.status}`);
            }
        } catch (e) {
            console.warn(`[loadHistoryData] ${etfId}: fetch失败`, e.message);
        }

        const cached = DataStorage.getHistoryData(etfId);
        if (cached) {
            console.log(`[loadHistoryData] ${etfId}: 使用localStorage缓存数据`);
            return cached;
        }

        console.warn(`[loadHistoryData] ${etfId}: 无数据，使用默认空数据`);
        return getDefaultHistoryData();
    }

    function getDefaultHistoryData() {
        return {
            spreadHistory: [], peHistory: [], dividendYieldHistory: [], bondYieldHistory: [],
            currentData: {
                dividendYield: 0, bondYield: 0, spread: 0, spreadPercentile: 0,
                pe: 0, pePercentile: 0, pb: 0, pbPercentile: 0,
                price: 0, priceChange: 0, updateTime: ''
            }
        };
    }

    // ========== 数据应用（核心 — 多维度信号生成）==========

    function applyData(etfId, etfConfig, data, historyData, skipSave) {
        const peAvailable = data.pe && data.pe > 0;
        const dividendAvailable = data.dividendYield && data.dividendYield > 0;
        const bondAvailable = data.bondYield && data.bondYield > 0;
        const canCalcSpread = etfConfig.useBondSpread && dividendAvailable && bondAvailable;

        const spread = canCalcSpread ? SignalEngine.calcSpread(data.dividendYield, data.bondYield) : 0;

        // 计算分位数 — API优先，本地兜底
        const spreadValues = (historyData && historyData.spreadHistory && historyData.spreadHistory.length >= 12) ? historyData.spreadHistory.map(d => d.value) : [];
        const peValues = (historyData && historyData.peHistory && historyData.peHistory.length >= 12) ? historyData.peHistory.map(d => d.value) : [];

        let spreadPercentile = null;
        if (canCalcSpread) {
            if (data.spreadPercentile !== null && data.spreadPercentile !== undefined && !isNaN(data.spreadPercentile)) spreadPercentile = data.spreadPercentile;
            else if (spreadValues.length > 0) spreadPercentile = SignalEngine.calcPercentile(spread, spreadValues);
        }

        // 【方案B修正】PE分位计算：统一使用本地calcPercentile，与走势图同一基准
        // 修正原因：之前实时信号用API pePercentile（十年全市场~81%），走势图用本地calcPercentile（JSON 76个PE点~28%），
        //          导致同一天的估值分从19→72（差53分），总分从37→60（差23分），走势图和信号卡严重矛盾。
        // 现在：信号计算统一用本地calcPercentile，API pePercentile仅作为参考显示在数据卡片上。
        let pePercentile = null;
        let apiPePercentile = null; // API返回的分位（仅用于数据卡片展示参考，不参与信号计算）
        if (peAvailable) {
            // 保存API分位（仅展示用）
            if (data.pePercentile !== null && data.pePercentile !== undefined && !isNaN(data.pePercentile)) {
                apiPePercentile = data.pePercentile;
            }
            // 信号计算统一用本地calcPercentile（与走势图同一基准）
            if (peValues.length > 0) {
                pePercentile = SignalEngine.calcPercentile(data.pe, peValues);
            }
            // 对比日志
            if (apiPePercentile !== null && pePercentile !== null) {
                const diff = Math.abs(apiPePercentile - pePercentile);
                if (diff > 10) {
                    console.info(`📊 [${etfId}] PE分位: 信号用本地=${pePercentile.toFixed(1)}% (JSON ${peValues.length}点), API参考=${apiPePercentile.toFixed(1)}% (十年全市场), 差${diff.toFixed(1)}pp`);
                }
            }
        }

        // 商品/黄金/债券类：趋势分数
        let trendScore = null;
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD || etfConfig.type === ETF_CONFIG.ETF_TYPE.BOND) {
            trendScore = (data.trendScore !== null && data.trendScore !== undefined) ? data.trendScore : null;
        }

        // 构建多维度输入数据（NaN防护：确保所有数值字段有效）
        const safeNum = (v) => (v !== null && v !== undefined && !isNaN(v)) ? v : null;
        const safeNumOr0 = (v) => (v !== null && v !== undefined && !isNaN(v)) ? v : 0;

        // 获取valuationAnchor（均值偏离度锚点）
        const anchor = (historyData && historyData.valuationAnchor) || {};

        const signalData = {
            pePercentile: safeNum(pePercentile),
            spreadPercentile: safeNum(spreadPercentile),
            trendScore: safeNum(trendScore),
            pe: safeNumOr0(data.pe),
            pb: safeNumOr0(data.pb),
            dividendYield: safeNumOr0(data.dividendYield),
            bondYield: safeNumOr0(data.bondYield),
            roe: safeNumOr0(data.roe),
            marketTemp: safeNum(data.marketTemp),
            // 巴菲特均值回归锚点
            peMean: safeNum(anchor.peMean),
            peStd: safeNum(anchor.peStd),
        };

        // 日志：输出实际用于信号计算的关键数据（方便调试信号与预期不符的问题）
        console.info(`🎯 [${etfId}] 信号计算输入: PE=${signalData.pe}, pePercentile=${signalData.pePercentile !== null ? signalData.pePercentile.toFixed(1) + '%' : 'null'}, marketTemp=${signalData.marketTemp !== null ? signalData.marketTemp : 'null'}, roe=${signalData.roe}`);

        // 生成多维度综合信号
        const { signal: currentSignal, scores, total } = SignalEngine.generateMultiDimSignal(signalData, etfConfig);
        console.info(`🎯 [${etfId}] 信号结果: 总分=${total.toFixed(1)}, 信号=${currentSignal.text}, 各维度=`, JSON.stringify(scores));

        // 更新UI
        updateSignalDisplay(currentSignal, total);
        updateDataCardsValues(etfConfig, data, spread, spreadPercentile, pePercentile, peAvailable, dividendAvailable, canCalcSpread, trendScore, apiPePercentile);
        updateGaugeValues(etfConfig, total, scores, trendScore);
        updateDimScoresDisplay(etfConfig, scores);
        updatePriceDisplay(data, etfConfig);

        // 刷新综合信号历史走势图（传入当前市场温度，使最新月份与实时信号一致）
        // 【方案B增强】同时传入实时PE等估值数据，让走势图的当月数据能反映最新PE变化
        // 关键判断：只有当PE确实来自API实时获取（data.valuationSource存在）时才注入
        // 如果API失败、PE来自JSON预设值，注入后与JSON最后一个月PE相同，插值无差异，反而可能引起混淆
        const hasRealtimePE = data.pe && data.pe > 0 && data.valuationSource;
        const realtimeValuation = hasRealtimePE ? {
            pe: data.pe,
            dividendYield: data.dividendYield || 0,
            bondYield: data.bondYield || 0,
        } : null;
        if (historyData) {
            renderSignalHistoryChart(etfConfig, historyData, signalData.marketTemp, realtimeValuation);
            renderScorePercentileChart(etfConfig, historyData, signalData.marketTemp, total, realtimeValuation);
            renderDailySignalHistoryChart(etfConfig, historyData, signalData.marketTemp, realtimeValuation);
            renderAlgoCompareChart(etfConfig, historyData, signalData.marketTemp, realtimeValuation);
        }

        // 更新信号方法标签
        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        const methodEl = document.getElementById('signal-method');
        if (methodEl) methodEl.textContent = `📐 ${rules.name} | 综合评分: ${total.toFixed(1)}分`;

        // 更新芒格式智能解读区
        updateInterpretationDisplay(scores, etfConfig, signalData);

        // 缓存
        etfDataCache[etfId] = etfDataCache[etfId] || {};
        etfDataCache[etfId].currentSignal = currentSignal;
        etfDataCache[etfId].currentData = { ...data, spread, spreadPercentile, pePercentile };
        etfDataCache[etfId].scores = scores;
        etfDataCache[etfId].total = total;

        updateTabDot(etfId, currentSignal.color);

        if (!skipSave) {
            DataStorage.saveCurrentData(etfId, {
                ...data, spread, spreadPercentile, pePercentile,
                signal: currentSignal.text, compositeScore: total
            });
        }
    }

    // ========== UI更新 ==========

    function updateSignalDisplay(signal, total) {
        const heroSection = document.getElementById('hero-section');
        const signalText = document.getElementById('signal-text');
        const signalAdvice = document.getElementById('signal-advice');
        const signalPosition = document.getElementById('signal-position');
        const signalIcon = document.getElementById('signal-icon');

        if (heroSection) {
            heroSection.style.background = `linear-gradient(135deg, ${signal.bgColor}22, ${signal.bgColor}44)`;
            heroSection.style.borderColor = signal.borderColor;
        }
        if (signalText) {
            signalText.textContent = signal.text;
            signalText.style.color = signal.color;
        }
        if (signalAdvice) signalAdvice.textContent = signal.advice;
        if (signalPosition) {
            signalPosition.textContent = `${signal.position} | 评分: ${total ? total.toFixed(1) : '--'}`;
            signalPosition.style.backgroundColor = signal.bgColor + '33';
            signalPosition.style.color = signal.color;
            signalPosition.style.borderColor = signal.borderColor;
        }
        if (signalIcon) signalIcon.textContent = signal.icon;
    }

    /**
     * 渲染芒格式智能解读区
     */
    function updateInterpretationDisplay(scores, etfConfig, signalData) {
        const container = document.getElementById('signal-interpretation');
        if (!container) return;

        const interp = SignalEngine.generateInterpretation(
            scores, etfConfig.dimWeights || {}, signalData, etfConfig
        );

        // 黄金/商品等无多维度解读的品种，隐藏此区域
        if (!interp) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = '';

        let html = '<div class="interp-header">🧠 芒格式维度解读</div>';

        // 维度解读条目
        html += '<div class="interp-dims">';
        interp.items.forEach(item => {
            const pct = Math.max(0, Math.min(100, item.score));
            html += `<div class="interp-dim-item">
                <div class="interp-dim-head">
                    <span class="interp-dim-icon">${item.icon}</span>
                    <span class="interp-dim-title">${item.title}</span>
                    <span class="interp-dim-score" style="color:${item.color}">${item.score.toFixed(0)}分</span>
                    <span class="interp-dim-weight">权重${item.weight}%</span>
                </div>
                <div class="interp-dim-bar-bg">
                    <div class="interp-dim-bar-fill" style="width:${pct}%;background:${item.color}"></div>
                </div>
                <div class="interp-dim-desc">${item.desc}</div>
            </div>`;
        });
        html += '</div>';

        // 综合操作建议
        if (interp.action) {
            html += `<div class="interp-action" style="border-left-color:${interp.action.color}">
                <span class="interp-action-icon">${interp.action.icon}</span>
                <span class="interp-action-text">${interp.action.text}</span>
            </div>`;
        }

        // 维度分歧提示
        if (interp.note) {
            html += `<div class="interp-note">${interp.note}</div>`;
        }

        container.innerHTML = html;
    }

    function updateDataCardsValues(etfConfig, data, spread, spreadPercentile, pePercentile, peAvailable, dividendAvailable, canCalcSpread, trendScore, apiPePercentile) {
        if (document.getElementById('val-dividend-yield')) {
            setText('val-dividend-yield', dividendAvailable ? data.dividendYield.toFixed(2) + '%' : '待补充');
            if (!dividendAvailable) setTextColor('val-dividend-yield', '#ffc107');
        }
        if (document.getElementById('val-bond-yield')) {
            setText('val-bond-yield', (data.bondYield && data.bondYield > 0) ? data.bondYield.toFixed(2) + '%' : '--');
        }
        if (document.getElementById('val-spread')) {
            if (canCalcSpread) {
                setText('val-spread', spread.toFixed(2) + '%');
                if (spreadPercentile !== null) {
                    setText('val-spread-percentile', spreadPercentile.toFixed(2) + '%');
                    updateProgressBar('progress-spread', spreadPercentile, 'spread');
                    updateZoneLabel('zone-spread', SignalEngine.getPercentileZone(spreadPercentile));
                }
            } else {
                setText('val-spread', '待补充');
                setTextColor('val-spread', '#ffc107');
            }
        }
        if (document.getElementById('val-pe')) {
            if (peAvailable) {
                setText('val-pe', data.pe.toFixed(2));
                setTextColor('val-pe', '');
                if (pePercentile !== null) {
                    // 展示本地分位（用于信号计算）+ API参考（如果有且差异大）
                    let percentileText = pePercentile.toFixed(2) + '%';
                    if (apiPePercentile !== null && apiPePercentile !== undefined) {
                        const diff = Math.abs(apiPePercentile - pePercentile);
                        if (diff > 5) {
                            percentileText += ` <span style="font-size:10px;opacity:0.6;">(蛋卷:${apiPePercentile.toFixed(0)}%)</span>`;
                        }
                    }
                    const el = document.getElementById('val-pe-percentile');
                    if (el) el.innerHTML = percentileText;
                    updateProgressBar('progress-pe', pePercentile, 'pe');
                    updateZoneLabel('zone-pe', SignalEngine.getPEPercentileZone(pePercentile));
                }
            } else {
                setText('val-pe', '待补充');
                setTextColor('val-pe', '#ffc107');
            }
        }
        if (document.getElementById('val-pb')) {
            setText('val-pb', data.pb ? data.pb.toFixed(2) : '--');
            setText('val-pb-percentile', (data.pbPercentile || 0).toFixed(2) + '%');
        }
        if (document.getElementById('val-trend')) {
            setText('val-trend', trendScore !== null ? (trendScore >= 50 ? '偏强' : '偏弱') : '--');
            setText('val-trend-score', trendScore !== null ? trendScore.toFixed(0) + '%' : '--');
        }
        // 市场温度（区分来源显示）
        if (document.getElementById('val-market-temp')) {
            const temp = data.marketTemp;
            if (temp !== null && temp !== undefined && !isNaN(temp)) {
                const desc = SignalEngine.getMarketTempDesc(temp);
                setText('val-market-temp', temp.toFixed(0));
                setTextColor('val-market-temp', desc.color);
                const descEl = document.getElementById('val-market-temp-desc');
                if (descEl) {
                    const sourceTag = data.marketTempAutoFetched ? '🔄 自动' : '✏️ 手动';
                    const isCached = data.aShareBreadthIsCachedFallback;

                    // 根据数据来源生成不同的描述
                    let ratingText = '';
                    let detailText = '';
                    if (data.marketTempSource === 'a_share_breadth') {
                        // A股市场广度来源
                        ratingText = data.aShareBreadthRating ? ` · ${data.aShareBreadthRating}` : '';
                        if (data.aShareBreadthUpCount > 0) {
                            detailText = ` <span style="font-size:10px;opacity:0.6;">涨${data.aShareBreadthUpCount}/跌${data.aShareBreadthDownCount}</span>`;
                        }
                        // 非交易时段缓存回退标识
                        if (isCached) {
                            detailText += ` <span style="font-size:10px;color:#ffc107;">📦 最近交易日</span>`;
                        }
                    } else if (data.marketTempSource === 'cnn') {
                        // CNN F&G来源（美股/港股原生）
                        ratingText = data.fearGreedRating ? ` · ${data.fearGreedRating}` : '';
                    } else if (data.marketTempSource === 'cnn_fallback') {
                        // CNN F&G兜底来源（A股广度不可用时替代）
                        ratingText = data.fearGreedRating ? ` · ${data.fearGreedRating}` : '';
                        detailText = ` <span style="font-size:10px;color:#ffc107;">🔄 CNN兜底(A股广度不可用)</span>`;
                    } else {
                        ratingText = data.fearGreedRating ? ` · ${data.fearGreedRating}` : (data.aShareBreadthRating ? ` · ${data.aShareBreadthRating}` : '');
                    }

                    descEl.innerHTML = `${desc.text}${ratingText}${detailText} <span style="font-size:10px;opacity:0.7;">(${sourceTag})</span>`;
                    descEl.style.color = desc.color;
                }
            } else {
                setText('val-market-temp', '获取中...');
                setTextColor('val-market-temp', '#ffc107');
                const descEl = document.getElementById('val-market-temp-desc');
                if (descEl) {
                    const tempConfig = getMarketTempConfig(etfConfig);
                    descEl.textContent = tempConfig.desc;
                    descEl.style.color = '';
                }
            }
        }
    }

    function updateGaugeValues(etfConfig, total, scores, trendScore) {
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            const g1 = ChartManager.getGaugeChart(1);
            if (trendScore !== null) {
                ChartManager.updateGauge(g1, trendScore.toFixed(0), '趋势强度');
            } else {
                ChartManager.updateGaugePending(g1, '趋势强度');
            }
        } else {
            // 综合评分仪表盘
            const g1 = ChartManager.getGaugeChart(1);
            if (total > 0) {
                ChartManager.updateGauge(g1, total.toFixed(1), '综合投资评分');
            } else {
                ChartManager.updateGaugePending(g1, '综合投资评分');
            }

            // 雷达图
            renderRadarChart(etfConfig, scores);
        }
    }

    function updateDimScoresDisplay(etfConfig, scores) {
        const list = document.getElementById('dim-scores-list');
        if (!list) return;

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        const names = rules.dimensionNames || {};

        let html = '';
        Object.keys(scores).forEach(dim => {
            const score = scores[dim];
            const name = names[dim] || dim;
            const val = score !== null && score !== undefined ? score.toFixed(0) : '--';
            const zone = score !== null ? SignalEngine.getCompositeScoreZone(score) : { color: '#718096' };
            html += `<div class="dim-score-item">
                <span class="dim-score-name">${name}</span>
                <span class="dim-score-val" style="color:${zone.color}">${val}</span>
            </div>`;
        });

        list.innerHTML = html;
    }

    function renderRadarChart(etfConfig, scores) {
        const dom = document.getElementById('chart-radar');
        if (!dom) return;

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        const names = rules.dimensionNames || {};
        const dims = rules.dimensions || [];

        // 准备数据
        const indicators = dims.map(d => ({
            name: (names[d] || d).replace(/^[^\s]+\s/, ''), // 去掉emoji前缀
            max: 100
        }));
        const values = dims.map(d => (scores[d] !== null && scores[d] !== undefined) ? scores[d] : 0);

        // 初始化或更新图表
        let chart = echarts.getInstanceByDom(dom);
        if (!chart) chart = echarts.init(dom);

        chart.setOption({
            backgroundColor: 'transparent',
            radar: {
                indicator: indicators,
                shape: 'polygon',
                radius: '65%',
                axisLine: { lineStyle: { color: '#2d3748' } },
                splitLine: { lineStyle: { color: '#2d3748' } },
                splitArea: { areaStyle: { color: ['transparent'] } },
                axisName: { color: '#a0aec0', fontSize: 11 },
            },
            series: [{
                type: 'radar',
                data: [{
                    value: values,
                    areaStyle: { color: etfConfig.color + '33' },
                    lineStyle: { color: etfConfig.color, width: 2 },
                    itemStyle: { color: etfConfig.color },
                    symbol: 'circle',
                    symbolSize: 6,
                }],
                animationDuration: 800,
            }]
        });
    }

    function updatePriceDisplay(data, etfConfig) {
        const priceEl = document.getElementById('val-price');
        const changeEl = document.getElementById('val-price-change');
        const priceCardEl = document.getElementById('val-price-card');
        const changeCardEl = document.getElementById('val-change-card');

        const price = data.price || 0;
        const change = data.priceChange || 0;
        const isHK = etfConfig && etfConfig.type === ETF_CONFIG.ETF_TYPE.HK_SHARE_INDEX;
        const currency = isHK ? 'HK$' : '¥';
        const changeText = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
        const changeClass = change >= 0 ? 'up' : 'down';
        const changeColor = change >= 0 ? '#ef4444' : '#28a745';

        if (priceEl) priceEl.textContent = price > 0 ? currency + price.toFixed(3) : '--';
        if (changeEl) {
            changeEl.textContent = price > 0 ? changeText : '--';
            changeEl.className = 'price-change ' + (price > 0 ? changeClass : '');
        }
        if (priceCardEl) priceCardEl.textContent = price > 0 ? currency + price.toFixed(3) : '--';
        if (changeCardEl) {
            changeCardEl.textContent = price > 0 ? '日涨跌幅: ' + changeText : '日涨跌幅: --';
            if (price > 0) changeCardEl.style.color = changeColor;
        }
    }

    function updateProgressBar(id, value, type) {
        const bar = document.getElementById(id);
        if (!bar) return;
        const fill = bar.querySelector('.progress-fill');
        if (fill) {
            fill.style.width = value + '%';
            if (type === 'spread') {
                if (value >= 80) fill.style.backgroundColor = '#28a745';
                else if (value >= 50) fill.style.backgroundColor = '#9be3b0';
                else if (value >= 20) fill.style.backgroundColor = '#ffc107';
                else fill.style.backgroundColor = '#dc3545';
            } else {
                if (value >= 80) fill.style.backgroundColor = '#dc3545';
                else if (value >= 50) fill.style.backgroundColor = '#ffc107';
                else if (value >= 20) fill.style.backgroundColor = '#9be3b0';
                else fill.style.backgroundColor = '#28a745';
            }
        }
    }

    function updateZoneLabel(id, zone) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = zone.text;
        el.style.color = zone.color;
    }

    function updateTimestamp(etfId) {
        const el = document.getElementById('update-time');
        if (el) {
            const saved = DataStorage.getCurrentData(etfId || currentETFId);
            if (saved && saved.timestamp) {
                const dataAge = Date.now() - new Date(saved.timestamp).getTime();
                const hours = Math.floor(dataAge / 3600000);
                const isStale = hours >= 24;
                if (saved.updateTime) {
                    el.textContent = '数据更新: ' + saved.updateTime + (isStale ? ` ⚠️(${hours}h前)` : '');
                    el.style.color = isStale ? '#ffc107' : '';
                } else {
                    el.textContent = '数据更新: ' + formatDateTime(new Date());
                }
            } else {
                el.textContent = '数据更新: ' + formatDateTime(new Date());
            }
        }
    }

    function updateDataSourceStatus(status, apiData) {
        const statusEl = document.getElementById('data-source-status');
        if (!statusEl) return;
        switch (status) {
            case 'fetching':
                statusEl.innerHTML = '<span class="status-dot status-loading"></span> 正在获取数据...';
                break;
            case 'success':
                const sources = [];
                if (apiData && apiData.etf) sources.push('ETF行情✅');
                if (apiData && apiData.bond) sources.push('国债收益率✅');
                if (apiData && apiData.valuation) {
                    const src = apiData.valuation.source ? `(${apiData.valuation.source})` : '';
                    sources.push(`估值数据✅${src}`);
                } else {
                    sources.push('估值:预设值⚠️');
                }
                if (apiData && apiData.fearGreed) {
                    sources.push(`市场温度✅(CNN F&G:${apiData.fearGreed.score.toFixed(0)}·美股)`);
                } else if (apiData && apiData.aShareBreadth) {
                    const cachedTag = apiData.aShareBreadth.isCachedFallback ? '📦缓存' : '';
                    sources.push(`市场温度✅(A股广度:${apiData.aShareBreadth.score}${cachedTag}·涨${apiData.aShareBreadth.upCount}/跌${apiData.aShareBreadth.downCount})`);
                } else if (apiData && apiData.fearGreedFallback) {
                    sources.push(`市场温度✅(CNN F&G兜底:${apiData.fearGreedFallback.score.toFixed(0)}·A股广度不可用)`);
                } else {
                    sources.push('市场温度:默认⚠️');
                }
                statusEl.innerHTML = '<span class="status-dot status-ok"></span> ' + sources.join(' | ');
                break;
            case 'error':
                const errMsg = apiData && apiData.errors ? apiData.errors.join('; ') : '获取失败';
                statusEl.innerHTML = '<span class="status-dot status-err"></span> ' + errMsg;
                break;
            default:
                statusEl.innerHTML = '';
        }
    }

    // ========== 图表 ==========

    function initChartsForETF(etfConfig, historyData) {
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            ChartManager.initGauge('chart-gauge-1', '趋势强度', false);
            if (historyData && historyData.priceHistory) {
                ChartManager.initLineChart('chart-line-1', historyData.priceHistory, '价格', etfConfig.color);
            }
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.BOND) {
            ChartManager.initGauge('chart-gauge-1', '综合配置评分', false);
            if (historyData && historyData.bondYieldHistory) {
                ChartManager.initLineChart('chart-line-1', historyData.bondYieldHistory, '国债收益率', etfConfig.color);
            }
        } else {
            // 综合评分仪表盘（非反转色）
            ChartManager.initGauge('chart-gauge-1', '综合投资评分', false);
            // 走势图
            if (etfConfig.useBondSpread) {
                if (historyData && historyData.spreadHistory) {
                    ChartManager.initLineChart('chart-line-1', historyData.spreadHistory, '股债利差', '#28a745');
                }
                if (historyData && historyData.peHistory) {
                    ChartManager.initLineChart('chart-line-2', historyData.peHistory, 'PE', '#ffc107');
                }
            } else {
                if (historyData && historyData.peHistory) {
                    ChartManager.initLineChart('chart-line-1', historyData.peHistory, 'PE', etfConfig.color);
                }
            }
        }

        // ========== 综合信号历史走势图 ==========
        renderSignalHistoryChart(etfConfig, historyData);

        // ========== 综合分历史分位图表（安全度量化）==========
        renderScorePercentileChart(etfConfig, historyData);

        // ========== 日级别综合信号历史走势图 ==========
        renderDailySignalHistoryChart(etfConfig, historyData);

        // ========== 算法对比图表（混合模型 vs 纯PE分位）==========
        renderAlgoCompareChart(etfConfig, historyData);
    }

    /**
     * 渲染综合信号历史走势图
     * 对于商品/黄金类ETF，隐藏该区域（缺少估值数据，纯趋势跟踪无法回算历史）
     * 对于债券类ETF，可以基于历史收益率回算信号
     * @param {Object} etfConfig
     * @param {Object} historyData
     * @param {number|null} currentMarketTemp - 当前市场温度（使最新月份与实时信号一致）
     * @param {Object|null} realtimeData - 实时估值数据 { pe, dividendYield, bondYield }
     */
    function renderSignalHistoryChart(etfConfig, historyData, currentMarketTemp, realtimeData) {
        const section = document.getElementById('chart-section-signal-history');
        const titleEl = document.getElementById('signal-history-title');

        // 商品/黄金类无PE估值且趋势需手动输入，不支持历史信号回算
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            if (section) section.style.display = 'none';
            return;
        }

        if (section) section.style.display = '';

        if (!historyData) {
            console.warn(`[renderSignalHistoryChart] ${etfConfig.id}: historyData为空`);
            ChartManager.initSignalHistoryChart('chart-signal-history', [], etfConfig.color);
            return;
        }

        // 计算96个月（8年）的历史信号，传入当前市场温度（用于最近一个月）
        // 数据不足8年的ETF会自动回退到全部可用历史
        // 【方案B增强】传入实时PE，让当月信号反映最新估值变化
        const mktTemp = (currentMarketTemp !== null && currentMarketTemp !== undefined) ? currentMarketTemp : null;
        const signals = SignalEngine.calcHistoricalSignals(historyData, etfConfig, 96, mktTemp, realtimeData);

        if (titleEl) {
            const monthCount = signals.length;
            const timeRange = monthCount >= 12 ? `近${(monthCount / 12).toFixed(0)}年` : `近${monthCount}个月`;
            titleEl.textContent = `综合信号历史走势（${timeRange} · ${etfConfig.shortName}）`;
        }

        if (signals.length === 0) {
            console.warn(`[renderSignalHistoryChart] ${etfConfig.id}: 历史信号计算结果为空`);
        }

        ChartManager.initSignalHistoryChart('chart-signal-history', signals, etfConfig.color);
    }

    /**
     * 渲染日级别综合信号历史走势图
     * @param {Object} etfConfig
     * @param {Object} historyData
     * @param {number|null} currentMarketTemp
     * @param {Object|null} realtimeData - 实时估值数据 { pe, dividendYield, bondYield }
     */
    function renderDailySignalHistoryChart(etfConfig, historyData, currentMarketTemp, realtimeData) {
        const section = document.getElementById('chart-section-daily-signal-history');
        const titleEl = document.getElementById('daily-signal-history-title');

        // 商品/黄金类不支持历史信号回算
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            if (section) section.style.display = 'none';
            return;
        }

        if (section) section.style.display = '';

        if (!historyData) {
            ChartManager.initDailySignalHistoryChart('chart-daily-signal-history', [], etfConfig.color);
            return;
        }

        // 默认显示近1年（365天），用户可通过dataZoom slider缩放
        const days = 365 * 3; // 3年日级别数据
        const mktTemp = (currentMarketTemp !== null && currentMarketTemp !== undefined) ? currentMarketTemp : null;
        // 【方案B增强】传入实时PE，让当月内每天的信号跟随实时PE变化
        const signals = SignalEngine.calcDailyHistoricalSignals(historyData, etfConfig, days, mktTemp, realtimeData);

        if (titleEl) {
            const dayCount = signals.length;
            let timeRange;
            if (dayCount >= 365) {
                const years = (dayCount / 365).toFixed(1);
                timeRange = years.endsWith('.0') ? `近${parseInt(years)}年` : `近${years}年`;
            } else if (dayCount >= 30) {
                timeRange = `近${Math.round(dayCount / 30)}个月`;
            } else {
                timeRange = `近${dayCount}天`;
            }
            titleEl.textContent = `综合信号日级别走势（${timeRange} · ${etfConfig.shortName}）`;
        }

        if (signals.length === 0) {
            console.warn(`[renderDailySignalHistoryChart] ${etfConfig.id}: 日级别历史信号计算结果为空`);
        }

        ChartManager.initDailySignalHistoryChart('chart-daily-signal-history', signals, etfConfig.color);
    }

    /**
     * 渲染综合分历史分位图表（安全度量化）
     * 用户直觉的量化版："历史上有多少时间比现在更差？越多=越安全"
     * @param {Object} etfConfig
     * @param {Object} historyData
     * @param {number|null} currentMarketTemp
     * @param {number|null} currentTotal - 当前实时综合评分（用于计算实时分位）
     * @param {Object|null} realtimeData - 实时估值数据 { pe, dividendYield, bondYield }
     */
    function renderScorePercentileChart(etfConfig, historyData, currentMarketTemp, currentTotal, realtimeData) {
        const section = document.getElementById('chart-section-score-percentile');
        const titleEl = document.getElementById('score-percentile-title');
        const summaryEl = document.getElementById('score-percentile-summary');

        // 商品/黄金类不支持历史信号回算
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            if (section) section.style.display = 'none';
            return;
        }

        if (section) section.style.display = '';

        if (!historyData) {
            ChartManager.initScorePercentileChart('chart-score-percentile', [], null, etfConfig.color);
            if (summaryEl) summaryEl.innerHTML = '';
            return;
        }

        // 使用尽可能长的历史（与算法对比图一致，追溯全量）
        const days = 365 * 20;
        const mktTemp = (currentMarketTemp !== null && currentMarketTemp !== undefined) ? currentMarketTemp : null;
        // 【方案B增强】传入实时PE
        const dailySignals = SignalEngine.calcDailyHistoricalSignals(historyData, etfConfig, days, mktTemp, realtimeData);

        if (dailySignals.length === 0) {
            ChartManager.initScorePercentileChart('chart-score-percentile', [], null, etfConfig.color);
            if (summaryEl) summaryEl.innerHTML = '';
            return;
        }

        // 计算分位走势序列（全部基于统一基准 marketTemp=50）
        const percentileSeries = SignalEngine.calcScorePercentileSeries(dailySignals);

        // 摘要和标记点使用图表同一基准的最后一个数据点
        // 【重要】不使用 currentTotal（实时综合分），因为它含真实市场温度，
        // 与图表中统一使用 marketTemp=50 的历史数据基准不同，混入会导致数据不可比
        let currentPercentile = null;
        const lastSignal = dailySignals[dailySignals.length - 1];
        if (lastSignal) {
            currentPercentile = SignalEngine.calcScoreHistoricalPercentile(lastSignal.score, dailySignals);
        }

        // 更新标题
        if (titleEl) {
            const dayCount = dailySignals.length;
            let timeRange;
            if (dayCount >= 365) {
                const years = (dayCount / 365).toFixed(1);
                timeRange = years.endsWith('.0') ? `近${parseInt(years)}年` : `近${years}年`;
            } else if (dayCount >= 30) {
                timeRange = `近${Math.round(dayCount / 30)}个月`;
            } else {
                timeRange = `近${dayCount}天`;
            }
            titleEl.textContent = `综合分历史分位（${timeRange} · ${etfConfig.shortName}）`;
        }

        // 更新摘要区域
        if (summaryEl && currentPercentile) {
            const pct = currentPercentile.percentile;
            const zone = currentPercentile.zone;
            // 获取图表基准下最后一天的综合分（与图表一致，统一使用 marketTemp=50 中性计算）
            const lastScore = lastSignal ? lastSignal.score.toFixed(1) : '--';
            summaryEl.innerHTML = `
                <div class="score-pct-current">
                    <span class="score-pct-value" style="color:${zone.color}">${pct.toFixed(1)}%</span>
                    <span class="score-pct-label">历史分位<br/>（越高越安全）</span>
                </div>
                <span class="score-pct-zone" style="color:${zone.color};border-color:${zone.color}">
                    ${zone.icon} ${zone.text}
                </span>
                <span class="score-pct-desc">${zone.desc}
                    <br/><span style="font-size:11px;color:#718096;">估值基准分 ${lastScore}，历史 ${currentPercentile.totalDays} 个数据点中 ${currentPercentile.worseDays} 个（${pct.toFixed(0)}%）≤ 当前</span>
                </span>
            `;
        } else if (summaryEl) {
            summaryEl.innerHTML = '';
        }

        // 渲染图表
        ChartManager.initScorePercentileChart('chart-score-percentile', percentileSeries, currentPercentile, etfConfig.color);
    }

    /**
     * 渲染算法对比图表：混合估值模型 vs 纯PE分位 日级别走势
     * 追溯时间尽可能长（使用全部可用历史数据）
     * @param {Object} etfConfig
     * @param {Object} historyData
     * @param {number|null} currentMarketTemp
     * @param {Object|null} realtimeData - 实时估值数据 { pe, dividendYield, bondYield }
     */
    function renderAlgoCompareChart(etfConfig, historyData, currentMarketTemp, realtimeData) {
        const section = document.getElementById('chart-section-algo-compare');
        const titleEl = document.getElementById('algo-compare-title');

        // 商品/黄金类不支持
        if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY || etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            if (section) section.style.display = 'none';
            return;
        }

        if (section) section.style.display = '';

        if (!historyData) {
            ChartManager.initAlgoCompareChart('chart-algo-compare', [], etfConfig.color);
            return;
        }

        // 使用尽可能长的历史：365*20=20年（实际会被数据最早时间截断）
        const days = 365 * 20;
        const mktTemp = (currentMarketTemp !== null && currentMarketTemp !== undefined) ? currentMarketTemp : null;
        // 【方案B增强】传入实时PE
        const signals = SignalEngine.calcDailyHistoricalSignals(historyData, etfConfig, days, mktTemp, realtimeData);

        if (titleEl) {
            const dayCount = signals.length;
            let timeRange;
            if (dayCount >= 365) {
                const years = (dayCount / 365).toFixed(1);
                timeRange = years.endsWith('.0') ? `近${parseInt(years)}年` : `近${years}年`;
            } else if (dayCount >= 30) {
                timeRange = `近${Math.round(dayCount / 30)}个月`;
            } else {
                timeRange = `近${dayCount}天`;
            }
            titleEl.textContent = `估值算法对比 · ${timeRange}日级别走势（${etfConfig.shortName}）`;
        }

        if (signals.length === 0) {
            console.warn(`[renderAlgoCompareChart] ${etfConfig.id}: 算法对比数据为空`);
        }

        ChartManager.initAlgoCompareChart('chart-algo-compare', signals, etfConfig.color);
    }

    // ========== 刷新 ==========

    async function refreshData() {
        if (!currentETFId) return;

        // VIX仪表盘刷新
        if (ETF_CONFIG.isVIXDashboard(currentETFId)) {
            showToast('正在刷新VIX数据...', 'info');
            await loadVIXDashboardData();
            return;
        }

        const etfConfig = ETF_CONFIG.getETFById(currentETFId);
        if (!etfConfig) return;

        updateDataSourceStatus('fetching');
        showToast('正在获取最新数据...', 'info');

        try {
            const apiData = await DataAPI.fetchAllDataForETF(etfConfig);
            if (etfDataCache[currentETFId]) etfDataCache[currentETFId].lastApiData = apiData;

            if (apiData.success) {
                const savedManual = DataStorage.getCurrentData(currentETFId);
                const historyData = etfDataCache[currentETFId] ? etfDataCache[currentETFId].historyData : null;
                const fallback = historyData ? historyData.currentData : {};
                const manualOverride = {};

                // 【方案B】API成功获取估值时，同步更新historyData中的currentData锚点
                if (apiData.valuation && historyData && historyData.currentData) {
                    const v = apiData.valuation;
                    if (v.pe > 0) historyData.currentData.pe = v.pe;
                    if (v.pePercentile > 0) historyData.currentData.pePercentile = v.pePercentile;
                    if (v.pb > 0) historyData.currentData.pb = v.pb;
                    if (v.pbPercentile > 0) historyData.currentData.pbPercentile = v.pbPercentile;
                    if (v.dividendYield > 0) historyData.currentData.dividendYield = v.dividendYield;
                    historyData.currentData.updateTime = new Date().toISOString().slice(0, 10);
                }

                if (!apiData.valuation) {
                    const _pickValid2 = (...vals) => {
                        for (const v of vals) {
                            if (v !== null && v !== undefined && v !== '' && !isNaN(v)) return v;
                        }
                        return undefined;
                    };
                    // 优先级调整：JSON预设(fallback) 优先于 localStorage缓存(savedManual)
                    const dv = _pickValid2(fallback && fallback.dividendYield, savedManual && savedManual.dividendYield);
                    const pe = _pickValid2(fallback && fallback.pe, savedManual && savedManual.pe);
                    const pb = _pickValid2(fallback && fallback.pb, savedManual && savedManual.pb);
                    const pePct = _pickValid2(fallback && fallback.pePercentile, savedManual && savedManual.pePercentile);
                    if (dv !== undefined) manualOverride.dividendYield = dv;
                    if (pe !== undefined) manualOverride.pe = pe;
                    if (pb !== undefined) manualOverride.pb = pb;
                    if (pePct !== undefined) manualOverride.pePercentile = pePct;
                }
                const normalized = DataAPI.normalizeData(apiData, manualOverride);

                // 保留手动数据（仅在API未自动获取时使用手动值）
                if (savedManual) {
                    if (!normalized.marketTempAutoFetched && savedManual.marketTemp !== null && savedManual.marketTemp !== undefined) {
                        normalized.marketTemp = savedManual.marketTemp;
                    }
                    if (savedManual.trendScore !== null && savedManual.trendScore !== undefined) normalized.trendScore = savedManual.trendScore;
                    if (savedManual.roe) normalized.roe = savedManual.roe;
                }

                applyData(currentETFId, etfConfig, normalized, historyData);
                updateDataSourceStatus('success', apiData);
                updateTimestamp(currentETFId);
                showToast('数据已更新', 'success');
            } else {
                updateDataSourceStatus('error', apiData);
                showToast('部分数据获取失败', 'error');
            }
        } catch (e) {
            updateDataSourceStatus('error');
            showToast('数据获取异常: ' + e.message, 'error');
        }
    }

    function isTradingHours() {
        const now = new Date();
        const day = now.getDay();
        if (day === 0 || day === 6) return false;
        const time = now.getHours() * 60 + now.getMinutes();
        return time >= 555 && time <= 905;
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        autoRefreshTimer = setInterval(() => { if (isTradingHours()) refreshData(); }, 300000);
    }

    function stopAutoRefresh() {
        if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    }

    // ========== 事件 ==========

    function bindGlobalEvents() {
        let refreshCooldown = false;
        const refreshBtn = document.getElementById('btn-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                if (refreshCooldown) { showToast('请稍后再刷新（冷却10秒）', 'info'); return; }
                refreshCooldown = true;
                setTimeout(() => { refreshCooldown = false; }, 10000);
                refreshBtn.classList.add('spinning');
                refreshData().finally(() => { setTimeout(() => refreshBtn.classList.remove('spinning'), 600); });
            });
        }

        const inputBtn = document.getElementById('btn-input-data');
        if (inputBtn) inputBtn.addEventListener('click', showInputModal);

        const closeBtn = document.getElementById('modal-close');
        if (closeBtn) closeBtn.addEventListener('click', hideInputModal);
        const modal = document.getElementById('input-modal');
        if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) hideInputModal(); });

        const exportBtn = document.getElementById('btn-export');
        if (exportBtn) exportBtn.addEventListener('click', () => DataStorage.downloadCSV(currentETFId));

        const resetBtn = document.getElementById('btn-reset');
        if (resetBtn) resetBtn.addEventListener('click', handleReset);

        document.querySelectorAll('.collapse-header').forEach(header => {
            header.addEventListener('click', () => {
                const content = header.nextElementSibling;
                const icon = header.querySelector('.collapse-icon');
                content.classList.toggle('collapsed');
                icon.classList.toggle('rotated');
            });
        });

        window.addEventListener('hashchange', () => {
            const hash = window.location.hash.replace('#', '');
            if (hash && hash !== currentETFId && (ETF_CONFIG.getETFById(hash) || ETF_CONFIG.isVIXDashboard(hash))) switchETF(hash);
        });
    }

    // ========== 模态框（新增市场温度输入）==========

    function showInputModal() {
        const etfConfig = ETF_CONFIG.getETFById(currentETFId);
        if (!etfConfig) return;
        const modal = document.getElementById('input-modal');
        const body = document.getElementById('modal-form-body');
        if (!modal || !body) return;

        let formHtml = `
            <p style="font-size:12px;color:#a0aec0;margin-bottom:14px;line-height:1.6;">
                💡 <strong>${etfConfig.name} (${etfConfig.code})</strong> 多维度数据补充
            </p>
            <form id="data-input-form">
        `;

        if (etfConfig.useBondSpread) {
            formHtml += `
                <div class="form-section-label">📌 估值数据</div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">股息率 (%)<span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" id="input-dividend-yield" placeholder="如 4.47" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">PE<span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" id="input-pe" placeholder="如 8.49" required>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">PB</label>
                        <input type="number" step="0.01" class="form-input" id="input-pb" placeholder="如 0.89">
                    </div>
                    <div class="form-group">
                        <label class="form-label">国债收益率 (%)</label>
                        <input type="number" step="0.01" class="form-input" id="input-bond-yield" placeholder="自动获取">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">ROE (%)</label>
                        <input type="number" step="0.1" class="form-input" id="input-roe" placeholder="如 12.5">
                    </div>
                    <div class="form-group">
                        <label class="form-label">PE历史分位 (%)</label>
                        <input type="number" step="0.01" min="0" max="100" class="form-input" id="input-pe-percentile" placeholder="0-100">
                    </div>
                </div>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.GOLD) {
            formHtml += `
                <div class="form-section-label">📌 趋势数据（黄金）</div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">趋势强度分数 (0-100)<span class="required">*</span></label>
                        <input type="number" step="1" min="0" max="100" class="form-input" id="input-trend-score" placeholder="0=极弱 50=中性 100=极强" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">判断依据</label>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
                            💡 价格>20日均线=偏强(60+)，>60日均线=强势(75+)，<20日均线=偏弱(40-)。
                            黄金与股票负相关，地缘冲突/通胀升温时趋势走强。
                        </div>
                    </div>
                </div>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.BOND) {
            formHtml += `
                <div class="form-section-label">📌 国债数据</div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">利率趋势强度 (0-100)</label>
                        <input type="number" step="1" min="0" max="100" class="form-input" id="input-trend-score" placeholder="0=快速下行 50=稳定 100=快速上行">
                    </div>
                    <div class="form-group">
                        <label class="form-label">判断依据</label>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
                            💡 国债收益率已自动获取。利率趋势：0=利率快速下行(利好债券)，50=稳定，100=利率快速上行(利空债券)。
                            留空使用默认中性(50)。
                        </div>
                    </div>
                </div>
            `;
        } else if (etfConfig.type === ETF_CONFIG.ETF_TYPE.COMMODITY) {
            formHtml += `
                <div class="form-section-label">📌 趋势数据</div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">趋势强度分数 (0-100)<span class="required">*</span></label>
                        <input type="number" step="1" min="0" max="100" class="form-input" id="input-trend-score" placeholder="0=极弱 50=中性 100=极强" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">判断依据</label>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
                            💡 价格>20日均线=偏强(60+)，>60日均线=强势(75+)，<20日均线=偏弱(40-)
                        </div>
                    </div>
                </div>
            `;
        } else {
            formHtml += `
                <div class="form-section-label">📌 估值数据</div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">PE<span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" id="input-pe" placeholder="当前PE" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">PB</label>
                        <input type="number" step="0.01" class="form-input" id="input-pb" placeholder="当前PB">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">PE历史分位 (%)</label>
                        <input type="number" step="0.01" min="0" max="100" class="form-input" id="input-pe-percentile" placeholder="0-100">
                    </div>
                    <div class="form-group">
                        <label class="form-label">ROE (%)</label>
                        <input type="number" step="0.1" class="form-input" id="input-roe" placeholder="如 15.3">
                    </div>
                </div>
            `;
        }

        // 非商品/非黄金ETF都有市场温度输入（改为可选覆盖）
        if (etfConfig.type !== ETF_CONFIG.ETF_TYPE.COMMODITY && etfConfig.type !== ETF_CONFIG.ETF_TYPE.GOLD) {
            const tempConfig = getMarketTempConfig(etfConfig);
            const tempExplain = tempConfig.source === 'cnn'
                ? '💡 <strong>已自动获取</strong> CNN Fear & Greed Index（综合VIX + 市场动量 + 看跌/看涨期权比 + 股市广度等7维度，反映<strong>美股情绪</strong>）。留空使用自动值，填写则覆盖。0=极度恐惧 50=中性 100=极度贪婪。'
                : '💡 <strong>已自动获取</strong> A股市场广度指标（上证涨跌家数比，反映<strong>A股实际情绪</strong>）。涨多跌少=贪婪，跌多涨少=恐惧。留空使用自动值，填写则覆盖。0=极度恐惧 50=中性 100=极度贪婪。';
            formHtml += `
                <hr class="form-divider">
                <div class="form-section-label">${tempConfig.label}（已自动获取）</div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">手动覆盖市场温度 (0-100)</label>
                        <input type="number" step="1" min="0" max="100" class="form-input" id="input-market-temp" placeholder="留空则使用自动获取的值">
                    </div>
                    <div class="form-group">
                        <label class="form-label">数据说明</label>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
                            ${tempExplain}
                        </div>
                    </div>
                </div>
            `;
        }

        formHtml += `
            <hr class="form-divider">
            <div class="form-section-label">💰 行情数据</div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">${etfConfig.code} 最新价</label>
                    <input type="number" step="0.001" class="form-input" id="input-price" placeholder="最新价格">
                </div>
                <div class="form-group">
                    <label class="form-label">日涨跌幅 (%)</label>
                    <input type="number" step="0.01" class="form-input" id="input-price-change" placeholder="涨跌幅">
                </div>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary">✅ 提交更新</button>
            </div>
        </form>`;

        body.innerHTML = formHtml;

        // 预填已有数据
        const saved = DataStorage.getCurrentData(currentETFId);
        if (saved) {
            const fill = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
            fill('input-dividend-yield', saved.dividendYield);
            fill('input-pe', saved.pe);
            fill('input-pb', saved.pb);
            fill('input-bond-yield', saved.bondYield);
            fill('input-price', saved.price);
            fill('input-price-change', saved.priceChange);
            fill('input-pe-percentile', saved.pePercentile);
            fill('input-trend-score', saved.trendScore);
            fill('input-market-temp', saved.marketTemp);
            fill('input-roe', saved.roe);
        }

        const form = document.getElementById('data-input-form');
        if (form) form.addEventListener('submit', handleFormSubmit);

        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    function hideInputModal() {
        const modal = document.getElementById('input-modal');
        if (modal) { modal.classList.remove('show'); document.body.style.overflow = ''; }
    }

    function handleFormSubmit(e) {
        e.preventDefault();
        const etfConfig = ETF_CONFIG.getETFById(currentETFId);
        if (!etfConfig) return;

        const cached = DataStorage.getCurrentData(currentETFId) || {};
        const getVal = (id) => { const el = document.getElementById(id); return el ? parseFloat(el.value) : NaN; };

        // 安全取值函数：区分"用户输入了0"和"用户没填"（NaN）
        const safeGetVal = (id, fallback) => {
            const v = getVal(id);
            return !isNaN(v) ? v : (fallback !== undefined && fallback !== null ? fallback : 0);
        };

        const data = {
            dividendYield: safeGetVal('input-dividend-yield', cached.dividendYield),
            bondYield: safeGetVal('input-bond-yield', cached.bondYield),
            pe: safeGetVal('input-pe', cached.pe),
            pb: safeGetVal('input-pb', cached.pb),
            price: safeGetVal('input-price', cached.price),
            priceChange: safeGetVal('input-price-change', cached.priceChange),
            pePercentile: safeGetVal('input-pe-percentile', 0),
            roe: safeGetVal('input-roe', cached.roe),
            updateTime: formatDateTime(new Date())
        };

        // 市场温度（特殊处理：NaN → null）
        const marketTempVal = getVal('input-market-temp');
        data.marketTemp = !isNaN(marketTempVal) ? marketTempVal : (cached.marketTemp !== undefined ? cached.marketTemp : null);

        // 趋势分数
        const trendVal = getVal('input-trend-score');
        data.trendScore = !isNaN(trendVal) ? trendVal : (cached.trendScore !== undefined ? cached.trendScore : null);

        const historyData = etfDataCache[currentETFId] ? etfDataCache[currentETFId].historyData : null;
        applyData(currentETFId, etfConfig, data, historyData);
        hideInputModal();
        showToast('数据已更新，多维度信号已重新计算', 'success');
        updateTimestamp(currentETFId);
    }

    function handleReset() {
        if (confirm('确定要重置当前ETF的所有数据吗？')) {
            DataStorage.clearETFData(currentETFId);
            etfDataCache[currentETFId] = null;
            const etfConfig = ETF_CONFIG.getETFById(currentETFId);
            if (etfConfig) loadETFData(currentETFId, etfConfig);
        }
    }

    // ========== 工具函数 ==========

    function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
    function setTextColor(id, color) { const el = document.getElementById(id); if (el) el.style.color = color || ''; }

    function formatDateTime(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        const s = String(date.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${h}:${min}:${s}`;
    }

    function adjustColor(hex, amount) {
        let r = parseInt(hex.slice(1, 3), 16);
        let g = parseInt(hex.slice(3, 5), 16);
        let b = parseInt(hex.slice(5, 7), 16);
        r = Math.max(0, Math.min(255, r + amount));
        g = Math.max(0, Math.min(255, g + amount));
        b = Math.max(0, Math.min(255, b + amount));
        return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    }

    function showLoading(show) {
        const loader = document.getElementById('loading');
        if (loader) loader.style.display = show ? 'flex' : 'none';
    }

    function showError(msg) { showToast(msg, 'error'); }

    function showToast(message, type = 'info') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }

    // ========== VIX 恐惧仪表盘 ==========

    let _vixDashboardData = null; // VIX仪表盘缓存

    /**
     * 显示VIX仪表盘模式（隐藏常规ETF内容，显示VIX专属区域）
     */
    function showVIXDashboard() {
        const vixConfig = ETF_CONFIG.VIX_DASHBOARD;
        document.documentElement.style.setProperty('--accent-color', vixConfig.color);

        // 隐藏常规ETF内容区域
        const hideIds = [
            'hero-section', 'chart-section-score-percentile', 'chart-section-1', 'chart-section-2',
            'chart-section-signal-history', 'chart-section-daily-signal-history',
            'chart-section-algo-compare', 'gauges-section'
        ];
        hideIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        // 隐藏核心数据指标的父section（data-grid的外层dashboard）
        const dataGrid = document.getElementById('data-grid');
        if (dataGrid && dataGrid.closest('.dashboard')) {
            dataGrid.closest('.dashboard').style.display = 'none';
        }

        // 显示VIX专属区域
        const vixSection = document.getElementById('vix-dashboard-section');
        if (vixSection) vixSection.style.display = '';

        // 更新Header
        const logoIcon = document.getElementById('header-logo-icon');
        const title = document.getElementById('header-title');
        const subtitle = document.getElementById('header-subtitle');
        if (logoIcon) {
            logoIcon.textContent = vixConfig.icon;
            logoIcon.style.background = `linear-gradient(135deg, ${vixConfig.color}, ${adjustColor(vixConfig.color, -40)})`;
        }
        if (title) title.textContent = vixConfig.name;
        if (subtitle) subtitle.textContent = 'CBOE Volatility Index · 不参与信号计算';

        // 隐藏补充数据按钮（VIX不需要手动输入）
        const inputBtn = document.getElementById('btn-input-data');
        if (inputBtn) inputBtn.style.display = 'none';

        // 更新数据来源状态
        const statusEl = document.getElementById('data-source-status');
        if (statusEl) statusEl.innerHTML = '<span class="status-dot status-loading"></span> 正在获取VIX恐惧指数数据...';
    }

    /**
     * 隐藏VIX仪表盘模式（恢复常规ETF内容）
     */
    function hideVIXDashboard() {
        const vixSection = document.getElementById('vix-dashboard-section');
        if (vixSection) vixSection.style.display = 'none';

        // 恢复常规ETF内容区域
        const showIds = [
            'hero-section', 'chart-section-score-percentile', 'chart-section-1',
            'chart-section-signal-history', 'chart-section-daily-signal-history',
            'chart-section-algo-compare', 'gauges-section'
        ];
        showIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
        const dataGrid = document.getElementById('data-grid');
        if (dataGrid && dataGrid.closest('.dashboard')) {
            dataGrid.closest('.dashboard').style.display = '';
        }

        // 恢复补充数据按钮
        const inputBtn = document.getElementById('btn-input-data');
        if (inputBtn) inputBtn.style.display = '';
    }

    /**
     * 加载VIX仪表盘数据
     */
    async function loadVIXDashboardData() {
        showLoading(true);
        try {
            const data = await DataAPI.fetchVIXDashboardData();
            _vixDashboardData = data;

            if (data.success) {
                renderVIXDashboard(data);
                // 更新数据来源状态
                const statusEl = document.getElementById('data-source-status');
                if (statusEl) {
                    let sources = [`VIX实时✅(${data.vix.vix.toFixed(2)})`];
                    if (data.fearGreed) sources.push(`CNN F&G✅(${data.fearGreed.score.toFixed(0)})`);
                    else sources.push('CNN F&G❌');
                    sources.push(`K线✅(${data.kline.length}天)`);
                    statusEl.innerHTML = '<span class="status-dot status-ok"></span> ' + sources.join(' | ');
                }
                showToast(`VIX恐惧指数: ${data.vix.vix.toFixed(2)}`, 'success');
            } else {
                showToast('VIX数据获取失败', 'error');
                const statusEl = document.getElementById('data-source-status');
                if (statusEl) statusEl.innerHTML = '<span class="status-dot status-err"></span> VIX数据获取失败';
            }

            // 更新价格栏
            if (data.vix) {
                const priceEl = document.getElementById('val-price');
                const changeEl = document.getElementById('val-price-change');
                if (priceEl) priceEl.textContent = data.vix.vix.toFixed(2);
                if (changeEl) {
                    const ch = data.vix.change;
                    changeEl.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
                    changeEl.className = 'price-change ' + (ch >= 0 ? 'up' : 'down');
                }
            }

            updateTimestamp(currentETFId);
        } catch (e) {
            console.error('VIX仪表盘加载失败:', e);
            showToast('VIX仪表盘加载异常: ' + e.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    /**
     * 计算VIX历史分位数（方案B核心）
     * @param {number} currentVIX - 当前VIX值
     * @param {Array} kline - VIX历史K线数据
     * @param {number} lookbackDays - 回看天数（默认全部）
     * @returns {Object} { percentile, daysBelow, totalDays, label, color, suggestion }
     */
    function calcVIXHistoricalPercentile(currentVIX, kline, lookbackDays) {
        if (!kline || kline.length === 0 || !currentVIX) return null;

        // 筛选回看区间
        let data = kline;
        if (lookbackDays && lookbackDays < kline.length) {
            data = kline.slice(-lookbackDays);
        }

        const closes = data.map(d => d.close).filter(v => v > 0);
        if (closes.length < 10) return null;

        // 当前VIX在历史中的百分位：有多少天VIX比当前低？
        const daysBelow = closes.filter(v => v <= currentVIX).length;
        const percentile = (daysBelow / closes.length) * 100;

        // 分位解读
        let label, color, suggestion;
        if (percentile >= 90) {
            label = '历史极高位';
            color = '#85182a';
            suggestion = '当前VIX处于历史90%+分位，极端恐慌，极少数时间比这更高 → 历史级抄底窗口';
        } else if (percentile >= 75) {
            label = '历史高位';
            color = '#dc3545';
            suggestion = '当前VIX高于历史75%的时间，恐慌情绪浓厚 → 关注超跌反弹机会';
        } else if (percentile >= 60) {
            label = '历史偏高';
            color = '#fd7e14';
            suggestion = '当前VIX高于历史60%的时间，市场紧张 → 保持警惕，可分批布局';
        } else if (percentile >= 40) {
            label = '历史中位';
            color = '#ffc107';
            suggestion = '当前VIX处于历史中间位置，市场正常波动 → 维持正常仓位';
        } else if (percentile >= 25) {
            label = '历史偏低';
            color = '#9be3b0';
            suggestion = '当前VIX低于历史60%的时间，市场偏乐观 → 注意风险积累';
        } else if (percentile >= 10) {
            label = '历史低位';
            color = '#28a745';
            suggestion = '当前VIX低于历史75%的时间，极度平静 → 历史表明暴风雨前的宁静';
        } else {
            label = '历史极低位';
            color = '#0d7337';
            suggestion = '当前VIX处于历史底部10%，极罕见的低波动 → 强烈警惕反转风险';
        }

        return {
            percentile: percentile.toFixed(1),
            daysBelow,
            totalDays: closes.length,
            label,
            color,
            suggestion,
            mean: (closes.reduce((a, b) => a + b, 0) / closes.length).toFixed(2),
            median: closes.sort((a, b) => a - b)[Math.floor(closes.length / 2)].toFixed(2),
            min: Math.min(...closes).toFixed(2),
            max: Math.max(...closes).toFixed(2),
        };
    }

    /**
     * 渲染VIX恐惧仪表盘全部内容
     * @param {Object} data - fetchVIXDashboardData 返回的数据
     */
    function renderVIXDashboard(data) {
        const container = document.getElementById('vix-dashboard-content');
        if (!container) return;

        const vixConfig = ETF_CONFIG.VIX_DASHBOARD;
        const vix = data.vix;
        const fg = data.fearGreed;
        const kline = data.kline || [];

        if (!vix) {
            container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">VIX数据获取失败，请稍后重试</div>';
            return;
        }

        const zone = ETF_CONFIG.getVIXZone(vix.vix);
        const deviation = ETF_CONFIG.getVIXDeviationFromMean(vix.vix);

        // 计算多周期历史分位（方案B核心）
        const pctAll = calcVIXHistoricalPercentile(vix.vix, kline);
        const pct1y = calcVIXHistoricalPercentile(vix.vix, kline, 252);
        const pct6m = calcVIXHistoricalPercentile(vix.vix, kline, 126);
        const pct3m = calcVIXHistoricalPercentile(vix.vix, kline, 63);

        let html = '';

        // ======== 1. VIX 核心卡片（大号仪表盘 + 关键数据）========
        html += `
        <div class="vix-hero">
            <div class="vix-hero-left">
                <div class="vix-value-container">
                    <span class="vix-emoji">${zone ? zone.emoji : '😐'}</span>
                    <span class="vix-value" style="color:${zone ? zone.color : '#ffc107'}">${vix.vix.toFixed(2)}</span>
                </div>
                <div class="vix-zone-badge" style="background:${zone ? zone.color : '#ffc107'}22;color:${zone ? zone.color : '#ffc107'};border-color:${zone ? zone.color : '#ffc107'}">
                    ${zone ? zone.label : '未知'}
                </div>
                <div class="vix-change ${vix.change >= 0 ? 'vix-change-up' : 'vix-change-down'}">
                    ${vix.change >= 0 ? '▲' : '▼'} ${Math.abs(vix.change).toFixed(2)}%
                    <span style="opacity:0.7;">较前收 ${vix.prevClose.toFixed(2)}</span>
                </div>
                <div class="vix-zone-desc">${zone ? zone.desc : ''}</div>
            </div>
            <div class="vix-hero-right">
                <div class="vix-gauge-container" id="vix-gauge-chart"></div>
            </div>
        </div>`;

        // ======== 2. 方案B：历史分位决策面板（核心新增！）========
        if (pctAll) {
            html += `
            <div class="vix-section-title">📊 方案B：VIX历史分位数决策</div>
            <div class="vix-percentile-panel">
                <div class="vix-pct-hero">
                    <div class="vix-pct-main">
                        <span class="vix-pct-value" style="color:${pctAll.color}">${pctAll.percentile}%</span>
                        <span class="vix-pct-label">历史总分位</span>
                    </div>
                    <div class="vix-pct-badge" style="color:${pctAll.color};border-color:${pctAll.color}">
                        ${pctAll.label}
                    </div>
                    <div class="vix-pct-suggestion">${pctAll.suggestion}</div>
                </div>

                <div class="vix-pct-multi">
                    <div class="vix-pct-item">
                        <div class="vix-pct-item-label">近3月分位</div>
                        <div class="vix-pct-item-value" style="color:${pct3m ? pct3m.color : '#718096'}">${pct3m ? pct3m.percentile + '%' : '--'}</div>
                        <div class="vix-pct-item-tag">${pct3m ? pct3m.label : ''}</div>
                        <div class="vix-pct-bar"><div class="vix-pct-bar-fill" style="width:${pct3m ? pct3m.percentile : 0}%;background:${pct3m ? pct3m.color : '#718096'}"></div></div>
                    </div>
                    <div class="vix-pct-item">
                        <div class="vix-pct-item-label">近6月分位</div>
                        <div class="vix-pct-item-value" style="color:${pct6m ? pct6m.color : '#718096'}">${pct6m ? pct6m.percentile + '%' : '--'}</div>
                        <div class="vix-pct-item-tag">${pct6m ? pct6m.label : ''}</div>
                        <div class="vix-pct-bar"><div class="vix-pct-bar-fill" style="width:${pct6m ? pct6m.percentile : 0}%;background:${pct6m ? pct6m.color : '#718096'}"></div></div>
                    </div>
                    <div class="vix-pct-item">
                        <div class="vix-pct-item-label">近1年分位</div>
                        <div class="vix-pct-item-value" style="color:${pct1y ? pct1y.color : '#718096'}">${pct1y ? pct1y.percentile + '%' : '--'}</div>
                        <div class="vix-pct-item-tag">${pct1y ? pct1y.label : ''}</div>
                        <div class="vix-pct-bar"><div class="vix-pct-bar-fill" style="width:${pct1y ? pct1y.percentile : 0}%;background:${pct1y ? pct1y.color : '#718096'}"></div></div>
                    </div>
                    <div class="vix-pct-item">
                        <div class="vix-pct-item-label">总历史分位</div>
                        <div class="vix-pct-item-value" style="color:${pctAll.color}">${pctAll.percentile}%</div>
                        <div class="vix-pct-item-tag">${pctAll.label}</div>
                        <div class="vix-pct-bar"><div class="vix-pct-bar-fill" style="width:${pctAll.percentile}%;background:${pctAll.color}"></div></div>
                    </div>
                </div>

                <div class="vix-pct-stats">
                    <span>📈 历史均值: <strong>${pctAll.mean}</strong></span>
                    <span>📊 历史中位: <strong>${pctAll.median}</strong></span>
                    <span>⬇️ 历史最低: <strong>${pctAll.min}</strong></span>
                    <span>⬆️ 历史最高: <strong>${pctAll.max}</strong></span>
                    <span>📅 数据量: <strong>${pctAll.totalDays}天</strong></span>
                </div>

                <div class="vix-pct-note">
                    💡 <strong>方案B决策逻辑：</strong>VIX分位越高 = 当前恐慌在历史中越罕见 = 超跌可能性越大 = 抄底机会越好。
                    相比固定阈值（如VIX>30=恐惧），历史分位能自适应不同市场环境（如2020年VIX均值比2019年高得多）。
                    <br/><strong>建议结合方案A（绝对值区间）+ 方案B（历史分位）双重确认。</strong>
                </div>
            </div>`;
        }

        // ======== 3. 方案A：绝对值区间 + 均值偏离度 ========
        html += `
        <div class="vix-section-title">📐 方案A：VIX绝对值区间 + 均值偏离度</div>
        <div class="vix-data-grid">
            <div class="vix-data-card">
                <div class="vix-data-label">日内高</div>
                <div class="vix-data-value">${vix.high > 0 ? vix.high.toFixed(2) : '--'}</div>
            </div>
            <div class="vix-data-card">
                <div class="vix-data-label">日内低</div>
                <div class="vix-data-value">${vix.low > 0 ? vix.low.toFixed(2) : '--'}</div>
            </div>
            <div class="vix-data-card">
                <div class="vix-data-label">前收盘</div>
                <div class="vix-data-value">${vix.prevClose > 0 ? vix.prevClose.toFixed(2) : '--'}</div>
            </div>
            <div class="vix-data-card">
                <div class="vix-data-label">开盘价</div>
                <div class="vix-data-value">${vix.open > 0 ? vix.open.toFixed(2) : '--'}</div>
            </div>
            <div class="vix-data-card">
                <div class="vix-data-label">📏 均值偏离</div>
                <div class="vix-data-value" style="color:${zone ? zone.color : '#ffc107'}">${deviation ? deviation.deviation + 'σ' : '--'}</div>
                <div class="vix-data-sub">长期均值 ${vixConfig.anchor.mean}</div>
            </div>
            <div class="vix-data-card">
                <div class="vix-data-label">📊 锚点分位</div>
                <div class="vix-data-value" style="color:${zone ? zone.color : '#ffc107'}">${deviation ? deviation.percentile + '%' : '--'}</div>
                <div class="vix-data-sub">基于1990-2025统计</div>
            </div>
        </div>`;

        // ======== 4. VIX恐惧/贪婪区间表 ========
        html += `
        <div class="vix-section-title">🎚️ VIX恐惧/贪婪区间对照表</div>
        <div class="vix-zone-table">`;
        vixConfig.zones.forEach(z => {
            const isActive = zone && z.label === zone.label;
            html += `
            <div class="vix-zone-row ${isActive ? 'vix-zone-active' : ''}" style="${isActive ? 'border-color:' + z.color + ';background:' + z.color + '15;' : ''}">
                <span class="vix-zone-emoji">${z.emoji}</span>
                <span class="vix-zone-range" style="color:${z.color}">${z.min}-${z.max === 999 ? '∞' : z.max}</span>
                <span class="vix-zone-name" style="color:${z.color};font-weight:${isActive ? 700 : 500}">${z.label}</span>
                <span class="vix-zone-desc-text">${z.desc}</span>
                ${isActive ? '<span class="vix-zone-current">← 当前</span>' : ''}
            </div>`;
        });
        html += '</div>';

        // ======== 5. CNN Fear & Greed 联动对比 ========
        if (fg) {
            const fgZone = fg.score <= 25 ? '极度恐惧' : fg.score <= 40 ? '恐惧' : fg.score <= 55 ? '中性' : fg.score <= 75 ? '贪婪' : '极度贪婪';
            const fgColor = fg.score <= 25 ? '#dc3545' : fg.score <= 40 ? '#fd7e14' : fg.score <= 55 ? '#ffc107' : fg.score <= 75 ? '#28a745' : '#0d7337';
            html += `
            <div class="vix-section-title">🌡️ CNN Fear & Greed 联动对比</div>
            <div class="vix-fg-panel">
                <div class="vix-fg-current">
                    <div class="vix-fg-score" style="color:${fgColor}">${fg.score.toFixed(0)}</div>
                    <div class="vix-fg-label">${fgZone}</div>
                    <div class="vix-fg-rating">${fg.rating || ''}</div>
                </div>
                <div class="vix-fg-history">
                    ${fg.previous ? `<div class="vix-fg-item"><span>昨日</span><strong>${fg.previous.toFixed(0)}</strong></div>` : ''}
                    ${fg.oneWeekAgo ? `<div class="vix-fg-item"><span>一周前</span><strong>${fg.oneWeekAgo.toFixed(0)}</strong></div>` : ''}
                    ${fg.oneMonthAgo ? `<div class="vix-fg-item"><span>一月前</span><strong>${fg.oneMonthAgo.toFixed(0)}</strong></div>` : ''}
                    ${fg.oneYearAgo ? `<div class="vix-fg-item"><span>一年前</span><strong>${fg.oneYearAgo.toFixed(0)}</strong></div>` : ''}
                </div>
                <div class="vix-fg-note">
                    💡 VIX和CNN F&G通常负相关：VIX高→F&G低(恐惧)，VIX低→F&G高(贪婪)。两者同时极端时信号更强。
                </div>
            </div>`;
        }

        // ======== 6. VIX 历史走势（区间着色）========
        html += `
        <div class="vix-section-title">📈 VIX历史走势（恐惧区间着色）</div>
        <div class="vix-kline-container" id="vix-kline-chart" style="height:400px;"></div>
        <div class="vix-kline-note">
            数据来源: 东方财富(CBOE VIX) · 近${kline.length}个交易日 · 背景色=恐惧/贪婪区间
        </div>`;

        // ======== 7. 使用说明 ========
        html += `
        <div class="vix-disclaimer">
            <strong>⚠️ VIX恐惧仪表盘说明：</strong>本页面独立于信号计算系统，仅作为市场情绪参考。
            VIX指数反映未来30天标普500隐含波动率预期。数据来源：东方财富(CBOE VIX) + CNN Fear & Greed Index。
            <br/>VIX升高≠股市必跌，仅代表市场预期波动加大。投资决策请综合多维度判断。
        </div>`;

        container.innerHTML = html;

        // 渲染ECharts图表（需要DOM已存在）
        setTimeout(() => {
            renderVIXGauge(vix.vix, zone);
            if (kline.length > 0) renderVIXKlineChart(kline, vix.vix);
        }, 50);
    }

    /**
     * 渲染VIX半圆仪表盘
     */
    function renderVIXGauge(vixValue, zone) {
        const dom = document.getElementById('vix-gauge-chart');
        if (!dom) return;

        let chart = echarts.getInstanceByDom(dom);
        if (!chart) chart = echarts.init(dom);

        const vixConfig = ETF_CONFIG.VIX_DASHBOARD;
        // 构建渐变色段
        const colorStops = vixConfig.zones.map(z => {
            const normalized = Math.min(1, z.min / 50);
            return [normalized, z.color];
        });
        // 确保最后到1.0
        colorStops.push([1, '#85182a']);

        chart.setOption({
            backgroundColor: 'transparent',
            series: [{
                type: 'gauge',
                min: 0,
                max: 50,
                startAngle: 180,
                endAngle: 0,
                center: ['50%', '78%'],
                radius: '100%',
                itemStyle: { color: zone ? zone.color : '#ffc107' },
                progress: {
                    show: true,
                    width: 16,
                    roundCap: true,
                    itemStyle: {
                        color: {
                            type: 'linear',
                            x: 0, y: 0, x2: 1, y2: 0,
                            colorStops: [
                                { offset: 0, color: '#0d7337' },
                                { offset: 0.3, color: '#28a745' },
                                { offset: 0.5, color: '#ffc107' },
                                { offset: 0.7, color: '#fd7e14' },
                                { offset: 0.85, color: '#dc3545' },
                                { offset: 1, color: '#85182a' },
                            ]
                        }
                    }
                },
                pointer: {
                    icon: 'triangle',
                    length: '55%',
                    width: 8,
                    offsetCenter: [0, '-10%'],
                    itemStyle: { color: '#e2e8f0' }
                },
                axisLine: {
                    lineStyle: {
                        width: 16,
                        color: [[1, 'rgba(255,255,255,0.08)']]
                    }
                },
                axisTick: { show: false },
                splitLine: {
                    distance: -18,
                    length: 8,
                    lineStyle: { width: 1, color: '#4a5568' }
                },
                axisLabel: {
                    distance: -32,
                    color: '#718096',
                    fontSize: 10,
                    formatter: function(v) {
                        if (v === 0) return '贪婪';
                        if (v === 20) return '20';
                        if (v === 30) return '30';
                        if (v === 50) return '恐惧';
                        return '';
                    }
                },
                title: {
                    offsetCenter: [0, '10%'],
                    fontSize: 12,
                    color: '#a0aec0',
                    fontWeight: 400,
                },
                detail: {
                    valueAnimation: true,
                    offsetCenter: [0, '-30%'],
                    fontSize: 28,
                    fontWeight: 800,
                    fontFamily: 'Roboto Mono, monospace',
                    color: zone ? zone.color : '#ffc107',
                    formatter: '{value}'
                },
                data: [{
                    value: Math.min(50, vixValue).toFixed(2),
                    name: zone ? zone.label : 'VIX'
                }],
                animationDuration: 1200,
                animationEasingUpdate: 'cubicOut',
            }]
        });
    }

    /**
     * 渲染VIX历史走势图（带恐惧区间着色）
     */
    function renderVIXKlineChart(kline, currentVIX) {
        const dom = document.getElementById('vix-kline-chart');
        if (!dom) return;

        let chart = echarts.getInstanceByDom(dom);
        if (!chart) chart = echarts.init(dom);

        const dates = kline.map(d => d.date);
        const closes = kline.map(d => d.close);

        const vixConfig = ETF_CONFIG.VIX_DASHBOARD;

        // 构建区间着色 markArea
        const markAreas = vixConfig.zones.map(z => [{
            yAxis: z.min,
            itemStyle: { color: z.color + '12' }
        }, {
            yAxis: Math.min(z.max, Math.max(...closes) + 5)
        }]);

        chart.setOption({
            backgroundColor: 'transparent',
            grid: { left: 50, right: 30, top: 20, bottom: 70 },
            tooltip: {
                trigger: 'axis',
                backgroundColor: '#1e293b',
                borderColor: '#4a5568',
                textStyle: { color: '#e2e8f0', fontSize: 12 },
                formatter: function(params) {
                    const d = params[0];
                    const v = d.value;
                    const z = ETF_CONFIG.getVIXZone(v);
                    return `<strong>${d.axisValue}</strong><br/>VIX: <span style="color:${z ? z.color : '#ffc107'};font-weight:700;">${v.toFixed(2)}</span><br/>区间: ${z ? z.emoji + ' ' + z.label : '--'}`;
                }
            },
            xAxis: {
                type: 'category',
                data: dates,
                axisLine: { lineStyle: { color: '#2d3748' } },
                axisLabel: { color: '#718096', fontSize: 10 },
                axisTick: { show: false },
            },
            yAxis: {
                type: 'value',
                min: function(val) { return Math.max(0, Math.floor(val.min - 2)); },
                axisLine: { lineStyle: { color: '#2d3748' } },
                axisLabel: { color: '#718096', fontSize: 10 },
                splitLine: { lineStyle: { color: '#2d3748', type: 'dashed' } },
            },
            dataZoom: [{
                type: 'slider',
                start: Math.max(0, 100 - (252 / kline.length) * 100),
                end: 100,
                height: 24,
                bottom: 10,
                borderColor: '#2d3748',
                fillerColor: 'rgba(233, 30, 99, 0.15)',
                handleStyle: { color: '#e91e63', borderColor: '#e91e63' },
                textStyle: { color: '#718096', fontSize: 10 },
                dataBackground: {
                    lineStyle: { color: '#e91e63', opacity: 0.3 },
                    areaStyle: { color: '#e91e63', opacity: 0.1 },
                }
            }],
            series: [{
                type: 'line',
                data: closes,
                smooth: 0.3,
                symbol: 'none',
                lineStyle: { color: '#e91e63', width: 1.5 },
                areaStyle: {
                    color: {
                        type: 'linear',
                        x: 0, y: 0, x2: 0, y2: 1,
                        colorStops: [
                            { offset: 0, color: 'rgba(233, 30, 99, 0.3)' },
                            { offset: 1, color: 'rgba(233, 30, 99, 0.02)' },
                        ]
                    }
                },
                markLine: {
                    silent: true,
                    symbol: 'none',
                    lineStyle: { type: 'dashed', width: 1 },
                    data: [
                        { yAxis: vixConfig.anchor.mean, label: { formatter: '均值 ' + vixConfig.anchor.mean, color: '#a0aec0', fontSize: 10 }, lineStyle: { color: '#4a5568' } },
                        { yAxis: currentVIX, label: { formatter: '当前 ' + currentVIX.toFixed(1), color: '#e91e63', fontSize: 10 }, lineStyle: { color: '#e91e63' } },
                        { yAxis: 20, label: { show: false }, lineStyle: { color: '#ffc10733' } },
                        { yAxis: 30, label: { show: false }, lineStyle: { color: '#dc354533' } },
                    ]
                },
                markArea: { silent: true, data: markAreas },
            }]
        });
    }

    // ========== 启动 ==========
    document.addEventListener('DOMContentLoaded', init);

    return { init, refreshData, switchETF, showInputModal, hideInputModal };
})();
