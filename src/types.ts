export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SOURCES: R2Bucket;
  APIS: Fetcher;
  USER_CENTER: Fetcher;
  ENVIRONMENT: string;
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
  locator: string;
  sourceUrl: string;
  excerpt: string;
}
