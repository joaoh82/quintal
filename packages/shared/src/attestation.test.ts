import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTESTATION_PREFIX,
  buildAttestationPreimage,
  isValidConditions,
  parseAttestation,
  signAttestation,
  verifyAttestation,
} from './attestation.js';
import { generateSecretKey, getPublicKeyHex, signAuthPayload } from './identity.js';

/**
 * An attestation is two keys and a signature; every test here is a way the
 * three can fail to line up. The happy path is one test. The rest are the
 * forgeries: signed by the wrong person, for the wrong agent, with conditions
 * edited after signing, or by the agent itself.
 */

function owner() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKeyHex(secretKey) };
}

function agent() {
  return getPublicKeyHex(generateSecretKey());
}

describe('owner attestation', () => {
  it('verifies when the owner signed for that agent', () => {
    const josh = owner();
    const buzz = agent();
    const tag = signAttestation({
      agentPubkey: buzz,
      ownerPubkey: josh.pubkey,
      ownerSecretKey: josh.secretKey,
    });

    assert.equal(tag[0], josh.pubkey);
    assert.equal(tag[1], '');
    assert.equal(
      verifyAttestation({ attestation: tag, agentPubkey: buzz, ownerPubkey: josh.pubkey }),
      true,
    );
  });

  it('refuses a tag signed by somebody other than the owner the office knows', () => {
    const josh = owner();
    const stranger = owner();
    const buzz = agent();
    // A perfectly valid attestation — by the wrong person. The tag names the
    // stranger as owner; the office knows better.
    const tag = signAttestation({
      agentPubkey: buzz,
      ownerPubkey: stranger.pubkey,
      ownerSecretKey: stranger.secretKey,
    });
    assert.equal(
      verifyAttestation({ attestation: tag, agentPubkey: buzz, ownerPubkey: josh.pubkey }),
      false,
    );
  });

  it('refuses a tag whose owner field was swapped after signing', () => {
    const josh = owner();
    const stranger = owner();
    const buzz = agent();
    const tag = signAttestation({
      agentPubkey: buzz,
      ownerPubkey: stranger.pubkey,
      ownerSecretKey: stranger.secretKey,
    });
    tag[0] = josh.pubkey;
    assert.equal(
      verifyAttestation({ attestation: tag, agentPubkey: buzz, ownerPubkey: josh.pubkey }),
      false,
    );
  });

  it('refuses a tag for a different agent', () => {
    const josh = owner();
    const tag = signAttestation({
      agentPubkey: agent(),
      ownerPubkey: josh.pubkey,
      ownerSecretKey: josh.secretKey,
    });
    assert.equal(
      verifyAttestation({ attestation: tag, agentPubkey: agent(), ownerPubkey: josh.pubkey }),
      false,
    );
  });

  it('refuses conditions edited after signing, even to an equivalent string', () => {
    const josh = owner();
    const buzz = agent();
    const tag = signAttestation({
      agentPubkey: buzz,
      ownerPubkey: josh.pubkey,
      ownerSecretKey: josh.secretKey,
      conditions: 'scope=chat&scope=move',
    });
    assert.equal(
      verifyAttestation({ attestation: tag, agentPubkey: buzz, ownerPubkey: josh.pubkey }),
      true,
    );
    // Same clauses, other order. Signed verbatim means this is a different string.
    tag[1] = 'scope=move&scope=chat';
    assert.equal(
      verifyAttestation({ attestation: tag, agentPubkey: buzz, ownerPubkey: josh.pubkey }),
      false,
    );
  });

  it('refuses self-attestation, at signing and at verifying', () => {
    const josh = owner();
    assert.throws(() =>
      signAttestation({
        agentPubkey: josh.pubkey,
        ownerPubkey: josh.pubkey,
        ownerSecretKey: josh.secretKey,
      }),
    );
    // Hand-built, in case a signer skipped the check.
    const sig = signAuthPayload(josh.secretKey, buildAttestationPreimage(josh.pubkey));
    assert.equal(
      verifyAttestation({
        attestation: [josh.pubkey, '', sig],
        agentPubkey: josh.pubkey,
        ownerPubkey: josh.pubkey,
      }),
      false,
    );
  });

  it('refuses a signature over the login payload, not the attestation', () => {
    const josh = owner();
    const buzz = agent();
    // A signer tricked into signing "something" must not have signed this.
    const sig = signAuthPayload(josh.secretKey, `quintal-auth:v1:https://x:${'0'.repeat(64)}:1`);
    assert.equal(
      verifyAttestation({
        attestation: [josh.pubkey, '', sig],
        agentPubkey: buzz,
        ownerPubkey: josh.pubkey,
      }),
      false,
    );
  });

  it('never throws on garbage', () => {
    const josh = owner();
    for (const garbage of [null, 'x', [], [1, 2, 3], ['a', 'b', 'c'], { ownerPubkey: 1 }]) {
      assert.equal(
        verifyAttestation({ attestation: garbage, agentPubkey: agent(), ownerPubkey: josh.pubkey }),
        false,
      );
    }
    assert.equal(parseAttestation(['0'.repeat(64), 'not valid!', '0'.repeat(128)]), null);
  });
});

describe('the conditions grammar', () => {
  it('accepts empty, and name=value clauses joined by &', () => {
    assert.equal(isValidConditions(''), true);
    assert.equal(isValidConditions('exp=1800000000'), true);
    assert.equal(isValidConditions('scope=chat&ws=abc-123'), true);
  });

  it('rejects anything that could be misread', () => {
    assert.equal(isValidConditions(' '), false);
    assert.equal(isValidConditions('scope'), false);
    assert.equal(isValidConditions('Scope=chat'), false);
    assert.equal(isValidConditions('scope=chat&'), false);
    assert.equal(isValidConditions('a=1&&b=2'), false);
    assert.equal(isValidConditions('a=' + 'x'.repeat(600)), false);
    assert.equal(isValidConditions(undefined), false);
  });

  it('is written into the preimage exactly as given', () => {
    const buzz = agent();
    assert.equal(buildAttestationPreimage(buzz, 'a=1'), `${ATTESTATION_PREFIX}:${buzz}:a=1`);
    assert.equal(buildAttestationPreimage(buzz), `${ATTESTATION_PREFIX}:${buzz}:`);
    assert.throws(() => buildAttestationPreimage(buzz, 'A=1'));
  });
});
