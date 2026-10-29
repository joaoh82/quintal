import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  repoPullOf,
  GithubClient,
  GithubError,
  mayManageGithubToken,
  mayMergeFromFacts,
  normaliseGithubRepos,
  normaliseGithubToken,
  parsePullRequestUrl,
  repoOnList,
  reviewDecisionOf,
  summariseChecks,
} from './github.js';

describe('a GitHub token, as pasted', () => {
  it('is trimmed and kept when it looks like one', () => {
    assert.equal(normaliseGithubToken('  github_pat_11AAAAAAA0abcdefghijklmnop  '), 'github_pat_11AAAAAAA0abcdefghijklmnop');
    assert.equal(normaliseGithubToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('is refused when it is short, long, or not a token at all', () => {
    assert.equal(normaliseGithubToken('ghp_short'), null);
    assert.equal(normaliseGithubToken('https://github.com/settings/tokens'), null);
    assert.equal(normaliseGithubToken('a'.repeat(256)), null);
    assert.equal(normaliseGithubToken(42), null);
  });
});

describe('a pull request URL', () => {
  it('names its repository and number', () => {
    assert.deepEqual(parsePullRequestUrl('https://github.com/acme/office/pull/12'), { owner: 'acme', repo: 'office', number: 12 });
    assert.deepEqual(parsePullRequestUrl('https://github.com/acme/office/pull/12/files'), { owner: 'acme', repo: 'office', number: 12 });
  });

  it('is null for anything else', () => {
    assert.equal(parsePullRequestUrl('https://github.com/acme/office/issues/12'), null);
    assert.equal(parsePullRequestUrl('https://github.com/acme/office/pull/0'), null);
    assert.equal(parsePullRequestUrl('not a url'), null);
  });

  it('is null on any other host: a path that looks right somewhere else is not a pull request here', () => {
    assert.equal(parsePullRequestUrl('https://gitlab.example/acme/office/pull/5'), null);
    assert.equal(parsePullRequestUrl('https://github.com.evil.example/acme/office/pull/5'), null);
    assert.equal(parsePullRequestUrl('ftp://github.com/acme/office/pull/5'), null);
    assert.deepEqual(parsePullRequestUrl('https://www.github.com/acme/office/pull/5'), { owner: 'acme', repo: 'office', number: 5 });
    assert.deepEqual(parsePullRequestUrl('https://git.acme.example/acme/office/pull/5', 'git.acme.example'), { owner: 'acme', repo: 'office', number: 5 }, 'an enterprise host, when configured');
    assert.equal(parsePullRequestUrl('https://github.com/acme/office/pull/5', 'git.acme.example'), null, 'and then not github.com');
  });
});

describe('the office’s list of repositories', () => {
  it('reads names one per line, or by spaces or commas, or as URLs, lower-cased and once each', () => {
    assert.deepEqual(normaliseGithubRepos('acme/office\nAcme/Payments, acme/office https://github.com/acme/web.git'), ['acme/office', 'acme/payments', 'acme/web']);
    assert.deepEqual(normaliseGithubRepos('  '), []);
  });

  it('refuses anything that is not a repository name, and too many', () => {
    assert.equal(normaliseGithubRepos('acme'), null);
    assert.equal(normaliseGithubRepos('acme/office/pull/5'), null);
    assert.equal(normaliseGithubRepos('acme/of fice'), null);
    assert.equal(normaliseGithubRepos(Array.from({ length: 51 }, (_, i) => `acme/r${i}`).join(' ')), null);
    assert.equal(normaliseGithubRepos(42), null);
  });

  it('says whether a pull request is in a listed repository, whatever the case', () => {
    assert.equal(repoOnList(['acme/office'], { owner: 'Acme', repo: 'Office' }), true);
    assert.equal(repoOnList(['acme/office'], { owner: 'acme', repo: 'payments' }), false);
    assert.equal(repoOnList([], { owner: 'acme', repo: 'office' }), false);
  });
});

describe('what the checks add up to', () => {
  const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, url: null });

  it('is none without any, and passing when every one has', () => {
    assert.equal(summariseChecks([]).summary, 'none');
    const all = summariseChecks([run('build', 'completed', 'success'), run('lint', 'completed', 'skipped'), run('note', 'completed', 'neutral')]);
    assert.equal(all.summary, 'passing');
    assert.equal(all.passed, 3);
  });

  it('is failing as soon as one has, over any still running', () => {
    const mixed = summariseChecks([run('build', 'completed', 'failure'), run('test', 'in_progress', null), run('lint', 'completed', 'success')]);
    assert.equal(mixed.summary, 'failing');
    assert.deepEqual([mixed.passed, mixed.failed, mixed.pending, mixed.total], [1, 1, 1, 3]);
    assert.equal(summariseChecks([run('build', 'completed', 'cancelled')]).summary, 'failing');
  });

  it('is pending while any still runs and none has failed', () => {
    assert.equal(summariseChecks([run('build', 'queued', null), run('lint', 'completed', 'success')]).summary, 'pending');
  });
});

describe('the review decision', () => {
  const review = (reviewer: string, state: string, submittedAt: number) => ({ reviewer, state, submittedAt });

  it('is each reviewer’s last word, and a request for changes outweighs an approval', () => {
    assert.equal(reviewDecisionOf([review('ana', 'APPROVED', 1), review('ben', 'CHANGES_REQUESTED', 2)]), 'changes_requested');
    assert.equal(reviewDecisionOf([review('ben', 'CHANGES_REQUESTED', 1), review('ben', 'APPROVED', 2)]), 'approved');
    assert.equal(reviewDecisionOf([review('ben', 'APPROVED', 2), review('ben', 'CHANGES_REQUESTED', 1)]), 'approved', 'order on the wire does not matter');
  });

  it('ignores comments and is none without a verdict', () => {
    assert.equal(reviewDecisionOf([review('ana', 'COMMENTED', 1)]), 'none');
    assert.equal(reviewDecisionOf([]), 'none');
  });
});

describe('who holds the office’s token', () => {
  it('is an owner or admin, not a member, a guest or nobody', () => {
    assert.equal(mayManageGithubToken('owner'), true);
    assert.equal(mayManageGithubToken('admin'), true);
    assert.equal(mayManageGithubToken('member'), false);
    assert.equal(mayManageGithubToken('guest'), false);
    assert.equal(mayManageGithubToken(null), false);
  });
});

describe('whether the board offers a merge', () => {
  it('only for an open pull request that is not a draft and not known to conflict', () => {
    assert.equal(mayMergeFromFacts({ state: 'open', draft: false, mergeable: true }), true);
    assert.equal(mayMergeFromFacts({ state: 'open', draft: false, mergeable: null }), true, 'GitHub still working it out is not a no');
    assert.equal(mayMergeFromFacts({ state: 'open', draft: false, mergeable: false }), false);
    assert.equal(mayMergeFromFacts({ state: 'open', draft: true, mergeable: true }), false);
    assert.equal(mayMergeFromFacts({ state: 'merged', draft: false, mergeable: null }), false);
  });
});

/** A GitHub that answers from a table, and remembers what it was asked. */
function fakeGithub(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace('https://api.github.com', '');
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const status = route.status ?? 200;
    return new Response(status === 204 || status === 202 ? null : JSON.stringify(route.body ?? {}), { status });
  };
  return { fetch, calls };
}

const REF = { owner: 'acme', repo: 'office', number: 12 };

describe('the client', () => {
  it('sends the token as a bearer, the API version, and asks for JSON', async () => {
    const github = fakeGithub({ 'GET /user': { body: { login: 'josh' } } });
    const client = new GithubClient('ghp_token', { fetch: github.fetch });
    assert.deepEqual(await client.viewer(), { login: 'josh' });
    const [call] = github.calls;
    assert.equal(call?.headers.Authorization, 'Bearer ghp_token');
    assert.equal(call?.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.match(call?.headers.Accept ?? '', /github\+json/);
  });

  it('reads a pull request’s facts in three calls', async () => {
    const github = fakeGithub({
      'GET /repos/acme/office/pulls/12': {
        body: {
          number: 12,
          state: 'open',
          merged: false,
          draft: false,
          title: 'Fix the chair',
          mergeable: true,
          mergeable_state: 'clean',
          head: { sha: 'abc123', ref: 'quintal/marvin/fix-the-chair' },
          base: { ref: 'main' },
        },
      },
      'GET /repos/acme/office/commits/abc123/check-runs?per_page=100': {
        body: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://ci/1' }] },
      },
      'GET /repos/acme/office/pulls/12/reviews?per_page=100': {
        body: [{ user: { login: 'ana' }, state: 'APPROVED', submitted_at: '2026-10-29T10:00:00Z' }],
      },
    });
    const facts = await new GithubClient('ghp_token', { fetch: github.fetch }).facts(REF);
    assert.equal(facts.state, 'open');
    assert.equal(facts.headSha, 'abc123');
    assert.equal(facts.baseRef, 'main');
    assert.equal(facts.mergeable, true);
    assert.equal(facts.checks.summary, 'passing');
    assert.equal(facts.checks.runs[0]?.url, 'https://ci/1');
    assert.equal(facts.reviewDecision, 'approved');
    assert.equal(github.calls.length, 3);
  });

  it('says merged for a merged one, whatever its state field', async () => {
    const github = fakeGithub({
      'GET /repos/acme/office/pulls/12': {
        body: { number: 12, state: 'closed', merged: true, title: 't', mergeable: null, head: { sha: 's', ref: 'b' }, base: { ref: 'main' } },
      },
      'GET /repos/acme/office/commits/s/check-runs?per_page=100': { body: { check_runs: [] } },
      'GET /repos/acme/office/pulls/12/reviews?per_page=100': { body: [] },
    });
    const facts = await new GithubClient('t', { fetch: github.fetch }).facts(REF);
    assert.equal(facts.state, 'merged');
    assert.equal(facts.mergeableState, 'unknown');
  });

  it('merges by method, pinned to the head the person saw', async () => {
    const github = fakeGithub({ 'PUT /repos/acme/office/pulls/12/merge': { body: { sha: 'm1', merged: true } } });
    const merged = await new GithubClient('t', { fetch: github.fetch }).merge(REF, 'squash', 'abc123');
    assert.equal(merged.sha, 'm1');
    assert.deepEqual(github.calls[0]?.body, { merge_method: 'squash', sha: 'abc123' });
  });

  it('closes, and asks for the branch to be brought up to date', async () => {
    const github = fakeGithub({
      'PATCH /repos/acme/office/pulls/12': { body: { state: 'closed' } },
      'PUT /repos/acme/office/pulls/12/update-branch': { status: 202 },
    });
    const client = new GithubClient('t', { fetch: github.fetch });
    await client.close(REF);
    await client.updateBranch(REF, 'abc123');
    assert.deepEqual(github.calls[0]?.body, { state: 'closed' });
    assert.deepEqual(github.calls[1]?.body, { expected_head_sha: 'abc123' });
  });

  it('turns GitHub’s refusals into words a person can act on', async () => {
    const github = fakeGithub({
      'GET /user': { status: 401, body: { message: 'Bad credentials' } },
      'PUT /repos/acme/office/pulls/12/merge': { status: 405, body: { message: 'Pull Request is not mergeable' } },
      'GET /repos/acme/office/pulls/13': { status: 403, body: { message: 'API rate limit exceeded for user' } },
    });
    const client = new GithubClient('t', { fetch: github.fetch });
    await assert.rejects(client.viewer(), (error: unknown) => error instanceof GithubError && error.code === 'unauthorised' && /token/.test(error.message));
    await assert.rejects(client.merge(REF, 'merge'), (error: unknown) => error instanceof GithubError && error.code === 'conflict' && /not mergeable/.test(error.message));
    await assert.rejects(client.pullRequest({ ...REF, number: 13 }), (error: unknown) => error instanceof GithubError && error.code === 'rate_limited');
    await assert.rejects(client.pullRequest({ ...REF, number: 99 }), (error: unknown) => error instanceof GithubError && error.code === 'not_found');
  });

  it('says so when GitHub cannot be reached at all', async () => {
    const client = new GithubClient('t', {
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await assert.rejects(client.viewer(), (error: unknown) => error instanceof GithubError && error.code === 'unavailable' && /ECONNREFUSED/.test(error.message));
  });
});

describe('a listed pull request, as the board carries it', () => {
  const raw = {
    number: 7,
    state: 'closed',
    draft: false,
    title: 'Paint the lobby',
    html_url: 'https://github.com/Acme/API/pull/7',
    user: { login: 'trillian' },
    merged_at: '2026-10-02T00:00:00Z',
    head: { sha: 'abc', ref: 'paint' },
    base: { ref: 'main' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  };

  it('says merged for a closed one with a merge, and keys the repository lower-case', () => {
    const pull = repoPullOf(raw, 'Acme/API');
    assert.equal(pull.repo, 'acme/api');
    assert.equal(pull.state, 'merged');
    assert.equal(pull.author, 'trillian');
    assert.equal(pull.updatedAt, Date.parse('2026-10-02T00:00:00Z'));
    assert.equal(repoPullOf({ ...raw, merged_at: null }, 'acme/api').state, 'closed');
    assert.equal(repoPullOf({ ...raw, state: 'open', merged_at: null, draft: true, user: null }, 'acme/api').author, '');
  });
});
