/**
 * etf-config.js - 多ETF配置中心（巴菲特多维度估值体系）
 * 
 * 设计哲学（致敬巴菲特/芒格）：
 *   1. "用合理的价格买入优质公司" — 不止看PE，还要看PB、股息率、安全边际
 *   2. "在别人恐惧时贪婪，在别人贪婪时恐惧" — 引入市场情绪/温度维度
 *   3. "永远不要亏损" — 安全边际 = 股息率 vs 无风险收益率
 *   4. "了解你的能力圈" — 每类ETF使用差异化权重
 *   5. "宏观经济很重要" — 经济周期判断辅助择时
 * 
 * 多维度评分体系 (总分 0-100)：
 *   维度A: 估值分位 — PE/PB历史分位（越低越好）
 *   维度B: 安全边际 — 股息率/FCF收益率 vs 国债收益率
 *   维度C: 盈利质量 — ROE、盈利趋势
 *   维度D: 市场温度 — 整体市场情绪（可选手动输入）
 * 
 * ETF分类（21只）：
 *   A股价值：红利低波(512890), 中证红利(515080), 自由现金流(159201)
 *   A股宽基：沪深300ETF(510300)
 *   A股成长：科创创业50(588300), 创业板50(159949)
 *   A股行业：医药ETF(512010), 科创半导体ETF(588170), 机器人ETF(562500), 储能ETF(159566), PCB电子ETF(515260)
 *   美股QDII：标普500(513650), 纳指(513110)
 *   港股QDII：恒生科技(513180), 港股通红利(513820), 港股通央企红利(513901)
 *   日股QDII：日经225ETF(513520), 东证ETF(513800)
 *   避险资产：黄金ETF(518850)
 *   固收债券：十年国债ETF(511260)
 *   商品期货：豆粕ETF(159985)
 */

const ETF_CONFIG = (() => {
    'use strict';

    // ========== ETF类型枚举 ==========
    const ETF_TYPE = {
        A_SHARE_INDEX: 'a_share_index',
        US_SHARE_INDEX: 'us_share_index',
        HK_SHARE_INDEX: 'hk_share_index',
        COMMODITY: 'commodity',
        SMART_BETA: 'smart_beta',
        GOLD: 'gold',
        BOND: 'bond',
    };

    // ========== 估值方法枚举 ==========
    const VALUATION_METHOD = {
        MULTI_DIM_VALUE: 'multi_dim_value',
        MULTI_DIM_GROWTH: 'multi_dim_growth',
        MULTI_DIM_US: 'multi_dim_us',
        MULTI_DIM_HK: 'multi_dim_hk',
        MULTI_DIM_BROAD: 'multi_dim_broad',
        MULTI_DIM_JP: 'multi_dim_jp',
        MULTI_DIM_PHARMA: 'multi_dim_pharma',
        TREND_FOLLOW: 'trend_follow',
        BOND_YIELD: 'bond_yield',
    };

    // ========== 所有ETF配置（21只）==========
    const ETF_LIST = [
        // ===== 1. 红利低波ETF =====
        {
            id: 'dividend-low-vol',
            code: '512890',
            name: '红利低波ETF',
            shortName: '红利低波',
            fullName: '华泰柏瑞红利低波动ETF',
            type: ETF_TYPE.SMART_BETA,
            market: 'SH',
            secid: '1.512890',
            color: '#28a745',
            icon: '💰',
            trackIndex: {
                name: '中证红利低波动指数',
                code: 'CSIH30269',
                danjuanCode: 'CSIH30269',
                danjuanName: '红利低波',
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_VALUE,
            useBondSpread: true,
            description: '跟踪中证红利低波动指数，选取股息率高且波动率低的50只股票。巴菲特理念：稳定现金流回报+安全边际。',
            signalRules: 'buffett_value',
            dimWeights: { valuation: 40, safety: 30, quality: 10, sentiment: 20 },
        },

        // ===== 2. 科创创业50ETF（招商） =====
        {
            id: 'sci-tech-50',
            code: '588300',
            name: '科创创业50ETF',
            shortName: '科创创业50',
            fullName: '招商中证科创创业50ETF',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SH',
            secid: '1.588300',
            color: '#e040fb',
            icon: '🚀',
            trackIndex: {
                name: '科创创业50指数',
                code: '931643',
                danjuanCode: 'SZ399006',   // 蛋卷无科创创业50(931643)，用创业板指(399006)做代理
                danjuanName: '创业板',      // 科创创业50=科创25+创业板25，与创业板指走势高相关
                // 直接使用蛋卷创业板指的全部估值数据（PE/PB/股息率/分位），数据源统一
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_GROWTH,
            useBondSpread: false,
            description: '跟踪中证科创创业50指数(931643)，从科创板和创业板选取市值最大的50只新兴产业上市公司。芒格理念：以合理价格买入优质成长公司。场内简称：双创ETF。',
            signalRules: 'buffett_growth',
            dimWeights: { valuation: 55, safety: 10, quality: 10, sentiment: 25 },
        },

        // ===== 3. 创业板50ETF =====
        {
            id: 'gem-50',
            code: '159949',
            name: '创业板50ETF',
            shortName: '创业板50',
            fullName: '创业板50ETF华安',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SZ',
            secid: '0.159949',
            color: '#ff6f00',
            icon: '🔥',
            trackIndex: {
                name: '创业板50指数',
                code: '399673',
                danjuanCode: 'SZ399006',    // 蛋卷无创业板50(399673)，用创业板指(399006)做代理
                danjuanName: '创业板',      // 创业板50是创业板指的子集(前50只)，走势高度相关
                // 直接使用蛋卷创业板指的全部估值数据（PE/PB/股息率/分位），数据源统一
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_GROWTH,
            useBondSpread: false,
            description: '创业板流动性最好的50只股票，聚焦新能源+信息技术+医药。',
            signalRules: 'buffett_growth',
            dimWeights: { valuation: 55, safety: 10, quality: 10, sentiment: 25 },
        },

        // ===== 4. 自由现金流ETF =====
        {
            id: 'free-cashflow',
            code: '159201',
            name: '自由现金流ETF',
            shortName: '自由现金流',
            fullName: '华夏国证自由现金流ETF',
            type: ETF_TYPE.SMART_BETA,
            market: 'SZ',
            secid: '0.159201',
            color: '#00bcd4',
            icon: '💎',
            trackIndex: {
                name: '国证自由现金流指数',
                code: '980092',
                danjuanCode: null,   // 蛋卷基金暂无此指数
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_VALUE,
            useBondSpread: true,
            description: '跟踪国证自由现金流指数。巴菲特核心：企业的内在价值等于未来自由现金流的折现值。',
            signalRules: 'buffett_value',
            dimWeights: { valuation: 35, safety: 40, quality: 10, sentiment: 15 },
        },

        // ===== 5. 标普500ETF =====
        {
            id: 'sp500-cn',
            code: '513650',
            name: '标普500ETF',
            shortName: '标普500',
            fullName: '标普500ETF南方(QDII)',
            type: ETF_TYPE.US_SHARE_INDEX,
            market: 'SH',
            secid: '1.513650',
            color: '#1976d2',
            icon: '🇺🇸',
            trackIndex: {
                name: 'S&P 500',
                code: 'SPX',
                danjuanCode: 'SP500',
                danjuanName: '标普500',
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_US,
            useBondSpread: false,
            description: '跟踪标普500指数。巴菲特遗嘱配置：90%资金投入标普500。美股长牛但需警惕周期性高估。',
            signalRules: 'buffett_us',
            dimWeights: { valuation: 45, safety: 15, quality: 10, sentiment: 30 },
        },

        // ===== 6. 纳指ETF =====
        {
            id: 'nasdaq100-cn',
            code: '513110',
            name: '纳指ETF',
            shortName: '纳指100',
            fullName: '纳指ETF华泰柏瑞(QDII)',
            type: ETF_TYPE.US_SHARE_INDEX,
            market: 'SH',
            secid: '1.513110',
            color: '#7c4dff',
            icon: '💜',
            trackIndex: {
                name: 'Nasdaq 100',
                code: 'NDX',
                danjuanCode: 'NDX',
                danjuanName: '纳指100',
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_US,
            useBondSpread: false,
            description: '跟踪纳斯达克100指数，聚焦美国科技龙头。成长股PE波动大，需更关注市场情绪。',
            signalRules: 'buffett_us_growth',
            dimWeights: { valuation: 45, safety: 15, quality: 10, sentiment: 30 },
        },

        // ===== 7. 中证红利ETF =====
        {
            id: 'csi-dividend',
            code: '515080',
            name: '中证红利ETF',
            shortName: '中证红利',
            fullName: '招商中证红利ETF',
            type: ETF_TYPE.SMART_BETA,
            market: 'SH',
            secid: '1.515080',
            color: '#e65100',
            icon: '🔴',
            trackIndex: {
                name: '中证红利指数',
                code: '000922',
                danjuanCode: 'SH000922',
                danjuanName: '中证红利',
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_VALUE,
            useBondSpread: true,
            description: '跟踪中证红利指数(000922)，选取100只现金股息率高、分红稳定的上市公司。A股最经典的红利策略指数，连续15次分红，与红利低波互补。',
            signalRules: 'buffett_value',
            dimWeights: { valuation: 40, safety: 30, quality: 10, sentiment: 20 },
        },

        // ===== 8. 港股通红利ETF =====
        {
            id: 'hk-dividend',
            code: '513820',
            name: '港股通红利ETF',
            shortName: '港股通红利',
            fullName: '汇添富中证港股通高股息投资ETF',
            type: ETF_TYPE.HK_SHARE_INDEX,
            market: 'SH',
            secid: '1.513820',
            color: '#ad1457',
            icon: '🔶',
            trackIndex: {
                name: '中证港股通高股息投资指数',
                code: '930914',
                danjuanCode: null,    // 蛋卷基金暂无此指数
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_HK,
            useBondSpread: true,
            description: '跟踪中证港股通高股息投资指数(930914)，选取30只港股通高股息股票，股息率加权。PE约8倍、PB约0.65倍、股息率约5.5%，兼具高股息+港股低估双重安全边际。',
            signalRules: 'buffett_hk_dividend',
            dimWeights: { valuation: 35, safety: 35, quality: 10, sentiment: 20 },
        },

        // ===== 9. 恒生科技指数ETF（原7）=====
        {
            id: 'hstech',
            code: '513180',
            name: '恒生科技指数ETF',
            shortName: '恒生科技',
            fullName: '恒生科技指数ETF',
            type: ETF_TYPE.HK_SHARE_INDEX,
            market: 'SH',
            secid: '1.513180',
            color: '#d32f2f',
            icon: '🇭🇰',
            trackIndex: {
                name: '恒生科技指数',
                code: 'HSTECH',
                danjuanCode: 'HKHSTECH',
                danjuanName: '恒生科技',
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_HK,
            useBondSpread: false,
            description: '跟踪恒生科技指数，覆盖腾讯/阿里/美团等互联网龙头。港股受AH溢价和资金面影响大。',
            signalRules: 'buffett_hk',
            dimWeights: { valuation: 50, safety: 15, quality: 10, sentiment: 25 },
        },

        // ===== 8. 沪深300ETF =====
        {
            id: 'csi300',
            code: '510300',
            name: '沪深300ETF',
            shortName: '沪深300',
            fullName: '华泰柏瑞沪深300ETF',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SH',
            secid: '1.510300',
            color: '#2962ff',
            icon: '🏛️',
            trackIndex: {
                name: '沪深300指数',
                code: 'SH000300',
                danjuanCode: 'SH000300',
                danjuanName: '沪深300',
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_BROAD,
            useBondSpread: true,
            description: 'A股的"锚"，由沪深两市规模最大、流动性最好的300只股票组成。巴菲特遗嘱配置理念的A股版本。规模3300+亿，费率0.2%，全市场最低。',
            signalRules: 'buffett_broad',
            dimWeights: { valuation: 40, safety: 30, quality: 10, sentiment: 20 },
        },

        // ===== 9. 医药ETF =====
        {
            id: 'pharma',
            code: '512010',
            name: '医药ETF',
            shortName: '医药',
            fullName: '易方达沪深300医药ETF',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SH',
            secid: '1.512010',
            color: '#e91e63',
            icon: '🏥',
            trackIndex: {
                name: '沪深300医药卫生指数',
                code: 'SH000978',
                danjuanCode: 'SH000978',
                danjuanName: '医药100',
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_PHARMA,
            useBondSpread: false,
            description: '跟踪沪深300医药卫生指数，覆盖恒瑞医药、药明康德、迈瑞医疗等龙头。独立周期防御型行业，与科技/消费相关性低。规模170亿，医药ETF中最大。',
            signalRules: 'buffett_pharma',
            dimWeights: { valuation: 50, safety: 20, quality: 10, sentiment: 20 },
        },

        // ===== 10. 黄金ETF =====
        {
            id: 'gold',
            code: '518850',
            name: '黄金ETF',
            shortName: '黄金',
            fullName: '华夏黄金ETF',
            type: ETF_TYPE.GOLD,
            market: 'SH',
            secid: '1.518850',
            color: '#ffc107',
            icon: '🥇',
            trackIndex: {
                name: '上海金Au99.99',
                code: 'AU9999',
                danjuanCode: null,
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.TREND_FOLLOW,
            useBondSpread: false,
            description: '跟踪上海黄金交易所Au99.99现货黄金。全球公认避险+抗通胀资产，与股市负相关。费率0.2%为全市场黄金ETF最低。',
            signalRules: 'gold_trend',
            dimWeights: { valuation: 0, safety: 0, quality: 0, sentiment: 100 },
        },

        // ===== 11. 十年国债ETF =====
        {
            id: 'bond-10y',
            code: '511260',
            name: '十年国债ETF',
            shortName: '十年国债',
            fullName: '国泰上证10年期国债ETF',
            type: ETF_TYPE.BOND,
            market: 'SH',
            secid: '1.511260',
            color: '#607d8b',
            icon: '🏦',
            trackIndex: {
                name: '上证10年期国债指数',
                code: 'CN10Y',
                danjuanCode: null,
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.BOND_YIELD,
            useBondSpread: true,
            description: '跟踪上证10年期国债指数。股债跷跷板效应的核心标的——国债大涨=市场避险升温=股市可能有机会。费率0.2%，规模165亿。',
            signalRules: 'bond_yield',
            dimWeights: { valuation: 40, safety: 30, quality: 0, sentiment: 30 },
        },

        // ===== 12. 豆粕ETF =====
        {
            id: 'soybean-meal',
            code: '159985',
            name: '豆粕ETF',
            shortName: '豆粕',
            fullName: '华夏饲料豆粕期货ETF',
            type: ETF_TYPE.COMMODITY,
            market: 'SZ',
            secid: '0.159985',
            color: '#8d6e63',
            icon: '🌾',
            trackIndex: {
                name: '大商所豆粕期货价格指数',
                code: 'DCEMIDX',
                danjuanCode: null,
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.TREND_FOLLOW,
            useBondSpread: false,
            description: '商品期货ETF，跟踪大商所豆粕期货价格指数，与股市低相关性。商品无估值，纯趋势跟踪。',
            signalRules: 'commodity_trend',
            dimWeights: { valuation: 0, safety: 0, quality: 0, sentiment: 100 },
        },

        // ===== 13. 港股通央企红利ETF =====
        {
            id: 'hk-soe-dividend',
            code: '513901',
            name: '港股通央企红利ETF',
            shortName: '港股央企红利',
            fullName: '港股通央企红利ETF',
            type: ETF_TYPE.HK_SHARE_INDEX,
            market: 'SH',
            secid: '1.513901',
            color: '#c62828',
            icon: '🏢',
            trackIndex: {
                name: '中证港股通央企红利指数',
                code: '931233',
                danjuanCode: null,    // 蛋卷基金暂无此指数
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_HK,
            useBondSpread: true,
            description: '跟踪中证港股通央企红利指数(931233)，从港股通央企中选取股息率高、分红稳定的上市公司。PE约7.5倍、PB约0.6倍、股息率约6%，"666组合"典型代表。兼具高股息+央企+港股低估三重安全边际。',
            signalRules: 'buffett_hk_dividend',
            dimWeights: { valuation: 35, safety: 35, quality: 10, sentiment: 20 },
        },

        // ===== 14. 日经225ETF =====
        {
            id: 'nikkei225',
            code: '513520',
            name: '日经225ETF',
            shortName: '日经225',
            fullName: '华夏野村日经225ETF(QDII)',
            type: ETF_TYPE.JP_SHARE_INDEX,
            market: 'SH',
            secid: '1.513520',
            color: '#e53935',
            icon: '🇯🇵',
            trackIndex: {
                name: '日经225指数',
                code: 'NKY',
                danjuanCode: null,    // 蛋卷基金暂无日经225指数
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_JP,
            useBondSpread: false,
            description: '跟踪日经225指数，覆盖丰田/索尼/任天堂/东京电子等日本龙头企业。日股受日元汇率和日央行政策影响大，2023年以来巴菲特增持日本商社引发全球关注。费率0.2%，规模约17亿。',
            signalRules: 'buffett_jp',
            dimWeights: { valuation: 45, safety: 15, quality: 10, sentiment: 30 },
        },

        // ===== 15. 东证ETF =====
        {
            id: 'topix',
            code: '513800',
            name: '东证ETF',
            shortName: '东证TOPIX',
            fullName: '日本东证指数ETF南方(QDII)',
            type: ETF_TYPE.JP_SHARE_INDEX,
            market: 'SH',
            secid: '1.513800',
            color: '#c62828',
            icon: '⛩️',
            trackIndex: {
                name: '东证股价指数(TOPIX)',
                code: 'TOPIX',
                danjuanCode: null,    // 蛋卷基金暂无东证指数
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_JP,
            useBondSpread: false,
            description: '跟踪日本东证股价指数(TOPIX)，覆盖东京证券交易所主板全部上市公司，比日经225更广泛。TOPIX是市值加权指数，更能反映日本股市整体表现。费率0.2%。',
            signalRules: 'buffett_jp',
            dimWeights: { valuation: 45, safety: 15, quality: 10, sentiment: 30 },
        },

        // ===== 16. 科创半导体ETF =====
        {
            id: 'sci-semi',
            code: '588170',
            name: '科创半导体ETF',
            shortName: '科创半导体',
            fullName: '华夏上证科创板半导体材料设备主题ETF',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SH',
            secid: '1.588170',
            color: '#00897b',
            icon: '🔬',
            trackIndex: {
                name: '上证科创板半导体材料设备指数',
                code: '000689',
                danjuanCode: null,
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_GROWTH,
            useBondSpread: false,
            description: '跟踪上证科创板半导体材料设备指数，聚焦中微公司/北方华创/沪硅产业等半导体设备材料龙头。科创板高弹性+国产替代主线，PE波动大（50-150倍），适合成长估值体系。',
            signalRules: 'buffett_growth',
            dimWeights: { valuation: 55, safety: 10, quality: 10, sentiment: 25 },
        },

        // ===== 17. 机器人ETF =====
        {
            id: 'robot',
            code: '562500',
            name: '机器人ETF',
            shortName: '机器人',
            fullName: '华夏中证机器人ETF',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SH',
            secid: '1.562500',
            color: '#5c6bc0',
            icon: '🤖',
            trackIndex: {
                name: '中证机器人指数',
                code: '930009',
                danjuanCode: null,
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_GROWTH,
            useBondSpread: false,
            description: '跟踪中证机器人指数，覆盖汇川技术/埃斯顿/绿的谐波等工业机器人及人形机器人产业链龙头。受益于AI+具身智能趋势，成长性强但PE波动大。',
            signalRules: 'buffett_growth',
            dimWeights: { valuation: 55, safety: 10, quality: 10, sentiment: 25 },
        },

        // ===== 18. 储能电池ETF =====
        {
            id: 'energy-storage',
            code: '159566',
            name: '储能ETF',
            shortName: '储能电池',
            fullName: '易方达国证新能源电池ETF',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SZ',
            secid: '0.159566',
            color: '#43a047',
            icon: '🔋',
            trackIndex: {
                name: '国证新能源电池指数',
                code: '399296',
                danjuanCode: null,
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_GROWTH,
            useBondSpread: false,
            description: '跟踪国证新能源电池指数，覆盖宁德时代/亿纬锂能/比亚迪等储能电池产业链龙头。受益于新能源+储能大趋势，成长性强但周期波动明显。',
            signalRules: 'buffett_growth',
            dimWeights: { valuation: 55, safety: 10, quality: 10, sentiment: 25 },
        },

        // ===== 19. PCB电子ETF =====
        {
            id: 'pcb',
            code: '515260',
            name: 'PCB电子ETF',
            shortName: 'PCB电子',
            fullName: '华宝中证电子50ETF',
            type: ETF_TYPE.A_SHARE_INDEX,
            market: 'SH',
            secid: '1.515260',
            color: '#f4511e',
            icon: '🖥️',
            trackIndex: {
                name: '中证电子50指数',
                code: '931087',
                danjuanCode: null,
                danjuanName: null,
            },
            valuationMethod: VALUATION_METHOD.MULTI_DIM_GROWTH,
            useBondSpread: false,
            description: '跟踪中证电子50指数，覆盖立讯精密/胜宏科技/鹏鼎控股等PCB及消费电子龙头。AI服务器/高速通信带动PCB需求爆发，成长弹性大。',
            signalRules: 'buffett_growth',
            dimWeights: { valuation: 55, safety: 10, quality: 10, sentiment: 25 },
        },
    ];

    // ========== 巴菲特多维度信号规则集合 ==========
    //
    // 核心理念：每个维度打0-100分，按ETF特性加权后得到总分
    // 总分 ≥ 80 → 强烈买入    总分 70-80 → 买入
    // 总分 55-70 → 持有/加仓   总分 40-55 → 持有观望
    // 总分 25-40 → 减仓预警    总分 15-25 → 卖出
    // 总分 < 15 → 强烈卖出/过热
    //
    // 维度得分（统一方向：分越高=越值得买）：
    //   估值分 = 100 - PE分位（PE越低 → 越便宜 → 分越高）
    //   安全边际分 = f(股息率 - 国债收益率)
    //   盈利质量分 = f(ROE, PB合理性)
    //   情绪温度分 = 100 - 市场温度（市场越冷 → 越是买点）

    const SIGNAL_RULES = {

        // ========== A股价值类（红利低波、自由现金流）==========
        buffett_value: {
            name: '巴菲特多维估值法（价值型）',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 安全边际',
                quality: '💪 盈利质量',
                sentiment: '🌡️ A股涨跌广度',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                // 维度B: 安全边际（股息率 - 国债收益率）
                // 修正：引入利率环境因子，低利率时利差天然偏大，需适度压缩避免虚高
                if (data.dividendYield > 0 && data.bondYield > 0) {
                    const spread = data.dividendYield - data.bondYield;
                    // 利率调节因子：国债收益率<2%时压缩系数0.7，>3%时系数1.0
                    const rateAdj = Math.max(0.7, Math.min(1.0, (data.bondYield - 1.0) * 0.3 + 0.7));
                    const rawSafety = 40 + spread * 20;
                    scores.safety = Math.max(0, Math.min(100, rawSafety * rateAdj));
                } else if (data.spreadPercentile !== null && data.spreadPercentile !== undefined) {
                    scores.safety = data.spreadPercentile;
                } else {
                    scores.safety = null;
                }

                // 维度C: 盈利质量（ROE + PB修正）
                if (data.roe > 0) {
                    const roeScore = Math.max(0, Math.min(100, data.roe * 5 + 15));
                    let pbAdj = 0;
                    if (data.pb > 0) {
                        pbAdj = data.pb < 1 ? 15 : (data.pb > 3 ? -15 : 0);
                    }
                    scores.quality = Math.max(0, Math.min(100, roeScore + pbAdj));
                } else {
                    scores.quality = null; // 无ROE数据时返回null，权重自动分配给其他维度
                }

                // 维度D: 市场温度（手动输入，越高=越热=情绪分越低）
                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配给其他维度
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 40, safety: 30, quality: 10, sentiment: 20 };
                const scores = SIGNAL_RULES.buffett_value.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                // 硬性极端规则
                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';
                if (scores.valuation !== null && scores.valuation <= 10 && scores.safety !== null && scores.safety <= 20) return 'STRONG_SELL';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== A股成长类 ==========
        buffett_growth: {
            name: '芒格成长价值法（成长型）',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 相对安全性',
                quality: '💪 盈利成长性',
                sentiment: '🌡️ A股涨跌广度',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                // 成长股安全性：基于PE倒数(E/P)的安全评估
                // PE=20 → E/P=5% → 安全性高(~75); PE=40 → E/P=2.5% → 中等(~55); PE=80 → E/P=1.25% → 低(~30)
                // 比原来的 130-PE*2 更平滑，对高PE行业（科创板PE 50-80）更公平
                if (data.pe > 0) {
                    const earningsYield = (1 / data.pe) * 100; // E/P 百分比
                    // E/P 1%→25分, 2%→45分, 3%→60分, 5%→80分, 8%→100分
                    scores.safety = Math.max(0, Math.min(100, earningsYield * 12 + 13));
                } else {
                    scores.safety = null;
                }

                if (data.roe > 0) {
                    scores.quality = Math.max(0, Math.min(100, data.roe * 5 + 10));
                } else {
                    scores.quality = null;
                }

                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 55, safety: 10, quality: 10, sentiment: 25 };
                const scores = SIGNAL_RULES.buffett_growth.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== 美股宽基（标普500 QDII）==========
        buffett_us: {
            name: '巴菲特美股估值法（宽基）',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 盈利收益率vs国债',
                quality: '💪 盈利质量',
                sentiment: '🌡️ 恐惧贪婪指数',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                // 盈利收益率(E/P) vs 美债
                if (data.pe > 0) {
                    const earningsYield = (1 / data.pe) * 100;
                    const bondY = data.bondYield || 4.2;
                    const gap = earningsYield - bondY;
                    scores.safety = Math.max(0, Math.min(100, 50 + gap * 15));
                } else {
                    scores.safety = null;
                }

                // 盈利质量：标普500用盈利收益率E/P作为质量代理
                // E/P越高→盈利能力越强→质量分越高
                if (data.pe > 0) {
                    const earningsYieldPct = (1 / data.pe) * 100;
                    // E/P 2%→质量40, 4%→60, 6%→80（美股E/P通常3-6%）
                    scores.quality = Math.max(0, Math.min(100, earningsYieldPct * 10));
                } else if (data.roe > 0) {
                    scores.quality = Math.max(0, Math.min(100, data.roe * 4 + 20));
                } else {
                    scores.quality = null; // 无数据时返回null，权重自动跳过
                }

                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 45, safety: 15, quality: 10, sentiment: 30 };
                const scores = SIGNAL_RULES.buffett_us.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== 美股成长（纳指100 QDII）==========
        buffett_us_growth: {
            name: '芒格美股成长法（科技）',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 盈利收益率',
                quality: '💪 创新溢价',
                sentiment: '🌡️ 恐惧贪婪指数',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                if (data.pe > 0) {
                    const earningsYield = (1 / data.pe) * 100;
                    scores.safety = Math.max(0, Math.min(100, earningsYield * 18));
                } else {
                    scores.safety = null;
                }

                // 盈利质量：纳指100用盈利收益率E/P作为质量代理
                if (data.pe > 0) {
                    const earningsYieldPct = (1 / data.pe) * 100;
                    // 纳指E/P通常2-4%，给予创新溢价加成（+10）
                    scores.quality = Math.max(0, Math.min(100, earningsYieldPct * 10 + 10));
                } else if (data.roe > 0) {
                    scores.quality = Math.max(0, Math.min(100, data.roe * 4 + 20));
                } else {
                    scores.quality = null;
                }

                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 45, safety: 15, quality: 10, sentiment: 30 };
                const scores = SIGNAL_RULES.buffett_us_growth.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== 港股科技 ==========
        buffett_hk: {
            name: '港股多维估值法',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 绝对估值水平',
                quality: '💪 盈利质量',
                sentiment: '🌡️ 恐惧贪婪(参考美股)',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                if (data.pe > 0) {
                    // 港股用E/P作为安全代理，更平滑
                    const earningsYield = (1 / data.pe) * 100;
                    scores.safety = Math.max(0, Math.min(100, earningsYield * 13 + 8));
                } else {
                    scores.safety = null;
                }

                if (data.roe > 0) {
                    scores.quality = Math.max(0, Math.min(100, data.roe * 4 + 20));
                } else {
                    scores.quality = null;
                }

                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 50, safety: 15, quality: 10, sentiment: 25 };
                const scores = SIGNAL_RULES.buffett_hk.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== 港股高股息央企（港股通央企红利）==========
        buffett_hk_dividend: {
            name: '港股高股息央企估值法',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 股息安全边际',
                quality: '💪 PB+盈利质量',
                sentiment: '🌡️ 恐惧贪婪(参考美股)',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                // 维度B: 股息安全边际（高股息特色：股息率 - 国债收益率）
                // 港股央企红利股息率通常5-7%，远高于国债，安全边际极强
                // 引入利率环境因子：低利率时利差天然偏大，需适度压缩
                if (data.dividendYield > 0 && data.bondYield > 0) {
                    const spread = data.dividendYield - data.bondYield;
                    const rateAdj = Math.max(0.7, Math.min(1.0, (data.bondYield - 1.0) * 0.3 + 0.7));
                    // 港股央企红利利差通常3-5%，比A股红利低波更高
                    const rawSafety = 35 + spread * 15;
                    scores.safety = Math.max(0, Math.min(100, rawSafety * rateAdj));
                } else if (data.pe > 0) {
                    // 回退：用E/P作为安全代理
                    const earningsYield = (1 / data.pe) * 100;
                    scores.safety = Math.max(0, Math.min(100, earningsYield * 10 + 15));
                } else {
                    scores.safety = null;
                }

                // 维度C: PB+盈利质量（央企ROE中等但PB极低是核心优势）
                // PB<0.7给高分（深度破净），PB<1加分，PB>1.5减分
                if (data.roe > 0) {
                    const roeScore = Math.max(0, Math.min(100, data.roe * 5 + 15));
                    let pbAdj = 0;
                    if (data.pb > 0) {
                        if (data.pb < 0.7) pbAdj = 25;       // 深度破净，央企重估空间大
                        else if (data.pb < 1.0) pbAdj = 15;  // 破净，有安全垫
                        else if (data.pb > 1.5) pbAdj = -10;
                    }
                    scores.quality = Math.max(0, Math.min(100, roeScore + pbAdj));
                } else if (data.pb > 0) {
                    // 无ROE时，仅用PB评估
                    if (data.pb < 0.7) scores.quality = 80;
                    else if (data.pb < 1.0) scores.quality = 65;
                    else if (data.pb < 1.5) scores.quality = 45;
                    else scores.quality = 30;
                } else {
                    scores.quality = null;
                }

                // 维度D: 市场情绪（港股参考CNN Fear & Greed）
                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null;
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 35, safety: 35, quality: 10, sentiment: 20 };
                const scores = SIGNAL_RULES.buffett_hk_dividend.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                // 硬性极端规则
                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';
                if (scores.valuation !== null && scores.valuation <= 10 && scores.safety !== null && scores.safety <= 20) return 'STRONG_SELL';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== 日股（日经225 QDII）==========
        buffett_jp: {
            name: '巴菲特日股估值法',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 盈利收益率vs日债',
                quality: '💪 盈利质量',
                sentiment: '🌡️ 恐惧贪婪指数',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                // 维度B: 盈利收益率(E/P) vs 日债
                // 日本10Y国债收益率很低（约0.5-1.5%），E/P约4-6%，利差天然大
                if (data.pe > 0) {
                    const earningsYield = (1 / data.pe) * 100;
                    const bondY = data.bondYield || 1.0; // 日债默认约1.0%
                    const gap = earningsYield - bondY;
                    // 日股E/P-日债利差通常2-5%，比美股宽
                    scores.safety = Math.max(0, Math.min(100, 40 + gap * 12));
                } else {
                    scores.safety = null;
                }

                // 维度C: 盈利质量：用E/P作为质量代理
                if (data.pe > 0) {
                    const earningsYieldPct = (1 / data.pe) * 100;
                    // E/P 2%→质量30, 4%→50, 6%→70（日股E/P通常3-6%）
                    scores.quality = Math.max(0, Math.min(100, earningsYieldPct * 10));
                } else if (data.roe > 0) {
                    scores.quality = Math.max(0, Math.min(100, data.roe * 4 + 20));
                } else {
                    scores.quality = null;
                }

                // 维度D: 市场情绪（参考CNN Fear & Greed，与美股共用）
                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null;
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 45, safety: 15, quality: 10, sentiment: 30 };
                const scores = SIGNAL_RULES.buffett_jp.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== A股宽基（沪深300）==========
        buffett_broad: {
            name: '巴菲特多维估值法（宽基）',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 股债利差',
                quality: '💪 盈利质量(ROE)',
                sentiment: '🌡️ A股涨跌广度',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                // 维度B: 股债利差（股息率 - 国债收益率）
                // 修正：引入利率环境因子，低利率时适度压缩
                if (data.dividendYield > 0 && data.bondYield > 0) {
                    const spread = data.dividendYield - data.bondYield;
                    // 沪深300股息率约2-3%，国债约1.5-2.5%
                    const rateAdj = Math.max(0.7, Math.min(1.0, (data.bondYield - 1.0) * 0.3 + 0.7));
                    const rawSafety = 45 + spread * 18;
                    scores.safety = Math.max(0, Math.min(100, rawSafety * rateAdj));
                } else if (data.spreadPercentile !== null && data.spreadPercentile !== undefined) {
                    scores.safety = data.spreadPercentile;
                } else {
                    scores.safety = null;
                }

                // 维度C: 盈利质量（ROE + PB修正）
                if (data.roe > 0) {
                    const roeScore = Math.max(0, Math.min(100, data.roe * 5 + 10));
                    let pbAdj = 0;
                    if (data.pb > 0) {
                        pbAdj = data.pb < 1.2 ? 10 : (data.pb > 2.5 ? -10 : 0);
                    }
                    scores.quality = Math.max(0, Math.min(100, roeScore + pbAdj));
                } else {
                    scores.quality = null; // 无ROE数据时权重自动跳过
                }

                // 维度D: 市场温度
                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 40, safety: 30, quality: 10, sentiment: 20 };
                const scores = SIGNAL_RULES.buffett_broad.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';
                if (scores.valuation !== null && scores.valuation <= 10 && scores.safety !== null && scores.safety <= 20) return 'STRONG_SELL';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== A股医药行业 ==========
        buffett_pharma: {
            name: '医药行业多维估值法',
            dimensions: ['valuation', 'safety', 'quality', 'sentiment'],
            dimensionNames: {
                valuation: '📊 PE均值偏离估值',
                safety: '🛡️ 绝对估值水平',
                quality: '💪 盈利质量(ROE)',
                sentiment: '🌡️ A股涨跌广度',
            },
            gauges: [
                { id: 'composite', title: '综合投资评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 估值（混合模式：PE均值偏离度×0.7 + PE分位×0.3）
                scores.valuation = SignalEngine.calcHybridValuationScore(data.pe, data.peMean, data.peStd, data.pePercentile);

                // 维度B: 绝对PE安全性（医药PE正常区间20-50）
                // 使用E/P(盈利收益率)作为安全代理，更平滑
                // PE=20 → E/P=5% → ~73分; PE=35 → E/P=2.86% → ~47分; PE=50 → E/P=2% → ~37分
                if (data.pe > 0) {
                    const earningsYield = (1 / data.pe) * 100;
                    scores.safety = Math.max(0, Math.min(100, earningsYield * 13 + 8));
                } else {
                    scores.safety = null;
                }

                // 维度C: 盈利质量（医药ROE一般10-20%）
                if (data.roe > 0) {
                    scores.quality = Math.max(0, Math.min(100, data.roe * 5 + 10));
                } else {
                    scores.quality = null; // 无ROE数据时权重自动跳过
                }

                // 维度D: 市场温度
                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 50, safety: 20, quality: 10, sentiment: 20 };
                const scores = SIGNAL_RULES.buffett_pharma.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                if (scores.valuation !== null && scores.valuation <= 5) return 'OVERHEAT';

                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== 黄金趋势跟踪 ==========
        gold_trend: {
            name: '趋势跟踪法（黄金避险）',
            dimensions: ['sentiment'],
            dimensionNames: {
                sentiment: '📈 趋势强度',
            },
            gauges: [
                { id: 'trend', title: '趋势强度', colorReverse: false },
            ],
            calcScores: (data) => {
                const scores = {};
                if (data.trendScore !== null && data.trendScore !== undefined) {
                    scores.sentiment = 100 - data.trendScore;
                } else {
                    scores.sentiment = null;
                }
                return scores;
            },
            generate: (data) => {
                const trend = data.trendScore;
                if (trend === null || trend === undefined) return 'DATA_INCOMPLETE';
                if (trend >= 85) return 'OVERHEAT';
                if (trend >= 70) return 'REDUCE_WARN';
                if (trend >= 50 && trend < 70) return 'HOLD';
                if (trend >= 30 && trend < 50) return 'HOLD_ADD';
                if (trend >= 15 && trend < 30) return 'BUY';
                if (trend < 15) return 'STRONG_BUY';
                return 'NEUTRAL';
            }
        },

        // ========== 国债收益率择时（债券ETF）==========
        bond_yield: {
            name: '国债收益率择时法',
            dimensions: ['valuation', 'safety', 'sentiment'],
            dimensionNames: {
                valuation: '📊 收益率水平',
                safety: '🛡️ 利率趋势',
                sentiment: '🌡️ A股广度(反向)',
            },
            gauges: [
                { id: 'composite', title: '综合配置评分', colorReverse: false },
            ],
            calcScores: (data, weights) => {
                const scores = {};

                // 维度A: 国债收益率水平（收益率越高=债券越便宜=分越高）
                // 中国10Y国债收益率历史区间1.5%-4.5%，2.5%为近年中枢
                if (data.bondYield > 0) {
                    // 收益率2.5%以上为偏高（债券便宜），1.5%以下为偏低（债券贵）
                    const yieldScore = Math.max(0, Math.min(100, (data.bondYield - 1.0) * 50));
                    scores.valuation = yieldScore;
                } else {
                    scores.valuation = null;
                }

                // 维度B: 利率趋势（手动输入趋势分数，或基于近期变化）
                // 利率下行=债券涨=持有债券分高
                if (data.trendScore !== null && data.trendScore !== undefined) {
                    // trendScore: 0=快速下行(利好债券), 50=稳定, 100=快速上行(利空债券)
                    scores.safety = Math.max(0, Math.min(100, 100 - data.trendScore));
                } else {
                    scores.safety = 50; // 默认中性
                }

                // 维度C: 股市温度（反向逻辑：股市越恐慌=资金流向债券=利好债券）
                if (data.marketTemp !== null && data.marketTemp !== undefined && !isNaN(data.marketTemp)) {
                    // 股市恐惧(marketTemp低)→利好债券→分高
                    scores.sentiment = Math.max(0, Math.min(100, 100 - data.marketTemp));
                } else {
                    scores.sentiment = null; // 无情绪数据时权重自动分配
                }

                return scores;
            },
            generate: (data, weights) => {
                const w = weights || { valuation: 40, safety: 30, sentiment: 30 };
                const scores = SIGNAL_RULES.bond_yield.calcScores(data, w);

                let totalWeight = 0, weightedSum = 0;
                Object.keys(w).forEach(dim => {
                    if (scores[dim] !== null && scores[dim] !== undefined) {
                        weightedSum += scores[dim] * w[dim];
                        totalWeight += w[dim];
                    }
                });

                if (totalWeight === 0) return 'DATA_INCOMPLETE';
                const total = weightedSum / totalWeight;

                // 国债ETF不用OVERHEAT概念
                if (total >= 80) return 'STRONG_BUY';
                if (total >= 70) return 'BUY';
                if (total >= 55) return 'HOLD_ADD';
                if (total >= 40) return 'HOLD';
                if (total >= 25) return 'REDUCE_WARN';
                if (total >= 15) return 'SELL';
                return 'STRONG_SELL';
            }
        },

        // ========== 商品趋势跟踪（豆粕）==========
        commodity_trend: {
            name: '趋势跟踪法（商品期货）',
            dimensions: ['sentiment'],
            dimensionNames: {
                sentiment: '📈 趋势强度',
            },
            gauges: [
                { id: 'trend', title: '趋势强度', colorReverse: false },
            ],
            calcScores: (data) => {
                const scores = {};
                if (data.trendScore !== null && data.trendScore !== undefined) {
                    scores.sentiment = 100 - data.trendScore;
                } else {
                    scores.sentiment = null;
                }
                return scores;
            },
            generate: (data) => {
                const trend = data.trendScore;
                if (trend === null || trend === undefined) return 'DATA_INCOMPLETE';
                if (trend >= 85) return 'OVERHEAT';
                if (trend >= 70) return 'REDUCE_WARN';
                if (trend >= 50 && trend < 70) return 'HOLD';
                if (trend >= 30 && trend < 50) return 'HOLD_ADD';
                if (trend >= 15 && trend < 30) return 'BUY';
                if (trend < 15) return 'STRONG_BUY';
                return 'NEUTRAL';
            }
        },
    };

    // ========== VIX 恐惧仪表盘（特殊页面，不参与信号计算）==========
    const VIX_DASHBOARD = {
        id: 'vix-dashboard',
        name: 'VIX恐惧仪表盘',
        shortName: 'VIX恐惧',
        icon: '😱',
        color: '#e91e63',
        // VIX 恐惧/贪婪区间定义
        zones: [
            { min: 0,  max: 12, label: '极度贪婪', color: '#0d7337', desc: '市场极度乐观，历史罕见低位，警惕随时反转', emoji: '🤑' },
            { min: 12, max: 16, label: '贪婪',     color: '#28a745', desc: '市场乐观平静，波动率偏低，可能蕴含风险', emoji: '😊' },
            { min: 16, max: 20, label: '偏乐观',   color: '#9be3b0', desc: '正常偏低波动，市场平稳运行', emoji: '🙂' },
            { min: 20, max: 25, label: '中性',     color: '#ffc107', desc: '历史均值附近，市场正常波动', emoji: '😐' },
            { min: 25, max: 30, label: '偏恐惧',   color: '#fd7e14', desc: '波动加大，市场开始紧张', emoji: '😟' },
            { min: 30, max: 40, label: '恐惧',     color: '#dc3545', desc: '市场恐慌情绪浓厚，可能存在超跌机会', emoji: '😨' },
            { min: 40, max: 999,label: '极度恐惧', color: '#85182a', desc: '极端恐慌（如08金融危机/20年疫情），历史级抄底窗口', emoji: '🔥' },
        ],
        // VIX 长期统计锚点（基于1990-2025历史数据）
        anchor: {
            mean: 19.5,        // 长期均值
            median: 17.6,      // 中位数
            std: 7.8,          // 标准差
            pct25: 14.0,       // 25分位
            pct75: 23.0,       // 75分位
            pct90: 30.0,       // 90分位
        },
        // 插入位置：在纳指（index 5）之后
        insertAfterETFId: 'nasdaq100-cn',
    };

    // ========== 公开API ==========
    return {
        ETF_TYPE,
        VALUATION_METHOD,
        ETF_LIST,
        SIGNAL_RULES,
        VIX_DASHBOARD,

        getETFById(id) {
            return ETF_LIST.find(e => e.id === id);
        },

        getETFByCode(code) {
            return ETF_LIST.find(e => e.code === code);
        },

        getSignalRules(ruleKey) {
            return SIGNAL_RULES[ruleKey] || SIGNAL_RULES.buffett_growth;
        },

        getAllETFIds() {
            return ETF_LIST.map(e => e.id);
        },

        isVIXDashboard(id) {
            return id === VIX_DASHBOARD.id;
        },

        getVIXZone(vixValue) {
            if (!vixValue || isNaN(vixValue)) return null;
            return VIX_DASHBOARD.zones.find(z => vixValue >= z.min && vixValue < z.max) || VIX_DASHBOARD.zones[VIX_DASHBOARD.zones.length - 1];
        },

        getVIXDeviationFromMean(vixValue) {
            if (!vixValue || isNaN(vixValue)) return null;
            const a = VIX_DASHBOARD.anchor;
            const deviation = (vixValue - a.mean) / a.std;
            const percentile = vixValue <= a.pct25 ? (vixValue / a.pct25 * 25) :
                              vixValue <= a.median ? (25 + (vixValue - a.pct25) / (a.median - a.pct25) * 25) :
                              vixValue <= a.pct75 ? (50 + (vixValue - a.median) / (a.pct75 - a.median) * 25) :
                              vixValue <= a.pct90 ? (75 + (vixValue - a.pct75) / (a.pct90 - a.pct75) * 15) :
                              Math.min(100, 90 + (vixValue - a.pct90) / 20 * 10);
            return { deviation: deviation.toFixed(2), percentile: Math.max(0, Math.min(100, percentile)).toFixed(1) };
        }
    };
})();
