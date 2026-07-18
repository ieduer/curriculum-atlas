export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SOURCES: R2Bucket;
  APIS: Fetcher;
  USER_CENTER: Fetcher;
  ENVIRONMENT: string;
  RELEASE_GIT_COMMIT?: string;
  RELEASE_ID?: string;
  RELEASE_MANIFEST_SHA256?: string;
  RELEASE_SOURCE_TREE_SHA256?: string;
  CORPUS_RELEASE_ID?: string;
  CORPUS_MANIFEST_SHA256?: string;
  SITE_ORIGIN: string;
  AI_ORIGIN: string;
  USER_CENTER_ORIGIN: string;
  AI_GATEWAY_URL?: string;
  AI_MODEL_LABEL: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET?: string;
  HASH_SALT?: string;
  ADMIN_SLUGS?: string;
}

export interface SessionUser {
  id?: number;
  slug: string;
  display_name?: string;
  name?: string;
  avatar_url?: string;
}

export interface Session {
  authenticated: boolean;
  user: SessionUser | null;
  admin: boolean;
}

export interface Passage {
  id: number;
  document_id: string;
  title: string;
  entity_kind: string;
  taxonomy_entity_kind: string;
  display_facet: string | null;
  subject: string | null;
  entity_label: string;
  subject_family: string | null;
  scope_kind: string | null;
  scope_label: string | null;
  version_label: string;
  page_number: number | null;
  source_locator: string;
  body: string;
  source_url: string;
  score: number;
}

export interface AiCitation {
  paragraphId: number;
  documentId: string;
  title: string;
  subject: string | null;
  entityLabel: string;
  entityKind: string;
  taxonomyEntityKind: string;
  displayFacet: string | null;
  locator: string;
  sourceUrl: string;
  excerpt: string;
}
