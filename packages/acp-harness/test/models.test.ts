import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { modelOption, pickModel } from '../src/models.js';

/**
 * Reading what an agent offers, in the shapes agents actually send.
 *
 * The spec says `configId` and a flat option list; shipped adapters have
 * said `id` and grouped lists. A reader that handles only the spec would
 * report "no model choice" for the most common runtime, which is the kind
 * of wrong answer that looks like a fact.
 */

const flat = [
  {
    configId: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'sonnet',
    options: [
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
    ],
  },
  { configId: 'mode', category: 'mode', type: 'select', options: [{ value: 'ask', name: 'Ask' }] },
];

describe('what an agent offers', () => {
  it('finds the model option among others and keeps the default', () => {
    assert.deepEqual(modelOption(flat), {
      configId: 'model',
      current: 'sonnet',
      choices: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
    });
  });

  it('accepts `id` where the spec says `configId`, and grouped options', () => {
    const shipped = [
      {
        id: 'model',
        category: 'model',
        type: 'select',
        options: [{ name: 'Anthropic', options: [{ value: 'opus', name: 'Opus' }] }],
      },
    ];
    assert.deepEqual(modelOption(shipped), {
      configId: 'model',
      current: null,
      choices: [{ id: 'opus', label: 'Opus' }],
    });
  });

  it('says null when there is no model option, or nothing to choose from', () => {
    assert.equal(modelOption(undefined), null);
    assert.equal(modelOption([flat[1]]), null);
    assert.equal(modelOption([{ configId: 'model', category: 'model', options: [] }]), null);
  });

  it('does not report a default the list does not contain', () => {
    assert.equal(modelOption([{ ...flat[0], currentValue: 'haiku' }])?.current, null);
  });
});

describe('choosing one', () => {
  it('names the option to set when the model is offered', () => {
    assert.deepEqual(pickModel(flat, 'opus'), { configId: 'model', value: 'opus' });
  });

  it('refuses rather than falling back when it is not', () => {
    assert.equal(pickModel(flat, 'haiku'), null, 'a refusal the runner must act on');
    assert.equal(pickModel(undefined, 'opus'), null);
  });
});
