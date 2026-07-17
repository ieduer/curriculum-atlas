import { createHash } from 'node:crypto';

export const SEMANTIC_PUBLICATION_SCHEMA_VERSION = 1;
export const SEMANTIC_PUBLICATION_POLICY = 'fail_closed_semantic_publication_v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CONTROL_ID_PATTERN = /^[a-z0-9][a-z0-9:-]*$/;
const STATUS_VALUES = new Set(['unresolved_fail_closed', 'resolved_after_review']);

function fail(message) {
  throw new Error(`semantic publication policy: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function requireExactKeys(value, label, required, optional = []) {
  requireObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function requireNullableString(value, label) {
  if (value === null) return null;
  return requireString(value, label);
}

function requireSha256(value, label) {
  return requireString(value, label, SHA256_PATTERN);
}

function requireIsoTimestamp(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function requireNullableIsoTimestamp(value, label) {
  if (value === null) return null;
  return requireIsoTimestamp(value, label);
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return value;
}

function requireUniqueStrings(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const seen = new Set();
  return value.map((item, index) => {
    const text = requireString(item, `${label}[${index}]`);
    if (seen.has(text)) fail(`${label} contains duplicate value ${text}`);
    seen.add(text);
    return text;
  });
}

function recordSourceSha256(record) {
  return record?.checksum_sha256 || record?.source_sha256 || null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scriptRegex(script) {
  try {
    return new RegExp(`\\p{Script=${script}}`, 'gu');
  } catch {
    fail(`unsupported Unicode script ${script}`);
  }
}

function normalizedQualityProfiles(rawProfiles) {
  requireObject(rawProfiles, 'quality_profiles');
  const profiles = {};
  for (const [profileName, rawProfile] of Object.entries(rawProfiles)) {
    requireString(profileName, `quality_profiles key ${profileName}`, DOCUMENT_ID_PATTERN);
    const label = `quality_profiles.${profileName}`;
    requireExactKeys(rawProfile, label, [
      'minimum_meaningful_characters_when_text_expected',
      'forbidden_unicode_scripts',
      'minimum_required_script_characters',
      'tabular_alignment_required',
      'required_resolution_attestations',
    ]);
    const forbiddenUnicodeScripts = requireUniqueStrings(
      rawProfile.forbidden_unicode_scripts,
      `${label}.forbidden_unicode_scripts`,
      { allowEmpty: true },
    );
    for (const script of forbiddenUnicodeScripts) scriptRegex(script);
    requireObject(rawProfile.minimum_required_script_characters, `${label}.minimum_required_script_characters`);
    const minimumRequiredScriptCharacters = {};
    for (const [script, minimum] of Object.entries(rawProfile.minimum_required_script_characters)) {
      scriptRegex(script);
      minimumRequiredScriptCharacters[script] = requireInteger(
        minimum,
        `${label}.minimum_required_script_characters.${script}`,
        1,
      );
    }
    profiles[profileName] = {
      minimum_meaningful_characters_when_text_expected: requireInteger(
        rawProfile.minimum_meaningful_characters_when_text_expected,
        `${label}.minimum_meaningful_characters_when_text_expected`,
        0,
      ),
      forbidden_unicode_scripts: forbiddenUnicodeScripts,
      minimum_required_script_characters: minimumRequiredScriptCharacters,
      tabular_alignment_required: requireBoolean(
        rawProfile.tabular_alignment_required,
        `${label}.tabular_alignment_required`,
      ),
      required_resolution_attestations: requireUniqueStrings(
        rawProfile.required_resolution_attestations,
        `${label}.required_resolution_attestations`,
        { allowEmpty: true },
      ),
    };
  }
  if (Object.keys(profiles).length === 0) fail('quality_profiles must not be empty');
  return profiles;
}

export function validateSemanticPublicationPolicy(policy) {
  requireExactKeys(policy, 'root', [
    'schema_version',
    'policy',
    'reviewed_by',
    'reviewed_at',
    'quality_profiles',
    'document_aliases',
    'page_controls',
  ], ['$schema']);
  if (policy.schema_version !== SEMANTIC_PUBLICATION_SCHEMA_VERSION) {
    fail(`schema_version must equal ${SEMANTIC_PUBLICATION_SCHEMA_VERSION}`);
  }
  if (policy.policy !== SEMANTIC_PUBLICATION_POLICY) {
    fail(`policy must equal ${SEMANTIC_PUBLICATION_POLICY}`);
  }
  const reviewedBy = requireString(policy.reviewed_by, 'reviewed_by');
  const reviewedAt = requireIsoTimestamp(policy.reviewed_at, 'reviewed_at');
  const qualityProfiles = normalizedQualityProfiles(policy.quality_profiles);

  if (!Array.isArray(policy.document_aliases)) fail('document_aliases must be an array');
  const aliasIds = new Set();
  const documentAliases = policy.document_aliases.map((alias, index) => {
    const label = `document_aliases[${index}]`;
    requireExactKeys(alias, label, [
      'alias_document_id',
      'canonical_document_id',
      'source_artifact_sha256',
      'relation',
      'reviewed_by',
      'reviewed_at',
      'note',
    ]);
    const aliasDocumentId = requireString(alias.alias_document_id, `${label}.alias_document_id`, DOCUMENT_ID_PATTERN);
    const canonicalDocumentId = requireString(
      alias.canonical_document_id,
      `${label}.canonical_document_id`,
      DOCUMENT_ID_PATTERN,
    );
    if (aliasDocumentId === canonicalDocumentId) fail(`${label} cannot alias itself`);
    if (aliasIds.has(aliasDocumentId)) fail(`${label}.alias_document_id is duplicated`);
    aliasIds.add(aliasDocumentId);
    if (alias.relation !== 'exact_source_duplicate') fail(`${label}.relation must equal exact_source_duplicate`);
    return {
      alias_document_id: aliasDocumentId,
      canonical_document_id: canonicalDocumentId,
      source_artifact_sha256: requireSha256(alias.source_artifact_sha256, `${label}.source_artifact_sha256`),
      relation: alias.relation,
      reviewed_by: requireString(alias.reviewed_by, `${label}.reviewed_by`),
      reviewed_at: requireIsoTimestamp(alias.reviewed_at, `${label}.reviewed_at`),
      note: requireString(alias.note, `${label}.note`),
    };
  });
  for (const alias of documentAliases) {
    if (aliasIds.has(alias.canonical_document_id)) {
      fail(`${alias.alias_document_id}: canonical_document_id must not be another alias`);
    }
  }

  if (!Array.isArray(policy.page_controls) || policy.page_controls.length === 0) {
    fail('page_controls must be a non-empty array');
  }
  const controlIds = new Set();
  const pageControls = policy.page_controls.map((control, index) => {
    const label = `page_controls[${index}]`;
    requireExactKeys(control, label, [
      'control_id',
      'document_id',
      'source_artifact_sha256',
      'page_count',
      'page_start',
      'page_end',
      'quality_profile',
      'status',
      'reasons',
      'source_image_text_expected',
      'boundary_basis',
      'resolution_requirements',
      'resolution_attestations',
      'reviewed_by',
      'reviewed_at',
      'resolved_by',
      'resolved_at',
      'note',
    ]);
    const controlId = requireString(control.control_id, `${label}.control_id`, CONTROL_ID_PATTERN);
    if (controlIds.has(controlId)) fail(`${label}.control_id is duplicated`);
    controlIds.add(controlId);
    const documentId = requireString(control.document_id, `${label}.document_id`, DOCUMENT_ID_PATTERN);
    if (aliasIds.has(documentId)) fail(`${label}.document_id must not target an alias`);
    const pageCount = requireInteger(control.page_count, `${label}.page_count`, 1);
    const pageStart = requireInteger(control.page_start, `${label}.page_start`, 1);
    const pageEnd = requireInteger(control.page_end, `${label}.page_end`, 1);
    if (pageEnd < pageStart || pageEnd > pageCount) {
      fail(`${label} page range must satisfy 1 <= page_start <= page_end <= page_count`);
    }
    const qualityProfile = requireString(control.quality_profile, `${label}.quality_profile`, DOCUMENT_ID_PATTERN);
    const profile = qualityProfiles[qualityProfile];
    if (!profile) fail(`${label}.quality_profile is not defined`);
    if (!STATUS_VALUES.has(control.status)) fail(`${label}.status is invalid`);
    const resolutionRequirements = requireUniqueStrings(
      control.resolution_requirements,
      `${label}.resolution_requirements`,
    );
    const resolutionAttestations = requireUniqueStrings(
      control.resolution_attestations,
      `${label}.resolution_attestations`,
      { allowEmpty: true },
    );
    const resolvedBy = requireNullableString(control.resolved_by, `${label}.resolved_by`);
    const resolvedAt = requireNullableIsoTimestamp(control.resolved_at, `${label}.resolved_at`);
    if (control.status === 'unresolved_fail_closed') {
      if (resolutionAttestations.length || resolvedBy !== null || resolvedAt !== null) {
        fail(`${label} unresolved controls cannot carry resolution attestations or reviewer fields`);
      }
    } else {
      if (!resolvedBy || !resolvedAt) fail(`${label} resolved controls require resolved_by and resolved_at`);
      const attestations = new Set(resolutionAttestations);
      for (const required of profile.required_resolution_attestations) {
        if (!attestations.has(required)) fail(`${label} resolved control is missing attestation ${required}`);
      }
      if (profile.tabular_alignment_required && !attestations.has('row_alignment_verified')) {
        fail(`${label} resolved tabular control requires row_alignment_verified`);
      }
    }
    return {
      control_id: controlId,
      document_id: documentId,
      source_artifact_sha256: requireSha256(control.source_artifact_sha256, `${label}.source_artifact_sha256`),
      page_count: pageCount,
      page_start: pageStart,
      page_end: pageEnd,
      quality_profile: qualityProfile,
      status: control.status,
      reasons: requireUniqueStrings(control.reasons, `${label}.reasons`),
      source_image_text_expected: requireBoolean(
        control.source_image_text_expected,
        `${label}.source_image_text_expected`,
      ),
      boundary_basis: requireString(control.boundary_basis, `${label}.boundary_basis`),
      resolution_requirements: resolutionRequirements,
      resolution_attestations: resolutionAttestations,
      reviewed_by: requireString(control.reviewed_by, `${label}.reviewed_by`),
      reviewed_at: requireIsoTimestamp(control.reviewed_at, `${label}.reviewed_at`),
      resolved_by: resolvedBy,
      resolved_at: resolvedAt,
      note: requireString(control.note, `${label}.note`),
    };
  });

  return {
    schema_version: SEMANTIC_PUBLICATION_SCHEMA_VERSION,
    policy: SEMANTIC_PUBLICATION_POLICY,
    reviewed_by: reviewedBy,
    reviewed_at: reviewedAt,
    quality_profiles: qualityProfiles,
    document_aliases: documentAliases,
    page_controls: pageControls,
  };
}

export function createSemanticPublicationGate({ policy, records }) {
  const normalized = validateSemanticPublicationPolicy(policy);
  if (!Array.isArray(records)) fail('records must be an array');
  const recordById = new Map(records.map((record) => [record.id, record]));
  if (recordById.size !== records.length) fail('records contain duplicate document ids');
  const aliasById = new Map();
  const aliasesByCanonicalId = new Map();
  for (const alias of normalized.document_aliases) {
    const aliasRecord = recordById.get(alias.alias_document_id);
    const canonicalRecord = recordById.get(alias.canonical_document_id);
    if (!aliasRecord || !canonicalRecord) fail(`${alias.alias_document_id}: alias or canonical catalog record is missing`);
    const aliasSha256 = recordSourceSha256(aliasRecord);
    const canonicalSha256 = recordSourceSha256(canonicalRecord);
    if (aliasSha256 !== alias.source_artifact_sha256 || canonicalSha256 !== alias.source_artifact_sha256) {
      fail(`${alias.alias_document_id}: exact duplicate source hash does not match both catalog records`);
    }
    if (aliasRecord.page_count !== canonicalRecord.page_count) {
      fail(`${alias.alias_document_id}: exact duplicate page_count differs from canonical document`);
    }
    aliasById.set(alias.alias_document_id, alias);
    if (!aliasesByCanonicalId.has(alias.canonical_document_id)) aliasesByCanonicalId.set(alias.canonical_document_id, []);
    aliasesByCanonicalId.get(alias.canonical_document_id).push(alias.alias_document_id);
  }

  const controlsByDocumentId = new Map();
  for (const control of normalized.page_controls) {
    const record = recordById.get(control.document_id);
    if (!record) fail(`${control.control_id}: catalog document is missing`);
    if (recordSourceSha256(record) !== control.source_artifact_sha256) {
      fail(`${control.control_id}: source artifact hash drift`);
    }
    if (record.page_count !== control.page_count) fail(`${control.control_id}: catalog page_count drift`);
    if (!controlsByDocumentId.has(control.document_id)) controlsByDocumentId.set(control.document_id, []);
    controlsByDocumentId.get(control.document_id).push(control);
  }

  const revisionSha256 = createHash('sha256').update(stableJson(normalized)).digest('hex');
  return {
    ...normalized,
    recordById,
    aliasById,
    aliasesByCanonicalId,
    controlsByDocumentId,
    revision_sha256: revisionSha256,
  };
}

export function semanticDocumentDisposition(gate, record) {
  const alias = gate.aliasById.get(record.id);
  return alias
    ? {
      excluded: true,
      relation: alias.relation,
      canonical_document_id: alias.canonical_document_id,
      source_artifact_sha256: alias.source_artifact_sha256,
    }
    : {
      excluded: false,
      relation: gate.aliasesByCanonicalId.has(record.id) ? 'exact_source_canonical' : null,
      canonical_document_id: record.id,
      alternate_document_ids: gate.aliasesByCanonicalId.get(record.id) || [],
    };
}

export function semanticPageScope({ gate, record, pageNumber }) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) fail('pageNumber must be a positive integer');
  const documentDisposition = semanticDocumentDisposition(gate, record);
  const controls = (gate.controlsByDocumentId.get(record.id) || [])
    .filter((control) => pageNumber >= control.page_start && pageNumber <= control.page_end);
  return {
    document_excluded: documentDisposition.excluded,
    canonical_document_id: documentDisposition.canonical_document_id,
    controls,
    unresolved_controls: controls.filter((control) => control.status === 'unresolved_fail_closed'),
    quality_profiles: [...new Set(controls.map((control) => control.quality_profile))],
  };
}

export function semanticPageDisposition({ gate, record, pageNumber, rawText }) {
  const scope = semanticPageScope({ gate, record, pageNumber });
  const blockReasons = [];
  if (scope.document_excluded) blockReasons.push(`document_alias:${scope.canonical_document_id}`);
  for (const control of scope.unresolved_controls) blockReasons.push(`unresolved:${control.control_id}`);

  if (rawText !== undefined) {
    if (typeof rawText !== 'string') fail(`${record.id}: page ${pageNumber} rawText must be a string`);
    const meaningfulCharacters = (rawText.match(/[\p{L}\p{N}]/gu) || []).length;
    for (const control of scope.controls) {
      const profile = gate.quality_profiles[control.quality_profile];
      if (control.source_image_text_expected
        && meaningfulCharacters < profile.minimum_meaningful_characters_when_text_expected) {
        blockReasons.push(
          `quality:${control.quality_profile}:meaningful_characters_below_${profile.minimum_meaningful_characters_when_text_expected}`,
        );
      }
      for (const script of profile.forbidden_unicode_scripts) {
        if (scriptRegex(script).test(rawText)) {
          blockReasons.push(`quality:${control.quality_profile}:forbidden_script:${script}`);
        }
      }
      for (const [script, minimum] of Object.entries(profile.minimum_required_script_characters)) {
        const count = (rawText.match(scriptRegex(script)) || []).length;
        if (count < minimum) blockReasons.push(`quality:${control.quality_profile}:required_script:${script}<${minimum}`);
      }
    }
  }

  return {
    blocked: blockReasons.length > 0,
    block_reasons: [...new Set(blockReasons)],
    control_ids: scope.controls.map((control) => control.control_id),
    quality_profiles: scope.quality_profiles,
    canonical_document_id: scope.canonical_document_id,
  };
}

export function applySemanticPagePublication({ gate, record, page, rawText }) {
  const disposition = semanticPageDisposition({
    gate,
    record,
    pageNumber: page.page_number,
    rawText,
  });
  if (!disposition.blocked) {
    return {
      ...page,
      semantic_excluded: false,
      semantic_control_ids: disposition.control_ids,
      semantic_quality_profiles: disposition.quality_profiles,
    };
  }
  const policyNote = `语义发布门关闭：${disposition.block_reasons.join(', ')}`;
  return {
    ...page,
    review_status: 'unresolved_fail_closed',
    display_allowed: false,
    citation_allowed: false,
    uncertainty_note: [page.uncertainty_note, policyNote].filter(Boolean).join('；'),
    semantic_excluded: true,
    semantic_control_ids: disposition.control_ids,
    semantic_quality_profiles: disposition.quality_profiles,
  };
}
