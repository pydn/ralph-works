# typescript-migration Review Findings

## Decision

Changes requested.

## Critical Findings

### [CRITICAL] Opt-in real Pi E2E no longer completes the multi-session workflow

The migrated code passes the normal skipped E2E path, but the required opt-in real Pi validation fails consistently.

Reproduction:

```sh
npm run test:e2e:pi
RALPH_WORKS_PI_E2E=1 node --test --test-name-pattern "real Pi creates a replacement session after a TDD task marker" tests/pi-real-session-handoff.e2e.test.ts
```

Observed result:

- The first real-Pi subtest passes.
- The TDD handoff subtest times out before harden approval.
- After `red_team` emits `RALPH_PHASE_COMPLETE`, the workflow enters `harden_spec` with `HANDOFF PENDING` and then changes to `HANDOFF FAILED`.
- The TUI/session error is: `RalphWorks session handoff requires an active Pi command context.`

Impact:

- In real Pi, the workflow cannot reliably advance past the replacement session created after `generate_spec` when a later phase tries to create the next handoff.
- This blocks the Ralph loop before harden approval/TDD and violates the hardened spec requirement that `npm run test:e2e:pi` exercise the migrated TypeScript path when opted in.
- It also undermines the core behavior-preservation requirement for fresh Pi session handoff across phase and task boundaries.

Required repair:

- Add/adjust a failing test that reproduces nested automatic phase handoff in a replacement real-Pi-like context where the event context does not itself expose `ctx.newSession`.
- Fix session-control context retention or handoff execution so replacement sessions can initiate subsequent phase/task handoffs under real Pi.
- Validate with `npm run test:e2e:pi`, `npm test`, and `npm run check`.
