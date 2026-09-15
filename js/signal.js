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

        const cleanData = { ...data };
        ['marketTemp', 'pePercentile', 'spreadPercentile', 'trendScore', 'pe', 'pb', 'dividendYield', 'bondYield', 'roe', 'peMean', 'peStd'].forEach(key => {
            cleanData[key] = DataQuality.number(cleanData[key]);
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

        const primaryField = DataQuality.primaryField(etfConfig);
        const primaryDim = primaryField === 'trendScore' ? 'sentiment' : 'valuation';
        const hardReasons = [...(data.quality && data.quality.hardReasons || [])];
        if (!DataQuality.valid(primaryField, cleanData[primaryField])) hardReasons.push(`缺少有效${primaryField}，不能仅凭情绪评分`);
        if (!Number.isFinite(scores[primaryDim])) hardReasons.push('缺少可比估值基准或趋势数据');
        if (DataQuality.isProxy(etfConfig) && !(data.valuationBasis && data.valuationBasis.indexId)) hardReasons.push('代理估值尚未选择同指数参照');
        const reasons = [...(data.quality && data.quality.reasons || [])];
        DataQuality.requiredFields(etfConfig).forEach(field => {
            if (!DataQuality.valid(field, cleanData[field])) reasons.push(`缺少${field}，使用可用维度参考`);
        });
        if (etfConfig.signalRules === 'buffett_stock' && !Number.isFinite(scores.quality)) reasons.push('个股盈利质量未完整评估');
        let totalWeight = 0, weightedSum = 0;
        const activeDimensions = Object.keys(weights).filter(dim => weights[dim] > 0 && Number.isFinite(scores[dim]));
        activeDimensions.forEach(dim => {
            weightedSum += scores[dim] * weights[dim];
            totalWeight += weights[dim];
        });
        const total = totalWeight > 0 ? Number((weightedSum / totalWeight).toFixed(1)) : 0;
        const fullWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
        if (data.quality && totalWeight < fullWeight) reasons.push('部分评分维度缺失，当前为可用维度参考分');
        if (data.valuationBasis && data.valuationBasis.isProxy) reasons.push('代理指数只作参考');
        const calculable = hardReasons.length === 0 && totalWeight > 0;
        const allowed = calculable && reasons.length === 0 && (!data.quality || data.quality.allowed);
        const quality = { ...(data.quality || {}), allowed, calculable, status: allowed ? 'verified' : calculable ? 'reference' : 'unavailable',
            reasons: [...new Set(reasons)], hardReasons: [...new Set(hardReasons)], activeDimensions,
            coverage: fullWeight > 0 ? Math.round(totalWeight / fullWeight * 100) : 0 };
        const signalKey = calculable ? rules.generate(cleanData, weights) : 'DATA_INCOMPLETE';
        const signal = { ...(SIGNAL_LEVELS[signalKey] || SIGNAL_LEVELS.NEUTRAL), quality };
        if (!calculable) {
            signal.text = '暂无法计算';
            signal.advice = quality.hardReasons.join('；') + '。仍可查看下方已有估值历史或价格趋势。';
            signal.position = '缺少计算依据';
            signal.icon = '—';
        } else if (!allowed) {
            const labels = { STRONG_BUY: '吸引力很高', BUY: '吸引力偏高', HOLD_ADD: '略有吸引力', HOLD: '吸引力中等', REDUCE_WARN: '吸引力偏低', SELL: '吸引力较低', STRONG_SELL: '吸引力很低', OVERHEAT: '估值偏高', NEUTRAL: '中性' };
            signal.level = 'REFERENCE';
            signal.referenceLevel = signalKey;
            const proxy = data.valuationBasis && data.valuationBasis.isProxy;
            signal.text = `${labels[signalKey] || '参考分析'} · ${proxy ? '代理参考' : '参考'}`;
            signal.position = `可用维度参考评分 · 覆盖原权重${quality.coverage}%`;
            signal.advice = `按${quality.dateLabel || quality.asOf || '日期未知'}的${proxy ? data.valuationBasis.label : '已记录数据'}计算，参考分${total.toFixed(1)}。可判断估值吸引力与维度分歧；时效、缺项或代理限制见下方，不直接折算仓位。`;
            signal.icon = '参考';
        }
        return { signal, scores, total: calculable ? total : 0, referenceTotal: total, quality };
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
     * 【方案B增强 - 实时PE注入】当API获取到实时PE时，更新当月的PE值，
     * 让月级别走势图的最后一个数据点也能反映最新估值变化。
     * 
     * @param {Object} historyData - JSON中的历史数据 (spreadHistory, peHistory, dividendYieldHistory, bondYieldHistory)
     * @param {Object} etfConfig - ETF配置（含signalRules, dimWeights）
     * @param {number} months - 回溯月数（默认96个月，即8年；数据不足时自动回退到全部可用历史）
     * @param {number|null} currentMarketTemp - 已弃用，保留参数兼容性。走势图统一使用marketTemp=50（中性）保证数据一致性
     * @param {Object|null} realtimeData - 实时数据 { pe, dividendYield, bondYield }，API获取成功时传入
     * @returns {Array<{date, score, signal, signalText, signalColor}>}
     */
    function calcHistoricalSignals(historyData, etfConfig, months = 96, currentMarketTemp = null, realtimeData = null) {
        if (!historyData || !etfConfig || (DataQuality.isProxy(etfConfig) && !historyData.referenceBasis)) return [];
        historyData = DataQuality.monthlyHistory(DataQuality.comparableHistory(historyData, etfConfig));

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        if (!rules || !rules.calcScores) return [];

        // 构建日期-值映射表
        const peMap = buildDateMap(historyData.peHistory);
        const spreadMap = buildDateMap(historyData.spreadHistory);
        const dividendMap = buildDateMap(historyData.dividendYieldHistory);
        const bondMap = buildDateMap(historyData.bondYieldHistory);

        if (realtimeData) {
            for (const [field, map, dateField] of [['pe', peMap, 'asOf'], ['dividendYield', dividendMap, 'dividendAsOf'], ['bondYield', bondMap, 'bondAsOf']]) {
                const date = DataQuality.asOf(realtimeData[dateField]);
                if (date && date <= DataQuality.today() && DataQuality.valid(field, realtimeData[field])) map[date.slice(0, 7)] = realtimeData[field];
            }
        }
        const allDates = new Set(Object.keys(etfConfig.type === 'bond' ? bondMap : peMap));

        // 按时间排序，取最近N个月
        const sortedDates = Array.from(allDates).sort();
        const recentDates = sortedDates.slice(-months);

        if (recentDates.length === 0) {
            console.warn(`[calcHistoricalSignals] ${etfConfig.id}: 无可用日期数据`);
            return [];
        }

        console.log(`[calcHistoricalSignals] ${etfConfig.id}: 找到 ${sortedDates.length} 个日期，取最近 ${recentDates.length} 个:`, recentDates[0], '...', recentDates[recentDates.length - 1]);

        const allPeValues = DataQuality.referenceValues(historyData, 'peHistory');
        const allSpreadValues = DataQuality.referenceValues(historyData, 'spreadHistory');

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
                valuationBasis: historyData.referenceBasis,
                quality: { allowed: false, reasons: ['历史重算仅作参考，不代表当时交易信号'], dateLabel: dateStr },
                spreadPercentile: null,
                trendScore: null,
                pe: pe || 0,
                pb: 0, // 历史PB数据不全，用默认
                dividendYield: dividend,
                bondYield: bond,
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
            if (signal.level === 'DATA_INCOMPLETE') continue;

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
     * 支持混合日期格式：YYYY-MM（月度）和 YYYY-MM-DD（日级别）
     * 日级别数据和月度数据共存，interpolateFromMap 会优先使用日级别精确命中
     */
    function buildDateMap(arr, useObservationDate = false) {
        const map = {};
        if (!arr) return map;
        arr.forEach(d => {
            const key = useObservationDate ? DataQuality.asOf(d.asOf) || d.date : d.date;
            map[key] = d.value;
        });
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
     * 在两个日期之间线性插值数值（月级别：startDate/endDate 为 YYYY-MM）
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
     * 在两个日级别日期之间线性插值（startDate/endDate 为 YYYY-MM-DD）
     * @param {string} startDate - 起始日期 YYYY-MM-DD
     * @param {number} startVal - 起始值
     * @param {string} endDate - 结束日期 YYYY-MM-DD
     * @param {number} endVal - 结束值
     * @param {string} targetDate - 目标日期 YYYY-MM-DD
     * @returns {number} 插值结果
     */
    function interpolateDaily(startDate, startVal, endDate, endVal, targetDate) {
        const s = new Date(startDate).getTime();
        const e = new Date(endDate).getTime();
        const t = new Date(targetDate).getTime();
        if (e === s) return startVal;
        const ratio = Math.max(0, Math.min(1, (t - s) / (e - s)));
        return startVal + (endVal - startVal) * ratio;
    }

    /**
     * 从映射表中，为指定日期取值（支持日级别精确命中 + 月级别插值混合）
     * 
     * 数据查找优先级：
     * 1. 精确命中 YYYY-MM-DD 日级别数据 → 直接返回（最优，真实采样值）
     * 2. 日级别数据间插值 → 在两个相邻日级别点之间线性插值
     * 3. 月级别数据插值 → 回退到原有的月间插值逻辑
     * 
     * @param {Object} dateMap - {YYYY-MM: value} 或 {YYYY-MM-DD: value} 混合
     * @param {string[]} sortedKeys - dateMap的键，已排序（混合了YYYY-MM和YYYY-MM-DD）
     * @param {string} targetDate - YYYY-MM-DD
     * @returns {number|null}
     */
    function interpolateFromMap(dateMap, sortedKeys, targetDate) {
        let previous = null;
        for (const key of sortedKeys || []) {
            const date = key.length === 7 ? key + '-01' : key;
            if (date <= targetDate) previous = key;
            else break;
        }
        if (previous === null) return null;
        const date = previous.length === 7 ? previous + '-01' : previous;
        const age = (Date.parse(targetDate) - Date.parse(date)) / 86400000;
        const maxAge = previous.length === 7 ? 31 : 7;
        return age <= maxAge ? dateMap[previous] : null;
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
     * 【方案B增强 - 实时PE注入】当API获取到实时PE时，将其作为"当前时刻"的锚点，
     * 让JSON最后一个月到今天的日级别数据能体现PE的实际变化，而非停留在JSON的静态值。
     * 
     * @param {Object} historyData - JSON中的历史数据
     * @param {Object} etfConfig - ETF配置
     * @param {number} days - 回溯天数（默认365天，即1年）
     * @param {number|null} currentMarketTemp - 已弃用，保留参数兼容性。走势图统一使用marketTemp=50（中性）保证数据一致性
     * @param {Object|null} realtimeData - 实时数据 { pe, dividendYield, bondYield }，API获取成功时传入
     * @returns {Array<{date, score, signal, signalText, signalColor, scores}>}
     */
    function calcDailyHistoricalSignals(historyData, etfConfig, days = 365, currentMarketTemp = null, realtimeData = null) {
        if (!historyData || !etfConfig || (DataQuality.isProxy(etfConfig) && !historyData.referenceBasis)) return [];
        historyData = DataQuality.comparableHistory(historyData, etfConfig);

        const rules = ETF_CONFIG.getSignalRules(etfConfig.signalRules);
        if (!rules || !rules.calcScores) return [];

        // 有源日期的采样使用真实观测日，旧月度记录保留月度位置。
        const peMap = buildDateMap(historyData.peHistory, true);
        const spreadMap = buildDateMap(historyData.spreadHistory, true);
        const dividendMap = buildDateMap(historyData.dividendYieldHistory, true);
        const bondMap = buildDateMap(historyData.bondYieldHistory, true);

        const today = new Date();
        const todayStr = DataQuality.today(today);
        const observationDate = realtimeData && DataQuality.asOf(realtimeData.asOf);
        if (observationDate && observationDate <= todayStr && realtimeData.pe > 0) peMap[observationDate] = realtimeData.pe;
        if (realtimeData) {
            for (const [field, map, dateField] of [['dividendYield', dividendMap, 'dividendAsOf'], ['bondYield', bondMap, 'bondAsOf']]) {
                const date = DataQuality.asOf(realtimeData[dateField]);
                if (date && date <= todayStr && DataQuality.valid(field, realtimeData[field])) map[date] = realtimeData[field];
            }
        }

        const sortedPeKeys = Object.keys(peMap).sort();
        const sortedSpreadKeys = Object.keys(spreadMap).sort();
        const sortedDividendKeys = Object.keys(dividendMap).sort();
        const sortedBondKeys = Object.keys(bondMap).sort();

        const allPeValues = DataQuality.referenceValues(historyData, 'peHistory');
        const anchor = historyData.valuationAnchor || {};
        const allSpreadValues = DataQuality.referenceValues(historyData, 'spreadHistory');

        const startDate = new Date(Date.parse(todayStr) - days * 86400000).toISOString().slice(0, 10);
        const primaryKeys = etfConfig.type === 'bond' ? sortedBondKeys : sortedPeKeys;
        const sampledDates = [...new Set(primaryKeys.map(key => key.length === 7 ? key + '-01' : key))]
            .filter(date => date >= startDate && date <= todayStr).sort();
        const results = [];

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
                valuationBasis: historyData.referenceBasis,
                quality: { allowed: false, reasons: ['历史重算仅作参考，不代表当时交易信号'], dateLabel: dateStr },
                spreadPercentile: null,
                trendScore: null,
                pe: pe || 0,
                pb: 0,
                dividendYield: dividend,
                bondYield: bond,
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
            if (signal.level === 'DATA_INCOMPLETE') continue;

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

    // ========== 趋势强度分析（右侧浅回撤追踪策略） ==========

    /**
     * 基于K线计算"距前高回撤"类趋势强度指标
     *
     * 策略灵感：社交网络上热议的"17号右侧浅回撤追踪"策略
     *   核心思想："好趋势跌不深"——回撤<20%的标的，大概率趋势仍在
     *   买入信号：距离前高回撤 < 20%（右侧浅回撤）
     *   卖出信号：距离前高回撤 ≥ 20%（趋势已坏）
     *
     * 我们不作为操作指令，而是把它量化为"趋势强度分"（0-100，越高趋势越强），
     * 作为现有估值体系的补充视角。
     *
     * @param {Array} kline - K线数组 [{date, high, low, close, ...}]
     * @param {number} lookbackDays - 前高回溯窗口（默认60交易日≈3个月）
     * @returns {Object|null} {
     *   currentPrice,         // 最新收盘价
     *   prevHigh,             // 窗口内前高
     *   prevHighDate,         // 前高日期
     *   drawdown,             // 当前回撤% (正数表示已下跌)
     *   trendScore,           // 趋势强度分 0-100
     *   zone,                 // 区间判定
     *   daysSinceHigh,        // 距前高天数
     *   signal17,             // 17号策略信号 BUY/HOLD/SELL
     *   signal17Text,
     * }
     */
    function calcTrendStrength(kline, lookbackDays = 60) {
        if (!kline || kline.length < 5) return null;

        // 取末尾 lookbackDays 个点作为前高窗口
        const window = kline.slice(-Math.min(lookbackDays, kline.length));
        const currentPrice = kline[kline.length - 1].close;
        if (!currentPrice || currentPrice <= 0) return null;

        // 找窗口内最高价（用 high 字段，否则退化用 close）
        let prevHigh = 0;
        let prevHighDate = null;
        let prevHighIdx = -1;
        window.forEach((bar, i) => {
            const h = bar.high || bar.close;
            if (h > prevHigh) {
                prevHigh = h;
                prevHighDate = bar.date;
                prevHighIdx = i;
            }
        });
        if (prevHigh <= 0) return null;

        // 距离前高天数（从窗口内位置换算）
        const daysSinceHigh = window.length - 1 - prevHighIdx;

        // 回撤比例（正数表示下跌）
        const drawdown = parseFloat(((prevHigh - currentPrice) / prevHigh * 100).toFixed(2));

        // 趋势强度分映射（与右侧浅回撤策略的区间对应）
        //   回撤<5%  → 95分（极强趋势，但乖离大，注意过热）
        //   回撤5-10% → 80分（强趋势）
        //   回撤10-20% → 60分（健康趋势，17号策略甜区）
        //   回撤20-30% → 30分（趋势走弱）
        //   回撤>30%  → 10分（趋势破坏）
        let trendScore;
        if (drawdown < 5)       trendScore = 95;
        else if (drawdown < 10) trendScore = 80;
        else if (drawdown < 20) trendScore = 60;
        else if (drawdown < 30) trendScore = 30;
        else                    trendScore = 10;

        // 用平滑函数做精细化，避免台阶感
        // 基础分 + 同区间内的线性渐变
        if (drawdown < 5) {
            trendScore = 100 - drawdown * 1; // 0%→100, 5%→95
        } else if (drawdown < 10) {
            trendScore = 95 - (drawdown - 5) * 3; // 5%→95, 10%→80
        } else if (drawdown < 20) {
            trendScore = 80 - (drawdown - 10) * 2; // 10%→80, 20%→60
        } else if (drawdown < 30) {
            trendScore = 60 - (drawdown - 20) * 3; // 20%→60, 30%→30
        } else {
            trendScore = Math.max(0, 30 - (drawdown - 30) * 1); // 30%→30, 60%→0
        }
        trendScore = parseFloat(trendScore.toFixed(1));

        // 区间判定
        let zone, zoneColor, zoneIcon;
        if (drawdown < 5) {
            zone = '极强趋势·过热预警';
            zoneColor = '#ff6b6b'; // 红色预警
            zoneIcon = '🔥';
        } else if (drawdown < 10) {
            zone = '强势趋势';
            zoneColor = '#28a745';
            zoneIcon = '📈';
        } else if (drawdown < 20) {
            zone = '健康趋势·策略甜区';
            zoneColor = '#0d7337';
            zoneIcon = '✅';
        } else if (drawdown < 30) {
            zone = '趋势走弱';
            zoneColor = '#ffc107';
            zoneIcon = '⚠️';
        } else {
            zone = '趋势破坏';
            zoneColor = '#dc3545';
            zoneIcon = '🔴';
        }

        // 17号策略的操作信号（仅作参考显示）
        let signal17, signal17Text;
        if (drawdown < 20) {
            signal17 = 'BUY';
            signal17Text = '满仓（回撤<20%，右侧趋势中）';
        } else if (drawdown < 25) {
            signal17 = 'HOLD';
            signal17Text = '观望（回撤接近20%临界）';
        } else {
            signal17 = 'SELL';
            signal17Text = '离场（回撤≥20%，趋势已破坏）';
        }

        return {
            currentPrice: parseFloat(currentPrice.toFixed(3)),
            prevHigh: parseFloat(prevHigh.toFixed(3)),
            prevHighDate,
            drawdown,
            trendScore,
            zone,
            zoneColor,
            zoneIcon,
            daysSinceHigh,
            signal17,
            signal17Text,
            lookbackDays: window.length,
        };
    }

    /**
     * 基于K线计算趋势强度的历史分位（当前回撤在过去一年中的相对位置）
     * @param {Array} kline - 需要至少 lookbackDays + historyDays 长度
     * @param {number} lookbackDays - 前高窗口，默认60
     * @param {number} historyDays - 回溯历史分位的窗口，默认250
     * @returns {Object|null} { percentile, worseCount, totalCount }
     */
    function calcTrendDrawdownPercentile(kline, lookbackDays = 60, historyDays = 250) {
        if (!kline || kline.length < lookbackDays + 30) return null;

        // 对历史上每一天，都计算"当时的距前高回撤"，作为分布
        const drawdownSeries = [];
        const startIdx = Math.max(lookbackDays, kline.length - historyDays);
        for (let i = startIdx; i < kline.length; i++) {
            const window = kline.slice(i - lookbackDays + 1, i + 1);
            let pH = 0;
            window.forEach(bar => {
                const h = bar.high || bar.close;
                if (h > pH) pH = h;
            });
            const cp = kline[i].close;
            if (pH > 0 && cp > 0) {
                drawdownSeries.push((pH - cp) / pH * 100);
            }
        }
        if (drawdownSeries.length === 0) return null;

        const current = drawdownSeries[drawdownSeries.length - 1];
        // 分位计算：当前回撤在历史分布中的排名
        // 回撤越小(越靠前高) → 分位越高（更接近牛市状态）
        // 所以用"历史上多少天的回撤≥当前回撤"作为"越高越强势"的分位
        const worseCount = drawdownSeries.filter(d => d >= current).length;
        const percentile = parseFloat((worseCount / drawdownSeries.length * 100).toFixed(1));

        return {
            percentile,
            worseCount,
            totalCount: drawdownSeries.length,
            currentDrawdown: parseFloat(current.toFixed(2)),
            // 历史回撤序列供可选绘图
            drawdownSeries: drawdownSeries.map(d => parseFloat(d.toFixed(2))),
        };
    }

    function analyzeCurrent(data, etfConfig, historyData) {
        const context = DataQuality.valuationContext(historyData, etfConfig, data);
        const quality = DataQuality.assess(data, etfConfig, new Date(), context.basis);
        const input = { quality, valuationBasis: context.basis };
        const usedFields = new Set(quality.required);
        if (DataQuality.primaryField(etfConfig) !== 'trendScore') usedFields.add('marketTemp');
        if (etfConfig.type === 'bond') usedFields.add('trendScore');
        if (!['buffett_us', 'buffett_us_growth', 'buffett_jp', 'bond_yield', 'gold_trend', 'commodity_trend'].includes(etfConfig.signalRules)) usedFields.add('roe');
        if (['buffett_value', 'buffett_broad', 'buffett_hk_dividend', 'buffett_stock'].includes(etfConfig.signalRules)) usedFields.add('pb');
        for (const field of ['pe', 'pb', 'roe', 'dividendYield', 'bondYield', 'marketTemp', 'trendScore']) {
            input[field] = DataQuality.referenceUsable(data, field, etfConfig, context.basis) ? DataQuality.number(data[field]) : null;
            if (usedFields.has(field) && input[field] !== null && !quality.required.includes(field)) {
                const issue = DataQuality.fieldIssue(data, field, etfConfig);
                if (issue) quality.reasons.push(issue);
            }
        }
        if (quality.reasons.length) quality.allowed = false;
        const values = DataQuality.referenceValues(context.history, 'peHistory');
        const anchor = context.history && context.history.valuationAnchor || {};
        input.pePercentile = input.pe > 0 && values.length ? calcPercentile(input.pe, values) : null;
        input.peMean = context.basis.isProxy ? null : DataQuality.number(anchor.peMean);
        input.peStd = context.basis.isProxy ? null : DataQuality.number(anchor.peStd);
        const spreadValues = DataQuality.referenceValues(context.history, 'spreadHistory');
        const canCalcSpread = etfConfig.useBondSpread && input.dividendYield !== null && input.bondYield !== null;
        const spread = canCalcSpread ? calcSpread(input.dividendYield, input.bondYield) : null;
        input.spreadPercentile = canCalcSpread && spreadValues.length ? calcPercentile(spread, spreadValues) : null;
        const result = generateMultiDimSignal(input, etfConfig);
        return { ...result, input, context, spread, canCalcSpread };
    }

    function calcValuationBaseline(historyData, etfConfig, currentData = {}) {
        const context = DataQuality.valuationContext(historyData, etfConfig, currentData);
        const field = DataQuality.primaryField(etfConfig);
        if (field === 'trendScore') return { available: false, reason: '黄金与商品没有PE估值，请查看价格趋势与回撤。', context, series: [] };
        const historyKey = field === 'bondYield' ? 'bondYieldHistory' : 'peHistory';
        const points = DataQuality.monthlyPoints(context.history && context.history[historyKey]).filter(point => DataQuality.valid(field, point.value));
        const samples = points.map(point => point.value);
        const result = { available: false, context, field, sampleCount: samples.length, series: [], start: points[0] && points[0].date, end: points.length ? points[points.length - 1].date : null };
        if (samples.length < 5) return { ...result, reason: `当前只有${samples.length}个月样本，暂不计算排名；保留已有数值供查看。` };
        const flat = new Set(samples).size === 1;
        const position = value => {
            const lower = samples.filter(sample => sample < value).length;
            const equal = samples.filter(sample => sample === value).length;
            const raw = (lower + equal * 0.5) / samples.length * 100;
            return { rawPercentile: Number(raw.toFixed(2)), percentile: Number((field === 'pe' ? 100 - raw : raw).toFixed(2)) };
        };
        const mapPoint = (point, isCurrent = false) => {
            const rank = position(point.value);
            const zone = flat ? { text: '样本无差异', color: '#718096' } : {
                ...getScorePercentileZone(rank.percentile, false),
                text: rank.percentile >= 80 ? '相对很便宜' : rank.percentile >= 65 ? '相对偏便宜' : rank.percentile >= 45 ? '历史中位' : rank.percentile >= 25 ? '相对偏贵' : '相对很贵'
            };
            return { date: point.date, value: point.value, ...rank, score: rank.percentile, zone, metric: field === 'pe' ? 'PE' : '10年期国债收益率',
                asOf: point.asOf || point.date, isCurrent, signalText: '估值历史位置（不是交易指令）' };
        };
        const series = points.map(point => mapPoint(point));
        const meta = DataQuality.metadata(currentData, field);
        const date = meta.asOf || meta.dateLabel;
        const currentUsable = DataQuality.referenceUsable(currentData, field, etfConfig, context.basis);
        const latest = currentUsable ? mapPoint({ date: date || '最新记录（日期未知）', asOf: date, value: DataQuality.number(currentData[field]) }, true) : series[series.length - 1];
        const notes = [];
        if (context.basis.isProxy) notes.push('仅比较创业板指代理采样，不使用目标指数旧PE或锚点');
        if (samples.length < 36) notes.push(`短样本：仅${samples.length}个月，不能代表完整市场周期`);
        if (points.some(point => !['observed', 'manual'].includes(point.quality))) notes.push('含旧版历史记录，来源未逐点核验');
        if (flat) notes.push('历史样本相同，排名区分度不足');
        if (!currentUsable) notes.push('当前估值不足，标记的是最新历史记录');
        if (currentUsable) {
            const existing = series.findIndex(point => point.date === latest.date);
            if (existing >= 0) series[existing] = latest;
            else series.push(latest);
            series.sort((a, b) => a.date.localeCompare(b.date));
        }
        return { ...result, available: true, flat, series, current: latest, currentUsable, notes };
    }

    // ========== 公开API ==========
    return {
        analyzeCurrent,
        calcValuationBaseline,
        SIGNAL_LEVELS,
        getComparableHistory: DataQuality.comparableHistory,
        getReferenceValues: DataQuality.referenceValues,
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
        generateInterpretation,
        calcTrendStrength,
        calcTrendDrawdownPercentile
    };
})();
