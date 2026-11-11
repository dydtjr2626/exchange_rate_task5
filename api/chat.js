'use strict';
// Vercel Serverless Function: AI 환율 해설 (Gemini 프록시, 스트리밍).
// GEMINI_API_KEY 는 서버 환경변수로만 읽는다 (브라우저 코드/응답/로그에 노출하지 않는다).
//
// 요청 POST /api/chat
//   { question, mode: 'chat'|'insight', history: [{role:'user'|'model', text}], context: { latest, range } }
// 응답 text/event-stream (SSE): 한 줄에 하나씩 `data: {json}`
//   {type:'status', text} 진행 안내 · {type:'delta', text} 답변 조각 · {type:'meta', ...} 참고 데이터 정보
//   {type:'done'} 끝 · {type:'error', code} 실패

const ecos = require('./_ecos.js');

// 모델은 앞에서부터 시도하고, 과부하/오류면 다음 모델로 넘어간다. 환경변수 GEMINI_MODELS(쉼표 구분)로 바꿀 수 있다.
const MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_Q = 200;
const MAX_HISTORY = 8;
const MAX_HIST_TEXT = 1200;
const FIRST_BYTE_MS = 15000;   // 모델이 이 시간 안에 첫 글자를 주지 않으면 다음 모델로
const TOTAL_MS = 45000;
const MAX_TOOL_ROUNDS = 3;
const MIN_DATE = '1977-04-01'; // 원/100엔 제공 시작일 (두 통화 값이 모두 있는 첫 날)

// ---------- 요청 횟수 제한 (남용 방지) ----------
// 서버리스는 인스턴스마다 메모리가 따로라서 완벽한 제한은 아니지만(최선의 방어), 한 사용자가 짧은 시간에 몰아서 쓰는 것을 막는다.
const RATE_MAX_PER_MIN = 20;
const RATE_MAX_PER_DAY = 300;
const hitLog = new Map(); // 주소 → 요청 시각 목록(최근 24시간)
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateLimited(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const list = (hitLog.get(ip) || []).filter((t) => now - t < 86400000);
  const inMinute = list.filter((t) => now - t < 60000).length;
  if (inMinute >= RATE_MAX_PER_MIN || list.length >= RATE_MAX_PER_DAY) { hitLog.set(ip, list); return true; }
  list.push(now);
  hitLog.set(ip, list);
  if (hitLog.size > 5000) { // 메모리 정리: 24시간 지난 기록만 남은 주소는 삭제
    for (const [k, v] of hitLog) if (!v.length || now - v[v.length - 1] > 86400000) hitLog.delete(k);
  }
  return false;
}

// ---------- 유틸 ----------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (n, d = 2) => Number(n).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 2) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n), d)}`;
const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
// 변화 크기 표현은 코드가 정한다(하루: 0.1/0.5/1%, 기간: 0.5/2/4%). AI 가 임의로 과장하지 않게 라벨을 함께 전달한다.
const sizeWord = (pct, daily) => { const a = Math.abs(pct); const [t1, t2, t3] = daily ? [0.1, 0.5, 1] : [0.5, 2, 4]; return a < t1 ? '거의 변동 없음' : a < t2 ? '소폭' : a < t3 ? '다소' : '큰 폭'; };
const dayPct = (last, change) => (last - change > 0 ? (change / (last - change)) * 100 : 0);
const positionWord = (p) => (p >= 80 ? '이 기간 중 매우 높은 편' : p >= 60 ? '이 기간 중 높은 편' : p >= 40 ? '이 기간 중 중간쯤' : p >= 20 ? '이 기간 중 낮은 편' : '이 기간 중 매우 낮은 편');
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- 클라이언트가 보낸 값 검증 (프롬프트에 들어가므로 형식과 길이를 엄격히 제한) ----------
function cleanStats(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of ['first', 'last', 'change', 'changePct', 'min', 'max', 'avg', 'percentile']) {
    const v = num(o[k]); if (v === null) return null; out[k] = v;
  }
  for (const k of ['minDate', 'maxDate']) { if (!ecos.isDate(o[k])) return null; out[k] = o[k]; }
  return out;
}
function cleanRange(r) {
  if (!r || typeof r !== 'object' || !ecos.isDate(r.start) || !ecos.isDate(r.end)) return null;
  const n = num(r.n);
  const usd = cleanStats(r.usd), jpy = cleanStats(r.jpy);
  if (!n || n < 2 || n > 20000 || !usd || !jpy) return null;
  const label = typeof r.label === 'string' ? r.label.replace(/[\r\n]+/g, ' ').slice(0, 40) : '';
  return { label, start: r.start, end: r.end, n, usd, jpy, focus: !!r.focus };
}
function cleanLatest(c) {
  const usd = num(c && c.usd_krw), jpy = num(c && c.jpy100_krw);
  if (usd === null || jpy === null || !ecos.isDate(c.kst_date)) return null;
  return {
    usd, jpy, date: c.kst_date,
    usdChange: num(c.usd_change), jpyChange: num(c.jpy_change),
    stale: c.status === 'stale', synthetic: !!c.synthetic,
  };
}
// 대화 기록: user/model 이 번갈아 나오도록 정리한다 (user 로 시작)
function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  const out = [];
  for (const m of h.slice(-MAX_HISTORY)) {
    if (!m || (m.role !== 'user' && m.role !== 'model') || typeof m.text !== 'string') continue;
    const text = m.text.trim().slice(0, MAX_HIST_TEXT);
    if (!text) continue;
    const last = out[out.length - 1];
    if (!out.length && m.role !== 'user') continue;
    if (last && last.role === m.role) { last.parts[0].text = text; continue; }
    out.push({ role: m.role, parts: [{ text }] });
  }
  if (out.length && out[out.length - 1].role === 'user') out.pop(); // 새 질문이 user 이므로 마지막이 user 면 제거
  return out;
}

// ---------- 시스템 프롬프트 (서버에서만 조립: 클라이언트가 지시문을 바꿀 수 없음) ----------
function statLine(name, s) {
  return `${name}: 시작 ${fmt(s.first)} → 현재 ${fmt(s.last)} (변화 ${signed(s.change)}, ${signed(s.changePct)}% → ${sizeWord(s.changePct, false)}), 최고 ${fmt(s.max)} (${s.maxDate}), 최저 ${fmt(s.min)} (${s.minDate}), 평균 ${fmt(s.avg)}, 현재 값의 위치: ${positionWord(s.percentile)}`;
}
function buildSystem(latest, range, mode) {
  const L = [];
  L.push('당신은 환율 대시보드의 AI 해설자입니다. 경제 초보자도 이해하는 쉬운 한국어로 답합니다.');
  L.push('');
  L.push('[데이터 출처] 한국은행 ECOS 매매기준율. 영업일 하루 한 번 산출되며 주말·공휴일 값은 없습니다. 단위: USD는 1달러당 원, JPY는 100엔당 원.');
  L.push('');
  L.push('[현재 환율]');
  L.push(`기준일(KST): ${latest.date}`);
  L.push(`USD/KRW: ${fmt(latest.usd)}원` + (latest.usdChange === null ? ' (전일 비교 없음)' : ` (전일 대비 ${signed(latest.usdChange)}원, ${signed(dayPct(latest.usd, latest.usdChange))}% → ${sizeWord(dayPct(latest.usd, latest.usdChange), true)})`));
  L.push(`100 JPY/KRW: ${fmt(latest.jpy)}원` + (latest.jpyChange === null ? ' (전일 비교 없음)' : ` (전일 대비 ${signed(latest.jpyChange)}원, ${signed(dayPct(latest.jpy, latest.jpyChange))}% → ${sizeWord(dayPct(latest.jpy, latest.jpyChange), true)})`));
  L.push(`상태: ${latest.stale ? 'stale (마지막 정상값이며 최신이 아닐 수 있음)' : 'fresh'}` + (latest.synthetic ? ' · 합성(시험) 값 기준' : ''));
  if (range) {
    L.push('');
    L.push(`[사용자가 보고 있는 구간 요약] ${range.label ? range.label + ' · ' : ''}${range.start} ~ ${range.end}, ${range.n}영업일${range.focus ? ' (사용자가 그래프에서 직접 선택한 구간)' : ''}`);
    L.push(statLine('USD/KRW', range.usd));
    L.push(statLine('100 JPY/KRW', range.jpy));
  }
  L.push('');
  L.push('[답변 규칙]');
  L.push('1. 위에 제공된 숫자와 get_exchange_rates 도구 결과에 있는 숫자만 인용하세요. 없는 수치는 지어내지 말고 "제공된 데이터에는 없습니다"라고 말하세요.');
  L.push('2. 위 구간 요약에 없는 특정 날짜나 다른 기간(예: 작년 3월, 10년 전, 최근 5년)을 묻는 질문은 get_exchange_rates 도구로 먼저 조회한 뒤 답하세요. 기간이 10년을 넘으면 나눠서 조회하세요.');
  L.push('3. 환율이 왜 움직였는지, 원인이나 배경을 묻는 질문에는 먼저 get_market_indicators 도구로 해당 기간(위 구간 요약의 기간 또는 질문 속 기간)의 지표를 조회하세요. 환율과 함께 움직인 지표(코스피 등락, 금리, 한·미 정책금리 차이)를 도구가 돌려준 숫자로 근거 삼아 "함께 움직였다", "영향을 줬을 수 있다"로만 설명하고 원인이라고 단정하지 마세요. 월별 지표는 가장 최근 발표 월을 밝히세요. 실시간 뉴스나 특정 사건은 알 수 없으므로 필요하면 "통계 기준 설명이며 구체적인 사건은 확인하지 못했습니다"라고 한 문장으로 밝히세요.');
  L.push('4. 마크다운 서식(**, #, 목록 기호) 없이 평문으로 쓰고, 어떤 기간을 기준으로 했는지 한 번 언급하세요(예: "최근 90일 기준"). "백분위" 같은 통계 용어는 쓰지 말고 "이 기간 중 높은 편/낮은 편/중간쯤"처럼 쉬운 말로 풀어 쓰세요. 변화의 크기는 괄호 안의 표현(거의 변동 없음/소폭/다소/큰 폭)을 넘어 과장하지 말고(\"급등\", \"급락\", \"크게\"는 \"큰 폭\"일 때만), 오늘(전일 대비) 변화와 선택 기간의 변화를 섞어 말하지 마세요.');
  L.push('5. 매수·매도 같은 투자 권유는 하지 않습니다. 환전·송금·여행 시점을 묻는 질문에는 지금 값이 이 기간 중 높은 편인지 낮은 편인지를 데이터로 설명하고, 미래 환율은 예측할 수 없다고 밝히세요. 나눠서 환전하기, 환전 수수료·우대율 확인 같은 일반적인 팁은 말해도 되지만 "지금 하세요/하지 마세요" 같은 결론은 내리지 마세요. 이런 질문에는 마지막에 "참고용 정보이며 투자 조언이 아닙니다. 실제 환전·송금 환율은 은행마다 다릅니다."를 한 문장으로 덧붙이세요.');
  L.push('6. 환율과 무관한 질문에는 환율 관련 질문만 답할 수 있다고 안내하세요.');
  L.push('7. 상태가 stale이면 값이 최신이 아닐 수 있음을 짧게 언급하세요.');
  if (mode === 'insight') L.push('8. 이번 요청은 "오늘의 한 줄 해설"입니다. 가장 중요한 변화 하나만 골라 한 문장(80자 안팎)으로만 답하세요. 도구는 사용하지 마세요.');
  else L.push('8. 기본은 2~4문장, 복잡한 질문은 최대 6문장으로 답하세요.');
  return L.join('\n');
}

// ---------- AI 도구: 한국은행 환율 조회 (서버가 직접 조회하므로 숫자를 신뢰할 수 있음) ----------
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_exchange_rates',
      description: '지정한 기간의 원/달러, 원/100엔 환율(한국은행 매매기준율)을 조회해 시작·끝 값, 변화, 최고·최저(날짜 포함), 평균, 대표 표본을 돌려준다. 최대 10년 단위. 1977-04-01 이후 데이터가 있다.',
      parameters: {
        type: 'OBJECT',
        properties: {
          start_date: { type: 'STRING', description: '시작일 YYYY-MM-DD' },
          end_date: { type: 'STRING', description: '종료일 YYYY-MM-DD' },
        },
        required: ['start_date', 'end_date'],
      },
    },
    {
      name: 'get_market_indicators',
      description: '환율이 왜 움직였는지 설명할 때 쓰는 도구. 지정한 기간의 코스피지수, 한국은행 기준금리, 국고채수익률(3년), 미국·한국 정책금리와 둘의 차이(월별), 그리고 같은 기간 원/달러·원/100엔 변화를 한국은행 통계에서 조회해 돌려준다. 최대 5년 단위. 지표가 환율과 함께 움직였는지 확인하는 용도이며 원인을 증명하지는 않는다.',
      parameters: {
        type: 'OBJECT',
        properties: {
          start_date: { type: 'STRING', description: '시작일 YYYY-MM-DD' },
          end_date: { type: 'STRING', description: '종료일 YYYY-MM-DD' },
        },
        required: ['start_date', 'end_date'],
      },
    },
  ],
}];

function summarizeSeries(values, dates) {
  const n = values.length;
  let min = Infinity, max = -Infinity, minI = 0, maxI = 0, sum = 0, below = 0, equal = 0;
  values.forEach((v, i) => { sum += v; if (v < min) { min = v; minI = i; } if (v > max) { max = v; maxI = i; } });
  const last = values[n - 1];
  values.forEach((v) => { if (v < last) below++; else if (v === last) equal++; });
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    first: r2(values[0]), last: r2(last), change: r2(last - values[0]), change_pct: r2(((last - values[0]) / values[0]) * 100),
    min: r2(min), min_date: dates[minI], max: r2(max), max_date: dates[maxI], avg: r2(sum / n),
    position: positionWord(Math.round(((below + 0.5 * equal) / n) * 100)),
  };
}
function splitYears(start, end, years) {
  const out = []; let s = start;
  while (s <= end) {
    const dt = new Date(s + 'T00:00:00Z'); dt.setUTCFullYear(dt.getUTCFullYear() + years); dt.setUTCDate(dt.getUTCDate() - 1);
    let e = dt.toISOString().slice(0, 10); if (e > end) e = end;
    out.push([s, e]); s = addDays(e, 1);
  }
  return out;
}
async function toolGetRates(args, toolsUsed) {
  const key = process.env.ECOS_API_KEY;
  if (!key) return { error: 'data_unavailable', hint: '서버에 한국은행 인증키가 설정되지 않았습니다.' };
  let s = args && args.start_date, e = args && args.end_date;
  if (!ecos.isDate(s) || !ecos.isDate(e)) return { error: 'invalid_dates', hint: 'start_date, end_date 를 YYYY-MM-DD 형식으로 지정하세요.' };
  const today = kstToday();
  if (e > today) e = today;
  if (s < MIN_DATE) s = MIN_DATE;
  if (s > e) return { error: 'invalid_range', hint: '시작일이 종료일보다 늦거나 데이터 제공 기간 밖입니다.' };
  if ((Date.parse(e) - Date.parse(s)) / 86400000 > 3660) return { error: 'range_too_large', hint: '한 번에 10년 이내로 나눠서 호출하세요.' };
  try {
    const parts = await Promise.all(splitYears(s, e, 5).map(([a, b]) => ecos.fetchRates(key, a, b)));
    const rows = parts.flat().sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    if (!rows.length) return { error: 'no_data', period: { start: s, end: e }, hint: '주말·공휴일이거나 아직 산출되지 않은 기간입니다.' };
    const dates = rows.map((r) => r.date);
    // 표본: 최대 20개를 고르게 뽑는다 (토큰 절약)
    const step = Math.max(1, Math.ceil(rows.length / 20));
    const samples = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ date: r.date, usd_krw: r.usd_krw, jpy100_krw: r.jpy100_krw }));
    toolsUsed.push({ kind: 'rates', start: dates[0], end: dates[dates.length - 1] });
    return {
      source: '한국은행 ECOS 매매기준율',
      period: { start: dates[0], end: dates[dates.length - 1] }, business_days: rows.length,
      usd_krw: summarizeSeries(rows.map((r) => r.usd_krw), dates),
      jpy100_krw: summarizeSeries(rows.map((r) => r.jpy100_krw), dates),
      samples,
    };
  } catch (err) {
    console.error('[chat] tool failed:', err && err.code ? err.code : 'unknown'); // 키/URL 은 기록하지 않음
    return { error: 'data_unavailable', hint: '한국은행 데이터를 지금 불러올 수 없습니다.' };
  }
}

// ---------- AI 도구: 환율에 영향을 주는 지표 조회 (한국은행 통계) ----------
const r2 = (v) => Math.round(v * 100) / 100;
// 일별 지표(코스피, 기준금리, 국고채): 기간의 처음·끝·최고·최저와 변화
function summarizeIndicator(map, def) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return null;
  const vals = keys.map((k) => map.get(k));
  const last = vals.length - 1;
  let minI = 0, maxI = 0;
  vals.forEach((v, i) => { if (v < vals[minI]) minI = i; if (v > vals[maxI]) maxI = i; });
  const out = {
    name: def.name, unit: def.unit, cycle: '일별', observations: keys.length,
    first: { date: keys[0], value: r2(vals[0]) }, last: { date: keys[last], value: r2(vals[last]) },
    change: r2(vals[last] - vals[0]), change_unit: def.unit === '%' ? '%p(퍼센트포인트)' : def.unit,
    min: { date: keys[minI], value: r2(vals[minI]) }, max: { date: keys[maxI], value: r2(vals[maxI]) },
  };
  if (def.unit !== '%' && vals[0] > 0) out.change_pct = r2(((vals[last] - vals[0]) / vals[0]) * 100);
  return out;
}
// 월별 지표(정책금리): 기간 시작 무렵의 값과 가장 최근에 발표된 값. 최근 월은 발표 전일 수 있다.
function monthlyPoint(map, def, startMonth, endMonth) {
  const keys = [...map.keys()].sort().filter((k) => k <= endMonth);
  if (!keys.length) return null;
  const latest = keys[keys.length - 1];
  const atStart = keys.filter((k) => k <= startMonth).pop() || keys[0];
  return {
    name: def.name, unit: def.unit, cycle: '월별',
    at_start: { month: atStart, value: r2(map.get(atStart)) }, latest: { month: latest, value: r2(map.get(latest)) },
    change: r2(map.get(latest) - map.get(atStart)), change_unit: '%p(퍼센트포인트)',
    ...(latest < endMonth ? { latest_month_note: `${endMonth}까지의 값은 아직 발표 전이라 ${latest} 값이 가장 최근입니다.` } : {}),
  };
}
async function toolGetIndicators(args, toolsUsed) {
  const key = process.env.ECOS_API_KEY;
  if (!key) return { error: 'data_unavailable', hint: '서버에 한국은행 인증키가 설정되지 않았습니다.' };
  let s = args && args.start_date, e = args && args.end_date;
  if (!ecos.isDate(s) || !ecos.isDate(e)) return { error: 'invalid_dates', hint: 'start_date, end_date 를 YYYY-MM-DD 형식으로 지정하세요.' };
  const today = kstToday();
  if (e > today) e = today;
  if (s < '1990-01-01') s = '1990-01-01';
  if (s > e) return { error: 'invalid_range', hint: '시작일이 종료일보다 늦거나 데이터 제공 기간 밖입니다.' };
  if ((Date.parse(e) - Date.parse(s)) / 86400000 > 1830) return { error: 'range_too_large', hint: '한 번에 5년 이내로 나눠서 호출하세요.' };

  const ID = ecos.INDICATORS;
  const lookback = addDays(s, -400); // 월별 지표는 발표가 늦어서 시작 이전 값까지 넉넉히 가져온다
  const jobs = [
    ['kospi', ecos.fetchIndicator(key, 'kospi', s, e)],
    ['base_rate', ecos.fetchIndicator(key, 'base_rate', s, e)],
    ['kts3y', ecos.fetchIndicator(key, 'kts3y', s, e)],
    ['us_policy', ecos.fetchIndicator(key, 'us_policy', lookback, e)],
    ['kr_policy', ecos.fetchIndicator(key, 'kr_policy', lookback, e)],
    ['fx', ecos.fetchRates(key, s, e)],
  ];
  const settled = await Promise.allSettled(jobs.map((j) => j[1]));
  const got = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') got[jobs[i][0]] = r.value;
    else console.error('[chat] indicator failed:', jobs[i][0], r.reason && r.reason.code ? r.reason.code : 'unknown'); // 키/URL 은 기록하지 않음
  });

  const names = [];
  const daily = {};
  for (const id of ['kospi', 'base_rate', 'kts3y']) {
    const sm = got[id] && summarizeIndicator(got[id], ID[id]);
    daily[id] = sm || { name: ID[id].name, error: '해당 기간의 데이터를 가져오지 못했거나 없습니다.' };
    if (sm) names.push(ID[id].name);
  }
  const monthly = {};
  const sMonth = s.slice(0, 7), eMonth = e.slice(0, 7);
  const us = got.us_policy && monthlyPoint(got.us_policy, ID.us_policy, sMonth, eMonth);
  const kr = got.kr_policy && monthlyPoint(got.kr_policy, ID.kr_policy, sMonth, eMonth);
  monthly.us_policy = us || { name: ID.us_policy.name, error: '데이터를 가져오지 못했거나 없습니다.' };
  monthly.kr_policy = kr || { name: ID.kr_policy.name, error: '데이터를 가져오지 못했거나 없습니다.' };
  if (us && kr) {
    // 금리차(미국 − 한국): 두 나라 값이 모두 있는 월 기준
    const common = [...got.us_policy.keys()].filter((k) => got.kr_policy.has(k) && k <= eMonth).sort();
    if (common.length) {
      const latest = common[common.length - 1];
      const atStart = common.filter((k) => k <= sMonth).pop() || common[0];
      const gap = (k) => r2(got.us_policy.get(k) - got.kr_policy.get(k));
      monthly.policy_rate_gap = {
        definition: '미국 정책금리 − 한국 정책금리 (%p). 양수면 미국 금리가 더 높아 원화에 불리한 환경으로 여겨진다.',
        at_start: { month: atStart, value: gap(atStart) }, latest: { month: latest, value: gap(latest) },
        change: r2(gap(latest) - gap(atStart)), change_unit: '%p(퍼센트포인트)',
      };
      names.push('한·미 정책금리(월별)');
    }
  }
  let fx = null;
  if (got.fx && got.fx.length) {
    const dates = got.fx.map((r) => r.date);
    fx = { usd_krw: summarizeSeries(got.fx.map((r) => r.usd_krw), dates), jpy100_krw: summarizeSeries(got.fx.map((r) => r.jpy100_krw), dates) };
  }
  if (!names.length) return { error: 'data_unavailable', hint: '한국은행 지표를 지금 불러올 수 없습니다.' };
  toolsUsed.push({ kind: 'indicators', start: s, end: e, names });
  return {
    source: '한국은행 ECOS', period: { start: s, end: e },
    daily_indicators: daily, monthly_indicators: monthly, exchange_rate_same_period: fx,
    notes: [
      '지표가 환율과 같은 방향으로 움직였더라도 그것이 환율 변동의 원인이라는 뜻은 아닙니다. "함께 움직였다"로만 설명하세요.',
      '월별 지표(정책금리)는 최근 월이 아직 발표되지 않았을 수 있습니다. 기준 월을 함께 밝히세요.',
      '뉴스나 특정 사건은 이 데이터에 포함되어 있지 않습니다.',
    ],
  };
}
async function runTool(call, toolsUsed) {
  if (call.name === 'get_exchange_rates') return toolGetRates(call.args, toolsUsed);
  if (call.name === 'get_market_indicators') return toolGetIndicators(call.args, toolsUsed);
  return { error: 'unknown_tool' };
}
const statusFor = (name) => (name === 'get_market_indicators' ? '코스피·금리 지표를 조회하는 중...' : '한국은행 환율 데이터를 조회하는 중...');

// ---------- Gemini 스트리밍 호출 ----------
class GeminiError extends Error {
  constructor(status, reason) { super(reason || String(status)); this.status = status; this.reason = reason; this.emitted = false; }
}

async function streamOnce(key, model, payload, send) {
  const ctl = new AbortController();
  let abortReason = null;
  const abort = (why) => { abortReason = why; ctl.abort(); };
  const firstTimer = setTimeout(() => abort('first_byte'), FIRST_BYTE_MS);
  const totalTimer = setTimeout(() => abort('total'), TOTAL_MS);
  let emitted = false;
  try {
    const r = await fetch(`${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload), signal: ctl.signal,
    });
    if (!r.ok) {
      // Gemini 는 잘못된 인증키도 400 으로 알려준다 → 본문의 이유 코드만 확인한다 (본문은 기록/전달하지 않음)
      let status = r.status;
      try {
        const t = (await r.text()).slice(0, 4000);
        if (/API_KEY_INVALID|API key not valid/i.test(t)) status = 401;
      } catch (_) { /* 무시 */ }
      throw new GeminiError(status, 'http');
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', finish = null;
    const parts = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(firstTimer);
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, ''); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let j; try { j = JSON.parse(data); } catch (_) { continue; }
        const c = j.candidates && j.candidates[0];
        if (c && c.content && Array.isArray(c.content.parts)) {
          for (const p of c.content.parts) {
            parts.push(p);
            if (typeof p.text === 'string' && p.text && !p.thought) { emitted = true; send({ type: 'delta', text: p.text }); }
          }
        }
        if (c && c.finishReason) finish = c.finishReason;
        if (j.promptFeedback && j.promptFeedback.blockReason) finish = 'BLOCKED';
      }
    }
    return { parts, finish, emitted };
  } catch (e) {
    const g = e instanceof GeminiError ? e : new GeminiError(abortReason ? 504 : 0, abortReason || 'network'); // e.message 에 URL 이 있을 수 있어 사용하지 않음
    g.emitted = emitted;
    throw g;
  } finally { clearTimeout(firstTimer); clearTimeout(totalTimer); }
}

// 모델을 차례로 시도한다. 이미 글자를 내보낸 뒤 실패하면(중복 방지) 다음 모델로 넘기지 않는다.
async function streamWithFallback(key, payload, send) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const out = await streamOnce(key, model, payload, send);
      out.model = model;
      return out;
    } catch (e) {
      lastErr = e;
      console.error('[chat] model failed:', model, e.status, e.reason || '');
      if (e.emitted) throw e;
      if (e.status === 401 || e.status === 403) throw e; // 키 문제는 다른 모델도 같다
    }
  }
  throw lastErr || new GeminiError(0, 'no_model');
}

function errorCode(e) {
  if (!(e instanceof GeminiError)) return 'internal';
  if (e.status === 401 || e.status === 403) return 'auth';
  if (e.status === 429) return 'quota';
  if (e.status === 504 || e.reason === 'first_byte' || e.reason === 'total') return 'timeout';
  return 'upstream';
}

// ---------- 핸들러 ----------
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  if (rateLimited(req)) return res.status(429).json({ error: 'rate_limited' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const mode = body.mode === 'insight' ? 'insight' : 'chat';
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const latest = cleanLatest(ctx.latest);
  if (!question || question.length > MAX_Q || !latest) return res.status(400).json({ error: 'bad_request' });
  const range = cleanRange(ctx.range);
  const history = mode === 'chat' ? cleanHistory(body.history) : [];

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch (_) { /* 연결이 끊김 */ } };

  const toolsUsed = [];
  let produced = '';
  const sendTracked = (o) => { if (o.type === 'delta') produced += o.text; send(o); };
  try {
    const contents = [...history, { role: 'user', parts: [{ text: question }] }];
    const system = buildSystem(latest, range, mode);
    const useTools = mode === 'chat';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const payload = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: mode === 'insight' ? 300 : 1500, temperature: 0.4 },
      };
      if (useTools && round < MAX_TOOL_ROUNDS) payload.tools = TOOLS; // 마지막 회차는 도구 없이 답을 마무리하게 한다
      const out = await streamWithFallback(key, payload, sendTracked);
      const calls = out.parts.filter((p) => p.functionCall);
      if (!calls.length) break;
      send({ type: 'status', text: [...new Set(calls.map((p) => statusFor(p.functionCall.name)))].join(' ') });
      contents.push({ role: 'model', parts: out.parts }); // thoughtSignature 를 포함해 그대로 돌려줘야 한다
      const results = await Promise.all(calls.map((p) => runTool(p.functionCall, toolsUsed)));
      contents.push({ role: 'user', parts: calls.map((p, i) => ({ functionResponse: { name: p.functionCall.name, response: results[i] } })) });
    }
    if (!produced.trim()) { send({ type: 'error', code: 'empty' }); return; }
    send({ type: 'meta', range: range ? { label: range.label, start: range.start, end: range.end, n: range.n, focus: range.focus } : null, tools: toolsUsed, source: '한국은행 ECOS 매매기준율' });
    send({ type: 'done' });
  } catch (e) {
    send({ type: 'error', code: errorCode(e) });
  } finally {
    res.end();
  }
};
