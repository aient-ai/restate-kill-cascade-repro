# Restate: an admin kill also kills invocations started by a one-way send

Killing an invocation through the admin API (`PATCH /invocations/{id}/kill`) also kills the invocations it started
with a one-way send (`ctx.serviceSendClient(...)`), and drops a delayed one-way send that is not yet due. The
documentation says one-way and delayed calls are detached from the call tree and are not killed. Cancelling the same
invocation behaves as documented: its one-way child keeps running.

## Versions

- Restate server `restatedev/restate:1.8.0`
  (`sha256:2614a4e3a2102ef0cd4733e324574ee29a77e19e7e29262fa5660c9c55df70e5`)
- `@restatedev/restate-sdk` 1.14.4
- Run on macOS with Docker 29.9.3 and Node.js 26.12.1. Any Node.js 20 or newer should work.

## What the documentation says

[Managing invocations](https://docs.restate.dev/services/invocation/managing-invocations), as read on 2026-11-10.

Under Kill:

> Killing immediately stops all calls in the invocation tree **without executing compensation logic**. [...] Note that
> one-way calls and delayed calls are not killed because they're detached from the originating call tree.

Under Cancel:

> One-way calls (`ctx.send()`) and delayed calls (`ctx.sendDelayed()`) are detached from the call tree. They will be
> scheduled and execute fully even if the originating invocation is cancelled.

The admin API's `PATCH /invocations/{invocation_id}/kill` takes only the invocation id; there is no option that
controls propagation.

## Run it

```sh
docker compose up -d --wait
npm ci
npm run repro
```

`docker compose down -v` removes the server afterwards. The server's ingress is mapped to host port 28080, its admin
API to 29070, and the driver serves the service endpoint on 29080, so it does not collide with a Restate already
running on the default ports. Override with `RESTATE_INGRESS_URL`, `RESTATE_ADMIN_URL`, `ENDPOINT_PORT` and
`ENDPOINT_URI` if needed.

## Observed output

Verbatim from a run against a freshly started container:

```text
restate-server 1.8.0, deployment http://host.docker.internal:29080

| Scenario                                         | Parent ended by                    | Parent final status                                                          | Child sent by    | Child when parent ended | Child final, per docs  | Child final, observed          | As documented |
|--------------------------------------------------|------------------------------------|------------------------------------------------------------------------------|------------------|-------------------------|------------------------|--------------------------------|---------------|
| A. kill parent; parent sent child one way        | admin kill (HTTP 200)              | failed: [409] killed                                                         | parent           | completed               | completed successfully | failed: [409] killed           | NO            |
| B. cancel parent; parent sent child one way      | admin cancel (HTTP 202)            | failed: [409] Cancelled                                                      | parent           | running                 | completed successfully | completed successfully         | yes           |
| C. kill parent; a returned callee sent child     | admin kill (HTTP 200)              | failed: [409] killed                                                         | relay            | running                 | completed successfully | completed successfully         | yes           |
| D. kill parent before a delayed send is due      | admin kill (HTTP 200)              | failed: [409] killed                                                         | parent           | removed                 | completed successfully | never ran (invocation removed) | NO            |
| E. retry policy kills parent; child sent one way | retry policy (onMaxAttempts: kill) | failed: [500] retryable failure until the retry policy kills this invocation | exhaustingParent | running                 | completed successfully | completed successfully         | yes           |
```

The same table came out on each of six runs.

## The services

All in [`src/services.ts`](src/services.ts):

- `child.run` blocks on an awakeable, and completes successfully once the driver resolves it.
- `parent.run` sends `child.run` one way (with `restate.rpc.sendOpts({ delay })` in scenario D), then blocks on an
  awakeable that nobody resolves.
- `parent.runViaRelay` calls `relay.run` request-response; `relay.run` sends `child.run` one way and returns. The
  parent then blocks.
- `exhaustingParent.run` sends `child.run` one way and then throws a retryable error. Its service retry policy is
  `{ maxAttempts: 3, onMaxAttempts: "kill" }`, so Restate kills it after the third attempt without any operator.

## The scenarios

| Scenario | What happens | Documented | Observed |
| --- | --- | --- | --- |
| A | Kill `parent` while it and its one-way child both run | child keeps running | **child killed** |
| B | Cancel `parent` instead | child keeps running | child keeps running |
| C | Kill `parent`; the child was sent by `relay`, which `parent` called and which has returned | child keeps running | child keeps running |
| D | Kill `parent` while its 5 s delayed send to the child is still scheduled | child runs after the delay | **child never runs**; its scheduled invocation is removed |
| E | `exhaustingParent` is killed by its retry policy (`onMaxAttempts: "kill"`) | child keeps running | child keeps running |

C narrows A down: the kill reaches invocations whose `invoked_by_id` is the killed invocation, but does not continue
through a caller that has already completed. E shows that only a kill through the admin API propagates; the kill that
ends retry exhaustion does not.

## How the driver decides each outcome

[`src/repro.ts`](src/repro.ts) serves the services in-process, registers the deployment, and runs the scenarios in
order. For each one it:

1. starts the parent with `POST /{service}/{handler}/send` on the ingress;
2. finds the child in `sys_invocation` through `invoked_by_id` (directly, or through the relay's invocation) and
   waits until it is blocked on its awakeable, or for D, until its status is `scheduled`;
3. kills or cancels the parent with `PATCH /invocations/{id}/kill` or `/cancel` on the admin API (E: nothing);
4. waits until the parent's `sys_invocation.status` is `completed` and records the child's status at that moment
   (the "Child when parent ended" column);
5. for D only: sends a control invocation of `child.run` through ingress with the same delay. It becomes due after the
   child would have, so once the control has run, the child's timer has either fired or never will;
6. if the child is still running, resolves its awakeable through `POST /restate/awakeables/{id}/resolve`, then waits
   until the child is `completed` and prints its `completion_result` and `completion_failure`.

Every wait polls `sys_invocation` (or the in-process record of the child's awakeable id) with a 30 s timeout; there
are no fixed sleeps. Releasing a surviving child turns "it was not killed" into a positive observation: it completes
successfully. In A the child is already `completed` with `[409] killed` by the time the parent's own completion is
visible, so the release in step 6 never races the kill.

## License

[MIT](LICENSE)
