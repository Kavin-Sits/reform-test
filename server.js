const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

global.DOMMatrix ||= class DOMMatrix {};
global.Path2D ||= class Path2D {};

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const { extractDocument } = require("./src/extractor");

const execFileAsync = promisify(execFile);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DOCUMENTS_DIR = path.join(DATA_DIR, "documents");
const DB_PATH = path.join(DATA_DIR, "documents.json");
const STANDARD_FONT_DATA_URL = path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;
const PORT = Number(process.env.PORT || 3000);
const PDFTOPPM =
  process.env.PDFTOPPM_PATH ||
  "/Users/kavin/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm";

async function ensureDataDirs() {
  await fsp.mkdir(DOCUMENTS_DIR, { recursive: true });
  try {
    await fsp.access(DB_PATH);
  } catch {
    await fsp.writeFile(DB_PATH, "[]\n");
  }
}

async function readDb() {
  await ensureDataDirs();
  return JSON.parse(await fsp.readFile(DB_PATH, "utf8"));
}

async function writeDb(documents) {
  await fsp.writeFile(DB_PATH, JSON.stringify(documents, null, 2));
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.length
  });
  res.end(payload);
}

function sendText(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".pdf": "application/pdf"
  }[ext] || "application/octet-stream";
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "content-type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipartPdf(req, body) {
  const type = req.headers["content-type"] || "";
  const match = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("Missing multipart boundary");

  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  let offset = body.indexOf(boundary);

  while (offset !== -1) {
    const headerStart = offset + boundary.length + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;

    const headers = body.slice(headerStart, headerEnd).toString("utf8");
    const nextBoundary = body.indexOf(boundary, headerEnd + 4);
    if (nextBoundary === -1) break;

    const disposition = headers.match(/content-disposition:.*name="file".*filename="([^"]+)"/i);
    if (disposition) {
      const file = body.slice(headerEnd + 4, nextBoundary - 2);
      return {
        fileName: path.basename(disposition[1]) || "upload.pdf",
        buffer: file
      };
    }

    offset = nextBoundary;
  }

  throw new Error("No PDF file field found");
}

async function renderPages(pdfPath, docDir) {
  const prefix = path.join(docDir, "page");
  await execFileAsync(PDFTOPPM, ["-png", "-r", "200", pdfPath, prefix]);

  const files = (await fsp.readdir(docDir))
    .filter((file) => /^page-\d+\.png$/.test(file))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  return files.map((file, index) => ({
    page: index + 1,
    imagePath: path.join(docDir, file),
    imageUrl: `/api/documents/${path.basename(docDir)}/pages/${index + 1}.png`
  }));
}

async function extractSelectableTextPages(pdfPath, renderedPages) {
  const data = new Uint8Array(await fsp.readFile(pdfPath));
  const pdf = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS
  }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const pdfPage = await pdf.getPage(pageNumber);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const rendered = renderedPages.find((page) => page.page === pageNumber);
    const pngSize = rendered ? readPngSize(rendered.imagePath) : null;
    const scale = pngSize ? pngSize.width / viewport.width : 1;
    const content = await pdfPage.getTextContent();
    const words = [];

    for (const item of content.items) {
      const text = cleanText(item.str);
      if (!text) continue;

      const x = item.transform[4] * scale;
      const fontY = item.transform[5];
      const height = Math.max(8, item.height || 10) * scale;
      const y = (viewport.height - fontY - (item.height || 10)) * scale;
      const width = Math.max(text.length * 4, item.width || 0) * scale;
      const parts = text.split(/\s+/).filter(Boolean);
      const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1;
      let cursor = x;

      for (const part of parts) {
        const partWidth = Math.max(4, width * (part.length / totalChars));
        words.push({
          text: part,
          confidence: 100,
          x: cursor,
          y,
          width: partWidth,
          height
        });
        cursor += partWidth + Math.max(2, width * 0.03);
      }
    }

    pages.push({
      page: pageNumber,
      text: wordsToLines(words),
      words
    });
  }

  return pages;
}

function readPngSize(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function wordsToLines(words) {
  const lines = [];
  for (const word of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const centerY = word.y + word.height / 2;
    let line = lines.find((candidate) => Math.abs(candidate.centerY - centerY) < Math.max(5, word.height * 0.65));
    if (!line) {
      line = { centerY, words: [] };
      lines.push(line);
    }
    line.words.push(word);
    line.centerY = line.words.reduce((sum, item) => sum + item.y + item.height / 2, 0) / line.words.length;
  }

  return lines
    .map((line) => line.words.sort((a, b) => a.x - b.x).map((word) => word.text).join(" "))
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function publicDocument(doc) {
  return {
    id: doc.id,
    fileName: doc.fileName,
    uploadedAt: doc.uploadedAt,
    status: doc.status,
    summary: doc.summary,
    fields: doc.fields,
    lineItems: doc.lineItems,
    pages: doc.pages.map(({ page, imageUrl, width, height, textSource }) => ({ page, imageUrl, width, height, textSource })),
    pdfUrl: `/api/documents/${doc.id}/file`
  };
}

async function handleUpload(req, res) {
  const body = await readRequestBody(req);
  const { fileName, buffer } = parseMultipartPdf(req, body);

  if (!fileName.toLowerCase().endsWith(".pdf")) {
    sendJson(res, 400, { error: "Only PDF uploads are supported." });
    return;
  }

  const id = crypto.randomUUID();
  const docDir = path.join(DOCUMENTS_DIR, id);
  await fsp.mkdir(docDir, { recursive: true });

  const pdfPath = path.join(docDir, "original.pdf");
  await fsp.writeFile(pdfPath, buffer);

  const now = new Date().toISOString();
  let doc = {
    id,
    fileName,
    uploadedAt: now,
    status: "processing",
    pdfPath,
    pages: [],
    fields: [],
    lineItems: [],
    summary: { averageConfidence: 0, needsReview: true }
  };

  const documents = await readDb();
  documents.unshift(doc);
  await writeDb(documents);

  try {
    const renderedPages = await renderPages(pdfPath, docDir);
    const textPages = await extractSelectableTextPages(pdfPath, renderedPages);
    const extraction = await extractDocument(renderedPages, textPages);
    doc = {
      ...doc,
      status: "ready",
      pages: extraction.pages,
      fields: extraction.fields,
      lineItems: extraction.lineItems,
      summary: extraction.summary
    };
  } catch (error) {
    doc = { ...doc, status: "failed", error: error.message };
  }

  const nextDocuments = (await readDb()).map((item) => (item.id === id ? doc : item));
  await writeDb(nextDocuments);

  if (doc.status === "failed") {
    sendJson(res, 500, { error: doc.error, document: publicDocument(doc) });
    return;
  }

  sendJson(res, 201, publicDocument(doc));
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const documents = await readDb();

  if (req.method === "GET" && url.pathname === "/api/documents") {
    sendJson(res, 200, documents.map(publicDocument));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/documents") {
    await handleUpload(req, res);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const doc = documents.find((item) => item.id === deleteMatch[1]);
    if (!doc) {
      sendText(res, 404, "Not found");
      return;
    }

    await fsp.rm(path.join(DOCUMENTS_DIR, doc.id), { recursive: true, force: true });
    await writeDb(documents.filter((item) => item.id !== doc.id));
    sendJson(res, 200, { ok: true });
    return;
  }

  const fileMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/file$/);
  if (req.method === "GET" && fileMatch) {
    const doc = documents.find((item) => item.id === fileMatch[1]);
    if (!doc) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/pdf" });
    fs.createReadStream(doc.pdfPath).pipe(res);
    return;
  }

  const pageMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/pages\/(\d+)\.png$/);
  if (req.method === "GET" && pageMatch) {
    const doc = documents.find((item) => item.id === pageMatch[1]);
    if (!doc) {
      sendText(res, 404, "Not found");
      return;
    }
    const page = doc.pages.find((item) => item.page === Number(pageMatch[2]));
    if (!page) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, { "content-type": "image/png" });
    fs.createReadStream(page.imagePath).pipe(res);
    return;
  }

  const docMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (req.method === "GET" && docMatch) {
    const doc = documents.find((item) => item.id === docMatch[1]);
    if (!doc) {
      sendText(res, 404, "Not found");
      return;
    }
    sendJson(res, 200, publicDocument(doc));
    return;
  }

  sendText(res, 404, "Not found");
}

async function main() {
  await ensureDataDirs();
  const server = http.createServer((req, res) => {
    Promise.resolve(req.url.startsWith("/api/") ? handleApi(req, res) : serveStatic(req, res)).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: error.message });
    });
  });

  server.listen(PORT, () => {
    console.log(`Reform document uploader running at http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
