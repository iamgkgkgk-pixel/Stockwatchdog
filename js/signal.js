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
        ['marketTemp', 'pePercentile', 'spreadPercentile', 'trendScore', 'pe', 'pb', 'dividendYield', 'bondYield', 'roe'].forEach(key => {
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

    // ========== 公开API ==========
    return {
        SIGNAL_LEVELS,
        calcSpread,
        calcPercentile,
        generateSignal,
        generateMultiDimSignal,
        getPercentileZone,
        getPEPercentileZone,
        getCompositeScoreZone,
        getMarketTempDesc
    };
})();
