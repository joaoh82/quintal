import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_CORE_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_BYTES,
  DEFAULT_AGENT_SCOPES,
  agentKeyHint,
  isValidMemorySlug,
  memoryLimitFor,
  normaliseAgentName,
  parseScopes,
} from './agent.js';

describe('parseScopes', () => {
  it('keeps known scopes', () => {
    assert.deepEqual(parseScopes(['chat', 'move']), ['chat', 'move']);
  });

  it('drops anything it does not recognise', () => {
    // A scope invented in the database must never widen what an agent can do.
    assert.deepEqual(parseScopes(['chat', 'sudo', 'delete-everything']), ['chat']);
  });

  it('grants nothing when every scope is unrecognised', () => {
    assert.deepEqual(parseScopes(['nonsense']), []);
  });

  it('falls back to the defaults when the column is not an array', () => {
    assert.deepEqual(parseScopes(null), [...DEFAULT_AGENT_SCOPES]);
    assert.deepEqual(parseScopes('chat'), [...DEFAULT_AGENT_SCOPES]);
  });
});

describe('memory limits', () => {
  it('holds core to a tighter limit than everything else', () => {
    assert.equal(memoryLimitFor('core'), AGENT_CORE_MEMORY_MAX_BYTES);
    assert.equal(memoryLimitFor('notes'), AGENT_MEMORY_MAX_BYTES);
    assert.ok(AGENT_CORE_MEMORY_MAX_BYTES < AGENT_MEMORY_MAX_BYTES);
  });

  it('accepts sane slugs and rejects the rest', () => {
    for (const slug of ['core', 'notes', 'my-notes', 'a1', '0']) {
      assert.equal(isValidMemorySlug(slug), true, slug);
    }
    for (const slug of ['Core', 'my notes', '-leading', 'has_underscore', '', 'a'.repeat(65)]) {
      assert.equal(isValidMemorySlug(slug), false, slug);
    }
  });
});

describe('normaliseAgentName', () => {
  it('collapses whitespace and trims', () => {
    assert.equal(normaliseAgentName('  code   reviewer '), 'code reviewer');
  });

  it('caps the length so an agent cannot own the nameplate', () => {
    assert.equal(normaliseAgentName('n'.repeat(200)).length, 40);
  });
});

describe('agentKeyHint', () => {
  it('shows enough to tell two keys apart and no more', () => {
    const hint = agentKeyHint('qa_abcdefghijklmnopqrstuvwxyz1234');
    assert.equal(hint, 'qa_abcd…1234');
    assert.ok(!hint.includes('mnop'), 'the middle of the key must not leak');
  });
});
