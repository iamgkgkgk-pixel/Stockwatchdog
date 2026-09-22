const GptStrategyEngine = (() => {
    'use strict';

    const ASSETS = [
        { id: 'dividend-low-vol', name: '红利低波', code: '512890', secid: '1.512890', symbol: 'sh512890', kind: 'core', history: 'dividend-low-vol', type: 'smart_beta', trackIndex: { code: 'CSIH30269', name: '中证红利低波动指数', danjuanCode: 'CSIH30269' } },
        { id: 'free-cashflow', name: '自由现金流', code: '159201', secid: '0.159201', symbol: 'sz159201', kind: 'core', history: 'free-cashflow', type: 'smart_beta', trackIndex: { code: '980092', name: '国证自由现金流指数' } },
        { id: 'sci-tech-50', name: '双创50', code: '588300', secid: '1.588300', symbol: 'sh588300', kind: 'tech', history: 'sci-tech-50', type: 'a_share_index', trackIndex: { code: '931643', name: '科创创业50指数', danjuanCode: 'SZ399006', isProxy: true, proxyHistoryFrom: '2026-04-28', proxyName: '创业板指' } },
        { id: 'star-50', name: '科创50', code: '588000', secid: '1.588000', symbol: 'sh588000', kind: 'tech', history: null, type: 'a_share_index', trackIndex: { code: '000688', name: '上证科创板50成份指数', danjuanCode: 'SH000688' } },
        { id: 'nasdaq100-cn', name: '纳斯达克100', code: '513110', secid: '1.513110', symbol: 'sh513110', kind: 'tech', history: 'nasdaq100-cn', type: 'us_share_index', trackIndex: { code: 'NDX', name: '纳斯达克100指数', danjuanCode: 'NDX' } },
    ];
    const DEFAULTS = Object.freeze({ timeframe: 'day', length: 12, smoothing: 6, confirmation: 2 });
    const POLICY = Object.freeze({ lowRank: 20, fairRank: 60, richRank: 90, sellPremium: 20, valuationMaxAge: 30,
        sentimentMaxAge: 7, vixFear: 20, vixPanic: 30, stressDrawdown: 10, panicDrawdown: 15, stressVolRank: 80, panicVolRank: 90 });
    const MARKETS = Object.freeze({
        cn: { market: 'cn', instrumentId: '1.000300', code: '000300', label: '沪深300压力代理', method: 'drawdown-volatility' },
        us: { market: 'us', instrumentId: 'CBOE:VIX', code: 'VIX', label: '美股VIX恐慌参考', method: 'vix' },
    });
    const DAY = 86400000;

    function number(value) {
        if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function date(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
        const parsed = new Date(value + 'T00:00:00Z');
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
    }

    function clock(now = new Date(), market = 'cn') {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
            timeZone: market === 'us' ? 'America/New_York' : market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(now).map(part => [part.type, part.value]));
        return { today: `${parts.year}-${parts.month}-${parts.day}`, closed: Number(parts.hour) * 60 + Number(parts.minute) >= (market === 'us' ? 990 : market === 'hk' ? 970 : 900) };
    }

    function age(asOf, today) {
        return date(asOf) && date(today) ? (Date.parse(today) - Date.parse(asOf)) / DAY : Infinity;
    }

    function settings(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
        const integer = (key, min, max) => Number.isInteger(Number(input[key])) && Number(input[key]) >= min && Number(input[key]) <= max ? Number(input[key]) : DEFAULTS[key];
        return { timeframe: input.timeframe === 'week' ? 'week' : 'day', length: integer('length', 2, 120),
            smoothing: integer('smoothing', 1, 30), confirmation: integer('confirmation', 1, 5) };
    }

    function completedBars(rows, now = new Date(), market = 'cn', includeCurrent = false) {
        const { today, closed } = clock(now, market);
        const unique = new Map();
        for (const row of rows || []) {
            const day = date(row.date);
            const close = number(row.close);
            if (!day || close === null || close <= 0 || day > today || (!includeCurrent && (row.provisional || day === today && !closed))) continue;
            unique.set(day, { ...row, date: day, close });
        }
        return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
    }

    function periods(rows, timeframe, now = new Date(), market = 'cn', includeCurrent = false) {
        const daily = completedBars(rows, now, market, includeCurrent);
        if (timeframe !== 'week') return daily;
        const { today, closed } = clock(now, market);
        const groups = new Map();
        for (const bar of daily) {
            const d = new Date(bar.date + 'T00:00:00Z');
            const offset = (d.getUTCDay() + 6) % 7;
            const monday = new Date(d.getTime() - offset * DAY).toISOString().slice(0, 10);
            const previous = groups.get(monday);
            groups.set(monday, previous ? { ...bar, open: previous.open, high: Math.max(previous.high, bar.high), low: Math.min(previous.low, bar.low) } : { ...bar });
        }
        const latestObserved = daily.at(-1)?.date;
        return [...groups.entries()].filter(([monday, bar]) => {
            const friday = new Date(Date.parse(monday) + 4 * DAY).toISOString().slice(0, 10);
            const calendarComplete = friday < today || (friday === today && closed);
            const dataComplete = bar.date === friday || latestObserved > friday;
            return calendarComplete && dataComplete || includeCurrent && monday <= today && today <= friday;
        }).map(([, bar]) => bar);
    }

    function percentile(value, samples, minimum = 1) {
        const clean = samples.map(number).filter(n => n !== null);
        if (number(value) === null || clean.length < minimum) return null;
        const below = clean.filter(n => n < value).length;
        const equal = clean.filter(n => n === value).length;
        return (below + equal / 2) / clean.length * 100;
    }

    function quantile(samples, fraction) {
        if (!samples.length) return null;
        const sorted = [...samples].sort((a, b) => a - b);
        const position = (sorted.length - 1) * fraction;
        const lower = Math.floor(position);
        return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
    }

    function rocModel(rows, input = {}, now = new Date(), market = 'cn') {
        const options = settings(input);
        const bars = periods(rows, options.timeframe, now, market);
        const dailyLast = completedBars(rows, now, market).at(-1);
        const fresh = !!dailyLast && age(dailyLast.date, clock(now, market).today) <= 7;
        return rocSeries(bars, options, fresh);
    }

    function rocSeries(bars, options, fresh) {
        const roc = bars.map((bar, i) => i < options.length ? null : (bar.close / bars[i - options.length].close - 1) * 100);
        const smooth = roc.map((_, i) => {
            const window = roc.slice(Math.max(0, i - options.smoothing + 1), i + 1);
            return window.length === options.smoothing && window.every(v => v !== null) ? window.reduce((sum, v) => sum + v, 0) / window.length : null;
        });
        const lookback = options.timeframe === 'week' ? 104 : 252;
        const minimum = lookback / 2;
        const ranks = [], lowerBand = [], upperBand = [], events = [];
        for (let i = 0; i < bars.length; i++) {
            const past = smooth.slice(Math.max(0, i - lookback), i).filter(v => v !== null);
            ranks.push(percentile(smooth[i], past, minimum));
            lowerBand.push(past.length >= minimum ? quantile(past, 0.2) : null);
            upperBand.push(past.length >= minimum ? quantile(past, 0.8) : null);
            const pivot = i - options.confirmation;
            if (pivot < options.confirmation || smooth[pivot] === null) continue;
            const neighbors = smooth.slice(pivot - options.confirmation, i + 1).filter((_, j) => j !== options.confirmation);
            if (neighbors.some(v => v === null)) continue;
            const value = smooth[pivot];
            const type = neighbors.every(v => value < v) ? 'trough' : neighbors.every(v => value > v) ? 'peak' : null;
            if (!type) continue;
            const rank = ranks[pivot];
            const extreme = rank !== null && (type === 'trough' ? rank <= 20 && value < 0 : rank >= 80 && value > 0);
            events.push({ type, pivotIndex: pivot, confirmIndex: i, pivotDate: bars[pivot].date, confirmedAt: bars[i].date,
                value, rank, extreme, price: bars[i].close });
        }
        const lastIndex = bars.length - 1;
        const slope = lastIndex > 0 && smooth[lastIndex] !== null && smooth[lastIndex - 1] !== null ? Math.sign(smooth[lastIndex] - smooth[lastIndex - 1]) : 0;
        const recent = [...events].reverse().find(event => event.extreme && lastIndex - event.confirmIndex <= 3 &&
            (event.type === 'trough' ? slope > 0 && smooth[lastIndex] > event.value : slope < 0 && smooth[lastIndex] < event.value)) || null;
        return { options, bars, roc, smooth, ranks, lowerBand, upperBand, events, recent, slope, fresh, lookback, minimum,
            last: lastIndex >= 0 ? { date: bars[lastIndex].date, close: bars[lastIndex].close, roc: roc[lastIndex], smooth: smooth[lastIndex], rank: ranks[lastIndex] } : null };
    }

    function displayRocModel(price, input = {}, now = new Date(), market = 'cn') {
        const options = settings(input), today = clock(now, market).today;
        const captured = new Date(price?.fetchedAt);
        const cut = Number.isFinite(captured.getTime()) && captured <= now ? captured : now;
        const confirmed = rocModel(price?.bars || [], options, cut, market);
        confirmed.fresh = !!confirmed.last && age(confirmed.last.date, today) <= 7;
        const alternative = price?.preview;
        const source = alternative && alternative.code === price.code && alternative.secid === price.secid
            && (alternative.market || market) === market && (!price.market || price.market === market) ? alternative : price;
        const fetched = new Date(source?.fetchedAt);
        const validCapture = Number.isFinite(fetched.getTime()) && fetched <= now && clock(fetched, market).today === today;
        const live = validCapture && source?.liveBar?.date === today && number(source.liveBar.close) > 0 ? source.liveBar : null;
        const daily = completedBars(source?.bars || [], validCapture ? fetched : cut, market);
        const rows = live ? [...daily.filter(bar => bar.date < live.date), { ...live, provisional: true }] : daily;
        const displayBars = validCapture ? periods(rows, options.timeframe, fetched, market, true) : confirmed.bars;
        const provisional = !!displayBars.length && (!confirmed.last || displayBars.at(-1).date > confirmed.last.date);
        const raw = (provisional ? source?.adjustment : price?.adjustment) === 'raw';
        const base = provisional ? rocSeries(displayBars, options, confirmed.fresh) : confirmed;
        const quote = price?.quote;
        const validQuote = quote && quote.code === price.code && quote.secid === price.secid && quote.date === today
            && number(quote.close) > 0 && Number.isFinite(Date.parse(quote.observedAt)) && Date.parse(quote.observedAt) <= now.getTime();
        const formatTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', {
            timeZone: market === 'us' ? 'America/New_York' : 'Asia/Shanghai', hour12: false }) : '时间未标注';
        const capturedAt = provisional ? source?.fetchedAt : price?.fetchedAt;
        const timeLabel = live?.observedAt ? '报价于 ' + formatTime(live.observedAt) : '获取于 ' + formatTime(capturedAt);
        const status = provisional ? options.timeframe === 'week' ? '本周暂估 · 未确认' : '当日暂估 · 未确认' : '收盘日线';
        const note = `${status}；${timeLabel}；${provisional ? '展示ROC随本次行情变化，确认信号仍截至 ' + (confirmed.last?.date || '无') : '日线截至 ' + (confirmed.last?.date || '无')}`
            + (confirmed.last && confirmed.last.date < today ? '；当天完整日线尚未取得或尚未收盘，不将旧日期改成今天' : '')
            + (raw ? '；未复权参考' : '') + '；源端行情可能延迟或修订';
        return { ...base, provisional, confirmed, raw, source: provisional ? source?.source : price?.source,
            capturedAt, timeLabel, status, note, quote: validQuote ? { ...quote, timeLabel: formatTime(quote.observedAt) } : null,
            events: raw || provisional && source !== price ? [] : confirmed.events, recent: null };
    }

    function valuationBand(rank) {
        if (number(rank) === null || rank < 0 || rank > 100) return 'unknown';
        return rank <= POLICY.lowRank ? 'low' : rank <= POLICY.fairRank ? 'fair' : rank >= POLICY.richRank ? 'rich' : 'elevated';
    }

    function valuationModel(points = [], observation = null, manual = null, now = new Date()) {
        const today = clock(now).today;
        const pe = number(observation?.pe);
        const asOf = date(observation?.asOf);
        const monthOnly = /^\d{4}-\d{2}$/.test(observation?.asOf || '') && date(observation.asOf + '-01') ? observation.asOf : null;
        const referenceDate = asOf || (monthOnly ? monthOnly + '-01' : null);
        const references = [];
        const validObservation = pe !== null && pe > 0 && !['proxy', 'estimated'].includes(observation?.quality);
        if (validObservation && referenceDate && referenceDate <= today) {
            const monthly = new Map();
            for (const point of points) {
                const rawDate = point.asOf || point.date;
                const stamp = /^\d{4}-\d{2}$/.test(rawDate || '') ? rawDate + '-01' : rawDate;
                if (!date(stamp) || stamp >= referenceDate || stamp.slice(0, 7) === referenceDate.slice(0, 7) ||
                    ['estimated', 'proxy'].includes(point.quality) || number(point.value) === null || Number(point.value) <= 0) continue;
                const key = stamp.slice(0, 7);
                if (!monthly.has(key) || monthly.get(key).date < stamp) monthly.set(key, { date: stamp, value: Number(point.value) });
            }
            for (const years of [3, 5]) {
                const cutoff = new Date(referenceDate + 'T00:00:00Z');
                cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
                const start = cutoff.toISOString().slice(0, 7);
                const window = [...monthly.entries()].filter(([month]) => month >= start).map(([, point]) => point).sort((a, b) => a.date.localeCompare(b.date));
                const samples = window.map(point => point.value);
                const enough = samples.length >= Math.ceil(years * 12 * 0.8);
                const median = enough ? quantile(samples, 0.5) : null;
                references.push({ years, label: `近${years}年`, count: samples.length, rank: enough ? percentile(pe, samples) : null,
                    median, premium: median > 0 ? (pe / median - 1) * 100 : null, start: window[0]?.date || null, end: window.at(-1)?.date || null });
            }
        }
        const valid = references.filter(reference => reference.rank !== null);
        let primary = valid.find(reference => reference.years === 5) || valid[0] || null;
        let mode = 'history';
        const providerRank = number(observation?.providerPercentile);
        if (!primary && validObservation && providerRank !== null && providerRank >= 0 && providerRank <= 100) {
            primary = { label: '服务商历史', rank: providerRank, median: null, premium: null, count: null };
            mode = 'provider';
        }
        const minRank = valid.length ? Math.min(...valid.map(reference => reference.rank)) : null;
        const maxRank = valid.length ? Math.max(...valid.map(reference => reference.rank)) : null;
        const consistent = valid.length === 2 && valuationBand(minRank) === valuationBand(maxRank);
        const disagreement = valid.length === 2 && (!consistent || maxRank - minRank > 20);
        let band = primary ? valuationBand(primary.rank) : 'unknown';
        if (valid.length === 2) {
            if (minRank <= POLICY.lowRank && maxRank > POLICY.fairRank || minRank <= POLICY.fairRank && maxRank >= POLICY.richRank) band = 'mixed';
            else if (band === 'low' && maxRank > POLICY.lowRank) band = 'fair';
            else if (band === 'rich' && minRank < POLICY.richRank) band = 'elevated';
        }
        const identityKnown = !!observation?.indexId && !observation.identityInferred;
        const fresh = validObservation && !!asOf && age(asOf, today) >= 0 && age(asOf, today) <= POLICY.valuationMaxAge;
        let usable = fresh && identityKnown && primary !== null;
        let confidence = mode === 'provider' ? 'provider' : disagreement ? 'disagreement' : valid.length === 1 ? 'single-window' : 'local';
        let reductionReady = band === 'rich' && mode === 'history' && primary.premium >= POLICY.sellPremium;
        let reason = !validObservation ? '没有可用于比较的同指数正PE观测。' : monthOnly ? '仅有月份精度的旧估值，保留当月参考，不当作当前估值。' : !identityKnown ? '旧估值未明确标注指数身份，只保留参考，不生成当前主买卖结论。' : !fresh ? '估值已过期或日期无效，保留原日期，不生成当前主买卖结论。' : !primary ? '缺少可比PE历史及同指数服务商分位，不用ROC代替估值。' : mode === 'provider' ? '本地历史不足，使用已标明来源的服务商分位作有限参考；不冒充3年或5年分位，不确认明显透支。' : disagreement ? '3年与5年判断存在差异：保留两者，向持有方向保守处理，不把整份分析清空。' : valid.length === 1 ? `仅${primary.label}样本足够，使用单窗口参考，不要求另一个窗口齐全。` : '优先使用5年PE分位，3年用于交叉检查；PE与分位不重复加权。';
        const manualValid = manual && ['low', 'fair', 'elevated', 'rich'].includes(manual.band) && date(manual.asOf) && age(manual.asOf, today) >= 0 && age(manual.asOf, today) <= POLICY.valuationMaxAge && typeof manual.reason === 'string' && manual.reason.trim();
        if (manualValid) {
            band = manual.band;
            usable = true;
            mode = 'manual';
            confidence = 'manual';
            reductionReady = band === 'rich';
            reason = `使用你在 ${manual.asOf} 核对的估值判断，不是模型独立验证。`;
        } else if (manual) reason += ' 已保存的人工判断无效或超过30天。';
        return { pe, asOf, references, primary, fresh, consistent, disagreement, confidence, band, usable, reductionReady, mode,
            reason, observation, manual: manualValid ? manual : null };
    }

    function marketFor(asset) {
        return asset.type === 'us_share_index' ? 'us' : 'cn';
    }

    function stressSeries(bars) {
        const returns = bars.map((bar, i) => i ? Math.log(bar.close / bars[i - 1].close) : null);
        const series = [];
        for (let i = 0; i < bars.length; i++) {
            const window = returns.slice(Math.max(1, i - 19), i + 1);
            let volatility = null;
            if (window.length === 20) {
                const mean = window.reduce((sum, value) => sum + value, 0) / 20;
                volatility = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 19) * Math.sqrt(252) * 100;
                volatility = Number(volatility.toFixed(8));
            }
            const peak = i >= 251 ? Math.max(...bars.slice(i - 251, i + 1).map(bar => bar.close)) : null;
            const drawdown = peak ? (1 - bars[i].close / peak) * 100 : null;
            const historicalVol = series.slice(-756).map(point => point.volatility).filter(value => value !== null);
            series.push({ date: bars[i].date, volatility, drawdown, volatilityRank: percentile(volatility, historicalVol, 252) });
        }
        return series;
    }

    function marketBars(snapshot, asset, now = new Date()) {
        const market = marketFor(asset), expected = MARKETS[market];
        if (!snapshot || snapshot.market !== market || snapshot.instrumentId !== expected.instrumentId || snapshot.method !== expected.method ||
            snapshot.adjustment !== 'none' || !Array.isArray(snapshot.bars) || typeof snapshot.fetchedAt !== 'string' || !date(snapshot.asOf)) return null;
        const capturedAt = new Date(snapshot.fetchedAt);
        if (!Number.isFinite(capturedAt.getTime()) || capturedAt > now || snapshot.bars.some(bar => !bar || typeof bar !== 'object')) return null;
        const bars = completedBars(completedBars(snapshot.bars, capturedAt, market), now, market);
        if (!bars.length || bars.at(-1).date !== snapshot.asOf || market === 'us' && bars.some(bar => bar.close > 300)) return null;
        return bars;
    }

    function sentimentModel(snapshot, asset, now = new Date()) {
        const market = marketFor(asset), expected = MARKETS[market];
        const result = { usable: false, level: 'unknown', label: '恐慌数据不足', market, asOf: null, method: expected.method,
            detail: '未使用缺失情绪推断中性或恐慌；估值主判断仍保留。', source: snapshot?.source || expected.label };
        const bars = marketBars(snapshot, asset, now);
        if (!bars) return result;
        const last = bars.at(-1);
        result.asOf = last.date;
        if (age(last.date, clock(now, market).today) > POLICY.sentimentMaxAge) return { ...result, label: '恐慌数据已过期', detail: `${last.date} 的观测已超过7天，不参与当前判断。` };
        if (market === 'us') {
            if (last.close <= 0 || last.close > 300) return result;
            const level = last.close >= POLICY.vixPanic ? 'panic' : last.close >= POLICY.vixFear ? 'fear' : 'normal';
            return { ...result, usable: true, level, value: last.close, label: level === 'panic' ? '美股恐慌较强' : level === 'fear' ? '美股有所恐慌' : '美股恐慌不明显',
                detail: `VIX ${last.close.toFixed(2)}（${last.date}）。衡量标普500期权预期波动，不是纳指专属情绪，也不预测涨跌。` };
        }
        const current = stressSeries(bars).at(-1);
        if (!current || current.drawdown === null || current.volatilityRank === null) return result;
        const level = current.drawdown >= POLICY.panicDrawdown && current.volatilityRank >= POLICY.panicVolRank ? 'panic' :
            current.drawdown >= POLICY.stressDrawdown && current.volatilityRank >= POLICY.stressVolRank ? 'fear' : 'normal';
        return { ...result, ...current, usable: true, level, label: level === 'panic' ? 'A股压力很高（代理）' : level === 'fear' ? 'A股压力偏高（代理）' : 'A股未见恐慌共振（代理）',
            detail: `沪深300距一年高点回撤 ${current.drawdown.toFixed(1)}%，20日波动率处历史 ${current.volatilityRank.toFixed(1)}% 分位（${last.date}）。这是价格压力代理，不是直接情绪调查。` };
    }

    function rocReason(model) {
        if (!model.last || number(model.last.smooth) === null) return '完整价格样本不足，暂时算不出ROC转折。';
        if (!model.fresh) return `价格数据只到 ${model.last.date}，已过期，不能判断当前波段。`;
        const confirmed = date(model.recent?.confirmedAt);
        const when = confirmed ? `（${confirmed.slice(5)}确认）` : '';
        if (model.recent?.type === 'peak') return `ROC高位转弱已确认${when}。`;
        if (model.recent?.type === 'trough') return `ROC低位回升已确认${when}。`;
        const rank = number(model.last.rank);
        if (rank === null) return 'ROC历史样本不够，暂时不能判断这次波动是否处于高低位。';
        if (rank <= 20) {
            if (model.slope < 0) return 'ROC已在历史低位，但均线仍在下行，尚未确认回升。';
            if (model.slope > 0) return 'ROC在低位回升，但还没有形成有效的转折确认。';
            return 'ROC在低位走平，尚未确认向上转折。';
        }
        if (rank >= 80) return model.slope >= 0 ? 'ROC在历史高位，但尚未确认转弱。' : 'ROC在高位回落，但尚未完成转折确认。';
        return model.slope < 0 ? 'ROC均线正在回落，但当前没有新的波段转折确认。' : 'ROC在中间区间波动，目前没有新的波段转折。';
    }

    function primaryDecision(asset, valuation, regime = 'unknown', sentiment = null) {
        const core = asset.kind === 'core';
        const fear = sentiment?.usable && sentiment.market === marketFor(asset) ? sentiment.level : 'unknown';
        const primary = valuation.primary;
        const bandNames = { low: '历史相对低位', fair: '合理区间', elevated: '相对偏高', rich: '明显偏高', mixed: '历史窗口分歧', unknown: '尚不明确' };
        const evidence = valuation.mode === 'manual' ? `你已判断当前估值处于${bandNames[valuation.band]}。` : primary && number(valuation.pe) > 0 ?
            `PE ${valuation.pe.toFixed(2)}，${primary.label} ${primary.rank.toFixed(1)}% 分位。` : '';
        const base = {
            action: 'HOLD', tone: 'neutral', title: '持有为主', reason: evidence,
            buy: core ? '合理价按计划少量买' : '等待更低估值', hold: core ? '底仓继续持有' : '持有为主',
            scope: valuation.mode === 'manual' ? '采用你的估值判断' : valuation.mode === 'provider' ? '服务商估值参考' : valuation.confidence === 'single-window' ? '单窗口估值参考' : '估值主判断',
            entryAllowed: core || regime === 'easing', next: '继续看估值变化与盈利是否能支撑当前价格。',
            premise: '前提是长期盈利逻辑未破坏；历史相对便宜不等于内在价值，所有边界都是未验证收益的实验规则。',
            sentimentEffect: fear === 'unknown' ? '恐慌参考缺失或过期：不作情绪修正，不当成中性。' : fear === 'panic' ? '恐慌参考偏强；只有估值合适才增强买入意愿，不是无条件抄底。' : fear === 'fear' ? '恐慌参考有所上升；保持分批，不因恐慌单独改变方向。' : '未见明显恐慌，不对估值结论额外加分。',
        };
        if (!valuation.usable) {
            base.action = 'DATA_INCOMPLETE'; base.tone = 'muted';
            base.title = valuation.observation?.asOf ? '估值待更新' : '暂无法判断';
            base.reason = valuation.observation?.asOf ? `估值只到 ${valuation.observation.asOf}，或缺少可比历史；不能用它判断当前贵贱。` : '缺少当前同指数估值，恐慌或波段形态都不能代替它。';
            base.buy = '先核对当前估值'; base.hold = '暂不据此调整底仓';
            base.scope = '主判断数据不足'; base.next = '保留已有历史参考，更新估值后再判断买卖。';
        } else if (valuation.band === 'mixed') {
            base.action = 'WAIT'; base.title = '观望，不加仓';
            base.reason += '不同历史窗口对贵贱判断相反，暂不下单边结论。';
            base.buy = '暂不加仓'; base.hold = '暂不据此调仓';
        } else if (valuation.band === 'low') {
            base.action = 'BUY'; base.tone = 'positive'; base.title = valuation.mode === 'provider' ? '小幅买入' : '分批买入';
            base.reason += '估值已在相对低位，买入方向不需要等待波段见底。';
            base.buy = valuation.mode === 'provider' ? '少量试买，复核来源' : '可分批买入';
            base.next = '核对盈利没有持续恶化，控制批次；不把低分位当作绝对底。';
            if (fear === 'panic' || fear === 'fear') base.sentimentEffect = '低估叠加市场压力，增强分批买入意愿；压力越大，越不应一次买满。';
        } else if (valuation.band === 'fair') {
            base.reason += '估值仍在合理区间，继续持有，不因波段高点改变主方向。';
            if (core && fear === 'panic' && valuation.mode !== 'provider' && !valuation.disagreement) {
                base.action = 'ADD'; base.tone = 'positive'; base.title = '小幅加仓';
                base.reason += '同时出现较强市场压力，可少量分批增加。'; base.buy = '可少量分批加仓';
                base.sentimentEffect = '恐慌参考在合理估值内提供加仓理由，不把它当成价格已经见底。';
            } else if (!core && fear === 'panic') base.sentimentEffect = '虽有恐慌，但科技估值还不够低，按你的偏好仍等待低价机会。';
        } else if (valuation.band === 'rich' && valuation.reductionReady) {
            base.action = 'REDUCE'; base.tone = 'caution'; base.title = '分批减仓';
            base.reason += valuation.mode === 'manual' ? '按你确认的高估判断分批兑现，不必等待短线走弱。' :
                `较${primary.label}中位PE高 ${primary.premium.toFixed(1)}%，同时满足高分位和明显偏离条件。`;
            base.hold = core ? '先减机动部分，底仓分批评估' : '分批减一部分'; base.buy = '不再追加';
            base.next = '核对盈利增长是否足以解释估值抬升；这是减仓参考，不是必须清仓。';
        } else {
            base.action = 'NO_ADD'; base.title = '持有，暂停加仓'; base.tone = 'caution';
            base.reason += valuation.band === 'rich' ? '虽处历史高分位，但缺少明显偏离的证据，先不直接推导减仓。' : '估值偏贵，但未达到本页的明显高估减仓条件。';
            base.buy = '暂停加仓';
            if (fear === 'panic' || fear === 'fear') base.sentimentEffect = '市场虽有压力，估值仍不便宜；恐慌不能把偏贵资产变成买点。';
        }
        if (!core && regime !== 'easing') {
            base.buy = regime === 'tightening' ? '按加息规则暂停新买' : '先选择利率阶段';
            if (['BUY', 'ADD'].includes(base.action)) {
                base.action = 'NO_BUY'; base.title = '暂不买入'; base.tone = 'neutral';
                base.reason = evidence + (regime === 'tightening' ? '估值虽低，但你设定加息阶段不买科技，暂不执行。' : '估值虽低，但利率阶段未确认，先不执行买入。');
            }
        }
        return base;
    }

    function tacticalDecision(asset, valuation, primary, model) {
        if (!model?.last || number(model.last.smooth) === null || !model.fresh) return { title: '波段暂不可用', detail: '完整价格缺失或过期，只暂停波段提示，不覆盖估值主判断。' };
        const context = rocReason(model);
        if (!valuation.usable || valuation.band === 'mixed') return { title: '只看形态，不代替估值', detail: context + ' 主判断仍需估值证据。' };
        if (primary.action === 'REDUCE') return { title: model.recent?.type === 'peak' ? '短线转弱，可分批兑现' : '按高估方向分批兑现', detail: context + ' 减仓理由来自估值，不必等ROC波峰。' };
        if (['BUY', 'ADD'].includes(primary.action)) {
            if (model.recent?.type === 'trough') return { title: '低位回升，分批执行', detail: context + ' 波段配合主买入方向。' };
            return { title: model.slope < 0 ? '短线偏弱，拉开买入批次' : '不要追涨，分批投入', detail: context + ' 不因此取消低估买入方向，也不因此转为卖出。' };
        }
        if (model.recent?.type === 'peak') return { title: asset.kind === 'core' ? '机动仓可做T减仓' : '波段仓可部分兑现', detail: context + ' 仅影响波段部分，不把主持有结论改成卖出。' };
        if (model.recent?.type === 'trough') return primary.entryAllowed && asset.kind === 'core' && valuation.band === 'fair' ?
            { title: '机动仓可分批回补', detail: context + ' 底仓仍按合理估值持有。' } : { title: '出现回升，不据此加仓', detail: context + ' 仍服从上方估值与利率条件。' };
        return { title: model.slope < 0 ? '短线回落，暂无做T确认' : '暂无新的做T信号', detail: context };
    }

    function decision(asset, valuation, model, regime = 'unknown', sentiment = null) {
        const main = primaryDecision(asset, valuation, regime, sentiment);
        return { ...main, tactical: tacticalDecision(asset, valuation, main, model) };
    }

    return { ASSETS, DEFAULTS, POLICY, MARKETS, number, date, clock, age, settings, completedBars, periods, percentile, quantile,
        rocModel, displayRocModel, valuationModel, valuationBand, marketFor, marketBars, stressSeries, sentimentModel, primaryDecision, tacticalDecision, decision };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GptStrategyEngine;
