const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const NOW = new Date('2026-09-21T02:00:00Z');
class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW.getTime(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function environment(transport = {}) {
    const values = new Map(), window = {};
    const context = vm.createContext({ Date: FixedDate, Intl, URLSearchParams, AbortController, setTimeout, clearTimeout,
        console: { log() {}, info() {}, warn() {}, error() {} }, window,
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
        fetch: transport.fetch || (async () => { throw new Error('offline'); }),
        document: { createElement: () => ({}), head: { appendChild(script) {
            script.parentNode = this;
            queueMicrotask(() => {
                if (!transport.jsonp) return script.onerror();
                const url = new URL(script.src);
                window[url.searchParams.get('cb')](transport.jsonp(url));
            });
        }, removeChild() {} } }
    });
    for (const file of ['etf-config', 'data-quality', 'signal', 'storage', 'api', 'gpt-strategy-engine', 'gpt-strategy-data', 'bottom-screener', 'overview-model', 'overview-data'])
        vm.runInContext(read(`js/${file}.js`), context, { filename: file });
    return vm.runInContext('({M:OverviewModel,D:OverviewData,Q:DataQuality,S:SignalEngine,E:GptStrategyEngine,A:DataAPI,C:ETF_CONFIG,Store:DataStorage})', context);
}
const evidence = (roc, signal, pe) => Object.fromEntries(Object.entries({ roc, signal, pe }).map(([key, vote]) => [key, { vote }]));

test('every signal and PE combination respects the ROC buy and sell vetoes', () => {
    const { M } = environment();
    for (const roc of [-1, 0, 1, null]) for (const signal of [-1, 0, 1, null]) for (const pe of [-1, 0, 1, null]) {
        const result = M.classify(evidence(roc, signal, pe));
        if (roc === 1) { assert.notEqual(result.tier, 'low'); assert.equal(result.buyBlocked, true); }
        if (roc === -1) { assert.notEqual(result.tier, 'risk'); assert.equal(result.sellBlocked, true); }
        if (roc === null) assert.equal(result.tier, 'pending');
        else assert.notEqual(result.tier, 'pending');
        if (pe === null) assert.equal(result.peIgnored, true);
    }
});

test('ROC veto beats green or red lights and ROC alone does not manufacture cheapness', () => {
    const { M } = environment();
    assert.equal(M.classify(evidence(-1, 0, 1)).tier, 'normal');
    assert.equal(M.classify(evidence(-1, null, null)).tier, 'normal');
    assert.match(M.classify(evidence(-1, null, null)).reason, /仅有ROC/);
    assert.equal(M.classify(evidence(-1, 1, -1)).tier, 'normal');
    assert.equal(M.classify(evidence(1, -1, -1)).tier, 'normal');
    assert.equal(M.classify(evidence(-1, -1, 0)).tier, 'low');
    assert.equal(M.classify(evidence(0, -1, null)).tier, 'low');
    assert.equal(M.classify(evidence(0, 1, null)).tier, 'risk');
    assert.equal(M.classify(evidence(0, 0, null)).tier, 'normal');
});

function fixture(env, id = 'csi300') {
    const asset = env.C.getETFById(id);
    const current = env.Q.manualSnapshot({ pe: 12, pb: 1.2, roe: 12, dividendYield: 3, bondYield: 1.8, marketTemp: 45 }, asset, '2026-09-18');
    for (const meta of Object.values(current.fieldMeta)) meta.quality = 'observed';
    const peHistory = [20, 18, 22, 16, 19, 17].map((value, i) => ({ date: `2026-0${i + 1}`, value, quality: 'observed', instrumentId: asset.trackIndex.code }));
    return { asset, phase: 'done', parts: { api: 'ready', price: 'ready', history: 'ready' }, api: { pending: [], success: true }, issues: {},
        previousCurrent: current, history: { peHistory }, priceResult: { price: { code: asset.code, secid: asset.secid, adjustment: 'qfq',
            bars: [{ date: '2026-09-18', close: 4 }], asOf: '2026-09-18' }, mode: 'fixture' } };
}
function mockRoc(env, value = -5, lower = -4, upper = 4, rank = 10) {
    env.E.rocModel = () => ({ fresh: true, last: { date: '2026-09-18', smooth: value, rank }, lowerBand: [lower], upperBand: [upper], minimum: 126 });
}

test('ROC gates use the real percentile, including 20 and 80 boundaries without rounding', () => {
    const env = environment(), record = fixture(env);
    for (const [rank, expected] of [[0, -1], [19.99, -1], [20, -1], [20.001, 0], [50, 0], [79.999, 0], [80, 1], [100, 1]]) {
        mockRoc(env, 0, -4, 4, rank);
        const model = env.M.build(record, env.E.DEFAULTS, NOW);
        assert.equal(model.evidence.roc.vote, expected);
        if (expected === 1) assert.equal(model.buyBlocked, true);
        if (expected === -1) assert.equal(model.sellBlocked, true);
    }
    for (const rank of [null, undefined, -1, 101, NaN]) {
        mockRoc(env, 0, -4, 4, rank === undefined ? null : rank);
        assert.equal(env.M.build(record).evidence.roc.vote, null);
    }
    mockRoc(env, null);
    assert.equal(env.M.build(record).evidence.roc.vote, null);
    mockRoc(env, 3, null, null);
    assert.equal(env.M.build(record).evidence.roc.vote, null);
});

test('PE mean uses the exact same comparable points as the detail line, without mutating history', () => {
    const env = environment(), record = fixture(env);
    const before = JSON.stringify(record.history);
    const result = env.M.build(record, {}, NOW);
    const current = env.M.normalized(record);
    const context = env.Q.valuationContext(record.history, record.asset, current);
    const points = env.Q.withLatestObservations(context.history, current, record.asset).peHistory;
    const expected = Number((points.reduce((sum, point) => sum + point.value, 0) / points.length).toFixed(2));
    assert.equal(result.evidence.pe.mean, expected);
    assert.equal(result.evidence.pe.vote, -1);
    assert.equal(JSON.stringify(record.history), before);
});

test('in-flight estimates cannot expose cached current PE as a completed observation', () => {
    const env = environment(), record = fixture(env);
    record.phase = 'loading'; record.parts.api = 'loading'; record.api.pending = ['valuation'];
    const model = env.M.build(record, {}, NOW);
    assert.equal(model.current.pe, undefined);
    assert.equal(model.evidence.pe.vote, null);
    assert.equal(model.evidence.signal.vote, null);
    assert.equal(model.status, 'loading');
});

test('stale PE, wrong instrument, proxy PE and too-short histories do not cast a PE vote', () => {
    for (const patch of [meta => { meta.asOf = '2026-08-01'; }, meta => { meta.instrumentId = 'OTHER'; }, meta => { meta.quality = 'proxy'; }]) {
        const env = environment(), record = fixture(env);
        patch(record.previousCurrent.fieldMeta.pe);
        assert.equal(env.M.build(record, {}, NOW).evidence.pe.vote, null);
    }
    const env = environment(), record = fixture(env);
    record.history.peHistory = record.history.peHistory.slice(0, 2);
    assert.equal(env.M.build(record, {}, NOW).evidence.pe.vote, null);
});

test('raw ROC can contribute only an explicitly labeled reference and stale prices cannot vote', () => {
    const env = environment(), record = fixture(env);
    mockRoc(env);
    record.priceResult.price.adjustment = 'raw';
    const result = env.M.build(record, {}, NOW);
    assert.equal(result.evidence.roc.vote, -1);
    assert.equal(result.evidence.roc.reference, true);
    assert.match(result.evidence.roc.detail, /未复权/);
    env.E.rocModel = () => ({ fresh: false, last: { date: '2026-08-01' }, lowerBand: [-1], upperBand: [1] });
    assert.equal(env.M.build(record, {}, NOW).evidence.roc.vote, null);
});

test('reference-level mapping retains original signal colors with a reference label', () => {
    const env = environment(), record = fixture(env);
    const original = env.S.analyzeCurrent;
    for (const [level, expected] of [['HOLD_ADD', -1], ['HOLD', 0], ['REDUCE_WARN', 1], ['SELL', 1]]) {
        env.S.analyzeCurrent = (...args) => {
            const result = original(...args);
            return { ...result, signal: { level: 'REFERENCE', referenceLevel: level, text: '参考' }, quality: { ...result.quality, calculable: true, allowed: false } };
        };
        const model = env.M.build(record, {}, NOW);
        assert.equal(model.evidence.signal.vote, expected);
        assert.equal(model.evidence.signal.reference, true);
    }
});

test('the asset union contains all original assets, standalone STAR50 and VIX once', () => {
    const { M, C, E } = environment();
    const assets = M.allAssets(C, E.ASSETS);
    assert.equal(new Set(assets.map(asset => asset.id)).size, assets.length);
    assert.equal(new Set(assets.map(asset => asset.code)).size, assets.length);
    for (const asset of C.ETF_LIST) assert.ok(assets.some(item => item.id === asset.id));
    assert.ok(assets.some(asset => asset.id === 'star-50' && asset.detail.startsWith('gpt-strategy.html#')));
    assert.ok(assets.some(asset => asset.id === 'vix-dashboard'));
});

test('gold, bonds, VIX and independent GPT assets never borrow another asset PE or signal', () => {
    const env = environment();
    for (const id of ['gold', 'bond-10y']) assert.equal(env.M.build(fixture(env, id), {}, NOW).evidence.pe.state, 'na');
    const assets = env.M.allAssets(env.C, env.E.ASSETS);
    for (const id of ['vix-dashboard', 'star-50']) {
        const record = { ...fixture(env), asset: assets.find(asset => asset.id === id) };
        const model = env.M.build(record, {}, NOW);
        assert.equal(model.evidence.signal.state, 'na');
        if (id === 'vix-dashboard') assert.equal(model.evidence.pe.state, 'na');
    }
});

function loaders(env, overrides = {}) {
    return { assets: env.C.ETF_LIST.slice(0, 5), getCurrent: () => null, getManual: () => null,
        historyLoader: async () => ({ data: { peHistory: [] }, state: 'ready' }), priceLoader: async () => ({ price: null, error: 'offline' }),
        apiLoader: async () => ({ success: false, errors: ['offline'], pending: [] }), ...overrides };
}
async function waitDone(controller) {
    for (let i = 0; i < 200; i++) {
        if (controller.summary().active === 0 && controller.summary().queued === 0) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('controller did not drain');
}

test('manual overview refresh and retry force prices with one shared scope per round', async () => {
    const env = environment(), calls = [];
    const controller = env.D.create(loaders(env, { priceLoader: async (asset, refresh, previous, scope) => {
        calls.push({ asset, refresh, previous, scope }); return { price: null, error: 'offline' };
    } }));
    controller.refreshAll(); await waitDone(controller);
    assert.ok(calls.every(call => call.refresh === true));
    assert.equal(new Set(calls.map(call => call.scope)).size, 1);
    const previousScope = calls[0].scope, count = calls.length;
    controller.refreshAll(); await waitDone(controller);
    assert.notEqual(calls[count].scope, previousScope);
    const retryCount = calls.length;
    controller.retry([calls[0].asset.id]); await waitDone(controller);
    assert.equal(calls.length, retryCount + 1);
    assert.equal(calls.at(-1).refresh, true);
    assert.notEqual(calls.at(-1).scope, calls[count].scope);
});

test('intraday display changes price and ROC without changing overview gates or candidate conclusions', () => {
    const env = environment(), record = fixture(env), bars = [];
    for (let d = new Date('2025-01-01T00:00:00Z'); d.toISOString().slice(0, 10) <= '2026-09-18'; d.setUTCDate(d.getUTCDate() + 1)) {
        if ([0, 6].includes(d.getUTCDay())) continue;
        const close = 100 + Math.sin(bars.length / 8) * 12;
        bars.push({ date: d.toISOString().slice(0, 10), open: close, close, high: close, low: close });
    }
    record.priceResult.price = { ...record.priceResult.price, bars, market: 'cn', fetchedAt: NOW.toISOString(),
        liveBar: { date: '2026-09-21', close: 70, high: 70, low: 70, open: 70 } };
    const first = env.M.build(record, {}, NOW);
    record.priceResult.price = { ...record.priceResult.price, liveBar: { date: '2026-09-21', close: 140, high: 140, low: 140, open: 140 } };
    const second = env.M.build(record, {}, NOW);
    assert.equal(first.display.provisional, true);
    assert.equal(first.dailyDisplay.last.date, '2026-09-21');
    assert.notEqual(first.display.last.rank, second.display.last.rank);
    assert.deepEqual(first.evidence.roc, second.evidence.roc);
    assert.deepEqual(first.candidate, second.candidate);
    assert.equal(first.buyBlocked, second.buyBlocked);
    assert.equal(first.sellBlocked, second.sellBlocked);
    assert.equal(first.tier, second.tier);
    record.priceResult.price = { ...record.priceResult.price, bars: bars.filter(bar => bar.date <= '2026-09-01'),
        fetchedAt: '2026-09-01T08:00:00Z', liveBar: null };
    const stale = env.M.build(record, {}, NOW);
    assert.equal(stale.evidence.roc.state, 'stale');
    assert.equal(stale.evidence.roc.vote, null);
    assert.equal(stale.buyBlocked, null);
    assert.equal(stale.sellBlocked, null);
});

test('async controller starts at most three assets, publishes fast prices, and continues after failure', async () => {
    const env = environment(), gates = new Map(), updates = [];
    const controller = env.D.create(loaders(env, { onChange: record => updates.push({ id: record.asset.id, ...record.parts }),
        apiLoader: asset => { const gate = deferred(); gates.set(asset.id, gate); return gate.promise; },
        priceLoader: async asset => ({ price: { code: asset.code, asOf: '2026-09-18', bars: [] } }) }));
    controller.refreshAll(); await tick();
    assert.equal(controller.summary().active, 3);
    assert.equal(controller.summary().queued, 2);
    assert.equal(controller.refreshAll(), false);
    assert.ok(updates.some(value => value.price === 'ready' && value.api === 'loading'));
    for (const gate of gates.values()) gate.reject(new Error('offline'));
    await tick(); await tick();
    assert.ok(controller.summary().active <= 3);
    for (const gate of gates.values()) gate.resolve({ success: false, errors: ['offline'] });
    await waitDone(controller);
    assert.equal(controller.summary().complete, 5);
    assert.equal(controller.summary().failed, 5);
});

test('retry targets only completed requested assets and uses a new batch scope', async () => {
    const env = environment(), calls = [], scopes = [];
    const controller = env.D.create(loaders(env, { apiLoader: async (asset, _onProgress, scope) => {
        calls.push(asset.id); scopes.push(scope); return { success: false, errors: ['offline'] };
    } }));
    controller.refreshAll(); await waitDone(controller);
    assert.equal(new Set(scopes).size, 1);
    const id = env.C.ETF_LIST[0].id;
    controller.retry([id, id]); await waitDone(controller);
    assert.equal(calls.length, 6);
    assert.equal(calls.at(-1), id);
    assert.notEqual(scopes.at(-1), scopes[0]);
    assert.equal(controller.records.get(id).revision, 2);
});

test('timed-out old callbacks cannot overwrite retry data and cannot leave cards loading forever', async () => {
    const env = environment();
    let callback, calls = 0;
    const controller = env.D.create(loaders(env, { assets: env.C.ETF_LIST.slice(0, 1), timeout: 10,
        apiLoader: async (_asset, update) => {
            calls++;
            if (calls === 1) { callback = update; return new Promise(() => {}); }
            return { success: true, valuation: { pe: 12, tradeDate: '2026-09-18' }, pending: [] };
        }
    }));
    controller.refreshAll(); await waitDone(controller);
    const id = env.C.ETF_LIST[0].id;
    assert.equal(controller.records.get(id).parts.api, 'failed');
    controller.retry([id]); await waitDone(controller);
    callback({ valuation: { pe: 999 }, success: true, pending: [] });
    assert.equal(controller.records.get(id).api.valuation.pe, 12);
    assert.equal(controller.summary().active, 0);
});

test('batch requests share a valuation payload but preserve each index identity', async () => {
    let requests = 0;
    const env = environment({ fetch: async () => { requests++; return { ok: true, json: async () => ({ data: { items: [
        { index_code: 'SH000300', pe: 13, date: '2026-09-18' }, { index_code: 'SH000016', pe: 10, date: '2026-09-18' }
    ] } }) }; } });
    const cache = new Map();
    const [first, second] = await Promise.all([env.A.fetchDanjuanValuationByIndex('SH000300', '', cache), env.A.fetchDanjuanValuationByIndex('SH000016', '', cache)]);
    assert.equal(requests, 1);
    assert.equal(first.pe, 13); assert.equal(second.pe, 10);
    assert.notEqual(first.instrumentId, second.instrumentId);
    await env.A.fetchDanjuanValuationByIndex('SH000300', '', new Map());
    assert.equal(requests, 2);
});

test('overview has both entry links, accessible progress and no blocking loading screen', () => {
    assert.match(read('index.html'), /href="overview.html"/);
    assert.match(read('gpt-strategy.html'), /href="overview.html"/);
    const html = read('overview.html');
    for (const lane of ['low', 'risk', 'normal', 'pending']) assert.ok(html.includes(`id="lane-${lane}"`));
    assert.match(html, /aria-live="polite"/);
    assert.ok(!html.includes('id="loading"'));
    assert.ok(!html.includes('src="js/main.js'));
});

test('removed manual input in the old current cache cannot override live observations', () => {
    const env = environment(), record = fixture(env);
    record.previousCurrent.fieldMeta.pe.quality = 'manual';
    record.previousCurrent.pe = 99;
    record.api = { pending: [], valuation: { pe: 12, instrumentId: record.asset.trackIndex.code, tradeDate: '2026-09-18', source: 'fixture' } };
    assert.equal(env.M.normalized(record).pe, 12);
});

test('two-field classification is always marked as a partial reference', () => {
    const env = environment(), record = fixture(env);
    mockRoc(env, -5);
    record.history.peHistory = [];
    const original = env.S.analyzeCurrent;
    env.S.analyzeCurrent = (...args) => ({ ...original(...args), signal: { level: 'BUY', text: '绿色' },
        quality: { calculable: true, allowed: true, hardReasons: [], coverage: 100 } });
    const model = env.M.build(record, {}, NOW);
    assert.equal(model.tier, 'low');
    assert.equal(model.count, 2);
    assert.equal(model.reference, true);
});

test('invalid vote values never count as neutral evidence', () => {
    const { M } = environment();
    assert.equal(M.classify({ roc: { vote: undefined }, signal: { vote: null }, pe: { vote: NaN } }).tier, 'pending');
});

test('ROC calculation is reused while unrelated source progress updates the same price sequence', () => {
    const env = environment(), record = fixture(env);
    let calculations = 0;
    env.E.rocModel = () => { calculations++; return { fresh: true, last: { date: '2026-09-18', smooth: -5 }, lowerBand: [-4], upperBand: [4], minimum: 126 }; };
    env.M.build(record, {}, NOW);
    record.parts.api = 'loading';
    env.M.build(record, {}, NOW);
    assert.equal(calculations, 1);
    env.M.build(record, { length: 20 }, NOW);
    assert.equal(calculations, 2);
});

test('missing PE does not prevent green or red signals from being classified when ROC permits', () => {
    const { M } = environment();
    for (const state of ['missing', 'stale', 'na', 'failed']) {
        for (const [roc, signal, tier] of [[0, -1, 'low'], [-1, -1, 'low'], [0, 1, 'risk'], [1, 1, 'risk'], [0, 0, 'normal'], [-1, 1, 'normal'], [1, -1, 'normal']]) {
            const items = evidence(roc, signal, null);
            items.pe.state = state;
            const result = M.classify(items);
            assert.equal(result.tier, tier, JSON.stringify({ roc, signal, state }));
            assert.equal(result.peIgnored, true);
            assert.match(result.reason, /历史PE已忽略/);
        }
    }
});

test('failed historical PE and unavailable composite score still allow ROC-only rhythm observation', () => {
    const env = environment(), record = fixture(env);
    record.history = {};
    record.previousCurrent = null;
    record.parts.api = 'failed'; record.parts.history = 'failed';
    record.api = { pending: [], success: false }; record.issues = { history: ['历史接口失败'] };
    mockRoc(env, -5, -4, 4, 12);
    const result = env.M.build(record, {}, NOW);
    assert.equal(result.tier, 'normal');
    assert.equal(result.status, 'error');
    assert.equal(result.evidence.pe.vote, null);
    assert.equal(result.evidence.signal.vote, null);
    assert.equal(result.peIgnored, true);
    assert.equal(result.sellBlocked, true);
    assert.match(result.reason, /仅有ROC/);
    assert.match(result.action, /不卖出/);
});

test('unknown ROC cannot be bypassed by two green valuation signals or red risk signals', () => {
    const { M } = environment();
    for (const signal of [-1, 0, 1]) for (const pe of [-1, 0, 1, null]) {
        const result = M.classify(evidence(null, signal, pe));
        assert.equal(result.tier, 'pending');
        assert.equal(result.buyBlocked, null);
        assert.equal(result.sellBlocked, null);
        assert.match(result.action, /等待ROC/);
    }
});

test('overview shows trading constraints and optional PE instead of the old two-vote rule', () => {
    const html = read('overview.html'), app = read('js/overview-app.js');
    assert.match(html, /≥80% 不买入/);
    assert.match(html, /≤20% 不卖出/);
    assert.match(html, /历史PE可选/);
    assert.ok(!html.includes('少于两项进入'));
    assert.match(app, /card-action/);
    assert.match(app, /已忽略/);
});

test('price-only additions skip nonexistent history and unused valuation calls in the overview', async () => {
    const env = environment(), asset = env.C.getETFById('bank');
    const history = await env.D.historyFor(asset);
    assert.equal(history.state, 'na');
    let apiCalls = 0, priceCalls = 0;
    const controller = env.D.create(loaders(env, { assets: [asset], historyLoader: env.D.historyFor,
        apiLoader: async () => { apiCalls++; return { success: true }; },
        priceLoader: async () => { priceCalls++; return { price: null, error: 'offline' }; }
    }));
    controller.refreshAll(); await waitDone(controller);
    assert.equal(apiCalls, 0); assert.equal(priceCalls, 1);
    const result = controller.records.get(asset.id);
    assert.equal(result.parts.history, 'na'); assert.equal(result.parts.api, 'na');
    assert.equal(result.phase, 'done');
});

test('new price-only assets cannot inherit cached PE or valuation votes', () => {
    const env = environment(), record = fixture(env);
    record.asset = env.C.getETFById('bank');
    mockRoc(env);
    const model = env.M.build(record, {}, NOW);
    assert.equal(model.evidence.pe.vote, null);
    assert.equal(model.evidence.signal.vote, null);
    assert.equal(model.candidate.valuationSupport, false);
    assert.equal(model.tier, 'pending');
});

test('name badge reuses the exact detail signal text, color and one-decimal score from one analysis call', () => {
    const env = environment(), record = fixture(env, 'dividend-low-vol');
    const original = env.S.analyzeCurrent;
    const expected = original(env.M.normalized(record), record.asset, record.history);
    let calls = 0;
    env.S.analyzeCurrent = (...args) => { calls++; return original(...args); };
    const model = env.M.build(record, {}, NOW), badge = model.composite;
    assert.equal(calls, 1);
    assert.equal(badge.text, expected.signal.text);
    assert.equal(badge.color, expected.signal.color);
    assert.equal(badge.score, expected.total);
    assert.equal(badge.scoreText, expected.total.toFixed(1));
    assert.equal(badge.reference, !expected.quality.allowed);
    assert.equal(model.count, env.M.classify(model.evidence).count);
    assert.equal(model.tier, env.M.classify(model.evidence).tier);
    assert.match(badge.detail, /不等于ROC分位/);
});

test('stale composite scores remain explicit detail-equivalent reference scores, not current classification votes', () => {
    const env = environment(), record = fixture(env);
    record.previousCurrent.fieldMeta.pe.asOf = '2026-08-18';
    const expected = env.S.analyzeCurrent(env.M.normalized(record), record.asset, record.history);
    const model = env.M.build(record, {}, NOW);
    assert.equal(expected.quality.calculable, true);
    assert.equal(model.evidence.signal.vote, null);
    assert.equal(model.composite.state, 'reference');
    assert.equal(model.composite.text, expected.signal.text);
    assert.equal(model.composite.scoreText, expected.total.toFixed(1));
    assert.match(model.composite.detail, /2026-08-18/);
    assert.match(model.composite.detail, /过期/);
});

test('API or valuation history in flight clears badge scores, but price-only progress does not', () => {
    const env = environment();
    for (const patch of [r => { r.parts.api = 'loading'; }, r => { r.parts.history = 'queued'; },
        r => { r.api.pending = ['valuation']; }]) {
        const r = fixture(env); patch(r);
        const badge = env.M.build(r, {}, NOW).composite;
        assert.equal(badge.state, 'loading'); assert.equal(badge.score, null); assert.equal(badge.scoreText, '—');
    }
    const r = fixture(env), before = env.M.build(r, {}, NOW).composite;
    r.parts.price = 'loading';
    const after = env.M.build(r, {}, NOW);
    assert.equal(after.loading, true); assert.notEqual(after.composite.state, 'loading');
    assert.equal(after.composite.text, before.text); assert.equal(after.composite.scoreText, before.scoreText);
});

test('missing or wrong-instrument valuation never displays the internal zero or referenceTotal as a composite score', () => {
    const env = environment();
    for (const patch of [r => { r.previousCurrent = null; r.history = {}; },
        r => { r.previousCurrent.fieldMeta.pe.instrumentId = 'WRONG'; },
        r => { r.previousCurrent.fieldMeta.pe.asOf = '2027-01-01'; }]) {
        const r = fixture(env); patch(r);
        const result = env.M.build(r, {}, NOW).composite;
        assert.equal(result.state, 'missing'); assert.equal(result.score, null); assert.equal(result.scoreText, '—');
        assert.equal(result.text, '暂无法计算');
    }
});

test('a legitimate zero composite score displays 0.0 while invalid totals remain missing', () => {
    const env = environment(), record = fixture(env), original = env.S.analyzeCurrent;
    for (const total of [0, 62.3, NaN, Infinity, null]) {
        env.S.analyzeCurrent = (...args) => {
            const result = original(...args);
            return { ...result, total, signal: { ...result.signal, level: 'SELL', text: '卖出',
                quality: { ...result.quality, allowed: true, calculable: true } } };
        };
        const badge = env.M.build(record, {}, NOW).composite;
        assert.equal(badge.scoreText, Number.isFinite(total) ? total.toFixed(1) : '—');
        assert.equal(badge.state, Number.isFinite(total) ? 'ready' : 'missing');
    }
});

test('price-only, GPT-only and VIX badges do not borrow a composite score', () => {
    const env = environment(), assets = env.M.allAssets(env.C, env.E.ASSETS);
    for (const id of ['bank', 'star-50', 'vix-dashboard']) {
        const record = fixture(env); record.asset = assets.find(asset => asset.id === id);
        const badge = env.M.build(record, {}, NOW).composite;
        assert.equal(badge.state, 'na'); assert.equal(badge.score, null); assert.equal(badge.scoreText, '—');
    }
});

test('reference, proxy and fallback text preserve the detail result without depending on ROC quality', () => {
    const env = environment(), record = fixture(env), original = env.S.analyzeCurrent;
    env.S.analyzeCurrent = (...args) => {
        const result = original(...args);
        return { ...result, signal: { ...result.signal, level: 'REFERENCE', referenceLevel: 'BUY', text: '吸引力偏高 · 代理参考',
            color: '#28a745', quality: { ...result.quality, allowed: false, calculable: true } } };
    };
    const before = env.M.build(record, {}, NOW).composite;
    record.priceResult.price.adjustment = 'raw'; record.parts.price = 'fallback';
    const raw = env.M.build(record, {}, NOW).composite;
    assert.equal(raw.text, before.text); assert.equal(raw.scoreText, before.scoreText);
    assert.equal(raw.fallback, false);
    record.parts.api = 'failed'; record.parts.history = 'fallback';
    const fallback = env.M.build(record, {}, NOW).composite;
    assert.equal(fallback.fallback, true); assert.equal(fallback.reference, true);
    assert.equal(fallback.text, '吸引力偏高 · 代理参考');
    assert.equal(fallback.scoreText, before.scoreText);
    assert.match(fallback.detail, /更新失败/);
});
