import type { Env } from './types';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': status === 200 ? 'no-store' : 'no-store',
      ...headers,
    },
  });
}

export async function readJson<T>(request: Request, maxBytes = 24_000): Promise<T> {
  const announced = Number(request.headers.get('content-length') || 0);
  if (announced > maxBytes) throw new HttpError(413, '请求体过大');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, '请求体过大');
  try {
    return JSON.parse(text || '{}') as T;
  } catch {
    throw new HttpError(400, 'JSON 格式无效');
  }
}

export function requireSameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  if (!origin || (origin !== requestOrigin && origin !== env.SITE_ORIGIN)) {
    throw new HttpError(403, '来源校验失败');
  }
}

export function textParam(value: string | null, max = 120): string {
  return String(value || '').trim().slice(0, max);
}

export function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function secureHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('cross-origin-opener-policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
