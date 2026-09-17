/**
 * 数据观测契约：数值、所属标的、观测日期与获取时间分别保存。
 * 缺失值不是0；缓存写入或行情刷新不改变估值的观测日期。
 */
const DataQuality = (() => {
    'use strict';

    const FIELDS = ['pe', 'pb', 'pePercentile', 'pbPercentile', 'dividendYield', 'bondYield', 'roe', 'price', 'priceChange', 'marketTemp', 'trendScore'];
    const LABELS = { pe: 'PE', pb: 'PB', dividendYield: '股息率', bondYield: '国债收益率', roe: 'ROE', marketTemp: '市场情绪', trendScore: '趋势数据' };
    const SERIES = { pe: 'peHistory', pb: 'pbHistory', dividendYield: 'dividendYieldHistory', bondYield: 'bondYieldHistory', roe: 'roeHistory', price: 'priceHistory' };

    function number(value) {
        if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function today(now = new Date()) {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
        return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
    }

    function asOf(value) {
        if (value === null || value === undefined || value === '') return null;
        let text = String(value).trim();
        if (/^\d{8}$/.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
        if (/^\d{10}(?:\d{3})?$/.test(text)) {
            const time = Number(text) * (text.length === 10 ? 1000 : 1);
            return Number.isFinite(time) ? today(new Date(time)) : null;
        }
        const match = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:$|[ T])/);
        if (!match) return null;
        const date = `${match[1]}-${match[2]}-${match[3]}`;
        const parsed = new Date(`${date}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
    }

    function indexKey(code) {
        const key = String(code || '').trim().toUpperCase().replace(/^(SH|SZ)(?=\d{6}$)/, '');
        return { SP500: 'SPX', HKHSTECH: 'HSTECH' }[key] || key;
    }

    function isProxy(config) {
        return !!(config && config.trackIndex && config.trackIndex.isProxy);
    }

    function valuationIndex(config) {
        const track = (config && config.trackIndex) || {};
        return indexKey(track.code || track.danjuanCode || (config && config.code));
    }

    function bondMarket(config) {
        if (config.signalRules === 'buffett_jp') return 'jp';
        if (config.type === 'us_share_index') return 'us';
        return 'cn';
    }

    function valid(field, value) {
        const n = number(value);
        if (n === null) return false;
        if (['pe', 'pb', 'price'].includes(field)) return n > 0;
        if (['pePercentile', 'pbPercentile', 'marketTemp', 'trendScore'].includes(field)) return n >= 0 && n <= 100;
        if (field === 'dividendYield') return n >= 0 && n <= 100;
        if (field === 'bondYield') return n >= -5 && n <= 30;
        return true;
    }

    function requiredFields(config) {
        if (config.type === 'gold' || config.type === 'commodity') return ['trendScore'];
        if (config.type === 'bond') return ['bondYield'];
        const required = ['pe'];
        if (config.useBondSpread || ['buffett_us', 'buffett_jp', 'buffett_stock'].includes(config.signalRules)) required.push('bondYield');
        if (config.useBondSpread) required.push('dividendYield');
        if (config.signalRules === 'buffett_stock') required.push('roe', 'pb');
        return required;
    }

    function metadata(data, field) {
        const meta = data.fieldMeta && data.fieldMeta[field];
        const originalDate = meta ? meta.asOf || meta.dateLabel : data.valuationAsOf || data.updateTime;
        const date = asOf(meta ? meta.asOf : originalDate);
        const dateLabel = date || (/^\d{4}-(0[1-9]|1[0-2])$/.test(originalDate || '') ? originalDate : null);
        return { ...(meta || { source: '旧版快照（来源待核验）', quality: 'legacy' }), asOf: date, dateLabel };
    }

    function primaryField(config) {
        return config.type === 'gold' || config.type === 'commodity' ? 'trendScore' : config.type === 'bond' ? 'bondYield' : 'pe';
    }

    function referenceUsable(data, field, config, basis = null) {
        if (!valid(field, data[field])) return false;
        const meta = metadata(data, field);
        if (meta.asOf && meta.asOf > today()) return false;
        if (field === 'bondYield') {
            if (meta.market && meta.market !== bondMarket(config)) return false;
            if (bondMarket(config) === 'jp' && meta.market !== 'jp') return false;
        }
        if (field === 'marketTemp' && meta.quality === 'proxy') return false;
        if (['pe', 'pb', 'dividendYield', 'roe'].includes(field)) {
            const expected = basis ? basis.indexId : valuationIndex(config);
            const knownIndex = meta.instrumentId ? indexKey(meta.instrumentId) : isProxy(config) ? pointIndex({ date: meta.dateLabel }, config) : null;
            if (knownIndex && knownIndex !== expected) return false;
            if (isProxy(config) && !knownIndex && meta.quality !== 'proxy') return false;
            if (meta.quality === 'proxy' && !(basis && basis.isProxy)) return false;
        }
        return true;
    }

    function fieldIssue(data, field, config, now = new Date()) {
        const label = LABELS[field] || field;
        if (!valid(field, data[field])) return `缺少有效${label}`;
        const meta = metadata(data, field);
        if (!['observed', 'manual'].includes(meta.quality)) return `${label}为${meta.quality === 'proxy' ? '代理' : meta.quality === 'estimated' ? '估算' : '未核验'}数据`;
        if (!meta.asOf) return `${label}缺少观测日期`;
        const age = (Date.parse(today(now)) - Date.parse(meta.asOf)) / 86400000;
        const maxAge = field === 'roe' ? 180 : field === 'marketTemp' || field === 'trendScore' ? 3 : 7;
        if (age < 0) return `${label}观测日期在未来`;
        if (age > maxAge) return `${label}已过期（${meta.asOf}）`;
        if (field === 'bondYield' && meta.market !== bondMarket(config)) return '国债市场与标的基准不匹配';
        if (['pe', 'pb', 'dividendYield', 'roe'].includes(field) && indexKey(meta.instrumentId) !== valuationIndex(config)) return `${label}所属指数未确认或不匹配`;
        return null;
    }

    function assess(data, config, now = new Date(), basis = null) {
        const required = requiredFields(config);
        const primary = primaryField(config);
        const reasons = required.map(field => fieldIssue(data, field, config, now)).filter(Boolean);
        if (basis && basis.isProxy) reasons.unshift(`${basis.label}仅作代理参考，不代表目标指数自身估值`);
        else if (isProxy(config) && !basis) reasons.unshift('需要选择同指数的参考历史');
        const warnings = [];
        if (config.dimWeights && config.dimWeights.quality > 0 && !required.includes('roe') && fieldIssue(data, 'roe', config, now)) warnings.push('盈利质量未完整核验');
        const primaryMeta = metadata(data, primary);
        const calculable = referenceUsable(data, primary, config, basis);
        const allowed = calculable && reasons.length === 0;
        const hardReasons = calculable ? [] : [`${LABELS[primary] || primary}缺失、身份不符或日期无效`];
        return { allowed, calculable, status: allowed ? 'verified' : calculable ? 'reference' : 'unavailable', reasons: [...new Set(reasons)], hardReasons, warnings,
            asOf: primaryMeta.asOf, dateLabel: primaryMeta.dateLabel || '日期未知', required, basis };
    }

    function mergeSnapshots(...snapshots) {
        const result = { fieldMeta: {} };
        const now = today();
        const rank = (meta) => ['observed', 'manual'].includes(meta.quality) ? 2 : meta.quality === 'proxy' ? 1 : 0;
        for (const snapshot of snapshots) {
            if (!snapshot) continue;
            for (const field of FIELDS) {
                if (!valid(field, snapshot[field])) continue;
                const incoming = metadata(snapshot, field);
                const current = result.fieldMeta[field];
                if (incoming.asOf && incoming.asOf > now) continue;
                const keepManual = current && current.quality === 'manual' && incoming.quality !== 'manual' && incoming.asOf === current.asOf;
                const replace = !keepManual && (!current || rank(incoming) > rank(current) || (rank(incoming) === rank(current) && (incoming.asOf || '') >= (current.asOf || '')));
                if (replace) {
                    result[field] = number(snapshot[field]);
                    result.fieldMeta[field] = incoming;
                }
            }
        }
        result.valuationAsOf = result.fieldMeta.pe ? result.fieldMeta.pe.asOf : null;
        const primaryMeta = result.fieldMeta.pe || result.fieldMeta.trendScore || result.fieldMeta.bondYield || {};
        result.updateTime = primaryMeta.asOf || primaryMeta.dateLabel || '';
        result.valuationSource = result.fieldMeta.pe ? result.fieldMeta.pe.source : '';
        result.dataSource = [...new Set(Object.entries(result.fieldMeta).map(([key, meta]) => `${LABELS[key] || key}:${meta.source || '未知来源'} · ${meta.asOf || meta.dateLabel || '日期未知'}`))];
        return result;
    }

    function latestSnapshot(history, config) {
        if (!history) return mergeSnapshots();
        const snapshots = [history.currentData || {}];
        if (history.proxyValuation && isProxy(config)) {
            const proxy = history.proxyValuation;
            const snapshot = { ...proxy, fieldMeta: {} };
            for (const field of ['pe', 'pb', 'pePercentile', 'dividendYield', 'roe']) snapshot.fieldMeta[field] = { ...proxy, quality: 'proxy', asOf: asOf(proxy.asOf) };
            snapshots.push(snapshot);
        }
        for (const [field, series] of Object.entries(SERIES)) {
            for (const point of history[series] || []) {
                if (!valid(field, point.value)) continue;
                const date = asOf(point.asOf || point.date);
                if (!date || date > today()) continue;
                const inferredProxy = isProxy(config) && ['pe', 'pb', 'dividendYield', 'roe'].includes(field) && pointIndex(point, config) === indexKey(config.trackIndex.danjuanCode);
                const meta = { source: point.source || (inferredProxy ? '旧版创业板指代理采样' : '历史采样（来源待核验）'), quality: inferredProxy ? 'proxy' : point.quality || 'legacy',
                    asOf: date, instrumentId: point.instrumentId || (isProxy(config) && field !== 'bondYield' ? pointIndex(point, config) : undefined), market: point.market };
                const snapshot = { [field]: point.value, fieldMeta: { [field]: meta } };
                if (field === 'pe' && valid('pePercentile', point.percentile)) {
                    snapshot.pePercentile = point.percentile;
                    snapshot.fieldMeta.pePercentile = { ...meta };
                }
                snapshots.push(snapshot);
            }
        }
        return mergeSnapshots(...snapshots);
    }

    function pointIndex(point, config) {
        if (point.instrumentId) return indexKey(point.instrumentId);
        if (!isProxy(config)) return valuationIndex(config);
        const date = asOf(point.asOf || point.date) || (/^\d{4}-\d{2}$/.test(point.date || '') ? point.date + '-01' : null);
        const boundary = config.trackIndex.proxyHistoryFrom;
        if (!date || !boundary) return null;
        return date >= boundary ? indexKey(config.trackIndex.danjuanCode) : valuationIndex(config);
    }

    function comparableHistory(history, config, selectedBasis = null) {
        if (!history) return null;
        const basis = selectedBasis || history.referenceBasis || { indexId: valuationIndex(config), label: config.trackIndex && config.trackIndex.name || config.shortName, isProxy: false };
        const result = { ...history, referenceBasis: basis };
        for (const key of ['peHistory', 'pbHistory', 'roeHistory', 'dividendYieldHistory', 'bondYieldHistory', 'spreadHistory']) {
            const source = key === 'peHistory' && basis.isProxy ? [...(history.peHistory || []), ...(history.proxyPeHistory || [])] : history[key] || [];
            result[key] = source.filter(point => {
                if (number(point.value) === null || point.quality === 'estimated') return false;
                const date = asOf(point.asOf || (point.date && point.date.length === 7 ? point.date + '-01' : point.date));
                if (!date || date > today()) return false;
                if (key === 'bondYieldHistory') {
                    if (point.market && point.market !== bondMarket(config)) return false;
                    if (bondMarket(config) === 'jp' && point.market !== 'jp') return false;
                } else if (key !== 'spreadHistory' && pointIndex(point, config) !== basis.indexId) return false;
                return key !== 'peHistory' || point.value > 0;
            }).map(point => ({ ...point, value: number(point.value) }));
        }
        if (basis.isProxy) result.valuationAnchor = null;
        delete result.historyBlockedReason;
        return result;
    }

    function valuationContext(history, config, data = {}) {
        const target = valuationIndex(config);
        const meta = metadata(data, 'pe');
        const proxyIndex = isProxy(config) ? indexKey(config.trackIndex.danjuanCode) : null;
        const inferredIndex = meta.instrumentId ? indexKey(meta.instrumentId) : pointIndex({ date: meta.dateLabel }, config);
        const useProxy = !!proxyIndex && (inferredIndex === proxyIndex || meta.quality === 'proxy' || (!meta.instrumentId && !data.pe));
        const basis = { indexId: useProxy ? proxyIndex : target, isProxy: useProxy,
            label: useProxy ? `${config.trackIndex.proxyName || config.trackIndex.danjuanName}（代理参考）` : config.trackIndex && config.trackIndex.name || config.shortName };
        return { basis, history: comparableHistory(history, config, basis) };
    }

    function monthlyPoints(points) {
        const months = new Map();
        for (const point of points || []) {
            if (!point.date || number(point.value) === null || point.quality === 'estimated') continue;
            const date = asOf(point.asOf || (point.date.length === 7 ? point.date + '-01' : point.date));
            if (!date || date > today()) continue;
            const month = date.slice(0, 7);
            const previous = months.get(month);
            if (!previous || date >= previous.sampleDate) months.set(month, { ...point, date: month, sampleDate: date, value: number(point.value) });
        }
        return [...months.values()].sort((a, b) => a.date.localeCompare(b.date));
    }

    function monthlyHistory(history) {
        if (!history) return null;
        const result = { ...history };
        for (const key of ['peHistory', 'spreadHistory', 'bondYieldHistory', 'dividendYieldHistory', 'priceHistory']) result[key] = monthlyPoints(history[key]);
        return result;
    }

    function referenceValues(history, key) {
        const points = monthlyPoints(history && history[key]);
        return points.length >= 5 ? points.map(point => point.value) : [];
    }

    function manualSnapshot(values, config, date) {
        const snapshot = { fieldMeta: {} };
        for (const field of FIELDS) {
            if (!valid(field, values[field])) continue;
            snapshot[field] = number(values[field]);
            snapshot.fieldMeta[field] = { source: '手动录入', quality: 'manual', asOf: asOf(date), instrumentId: valuationIndex(config), market: field === 'bondYield' ? bondMarket(config) : undefined };
        }
        return mergeSnapshots(snapshot);
    }

    function withLatestObservations(history, snapshot, config) {
        const result = { ...(history || {}) };
        const append = (key, value, meta) => {
            const point = { ...meta, date: meta.asOf, value };
            result[key] = [...(result[key] || []).filter(item => item.date !== point.date), point]
                .sort((a, b) => a.date.localeCompare(b.date));
        };
        const available = field => metadata(snapshot, field).quality === 'observed' && !fieldIssue(snapshot, field, config);
        for (const field of ['pe', 'dividendYield', 'bondYield']) {
            if (available(field)) append(SERIES[field], number(snapshot[field]), metadata(snapshot, field));
        }
        const dividend = metadata(snapshot, 'dividendYield'), bond = metadata(snapshot, 'bondYield');
        if (config.useBondSpread && available('dividendYield') && available('bondYield') && dividend.asOf === bond.asOf) {
            append('spreadHistory', number(snapshot.dividendYield) - number(snapshot.bondYield), {
                ...dividend, market: bond.market, source: `${dividend.source} − ${bond.source}`
            });
        }
        return result;
    }

    return { FIELDS, number, today, asOf, indexKey, isProxy, valuationIndex, bondMarket, valid, primaryField, requiredFields, metadata, fieldIssue, referenceUsable, assess,
        mergeSnapshots, latestSnapshot, manualSnapshot, comparableHistory, valuationContext, monthlyHistory, monthlyPoints, referenceValues, withLatestObservations };
})();
