const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function env() {
    const context = vm.createContext({ Date, Intl, console, GptStrategyData: { priceMarket: asset => asset.market === 'HK' ? 'hk' : 'cn' } });
    for (const file of ['etf-config', 'gpt-strategy-engine', 'bottom-screener', 'candidate-view']) vm.runInContext(fs.readFileSync(path.join(root, 'js', file + '.js'), 'utf8'), context);
    return vm.runInContext('({B:BottomScreener,E:GptStrategyEngine,C:ETF_CONFIG,V:CandidateView})', context);
}
const NOW = new Date('2026-09-21T02:00:00Z');
const asset = { id: 'bank', code: '512800', secid: '1.512800', market: 'SH', type: 'a_share_index', family: '金融', shortName: '银行', group: 'ATTACK' };
function bars(closes) {
    const dates = [], date = new Date('2026-09-18T00:00:00Z');
    while (dates.length < closes.length) {
        if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.unshift(date.toISOString().slice(0, 10));
        date.setUTCDate(date.getUTCDate() - 1);
    }
    return closes.map((close, i) => ({ date: dates[i], close }));
}
function record(closes = [...Array(270).fill(110), ...Array.from({ length: 30 }, (_, i) => 110 - 2 * (i + 1))]) {
    return { asset: { ...asset }, parts: { price: 'ready' }, priceResult: { price: { code: asset.code, secid: asset.secid, market: 'cn',
        adjustment: 'qfq', fetchedAt: '2026-09-18T10:00:00Z', source: 'test fixture', bars: bars(closes) } } };
}
const votes = { roc: { vote: -1 }, pe: { vote: null } };
const recovery = [...Array(270).fill(110), ...Array.from({ length: 30 }, (_, i) => 108 - 2 * i), ...Array.from({ length: 20 }, (_, i) => 51.5 + 1.5 * i)];

test('12 verified additions preserve existing assets, have unique identities and no invented valuation mappings', () => {
    const { C } = env(), additions = C.ETF_LIST.filter(item => item.priceOnly);
    assert.equal(C.ETF_LIST.length, 38); assert.equal(additions.length, 12);
    assert.equal(new Set(C.ETF_LIST.map(item => item.id)).size, 38);
    assert.equal(new Set(C.ETF_LIST.map(item => item.code)).size, 38);
    for (const item of additions) {
        assert.equal(item.history, null); assert.equal(item.trackIndex.danjuanCode, null);
        assert.equal(item.valuationCapability, 'price-only'); assert.ok(item.identitySource.endsWith(item.code + '.html'));
        assert.equal(item.secid, (item.market === 'SH' ? '1.' : '0.') + item.code);
    }
    assert.equal(C.getETFById('machine-tool').code, '159663'); assert.equal(C.getETFById('pcb').code, '515260');
});

test('price position and current drawdown use 252 closes, not ROC or historical max drawdown', () => {
    const { B } = env(), rows = bars([...Array(251).fill(150), 120]); rows[0].close = 200; rows[1].close = 100;
    const m = B.windowMetrics(rows, 251);
    assert.equal(m.position, 20); assert.equal(m.drawdown, -40); assert.equal(m.lowZone, true);
    rows.at(-1).close = 140; assert.equal(B.windowMetrics(rows, 251).lowZone, true);
    rows.at(-1).close = 140.001; assert.equal(B.windowMetrics(rows, 251).lowZone, false);
    assert.equal(B.windowMetrics(rows.slice(0, 251), 250), null);
    rows[0].date = '2020-01-01'; assert.equal(B.windowMetrics(rows, 251), null);
});

test('low prices while still declining are labeled low but unstable, never confirmed bottom', () => {
    const { B } = env(), result = B.analyze(record(), votes, NOW);
    assert.equal(result.state, 'falling'); assert.equal(result.eligible, true);
    assert.equal(result.valuationSupport, false); assert.equal(result.valuationLabel, '仅价格依据');
    assert.equal(result.gate, '不卖 / 不减'); assert.equal(result.rebound, null);
});

test('improvement requires rising daily momentum and non-declining close while in a low zone', () => {
    const { B } = env(), result = B.analyze(record(recovery.slice(0, 308)), votes, NOW);
    assert.equal(result.state, 'improving'); assert.equal(result.eligible, true);
    assert.match(result.reason, /并非确认见底/);
    assert.equal(result.position <= 40, true);
});

test('rebounds remain tracked after leaving low zone and gains begin at a prior confirmation close', () => {
    const { B } = env(), r = record(recovery), c = B.analyze(r, { roc: { vote: 1 } }, NOW);
    assert.equal(c.state, 'rebound'); assert.equal(c.gate, '不买 / 不加');
    const entry = r.priceResult.price.bars.find(bar => bar.date === c.entryDate);
    assert.ok(entry); assert.ok(c.entryDate < c.asOf);
    assert.equal(c.rebound, (recovery.at(-1) / entry.close - 1) * 100);
    const entryIndex = r.priceResult.price.bars.indexOf(entry);
    const prefix = structuredClone(r); prefix.priceResult.price.bars = prefix.priceResult.price.bars.slice(0, entryIndex + 1);
    prefix.priceResult.price.fetchedAt = entry.date + 'T10:00:00Z';
    assert.equal(B.analyze(prefix, votes, new Date(entry.date + 'T12:00:00Z')).state, 'improving');
    const old = record([...recovery, ...Array(25).fill(90)]);
    assert.equal(B.analyze(old, votes, NOW).state, 'normal');
});

test('short, constant, stale, raw and wrong-identity histories cannot be effective candidates', () => {
    const { B } = env();
    const cases = [record(Array(100).fill(1)), record(Array(300).fill(1))];
    const stale = record(); stale.priceResult.price.bars = stale.priceResult.price.bars.slice(0, -20); cases.push(stale);
    const raw = record(); raw.priceResult.price.adjustment = 'raw'; cases.push(raw);
    const unknown = record(); delete unknown.priceResult.price.adjustment; cases.push(unknown);
    const wrong = record(); wrong.priceResult.price.secid = '0.512800'; cases.push(wrong);
    const future = record(); future.priceResult.price.fetchedAt = '2027-01-01'; cases.push(future);
    for (const r of cases) { const c = B.analyze(r, votes, NOW); assert.equal(c.eligible, false); assert.ok(['reference', 'pending'].includes(c.state)); }
    assert.equal(B.analyze(stale, votes, NOW).asOf, stale.priceResult.price.bars.at(-1).date);
});

test('cached intraday bars do not become completed bars after the close', () => {
    const { B } = env(), r = record();
    r.priceResult.price.fetchedAt = '2026-09-21T02:00:00Z';
    r.priceResult.price.bars.push({ date: '2026-09-21', close: 30 });
    assert.equal(B.analyze(r, votes, new Date('2026-09-21T12:00:00Z')).asOf, '2026-09-18');
});

test('in-flight refresh hides prior candidates; failure fallback retains original observation date', () => {
    const { B } = env(), r = record(); r.parts.price = 'loading';
    assert.equal(B.analyze(r, votes, NOW).eligible, false);
    r.parts.price = 'fallback'; const c = B.analyze(r, votes, NOW);
    assert.equal(c.eligible, true); assert.equal(c.fallback, true); assert.equal(c.asOf, '2026-09-18');
    assert.match(c.trustLabel, /失败回退/);
});

test('valuation support excludes proxy, reference and price-only evidence and never changes ROC gates', () => {
    const { B } = env(), r = record(), evidence = { roc: { vote: 1 }, pe: { vote: -1, reference: false } };
    assert.equal(B.analyze(r, evidence, NOW).valuationSupport, true);
    assert.equal(B.analyze(r, evidence, NOW).gate, '不买 / 不加');
    evidence.pe.reference = true; assert.equal(B.analyze(r, evidence, NOW).valuationSupport, false);
    evidence.pe.reference = false; r.asset.trackIndex = { isProxy: true }; assert.equal(B.analyze(r, evidence, NOW).valuationSupport, false);
    r.asset.trackIndex = {}; r.asset.priceOnly = true; assert.equal(B.analyze(r, evidence, NOW).valuationSupport, false);
});

test('non-stock assets and individual stock remain outside ETF candidates', () => {
    const { B } = env();
    for (const patch of [{ id: 'vix-dashboard' }, { id: 'tencent-hk' }, { type: 'gold' }, { type: 'bond' }, { type: 'commodity' }]) {
        const r = record(); Object.assign(r.asset, patch); assert.equal(B.analyze(r, votes, NOW).state, 'excluded');
    }
});

test('filters compose, unavailable records sort last, and shortlist preserves different indices in the same family', () => {
    const { B } = env();
    const items = ['improving', 'improving', 'rebound', 'falling', 'pending'].map((state, i) => ({
        asset: { id: String(i), code: '51200' + i, name: 'ETF' + i, group: 'ATTACK' },
        model: { candidate: { state, eligible: state !== 'pending', position: 10 - i, drawdown: -20 - i,
            family: i < 2 ? '科技' : '金融', sector: '板块' + i, valuationSupport: i === 0 } }
    }));
    assert.equal(B.select(items, { filter: 'improving' }).length, 2);
    assert.equal(B.select(items, { filter: 'supported' }).length, 1);
    assert.equal(B.select(items, { filter: 'favorites', favorites: ['3'] })[0].asset.id, '3');
    assert.equal(B.select(items, { query: '板块2', family: '金融' })[0].asset.id, '2');
    assert.equal(B.select(items, { sort: 'drawdown' }).at(-1).asset.id, '4');
    assert.equal(B.shortlist(items).length, 4);
    assert.equal(B.select(items, { onlyIssues: true }).length, 1);
    assert.equal(items[0].asset.id, '0');
});

test('candidate HTML exposes accessible filtering and preserves original tiers', () => {
    const html = fs.readFileSync(path.join(root, 'overview.html'), 'utf8');
    for (const id of ['candidate-panel', 'candidate-filter', 'candidate-family', 'candidate-sort', 'candidate-rows', 'lane-low', 'lane-risk', 'lane-normal']) assert.ok(html.includes('id="' + id + '"'));
    assert.match(html, /不是估值分位/); assert.match(html, /未经收益优化/);
});

test('raw HSTECH, energy storage and software show exactly the detail-engine daily ROC without becoming candidates', () => {
    const { B, E, C, V } = env();
    for (const id of ['hstech', 'energy-storage', 'software']) {
        const r = record(recovery); r.asset = C.getETFById(id);
        Object.assign(r.priceResult.price, { code: r.asset.code, secid: r.asset.secid, adjustment: 'raw' });
        const p = r.priceResult.price, detail = E.rocModel(p.bars, E.DEFAULTS, NOW, 'cn');
        const result = B.analyze(r, votes, NOW);
        assert.equal(result.rank, detail.last.rank, id); assert.equal(result.rocValue, detail.last.roc, id);
        assert.equal(result.rocSmooth, detail.last.smooth, id);
        assert.equal(result.state, 'reference'); assert.equal(result.eligible, false); assert.equal(result.entryDate, undefined);
        for (const key of ['rank', 'position', 'drawdown']) {
            const display = V.metricPresentation(result, key);
            assert.notEqual(display.value, '—', `${id} ${key}`);
            assert.ok(display.notes.includes('未复权参考'));
        }
        p.adjustment = 'qfq';
        const adjusted = B.analyze({ ...r, priceResult: { price: { ...p } } }, votes, NOW);
        assert.equal(adjusted.rank, result.rank);
    }
});

test('ROC has its own 13/18/144 sample boundaries and need not wait for 252 price samples', () => {
    const { B, E, V } = env();
    for (const count of [12, 13, 17, 18, 138, 139, 143, 144, 251, 252]) {
        const r = record(Array.from({ length: count }, (_, i) => 100 + Math.sin(i / 4) * 5 + i / 50));
        const c = B.analyze(r, votes, NOW), model = E.rocModel(r.priceResult.price.bars, E.DEFAULTS, NOW, 'cn');
        assert.equal(c.rocValue, count < 13 ? null : model.last.roc);
        assert.equal(c.rocSmooth, count < 18 ? null : model.last.smooth);
        assert.equal(c.rank, count < 144 ? null : model.last.rank);
        assert.equal(c.rocRank, count < 139 ? null : model.last.rocRank);
        if (count < 139) assert.match(V.metricPresentation(c, 'rocRank').notes[0], /ROC12样本不足/);
        else assert.notEqual(V.metricPresentation(c, 'rocRank').value, '—');
        if (count < 252) { assert.equal(c.eligible, false); assert.equal(c.position, null); assert.match(V.metricPresentation(c, 'position').notes[0], /价格样本不足/); }
        if (count < 144) assert.match(V.metricPresentation(c, 'rank').notes[0], /ROC均线样本不足/);
        else assert.notEqual(V.metricPresentation(c, 'rank').value, '—');
    }
});

test('a flat price window retains zero ROC and 50th percentile while candidate position remains undefined', () => {
    const { B, V } = env(), c = B.analyze(record(Array(300).fill(100)), votes, NOW);
    assert.equal(c.position, null); assert.equal(c.drawdown, 0); assert.equal(c.rank, 50);
    assert.equal(c.rocValue, 0); assert.equal(c.rocSmooth, 0); assert.equal(c.eligible, false);
    assert.match(V.metricPresentation(c, 'position').notes[0], /区间价格无变化/);
    assert.equal(V.metricPresentation(c, 'drawdown').value, '0.0%');
});

test('sparse or expired price windows do not erase an independently computable historical ROC', () => {
    const { B, E, V } = env(), sparse = record();
    sparse.priceResult.price.bars = sparse.priceResult.price.bars.map((bar, i, rows) => ({ ...bar,
        date: new Date(Date.parse('2026-09-18') - (rows.length - 1 - i) * 3 * 86400000).toISOString().slice(0, 10) }));
    const c = B.analyze(sparse, votes, NOW);
    assert.equal(c.eligible, false); assert.equal(c.position, null); assert.ok(Number.isFinite(c.rank));
    assert.match(c.priceMissing, /400天/);
    for (const age of [7, 8]) {
        const r = record(recovery), now = new Date(`2026-09-${18 + age}T10:00:00Z`);
        const result = B.analyze(r, votes, now);
        assert.equal(result.rank, E.rocModel(r.priceResult.price.bars, E.DEFAULTS, now, 'cn').last.rank);
        assert.equal(result.stale, age > 7); assert.equal(result.eligible, age <= 7);
        assert.equal(result.asOf, '2026-09-18');
        assert.equal(V.metricPresentation(result, 'rank').notes.includes('已过期 · 历史参考'), age > 7);
    }
});

test('missing today uses latest completed observation, but bad identity, future timestamps or in-flight requests never leak ROC', () => {
    const { B } = env(), r = record();
    const value = B.analyze(r, votes, NOW);
    assert.ok(Number.isFinite(value.rank)); assert.equal(value.asOf, '2026-09-18');
    for (const patch of [copy => { copy.parts.price = 'loading'; }, copy => { copy.priceResult.price.code = 'WRONG'; },
        copy => { copy.priceResult.price.fetchedAt = '2027-01-01'; }]) {
        const copy = structuredClone(r); patch(copy);
        assert.equal(B.analyze(copy, votes, NOW).rank, null);
    }
});

test('returning to a later date invalidates cached freshness without changing historical ROC', () => {
    const { B, V } = env(), r = record();
    const original = B.analyze(r, votes, NOW);
    r.parts.price = 'fallback';
    const later = B.analyze(r, votes, new Date('2026-09-30T10:00:00Z'));
    assert.equal(later.rank, original.rank); assert.equal(later.eligible, false); assert.equal(later.stale, true);
    assert.ok(V.metricPresentation(later, 'rank').notes.includes('失败回退'));
    assert.ok(V.metricPresentation(later, 'position').notes.includes('已过期 · 历史参考'));
});

test('fresh low raw prices enter only the reference pool, regardless of momentum or valuation support', () => {
    const { B, C } = env();
    for (const id of ['hstech', 'energy-storage', 'software']) {
        const r = record(recovery.slice(0, 308)); r.asset = C.getETFById(id);
        Object.assign(r.priceResult.price, { code: r.asset.code, secid: r.asset.secid, adjustment: 'raw' });
        for (const vote of [-1, 0, 1]) {
            const c = B.analyze(r, { roc: { vote }, pe: { vote: -1, reference: false } }, NOW);
            assert.equal(c.referenceEligible, true); assert.equal(c.watchLevel, 'reference');
            assert.equal(c.eligible, false); assert.equal(c.state, 'reference');
            assert.match(c.label, /低位参考/); assert.equal(c.entryDate, undefined); assert.equal(c.rebound, undefined);
            assert.equal(c.gate, vote === -1 ? '不卖 / 不减' : vote === 1 ? '不买 / 不加' : '区间内');
            const item = { asset: r.asset, model: { candidate: c } };
            assert.equal(B.select([item], { filter: 'references' }).length, 1);
            assert.equal(B.select([item], { filter: 'low-watch' }).length, 1);
            for (const filter of ['candidates', 'improving', 'rebound', 'falling', 'pending'])
                assert.equal(B.select([item], { filter }).length, 0, filter);
        }
    }
});

test('reference pool still rejects expired, wrong-identity, future, short, flat, unknown and non-low records', () => {
    const { B } = env();
    const raw = () => { const r = record(); r.priceResult.price.adjustment = 'raw'; return r; };
    const patches = [r => { r.priceResult.price.code = 'OTHER'; }, r => { r.priceResult.price.fetchedAt = '2027-01-01'; },
        r => { r.priceResult.price.bars = r.priceResult.price.bars.slice(0, -30); },
        r => { r.priceResult.price.bars = r.priceResult.price.bars.slice(-251); },
        r => { r.priceResult.price.bars.forEach(bar => { bar.close = 50; }); },
        r => { r.priceResult.price.bars = bars(Array.from({ length: 300 }, (_, i) => i + 10)); },
        r => { delete r.priceResult.price.adjustment; }, r => { r.parts.price = 'loading'; },
        r => { r.priceResult = null; }];
    for (const patch of patches) {
        const r = raw(); patch(r); const c = B.analyze(r, votes, NOW);
        assert.equal(c.referenceEligible, false); assert.equal(c.eligible, false); assert.equal(c.watchLevel, 'none');
        assert.equal(B.select([{ asset: r.asset, model: { candidate: c } }], { filter: 'low-watch' }).length, 0);
    }
    const r = raw(); r.parts.price = 'fallback';
    const c = B.analyze(r, votes, NOW); assert.equal(c.referenceEligible, true); assert.equal(c.fallback, true);
    assert.equal(c.asOf, '2026-09-18');
});

test('all-low filter composes with favorites, search and family while preserving separate credibility ordering', () => {
    const { B } = env();
    const confirmedRecord = record(), referenceRecord = record(); referenceRecord.priceResult.price.adjustment = 'raw';
    const confirmed = B.analyze(confirmedRecord, votes, NOW), reference = B.analyze(referenceRecord, votes, NOW);
    const items = [
        { asset: { ...asset, id: 'ref', code: '512801', name: '参考银行' }, model: { candidate: { ...reference, position: 1 } } },
        { asset: { ...asset, id: 'ok', name: '银行' }, model: { candidate: { ...confirmed, position: 10 } } }
    ];
    const all = B.select(items, { filter: 'low-watch', sort: 'position', family: '金融' });
    assert.equal(all.length, 2); assert.equal(all[0].asset.id, 'ok');
    assert.equal(B.select(items, { filter: 'favorites', favorites: ['ref'] })[0].model.candidate.watchLevel, 'reference');
    assert.equal(B.select(items, { filter: 'references', query: '参考', group: 'ATTACK' }).length, 1);
    assert.equal(B.select(items, { filter: 'references', family: '科技' }).length, 0);
    assert.equal(B.select(items, { filter: 'candidates' }).length, 1);
});

test('summary keeps same-family indices, merges known target-index identities, and never guesses from proxy or missing codes', () => {
    const { B } = env();
    const c = { state: 'falling', eligible: true, watchLevel: 'confirmed', family: '科技', position: 10 };
    const item = (id, trackIndex) => ({ asset: { id, code: id, trackIndex }, model: { candidate: c } });
    const items = [item('a', { code: 'SH000300' }), item('b', { code: '000300' }),
        item('c', { code: '931643', danjuanCode: 'SZ399006', isProxy: true }),
        item('d', { code: '399673', danjuanCode: 'SZ399006', isProxy: true }),
        item('e', { code: null, name: '相同名称' }), item('f', { code: null, name: '相同名称' }),
        item('g', { code: '000688' }), item('h', { code: '000689' })];
    assert.equal(B.shortlist(items).length, 6);
    const all = B.shortlist(items, Infinity);
    assert.equal(all.length, 7); assert.ok(all.some(row => row.asset.id === 'c')); assert.ok(all.some(row => row.asset.id === 'd'));
    assert.ok(all.some(row => row.asset.id === 'e')); assert.ok(all.some(row => row.asset.id === 'f'));
    assert.equal(B.select(items, { filter: 'candidates' }).length, 8);
    const refs = items.map(row => ({ ...row, model: { candidate: { ...c, state: 'reference', eligible: false, referenceEligible: true, watchLevel: 'reference' } } }));
    assert.equal(B.shortlist(refs, 6, 'references').length, 6);
    assert.equal(B.shortlist(refs, Infinity, 'references').length, 7);
    assert.equal(B.shortlist(refs).length, 0);
});

test('each refresh can move a reference into confirmed or pending without retaining prior eligibility', () => {
    const { B } = env(), raw = record(); raw.priceResult.price.adjustment = 'raw';
    const first = B.analyze(raw, votes, NOW); assert.equal(first.referenceEligible, true);
    const live = structuredClone(raw); live.priceResult.price.adjustment = 'qfq';
    const second = B.analyze(live, votes, NOW); assert.equal(second.eligible, true); assert.equal(second.referenceEligible, false);
    const expired = B.analyze(raw, votes, new Date('2026-09-30T10:00:00Z'));
    assert.equal(expired.referenceEligible, false); assert.equal(expired.watchLevel, 'none');
    assert.equal(first.referenceEligible, true);
});

test('page defaults to both low tiers, exposes independent show-all controls and retains the full universe', () => {
    const html = fs.readFileSync(path.join(root, 'overview.html'), 'utf8');
    assert.match(html, /value="opportunity-watch" selected/);
    assert.match(html, /value="low-watch">仅年度价格低位/);
    assert.match(html, /value="correction-watch">仅超跌回调/);
    for (const id of ['confirmed-count', 'reference-count', 'confirmed-more', 'reference-more', 'reference-shortlist']) assert.ok(html.includes('id="' + id + '"'));
    assert.match(html, /value="all">全部板块/); assert.match(html, /value="favorites">我的关注/);
    assert.ok(!html.includes('每类最多1只'));
});

const crest = [...Array(270).fill(50), ...Array.from({ length: 30 }, (_, i) => 52 + 2 * i), ...Array.from({ length: 20 }, (_, i) => 109 - i)];

test('high position includes exactly 80 but is not an automatic turn or sell alert', () => {
    const { B } = env(), rows = bars(Array(252).fill(150)); rows[0].close = 100; rows[1].close = 200;
    rows.at(-1).close = 180; assert.equal(B.windowMetrics(rows, 251).highZone, true);
    rows.at(-1).close = 179.999; assert.equal(B.windowMetrics(rows, 251).highZone, false);
    const r = record(Array.from({ length: 300 }, (_, i) => 50 + i / 3));
    const c = B.analyze(r, { roc: { vote: 1 } }, NOW);
    assert.equal(c.risk.state, 'high'); assert.equal(c.risk.eligible, true);
    assert.equal(c.gate, '不买 / 不加');
    assert.equal(B.select([{ asset, model: { candidate: c } }], { filter: 'risk-alerts' }).length, 0);
    assert.equal(B.attention(c, 'high').group, 'observe');
});

test('high weakening uses price plus momentum decline and never overrides the no-sell ROC gate', () => {
    const { B } = env(), r = record(crest.slice(0, 308));
    const c = B.analyze(r, votes, NOW);
    assert.equal(c.risk.state, 'weakening'); assert.equal(c.risk.eligible, true);
    assert.equal(c.gate, '不卖 / 不减'); assert.equal(B.attention(c, 'high').group, 'priority');
    assert.equal(B.select([{ asset, model: { candidate: c } }], { filter: 'risk-alerts' }).length, 1);
    assert.match(c.risk.reason, /不等于卖出指令/);
});

test('pullback tracks a past high weakening confirmation without lookahead, and expires after 20 sessions', () => {
    const { B } = env(), r = record(crest), c = B.analyze(r, votes, NOW);
    assert.equal(c.risk.state, 'pullback');
    const rows = r.priceResult.price.bars, i = rows.findIndex(row => row.date === c.risk.entryDate);
    assert.ok(i >= 0 && i < rows.length - 1);
    assert.equal(c.risk.change, (rows.at(-1).close / rows[i].close - 1) * 100);
    const prefix = structuredClone(r); prefix.priceResult.price.bars = rows.slice(0, i + 1);
    prefix.priceResult.price.fetchedAt = rows[i].date + 'T10:00:00Z';
    assert.equal(B.analyze(prefix, votes, new Date(rows[i].date + 'T12:00:00Z')).risk.state, 'weakening');
    assert.equal(B.analyze(record([...crest, ...Array(25).fill(80)]), votes, NOW).risk.state, 'normal');
});

test('raw high prices are reference-only and stale or invalid snapshots produce no current risk signal', () => {
    const { B } = env(), r = record(crest.slice(0, 308)); r.priceResult.price.adjustment = 'raw';
    const c = B.analyze(r, votes, NOW);
    assert.equal(c.risk.state, 'reference'); assert.equal(c.risk.referenceEligible, true); assert.equal(c.risk.eligible, false);
    assert.equal(c.risk.entryDate, null); assert.equal(c.risk.change, null);
    assert.equal(B.attention(c, 'high').group, 'verify');
    assert.equal(B.select([{ asset, model: { candidate: c } }], { filter: 'risk-alerts' }).length, 0);
    for (const patch of [copy => { copy.priceResult.price.code = 'BAD'; }, copy => { copy.priceResult.price.bars = copy.priceResult.price.bars.slice(-200); },
        copy => { copy.priceResult.price.fetchedAt = '2027-01-01'; }, copy => { copy.parts.price = 'loading'; },
        copy => { copy.priceResult.price.bars = copy.priceResult.price.bars.slice(0, -30); }]) {
        const copy = structuredClone(r); patch(copy); const risk = B.analyze(copy, votes, NOW).risk;
        assert.equal(risk.eligible, false); assert.equal(risk.referenceEligible, false);
    }
    assert.equal(B.analyze(r, votes, new Date('2026-09-30T10:00:00Z')).risk.referenceEligible, false);
});

test('research priority does not promote raw low prices or plain high prices above change signals', () => {
    const { B } = env();
    const low = B.analyze(record(recovery.slice(0, 308)), votes, NOW);
    const falling = B.analyze(record(), votes, NOW);
    const raw = record(); raw.priceResult.price.adjustment = 'raw'; const ref = B.analyze(raw, votes, NOW);
    assert.equal(B.attention(low).group, 'priority'); assert.equal(B.attention(falling).group, 'observe'); assert.equal(B.attention(ref).group, 'verify');
    const weak = B.analyze(record(crest.slice(0, 308)), votes, NOW);
    const high = B.analyze(record(Array.from({length:300},(_,i)=>50+i)), votes, NOW);
    const items = [high, weak].map((candidate,i)=>({asset:{...asset,id:String(i),code:String(i)},model:{candidate}}));
    assert.equal(B.select(items,{filter:'high-watch'})[0].model.candidate.risk.state,'weakening');
    assert.equal(B.attention(weak,'all').side,'high');
});

test('risk-only ETFs are discoverable without PE and both views preserve independently computed ROC', () => {
    const { B, C, E } = env(), r = record(crest.slice(0, 308)); r.asset = C.getETFById('software');
    Object.assign(r.priceResult.price,{code:r.asset.code,secid:r.asset.secid});
    const c = B.analyze(r, votes, NOW);
    assert.equal(c.risk.eligible,true); assert.equal(c.valuationSupport,false);
    assert.equal(c.rank,E.rocModel(r.priceResult.price.bars,E.DEFAULTS,NOW,'cn').last.rank);
    for(const filter of ['high-watch','risk-alerts','weakening']) assert.equal(B.select([{asset:r.asset,model:{candidate:c}}],{filter}).length,1);
    assert.equal(B.select([{asset:r.asset,model:{candidate:c}}],{filter:'low-watch'}).length,0);
});

test('oversold entry uses real rank boundaries and negative returns, not price or fund-specific thresholds', () => {
    const { B } = env();
    for (const rank of [0, 10, 20]) assert.equal(B.oversold(rank, -0.1, -0.2), true);
    for (const rank of [20.00001, -1, null, undefined, NaN, Infinity]) assert.equal(B.oversold(rank, -1, -1), false);
    for (const [value, smooth] of [[0, -1], [-1, 0], [1, -1], [-1, 1], [null, -1]]) assert.equal(B.oversold(0, value, smooth), false);
});

const correctionCloses = [...Array.from({ length: 290 }, (_, i) => 80 + i * 0.2), ...Array.from({ length: 10 }, (_, i) => 137 - i)];

test('recent declines enter at a non-low annual position without 25 percent drawdown or verified PE', () => {
    const { B, C } = env();
    for (const id of ['chemical', 'agriculture', 'dow-jones']) {
        const r = record(correctionCloses); r.asset = C.getETFById(id);
        Object.assign(r.priceResult.price, { code: r.asset.code, secid: r.asset.secid, adjustment: 'raw' });
        const c = B.analyze(r, votes, NOW);
        assert.equal(c.lowZone, false); assert.ok(c.drawdown > -25); assert.equal(c.referenceEligible, false);
        assert.equal(c.correction.referenceEligible, true); assert.equal(c.correction.eligible, false);
        assert.equal(c.correction.entryDate, null); assert.equal(c.correction.change, null);
        assert.ok(Number.isFinite(c.correction.recentDrawdown));
        assert.equal(B.attention(c).state, 'correction-reference'); assert.equal(B.attention(c).group, 'verify');
        assert.match(B.attention(c).reason, /并非年度低位/);
        const item = { asset: r.asset, model: { candidate: c } };
        for (const filter of ['opportunity-watch', 'correction-watch', 'correction-references']) assert.equal(B.select([item], { filter }).length, 1);
        for (const filter of ['low-watch', 'opportunities', 'correction-improving']) assert.equal(B.select([item], { filter }).length, 0);
        assert.match(B.explain(c), /本项不满足/); assert.match(B.explain(c), /进入超跌回调线索/);
    }
});

test('144-251 completed bars can support independent correction while annual price position remains unknown', () => {
    const { B } = env();
    for (const count of [143, 144, 200, 251, 252]) {
        const r = record(correctionCloses.slice(-count));
        const c = B.analyze(r, votes, NOW);
        assert.equal(c.correction.eligible, count >= 144);
        if (count < 252) { assert.equal(c.position, null); assert.equal(c.eligible, false); }
        if (count >= 144 && count < 252) assert.match(B.attention(c).reason, /年度价格位置未知/);
    }
});

function correctionFixture(count = 210) {
    const rows = bars(Array(count).fill(100));
    const roc = { ranks: Array(count).fill(50), roc: Array(count).fill(0), smooth: Array(count).fill(0), last: { rank: 50 } };
    const seed = 180;
    rows[seed].close = 95; rows[seed + 1].close = 96; rows[seed + 2].close = 97;
    roc.ranks[seed] = 10; roc.roc[seed] = -5; roc.smooth[seed] = -5;
    roc.smooth[seed + 1] = -4; roc.smooth[seed + 2] = -3;
    return { rows, roc, seed, confirmed: seed + 2 };
}

test('correction improvement can follow a rank exit, uses first confirmation, and tracks only 20 sessions', () => {
    const { B } = env(), f = correctionFixture();
    const at = (i, adjustment = 'qfq') => B.correctionModel(f.rows.slice(0, i + 1), { ...f.roc,
        ranks: f.roc.ranks.slice(0, i + 1), roc: f.roc.roc.slice(0, i + 1), smooth: f.roc.smooth.slice(0, i + 1), last: { rank: f.roc.ranks[i] } }, adjustment, false);
    assert.equal(at(f.seed).state, 'watch');
    const confirmed = at(f.confirmed);
    assert.equal(confirmed.state, 'improving'); assert.equal(confirmed.triggered, false);
    assert.equal(confirmed.seedDate, f.rows[f.seed].date); assert.equal(confirmed.entryDate, f.rows[f.confirmed].date);
    assert.equal(at(f.confirmed + 1).entryDate, confirmed.entryDate);
    const atLimit = at(f.confirmed + 20);
    assert.equal(atLimit.state, 'tracking'); assert.equal(atLimit.entryDate, confirmed.entryDate);
    assert.equal(atLimit.change, (100 / 97 - 1) * 100);
    assert.equal(at(f.confirmed + 21).eligible, false);
    assert.equal(at(f.confirmed, 'raw').eligible, false); assert.equal(at(f.confirmed, 'raw').entryDate, null);
    f.rows[f.confirmed + 10].close = 96;
    assert.equal(at(f.confirmed + 10).eligible, false);
});

test('correction gates reject unknown adjustment, stale, future, sparse and wrong-identity observations', () => {
    const { B } = env();
    const patches = [r => { r.priceResult.price.adjustment = 'unknown'; }, r => { r.parts.price = 'loading'; },
        r => { r.priceResult.price.code = 'wrong'; }, r => { r.priceResult.price.fetchedAt = '2027-01-01'; },
        r => { r.priceResult.price.bars = r.priceResult.price.bars.slice(0, -30); },
        r => { r.priceResult.price.bars = r.priceResult.price.bars.map((bar, i, all) => ({ ...bar, date: new Date(Date.parse('2026-09-18') - (all.length - 1 - i) * 3 * 86400000).toISOString().slice(0, 10) })); }];
    for (const patch of patches) {
        const r = record(correctionCloses); patch(r); const c = B.analyze(r, votes, NOW);
        assert.equal(c.correction.eligible, false); assert.equal(c.correction.referenceEligible, false);
        assert.equal(B.select([{ asset, model: { candidate: c } }], { filter: 'correction-watch' }).length, 0);
    }
    const stale = B.analyze(record(correctionCloses), votes, new Date('2026-09-30T10:00:00Z'));
    assert.equal(stale.correction.eligible, false); assert.ok(Number.isFinite(stale.rank));
});

test('opportunity union keeps one row for overlapping low and correction entries without changing trade gates', () => {
    const { B } = env(), r = record();
    for (const vote of [-1, 0, 1]) {
        const c = B.analyze(r, { roc: { vote } }, NOW);
        assert.equal(c.eligible, true); assert.equal(c.correction.eligible, true);
        const item = { asset, model: { candidate: c } };
        assert.equal(B.select([item], { filter: 'opportunity-watch' }).length, 1);
        assert.ok(B.entryTags(c).includes('年度价格低位')); assert.ok(B.entryTags(c).includes('动量超跌回调'));
        assert.equal(c.gate, vote < 0 ? '不卖 / 不减' : vote > 0 ? '不买 / 不加' : '区间内');
    }
});

test('low-rank positive returns are not pulled into correction watch and missing prices remain explicit', () => {
    const { B } = env();
    const r = record(Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.log(i + 1)));
    const c = B.analyze(r, votes, NOW);
    assert.ok(c.rank <= 20); assert.ok(c.rocValue > 0);
    assert.equal(c.correction.eligible, false); assert.equal(c.correction.triggered, false);
    assert.match(B.explain(c), /未满足/);
    const missing = B.analyze({ asset, parts: { price: 'failed' }, priceResult: null }, votes, NOW);
    assert.equal(missing.correction.eligible, false); assert.match(B.explain(missing), /价格请求失败/);
});

test('fallback keeps date and correction reference while refresh and later expiry clear eligibility', () => {
    const { B } = env(), r = record(correctionCloses); r.priceResult.price.adjustment = 'raw'; r.parts.price = 'fallback';
    const current = B.analyze(r, votes, NOW);
    assert.equal(current.correction.referenceEligible, true); assert.equal(current.asOf, '2026-09-18'); assert.equal(current.fallback, true);
    r.parts.price = 'loading'; assert.equal(B.analyze(r, votes, NOW).correction.referenceEligible, false);
    r.parts.price = 'fallback'; assert.equal(B.analyze(r, votes, new Date('2026-09-30T10:00:00Z')).correction.referenceEligible, false);
});

test('default priority favors a valid short-history correction improvement over an older full-history tracking signal', () => {
    const { B } = env();
    const items = [
        { asset: { ...asset, id: 'track' }, model: { candidate: { position: 10, correction: { eligible: true, state: 'tracking' } } } },
        { asset: { ...asset, id: 'improve' }, model: { candidate: { position: null, correction: { eligible: true, state: 'improving' } } } }
    ];
    assert.equal(B.select(items, { filter: 'correction-watch' })[0].asset.id, 'improve');
    assert.equal(B.select(items, { filter: 'opportunity-watch' })[0].asset.id, 'improve');
});
