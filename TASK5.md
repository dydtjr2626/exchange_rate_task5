# 과제 5 — 이동평균선 (고정 기록)

작업 시작 전에 확정한 내용입니다. 이후 수정하지 않습니다.

## 고르는 기능
과제 4(환율 정보판)에 **5일·20일 이동평균선과 골든/데드 크로스 표시**를 추가합니다.

## 고정 검사 10개
- 파일: `tests/ma.test.js` (F01 ~ F10)
- 실행: `node --test tests/`
- 대상: `public/ma.js` 의 `movingAverage(values, window)`, `findCrosses(shortMA, longMA)`
- 규칙: 검사 삭제, 조건 완화, 기대값 변경 금지

## AI A / AI B 공통 한도
| 항목 | 한도 (AI당) |
|---|---|
| 작업 시간 | 60분 |
| 요청·호출 수 | 20회 (사람이 AI에게 보낸 메시지 수) |

## 최초 요청 문장
"`public/ma.js`를 만들어 `tests/`의 검사 10개를 통과시키고, 그래프에 5일·20일 이동평균선을 겹쳐 그려줘. `tests/`, `tools/`, `TASK5.md`, `records.json`은 수정하지 마. 작업 중 검사는 `node tools/run-tests.js A`로 돌려줘."

(AI B에게는 같은 문장에서 `A`만 `B`로 바꿔 사용합니다.)

## 자동 보고서
- 검사 실행: `node tools/run-tests.js A` / `node tools/run-tests.js B` → `test-runs.json`에 기록
- 보고서 생성: `node tools/make-report.js` → `report/index.html`
- 커밋 메시지는 `A 시작`, `A 중단`, `A 인수인계`, `B 시작`, `B 완료`로 시작해야 단계가 인식됩니다.

## 작업 기록 (아래에 채움)
| 단계 | 시각 | 커밋 ID | 비고 |
|---|---|---|---|
| A 시작 | | | |
| A 종료·인수인계 | | | |
| B 시작 | | | |
| B 완료 | | | |
