// 비교 보고서(report/index.html)를 자동으로 만듭니다.  사용법: node tools/make-report.js
// 읽는 것: git 커밋 기록, test-runs.json(검사 실행 기록), records.json(직접 적은 값), HANDOFF.md
// 커밋 메시지 규칙: "A 시작", "A 중단", "A 인수인계", "B 시작", "B 완료" 로 시작해야 단계가 인식됩니다.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 실패: ' + (r.stderr || '').trim());
  return r.stdout;
};
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return fallback; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kst = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '-');

// 1) 커밋에서 단계 찾기 (가장 최근에 붙인 같은 이름의 커밋)
const commits = git('log', '--format=%H|%cI|%s').trim().split('\n').filter(Boolean).map((l) => {
  const [hash, at, ...rest] = l.split('|');
  return { hash, at, subject: rest.join('|') };
});
const STAGES = ['A 시작', 'A 중단', 'A 인수인계', 'B 시작', 'B 완료'];
const stage = {};
for (const s of STAGES) stage[s] = commits.find((c) => c.subject.startsWith(s)) || null;

// 2) 검사 실행 기록에서 오류 회차·통과 수
const runs = readJson('test-runs.json', []);
const testInfo = (label) => {
  const rs = runs.filter((r) => r.label === label);
  const last = rs[rs.length - 1];
  return { runs: rs.length, errorRuns: rs.filter((r) => r.fail > 0).length, passed: last ? last.pass : null, total: last ? last.total || 10 : null };
};

// 3) 시작·종료 커밋 사이 소스 줄 수 (검사·도구·보고서·기록 파일·lockfile 제외)
const diffLines = (from, to) => {
  if (!from || !to) return null;
  const ex = ['tests', 'tools', 'report', 'TASK5.md', 'HANDOFF.md', 'records.json', 'test-runs.json', '*lock*'].map((p) => ':(exclude)' + p);
  const out = git('diff', '--numstat', from.hash, to.hash, '--', '.', ...ex).trim();
  let add = 0, del = 0;
  for (const l of out.split('\n').filter(Boolean)) {
    const [a, d] = l.split('\t');
    if (a !== '-') { add += Number(a); del += Number(d); }
  }
  return { add, del };
};

const rec = readJson('records.json', {});
const minutesBetween = (a, b) => (a && b ? Math.round((new Date(b.at) - new Date(a.at)) / 60000) : null);
const side = (label, startKey, endKey, endFallbackKey) => {
  const start = stage[startKey];
  const end = stage[endKey] || (endFallbackKey && stage[endFallbackKey]) || null;
  const m = rec[label] || {};
  const t = testInfo(label);
  return {
    label, start, end,
    minutes: m.minutes ?? minutesBetween(start, end),
    minutesFrom: m.minutes != null ? '직접 기록' : '커밋 시각 차이',
    requests: m.requests ?? null,
    toolCalls: m.tool_calls ?? null,
    errorRuns: t.runs ? t.errorRuns : null,
    passed: t.passed, total: t.total, testRuns: t.runs,
    lines: diffLines(start, end),
  };
};
const A = side('A', 'A 시작', 'A 중단', 'A 인수인계');
const B = side('B', 'B 시작', 'B 완료');

const handoff = (() => { try { return fs.readFileSync(path.join(root, 'HANDOFF.md'), 'utf8'); } catch { return ''; } })();
const lim = rec.limits || {};
const dash = (v, unit = '') => (v == null || v === '' ? '<span class="warn">미기록</span>' : esc(v) + unit);
const lines = (s) => (s.lines ? `+${s.lines.add} / -${s.lines.del}` : null);
const short = (c) => (c ? c.hash.slice(0, 7) : null);
const verify = (rec.verify || []).map((v) => v.trim());
const jd = rec.judgment || {};

const row = (name, a, b, note = '') => `<tr><th>${name}</th><td>${a}</td><td>${b}</td><td class="note">${note}</td></tr>`;
const body = `
<h1>과제 5 — AI 세션 간 인수인계 비교 보고서</h1>
<p class="sub">기능: 환율 그래프의 5일·20일 이동평균선과 골든/데드 크로스 표시 · 생성: ${esc(kst(new Date().toISOString()))}</p>

<h2>짧은 확인 방법</h2>
<ol>
  <li><b>어디로 가나요?</b> ${esc(verify[0])}</li>
  <li><b>3단계 이내에 무엇을 하나요?</b> ${esc(verify[1])}</li>
  <li><b>무엇이 보이면 통과인가요?</b> ${esc(verify[2])}</li>
  <li><b>안 될 때 무엇이 보이나요?</b> ${esc(verify[3])}</li>
</ol>

<h2>A/B 블라인드 비교표</h2>
<table>
  <tr><th></th><th>AI A</th><th>AI B</th><th>비고</th></tr>
  ${row('작업 시간(분)', dash(A.minutes), dash(B.minutes), `공통 상한 ${esc(lim.minutes ?? '-')}분 · A: ${A.minutesFrom} / B: ${B.minutesFrom}`)}
  ${row('요청 수', dash(A.requests), dash(B.requests), `공통 상한 ${esc(lim.requests ?? '-')}회`)}
  ${row('호출 수', dash(A.toolCalls), dash(B.toolCalls), '')}
  ${row('오류 회차', dash(A.errorRuns), dash(B.errorRuns), '고정 검사 10개 중 하나 이상 FAIL 이었던 실행 횟수')}
  ${row('검사 통과 수', A.passed == null ? dash(null) : `${A.passed} / ${A.total}`, B.passed == null ? dash(null) : `${B.passed} / ${B.total}`, '각 AI 마지막 실행 기준')}
  ${row('소스 변경(줄)', dash(lines(A)), dash(lines(B)), '검사·도구·보고서·기록 파일·lockfile 제외')}
</table>

<h2>작업 순서와 고정 소스 버전</h2>
<table>
  <tr><th>단계</th><th>시각(KST)</th><th>커밋 ID</th></tr>
  ${STAGES.map((s) => `<tr><th>${s}</th><td>${esc(kst(stage[s] && stage[s].at))}</td><td>${dash(short(stage[s]))}</td></tr>`).join('')}
</table>
<p>시작 → A 인수인계 → B 시작 → B 완료 순서로 기록했습니다.</p>

<h2>인수인계 누락</h2>
<p>${esc(rec.handoff_missing) || '<span class="warn">미기록</span>'}</p>

<h2>인수인계 문서 (HANDOFF.md)</h2>
<pre>${esc(handoff) || '(없음)'}</pre>

<h2>AI와 나의 판단</h2>
<ul>
  <li><b>AI에게 맡긴 일:</b> ${esc(jd.delegated)}</li>
  <li><b>직접 판단한 일:</b> ${esc(jd.decided_by_me)}</li>
  <li><b>AI 제안을 따르지 않은 일:</b> ${esc(jd.not_followed)}</li>
</ul>

<h2>다음 작업의 도구 선택 기준</h2>
<p>${esc(rec.tool_criterion) || '<span class="warn">미기록</span>'}</p>
${rec.repo_url ? `<p>소스 주소: <a href="${esc(rec.repo_url)}">${esc(rec.repo_url)}</a></p>` : ''}
`;

// 4) 제출 전 안전 점검: 서비스·모델 이름(블라인드), 비밀값, 이메일
const problems = [];
const checks = [
  [/claude|anthropic|gemini|google|openai|chatgpt|gpt-?\d|copilot|antigravity|cursor|llama|mistral/i, 'AI·서비스 이름이 남아 있어요(블라인드 위반)'],
  [/AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}|api[_-]?key\s*[:=]\s*\S+/i, '비밀값처럼 보이는 문자열이 있어요'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, '이메일 주소가 있어요(개인정보)'],
];
for (const [re, msg] of checks) {
  const m = body.replace(/<[^>]+>/g, ' ').match(re);
  if (m) problems.push(`${msg}: "${m[0]}"`);
}
if (problems.length) {
  console.error('[중단] 보고서를 만들지 않았어요. 아래를 고친 뒤 다시 실행하세요:\n- ' + problems.join('\n- '));
  process.exit(1);
}

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>과제 5 비교 보고서</title>
<style>
:root{--bg:#fff;--fg:#1d2630;--mut:#5b6773;--line:#d9e0e6;--warn:#b45309;--card:#f6f9fa}
@media (prefers-color-scheme:dark){:root{--bg:#12181d;--fg:#e6ebef;--mut:#9aa7b2;--line:#2b3640;--warn:#f59e0b;--card:#18212a}}
body{margin:0 auto;max-width:880px;padding:24px 16px 64px;background:var(--bg);color:var(--fg);font:15px/1.65 system-ui,'Noto Sans KR',sans-serif}
h1{font-size:22px}h2{font-size:17px;margin-top:32px;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{color:var(--mut)}table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--card)}
.note{color:var(--mut);font-size:13px}.warn{color:var(--warn);font-weight:600}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);padding:12px;border-radius:8px}
a{color:inherit}
</style></head><body>${body}</body></html>
`;
fs.mkdirSync(path.join(root, 'report'), { recursive: true });
fs.writeFileSync(path.join(root, 'report', 'index.html'), html);

const missing = [];
if (A.requests == null) missing.push('records.json: A.requests');
if (B.requests == null) missing.push('records.json: B.requests');
for (const s of STAGES) if (!stage[s]) missing.push(`커밋 "${s}"`);
if (!A.testRuns) missing.push('검사 실행 기록 A (node tools/run-tests.js A)');
if (!B.testRuns) missing.push('검사 실행 기록 B (node tools/run-tests.js B)');
if (!verify.every(Boolean)) missing.push('records.json: verify 4줄');
if (!jd.delegated || !jd.decided_by_me || !jd.not_followed) missing.push('records.json: judgment 3줄');
if (!rec.tool_criterion) missing.push('records.json: tool_criterion');
console.log('[완료] report/index.html 을 만들었어요.');
console.log(missing.length ? '아직 비어 있는 항목:\n- ' + missing.join('\n- ') : '비어 있는 항목이 없어요.');
