import * as restate from "@restatedev/restate-sdk";
import { randomUUID } from "node:crypto";
import { child, childAwakeables, exhaustingParent, parent, relay, type Input } from "./services.js";

const INGRESS = process.env.RESTATE_INGRESS_URL ?? "http://localhost:28080";
const ADMIN = process.env.RESTATE_ADMIN_URL ?? "http://localhost:29070";
const ENDPOINT_PORT = Number(process.env.ENDPOINT_PORT ?? 29080);
// The address at which the Restate container reaches the endpoint this process serves.
const ENDPOINT_URI = process.env.ENDPOINT_URI ?? `http://host.docker.internal:${ENDPOINT_PORT}`;

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 30_000;
const DELAYED_SEND_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// Admin API and ingress helpers
// ---------------------------------------------------------------------------------------------

type InvocationRow = {
  id: string;
  target: string;
  status: string;
  invoked_by_id: string | null;
  completion_result: string | null;
  completion_failure: string | null;
};

async function http(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sql<T>(query: string): Promise<T[]> {
  const response = await http("POST", `${ADMIN}/query`, { query });
  if (!response.ok) throw new Error(`query failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { rows: T[] }).rows;
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const COLUMNS = "id, target, status, invoked_by_id, completion_result, completion_failure";

async function invocation(id: string): Promise<InvocationRow | undefined> {
  return (await sql<InvocationRow>(`SELECT ${COLUMNS} FROM sys_invocation WHERE id = ${quote(id)}`))[0];
}

async function invocationsStartedBy(callerId: string): Promise<InvocationRow[]> {
  return sql<InvocationRow>(`SELECT ${COLUMNS} FROM sys_invocation WHERE invoked_by_id = ${quote(callerId)}`);
}

/** Polls `probe` until it returns a value other than undefined; fails after a timeout. */
async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${POLL_TIMEOUT_MS} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

const completed = (row: InvocationRow | undefined) => (row?.status === "completed" ? row : undefined);

async function waitUntilCompleted(id: string, name: string): Promise<InvocationRow> {
  return waitFor(`${name} ${id} to complete`, async () => completed(await invocation(id)));
}

/** One-way invocation through ingress: POST /{service}/{handler}/send. */
async function sendViaIngress(service: string, handler: string, input: Input): Promise<string> {
  const response = await http("POST", `${INGRESS}/${service}/${handler}/send`, input);
  if (!response.ok) throw new Error(`send ${service}/${handler} failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { invocationId: string }).invocationId;
}

/** PATCH /invocations/{id}/kill or /cancel on the admin API. */
async function endViaAdmin(id: string, action: "kill" | "cancel"): Promise<number> {
  const response = await http("PATCH", `${ADMIN}/invocations/${id}/${action}`);
  if (!response.ok) throw new Error(`${action} failed: ${response.status} ${await response.text()}`);
  return response.status;
}

async function resolveAwakeable(id: string): Promise<void> {
  const response = await http("POST", `${INGRESS}/restate/awakeables/${id}/resolve`, "released");
  if (!response.ok) throw new Error(`resolving awakeable failed: ${response.status} ${await response.text()}`);
}

function outcome(row: InvocationRow): string {
  return row.completion_result === "success" ? "completed successfully" : `failed: ${row.completion_failure}`;
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

type Scenario = {
  name: string;
  handler: "parent/run" | "parent/runViaRelay" | "exhaustingParent/run";
  end: "kill" | "cancel" | "retry policy";
  delayMs?: number;
};

const scenarios: Scenario[] = [
  { name: "A. kill parent; parent sent child one way", handler: "parent/run", end: "kill" },
  { name: "B. cancel parent; parent sent child one way", handler: "parent/run", end: "cancel" },
  { name: "C. kill parent; a returned callee sent child", handler: "parent/runViaRelay", end: "kill" },
  {
    name: "D. kill parent before a delayed send is due",
    handler: "parent/run",
    end: "kill",
    delayMs: DELAYED_SEND_MS,
  },
  { name: "E. retry policy kills parent; child sent one way", handler: "exhaustingParent/run", end: "retry policy" },
];

// Per the documentation, a one-way or delayed call is detached from the call tree: in every
// scenario the child runs and, once the driver releases it, completes successfully.
const DOCUMENTED_CHILD_OUTCOME = "completed successfully";

type Observation = {
  scenario: Scenario;
  endedBy: string;
  parent: string;
  childSentBy: string;
  childWhenParentEnded: string;
  child: string;
};

/** The child's invocation id, found through `invoked_by_id` (directly, or via the relay). */
async function findChild(parentId: string): Promise<InvocationRow | undefined> {
  for (const row of await invocationsStartedBy(parentId)) {
    if (row.target.startsWith("child/")) return row;
    if (row.target.startsWith("relay/")) {
      const viaRelay = (await invocationsStartedBy(row.id)).find((r) => r.target.startsWith("child/"));
      if (viaRelay) return viaRelay;
    }
  }
  return undefined;
}

async function serviceNameOf(id: string | null): Promise<string> {
  const row = id === null ? undefined : await invocation(id);
  return row ? row.target.split("/")[0] : "-";
}

async function run(scenario: Scenario): Promise<Observation> {
  const tag = randomUUID();
  const [service, handler] = scenario.handler.split("/");
  const input: Input = scenario.delayMs === undefined ? { tag } : { tag, delayMs: scenario.delayMs };
  const parentId = await sendViaIngress(service, handler, input);

  // 1. Wait until the child exists: running and blocked on its awakeable, or (delayed send) scheduled.
  const childAtStart = await waitFor("the child invocation to exist", () => findChild(parentId));
  const childId = childAtStart.id;
  const childSentBy = await serviceNameOf(childAtStart.invoked_by_id);

  // 2. End the parent through the admin API (scenario E: the retry policy ends it on its own).
  let endedBy = "retry policy (onMaxAttempts: kill)";
  if (scenario.end !== "retry policy") {
    if (scenario.delayMs === undefined) {
      await waitFor("the child to block on its awakeable", async () => childAwakeables.get(tag));
    } else {
      await waitFor("the delayed child to be scheduled", async () =>
        (await invocation(childId))?.status === "scheduled" ? true : undefined,
      );
    }
    endedBy = `admin ${scenario.end} (HTTP ${await endViaAdmin(parentId, scenario.end)})`;
  }

  // 3. Wait for the parent's final status.
  const parent = await waitUntilCompleted(parentId, "parent");
  const childWhenParentEnded = (await invocation(childId))?.status ?? "removed";

  // 4. Delayed send only: prove whether the child's timer still fires. A control invocation is sent
  //    through ingress with the same delay, so it becomes due after the child would have. Once the
  //    control has run, the child has either run too or never will.
  if (scenario.delayMs !== undefined) {
    const controlTag = `${tag}-control`;
    const response = await http(
      "POST",
      `${INGRESS}/child/run/send?delay=${scenario.delayMs}ms`,
      { tag: controlTag } satisfies Input,
    );
    if (!response.ok) throw new Error(`control send failed: ${response.status} ${await response.text()}`);
    const control = ((await response.json()) as { invocationId: string }).invocationId;
    await resolveAwakeable(await waitFor("the control to run", async () => childAwakeables.get(controlTag)));
    await waitUntilCompleted(control, "control");
  }

  // 5. Wait until the child has completed, or runs and is blocked on its awakeable; release it if
  //    it is still running, then read its final status.
  const childNow = await waitFor("the child to complete, run or disappear", async () => {
    const row = await invocation(childId);
    if (row === undefined) return { removed: true as const };
    if (row.status === "completed" || childAwakeables.has(tag)) return { row };
    return undefined;
  });
  let child: string;
  if ("removed" in childNow) {
    child = childAwakeables.has(tag) ? "removed after running" : "never ran (invocation removed)";
  } else {
    if (childNow.row.status !== "completed") await resolveAwakeable(childAwakeables.get(tag)!);
    child = outcome(await waitUntilCompleted(childId, "child"));
  }

  return { scenario, endedBy, parent: outcome(parent), childSentBy, childWhenParentEnded, child };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  console.log(line(header));
  console.log(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const row of rows) console.log(line(row));
}

async function main(): Promise<void> {
  // A silent logger: scenario E fails on purpose, and the SDK would print each attempt's stack trace.
  await restate
    .endpoint()
    .setLogger(() => {})
    .bind(parent)
    .bind(relay)
    .bind(child)
    .bind(exhaustingParent)
    .listen(ENDPOINT_PORT);

  const version = (await (await http("GET", `${ADMIN}/version`)).json()) as { version: string };
  const registration = await http("POST", `${ADMIN}/deployments`, { uri: ENDPOINT_URI, force: true });
  if (!registration.ok) throw new Error(`registration failed: ${registration.status} ${await registration.text()}`);
  console.log(`restate-server ${version.version}, deployment ${ENDPOINT_URI}`);
  console.log();

  const observations: Observation[] = [];
  for (const scenario of scenarios) observations.push(await run(scenario));

  printTable(
    [
      "Scenario",
      "Parent ended by",
      "Parent final status",
      "Child sent by",
      "Child when parent ended",
      "Child final, per docs",
      "Child final, observed",
      "As documented",
    ],
    observations.map((o) => [
      o.scenario.name,
      o.endedBy,
      o.parent,
      o.childSentBy,
      o.childWhenParentEnded,
      DOCUMENTED_CHILD_OUTCOME,
      o.child,
      o.child === DOCUMENTED_CHILD_OUTCOME ? "yes" : "NO",
    ]),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
