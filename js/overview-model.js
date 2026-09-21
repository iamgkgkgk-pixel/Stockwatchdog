const OverviewModel = (() => {
    'use strict';
    const Q = DataQuality, S = SignalEngine, E = GptStrategyEngine;
    const rocCache = new WeakMap();
    const GREEN = new Set(['STRONG_BUY', 'BUY', 'HOLD_ADD']);
    const RED = new Set(['REDUCE_WARN', 'SELL', 'STRONG_SELL', 'OVERHEAT']);
    const SOURCE_FIELDS = {
        etf: ['price', 'priceChange'], valuation: ['pe', 'pb', 'roe', 'dividendYield', 'pePercentile', 'pbPercentile'],
        bond: ['bondYield'], aShareBreadth: ['marketTemp'], fearGreed: ['marketTemp'], fearGreedFallback: ['marketTemp']
    };
    const number = (value, digits = 2) => Q.number(value) === null ? '—' : Number(value).toFixed(digits);
    const missing = (title, state, detail) => ({ title, state, detail, vote: null, reference: false, asOf: null });

    function classify(evidence) {
        const vote = key => [-1, 0, 1].includes(evidence[key]?.vote) ? evidence[key].vote : null;
        const roc = vote('roc'), signal = vote('signal'), pe = vote('pe');
        const valid = Object.values(evidence).filter(item => item && [-1, 0, 1].includes(item.vote));
        const base = { low: valid.filter(item => item.vote === -1).length, risk: valid.filter(item => item.vote === 1).length,
            count: valid.length, reference: valid.some(item => item.reference), peIgnored: pe === null,
            buyBlocked: roc === null ? null : roc === 1, sellBlocked: roc === null ? null : roc === -1 };
        if (roc === null) return { ...base, tier: 'pending', reason: 'ROC尚不可用，无法核对买卖节奏约束', action: '等待ROC，不给出买卖观察方向' };
        const action = roc === 1 ? 'ROC ≥80%：不买入、不加仓' : roc === -1 ? 'ROC ≤20%：不卖出、不减仓' : 'ROC在20%—80%之间：结合信号观察，不等于应当交易';
        let tier = 'normal', reason = '暂未形成买入或减仓观察方向';
        if (signal === 1) {
            tier = 'risk'; reason = '综合信号红色，列入减仓观察';
        } else if (signal === -1 && pe !== 1) {
            tier = 'low'; reason = '综合信号绿色，列入买入观察';
        } else if (signal === -1 && pe === 1) {
            reason = '综合信号绿色但PE均上，方向分歧，继续观察';
        } else if (pe === -1 && roc === -1) {
            tier = 'low'; reason = 'ROC低位且PE均下，列入买入观察';
        } else if (pe === 1 && roc === 1) {
            tier = 'risk'; reason = 'ROC高位且PE均上，列入减仓观察';
        } else if (signal === null && pe === null) {
            reason = '仅有ROC节奏参考，不推断估值高低或买卖方向';
        }
        if (tier === 'low' && base.buyBlocked) {
            tier = 'normal'; reason = '虽有偏低依据，但ROC ≥80%，暂停买入观察';
        }
        if (tier === 'risk' && base.sellBlocked) {
            tier = 'normal'; reason = '虽有风险依据，但ROC ≤20%，暂停卖出观察';
        }
        if (base.peIgnored) reason += '；历史PE已忽略';
        return { ...base, tier, reason, action };
    }

    function normalized(record) {
        const { asset, api = {}, history, previousCurrent, manual } = record;
        const cached = { ...(previousCurrent || {}) };
        for (const [field, meta] of Object.entries(cached.fieldMeta || {})) if (meta.quality === 'manual') delete cached[field];
        const fallback = Q.mergeSnapshots(Q.latestSnapshot(history, asset), cached, manual);
        for (const key of api.pending || []) for (const field of SOURCE_FIELDS[key] || []) {
            delete fallback[field];
            delete fallback.fieldMeta[field];
        }
        return DataAPI.normalizeData(api, fallback, asset);
    }

    function rocEvidence(record, options, now) {
        if (record.parts.price === 'queued' || record.parts.price === 'loading') return missing('ROC', record.parts.price, '等待完整价格序列');
        const price = record.priceResult?.price;
        if (!price) return missing('ROC', 'missing', '未取得价格，不能计算动量');
        if (price.code !== record.asset.code || price.secid && price.secid !== record.asset.secid) return missing('ROC', 'missing', '行情身份不匹配');
        const market = GptStrategyData.priceMarket(record.asset);
        const key = JSON.stringify([E.settings(options), E.clock(now, market), market]);
        const cached = rocCache.get(price);
        const model = cached?.key === key && cached.factory === E.rocModel ? cached.model : E.rocModel(price.bars, options, now, market);
        if (model !== cached?.model) rocCache.set(price, { key, model, factory: E.rocModel });
        const last = model.last, lower = model.lowerBand.at(-1), upper = model.upperBand.at(-1);
        if (!model.fresh) return { ...missing('ROC', 'stale', '价格超过7天，只作历史参考'), asOf: last?.date };
        const rank = Q.number(last?.rank);
        if (!last || Q.number(last.smooth) === null || rank === null || rank < 0 || rank > 100 || Q.number(lower) === null || Q.number(upper) === null)
            return { ...missing('ROC', 'missing', `分位不足或无效：至少需要${model.minimum}个历史平滑ROC样本`), asOf: last?.date };
        const vote = rank <= 20 ? -1 : rank >= 80 ? 1 : 0;
        const raw = price.adjustment === 'raw';
        return { title: 'ROC', state: record.parts.price, vote, reference: raw || record.parts.price !== 'ready', asOf: last.date,
            label: `${number(rank, 1)}%分位 · ${vote < 0 ? '不卖' : vote > 0 ? '不买' : '区间内'}`,
            detail: `ROC历史分位 ${number(rank, 2)}%（按未四舍五入值判定） · 均线 ${number(last.smooth)}% · 下沿 ${number(lower)}% / 上沿 ${number(upper)}%${raw ? ' · 未复权参考，需核对除权影响' : ''}`,
            value: last.smooth, lower, upper, rank, raw };
    }

    function signalEvidence(record, data, analysis, now) {
        if (record.asset.id === 'vix-dashboard') return missing('综合信号', 'na', 'VIX不参与原工具综合评分');
        if (record.asset.overviewOnly) return missing('综合信号', 'na', 'GPT独立标的尚无原工具综合信号，不借用其他标的评分');
        if (['queued', 'loading'].includes(record.parts.api) || ['queued', 'loading'].includes(record.parts.history))
            return missing('综合信号', 'loading', '等待评分相关数据返回');
        const primary = Q.primaryField(record.asset), meta = Q.metadata(data, primary);
        const age = E.age(meta.asOf, Q.today(now));
        if (!meta.asOf || age < 0 || age > (primary === 'trendScore' ? 3 : 7))
            return { ...missing('综合信号', 'stale', '核心观测过期或日期未知，不参与归档'), asOf: meta.asOf || meta.dateLabel };
        if (!analysis?.quality.calculable) return missing('综合信号', 'missing', analysis?.quality.hardReasons.join('；') || '缺少评分依据');
        const signal = analysis.signal, level = signal.referenceLevel || signal.level;
        const vote = GREEN.has(level) ? -1 : RED.has(level) ? 1 : ['HOLD', 'NEUTRAL'].includes(level) ? 0 : null;
        if (vote === null) return missing('综合信号', 'missing', '无法映射信号等级');
        return { title: '综合信号', state: record.parts.api, vote, reference: !analysis.quality.allowed || record.parts.api !== 'ready',
            asOf: meta.asOf, label: vote < 0 ? '绿色' : vote > 0 ? '红色' : '黄色',
            detail: `${signal.text} · ${number(analysis.total, 1)}分 · 覆盖${analysis.quality.coverage}%`, level };
    }

    function peEvidence(record, data, analysis, now) {
        if (record.asset.id === 'vix-dashboard' || ['gold', 'commodity', 'bond'].includes(record.asset.type)) return missing('历史PE', 'na', '该标的没有PE，不用价格替代');
        if (['queued', 'loading'].includes(record.parts.history) || record.api?.pending?.includes('valuation') || record.parts.api === 'queued')
            return missing('历史PE', 'loading', '等待当前估值与可比历史');
        const issue = Q.fieldIssue(data, 'pe', record.asset, now), meta = Q.metadata(data, 'pe');
        if (issue) return { ...missing('历史PE', 'missing', issue), asOf: meta.asOf || meta.dateLabel };
        const history = Q.withLatestObservations(analysis.context.history, data, record.asset);
        const points = (history?.peHistory || []).filter(point => Q.valid('pe', point.value));
        if (Q.monthlyPoints(points).length < 5) return missing('历史PE', 'missing', '可比历史不足5个月');
        const mean = Number((points.reduce((sum, point) => sum + point.value, 0) / points.length).toFixed(2));
        const vote = data.pe < mean ? -1 : data.pe > mean ? 1 : 0;
        return { title: '历史PE', state: record.parts.history, vote, asOf: meta.asOf, value: data.pe, mean,
            reference: record.parts.history !== 'ready' || points.some(point => !['observed', 'manual'].includes(point.quality)),
            label: vote < 0 ? '历史均下' : vote > 0 ? '历史均上' : '接近历史均值',
            detail: `PE ${number(data.pe)} / 均值 ${number(mean)} · ${points.length}点 · ${points[0].date}起（与详情PE图同口径）` };
    }

    function build(record, options = E.DEFAULTS, now = new Date()) {
        let data = {}, analysis = null;
        if (record.asset.id !== 'vix-dashboard') {
            data = normalized(record);
            analysis = S.analyzeCurrent(data, record.asset, record.history || {});
        }
        const evidence = { roc: rocEvidence(record, options, now), signal: signalEvidence(record, data, analysis, now), pe: peEvidence(record, data, analysis, now) };
        const classification = classify(evidence);
        const loading = Object.values(record.parts).some(part => part === 'loading' || part === 'queued');
        const issues = [...new Set(Object.values(record.issues || {}).flat().filter(Boolean))];
        const reference = classification.reference || classification.count < 3 || issues.length > 0;
        return { ...classification, reference, evidence, loading, issues, current: data,
            status: record.phase === 'queued' ? 'queued' : loading ? 'loading' : issues.length ? 'error' : classification.tier === 'pending' ? 'incomplete' : reference ? 'reference' : 'ready' };
    }

    function allAssets(config, strategyAssets) {
        const assets = config.ETF_LIST.map(asset => ({ ...asset, detail: 'index.html#' + encodeURIComponent(asset.id) }));
        for (const asset of strategyAssets) if (!assets.some(item => item.code === asset.code)) {
            const template = config.ETF_LIST.find(item => item.id === 'sci-tech-50');
            assets.push({ ...template, ...asset, group: 'ATTACK', shortName: asset.name,
                detail: 'gpt-strategy.html#' + encodeURIComponent(asset.id), overviewOnly: true });
        }
        assets.push({ id: 'vix-dashboard', code: 'VIX', name: 'VIX恐惧指数', shortName: 'VIX', market: 'US', secid: '100.VIX', group: 'HEDGE',
            detail: 'index.html#vix-dashboard', history: null });
        return assets;
    }

    return { classify, normalized, build, allAssets };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = OverviewModel;
