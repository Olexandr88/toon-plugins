import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Forward host secrets INTO the sandcastle Docker sandbox.
//
// WHY THIS EXISTS — root cause of the first-run failure seen in toon-protocol/relay#68
// -------------------------------------------------------------
// The `agent:implement` runner reached the sandbox, but claude-code inside it
// died with `Not logged in · Please run /login`, even though the workflow step
// exported CLAUDE_CODE_OAUTH_TOKEN (and GH_TOKEN) into the runner's env.
//
// The reason: @ai-hero/sandcastle@0.12.0's env resolver does NOT blanket-pass
// `process.env` into the container. It only forwards a variable whose KEY also
// appears in `.sandcastle/.env` (see `resolveEnv` in the engine's dist/index.js):
//
//     const sandcastleEnv = parseEnvFile(".sandcastle/.env");   // missing -> {}
//     for (const key of Object.keys(sandcastleEnv))             // keys from the FILE
//       result[key] = sandcastleEnv[key] || process.env[key];
//
// `.sandcastle/.env` is gitignored (only `.env.example` is committed), so in CI
// the file does not exist -> `parseEnvFile` returns {} -> the loop never runs ->
// the resolved env is {} -> NEITHER token is passed to `docker run`. The
// container therefore starts with no credentials and claude-code is unauthed.
//
// THE FIX
// -------
// Pass the secrets through the sandbox PROVIDER's first-class `env` option
// (`docker({ env })`), which the README documents as "Environment variables to
// inject into the sandbox" and merges via `mergeProviderEnv`. `createSandbox`
// bakes `sandboxProviderEnv` into the `docker run -e KEY=VALUE` flags at
// container start (`startContainer` in dist/sandboxes -> chunk-CP3TYXZA.js:
// `Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`])`). Every
// in-container exec then inherits them: claude-code (CLAUDE_CODE_OAUTH_TOKEN)
// AND the agent's in-sandbox `gh issue view` / `gh issue comment` (GH_TOKEN).
//
// NOTE: CLAUDE_CODE_OAUTH_TOKEN is included only when it is set on the host, so a
// local `.sandcastle/.env` value is not clobbered (`mergeProviderEnv` layers
// sandbox-provider env OVER the resolved `.env` values).
//
// GH_TOKEN is the exception: it is ALWAYS set here, to an empty string if there is
// no issues-only token. Sandcastle's own resolution forwards
// `sandcastleEnv[key] || process.env[key]`, so a `GH_TOKEN=` line left blank in
// `.sandcastle/.env` would hand the container whatever GH_TOKEN the developer's
// shell exports (often `gh auth token`, which can push). Setting the key here wins
// over that resolution, so the host's own GH_TOKEN never reaches the container.

// WHICH GITHUB TOKEN THE SANDBOX GETS
// -----------------------------------
// The agents work from an issue and its comments, and anyone can write those. So
// the container's GH_TOKEN is NOT the host's. The host's token can push and open
// PRs; the container gets a separate one that can only read and write issues
// (SANDBOX_GH_TOKEN, minted by agent-implement.yml with `issues: write` alone).
// That is all an agent uses `gh` for: the prompts tell it to read the issue and
// to comment on it, and not to push or open a PR. The runner does every push
// itself, with a token it mints and stages for the length of one `git push`
// (pushBranch in agent-implement-issue.ts).
//
// DELIBERATELY ABSENT: any wallet mnemonic or funded key. The tests here need none, and
// this repository is public. Do not add one without re-reading the redaction step in
// agent-implement.yml first.
//
// APP_PRIVATE_KEY is absent for the same class of reason: it stays on the host
// so the runner can mint a fresh push credential without the container ever
// holding the key (toon-protocol/connector#462).

/** Parse `.sandcastle/.env` the way sandcastle 0.12.0's `parseEnvFile` does. Missing file: {}. */
export function readSandcastleEnv(repoDir: string = process.cwd()): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(join(repoDir, '.sandcastle', '.env'), 'utf8');
  } catch {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    vars[trimmed.slice(0, eq).trim()] = value;
  }
  return vars;
}

/**
 * The secrets to inject into the sandbox, as a `Record<string, string>` suitable
 * for `docker({ env })`:
 *
 *   CLAUDE_CODE_OAUTH_TOKEN  the host's, when set. Authenticates claude-code.
 *   GH_TOKEN                 always present. The issues-only token: the host's
 *                            SANDBOX_GH_TOKEN, else (off Actions) SANDBOX_GH_TOKEN
 *                            or GH_TOKEN written in `.sandcastle/.env`, else empty.
 *                            Never the host's own GH_TOKEN.
 *
 * On Actions there is no `.sandcastle/.env`, so a missing SANDBOX_GH_TOKEN throws:
 * the run must not start with no token, and must never fall back to the one that
 * can push.
 */
export function sandboxSecrets(
  host: Record<string, string | undefined> = process.env,
  envFile: Record<string, string> = readSandcastleEnv()
): Record<string, string> {
  const env: Record<string, string> = {};
  if (host.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = host.CLAUDE_CODE_OAUTH_TOKEN;
  if (host.SANDBOX_GH_TOKEN) {
    env.GH_TOKEN = host.SANDBOX_GH_TOKEN;
  } else if (host.GITHUB_ACTIONS === 'true') {
    throw new Error(
      'SANDBOX_GH_TOKEN is not set. The sandbox needs its own issues-only token ' +
        '(see agent-implement.yml); the runner will not forward its own GH_TOKEN.'
    );
  } else {
    // Only a value the developer wrote into .sandcastle/.env for the sandbox.
    // An empty string still overrides sandcastle's fallback to the shell's GH_TOKEN.
    env.GH_TOKEN = envFile.SANDBOX_GH_TOKEN || envFile.GH_TOKEN || '';
  }
  return env;
}
