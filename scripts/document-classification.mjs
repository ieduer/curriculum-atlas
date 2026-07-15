import { readFile } from 'node:fs/promises';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function scopeKind(rule) {
  const classification = text(rule?.classification) || '';
  if (rule?.entity_kind === 'assessment_domain') {
    return classification.includes('policy') ? 'evaluation_framework' : 'assessment_framework';
  }
  if (rule?.entity_kind === 'source_collection') {
    return classification === 'multi_subject_compendium' ? 'subject_collection' : 'source_collection';
  }
  if (classification.includes('curriculum_framework') || classification.includes('curriculum_line')) {
    return 'curriculum_framework';
  }
  return 'cross_subject';
}

export function validateDocumentClassification(value, record) {
  const entityKind = text(value?.entity_kind);
  const canonicalSubject = text(value?.canonical_subject);
  const classifiedScopeKind = text(value?.scope_kind);
  const scopeLabel = text(value?.scope_label);
  if (!entityKind) throw new Error(`Missing entity_kind for ${record.id}`);
  if (!['subject', 'scope'].includes(entityKind)) throw new Error(`Invalid entity_kind for ${record.id}: ${entityKind}`);
  if (entityKind === 'subject' && !canonicalSubject) {
    throw new Error(`Subject classification lacks canonical_subject for ${record.id}`);
  }
  if (entityKind !== 'subject' && (canonicalSubject || !classifiedScopeKind || !scopeLabel)) {
    throw new Error(`Scope classification is incomplete for ${record.id}`);
  }
  return {
    document_id: record.id,
    entity_kind: entityKind,
    canonical_subject: entityKind === 'subject' ? canonicalSubject : null,
    subject_family: entityKind === 'subject' ? text(value.subject_family) || canonicalSubject : null,
    scope_kind: entityKind === 'subject' ? null : classifiedScopeKind,
    scope_label: entityKind === 'subject' ? null : scopeLabel,
    source_subject_label: text(record.subject) || '未标注',
    decision_basis: text(value.decision_basis) || 'concept_model_v2_explicit_taxonomy',
    reviewed_at: text(value.reviewed_at),
  };
}

export function fallbackDocumentClassification(record) {
  const sourceLabel = text(record.subject) || '未标注';
  return validateDocumentClassification({
    entity_kind: 'scope', scope_kind: 'unclassified', scope_label: `${sourceLabel}（分类待核）`,
    decision_basis: 'unknown_source_subject_label_fail_closed',
  }, record);
}

export async function loadDocumentClassificationResolver(projectRoot) {
  const model = JSON.parse(await readFile(new URL('data/concept-model-v2.json', projectRoot), 'utf8'));
  if (!model.subject_taxonomy || !model.document_entity_overrides || !model.subject_families) {
    throw new Error('concept-model-v2 taxonomy is incomplete');
  }
  const familyByLabel = new Map();
  for (const [family, labels] of Object.entries(model.subject_families)) {
    for (const label of labels) familyByLabel.set(label, family);
  }
  return (record) => {
    const rule = model.document_entity_overrides[record.id] || model.subject_taxonomy[record.subject];
    if (!rule) return fallbackDocumentClassification(record);
    if (rule.entity_kind === 'subject' && rule.facet_eligible === true) {
      return validateDocumentClassification({
        entity_kind: 'subject',
        canonical_subject: rule.canonical,
        subject_family: rule.lineage_family || familyByLabel.get(record.subject) || rule.canonical,
        decision_basis: `concept_model_v2:${rule.classification || 'subject'}`,
      }, record);
    }
    return validateDocumentClassification({
      entity_kind: 'scope',
      scope_kind: scopeKind(rule),
      scope_label: rule.canonical || record.document_type || '跨学科范围',
      decision_basis: `concept_model_v2:${rule.classification || 'non_subject'}`,
    }, record);
  };
}
