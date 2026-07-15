import { HttpError } from './http';
import type { Env, Session, SessionUser } from './types';

function sessionCookie(request: Request): string {
  const match = request.headers.get('cookie')?.match(/(?:^|;\s*)bdfz_uc_session=([^;]+)/);
  return match ? `bdfz_uc_session=${match[1]}` : '';
}

function adminSet(env: Env): Set<string> {
  return new Set(String(env.ADMIN_SLUGS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export async function getSession(request: Request, env: Env): Promise<Session> {
  const cookie = sessionCookie(request);
  if (!cookie) return { authenticated: false, user: null, admin: false };
  const sessionRequest = new Request('https://user-center.internal/api/session', {
    headers: { cookie, accept: 'application/json' },
  });
  const response = env.USER_CENTER
    ? await env.USER_CENTER.fetch(sessionRequest)
    : await fetch(`${env.USER_CENTER_ORIGIN}/api/session`, sessionRequest);
  if (!response.ok) return { authenticated: false, user: null, admin: false };
  const data = await response.json<{ authenticated?: boolean; user?: SessionUser | null }>()
    .catch(() => ({} as { authenticated?: boolean; user?: SessionUser | null }));
  const user = data.authenticated && data.user?.slug ? data.user : null;
  return {
    authenticated: Boolean(user),
    user,
    admin: Boolean(user && adminSet(env).has(user.slug.toLowerCase())),
  };
}

export function requireAuthenticated(session: Session): SessionUser {
  if (!session.authenticated || !session.user) throw new HttpError(401, '请先通过统一用户中心登录');
  return session.user;
}

export function requireAdmin(session: Session): SessionUser {
  const user = requireAuthenticated(session);
  if (!session.admin) throw new HttpError(403, '此操作仅限已配置的内容管理员');
  return user;
}
