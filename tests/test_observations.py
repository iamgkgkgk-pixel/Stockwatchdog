import copy
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import observations as obs
import daily_update_data as daily
import auto_update_data as monthly


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.clock = patch.object(obs, 'today', return_value='2026-09-14')
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.config = {'id': 'pharma', 'type': 'a_pharma', 'danjuanCode': 'SH000978', 'bondType': 'cn'}
        self.data = {'peHistory': [], 'dividendYieldHistory': [], 'bondYieldHistory': [], 'spreadHistory': [],
                     'currentData': {'pe': 40, 'updateTime': '2026-06-01'}, 'note': 'keep'}
        self.valuation = {'pe': 20, 'pb': 2, 'roe': 15, 'pePercentile': 0, 'dividendYield': 0,
                          'asOf': '2026-09-14', 'instrumentId': '000978', 'source': 'fixture', 'quality': 'observed'}
        self.bond = {'value': 1.71, 'market': 'cn', 'asOf': '2026-09-14', 'source': 'fixture', 'quality': 'observed'}

    def test_no_source_means_no_change(self):
        before = copy.deepcopy(self.data)
        self.assertFalse(obs.update_equity(self.data, self.config, None, {}))
        self.assertEqual(self.data, before)

    def test_daily_snapshot_and_zero_values(self):
        self.assertTrue(obs.update_equity(self.data, self.config, self.valuation, {'cn': self.bond}))
        self.assertEqual(self.data['currentData']['pe'], 20)
        self.assertEqual(self.data['currentData']['roe'], 15)
        self.assertEqual(self.data['currentData']['pePercentile'], 0)
        self.assertEqual(self.data['currentData']['dividendYield'], 0)
        self.assertEqual(self.data['currentData']['fieldMeta']['pe']['asOf'], '2026-09-14')
        self.assertEqual(self.data['peHistory'][0]['percentile'], 0)
        before = copy.deepcopy(self.data)
        self.assertFalse(obs.update_equity(self.data, self.config, self.valuation, {'cn': self.bond}))
        self.assertEqual(self.data, before)

    def test_partial_bond_update_does_not_refresh_old_pe(self):
        obs.update_equity(self.data, self.config, None, {'cn': self.bond})
        self.assertEqual(self.data['currentData']['pe'], 40)
        self.assertEqual(self.data['currentData']['updateTime'], '2026-06-01')
        self.assertEqual(self.data['currentData']['fieldMeta']['pe']['quality'], 'legacy')

    def test_force_replaces_one_date_and_preserves_revision(self):
        obs.update_equity(self.data, self.config, self.valuation, {})
        revised = {**self.valuation, 'pe': 21}
        obs.update_equity(self.data, self.config, revised, {}, force=True)
        self.assertEqual(len(self.data['peHistory']), 1)
        self.assertEqual(self.data['peHistory'][0]['value'], 21)
        self.assertEqual(self.data['peHistory'][0]['revisions'][0]['value'], 20)
        self.assertEqual(self.data['currentData']['pe'], 21)

    def test_partial_day_can_be_completed(self):
        obs.update_equity(self.data, self.config, None, {'cn': self.bond})
        self.assertTrue(obs.update_equity(self.data, self.config, self.valuation, {'cn': self.bond}))
        self.assertEqual(len(self.data['peHistory']), 1)
        self.assertEqual(len(self.data['bondYieldHistory']), 1)

    def test_source_date_is_not_collection_date(self):
        old = {**self.valuation, 'asOf': '2026-09-11'}
        obs.update_equity(self.data, self.config, old, {'cn': self.bond})
        self.assertEqual(self.data['peHistory'][0]['date'], '2026-09-11')
        self.assertEqual(self.data['spreadHistory'], [])

    def test_proxy_does_not_pollute_target_series(self):
        config = {**self.config, 'isProxy': True, 'danjuanCode': 'SZ399006'}
        value = {**self.valuation, 'instrumentId': '399006'}
        obs.update_equity(self.data, config, value, {})
        self.assertEqual(self.data['peHistory'], [])
        self.assertEqual(self.data['currentData']['pe'], 40)
        self.assertEqual(self.data['proxyValuation']['quality'], 'proxy')

    def test_japan_cannot_borrow_us_bond(self):
        config = {**self.config, 'bondType': 'jp', 'danjuanCode': None}
        before = copy.deepcopy(self.data)
        us = {**self.bond, 'market': 'us', 'value': 4.31}
        self.assertFalse(monthly.update_standard_equity(self.data, config, None, None, us))
        self.assertEqual(self.data, before)

    def test_unknown_or_wrong_identity_is_rejected(self):
        for fields in [{'asOf': None}, {'asOf': '2026-09-15'}, {'quality': 'estimated'}]:
            data = copy.deepcopy(self.data)
            self.assertFalse(obs.update_equity(data, self.config, {**self.valuation, **fields}, {}))
            self.assertEqual(data, self.data)
        with self.assertRaises(ValueError):
            obs.update_equity(self.data, self.config, {**self.valuation, 'instrumentId': '399006'}, {})

    def test_parser_preserves_zero_and_matches_normalized_code_only(self):
        item = {'index_code': '000978', 'name': 'fixture', 'pe': '20', 'pb': None, 'pe_percentile': 0,
                'roe': .15, 'yeild': 0, 'date': '20260914'}
        result = obs.parse_valuation([item], 'SH000978')
        self.assertEqual(result['pePercentile'], 0)
        self.assertEqual(result['dividendYield'], 0)
        self.assertEqual(result['roe'], 15)
        self.assertIsNone(result['pb'])
        self.assertIsNone(obs.parse_valuation([item], '00097'))
        self.assertIsNone(obs.parse_valuation([{**item, 'date': None}], 'SH000978'))

    def test_new_growth_does_not_extrapolate_old_schema(self):
        old = {'peHistory': [{'date': '2026-04', 'value': 30}, {'date': '2026-05', 'value': 35}], 'dividendHistory': []}
        before = copy.deepcopy(old)
        self.assertFalse(monthly.update_new_growth(old, self.config, None, None))
        self.assertEqual(old, before)

    def test_etf_price_not_appended_to_legacy_spot_series(self):
        data = {'priceHistory': [{'date': '2026-01', 'value': 365}], 'currentData': {}}
        quote = {'value': 9.43, 'priceChange': None, 'asOf': '2026-09-14', 'source': 'fixture',
                 'quality': 'observed', 'instrumentId': '1.518850'}
        obs.update_price(data, {'secid': '1.518850'}, quote)
        self.assertEqual(data['priceHistory'], [{'date': '2026-01', 'value': 365}])
        self.assertEqual(data['etfPriceHistory'][0]['value'], 9.43)
        self.assertNotIn('priceChange', data['currentData'])

    def test_machine_and_electronic_collectors_keep_unique_instrument_ids(self):
        for etf_id, secid in [('machine-tool', '0.159663'), ('pcb', '1.515260')]:
            configs = []
            for module in [daily, monthly]:
                matches = [item for item in module.ETF_CONFIGS if item['id'] == etf_id]
                self.assertEqual(len(matches), 1)
                config = matches[0]
                self.assertEqual(config['secid'], secid)
                self.assertEqual(config['file'], etf_id + '.json')
                self.assertIsNone(config['danjuanCode'])
                self.assertEqual(sum(item['secid'] == secid for item in module.ETF_CONFIGS), 1)
                configs.append(config)
            self.assertEqual(configs[0], configs[1])

    def test_machine_bond_refresh_never_creates_pe_history_or_observation_date(self):
        config = next(item for item in daily.ETF_CONFIGS if item['id'] == 'machine-tool')
        data = json.loads((Path(__file__).resolve().parents[1] / 'data/machine-tool.json').read_text())
        original_quote = copy.deepcopy(data['currentData']['fieldMeta']['price'])
        obs.update_equity(data, config, None, {'cn': self.bond})
        self.assertEqual(data['peHistory'], [])
        self.assertIsNone(data['currentData']['pe'])
        self.assertIsNone(data['currentData']['updateTime'])
        self.assertNotIn('pe', data['currentData']['fieldMeta'])
        self.assertEqual(data['currentData']['fieldMeta']['price'], original_quote)

    def test_non_today_argument_rejected_before_network_even_with_force(self):
        with patch.object(daily, 'today', return_value='2026-09-14'), patch.object(daily, 'fetch_cn_bond_yield') as fetch:
            for date in ['2026-09-11', '2026-09-15', 'bad-date', '2026-02-30']:
                with patch.object(sys, 'argv', ['daily', '--date', date, '--force', '--dry-run']), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as exc:
                        daily.main()
                    self.assertNotEqual(exc.exception.code, 0)
            fetch.assert_not_called()

    def test_all_sources_failed_is_not_success(self):
        for module in [daily, monthly]:
            with self.subTest(module=module.__name__), patch.object(sys, 'argv', ['collector', '--dry-run', '--force']), \
                 patch.object(module, 'ETF_CONFIGS', []), patch.object(module, 'fetch_cn_bond_yield', return_value=None), \
                 patch.object(module, 'fetch_us_bond_yield', return_value=None), patch.object(module, 'fetch_jp_bond_yield', return_value=None), \
                 patch.object(module, 'fetch_danjuan_all', return_value={}), patch.object(module, 'today', return_value='2026-09-14'), \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as exc:
                    module.main()
                self.assertNotEqual(exc.exception.code, 0)


if __name__ == '__main__':
    unittest.main()
