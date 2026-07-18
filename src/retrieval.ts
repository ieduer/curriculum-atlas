import { textParam } from './http';
import { ftsQuery } from './search-query';
import type { Env, Passage } from './types';

interface SearchFilters {
  query: string;
  subject?: string;
  stage?: string;
  limit?: number;
}

export async function retrieve(env: Env, filters: SearchFilters): Promise<Passage[]> {
  const query = textParam(filters.query, 240);
  if (query.length < 2) return [];
  const limit = Math.min(12, Math.max(1, filters.limit || 8));
  const subject = textParam(filters.subject || '', 40);
  const stage = textParam(filters.stage || '', 40);
  const match = ftsQuery(query);
  if (match) {
    const result = await env.DB.prepare(
      `SELECT p.id, COALESCE(ei.id, p.document_id) AS document_id,
              p.document_id AS parent_document_id, ei.id AS embedded_item_id,
              COALESCE(ei.title, d.title) AS title, dc.entity_kind, dc.taxonomy_entity_kind, dc.display_facet,
              dc.canonical_subject AS subject,
              COALESCE(dc.canonical_subject, dc.scope_label, dc.source_subject_label) AS entity_label,
              dc.subject_family, dc.scope_kind, dc.scope_label,
              COALESCE(CAST(ei.display_year AS TEXT), d.version_label) AS version_label,
              p.page_number, p.source_locator, p.body, d.source_url,
              bm25(paragraph_fts) AS score
       FROM paragraph_fts
       JOIN paragraphs p ON p.id = paragraph_fts.paragraph_id
       JOIN documents d ON d.id = p.document_id
       JOIN page_publication_gates g
         ON g.document_id = p.document_id
        AND g.page_number = p.page_number
        AND g.corpus_release_id = p.corpus_release_id
       JOIN document_classifications dc ON dc.document_id = d.id
       LEFT JOIN embedded_items ei
         ON ei.id = p.embedded_item_id
        AND ei.corpus_release_id = p.corpus_release_id
       WHERE paragraph_fts MATCH ?
         AND p.corpus_release_id = (SELECT value FROM site_meta WHERE key='current_corpus_release_id')
         AND d.corpus_release_id = p.corpus_release_id
         AND p.citation_allowed = 1
         AND g.citation_allowed = 1
         AND ((p.embedded_item_id IS NULL AND d.citation_allowed = 1)
           OR (p.embedded_item_id IS NOT NULL AND ei.citation_allowed = 1))
         AND (? = '' OR (dc.taxonomy_entity_kind = 'subject' AND dc.canonical_subject = ?))
         AND (? = '' OR COALESCE(ei.stage, d.stage) = ?)
       ORDER BY score ASC
       LIMIT ?`,
    ).bind(match, subject, subject, stage, stage, limit).all<Passage>();
    if (result.results.length) return result.results;
  }

  const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const fallback = await env.DB.prepare(
    `SELECT p.id, COALESCE(ei.id, p.document_id) AS document_id,
            p.document_id AS parent_document_id, ei.id AS embedded_item_id,
            COALESCE(ei.title, d.title) AS title, dc.entity_kind, dc.taxonomy_entity_kind, dc.display_facet,
            dc.canonical_subject AS subject,
            COALESCE(dc.canonical_subject, dc.scope_label, dc.source_subject_label) AS entity_label,
            dc.subject_family, dc.scope_kind, dc.scope_label,
            COALESCE(CAST(ei.display_year AS TEXT), d.version_label) AS version_label,
            p.page_number, p.source_locator, p.body, d.source_url, 0 AS score
     FROM paragraphs p
     JOIN documents d ON d.id = p.document_id
     JOIN page_publication_gates g
       ON g.document_id = p.document_id
      AND g.page_number = p.page_number
      AND g.corpus_release_id = p.corpus_release_id
     JOIN document_classifications dc ON dc.document_id = d.id
     LEFT JOIN embedded_items ei
       ON ei.id = p.embedded_item_id
      AND ei.corpus_release_id = p.corpus_release_id
     WHERE p.body LIKE ? ESCAPE '\\'
       AND p.corpus_release_id = (SELECT value FROM site_meta WHERE key='current_corpus_release_id')
       AND d.corpus_release_id = p.corpus_release_id
       AND p.citation_allowed = 1
       AND g.citation_allowed = 1
       AND ((p.embedded_item_id IS NULL AND d.citation_allowed = 1)
         OR (p.embedded_item_id IS NOT NULL AND ei.citation_allowed = 1))
       AND (? = '' OR (dc.taxonomy_entity_kind = 'subject' AND dc.canonical_subject = ?))
       AND (? = '' OR COALESCE(ei.stage, d.stage) = ?)
     ORDER BY COALESCE(ei.display_year, d.sort_year) DESC, p.ordinal ASC LIMIT ?`,
  ).bind(like, subject, subject, stage, stage, limit).all<Passage>();
  return fallback.results;
}
