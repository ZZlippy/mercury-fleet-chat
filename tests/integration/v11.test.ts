import { beforeAll, describe, expect, it } from "vitest";
import {
  buildFleetCandidates,
  consumeMessageAction,
  handleInbound,
  recordInbound,
  resolveNumberedChoice,
  reviewFleetProfile,
  sendRfqToFleet,
  submitFleetProfile,
} from "@mercury/application";
import { withTx } from "@mercury/db";
import { cid, lastOutbound, setupFixtures, type Fixtures } from "./helpers.ts";

let f: Fixtures;

async function approvedProfile(
  fleetId: string,
  userId: string,
  countries: string[],
  supportsHazardous = false,
) {
  return withTx(f.db, async (tx) => {
    const profile = (
      await tx.query(
        `SELECT id FROM fleet_profiles WHERE fleet_organization_id=$1 FOR UPDATE`,
        [fleetId],
      )
    ).rows[0];
    const version = (
      await tx.query(
        `INSERT INTO fleet_profile_versions (
           fleet_profile_id, version, status, fleet_name,
           supports_hazardous, supports_reefer, contact_name, contact_phone,
           submitted_by_user_id, submitted_at, reviewed_at
         )
         VALUES ($1,1,'APPROVED',$2,$3,false,'联系人','+65 6000', $4,now(),now())
         RETURNING id`,
        [profile.id, `Profile ${fleetId.slice(0, 4)}`, supportsHazardous, userId],
      )
    ).rows[0];
    for (const country of countries) {
      await tx.query(
        `INSERT INTO fleet_profile_version_countries
           (fleet_profile_version_id, country_code)
         VALUES ($1,$2)`,
        [version.id, country],
      );
    }
    await tx.query(
      `UPDATE fleet_profiles SET approved_version_id=$2 WHERE id=$1`,
      [profile.id, version.id],
    );
    return { profileId: profile.id, versionId: version.id };
  });
}

describe("v1.1 fleet profiles and deterministic matching", () => {
  beforeAll(async () => {
    f = await setupFixtures();
    await approvedProfile(f.fleetA, f.userA, ["SG"], false);
    await approvedProfile(f.fleetB, f.userB, ["MY"], true);
  });

  it("matches service country and capability without ranking", async () => {
    let candidates = await buildFleetCandidates(f.db, f.orderId);
    expect(candidates.find((candidate) => candidate.id === f.fleetA)?.eligible).toBe(true);
    expect(candidates.find((candidate) => candidate.id === f.fleetB)?.reasons)
      .toContain("营运范围不包含 SG");

    await f.db.query(`UPDATE orders SET is_hazardous=true, un_number='UN1203' WHERE id=$1`, [f.orderId]);
    candidates = await buildFleetCandidates(f.db, f.orderId);
    expect(candidates.find((candidate) => candidate.id === f.fleetA)?.reasons)
      .toContain("不具备危险品能力");
  });

  it("keeps the approved profile active while a new version awaits review", async () => {
    const submission = await withTx(f.db, (tx) =>
      submitFleetProfile(tx, f.dispatcherA, {
        fleetName: "ABC New Name",
        acceptingOrders: true,
        operatingCountries: ["SG", "MY"],
        supportsHazardous: true,
        supportsReefer: false,
        contactName: "新联系人",
        contactPhone: "+65 6111",
        notes: null,
      }),
    );
    const beforeReview = await f.db.query(
      `SELECT approved_version_id FROM fleet_profiles WHERE fleet_organization_id=$1`,
      [f.fleetA],
    );
    expect(beforeReview.rows[0].approved_version_id).not.toBe(submission.versionId);

    await withTx(f.db, (tx) =>
      reviewFleetProfile(tx, f.operator, {
        versionId: submission.versionId,
        approved: true,
      }),
    );
    const afterReview = await f.db.query(
      `SELECT approved_version_id FROM fleet_profiles WHERE fleet_organization_id=$1`,
      [f.fleetA],
    );
    expect(afterReview.rows[0].approved_version_id).toBe(submission.versionId);
  });
});

describe("v1.1 numbered choices", () => {
  beforeAll(async () => {
    f = await setupFixtures();
    await sendRfqToFleet(
      f.db,
      f.operator,
      { orderId: f.orderId, fleetOrganizationId: f.fleetA },
      cid(),
    );
  });

  it("maps reply 1 to the versioned RFQ action, then treats 220 as a quote amount", async () => {
    const [rfqMessage] = await lastOutbound(f.db, f.convA);
    expect(rfqMessage.text_content).toContain("1. 我要报价");

    const first = await recordInbound(f.db, f.dispatcherA, {
      conversationId: f.convA,
      clientMessageId: cid(),
      text: "1",
      replyToMessageId: rfqMessage.id,
    });
    const numbered = await resolveNumberedChoice(f.db, f.dispatcherA, {
      conversationId: f.convA,
      sourceMessageId: first.messageId,
      text: "1",
    });
    expect(numbered.kind).toBe("RESOLVED");
    if (numbered.kind !== "RESOLVED") return;
    await consumeMessageAction(f.db, f.dispatcherA, {
      actionId: numbered.actionId,
      clientIdempotencyKey: cid(),
    });

    const amount = await recordInbound(f.db, f.dispatcherA, {
      conversationId: f.convA,
      clientMessageId: cid(),
      text: "220",
      replyToMessageId: rfqMessage.id,
    });
    const amountResolution = await resolveNumberedChoice(f.db, f.dispatcherA, {
      conversationId: f.convA,
      sourceMessageId: amount.messageId,
      text: "220",
    });
    expect(amountResolution.kind).toBe("NOT_NUMBERED");
    await handleInbound(f.db, f.dispatcherA, {
      conversationId: f.convA,
      messageId: amount.messageId,
    });
    const quote = (await f.db.query(`SELECT * FROM quotes`)).rows[0];
    expect(quote.amount).toBe("220.00");
    expect(quote.status).toBe("PENDING_CONFIRMATION");
  });

  it("rejects an out-of-range number without business mutation", async () => {
    const [confirmation] = await lastOutbound(f.db, f.convA);
    const before = (await f.db.query(`SELECT count(*)::int AS n FROM quotes`)).rows[0].n;
    const inbound = await recordInbound(f.db, f.dispatcherA, {
      conversationId: f.convA,
      clientMessageId: cid(),
      text: "9",
      replyToMessageId: confirmation.id,
    });
    const result = await resolveNumberedChoice(f.db, f.dispatcherA, {
      conversationId: f.convA,
      sourceMessageId: inbound.messageId,
      text: "9",
    });
    expect(result.kind).toBe("OUT_OF_RANGE");
    const after = (await f.db.query(`SELECT count(*)::int AS n FROM quotes`)).rows[0].n;
    expect(after).toBe(before);
  });
});
