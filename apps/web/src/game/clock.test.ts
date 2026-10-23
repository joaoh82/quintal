import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_PREDICTION_STEP_SECONDS, predictionStep } from './clock';

describe('predictionStep', () => {
  it('walks the real time a frame took, not a smoothed one', () => {
    assert.equal(predictionStep(16.7), 0.0167);
    assert.equal(predictionStep(250), 0.25);
  });

  it('bounds a frozen frame instead of walking through it', () => {
    assert.equal(predictionStep(5_000), MAX_PREDICTION_STEP_SECONDS);
  });

  it('treats a negative or missing delta as no time at all', () => {
    assert.equal(predictionStep(-5), 0);
    assert.equal(predictionStep(Number.NaN), 0);
  });
});
