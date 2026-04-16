/**
 * signal.js - 多维度择时信号引擎
 * 
 * 巴菲特/芒格多维度评分体系：
 *   维度A: 估值分位 (PE越低越好)
 *   维度B: 安全边际 (股息率/FCF vs 无风险利率)
 *   维度C: 盈利质量 (ROE + PB合理性)
 *   维度D: 市场温度 (恐惧贪婪，越冷越买)
 * 
 * 总分 0-100 → 映射为8级信号
 */

const SignalEngine = (() => {
    'use strict';

    // ========== 信号级别定义 ==========
    const SIGNAL_LEVELS = {
        STRONG_BUY: {
            level: 'STRONG_BUY',
            text: '强烈买入',
            color: '#0d7337',
            bgColor: '#0d7337',
            textColor: '#ffffff',
            borderColor: '#0a5c2c',
            icon: '🟢',
            advice: '多维度综合评分极高：估值处于历史低位，安全边际极厚，市场情绪恐惧。巴菲特说"在别人恐惧时贪婪"，建议分批建仓，目标仓位50%+。',
            position: '分批建仓，目标仓位50%+'
        },
        BUY: {
            level: 'BUY',
            text: '买入',
            color: '#28a745',
            bgColor: '#28a745',
            textColor: '#ffffff',
            borderColor: '#1e7e34',
            icon: '🟢',
            advice: '综合评分较高：估值处于历史较低区间，安全边际尚可。芒格说"以合理的价格买入优质资产"，建议适度建仓30%-40%。',
            position: '可建仓，目标仓位30-40%'
        },
        HOLD_ADD: {
            level: 'HOLD_ADD',
            text: '持有/小幅加仓',
            color: '#9be3b0',
            bgColor: '#9be3b0',
            textColor: '#155724',
            borderColor: '#28a745',
            icon: '🔵',
            advice: '综合评分中等偏高：估值合理偏低，安全边际存在。建议维持现有仓位，可小幅加仓优化持仓成本。',
            position: '维持现有仓位'
        },
        HOLD: {
            level: 'HOLD',
            text: '持有观望',
            color: '#ffc107',
            bgColor: '#ffc107',
            textColor: '#856404',
            borderColor: '#d39e00',
            icon: '🟡',
            advice: '综合评分中性：估值既不便宜也不贵，安全边际一般。巴菲特说"宁愿以合理价格持有，也不轻易换仓"。建议不加不减，耐心等待。',
            position: '不加不减，耐心等待'
        },
        REDUCE_WARN: {
            level: 'REDUCE_WARN',
            text: '减仓预警',
            color: '#fd7e14',
            bgColor: '#fd7e14',
            textColor: '#ffffff',
            borderColor: '#dc6502',
            icon: '🟠',
            advice: '综合评分偏低：估值偏高，安全边际收窄，市场可能过度乐观。考虑逐步减仓，锁定部分利润。',
            position: '考虑减仓至30%'
        },
        SELL: {
            level: 'SELL',
            text: '卖出',
            color: '#dc3545',
            bgColor: '#dc3545',
            textColor: '#ffffff',
            borderColor: '#c82333',
            icon: '🔴',
            advice: '综合评分较低：估值偏高，安全边际薄弱。巴菲特的第一原则"永远不要亏损"。建议执行减仓至20%以下。',
            position: '执行减仓'
        },
        STRONG_SELL: {
            level: 'STRONG_SELL',
            text: '强烈卖出',
            color: '#85182a',
            bgColor: '#85182a',
            textColor: '#ffffff',
            borderColor: '#6c1022',
            icon: '🔴',
            advice: '综合评分极低：估值泡沫化，安全边际为负，市场贪婪过度。强烈建议分批减仓至20%以下。',
            position: '分批减仓至20%以下'
        },
        OVERHEAT: {
            level: 'OVERHEAT',
            text: '估值过热',
            color: '#85182a',
            bgColor: '#85182a',
            textColor: '#ffffff',
            borderColor: '#6c1022',
            icon: '🔥',
            advice: 'PE估值突破95%分位！历史极端高位。无论其他维度如何，应立即停止加仓。巴菲特说"在别人贪婪时恐惧"。',
            position: '停止加仓，考虑减持'
        },
        NEUTRAL: {
            level: 'NEUTRAL',
            text: '中性观望',
            color: '#6c757d',
            bgColor: '#6c757d',
            textColor: '#ffffff',
            borderColor: '#545b62',
            icon: '⚪',
            advice: '信号不明朗，各维度未形成一致方向。保持现有仓位，继续观察。',
            position: '保持现有仓位'
        },
        DATA_INCOMPLETE: {
            level: 'DATA_INCOMPLETE',
            text: '数据不完整',
            color: '#6c757d',
            bgColor: '#4a5568',
            textColor: '#ffffff',
            borderColor: '#718096',
            icon: '⚠️',
            advice: '缺少核心估值数据，无法生成多维度信号。请点击"补充数据"按钮手动填写PE、市场温度等数据。',
            position: '请先补充估值数据'
        }
    };

    // ========== 核心计算函数 ==========

    /**
     * 计算股债利差
     */
    function calcSpread(dividendYield, bondYield) {
        return parseFloat((dividendYield - bondYield).toFixed(4));
    }

    /**
     * 计算分位数
     */
    function calcPercentile(currentValue, historyArray) {
        if (!historyArray || historyArray.length === 0) return 50;
        const sorted = [...historyArray].sort((a, b) => a - b);
        const rank = sorted.filter(v => v <= currentValue).length;
        return parseFloat(((rank / sorted.length) * 100).toFixed(2));
    }

    /**
     * 多维度综合信号生成
     * @param {Object} data - 包含pePercentile, dividendYield, bondYield, roe, pb, marketTemp, trendScore等
     * @param {Object} etfConfig - ETF配置（含signalRules, dimWeights）
     * @returns {{ signal: Object, scores: Object, total: number }}
     */
    function generateMultiDimSignal(data, etfConfig) {
        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        const weights = etfConfig.dimWeights || {};

        // NaN防护：在输入数据层清理NaN值，转为null
        const cleanData = { ...data };
        ['marketTemp', 'pePercentile', 'spreadPercentile', 'trendScore', 'pe', 'pb', 'dividendYield', 'bondYield', 'roe', 'peMean', 'peStd'].forEach(key => {
            if (typeof cleanData[key] === 'number' && isNaN(cleanData[key])) {
                cleanData[key] = null;
                console.warn(`信号引擎: 输入数据 ${key} 为NaN，已清理为null`);
            }
        });

        // 计算各维度分数
        let scores = {};
        if (rules.calcScores) {
            scores = rules.calcScores(cleanData, weights);
        }

        // NaN防护：清理scores中可能的NaN
        Object.keys(scores).forEach(dim => {
            if (typeof scores[dim] === 'number' && isNaN(scores[dim])) {
                scores[dim] = null;
                console.warn(`信号引擎: 维度 ${dim} 评分为NaN，已清理为null`);
            }
        });

        // 生成信号关键字
        const signalKey = rules.generate(cleanData, weights);
        const signal = SIGNAL_LEVELS[signalKey] || SIGNAL_LEVELS.NEUTRAL;

        // 计算加权总分（用于仪表盘显示）
        let totalWeight = 0, weightedSum = 0;
        Object.keys(weights).forEach(dim => {
            if (scores[dim] !== null && scores[dim] !== undefined && !isNaN(scores[dim])) {
                weightedSum += scores[dim] * weights[dim];
                totalWeight += weights[dim];
            }
        });
        const total = totalWeight > 0 ? weightedSum / totalWeight : 0;

        // 最终NaN防护
        const safeTotal = isNaN(total) ? 0 : parseFloat(total.toFixed(1));

        return { signal, scores, total: safeTotal };
    }

    /**
     * 旧版兼容接口
     */
    function generateSignal(spreadPercentile, pePercentile) {
        const data = { spreadPercentile, pePercentile, dividendYield: 0, bondYield: 0 };
        const hasSpread = spreadPercentile !== null && spreadPercentile !== undefined;
        const hasPE = pePercentile !== null && pePercentile !== undefined;

        if (!hasSpread && !hasPE) return { ...SIGNAL_LEVELS.DATA_INCOMPLETE };

        // 简化兼容逻辑
        if (hasPE && pePercentile >= 95) return { ...SIGNAL_LEVELS.OVERHEAT };

        if (hasSpread && hasPE) {
            if (spreadPercentile <= 20 && pePercentile >= 80) return { ...SIGNAL_LEVELS.STRONG_SELL };
            if (spreadPercentile <= 20) return { ...SIGNAL_LEVELS.SELL };
            if (spreadPercentile >= 80 && pePercentile <= 30) return { ...SIGNAL_LEVELS.STRONG_BUY };
            if (spreadPercentile >= 80 && pePercentile <= 70) return { ...SIGNAL_LEVELS.BUY };
            if (spreadPercentile >= 50 && pePercentile <= 50) return { ...SIGNAL_LEVELS.HOLD_ADD };
            if (spreadPercentile >= 50 && pePercentile <= 80) return { ...SIGNAL_LEVELS.HOLD };
            if (spreadPercentile < 50 && pePercentile >= 70) return { ...SIGNAL_LEVELS.REDUCE_WARN };
        }

        return { ...SIGNAL_LEVELS.NEUTRAL };
    }

    /**
     * 利差分位区间描述
     */
    function getPercentileZone(percentile) {
        if (percentile >= 80) return { text: '极高', color: '#28a745', zone: 'high' };
        if (percentile >= 60) return { text: '偏高', color: '#9be3b0', zone: 'medium-high' };
        if (percentile >= 40) return { text: '中等', color: '#ffc107', zone: 'medium' };
        if (percentile >= 20) return { text: '偏低', color: '#fd7e14', zone: 'medium-low' };
        return { text: '极低', color: '#dc3545', zone: 'low' };
    }

    /**
     * PE分位区间描述
     */
    function getPEPercentileZone(percentile) {
        if (percentile >= 80) return { text: '高估', color: '#dc3545', zone: 'overvalued' };
        if (percentile >= 60) return { text: '偏高', color: '#fd7e14', zone: 'slightly-overvalued' };
        if (percentile >= 40) return { text: '合理', color: '#ffc107', zone: 'fair' };
        if (percentile >= 20) return { text: '偏低', color: '#9be3b0', zone: 'slightly-undervalued' };
        return { text: '低估', color: '#28a745', zone: 'undervalued' };
    }

    /**
     * 综合评分区间描述
     */
    function getCompositeScoreZone(score) {
        if (score >= 80) return { text: '极佳', color: '#0d7337', zone: 'excellent' };
        if (score >= 70) return { text: '较好', color: '#28a745', zone: 'good' };
        if (score >= 55) return { text: '偏好', color: '#9be3b0', zone: 'fair-good' };
        if (score >= 40) return { text: '中性', color: '#ffc107', zone: 'neutral' };
        if (score >= 25) return { text: '偏差', color: '#fd7e14', zone: 'fair-bad' };
        if (score >= 15) return { text: '较差', color: '#dc3545', zone: 'bad' };
        return { text: '极差', color: '#85182a', zone: 'terrible' };
    }

    /**
     * 市场温度描述（0=极度恐惧, 50=中性, 100=极度贪婪）
     */
    function getMarketTempDesc(temp) {
        if (temp >= 80) return { text: '极度贪婪 🤑', color: '#dc3545' };
        if (temp >= 60) return { text: '偏贪婪', color: '#fd7e14' };
        if (temp >= 40) return { text: '中性', color: '#ffc107' };
        if (temp >= 20) return { text: '偏恐惧', color: '#9be3b0' };
        return { text: '极度恐惧 😱', color: '#28a745' };
    }

    // ========== 历史信号回算 ==========

    /**
     * 基于历史数据回算每个月末的综合信号评分
     * 
     * 【方案B - 统一基准】不再依赖JSON中预设的percentile字段（那是硬编码的伪历史），
     * 改为用全量PE历史值统一计算分位，确保实时信号与历史走势图使用同一套基准。
     * 
     * @param {Object} historyData - JSON中的历史数据 (spreadHistory, peHistory, dividendYieldHistory, bondYieldHistory)
     * @param {Object} etfConfig - ETF配置（含signalRules, dimWeights）
     * @param {number} months - 回溯月数（默认96个月，即8年；数据不足时自动回退到全部可用历史）
     * @param {number|null} currentMarketTemp - 已弃用，保留参数兼容性。走势图统一使用marketTemp=50（中性）保证数据一致性
     * @returns {Array<{date, score, signal, signalText, signalColor}>}
     */
    function calcHistoricalSignals(historyData, etfConfig, months = 96, currentMarketTemp = null) {
        if (!historyData || !etfConfig) return [];

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        if (!rules || !rules.calcScores) return [];

        // 构建日期-值映射表
        const peMap = buildDateMap(historyData.peHistory);
        const spreadMap = buildDateMap(historyData.spreadHistory);
        const dividendMap = buildDateMap(historyData.dividendYieldHistory);
        const bondMap = buildDateMap(historyData.bondYieldHistory);

        // 获取所有可用的月末日期（取所有历史数据的并集）
        const allDates = new Set();
        if (historyData.peHistory) historyData.peHistory.forEach(d => allDates.add(d.date));
        if (historyData.spreadHistory) historyData.spreadHistory.forEach(d => allDates.add(d.date));
        if (historyData.bondYieldHistory) historyData.bondYieldHistory.forEach(d => allDates.add(d.date));
        if (historyData.dividendYieldHistory) historyData.dividendYieldHistory.forEach(d => allDates.add(d.date));
        if (historyData.priceHistory) historyData.priceHistory.forEach(d => allDates.add(d.date));

        // 按时间排序，取最近N个月
        const sortedDates = Array.from(allDates).sort();
        const recentDates = sortedDates.slice(-months);

        if (recentDates.length === 0) {
            console.warn(`[calcHistoricalSignals] ${etfConfig.id}: 无可用日期数据`);
            return [];
        }

        console.log(`[calcHistoricalSignals] ${etfConfig.id}: 找到 ${sortedDates.length} 个日期，取最近 ${recentDates.length} 个:`, recentDates[0], '...', recentDates[recentDates.length - 1]);

        // 【方案B核心】统一用全量PE历史值计算分位，不再使用JSON预设的percentile
        const allPeValues = historyData.peHistory ? historyData.peHistory.map(d => d.value) : [];

        // 全量利差历史值数组
        const allSpreadValues = historyData.spreadHistory ? historyData.spreadHistory.map(d => d.value) : [];

        // 获取valuationAnchor（均值偏离度锚点）
        const anchor = historyData.valuationAnchor || {};

        const results = [];
        for (const dateStr of recentDates) {
            const pe = peMap[dateStr];
            const spread = spreadMap[dateStr];
            const dividend = dividendMap[dateStr] || findNearestValue(dividendMap, dateStr);
            const bond = bondMap[dateStr] || findNearestValue(bondMap, dateStr);

            // 【方案B】PE分位：统一用本地全量PE值计算，与applyData中的calcPercentile基准一致
            let pePercentile = null;
            if (pe !== null && pe !== undefined && allPeValues.length >= 5) {
                pePercentile = calcPercentile(pe, allPeValues);
            }

            // 构建信号输入数据
            // marketTemp: 所有月份统一使用50（中性），保证走势图数据一致性
            // 原因：历史月份无法获取真实的市场情绪数据，如果设为null会跳过sentiment维度（权重25%），
            //       导致历史月份只用65权重计算，而当前月用90权重计算，分数基准不同无法对比。
            //       统一用50=中性，让sentiment维度对所有月份贡献一致（50分），走势图只反映估值变化。
            const marketTemp = 50;

            const signalData = {
                pePercentile: pePercentile,
                spreadPercentile: null,
                trendScore: null,
                pe: pe || 0,
                pb: 0, // 历史PB数据不全，用默认
                dividendYield: dividend || 0,
                bondYield: bond || 0,
                roe: 0, // 历史ROE不可用
                marketTemp: marketTemp,
                // 巴菲特均值回归锚点
                peMean: anchor.peMean || null,
                peStd: anchor.peStd || null,
            };

            // 对于使用利差的ETF，使用全量利差数据计算分位
            if (etfConfig.useBondSpread && spread !== null && spread !== undefined && allSpreadValues.length >= 5) {
                signalData.spreadPercentile = calcPercentile(spread, allSpreadValues);
            }

            // 生成综合信号
            const { signal, scores, total } = generateMultiDimSignal(signalData, etfConfig);

            results.push({
                date: dateStr,
                score: total,
                signal: signal.level,
                signalText: signal.text,
                signalColor: signal.color,
                // 附带各维度分数（用于tooltip）
                scores: { ...scores },
                pe: pe,
                pePercentile: pePercentile,
                dividend: dividend,
                bond: bond,
            });
        }

        return results;
    }

    /**
     * 构建 {date: value} 映射表
     */
    function buildDateMap(arr) {
        const map = {};
        if (!arr) return map;
        arr.forEach(d => { map[d.date] = d.value; });
        return map;
    }

    /**
     * 查找最近日期的值（向前查找）
     */
    function findNearestValue(dateMap, targetDate) {
        const dates = Object.keys(dateMap).sort();
        let nearest = null;
        for (const d of dates) {
            if (d <= targetDate) nearest = dateMap[d];
        }
        return nearest;
    }

    /**
     * 在两个日期之间线性插值数值
     * @param {string} startDate - 起始日期 YYYY-MM
     * @param {number} startVal - 起始值
     * @param {string} endDate - 结束日期 YYYY-MM
     * @param {number} endVal - 结束值
     * @param {string} targetDate - 目标日期 YYYY-MM-DD
     * @returns {number} 插值结果
     */
    function interpolate(startDate, startVal, endDate, endVal, targetDate) {
        const s = new Date(startDate + '-01').getTime();
        const e = new Date(endDate + '-01').getTime();
        const t = new Date(targetDate).getTime();
        if (e === s) return startVal;
        const ratio = Math.max(0, Math.min(1, (t - s) / (e - s)));
        return startVal + (endVal - startVal) * ratio;
    }

    /**
     * 从月度映射表中，为指定日期做线性插值取值
     * @param {Object} dateMap - {YYYY-MM: value}
     * @param {string[]} sortedKeys - dateMap的键，已排序
     * @param {string} targetDate - YYYY-MM-DD
     * @returns {number|null}
     */
    function interpolateFromMap(dateMap, sortedKeys, targetDate) {
        if (!sortedKeys || sortedKeys.length === 0) return null;
        const targetMonth = targetDate.slice(0, 7); // YYYY-MM

        // 精确命中月份
        if (dateMap[targetMonth] !== undefined) {
            // 找下一个月来插值
            const idx = sortedKeys.indexOf(targetMonth);
            if (idx >= 0 && idx < sortedKeys.length - 1) {
                const nextMonth = sortedKeys[idx + 1];
                return interpolate(targetMonth, dateMap[targetMonth], nextMonth, dateMap[nextMonth], targetDate);
            }
            return dateMap[targetMonth]; // 最后一个月，直接返回
        }

        // 在两个月之间
        let before = null, after = null;
        for (let i = 0; i < sortedKeys.length; i++) {
            if (sortedKeys[i] <= targetMonth) before = sortedKeys[i];
            if (sortedKeys[i] > targetMonth && after === null) after = sortedKeys[i];
        }

        if (before !== null && after !== null) {
            return interpolate(before, dateMap[before], after, dateMap[after], targetDate);
        }
        if (before !== null) return dateMap[before];
        if (after !== null) return dateMap[after];
        return null;
    }

    /**
     * 【方案B】为指定日期计算PE分位：先对PE值做日间插值，再用全量PE历史计算分位
     * 不再依赖JSON中预设的percentile字段，统一使用calcPercentile保证与实时信号基准一致
     */
    function interpolatePercentile(pePercentileMap, sortedPercentileKeys, peMap, sortedPeKeys, allPeValues, targetDate) {
        // 【方案B核心】始终用PE值做插值后计算分位，确保与实时信号使用同一套calcPercentile基准
        const pe = interpolateFromMap(peMap, sortedPeKeys, targetDate);
        if (pe !== null && allPeValues.length >= 5) {
            return calcPercentile(pe, allPeValues);
        }
        return null;
    }

    /**
     * 生成日期序列 (YYYY-MM-DD)
     * @param {string} startDate - 起始日期 YYYY-MM-DD
     * @param {string} endDate - 结束日期 YYYY-MM-DD
     * @returns {string[]}
     */
    function generateDateRange(startDate, endDate) {
        const dates = [];
        const current = new Date(startDate);
        const end = new Date(endDate);
        while (current <= end) {
            dates.push(current.toISOString().slice(0, 10));
            current.setDate(current.getDate() + 1);
        }
        return dates;
    }

    /**
     * 基于月度历史数据，通过插值生成日级别综合信号走势
     * 
     * 【方案B - 统一基准】不再依赖JSON中预设的percentile字段，
     * 改为对PE值做日间插值后，用全量PE历史统一计算分位。
     * 
     * @param {Object} historyData - JSON中的历史数据
     * @param {Object} etfConfig - ETF配置
     * @param {number} days - 回溯天数（默认365天，即1年）
     * @param {number|null} currentMarketTemp - 已弃用，保留参数兼容性。走势图统一使用marketTemp=50（中性）保证数据一致性
     * @returns {Array<{date, score, signal, signalText, signalColor, scores}>}
     */
    function calcDailyHistoricalSignals(historyData, etfConfig, days = 365, currentMarketTemp = null) {
        if (!historyData || !etfConfig) return [];

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        if (!rules || !rules.calcScores) return [];

        // 构建月度映射表
        const peMap = buildDateMap(historyData.peHistory);
        const spreadMap = buildDateMap(historyData.spreadHistory);
        const dividendMap = buildDateMap(historyData.dividendYieldHistory);
        const bondMap = buildDateMap(historyData.bondYieldHistory);

        const sortedPeKeys = Object.keys(peMap).sort();
        const sortedSpreadKeys = Object.keys(spreadMap).sort();
        const sortedDividendKeys = Object.keys(dividendMap).sort();
        const sortedBondKeys = Object.keys(bondMap).sort();

        // 【方案B核心】统一用全量PE值计算分位，不再读取JSON中的预设percentile
        const allPeValues = historyData.peHistory ? historyData.peHistory.map(d => d.value) : [];

        // 获取PE均值偏离度锚定数据
        const anchor = historyData.valuationAnchor || {};

        // 全量利差历史值
        const allSpreadValues = historyData.spreadHistory ? historyData.spreadHistory.map(d => d.value) : [];

        // 确定日期范围：从数据最早可用月的第1天，到今天
        const allMonths = new Set();
        [sortedPeKeys, sortedSpreadKeys, sortedDividendKeys, sortedBondKeys].forEach(keys => {
            keys.forEach(k => allMonths.add(k));
        });
        const sortedMonths = Array.from(allMonths).sort();
        if (sortedMonths.length < 2) return []; // 至少需要2个月才能插值

        // 结束日期：今天
        const today = new Date();
        const endDate = today.toISOString().slice(0, 10);

        // 起始日期：往前推 days 天
        const startDateObj = new Date(today);
        startDateObj.setDate(startDateObj.getDate() - days);
        // 不能早于数据最早月份
        const dataStart = sortedMonths[0] + '-01';
        const actualStart = startDateObj.toISOString().slice(0, 10) > dataStart
            ? startDateObj.toISOString().slice(0, 10) : dataStart;

        const dailyDates = generateDateRange(actualStart, endDate);
        if (dailyDates.length === 0) return [];

        // 采样：如果天数太多（>1000天），每隔N天取一个点，保持图表流畅
        let sampledDates = dailyDates;
        let sampleInterval = 1;
        if (dailyDates.length > 800) {
            sampleInterval = Math.ceil(dailyDates.length / 800);
            sampledDates = dailyDates.filter((_, i) => i % sampleInterval === 0);
            // 确保最后一天（今天）被包含
            if (sampledDates[sampledDates.length - 1] !== dailyDates[dailyDates.length - 1]) {
                sampledDates.push(dailyDates[dailyDates.length - 1]);
            }
        }

        const results = [];
        const lastDate = sampledDates[sampledDates.length - 1];

        for (const dateStr of sampledDates) {
            // 对每个日期做PE值插值
            const pe = interpolateFromMap(peMap, sortedPeKeys, dateStr);
            const dividend = interpolateFromMap(dividendMap, sortedDividendKeys, dateStr);
            const bond = interpolateFromMap(bondMap, sortedBondKeys, dateStr);
            
            // 【方案B】PE分位：用插值得到的PE值 + 全量PE历史统一计算分位
            let pePercentile = null;
            if (pe !== null && allPeValues.length >= 5) {
                pePercentile = calcPercentile(pe, allPeValues);
            }

            // 市场温度：所有日期统一使用50（中性），保证走势图数据一致性
            // 与月级别走势保持同一策略：走势图只反映估值+安全边际的变化趋势
            const marketTemp = 50;

            const signalData = {
                pePercentile: pePercentile,
                spreadPercentile: null,
                trendScore: null,
                pe: pe || 0,
                pb: 0,
                dividendYield: dividend || 0,
                bondYield: bond || 0,
                roe: 0,
                marketTemp: marketTemp,
                peMean: anchor.peMean || null,
                peStd: anchor.peStd || null,
            };

            // 利差分位
            if (etfConfig.useBondSpread) {
                const spread = interpolateFromMap(spreadMap, sortedSpreadKeys, dateStr);
                if (spread !== null && allSpreadValues.length >= 5) {
                    signalData.spreadPercentile = calcPercentile(spread, allSpreadValues);
                }
            }

            const { signal, scores, total } = generateMultiDimSignal(signalData, etfConfig);

            // === 对比线：使用旧的纯PE分位算法计算估值分 + 总分 ===
            // 旧算法: valuation = 100 - pePercentile（不使用均值偏离度）
            let purePercentileScore = null;
            if (pePercentile !== null && pePercentile !== undefined) {
                purePercentileScore = Math.max(0, Math.min(100, 100 - pePercentile));
            }
            // 用旧估值分替换新估值分，重新加权得到旧总分
            let oldTotal = null;
            if (purePercentileScore !== null) {
                const oldScores = { ...scores, valuation: purePercentileScore };
                const weights = etfConfig.dimWeights || {};
                let tw = 0, ws = 0;
                Object.keys(weights).forEach(dim => {
                    if (oldScores[dim] !== null && oldScores[dim] !== undefined && !isNaN(oldScores[dim])) {
                        ws += oldScores[dim] * weights[dim];
                        tw += weights[dim];
                    }
                });
                oldTotal = tw > 0 ? parseFloat((ws / tw).toFixed(1)) : null;
            }

            results.push({
                date: dateStr,
                score: total,
                signal: signal.level,
                signalText: signal.text,
                signalColor: signal.color,
                scores: { ...scores },
                pe: pe,
                pePercentile: pePercentile,
                dividend: dividend,
                bond: bond,
                // 对比数据（旧的纯PE分位算法）
                oldValuationScore: purePercentileScore,
                oldTotal: oldTotal,
            });
        }

        return results;
    }

    // ========== 智能解读生成 ==========

    /**
     * 基于各维度分数生成芒格式智能解读
     * @param {Object} scores - { valuation, safety, quality, sentiment } 各维度分数
     * @param {Object} dimWeights - { valuation: 40, safety: 30, ... } 各维度权重
     * @param {Object} signalData - 原始信号输入数据（pe, marketTemp等）
     * @param {Object} etfConfig - ETF配置
     * @returns {Object} { items: [{icon, title, desc, color}], action: {text, color, icon}, note: string }
     */
    function generateInterpretation(scores, dimWeights, signalData, etfConfig) {
        const items = [];
        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        const isGoldOrCommodity = etfConfig.type === 'gold' || etfConfig.type === 'commodity';
        const isBond = etfConfig.type === 'bond';

        // 如果是黄金/商品（纯趋势跟踪），不生成多维度解读
        if (isGoldOrCommodity) {
            return null;
        }

        // ===== 1. 估值分位解读 =====
        const vScore = scores.valuation;
        if (vScore !== null && vScore !== undefined) {
            const pePercentile = signalData.pePercentile;
            let desc, color;
            if (vScore >= 70) {
                desc = `PE分位 ${pePercentile !== null ? pePercentile.toFixed(0) + '%' : '--'}，处于历史低位区间，估值确实便宜`;
                color = '#28a745';
            } else if (vScore >= 55) {
                desc = `PE分位 ${pePercentile !== null ? pePercentile.toFixed(0) + '%' : '--'}，估值偏低，有一定吸引力`;
                color = '#9be3b0';
            } else if (vScore >= 40) {
                desc = `PE分位 ${pePercentile !== null ? pePercentile.toFixed(0) + '%' : '--'}，估值中等，不贵不便宜`;
                color = '#ffc107';
            } else if (vScore >= 25) {
                desc = `PE分位 ${pePercentile !== null ? pePercentile.toFixed(0) + '%' : '--'}，估值偏高，性价比不足`;
                color = '#fd7e14';
            } else {
                desc = `PE分位 ${pePercentile !== null ? pePercentile.toFixed(0) + '%' : '--'}，估值处于历史高位，需警惕`;
                color = '#dc3545';
            }
            items.push({
                icon: '📊',
                title: '估值水平',
                score: vScore,
                desc,
                color,
                weight: dimWeights.valuation || 0,
            });
        }

        // ===== 2. 安全边际解读 =====
        const sScore = scores.safety;
        if (sScore !== null && sScore !== undefined && (dimWeights.safety || 0) > 0) {
            let desc, color;
            if (sScore >= 70) {
                desc = '安全边际充裕，即使判断有误也有较好的保护';
                color = '#28a745';
            } else if (sScore >= 55) {
                desc = '安全边际尚可，有一定的缓冲空间';
                color = '#9be3b0';
            } else if (sScore >= 40) {
                desc = '安全边际一般，缓冲空间有限';
                color = '#ffc107';
            } else if (sScore >= 25) {
                desc = '安全边际薄弱，下行风险较大';
                color = '#fd7e14';
            } else {
                desc = '安全边际极低，风险暴露明显';
                color = '#dc3545';
            }
            items.push({
                icon: '🛡️',
                title: '安全边际',
                score: sScore,
                desc,
                color,
                weight: dimWeights.safety || 0,
            });
        }

        // ===== 3. 市场情绪解读 =====
        const sentScore = scores.sentiment;
        if (sentScore !== null && sentScore !== undefined && (dimWeights.sentiment || 0) > 0) {
            const marketTemp = signalData.marketTemp;
            let tempText = '';
            if (marketTemp !== null && marketTemp !== undefined) {
                const tempDesc = getMarketTempDesc(marketTemp);
                tempText = `（${tempDesc.text}，指数${marketTemp.toFixed(0)}）`;
            }
            
            let desc, color;
            if (sentScore >= 70) {
                desc = `市场偏恐惧${tempText}`;
                color = '#28a745';
            } else if (sentScore >= 55) {
                desc = `市场情绪偏冷${tempText}`;
                color = '#9be3b0';
            } else if (sentScore >= 40) {
                desc = `市场情绪中性${tempText}`;
                color = '#ffc107';
            } else if (sentScore >= 25) {
                desc = `市场偏乐观${tempText}`;
                color = '#fd7e14';
            } else {
                desc = `市场贪婪过度${tempText}`;
                color = '#dc3545';
            }
            items.push({
                icon: '🌡️',
                title: '市场情绪',
                score: sentScore,
                desc,
                color,
                weight: dimWeights.sentiment || 0,
            });
        }

        // ===== 4. 综合操作建议（芒格决策矩阵）=====
        const hasValuation = vScore !== null && vScore !== undefined;
        const hasSafety = sScore !== null && sScore !== undefined;
        const hasSentiment = sentScore !== null && sentScore !== undefined;

        let action = null;
        if (hasValuation) {
            const vLevel = vScore >= 55 ? 'cheap' : (vScore >= 35 ? 'fair' : 'expensive');
            const sLevel = hasSafety ? (sScore >= 55 ? 'thick' : (sScore >= 35 ? 'thin' : 'none')) : 'unknown';
            const sentLevel = hasSentiment ? (sentScore >= 55 ? 'fear' : (sentScore >= 40 ? 'neutral' : 'greed')) : 'neutral';

            if (vLevel === 'cheap' && (sLevel === 'thick' || sLevel === 'unknown')) {
                if (sentLevel === 'fear') {
                    action = {
                        text: '估值低+安全边际厚+市场恐惧 → 芒格时刻："在别人恐惧时贪婪"，可果断分批建仓',
                        color: '#0d7337',
                        icon: '🟢',
                        type: 'strong_buy'
                    };
                } else if (sentLevel === 'greed') {
                    action = {
                        text: '估值低+安全边际厚+市场偏贪 → 基本面支撑买入，但短期别急，可分批建仓',
                        color: '#28a745',
                        icon: '🔵',
                        type: 'buy_patience'
                    };
                } else {
                    action = {
                        text: '估值低+安全边际厚+情绪中性 → 好价格好资产，正常节奏建仓即可',
                        color: '#28a745',
                        icon: '🟢',
                        type: 'buy'
                    };
                }
            } else if (vLevel === 'cheap' && sLevel === 'thin') {
                action = {
                    text: '估值偏低但安全边际不足 → 有机会但需谨慎，建议小仓位试探',
                    color: '#9be3b0',
                    icon: '🔵',
                    type: 'small_buy'
                };
            } else if (vLevel === 'fair') {
                if (sentLevel === 'fear') {
                    action = {
                        text: '估值中等+市场恐惧 → 不算便宜但情绪给了折扣，可小仓位试探',
                        color: '#9be3b0',
                        icon: '🔵',
                        type: 'small_try'
                    };
                } else if (sentLevel === 'greed') {
                    action = {
                        text: '估值中等+市场偏贪 → 不便宜且大家都在嗨，听实时信号，观望为主',
                        color: '#ffc107',
                        icon: '🟡',
                        type: 'wait'
                    };
                } else {
                    action = {
                        text: '估值中等+情绪中性 → 无明显机会，耐心持有等待更好的价格',
                        color: '#ffc107',
                        icon: '🟡',
                        type: 'hold'
                    };
                }
            } else {
                // expensive
                if (sentLevel === 'greed') {
                    action = {
                        text: '估值偏高+市场贪婪 → 双重警告！芒格说"在别人贪婪时恐惧"，考虑减仓',
                        color: '#dc3545',
                        icon: '🔴',
                        type: 'reduce'
                    };
                } else if (sentLevel === 'fear') {
                    action = {
                        text: '估值偏高但市场恐惧 → 可能是下跌中继的反弹，不要轻易抄底',
                        color: '#fd7e14',
                        icon: '🟠',
                        type: 'caution'
                    };
                } else {
                    action = {
                        text: '估值偏高+情绪中性 → 性价比不足，建议逐步减仓或观望',
                        color: '#fd7e14',
                        icon: '🟠',
                        type: 'reduce_or_wait'
                    };
                }
            }
        }

        // ===== 5. 找出影响总分最大的维度 =====
        let note = '';
        if (items.length >= 2) {
            // 找出得分最高和最低的维度
            const sorted = [...items].sort((a, b) => b.score - a.score);
            const highest = sorted[0];
            const lowest = sorted[sorted.length - 1];
            const gap = highest.score - lowest.score;
            
            if (gap >= 25) {
                note = `📌 维度分歧提示：「${highest.title}」(${highest.score.toFixed(0)}分) 与「${lowest.title}」(${lowest.score.toFixed(0)}分) 差距较大(${gap.toFixed(0)}分)，建议重点关注${lowest.title}的变化`;
            }
        }

        return { items, action, note };
    }

    // ========== PE偏离度估值计算（巴菲特均值回归体系）==========

    /**
     * 基于PE均值偏离度计算估值分数
     * 
     * 核心思想（芒格/巴菲特）：
     *   - 估值的"锚"是该指数自身的长期PE均值（peMean）
     *   - "离正常水平有多远"比"排在历史第几"更有意义
     *   - 偏离度 = (当前PE - 均值PE) / 标准差
     *   - 映射为0-100分：均值=50分，-2σ=95分（极度便宜），+2σ=5分（极度昂贵）
     * 
     * @param {number} currentPE - 当前PE值
     * @param {number} peMean - PE历史均值
     * @param {number} peStd - PE历史标准差
     * @returns {number|null} 0-100分，分越高越便宜
     */
    function calcDeviationScore(currentPE, peMean, peStd) {
        if (!currentPE || currentPE <= 0 || !peMean || peMean <= 0 || !peStd || peStd <= 0) {
            return null;
        }
        // 偏离度：正值=高于均值（贵），负值=低于均值（便宜）
        const deviation = (currentPE - peMean) / peStd;
        // 映射到0-100：偏离度0→50分，-2σ→95分，+2σ→5分
        // 使用线性映射：score = 50 - deviation * 22.5
        // 这样 deviation=-2 → score=95, deviation=0 → 50, deviation=+2 → 5
        const score = 50 - deviation * 22.5;
        return Math.max(0, Math.min(100, score));
    }

    /**
     * 混合估值分数：偏离度×0.7 + PE分位×0.3
     * 
     * 芒格"多把尺子"理论：偏离度回答"离正常水平多远"，分位回答"在历史中排第几"，
     * 两者互补验证，结论更可靠。
     * 
     * @param {number} currentPE - 当前PE
     * @param {number} peMean - PE均值
     * @param {number} peStd - PE标准差
     * @param {number|null} pePercentile - PE历史分位（0-100，可为null）
     * @returns {number|null} 混合估值分（0-100），分越高越便宜
     */
    function calcHybridValuationScore(currentPE, peMean, peStd, pePercentile) {
        const deviationScore = calcDeviationScore(currentPE, peMean, peStd);
        
        // 如果偏离度分数不可用，回退到纯分位
        if (deviationScore === null) {
            if (pePercentile !== null && pePercentile !== undefined) {
                return Math.max(0, Math.min(100, 100 - pePercentile));
            }
            return null;
        }
        
        // 如果分位数据不可用，纯用偏离度
        if (pePercentile === null || pePercentile === undefined) {
            return deviationScore;
        }
        
        // 双维度混合：偏离度70% + 分位30%
        const percentileScore = Math.max(0, Math.min(100, 100 - pePercentile));
        return deviationScore * 0.7 + percentileScore * 0.3;
    }

    // ========== 综合分历史分位计算 ==========

    /**
     * 综合分历史分位 → 安全等级判定（纯分位维度）
     * 
     * 设计原则：
     *   历史分位是一个**独立的参考维度**，只回答一个问题：
     *   "历史上有多少时间比现在更差？"
     *   
     *   它不考虑综合分的绝对水平（那是信号卡片的职责），
     *   也不对当前是否该买入/卖出做判断。
     *   
     *   分位低 = 历史上多数时间比现在好 = 当前处于历史偏低位置
     *   分位高 = 历史上多数时间比现在差 = 当前处于历史偏高位置
     * 
     * @param {number} percentile - 分位数 0-100
     * @param {boolean} detailed - 是否返回详细desc字段（摘要区用true，图表tooltip用false）
     * @returns {Object} zone对象
     */
    function getScorePercentileZone(percentile, detailed) {
        let level; // 0=历史低位, 1=偏低, 2=中等, 3=偏高, 4=历史高位
        if (percentile >= 80) level = 4;
        else if (percentile >= 65) level = 3;
        else if (percentile >= 45) level = 2;
        else if (percentile >= 25) level = 1;
        else level = 0;

        const zones = detailed ? [
            { text: '历史低位', color: '#dc3545', icon: '🔴', desc: '历史上绝大多数时间综合评分高于当前，处于历史极低位置' },
            { text: '历史偏低', color: '#fd7e14', icon: '🟠', desc: '历史上多数时间综合评分高于当前，处于历史偏低位置' },
            { text: '历史中位', color: '#ffc107', icon: '🟡', desc: '当前综合评分在历史中处于中间水平' },
            { text: '历史偏高', color: '#28a745', icon: '🟢', desc: '历史上多数时间综合评分低于当前，处于历史偏高位置' },
            { text: '历史高位', color: '#0d7337', icon: '🟢', desc: '历史上绝大多数时间综合评分低于当前，处于历史极高位置' },
        ] : [
            { text: '历史低位', color: '#dc3545' },
            { text: '历史偏低', color: '#fd7e14' },
            { text: '历史中位', color: '#ffc107' },
            { text: '历史偏高', color: '#28a745' },
            { text: '历史高位', color: '#0d7337' },
        ];

        return zones[level];
    }

    /**
     * 计算当前综合评分在全部历史综合评分中的分位数
     * 
     * 纯历史维度的量化指标：
     *   "历史上有多少时间比现在更差？"
     *   分位越高 = 历史上更多时间比现在差 = 当前处于历史较高位置
     *   分位越低 = 历史上更多时间比现在好 = 当前处于历史较低位置
     * 
     * 注意：此指标不对"当前是否安全"做结论，那是综合信号的职责。
     *       此指标只回答"当前在历史中排第几"。
     * 
     * @param {number} currentScore - 当前综合评分
     * @param {Array} dailySignals - calcDailyHistoricalSignals 返回的日级别历史信号数组
     * @returns {{ percentile: number, worseDays: number, totalDays: number, zone: Object }}
     */
    function calcScoreHistoricalPercentile(currentScore, dailySignals) {
        if (!dailySignals || dailySignals.length === 0) {
            return { percentile: 50, worseDays: 0, totalDays: 0, zone: { text: '无数据', color: '#718096' } };
        }

        const allScores = dailySignals.map(d => d.score);
        const percentile = calcPercentile(currentScore, allScores);
        const worseDays = allScores.filter(s => s <= currentScore).length;

        // 纯分位维度判定，不混入综合分绝对值
        const zone = getScorePercentileZone(percentile, true);

        return {
            percentile: parseFloat(percentile.toFixed(1)),
            worseDays: worseDays,
            totalDays: allScores.length,
            zone: zone,
        };
    }

    /**
     * 基于日级别历史信号，计算每个时间点的综合分累计分位走势
     * 用于绘制"综合分历史分位"图表 — 显示综合评分在全部历史中的相对位置变化
     * 
     * @param {Array} dailySignals - calcDailyHistoricalSignals 返回的日级别数据
     * @returns {Array<{date, score, percentile, zone}>}
     */
    function calcScorePercentileSeries(dailySignals) {
        if (!dailySignals || dailySignals.length === 0) return [];

        // 收集全量历史分数作为参照基准
        const allScores = dailySignals.map(d => d.score);

        return dailySignals.map(d => {
            const pct = calcPercentile(d.score, allScores);
            // 纯分位维度判定
            const zone = getScorePercentileZone(pct, false);

            return {
                date: d.date,
                score: d.score,
                percentile: parseFloat(pct.toFixed(1)),
                signalText: d.signalText,
                signalColor: d.signalColor,
                zone: zone,
            };
        });
    }

    // ========== 公开API ==========
    return {
        SIGNAL_LEVELS,
        calcSpread,
        calcPercentile,
        calcDeviationScore,
        calcHybridValuationScore,
        generateSignal,
        generateMultiDimSignal,
        calcHistoricalSignals,
        calcDailyHistoricalSignals,
        calcScoreHistoricalPercentile,
        calcScorePercentileSeries,
        getScorePercentileZone,
        getPercentileZone,
        getPEPercentileZone,
        getCompositeScoreZone,
        getMarketTempDesc,
        generateInterpretation
    };
})();
