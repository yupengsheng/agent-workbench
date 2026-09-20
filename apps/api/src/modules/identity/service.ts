import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { argon2id, argon2Verify } from 'hash-wasm';
import type { AuthResponse, UserSummary } from '@agent-workbench/contracts';
import type { DatabaseHandle } from '../../db/client.js';
import { sessions, users } from '../../db/schema.js';

export const SESSION_COOKIE_NAME = 'aw_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface AuthenticatedUser extends UserSummary {
  sessionId: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toUserSummary(user: {
  id: string;
  email: string;
  displayName: string;
}): UserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}

export function toAuthResponse(user: UserSummary): AuthResponse {
  return { user };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    iterations: 2,
    memorySize: 19_456,
    parallelism: 1,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ hash: passwordHash, password });
  } catch {
    return false;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function createSession(database: DatabaseHandle, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await database.db.insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export async function getAuthenticatedUser(
  request: FastifyRequest,
  database: DatabaseHandle,
): Promise<AuthenticatedUser | undefined> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) return undefined;

  const [row] = await database.db
    .select({
      sessionId: sessions.id,
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        gt(sessions.expiresAt, new Date()),
        eq(users.status, 'active'),
      ),
    )
    .limit(1);

  if (!row) return undefined;

  await database.db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.sessionId));

  return row;
}
