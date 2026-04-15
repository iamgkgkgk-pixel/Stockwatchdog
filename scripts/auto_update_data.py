#!/usr/bin/env python3
"""
ETF择时助手 - 自动数据更新脚本
每月自动从公开API获取最新估值数据，更新data/*.json文件

数据源：
1. 蛋卷基金 API (PE/PB/股息率/百分位/ROE) - 主数据源（覆盖部分指数）
2. 东方财富 push2 API (国债收益率、ETF行情) - 辅助数据源
3. 对于无API覆盖的ETF，基于历史趋势外推

使用方法：
  python3 scripts/auto_update_data.py          # 正常更新
  python3 scripts/auto_update_data.py --dry-run # 试运行，不写入文件
  python3 scripts/auto_update_data.py --force   # 强制更新（即使本月已更新）
"""

import json
import os
import sys
import ssl
import time
import re
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path

# macOS Python可能缺少系统CA证书，创建不验证SSL的context作为后备
try:
    _DEFAULT_SSL_CTX = ssl.create_default_context()
except Exception:
    _DEFAULT_SSL_CTX = None

_NOVERIFY_SSL_CTX = ssl.create_default_context()
_NOVERIFY_SSL_CTX.check_hostname = False
_NOVERIFY_SSL_CTX.verify_mode = ssl.CERT_NONE

# ========== 配置 ==========

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"

# 当前年月
NOW = datetime.now()
CURRENT_MONTH = NOW.strftime("%Y-%m")  # e.g. "2026-05"
TODAY = NOW.strftime("%Y-%m-%d")       # e.g. "2026-05-01"

# API超时
API_TIMEOUT = 15  # 秒

# 蛋卷基金API（服务器端可直接请求，无需CORS代理）
DANJUAN_API = "https://danjuanfunds.com/djapi/index_eva/dj"

# 东方财富API
EASTMONEY_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"

# ========== ETF配置映射（与etf-config.js保持一致）==========

ETF_CONFIGS = [
    # A股价值型
    {
        "id": "dividend-low-vol",
        "file": "dividend-low-vol.json",
        "type": "a_value",
        "danjuanCode": "CSIH30269",
        "secid": "1.512890",
        "useBondSpread": True,
        "bondType": "cn",  # cn=中国10Y, us=美国10Y
    },
    {
        "id": "history",
        "file": "history.json",
        "type": "a_value",
        "danjuanCode": "CSIH30269",  # 与dividend-low-vol相同
        "secid": "1.512890",
        "useBondSpread": True,
        "bondType": "cn",
    },
    {
        "id": "free-cashflow",
        "file": "free-cashflow.json",
        "type": "a_value",
        "danjuanCode": None,
        "secid": "0.159201",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # A股宽基
    {
        "id": "csi300",
        "file": "csi300.json",
        "type": "a_broad",
        "danjuanCode": "SH000300",
        "secid": "1.510300",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # A股成长型
    {
        "id": "sci-tech-50",
        "file": "sci-tech-50.json",
        "type": "a_growth",
        "danjuanCode": None,
        "secid": "1.588300",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "gem-50",
        "file": "gem-50.json",
        "type": "a_growth",
        "danjuanCode": "SZ399673",
        "secid": "0.159949",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "pharma",
        "file": "pharma.json",
        "type": "a_pharma",
        "danjuanCode": "SH000978",
        "secid": "1.512010",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "sci-semi",
        "file": "sci-semi.json",
        "type": "a_growth",
        "danjuanCode": None,
        "secid": "1.588170",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "robot",
        "file": "robot.json",
        "type": "a_growth",
        "danjuanCode": None,
        "secid": "1.562500",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "energy-storage",
        "file": "energy-storage.json",
        "type": "a_growth_new",  # 特殊格式：dividendHistory而非dividendYieldHistory
        "danjuanCode": None,
        "secid": "0.159566",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "pcb",
        "file": "pcb.json",
        "type": "a_growth_new",
        "danjuanCode": None,
        "secid": "1.515260",
        "useBondSpread": False,
        "bondType": "cn",
    },
    # 美股
    {
        "id": "sp500-cn",
        "file": "sp500-cn.json",
        "type": "us_stock",
        "danjuanCode": "SP500",
        "secid": "1.513650",
        "useBondSpread": False,
        "bondType": "us",
    },
    {
        "id": "nasdaq100-cn",
        "file": "nasdaq100-cn.json",
        "type": "us_stock",
        "danjuanCode": "NDX",
        "secid": "1.513110",
        "useBondSpread": False,
        "bondType": "us",
    },
    # 港股
    {
        "id": "hstech",
        "file": "hstech.json",
        "type": "hk_stock",
        "danjuanCode": "HKHSTECH",
        "secid": "1.513180",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "hk-soe-dividend",
        "file": "hk-soe-dividend.json",
        "type": "hk_dividend",
        "danjuanCode": None,
        "secid": "1.513901",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # 日股
    {
        "id": "nikkei225",
        "file": "nikkei225.json",
        "type": "jp_stock",
        "danjuanCode": None,
        "secid": "1.513520",
        "useBondSpread": False,
        "bondType": "jp",
    },
    {
        "id": "topix",
        "file": "topix.json",
        "type": "jp_stock",
        "danjuanCode": None,
        "secid": "1.513800",
        "useBondSpread": False,
        "bondType": "jp",
    },
    # 商品
    {
        "id": "gold",
        "file": "gold.json",
        "type": "commodity",
        "danjuanCode": None,
        "secid": "1.518850",
        "useBondSpread": False,
        "bondType": None,
    },
    {
        "id": "soybean-meal",
        "file": "soybean-meal.json",
        "type": "commodity",
        "danjuanCode": None,
        "secid": "0.159985",
        "useBondSpread": False,
        "bondType": None,
    },
    # 债券
    {
        "id": "bond-10y",
        "file": "bond-10y.json",
        "type": "bond",
        "danjuanCode": None,
        "secid": "1.511260",
        "useBondSpread": True,
        "bondType": "cn",
    },
]


# ========== API请求工具 ==========

def _urlopen_with_ssl_fallback(req, timeout=API_TIMEOUT):
    """尝试正常SSL连接，失败则用不验证的context（兼容macOS证书问题）"""
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=_DEFAULT_SSL_CTX)
    except (ssl.SSLError, urllib.error.URLError):
        return urllib.request.urlopen(req, timeout=timeout, context=_NOVERIFY_SSL_CTX)


def fetch_json(url, headers=None, timeout=API_TIMEOUT):
    """发送HTTP GET请求获取JSON"""
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
    try:
        with _urlopen_with_ssl_fallback(req, timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except Exception as e:
        print(f"  ⚠️  请求失败 {url[:80]}...: {e}")
        return None


def fetch_jsonp(url, params=None, timeout=API_TIMEOUT):
    """发送东方财富JSONP请求并解析"""
    if params is None:
        params = {}
    params["cb"] = "callback"
    query = "&".join(f"{k}={v}" for k, v in params.items())
    full_url = f"{url}?{query}"
    
    req = urllib.request.Request(full_url)
    req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
    req.add_header("Referer", "https://quote.eastmoney.com/")
    try:
        with _urlopen_with_ssl_fallback(req, timeout) as resp:
            raw = resp.read().decode("utf-8")
            match = re.search(r'callback\((.*)\)', raw, re.DOTALL)
            if match:
                return json.loads(match.group(1))
            return None
    except Exception as e:
        print(f"  ⚠️  JSONP请求失败: {e}")
        return None


# ========== 数据获取函数 ==========

# 缓存：蛋卷基金全量数据（一次请求获取所有指数）
_danjuan_cache = None

def fetch_danjuan_all():
    """获取蛋卷基金所有指数估值数据"""
    global _danjuan_cache
    if _danjuan_cache is not None:
        return _danjuan_cache
    
    print("📊 获取蛋卷基金估值数据...")
    data = fetch_json(DANJUAN_API, headers={"Referer": "https://danjuanfunds.com/"})
    if data and data.get("data") and data["data"].get("items"):
        items = data["data"]["items"]
        _danjuan_cache = {item.get("index_code", ""): item for item in items}
        print(f"  ✅ 获取到 {len(items)} 个指数数据")
        return _danjuan_cache
    
    print("  ❌ 蛋卷基金API获取失败")
    _danjuan_cache = {}
    return _danjuan_cache


def get_danjuan_valuation(danjuan_code):
    """从蛋卷基金获取指定指数的估值数据"""
    if not danjuan_code:
        return None
    
    all_data = fetch_danjuan_all()
    item = all_data.get(danjuan_code)
    if not item:
        # 尝试模糊匹配
        for code, v in all_data.items():
            if danjuan_code in code or code in danjuan_code:
                item = v
                break
    
    if not item:
        return None
    
    # 解析数据
    raw_yield = float(item.get("yeild") or item.get("dy") or 0)
    raw_pe_pct = float(item.get("pe_percentile") or 0)
    raw_pb_pct = float(item.get("pb_percentile") or 0)
    raw_roe = float(item.get("roe") or 0)
    
    return {
        "pe": float(item.get("pe") or 0),
        "pb": float(item.get("pb") or 0),
        "dividendYield": raw_yield * 100 if raw_yield < 1 else raw_yield,
        "pePercentile": raw_pe_pct * 100 if raw_pe_pct < 1 else raw_pe_pct,
        "pbPercentile": raw_pb_pct * 100 if raw_pb_pct < 1 else raw_pb_pct,
        "roe": raw_roe * 100 if raw_roe < 1 else raw_roe,
        "name": item.get("name", ""),
    }


# 缓存：国债收益率
_bond_yields = {}

def fetch_cn_bond_yield():
    """获取中国10年期国债收益率"""
    if "cn" in _bond_yields:
        return _bond_yields["cn"]
    
    print("🏦 获取中国10年期国债收益率...")
    data = fetch_jsonp(EASTMONEY_QUOTE, {
        "secid": "171.CN10Y",
        "fields": "f43,f57,f58,f60,f170",
        "invt": "2", "fltt": "2",
        "ut": "fa5fd1943c7b386f172d6893dbbd2"
    })
    
    if data and data.get("data"):
        yield_val = data["data"].get("f43")
        if yield_val and yield_val != "-":
            val = round(float(yield_val), 2)
            _bond_yields["cn"] = val
            print(f"  ✅ 中国10Y国债: {val}%")
            return val
    
    print("  ❌ 中国10Y国债收益率获取失败，使用默认值1.82%")
    _bond_yields["cn"] = 1.82
    return 1.82


def fetch_us_bond_yield():
    """获取美国10年期国债收益率（通过东方财富）"""
    if "us" in _bond_yields:
        return _bond_yields["us"]
    
    print("🏦 获取美国10年期国债收益率...")
    data = fetch_jsonp(EASTMONEY_QUOTE, {
        "secid": "171.ZCUS10Y",
        "fields": "f43,f57,f58,f60,f170",
        "invt": "2", "fltt": "2",
        "ut": "fa5fd1943c7b386f172d6893dbbd2"
    })
    
    if data and data.get("data"):
        yield_val = data["data"].get("f43")
        if yield_val and yield_val != "-":
            val = round(float(yield_val), 2)
            _bond_yields["us"] = val
            print(f"  ✅ 美国10Y国债: {val}%")
            return val
    
    print("  ⚠️  美国10Y国债收益率获取失败，使用默认值4.31%")
    _bond_yields["us"] = 4.31
    return 4.31


def fetch_etf_price(secid):
    """获取ETF最新价格"""
    data = fetch_jsonp(EASTMONEY_QUOTE, {
        "secid": secid,
        "fields": "f43,f57,f58,f60,f170",
        "invt": "2", "fltt": "2",
        "ut": "fa5fd1943c7b386f172d6893dbbd2"
    })
    
    if data and data.get("data"):
        d = data["data"]
        price = d.get("f43")
        change = d.get("f170")
        if price and price != "-":
            return {
                "price": float(price),
                "priceChange": float(change) if change and change != "-" else 0,
            }
    return None


# ========== 数据趋势外推 ==========

def extrapolate_value(history, field="value"):
    """基于历史数据最近N个月的趋势，外推下一个月的值"""
    if not history or len(history) < 2:
        return None
    
    # 取最近3个数据点
    recent = history[-3:] if len(history) >= 3 else history[-2:]
    values = [entry.get(field, entry.get("value")) for entry in recent if entry.get(field, entry.get("value")) is not None]
    
    if len(values) < 2:
        return values[-1] if values else None
    
    # 简单线性外推：用最近2个点的平均变化率
    diffs = [values[i] - values[i-1] for i in range(1, len(values))]
    avg_diff = sum(diffs) / len(diffs)
    
    # 限制变化幅度（防止极端外推）
    last_val = values[-1]
    if last_val != 0:
        max_change = abs(last_val) * 0.15  # 最多变化15%
        avg_diff = max(-max_change, min(max_change, avg_diff))
    
    return round(last_val + avg_diff, 2)


def extrapolate_percentile(history):
    """外推PE百分位"""
    if not history or len(history) < 2:
        return None
    
    recent = history[-3:] if len(history) >= 3 else history[-2:]
    pcts = [entry.get("percentile") for entry in recent if entry.get("percentile") is not None]
    
    if len(pcts) < 2:
        return pcts[-1] if pcts else 50.0
    
    diffs = [pcts[i] - pcts[i-1] for i in range(1, len(pcts))]
    avg_diff = sum(diffs) / len(diffs)
    
    # 百分位限制在0-100
    result = pcts[-1] + avg_diff
    return round(max(0.1, min(99.9, result)), 1)


# ========== 更新数据文件 ==========

def has_month_data(history_array, month):
    """检查历史数组中是否已有指定月份的数据"""
    if not history_array:
        return False
    return any(entry.get("date") == month for entry in history_array)


def update_standard_equity(data, config, api_data, cn_bond, us_bond):
    """
    更新标准权益类ETF（A股价值/宽基/成长/港股/医药等）
    数据格式：peHistory + dividendYieldHistory + bondYieldHistory [+ spreadHistory] + currentData
    """
    updated = False
    
    # PE数据
    if "peHistory" in data:
        if not has_month_data(data["peHistory"], CURRENT_MONTH):
            pe_val = None
            pe_pct = None
            
            if api_data:
                pe_val = api_data.get("pe")
                pe_pct = api_data.get("pePercentile")
            
            if not pe_val:
                pe_val = extrapolate_value(data["peHistory"])
            if not pe_pct:
                pe_pct = extrapolate_percentile(data["peHistory"])
            
            if pe_val:
                entry = {"date": CURRENT_MONTH, "value": round(pe_val, 2), "percentile": round(pe_pct or 50, 1)}
                data["peHistory"].append(entry)
                updated = True
                print(f"    PE: {pe_val} ({pe_pct}%tile)")
    
    # 股息率
    if "dividendYieldHistory" in data:
        if not has_month_data(data["dividendYieldHistory"], CURRENT_MONTH):
            dy_val = None
            if api_data:
                dy_val = api_data.get("dividendYield")
            if not dy_val:
                dy_val = extrapolate_value(data["dividendYieldHistory"])
            
            if dy_val:
                data["dividendYieldHistory"].append({"date": CURRENT_MONTH, "value": round(dy_val, 2)})
                updated = True
                print(f"    股息率: {dy_val}%")
    
    # 国债收益率
    if "bondYieldHistory" in data:
        if not has_month_data(data["bondYieldHistory"], CURRENT_MONTH):
            bond_val = cn_bond if config["bondType"] == "cn" else us_bond
            if bond_val:
                data["bondYieldHistory"].append({"date": CURRENT_MONTH, "value": round(bond_val, 2)})
                updated = True
                print(f"    国债收益率: {bond_val}%")
    
    # 利差（spreadHistory）
    if "spreadHistory" in data:
        if not has_month_data(data["spreadHistory"], CURRENT_MONTH):
            # 利差 = 股息率 - 国债收益率
            dy = None
            bond = cn_bond if config["bondType"] == "cn" else us_bond
            
            if api_data and api_data.get("dividendYield"):
                dy = api_data["dividendYield"]
            elif "dividendYieldHistory" in data and data["dividendYieldHistory"]:
                dy = data["dividendYieldHistory"][-1].get("value")
            
            if dy and bond:
                spread = round(dy - bond, 2)
                data["spreadHistory"].append({"date": CURRENT_MONTH, "value": spread})
                updated = True
                print(f"    利差: {spread}%")
    
    # 更新currentData
    if "currentData" in data and updated:
        cd = data["currentData"]
        if api_data:
            if api_data.get("pe"): cd["pe"] = round(api_data["pe"], 2)
            if api_data.get("pePercentile"): cd["pePercentile"] = round(api_data["pePercentile"], 2)
            if api_data.get("pb"): cd["pb"] = round(api_data["pb"], 2)
            if api_data.get("pbPercentile"): cd["pbPercentile"] = round(api_data["pbPercentile"], 2)
            if api_data.get("dividendYield"): cd["dividendYield"] = round(api_data["dividendYield"], 2)
        
        bond = cn_bond if config["bondType"] == "cn" else us_bond
        if bond: cd["bondYield"] = round(bond, 2)
        
        if cd.get("dividendYield") and cd.get("bondYield"):
            cd["spread"] = round(cd["dividendYield"] - cd["bondYield"], 2)
        
        cd["updateTime"] = TODAY
    
    return updated


def update_new_growth(data, config, api_data, cn_bond):
    """
    更新新型成长行业ETF（energy-storage, pcb）
    数据格式：peHistory + dividendHistory（非dividendYieldHistory） + bondYieldHistory，无currentData
    """
    updated = False
    
    # PE数据
    if "peHistory" in data:
        if not has_month_data(data["peHistory"], CURRENT_MONTH):
            pe_val = extrapolate_value(data["peHistory"])
            pe_pct = extrapolate_percentile(data["peHistory"])
            
            if pe_val:
                data["peHistory"].append({"date": CURRENT_MONTH, "value": round(pe_val, 1), "percentile": round(pe_pct or 50, 1)})
                updated = True
                print(f"    PE: {pe_val} ({pe_pct}%tile)")
    
    # dividendHistory（注意不是dividendYieldHistory）
    if "dividendHistory" in data:
        if not has_month_data(data["dividendHistory"], CURRENT_MONTH):
            dh_val = extrapolate_value(data["dividendHistory"])
            if dh_val:
                data["dividendHistory"].append({"date": CURRENT_MONTH, "value": round(dh_val, 2)})
                updated = True
                print(f"    股息: {dh_val}")
    
    # bondYieldHistory
    if "bondYieldHistory" in data:
        if not has_month_data(data["bondYieldHistory"], CURRENT_MONTH):
            data["bondYieldHistory"].append({"date": CURRENT_MONTH, "value": round(cn_bond, 2)})
            updated = True
            print(f"    国债收益率: {cn_bond}%")
    
    return updated


def update_commodity(data, config):
    """
    更新商品ETF（黄金、豆粕）
    数据格式：priceHistory + currentData
    """
    updated = False
    
    if "priceHistory" in data:
        if not has_month_data(data["priceHistory"], CURRENT_MONTH):
            # 尝试获取实时价格
            price_data = fetch_etf_price(config["secid"])
            price = None
            change = 0
            
            if price_data:
                price = price_data["price"]
                change = price_data["priceChange"]
            else:
                price = extrapolate_value(data["priceHistory"])
            
            if price:
                data["priceHistory"].append({"date": CURRENT_MONTH, "value": round(price, 2)})
                updated = True
                print(f"    价格: {price}")
                
                # 更新currentData
                if "currentData" in data:
                    data["currentData"]["price"] = round(price, 2)
                    data["currentData"]["priceChange"] = round(change, 2)
                    data["currentData"]["updateTime"] = TODAY
    
    return updated


def update_bond(data, config, cn_bond):
    """
    更新债券ETF
    数据格式：bondYieldHistory + currentData
    """
    updated = False
    
    if "bondYieldHistory" in data:
        if not has_month_data(data["bondYieldHistory"], CURRENT_MONTH):
            data["bondYieldHistory"].append({"date": CURRENT_MONTH, "value": round(cn_bond, 2)})
            updated = True
            print(f"    国债收益率: {cn_bond}%")
            
            # 更新currentData
            if "currentData" in data:
                data["currentData"]["bondYield"] = round(cn_bond, 2)
                data["currentData"]["updateTime"] = TODAY
    
    return updated


# ========== 主流程 ==========

def main():
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    
    print("=" * 60)
    print(f"🚀 ETF择时助手 - 自动数据更新")
    print(f"📅 更新月份: {CURRENT_MONTH}")
    print(f"📁 数据目录: {DATA_DIR}")
    if dry_run:
        print("⚠️  试运行模式：不会写入文件")
    if force:
        print("⚠️  强制更新模式")
    print("=" * 60)
    
    # 1. 获取实时国债收益率
    cn_bond = fetch_cn_bond_yield()
    us_bond = fetch_us_bond_yield()
    
    # 2. 获取蛋卷基金全量数据（一次请求）
    fetch_danjuan_all()
    
    # 3. 逐个更新ETF数据文件
    updated_count = 0
    skipped_count = 0
    error_count = 0
    
    for config in ETF_CONFIGS:
        file_path = DATA_DIR / config["file"]
        etf_id = config["id"]
        
        if not file_path.exists():
            print(f"\n❌ 文件不存在: {config['file']}")
            error_count += 1
            continue
        
        print(f"\n📄 处理: {config['file']} ({etf_id})")
        
        # 读取现有数据
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  ❌ 读取失败: {e}")
            error_count += 1
            continue
        
        # 检查是否已更新到当前月
        if not force:
            last_update = data.get("lastUpdate", "")
            if last_update and last_update >= CURRENT_MONTH[:7]:
                # 检查各数组是否都已有当月数据
                all_arrays_updated = True
                for key in ["peHistory", "priceHistory", "bondYieldHistory"]:
                    if key in data and not has_month_data(data[key], CURRENT_MONTH):
                        all_arrays_updated = False
                        break
                
                if all_arrays_updated:
                    print(f"  ⏭️  已是最新 (lastUpdate={last_update})")
                    skipped_count += 1
                    continue
        
        # 获取蛋卷基金估值数据
        api_data = None
        if config.get("danjuanCode"):
            api_data = get_danjuan_valuation(config["danjuanCode"])
            if api_data:
                print(f"  📊 蛋卷数据: PE={api_data.get('pe')}, 百分位={api_data.get('pePercentile')}%, 股息率={api_data.get('dividendYield')}%")
        
        # 根据类型调用不同的更新函数
        updated = False
        try:
            etf_type = config["type"]
            
            if etf_type in ("a_value", "a_broad", "a_growth", "a_pharma", "hk_stock", "hk_dividend", "us_stock", "jp_stock"):
                updated = update_standard_equity(data, config, api_data, cn_bond, us_bond)
            elif etf_type == "a_growth_new":
                updated = update_new_growth(data, config, api_data, cn_bond)
            elif etf_type == "commodity":
                updated = update_commodity(data, config)
            elif etf_type == "bond":
                updated = update_bond(data, config, cn_bond)
            else:
                print(f"  ⚠️  未知类型: {etf_type}")
                
        except Exception as e:
            print(f"  ❌ 更新出错: {e}")
            error_count += 1
            continue
        
        if updated:
            data["lastUpdate"] = TODAY
            
            if not dry_run:
                # 写入文件
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"  ✅ 已更新并保存")
            else:
                print(f"  ✅ 已计算（试运行，未保存）")
            
            updated_count += 1
        else:
            print(f"  ⏭️  无需更新")
            skipped_count += 1
        
        # 避免请求过快
        time.sleep(0.3)
    
    # 4. 汇总
    print("\n" + "=" * 60)
    print(f"📊 更新完成!")
    print(f"  ✅ 已更新: {updated_count} 个文件")
    print(f"  ⏭️  跳过:   {skipped_count} 个文件")
    print(f"  ❌ 错误:   {error_count} 个文件")
    print(f"  📅 数据月份: {CURRENT_MONTH}")
    print(f"  🏦 中国10Y国债: {cn_bond}%")
    print(f"  🏦 美国10Y国债: {us_bond}%")
    print("=" * 60)
    
    # 如果有错误，返回非零退出码
    if error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
