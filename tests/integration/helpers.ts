import { getDb, migrate, withTx, type Db } from "@mercury/db";
import type { Actor } from "@mercury/application";

export interface Fixtures {
  db: Db;
  fleetA: string;
  fleetB: string;
  customer: string;
  mercury: string;
  userA: string;
  userB: string;
  operatorUser: string;
  convA: string;
  convB: string;
  orderId: string;
  dispatcherA: Actor;
  dispatcherB: Actor;
  operator: Actor;
}

const TABLES = [
  "processed_commands", "outbox_events", "audit_logs", "exception_cases",
  "pending_interactions", "task_read_states", "fleet_profile_version_countries", "fleet_profile_versions", "fleet_profiles",
  "document_links", "documents", "shipment_events", "shipments",
  "booking_assignments", "bookings", "quotes", "message_actions",
  "message_context_links", "messages", "rfq_recipients", "rfqs",
  "conversations", "orders", "vehicles", "drivers", "sessions",
  "organization_memberships", "users", "organizations",
];

export async function resetDb(db: Db): Promise<void> {
  await db.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function setupFixtures(): Promise<Fixtures> {
  const db = getDb();
  await migrate(db);
  await resetDb(db);
  return withTx(db, async (tx) => {
    const org = async (type: string, name: string) =>
      (await tx.query(`INSERT INTO organizations (type, name) VALUES ($1,$2) RETURNING id`, [type, name])).rows[0].id as string;
    const mercury = await org("MERCURY", "Mercury Operations");
    const fleetA = await org("FLEET", "ABC Logistics");
    const fleetB = await org("FLEET", "XYZ Transport");
    const customer = await org("CUSTOMER", "Demo Customer");
    await tx.query(
      `INSERT INTO fleet_profiles (fleet_organization_id, accepting_orders)
       VALUES ($1,true),($2,true)`,
      [fleetA, fleetB],
    );

    const user = async (email: string, orgId: string, role: string) => {
      const id = (
        await tx.query(`INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,'x') RETURNING id`, [email, email])
      ).rows[0].id as string;
      await tx.query(`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1,$2,$3::membership_role)`, [orgId, id, role]);
      return id;
    };
    const userA = await user("a@test", fleetA, "DISPATCHER");
    const userB = await user("b@test", fleetB, "DISPATCHER");
    const operatorUser = await user("op@test", mercury, "OPERATOR");

    await tx.query(`INSERT INTO drivers (fleet_organization_id, name) VALUES ($1,'陈师傅'),($1,'刘师傅')`, [fleetA]);
    await tx.query(`INSERT INTO vehicles (fleet_organization_id, plate_number) VALUES ($1,'SGB1234A'),($1,'SGB5678B')`, [fleetA]);

    const convA = (
      await tx.query(`INSERT INTO conversations (fleet_organization_id, channel) VALUES ($1,'WEB') RETURNING id`, [fleetA])
    ).rows[0].id as string;
    const convB = (
      await tx.query(`INSERT INTO conversations (fleet_organization_id, channel) VALUES ($1,'WEB') RETURNING id`, [fleetB])
    ).rows[0].id as string;

    const orderId = (
      await tx.query(
        `INSERT INTO orders (
           public_reference, customer_organization_id, status,
           order_type, service_country,
           pickup_location_text, delivery_location_text,
           destination_terminal, delivery_location, empty_container_return_location,
           container_type, container_quantity, pickup_at,
           requested_start_at, requested_complete_at
         )
         VALUES (
           'M-1001',$1,'QUOTING','IMPORT_DRAYAGE','SG',
           'PSA Pasir Panjang','Jurong Industrial Estate',
           'PSA Pasir Panjang','Jurong Industrial Estate','Tuas Empty Depot',
           '40HQ',2,'2026-08-04T01:00:00Z',
           '2026-08-04T01:00:00Z','2026-08-04T09:00:00Z'
         )
         RETURNING id`,
        [customer],
      )
    ).rows[0].id as string;

    return {
      db, fleetA, fleetB, customer, mercury, userA, userB, operatorUser, convA, convB, orderId,
      dispatcherA: { actorType: "USER", userId: userA, organizationId: fleetA, role: "DISPATCHER" },
      dispatcherB: { actorType: "USER", userId: userB, organizationId: fleetB, role: "DISPATCHER" },
      operator: { actorType: "OPERATOR", userId: operatorUser, organizationId: mercury, role: "OPERATOR" },
    };
  });
}

let seq = 0;
export const cid = (): string => `00000000-0000-4000-8000-${String(++seq + Date.now()).slice(-12).padStart(12, "0")}`;

export async function findActions(db: Db, conversationId: string, actionType: string, status = "AVAILABLE") {
  const r = await db.query(
    `SELECT ma.* FROM message_actions ma JOIN messages m ON m.id=ma.message_id
      WHERE m.conversation_id=$1 AND ma.action_type=$2 AND ma.status=$3
      ORDER BY ma.created_at DESC`,
    [conversationId, actionType, status],
  );
  return r.rows;
}

export async function lastOutbound(db: Db, conversationId: string, n = 1) {
  const r = await db.query(
    `SELECT * FROM messages WHERE conversation_id=$1 AND direction='OUTBOUND' ORDER BY created_at DESC LIMIT $2`,
    [conversationId, n],
  );
  return r.rows;
}
