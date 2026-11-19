// Boot file for the forge.
//
// The trial harness gives this process exactly one job beyond serving:
// announce the port the forge bound, then stay alive until the harness
// says the trial is over. Everything else — the git smart HTTP, REST,
// GraphQL and MCP surfaces — lives in app.ts behind createApp().

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** How long to wait between two polls of the environment's /done. */
const DONE_POLL_MS = 500;

/** How long to wait before retrying a failed call to the environment. */
const ENV_RETRY_MS = 300;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The contest environment's base URL, with any trailing slash removed. */
function environmentBase(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

/**
 * POST the bound port to the environment until it accepts the
 * registration. The environment may still be coming up when this
 * process starts, so a refused or failed attempt is retried, with the
 * wait growing towards a cap so a slow environment is not hammered.
 * A 409 counts as success: it means an earlier attempt landed but its
 * reply was lost on the way back, so the registration already stands.
 */
async function registerPort(base: string, port: number): Promise<void> {
  let delay = ENV_RETRY_MS;
  for (;;) {
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (reply.ok || reply.status === 409) return;
    } catch {
      // The environment is not answering yet; fall through and retry.
    }
    await pause(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

/**
 * Poll the environment until it reports the trial is done. A failed
 * poll says nothing about the trial, so it is simply retried on the
 * next tick; the wait ends only on an explicit done.
 */
async function awaitTrialEnd(base: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${base}/done`);
      if (reply.ok) {
        const state = (await reply.json()) as { done?: unknown };
        if (state.done === true) return;
      }
    } catch {
      // Keep polling; a silent environment is not a finished trial.
    }
    await pause(DONE_POLL_MS);
  }
}

const forge = createApp();

// Port 0 asks the kernel for a free port; 8080 belongs to the suite.
await new Promise<void>((resolve, reject) => {
  forge.once('error', reject);
  forge.listen(0, () => resolve());
});

const bound = forge.address();
if (bound === null || typeof bound === 'string') {
  throw new Error('the forge did not bind a TCP port');
}
console.log(`forge: listening on port ${bound.port}`);

const base = environmentBase();
if (base !== '') {
  await registerPort(base, bound.port);
  console.log('forge: registered with the contest environment');
  await awaitTrialEnd(base);
  console.log('forge: trial finished, exiting');
  process.exit(0);
}
