import { handleReleaseCoordinator } from '../../src/release-coordinator';
import type { Env } from '../../src/types';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleReleaseCoordinator(request, env);
  },
};
