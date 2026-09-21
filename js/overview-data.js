const OverviewData = (() => {
    'use strict';
    async function historyFor(asset) {
        if (asset.history === null || asset.id === 'vix-dashboard') return { data: {}, state: 'na' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
        try {
            const response = await fetch(`data/${asset.history || asset.id}.json`, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('历史文件请求失败');
            const data = await response.json();
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('历史文件格式错误');
            return { data, state: 'ready' };
        } catch (_) {
            const data = DataStorage.getHistoryData(asset.id);
            return { data: data || {}, state: data ? 'fallback' : 'failed', error: data ? '历史请求失败，回退本机缓存' : '历史请求失败且无缓存' };
        } finally { clearTimeout(timer); }
    }

    function deadline(promise, ms) {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('请求超时')), ms); })])
            .finally(() => clearTimeout(timer));
    }

    function create({ assets, onChange = () => {}, concurrency = 3, historyLoader = historyFor,
        apiLoader = DataAPI.fetchAllDataForETF, priceLoader = GptStrategyData.loadPrice,
        getCurrent = id => DataStorage.getCurrentData(id), getManual = id => DataStorage.getManualData(id), timeout = 90000 }) {
        const records = new Map();
        let queue = [], active = 0, runId = 0, shared = new Map();
        const emit = record => onChange(record, summary());
        function summary() {
            const all = [...records.values()];
            return { total: all.length, active, queued: queue.length, complete: all.filter(record => record.phase === 'done').length,
                failed: all.filter(record => Object.values(record.issues).some(list => list.length)).length };
        }
        function fresh(asset, previous) {
            return { asset, phase: 'queued', revision: (previous?.revision || 0) + 1,
                parts: { api: 'queued', history: 'queued', price: 'queued' }, issues: {},
                history: null, api: { pending: ['valuation', 'bond', 'etf', 'aShareBreadth'] }, priceResult: null,
                previousPrice: previous?.priceResult, previousCurrent: previous?.current || getCurrent(asset.id), manual: getManual(asset.id) };
        }
        async function process(record, scope) {
            const generation = runId;
            const live = () => generation === runId && records.get(record.asset.id) === record && record.phase === 'loading';
            record.phase = 'loading';
            record.parts = { api: 'loading', history: 'loading', price: 'loading' };
            emit(record);
            const jobs = [
                deadline(Promise.resolve().then(() => historyLoader(record.asset)), timeout).then(result => {
                    if (!live()) return;
                    record.history = result.data; record.parts.history = result.state;
                    if (result.error) record.issues.history = [result.error];
                    emit(record);
                }).catch(() => {
                    if (!live()) return;
                    record.history = {}; record.parts.history = 'failed'; record.issues.history = ['历史数据读取超时或失败']; emit(record);
                }),
                deadline(Promise.resolve().then(() => priceLoader(record.asset, false, record.previousPrice)), timeout).then(result => {
                    if (!live()) return;
                    record.priceResult = result;
                    record.parts.price = result?.price ? result.error ? 'fallback' : 'ready' : 'failed';
                    if (result?.error || !result?.price) record.issues.price = [result?.error || '价格获取失败'];
                    emit(record);
                }).catch(() => {
                    if (!live()) return;
                    record.priceResult = record.previousPrice || null;
                    record.parts.price = record.priceResult?.price ? 'fallback' : 'failed';
                    record.issues.price = ['价格更新超时或失败，保留原日期']; emit(record);
                })
            ];
            if (record.asset.id === 'vix-dashboard' || record.asset.priceOnly) {
                record.api = { pending: [] }; record.parts.api = 'na';
            } else jobs.push(deadline(Promise.resolve().then(() => apiLoader(record.asset, partial => {
                if (!live() || record.parts.api !== 'loading') return;
                record.api = partial;
                record.issues.api = partial.errors || [];
                emit(record);
            }, scope)), timeout).then(result => {
                if (!live()) return;
                record.api = { ...(result || {}), pending: [] };
                record.issues.api = result?.errors || [];
                record.parts.api = result?.success ? record.issues.api.length ? 'fallback' : 'ready' : 'failed';
                if (!result?.success && !record.issues.api.length) record.issues.api = ['估值及综合信号数据请求失败'];
                emit(record);
            }).catch(() => {
                if (!live()) return;
                record.api = { ...record.api, pending: [] }; record.parts.api = 'failed';
                record.issues.api = [...(record.api.errors || []), '信号数据请求超时或失败']; emit(record);
            }));
            await Promise.all(jobs);
            if (!live()) return;
            record.phase = 'done'; record.finishedAt = new Date().toISOString();
            if (record.asset.id !== 'vix-dashboard') record.current = OverviewModel.normalized(record);
            emit(record);
        }
        function pump() {
            while (active < concurrency && queue.length) {
                const { record, scope } = queue.shift();
                active++;
                process(record, scope).catch(() => {
                    record.phase = 'done'; record.parts = { api: 'failed', history: 'failed', price: 'failed' };
                    record.issues.internal = ['数据处理失败，请重试']; emit(record);
                }).finally(() => { active--; emit(record); pump(); });
            }
        }
        function refreshAll() {
            if (active || queue.length) return false;
            runId++; shared = new Map();
            for (const asset of assets) {
                const record = fresh(asset, records.get(asset.id));
                records.set(asset.id, record); queue.push({ record, scope: shared });
            }
            for (const record of records.values()) emit(record);
            pump();
            return true;
        }
        function retry(ids) {
            const scope = new Map();
            for (const id of ids) {
                const previous = records.get(id);
                if (!previous || previous.phase !== 'done') continue;
                const record = fresh(previous.asset, previous);
                records.set(id, record); queue.push({ record, scope }); emit(record);
            }
            pump();
        }
        return { refreshAll, retry, summary, records };
    }
    return { create, historyFor };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = OverviewData;
