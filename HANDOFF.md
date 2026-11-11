# HANDOFF

기준 커밋: `88996ce8d949325024ac6aed99a62b06c9fecc52` (작성 시점 작업 트리는 깨끗함)

## 1. 목표
환율 정보판(USD·JPY 및 추가 통화)의 일별 추이 차트에 **5일·20일 이동평균선**을 겹쳐 그리고, 계산 함수 `public/ma.js`가 고정 검사 10개(`tests/ma.test.js`)를 통과하게 한다. 골든/데드 크로스(`findCrosses`)를 차트에 표시하는 것까지가 완료 조건이다.

## 2. 현재 상태
- `public/ma.js`: `movingAverage(values, window)`, `findCrosses(shortMA, longMA)` 구현. 브라우저(`window.MA`)와 Node(`module.exports`) 공용.
- `public/index.html`: `ma.js`를 `app.js`보다 먼저 불러옴. '최근 변화' 영역에 `#extra-charts` 추가.
- `public/app.js` `drawChart`: 이동평균선(5일 주황, 20일 보라) 겹쳐 그림 / 점 제거, 원본선 두께 1 / 큰 차트(720×320) / Y축 눈금 4개(범위 3등분) / Y 범위에 이동평균 포함 / 마우스를 올리면 5일·20일 평균을 툴팁과 선 위 점으로 표시.
- 추가 통화 차트는 카드 안 접기 버튼을 없애고 '최근 변화' 영역에 USD·JPY와 같은 크기로 표시.
- `public/style.css`: 이동평균 색, 툴팁, 선 두께 스타일 추가.

## 3. 실행 명령
```
node server.js                 # 로컬 서버, http://localhost:3000 (포트는 PORT 환경변수로 변경)
node --test tests/             # 검사 10개 직접 실행
node tools/run-tests.js A      # 검사 실행 + test-runs.json 에 결과 1줄 추가 (A 또는 B)
```
환율·챗봇 API 키는 프로젝트 밖(`~/.exchange_rate.env`) 또는 `.env.local`에서 읽는다. 키가 없으면 환율 조회와 챗봇이 실패 상태로 표시된다.

## 4. 통과한 검사
`node tools/run-tests.js A`를 4회 실행, 매번 **10/10 통과, 실패 0** (`test-runs.json` 기록). F01~F10 전부 통과: 3일 평균, window=1, window=길이, window>길이, 빈 배열, 결측(null), 소수 둘째 자리 반올림, 잘못된 window의 RangeError, 입력 불변, 골든/데드 크로스 위치.
이 검사는 `ma.js` 계산만 확인한다. 차트 화면은 검사 대상이 아니다.

## 5. 남은 문제
- 차트 변경은 문법 검사(`node --check public/app.js`)만 했고 **브라우저에서 눈으로 확인하지 않았다.**
- 눈금 4개는 범위를 3등분한 값이라 딱 떨어지는 숫자가 아닐 수 있다.
- 점을 없애면서 키보드 Tab으로 점 이동하는 기능과 수동 입력 값의 마름모 표시가 사라졌다(점선 구간으로만 구분).
- `findCrosses`는 만들어 두었지만 화면에는 연결하지 않았다.

## 6. 다음 작업
1. 서버를 켜고 브라우저에서 확인: 선이 차트 안에 들어오는지, 눈금 4개, 툴팁의 평균 표시, 다크 모드 색, 모바일 폭.
2. 추가 통화를 넣고 짧은 기간(7일)과 긴 기간(10년)에서 차트가 정상인지 확인.
3. 골든/데드 크로스를 차트에 표시(필수). 키보드 접근성 복원은 선택.
4. 변경 후 `node tools/run-tests.js B`로 10/10 유지 확인. (이어받은 작업자는 반드시 B로 기록)
## 7. 변경 금지 범위
다음 파일은 수정하지 않는다: `tests/` 전체, `tools/` 전체, `TASK5.md`, `records.json`.
`test-runs.json`은 직접 편집하지 않고 `tools/run-tests.js`가 추가하는 기록만 남긴다.
