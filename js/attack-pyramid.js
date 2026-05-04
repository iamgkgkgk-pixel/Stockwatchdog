/**
 * attack-pyramid.js — 全局仓位模式 + 综合信号→仓位建议 翻译器（精简版）
 * ====================================================================
 *
 * 【设计理念】尊崇巴菲特/芒格，但承认"择时是价值投资的合法组成部分"
 *
 *   ① 巴菲特本人也择时（2024年囤现金3500亿，2000年躲互联网，2007年卖中石油）
 *   ② 但他的择时很简单：贵了拿现金，便宜了加仓，不做短线
 *   ③ 全局档位 = 您对市场整体贵/便宜的宏观判断（算法不预测）
 *   ④ 仓位建议 = 综合信号（signal.js 多维度评分）× 全局档位过滤
 *
 * 【不做的事】
 *   ✗ 不重复计算估值（综合评分 signal.js 已做了）
 *   ✗ 不引入新指标（Gap/E/P 都被综合评分的 safety 维度覆盖）
 *   ✗ 不推荐个别标的（所有标的共用一套翻译规则）
 *
 * 【4档全局模式】用户手动切换，localStorage持久化
 *
 *   🟢 NORMAL    : 正常执行 signal.js 给出的 position 建议
 *   🟡 CAUTIOUS  : 建议仓位砍半（巴菲特2024"估值偏高，多拿现金"）
 *   🔴 DEFENSIVE : 禁止新建仓（巴菲特2000/2007"等明确机会"）
 *   ⚫ RETREAT   : 全部清仓（巴菲特1969/2020Q1"极端保守"）
 */

const AttackPyramid = (() => {
    'use strict';

    const REGIMES = {
        NORMAL: {
            key: 'NORMAL',
            icon: '🟢',
            label: '正常',
            shortHint: '按综合信号正常建议',
            desc: '按标的综合信号给出仓位建议',
            posMultiplier: 1.0,
            allowNewEntry: true,
            forceExit: false,
        },
        CAUTIOUS: {
            key: 'CAUTIOUS',
            icon: '🟡',
            label: '谨慎',
            shortHint: '仓位砍半，多拿现金',
            desc: '建议仓位上限50%，等待更好机会（巴菲特2024式）',
            posMultiplier: 0.5,
            allowNewEntry: true,
            forceExit: false,
        },
        DEFENSIVE: {
            key: 'DEFENSIVE',
            icon: '🔴',
            label: '防守',
            shortHint: '禁止新建仓',
            desc: '禁止新建仓，已有仓位视信号自然演变（巴菲特2000/2007式）',
            posMultiplier: 0,
            allowNewEntry: false,
            forceExit: false,
        },
        RETREAT: {
            key: 'RETREAT',
            icon: '⚫',
            label: '撤退',
            shortHint: '清仓所有进攻仓位',
            desc: '清空所有股票仓位，全回现金（巴菲特1969/2020Q1式极端保守）',
            posMultiplier: 0,
            allowNewEntry: false,
            forceExit: true,
        },
    };

    const STORAGE_KEY = 'attack_pyramid_regime';
    const DEFAULT_REGIME = 'NORMAL';

    /**
     * 综合信号 → 建议仓位 翻译表
     *
     * signal.js 的 SIGNAL_LEVELS 共 8 档，每档给一个仓位范围：
     *   STRONG_BUY  → 80%+  (极度低估，梭哈级别)
     *   BUY         → 50%   (深度低估)
     *   HOLD_ADD    → 30%   (偏低，试探仓)
     *   HOLD        → 维持当前 (中性)
     *   REDUCE_WARN → 减至30%
     *   SELL        → 减至10%
     *   STRONG_SELL → 0% 清仓
     *   OVERHEAT    → 0% 清仓
     *   DATA_INCOMPLETE → 维持当前
     *
     * 注：数字是"进攻资金"内的仓位比例，不是总资产比例
     */
    const SIGNAL_TO_POSITION = {
        STRONG_BUY:      { pct: 80, label: '80%+（极度低估·梭哈级）', color: '#0d7337' },
        BUY:             { pct: 50, label: '50%（深度低估·主力仓）',  color: '#28a745' },
        HOLD_ADD:        { pct: 30, label: '30%（偏低·试探仓）',      color: '#9be3b0' },
        HOLD:            { pct: null, label: '维持现有（中性）',     color: '#ffc107' },
        REDUCE_WARN:     { pct: 30, label: '减至30%（开始贵）',       color: '#fd7e14' },
        SELL:            { pct: 10, label: '减至10%（很贵）',         color: '#dc3545' },
        STRONG_SELL:     { pct: 0,  label: '清仓 0%（极度高估）',     color: '#85182a' },
        OVERHEAT:        { pct: 0,  label: '清仓 0%（过热）',         color: '#85182a' },
        DATA_INCOMPLETE: { pct: null, label: '数据不足，无建议',      color: '#718096' },
    };

    /**
     * 根据综合信号 + 全局档位，计算建议仓位
     *
     * @param {Object} signal  signal.js 返回的信号对象 { level: 'BUY', ... }
     * @param {string} regimeKey  当前全局档位
     * @returns {Object} { pct, label, color, reason }
     *   pct    — 建议仓位百分比 (0-100)，null = 维持
     *   label  — 人类可读的建议
     *   color  — 颜色
     *   reason — 一句话解释
     */
    function translateSignalToPosition(signal, regimeKey) {
        const regime = REGIMES[regimeKey] || REGIMES[DEFAULT_REGIME];

        if (!signal || !signal.level) {
            return {
                pct: null,
                label: '等待数据',
                color: '#718096',
                reason: '暂无综合信号数据',
                regime,
            };
        }

        const base = SIGNAL_TO_POSITION[signal.level] || SIGNAL_TO_POSITION.DATA_INCOMPLETE;

        // ⚫ 撤退：无论信号如何，强制0%
        if (regime.forceExit) {
            return {
                pct: 0,
                label: '清仓 0%（撤退模式）',
                color: '#85182a',
                reason: `⚫ 撤退模式：覆盖综合信号"${signal.text}"，全回现金等待极端机会`,
                regime,
                originalPct: base.pct,
                originalLabel: base.label,
            };
        }

        // 🔴 防守：仅对"建仓"信号做拦截（REDUCE/SELL 类照常减仓）
        if (!regime.allowNewEntry && base.pct !== null && base.pct > 0 &&
            ['STRONG_BUY', 'BUY', 'HOLD_ADD'].indexOf(signal.level) !== -1) {
            return {
                pct: null,
                label: '维持现有（防守模式拦截建仓）',
                color: '#dc3545',
                reason: `🔴 防守模式：综合信号"${signal.text}"建议${base.pct}%，但当前不新建仓，持有现有观望`,
                regime,
                originalPct: base.pct,
                originalLabel: base.label,
            };
        }

        // 🟡 谨慎：建仓信号的仓位砍半（减仓不变）
        if (regime.posMultiplier < 1.0 && base.pct !== null && base.pct > 0 &&
            ['STRONG_BUY', 'BUY', 'HOLD_ADD'].indexOf(signal.level) !== -1) {
            const cappedPct = Math.round(base.pct * regime.posMultiplier);
            return {
                pct: cappedPct,
                label: `${cappedPct}%（${signal.text}×谨慎档）`,
                color: base.color,
                reason: `🟡 谨慎模式：综合信号"${signal.text}"原建议${base.pct}%，砍半后 ${cappedPct}%（巴菲特式多拿现金）`,
                regime,
                originalPct: base.pct,
                originalLabel: base.label,
            };
        }

        // 🟢 正常 或 非建仓信号：直接用原始建议
        return {
            pct: base.pct,
            label: base.label,
            color: base.color,
            reason: `综合信号：${signal.text}${signal.position ? ' · ' + signal.position : ''}`,
            regime,
        };
    }

    // ========== 档位持久化 ==========

    function getCurrentRegime() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored && REGIMES[stored]) return stored;
        } catch (e) {}
        return DEFAULT_REGIME;
    }

    function setCurrentRegime(regimeKey) {
        if (!REGIMES[regimeKey]) return false;
        try {
            localStorage.setItem(STORAGE_KEY, regimeKey);
            return true;
        } catch (e) {
            return false;
        }
    }

    return {
        REGIMES,
        SIGNAL_TO_POSITION,
        DEFAULT_REGIME,

        translateSignalToPosition,
        getCurrentRegime,
        setCurrentRegime,
    };
})();

if (typeof window !== 'undefined') {
    window.AttackPyramid = AttackPyramid;
}
