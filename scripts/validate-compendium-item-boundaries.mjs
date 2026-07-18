#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compendiumStableItemId,
  compendiumTocEntryReceiptSha256,
  compendiumTocPageReceiptSha256,
  compendiumItemCitationEntitlementSha256,
  onlineRegistryStatusForCompendium,
} from './compendium-evidence-receipt.mjs';

const shaPattern = /^[a-f0-9]{64}$/;
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function add(errors, condition, code, detail) {
  if (!condition) errors.push({ code, detail });
}

export function canonicalCompendiumTitle(rawTitle) {
  return rawTitle.normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/^附件([一二三四五六七八九十])\s+([（(])/u, '附件$1$2')
    .trim();
}

export function compendiumPageSetSha256({
  documentId,
  sourceArtifactSha256,
  pagePublicationReleaseId,
  physicalPageStart,
  physicalPageEnd,
  pages,
}) {
  if (!Array.isArray(pages)) throw new Error('compendium page set pages must be an array');
  const expectedCount = physicalPageEnd - physicalPageStart + 1;
  if (!Number.isSafeInteger(physicalPageStart) || !Number.isSafeInteger(physicalPageEnd)
    || expectedCount < 1 || pages.length !== expectedCount) {
    throw new Error('compendium page set range is not contiguous and complete');
  }
  const projection = pages.map((page, index) => {
    const expectedPage = physicalPageStart + index;
    if (page.document_id !== documentId || page.page_number !== expectedPage
      || page.source_artifact_sha256 !== sourceArtifactSha256
      || page.display_allowed !== true) {
      throw new Error(`compendium page set page ${expectedPage} is not source-bound and display-accepted`);
    }
    for (const key of ['source_page_sha256', 'final_text_sha256', 'evidence_bundle_sha256']) {
      if (!shaPattern.test(page[key] || '')) throw new Error(`compendium page set page ${expectedPage} lacks ${key}`);
    }
    if (typeof page.stable_locator !== 'string' || page.stable_locator.length === 0) {
      throw new Error(`compendium page set page ${expectedPage} lacks stable_locator`);
    }
    return {
      page_number: page.page_number,
      source_page_sha256: page.source_page_sha256,
      final_text_sha256: page.final_text_sha256,
      evidence_bundle_sha256: page.evidence_bundle_sha256,
      stable_locator: page.stable_locator,
      citation_allowed: page.citation_allowed === true,
    };
  });
  return sha256(JSON.stringify({
    policy: 'verified_compendium_page_set_v1',
    document_id: documentId,
    source_artifact_sha256: sourceArtifactSha256,
    page_publication_release_id: pagePublicationReleaseId,
    physical_page_start: physicalPageStart,
    physical_page_end: physicalPageEnd,
    pages: projection,
  }));
}

function nullableEvidenceClosed(value, keys) {
  return keys.every((key) => value[key] === null);
}

export function validateCompendiumItemBoundaries(value, { catalog, queue, onlineVerifications } = {}) {
  const errors = [];
  add(errors, exactKeys(value, ['$schema', 'schema_version', 'policy', 'documents']),
    'root_shape', 'root keys are not canonical');
  add(errors, value?.$schema === './compendium-item-boundaries.schema.json', 'schema_pointer', 'schema pointer drifted');
  add(errors, value?.schema_version === 2, 'schema_version', 'schema version must equal 2');
  add(errors, value?.policy === 'fail_closed_compendium_item_boundaries_v2', 'policy', 'policy drifted');
  add(errors, Array.isArray(value?.documents), 'documents', 'documents must be an array');

  const catalogById = new Map((catalog?.documents || []).map((record) => [record.id, record]));
  const queueById = new Map((queue?.documents || []).map((record) => [record.id, record]));
  const onlineRecords = onlineVerifications?.samples || [];
  const onlineById = new Map(onlineRecords.map((record) => [record.id, record]));
  if (onlineVerifications) {
    add(errors, Array.isArray(onlineVerifications.samples) && onlineById.size === onlineRecords.length,
      'online_source_registry', 'online source registry IDs must be unique');
  }
  const documentIds = new Set();
  const itemIds = new Set();
  for (const document of value?.documents || []) {
    add(errors, exactKeys(document, [
      'document_id', 'source_artifact_sha256', 'physical_page_count',
      'printed_to_physical_page_offset', 'toc_evidence', 'items',
    ]), 'document_shape', `${document?.document_id || '<unknown>'} keys are not canonical`);
    add(errors, typeof document.document_id === 'string' && !documentIds.has(document.document_id),
      'document_id', `${document.document_id} is missing or repeated`);
    documentIds.add(document.document_id);
    add(errors, shaPattern.test(document.source_artifact_sha256 || ''),
      'source_hash', `${document.document_id} source hash is invalid`);
    add(errors, Number.isSafeInteger(document.physical_page_count) && document.physical_page_count > 0,
      'page_count', `${document.document_id} page count is invalid`);
    add(errors, Number.isSafeInteger(document.printed_to_physical_page_offset),
      'page_offset', `${document.document_id} page offset is invalid`);
    const catalogRecord = catalogById.get(document.document_id);
    const queueRecord = queueById.get(document.document_id);
    if (catalog) {
      add(errors, catalogRecord?.checksum_sha256 === document.source_artifact_sha256
        && catalogRecord?.page_count === document.physical_page_count,
      'catalog_identity', `${document.document_id} differs from catalog source identity`);
    }
    if (queue) {
      add(errors, queueRecord?.source_sha256 === document.source_artifact_sha256
        && queueRecord?.page_count === document.physical_page_count,
      'queue_identity', `${document.document_id} differs from OCR queue source identity`);
    }

    const toc = document.toc_evidence;
    add(errors, exactKeys(toc, ['physical_pages', 'review_status', 'reviewer_id', 'reviewed_at', 'review_note']),
      'toc_shape', `${document.document_id} TOC evidence keys are not canonical`);
    add(errors, toc?.review_status === 'human_image_review_pass_navigation_only'
      && typeof toc?.reviewer_id === 'string' && toc.reviewer_id.length > 0
      && canonicalTimestampPattern.test(toc?.reviewed_at || '')
      && typeof toc?.review_note === 'string' && toc.review_note.length > 0,
    'toc_review', `${document.document_id} TOC lacks a navigation-only image review`);
    const tocPages = new Set();
    for (const page of toc?.physical_pages || []) {
      add(errors, exactKeys(page, [
        'page_number', 'primary_text_sha256', 'source_image_sha256',
        'vision_witness_sha256', 'evidence_bundle_sha256',
      ]),
        'toc_page_shape', `${document.document_id} TOC page keys are not canonical`);
      add(errors, Number.isSafeInteger(page.page_number) && page.page_number >= 1
        && page.page_number <= document.physical_page_count && !tocPages.has(page.page_number),
      'toc_page', `${document.document_id} TOC page ${page.page_number} is invalid or repeated`);
      add(errors, [
        page.primary_text_sha256, page.source_image_sha256,
        page.vision_witness_sha256, page.evidence_bundle_sha256,
      ].every((digest) => shaPattern.test(digest || '')),
        'toc_page_hash', `${document.document_id} TOC page ${page.page_number} lacks hashes`);
      add(errors, page.evidence_bundle_sha256 === compendiumTocPageReceiptSha256({
        documentId: document.document_id,
        sourceArtifactSha256: document.source_artifact_sha256,
        pageNumber: page.page_number,
        primaryTextSha256: page.primary_text_sha256,
        sourceImageSha256: page.source_image_sha256,
        visionWitnessSha256: page.vision_witness_sha256,
      }), 'toc_page_receipt', `${document.document_id} TOC page ${page.page_number} receipt drifted`);
      tocPages.add(page.page_number);
    }
    add(errors, tocPages.size > 0, 'toc_pages_empty', `${document.document_id} has no TOC pages`);

    const items = Array.isArray(document.items) ? document.items : [];
    add(errors, items.length > 0, 'items_empty', `${document.document_id} has no item candidates`);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let expectedId = null;
      try {
        expectedId = compendiumStableItemId({
          documentId: document.document_id,
          sourceArtifactSha256: document.source_artifact_sha256,
          tocEntryReceiptSha256: item?.toc_entry_sha256,
        });
      } catch {
        expectedId = null;
      }
      add(errors, exactKeys(item, [
        'item_id', 'sequence', 'section', 'item_kind', 'parent_item_id', 'raw_title', 'title',
        'display_year', 'year_basis', 'toc_physical_page', 'printed_page_start', 'issuing_body',
        'candidate_physical_page_start', 'candidate_physical_page_end', 'toc_entry_sha256',
        'toc_entry_evidence',
        'body_heading', 'online_verification', 'page_evidence', 'semantic_review',
        'identity_status', 'display_allowed', 'citation_allowed', 'semantic_claim_allowed',
        'uncertainty_note',
      ]), 'item_shape', `${item?.item_id || expectedId || '<unknown>'} keys are not canonical`);
      add(errors, expectedId !== null && item.item_id === expectedId && !itemIds.has(item.item_id),
        'item_id', `${item.item_id} is not the canonical unique identity`);
      itemIds.add(item.item_id);
      add(errors, item.sequence === index + 1, 'item_sequence', `${item.item_id} sequence drifted`);
      add(errors, ['小学', '中学', '综合'].includes(item.section), 'item_section', `${item.item_id} section is invalid`);
      add(errors, ['curriculum_document', 'attachment'].includes(item.item_kind), 'item_kind', `${item.item_id} kind is invalid`);
      add(errors, typeof item.raw_title === 'string' && item.raw_title.length > 0
        && typeof item.title === 'string' && item.title.length > 0,
      'item_title', `${item.item_id} title is missing`);
      add(errors, item.title === canonicalCompendiumTitle(item.raw_title),
        'item_title_normalization', `${item.item_id} canonical title differs from its reviewed TOC text`);
      add(errors, Number.isSafeInteger(item.display_year) && item.display_year >= 1800 && item.display_year <= 2030,
        'item_year', `${item.item_id} year is invalid`);
      add(errors, item.issuing_body === null
        || (typeof item.issuing_body === 'string' && item.issuing_body.trim().length > 0),
      'issuing_body', `${item.item_id} issuing body must be null or an independently reviewed value`);
      add(errors, tocPages.has(item.toc_physical_page), 'item_toc_page', `${item.item_id} points outside reviewed TOC pages`);
      add(errors, Number.isSafeInteger(item.printed_page_start) && item.printed_page_start > 0
        && item.candidate_physical_page_start === item.printed_page_start + document.printed_to_physical_page_offset,
      'item_start_mapping', `${item.item_id} printed-to-physical mapping is invalid`);
      const next = items[index + 1];
      const expectedEnd = next ? next.candidate_physical_page_start - 1 : document.physical_page_count;
      add(errors, item.candidate_physical_page_end === expectedEnd
        && item.candidate_physical_page_end >= item.candidate_physical_page_start
        && item.candidate_physical_page_end <= document.physical_page_count,
      'item_candidate_end', `${item.item_id} candidate end is not the next-item boundary`);
      add(errors, index === 0 || item.candidate_physical_page_start > items[index - 1].candidate_physical_page_start,
        'item_order', `${item.item_id} does not strictly follow the prior item`);
      const tocEntry = item.toc_entry_evidence;
      const tocPage = (toc?.physical_pages || []).find((page) => page.page_number === item.toc_physical_page);
      add(errors, exactKeys(tocEntry, [
        'source_line', 'source_line_sha256', 'toc_page_evidence_bundle_sha256', 'entry_receipt_sha256',
      ]), 'item_toc_evidence_shape', `${item.item_id} TOC entry evidence keys are not canonical`);
      const sourceLineMatch = /^(?:(\d{4})\s*年\s*)?(.+?)\s+\.{3,}\s*(\d+)\s*$/u.exec(tocEntry?.source_line || '');
      add(errors, Boolean(sourceLineMatch)
        && sha256(tocEntry.source_line) === tocEntry.source_line_sha256
        && canonicalCompendiumTitle(sourceLineMatch[2]) === item.title
        && Number(sourceLineMatch[3]) === item.printed_page_start
        && (item.item_kind === 'attachment'
          ? sourceLineMatch[1] === undefined
          : Number(sourceLineMatch[1]) === item.display_year)
        && tocEntry.toc_page_evidence_bundle_sha256 === tocPage?.evidence_bundle_sha256,
      'item_toc_source_line', `${item.item_id} does not match its immutable TOC source line`);
      const expectedEntryReceipt = compendiumTocEntryReceiptSha256({
        documentId: document.document_id,
        sourceArtifactSha256: document.source_artifact_sha256,
        tocPageNumber: item.toc_physical_page,
        tocPageEvidenceBundleSha256: tocEntry?.toc_page_evidence_bundle_sha256,
        sourceLine: tocEntry?.source_line,
        section: item.section,
        displayYear: item.display_year,
        rawTitle: item.raw_title,
        printedPageStart: item.printed_page_start,
      });
      add(errors, tocEntry?.entry_receipt_sha256 === expectedEntryReceipt
        && item.toc_entry_sha256 === expectedEntryReceipt,
      'item_toc_receipt', `${item.item_id} TOC row is not bound to its source-page receipt`);

      if (item.item_kind === 'attachment') {
        const parent = items[index - 1];
        add(errors, item.parent_item_id === parent?.item_id && item.year_basis === 'parent_notice_year'
          && item.display_year === parent?.display_year && item.section === parent?.section,
        'attachment_parent', `${item.item_id} is not bound to its adjacent same-year parent`);
        add(errors, !item.display_allowed || parent?.display_allowed === true,
          'attachment_publication_parent', `${item.item_id} cannot publish without its parent item identity`);
      } else {
        add(errors, item.parent_item_id === null && item.year_basis === 'toc_explicit_year',
          'document_year_basis', `${item.item_id} has an invented parent or year`);
      }

      const heading = item.body_heading;
      add(errors, exactKeys(heading, [
        'verification_status', 'physical_page', 'exact_text', 'exact_text_sha256',
        'source_image_sha256', 'primary_ocr_sha256', 'witness_sha256', 'reviewer_id', 'reviewed_at',
      ]), 'heading_shape', `${item.item_id} heading keys are not canonical`);
      const headingVerified = heading?.verification_status === 'image_primary_witness_verified';
      if (headingVerified) {
        add(errors, heading.physical_page === item.candidate_physical_page_start
          && typeof heading.exact_text === 'string' && heading.exact_text.length > 0
          && canonicalCompendiumTitle(heading.exact_text) === item.title
          && [heading.exact_text_sha256, heading.source_image_sha256, heading.primary_ocr_sha256, heading.witness_sha256]
            .every((digest) => shaPattern.test(digest || ''))
          && sha256(heading.exact_text) === heading.exact_text_sha256
          && typeof heading.reviewer_id === 'string' && heading.reviewer_id.length > 0
          && canonicalTimestampPattern.test(heading.reviewed_at || '')
          && heading.reviewed_at >= toc.reviewed_at,
        'heading_evidence', `${item.item_id} verified heading evidence is incomplete`);
      } else {
        add(errors, heading?.verification_status === 'not_verified'
          && nullableEvidenceClosed(heading, [
            'physical_page', 'exact_text', 'exact_text_sha256', 'source_image_sha256',
            'primary_ocr_sha256', 'witness_sha256', 'reviewer_id', 'reviewed_at',
          ]), 'heading_fail_closed', `${item.item_id} unverified heading retains evidence claims`);
      }

      const pages = item.page_evidence;
      add(errors, exactKeys(pages, [
        'verification_status', 'page_publication_release_id', 'physical_page_start',
        'physical_page_end', 'accepted_page_count', 'page_set_sha256',
        'item_citation_entitlement_sha256',
      ]), 'page_evidence_shape', `${item.item_id} page evidence keys are not canonical`);
      const pagesVerified = ['all_pages_display_verified', 'all_pages_citation_verified'].includes(pages?.verification_status);
      if (pagesVerified) {
        add(errors, typeof pages.page_publication_release_id === 'string' && pages.page_publication_release_id.length > 0
          && pages.physical_page_start === item.candidate_physical_page_start
          && pages.physical_page_end === item.candidate_physical_page_end
          && pages.accepted_page_count === item.candidate_physical_page_end - item.candidate_physical_page_start + 1
          && shaPattern.test(pages.page_set_sha256 || ''),
        'page_evidence', `${item.item_id} verified page set is incomplete`);
      } else {
        add(errors, pages?.verification_status === 'not_verified'
          && nullableEvidenceClosed(pages, [
            'page_publication_release_id', 'physical_page_start', 'physical_page_end',
            'accepted_page_count', 'page_set_sha256', 'item_citation_entitlement_sha256',
          ]), 'page_evidence_fail_closed', `${item.item_id} unverified page set retains publication claims`);
      }

      const online = item.online_verification;
      add(errors, exactKeys(online, [
        'verification_status', 'version_relation', 'source_ids', 'comparison_scope',
        'primary_item_text_sha256', 'online_text_sha256', 'reviewer_id', 'reviewed_at',
        'verification_note', 'uncertainty_note',
      ])
        && Array.isArray(online?.source_ids), 'online_shape', `${item.item_id} online evidence keys are invalid`);
      const exactOnline = online?.verification_status === 'same_edition_exact_text_verified';
      if (exactOnline) {
        add(errors, online.version_relation === 'same_work_same_edition'
          && online.source_ids.length > 0 && new Set(online.source_ids).size === online.source_ids.length
          && online.source_ids.every((id) => typeof id === 'string' && id.length > 0)
          && online.comparison_scope === 'full_item_text'
          && shaPattern.test(online.primary_item_text_sha256 || '')
          && shaPattern.test(online.online_text_sha256 || '')
          && typeof online.reviewer_id === 'string' && online.reviewer_id.length > 0
          && canonicalTimestampPattern.test(online.reviewed_at || '')
          && online.reviewed_at >= toc.reviewed_at
          && (!headingVerified || online.reviewed_at >= heading.reviewed_at)
          && typeof online.verification_note === 'string' && online.verification_note.length > 0
          && online.uncertainty_note === null,
        'online_exact', `${item.item_id} exact-edition online evidence is incomplete`);
        if (onlineVerifications) {
          add(errors, online.source_ids.every((id) => {
            const source = onlineById.get(id);
            return source?.document_id === document.document_id
              && canonicalCompendiumTitle(source.contained_document || '') === item.title
              && source.edition_match_status === 'exact_document_exact_edition'
              && source.verification_status === onlineRegistryStatusForCompendium(online.verification_status)
              && source.primary_ocr_sha256 === online.primary_item_text_sha256
              && source.online_text_sha256 === online.online_text_sha256
              && source.citation_allowed === true;
          }), 'online_source_binding', `${item.item_id} exact-edition source IDs are unresolved or edition-mismatched`);
        } else {
          add(errors, false, 'online_source_context', `${item.item_id} exact-edition evidence requires the online source registry`);
        }
      } else if (online?.verification_status === 'not_started') {
        add(errors, online.version_relation === null && online.source_ids.length === 0
          && online.comparison_scope === null && online.primary_item_text_sha256 === null
          && online.online_text_sha256 === null && online.reviewer_id === null
          && online.reviewed_at === null && online.verification_note === null
          && typeof online.uncertainty_note === 'string' && online.uncertainty_note.length > 0,
        'online_not_started', `${item.item_id} unstarted online review retains evidence claims`);
      } else {
        add(errors, ['different_edition_stable_facts_only', 'not_found'].includes(online?.verification_status)
          && typeof online.reviewer_id === 'string' && online.reviewer_id.length > 0
          && canonicalTimestampPattern.test(online.reviewed_at || '')
          && online.reviewed_at >= toc.reviewed_at
          && typeof online.verification_note === 'string' && online.verification_note.length > 0
          && typeof online.uncertainty_note === 'string' && online.uncertainty_note.length > 0,
        'online_uncertainty', `${item.item_id} non-exact online state lacks a reviewed uncertainty record`);
        if (online?.verification_status === 'different_edition_stable_facts_only') {
          add(errors, online.version_relation !== 'same_work_same_edition'
            && online.source_ids.length > 0 && new Set(online.source_ids).size === online.source_ids.length
            && online.comparison_scope === 'stable_facts_only'
            && online.primary_item_text_sha256 === null && shaPattern.test(online.online_text_sha256 || ''),
          'online_stable_fact', `${item.item_id} different-edition evidence exceeds stable-fact scope`);
          if (onlineVerifications) {
            add(errors, online.source_ids.every((id) => {
              const source = onlineById.get(id);
              return source?.document_id === document.document_id
                && canonicalCompendiumTitle(source.contained_document || '') === item.title
                && ['same_work_different_edition', 'stable_fact_only'].includes(source.edition_match_status)
                && source.verification_status === 'verified_stable_fact_only'
                && source.online_text_sha256 === online.online_text_sha256;
            }), 'online_stable_source_binding', `${item.item_id} stable-fact source IDs are unresolved or over-scoped`);
          } else {
            add(errors, false, 'online_source_context', `${item.item_id} stable-fact evidence requires the online source registry`);
          }
        } else if (online?.verification_status === 'not_found') {
          add(errors, online.version_relation === null && online.source_ids.length === 0
            && online.comparison_scope === null && online.primary_item_text_sha256 === null
            && online.online_text_sha256 === null,
          'online_not_found', `${item.item_id} not-found review retains source claims`);
        }
      }

      const expectedItemCitationEntitlement = exactOnline && pagesVerified
        ? compendiumItemCitationEntitlementSha256({
          itemId: item.item_id,
          parentDocumentId: document.document_id,
          sourceArtifactSha256: document.source_artifact_sha256,
          pageSetSha256: pages.page_set_sha256,
          primaryItemTextSha256: online.primary_item_text_sha256,
          onlineTextSha256: online.online_text_sha256,
          onlineSourceIds: online.source_ids,
        })
        : null;
      add(errors, pages?.verification_status === 'all_pages_citation_verified'
        ? pages.item_citation_entitlement_sha256 === expectedItemCitationEntitlement
          && shaPattern.test(pages.item_citation_entitlement_sha256 || '')
        : pages?.item_citation_entitlement_sha256 === null,
      'item_citation_entitlement', `${item.item_id} item-scoped citation receipt is missing or stale`);

      const semantic = item.semantic_review;
      add(errors, exactKeys(semantic, ['review_status', 'reviewer_id', 'reviewed_at', 'review_note']),
        'semantic_shape', `${item.item_id} semantic review keys are not canonical`);
      const semanticReviewed = semantic?.review_status === 'editor_reviewed';
      if (semanticReviewed) {
        add(errors, typeof semantic.reviewer_id === 'string' && semantic.reviewer_id.length > 0
          && canonicalTimestampPattern.test(semantic.reviewed_at || '')
          && semantic.reviewed_at >= toc.reviewed_at
          && (!headingVerified || semantic.reviewed_at >= heading.reviewed_at)
          && (!online.reviewed_at || semantic.reviewed_at >= online.reviewed_at)
          && typeof semantic.review_note === 'string' && semantic.review_note.length > 0,
        'semantic_review', `${item.item_id} semantic review is incomplete`);
        add(errors, item.citation_allowed === true && exactOnline
          && pages?.verification_status === 'all_pages_citation_verified',
        'semantic_review_order', `${item.item_id} semantic review preceded the exact-edition citation gate`);
      } else {
        add(errors, semantic?.review_status === 'not_started'
          && nullableEvidenceClosed(semantic, ['reviewer_id', 'reviewed_at', 'review_note']),
        'semantic_fail_closed', `${item.item_id} unreviewed semantics retain reviewer claims`);
      }

      const nextHeadingVerified = next?.body_heading?.verification_status === 'image_primary_witness_verified';
      const endBoundaryVerified = next ? nextHeadingVerified
        : item.candidate_physical_page_end === document.physical_page_count;
      if (item.identity_status === 'toc_navigation_candidate') {
        add(errors, !headingVerified && !pagesVerified, 'candidate_identity', `${item.item_id} candidate contains verified body claims`);
      } else if (item.identity_status === 'body_boundary_verified') {
        add(errors, headingVerified, 'body_identity', `${item.item_id} body identity lacks heading evidence`);
      } else {
        add(errors, item.identity_status === 'verified_full_item' && headingVerified && pagesVerified && endBoundaryVerified,
          'full_identity', `${item.item_id} full identity lacks heading, next-heading/end, or page evidence`);
      }
      add(errors, item.display_allowed === (item.identity_status === 'verified_full_item'
        && headingVerified && pagesVerified && endBoundaryVerified),
        'display_gate', `${item.item_id} display gate exceeds or understates verified page identity`);
      add(errors, item.citation_allowed === (item.display_allowed
        && pages?.verification_status === 'all_pages_citation_verified' && exactOnline),
      'citation_gate', `${item.item_id} citation gate is not exact-edition and full-page bound`);
      add(errors, item.semantic_claim_allowed === (item.citation_allowed && semanticReviewed),
        'semantic_gate', `${item.item_id} semantic gate is not citation-and-editor bound`);
      if (!item.semantic_claim_allowed) {
        add(errors, typeof item.uncertainty_note === 'string' && item.uncertainty_note.length > 0,
          'uncertainty_note', `${item.item_id} fail-closed state lacks an uncertainty note`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    counts: {
      documents: value?.documents?.length || 0,
      items: [...itemIds].length,
      display_allowed: (value?.documents || []).flatMap((document) => document.items || []).filter((item) => item.display_allowed).length,
      citation_allowed: (value?.documents || []).flatMap((document) => document.items || []).filter((item) => item.citation_allowed).length,
      semantic_claim_allowed: (value?.documents || []).flatMap((document) => document.items || []).filter((item) => item.semantic_claim_allowed).length,
    },
  };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [boundaries, catalog, queue, onlineVerifications] = await Promise.all([
    readFile(path.join(root, 'data/compendium-item-boundaries.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'data/catalog.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'data/ocr-queue.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'data/online-verification-samples.json'), 'utf8').then(JSON.parse),
  ]);
  const report = validateCompendiumItemBoundaries(boundaries, { catalog, queue, onlineVerifications });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`validate-compendium-item-boundaries: ${error.message}\n`);
    process.exitCode = 2;
  });
}
