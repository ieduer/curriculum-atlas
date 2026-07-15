import { HttpError } from './http';
import type { Env } from './types';

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function hashPrivate(value: string, env: Env): Promise<string> {
  if (!env.HASH_SALT) throw new HttpError(503, '安全哈希尚未配置');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.HASH_SALT),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

export async function sha256(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function enforceRateLimit(
  env: Env,
  bucket: string,
  actor: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const actorHash = await hashPrivate(`${bucket}:${actor}`, env);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const result = await env.DB.prepare(
    `INSERT INTO rate_limits(bucket, actor_hash, window_start, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(bucket, actor_hash, window_start)
     DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(bucket, actorHash, windowStart).first<{ count: number }>();
  if (!result || result.count > limit) throw new HttpError(429, '操作过于频繁，请稍后再试');
}

export async function verifyTurnstile(request: Request, env: Env, token: string): Promise<void> {
  if (!env.TURNSTILE_SECRET) throw new HttpError(503, '匿名讨论暂未开放');
  if (!token) throw new HttpError(400, '请完成人机验证');
  const ip = request.headers.get('cf-connecting-ip') || '';
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const result = await response.json<{ success?: boolean }>().catch(() => ({} as { success?: boolean }));
  if (!response.ok || !result.success) throw new HttpError(403, '人机验证失败或已过期');
}
