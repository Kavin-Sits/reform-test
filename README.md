# Reform Document Uploader

Small full-stack PDF intake app for freight-forwarding documents. The first working version focuses on uploading scanned or text PDFs, extracting the requested shipment/commercial fields, showing confidence scores, and highlighting extracted evidence on the rendered document.

## Current Build Plan

1. Build a plain Node.js server with static browser UI.
2. Accept PDF uploads through `POST /api/documents`.
3. Store uploaded files and derived page images under `data/documents`.
4. Render PDF pages to PNG with Poppler's `pdftoppm`.
5. Run OCR with Tesseract.js so scanned PDFs like the sample bill of lading work.
6. Centralize field extraction rules in `src/extractor.js`.
7. Display extracted values, confidence, page source, line items, and PDF highlights in the UI.

This is intentionally simple for the first pass: no database, auth, queue, object storage, or LLM dependency.

## Target Fields

The uploader is being built around these fields:

- bill of lading number
- invoice number
- shipper name
- shipper address
- consignee name
- consignee address
- line items
  - quantity
  - description
  - value
  - HTS code
- total value of goods

## Project Structure

```text
.
├── public/
│   ├── app.js          # Browser state, upload flow, rendering, highlights
│   ├── index.html      # App shell
│   └── styles.css      # UI styling
├── src/
│   └── extractor.js    # OCR extraction schema, field rules, confidence, boxes
├── server.js           # HTTP API, upload handling, PDF rendering, persistence
├── package.json
└── README.md
```

Generated files are intentionally ignored:

- `data/` for uploaded PDFs, rendered page images, and local JSON persistence
- `.cache/` for OCR language data
- `node_modules/`

## Running Locally

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

The app expects `pdftoppm` to be available. In this Codex environment, `server.js` currently defaults to the bundled Poppler binary path. On a normal machine, install Poppler and optionally set:

```bash
PDFTOPPM_PATH=/path/to/pdftoppm npm start
```

## API

- `GET /api/documents` - list uploaded documents
- `POST /api/documents` - upload and process a PDF
- `GET /api/documents/:id` - fetch one processed document
- `GET /api/documents/:id/file` - stream the original PDF
- `GET /api/documents/:id/pages/:page.png` - stream a rendered page image

## Design Decisions

- **Plain Node server:** fastest path to a working full-stack app in this empty repo without pulling in a framework.
- **Local JSON persistence:** enough for demo and review workflows; easy to replace with Postgres later.
- **OCR-first extraction:** the sample PDF is image-based, so text-only PDF extraction is not sufficient.
- **Shared extraction schema:** field definitions live in one place, making requested field changes straightforward.
- **Evidence-oriented UI:** extracted fields carry source text, confidence, page number, and highlight boxes so non-technical users can review quickly.
- **Word-box highlights:** OCR word positions are grouped into lines and reused for both extraction and click-to-highlight behavior.
- **Region-based party extraction:** shipper and consignee fields use deterministic page regions before falling back to global text order, which is more reliable on multi-column forms.

## Assumptions

- PDFs are shipment, invoice, or bill-of-lading style documents.
- Uploaded PDFs may be scanned images.
- First-pass extraction can be rule-based.
- Missing or low-confidence values should be visible rather than silently hidden.
- Line item extraction will need more tuning as we see more invoice formats.

## Improvement Ideas

- Add text-layer PDF extraction before OCR for faster processing on selectable-text PDFs.
- Add background jobs so large PDFs do not block the upload request.
- Store documents in S3 or similar object storage.
- Replace JSON persistence with Postgres.
- Add per-field manual correction and reviewer approval state.
- Add document-type classification before extraction.
- Add table-aware line item extraction.
- Add more fixture PDFs for invoices, packing lists, and bills of lading so extraction changes can be tested quickly.
- Add an LLM or document AI fallback for low-confidence fields.
- Add automated tests with fixture PDFs.
- Add authentication and organization-level document isolation.

## Repo Setup

This workspace is initialized as a git repo with:

```text
origin https://github.com/Kavin-Sits/reform-test.git
```

Suggested workflow:

```bash
git status
git add .
git commit -m "Build document uploader prototype"
git push -u origin main
```
