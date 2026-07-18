import { createHash } from 'node:crypto';

export const CORPUS_BUILDER_CONTRACT = 'release_snapshot_v4_reference_closure';

export function computeCorpusReleaseFingerprint({
  catalog,
  ingest,
  documentedSources,
  insights,
  onlineVerificationSamples,
  classifications,
  pagePublicationManifest,
  semanticPublicationPolicy,
  semanticPublicationRevisionSha256,
  textAssets,
} = {}) {
  const required = {
    catalog,
    ingest,
    documentedSources,
    insights,
    onlineVerificationSamples,
    classifications,
    pagePublicationManifest,
    semanticPublicationPolicy,
    semanticPublicationRevisionSha256,
    textAssets,
  };
  for (const [key, value] of Object.entries(required)) {
    if (value === undefined) throw new Error(`corpus release fingerprint input is missing: ${key}`);
  }
  return createHash('sha256').update(JSON.stringify({
    catalog,
    ingest,
    document_sources: documentedSources,
    subject_insights: insights,
    online_verification_samples: onlineVerificationSamples,
    document_classifications: classifications,
    page_publication_manifest: pagePublicationManifest,
    semantic_publication_policy: semanticPublicationPolicy,
    semantic_publication_revision_sha256: semanticPublicationRevisionSha256,
    text_assets: textAssets,
    corpus_builder_contract: CORPUS_BUILDER_CONTRACT,
  })).digest('hex');
}
