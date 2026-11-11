'use strict';
// 이동평균 · 골든/데드 크로스 계산 (브라우저와 Node 검사에서 공용)

// values: 숫자 또는 null(결측) 배열, window: 1 이상의 정수.
// 창이 다 차지 않았거나 창 안에 결측이 있으면 null. 결과는 소수 둘째 자리까지 반올림. 입력은 바꾸지 않는다.
function movingAverage(values, window) {
  if (!Number.isInteger(window) || window < 1) throw new RangeError('window 는 1 이상의 정수여야 합니다');
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - window + 1; j <= i; j++) {
      const v = values[j];
      if (typeof v !== 'number' || !isFinite(v)) { ok = false; break; }
      sum += v;
    }
    if (ok) out[i] = Math.round((sum / window) * 100) / 100;
  }
  return out;
}

// 단기-장기 차이의 부호가 (0 을 건너뛰고) 바뀐 칸을 찾는다. 0 에 맞닿기만 하고 되돌아가면 교차가 아니다.
function findCrosses(shortMA, longMA) {
  const res = [];
  let prev = 0; // 직전의 0 이 아닌 부호
  const n = Math.min(shortMA.length, longMA.length);
  for (let i = 0; i < n; i++) {
    const a = shortMA[i], b = longMA[i];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const s = Math.sign(a - b);
    if (s === 0) continue;
    if (prev !== 0 && s !== prev) res.push({ index: i, type: s > 0 ? 'golden' : 'dead' });
    prev = s;
  }
  return res;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { movingAverage, findCrosses };
if (typeof window !== 'undefined') window.MA = { movingAverage, findCrosses };
