import type { AuthResponse } from '@agent-workbench/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { users, sessions } from '../../db/schema.js';
import {
  createSession,
  getAuthenticatedUser,
  hashSessionToken,
  normalizeEmail,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  toAuthResponse,
  toUserSummary,
  verifyPassword,
} from './service.js';

interface LoginBody {
  email: string;
  password: string;
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'database_unavailable', message: '服务暂时不可用' },
  });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: { code: 'unauthorized', message: '邮箱或密码错误' },
  });
}

function parseLoginBody(body: unknown): LoginBody | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.email !== 'string' || typeof candidate.password !== 'string') {
    return undefined;
  }
  const email = normalizeEmail(candidate.email);
  if (
    !email ||
    email.length > 320 ||
    candidate.password.length < 1 ||
    candidate.password.length > 1024
  ) {
    return undefined;
  }
  return { email, password: candidate.password };
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  app.post('/api/v1/auth/login', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    if (!database) return unavailable(reply);
    const body = parseLoginBody(request.body);
    if (!body) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'email 和 password 为必填项' },
      });
    }

    const [user] = await database.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        status: users.status,
      })
      .from(users)
      .where(eq(users.emailNormalized, body.email))
      .limit(1);

    if (
      !user ||
      user.status !== 'active' ||
      !(await verifyPassword(user.passwordHash, body.password))
    ) {
      return unauthorized(reply);
    }

    const { token } = await createSession(database, user.id);
    reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    const response: AuthResponse = toAuthResponse(toUserSummary(user));
    return reply.send(response);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (database) {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        await database.db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
      }
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    if (!database) return unavailable(reply);
    const user = await getAuthenticatedUser(request, database);
    if (!user) return unauthorized(reply);
    return reply.send(toAuthResponse(user));
  });
}
