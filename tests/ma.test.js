// 과제 5 고정 검사 10개 (AI A/B 작업 시작 전에 확정, 이후 수정 금지)
// 실행: node --test tests/
// 대상: public/ma.js 가 내보내는 movingAverage(values, window), findCrosses(shortMA, longMA)
const test = require('node:test');
const assert = require('node:assert/strict');
const { movingAverage, findCrosses } = require('../public/ma.js');

test('F01 기본: 3일 이동평균', () => {
  assert.deepEqual(movingAverage([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('F02 경계: window=1 이면 값 그대로', () => {
  assert.deepEqual(movingAverage([5, 7], 1), [5, 7]);
});

test('F03 경계: window 가 데이터 길이와 같으면 마지막 칸만 값', () => {
  assert.deepEqual(movingAverage([2, 4, 6], 3), [null, null, 4]);
});

test('F04 경계: window 가 데이터 길이보다 크면 전부 null', () => {
  assert.deepEqual(movingAverage([1, 2], 5), [null, null]);
});

test('F05 경계: 빈 배열은 빈 배열', () => {
  assert.deepEqual(movingAverage([], 3), []);
});

test('F06 결측: 창 안에 null 이 있으면 그 칸은 null', () => {
  assert.deepEqual(movingAverage([1, null, 3, 4], 2), [null, null, null, 3.5]);
});

test('F07 반올림: 소수 둘째 자리까지', () => {
  assert.deepEqual(movingAverage([1400.1, 1400.2, 1400.4], 3), [null, null, 1400.23]);
});

test('F08 오류: window 가 0 또는 정수가 아니면 RangeError', () => {
  assert.throws(() => movingAverage([1, 2, 3], 0), RangeError);
  assert.throws(() => movingAverage([1, 2, 3], 2.5), RangeError);
});

test('F09 안전: 입력 배열을 바꾸지 않는다', () => {
  const input = [1, 2, 3, 4];
  movingAverage(input, 2);
  assert.deepEqual(input, [1, 2, 3, 4]);
});

test('F10 교차: 골든/데드 크로스 위치 (맞닿기만 하면 교차 아님)', () => {
  // 차이(단기-장기) = [-1, 0, 1, -0.5] → 2번째 칸에서 골든, 3번째 칸에서 데드
  assert.deepEqual(findCrosses([1, 2, 4, 3], [2, 2, 3, 3.5]), [
    { index: 2, type: 'golden' },
    { index: 3, type: 'dead' },
  ]);
});
