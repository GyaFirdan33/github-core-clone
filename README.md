# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/GyaFirdan33/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/GyaFirdan33/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, one-process GitHub-compatible git forge. It serves git smart HTTP (v2 fetch with shallow/deepen, v0 receive-pack), the REST v3 API (repositories, contents, issues, pull requests with three-way merge), a hand-written GraphQL executor, and MCP tools — all from a single Node process over its own in-memory store, with no UI and no outside service. The sealed make.fun suite drives it as a client and times four workloads against it; locally it scores 991/1000 (feature 600/600, agent 200/200).

## Run it

```sh
node main.ts
```

`main.ts` boots the forge from `app.ts`, listens on a kernel-picked port, registers that port with `$MAKEFUN_ENV_URL/register`, and exits 0 when `$MAKEFUN_ENV_URL/done` flips. The harness sets `MAKEFUN_ENV_URL` and the trial token; `/healthz` answers 200 and `/api/v3/user` enforces the token (200 with it, 401 without).

## What it implements

- **Git smart HTTP** — pkt-line framing, pack write/read with delta resolution, v2 `ls-refs`/`fetch` (shallow, deepen, filter), v0 `receive-pack` with report-status.
- **REST v3** — repository CRUD, contents API, issues, pull requests with three-way merge, all on the same store.
- **GraphQL** — a hand-written parser and executor covering the query/mutation shapes `gh` and `github-mcp-server` send.
- **MCP** — eight tools at `/mcp` over the same store.
- **Scoring** — the local suite (kit `sdk/run.ts --perf`) reports 991/1000: conformance 120/120, feature 600/600, agent 200/200, perf 191/200.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5ds3qsy9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
