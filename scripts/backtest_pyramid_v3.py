"""
进攻仓·金字塔策略 v3 — 引入利率周期过滤
========================================

v2 发现的问题：
  - 恒生科技 2022-2023 跌 50% 不是机会，是美联储加息挤泡沫（流动性危机）
  - 金字塔策略"越跌越买"在加息周期会持续被套

v3 核心改进：
  1. **双利率判定**：美国10Y为主 + 中国10Y为辅
     - 两者一致 → 信号加强
     - 两者冲突 → 以美联储为准（美元流动性决定全球风险资产定价）
  2. **加息周期完全禁止新建仓**：现有持仓自动平仓转现金
  3. **利率周期档位**：
     - HIKE_STRONG（美联储加息 + 中国降息/平台）   → 🔴 禁止
     - HIKE_WEAK（仅一方加息）                      → 🟡 现有仓位减半
     - NEUTRAL（双方持平或小幅波动）                 → 🟢 正常金字塔
     - CUT_WEAK（仅一方降息）                       → 🟢 正常金字塔（略激进）
     - CUT_STRONG（双方降息）                       → 🟢🟢 放宽阈值0.5σ（抄底良机）

利率斜率判定（窗口=3个月）：
     斜率 > +0.30% → 加息
     斜率 < -0.30% → 降息
     |斜率| ≤ 0.30% → 平台/中性

用法：
  python3 scripts/backtest_pyramid_v3.py
  python3 scripts/backtest_pyramid_v3.py --etf hstech --verbose
"""

import json
import argparse
import statistics
from pathlib import Path


ATTACK_POOL = [
    ("nasdaq100-cn", "纳指100", "美股"),
    ("sp500-cn", "标普500", "美股"),
    ("sci-tech-50", "科创50", "A股"),
    ("gem-50", "创业板50", "A股"),
    ("csi300", "沪深300", "A股"),
    ("pharma", "医药", "行业"),
    ("hstech", "恒生科技", "港股"),
    ("sse50", "上证50", "A股"),
    ("sci-semi", "科创半导体(AI荐)", "行业"),
]


# ========== 工具函数 ==========

def load_json(path):
    p = Path(path)
    if not p.exists():
        return None
    with open(p) as f:
        return json.load(f)


def load_etf_data(etf_id):
    return load_json(f"data/{etf_id}.json")


def get_pe_series(data):
    series = [
        (x["date"], x["value"])
        for x in data.get("peHistory", [])
        if len(x["date"]) == 7 and x.get("value") and x["value"] > 0
    ]
    series.sort(key=lambda t: t[0])
    return series


def get_yield_map(data, key):
    """返回 {date: yield} 映射"""
    hist = data.get(key, [])
    return {x["date"]: x["value"] for x in hist if len(x["date"]) == 7}


# ========== 利率周期判定（v3改良版）==========

def get_past_values(yield_map, date, months_back):
    """获取某日期往前 months_back 个月的所有值（含当前月）"""
    try:
        y, m = map(int, date.split("-"))
        dates = [date]
        for i in range(1, months_back + 1):
            m2, y2 = m - i, y
            while m2 <= 0:
                m2 += 12
                y2 -= 1
            dates.append(f"{y2:04d}-{m2:02d}")
        dates.reverse()
        return [yield_map[d] for d in dates if d in yield_map]
    except Exception:
        return []


def classify_rate_state(yield_map, date, is_us=True):
    """
    改良版利率档位判定（基于多维度综合）
    
    返回: HIKE(加息中) / HIKE_PEAK(加息顶部震荡) / CUT(降息中) / CUT_BOTTOM(降息尾) / FLAT(平台)
    
    判定规则（水平 + 6月变化 + vs 过去2年均值）：
      - 美10Y:
          水平 ≥ 4% 且 6月变化 ≥ +0.5%  → HIKE（加息进行中）
          水平 ≥ 3.5% 且 12月均值 ≥ 3%   → HIKE_PEAK（高位震荡）
          水平 ≤ 1.5%                     → CUT_BOTTOM
          6月变化 ≤ -0.5%                  → CUT
          6月变化 ≥ +0.5%                  → HIKE
          其他                             → FLAT
      - 中10Y: 阈值全部 /2（中国波动幅度约美国一半）
    """
    if date not in yield_map:
        return "UNKNOWN"
    current = yield_map[date]
    values_6m = get_past_values(yield_map, date, 6)
    values_12m = get_past_values(yield_map, date, 12)
    values_24m = get_past_values(yield_map, date, 24)

    if len(values_6m) < 4:
        return "UNKNOWN"

    change_6m = current - values_6m[0]
    mean_12m = statistics.mean(values_12m) if values_12m else current
    mean_24m = statistics.mean(values_24m) if len(values_24m) >= 12 else mean_12m

    # 美股阈值 (基于历史经验)
    if is_us:
        hike_level = 4.0
        peak_level = 3.5
        bottom_level = 1.5
        change_threshold = 0.5
    else:
        # 中国利率波动窄，阈值减半
        hike_level = 3.0
        peak_level = 2.8
        bottom_level = 1.8
        change_threshold = 0.25

    # 加息中：水平高+6月明显上行
    if current >= hike_level and change_6m >= change_threshold:
        return "HIKE"
    # 加息顶部震荡：水平较高+近12月均值高
    if current >= peak_level and mean_12m >= peak_level - 0.3:
        return "HIKE_PEAK"
    # 降息到底：绝对低位
    if current <= bottom_level:
        return "CUT_BOTTOM"
    # 降息中：6月明显下行
    if change_6m <= -change_threshold:
        return "CUT"
    # 加息中（未达高位但持续上行）
    if change_6m >= change_threshold:
        return "HIKE"
    return "FLAT"


def rate_regime(us_state, cn_state):
    """
    综合利率档位判定（美联储为主）
    返回：(regime, pos_multiplier, allow_new_entry)
    """
    # 档位组合表（以美联储为主导）
    # 🔴 禁止建仓 + 强制平仓 + 减仓
    # 🟡 禁止新建 + 不强制平仓  
    # 🟢 正常建仓
    # 🟢🟢 放宽阈值
    
    if us_state in ("HIKE",):
        return "HIKE_STRONG", 0.0, False  # 🔴 加息进行中，清仓
    
    if us_state == "HIKE_PEAK":
        # 加息顶部震荡：不新建仓，但允许持有（拐点可能随时到来）
        return "HIKE_PEAK", 1.0, False  # 🟡
    
    if us_state == "CUT" and cn_state in ("CUT", "CUT_BOTTOM"):
        return "CUT_STRONG", 1.0, True  # 🟢🟢 双降息，放宽阈值
    
    if us_state == "CUT":
        return "CUT", 1.0, True  # 🟢 美在降息
    
    if us_state == "CUT_BOTTOM":
        return "CUT_BOTTOM", 1.0, True  # 🟢 低利率平台
    
    return "NEUTRAL", 1.0, True  # FLAT/UNKNOWN


def calc_slope(yield_map, date, months_back=3):
    """保留旧版斜率计算供展示用"""
    values = get_past_values(yield_map, date, months_back)
    if len(values) < 2:
        return None
    return (values[-1] - values[0]) / max(1, len(values) - 1)


# ========== 策略 ==========

def rolling_mu_sigma(pe_series, end_idx, window_months=60):
    start = max(0, end_idx - window_months)
    window = [pe for _, pe in pe_series[start:end_idx]]
    if len(window) < 12:
        return None, None, len(window)
    mu = statistics.mean(window)
    sigma = statistics.stdev(window) if len(window) > 1 else 0
    return mu, sigma, len(window)


def calc_pe_percentile(pe, window_values):
    if not window_values:
        return 50.0
    sorted_h = sorted(window_values)
    rank = sum(1 for v in sorted_h if v <= pe)
    return rank / len(sorted_h) * 100


def strategy_buy_hold(pe_series, start_idx):
    if start_idx >= len(pe_series):
        return []
    start_pe = pe_series[start_idx][1]
    return [{"date": d, "nav": pe / start_pe, "pos": 1.0, "action": "HOLD"}
            for d, pe in pe_series[start_idx:]]


def strategy_valuation_mild(pe_series, start_idx, window=60, rate_filter=None):
    """估值温和版 (可选利率过滤)"""
    curve = []
    nav = 1.0
    pos = 0.0
    entry_pe = None

    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        start = max(0, i - window)
        window_pe = [p for _, p in pe_series[start:i]]
        if len(window_pe) < 12:
            curve.append({"date": date, "nav": nav, "pos": pos, "action": "WARMUP"})
            continue
        pct = calc_pe_percentile(pe, window_pe)

        # 利率过滤
        regime, mult, allow_entry = rate_filter(date) if rate_filter else ("NEUTRAL", 1.0, True)

        # 加息期强制平仓
        if regime == "HIKE_STRONG" and pos > 0:
            nav = nav * (pe / entry_pe)
            pos = 0.0
            entry_pe = None
            curve.append({"date": date, "nav": nav, "pos": 0, "action": f"RATE-EXIT({regime})"})
            continue

        if pos == 0 and pct <= 25 and allow_entry:
            pos = 1.0
            entry_pe = pe
            curve.append({"date": date, "nav": nav, "pos": pos, "action": f"BUY({regime})"})
        elif pos == 1.0 and pct >= 60:
            nav *= (pe / entry_pe)
            pos = 0.0
            entry_pe = None
            curve.append({"date": date, "nav": nav, "pos": 0, "action": "SELL"})
        elif pos > 0:
            curve.append({"date": date, "nav": nav * (pe / entry_pe), "pos": pos, "action": "HOLD"})
        else:
            curve.append({"date": date, "nav": nav, "pos": 0.0, "action": f"CASH({regime[:4]})"})

    if pos > 0 and entry_pe:
        last_pe = pe_series[-1][1]
        curve[-1]["nav"] = nav * (last_pe / entry_pe)
        curve[-1]["action"] = "FINAL"
    return curve


def strategy_pyramid(pe_series, start_idx,
                     entry_sigmas, exit_sigmas,
                     window=60, label="pyramid",
                     rate_filter=None):
    """金字塔（可选利率过滤）"""
    curve = []
    trades = []
    nav = 1.0
    pos = 0.0
    avg_entry_pe = None

    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        mu, sigma, win_n = rolling_mu_sigma(pe_series, i, window)

        if mu is None or sigma is None or sigma == 0:
            curve.append({"date": date, "nav": nav, "pos": pos, "action": "WARMUP"})
            continue

        # 利率过滤
        regime, pos_mult, allow_entry = rate_filter(date) if rate_filter else ("NEUTRAL", 1.0, True)

        # 🔴 HIKE_STRONG：强制平仓
        if regime == "HIKE_STRONG" and pos > 0:
            # 按当前PE变现
            nav = nav * (1 - pos) + nav * pos * (pe / avg_entry_pe)
            pos = 0.0
            avg_entry_pe = None
            curve.append({"date": date, "nav": nav, "pos": 0, "action": f"RATE-EXIT", 
                         "pe": pe, "regime": regime, "zone": "FORCE-OUT"})
            trades.append({"date": date, "action": "RATE-EXIT", "pe": pe, "pos": 0, 
                          "zone": "FORCE-OUT", "nav": nav, "regime": regime})
            continue

        # 🟡 HIKE_WEAK：现有仓位减至 pos_mult 倍
        if regime == "HIKE_WEAK" and pos > 0 and pos_mult < 1.0:
            target = pos * pos_mult
            if pos - target > 0.01:
                # 变现一部分
                delta = pos - target
                float_nav = nav * (1 - pos) + nav * pos * (pe / avg_entry_pe)
                nav = float_nav
                pos = target
                curve.append({"date": date, "nav": nav, "pos": pos, "action": f"RATE-REDUCE→{int(pos*100)}%",
                             "pe": pe, "regime": regime, "zone": "RATE-REDUCE"})
                trades.append({"date": date, "action": f"RATE-REDUCE→{int(pos*100)}%", "pe": pe, 
                              "pos": pos, "zone": "RATE-REDUCE", "nav": nav, "regime": regime})
                continue

        # 基于μ/σ计算阈值（降息周期放宽0.25σ）
        sigma_shift = -0.25 if regime == "CUT_STRONG" else 0.0

        buy_th = [mu + (entry_sigmas[0] + sigma_shift) * sigma,
                  mu + (entry_sigmas[1] + sigma_shift) * sigma,
                  mu + (entry_sigmas[2] + sigma_shift) * sigma]
        sell_th = [mu + exit_sigmas[0] * sigma,
                   mu + exit_sigmas[1] * sigma,
                   mu + exit_sigmas[2] * sigma]

        # 目标仓位
        target_pos = pos
        zone = "MID"
        if pe <= buy_th[2] and allow_entry:
            target_pos = 1.0
            zone = "DEEP-BUY"
        elif pe <= buy_th[1] and allow_entry:
            target_pos = max(0.6, pos)
            zone = "HEAVY-BUY"
        elif pe <= buy_th[0] and allow_entry:
            target_pos = max(0.3, pos)
            zone = "LIGHT-BUY"
        elif pe >= sell_th[2]:
            target_pos = 0.0
            zone = "DEEP-SELL"
        elif pe >= sell_th[1]:
            target_pos = min(0.33, pos)
            zone = "HEAVY-SELL"
        elif pe >= sell_th[0]:
            target_pos = min(0.67, pos)
            zone = "LIGHT-SELL"
        else:
            zone = "HOLD-ZONE"

        # 计算浮动净值
        if pos > 0 and avg_entry_pe and avg_entry_pe > 0:
            float_nav = nav * (1 - pos) + nav * pos * (pe / avg_entry_pe)
        else:
            float_nav = nav

        action = "HOLD"
        if abs(target_pos - pos) > 0.01:
            if target_pos > pos:
                # 加仓
                delta = target_pos - pos
                if avg_entry_pe and pos > 0:
                    avg_entry_pe = (pos * avg_entry_pe + delta * pe) / target_pos
                else:
                    avg_entry_pe = pe
                pos = target_pos
                action = f"BUY→{int(target_pos*100)}%"
                trades.append({"date": date, "action": action, "pe": pe, "pos": pos, 
                              "zone": zone, "nav": float_nav, "regime": regime})
            else:
                # 减仓：落袋
                nav = float_nav
                pos = target_pos
                if pos == 0:
                    avg_entry_pe = None
                action = f"SELL→{int(target_pos*100)}%"
                trades.append({"date": date, "action": action, "pe": pe, "pos": pos, 
                              "zone": zone, "nav": nav, "regime": regime})

        # 当前浮动净值
        if pos > 0 and avg_entry_pe:
            cur_nav = nav * (1 - pos) + nav * pos * (pe / avg_entry_pe)
        else:
            cur_nav = nav
        curve.append({"date": date, "nav": cur_nav, "pos": pos, "action": action,
                     "pe": pe, "mu": mu, "sigma": sigma, "zone": zone, "regime": regime})

    # 结算
    if pos > 0 and avg_entry_pe:
        last_pe = pe_series[-1][1]
        final_nav = nav * (1 - pos) + nav * pos * (last_pe / avg_entry_pe)
        curve[-1]["nav"] = final_nav
        curve[-1]["action"] = "FINAL-MARK"

    return curve, trades


# ========== 评估 ==========

def evaluate(curve, label):
    if not curve or len(curve) < 2:
        return None
    real_curve = [c for c in curve if c.get("action") != "WARMUP"]
    if len(real_curve) < 2:
        return None

    navs = [c["nav"] for c in real_curve]
    start_nav = navs[0]
    navs = [n / start_nav for n in navs]
    final_nav = navs[-1]
    total_return = (final_nav - 1) * 100

    peak = navs[0]
    max_dd = 0
    for nav in navs:
        if nav > peak:
            peak = nav
        dd = (peak - nav) / peak * 100 if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd

    months = len(real_curve)
    years = months / 12 if months > 0 else 1
    annualized = (final_nav ** (1 / years) - 1) * 100 if final_nav > 0 else 0

    trade_count = sum(1 for c in real_curve if c.get("action", "").startswith(("BUY", "SELL", "RATE")))
    cash_count = sum(1 for c in real_curve if c.get("pos", 0) == 0)
    cash_ratio = cash_count / len(real_curve) * 100
    avg_pos = statistics.mean([c.get("pos", 0) for c in real_curve])

    return {
        "策略": label,
        "净值": f"{final_nav:.3f}",
        "总收益%": f"{total_return:+.1f}",
        "年化%": f"{annualized:+.1f}",
        "回撤%": f"-{max_dd:.1f}",
        "月数": months,
        "交易": trade_count,
        "空仓%": f"{cash_ratio:.0f}",
        "均仓%": f"{avg_pos*100:.0f}",
    }


def make_rate_filter():
    """返回 rate_filter(date) 函数"""
    us_data = load_json("data/us-10y.json")
    cn_data = load_json("data/bond-10y.json")
    us_map = {x["date"]: x["value"] for x in us_data.get("yieldHistory", [])} if us_data else {}
    cn_map = {x["date"]: x["value"] for x in cn_data.get("bondYieldHistory", [])} if cn_data else {}

    def filter_fn(date):
        us_state = classify_rate_state(us_map, date, is_us=True)
        cn_state = classify_rate_state(cn_map, date, is_us=False)
        return rate_regime(us_state, cn_state)
    return filter_fn, us_map, cn_map


def backtest_etf(etf_id, display_name, market, years=5, verbose=False, rate_filter=None):
    data = load_etf_data(etf_id)
    if not data:
        print(f"\n❌ {display_name} 无数据")
        return None
    pe_series = get_pe_series(data)
    if len(pe_series) < 24:
        print(f"\n❌ {display_name} 数据不足")
        return None

    months_back = years * 12
    start_idx = max(0, len(pe_series) - months_back)
    start_date = pe_series[start_idx][0]
    end_date = pe_series[-1][0]

    print(f"\n{'='*96}")
    print(f"  📊 {display_name} [{market}] ({etf_id})  {start_date}→{end_date}  {len(pe_series)-start_idx}月")
    print('='*96)

    results = []
    results.append(evaluate(strategy_buy_hold(pe_series, start_idx), "1.买入持有"))

    # v2 基线（无利率过滤）
    eq_mild_v2 = strategy_valuation_mild(pe_series, start_idx, rate_filter=None)
    results.append(evaluate(eq_mild_v2, "2.估值温和(无过滤)"))

    eq_p_strict_v2, _ = strategy_pyramid(pe_series, start_idx, (-1.0, -1.5, -2.0), (0.0, 1.0, 1.5), rate_filter=None)
    results.append(evaluate(eq_p_strict_v2, "3.金字塔严(无过滤)"))

    eq_p_mid_v2, _ = strategy_pyramid(pe_series, start_idx, (-0.5, -1.0, -1.5), (0.5, 1.0, 1.5), rate_filter=None)
    results.append(evaluate(eq_p_mid_v2, "4.金字塔中(无过滤)"))

    # v3 带利率过滤
    eq_mild_v3 = strategy_valuation_mild(pe_series, start_idx, rate_filter=rate_filter)
    results.append(evaluate(eq_mild_v3, "5.估值温和+利率"))

    eq_p_strict_v3, trades_s = strategy_pyramid(pe_series, start_idx, (-1.0, -1.5, -2.0), (0.0, 1.0, 1.5), rate_filter=rate_filter)
    results.append(evaluate(eq_p_strict_v3, "6.金字塔严+利率"))

    eq_p_mid_v3, trades_m = strategy_pyramid(pe_series, start_idx, (-0.5, -1.0, -1.5), (0.5, 1.0, 1.5), rate_filter=rate_filter)
    results.append(evaluate(eq_p_mid_v3, "7.金字塔中+利率"))

    eq_p_wide_v3, trades_w = strategy_pyramid(pe_series, start_idx, (0.0, -0.5, -1.0), (1.0, 1.5, 2.0), rate_filter=rate_filter)
    results.append(evaluate(eq_p_wide_v3, "8.金字塔宽+利率"))

    results = [r for r in results if r]
    if results:
        keys = list(results[0].keys())
        col_widths = {k: max(len(k), max(len(str(r[k])) for r in results)) + 2 for k in keys}
        print("".join(f"{k:<{col_widths[k]}}" for k in keys))
        print("-" * sum(col_widths.values()))
        for r in results:
            print("".join(f"{str(r[k]):<{col_widths[k]}}" for k in keys))

    if verbose:
        for label, trades in [("严+利率", trades_s), ("中+利率", trades_m), ("宽+利率", trades_w)]:
            if trades:
                print(f"\n  🎯 金字塔·{label} 交易 ({len(trades)}次):")
                for t in trades[:20]:
                    print(f"     {t['date']}  {t['action']:<16} PE={t['pe']:>6.2f} {t['zone']:<12} [{t.get('regime','')}] 净值={t['nav']:.3f}")

    return {
        "etf": display_name, "market": market,
        "results": results
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--etf", default=None)
    parser.add_argument("--years", type=int, default=5)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    print("=" * 96)
    print("  进攻仓·金字塔 v3 — 加入双利率周期过滤（美联储主+中国辅）")
    print(f"  回测期: 近 {args.years} 年 | 加息期策略: 全部平仓回现金")
    print("=" * 96)

    rate_filter, us_map, cn_map = make_rate_filter()

    # 展示利率周期全景
    print("\n  📈 近5年利率周期识别（多维度综合判定）:")
    print("  " + "-"*100)
    print(f"  {'日期':<10} {'美10Y':>7} {'美状态':<12} {'中10Y':>7} {'中状态':<12} {'综合档位':<15} {'可建仓':<6}")
    print("  " + "-"*100)
    sample_dates = sorted(us_map.keys())[-60:]
    for i, d in enumerate(sample_dates):
        if i % 3 == 0 or i == len(sample_dates) - 1:
            us_v = us_map.get(d, 0)
            cn_v = cn_map.get(d, 0)
            us_st = classify_rate_state(us_map, d, True)
            cn_st = classify_rate_state(cn_map, d, False)
            regime, mult, allow = rate_regime(us_st, cn_st)
            allow_str = "✅" if allow else "❌"
            print(f"  {d:<10} {us_v:>7.2f} {us_st:<12} {cn_v:>7.2f} {cn_st:<12} {regime:<15} {allow_str}")
    print()

    if args.etf:
        targets = [(t[0], t[1], t[2]) for t in ATTACK_POOL if t[0] == args.etf]
        if not targets:
            targets = [(args.etf, args.etf, "指定")]
    else:
        targets = ATTACK_POOL

    all_results = []
    for etf_id, name, market in targets:
        r = backtest_etf(etf_id, name, market, args.years, args.verbose, rate_filter)
        if r:
            all_results.append(r)

    # 汇总
    print(f"\n{'='*96}")
    print("  🏆 跨标的汇总 · 年化收益% (利率过滤前 vs 过滤后)")
    print("=" * 96)

    markets = {}
    for r in all_results:
        markets.setdefault(r["market"], []).append(r)

    for market_name in ["美股", "A股", "港股", "行业", "指定"]:
        if market_name not in markets:
            continue
        print(f"\n  【{market_name}】")
        header = f"  {'标的':<18}"
        for s in all_results[0]["results"]:
            header += f" {s['策略'][:12]:>14}"
        print(header)
        for r in markets[market_name]:
            row = f"  {r['etf']:<18}"
            for res in r["results"]:
                row += f" {res['年化%']:>14}"
            print(row)

    print(f"\n{'='*96}")
    print("  📌 关键看点:")
    print("  - 对比 3 vs 6 / 4 vs 7：利率过滤对金字塔策略的增益")
    print("  - 关注 恒生科技 / 科创50 / 科创半导体 在2022-2024加息期的表现改善")
    print("  - RATE-EXIT 出现的时点 = 美联储加息确认")
    print("=" * 96)


if __name__ == "__main__":
    main()
