'use strict';
// 한국은행 ECOS Open API 공용 모듈 (api/rates.js 와 api/chat.js 의 AI 도구가 함께 사용).
// 파일 이름이 _ 로 시작하므로 Vercel 에서 별도 API 주소로 노출되지 않는다.
// 인증키는 호출하는 쪽이 서버 환경변수(ECOS_API_KEY)에서 읽어 넘긴다 (이 모듈은 키를 기록하거나 반환하지 않는다).

const BASE = process.env.ECOS_BASE_URL || 'https://ecos.bok.or.kr/api'; // ECOS_BASE_URL 은 시험용(모의 서버) 재정의
const TABLE = '731Y001'; // 3.1.1.1 주요국 통화의 대원화환율 (일별, 매매기준율)
const ITEMS = { usd: '0000001', jpy: '0000002' }; // 원/미국달러(매매기준율), 원/일본엔(100엔)
const SERIES_NAMES = { usd: '원/미국달러(매매기준율)', jpy: '원/일본엔(100엔)(매매기준율)' };
const MAX_DAYS = 366 * 6; // 한 번에 조회 가능한 최대 기간
const UPSTREAM_TIMEOUT_MS = 25000;

// 환율에 영향을 주는 것으로 알려진 지표 (통계 코드는 한국은행 ECOS 에서 직접 확인한 값)
const INDICATORS = {
  kospi:     { name: '코스피지수',        unit: '포인트', cycle: 'D', table: '802Y001', item: '0001000' },
  base_rate: { name: '한국은행 기준금리',  unit: '%',      cycle: 'D', table: '722Y001', item: '0101000' },
  kts3y:     { name: '국고채수익률(3년)', unit: '%',      cycle: 'D', table: '817Y002', item: '010200000' },
  us_policy: { name: '미국 정책금리',     unit: '%',      cycle: 'M', table: '902Y006', item: 'US' }, // 월별
  kr_policy: { name: '한국 정책금리',     unit: '%',      cycle: 'M', table: '902Y006', item: 'KR' }, // 월별
};

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
const compact = (s) => s.replace(/-/g, '');
const dashed = (t) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;

// ECOS 는 오류도 HTTP 200 + RESULT.CODE 로 알려준다 → 앱이 구분할 수 있는 HTTP 상태로 바꾼다
function mapEcosResult(result) {
  const code = String((result && result.CODE) || '');
  const msg = String((result && result.MESSAGE) || '');
  if (code === 'INFO-200') return null;                               // 해당 구간에 데이터 없음 (정상)
  if (code === 'INFO-100') throw new HttpError(401, 'invalid_key');   // 인증키 오류
  if (code === 'INFO-300') throw new HttpError(403, 'key_blocked');   // 인증키 사용 제한
  if (/호출|제한|초과/.test(msg) && /초과|제한/.test(msg) && code !== 'ERROR-301') throw new HttpError(429, 'rate_limited');
  console.error('[ecos] result code:', code); // 코드만 기록 (URL/키는 기록하지 않음)
  throw new HttpError(502, 'upstream_error');
}

// 임의의 통계표/항목/주기를 조회한다. 반환: Map(라벨 → 값). 일별은 'YYYY-MM-DD', 월별은 'YYYY-MM'.
// start/end 는 일별이면 'YYYY-MM-DD', 월별이면 'YYYY-MM' 형식.
async function fetchStat(key, table, cycle, item, start, end, maxRows) {
  const url = `${BASE}/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/${maxRows}/${table}/${cycle}/${compact(start)}/${compact(end)}/${item}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, { signal: ctl.signal });
  } catch (e) {
    throw new HttpError(e && e.name === 'AbortError' ? 504 : 502, 'upstream_unreachable'); // e.message 에 URL 이 있을 수 있어 사용하지 않음
  } finally { clearTimeout(timer); }
  if (r.status === 429) throw new HttpError(429, 'rate_limited');
  if (!r.ok) throw new HttpError(502, 'upstream_error');
  let j;
  try { j = await r.json(); } catch (_) { throw new HttpError(502, 'upstream_bad_json'); }

  const map = new Map();
  if (j && j.StatisticSearch && Array.isArray(j.StatisticSearch.row)) {
    const pattern = cycle === 'M' ? /^\d{6}$/ : /^\d{8}$/;
    for (const row of j.StatisticSearch.row) {
      const v = Number(row.DATA_VALUE);
      if (typeof row.TIME !== 'string' || !pattern.test(row.TIME) || !Number.isFinite(v)) continue;
      map.set(cycle === 'M' ? `${row.TIME.slice(0, 4)}-${row.TIME.slice(4, 6)}` : dashed(row.TIME), v);
    }
    return map;
  }
  if (j && j.RESULT) { mapEcosResult(j.RESULT); return map; } // 데이터 없음이면 빈 Map
  throw new HttpError(502, 'upstream_schema');
}

const rowLimit = (key) => (key === 'sample' ? 10 : 100000); // ECOS 의 sample 키는 최대 10건만 허용

// 환율 한 계열(일별 매매기준율). 값은 양수만 인정한다.
async function fetchSeries(key, item, start, end, maxRows) {
  const m = await fetchStat(key, TABLE, 'D', item, start, end, maxRows);
  for (const [k, v] of m) if (!(v > 0)) m.delete(k);
  return m;
}

// [start, end] 기간의 일별 환율. 두 통화 값이 모두 있는 날만, 날짜 오름차순으로 반환한다.
async function fetchRates(key, start, end) {
  const maxRows = rowLimit(key);
  const [usd, jpy] = await Promise.all([
    fetchSeries(key, ITEMS.usd, start, end, maxRows),
    fetchSeries(key, ITEMS.jpy, start, end, maxRows),
  ]);
  const rows = [];
  for (const [date, u] of usd) {
    const j = jpy.get(date);
    if (j !== undefined) rows.push({ date, usd_krw: u, jpy100_krw: j });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

// 지표 한 개를 조회한다 (월별 지표는 start/end 를 'YYYY-MM' 로 바꿔 요청).
async function fetchIndicator(key, id, start, end) {
  const d = INDICATORS[id];
  if (!d) throw new HttpError(400, 'unknown_indicator');
  const s = d.cycle === 'M' ? start.slice(0, 7) : start;
  const e = d.cycle === 'M' ? end.slice(0, 7) : end;
  return fetchStat(key, d.table, d.cycle, d.item, s, e, rowLimit(key));
}

// 추가로 보여 줄 수 있는 통화 (한국은행 731Y001 의 항목 코드, 모두 1단위당 원화로 제공됨을 실제 데이터로 확인)
const EXTRA_CURRENCIES = {
  EUR: { name: '유로', item: '0000003' },
  CNY: { name: '중국 위안', item: '0000053' },
  GBP: { name: '영국 파운드', item: '0000012' },
  AUD: { name: '호주 달러', item: '0000017' },
  CAD: { name: '캐나다 달러', item: '0000013' },
  CHF: { name: '스위스 프랑', item: '0000014' },
  HKD: { name: '홍콩 달러', item: '0000015' },
  SGD: { name: '싱가포르 달러', item: '0000024' },
  THB: { name: '태국 바트', item: '0000028' },
};

// 추가 통화들의 일별 값. 반환: { EUR: [[date, value], ...], ... } (날짜 오름차순)
async function fetchExtra(key, codes, start, end) {
  const maxRows = rowLimit(key);
  const list = codes.filter((c) => EXTRA_CURRENCIES[c]);
  const maps = await Promise.all(list.map((c) => fetchSeries(key, EXTRA_CURRENCIES[c].item, start, end, maxRows)));
  const out = {};
  list.forEach((c, i) => { out[c] = [...maps[i].entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); });
  return out;
}

module.exports = { HttpError, isDate, fetchRates, fetchExtra, fetchIndicator, EXTRA_CURRENCIES, INDICATORS, MAX_DAYS, TABLE, ITEMS, SERIES_NAMES };
