import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMichikusaMetrics, calculateMichikusaScore } from './analysis.ts';

test('スタンプ0個は0', () => {
  assert.equal(calculateMichikusaScore([]), 0);
});

test('スタンプ1個は広がりと多方向性が0', () => {
  const metrics = calculateMichikusaMetrics([{ x: 10, y: 20 }]);
  assert.equal(metrics.spreadNormalized, 0);
  assert.equal(metrics.directionality, 0);
  assert.ok(metrics.score >= 0);
});

test('一直線上では多方向性が低い', () => {
  const metrics = calculateMichikusaMetrics([{ x: -100, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.ok(metrics.directionality < 0.001);
});

test('十字状では多方向性が高い', () => {
  const metrics = calculateMichikusaMetrics([{ x: -100, y: 0 }, { x: 100, y: 0 }, { x: 0, y: -100 }, { x: 0, y: 100 }]);
  assert.ok(metrics.directionality > 0.99);
});

test('同じ座標でもNaNにならない', () => {
  const score = calculateMichikusaScore(Array.from({ length: 10 }, () => ({ x: 50, y: 50 })));
  assert.ok(Number.isFinite(score));
});

test('結果は必ず0から45に収まる', () => {
  const points = Array.from({ length: 1000 }, (_, index) => ({ x: Math.cos(index) * 1_000_000, y: Math.sin(index) * 1_000_000 }));
  const score = calculateMichikusaScore(points);
  assert.ok(score >= 0 && score <= 45);
});
