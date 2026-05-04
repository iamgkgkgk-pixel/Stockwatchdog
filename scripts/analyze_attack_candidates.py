#!/usr/bin/env python3
"""分析进攻仓候选标的的PE历史数据情况"""
import json
import os
import statistics

FILES = {
    "纳指100": "nasdaq100-cn.json",
    "标普500": "sp500-cn.json",
    "科创50": "sci-tech-50.json",
    "创业板50": "gem-50.json",
    "沪深300": "csi300.json",
    "医药": "pharma.json",
    "恒生科技": "hstech.json",
    "上证50": "sse50.json",
    "[候选]道琼斯": "dow-jones.json",
    "[候选]科创半导体": "sci-semi.json",
    "[候选]机器人": "robot.json",
    "[候选]PCB": "pcb.json",
    "[候选]储能": "energy-storage.json",
    "[候选]自由现金流": "free-cashflow.json",
}


def main():
    base = os.path.join(os.path.dirname(__file__), "..", "data")
    header = f"{'标的':<14} {'总量':>5} {'起始':>10} {'结束':>10} {'PE均值':>7} {'标准差':>7} {'最小':>7} {'最大':>7} {'5Y量':>5} {'极差/均':>8}"
    print(header)
    print("-" * len(header))

    for name, f in FILES.items():
        path = os.path.join(base, f)
        if not os.path.exists(path):
            print(f"{name:<14} 文件不存在")
            continue
        with open(path) as fp:
            data = json.load(fp)
        pe_hist = data.get("peHistory", [])
        if not pe_hist:
            print(f"{name:<14} 无peHistory")
            continue
        pairs = [(d["date"], d["value"]) for d in pe_hist if d.get("value") and d["value"] > 0]
        if not pairs:
            print(f"{name:<14} PE全为0")
            continue
        pairs.sort(key=lambda x: x[0])
        values = [v for _, v in pairs]
        dates = [d for d, _ in pairs]
        n = len(values)
        mean = statistics.mean(values)
        std = statistics.stdev(values) if n > 1 else 0
        mn = min(values)
        mx = max(values)
        last_5y = sum(1 for d in dates if d >= "2021-05")
        range_ratio = (mx - mn) / mean if mean else 0  # 波动范围 / 均值
        print(
            f"{name:<14} {n:>5} {dates[0][:10]:>10} {dates[-1][:10]:>10} "
            f"{mean:>7.2f} {std:>7.2f} {mn:>7.2f} {mx:>7.2f} {last_5y:>5} {range_ratio:>8.2f}"
        )


if __name__ == "__main__":
    main()
