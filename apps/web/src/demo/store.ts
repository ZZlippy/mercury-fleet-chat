import fixturesRaw from "./fixtures.json";

/**
 * In-memory demo "database". Seeded once per page load from fixtures.json
 * (captured from the real backend — see scripts/build-demo-fixtures.ts) and
 * then mutated in place by demo/api.ts so that operator/fleet dashboards see
 * their own changes reflected on the next poll. Nothing here is persisted —
 * a full page reload resets everything back to the captured fixtures.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const fixtures = fixturesRaw as any;

let operatorStore: any = null;
export function getOperatorStore() {
  if (!operatorStore) operatorStore = clone(fixtures.operator);
  return operatorStore;
}

const fleetStores: Record<string, any> = {};
export function getFleetStore(usernameHint: string): { username: string; data: any } {
  const username = fixtures.fleets[usernameHint] ? usernameHint : "fleet1";
  if (!fleetStores[username]) fleetStores[username] = clone(fixtures.fleets[username]);
  return { username, data: fleetStores[username] };
}

export function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
