import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandboxSecrets } from './sandbox-secrets.ts';

test("the sandbox gets the issues-only token as GH_TOKEN, never the host's own", () => {
  const env = sandboxSecrets({
    GITHUB_ACTIONS: 'true',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-credential',
    GH_TOKEN: 'ghs_host_token_that_can_push',
    SANDBOX_GH_TOKEN: 'ghs_issues_only',
    APP_ID: '1',
    APP_PRIVATE_KEY: 'key',
  });

  assert.deepEqual(env, {
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-credential',
    GH_TOKEN: 'ghs_issues_only',
  });
});

test('on Actions, a run with no issues-only token does not start', () => {
  assert.throws(
    () =>
      sandboxSecrets({
        GITHUB_ACTIONS: 'true',
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-credential',
        GH_TOKEN: 'ghs_host_token_that_can_push',
      }),
    /SANDBOX_GH_TOKEN is not set/
  );
});

test("off Actions, a blank GH_TOKEN line cannot let the shell's GH_TOKEN reach the container", () => {
  // What sandcastle resolves from `.sandcastle/.env` (GH_TOKEN= left blank) ...
  const host = { CLAUDE_CODE_OAUTH_TOKEN: 'claude-credential', GH_TOKEN: 'ghp_developer_token_that_can_push' };
  const envFile = { CLAUDE_CODE_OAUTH_TOKEN: '', GH_TOKEN: '' };
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(envFile)) {
    const value = envFile[key as keyof typeof envFile] || host[key as keyof typeof host];
    if (value) resolved[key] = value;
  }
  assert.equal(resolved.GH_TOKEN, 'ghp_developer_token_that_can_push');

  // ... merged the way sandcastle's mergeProviderEnv merges it: provider env wins.
  const container = { ...resolved, ...sandboxSecrets(host, envFile) };

  assert.equal(container.GH_TOKEN, '');
  assert.equal(container.CLAUDE_CODE_OAUTH_TOKEN, 'claude-credential');
});

test('off Actions, an issues-only token written in .sandcastle/.env is used', () => {
  const host = { GH_TOKEN: 'ghp_developer_token_that_can_push' };
  assert.equal(sandboxSecrets(host, { SANDBOX_GH_TOKEN: 'github_pat_issues_only' }).GH_TOKEN, 'github_pat_issues_only');
  assert.equal(sandboxSecrets(host, { GH_TOKEN: 'github_pat_older_setup' }).GH_TOKEN, 'github_pat_older_setup');
});
