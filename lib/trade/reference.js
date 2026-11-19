'use strict';
// Reference data: the list of countries and currencies (names, ISO codes, dialling codes) and the extra staff roles for the Global Trade module.
// This is only a directory. Nothing here switches a country on, and there are NO duty rates or carrier prices: those are entered or fetched later.
const { run, now } = require('../db');

// code, name, symbol, decimals
const CURRENCIES = [
  ['NGN', 'Nigerian Naira', '₦', 2], ['USD', 'US Dollar', '$', 2], ['GBP', 'British Pound', '£', 2], ['EUR', 'Euro', '€', 2], ['CAD', 'Canadian Dollar', 'CA$', 2], ['AUD', 'Australian Dollar', 'A$', 2],
  ['GHS', 'Ghanaian Cedi', 'GH₵', 2], ['ZAR', 'South African Rand', 'R', 2], ['KES', 'Kenyan Shilling', 'KSh', 2], ['TZS', 'Tanzanian Shilling', 'TSh', 2], ['UGX', 'Ugandan Shilling', 'USh', 0], ['RWF', 'Rwandan Franc', 'RF', 0],
  ['EGP', 'Egyptian Pound', 'E£', 2], ['MAD', 'Moroccan Dirham', 'MAD', 2], ['XOF', 'West African CFA Franc', 'CFA', 0], ['XAF', 'Central African CFA Franc', 'FCFA', 0], ['ETB', 'Ethiopian Birr', 'Br', 2],
  ['MXN', 'Mexican Peso', 'MX$', 2], ['BRL', 'Brazilian Real', 'R$', 2], ['CHF', 'Swiss Franc', 'CHF', 2], ['SEK', 'Swedish Krona', 'kr', 2], ['NOK', 'Norwegian Krone', 'kr', 2], ['DKK', 'Danish Krone', 'kr', 2],
  ['PLN', 'Polish Złoty', 'zł', 2], ['TRY', 'Turkish Lira', '₺', 2], ['AED', 'UAE Dirham', 'AED', 2], ['SAR', 'Saudi Riyal', 'SAR', 2], ['QAR', 'Qatari Riyal', 'QAR', 2], ['INR', 'Indian Rupee', '₹', 2],
  ['PKR', 'Pakistani Rupee', 'Rs', 2], ['BDT', 'Bangladeshi Taka', '৳', 2], ['CNY', 'Chinese Yuan', 'CN¥', 2], ['HKD', 'Hong Kong Dollar', 'HK$', 2], ['JPY', 'Japanese Yen', '¥', 0], ['KRW', 'South Korean Won', '₩', 0],
  ['SGD', 'Singapore Dollar', 'S$', 2], ['MYR', 'Malaysian Ringgit', 'RM', 2], ['THB', 'Thai Baht', '฿', 2], ['IDR', 'Indonesian Rupiah', 'Rp', 2], ['VND', 'Vietnamese Dong', '₫', 0], ['PHP', 'Philippine Peso', '₱', 2], ['NZD', 'New Zealand Dollar', 'NZ$', 2],
];
const ACTIVE_CURRENCIES = new Set(['NGN', 'USD', 'GBP', 'EUR', 'CAD', 'AUD']);

// code, name, iso3, dial code, currency, region
const COUNTRIES = [
  ['NG', 'Nigeria', 'NGA', '234', 'NGN', 'Africa'], ['GH', 'Ghana', 'GHA', '233', 'GHS', 'Africa'], ['ZA', 'South Africa', 'ZAF', '27', 'ZAR', 'Africa'], ['KE', 'Kenya', 'KEN', '254', 'KES', 'Africa'],
  ['TZ', 'Tanzania', 'TZA', '255', 'TZS', 'Africa'], ['UG', 'Uganda', 'UGA', '256', 'UGX', 'Africa'], ['RW', 'Rwanda', 'RWA', '250', 'RWF', 'Africa'], ['EG', 'Egypt', 'EGY', '20', 'EGP', 'Africa'],
  ['MA', 'Morocco', 'MAR', '212', 'MAD', 'Africa'], ['SN', 'Senegal', 'SEN', '221', 'XOF', 'Africa'], ['CI', "Côte d'Ivoire", 'CIV', '225', 'XOF', 'Africa'], ['CM', 'Cameroon', 'CMR', '237', 'XAF', 'Africa'],
  ['BJ', 'Benin', 'BEN', '229', 'XOF', 'Africa'], ['TG', 'Togo', 'TGO', '228', 'XOF', 'Africa'], ['ET', 'Ethiopia', 'ETH', '251', 'ETB', 'Africa'],
  ['US', 'United States', 'USA', '1', 'USD', 'North America'], ['CA', 'Canada', 'CAN', '1', 'CAD', 'North America'], ['MX', 'Mexico', 'MEX', '52', 'MXN', 'North America'], ['BR', 'Brazil', 'BRA', '55', 'BRL', 'South America'],
  ['GB', 'United Kingdom', 'GBR', '44', 'GBP', 'Europe'], ['IE', 'Ireland', 'IRL', '353', 'EUR', 'Europe'], ['DE', 'Germany', 'DEU', '49', 'EUR', 'Europe'], ['FR', 'France', 'FRA', '33', 'EUR', 'Europe'],
  ['IT', 'Italy', 'ITA', '39', 'EUR', 'Europe'], ['ES', 'Spain', 'ESP', '34', 'EUR', 'Europe'], ['NL', 'Netherlands', 'NLD', '31', 'EUR', 'Europe'], ['BE', 'Belgium', 'BEL', '32', 'EUR', 'Europe'],
  ['PT', 'Portugal', 'PRT', '351', 'EUR', 'Europe'], ['AT', 'Austria', 'AUT', '43', 'EUR', 'Europe'], ['CH', 'Switzerland', 'CHE', '41', 'CHF', 'Europe'], ['SE', 'Sweden', 'SWE', '46', 'SEK', 'Europe'],
  ['NO', 'Norway', 'NOR', '47', 'NOK', 'Europe'], ['DK', 'Denmark', 'DNK', '45', 'DKK', 'Europe'], ['PL', 'Poland', 'POL', '48', 'PLN', 'Europe'], ['TR', 'Türkiye', 'TUR', '90', 'TRY', 'Europe'],
  ['AE', 'United Arab Emirates', 'ARE', '971', 'AED', 'Middle East'], ['SA', 'Saudi Arabia', 'SAU', '966', 'SAR', 'Middle East'], ['QA', 'Qatar', 'QAT', '974', 'QAR', 'Middle East'],
  ['IN', 'India', 'IND', '91', 'INR', 'Asia'], ['PK', 'Pakistan', 'PAK', '92', 'PKR', 'Asia'], ['BD', 'Bangladesh', 'BGD', '880', 'BDT', 'Asia'], ['CN', 'China', 'CHN', '86', 'CNY', 'Asia'],
  ['HK', 'Hong Kong', 'HKG', '852', 'HKD', 'Asia'], ['JP', 'Japan', 'JPN', '81', 'JPY', 'Asia'], ['KR', 'South Korea', 'KOR', '82', 'KRW', 'Asia'], ['SG', 'Singapore', 'SGP', '65', 'SGD', 'Asia'],
  ['MY', 'Malaysia', 'MYS', '60', 'MYR', 'Asia'], ['TH', 'Thailand', 'THA', '66', 'THB', 'Asia'], ['ID', 'Indonesia', 'IDN', '62', 'IDR', 'Asia'], ['VN', 'Vietnam', 'VNM', '84', 'VND', 'Asia'],
  ['PH', 'Philippines', 'PHL', '63', 'PHP', 'Asia'], ['AU', 'Australia', 'AUS', '61', 'AUD', 'Oceania'], ['NZ', 'New Zealand', 'NZL', '64', 'NZD', 'Oceania'],
];

async function seedReference() {
  {
    let i = 0;
    for (const [code, name, symbol, decimals] of CURRENCIES) {
      await run('INSERT INTO trade_currencies (code,name,symbol,decimals,is_base,active,sort) VALUES (?,?,?,?,?,?,?) ON CONFLICT (code) DO NOTHING', code, name, symbol, decimals, code === 'NGN' ? 1 : 0, ACTIVE_CURRENCIES.has(code) ? 1 : 0, code === 'NGN' ? 0 : 10 + i++);
    }
    let s = 0;
    for (const [code, name, iso3, dial, cur, region] of COUNTRIES) {
      // Nigeria is the home country: we ship from it and import into it. Every other country starts switched OFF; the owner enables the ones to trade with.
      const home = code === 'NG' ? 1 : 0;
      await run('INSERT INTO trade_countries (code,name,iso3,dial_code,currency_code,region,export_from,import_to,sort) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (code) DO NOTHING', code, name, iso3, dial, cur, region, home, home, code === 'NG' ? 0 : 10 + s++);
    }
  }
}

// Roles for the "trade" permission module. Added without touching roles the owner already edited (ON CONFLICT DO NOTHING).
async function ensureTradeRoles() {
  const V = (...m) => m.map((x) => x + ':view'), E = (...m) => m.flatMap((x) => [x + ':view', x + ':edit']);
  const roles = [
    ['Trade & Logistics Manager', 'Runs imports, exports, shipments, customs and international suppliers.', [...E('trade'), ...V('orders', 'catalog', 'warehouse', 'finance', 'reports')]],
    ['Trade Analyst', 'Reads Global Trade dashboards and reports; cannot change anything.', [...V('trade', 'reports', 'orders')]],
  ];
  for (const [name, description, perms] of roles) await run('INSERT INTO staff_roles (name,description,perms,builtin,created) VALUES (?,?,?,1,?) ON CONFLICT (name) DO NOTHING', name, description, JSON.stringify(perms), now());
}

module.exports = { seedReference, ensureTradeRoles, CURRENCIES, COUNTRIES };
