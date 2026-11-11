'use strict';

const SOURCE_NAME = '한국은행 ECOS (매매기준율)';
const STORAGE_KEY = 't04_state_v1';
const TIMEOUT_MS = 10000;      // 실제 조회 제한 시간 (느린 네트워크 고려)
const SYNTH_TIMEOUT_MS = 3000; // 합성 타임아웃 재생용
const AUTO_MS = 30 * 60 * 1000; // 자동 갱신 간격 (매매기준율은 영업일 하루 1회 산출이라 길게)
let busy = false;
const TZ = 'Asia/Seoul';

const $ = (id) => document.getElementById(id);
// 개발자 전용 화면 요소는 ?dev=1 일 때만 보인다 (CSS의 .dev-only 와 연동)
const DEV = new URLSearchParams(location.search).has('dev');
document.body.classList.toggle('dev', DEV);

// ---------- 시간 유틸 (KST) ----------
function kstDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// 짧은 표기: 2026-11-04 15:10 KST
function kstStamp(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} KST`;
}
function kstDateTime(iso) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(iso)) + ' KST';
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- 저장소 ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.history)) return s;
  } catch (_) { /* ignore */ }
  return { last_valid: null, history: [], status: 'fresh', error_code: 'none', error_msg: '', error_guide: '' };
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('저장 실패(브라우저 저장 용량 초과 가능):', e && e.name); }
}
let state = load();
const DATA_SOURCE = 'ECOS';
(function migrateSource() {
  if (state.data_source === DATA_SOURCE) return;
  state.history = state.history.filter((h) => h.synthetic || h.manual); // 이전 원천(ECB)에서 온 실제/소급 기록 제거
  if (state.last_valid && !state.last_valid.synthetic && !state.last_valid.manual) state.last_valid = null;
  delete state.backfill_at;
  delete state.backfill_v;
  state.data_source = DATA_SOURCE;
  save();
})();

// 같은 KST 날짜는 1건만 유지 (덮어쓰기)
function upsertDaily(rec) {
  const i = state.history.findIndex((h) => h.kst_date === rec.kst_date);
  if (i >= 0) state.history[i] = rec; else state.history.push(rec);
  state.history.sort((a, b) => a.kst_date.localeCompare(b.kst_date));
}

// ---------- 오류 정의 ----------
const ERRORS = {
  timeout: { code: 'TIMEOUT', msg: '외부 서버 응답이 너무 느려 시간 초과되었습니다.', guide: '잠시 후 다시 시도하세요. 계속되면 네트워크 상태를 확인하세요.' },
  auth: { code: 'HTTP_401_403', msg: '외부 원천이 요청을 거절했습니다 (401/403).', guide: '접근 권한(인증키) 문제입니다. 서비스 관리자에게 문의하세요.' },
  config: { code: 'NOT_CONFIGURED', msg: '서버에 한국은행 인증키가 설정되지 않았습니다.', guide: '서비스 관리자에게 ECOS 인증키 설정을 요청하세요.' },
  rate: { code: 'HTTP_429', msg: '호출 제한을 초과했습니다 (429).', guide: '잠시 기다린 뒤 다시 시도하세요.' },
  offline: { code: 'OFFLINE', msg: '네트워크에 연결되어 있지 않습니다.', guide: '인터넷 연결을 확인한 뒤 다시 시도하세요.' },
  schema: { code: 'SCHEMA_MISMATCH', msg: '응답 형식이 예상과 달라 값을 사용할 수 없습니다.', guide: '원천 API 형식이 바뀌었을 수 있습니다. 관리자에게 알려주세요.' },
};
class FetchError extends Error { constructor(kind) { super(kind); this.kind = kind; } }

// ---------- 조회 (서버 프록시 /api/rates → 한국은행 ECOS) ----------
// 응답 형식: { rows: [{ date, usd_krw, jpy100_krw }, ...] } (날짜 오름차순)
function validate(json) {
  const rows = json && json.rows;
  if (!Array.isArray(rows) || !rows.length) throw new FetchError('schema');
  const last = rows[rows.length - 1];
  if (!last || typeof last.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(last.date)) throw new FetchError('schema');
  if (![last.usd_krw, last.jpy100_krw].every((v) => typeof v === 'number' && isFinite(v) && v > 0)) throw new FetchError('schema');
  return {
    usd_krw: last.usd_krw,
    jpy100_krw: last.jpy100_krw,
    source_date: last.date,
    raw: { source: json.source, table: json.table, series: json.series, latest: last, window_rows: rows.length },
  };
}

// 서버 프록시에서 [start, end] 기간의 일별 환율을 받는다. HTTP 상태를 앱의 실패 유형으로 변환한다.
async function fetchRates(start, end, timeoutMs) {
  if (!navigator.onLine) throw new FetchError('offline');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`/api/rates?start=${start}&end=${end}`, { signal: ctl.signal, cache: 'no-store' });
  } catch (e) {
    throw new FetchError(e.name === 'AbortError' ? 'timeout' : 'offline');
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw new FetchError('auth');
  if (res.status === 429) throw new FetchError('rate');
  if (res.status === 503) throw new FetchError('config'); // 서버에 인증키가 설정되지 않음
  if (res.status === 504) throw new FetchError('timeout');
  if (!res.ok) throw new FetchError('schema');
  let json;
  try { json = await res.json(); } catch (_) { throw new FetchError('schema'); }
  if (!json || !Array.isArray(json.rows)) throw new FetchError('schema');
  return json;
}

// 최신 값: 최근 14일 중 가장 마지막 영업일 값을 사용한다
async function realFetch() {
  const end = kstDate(), start = addDays(end, -14);
  const json = await fetchRates(start, end, TIMEOUT_MS);
  return { json, parsed: validate(json) };
}

// 합성 실패: 외부 호출 없이 시험값으로만 재생
async function syntheticFailure(kind) {
  switch (kind) {
    case 'timeout': { // 합성 지연(10초) vs 실제 타임아웃 제한
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), SYNTH_TIMEOUT_MS);
      try {
        await new Promise((resolve, reject) => {
          const slow = setTimeout(resolve, SYNTH_TIMEOUT_MS * 4);
          ctl.signal.addEventListener('abort', () => { clearTimeout(slow); reject(new FetchError('timeout')); });
        });
      } finally { clearTimeout(t); }
      return;
    }
    case 'auth': throw new FetchError('auth');
    case 'rate': throw new FetchError('rate');
    case 'offline': throw new FetchError('offline');
    case 'schema': validate({ data: 'SYNTHETIC', rates: 'changed' }); return;
  }
}

// synthetic: 합성 재생으로 만든 실패인가(true) / 실제 조회 실패인가(false)
function setFailure(kind, synthetic) {
  const e = ERRORS[kind] || ERRORS.schema;
  // 마지막 정상값(last_valid, history)은 건드리지 않는다
  state.failure_synthetic = synthetic;
  state.status = 'stale';
  state.error_code = e.code;
  state.error_msg = e.msg;
  state.error_guide = e.guide;
  state.last_failure_at = new Date().toISOString();
  state.recovery_note = '';
  save(); render();
}

// 합성 실패로 stale인 동안은 자동 갱신을 멈춘다(복구 asset 재생으로만 풀림).
// 실제 조회 실패로 stale이면 자동으로 재시도한다.
const pausedBySynthetic = () => state.status === 'stale' && state.failure_synthetic !== false;
async function autoFetch() {
  if (busy || document.hidden || pausedBySynthetic()) return;
  await onRealFetch();
}
// "다시 시도": 합성 실패 → 복구 asset 재생(T04-RECOVER-D2), 실제 실패 → 실제 재조회
function onRetry() {
  return state.failure_synthetic === false ? onRealFetch() : onRecover();
}

async function onRealFetch() {
  if (busy) return;
  setBusy(true);
  try {
    const { json, parsed } = await realFetch();
    const now = new Date();
    const date = kstDate(now);
    state.last_valid = {
      usd_krw: parsed.usd_krw, jpy100_krw: parsed.jpy100_krw,
      source: SOURCE_NAME, source_date: parsed.source_date,
      fetched_at: now.toISOString(), kst_date: date, synthetic: false, raw: parsed.raw,
    };
    upsertDaily({
      kst_date: date, usd_krw: parsed.usd_krw, jpy100_krw: parsed.jpy100_krw, synthetic: false,
      source_date: parsed.source_date, fetched_at: now.toISOString(), raw: parsed.raw,
    });
    Object.assign(state, { status: 'fresh', error_code: 'none', error_msg: '', error_guide: '', failure_synthetic: null, last_success_at: now.toISOString(), recovery_note: '' });
    save(); render();
  } catch (e) {
    setFailure(e instanceof FetchError ? e.kind : 'offline', false);
  } finally { setBusy(false); }
}

async function onSyntheticFailure() {
  if (busy) return;
  setBusy(true);
  try { await syntheticFailure($('fail-select').value); }
  catch (e) { setFailure(e instanceof FetchError ? e.kind : 'schema', true); }
  finally { setBusy(false); }
}

// ---------- 복구 asset ----------
async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 게시된 기준 해시(T04-RECOVER-D2.sha256)와 실제로 받은 asset의 해시를 비교한다
let expectedHash;
async function loadExpectedHash() {
  try {
    const r = await fetch('T04-RECOVER-D2.sha256', { cache: 'no-store' });
    if (!r.ok) return null;
    const h = (await r.text()).trim().split(/\s+/)[0].toLowerCase();
    return /^[0-9a-f]{64}$/.test(h) ? h : null;
  } catch (_) { return null; }
}
function showVerify(hash, match, note = '') {
  $('asset-hash').textContent = hash;
  const v = $('asset-verify');
  v.className = 'verify ' + (match === true ? 'ok' : match === false ? 'bad' : 'na');
  v.textContent = match === true ? `✔ 게시된 해시와 일치${note}`
    : match === false ? `✖ 게시된 해시와 불일치${note}` : '게시된 기준 해시 없음';
}
async function fetchAsset() {
  const res = await fetch('T04-RECOVER-D2.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('asset');
  const buf = await res.arrayBuffer();
  const hash = await sha256Hex(buf); // 매번 다시 계산
  if (expectedHash === undefined) expectedHash = await loadExpectedHash();
  const match = expectedHash ? hash === expectedHash : null;
  showVerify(hash, match);
  return { asset: JSON.parse(new TextDecoder().decode(buf)), hash, match };
}
async function onRecover() {
  if (busy) return;
  setBusy(true);
  try {
    const { asset: a, hash, match } = await fetchAsset();
    if (a.asset_id !== 'T04-RECOVER-D2' || !a.rates) throw new Error('asset');
    // 기록이 없어도 "다음 날짜"가 되도록 항상 기준일에 offset을 더한다
    const latest = state.history.length ? state.history[state.history.length - 1].kst_date : kstDate();
    const next = addDays(latest, a.day_offset || 1);
    const rec = { kst_date: next, usd_krw: a.rates.usd_krw, jpy100_krw: a.rates.jpy100_krw, synthetic: true };
    upsertDaily(rec);
    state.last_valid = {
      ...rec, source: a.source, source_date: next,
      fetched_at: new Date().toISOString(), raw: a,
    };
    Object.assign(state, { status: 'fresh', error_code: 'none', error_msg: '', error_guide: '', failure_synthetic: null, last_success_at: new Date().toISOString() });
    // 복구 직후 결과 한 줄 요약 (해시는 이번 재생에서 다시 계산한 값)
    const hashTxt = match === true ? 'SHA-256 재계산 일치 ✔' : match === false ? 'SHA-256 불일치 ✖ (asset 변조 가능성)' : 'SHA-256 기준값 없음';
    state.recovery_note = `복구 완료 · ${next.slice(5)} 기록 1건 추가됨 · ${hashTxt} · fresh / error_code none`;
    state.recovery_warn = match === false;
    state.recovery_short = `복구 완료 · ${next.slice(5)} 기록 1건 추가됨`; // 일반 화면용 (해시 정보 제외)
    showVerify(hash, match, ' (복구 시 재계산)');
    save(); render();
  } catch (_) {
    setFailure('schema', true);
  } finally { setBusy(false); }
}

// ---------- 렌더링 ----------
const fmt = (n, d = 2) => n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });

function yesterdayOf(rec) {
  const prev = state.history.filter((h) => h.kst_date < rec.kst_date);
  return prev.length ? prev[prev.length - 1] : null;
}
function diffInfo(key) {
  const lv = state.last_valid;
  if (!lv) return null;
  const y = yesterdayOf({ kst_date: lv.kst_date });
  if (!y) return null;
  return { delta: lv[key] - y[key], pct: ((lv[key] - y[key]) / y[key]) * 100, from: y.kst_date, manual: !!y.manual, backfilled: !!y.backfilled };
}
// 카드 하단: 전일 대비 변화 칩(오르면 빨강 ▲, 내리면 파랑 ▼) + 비교 기준 날짜
function renderDiff(el, key) {
  const d = diffInfo(key);
  el.className = 'diff';
  el.replaceChildren(changeChip(d ? '전일 대비' : '', d));
  const hint = document.createElement('div');
  hint.className = 'small';
  hint.textContent = d ? `비교 기준: ${d.from}${d.manual ? ' (수동 입력값)' : d.backfilled ? ' (소급 조회값)' : ''}` : '다른 KST 날짜 기록이 쌓이면 표시됩니다.';
  el.appendChild(hint);
}

// ---------- 표시 기간 (차트 · 표 · 내려받기에 공통 적용) ----------
const RANGE_LABELS = { 1: '1d', 7: '7d', 30: '30d', 90: '90d', 180: '180d', 365: '365d', 3650: '10y', 0: 'all' };
const rangeDays = () => (state.range_days === undefined ? 30 : state.range_days); // 0 = 전체
const rangeLabel = () => RANGE_LABELS[rangeDays()] || String(rangeDays()) + 'd';
const exportTag = () => `${kstDate()}_${tableScope() === 'all' ? 'all' : rangeLabel()}`;
let tablePage = 1;
let tableHighlight = null; // 날짜로 이동했을 때 잠깐 강조할 날짜
const TABLE_SIZES = [25, 50, 100, 200];
const tableScope = () => (state.table_scope === 'all' ? 'all' : 'range'); // 표 범위: 표시 기간 / 전체 기록
const tableSize = () => (TABLE_SIZES.includes(state.table_size) ? state.table_size : 50);
const tableRecords = () => (tableScope() === 'all' ? state.history : windowRecords());
// 가장 최근 기록 날짜를 기준으로 선택한 기간 안의 기록만 반환 (state.history는 날짜 오름차순)
function windowRecords() {
  const n = state.history.length;
  if (!n || rangeDays() === 0) return state.history;
  const latest = state.history[n - 1].kst_date;
  let start;
  if (rangeDays() === 3650) { // 10년은 달력 기준 10년 전 같은 날짜
    const dt = new Date(latest + 'T00:00:00Z');
    dt.setUTCFullYear(dt.getUTCFullYear() - 10);
    start = dt.toISOString().slice(0, 10);
  } else start = addDays(latest, -rangeDays());
  let i = n;
  while (i > 0 && state.history[i - 1].kst_date >= start) i--;
  return state.history.slice(i);
}

// 경과 시간 표기: "방금", "5분 전", "3시간 12분 전", "2일 4시간 전"
function ago(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return '방금';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분 전`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간 전`;
}
const lastGoodAt = () => (state.last_valid && state.last_valid.fetched_at) || state.last_success_at || null;
function renderAge() {
  const ref = lastGoodAt();
  const el = $('status-age');
  if (state.status === 'stale' && ref) el.textContent = `마지막 정상값 ${ago(ref)}`;
  else if (ref) el.textContent = `마지막 갱신 ${ago(ref)}`;
  else el.textContent = '';
}

function render() {
  const stale = state.status === 'stale';
  const lv = state.last_valid;
  renderAge();
  const rr = $('recover-result');
  rr.textContent = !stale && state.recovery_note ? (DEV ? state.recovery_note : state.recovery_short) : '';
  rr.classList.toggle('warn', DEV && !!state.recovery_warn);
  $('export-json').disabled = $('export-csv').disabled = state.history.length === 0;

  $('status-bar').className = 'status ' + (stale ? 'stale' : 'fresh');
  $('status-badge').textContent = state.status;
  $('status-code').textContent = 'error_code: ' + state.error_code;
  $('status-msg').textContent = stale ? state.error_msg : '';
  // 정상일 때는 큰 배너 대신 작은 한 줄로 기준 시각만 보여 준다
  const sl = $('status-line');
  if (stale) { sl.textContent = ''; sl.removeAttribute('title'); }
  else if (lv) {
    const ref = lv.fetched_at || state.last_success_at;
    sl.textContent = `최신값 (기준: ${ref ? kstStamp(ref) : '시각 정보 없음'})`;
    sl.title = `출처 기준일 ${lv.source_date || '-'} · 자동 갱신: 열 때와 30분마다 조회`;
  } else { sl.textContent = '아직 조회한 값이 없습니다. "실제 환율 조회"를 눌러주세요.'; sl.removeAttribute('title'); }
  $('status-guide').textContent = stale ? '안내: ' + state.error_guide : '';
  $('retry-btn').hidden = !stale;
  const times = [];
  if (state.last_success_at) times.push('마지막 성공: ' + kstDateTime(state.last_success_at));
  if (state.last_failure_at) times.push('마지막 실패: ' + kstDateTime(state.last_failure_at));
  $('status-times').textContent = times.join(' · ');
  $('auto-note').textContent = !stale
    ? '자동 갱신: 열 때와 30분마다 조회합니다.'
    : pausedBySynthetic()
      ? (DEV ? '자동 갱신 일시중지: "다시 시도"(T04-RECOVER-D2 재생)로 복구하면 다시 시작됩니다.' : '자동 갱신 일시중지: "다시 시도"로 복구하면 다시 시작됩니다.')
      : '실제 조회 실패: 30분마다 자동 재시도하며, "다시 시도"는 지금 바로 재조회합니다.';

  for (const [p, key] of [['usd', 'usd_krw'], ['jpy', 'jpy100_krw']]) {
    const v = $(p + '-value');
    v.replaceChildren(lv ? fmt(lv[key]) : '-');
    if (lv) { const w = document.createElement('span'); w.className = 'won'; w.textContent = ' 원'; v.appendChild(w); }
    $(p + '-stale').hidden = !stale || !lv;
    $('card-' + p).classList.toggle('stale', stale && !!lv);
    renderDiff($(p + '-diff'), key);
  }

  $('m-source').textContent = lv ? lv.source + (lv.synthetic ? ' [합성 시험값]' : '') + (lv.manual ? ' [수동 입력]' : '') : '-';
  $('m-source-time').textContent = lv ? `${lv.source_date} (원천 제공 일자, 시각 정보 없음)` : '-';
  $('m-fetched').textContent = lv && lv.fetched_at ? kstDateTime(lv.fetched_at) : '-';
  $('raw').textContent = lv && lv.raw ? JSON.stringify(lv.raw, null, 2) : '-';

  const real = state.history.filter((h) => !h.synthetic && !h.manual && !h.backfilled);
  const backfillN = state.history.filter((h) => h.backfilled).length;
  const manualN = state.history.filter((h) => h.manual).length;
  const synth = state.history.filter((h) => h.synthetic).length;
  const notes = [`실제 조회 기록 ${real.length}건 (목표: 서로 다른 KST 날짜 2건)` + (manualN ? ` · 수동 입력 ${manualN}건(실제 조회 건수에 포함 안 됨)` : '') + (backfillN ? ` · 소급 조회 ${backfillN}건` : '')];
  if (!real.some((h) => h.kst_date === kstDate())) notes.push('오늘(KST) 실제 기록이 아직 없습니다. 조회하면 오늘 기록이 생깁니다.');
  if (synth || (lv && lv.synthetic)) notes.push(`합성 기록 ${synth}건 포함: 제출 전 "합성 기록 제거"를 누르세요(실제 기록은 유지).`);
  $('record-note').textContent = notes.join(' · ');

  // 표: 최신순으로 페이지 단위로 나눠 그린다 (전체 기록 1.3만 건도 가볍게). 범위는 '표시 기간' 또는 '전체 기록'.
  const win = tableRecords(); // state.history 의 뒷부분(또는 전체)이므로 아래의 전체 기록 인덱스 계산이 성립한다
  const n = win.length, size = tableSize();
  const pages = Math.max(1, Math.ceil(n / size));
  if (tablePage > pages) tablePage = pages;
  if (tablePage < 1) tablePage = 1;
  const offset = (tablePage - 1) * size;
  const count = Math.max(0, Math.min(size, n - offset));
  $('range-select').value = String(rangeDays());
  $('table-scope').value = tableScope();
  $('table-size').value = String(size);
  $('table-note').textContent = n
    ? `${n.toLocaleString()}건 중 ${(offset + 1).toLocaleString()}–${(offset + count).toLocaleString()}번째 (최신순)`
      + (tableScope() === 'range' ? ` · 저장된 전체 ${state.history.length.toLocaleString()}건은 '전체 기록'으로 바꾸면 볼 수 있습니다` : ' · 전체 기록')
    : '표시할 기록이 없습니다.';
  $('table-pager').hidden = pages <= 1;
  $('pg-input').value = String(tablePage);
  $('pg-input').max = String(pages);
  $('pg-total').textContent = pages.toLocaleString();
  $('pg-first').disabled = $('pg-prev').disabled = tablePage <= 1;
  $('pg-next').disabled = $('pg-last').disabled = tablePage >= pages;
  if (n) { $('table-jump').min = win[0].kst_date; $('table-jump').max = win[n - 1].kst_date; }
  const body = $('history-body');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const k = n - 1 - (offset + i); // 최신 기록이 먼저 나오도록 뒤에서부터
    const h = win[k];
    const tr = document.createElement('tr');
    if (tableHighlight && h.kst_date === tableHighlight) tr.className = 'row-hl';
    [h.kst_date, fmt(h.usd_krw), fmt(h.jpy100_krw), h.synthetic ? '합성(복구 asset)' : h.manual ? '수동 입력' : h.backfilled ? '소급 조회' : '실제'].forEach((t, ci) => {
      const td = document.createElement('td');
      if (ci === 3) { // 구분 열: 라벨 모양으로 표시
        const s = document.createElement('span');
        s.className = 'pill' + (h.synthetic ? ' synth' : h.manual ? ' manual' : h.backfilled ? ' backfill' : '');
        s.textContent = t;
        td.appendChild(s);
        if (h.manual) { // 출처를 함께 표시 (직접 입력한 값임을 숨기지 않음)
          s.title = h.source + (h.note ? ' · ' + h.note : '');
          const src = document.createElement('div');
          src.className = 'small';
          src.textContent = h.source;
          td.appendChild(src);
        }
      } else td.textContent = t;
      tr.appendChild(td);
    });
    // ✨ 버튼: 이 날의 변화를 직전 기록과 비교해 AI에게 설명해 달라고 요청
    const aiTd = document.createElement('td');
    aiTd.className = 'ai-col';
    const gi = state.history.length - win.length + k; // 전체 기록에서의 위치
    const prevRec = gi > 0 ? state.history[gi - 1] : null;
    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'link-btn ai-row';
    aiBtn.textContent = '✨';
    aiBtn.title = '이 날의 변화를 AI에게 물어보기';
    aiBtn.setAttribute('aria-label', `${h.kst_date} 환율 변화 AI 설명`);
    const off = !prevRec || h.synthetic || prevRec.synthetic;
    if (off) aiBtn.dataset.off = '1';
    aiBtn.disabled = off || chatBusy;
    if (!off) aiBtn.addEventListener('click', () => askAboutRange({ start: prevRec.kst_date, end: h.kst_date }, `${h.kst_date}에 환율이 직전 기록일(${prevRec.kst_date}) 대비 어떻게 변했는지 설명해줘`));
    aiTd.appendChild(aiBtn);
    tr.appendChild(aiTd);
    frag.appendChild(tr);
  }
  body.replaceChildren(frag);
  drawCharts();
  renderChartAsk();
  renderLegend();
  renderStats();
  renderCrossNote();
  renderCalc();
  renderExtra();
  maybeInsight();
}

// 범례: 실제 조회가 아닌 기록(수동 입력/합성)이 있을 때만 표시 (실제 기록으로 바뀌면 자동으로 사라짐)
function legendItem(kind, text) {
  const item = document.createElement('span');
  item.className = 'lg-item';
  const dot = document.createElement('span');
  dot.className = 'lg-dot ' + kind; // real: 채운 원, manual: 마름모, synth: 속이 빈 원
  item.append(dot, text);
  return item;
}
function renderLegend() {
  const lg = $('chart-legend');
  lg.replaceChildren();
  const w = windowRecords();
  const hasManual = w.some((h) => h.manual), hasSynth = w.some((h) => h.synthetic);
  if (!hasManual && !hasSynth) return;
  lg.append(legendItem('real', '실제 조회 (실선)'));
  if (hasManual) lg.append(legendItem('manual', '수동 입력 (점선)'));
  if (hasSynth) lg.append(legendItem('synth', '합성(복구 asset) (점선)'));
}

function setBusy(b) {
  busy = b;
  ['refresh-btn', 'fail-btn', 'retry-btn'].forEach((id) => { $(id).disabled = b; });
}

// ---------- 차트 (단일 시리즈 SVG, 단위가 달라 USD/JPY는 축을 공유하지 않음) ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs = {}) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function niceTicks(min, max, n = 3) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return { ticks, step };
}

// opts: { recs: 그릴 기록(기본은 표시 기간), unit: '원'|'엔', prevFirst: 첫 점의 직전 값, noSelect: 드래그 구간 선택 끄기 }
function drawChart(id, key, title, opts = {}) {
  const box = $(id);
  box.replaceChildren();
  const h3 = document.createElement('h3');
  h3.textContent = title;
  box.appendChild(h3);

  const pts = (opts.recs || windowRecords()).map((h) => ({
    t: Date.parse(h.kst_date + 'T00:00:00Z'), v: h[key], date: h.kst_date, synth: !!h.synthetic, manual: !!h.manual, backfilled: !!h.backfilled,
  }));
  if (pts.length < 2) {
    const p = document.createElement('p');
    p.className = 'small';
    p.textContent = '선택한 기간에 기록이 2건 이상 필요합니다. 기간을 늘리거나 "전체 과거 값 다시 가져오기"를 눌러 보세요.';
    box.appendChild(p);
    return;
  }

  const W = 360, H = 170, m = { l: 48, r: 64, t: 14, b: 26 };
  // Y축: 데이터 범위에 약간의 여백만 두고(바깥으로 반올림하지 않음), 그 안의 깔끔한 값에 눈금을 둔다
  const vals = pts.map((p) => p.v);
  let vmin = Infinity, vmax = -Infinity; // (수천 건에도 안전하도록 spread 대신 반복문)
  for (const v of vals) { if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  const span = vmax - vmin || Math.max(1, vmax * 0.002);
  const y0 = vmin - span * 0.18, y1 = vmax + span * 0.18;
  const nt = niceTicks(y0, y1, 3);
  const step = nt.step;
  const inside = nt.ticks.filter((v) => v >= y0 && v <= y1);
  const ticks = inside.length >= 2 ? inside : nt.ticks;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const dec = step % 1 === 0 ? 0 : step < 1 ? 2 : 1;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title} 일별 추이, 표와 같은 값` });
  for (const tv of ticks) {
    svg.appendChild(svgEl('line', { class: 'ch-grid', x1: m.l, x2: W - m.r, y1: y(tv), y2: y(tv) }));
    const lab = svgEl('text', { class: 'ch-tick', x: m.l - 6, y: y(tv) + 4, 'text-anchor': 'end' });
    lab.textContent = fmt(tv, dec);
    svg.appendChild(lab);
  }
  const first = svgEl('text', { class: 'ch-tick', x: x(t0), y: H - 6, 'text-anchor': 'start' });
  first.textContent = pts[0].date; // 연도 포함 전체 날짜
  const last = svgEl('text', { class: 'ch-tick', x: x(t1), y: H - 6, 'text-anchor': 'end' });
  last.textContent = pts[pts.length - 1].date;
  svg.append(first, last);

  const dense = pts.length > 60; // 점이 많으면 개별 마커 없이 하나의 선으로 그린다
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  svg.appendChild(svgEl('polygon', { class: 'ch-area', points: `${x(t0).toFixed(1)},${y(y0).toFixed(1)} ${line} ${x(t1).toFixed(1)},${y(y0).toFixed(1)}` }));
  if (dense) {
    svg.appendChild(svgEl('polyline', { class: 'ch-line', points: line }));
  } else {
    // 합성/수동 입력 기록이 끝점인 구간은 점선으로 그려 실제 구간과 구분한다
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      svg.appendChild(svgEl('line', {
        class: 'ch-line' + (a.synth || b.synth || a.manual || b.manual ? ' dashed' : ''),
        x1: x(a.t), y1: y(a.v), x2: x(b.t), y2: y(b.v),
      }));
    }
  }

  const cross = svgEl('line', { class: 'ch-cross', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  svg.appendChild(cross);
  const tip = document.createElement('div');
  tip.className = 'ch-tip';
  tip.hidden = true;

  const tagOf = (p) => (p.synth ? ' (합성)' : p.manual ? ' (수동 입력)' : p.backfilled ? ' (소급 조회)' : '');
  const U = opts.unit || '원';
  // 전일 대비: 직전 기록과 비교한다. 선택 기간의 첫 점은 기간 밖의 직전 기록과 비교한다 (windowRecords는 history의 뒷부분)
  const prevVal = (i) => (i > 0 ? pts[i - 1].v
    : opts.prevFirst !== undefined ? opts.prevFirst : (state.history[state.history.length - pts.length - 1] || {})[key]);
  const changeOf = (i) => {
    const pv = prevVal(i);
    if (typeof pv !== 'number' || !(pv > 0)) return null;
    const delta = pts[i].v - pv;
    return { delta, pct: (delta / pv) * 100 };
  };
  const changeText = (i) => { // 스크린리더/키보드용 문장
    const c = changeOf(i);
    if (!c) return '전일 비교 없음';
    if (Math.abs(c.delta) < 0.005) return '전일 대비 변동 없음';
    return `전일 대비 ${c.delta > 0 ? '상승' : '하락'} ${fmt(Math.abs(c.delta))}${U} (${fmt(Math.abs(c.pct))}%)`;
  };
  // 마우스: 플롯 전체를 덮는 투명 영역에서 가장 가까운 점 선택 (마커보다 아래에 둔다)
  const hit = svgEl('rect', { x: m.l - 8, y: m.t, width: W - m.l - m.r + 16, height: H - m.t - m.b, fill: 'transparent' });
  // 드래그로 고른 구간을 옅은 파란 띠로 표시한다 (마우스 이벤트는 받지 않음)
  const selRect = svgEl('rect', { class: 'ch-sel', y: m.t, height: H - m.t - m.b, visibility: 'hidden' });
  svg.appendChild(selRect);
  svg.appendChild(hit);
  const mxOf = (ev) => { const r = svg.getBoundingClientRect(); return ((ev.clientX - r.left) / r.width) * W; };
  const setSel = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    selRect.setAttribute('x', x(pts[lo].t));
    selRect.setAttribute('width', Math.max(2, x(pts[hi].t) - x(pts[lo].t)));
    selRect.setAttribute('visibility', 'visible');
  };
  if (chartSel && !opts.noSelect) {
    const a = pts.findIndex((p) => p.date >= chartSel.start);
    let b = -1;
    pts.forEach((p, i) => { if (p.date <= chartSel.end) b = i; });
    if (a >= 0 && b >= a) setSel(a, b);
  }

  let dots = [];
  let hoverDot = null;
  if (!dense) {
    dots = pts.map((p, i) => {
      const common = { 'aria-label': `${p.date}${tagOf(p)} ${fmt(p.v)}${U}, ${changeText(i)}`, ...(pts.length <= 40 ? { tabindex: 0 } : {}) };
      const d = p.manual // 수동 입력은 마름모로 구분
        ? svgEl('polygon', { ...common, class: 'ch-dot manual', points: `${x(p.t)},${y(p.v) - 6} ${x(p.t) + 6},${y(p.v)} ${x(p.t)},${y(p.v) + 6} ${x(p.t) - 6},${y(p.v)}` })
        : svgEl('circle', { ...common, class: 'ch-dot' + (p.synth ? ' synth' : ''), cx: x(p.t), cy: y(p.v), r: 4 });
      svg.appendChild(d);
      return d;
    });
  } else {
    // 밀집 모드: 마지막 점 + 마우스를 올린 점만 표시
    svg.appendChild(svgEl('circle', { class: 'ch-dot', cx: x(t1), cy: y(pts[pts.length - 1].v), r: 4 }));
    hoverDot = svgEl('circle', { class: 'ch-dot', r: 4, visibility: 'hidden' });
    svg.appendChild(hoverDot);
  }
  const endLab = svgEl('text', { class: 'ch-end', x: x(t1) + 10, y: y(pts[pts.length - 1].v) + 4 });
  endLab.textContent = fmt(pts[pts.length - 1].v);
  svg.appendChild(endLab);

  const show = (i) => {
    const p = pts[i];
    dots.forEach((d, j) => d.classList.toggle('on', i === j));
    if (hoverDot) { hoverDot.setAttribute('cx', x(p.t)); hoverDot.setAttribute('cy', y(p.v)); hoverDot.setAttribute('visibility', 'visible'); }
    cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
    // 툴팁: 날짜(구분) / 환율 / 전일 대비 변화 칩(오르면 빨강 ▲, 내리면 파랑 ▼, 같으면 회색)
    const dateLine = document.createElement('div');
    dateLine.className = 'tip-date';
    dateLine.textContent = `${p.date}${tagOf(p)}`;
    const valLine = document.createElement('div');
    valLine.className = 'tip-val';
    valLine.textContent = `${fmt(p.v)}${U}`;
    const chg = changeOf(i);
    tip.replaceChildren(dateLine, valLine, changeChip(chg ? '전일 대비' : '', chg, U));
    tip.hidden = false;
    // 위치는 SVG의 화면 좌표로 계산한다 (SVG 요소에는 offsetLeft/offsetTop이 없다)
    const r = svg.getBoundingClientRect(), br = box.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const left = (r.left - br.left) + (x(p.t) / W) * r.width;
    tip.style.left = Math.max(half + 2, Math.min(br.width - half - 2, left)) + 'px'; // 카드 밖으로 잘리지 않게
    tip.style.top = (r.top - br.top) + (y(p.v) / H) * r.height + 'px';
  };
  const hide = () => {
    dots.forEach((d) => d.classList.remove('on'));
    if (hoverDot) hoverDot.setAttribute('visibility', 'hidden');
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  // pts는 날짜순이라 x도 증가 → 이진 탐색으로 가장 가까운 점을 찾는다
  const nearest = (mx) => {
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x(pts[mid].t) < mx) lo = mid; else hi = mid; }
    return Math.abs(x(pts[lo].t) - mx) <= Math.abs(x(pts[hi].t) - mx) ? lo : hi;
  };
  hit.addEventListener('mousemove', (ev) => {
    const i = nearest(mxOf(ev));
    show(i);
    if (chartDrag && chartDrag.pts === pts) { // 드래그 중: 선택 띠를 늘린다
      chartDrag.i1 = i;
      if (i !== chartDrag.i0) chartDrag.moved = true;
      setSel(chartDrag.i0, i);
    }
  });
  hit.addEventListener('mousedown', (ev) => {
    if (opts.noSelect || ev.button !== 0) return;
    const i = nearest(mxOf(ev));
    chartDrag ={ pts, i0: i, i1: i, moved: false };
    ev.preventDefault(); // 드래그 중 글자가 선택되지 않게
  });
  hit.addEventListener('mouseleave', hide);
  dots.forEach((d, i) => { d.addEventListener('focus', () => show(i)); d.addEventListener('blur', hide); });

  box.append(svg, tip);
}

// ---------- 챗봇 ----------
const FALLBACK = 'AI 분석을 불러올 수 없습니다. 마지막 정상 환율 데이터를 확인하세요.';
function addMsg(text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls; div.textContent = text;
  pushChat(div);
}
// 오류 메시지: 정해진 대체 문구 + 원인 한 줄
function addErrMsg(detail, noData) {
  const div = document.createElement('div');
  div.className = 'msg err';
  if (noData) {
    const b = document.createElement('div');
    b.className = 'badge-stale none';
    b.textContent = '⚠ 환율 데이터 없음';
    div.appendChild(b);
  }
  const p = document.createElement('p');
  p.textContent = FALLBACK;
  const d = document.createElement('div');
  d.className = 'detail';
  d.textContent = '원인: ' + detail;
  div.append(p, d);
  pushChat(div);
}
class ChatError extends Error {
  constructor(detail, noData = false) { super(detail); this.detail = detail; this.noData = noData; }
}
function pushChat(el) {
  const log = $('chat-log');
  log.appendChild(el);
  log.scrollTop = log.scrollHeight; // 새 메시지가 보이도록 맨 아래로
}

// 전일 대비 변화 칩: 오르면 빨강(▲), 내리면 파랑(▼), 같으면 회색. 색만이 아니라 화살표와 부호도 함께 표시
function changeChip(label, d, unit = '원') {
  const chip = document.createElement('span');
  chip.className = 'chg';
  if (!d) { chip.classList.add('flat'); chip.textContent = `${label ? label + ' ' : ''}전일 비교 없음`; return chip; }
  // 표시 단위(소수 2자리)로 반올림해 0이면 변동 없음으로 본다 (저장 시 반올림 오차로 +0.00이 뜨는 것 방지)
  const dir = Math.abs(d.delta) < 0.005 ? 'flat' : d.delta > 0 ? 'up' : 'down';
  chip.classList.add(dir);
  if (dir === 'flat') { chip.textContent = `${label ? label + ' ' : ''}변동 없음`; return chip; }
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '-';
  const sign = d.delta > 0 ? '+' : d.delta < 0 ? '-' : '';
  chip.textContent = `${label} ${arrow} ${sign}${fmt(Math.abs(d.delta))}${unit} (${sign}${fmt(Math.abs(d.pct))}%)`;
  return chip;
}

// ----- AI 맥락 구성: 현재 값 + 사용자가 보고 있는 기간(또는 선택한 구간)의 요약 통계 -----
const RANGE_NAMES = { 1: '최근 1일', 7: '최근 7일', 30: '최근 30일', 90: '최근 90일', 180: '최근 180일', 365: '최근 365일', 3650: '최근 10년', 0: '전체 기간' };
function summarizeRecords(recs, key) {
  const vals = recs.map((h) => h[key]);
  const n = vals.length;
  let min = Infinity, max = -Infinity, minI = 0, maxI = 0, sum = 0, below = 0, equal = 0;
  vals.forEach((v, i) => { sum += v; if (v < min) { min = v; minI = i; } if (v > max) { max = v; maxI = i; } });
  const last = vals[n - 1];
  vals.forEach((v) => { if (v < last) below++; else if (v === last) equal++; });
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    first: r2(vals[0]), last: r2(last), change: r2(last - vals[0]), changePct: r2(((last - vals[0]) / vals[0]) * 100),
    min: r2(min), minDate: recs[minI].kst_date, max: r2(max), maxDate: recs[maxI].kst_date, avg: r2(sum / n),
    percentile: Math.round(((below + 0.5 * equal) / n) * 100), // 현재 값이 구간 안에서 차지하는 위치 (0=최저, 100=최고)
  };
}
// focus: {start,end} 직접 선택한 구간 / fixedDays: 표시 기간과 무관하게 최근 N일 / 둘 다 없으면 지금 표시 중인 기간
function buildAiContext(focus, fixedDays) {
  const lv = state.last_valid;
  if (!lv) return null;
  const du = diffInfo('usd_krw'), dj = diffInfo('jpy100_krw');
  const latest = {
    usd_krw: lv.usd_krw, usd_change: du ? du.delta : null, jpy100_krw: lv.jpy100_krw, jpy_change: dj ? dj.delta : null,
    status: state.status, kst_date: lv.kst_date, synthetic: !!lv.synthetic,
  };
  let pool, label;
  if (focus) { pool = state.history.filter((h) => h.kst_date >= focus.start && h.kst_date <= focus.end); label = '선택한 구간'; }
  else if (fixedDays) {
    const start = addDays(state.history[state.history.length - 1].kst_date, -fixedDays);
    pool = state.history.filter((h) => h.kst_date >= start); label = RANGE_NAMES[fixedDays];
  } else { pool = windowRecords(); label = RANGE_NAMES[rangeDays()] || ''; }
  const recs = pool.filter((h) => !h.synthetic); // 합성(시험) 기록은 분석에서 제외
  const range = recs.length >= 2 ? {
    label, start: recs[0].kst_date, end: recs[recs.length - 1].kst_date, n: recs.length, focus: !!focus,
    usd: summarizeRecords(recs, 'usd_krw'), jpy: summarizeRecords(recs, 'jpy100_krw'),
  } : null;
  return { latest, range, du, dj, lv };
}

// ----- AI 호출 (스트리밍) -----
const AI_ERRORS = {
  auth: 'AI 인증키 오류 (서버 설정 확인 필요)', quota: 'AI 사용 한도를 초과했습니다 (잠시 후 다시 시도)', timeout: 'AI 응답 시간 초과',
  upstream: 'AI 서비스 응답 오류 (잠시 후 다시 시도)', empty: 'AI가 빈 응답을 반환했습니다', internal: '서버 내부 오류',
};
let chatHistory = []; // 대화 기억: [{role:'user'|'model', text}]
// ctx: buildAiContext 결과. onStatus(text) 진행 안내, onDelta(fullText) 답변이 늘어날 때마다 호출
async function askAI({ question, mode = 'chat', ctx, onStatus, onDelta }) {
  const body = { question, mode, history: mode === 'chat' ? chatHistory.slice(-6) : [], context: { latest: ctx.latest, range: ctx.range } };
  let res;
  try {
    res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new ChatError(e.name === 'TimeoutError' ? '응답 시간 초과' : '서버에 연결할 수 없습니다');
  }
  if (!res.ok) throw new ChatError(res.status === 400 ? '질문 형식 오류' : res.status === 429 ? '요청이 너무 많습니다 (잠시 후 다시 시도)' : res.status === 503 ? 'AI 키가 서버에 설정되지 않았습니다' : `서버 오류 (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', meta = null, truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(chunk.slice(5)); } catch (_) { continue; }
        if (ev.type === 'status' && onStatus) onStatus(ev.text);
        else if (ev.type === 'delta') { text += ev.text; if (onDelta) onDelta(text); }
        else if (ev.type === 'meta') meta = ev;
        else if (ev.type === 'error') { if (text) { truncated = true; } else throw new ChatError(AI_ERRORS[ev.code] || AI_ERRORS.internal); }
      }
    }
  } catch (e) {
    if (e instanceof ChatError) throw e;
    if (!text) throw new ChatError('응답이 중간에 끊겼습니다');
    truncated = true; // 일부만 받았으면 받은 만큼은 보여 준다
  }
  if (!text.trim()) throw new ChatError(AI_ERRORS.empty);
  return { text, meta, truncated };
}

// 답변 본문: 마크다운 기호를 지우고 문장 단위로 줄을 나눠 그린다 (스트리밍 중에도 호출됨)
function renderBody(body, text) {
  const clean = text.replace(/\*\*|__|^#+\s*/gm, '').replace(/^\s*[*-]\s+/gm, '').trim();
  body.replaceChildren(...clean.split(/(?<=[.!?])\s+/).filter(Boolean).map((s) => {
    const p = document.createElement('p');
    p.textContent = s;
    return p;
  }));
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
}
// 답변 말풍선 틀: 최신 아님 배지 + 전일 대비 변화 칩 + 본문 자리
function createBotMsg(ctx) {
  const { lv, du, dj } = ctx;
  const div = document.createElement('div');
  div.className = 'msg bot';
  if (state.status === 'stale' || lv.synthetic) {
    const b = document.createElement('div');
    b.className = 'badge-stale';
    b.textContent = state.status === 'stale'
      ? `⚠ 최신이 아닐 수 있음${lv.fetched_at ? ' · 마지막 정상값 ' + ago(lv.fetched_at) : ''}`
      : '⚠ 합성(시험) 값 기준 답변';
    div.appendChild(b);
  }
  const row = document.createElement('div');
  row.className = 'chg-row';
  row.append(changeChip('USD', du), changeChip('100엔', dj));
  const base = document.createElement('span');
  base.className = 'small';
  base.textContent = du ? `기준 ${du.from} → ${lv.kst_date}` : '';
  row.appendChild(base);
  const body = document.createElement('div');
  body.className = 'body';
  div.append(row, body);
  pushChat(div);
  return { div, body };
}
// 답변 아래: 어떤 데이터를 근거로 했는지 (AI가 도구로 추가 조회한 기간도 그대로 공개)
function addSourceCaption(bot, meta, truncated) {
  const parts = [];
  if (meta && meta.range) parts.push(`${meta.range.label || '구간'} ${meta.range.start} ~ ${meta.range.end} (${meta.range.n}영업일)`);
  const tools = (meta && meta.tools) || [];
  // 근거 구분 배지: 한국은행 통계 숫자를 근거로 한 답인지, 일반 지식으로 답한 일반 추론인지
  const grounded = !!((meta && meta.range) || tools.length);
  const badge = document.createElement('div');
  badge.className = 'basis ' + (grounded ? 'stat' : 'general');
  badge.textContent = grounded ? '📊 통계 근거 (원인 설명은 일반 추론)' : '💭 일반 추론';
  badge.title = grounded
    ? '한국은행 통계 숫자를 근거로 한 설명입니다. "~일 수 있습니다" 같은 원인 설명은 추론입니다.'
    : '구체적인 통계 없이 일반 지식으로 답했습니다.';
  bot.div.insertBefore(badge, bot.div.firstChild);
  const rateTools = tools.filter((t) => t.kind !== 'indicators');
  const indTools = tools.filter((t) => t.kind === 'indicators');
  if (rateTools.length) parts.push('AI가 추가 조회한 환율: ' + rateTools.map((t) => `${t.start} ~ ${t.end}`).join(', '));
  parts.push(meta && meta.source ? meta.source : '한국은행 ECOS 매매기준율');
  const cap = document.createElement('div');
  cap.className = 'src';
  cap.textContent = '📊 참고 데이터: ' + parts.join(' · ');
  bot.div.appendChild(cap);
  // 환율과 함께 움직인 지표를 근거로 썼다면 어떤 지표를 어느 기간으로 조회했는지 공개한다
  indTools.forEach((t) => {
    const ind = document.createElement('div');
    ind.className = 'src';
    ind.textContent = `📈 참고 지표: ${(t.names || []).join(', ')} · ${t.start} ~ ${t.end} · 한국은행 ECOS (함께 움직인 지표이며 원인을 뜻하지는 않습니다)`;
    bot.div.appendChild(ind);
  });
  if (truncated) {
    const t = document.createElement('div');
    t.className = 'src warn';
    t.textContent = '⚠ 응답이 중간에 끊겨 일부만 표시되었습니다.';
    bot.div.appendChild(t);
  }
}

let chatBusy = false;
let pendingFocus = null; // 그래프에서 고른 구간으로 질문할 때 onChat 이 사용한다
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function onChat(ev) {
  ev.preventDefault();
  if (chatBusy) return; // 중복 전송 방지
  const q = $('chat-input').value.trim();
  if (!q) return;
  const focus = pendingFocus;
  pendingFocus = null;
  setChatBusy(true);
  addMsg(q, 'user');
  $('chat-input').value = '';
  updateCount();
  const wait = document.createElement('div');
  wait.className = 'msg wait';
  wait.textContent = '답변 생성 중...';
  pushChat(wait);
  let bot = null;
  try {
    // 조회한 값이 없으면 먼저 자동 조회
    if (!state.last_valid) {
      if (busy) { for (let i = 0; i < 30 && busy; i++) await sleep(300); }
      else await onRealFetch();
    }
    const ctx = buildAiContext(focus);
    if (!ctx) throw new ChatError('조회된 환율 값이 없습니다. "실제 환율 조회"로 값을 먼저 가져와 주세요.', true);
    const out = await askAI({
      question: q, mode: 'chat', ctx,
      onStatus: (t) => { if (wait.isConnected) wait.textContent = t; },
      onDelta: (text) => {
        if (!bot) { wait.remove(); bot = createBotMsg(ctx); } // 첫 글자가 오면 말풍선을 만들고 이후 계속 채운다
        renderBody(bot.body, text);
      },
    });
    wait.remove();
    if (!bot) { bot = createBotMsg(ctx); renderBody(bot.body, out.text); }
    addSourceCaption(bot, out.meta, out.truncated);
    chatHistory.push({ role: 'user', text: q }, { role: 'model', text: out.text });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
  } catch (e) {
    wait.remove();
    if (bot) { // 일부 글자를 받은 뒤 실패: 받은 내용은 남기고 안내만 덧붙인다
      const t = document.createElement('div');
      t.className = 'src warn';
      t.textContent = '⚠ 응답이 중간에 끊겼습니다: ' + (e instanceof ChatError ? e.detail : '알 수 없는 오류');
      bot.div.appendChild(t);
    } else addErrMsg(e instanceof ChatError ? e.detail : '알 수 없는 오류', e instanceof ChatError && e.noData);
  } finally {
    setChatBusy(false);
  }
}
// 전송 중에는 질문 버튼, 예시 버튼, 입력창을 잠근다
function setChatBusy(b) {
  chatBusy = b;
  $('chat-btn').disabled = b;
  $('chat-btn').textContent = b ? '생성 중...' : '질문';
  $('chat-input').disabled = b;
  document.querySelectorAll('.chip').forEach((c) => { c.disabled = b; });
  $('chat-reset').disabled = b;
  document.querySelectorAll('#chart-ask button').forEach((c) => { c.disabled = b; });
  document.querySelectorAll('.ai-row').forEach((c) => { c.disabled = b || c.dataset.off === '1'; }); // 표의 ✨ 버튼 (원래 비활성인 것은 유지)
  if (!b) $('chat-input').focus({ preventScroll: true }); // 입력창이 화면 밖이면 브라우저가 페이지를 내려 버리므로 스크롤은 막는다
}
function updateCount() {
  const n = $('chat-input').value.length;
  const el = $('chat-count');
  el.textContent = `${n} / 200`;
  el.classList.toggle('warn', n >= 180 && n < 200);
  el.classList.toggle('limit', n >= 200);
}
$('chat-input').addEventListener('input', updateCount);
$('chat-reset').addEventListener('click', () => {
  if (chatBusy) return;
  chatHistory = [];
  $('chat-log').replaceChildren(); // 비면 안내 문구가 다시 보인다
});

// ----- 오늘의 한 줄 요약: 수치와 표현을 모두 코드가 만든다 -----
// AI 가 문장을 쓰면 "최근 30일 기준"과 "전일 대비"가 한 문장에 섞이고 표현이 들쭉날쭉해지는 문제가 확인되어(같은 입력으로 6번 중 6번),
// 계산과 문장 조립을 코드로 옮겼다. 표현의 크기 기준은 아래 임계값 하나로만 정해진다.
const DAY_STEPS = [0.1, 0.5, 1];  // 하루 변화(%): 거의 변동 없음 / 소폭 / 다소 / 큰 폭
const PERIOD_STEPS = [0.5, 2, 4]; // 30일 변화(%)
function sizeOf(pct, steps) {
  const a = Math.abs(pct);
  return a < steps[0] ? 'flat' : a < steps[1] ? 'small' : a < steps[2] ? 'mid' : 'large';
}
const signedWon = (v) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${fmt(Math.abs(v))}원`;
const signedPct = (v) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${fmt(Math.abs(v))}%`;
// 오늘(전일 대비) 한 통화의 절: ending 은 '고' | '으며' | '습니다'
function dayClause(name, d, ending) {
  const size = sizeOf(d.pct, DAY_STEPS);
  const chg = `(${signedWon(d.delta)})`;
  if (size === 'flat') return `${name}는 거의 변동이 없었${ending}${chg}`;
  const amt = size === 'small' ? '소폭 ' : size === 'mid' ? '다소 ' : '큰 폭으로 ';
  return `${name}는 ${amt}${d.delta > 0 ? '올랐' : '내렸'}${ending}${chg}`;
}
// 기간 변화 한 통화의 구
function periodPhrase(name, s) {
  const size = sizeOf(s.changePct, PERIOD_STEPS);
  if (size === 'flat') return `${name} 거의 변동 없음(${signedPct(s.changePct)})`;
  const amt = size === 'small' ? '소폭 ' : size === 'mid' ? '다소 ' : '큰 폭 ';
  return `${name} ${amt}${s.changePct > 0 ? '상승' : '하락'}(${signedPct(s.changePct)})`;
}
function insightSentence() {
  const du = diffInfo('usd_krw'), dj = diffInfo('jpy100_krw');
  const h = state.history;
  const start = h.length ? addDays(h[h.length - 1].kst_date, -30) : null;
  const recs = start ? h.filter((x) => x.kst_date >= start && !x.synthetic) : [];
  const hasPeriod = recs.length >= 2;
  const su = hasPeriod ? summarizeRecords(recs, 'usd_krw') : null;
  const sj = hasPeriod ? summarizeRecords(recs, 'jpy100_krw') : null;
  let s;
  if (!du || !dj) s = '오늘은 전일과 비교할 기록이 아직 없습니다';
  else if (sizeOf(du.pct, DAY_STEPS) === 'flat' && sizeOf(dj.pct, DAY_STEPS) === 'flat') {
    s = `오늘 달러와 엔화 모두 거의 변동이 없었${hasPeriod ? '으며' : '습니다'}(달러 ${signedWon(du.delta)}, 엔화 ${signedWon(dj.delta)})`;
  } else s = `오늘 ${dayClause('달러', du, '고')} ${dayClause('엔화', dj, hasPeriod ? '으며' : '습니다')}`;
  if (hasPeriod) s += `, 최근 30일 기준으로는 ${periodPhrase('달러', su)}, ${periodPhrase('엔화', sj)}입니다.`;
  else s += '.';
  const note = [`기준일 ${state.last_valid.kst_date}`];
  if (du) note.push(`전일(${du.from}) 대비`);
  if (hasPeriod) note.push(`최근 30일 = ${recs[0].kst_date} ~ ${recs[recs.length - 1].kst_date}`);
  if (state.status === 'stale') note.push('⚠ 최신이 아닐 수 있는 값');
  return { text: s, note: note.join(' · ') };
}
function maybeInsight() {
  const card = $('insight');
  const lv = state.last_valid;
  if (!lv || lv.synthetic) { card.hidden = true; return; } // 합성(시험) 값으로는 요약하지 않는다
  const r = insightSentence();
  card.hidden = false;
  $('insight-text').textContent = r.text;
  $('insight-note').textContent = r.note;
}

// ----- 그래프에서 구간을 드래그로 고르고 AI에게 설명 요청 -----
let chartSel = null;  // {start, end}
let chartDrag = null; // 드래그 중인 상태 (drawChart 에서 설정)
function drawCharts() {
  drawChart('chart-usd', 'usd_krw', 'USD / KRW (원)');
  drawChart('chart-jpy', 'jpy100_krw', '100 JPY / KRW (원)');
  drawCrossChart();
}
function setChartSel(start, end) {
  chartSel = start && end ? { start, end } : null;
  drawCharts();
  renderChartAsk();
}
document.addEventListener('mouseup', () => { // 마우스를 그래프 밖에서 놓아도 드래그를 마친다
  if (!chartDrag) return;
  const d = chartDrag;
  chartDrag = null;
  if (!d.moved) return;
  const a = Math.min(d.i0, d.i1), b = Math.max(d.i0, d.i1);
  setChartSel(d.pts[a].date, d.pts[b].date);
});
function renderChartAsk() {
  const el = $('chart-ask');
  el.replaceChildren();
  const usable = windowRecords().filter((h) => !h.synthetic);
  if (usable.length < 2) return;
  const info = document.createElement('span');
  info.className = 'small';
  const ask = document.createElement('button');
  ask.type = 'button';
  ask.className = 'outline sm';
  ask.disabled = chatBusy;
  if (chartSel) {
    const n = state.history.filter((h) => !h.synthetic && h.kst_date >= chartSel.start && h.kst_date <= chartSel.end).length;
    info.textContent = `선택 구간 ${chartSel.start} ~ ${chartSel.end} (${n}영업일)`;
    ask.textContent = '✨ 이 구간 AI에게 설명 요청';
    ask.addEventListener('click', () => askAboutRange({ ...chartSel }));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'link-btn';
    clear.textContent = '선택 해제';
    clear.addEventListener('click', () => setChartSel(null, null));
    el.append(info, ask, clear);
  } else {
    info.textContent = '그래프를 마우스로 드래그하면 구간을 고를 수 있어요.';
    ask.textContent = `✨ ${RANGE_NAMES[rangeDays()] || '표시 기간'} 흐름 AI 설명`;
    ask.addEventListener('click', () => askAboutRange(null));
    el.append(info, ask);
  }
}
function askAboutRange(focus, questionOverride) {
  if (chatBusy) return;
  pendingFocus = focus;
  $('chat-input').value = questionOverride || (focus
    ? `선택한 구간(${focus.start} ~ ${focus.end})의 환율 흐름과 특징을 설명해줘`
    : `${RANGE_NAMES[rangeDays()] || '표시 기간'} 동안의 환율 흐름과 특징을 설명해줘`);
  updateCount();
  // 좁은 화면(패널이 페이지 맨 아래에 있는 경우)에서만 패널로 이동한다. 넓은 화면에서는 패널이 이미 옆에 떠 있다.
  if (matchMedia('(max-width: 960px)').matches) document.querySelector('.chat').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('chat-form').requestSubmit();
}

// ---------- 통화 이름 / 환율표 / 공통 복사 ----------
const EXTRA_NAMES = { EUR: '유로', CNY: '중국 위안', GBP: '영국 파운드', AUD: '호주 달러', CAD: '캐나다 달러', CHF: '스위스 프랑', HKD: '홍콩 달러', SGD: '싱가포르 달러', THB: '태국 바트' };
const CUR_NAME = { KRW: '대한민국 원', USD: '미국 달러', JPY: '일본 엔', ...EXTRA_NAMES };
const MAX_EXTRA = 6;
let extraData = {};     // { EUR: [[날짜, 값], ...] } 서버에서 받은 추가 통화 일별 값
let extraRange = null;  // 마지막으로 받은 { start, end }
let extraBusy = false, extraAgain = false, extraError = '';
const extraCodes = () => (Array.isArray(state.extra_currencies) ? state.extra_currencies : []);
const positionWord = (p) => (p >= 80 ? '이 기간 중 매우 높은 편' : p >= 60 ? '이 기간 중 높은 편' : p >= 40 ? '이 기간 중 중간쯤' : p >= 20 ? '이 기간 중 낮은 편' : '이 기간 중 매우 낮은 편');
const pctSign = (v) => (v > 0 ? '+' : v < 0 ? '-' : '');

// "1단위당 원화" 환율표: KRW=1, USD, JPY(1엔당), 그리고 불러온 추가 통화
function ratesNow() {
  const lv = state.last_valid;
  if (!lv) return null;
  const r = { KRW: 1, USD: lv.usd_krw, JPY: lv.jpy100_krw / 100 };
  for (const c of extraCodes()) { const s = extraData[c]; if (s && s.length) r[c] = s[s.length - 1][1]; }
  return r;
}
// 복사/계산기에 붙는 출처·시각 문구
function basisText() {
  const lv = state.last_valid;
  if (!lv) return '';
  const ref = lv.fetched_at || state.last_success_at;
  const src = lv.synthetic ? '합성(시험) 값' : lv.manual ? '수동 입력' : '한국은행 ECOS 매매기준율';
  return `${ref ? kstStamp(ref) + ' 조회' : '조회 시각 없음'}, 기준일 ${lv.source_date || lv.kst_date}, ${src}` + (state.status === 'stale' ? ', 최신이 아닐 수 있음' : '');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) { // clipboard API 를 못 쓰는 환경 대비
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
}
function flash(btn, text, ms = 1500) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = btn.dataset.label; }, ms);
}

// ---------- 카드의 복사/공유 버튼: 출처와 시각이 한 줄에 같이 들어간다 ----------
function rateLine(code) {
  const lv = state.last_valid;
  if (!lv) return '';
  const head = code === 'USD' ? `USD ${fmt(lv.usd_krw)}원` : `JPY 100엔 ${fmt(lv.jpy100_krw)}원`;
  return `${head} (${basisText()})`;
}
document.querySelectorAll('.copy-rate').forEach((b) => b.addEventListener('click', async () => {
  const t = rateLine(b.dataset.cur);
  if (!t) { flash(b, '값 없음'); return; }
  flash(b, (await copyText(t)) ? '복사됨 ✔' : '복사 실패');
}));
if (navigator.share) { // 공유 기능을 지원하는 기기(주로 모바일)에서만 공유 버튼을 보여 준다
  document.querySelectorAll('.share-rate').forEach((b) => {
    b.hidden = false;
    b.addEventListener('click', async () => {
      const t = rateLine(b.dataset.cur);
      if (!t) return;
      try { await navigator.share({ title: '환율', text: t }); } catch (_) { /* 사용자가 취소 */ }
    });
  });
}

// ---------- 환율 계산기 (원 · 달러 · 엔 + 추가 통화, 양방향) ----------
let calcKey = '', calcText = '';
const unitLabel = (c) => (c === 'KRW' ? '원' : c);
const calcFmt = (code, v) => (code === 'KRW' ? fmt(v, v >= 100 ? 0 : 2) : fmt(v, 2));
function fillCalcOptions() {
  const codes = ['KRW', 'USD', 'JPY', ...extraCodes().filter((c) => extraData[c] && extraData[c].length)];
  const key = codes.join(',');
  if (key === calcKey) return;
  calcKey = key;
  for (const [id, def] of [['calc-from', 'USD'], ['calc-to', 'KRW']]) {
    const sel = $(id), cur = sel.value;
    sel.replaceChildren(...codes.map((c) => { const o = document.createElement('option'); o.value = c; o.textContent = `${c} · ${CUR_NAME[c]}`; return o; }));
    sel.value = codes.includes(cur) ? cur : def;
  }
}
function renderCalc() {
  fillCalcOptions();
  const res = $('calc-result'), det = $('calc-detail'), copyBtn = $('calc-copy');
  res.replaceChildren(); det.replaceChildren(); calcText = '';
  const rates = ratesNow();
  if (!rates) { res.textContent = '환율 값을 먼저 조회해 주세요.'; copyBtn.disabled = true; return; }
  const raw = $('calc-amount').value.replace(/[,\s]/g, '');
  const amount = Number(raw);
  if (raw === '' || !isFinite(amount) || amount < 0 || amount > 1e13) { res.textContent = '0 이상의 숫자를 입력해 주세요.'; copyBtn.disabled = true; return; }
  const from = $('calc-from').value, to = $('calc-to').value;
  if (!(rates[from] > 0) || !(rates[to] > 0)) { res.textContent = '선택한 통화의 환율을 불러오는 중입니다.'; copyBtn.disabled = true; return; }
  const out = (amount * rates[from]) / rates[to];
  const left = `${calcFmt(from, amount)} ${unitLabel(from)} = `;
  const strong = document.createElement('strong');
  strong.textContent = `${calcFmt(to, out)} ${unitLabel(to)}`;
  res.append(left, strong);

  // 적용한 환율 설명 (100엔 단위 표기를 풀어서 보여 준다)
  const lines = [];
  const used = [...new Set([from, to])].filter((c) => c !== 'KRW');
  for (const c of used) {
    lines.push(c === 'JPY'
      ? `100 JPY = ${fmt(rates.JPY * 100)}원  (1 JPY = ${fmt(rates.JPY, 4)}원)`
      : `1 ${c} = ${fmt(rates[c])}원`);
  }
  if (from !== 'KRW' && to !== 'KRW' && from !== to) lines.push(`1 ${from} = ${fmt(rates[from] / rates[to], 4)} ${to}  (원화를 거쳐 계산)`);
  if (used.includes('JPY')) lines.push('※ 엔화는 보통 100엔 기준으로 고시됩니다. 1엔 값은 100엔 값의 1/100입니다.');
  lines.push(`기준: ${basisText()}`);
  if (state.status === 'stale') lines.push('⚠ 최신이 아닐 수 있는 값으로 계산했습니다.');
  if (state.last_valid.synthetic) lines.push('⚠ 합성(시험) 값으로 계산했습니다.');
  lines.push('실제 환전·송금 환율은 은행·환전소의 수수료와 우대율에 따라 다릅니다.');
  lines.forEach((t) => { const p = document.createElement('div'); p.textContent = t; det.appendChild(p); });

  calcText = `${calcFmt(from, amount)} ${unitLabel(from)} = ${calcFmt(to, out)} ${unitLabel(to)} (적용 환율: ${used.map((c) => (c === 'JPY' ? `100 JPY = ${fmt(rates.JPY * 100)}원` : `1 ${c} = ${fmt(rates[c])}원`)).join(', ') || '원 기준'}; ${basisText()})`;
  copyBtn.disabled = false;
}
$('calc-amount').addEventListener('input', renderCalc);
$('calc-from').addEventListener('change', renderCalc);
$('calc-to').addEventListener('change', renderCalc);
$('calc-swap').addEventListener('click', () => {
  const a = $('calc-from').value;
  $('calc-from').value = $('calc-to').value;
  $('calc-to').value = a;
  renderCalc();
});
$('calc-copy').addEventListener('click', async () => {
  if (!calcText) return;
  flash($('calc-copy'), (await copyText(calcText)) ? '복사됨 ✔' : '복사 실패');
});

// ---------- 기간 통계 카드 (숫자는 모두 코드로 계산) ----------
function renderStats() {
  const box = $('stats');
  box.replaceChildren();
  const recs = windowRecords().filter((h) => !h.synthetic);
  if (recs.length < 2) {
    const p = document.createElement('p');
    p.className = 'small';
    p.textContent = '선택한 기간에 기록이 2건 이상 있으면 표시됩니다.';
    box.appendChild(p);
    return;
  }
  for (const [key, title] of [['usd_krw', 'USD / KRW'], ['jpy100_krw', '100 JPY / KRW']]) {
    const s = summarizeRecords(recs, key);
    const card = document.createElement('div');
    card.className = 'stat-card';
    const h4 = document.createElement('h4');
    h4.textContent = title;
    card.appendChild(h4);
    const rows = [
      ['기간 변화', changeChip('', { delta: s.change, pct: s.changePct })],
      ['최고', `${fmt(s.max)}원`, s.maxDate],
      ['최저', `${fmt(s.min)}원`, s.minDate],
      ['평균', `${fmt(s.avg)}원`],
      ['변동폭', `${fmt(s.max - s.min)}원`, `평균 대비 ${fmt(((s.max - s.min) / s.avg) * 100)}%`],
      ['현재 위치', positionWord(s.percentile)],
    ];
    const dl = document.createElement('dl');
    dl.className = 'stat-list';
    for (const [name, val, sub] of rows) {
      const dt = document.createElement('dt'); dt.textContent = name;
      const dd = document.createElement('dd');
      if (typeof val === 'string') dd.textContent = val; else dd.appendChild(val);
      if (sub) { const sm = document.createElement('span'); sm.className = 'small'; sm.textContent = ` ${sub}`; dd.appendChild(sm); }
      dl.append(dt, dd);
    }
    card.appendChild(dl);
    box.appendChild(card);
  }
}

// ---------- 교차 환율: 달러/엔 (원/엔 = 원/달러 ÷ 달러/엔) ----------
const usdJpy = (h) => h.usd_krw / (h.jpy100_krw / 100);
function drawCrossChart() {
  const win = windowRecords();
  const prev = state.history[state.history.length - win.length - 1];
  drawChart('chart-cross', 'usd_jpy', '달러 / 엔 (1달러당 엔)', {
    recs: win.map((h) => ({ ...h, usd_jpy: usdJpy(h) })), unit: '엔', prevFirst: prev ? usdJpy(prev) : undefined,
  });
}
function pctChip(label, v) {
  const chip = document.createElement('span');
  const dir = Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down';
  chip.className = 'chg ' + dir;
  chip.textContent = dir === 'flat' ? `${label} 변동 없음` : `${label} ${dir === 'up' ? '▲' : '▼'} ${pctSign(v)}${fmt(Math.abs(v))}%`;
  return chip;
}
function renderCrossNote() {
  const box = $('cross-note');
  box.replaceChildren();
  const recs = windowRecords().filter((h) => !h.synthetic);
  if (recs.length < 2) return;
  const a = recs[0], b = recs[recs.length - 1];
  const pc = (x, y) => (y / x - 1) * 100;
  const usd = pc(a.usd_krw, b.usd_krw), ujy = pc(usdJpy(a), usdJpy(b)), jpy = pc(a.jpy100_krw, b.jpy100_krw);
  const head = document.createElement('div');
  head.className = 'small';
  head.textContent = `${a.kst_date} → ${b.kst_date} 변화율`;
  box.appendChild(head);
  const rows = [
    ['원/달러', usd, usd > 0 ? '달러 대비 원화 약세' : usd < 0 ? '달러 대비 원화 강세' : '변동 없음'],
    ['달러/엔', ujy, ujy > 0 ? '달러 대비 엔화 약세' : ujy < 0 ? '달러 대비 엔화 강세' : '변동 없음'],
    ['원/엔(100엔)', jpy, jpy > 0 ? '원화 대비 엔화 강세' : jpy < 0 ? '원화 대비 엔화 약세' : '변동 없음'],
  ];
  for (const [label, v, meaning] of rows) {
    const row = document.createElement('div');
    row.className = 'cross-row';
    const m = document.createElement('span');
    m.className = 'small';
    m.textContent = meaning;
    row.append(pctChip(label, v), m);
    box.appendChild(row);
  }
  const why = document.createElement('p');
  why.className = 'cross-why';
  if (Math.abs(jpy) < 0.05) why.textContent = '이 기간 원/엔은 거의 변하지 않았습니다.';
  else {
    const dir = jpy > 0 ? '올랐' : '내렸';
    why.textContent = Math.abs(usd) >= Math.abs(ujy)
      ? `이 기간 원/엔이 ${dir}습니다. 주된 이유는 달러 대비 원화의 움직임(원/달러 ${pctSign(usd)}${fmt(Math.abs(usd))}%, ${usd > 0 ? '원화 약세' : '원화 강세'})입니다.`
      : `이 기간 원/엔이 ${dir}습니다. 주된 이유는 달러 대비 엔화의 움직임(달러/엔 ${pctSign(ujy)}${fmt(Math.abs(ujy))}%, ${ujy > 0 ? '엔화 약세' : '엔화 강세'})입니다.`;
  }
  box.appendChild(why);
  const how = document.createElement('p');
  how.className = 'small';
  how.textContent = '원/엔 = 원/달러 ÷ 달러/엔. 원/엔이 내려가는 길은 ① 원화가 달러에 강해지거나(원/달러↓) ② 엔화가 달러에 약해지는 것(달러/엔↑) 두 가지입니다.';
  box.appendChild(how);
}

// ---------- 추가 통화 (유로, 위안 등) ----------
function extraFetchRange() {
  const end = kstDate();
  const d = rangeDays();
  const days = d === 0 || d >= 3650 ? 1826 : Math.min(Math.max(d, 14), 1826); // 최대 5년
  return { start: addDays(end, -days), end };
}
async function loadExtra(force) {
  const codes = extraCodes();
  if (!codes.length) { extraData = {}; extraRange = null; extraError = ''; renderExtra(); renderCalc(); return; }
  const w = extraFetchRange();
  if (!force && extraRange && extraRange.start === w.start && codes.every((c) => extraData[c])) { renderExtra(); return; }
  if (extraBusy) { extraAgain = true; return; }
  extraBusy = true;
  extraError = '';
  renderExtra();
  try {
    const res = await fetch(`/api/rates?start=${w.start}&end=${w.end}&extra=${codes.join(',')}&only_extra=1`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('http ' + res.status);
    const json = await res.json();
    extraData = json.extra && typeof json.extra === 'object' ? json.extra : {};
    extraRange = w;
    extraFetchedAt = new Date().toISOString();
  } catch (_) {
    extraError = '추가 통화를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  } finally {
    extraBusy = false;
    renderExtra();
    renderCalc();
    if (extraAgain) { extraAgain = false; loadExtra(true); }
  }
}
// 표시 기간에 맞춰 자른 기록과, 첫 점의 직전 값
function extraWindow(s) {
  const d = rangeDays();
  const last = s[s.length - 1][0];
  const start = d === 0 || d >= 3650 ? s[0][0] : addDays(last, -d);
  const idx = s.findIndex(([dt]) => dt >= start);
  const from = idx < 0 ? 0 : idx;
  return { recs: s.slice(from).map(([dt, v]) => ({ kst_date: dt, v, backfilled: true })), prevFirst: from > 0 ? s[from - 1][1] : undefined };
}
const extraOpen = new Set(); // 차트를 펼쳐 둔 통화 (화면을 다시 그려도 유지)
let extraFetchedAt = null;   // 추가 통화를 마지막으로 받은 시각
// 복사용 한 줄: 출처와 시각이 함께 들어간다
function extraLine(code) {
  const s = extraData[code];
  if (!s || !s.length) return '';
  const latest = s[s.length - 1];
  return `${code} ${fmt(latest[1])}원 (${extraFetchedAt ? kstStamp(extraFetchedAt) + ' 조회, ' : ''}기준일 ${latest[0]}, 한국은행 ECOS 매매기준율)`;
}
function drawExtraChart(c) {
  const s = extraData[c];
  if (!s || !s.length || !$(`chart-x-${c}`)) return;
  const w = extraWindow(s);
  drawChart(`chart-x-${c}`, 'v', `${c} / KRW (원)`, { recs: w.recs, unit: '원', prevFirst: w.prevFirst, noSelect: true });
}
// 추가 통화 카드: 달러·엔 카드와 같은 격자(#extra-cards 는 display: contents)에 같은 모양으로 놓인다
function renderExtra() {
  const codes = extraCodes();
  const avail = Object.keys(EXTRA_NAMES).filter((c) => !codes.includes(c));
  const sel = $('extra-select');
  sel.replaceChildren(...avail.map((c) => { const o = document.createElement('option'); o.value = c; o.textContent = `${c} · ${EXTRA_NAMES[c]}`; return o; }));
  const full = codes.length >= MAX_EXTRA || !avail.length;
  sel.disabled = full;
  $('extra-add').disabled = full;
  $('extra-msg').textContent = extraBusy ? '추가 통화를 불러오는 중...'
    : extraError || (codes.length >= MAX_EXTRA ? `통화는 최대 ${MAX_EXTRA}개까지 추가할 수 있습니다.` : codes.length ? '' : '골라서 추가하면 달러·엔 옆에 카드로 나타납니다. 환율 계산기에서도 쓸 수 있어요.');
  const grid = $('extra-cards');
  grid.replaceChildren();
  for (const c of codes) {
    const s = extraData[c];
    const card = document.createElement('article');
    card.className = 'card extra-card';
    const h = document.createElement('h2');
    h.append(`${c} / KRW `);
    const nm = document.createElement('span');
    nm.className = 'small';
    nm.textContent = CUR_NAME[c];
    h.appendChild(nm);
    card.appendChild(h);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'extra-remove';
    rm.dataset.cur = c;
    const rmx = document.createElement('span');
    rmx.textContent = '✕';
    rmx.setAttribute('aria-hidden', 'true');
    rm.append(rmx, ' 제거');
    rm.setAttribute('aria-label', `${CUR_NAME[c]} 제거`);
    if (!s || !s.length) {
      const p = document.createElement('p');
      p.className = 'small';
      p.textContent = extraBusy ? '불러오는 중...' : '표시할 데이터가 없습니다.';
      actions.appendChild(rm);
      card.append(p, actions);
      grid.appendChild(card);
      continue;
    }
    const latest = s[s.length - 1], prev = s[s.length - 2];
    const val = document.createElement('div');
    val.className = 'value';
    val.append(fmt(latest[1]));
    const won = document.createElement('span');
    won.className = 'won';
    won.textContent = ' 원';
    val.appendChild(won);
    const unit = document.createElement('div');
    unit.className = 'unit';
    unit.textContent = `1 ${c} 당 원화 · 기준일 ${latest[0]}`;
    const diff = document.createElement('div');
    diff.className = 'diff';
    diff.appendChild(changeChip(prev ? '전일 대비' : '', prev ? { delta: latest[1] - prev[1], pct: ((latest[1] - prev[1]) / prev[1]) * 100 } : null));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'outline sm extra-copy';
    copy.dataset.cur = c;
    copy.title = '출처와 시각이 포함된 한 줄로 복사';
    copy.textContent = '📋 복사';
    actions.appendChild(copy);
    if (navigator.share) { // 달러·엔 카드와 같은 조건(공유 기능을 지원하는 브라우저)에서만 표시
      const sh = document.createElement('button');
      sh.type = 'button';
      sh.className = 'outline sm extra-share';
      sh.dataset.cur = c;
      sh.textContent = '공유';
      actions.appendChild(sh);
    }
    actions.appendChild(rm);

    // 차트는 접어 두어 달러·엔 카드와 높이를 맞춘다 (펼친 상태는 기억)
    const det = document.createElement('details');
    det.className = 'extra-chart-wrap';
    if (extraOpen.has(c)) det.open = true;
    const sum = document.createElement('summary');
    const lo = document.createElement('span');
    lo.className = 'lbl-open';
    lo.textContent = '📈 차트 보기';
    const lc = document.createElement('span');
    lc.className = 'lbl-close';
    lc.textContent = '차트 접기';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▼';
    chev.setAttribute('aria-hidden', 'true');
    sum.append(lo, lc, chev);
    const chart = document.createElement('div');
    chart.className = 'chart';
    chart.id = `chart-x-${c}`;
    det.append(sum, chart);
    det.addEventListener('toggle', () => {
      if (det.open) { extraOpen.add(c); drawExtraChart(c); } else extraOpen.delete(c);
    });
    card.append(val, unit, diff, actions, det);
    grid.appendChild(card);
  }
  for (const c of codes) if (extraOpen.has(c)) drawExtraChart(c); // 펼쳐 둔 차트는 카드가 붙은 뒤에 그린다
}
$('extra-add').addEventListener('click', () => {
  const c = $('extra-select').value;
  if (!c || extraCodes().includes(c) || extraCodes().length >= MAX_EXTRA) return;
  state.extra_currencies = [...extraCodes(), c];
  save();
  loadExtra(true);
});
$('extra-cards').addEventListener('click', async (ev) => {
  const cp = ev.target.closest('.extra-copy');
  if (cp) {
    const t = extraLine(cp.dataset.cur);
    flash(cp, t && (await copyText(t)) ? '복사됨 ✔' : '복사 실패');
    return;
  }
  const sh = ev.target.closest('.extra-share');
  if (sh) {
    const t = extraLine(sh.dataset.cur);
    if (!t) return;
    try { await navigator.share({ title: '환율', text: t }); } catch (_) { /* 사용자가 취소 */ }
    return;
  }
  const b = ev.target.closest('.extra-remove');
  if (!b) return;
  const c = b.dataset.cur;
  extraOpen.delete(c);
  state.extra_currencies = extraCodes().filter((x) => x !== c);
  delete extraData[c];
  save();
  renderExtra();
  renderCalc();
});

// ---------- 다크 모드 ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const b = $('theme-toggle');
  const label = t === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환';
  b.textContent = t === 'dark' ? '☀️' : '🌙';
  b.setAttribute('aria-label', label);
  b.title = label;
}
applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
$('theme-toggle').addEventListener('click', () => {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('t04_theme', t); } catch (_) { /* 저장 실패는 무시 */ }
  applyTheme(t);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { // 직접 고른 적이 없으면 시스템 설정을 따른다
  let saved = null; try { saved = localStorage.getItem('t04_theme'); } catch (_) { /* 무시 */ }
  if (!saved) applyTheme(e.matches ? 'dark' : 'light');
});

// ---------- 오프라인 안내 + 연결되면 자동 재조회 ----------
function updateNet() { $('net-banner').hidden = navigator.onLine; }
window.addEventListener('offline', updateNet);
window.addEventListener('online', () => { updateNet(); autoFetch(); loadExtra(true); });
updateNet();

// ---------- 일별 기록 내려받기 (개인정보 없음: 날짜, 환율 값, 구분만 포함) ----------
function download(name, mime, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const exportRows = () => tableRecords().map((h) => ({
  kst_date: h.kst_date, usd_krw: h.usd_krw, jpy100_krw: h.jpy100_krw,
  type: h.synthetic ? 'synthetic' : h.manual ? 'manual' : h.backfilled ? 'backfill' : 'real', source_date: h.source_date || '', fetched_at: h.fetched_at || '',
  source: h.manual ? h.source : '', note: h.note || '',
}));
$('export-json').addEventListener('click', () => {
  download(`exchange_rate_history_${exportTag()}.json`, 'application/json', JSON.stringify({
    exported_at: new Date().toISOString(), timezone: TZ, source: SOURCE_NAME,
    units: { usd_krw: 'KRW per 1 USD', jpy100_krw: 'KRW per 100 JPY' }, range: tableScope() === 'all' ? 'all' : rangeLabel(), records: exportRows(),
  }, null, 2));
});
$('export-csv').addEventListener('click', () => {
  const rows = exportRows();
  const head = Object.keys(rows[0] || { kst_date: 0, usd_krw: 0, jpy100_krw: 0, type: 0, source_date: 0, fetched_at: 0, source: 0, note: 0 });
  const cell = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v); // 쉼표/따옴표 포함 값 이스케이프
  const csv = [head.join(','), ...rows.map((r) => head.map((k) => cell(r[k])).join(','))].join('\r\n') + '\r\n';
  download(`exchange_rate_history_${exportTag()}.csv`, 'text/csv', '﻿' + csv); // BOM: 엑셀에서 한글 깨짐 방지
});

// ---------- 초기화 ----------
$('refresh-btn').addEventListener('click', onRealFetch);
$('fail-btn').addEventListener('click', onSyntheticFailure);
$('retry-btn').addEventListener('click', onRetry);
$('clean-btn').addEventListener('click', () => {
  const n = state.history.filter((h) => h.synthetic).length;
  if (!n && !(state.last_valid && state.last_valid.synthetic)) { alert('삭제할 합성 기록이 없습니다.'); return; }
  if (!confirm(`합성(복구 asset) 기록 ${n}건을 삭제합니다.\n실제 기록은 유지됩니다. 계속할까요?`)) return;
  state.history = state.history.filter((h) => !h.synthetic);
  if (!state.last_valid || state.last_valid.synthetic) {
    const r = state.history[state.history.length - 1];
    state.last_valid = r ? {
      usd_krw: r.usd_krw, jpy100_krw: r.jpy100_krw, source: r.manual ? r.source : SOURCE_NAME,
      source_date: r.source_date || r.kst_date, fetched_at: r.fetched_at || null,
      kst_date: r.kst_date, synthetic: false, manual: !!r.manual, raw: r.raw || null,
    } : null;
  }
  if (state.failure_synthetic !== false) { // 합성 실패 상태만 정리 (실제 실패는 그대로 둠)
    Object.assign(state, { status: 'fresh', error_code: 'none', error_msg: '', error_guide: '', failure_synthetic: null });
  }
  state.recovery_note = ''; // 지워진 합성 기록에 대한 복구 요약은 더 이상 유효하지 않음
  save(); render();
});
$('chat-form').addEventListener('submit', onChat);
$('reset-btn').addEventListener('click', () => {
  // 되돌릴 수 없는 동작: 확인 문구를 직접 입력해야 진행
  const real = state.history.filter((h) => !h.synthetic).length;
  const ans = prompt(`실제 기록 ${real}건을 포함한 모든 저장 데이터가 삭제되며 되돌릴 수 없습니다.\n실제 기록을 남기려면 취소하고 "합성 기록 제거"를 쓰세요.\n\n계속하려면 "초기화"를 입력하세요.`);
  if (ans === null || ans.trim() !== '초기화') return;
  localStorage.removeItem(STORAGE_KEY); state = load(); render();
});
// 수동 입력 기록(public/manual-records.json): 앱이 공개 원천에서 받은 값이 아니라 직접 제공된 값.
// 같은 날짜의 기존 기록(실제 조회 포함)이 있으면 덮어쓰지 않는다.
async function loadManualRecords() {
  try {
    const res = await fetch('manual-records.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    let changed = false;
    for (const r of data.records || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.kst_date) || !(r.usd_krw > 0) || !(r.jpy100_krw > 0)) continue;
      if (state.history.some((h) => h.kst_date === r.kst_date)) continue;
      upsertDaily({
        kst_date: r.kst_date, usd_krw: r.usd_krw, jpy100_krw: r.jpy100_krw, synthetic: false, manual: true,
        source: r.source || '수동 입력', note: r.note || '', source_date: r.kst_date, fetched_at: null,
      });
      changed = true;
    }
    if (changed) { save(); render(); }
  } catch (_) { /* 파일이 없거나 형식이 다르면 무시 */ }
}
// ---------- 과거 값 소급 조회 (서버 프록시 /api/rates → 한국은행 ECOS) ----------
// 한국은행 매매기준율을 제공 시작 시점부터 전부 가져와 날짜별 기록으로 합친다.
// 서버리스 함수의 실행 시간 제한을 피하려고 5년 단위로 나눠 최근 구간부터 순서대로 요청한다.
// 앱이 직접 조회한 실제 기록은 덮어쓰지 않고, 수동 입력/합성/기존 소급 기록은 한국은행 값으로 교체한다.
// 처음 한 번 전체를 가져오고, 이후에는 열 때 하루 한 번 최근 30일만 보충한다.
const BACKFILL_START = '1977-01-01'; // 원/달러는 1964년부터지만 원/100엔이 1977-04-01부터라 두 통화가 모두 있는 날부터 기록된다
const BACKFILL_VERSION = 3;
const CHUNK_YEARS = 5;
const AUTO_TOPUP_MS = 24 * 60 * 60 * 1000;
const BACKFILL_TIMEOUT_MS = 30000;
let backfillBusy = false;
const r4 = (v) => Math.round(v * 1e4) / 1e4; // 저장 용량을 줄이기 위해 소수 4자리로 저장

function yearChunks(startDate, endDate) {
  const out = [];
  let s = startDate;
  while (s <= endDate) {
    const dt = new Date(s + 'T00:00:00Z');
    dt.setUTCFullYear(dt.getUTCFullYear() + CHUNK_YEARS);
    dt.setUTCDate(dt.getUTCDate() - 1);
    let e = dt.toISOString().slice(0, 10);
    if (e > endDate) e = endDate;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}

async function backfill(auto, full = true) {
  if (backfillBusy) return;
  backfillBusy = true;
  $('backfill-btn').disabled = true;
  const msg = $('backfill-msg');
  const first = state.backfill_v !== BACKFILL_VERSION;
  const everything = full || first;
  const loud = !auto || first; // 처음/수동 실행일 때만 진행 상황을 보여 준다
  try {
    const end = kstDate();
    const chunks = (everything ? yearChunks(BACKFILL_START, end) : [[addDays(end, -30), end]]).reverse(); // 최근 구간 우선
    const rows = [];
    let failure = null;
    let limited = false; // 시험용(sample) 인증키: 구간마다 일부만 오므로 '전체를 받았다'고 기록하지 않는다
    for (let i = 0; i < chunks.length; i++) {
      if (loud) msg.textContent = `과거 값을 가져오는 중... (${i + 1}/${chunks.length})`;
      try {
        const json = await fetchRates(chunks[i][0], chunks[i][1], BACKFILL_TIMEOUT_MS);
        if (json.limited) limited = true;
        rows.push(...json.rows);
      } catch (e) { failure = e; break; } // 한 구간이라도 실패하면 거기서 멈추고, 받은 구간까지만 반영한다
    }

    // 수천 건이므로 한 번에 합쳐서 한 번만 정렬한다
    const byKey = new Map(state.history.map((h) => [h.kst_date, h]));
    let changed = 0, minD = '', maxD = '';
    for (const r of rows) {
      const d = r && r.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || ![r.usd_krw, r.jpy100_krw].every((v) => typeof v === 'number' && isFinite(v) && v > 0)) continue;
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
      const old = byKey.get(d);
      if (old && !old.manual && !old.synthetic && !old.backfilled) continue; // 앱이 직접 조회한 실제 기록은 유지
      const rec = { kst_date: d, usd_krw: r4(r.usd_krw), jpy100_krw: r4(r.jpy100_krw), backfilled: true };
      if (old && old.backfilled && old.usd_krw === rec.usd_krw && old.jpy100_krw === rec.jpy100_krw) continue; // 변화 없음
      byKey.set(d, rec);
      changed++;
    }
    if (rows.length) {
      state.history = [...byKey.values()].sort((a, b) => (a.kst_date < b.kst_date ? -1 : a.kst_date > b.kst_date ? 1 : 0));
    }
    if (!failure && !limited) {
      state.backfill_at = new Date().toISOString();
      state.backfill_v = BACKFILL_VERSION;
    }
    save(); render();

    if (limited) {
      msg.textContent = `시험용(sample) 인증키라 구간마다 일부만 가져왔습니다 (${changed.toLocaleString()}건). 정식 인증키를 설정한 뒤 "전체 과거 값 다시 가져오기"를 누르세요.`;
    } else if (failure) {
      const why = (ERRORS[failure.kind] || ERRORS.schema).msg;
      msg.textContent = rows.length
        ? `일부만 가져왔습니다 (${changed.toLocaleString()}건 반영). ${why} 버튼을 다시 눌러 이어서 시도하세요.`
        : (auto && !first ? '' : `과거 값을 가져오지 못했습니다. ${why}`);
    } else {
      msg.textContent = changed
        ? `${changed.toLocaleString()}건 추가/갱신됨 (${minD} ~ ${maxD}, 한국은행 영업일 기준)`
        : '이미 최신입니다. 추가할 새 기록이 없습니다.';
      if (auto && !first && !changed) msg.textContent = '';
    }
  } catch (_) {
    msg.textContent = auto && !first ? '' : '과거 값을 가져오지 못했습니다. 잠시 후 다시 시도하세요.';
  } finally {
    backfillBusy = false;
    $('backfill-btn').disabled = false;
  }
}
$('backfill-btn').addEventListener('click', () => backfill(false, true));
$('range-select').addEventListener('change', (e) => {
  state.range_days = Number(e.target.value);
  chartSel = null;
  tablePage = 1;
  save(); render();
  loadExtra(); // 추가 통화 차트도 새 기간으로 다시 받는다
});
// ----- 표 페이지 이동 / 범위 / 날짜로 이동 -----
function goPage(p) {
  tablePage = p; // 범위를 벗어난 값은 render() 가 첫/마지막 페이지로 맞춘다
  render();
  const box = $('history-body').closest('.table-scroll');
  if (box) box.scrollTop = 0;
}
$('pg-first').addEventListener('click', () => goPage(1));
$('pg-prev').addEventListener('click', () => goPage(tablePage - 1));
$('pg-next').addEventListener('click', () => goPage(tablePage + 1));
$('pg-last').addEventListener('click', () => goPage(Number.MAX_SAFE_INTEGER));
$('pg-input').addEventListener('change', () => { const v = parseInt($('pg-input').value, 10); goPage(Number.isFinite(v) ? v : 1); });
$('table-scope').addEventListener('change', (e) => { state.table_scope = e.target.value; tablePage = 1; save(); render(); });
$('table-size').addEventListener('change', (e) => { state.table_size = Number(e.target.value); tablePage = 1; save(); render(); });
function jumpToDate() {
  const d = $('table-jump').value;
  const msg = $('table-jump-msg');
  msg.textContent = '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  const win = tableRecords();
  if (!win.length) return;
  let k = -1; // 입력한 날짜 이하 중 가장 최근 기록(그 날 또는 직전 영업일)
  for (let i = win.length - 1; i >= 0; i--) if (win[i].kst_date <= d) { k = i; break; }
  if (k < 0) { k = 0; msg.textContent = '그 날짜 이전 기록은 없어서 가장 오래된 기록으로 이동했습니다.'; }
  else if (win[k].kst_date !== d) msg.textContent = `${d} 기록이 없어(주말·공휴일) 직전 영업일 ${win[k].kst_date}로 이동했습니다.`;
  tablePage = Math.floor((win.length - 1 - k) / tableSize()) + 1;
  tableHighlight = win[k].kst_date;
  render();
  // 강조한 행을 표 상자의 가운데로 스크롤한다 (scrollIntoView 는 고정된 머리글 뒤로 행을 가릴 수 있다)
  const hl = document.querySelector('#history-body .row-hl');
  const box = $('history-body').closest('.table-scroll');
  if (hl && box) box.scrollTop = Math.max(0, hl.offsetTop - box.clientHeight / 2 + hl.offsetHeight / 2);
  setTimeout(() => { tableHighlight = null; document.querySelectorAll('#history-body .row-hl').forEach((r) => r.classList.remove('row-hl')); }, 4000);
}
$('table-jump-btn').addEventListener('click', jumpToDate);
$('table-jump').addEventListener('keydown', (e) => { if (e.key === 'Enter') jumpToDate(); });

document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
  $('chat-input').value = b.textContent;
  $('chat-form').requestSubmit();
}));
render();
loadExtra();
loadManualRecords();
// 처음 열 때 전체 과거 값을 한 번 가져오고, 이후에는 하루 한 번 최근 30일만 보충한다
if (state.backfill_v !== BACKFILL_VERSION) backfill(true, true);
else if (!state.backfill_at || Date.now() - Date.parse(state.backfill_at) > AUTO_TOPUP_MS) backfill(true, false);
fetchAsset().catch(() => { $('asset-hash').textContent = '(불러오기 실패)'; $('asset-verify').textContent = '검증 불가'; });
$('copy-hash').addEventListener('click', async () => {
  const text = $('asset-hash').textContent;
  try { await navigator.clipboard.writeText(text); }
  catch (_) { // clipboard API를 못 쓰는 환경 대비
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const b = $('copy-hash');
  b.textContent = '복사됨 ✔';
  setTimeout(() => { b.textContent = '복사'; }, 1500);
});
setInterval(renderAge, 30 * 1000); // "마지막 정상값 n분 전" 표시를 주기적으로 갱신

// 자동 갱신: 열 때 1회 + 30분마다 + 탭이 다시 보일 때 오래됐으면 (stale 상태에서는 autoFetch가 건너뜀)
autoFetch();
setInterval(autoFetch, AUTO_MS);
document.addEventListener('visibilitychange', () => {
  const t = state.last_success_at ? Date.parse(state.last_success_at) : 0;
  if (!document.hidden && Date.now() - t > AUTO_MS) autoFetch();
});

// ---------- 챗봇 패널이 스크롤을 부드럽게 따라오는 애니메이션 ----------
(function floatingChat() {
  const layout = document.querySelector('.layout');
  const col = document.querySelector('.chat-col');
  const wide = window.matchMedia('(min-width: 961px)');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const TOP_GAP = 16, EASE = 0.14;
  let current = 0, raf = 0;

  const enabled = () => wide.matches && !reduce.matches;
  const target = () => {
    const layoutTop = layout.getBoundingClientRect().top + window.scrollY;
    const maxTravel = Math.max(0, layout.offsetHeight - col.offsetHeight);
    return Math.min(maxTravel, Math.max(0, window.scrollY + TOP_GAP - layoutTop));
  };
  function tick() {
    raf = 0;
    const t = target();
    current += (t - current) * EASE; // 목표와의 거리의 일부씩 이동 → 감속하며 도착
    if (Math.abs(t - current) < 0.4) current = t;
    col.style.transform = `translateY(${current.toFixed(2)}px)`;
    if (current !== t) raf = requestAnimationFrame(tick);
  }
  const kick = () => { if (enabled() && !raf) raf = requestAnimationFrame(tick); };
  function sync() {
    layout.classList.toggle('float-anim', enabled());
    if (!enabled()) { col.style.transform = ''; current = 0; }
    else kick();
  }
  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', sync);
  wide.addEventListener('change', sync);
  reduce.addEventListener('change', sync);
  sync();
})();
