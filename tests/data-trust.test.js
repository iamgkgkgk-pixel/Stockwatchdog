const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
function load(transport = {}) {
    const values = new Map();
    const FrozenDate = class extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-09-14T12:00:00+08:00'])); }
        static now() { return Date.parse('2026-09-14T12:00:00+08:00'); }
    };
    const window = {};
    const document = { createElement: () => ({}), head: {
        appendChild(node) {
            node.parentNode = this;
            queueMicrotask(() => {
                try {
                    const url = new URL(node.src);
                    if (!transport.jsonp) throw new Error('Unexpected JSONP request');
                    window[url.searchParams.get('cb')](transport.jsonp(url));
                } catch (_) { node.onerror(); }
            });
        },
        removeChild(node) { node.parentNode = null; }
    } };
    const context = vm.createContext({ Date: FrozenDate, Intl, window, document, setTimeout, clearTimeout, AbortController,
        fetch: async (...args) => {
            if (!transport.fetch) throw new Error('Unexpected fetch request');
            return transport.fetch(...args);
        },
        console: { log() {}, info() {}, warn() {}, error() {} },
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
    for (const file of ['etf-config', 'data-quality', 'signal', 'storage', 'api', 'attack-pyramid']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'js', `${file}.js`), 'utf8'), context, { filename: file, timeout: 5000 });
    }
    return vm.runInContext('({DataQuality, SignalEngine, ETF_CONFIG, DataAPI, DataStorage, AttackPyramid})', context);
}
const api = load();
const { DataQuality: Q, SignalEngine: S, ETF_CONFIG: C, DataAPI: A, DataStorage: Store, AttackPyramid: P } = api;
const pharma = C.getETFById('pharma');
const input = { pe: 20, peMean: 30, peStd: 8, pePercentile: 20, marketTemp: 50, roe: 15, pb: 2 };
const history = { peHistory: [45, 42, 40, 38, 36, 35].map((value, i) => ({ date: `2026-${String(i + 4).padStart(2, '0')}`, value })), valuationAnchor: { peMean: 40, peStd: 5 } };

function observation(values, config = pharma, date = '2026-09-14') {
    const data = Q.manualSnapshot(values, config, date);
    for (const meta of Object.values(data.fieldMeta)) meta.quality = 'observed';
    return data;
}

test('missing valuation cannot become a sentiment-only strong buy', () => {
    const result = S.generateMultiDimSignal({ marketTemp: 0 }, pharma);
    assert.equal(result.signal.level, 'DATA_INCOMPLETE');
    assert.equal(result.total, 0);
    for (const mode of ['NORMAL', 'CAUTIOUS', 'DEFENSIVE', 'RETREAT']) assert.equal(P.translateSignalToPosition(result.signal, mode).pct, null);
});

test('invalid numeric input cannot bypass the core-data gate', () => {
    for (const pe of [null, undefined, '', '  ', '20bad', NaN, Infinity, -1, 0, true]) {
        assert.equal(S.generateMultiDimSignal({ ...input, pe }, pharma).signal.level, 'DATA_INCOMPLETE');
    }
});

test('valid core inputs retain existing rule thresholds and scores', () => {
    const result = S.generateMultiDimSignal(input, pharma);
    assert.equal(result.signal.level, C.getSignalRules(pharma.signalRules).generate(input, pharma.dimWeights));
    assert.ok(result.total > 0);
});

test('zero trend is valid for gold, but sentiment alone is not a bond valuation', () => {
    assert.notEqual(S.generateMultiDimSignal({ trendScore: 0 }, C.getETFById('gold')).signal.level, 'DATA_INCOMPLETE');
    assert.equal(S.generateMultiDimSignal({ marketTemp: 0 }, C.getETFById('bond-10y')).signal.level, 'DATA_INCOMPLETE');
});

test('quote refresh neither estimates old PE nor changes its observation date', () => {
    const fallback = Q.manualSnapshot({ pe: 40 }, pharma, '2026-06-01');
    const normalized = A.normalizeData({ etf: { price: 102, priceChange: 2, source: 'quote', asOf: '2026-09-14' } }, fallback, pharma);
    assert.equal(normalized.pe, 40);
    assert.equal(normalized.fieldMeta.pe.asOf, '2026-06-01');
    assert.ok(!normalized.valuationSource.includes('反推'));
    assert.equal(Q.assess(normalized, pharma).allowed, false);
});

test('valuation adapter preserves ROE, zero percentile and field-level fallback', () => {
    const fallback = observation({ pe: 30, pb: 3, roe: 10 }, pharma, '2026-09-11');
    const result = A.normalizeData({ valuation: { pe: 20, roe: 15, pePercentile: 0, pb: null, source: 'fixture', instrumentId: '000978', tradeDate: '2026-09-14' } }, fallback, pharma);
    assert.equal(result.roe, 15);
    assert.equal(result.pePercentile, 0);
    assert.equal(result.pb, 3);
    assert.equal(result.fieldMeta.pb.asOf, '2026-09-11');
    assert.equal(result.fieldMeta.pe.asOf, '2026-09-14');
    assert.equal(Q.assess(result, pharma).allowed, true);
});

test('uncertain dates retain reference scores but known wrong instruments remain blocked', () => {
    for (const edit of [meta => { meta.asOf = null; }, meta => { meta.asOf = '2026-06-01'; }, meta => { meta.quality = 'estimated'; }]) {
        const d = observation({ pe: 20 });
        edit(d.fieldMeta.pe);
        const result = S.analyzeCurrent(d, pharma, history);
        assert.equal(result.quality.allowed, false);
        assert.equal(result.signal.level, 'REFERENCE');
        assert.ok(result.total > 0);
        assert.equal(P.translateSignalToPosition(result.signal, 'NORMAL').pct, null);
    }
    const wrong = observation({ pe: 20 });
    wrong.fieldMeta.pe.instrumentId = '399006';
    assert.equal(S.analyzeCurrent(wrong, pharma, history).signal.level, 'DATA_INCOMPLETE');
});

test('source date parser handles zero/invalid dates without inventing today', () => {
    for (const date of ['', null, '2026-02-30', '2026-09', 'not a date']) assert.equal(Q.asOf(date), null);
    assert.equal(Q.asOf('20260911'), '2026-09-11');
    assert.equal(Q.number(''), null);
    assert.equal(Q.number(0), 0);
});

test('local latest daily observation wins over an old current snapshot', () => {
    const source = { currentData: { pe: 48.25, updateTime: '2026-06-01' }, peHistory: [{ date: '2026-09-14', value: 37.94 }] };
    const before = JSON.stringify(source);
    const result = Q.latestSnapshot(source, pharma);
    assert.equal(result.pe, 37.94);
    assert.equal(result.fieldMeta.pe.asOf, '2026-09-14');
    assert.equal(result.fieldMeta.pe.quality, 'legacy');
    assert.equal(JSON.stringify(source), before);
});

test('saving cache does not mutate dates or the input and manual data is separate', () => {
    const d = Q.manualSnapshot({ pe: 20 }, pharma, '2026-09-11');
    const before = JSON.stringify(d);
    Store.saveCurrentData('pharma', d);
    Store.saveManualData('pharma', { pe: 19 });
    assert.equal(JSON.stringify(d), before);
    assert.equal(Store.getCurrentData('pharma').fieldMeta.pe.asOf, '2026-09-11');
    assert.equal(Store.getManualData('pharma').pe, 19);
    Store.saveCurrentData('pharma', { pe: 22 });
    assert.equal(Store.getManualData('pharma').pe, 19);
});

test('proxy valuation is not compared with target-index history', () => {
    for (const id of ['gem-50', 'sci-tech-50']) {
        const config = C.getETFById(id);
        assert.equal(S.generateMultiDimSignal(input, config).signal.level, 'DATA_INCOMPLETE');
        assert.equal(S.calcHistoricalSignals(history, config).length, 0);
        assert.equal(S.calcDailyHistoricalSignals(history, config).length, 0);
    }
});

test('monthly references give each month one vote', () => {
    const expanded = { ...history, peHistory: [...history.peHistory, ...Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, value: 35 }))] };
    assert.deepEqual(Array.from(S.getReferenceValues(history, 'peHistory')), Array.from(S.getReferenceValues(expanded, 'peHistory')));
    const monthly = S.calcHistoricalSignals(expanded, pharma);
    assert.equal(monthly.length, 6);
    assert.ok(monthly.every(point => point.date.length === 7));
});

test('real-time PE replaces the actual observation-day point, not next month', () => {
    const h = { ...history, peHistory: [...history.peHistory, { date: '2026-09-14', value: 37.94 }] };
    const daily = S.calcDailyHistoricalSignals(h, pharma, 365, null, { pe: 50, asOf: '2026-09-14' });
    assert.equal(daily.at(-1).date, '2026-09-14');
    assert.equal(daily.at(-1).pe, 50);
    assert.ok(daily.length <= h.peHistory.length);
    assert.ok(daily.every(point => point.date <= '2026-09-14'));
});

test('automatic A-share breadth preserves source date through normalization and caching', async () => {
    let requests = 0;
    const date = Date.parse('2026-09-11T15:00:00+08:00') / 1000;
    const env = load({ jsonp: url => {
        requests++;
        assert.ok(url.searchParams.get('fields').split(',').includes('f124'));
        return { data: { f104: '1200', f105: '800', f106: '0', f124: date } };
    } });
    const breadth = await env.DataAPI.fetchAShareMarketBreadth();
    assert.equal(breadth.score, 60);
    assert.equal(breadth.asOf, '2026-09-11');
    const normalized = env.DataAPI.normalizeData({ aShareBreadth: breadth }, {}, pharma);
    assert.equal(normalized.marketTemp, 60);
    assert.equal(env.DataQuality.fieldIssue(normalized, 'marketTemp', pharma), null);
    assert.equal((await env.DataAPI.fetchAShareMarketBreadth()).asOf, '2026-09-11');
    assert.equal(requests, 1);
});

test('invalid breadth counts cannot become an extreme sentiment signal', async () => {
    const env = load({ jsonp: () => ({ data: { f104: '-', f105: 800, f106: 0 } }) });
    assert.equal(await env.DataAPI.fetchAShareMarketBreadth(), null);
});

test('CNN zero is preserved and missing source dates are not replaced by fetch time', async () => {
    for (const fallback of [false, true]) {
        const env = load({ fetch: async url => {
            if (fallback && url.startsWith('https://production.dataviz.cnn.io/')) throw new Error('Direct source unavailable');
            return new Response(JSON.stringify({ fear_and_greed: { score: 0, timestamp: null } }), { status: 200 });
        } });
        const fearGreed = await env.DataAPI.fetchFearGreedIndex();
        assert.equal(fearGreed.score, 0);
        assert.equal(fearGreed.timestamp, null);
        const data = env.DataAPI.normalizeData({ fearGreed }, {}, C.getETFById('sp500-cn'));
        assert.equal(data.marketTemp, 0);
        assert.equal(data.fieldMeta.marketTemp.asOf, null);
        assert.ok(env.DataQuality.fieldIssue(data, 'marketTemp', C.getETFById('sp500-cn')));
    }
    const missing = load({ fetch: async () => ({ ok: true, json: async () => ({ fear_and_greed: {} }) }) });
    assert.equal(await missing.DataAPI.fetchFearGreedIndex(), null);
});

test('quote dates and missing daily returns survive the adapter', async () => {
    const env = load({ jsonp: url => {
        assert.ok(url.searchParams.get('fields').split(',').includes('f124'));
        return { data: { f43: 1.25, f170: '-', f124: Date.parse('2026-09-14T11:00:00+08:00') / 1000 } };
    } });
    const quote = await env.DataAPI.fetchQuoteBySecid('1.512010');
    assert.equal(quote.price, 1.25);
    assert.equal(quote.priceChange, null);
    assert.equal(quote.asOf, '2026-09-14');
    const data = env.DataAPI.normalizeData({ etf: quote }, {}, pharma);
    assert.equal(data.fieldMeta.price.asOf, '2026-09-14');
    assert.equal(data.priceChange, undefined);
});

test('confirmed provider aliases are the same instrument, not proxies', () => {
    assert.equal(Q.indexKey('SP500'), Q.indexKey('SPX'));
    assert.equal(Q.indexKey('HKHSTECH'), Q.indexKey('HSTECH'));
    assert.notEqual(Q.indexKey('SZ399006'), Q.indexKey('399673'));
});

test('single stocks cannot discard unavailable profitability to produce a buy', () => {
    const config = C.getETFById('tencent-hk');
    const result = S.generateMultiDimSignal({ ...input, roe: -5, bondYield: 1.7 }, config);
    assert.equal(result.signal.level, 'REFERENCE');
    assert.equal(result.quality.allowed, false);
    assert.equal(P.translateSignalToPosition(result.signal, 'NORMAL').pct, null);
});

test('zero dividend stays in the safety calculation', () => {
    const config = C.getETFById('dividend-low-vol');
    const result = S.generateMultiDimSignal({ ...input, dividendYield: 0, bondYield: 1.7 }, config);
    assert.ok(Number.isFinite(result.scores.safety));
    assert.ok(result.scores.safety < 10);
});

test('historical missing bond is not converted to a zero-yield observation', () => {
    const config = C.getETFById('dividend-low-vol');
    for (const series of [S.calcHistoricalSignals(history, config), S.calcDailyHistoricalSignals(history, config)]) {
        assert.ok(series.length > 0);
        assert.ok(series.every(point => point.bond == null && point.scores.safety === null));
        assert.ok(series.every(point => point.signal === 'REFERENCE'));
    }
    assert.equal(S.calcValuationBaseline(history, config, { pe: 35 }).available, true);
});

test('dated monthly records retain the real observation day', () => {
    const dated = { ...history, peHistory: history.peHistory.map(point => ({ ...point, asOf: point.date + '-10' })) };
    const result = S.calcDailyHistoricalSignals(dated, pharma, 365);
    assert.ok(result.length > 0);
    assert.ok(result.every(point => point.date.endsWith('-10')));
});

test('Japanese bond data never falls back to a US yield', () => {
    const cfg = C.getETFById('nikkei225');
    const d = observation({ pe: 20, bondYield: 4.31 }, cfg);
    d.fieldMeta.bondYield.market = 'us';
    assert.equal(Q.assess(d, cfg).allowed, false);
    const clean = S.getComparableHistory({ bondYieldHistory: [{ date: '2026-05', value: 4.31 }] }, cfg);
    assert.equal(clean.bondYieldHistory.length, 0);
});

test('legacy monthly timestamps remain monthly and scores remain visible', () => {
    const data = Q.latestSnapshot({ currentData: { pe: 30, updateTime: '2026-05' } }, pharma);
    const result = S.analyzeCurrent(data, pharma, history);
    assert.equal(result.quality.dateLabel, '2026-05');
    assert.equal(result.quality.asOf, null);
    assert.equal(result.signal.level, 'REFERENCE');
    assert.ok(result.quality.calculable);
});

test('independent PE history needs neither ROE, sentiment nor a bond series', () => {
    for (const id of ['dividend-low-vol', 'pharma', 'nikkei225', 'tencent-hk']) {
        const result = S.calcValuationBaseline(history, C.getETFById(id), { pe: 35 });
        assert.equal(result.available, true, id);
        assert.equal(result.sampleCount, 6, id);
        assert.ok(result.current.percentile > 80, id);
    }
});

test('flat reference samples rank at the midpoint rather than 100 percent', () => {
    const h = { peHistory: history.peHistory.map(point => ({ ...point, value: 30 })) };
    const result = S.calcValuationBaseline(h, pharma, { pe: 30 });
    assert.equal(result.available, true);
    assert.equal(result.flat, true);
    assert.equal(result.current.percentile, 50);
    assert.ok(result.notes.some(note => note.includes('区分度')));
});

test('independent baseline keeps month weights stable when daily sampling gets denser', () => {
    const h = { ...history, peHistory: [...history.peHistory, ...Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, value: 35 }))] };
    const a = S.calcValuationBaseline(history, pharma, { pe: 35 });
    const b = S.calcValuationBaseline(h, pharma, { pe: 35 });
    assert.equal(a.sampleCount, b.sampleCount);
    assert.equal(a.current.percentile, b.current.percentile);
});

test('a dated old snapshot is marked on its own date and not added to sample weights', () => {
    const result = S.calcValuationBaseline(history, pharma, { pe: 37, updateTime: '2026-07-15' });
    assert.equal(result.current.date, '2026-07-15');
    assert.ok(result.series.some(point => point.isCurrent && point.date === result.current.date && point.percentile === result.current.percentile));
    assert.equal(result.sampleCount, 6);
});

test('normal observations are not downgraded for unused legacy bond data', () => {
    const data = observation({ pe: 20, roe: 15, marketTemp: 50 });
    data.bondYield = 4.31;
    data.fieldMeta.bondYield = { quality: 'legacy', asOf: '2026-06-01' };
    const result = S.analyzeCurrent(data, pharma, history);
    assert.equal(result.quality.status, 'verified');
    assert.equal(result.quality.allowed, true);
    assert.notEqual(result.signal.level, 'REFERENCE');
});

test('proxy analysis uses only its own post-switch history and no target anchor', () => {
    const config = C.getETFById('gem-50');
    const h = JSON.parse(fs.readFileSync(path.join(root, 'data/gem-50.json'), 'utf8'));
    const data = Q.latestSnapshot(h, config);
    const before = JSON.stringify(h);
    const analysis = S.analyzeCurrent(data, config, h);
    const baseline = S.calcValuationBaseline(h, config, data);
    assert.equal(analysis.signal.level, 'REFERENCE');
    assert.equal(analysis.context.basis.indexId, '399006');
    assert.equal(analysis.context.history.valuationAnchor, null);
    assert.ok(baseline.available);
    assert.equal(baseline.start, '2026-04');
    assert.ok(baseline.notes.some(note => note.includes('短样本')));
    const modified = JSON.parse(before);
    modified.valuationAnchor = { peMean: 999, peStd: 999 };
    modified.peHistory.filter(point => point.date < '2026-04-28').forEach(point => { point.value = 999; });
    assert.equal(S.analyzeCurrent(data, config, modified).total, analysis.total);
    assert.equal(S.calcValuationBaseline(modified, config, data).current.percentile, baseline.current.percentile);
    assert.equal(JSON.stringify(h), before);
});

test('undated ambiguous proxy snapshots are not silently treated as target valuations', () => {
    const config = C.getETFById('gem-50');
    const h = JSON.parse(fs.readFileSync(path.join(root, 'data/gem-50.json'), 'utf8'));
    assert.equal(S.analyzeCurrent({ pe: 40 }, config, h).quality.calculable, false);
    const dated = S.analyzeCurrent({ pe: 40, updateTime: '2026-06-01' }, config, h);
    assert.equal(dated.context.basis.indexId, '399006');
    assert.equal(dated.quality.calculable, true);
    assert.equal(dated.quality.allowed, false);
});

test('machine tool price and panic inputs cannot manufacture missing valuation or positions', () => {
    const config = C.getETFById('machine-tool');
    const h = JSON.parse(fs.readFileSync(path.join(root, 'data/machine-tool.json'), 'utf8'));
    assert.equal(h.valuationAnchor, null);
    assert.equal(h.peHistory.length, 0);
    assert.equal(h.currentData.pe, null);
    const data = A.normalizeData({ etf: { price: 1, priceChange: -8, source: 'fixture', asOf: '2026-09-14' } }, {}, config);
    data.marketTemp = 0;
    const result = S.analyzeCurrent(data, config, h);
    assert.equal(data.price, 1);
    assert.equal(Q.valid('pe', data.pe), false);
    assert.equal(result.signal.level, 'DATA_INCOMPLETE');
    assert.equal(result.quality.allowed, false);
    assert.equal(result.quality.calculable, false);
    assert.equal(S.calcValuationBaseline(h, config, data).available, false);
    for (const mode of ['NORMAL', 'CAUTIOUS', 'DEFENSIVE', 'RETREAT']) {
        assert.equal(P.translateSignalToPosition(result.signal, mode).pct, null);
    }
});

test('actual repository coverage preserves existing analysis and explicitly handles the new valuation gap', () => {
    for (const config of C.ETF_LIST.filter(item => !['gold', 'commodity'].includes(item.type))) {
        const h = config.history === null ? { peHistory: [], currentData: {} }
            : JSON.parse(fs.readFileSync(path.join(root, 'data', `${config.id}.json`), 'utf8'));
        const before = JSON.stringify(h);
        const data = Q.latestSnapshot(h, config);
        const analysis = S.analyzeCurrent(data, config, h);
        const baseline = S.calcValuationBaseline(h, config, data);
        if (config.id === 'machine-tool' || config.priceOnly) {
            assert.equal(analysis.quality.calculable, false, config.id);
            assert.equal(analysis.signal.level, 'DATA_INCOMPLETE', config.id);
            assert.equal(analysis.quality.allowed, false, config.id);
            assert.equal(baseline.available, false, config.id);
            assert.equal(P.translateSignalToPosition(analysis.signal, 'NORMAL').pct, null);
        } else {
            assert.equal(analysis.quality.calculable, true, config.id);
            assert.ok(Number.isFinite(analysis.total), config.id);
            assert.equal(baseline.available, true, config.id);
            assert.ok(baseline.sampleCount >= 5, config.id);
        }
        assert.equal(JSON.stringify(h), before, config.id);
    }
});
