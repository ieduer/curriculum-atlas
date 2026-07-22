export const ADMIN_PAGE_LIMIT = 50;

const ADMIN_PAGE_ENDPOINTS = Object.freeze({
  comments: { path: '/api/admin/comments', status: 'pending' },
  reports: { path: '/api/admin/reports', status: 'open' },
  ai: { path: '/api/admin/ai-logs', status: 'failed' },
  audit: { path: '/api/admin/audit' },
  inventory: { path: '/api/admin/inventory' },
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function adminPageRequest(view, options = {}) {
  const definition = ADMIN_PAGE_ENDPOINTS[view];
  if (!definition) throw new Error('管理分页视图无效');
  const limit = boundedInteger(options.limit, ADMIN_PAGE_LIMIT, 1, 200);
  const offset = boundedInteger(options.offset, 0, 0, 1_000_000);
  const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (definition.status) search.set('status', definition.status);
  if (view === 'inventory') {
    search.set('kind', String(options.kind || 'documents'));
    search.set('q', String(options.query || '').slice(0, 160));
  }
  return `${definition.path}?${search}`;
}

export function adminPageState(result) {
  const total = boundedInteger(result?.total, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(result?.limit, ADMIN_PAGE_LIMIT, 1, 200);
  const offset = boundedInteger(result?.offset, 0, 0, 1_000_000);
  const rowCount = Array.isArray(result?.rows) ? result.rows.length : 0;
  return {
    total,
    limit,
    offset,
    start: total > 0 ? offset + 1 : 0,
    end: Math.min(total, offset + rowCount),
    hasPrevious: offset > 0,
    hasNext: offset + rowCount < total,
    previousOffset: Math.max(0, offset - limit),
    nextOffset: Math.min(1_000_000, offset + limit),
  };
}

export function adminReportResolution(action) {
  if (action === 'keep') return { status: 'dismissed', commentStatus: 'approved' };
  if (action === 'remove') return { status: 'resolved', commentStatus: 'deleted' };
  throw new Error('举报处理动作无效');
}

export function applyAdminViewSelection(buttons, view) {
  for (const button of buttons) {
    const selected = button.dataset.adminView === view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

export function restoreAdminPanelFocus(root, view) {
  const heading = root.querySelector(`[data-admin-heading="${view}"]`);
  if (!heading) return false;
  heading.focus();
  return true;
}
