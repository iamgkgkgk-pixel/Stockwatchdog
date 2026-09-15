const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../js/gpt-strategy-engine.js');
const D = require('../js/gpt-strategy-data.js');
const NOW = new Date('2026-09-15T09:00:00Z');
const core = E.ASSETS[0], tech = E.ASSETS[4];
const approximate = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function daily(length, price = i => 100 * Math.exp(i * 0.0002 + Math.sin(i / 13) * 0.18)) {
    const result = [];
    let day = new Date('2024-01-01T00:00:00Z');
    while (result.length < length) {
        if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
            const close = price(result.length);
            result.push({ date: day.toISOString().slice(0, 10), close, open: close, high: close, low: close });
        }
        day = new Date(day.getTime() + 86400000);
    }
    return result;
}

function monthly(length = 72, value = i => 15 + Math.sin(i)) {
    return Array.from({ length }, (_, i) => ({ date: new Date(Date.UTC(2020, 8 + i, 1)).toISOString().slice(0, 7), value: value(i) }));
}
const observation = { pe: 9, asOf: '2026-09-14', source: 'test fixture', indexId: 'NDX' };
const valuation = band => ({ usable: true, band, mode: 'history', confidence: 'local', pe: band === 'rich' ? 30 : 15,
    reductionReady: band === 'rich', primary: { label: '近5年', rank: ({ low: 10, fair: 40, elevated: 75, rich: 95 })[band] ?? 50, median: 20, premium: band === 'rich' ? 50 : -25 } });
const turn = type => ({ fresh: true, last: { smooth: type === 'trough' ? -4 : 4, rank: type === 'trough' ? 10 : 90 }, recent: { type }, slope: type === 'trough' ? 1 : -1 });

// Synthetic series below are test fixtures only, never production or displayed data.
test('five identities keep STAR50 separate from dual innovation', () => {
    assert.equal(E.ASSETS.length, 5);
    assert.equal(E.ASSETS.find(a => a.id === 'star-50').code, '588000');
    assert.equal(E.ASSETS.find(a => a.id === 'sci-tech-50').code, '588300');
    assert.notEqual(E.ASSETS[2].trackIndex.code, E.ASSETS[3].trackIndex.code);
});

test('ROC uses percentage change over N periods, no forward fill', () => {
    const model = E.rocModel(daily(4, i => [100, 110, 121, 132][i]), { length: 2, smoothing: 1, confirmation: 1 }, NOW);
    assert.deepEqual(model.roc.slice(0, 2), [null, null]);
    approximate(model.roc[2], 21);
    approximate(model.roc[3], 20);
});

test('trailing smoothing needs its entire window', () => {
    const model = E.rocModel(daily(5, i => [100, 110, 121, 132, 145.2][i]), { length: 2, smoothing: 2, confirmation: 1 }, NOW);
    assert.equal(model.smooth[2], null);
    approximate(model.smooth[3], 20.5);
});

test('nulls, blanks and non-finite numbers are not zero observations', () => {
    for (const value of [null, undefined, '', ' ', false, Infinity, NaN]) assert.equal(E.number(value), null);
    assert.equal(E.number(0), 0);
    assert.equal(E.date('2026-02-30'), null);
});

test('unfinished and future daily bars are excluded, duplicates are deterministic', () => {
    const rows = [{ date: '2026-09-14', close: 2 }, { date: '2026-09-14', close: 3 }, { date: '2026-09-15', close: 4 }, { date: '2026-09-16', close: 5 }, { date: '2026-02-30', close: 4 }, { date: '2026-09-10', close: 0 }];
    const morning = E.completedBars(rows, new Date('2026-09-15T06:00:00Z'));
    assert.equal(morning.length, 1);
    assert.equal(morning[0].close, 3);
    assert.equal(E.completedBars(rows, NOW).length, 2);
});

test('weekly aggregation excludes the ongoing week and Friday before close', () => {
    const rows = ['2026-09-07', '2026-09-11', '2026-09-14', '2026-09-18'].map((date, i) => ({ date, close: i + 1 }));
    assert.deepEqual(E.periods(rows, 'week', NOW).map(b => b.date), ['2026-09-11']);
    assert.equal(E.periods(rows, 'week', new Date('2026-09-18T06:00:00Z')).length, 1);
    assert.equal(E.periods(rows, 'week', new Date('2026-09-18T09:00:00Z')).length, 2);
});

test('flat prices produce no manufactured peaks and no extreme percentile', () => {
    const model = E.rocModel(daily(400, () => 100), {}, NOW);
    assert.equal(model.events.length, 0);
    assert.equal(model.last.rank, 50);
    assert.equal(model.recent, null);
});

test('equal percentile ranks receive midpoint treatment', () => {
    assert.equal(E.percentile(2, [1, 2, 2, 3]), 50);
    assert.equal(E.percentile(0, [1, 2, 3]), 0);
    assert.equal(E.percentile(4, [1, 2, 3]), 100);
    assert.equal(E.percentile(4, [1, 2, 3], 4), null);
});

test('appending future data cannot rewrite previous ROC, bands or confirmation events', () => {
    const rows = daily(500);
    const full = E.rocModel(rows, {}, NOW);
    for (const length of [100, 210, 340, 499]) {
        const prefix = E.rocModel(rows.slice(0, length), {}, NOW);
        assert.deepEqual(prefix.roc, full.roc.slice(0, length));
        assert.deepEqual(prefix.smooth, full.smooth.slice(0, length));
        assert.deepEqual(prefix.ranks, full.ranks.slice(0, length));
        assert.deepEqual(prefix.lowerBand, full.lowerBand.slice(0, length));
        assert.deepEqual(prefix.events, full.events.filter(e => e.confirmIndex < length));
    }
});

test('pivot is only released at confirmation date, not at the earlier extremum', () => {
    const rows = daily(400);
    const full = E.rocModel(rows, {}, NOW);
    assert.ok(full.events.length > 5);
    for (const event of full.events.slice(0, 5)) {
        assert.equal(event.confirmIndex - event.pivotIndex, 2);
        assert.ok(event.confirmedAt > event.pivotDate);
        assert.ok(!E.rocModel(rows.slice(0, event.confirmIndex), {}, NOW).events.some(e => e.pivotDate === event.pivotDate));
    }
});

test('historical percentile excludes the current observation', () => {
    const model = E.rocModel(daily(300), {}, NOW);
    const i = 200;
    approximate(model.ranks[i], E.percentile(model.smooth[i], model.smooth.slice(0, i).filter(v => v !== null), 126));
});

test('a constant forward adjustment factor leaves ROC unchanged', () => {
    const rows = daily(250);
    const a = E.rocModel(rows, {}, NOW);
    const b = E.rocModel(rows.map(r => ({ ...r, close: r.close * 0.63 })), {}, NOW);
    a.roc.forEach((value, i) => { if (value !== null) approximate(value, b.roc[i]); });
});

test('short histories still have ROC but cannot claim a calibrated tail', () => {
    const model = E.rocModel(daily(50), {}, NOW);
    assert.notEqual(model.last.roc, null);
    assert.equal(model.last.rank, null);
    assert.equal(model.recent, null);
});

test('invalid settings revert to bounded defaults', () => {
    assert.deepEqual(E.settings({ length: -2, smoothing: 0, confirmation: 1.5, timeframe: 'year' }), E.DEFAULTS);
    assert.equal(E.settings({ length: 60 }).length, 60);
});

test('PE histories are monthly equal-weight and current month is excluded', () => {
    const points = monthly();
    const base = E.valuationModel(points, observation, null, NOW);
    const duplicateDays = [...points, ...Array.from({ length: 20 }, (_, i) => ({ date: '2026-09-' + String(i + 1).padStart(2, '0'), value: 999 }))];
    const model = E.valuationModel(duplicateDays, observation, null, NOW);
    assert.deepEqual(model.references, base.references);
    assert.deepEqual(model.references.map(r => r.count), [36, 60]);
    assert.equal(model.band, 'low');
    assert.equal(model.usable, true);
});

test('monthly duplicate daily samples do not overweight a month', () => {
    const points = monthly();
    const original = E.valuationModel(points, observation, null, NOW);
    const extra = [...points, { date: '2026-08-05', value: points.at(-1).value }, { date: '2026-08-26', value: points.at(-1).value }];
    assert.deepEqual(E.valuationModel(extra, observation, null, NOW).references.map(r => [r.rank, r.count]), original.references.map(r => [r.rank, r.count]));
});

test('estimated, future and non-positive PE samples cannot enter the baseline', () => {
    const base = monthly();
    const extra = [...base, { date: '2026-07-30', value: 999, quality: 'estimated' }, { date: '2027-01', value: 999 }, { date: '2026-08-30', value: -3 }];
    assert.deepEqual(E.valuationModel(extra, observation, null, NOW).references, E.valuationModel(base, observation, null, NOW).references);
});

test('adjacent-window disagreement remains useful but is conservative about cheapness', () => {
    const points = monthly(72, i => i < 36 ? 5 : 30);
    const model = E.valuationModel(points, { ...observation, pe: 20 }, null, NOW);
    assert.equal(model.band, 'fair');
    assert.equal(model.usable, true);
    assert.equal(model.disagreement, true);
    assert.equal(model.primary.years, 5);
    assert.notEqual(E.decision(tech, model, turn('trough'), 'easing').action, 'BUY');
});

test('provider percentile is explicitly limited rather than impersonating a local window', () => {
    const model = E.valuationModel([], { ...observation, providerPercentile: 1 }, null, NOW);
    assert.equal(model.usable, true);
    assert.equal(model.band, 'low');
    assert.equal(model.mode, 'provider');
    assert.equal(model.confidence, 'provider');
    assert.equal(model.primary.median, null);
    assert.ok(model.references.every(reference => reference.rank === null));
    assert.equal(model.reductionReady, false);
});

test('stale PE remains visible but cannot open a current entry', () => {
    const model = E.valuationModel(monthly(), { ...observation, asOf: '2026-06-01' }, null, NOW);
    assert.equal(model.pe, 9);
    assert.equal(model.usable, false);
    assert.equal(model.fresh, false);
});

test('explicit user valuation premise has separate provenance and expiry', () => {
    const manual = { band: 'fair', asOf: '2026-09-14', reason: 'test: user checked source' };
    const good = E.valuationModel([], null, manual, NOW);
    assert.equal(good.usable, true);
    assert.equal(good.mode, 'manual');
    for (const asOf of ['2026-09-16', '2026-07-01', '2026-02-30']) assert.equal(E.valuationModel([], null, { ...manual, asOf }, NOW).usable, false);
    assert.equal(E.valuationModel([], null, { ...manual, reason: '' }, NOW).usable, false);
});

test('cheap technology needs the manual rate gate but no longer needs an ROC trough', () => {
    for (const roc of [turn('trough'), turn('peak'), { ...turn('trough'), recent: null, slope: -1 }, null]) {
        const result = E.decision(tech, valuation('low'), roc, 'easing');
        assert.equal(result.action, 'BUY');
        assert.equal(result.title, '分批买入');
    }
    for (const regime of ['tightening', 'unknown']) assert.equal(E.decision(tech, valuation('low'), turn('trough'), regime).action, 'NO_BUY');
    assert.notEqual(E.decision(tech, valuation('fair'), turn('trough'), 'easing').action, 'BUY');
});

test('easing alone does not buy expensive technology and tightening does not sell cheap holdings', () => {
    assert.equal(E.decision(tech, valuation('elevated'), turn('trough'), 'easing').action, 'NO_ADD');
    const hiking = E.decision(tech, valuation('low'), turn('peak'), 'tightening');
    assert.equal(hiking.action, 'NO_BUY');
    assert.match(hiking.buy, /暂停新买/);
    assert.doesNotMatch(hiking.hold, /减|卖|清仓/);
});

test('a core ROC trough may suggest tactical refill while the main decision remains HOLD', () => {
    const result = E.decision(core, valuation('fair'), turn('trough'), 'tightening');
    assert.equal(result.action, 'HOLD');
    assert.equal(result.title, '持有为主');
    assert.match(result.tactical.title, /机动仓.*回补/);
    assert.doesNotMatch(result.buy, /\d+%/);
});

test('a core ROC peak cannot downgrade a fairly valued long-term holding to SELL', () => {
    const result = E.decision(core, valuation('fair'), turn('peak'), 'unknown');
    assert.equal(result.action, 'HOLD');
    assert.equal(result.title, '持有为主');
    assert.equal(result.hold, '底仓继续持有');
    assert.match(result.tactical.title, /做T减仓/);
});

test('a confirmed tech ROC peak is not a primary sale if valuation is fair', () => {
    assert.equal(E.decision(tech, valuation('fair'), turn('peak'), 'easing').action, 'HOLD');
});

test('fear and ROC cannot replace missing PE for a primary buy or sale', () => {
    for (const roc of [turn('trough'), turn('peak')]) {
        const result = E.decision(core, { usable: false, band: 'unknown' }, roc, 'easing', { usable: true, market: 'cn', level: 'panic' });
        assert.equal(result.action, 'DATA_INCOMPLETE');
        assert.equal(result.title, '暂无法判断');
        assert.match(result.tactical.detail, /ROC/);
        assert.equal(result.scope, '主判断数据不足');
    }
});

test('stale or missing prices suspend only ROC, not a current valuation decision', () => {
    for (const roc of [{ ...turn('peak'), fresh: false }, { last: null, fresh: false }, null]) {
        assert.equal(E.decision(tech, valuation('low'), roc, 'easing').action, 'BUY');
        const fair = E.decision(core, valuation('fair'), roc, 'easing');
        assert.equal(fair.action, 'HOLD');
        assert.equal(fair.tactical.title, '波段暂不可用');
    }
});

test('strong fear strengthens cheap-value context, but never converts expensive assets to BUY', () => {
    const fear = { usable: true, market: 'us', level: 'panic' };
    const cheap = E.decision(tech, valuation('low'), turn('peak'), 'easing', fear);
    assert.equal(cheap.action, 'BUY');
    assert.match(cheap.sentimentEffect, /低估叠加/);
    assert.equal(E.decision(tech, valuation('elevated'), turn('trough'), 'easing', fear).action, 'NO_ADD');
    assert.equal(E.decision(tech, valuation('rich'), turn('trough'), 'easing', fear).action, 'REDUCE');
});

test('same-market strong pressure can mildly increase a fair core position, not a fair tech position', () => {
    assert.equal(E.decision(core, valuation('fair'), null, 'easing', { usable: true, market: 'cn', level: 'panic' }).action, 'ADD');
    assert.equal(E.decision(tech, valuation('fair'), null, 'easing', { usable: true, market: 'us', level: 'panic' }).action, 'HOLD');
});

test('missing, stale and wrong-market fear is not silently replaced with extreme or neutral sentiment', () => {
    for (const fear of [null, { usable: false, market: 'cn', level: 'panic' }, { usable: true, market: 'us', level: 'panic' }]) {
        const result = E.decision(core, valuation('fair'), turn('peak'), 'easing', fear);
        assert.equal(result.action, 'HOLD');
        assert.match(result.sentimentEffect, /不作情绪修正/);
    }
});

test('clear overvaluation leads to staged reduction even if ROC is still strong', () => {
    const result = E.decision(tech, valuation('rich'), { ...turn('peak'), recent: null, slope: 1 }, 'easing');
    assert.equal(result.action, 'REDUCE');
    assert.equal(result.title, '分批减仓');
    assert.match(result.tactical.detail, /不必等ROC/);
    assert.doesNotMatch(result.hold, /清仓/);
});

test('high percentile alone without a meaningful PE premium does not force selling', () => {
    const highButNarrow = E.valuationModel(monthly(72, () => 10), { ...observation, pe: 11 }, null, NOW);
    assert.equal(highButNarrow.band, 'rich');
    assert.equal(highButNarrow.reductionReady, false);
    assert.equal(E.decision(tech, highButNarrow, turn('peak'), 'easing').action, 'NO_ADD');
    const clearlyHigh = E.valuationModel(monthly(72, () => 10), { ...observation, pe: 13 }, null, NOW);
    assert.equal(clearlyHigh.reductionReady, true);
    assert.equal(E.decision(tech, clearlyHigh, null, 'easing').action, 'REDUCE');
});

test('manual valuation remains explicitly attributed', () => {
    const result = E.decision(tech, { ...valuation('low'), mode: 'manual' }, turn('peak'), 'easing');
    assert.equal(result.action, 'BUY');
    assert.match(result.reason, /你已判断/);
    assert.equal(result.scope, '采用你的估值判断');
});

test('changing any ROC state cannot change any field of the main decision', () => {
    for (const asset of [core, tech]) for (const regime of ['easing', 'tightening', 'unknown']) for (const band of ['low', 'fair', 'elevated', 'rich', 'unknown']) {
        for (const level of ['normal', 'fear', 'panic', 'unknown']) {
            const v = { ...valuation(band), usable: band !== 'unknown' };
            const fear = { usable: level !== 'unknown', level, market: E.marketFor(asset) };
            const expected = E.primaryDecision(asset, v, regime, fear);
            for (const roc of [turn('peak'), turn('trough'), { ...turn('trough'), recent: null }, { ...turn('peak'), fresh: false }, null]) {
                const { tactical, ...actual } = E.decision(asset, v, roc, regime, fear);
                assert.deepEqual(actual, expected);
                assert.ok(tactical.title.length > 0);
            }
        }
    }
});

test('daily versus weekly ROC and different N/M settings alter only the secondary hint', () => {
    const data = daily(500);
    const main = E.primaryDecision(tech, valuation('low'), 'easing');
    for (const options of [{ length: 12, smoothing: 6 }, { length: 60, smoothing: 1 }, { timeframe: 'week', length: 26 }]) {
        const { tactical, ...result } = E.decision(tech, valuation('low'), E.rocModel(data, options, NOW), 'easing');
        assert.deepEqual(result, main);
        assert.ok(tactical);
    }
});

test('headlines stay short and never call the whole strategy a ROC trade', () => {
    const titles = new Set(['持有为主', '暂不买入', '持有，暂停加仓', '分批买入', '小幅买入', '小幅加仓', '分批减仓', '暂无法判断', '估值待更新', '观望，不加仓']);
    for (const asset of [core, tech]) for (const regime of ['easing', 'tightening', 'unknown']) for (const band of ['low', 'fair', 'elevated', 'rich', 'unknown']) {
        const result = E.decision(asset, { ...valuation(band), usable: band !== 'unknown' }, turn('peak'), regime);
        assert.ok(titles.has(result.title));
        assert.ok(result.reason.length > 0);
        assert.ok(result.buy.length <= 22 && result.hold.length <= 22);
        assert.doesNotMatch(result.title, /ROC|做T/);
    }
});

test('price request explicitly uses forward-adjusted daily ETF prices', () => {
    const url = new URL(D.priceURL(core, NOW));
    assert.equal(url.searchParams.get('fqt'), '1');
    assert.equal(url.searchParams.get('klt'), '101');
    assert.equal(url.searchParams.get('secid'), core.secid);
});

test('price parser rejects wrong instrument identity and invalid OHLC', () => {
    const payload = { rc: 0, data: { code: core.code, market: 1, klines: ['2026-09-14,1,2,2,1,100'] } };
    assert.equal(D.parseEastmoney(payload, core).adjustment, 'qfq');
    assert.throws(() => D.parseEastmoney(payload, tech), /身份/);
    assert.throws(() => D.parseEastmoney({ ...payload, data: { ...payload.data, klines: ['2026-09-14,1,2,1,1'] } }, core), /没有/);
});

test('valuation parser uses explicit epoch date, not partial MM-DD or fetch time', () => {
    const item = { index_code: 'NDX', pe: 25, ts: Date.parse('2026-09-14T00:00:00Z'), date: '09-14', pe_percentile: 0 };
    const parsed = D.parseValuations({ data: { items: [item] } }, NOW);
    assert.equal(parsed[tech.id].asOf, '2026-09-14');
    assert.equal(parsed[tech.id].providerPercentile, 0);
    assert.deepEqual(D.parseValuations({ data: { items: [{ ...item, ts: undefined }] } }, NOW), {});
    assert.deepEqual(D.parseValuations({ data: { items: [item, item] } }, NOW), {});
});

test('provider proxy cannot become the dual-innovation valuation', () => {
    const item = { index_code: 'SZ399006', pe: 25, ts: Date.parse('2026-09-14T00:00:00Z') };
    assert.equal(D.parseValuations({ data: { items: [item] } }, NOW)['sci-tech-50'], undefined);
});

test('existing storage keys stay untouched and malformed lab preferences are safe', () => {
    const values = new Map([['attack_pyramid_regime', 'NORMAL'], ['gpt_strategy_lab_v1', '{broken']]);
    const context = vm.createContext({ require: () => E, module: { exports: {} }, localStorage: {
        getItem: key => values.get(key), setItem: (key, value) => values.set(key, value),
    } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/gpt-strategy-data.js'), 'utf8'), context);
    assert.equal(JSON.stringify(context.module.exports.loadPreferences()), '{}');
    context.module.exports.savePreferences({ regime: 'tightening' });
    assert.equal(values.get('attack_pyramid_regime'), 'NORMAL');
    assert.equal(values.size, 2);
});

test('read-only history adapter excludes post-boundary proxy records without mutating raw history', () => {
    const context = vm.createContext({ Intl, Date, console });
    for (const file of ['data-quality', 'gpt-strategy-engine', 'gpt-strategy-data']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + file + '.js'), 'utf8'), context);
    const result = vm.runInContext(`(() => {
        const asset = GptStrategyEngine.ASSETS[2];
        const history = { currentData: { pe: 999, updateTime: '2026-06-01' },
            proxyValuation: { pe: 5, asOf: '2026-09-14', instrumentId: 'SZ399006', quality: 'proxy' }, peHistory: [
            { date: '2026-04-27', value: 40 }, { date: '2026-04-28', value: 20 }, { date: '2026-05-01', value: 10 }
        ] };
        const before = JSON.stringify(history);
        const output = GptStrategyData.valuationInputs(asset, history, null);
        return { count: output.points.length, pe: output.observation.pe, unchanged: JSON.stringify(history) === before };
    })()`, context);
    assert.equal(result.count, 1);
    assert.equal(result.pe, 40);
    assert.equal(result.unchanged, true);
});

test('unfinished captured daily bars cannot mature merely because the clock advances', () => {
    const payload = { rc: 0, data: { code: core.code, market: 1, klines: ['2026-09-14,1,2,2,1,100', '2026-09-15,2,3,3,2,100'] } };
    const captured = D.parseEastmoney(payload, core, new Date('2026-09-15T06:00:00Z'));
    assert.equal(captured.bars.length, 1);
    assert.equal(captured.completedOnly, true);
    assert.equal(E.completedBars(captured.bars, new Date('2026-09-16T09:00:00Z')).at(-1).date, '2026-09-14');
});

test('an old Monday snapshot cannot become a complete Friday weekly candle', () => {
    const rows = [{ date: '2026-09-11', close: 10 }, { date: '2026-09-14', close: 11 }];
    assert.deepEqual(E.periods(rows, 'week', new Date('2026-09-18T09:00:00Z')).map(row => row.date), ['2026-09-11']);
    assert.deepEqual(E.periods(rows, 'week', new Date('2026-09-21T09:00:00Z')).map(row => row.date), ['2026-09-11']);
});

test('a historical month-only PE remains visible but cannot pass current-date checks', () => {
    const model = E.valuationModel(monthly(), { ...observation, asOf: '2026-08' }, null, NOW);
    assert.ok(model.references.length > 0);
    assert.equal(model.asOf, null);
    assert.equal(model.fresh, false);
    assert.equal(model.usable, false);
    assert.match(model.reason, /月份精度/);
});

test('month-only target history survives without being relabeled as daily data', () => {
    const context = vm.createContext({ Intl, Date, console });
    for (const file of ['data-quality', 'gpt-strategy-engine', 'gpt-strategy-data']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + file + '.js'), 'utf8'), context);
    const result = vm.runInContext(`GptStrategyData.valuationInputs(GptStrategyEngine.ASSETS[2], { peHistory: [{date:'2026-03',value:42},{date:'2026-04',value:40},{date:'2026-05',value:20}] }, null)`, context);
    assert.equal(result.observation.pe, 40);
    assert.equal(result.observation.asOf, '2026-04');
});

test('null stored settings cannot crash the page', () => {
    for (const input of [null, false, [], 'broken']) assert.deepEqual(E.settings(input), E.DEFAULTS);
});

test('failed refresh keeps more recent in-session prices instead of old bundled prices', async () => {
    const old = { adjustment: 'qfq', code: core.code, bars: [{ date: '2026-09-01', close: 2 }], asOf: '2026-09-01', fetchedAt: '2026-09-02T09:00:00Z' };
    const recent = { ...old, bars: [{ date: '2026-09-14', close: 3 }], asOf: '2026-09-14', fetchedAt: NOW.toISOString() };
    const previous = { price: recent, points: monthly(), observation: { ...observation, indexId: core.trackIndex.code }, mode: '本次接口获取' };
    const bundle = { assets: { [core.id]: old }, valuations: {}, fetchedAt: old.fetchedAt };
    const context = vm.createContext({ require: () => E, module: { exports: {} }, setTimeout, clearTimeout, AbortController, URLSearchParams, Date,
        window: {}, document: { createElement: () => ({ remove() {} }), head: { appendChild(script) { queueMicrotask(() => script.onerror()); } } },
        fetch: async url => {
            if (url === 'data/gpt-strategy-market.json') return { ok: true, json: async () => bundle };
            throw new Error('simulated offline');
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/gpt-strategy-data.js'), 'utf8'), context);
    const result = await context.module.exports.load(core, true, previous);
    assert.equal(result.price.asOf, '2026-09-14');
    assert.equal(result.price.bars[0].close, 3);
    assert.equal(result.observation.asOf, '2026-09-14');
    assert.equal(result.points.length, previous.points.length);
    assert.ok(result.errors.length > 0);
});

test('HTML retains all four manual valuation choices and does not load the legacy app', () => {
    const html = fs.readFileSync(path.join(__dirname, '../gpt-strategy.html'), 'utf8');
    for (const band of ['low', 'fair', 'elevated', 'rich']) assert.match(html, new RegExp('<option value="' + band + '">'));
    assert.doesNotMatch(html, /<\/option\s+value=/);
    assert.doesNotMatch(html, /src="js\/(main|signal|storage|attack-pyramid)\.js/);
});

test('bundled market data has explicit identity and acquisition-time completed bars', () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gpt-strategy-market.json'), 'utf8'));
    for (const asset of E.ASSETS) {
        const price = bundle.assets[asset.id];
        assert.equal(price.code, asset.code);
        assert.equal(price.adjustment, 'qfq');
        assert.equal(price.completedOnly, true);
        assert.ok(price.bars.length > 100);
        assert.deepEqual(E.completedBars(price.bars, new Date(price.fetchedAt)), price.bars);
    }
});

test('one sufficient PE window supports a labeled reference rather than blocking the entire analysis', () => {
    const model = E.valuationModel(monthly().slice(-36), observation, null, NOW);
    assert.equal(model.usable, true);
    assert.equal(model.primary.years, 3);
    assert.equal(model.confidence, 'single-window');
    assert.equal(model.references.find(item => item.years === 5).rank, null);
});

test('genuinely contradictory valuation windows keep references but do not produce BUY or REDUCE', () => {
    const model = E.valuationModel(monthly(72, i => i < 36 ? 30 : 5), { ...observation, pe: 20 }, null, NOW);
    assert.equal(model.usable, true);
    assert.equal(model.band, 'mixed');
    assert.equal(model.references.length, 2);
    assert.equal(E.decision(tech, model, turn('trough'), 'easing').action, 'WAIT');
});

test('provider high percentile alone cannot satisfy the PE premium reduction condition', () => {
    const model = E.valuationModel([], { ...observation, providerPercentile: 99 }, null, NOW);
    assert.equal(model.mode, 'provider');
    assert.equal(model.reductionReady, false);
    assert.equal(E.decision(tech, model, turn('peak'), 'easing').action, 'NO_ADD');
});

test('inferred identity permits historical reading but not a current primary trade', () => {
    const model = E.valuationModel(monthly(), { ...observation, identityInferred: true }, null, NOW);
    assert.equal(model.fresh, true);
    assert.equal(model.usable, false);
    assert.ok(model.references.some(reference => reference.rank !== null));
    assert.match(model.reason, /身份/);
});

test('manual high valuation is an explicit user override, not a fabricated numeric validation', () => {
    const v = E.valuationModel([], null, { band: 'rich', asOf: '2026-09-14', reason: 'test user override' }, NOW);
    const result = E.decision(tech, v, null, 'easing');
    assert.equal(result.action, 'REDUCE');
    assert.equal(result.scope, '采用你的估值判断');
    assert.match(result.reason, /你/);
    assert.equal(v.primary, null);
    assert.equal(v.pe, null);
});

test('US completed bars use New York time in summer and winter, not Shanghai close', () => {
    const rows = [{ date: '2026-09-11', close: 16 }, { date: '2026-09-14', close: 30 }];
    assert.equal(E.completedBars(rows, new Date('2026-09-14T19:00:00Z'), 'us').at(-1).date, '2026-09-11');
    assert.equal(E.completedBars(rows, new Date('2026-09-14T20:45:00Z'), 'us').at(-1).date, '2026-09-14');
    assert.equal(E.clock(new Date('2026-01-05T21:15:00Z'), 'us').closed, false);
    assert.equal(E.clock(new Date('2026-01-05T21:45:00Z'), 'us').closed, true);
});

test('official VIX CSV parser validates format and excludes an ongoing US trading session', () => {
    const csv = 'DATE,OPEN,HIGH,LOW,CLOSE\n09/11/2026,16,18,15,17\n09/14/2026,17,22,17,21\n09/15/2026,20,35,18,31\n09/31/2026,10,20,10,15';
    const snapshot = D.parseVixHistory(csv, NOW);
    assert.equal(snapshot.instrumentId, 'CBOE:VIX');
    assert.equal(snapshot.market, 'us');
    assert.equal(snapshot.asOf, '2026-09-14');
    assert.equal(snapshot.bars.length, 2);
    assert.throws(() => D.parseVixHistory('<html>error</html>', NOW), /格式/);
});

test('VIX levels have limited interpretation and are never used for A-share fear', () => {
    const make = value => ({ ...E.MARKETS.us, adjustment: 'none', fetchedAt: NOW.toISOString(), asOf: '2026-09-14', bars: [{ date: '2026-09-14', close: value }] });
    assert.equal(E.sentimentModel(make(17), tech, NOW).level, 'normal');
    assert.equal(E.sentimentModel(make(20), tech, NOW).level, 'fear');
    assert.equal(E.sentimentModel(make(30), tech, NOW).level, 'panic');
    assert.equal(E.sentimentModel(make(30), core, NOW).usable, false);
    assert.equal(E.sentimentModel(make(0), tech, NOW).usable, false);
    assert.equal(E.sentimentModel(make(1000), tech, NOW).usable, false);
    assert.equal(E.sentimentModel(make(17), tech, new Date('2026-09-25T09:00:00Z')).usable, false);
});

test('A-share benchmark identity and non-adjusted request are explicit', () => {
    const payload = { rc: 0, data: { code: '000300', market: 1, klines: ['2026-09-14,4000,4100,4200,3900,100'] } };
    assert.equal(D.parseBenchmark(payload, NOW).instrumentId, '1.000300');
    assert.equal(new URL(D.benchmarkURL(NOW)).searchParams.get('fqt'), '0');
    assert.throws(() => D.parseBenchmark({ rc: 0, data: { ...payload.data, code: '000001' } }, NOW), /身份/);
});

test('20-day annualized volatility uses 20 returns with sample standard deviation', () => {
    const rows = daily(21, i => i % 2 ? 101 : 100);
    const returns = rows.slice(1).map((row, i) => Math.log(row.close / rows[i].close));
    const mean = returns.reduce((a, b) => a + b, 0) / 20;
    const expected = Math.sqrt(returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 19) * Math.sqrt(252) * 100;
    const result = E.stressSeries(rows);
    assert.equal(result[19].volatility, null);
    approximate(result[20].volatility, expected);
    assert.equal(result[20].volatilityRank, null);
});

test('stress history does not repaint after future observations are appended', () => {
    const rows = daily(500);
    const full = E.stressSeries(rows);
    for (const count of [100, 280, 430]) assert.deepEqual(E.stressSeries(rows.slice(0, count)), full.slice(0, count));
    const index = 350;
    approximate(full[index].volatilityRank, E.percentile(full[index].volatility, full.slice(0, index).map(point => point.volatility), 252));
});

test('A-share pressure needs both large drawdown and unusual volatility', () => {
    const assess = rows => {
        const now = new Date(rows.at(-1).date + 'T09:00:00Z');
        const snapshot = { ...E.MARKETS.cn, bars: rows, adjustment: 'none', asOf: rows.at(-1).date, fetchedAt: now.toISOString() };
        return E.sentimentModel(snapshot, core, now);
    };
    const calm = assess(daily(340, i => 100 * Math.exp(-i * .001)));
    assert.equal(calm.level, 'normal');
    const risingVolatile = assess(daily(340, i => i < 320 ? 100 + Math.sin(i / 7) * .2 : 100 + (i - 319) * 1.8 + (i % 2 ? 1.4 : -1.4)));
    assert.equal(risingVolatile.level, 'normal');
    const selloff = assess(daily(340, i => i < 320 ? 100 + Math.sin(i / 7) * .2 : 100 - (i - 319) * 1.8 + (i % 2 ? 1.4 : -1.4)));
    assert.equal(selloff.level, 'panic');
    assert.equal(selloff.usable, true);
    assert.match(selloff.label, /代理/);
});

test('new invalid fear snapshot cannot evict a valid older cached observation', async () => {
    const good = { ...E.MARKETS.us, adjustment: 'none', fetchedAt: '2026-09-14T23:00:00Z', asOf: '2026-09-14', bars: [{ date: '2026-09-14', close: 17 }] };
    const context = vm.createContext({ require: () => E, module: { exports: {} }, setTimeout, clearTimeout, AbortController, Date,
        fetch: async url => ({ ok: true, json: async () => ({ snapshots: { us: { ...good, fetchedAt: undefined, asOf: '2099-01-01' } } }) }),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/gpt-strategy-data.js'), 'utf8'), context);
    const result = await context.module.exports.loadSentiment(tech, false, good);
    assert.equal(result.snapshot.asOf, good.asOf);
    assert.equal(result.snapshot.fetchedAt, good.fetchedAt);
});

test('fear snapshots validate capture time and metadata instead of trusting a recent date string', () => {
    const good = { ...E.MARKETS.us, adjustment: 'none', fetchedAt: NOW.toISOString(), asOf: '2026-09-14', bars: [{ date: '2026-09-14', close: 17 }] };
    for (const patch of [{ fetchedAt: null }, { fetchedAt: '2099-01-01T00:00:00Z' }, { asOf: '2099-01-01' }, { bars: null }, { instrumentId: '1.000300' }, { adjustment: 'qfq' }]) {
        assert.equal(E.marketBars({ ...good, ...patch }, tech, NOW), null);
        assert.equal(E.sentimentModel({ ...good, ...patch }, tech, NOW).usable, false);
    }
});

test('both bundled fear references are dated real completed-market observations', () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gpt-strategy-sentiment.json'), 'utf8'));
    for (const asset of [core, tech]) {
        const snapshot = bundle.snapshots[E.marketFor(asset)];
        const now = new Date(snapshot.fetchedAt);
        const result = E.sentimentModel(snapshot, asset, now);
        assert.equal(result.usable, true);
        assert.equal(result.asOf, snapshot.asOf);
        assert.equal(snapshot.adjustment, 'none');
    }
});

test('main and tactical explanation remain separate DOM sections', () => {
    const html = fs.readFileSync(path.join(__dirname, '../gpt-strategy.html'), 'utf8');
    assert.match(html, /id="decision-title"/);
    assert.match(html, /id="tactical-title"/);
    assert.match(html, /id="sentiment-summary"/);
    assert.match(html, /人工估值是独立覆盖/);
    assert.doesNotMatch(html, /估值相对低位、低位转折已确认同时成立/);
});
