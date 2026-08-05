import type { Db, Tx } from "@mercury/db";
import { err } from "@mercury/contracts";
import { type Actor, audit, CommandFailure, emitOutbox } from "./kernel.ts";

export interface FleetProfileDraft {
  fleetName: string;
  acceptingOrders: boolean;
  operatingCountries: string[];
  supportsHazardous: boolean;
  supportsReefer: boolean;
  contactName: string;
  contactPhone: string;
  notes?: string | null;
}

const normalizeCountries = (countries: string[]): string[] =>
  [...new Set(countries.map((country) => country.trim().toUpperCase()))].sort();

function validateProfile(input: FleetProfileDraft): string[] {
  const errors: string[] = [];
  if (!input.fleetName.trim()) errors.push("车队名称不能为空");
  if (!input.contactName.trim()) errors.push("联系人不能为空");
  if (!input.contactPhone.trim()) errors.push("联系电话不能为空");
  const countries = normalizeCountries(input.operatingCountries);
  if (!countries.length) errors.push("至少选择一个营运国家");
  if (countries.some((country) => !/^[A-Z]{2}$/.test(country))) {
    errors.push("营运国家必须使用两个字母的 ISO 国家代码");
  }
  return errors;
}

async function lockFleetProfile(tx: Tx, fleetOrganizationId: string) {
  const organization = (
    await tx.query(
      `SELECT * FROM organizations WHERE id=$1 AND type='FLEET' FOR UPDATE`,
      [fleetOrganizationId],
    )
  ).rows[0];
  if (!organization) throw new CommandFailure(err("NOT_FOUND", "Fleet organization not found"));
  const existing = (
    await tx.query(
      `SELECT * FROM fleet_profiles WHERE fleet_organization_id=$1 FOR UPDATE`,
      [fleetOrganizationId],
    )
  ).rows[0];
  if (existing) return { organization, profile: existing };
  const profile = (
    await tx.query(
      `INSERT INTO fleet_profiles (fleet_organization_id) VALUES ($1) RETURNING *`,
      [fleetOrganizationId],
    )
  ).rows[0];
  return { organization, profile };
}

export async function submitFleetProfile(
  tx: Tx,
  actor: Actor,
  input: FleetProfileDraft,
): Promise<{ profileId: string; versionId: string; version: number; status: "PENDING_REVIEW" }> {
  if (!actor.organizationId) throw new CommandFailure(err("FORBIDDEN", "Organization required"));
  const validation = validateProfile(input);
  if (validation.length) throw new CommandFailure(err("VALIDATION", validation.join("；")));
  const { profile } = await lockFleetProfile(tx, actor.organizationId);

  // The accepting-orders switch is operational status and applies immediately.
  await tx.query(
    `UPDATE fleet_profiles SET accepting_orders=$2, updated_at=now() WHERE id=$1`,
    [profile.id, input.acceptingOrders],
  );
  await tx.query(
    `UPDATE fleet_profile_versions
        SET status='REJECTED', reviewed_at=now(),
            review_note='Superseded by a newer fleet submission'
      WHERE fleet_profile_id=$1 AND status='PENDING_REVIEW'`,
    [profile.id],
  );
  const nextVersion = (
    await tx.query(
      `SELECT COALESCE(max(version),0)::int + 1 AS version
         FROM fleet_profile_versions WHERE fleet_profile_id=$1`,
      [profile.id],
    )
  ).rows[0].version as number;
  const version = (
    await tx.query(
      `INSERT INTO fleet_profile_versions (
         fleet_profile_id, version, status, fleet_name,
         supports_hazardous, supports_reefer, contact_name, contact_phone,
         notes, submitted_by_user_id, submitted_at
       )
       VALUES ($1,$2,'PENDING_REVIEW',$3,$4,$5,$6,$7,$8,$9,now())
       RETURNING id`,
      [
        profile.id,
        nextVersion,
        input.fleetName.trim(),
        input.supportsHazardous,
        input.supportsReefer,
        input.contactName.trim(),
        input.contactPhone.trim(),
        input.notes?.trim() || null,
        actor.userId,
      ],
    )
  ).rows[0];
  for (const country of normalizeCountries(input.operatingCountries)) {
    await tx.query(
      `INSERT INTO fleet_profile_version_countries (
         fleet_profile_version_id, country_code
       ) VALUES ($1,$2)`,
      [version.id, country],
    );
  }
  await audit(tx, {
    actor,
    action: "fleet_profile.submitted",
    objectType: "FLEET_PROFILE_VERSION",
    objectId: version.id,
    after: {
      version: nextVersion,
      acceptingOrders: input.acceptingOrders,
      operatingCountries: normalizeCountries(input.operatingCountries),
    },
  });
  await emitOutbox(tx, "fleet_profile.submitted", "FLEET_PROFILE_VERSION", version.id, {
    fleetOrganizationId: actor.organizationId,
    version: nextVersion,
  });
  return {
    profileId: profile.id,
    versionId: version.id,
    version: nextVersion,
    status: "PENDING_REVIEW",
  };
}

export async function setFleetAcceptingOrders(
  tx: Tx,
  actor: Actor,
  acceptingOrders: boolean,
): Promise<{ acceptingOrders: boolean }> {
  if (!actor.organizationId) throw new CommandFailure(err("FORBIDDEN", "Organization required"));
  const { profile } = await lockFleetProfile(tx, actor.organizationId);
  await tx.query(
    `UPDATE fleet_profiles SET accepting_orders=$2, updated_at=now() WHERE id=$1`,
    [profile.id, acceptingOrders],
  );
  await audit(tx, {
    actor,
    action: "fleet_profile.accepting_orders_changed",
    objectType: "FLEET_PROFILE",
    objectId: profile.id,
    before: { acceptingOrders: profile.accepting_orders },
    after: { acceptingOrders },
  });
  return { acceptingOrders };
}

export async function reviewFleetProfile(
  tx: Tx,
  actor: Actor,
  input: { versionId: string; approved: boolean; note?: string | null },
): Promise<{ versionId: string; status: "APPROVED" | "REJECTED" }> {
  if (actor.actorType !== "OPERATOR") {
    throw new CommandFailure(err("FORBIDDEN", "Operator review required"));
  }
  const version = (
    await tx.query(
      `SELECT v.*, p.fleet_organization_id
         FROM fleet_profile_versions v
         JOIN fleet_profiles p ON p.id=v.fleet_profile_id
        WHERE v.id=$1 FOR UPDATE OF v, p`,
      [input.versionId],
    )
  ).rows[0];
  if (!version) throw new CommandFailure(err("NOT_FOUND", "Fleet profile version not found"));
  if (version.status !== "PENDING_REVIEW") {
    throw new CommandFailure(err("INVALID_TRANSITION", `Profile is ${version.status}`));
  }
  const status = input.approved ? "APPROVED" : "REJECTED";
  await tx.query(
    `UPDATE fleet_profile_versions
        SET status=$2, reviewed_by_user_id=$3, reviewed_at=now(), review_note=$4
      WHERE id=$1`,
    [version.id, status, actor.userId, input.note ?? null],
  );
  if (input.approved) {
    await tx.query(
      `UPDATE fleet_profiles SET approved_version_id=$2, updated_at=now() WHERE id=$1`,
      [version.fleet_profile_id, version.id],
    );
  }
  await audit(tx, {
    actor,
    action: input.approved ? "fleet_profile.approved" : "fleet_profile.rejected",
    objectType: "FLEET_PROFILE_VERSION",
    objectId: version.id,
    before: { status: version.status },
    after: { status, note: input.note ?? null },
  });
  await emitOutbox(
    tx,
    input.approved ? "fleet_profile.approved" : "fleet_profile.rejected",
    "FLEET_PROFILE_VERSION",
    version.id,
    { fleetOrganizationId: version.fleet_organization_id },
  );
  return { versionId: version.id, status };
}

export async function getFleetProfile(db: Db, fleetOrganizationId: string) {
  const result = await db.query(
    `SELECT p.id, p.accepting_orders, p.approved_version_id,
            approved.id AS approved_id, approved.version AS approved_version,
            approved.fleet_name AS approved_fleet_name,
            approved.supports_hazardous AS approved_supports_hazardous,
            approved.supports_reefer AS approved_supports_reefer,
            approved.contact_name AS approved_contact_name,
            approved.contact_phone AS approved_contact_phone,
            approved.notes AS approved_notes,
            pending.id AS pending_id, pending.version AS pending_version,
            pending.status AS pending_status, pending.fleet_name AS pending_fleet_name,
            pending.supports_hazardous AS pending_supports_hazardous,
            pending.supports_reefer AS pending_supports_reefer,
            pending.contact_name AS pending_contact_name,
            pending.contact_phone AS pending_contact_phone,
            pending.notes AS pending_notes, pending.review_note AS pending_review_note,
            COALESCE((
              SELECT json_agg(c.country_code ORDER BY c.country_code)
                FROM fleet_profile_version_countries c
               WHERE c.fleet_profile_version_id=approved.id
            ), '[]') AS approved_countries,
            COALESCE((
              SELECT json_agg(c.country_code ORDER BY c.country_code)
                FROM fleet_profile_version_countries c
               WHERE c.fleet_profile_version_id=pending.id
            ), '[]') AS pending_countries
       FROM fleet_profiles p
       LEFT JOIN fleet_profile_versions approved ON approved.id=p.approved_version_id
       LEFT JOIN LATERAL (
         SELECT * FROM fleet_profile_versions v
          WHERE v.fleet_profile_id=p.id
          ORDER BY v.version DESC LIMIT 1
       ) pending ON true
      WHERE p.fleet_organization_id=$1`,
    [fleetOrganizationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const approved = row.approved_id
    ? {
        id: row.approved_id,
        version: row.approved_version,
        fleet_name: row.approved_fleet_name,
        supports_hazardous: row.approved_supports_hazardous,
        supports_reefer: row.approved_supports_reefer,
        contact_name: row.approved_contact_name,
        contact_phone: row.approved_contact_phone,
        notes: row.approved_notes,
        operating_countries: row.approved_countries,
        status: "APPROVED",
      }
    : null;
  const latest = row.pending_id
    ? {
        id: row.pending_id,
        version: row.pending_version,
        fleet_name: row.pending_fleet_name,
        supports_hazardous: row.pending_supports_hazardous,
        supports_reefer: row.pending_supports_reefer,
        contact_name: row.pending_contact_name,
        contact_phone: row.pending_contact_phone,
        notes: row.pending_notes,
        review_note: row.pending_review_note,
        operating_countries: row.pending_countries,
        status: row.pending_status,
      }
    : null;
  return {
    id: row.id,
    accepting_orders: row.accepting_orders,
    approved,
    pending: latest?.status === "PENDING_REVIEW" ? latest : null,
    latest_rejected: latest?.status === "REJECTED" ? latest : null,
  };
}

export async function buildFleetCandidates(
  db: Db,
  orderId: string,
): Promise<Array<{ id: string; name: string; eligible: boolean; reasons: string[] }>> {
  const order = (
    await db.query(
      `SELECT service_country, is_hazardous, is_reefer FROM orders WHERE id=$1`,
      [orderId],
    )
  ).rows[0];
  if (!order) throw new CommandFailure(err("NOT_FOUND", "Order not found"));
  const fleets = await db.query(
    `SELECT o.id, COALESCE(v.fleet_name,o.name) AS name, o.status AS organization_status,
            p.accepting_orders, p.approved_version_id,
            v.supports_hazardous, v.supports_reefer,
            EXISTS (
              SELECT 1 FROM fleet_profile_version_countries c
               WHERE c.fleet_profile_version_id=v.id
                 AND c.country_code=$1
            ) AS supports_country
       FROM organizations o
       LEFT JOIN fleet_profiles p ON p.fleet_organization_id=o.id
       LEFT JOIN fleet_profile_versions v ON v.id=p.approved_version_id
      WHERE o.type='FLEET'
      ORDER BY COALESCE(v.fleet_name,o.name), o.name`,
    [order.service_country],
  );
  return fleets.rows.map((fleet) => {
    const reasons: string[] = [];
    if (fleet.organization_status !== "ACTIVE") reasons.push("系统账号已停用");
    if (!fleet.accepting_orders) reasons.push("车队已暂停接单");
    if (!fleet.approved_version_id) reasons.push("没有已审核通过的车队档案");
    if (fleet.approved_version_id && !fleet.supports_country) {
      reasons.push(`营运范围不包含 ${order.service_country}`);
    }
    if (order.is_hazardous && !fleet.supports_hazardous) reasons.push("不具备危险品能力");
    if (order.is_reefer && !fleet.supports_reefer) reasons.push("不具备冷藏箱能力");
    return { id: fleet.id, name: fleet.name, eligible: reasons.length === 0, reasons };
  });
}
