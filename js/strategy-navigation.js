const StrategyNavigation = (() => {
    'use strict';
    const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
    const ids = assets => assets.map(asset => typeof asset === 'string' ? asset : asset.id);

    function toGpt(currentId, gptAssets) {
        const supported = ids(gptAssets);
        const target = supported.includes(currentId) ? currentId : supported[0];
        const query = safeId(currentId) ? '?returnTo=' + encodeURIComponent(currentId) : '';
        return 'gpt-strategy.html' + query + '#' + encodeURIComponent(target || 'dividend-low-vol');
    }

    function toLegacy(currentId, returnId, legacyAssets) {
        const supported = ids(legacyAssets);
        const target = supported.includes(returnId) ? returnId : supported.includes(currentId) ? currentId : supported[0];
        return 'index.html#' + encodeURIComponent(target || 'dividend-low-vol');
    }

    function returnContext(search, legacyAssets) {
        const returnId = new URLSearchParams(search).get('returnTo');
        return safeId(returnId) && ids(legacyAssets).includes(returnId) ? returnId : null;
    }

    return { toGpt, toLegacy, returnContext };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StrategyNavigation;
