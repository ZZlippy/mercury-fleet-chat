import "dotenv/config";
import bcrypt from "bcryptjs";
import { closeDb, getDb, withTx } from "@mercury/db";

/** Idempotent local demo seed. Password for every v1.1 account: mercury */
const db = getDb();
const hash = bcrypt.hashSync("mercury", 10);

await withTx(db, async (tx) => {
  const org = async (type: string, name: string) => {
    const found = await tx.query(
      `SELECT id FROM organizations WHERE type=$1::organization_type AND name=$2`,
      [type, name],
    );
    if (found.rowCount) return found.rows[0].id as string;
    return (
      await tx.query(
        `INSERT INTO organizations (type, name) VALUES ($1,$2) RETURNING id`,
        [type, name],
      )
    ).rows[0].id as string;
  };

  const mercury = await org("MERCURY", "Mercury Operations");
  const customer = await org("CUSTOMER", "Demo Customer Pte Ltd");
  const fleetOrganizations: string[] = [];
  for (let index = 1; index <= 10; index += 1) {
    fleetOrganizations.push(await org("FLEET", `Fleet ${index}`));
  }

  const user = async (
    username: string,
    name: string,
    orgId: string,
    role: "FLEET_ADMIN" | "OPERATOR",
  ) => {
    const found = await tx.query(`SELECT id FROM users WHERE username=$1`, [username]);
    const id = found.rowCount
      ? found.rows[0].id
      : (
          await tx.query(
            `INSERT INTO users (username, display_name, password_hash)
             VALUES ($1,$2,$3) RETURNING id`,
            [username, name, hash],
          )
        ).rows[0].id;
    await tx.query(
      `UPDATE users
          SET display_name=$2, password_hash=$3, status='ACTIVE', updated_at=now()
        WHERE id=$1`,
      [id, name, hash],
    );
    await tx.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1,$2,$3::membership_role)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET role=$3::membership_role, status='ACTIVE'`,
      [orgId, id, role],
    );
    return id as string;
  };

  for (let index = 1; index <= 10; index += 1) {
    const fleetId = fleetOrganizations[index - 1];
    const fleetUserId = await user(
      `fleet${index}`,
      `车队 ${index}`,
      fleetId,
      "FLEET_ADMIN",
    );

    const profile = (
      await tx.query(
        `INSERT INTO fleet_profiles (fleet_organization_id, accepting_orders)
         VALUES ($1,true)
         ON CONFLICT (fleet_organization_id)
         DO UPDATE SET updated_at=now()
         RETURNING id, approved_version_id`,
        [fleetId],
      )
    ).rows[0];
    if (!profile.approved_version_id) {
      const version = (
        await tx.query(
          `INSERT INTO fleet_profile_versions (
             fleet_profile_id, version, status, fleet_name,
             supports_hazardous, supports_reefer, contact_name, contact_phone,
             notes, submitted_by_user_id, reviewed_by_user_id, submitted_at, reviewed_at
           )
           VALUES ($1,1,'APPROVED',$2,$3,$4,$5,$6,$7,$8,NULL,now(),now())
           RETURNING id`,
          [
            profile.id,
            `Fleet ${index}`,
            index % 2 === 0,
            index % 3 === 0,
            `联系人 ${index}`,
            `+65 6000 ${String(index).padStart(4, "0")}`,
            "本地演示档案",
            fleetUserId,
          ],
        )
      ).rows[0];
      await tx.query(
        `INSERT INTO fleet_profile_version_countries
           (fleet_profile_version_id, country_code)
         VALUES ($1,'SG')`,
        [version.id],
      );
      await tx.query(
        `UPDATE fleet_profiles SET approved_version_id=$2 WHERE id=$1`,
        [profile.id, version.id],
      );
    }

    const conversation = await tx.query(
      `SELECT id FROM conversations
        WHERE fleet_organization_id=$1 AND channel='WEB' AND status='ACTIVE'`,
      [fleetId],
    );
    if (!conversation.rowCount) {
      await tx.query(
        `INSERT INTO conversations (fleet_organization_id, channel)
         VALUES ($1,'WEB')`,
        [fleetId],
      );
    }
  }

  for (let index = 1; index <= 3; index += 1) {
    await user(`operator${index}`, `Mercury 运营 ${index}`, mercury, "OPERATOR");
  }

  const existing = await tx.query(
    `SELECT id FROM orders WHERE public_reference='M-1001'`,
  );
  if (!existing.rowCount) {
    await tx.query(
      `INSERT INTO orders (
         public_reference, customer_organization_id, status,
         order_type, service_country,
         pickup_location_text, delivery_location_text,
         destination_terminal, delivery_location,
         empty_container_return_location,
         container_type, container_quantity,
         pickup_at, requested_start_at, requested_complete_at,
         special_requirements
       )
       VALUES (
         'M-1001',$1,'DRAFT','IMPORT_DRAYAGE','SG',
         'PSA Pasir Panjang Terminal','Jurong Industrial Estate',
         'PSA Pasir Panjang Terminal','Jurong Industrial Estate',
         'Tuas Empty Container Depot',
         '40HQ',2,
         '2026-08-04T01:00:00Z','2026-08-04T01:00:00Z','2026-08-04T09:00:00Z',
         '演示订单'
       )`,
      [customer],
    );
  }
});

console.log("Seed complete. Password for all demo accounts: mercury");
console.log("Fleet accounts: fleet1 ... fleet10");
console.log("Operator accounts: operator1 ... operator3");
await closeDb();
