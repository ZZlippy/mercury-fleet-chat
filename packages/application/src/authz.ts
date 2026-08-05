import bcrypt from "bcryptjs";
import type { Db } from "@mercury/db";
import type { Actor } from "./kernel.ts";

export interface SessionInfo {
  sessionId: string;
  user: { id: string; username: string; email: string | null; displayName: string };
  organization: { id: string; name: string; type: string };
  role: "FLEET_ADMIN" | "DISPATCHER" | "VIEWER" | "OPERATOR";
}

export async function login(db: Db, username: string, password: string): Promise<SessionInfo | null> {
  const r = await db.query(
    `SELECT u.id, u.username, u.email, u.display_name, u.password_hash, m.role, o.id AS org_id, o.name AS org_name, o.type AS org_type
       FROM users u
       JOIN organization_memberships m ON m.user_id=u.id AND m.status='ACTIVE'
       JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
      WHERE u.username=$1 AND u.status='ACTIVE'
      ORDER BY o.type='FLEET' DESC
      LIMIT 1`,
    [username],
  );
  const row = r.rows[0];
  if (!row?.password_hash || !(await bcrypt.compare(password, row.password_hash))) return null;
  const ttlHours = Number(process.env.SESSION_TTL_HOURS ?? 72);
  const s = await db.query(
    `INSERT INTO sessions (user_id, expires_at) VALUES ($1, now() + ($2 || ' hours')::interval) RETURNING id`,
    [row.id, String(ttlHours)],
  );
  return {
    sessionId: s.rows[0].id,
    user: { id: row.id, username: row.username, email: row.email, displayName: row.display_name },
    organization: { id: row.org_id, name: row.org_name, type: row.org_type },
    role: row.role,
  };
}

export async function resolveSession(db: Db, sessionId: string | undefined): Promise<SessionInfo | null> {
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const r = await db.query(
    `SELECT s.id AS session_id, u.id, u.username, u.email, u.display_name, m.role, o.id AS org_id, o.name AS org_name, o.type AS org_type
       FROM sessions s
       JOIN users u ON u.id=s.user_id AND u.status='ACTIVE'
       JOIN organization_memberships m ON m.user_id=u.id AND m.status='ACTIVE'
       JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
      WHERE s.id=$1 AND s.expires_at > now()
      ORDER BY o.type='FLEET' DESC
      LIMIT 1`,
    [sessionId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    user: { id: row.id, username: row.username, email: row.email, displayName: row.display_name },
    organization: { id: row.org_id, name: row.org_name, type: row.org_type },
    role: row.role,
  };
}

export async function logout(db: Db, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE id=$1`, [sessionId]);
}

/** Identity always derives from the session — never from client input (§17). */
export function actorFromSession(s: SessionInfo): Actor {
  return {
    actorType: s.role === "OPERATOR" ? "OPERATOR" : "USER",
    userId: s.user.id,
    organizationId: s.organization.id,
    role: s.role,
  };
}

export const canMutate = (role: SessionInfo["role"]): boolean =>
  role === "FLEET_ADMIN" || role === "DISPATCHER" || role === "OPERATOR";
