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
        const liveBar = E.clock(now, market).closed ? null : bars.find(bar => bar.date === E.clock(now, market).today) || null;
        return { bars: completed, liveBar, adjustment: 'qfq', code: asset.code, secid: asset.secid, market, source: '东方财富 · 日线前复权', asOf: completed.at(-1).date, fetchedAt: now.toISOString(), completedOnly: true };
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
        const market = priceMarket(asset), clock = E.clock(now, market);
        const valid = rows.filter(Array.isArray).map(row => ({ date: row[0], open: E.number(row[1]), close: E.number(row[2]),
            high: E.number(row[3]), low: E.number(row[4]) })).filter(bar => E.date(bar.date) && [bar.open, bar.close, bar.high, bar.low].every(value => value !== null && value > 0) &&
                bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close));
        const bars = E.completedBars(valid, now, market);
        if (!bars.length) throw new Error('备用行情没有完整收盘记录');
        const qt = data.qt?.[symbol], stamp = String(qt?.[30] || '');
        const quoteDate = /^\d{14}$/.test(stamp) ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : null;
        const quoteTime = quoteDate ? `${quoteDate}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}+08:00` : null;
        const quote = qt?.[2] === asset.code && E.date(quoteDate) && Number.isFinite(Date.parse(quoteTime)) && Date.parse(quoteTime) <= now.getTime()
            && quoteDate === clock.today && E.number(qt[3]) > 0
            ? { close: E.number(qt[3]), date: quoteDate, observedAt: quoteTime, source: '腾讯最新报价', code: asset.code, secid: asset.secid } : null;
        let liveBar = !clock.closed ? valid.find(bar => bar.date === clock.today) || null : null;
        if (!adjusted && quote && (!clock.closed || bars.at(-1).date < clock.today)) {
            const last = bars.at(-1), gap = E.age(last.date, quote.date);
            const compatible = last.date === quote.date || gap > 0 && gap <= 4 && E.number(qt[4]) === last.close;
            if (compatible) {
                const close = quote.close;
                liveBar = { date: quote.date, open: E.number(qt[5]) || close, close,
                    high: Math.max(close, E.number(qt[33]) || close, E.number(qt[5]) || close),
                    low: Math.min(close, E.number(qt[34]) || close, E.number(qt[5]) || close), provisional: true, observedAt: quote.observedAt };
            }
        }
        return { bars, liveBar, quote, code: asset.code, secid: asset.secid, market, adjustment: adjusted ? 'qfq' : 'raw',
            requestedAdjustment: 'qfq', source: adjusted ? '腾讯行情 · 日线前复权' : '腾讯行情 · 原始日线（复权未确认）',
            asOf: bars.at(-1).date, fetchedAt: now.toISOString(), completedOnly: true };
    }

    async function fetchPrice(asset) {
        let primary = null;
        try { primary = parseEastmoney(await jsonp(priceURL(asset)), asset); } catch (_) {}
        const today = E.clock(new Date(), priceMarket(asset)).today;
        if (primary && (primary.liveBar?.date === today || primary.asOf === today)) return primary;
        let backup = null;
        try { backup = parseTencentPrice(await json(tencentPriceURL(asset) + '&_=' + Date.now()), asset); } catch (_) {}
        const price = newestPrice(primary, backup);
        if (!price) throw new Error('价格接口均不可用');
        return withLatestDisplay(price, primary, backup);
    }

    function withLatestDisplay(price, ...sources) {
        if (!price) return null;
        const previews = [price, ...sources].flatMap(item => item ? [item, item.preview].filter(Boolean) : [])
            .filter(item => item.code === price.code && item.secid === price.secid && item.liveBar?.date > price.asOf);
        previews.sort((a, b) => b.liveBar.date.localeCompare(a.liveBar.date) || Number(b.adjustment === 'qfq') - Number(a.adjustment === 'qfq')
            || Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));
        const chosen = previews[0];
        const preview = chosen && chosen !== price ? { bars: chosen.bars, liveBar: chosen.liveBar, code: chosen.code, secid: chosen.secid,
            market: chosen.market, adjustment: chosen.adjustment, source: chosen.source, fetchedAt: chosen.fetchedAt } : null;
        const quotes = [price, ...sources].map(item => item?.quote).filter(item => item?.code === price.code && item.secid === price.secid);
        quotes.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
        return { ...price, preview, quote: quotes[0] || null };
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

    async function fetchValuations() {
        const urls = [VALUATIONS,
            'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(VALUATIONS),
            'https://api.allorigins.win/raw?url=' + encodeURIComponent(VALUATIONS)];
        for (const url of urls) {
            try {
                const response = await json(url, url === VALUATIONS ? 7000 : 12000);
                const payload = typeof response?.body === 'string' ? JSON.parse(response.body) : response;
                if (Array.isArray(payload?.data?.items)) return parseValuations(payload);
            } catch (_) {}
        }
        throw new Error('估值接口及备用通道均不可用');
    }

    function loadBundle(refresh = false) {
        if (refresh || !bundlePromise) bundlePromise = json('data/gpt-strategy-market.json').catch(() => ({ assets: {}, valuations: {} }));
        return bundlePromise;
    }

    function loadHistory(asset, refresh = false) {
        if (refresh || !histories.has(asset.id)) histories.set(asset.id, asset.history ? json('data/' + asset.history + '.json').catch(() => null) : Promise.resolve(null));
        return histories.get(asset.id);
    }

    function loadPriceBundle(refresh = false) {
        if (refresh || !priceBundlePromise) priceBundlePromise = json('data/price-roc-history.json').catch(() => ({ assets: {} }));
        return priceBundlePromise;
    }

    async function loadSentiment(asset, refresh = true, previous = null) {
        const market = E.marketFor(asset);
        const live = Promise.allSettled([market === 'cn'
            ? jsonp(benchmarkURL()).then(payload => parseBenchmark(payload))
            : json(VIX_HISTORY, 7000, 'text').then(content => parseVixHistory(content))]);
        if (refresh || !sentimentPromise) sentimentPromise = json('data/gpt-strategy-sentiment.json').catch(() => ({ snapshots: {} }));
        const [bundle, [response]] = await Promise.all([sentimentPromise, live]);
        const candidates = [bundle.snapshots?.[market], marketCache.get(market), previous].filter(value => E.marketBars(value, asset));
        let snapshot = candidates.sort((a, b) => b.asOf.localeCompare(a.asOf) || b.fetchedAt.localeCompare(a.fetchedAt))[0] || null;
        let error = null;
        if (response.status === 'fulfilled' && E.marketBars(response.value, asset)) {
            if (!snapshot || response.value.asOf >= snapshot.asOf) snapshot = response.value;
            else error = '恐慌参考接口返回旧观测，保留较新的原日期。';
        } else error = '恐慌参考更新失败，保留原日期；超过7天不参与判断。';
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

    function newestPrice(...prices) {
        return prices.filter(Boolean).sort((a, b) => b.asOf.localeCompare(a.asOf) ||
            Number(b.adjustment === 'qfq') - Number(a.adjustment === 'qfq') ||
            Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) || b.bars.length - a.bars.length)[0] || null;
    }

    function loadPrice(asset, refresh = true, previous = null, scope = null) {
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
            const live = Promise.allSettled([fetchPrice(asset)]);
            const sharedKey = 'price-history-bundles';
            if (scope && !scope.has(sharedKey)) scope.set(sharedKey, Promise.all([loadBundle(refresh), loadPriceBundle(refresh)]));
            const bundles = scope ? scope.get(sharedKey) : Promise.all([loadBundle(refresh), loadPriceBundle(refresh)]);
            const [[bundle, extended], [response]] = await Promise.all([bundles, live]);
            const packed = cachedPrice(bundle.assets?.[asset.id], asset, bundle.fetchedAt, true);
            const extendedPrice = cachedPrice(extended.assets?.[asset.id], asset, extended.fetchedAt, true);
            let price = newestPrice(memo?.price, previousPrice, packed, extendedPrice);
            let mode = price === packed || price === extendedPrice ? '只读价格快照' : '已缓存价格';
            let error = null;
            if (response.status === 'fulfilled') {
                const latest = response.value;
                if (newestPrice(latest, price) === latest) {
                    price = latest;
                    mode = '本次行情获取';
                } else error = '接口未提供日期更新或同日更优口径的数据，保留已有完整序列。';
            } else error = price ? '价格更新失败，保留原观测日期。' : '暂未取得该标的真实价格，请重试。';
            price = withLatestDisplay(price, response.status === 'fulfilled' ? response.value : null);
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

    async function load(asset, refresh = true, previous = null, onProgress) {
        const state = { price: null, points: [], observation: null, sentiment: null, mode: '更新中', errors: [], bundledAt: null };
        const pending = new Set(['price', 'valuation', 'history', 'sentiment']);
        let history = null, bundle = {}, observation = null;
        const snapshot = () => ({ ...state, errors: [...state.errors], pending: [...pending] });
        const publish = () => {
            if (typeof onProgress === 'function') {
                try { onProgress(snapshot()); } catch (_) {}
            }
        };
        const updateValuation = () => {
            const result = valuationInputs(asset, history, observation);
            state.points = result.points.length ? result.points : previous?.points || [];
            state.observation = pending.has('valuation') ? null : result.observation;
        };
        publish();
        const bundled = loadBundle(refresh).then(value => { bundle = value; state.bundledAt = value.fetchedAt || null; return value; });
        const historyTask = loadHistory(asset, refresh).then(value => {
            history = value;
            pending.delete('history');
            updateValuation();
            publish();
        });
        const priceTask = (async () => {
            const scope = new Map([['price-history-bundles', Promise.all([bundled, loadPriceBundle(refresh)])]]);
            const result = await loadPrice(asset, refresh, previous, scope);
            state.price = result.price;
            state.mode = result.mode === '本次行情获取' ? '本次接口获取' : result.mode;
            if (result.error) state.errors.push(result.error);
            pending.delete('price');
            publish();
        })();
        const valuationTask = (async () => {
            let latest = null;
            try { latest = (await fetchValuations())[asset.id] || null; } catch (_) {}
            const prior = previous?.observation;
            if (latest && (!prior || prior.identityInferred || prior.indexId !== asset.trackIndex.code || latest.asOf >= prior.asOf)) observation = latest;
            else {
                await bundled;
                observation = bundle.valuations?.[asset.id] || null;
                if (previous?.observation && (!observation || previous.observation.asOf >= observation.asOf)) observation = previous.observation;
                state.errors.push('没有取得新的同指数估值；不会用代理或抓取时间替代。');
            }
            pending.delete('valuation');
            updateValuation();
            publish();
        })();
        const sentimentTask = loadSentiment(asset, refresh, previous?.sentiment).then(result => {
            state.sentiment = result.snapshot;
            if (result.error) state.errors.push(result.error);
            pending.delete('sentiment');
            publish();
        });
        await Promise.all([historyTask, priceTask, valuationTask, sentimentTask]);
        return snapshot();
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
