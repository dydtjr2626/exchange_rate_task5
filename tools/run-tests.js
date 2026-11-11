// 검사 10개를 실행하고 결과를 test-runs.json 에 한 줄 추가합니다.
// 사용법: node tools/run-tests.js A   (또는 B)
// 보고서의 "오류 회차"(검사가 하나라도 FAIL 이었던 실행 횟수)와 "검사 통과 수"가 여기서 자동 계산됩니다.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const label = process.argv[2];
if (!['A', 'B'].includes(label)) {
  console.error('사용법: node tools/run-tests.js A  또는  node tools/run-tests.js B');
  process.exit(2);
}

const root = path.join(__dirname, '..');
const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/'], { cwd: root, encoding: 'utf8' });
const out = (r.stdout || '') + (r.stderr || '');
const num = (k) => {
  const m = out.match(new RegExp('^# ' + k + ' (\\d+)', 'm'));
  return m ? Number(m[1]) : 0;
};

const rec = { label, at: new Date().toISOString(), pass: num('pass'), fail: num('fail'), total: num('tests') };
// 파일을 불러오지 못하는 등 검사 자체가 돌지 못한 경우도 실패로 센다
if (r.status !== 0 && rec.fail === 0) rec.fail = Math.max(1, 10 - rec.pass);

const file = path.join(root, 'test-runs.json');
let runs = [];
try { runs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { runs = []; }
runs.push(rec);
fs.writeFileSync(file, JSON.stringify(runs, null, 2) + '\n');

console.log(out.split('\n').filter((l) => /^(not ok|ok|# (tests|pass|fail))/.test(l)).join('\n'));
console.log(`\n[기록됨] ${label} 실행 ${runs.filter((x) => x.label === label).length}회째: 통과 ${rec.pass} / 실패 ${rec.fail}`);
process.exit(0);
