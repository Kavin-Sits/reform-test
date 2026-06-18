# Reform Document Uploader

## Steps To Start The Services

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm start
```

Open the app:

```text
http://localhost:3000
```

The app renders PDFs with Poppler's `pdftoppm`. On macOS, install it with:

```bash
brew install poppler
```

If `pdftoppm` is not on your path, provide it explicitly:

```bash
PDFTOPPM_PATH=/path/to/pdftoppm npm start
```

## Design

The project is a small Node.js app with static browser assets:

```text
public/
  app.js        Browser state, upload flow, delete flow, field clicks, highlights
  index.html    App shell
  styles.css    UI styles
src/
  extractor.js  Field extraction, confidence scores, line items, highlight boxes
server.js       HTTP API, PDF upload, rendering, text extraction, local storage
```

Key decisions:

- Use a plain Node server to keep the prototype small and easy to run.
- Store uploaded PDFs, rendered page images, and document metadata locally under `data/`.
- Render PDF pages to PNG and overlay extracted-field highlights in the browser.
- Keep field extraction centralized in `src/extractor.js` so new document-specific rules do not spread through the UI.
- Use confidence scores to make uncertain or missing values visible to reviewers.
- Support deleting uploaded files through the UI and `DELETE /api/documents/:id`.

Text extraction pipeline:

```text
PDF upload
  -> render pages to PNG with Poppler
  -> extract selectable text with pdfjs-dist
  -> fall back to OCR with tesseract.js when selectable text is weak or missing
  -> normalize both sources into the same page/word/line model
  -> run field extractors against the normalized model
  -> return values, confidence scores, and highlight boxes
```

The normalized document model is internal to `src/extractor.js`. It contains page dimensions, words, lines, text source, confidence, and bounding boxes. This gives every extractor the same search surface whether the source was embedded PDF text or OCR.

Extraction is intentionally high precision. Field extractors look for labels and anchors, then inspect nearby text spatially instead of blindly matching across the whole document. Each candidate is scored using label strength, proximity, value validation, text/OCR confidence, and whether a highlight box can be found. Candidates below the configured confidence threshold are returned as missing so the UI shows `Needs review` instead of a likely wrong value.

The rich normalized page graph is not persisted because it contains circular references used for extraction. The stored document keeps only the safe fields needed by the UI: page number, rendered image URL, dimensions, text source, extracted fields, line items, confidence, and highlights.

## Assumptions

- This is a local prototype, not a production service.
- There is no authentication or multi-tenant data isolation yet.
- Uploaded documents are freight-forwarding PDFs such as bills of lading, invoices, or related shipping documents.
- Some PDFs have selectable text and others are scanned images.
- Rule-based extraction is acceptable for the first pass.
- Missing fields should remain visible as `Needs review` instead of being hidden.
- Extracted values may need manual review, especially on noisy scans or unfamiliar layouts.

## Improvements

- Add automated fixture tests for each sample PDF and expected field values.
- Move document processing to a background job so large files do not block uploads.
- Add manual field correction, review status, and audit history.
- Add stronger table extraction for line items, values, and HTS codes.
- Add document-type classification before running extraction rules.
- Replace local JSON/file storage with Postgres and object storage.
- Add authentication and organization-level access control.
- Add an LLM or document AI fallback for low-confidence fields.
- Improve OCR preprocessing for low-quality scans.
