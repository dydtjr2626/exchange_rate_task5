// Vercel Serverless Function: 한국은행 ECOS Open API 프록시.
// 인증키는 서버 환경변수 ECOS_API_KEY 로만 읽는다 (브라우저 코드/응답/로그에 절대 노출하지 않는다).
//
// 사용: GET /api/rates?start=YYYY-MM-DD&end=YYYY-MM-DD[&extra=EUR,CNY][&only_extra=1]
// 응답: { source, table, series, rows: [{ date, usd_krw, jpy100_krw }], extra?: { EUR: [[date, value], ...] } }
//   rows 는 날짜 오름차순이며 두 통화 값이 모두 있는 날만 포함한다. extra 는 요청한 추가 통화의 일별 값이다.
//   only_extra=1 이면 USD/JPY 는 조회하지 않고 rows 를 비워서 돌려준다.

const ecos = require('./_ecos.js');
const MAX_EXTRA = 6;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const key = process.env.ECOS_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' }); // 서버에 인증키가 설정되지 않음

  const { start, end } = req.query || {};
  if (!ecos.isDate(start) || !ecos.isDate(end) || start > end) return res.status(400).json({ error: 'bad_request' });
  if ((Date.parse(end) - Date.parse(start)) / 86400000 > ecos.MAX_DAYS) return res.status(400).json({ error: 'range_too_large' });

  // 추가 통화: 허용 목록에 있는 코드만, 중복 제거 후 최대 MAX_EXTRA 개
  const extraCodes = typeof (req.query || {}).extra === 'string'
    ? [...new Set(req.query.extra.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))]
    : [];
  if (extraCodes.length > MAX_EXTRA || extraCodes.some((c) => !ecos.EXTRA_CURRENCIES[c])) return res.status(400).json({ error: 'bad_currency' });
  const onlyExtra = (req.query || {}).only_extra === '1';

  try {
    const [rows, extra] = await Promise.all([
      onlyExtra ? Promise.resolve([]) : ecos.fetchRates(key, start, end),
      extraCodes.length ? ecos.fetchExtra(key, extraCodes, start, end) : Promise.resolve(null),
    ]);
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({
      source: '한국은행 ECOS', table: ecos.TABLE,
      limited: key === 'sample', // 시험용 sample 키는 요청당 10건만 오므로 '일부 데이터'임을 알린다
      series: { usd: `${ecos.ITEMS.usd} ${ecos.SERIES_NAMES.usd}`, jpy: `${ecos.ITEMS.jpy} ${ecos.SERIES_NAMES.jpy}` },
      rows,
      ...(extra ? { extra } : {}),
    });
  } catch (e) {
    const status = e instanceof ecos.HttpError ? e.status : 502;
    return res.status(status).json({ error: e instanceof ecos.HttpError ? e.code : 'upstream_error' });
  }
};
