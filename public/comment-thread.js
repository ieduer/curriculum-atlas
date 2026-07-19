function wouldCycle(node, parent, byId) {
  const visited = new Set([node.id]);
  let cursor = parent;
  while (cursor) {
    if (visited.has(cursor.id)) return true;
    visited.add(cursor.id);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null;
  }
  return false;
}

export function buildCommentThread(comments) {
  if (!Array.isArray(comments)) throw new Error('讨论列表无效');
  const nodes = comments.map((comment) => ({ ...comment, children: [] }));
  const byId = new Map();
  for (const node of nodes) {
    if (!node.id || byId.has(node.id)) throw new Error('讨论身份无效或重复');
    byId.set(node.id, node);
  }
  const roots = [];
  for (const node of nodes) {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    if (!parent || parent === node || wouldCycle(node, parent, byId)) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

export function commentReplyTarget(comment) {
  if (!comment?.id) throw new Error('回复目标无效');
  return {
    parentId: String(comment.id),
    paragraphId: Number.isSafeInteger(Number(comment.paragraph_id)) && Number(comment.paragraph_id) > 0
      ? Number(comment.paragraph_id)
      : null,
    label: String(comment.body || ''),
  };
}
