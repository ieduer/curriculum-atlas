// Resolve the public method/path contract before any database or session work.
// Unknown paths must not pay for the full corpus consistency check.
type PlainRoute = 'health' | 'me' | 'meta' | 'documents' | 'search' | 'insights'
  | 'terms' | 'compare' | 'source-manifest' | 'comments' | 'create-comment'
  | 'admin-summary' | 'ai-chat';
type ResourceRoute = 'document' | 'historical-pdf' | 'historical-item'
  | 'report-comment' | 'moderate-comment';
export type ApiRoute = { kind: PlainRoute } | { kind: ResourceRoute; id: string };

export function resolveApiRoute(path: string, method: string): ApiRoute | null {
  if (method === 'GET') {
    const plain: Record<string, PlainRoute> = {
      '/api/health': 'health', '/api/me': 'me', '/api/meta': 'meta',
      '/api/documents': 'documents', '/api/search': 'search',
      '/api/insights': 'insights', '/api/terms': 'terms', '/api/compare': 'compare',
      '/api/source-manifest': 'source-manifest', '/api/comments': 'comments',
      '/api/admin/summary': 'admin-summary',
    };
    if (Object.hasOwn(plain, path)) return { kind: plain[path] };
    const document = path.match(/^\/api\/documents\/([a-z0-9-]+)$/);
    if (document) return { kind: 'document', id: document[1] };
    const pdf = path.match(/^\/api\/historical\/(.+)\/source\.pdf$/);
    if (pdf) return { kind: 'historical-pdf', id: pdf[1] };
    const item = path.match(/^\/api\/historical\/(.+)$/);
    if (item) return { kind: 'historical-item', id: item[1] };
  }
  if (method === 'POST') {
    if (path === '/api/comments') return { kind: 'create-comment' };
    if (path === '/api/ai/chat') return { kind: 'ai-chat' };
    const report = path.match(/^\/api\/comments\/([a-f0-9-]+)\/report$/);
    if (report) return { kind: 'report-comment', id: report[1] };
  }
  if (method === 'PATCH') {
    const comment = path.match(/^\/api\/admin\/comments\/([a-f0-9-]+)$/);
    if (comment) return { kind: 'moderate-comment', id: comment[1] };
  }
  return null;
}
