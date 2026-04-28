#!/usr/bin/env python3
"""
ETF择时助手 - 每日数据采样脚本
每个交易日自动从公开API获取最新估值数据，以日级别(YYYY-MM-DD)粒度追加到data/*.json

与月度脚本(auto_update_data.py)的区别：
- 月度脚本：每月运行一次，写入 "2026-04" 格式的月度汇总数据
- 日度脚本：每天运行一次，写入 "2026-04-28" 格式的日级别采样数据
- 两者共存：前端interpolateFromMap会优先使用日级别数据点，日级别数据不存在时才对月级别做插值

数据源：
1. 蛋卷基金 API (PE/股息率) - 主数据源
2. 东方财富 API (国债收益率) - 辅助数据源

使用方法：
  python3 scripts/daily_update_data.py              # 正常更新（今天）
  python3 scripts/daily_update_data.py --dry-run     # 试运行，不写入文件
  python3 scripts/daily_update_data.py --force        # 强制更新（即使今天已更新）
  python3 scripts/daily_update_data.py --date 2026-04-25  # 指定日期（用于补录）
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

# macOS Python可能缺少系统CA证书
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

NOW = datetime.now()
API_TIMEOUT = 15

# 蛋卷基金API
DANJUAN_API = "https://danjuanfunds.com/djapi/index_eva/dj"

# 东方财富API
EASTMONEY_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"

# ========== ETF配置（与auto_update_data.py保持一致）==========

ETF_CONFIGS = [
    {"id": "dividend-low-vol", "file": "dividend-low-vol.json", "type": "a_value", "danjuanCode": "CSIH30269", "secid": "1.512890", "useBondSpread": True, "bondType": "cn"},
    {"id": "history", "file": "history.json", "type": "a_value", "danjuanCode": "CSIH30269", "secid": "1.512890", "useBondSpread": True, "bondType": "cn"},
    {"id": "free-cashflow", "file": "free-cashflow.json", "type": "a_value", "danjuanCode": None, "secid": "0.159201", "useBondSpread": True, "bondType": "cn"},
    {"id": "csi300", "file": "csi300.json", "type": "a_broad", "danjuanCode": "SH000300", "secid": "1.510300", "useBondSpread": True, "bondType": "cn"},
    {"id": "sse50", "file": "sse50.json", "type": "a_broad", "danjuanCode": "SH000016", "secid": "1.510050", "useBondSpread": True, "bondType": "cn"},
    {"id": "sci-tech-50", "file": "sci-tech-50.json", "type": "a_growth", "danjuanCode": "SZ399006", "secid": "1.588300", "useBondSpread": False, "bondType": "cn"},
    {"id": "gem-50", "file": "gem-50.json", "type": "a_growth", "danjuanCode": "SZ399006", "secid": "0.159949", "useBondSpread": False, "bondType": "cn"},
    {"id": "pharma", "file": "pharma.json", "type": "a_pharma", "danjuanCode": "SH000978", "secid": "1.512010", "useBondSpread": False, "bondType": "cn"},
    {"id": "sci-semi", "file": "sci-semi.json", "type": "a_growth", "danjuanCode": None, "secid": "1.588170", "useBondSpread": False, "bondType": "cn"},
    {"id": "robot", "file": "robot.json", "type": "a_growth", "danjuanCode": None, "secid": "1.562500", "useBondSpread": False, "bondType": "cn"},
    {"id": "energy-storage", "file": "energy-storage.json", "type": "a_growth_new", "danjuanCode": None, "secid": "0.159566", "useBondSpread": False, "bondType": "cn"},
    {"id": "pcb", "file": "pcb.json", "type": "a_growth_new", "danjuanCode": None, "secid": "1.515260", "useBondSpread": False, "bondType": "cn"},
    {"id": "sp500-cn", "file": "sp500-cn.json", "type": "us_stock", "danjuanCode": "SP500", "secid": "1.513650", "useBondSpread": False, "bondType": "us"},
    {"id": "nasdaq100-cn", "file": "nasdaq100-cn.json", "type": "us_stock", "danjuanCode": "NDX", "secid": "1.513110", "useBondSpread": False, "bondType": "us"},
    {"id": "csi-dividend", "file": "csi-dividend.json", "type": "a_value", "danjuanCode": "SH000922", "secid": "1.515080", "useBondSpread": True, "bondType": "cn"},
    {"id": "hk-dividend", "file": "hk-dividend.json", "type": "hk_dividend", "danjuanCode": None, "secid": "1.513820", "useBondSpread": True, "bondType": "cn"},
    {"id": "hstech", "file": "hstech.json", "type": "hk_stock", "danjuanCode": "HKHSTECH", "secid": "1.513180", "useBondSpread": False, "bondType": "cn"},
    {"id": "hk-soe-dividend", "file": "hk-soe-dividend.json", "type": "hk_dividend", "danjuanCode": None, "secid": "1.513901", "useBondSpread": True, "bondType": "cn"},
    {"id": "nikkei225", "file": "nikkei225.json", "type": "jp_stock", "danjuanCode": None, "secid": "1.513520", "useBondSpread": False, "bondType": "jp"},
    {"id": "topix", "file": "topix.json", "type": "jp_stock", "danjuanCode": None, "secid": "1.513800", "useBondSpread": False, "bondType": "jp"},
    {"id": "gold", "file": "gold.json", "type": "commodity", "danjuanCode": None, "secid": "1.518850", "useBondSpread": False, "bondType": None},
    {"id": "soybean-meal", "file": "soybean-meal.json", "type": "commodity", "danjuanCode": None, "secid": "0.159985", "useBondSpread": False, "bondType": None},
    {"id": "bond-10y", "file": "bond-10y.json", "type": "bond", "danjuanCode": None, "secid": "1.511260", "useBondSpread": True, "bondType": "cn"},
]


# ========== API请求工具（与auto_update_data.py一致）==========

def _urlopen_with_ssl_fallback(req, timeout=API_TIMEOUT):
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=_DEFAULT_SSL_CTX)
    except (ssl.SSLError, urllib.error.URLError):
        return urllib.request.urlopen(req, timeout=timeout, context=_NOVERIFY_SSL_CTX)


def fetch_json(url, headers=None, timeout=API_TIMEOUT):
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


# ========== 数据获取 ==========

_danjuan_cache = None

def fetch_danjuan_all():
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
    if not danjuan_code:
        return None
    
    all_data = fetch_danjuan_all()
    item = all_data.get(danjuan_code)
    if not item:
        for code, v in all_data.items():
            if danjuan_code in code or code in danjuan_code:
                item = v
                break
    
    if not item:
        return None
    
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


_bond_yields = {}

def fetch_cn_bond_yield():
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
    
    print("  ❌ 中国10Y国债收益率获取失败")
    return None


def fetch_us_bond_yield():
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
    
    print("  ❌ 美国10Y国债收益率获取失败")
    return None


def fetch_jp_bond_yield():
    """获取日本10年期国债收益率"""
    if "jp" in _bond_yields:
        return _bond_yields["jp"]
    
    print("🏦 获取日本10年期国债收益率...")
    data = fetch_jsonp(EASTMONEY_QUOTE, {
        "secid": "171.ZCJP10Y",
        "fields": "f43,f57,f58,f60,f170",
        "invt": "2", "fltt": "2",
        "ut": "fa5fd1943c7b386f172d6893dbbd2"
    })
    
    if data and data.get("data"):
        yield_val = data["data"].get("f43")
        if yield_val and yield_val != "-":
            val = round(float(yield_val), 2)
            _bond_yields["jp"] = val
            print(f"  ✅ 日本10Y国债: {val}%")
            return val
    
    print("  ❌ 日本10Y国债收益率获取失败")
    return None


# ========== 数据写入 ==========

def has_date_data(history_array, date_str):
    """检查历史数组中是否已有指定日期的数据（支持YYYY-MM-DD和YYYY-MM）"""
    if not history_array:
        return False
    return any(entry.get("date") == date_str for entry in history_array)


def append_daily_point(history_array, date_str, value, extra_fields=None):
    """向历史数组追加一个日级别数据点
    
    Args:
        history_array: 要追加的历史数据数组
        date_str: 日期字符串 YYYY-MM-DD
        value: 值
        extra_fields: 额外字段（如percentile）
    
    Returns:
        bool: 是否成功追加
    """
    if value is None:
        return False
    
    if has_date_data(history_array, date_str):
        return False  # 已存在
    
    entry = {"date": date_str, "value": round(value, 2)}
    if extra_fields:
        entry.update(extra_fields)
    
    history_array.append(entry)
    return True


def update_etf_daily(data, config, api_data, bond_yields, target_date):
    """
    为一个ETF写入当天的日级别数据点
    
    Returns:
        bool: 是否有数据更新
    """
    updated = False
    etf_type = config["type"]
    
    # 商品类只有价格，没有PE估值，跳过日级别采样
    # （商品ETF不参与综合分位计算，日级别对它们无意义）
    if etf_type == "commodity":
        return False
    
    cn_bond = bond_yields.get("cn")
    us_bond = bond_yields.get("us")
    jp_bond = bond_yields.get("jp")
    
    # PE数据（蛋卷API有的才能采样）
    if "peHistory" in data and api_data and api_data.get("pe"):
        pe_val = api_data["pe"]
        pe_pct = api_data.get("pePercentile")
        extra = {"percentile": round(pe_pct, 1)} if pe_pct else {}
        if append_daily_point(data["peHistory"], target_date, pe_val, extra):
            updated = True
            print(f"    PE: {pe_val}" + (f" ({pe_pct}%tile)" if pe_pct else ""))
    
    # 股息率
    if "dividendYieldHistory" in data and api_data and api_data.get("dividendYield"):
        dy_val = api_data["dividendYield"]
        if append_daily_point(data["dividendYieldHistory"], target_date, dy_val):
            updated = True
            print(f"    股息率: {dy_val}%")
    
    # 股息（energy-storage/pcb等新型成长ETF用dividendHistory而非dividendYieldHistory）
    if "dividendHistory" in data and "dividendYieldHistory" not in data:
        # 这类ETF通常没有蛋卷数据，跳过日级别
        pass
    
    # 国债收益率
    if "bondYieldHistory" in data:
        bond_val = None
        if config["bondType"] == "cn":
            bond_val = cn_bond
        elif config["bondType"] == "us":
            bond_val = us_bond
        elif config["bondType"] == "jp":
            bond_val = jp_bond
        
        if bond_val is not None:
            if append_daily_point(data["bondYieldHistory"], target_date, bond_val):
                updated = True
                print(f"    国债收益率: {bond_val}%")
    
    # 利差 = 股息率 - 国债收益率
    if "spreadHistory" in data:
        dy = None
        bond = None
        
        if api_data and api_data.get("dividendYield"):
            dy = api_data["dividendYield"]
        
        if config["bondType"] == "cn":
            bond = cn_bond
        elif config["bondType"] == "us":
            bond = us_bond
        
        if dy is not None and bond is not None:
            spread = round(dy - bond, 2)
            if append_daily_point(data["spreadHistory"], target_date, spread):
                updated = True
                print(f"    利差: {spread}%")
    
    return updated


# ========== 交易日判断 ==========

def is_weekday(date_str):
    """简易判断是否为工作日（不含法定假日，仅排除周末）"""
    d = datetime.strptime(date_str, "%Y-%m-%d")
    return d.weekday() < 5  # 0=Mon, 4=Fri


# ========== 主流程 ==========

def main():
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    
    # 支持指定日期
    target_date = NOW.strftime("%Y-%m-%d")
    for i, arg in enumerate(sys.argv):
        if arg == "--date" and i + 1 < len(sys.argv):
            target_date = sys.argv[i + 1]
            break
    
    print("=" * 60)
    print(f"🚀 ETF择时助手 - 每日数据采样")
    print(f"📅 采样日期: {target_date}")
    print(f"📁 数据目录: {DATA_DIR}")
    if dry_run:
        print("⚠️  试运行模式：不会写入文件")
    if force:
        print("⚠️  强制更新模式")
    print("=" * 60)
    
    # 检查是否为工作日（非强制模式下跳过周末）
    if not force and not is_weekday(target_date):
        print(f"⏭️  {target_date} 是周末，跳过采样（使用 --force 强制执行）")
        return
    
    # 1. 获取实时国债收益率
    cn_bond = fetch_cn_bond_yield()
    us_bond = fetch_us_bond_yield()
    jp_bond = fetch_jp_bond_yield()
    
    bond_yields = {"cn": cn_bond, "us": us_bond, "jp": jp_bond}
    
    # 2. 获取蛋卷基金全量数据
    fetch_danjuan_all()
    
    # 3. 逐个更新ETF数据文件
    updated_count = 0
    skipped_count = 0
    error_count = 0
    no_api_count = 0
    
    for config in ETF_CONFIGS:
        file_path = DATA_DIR / config["file"]
        etf_id = config["id"]
        
        if not file_path.exists():
            print(f"\n❌ 文件不存在: {config['file']}")
            error_count += 1
            continue
        
        # 商品类跳过
        if config["type"] == "commodity":
            continue
        
        print(f"\n📄 {config['file']} ({etf_id})")
        
        # 读取现有数据
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  ❌ 读取失败: {e}")
            error_count += 1
            continue
        
        # 检查是否已有今天的数据（避免重复）
        if not force:
            already_exists = False
            for key in ["peHistory", "bondYieldHistory", "dividendYieldHistory"]:
                if key in data and has_date_data(data[key], target_date):
                    already_exists = True
                    break
            if already_exists:
                print(f"  ⏭️  已有 {target_date} 数据")
                skipped_count += 1
                continue
        
        # 获取蛋卷估值
        api_data = None
        if config.get("danjuanCode"):
            api_data = get_danjuan_valuation(config["danjuanCode"])
            if api_data:
                print(f"  📊 PE={api_data.get('pe')}, 股息率={api_data.get('dividendYield')}%")
            else:
                print(f"  ⚠️  蛋卷数据获取失败")
        
        # 没有蛋卷数据 且 没有国债收益率 → 这个ETF今天无法采样
        bond_type = config.get("bondType")
        has_bond = (bond_type == "cn" and cn_bond) or (bond_type == "us" and us_bond) or (bond_type == "jp" and jp_bond)
        
        if not api_data and not has_bond:
            print(f"  ⏭️  无可用数据源，跳过")
            no_api_count += 1
            continue
        
        # 写入日级别数据
        try:
            updated = update_etf_daily(data, config, api_data, bond_yields, target_date)
        except Exception as e:
            print(f"  ❌ 更新出错: {e}")
            error_count += 1
            continue
        
        if updated:
            # 更新lastUpdate标记
            data["lastUpdate"] = target_date
            
            if not dry_run:
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"  ✅ 已保存")
            else:
                print(f"  ✅ 已计算（试运行，未保存）")
            
            updated_count += 1
        else:
            print(f"  ⏭️  无新数据")
            skipped_count += 1
        
        time.sleep(0.3)
    
    # 4. 汇总
    print("\n" + "=" * 60)
    print(f"📊 每日采样完成!")
    print(f"  ✅ 已更新: {updated_count} 个文件")
    print(f"  ⏭️  跳过:   {skipped_count} 个文件")
    print(f"  ⚠️  无数据源: {no_api_count} 个文件")
    print(f"  ❌ 错误:   {error_count} 个文件")
    print(f"  📅 采样日期: {target_date}")
    if cn_bond: print(f"  🏦 中国10Y国债: {cn_bond}%")
    if us_bond: print(f"  🏦 美国10Y国债: {us_bond}%")
    if jp_bond: print(f"  🏦 日本10Y国债: {jp_bond}%")
    print("=" * 60)
    
    if error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
