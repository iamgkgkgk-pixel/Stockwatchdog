const GptStrategyData = (() => {
    'use strict';
    const E = typeof module !== 'undefined' && module.exports ? require('./gpt-strategy-engine.js') : GptStrategyEngine;
    const STORAGE_KEY = 'gpt_strategy_lab_v1';
    const EASTMONEY = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
    const VALUATIONS = 'https://danjuanfunds.com/djapi/index_eva/dj';
    const VIX_HISTORY = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv';
    let bundlePromise;
    let priceBundlePromise;
    let sentimentPromise;
    const marketCache = new Map();
    let counter = 0;
    const histories = new Map();
    const priceCache = new Map();
    const priceRequests = new Map();

    function priceMarket(asset) {
        if (asset.id === 'vix-dashboard') return 'us';
        return asset.market === 'HK' || String(asset.secid).startsWith('116.') ? 'hk' : 'cn';
    }

    function parseEastmoney(payload, asset, now = new Date()) {
        const data = payload && payload.data;
        if (payload?.rc !== 0 || !data || String(data.code) !== asset.code || String(data.market) !== asset.secid.split('.')[0]) throw new Error('行情身份不匹配或接口未返回数据');
        const bars = (data.klines || []).map(line => {
            const parts = String(line).split(',');
            return { date: parts[0], open: E.number(parts[1]), close: E.number(parts[2]), high: E.number(parts[3]), low: E.number(parts[4]) };
        }).filter(bar => E.date(bar.date) && [bar.open, bar.close, bar.high, bar.low].every(n => n !== null && n > 0) &&
            bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close));
        const market = priceMarket(asset);
        const completed = E.completedBars(bars, now, market);
        if (!completed.length) throw new Error('没有可用的已完成前复权价格');
        return { bars: completed, adjustment: 'qfq', code: asset.code, secid: asset.secid, market, source: '东方财富 · 日线前复权', asOf: completed.at(-1).date, fetchedAt: now.toISOString(), completedOnly: true };
    }

    function tencentSymbol(asset) {
        const parts = String(asset.secid).split('.');
        const prefix = { '1': 'sh', '0': 'sz', '116': 'hk' }[parts[0]];
        if (!prefix || parts[1] !== asset.code || !/^\d{5,6}$/.test(asset.code)) throw new Error('不支持的行情标识');
        return prefix + asset.code;
    }

    function tencentPriceURL(asset) {
        const endpoint = priceMarket(asset) === 'hk' ? 'hkfqkline' : 'fqkline';
        return `https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/get?param=${tencentSymbol(asset)},day,,,640,qfq`;
    }

    function parseTencentPrice(payload, asset, now = new Date()) {
        const symbol = tencentSymbol(asset);
        const data = payload?.data?.[symbol];
        if (payload?.code !== 0 || !data || data.qt?.[symbol]?.[2] && data.qt[symbol][2] !== asset.code) throw new Error('备用行情身份不符');
        const adjusted = Array.isArray(data.qfqday) && data.qfqday.length > 0;
        const rows = adjusted ? data.qfqday : data.day;
        if (!Array.isArray(rows)) throw new Error('备用行情没有价格序列');
        const bars = E.completedBars(rows.filter(Array.isArray).map(row => ({ date: row[0], open: E.number(row[1]), close: E.number(row[2]),
            high: E.number(row[3]), low: E.number(row[4]) })).filter(bar => [bar.open, bar.close, bar.high, bar.low].every(value => value !== null && value > 0) &&
                bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close)), now, priceMarket(asset));
        if (!bars.length) throw new Error('备用行情没有完整收盘记录');
        return { bars, code: asset.code, secid: asset.secid, market: priceMarket(asset), adjustment: adjusted ? 'qfq' : 'raw',
            requestedAdjustment: 'qfq', source: adjusted ? '腾讯行情 · 日线前复权' : '腾讯行情 · 原始日线（复权未确认）',
            asOf: bars.at(-1).date, fetchedAt: now.toISOString(), completedOnly: true };
    }

    async function fetchPrice(asset) {
        try { return parseEastmoney(await jsonp(priceURL(asset)), asset); }
        catch (_) { return parseTencentPrice(await json(tencentPriceURL(asset)), asset); }
    }

    function priceURL(asset, now = new Date()) {
        const start = new Date(now);
        start.setUTCFullYear(start.getUTCFullYear() - 5);
        const params = new URLSearchParams({ secid: asset.secid, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56',
            klt: '101', fqt: '1', beg: start.toISOString().slice(0, 10).replaceAll('-', ''), end: E.clock(now, priceMarket(asset)).today.replaceAll('-', ''), lmt: '2400' });
        return EASTMONEY + '?' + params;
    }

    function benchmarkURL(now = new Date()) {
        const start = new Date(now);
        start.setUTCFullYear(start.getUTCFullYear() - 5);
        return EASTMONEY + '?' + new URLSearchParams({ secid: E.MARKETS.cn.instrumentId, fields1: 'f1,f2,f3,f4,f5,f6',
            fields2: 'f51,f52,f53,f54,f55,f56', klt: '101', fqt: '0', beg: start.toISOString().slice(0, 10).replaceAll('-', ''),
            end: E.clock(now).today.replaceAll('-', ''), lmt: '2400' });
    }

    function parseBenchmark(payload, now = new Date()) {
        const data = payload?.data;
        if (payload?.rc !== 0 || String(data?.code) !== E.MARKETS.cn.code || String(data?.market) !== '1') throw new Error('A股压力基准身份不符');
        const bars = E.completedBars((data.klines || []).map(line => {
            const fields = String(line).split(',');
            return { date: fields[0], close: E.number(fields[2]) };
        }), now, 'cn');
        if (!bars.length) throw new Error('没有完整的沪深300历史');
        return { ...E.MARKETS.cn, bars, adjustment: 'none', asOf: bars.at(-1).date, fetchedAt: now.toISOString(), completedOnly: true,
            source: '东方财富 · 沪深300日收盘 · 回撤/波动压力代理' };
    }

    function parseVixHistory(content, now = new Date()) {
        const lines = String(content).trim().split(/\r?\n/);
        if (lines.shift()?.replace(/^\uFEFF/, '').trim() !== 'DATE,OPEN,HIGH,LOW,CLOSE') throw new Error('VIX历史格式不符');
        const start = new Date(now);
        start.setUTCFullYear(start.getUTCFullYear() - 5);
        const firstDate = start.toISOString().slice(0, 10);
        const rows = [];
        for (const line of lines) {
            const fields = line.split(',');
            const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fields[0]);
            const close = E.number(fields[4]);
            if (!match || fields.length !== 5 || close === null || close <= 0 || close > 300) continue;
            const date = `${match[3]}-${match[1]}-${match[2]}`;
            if (date >= firstDate) rows.push({ date, close });
        }
        const bars = E.completedBars(rows, now, 'us');
        if (!bars.length) throw new Error('没有完整VIX收盘记录');
        return { ...E.MARKETS.us, bars, adjustment: 'none', asOf: bars.at(-1).date, fetchedAt: now.toISOString(), completedOnly: true,
            source: 'Cboe · VIX官方日收盘历史（美股整体）' };
    }

    function parseValuations(payload, now = new Date()) {
        const observations = {};
        const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
        for (const asset of E.ASSETS) {
            const expected = asset.trackIndex.isProxy ? asset.trackIndex.code : asset.trackIndex.danjuanCode || asset.trackIndex.code;
            const matches = items.filter(item => item.index_code === expected);
            if (matches.length !== 1) continue;
            const item = matches[0];
            const timestamp = E.number(item.ts);
            const pe = E.number(item.pe);
            if (timestamp === null || timestamp < 946684800000 || timestamp > now.getTime() || pe === null || pe <= 0) continue;
            const asOf = E.clock(new Date(timestamp)).today;
            const rank = E.number(item.pe_percentile);
            observations[asset.id] = { pe, asOf, indexId: asset.trackIndex.code, quality: 'observed', source: '蛋卷基金 · ' + asset.trackIndex.name,
                providerPercentile: rank !== null && rank >= 0 && rank <= 1 ? rank * 100 : null };
        }
        return observations;
    }

    async function json(url, timeout = 7000, format = 'json') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return format === 'text' ? await response.text() : await response.json();
        } finally { clearTimeout(timer); }
    }

    function jsonp(url, timeout = 9000) {
        return new Promise((resolve, reject) => {
            const name = '__gptStrategy_' + Date.now() + '_' + counter++;
            const script = document.createElement('script');
            let done = false;
            const finish = (error, payload) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                script.remove();
                delete window[name];
                if (error) reject(error); else resolve(payload);
            };
            const timer = setTimeout(() => finish(new Error('行情请求超时')), timeout);
            window[name] = payload => finish(null, payload);
            script.onerror = () => finish(new Error('行情接口不可达'));
            script.src = url + '&cb=' + name;
            document.head.appendChild(script);
        });
    }

    function loadBundle(refresh = false) {
        if (refresh || !bundlePromise) bundlePromise = json('data/gpt-strategy-market.json').catch(() => ({ assets: {}, valuations: {} }));
        return bundlePromise;
    }

    function loadHistory(asset, refresh = false) {
        if (refresh || !histories.has(asset.id)) histories.set(asset.id, asset.history ? json('data/' + asset.history + '.json').catch(() => null) : Promise.resolve(null));
        return histories.get(asset.id);
    }

    function loadPriceBundle() {
        if (!priceBundlePromise) priceBundlePromise = json('data/price-roc-history.json').catch(() => ({ assets: {} }));
        return priceBundlePromise;
    }

    async function loadSentiment(asset, refresh = false, previous = null) {
        const market = E.marketFor(asset);
        if (refresh || !sentimentPromise) sentimentPromise = json('data/gpt-strategy-sentiment.json').catch(() => ({ snapshots: {} }));
        const bundle = await sentimentPromise;
        const candidates = [bundle.snapshots?.[market], marketCache.get(market), previous].filter(value => E.marketBars(value, asset));
        let snapshot = candidates.sort((a, b) => b.asOf.localeCompare(a.asOf) || b.fetchedAt.localeCompare(a.fetchedAt))[0] || null;
        let error = null;
        if (refresh || !snapshot) {
            try {
                const latest = market === 'cn' ? parseBenchmark(await jsonp(benchmarkURL())) : parseVixHistory(await json(VIX_HISTORY, 7000, 'text'));
                if (!snapshot || latest.asOf >= snapshot.asOf) snapshot = latest;
                else error = '恐慌参考接口返回旧观测，保留较新的原日期。';
            } catch (_) { error = '恐慌参考未更新，保留原日期；超过7天不参与判断。'; }
        }
        if (snapshot) marketCache.set(market, snapshot);
        return { snapshot, error };
    }

    function cachedPrice(value, asset, fetchedAt, allowRaw = false) {
        if (!value || !(value.adjustment === 'qfq' || allowRaw && value.adjustment === 'raw') || value.code !== asset.code || !Array.isArray(value.bars)) return null;
        const capturedAt = new Date(value.fetchedAt || fetchedAt);
        if (!Number.isFinite(capturedAt.getTime()) || capturedAt > new Date() || value.secid && value.secid !== asset.secid || value.market && value.market !== priceMarket(asset)) return null;
        const bars = E.completedBars(value.bars, capturedAt, priceMarket(asset));
        return bars.length ? { ...value, bars, asOf: bars.at(-1).date, completedOnly: true, fetchedAt: capturedAt.toISOString() } : null;
    }

    function loadPrice(asset, refresh = false, previous = null) {
        const isVix = asset.id === 'vix-dashboard';
        const key = `${asset.secid}|${isVix ? 'none' : 'prefer-qfq'}|history`;
        if (priceRequests.has(key)) return priceRequests.get(key);
        const request = (async () => {
            if (isVix) {
                const result = await loadSentiment(E.ASSETS.find(item => item.id === 'nasdaq100-cn'), refresh);
                const snapshot = result.snapshot;
                const bars = E.marketBars(snapshot, E.ASSETS.find(item => item.id === 'nasdaq100-cn'));
                return { price: bars ? { ...snapshot, bars, code: 'VIX', secid: '100.VIX' } : null,
                    mode: '官方指数收盘', error: result.error };
            }
            const memo = priceCache.get(key);
            const previousPrice = cachedPrice(previous?.price, asset, previous?.price?.fetchedAt, true);
            if (memo && !refresh && E.age(memo.price.asOf, E.clock(new Date(), priceMarket(asset)).today) <= 7) return memo;
            const [bundle, extended] = await Promise.all([loadBundle(), loadPriceBundle()]);
            const packed = cachedPrice(bundle.assets?.[asset.id], asset, bundle.fetchedAt);
            const extendedPrice = cachedPrice(extended.assets?.[asset.id], asset, extended.fetchedAt, true);
            const today = E.clock(new Date(), priceMarket(asset)).today;
            const recentAdjusted = value => value.adjustment === 'qfq' && E.age(value.asOf, today) <= 7;
            const newest = (a, b) => Number(recentAdjusted(b)) - Number(recentAdjusted(a)) || b.asOf.localeCompare(a.asOf) ||
                Number(b.adjustment === 'qfq') - Number(a.adjustment === 'qfq') || b.bars.length - a.bars.length ||
                Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt);
            const candidates = [memo?.price, previousPrice, packed, extendedPrice].filter(Boolean).sort(newest);
            let price = candidates[0] || null;
            let mode = price === packed || price === extendedPrice ? '只读价格快照' : '已缓存价格';
            let error = null;
            if (refresh || !price || E.age(price.asOf, E.clock(new Date(), priceMarket(asset)).today) > 7) {
                try {
                    const latest = await fetchPrice(asset);
                    const selected = [price, latest].filter(Boolean).sort(newest)[0];
                    if (selected === latest) { price = latest; mode = '本次行情获取'; }
                    else error = '接口未提供更新或更完整的同口径行情，保留已有观测。';
                } catch (_) { error = price ? '价格更新失败，保留原观测日期。' : '暂未取得该标的真实价格，请重试。'; }
            }
            const result = { price, mode, error };
            if (price) priceCache.set(key, result);
            return result;
        })();
        priceRequests.set(key, request);
        const cleanup = () => { if (priceRequests.get(key) === request) priceRequests.delete(key); };
        request.then(cleanup, cleanup);
        return request;
    }

    function valuationInputs(asset, history, liveObservation) {
        let points = [], observation = null;
        if (history && typeof DataQuality !== 'undefined') {
            const basis = { indexId: DataQuality.valuationIndex(asset), label: asset.trackIndex.name, isProxy: false };
            const comparable = DataQuality.comparableHistory(history, asset, basis);
            points = comparable.peHistory || [];
            const safe = { ...comparable, currentData: asset.trackIndex.isProxy ? {} : comparable.currentData };
            delete safe.proxyValuation;
            const snapshot = DataQuality.latestSnapshot(safe, asset);
            const meta = DataQuality.metadata(snapshot, 'pe');
            const identityMatches = !meta.instrumentId || DataQuality.indexKey(meta.instrumentId) === basis.indexId;
            if (E.number(snapshot.pe) > 0 && (meta.asOf || meta.dateLabel) && identityMatches && !['proxy', 'estimated'].includes(meta.quality)) {
                observation = { pe: snapshot.pe, asOf: meta.asOf || meta.dateLabel, identityInferred: !meta.instrumentId,
                    source: meta.source, quality: meta.quality, indexId: asset.trackIndex.code, providerPercentile: null };
            }
            if (!observation) {
                const monthly = points.filter(point => /^\d{4}-\d{2}$/.test(point.date || '') && !['proxy', 'estimated'].includes(point.quality))
                    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
                if (monthly) observation = { pe: monthly.value, asOf: monthly.date, source: monthly.source || '同指数旧月度记录（来源待核验）',
                    quality: monthly.quality || 'legacy', identityInferred: !monthly.instrumentId, indexId: asset.trackIndex.code, providerPercentile: null };
            }
        }
        if (liveObservation && liveObservation.indexId === asset.trackIndex.code && E.date(liveObservation.asOf) && !liveObservation.identityInferred &&
            E.age(liveObservation.asOf, E.clock().today) >= 0 && E.number(liveObservation.pe) > 0 && !['proxy', 'estimated'].includes(liveObservation.quality) &&
            (!observation || observation.identityInferred || liveObservation.asOf >= observation.asOf)) observation = liveObservation;
        return { points, observation };
    }

    async function load(asset, refresh = false, previous = null) {
        const [bundle, history, sentiment] = await Promise.all([loadBundle(refresh), loadHistory(asset, refresh), loadSentiment(asset, refresh, previous?.sentiment)]);
        const bundled = cachedPrice(bundle.assets?.[asset.id], asset, bundle.fetchedAt);
        const prior = cachedPrice(previous?.price, asset, previous?.bundledAt);
        const keepPrior = prior && (!bundled || prior.asOf >= bundled.asOf);
        let price = keepPrior ? prior : bundled;
        let observation = bundle.valuations?.[asset.id] || null;
        if (previous?.observation && (!observation || previous.observation.asOf >= observation.asOf)) observation = previous.observation;
        let mode = keepPrior ? previous.mode : price ? '随页只读快照' : '暂无数据';
        const errors = [];
        if (refresh || !price) {
            const [priceResult, valuationResult] = await Promise.allSettled([
                jsonp(priceURL(asset)).then(payload => parseEastmoney(payload, asset)),
                json(VALUATIONS).then(payload => parseValuations(payload)),
            ]);
            if (priceResult.status === 'fulfilled' && (!price || priceResult.value.asOf >= price.asOf)) {
                price = priceResult.value; mode = '本次接口获取';
            } else errors.push('价格未取得更新观测，保留最近数据和原日期。');
            const nextObservation = valuationResult.status === 'fulfilled' && valuationResult.value[asset.id];
            if (nextObservation && (!observation || nextObservation.asOf >= observation.asOf)) observation = nextObservation;
            else errors.push('没有取得新的同指数估值；不会用代理或抓取时间替代。');
        }
        const valuation = valuationInputs(asset, history, observation);
        if (!history && previous) {
            valuation.points = previous.points || [];
            if (!valuation.observation) valuation.observation = previous.observation || null;
        }
        if (sentiment.error) errors.push(sentiment.error);
        return { price, ...valuation, sentiment: sentiment.snapshot, mode, errors, bundledAt: bundle.fetchedAt || null };
    }

    function loadPreferences() {
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        } catch (_) { return {}; }
    }

    function savePreferences(value) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); return true; }
        catch (_) { return false; }
    }

    return { STORAGE_KEY, VALUATIONS, VIX_HISTORY, parseEastmoney, parseValuations, parseBenchmark, parseVixHistory,
        priceURL, priceMarket, tencentPriceURL, parseTencentPrice, loadPrice, benchmarkURL, valuationInputs, loadSentiment, load, loadPreferences, savePreferences };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GptStrategyData;
