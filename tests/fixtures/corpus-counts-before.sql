-- Accepted predecessor query; fixed comparison oracle for synthetic SQLite regressions.
SELECT r.*,
      (SELECT COUNT(*) FROM documents d WHERE d.corpus_release_id=r.release_id) AS live_documents,
      (SELECT COUNT(*) FROM paragraphs p WHERE p.corpus_release_id=r.release_id) AS live_paragraphs,
      (SELECT COUNT(*) FROM paragraph_fts) AS live_fts_rows,
      (SELECT COUNT(*) FROM page_publication_gates g WHERE g.corpus_release_id=r.release_id) AS live_page_gates,
      (SELECT COUNT(*) FROM paragraphs p WHERE p.corpus_release_id=r.release_id AND p.display_allowed=1) AS live_displayed_paragraphs,
      (SELECT COUNT(DISTINCT g.document_id) FROM page_publication_gates g
        WHERE g.corpus_release_id=r.release_id AND g.publication_basis='accepted_ocr_page_manifest') AS live_accepted_ocr_documents,
      (SELECT COUNT(*) FROM corpus_import_chunks c WHERE c.release_id=r.release_id) AS live_chunks,
      json_object(
        'subjects',(SELECT COUNT(*) FROM subjects),
        'periods',(SELECT COUNT(*) FROM periods),
        'document_relations',(SELECT COUNT(*) FROM document_relations),
        'chapters',(SELECT COUNT(*) FROM chapters),
        'document_classifications',(SELECT COUNT(*) FROM document_classifications dc JOIN documents d ON d.id=dc.document_id WHERE d.corpus_release_id=r.release_id),
        'document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=r.release_id),
        'primary_document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=r.release_id AND ds.is_primary=1),
        'subject_insights',(SELECT COUNT(*) FROM subject_insights),
        'terms',(SELECT COUNT(*) FROM terms),
        'term_relations',(SELECT COUNT(*) FROM term_relations),
        'version_diffs',(SELECT COUNT(*) FROM version_diffs),
        'online_verifications',(SELECT COUNT(*) FROM online_verifications ov WHERE ov.corpus_release_id=r.release_id),
        'online_evidence',(SELECT COUNT(*) FROM online_evidence oe JOIN online_verifications ov ON ov.id=oe.verification_id WHERE ov.corpus_release_id=r.release_id)
      ) AS live_core_counts_json
      FROM corpus_import_releases r
      JOIN site_meta release_meta ON release_meta.key='current_corpus_release_id' AND release_meta.value=r.release_id
      JOIN site_meta state_meta ON state_meta.key='corpus_import_state' AND state_meta.value=r.state
      JOIN site_meta manifest_meta ON manifest_meta.key='current_corpus_manifest_sha256' AND manifest_meta.value=r.manifest_sha256
      LIMIT 1;
