/**
 * storage.js - 多ETF本地存储模块
 * 每个ETF使用独立的命名空间
 */
const DataStorage = (() => {
    'use strict';
    const PREFIX = 'etf_timer_';

    function save(key, data) {
        try { localStorage.setItem(key, JSON.stringify(data)); return true; }
        catch(e) { console.error('存储失败:', e); return false; }
    }
    function load(key) {
        try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : null; }
        catch(e) { return null; }
    }

    function saveCurrentData(etfId, data) {
        if (typeof etfId === 'object') { data = etfId; etfId = 'default'; }
        data.timestamp = new Date().toISOString();
        return save(`${PREFIX}${etfId}_current`, data);
    }
    function getCurrentData(etfId) {
        if (!etfId) etfId = 'default';
        return load(`${PREFIX}${etfId}_current`);
    }
    function saveHistoryData(etfId, data) {
        if (typeof etfId === 'object') { data = etfId; etfId = 'default'; }
        return save(`${PREFIX}${etfId}_history`, data);
    }
    function getHistoryData(etfId) {
        if (!etfId) etfId = 'default';
        return load(`${PREFIX}${etfId}_history`);
    }
    function addUserRecord(etfId, record) {
        if (typeof etfId === 'object') { record = etfId; etfId = 'default'; }
        const key = `${PREFIX}${etfId}_records`;
        const records = load(key) || [];
        record.timestamp = new Date().toISOString();
        record.date = new Date().toISOString().split('T')[0];
        const idx = records.findIndex(r => r.date === record.date);
        if (idx >= 0) records[idx] = record; else records.push(record);
        if (records.length > 365) records.splice(0, records.length - 365);
        return save(key, records);
    }
    function getUserRecords(etfId) {
        if (!etfId) etfId = 'default';
        return load(`${PREFIX}${etfId}_records`) || [];
    }
    function saveSettings(settings) { return save(`${PREFIX}settings`, settings); }
    function getSettings() {
        return load(`${PREFIX}settings`) || { refreshInterval: 60 };
    }
    function exportToCSV(etfId) {
        const records = getUserRecords(etfId);
        if (records.length === 0) return '';
        const headers = ['日期','股息率(%)','国债收益率(%)','股债利差(%)','利差分位(%)','PE','PE分位(%)','PB','价格','信号'];
        const rows = records.map(r => [r.date,r.dividendYield||'',r.bondYield||'',r.spread||'',r.spreadPercentile||'',r.pe||'',r.pePercentile||'',r.pb||'',r.price||'',r.signal||'']);
        return '\uFEFF' + [headers.join(','), ...rows.map(r=>r.join(','))].join('\n');
    }
    function downloadCSV(etfId) {
        const csv = exportToCSV(etfId);
        if (!csv) { alert('暂无可导出的数据'); return; }
        const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `ETF择时数据_${etfId||'all'}_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    }
    function clearETFData(etfId) {
        if (!etfId) return;
        localStorage.removeItem(`${PREFIX}${etfId}_current`);
        localStorage.removeItem(`${PREFIX}${etfId}_history`);
        localStorage.removeItem(`${PREFIX}${etfId}_records`);
    }
    function clearAll() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(PREFIX)) keys.push(key);
        }
        keys.forEach(k => localStorage.removeItem(k));
    }

    return { saveCurrentData, getCurrentData, saveHistoryData, getHistoryData,
        addUserRecord, getUserRecords, saveSettings, getSettings,
        exportToCSV, downloadCSV, clearETFData, clearAll };
})();
