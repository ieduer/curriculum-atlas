import {
  acquireCreateLease,
  handleReleaseCoordinator,
  releaseCreateLease,
} from '../../src/release-coordinator';
import type { Env } from '../../src/types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__test/hold-create') {
      const releaseId = request.headers.get('x-release-id') || '';
      const manifestSha256 = request.headers.get('x-release-manifest-sha256') || '';
      const fence = Number(request.headers.get('x-release-owner-fence'));
      const delayMs = Number(url.searchParams.get('delayMs'));
      await acquireCreateLease(env, releaseId, manifestSha256, fence);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return Response.json({ held: true });
      } finally {
        await releaseCreateLease(env, releaseId, manifestSha256, fence);
      }
    }
    return handleReleaseCoordinator(request, env);
  },
};
