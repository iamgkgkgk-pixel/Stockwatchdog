const BottomScreener = (() => {
    'use strict';
    const E = GptStrategyEngine;
    const POLICY = Object.freeze({ window: 252, maxSpanDays: 400, lowPosition: 20, deepDrawdown: -25,
        deepPosition: 40, highPosition: 80, trackingDays: 20, maxAge: 7,
        oversoldRank: 20, correctionSeedDays: 5, correctionWindow: 20, correctionMinBars: 144, correctionMaxSpan: 240 });
    const cache = new WeakMap();
    const labels = { improving: '低位改善', falling: '低位未稳', rebound: '反弹跟踪', normal: '未入候选',
        pending: '待判定', reference: '口径待核验', excluded: '不参与筛选' };
    const families = {
        'dividend-low-vol': '红利风格', 'free-cashflow': '红利风格', 'csi-dividend': '红利风格',
        'hk-dividend': '红利风格', 'hk-soe-dividend': '红利风格',
        csi300: '宽基', sse50: '宽基', 'sci-tech-50': '宽基', 'gem-50': '宽基', 'star-50': '宽基',
        'sci-semi': '科技', pcb: '科技', hstech: '科技', 'tencent-hk': '科技',
        robot: '制造', 'machine-tool': '制造', 'energy-storage': '新能源', pharma: '医药', 'consumer-50': '消费农业',
        'sp500-cn': '海外宽基', 'nasdaq100-cn': '海外宽基', 'dow-jones': '海外宽基', nikkei225: '海外宽基', topix: '海外宽基',
        gold: '非股票', 'bond-10y': '非股票', 'soybean-meal': '非股票', 'vix-dashboard': '非股票'
    };
    function describeAsset(asset) {
        return { sector: asset.sector || asset.shortName || asset.name, family: asset.family || families[asset.id] || '其他',
            capability: asset.priceOnly ? '仅价格依据' : asset.trackIndex?.isProxy ? '代理估值需核验' : asset.trackIndex?.danjuanCode ? '估值待核验' : '估值覆盖有限' };
    }
    function windowMetrics(bars, end) {
        if (end + 1 < POLICY.window) return null;
        const sample = bars.slice(end + 1 - POLICY.window, end + 1);
        if (E.age(sample[0].date, sample.at(-1).date) > POLICY.maxSpanDays) return null;
        const prices = sample.map(bar => bar.close), low = Math.min(...prices), high = Math.max(...prices), close = prices.at(-1);
        const position = high > low ? (close - low) / (high - low) * 100 : null;
        const drawdown = (close / high - 1) * 100;
        return { low, high, position, drawdown, from: sample[0].date, samples: sample.length,
            highZone: position !== null && position >= POLICY.highPosition,
            lowZone: position !== null && (position <= POLICY.lowPosition || position <= POLICY.deepPosition && drawdown <= POLICY.deepDrawdown) };
    }
    function oversold(rank, value, smooth) {
        return [rank, value, smooth].every(n => E.number(n) !== null)
            && rank >= 0 && rank <= POLICY.oversoldRank && value < 0 && smooth < 0;
    }
    function correctionModel(bars, roc, adjustment, stale) {
        const base = { state: 'pending', eligible: false, referenceEligible: false, triggered: false,
            entryDate: null, seedDate: null, change: null, recentDrawdown: null, reason: '等待有效日线ROC' };
        const n = bars.length - 1, last = bars[n];
        if (!last || !roc?.last || !Number.isFinite(roc.last.rank)) return base;
        const recent = bars.slice(-POLICY.correctionWindow);
        const recentDrawdown = (last.close / Math.max(...recent.map(bar => bar.close)) - 1) * 100;
        const detail = { ...base, recentDrawdown };
        if (stale) return { ...detail, reason: '价格已过期，回调数值仅作历史参考' };
        const completeAt = i => i >= POLICY.correctionMinBars - 1
            && E.age(bars[i - POLICY.correctionMinBars + 1].date, bars[i].date) <= POLICY.correctionMaxSpan;
        if (!completeAt(n)) return { ...detail, reason: '回调观察至少需144个完整日线，且最近144日样本跨度不超过240个自然日' };
        if (!['qfq', 'raw'].includes(adjustment)) return { ...detail, reason: '价格口径未知，不纳入回调观察' };
        const triggeredAt = i => i >= 0 && completeAt(i) && oversold(roc.ranks[i], roc.roc[i], roc.smooth[i]);
        const triggered = triggeredAt(n);
        const condition = `日线平滑ROC分位 ≤${POLICY.oversoldRank}%，且ROC(12)与MA(6)均为负`;
        if (adjustment === 'raw') return { ...detail, triggered, state: triggered ? 'reference' : 'normal', referenceEligible: triggered,
            reason: triggered ? `满足${condition}，进入超跌回调线索；未复权，不能据此确认改善或低估`
                : `未满足${condition}，未复权数据不用于确认回调改善` };
        const seedAt = i => {
            for (let j = i; j >= Math.max(0, i - POLICY.correctionSeedDays); j--) if (triggeredAt(j)) return j;
            return -1;
        };
        const improvesAt = i => i >= 5 && [roc.smooth[i], roc.smooth[i - 1], roc.smooth[i - 2]].every(Number.isFinite)
            && roc.smooth[i] > roc.smooth[i - 1] && roc.smooth[i - 1] > roc.smooth[i - 2]
            && bars[i].close >= bars[i - 1].close && bars[i].close > Math.min(...bars.slice(i - 5, i).map(bar => bar.close));
        const qualifiesAt = i => completeAt(i) && seedAt(i) >= 0 && improvesAt(i);
        let entry = null;
        for (let i = Math.max(POLICY.correctionMinBars - 1, n - POLICY.trackingDays); i <= n; i++) {
            if (qualifiesAt(i) && !qualifiesAt(i - 1)) entry = { index: i, close: bars[i].close, date: bars[i].date, seedDate: bars[seedAt(i)].date };
        }
        const tracking = entry && n > entry.index && last.close >= entry.close;
        const improving = qualifiesAt(n) && (triggered || !!entry);
        const state = improving ? 'improving' : triggered ? 'watch' : tracking ? 'tracking' : 'normal';
        const reason = state === 'improving' ? '当前或此前5个交易日出现过负收益的低ROC分位，平滑ROC连续两期回升且收盘改善；只是下跌缓和，不代表价格便宜'
            : state === 'watch' ? `满足${condition}；近期走势相对自身历史偏弱，尚未满足连续改善条件，不需要跌满25%才观察`
            : state === 'tracking' ? '回调改善后仍在20个交易日跟踪期，当前不低于改善确认日收盘；分位离开20%后仍保留观察，不追认底部'
            : `未满足${condition}，也没有仍有效的回调改善跟踪`;
        return { ...detail, state, triggered, eligible: state !== 'normal', reason,
            entryDate: entry?.date || null, seedDate: entry?.seedDate || null,
            change: entry ? (last.close / entry.close - 1) * 100 : null };
    }
    function calculate(price, asset, now) {
        const market = GptStrategyData.priceMarket(asset);
        const captured = new Date(price.fetchedAt);
        const cut = Number.isFinite(captured.getTime()) && captured < now ? captured : now;
        const bars = E.completedBars(price.bars, cut, market), last = bars.at(-1);
        const roc = bars.length > E.DEFAULTS.length ? E.rocModel(bars, E.DEFAULTS, cut, market) : null;
        const rank = E.number(roc?.last?.rank), rocMinimum = 126;
        const rocSamples = (roc?.smooth || []).slice(0, -1).slice(-252).filter(value => E.number(value) !== null).length;
        const rocMissing = !last ? '无完整收盘记录' : rank === null ? `ROC样本不足 ${rocSamples}/${rocMinimum}` : '';
        const metrics = windowMetrics(bars, bars.length - 1);
        const priceMissing = !last ? '无完整收盘记录' : bars.length < POLICY.window ? `价格样本不足 ${bars.length}/${POLICY.window}`
            : !metrics ? '价格窗口跨度超过400天' : '';
        const stale = !!last && E.age(last.date, E.clock(now, market).today) > POLICY.maxAge;
        const base = { bars, asOf: last?.date || null, source: price.source || '来源未标注', adjustment: price.adjustment,
            position: null, drawdown: null, samples: Math.min(bars.length, POLICY.window), ...metrics,
            rank, rocValue: E.number(roc?.last?.roc), rocSmooth: E.number(roc?.last?.smooth),
            rocSamples, rocMinimum, rocMissing, priceMissing, stale,
            correction: correctionModel(bars, roc, price.adjustment, stale),
            positionMissing: priceMissing || (metrics?.position === null ? '区间价格无变化' : '') };
        if (!last) return { ...base, state: 'pending', reason: '没有可用的完整收盘记录' };
        if (stale) return { ...base, state: 'pending', reason: '价格超过7个自然日，指标仅作原日期历史参考，不参与当前候选' };
        if (!metrics) return { ...base, state: 'pending', reason: '需252个完整日线样本，且窗口不超过400个自然日；不影响独立ROC的计算' };
        const detail = base;
        if (price.adjustment !== 'qfq') return { ...detail, state: 'reference', reason: '未确认前复权，价格位置、回撤和ROC仅作参考，不生成低位改善或反弹候选' };
        if (metrics.position === null) return { ...detail, state: 'pending', reason: '窗口价格无变化，无法识别有效低位区间；ROC仍可独立展示' };
        const n = bars.length - 1;
        if (rank === null) return { ...detail, state: 'pending', reason: '日线ROC样本不足，等待更多历史' };
        const smooth = roc.smooth;
        const improvingAt = i => i >= 5 && [smooth[i], smooth[i - 1], smooth[i - 2]].every(value => E.number(value) !== null)
            && smooth[i] > smooth[i - 1] && smooth[i - 1] > smooth[i - 2]
            && bars[i].close >= bars[i - 1].close && bars[i].close > Math.min(...bars.slice(i - 5, i).map(bar => bar.close));
        const weakeningAt = i => i >= 5 && [smooth[i], smooth[i - 1], smooth[i - 2]].every(value => E.number(value) !== null)
            && smooth[i] < smooth[i - 1] && smooth[i - 1] < smooth[i - 2]
            && bars[i].close <= bars[i - 1].close && bars[i].close < Math.max(...bars.slice(i - 5, i).map(bar => bar.close));
        let entry = null, riskEntry = null;
        for (let i = Math.max(POLICY.window - 1, n - POLICY.trackingDays); i <= n; i++) {
            const point = windowMetrics(bars, i);
            if (point?.lowZone && improvingAt(i)) entry = { date: bars[i].date, close: bars[i].close, index: i };
            if (point?.highZone && weakeningAt(i)) riskEntry = { date: bars[i].date, close: bars[i].close, index: i };
        }
        const riskTracking = riskEntry && n > riskEntry.index && last.close < riskEntry.close;
        const riskState = metrics.highZone ? weakeningAt(n) ? 'weakening' : 'high' : riskTracking ? 'pullback' : 'normal';
        const isImproving = improvingAt(n);
        const tracking = entry && n > entry.index && bars[n].close > entry.close;
        const state = metrics.lowZone ? isImproving ? 'improving' : 'falling' : tracking ? 'rebound' : 'normal';
        const reason = state === 'improving' ? '价格处于低位区，日线平滑ROC连续两期回升，收盘未继续走低；并非确认见底'
            : state === 'falling' ? '进入价格低位区，但尚未同时满足动量回升与收盘改善条件'
            : state === 'rebound' ? '近20个交易日曾在低位出现改善，目前离开低位区且高于当时确认日收盘'
            : '当前未满足低位区或近期反弹跟踪条件，不代表无风险';
        return { ...detail, state, reason, rank: roc.last.rank, entryDate: entry?.date || null,
            riskState, riskEntryDate: riskEntry?.date || null,
            riskChange: riskTracking ? (last.close / riskEntry.close - 1) * 100 : null,
            rebound: tracking ? (last.close / entry.close - 1) * 100 : null };
    }
    function analyze(record, evidence, now = new Date()) {
        const meta = describeAsset(record.asset);
        const empty = (state, reason) => ({ ...meta, state, label: labels[state], reason, eligible: false,
            referenceEligible: false, watchLevel: 'none',
            risk: { state: 'pending', eligible: false, referenceEligible: false, label: '风险数据待处理', reason },
            correction: { state: 'pending', eligible: false, referenceEligible: false, triggered: false, reason },
            valuationSupport: false, position: null, drawdown: null, rank: null, asOf: null });
        if (record.asset.id === 'vix-dashboard' || record.asset.id === 'tencent-hk' || ['gold', 'commodity', 'bond'].includes(record.asset.type))
            return empty('excluded', '此视图筛选股票ETF；非股票资产与个股保留在原三档总览');
        if (['queued', 'loading'].includes(record.parts.price)) return empty('pending', '正在请求最新完整价格，暂不展示旧候选');
        const price = record.priceResult?.price;
        if (!price) return empty('pending', '价格请求失败且无可用历史，请重试');
        if (price.code !== record.asset.code || price.secid !== record.asset.secid || price.market && price.market !== GptStrategyData.priceMarket(record.asset))
            return empty('pending', '价格代码或市场身份不匹配');
        if (price.fetchedAt && (!Number.isFinite(Date.parse(price.fetchedAt)) || Date.parse(price.fetchedAt) > now.getTime()))
            return empty('pending', '价格抓取时间无效或来自未来');
        const key = JSON.stringify([E.clock(now, GptStrategyData.priceMarket(record.asset)), record.asset.secid]);
        let cached = cache.get(price);
        if (!cached || cached.key !== key) { cached = { key, result: calculate(price, record.asset, now) }; cache.set(price, cached); }
        const result = cached.result, pe = evidence?.pe;
        const valuationSupport = !record.asset.priceOnly && !record.asset.trackIndex?.isProxy && pe?.vote === -1 && pe.reference === false;
        const eligible = ['improving', 'falling', 'rebound'].includes(result.state);
        const referenceEligible = result.state === 'reference' && price.adjustment === 'raw'
            && result.lowZone === true && Number.isFinite(result.rank);
        const fallback = record.parts.price !== 'ready';
        const riskReference = result.state === 'reference' && price.adjustment === 'raw'
            && result.highZone === true && Number.isFinite(result.rank);
        const riskState = result.riskState || (riskReference ? 'reference' : 'pending');
        const riskLabels = { weakening: '高位开始转弱', pullback: '转弱后继续回落', high: '高位仍需观察', normal: '暂无高位预警', reference: '高位线索 · 待核验', pending: '风险依据不足' };
        const riskReasons = {
            weakening: '价格位于近252日收盘区间上部20%，平滑ROC连续两期下降，收盘不高于前日且低于此前5日最高收盘；优先检查持仓风险，不等于卖出指令',
            pullback: '近20个交易日曾在高位出现转弱，现在离开高位区且低于转弱确认日收盘；继续检查风险，不用事后最高点计算变化',
            high: '价格位于近252日收盘区间上部20%，但尚未满足转弱条件；可能继续走强，不因价格高就判断见顶',
            normal: '目前不符合高位或近期回落跟踪条件，不代表无风险',
            reference: '原始日线处在高位，但分红除权影响未核验；仅作高位线索，不确认转弱或见顶'
        };
        const risk = { state: riskState, label: riskLabels[riskState], reason: riskReasons[riskState] || result.reason,
            eligible: ['weakening', 'pullback', 'high'].includes(riskState), referenceEligible: riskReference,
            entryDate: result.riskEntryDate || null, change: result.riskChange ?? null };
        return { ...meta, ...result, risk, label: referenceEligible ? '低位参考 · 待核验' : labels[result.state],
            reason: referenceEligible ? '原始日线满足价格低位条件，但分红除权影响尚未核验；仅加入低位参考，不判断企稳或确认反弹' : result.reason,
            eligible, referenceEligible, watchLevel: eligible ? 'confirmed' : referenceEligible ? 'reference' : 'none', fallback, valuationSupport,
            valuationLabel: valuationSupport ? 'PE均下支持' : pe?.vote !== null && pe?.vote !== undefined ? `PE${pe.vote > 0 ? '均上' : pe.vote === 0 ? '近均值' : '均下'}${pe.reference ? ' · 参考' : ''}` : '仅价格依据',
            trustLabel: result.stale ? '已过期 · 原日期' : fallback ? '失败回退 · 原日期' : price.adjustment !== 'qfq' ? '复权待核验' : '本次价格',
            gate: evidence?.roc?.vote === 1 ? '不买 / 不加' : evidence?.roc?.vote === -1 ? '不卖 / 不减' : evidence?.roc?.vote === 0 ? '区间内' : 'ROC约束待判定' };
    }
    function entryTags(c) {
        const tags = [];
        if (c.eligible || c.referenceEligible) tags.push(c.state === 'rebound' ? '低位反弹跟踪' : '年度价格低位');
        if (c.correction?.eligible || c.correction?.referenceEligible) tags.push(c.correction.triggered ? '动量超跌回调' : '回调改善跟踪');
        if (c.risk?.eligible || c.risk?.referenceEligible) tags.push(c.risk.state === 'pullback' ? '高位回落跟踪' : '年度价格高位');
        return tags;
    }
    function explain(c) {
        const percent = v => Number.isFinite(v) ? v.toFixed(1) + '%' : '未知';
        const price = c.eligible || c.referenceEligible ? c.reason
            : Number.isFinite(c.position) ? `价格位置 ${percent(c.position)}，距年度高点回撤 ${percent(c.drawdown)}；年度低位要求位置≤20%，或位置≤40%且回撤≥25%。${c.lowZone ? '数值满足，但' + c.reason : '本项不满足'}`
                : c.priceMissing || c.reason;
        const risk = c.risk?.eligible || c.risk?.referenceEligible ? c.risk.reason
            : Number.isFinite(c.position) && !c.stale ? `当前价格位置 ${percent(c.position)}，${c.highZone ? '达到' : '未达到'}年度高位线80%。${c.adjustment === 'raw' ? '未复权历史不能确认高位转弱或回落跟踪' : c.risk?.reason || '历史转弱依据不足'}`
                : c.risk?.reason || '数据不足';
        return `年度低位：${price}。回调入口：${c.correction?.reason || '数据不足'}。高位风险：${risk}。`;
    }
    function attention(c, mode = 'low') {
        const item = (group, priority, side, state, label, action, reason) => ({ group, priority, side, state, label, action, reason });
        const q = c.correction || {};
        const positionNote = c.lowZone ? '同时处在年度低位区' : Number.isFinite(c.position) ? `并非年度低位（位置${c.position.toFixed(1)}%）` : '年度价格位置未知，勿当成低价';
        const correction = q.eligible ? q.state === 'improving'
            ? item('priority', 0, 'low', 'correction-improving', '回调开始缓和', '优先研究改善，仍需核对估值', q.reason + '；' + positionNote)
            : q.state === 'tracking' ? item('priority', 1, 'low', 'correction-tracking', '回调改善跟踪', '持续观察，不因反弹而追买', q.reason + '；' + positionNote)
                : item('observe', 2, 'low', 'correction-watch', '超跌回调·等待缓和', '先观察下跌是否缓和，不等于低估', q.reason + '；' + positionNote)
            : q.referenceEligible ? item('verify', 3, 'low', 'correction-reference', '回调线索·待核验', '先核验数据，再判断是否改善', q.reason + '；' + positionNote) : null;
        const low = c.eligible ? c.state === 'improving'
            ? item('priority', 0, 'low', 'improving', '低位开始改善', '优先研究：再核对估值与风险', c.reason)
            : c.state === 'rebound' ? item('priority', 1, 'low', 'rebound', '低位反弹跟踪', '继续跟踪，别因反弹就追买', c.reason)
                : item('observe', 2, 'low', 'falling', '跌得低，还没稳', '先观察，等下跌缓和', c.reason)
            : c.referenceEligible ? item('verify', 3, 'low', 'low-reference', '低位线索·待核验', '有研究线索，先核验价格数据', c.reason) : null;
        const r = c.risk || {};
        const high = r.eligible ? r.state === 'weakening'
            ? item('priority', 0, 'high', 'weakening', '高位开始转弱', '如果持有，优先检查风险', r.reason)
            : r.state === 'pullback' ? item('priority', 1, 'high', 'pullback', '转弱后继续回落', '如果持有，继续检查风险', r.reason)
                : item('observe', 2, 'high', 'high', '价格高，尚未转弱', '先观察，高位不等于该卖', r.reason)
            : r.referenceEligible ? item('verify', 3, 'high', 'high-reference', '高位线索·待核验', '先核验，不确认见顶或转弱', r.reason) : null;
        const opportunity = [low, correction].filter(Boolean).sort((a, b) => a.priority - b.priority)[0];
        let result = mode === 'high' ? high : mode === 'correction' ? correction : opportunity;
        if (mode === 'all') result = [high, opportunity].filter(Boolean).sort((a, b) => a.priority - b.priority)[0];
        if (result) return result;
        const pending = c.state === 'pending' || c.state === 'excluded';
        const raw = c.state === 'reference';
        return item('none', pending ? 6 : raw ? 5 : 4, mode === 'high' ? 'high' : 'low', pending ? 'pending' : raw ? 'reference' : 'normal',
            pending ? '数据待处理' : raw ? '暂无线索·数据待核验' : '暂未触发观察条件', '不在当前名单，不等于没有风险',
            mode === 'high' ? r.reason || c.reason : c.reason);
    }
    function select(items, { filter = 'all', sort = 'priority', family = 'all', query = '', favorites = [], onlyIssues = false, group = 'all', mode = 'low' } = {}) {
        const text = query.trim().toLowerCase(), watched = new Set(favorites);
        const rows = items.filter(({ asset, model }) => {
            const c = model?.candidate;
            if (!c || c.state === 'excluded') return false;
            if (family !== 'all' && c.family !== family || group !== 'all' && asset.group !== group) return false;
            if (text && ![asset.name, asset.shortName, asset.code, c.sector, c.family].join(' ').toLowerCase().includes(text)) return false;
            if (onlyIssues && !['pending', 'reference'].includes(c.state) && !c.fallback && model.status !== 'error') return false;
            return filter === 'all' || filter === 'low-watch' && (c.eligible || c.referenceEligible)
                || filter === 'opportunity-watch' && (c.eligible || c.referenceEligible || c.correction?.eligible || c.correction?.referenceEligible)
                || filter === 'correction-watch' && (c.correction?.eligible || c.correction?.referenceEligible)
                || filter === 'correction-improving' && c.correction?.eligible && c.correction.state === 'improving'
                || filter === 'correction-references' && c.correction?.referenceEligible
                || filter === 'candidates' && c.eligible || filter === 'references' && c.referenceEligible
                || filter === 'improving' && c.state === 'improving'
                || filter === 'opportunities' && (c.eligible && ['improving', 'rebound'].includes(c.state)
                    || c.correction?.eligible && ['improving', 'tracking'].includes(c.correction.state))
                || filter === 'high-watch' && (c.risk?.eligible || c.risk?.referenceEligible)
                || filter === 'risk-alerts' && c.risk?.eligible && ['weakening', 'pullback'].includes(c.risk.state)
                || filter === 'high-references' && c.risk?.referenceEligible
                || ['weakening', 'pullback', 'high'].includes(filter) && c.risk?.eligible && c.risk.state === filter
                || filter === 'supported' && (c.eligible || c.referenceEligible || c.correction?.eligible || c.correction?.referenceEligible) && c.valuationSupport
                || filter === 'favorites' && watched.has(asset.id)
                || filter === 'pending' && ['pending', 'reference'].includes(c.state)
                    && !c.referenceEligible && !c.risk?.referenceEligible && !c.correction?.eligible && !c.correction?.referenceEligible
                || ['falling', 'rebound', 'normal', 'reference'].includes(filter) && filter === c.state;
        });
        const direction = ['high-watch', 'risk-alerts', 'high-references', 'weakening', 'pullback', 'high'].includes(filter) ? 'high'
            : filter.startsWith('correction-') ? 'correction' : mode;
        const groups = { priority: 0, observe: 1, verify: 2, none: 3 };
        return rows.sort((a, b) => {
            const x = a.model.candidate, y = b.model.candidate;
            const ax = attention(x, direction), ay = attention(y, direction);
            const section = groups[ax.group] - groups[ay.group];
            if (section) return section;
            if (sort === 'priority' && ax.priority !== ay.priority) return ax.priority - ay.priority;
            const availability = Number(!Number.isFinite(x.position)) - Number(!Number.isFinite(y.position));
            if (availability) return availability;
            if (['position', 'position-desc', 'drawdown'].includes(sort)) {
                const metric = sort === 'position-desc' ? 'position' : sort;
                const delta = sort === 'position-desc' ? (y[metric] ?? -Infinity) - (x[metric] ?? -Infinity) : (x[metric] ?? Infinity) - (y[metric] ?? Infinity);
                if (delta) return delta;
            }
            const positionDelta = direction === 'high' ? (y.position ?? -Infinity) - (x.position ?? -Infinity) : (x.position ?? Infinity) - (y.position ?? Infinity);
            return ax.priority - ay.priority || Number(x.fallback) - Number(y.fallback)
                || (direction === 'low' ? Number(y.valuationSupport) - Number(x.valuationSupport) : 0) || positionDelta
                || a.asset.code.localeCompare(b.asset.code);
        });
    }
    function shortlist(items, limit = 6, filter = 'candidates', sort = 'priority', mode = 'low') {
        const seen = new Set();
        return select(items, { filter, sort, mode }).filter(({ asset }) => {
            const code = String(asset.trackIndex?.code || '').trim().toUpperCase().replace(/^(SH|SZ)(?=\d{6}$)/, '');
            const key = code ? 'index:' + code : 'asset:' + (asset.secid || asset.id);
            if (seen.has(key)) return false;
            seen.add(key); return true;
        }).slice(0, limit);
    }
    return { POLICY, labels, describeAsset, windowMetrics, oversold, correctionModel, analyze, entryTags, explain, attention, select, shortlist };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BottomScreener;
