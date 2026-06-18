const path = require("node:path");
const fs = require("node:fs");
const { createWorker } = require("tesseract.js");

const CACHE_PATH = path.join(__dirname, "..", ".cache", "tesseract");
const FIELD_CONFIDENCE_THRESHOLD = 70;

const FIELD_DEFINITIONS = [
  { key: "billOfLadingNumber", label: "Bill of lading number", extractor: extractBillOfLadingNumber },
  { key: "invoiceNumber", label: "Invoice number", extractor: extractInvoiceNumber },
  { key: "shipperName", label: "Shipper name", extractor: extractShipperName },
  { key: "shipperAddress", label: "Shipper address", extractor: extractShipperAddress },
  { key: "consigneeName", label: "Consignee name", extractor: extractConsigneeName },
  { key: "consigneeAddress", label: "Consignee address", extractor: extractConsigneeAddress },
  { key: "totalValueOfGoods", label: "Total value of goods", extractor: extractTotalValueOfGoods }
];

async function extractDocument(renderedPages, textPages = []) {
  let worker = null;

  try {
    const pages = [];
    for (const page of renderedPages) {
      const textPage = textPages.find((item) => item.page === page.page);
      const size = getPngSize(page.imagePath);
      const hasTextLayer = cleanWhitespace(textPage?.text).length > 80 && (textPage?.words || []).length > 10;
      let words = textPage?.words || [];
      let text = textPage?.text || "";

      if (!hasTextLayer) {
        worker ||= await createWorker("eng", 1, {
          cachePath: CACHE_PATH,
          gzip: true
        });
        const result = await worker.recognize(page.imagePath, {}, { text: true, blocks: true });
        words = collectWords(result.data);
        text = result.data.text || "";
      }

      pages.push(buildPageModel({
        ...page,
        width: size.width,
        height: size.height,
        text,
        textSource: hasTextLayer ? "pdf-text" : "ocr",
        words
      }));
    }

    const document = buildDocumentModel(pages);
    const fields = FIELD_DEFINITIONS.map((definition) => extractField(definition, document));
    const lineItems = extractLineItems(document);
    const presentScores = fields.filter((field) => field.value).map((field) => field.confidence);
    const averageConfidence = presentScores.length
      ? Math.round(presentScores.reduce((sum, score) => sum + score, 0) / presentScores.length)
      : 0;

    return {
      pages: pages.map(toStoredPage),
      fields,
      lineItems,
      summary: {
        averageConfidence,
        needsReview: fields.some((field) => field.confidence < FIELD_CONFIDENCE_THRESHOLD) ||
          lineItems.some((item) => item.confidence < FIELD_CONFIDENCE_THRESHOLD)
      }
    };
  } finally {
    if (worker) await worker.terminate();
  }
}

function toStoredPage(page) {
  return {
    page: page.page,
    imagePath: page.imagePath,
    imageUrl: page.imageUrl,
    width: page.width,
    height: page.height,
    textSource: page.textSource
  };
}

function buildDocumentModel(pages) {
  const lines = pages.flatMap((page) => page.lines);
  for (const page of pages) page.documentLines = lines;
  return {
    pages,
    lines,
    text: pages.map((page) => page.text).join("\n")
  };
}

function buildPageModel(page) {
  const words = [...page.words].sort((a, b) => a.y - b.y || a.x - b.x);
  const model = {
    ...page,
    words,
    lines: [],
    text: page.text
  };
  const lines = groupWordsIntoLines(words).map((line) => ({ ...line, pageNumber: model.page, page: model }));
  model.lines = lines;
  model.text = lines.length ? lines.map((line) => line.text).join("\n") : page.text;
  return model;
}

function extractField(definition, document) {
  const candidates = definition.extractor(document);
  const best = selectBestCandidate(candidates);
  return best ? makeField(definition, best) : makeMissingField(definition);
}

function selectBestCandidate(candidates) {
  const sorted = candidates
    .filter((candidate) => candidate && candidate.value !== "" && candidate.value != null)
    .sort((a, b) => b.confidence - a.confidence);

  const best = sorted[0];
  if (!best || best.confidence < FIELD_CONFIDENCE_THRESHOLD) return null;

  const second = sorted[1];
  if (second && best.confidence - second.confidence < 8 && normalizeToken(best.value) !== normalizeToken(second.value)) {
    return null;
  }

  return best;
}

function extractBillOfLadingNumber(document) {
  return [
    ...extractValueNearLabels(document, {
      labels: [/B\/L-AWB\s+NO\.?/i, /B\/L\s+NUMBER/i, /B\/L\s+No\.?/i, /BILL\s+OF\s+LADING\s+(?:NO|NUMBER)/i],
      rejectLabels: [/INVOICE/i],
      validator: looksLikeDocumentNumber,
      cleanup: cleanDocumentNumber,
      baseConfidence: 88
    }),
    ...findStandaloneValues(document, /\bHBL[A-Z0-9]+\b/g, looksLikeDocumentNumber, 86)
  ];
}

function extractInvoiceNumber(document) {
  return extractValueNearLabels(document, {
    labels: [/INVOICE\s+(?:NO\.?|NUMBER|#)/i],
    rejectLabels: [/INVOICE\s+TO/i, /INVOICE\s+TOTAL/i],
    validator: looksLikeDocumentNumber,
    cleanup: cleanDocumentNumber,
    baseConfidence: 90,
    sameColumn: false
  });
}

function extractShipperName(document) {
  return extractPartyValue(document, {
    labels: [/^SHIPPER\b/i, /^EXPORTER\b/i, /^\d+\.\s*EXPORTER\b/i],
    stopLabels: [/^CONSIGNEE\b/i, /^CONSIGNED TO\b/i, /^\d+\.\s*CONSIGNED TO\b/i, /^INVOICE TO\b/i],
    valueType: "name",
    baseConfidence: 84
  });
}

function extractShipperAddress(document) {
  return extractPartyValue(document, {
    labels: [/^SHIPPER\b/i, /^EXPORTER\b/i, /^\d+\.\s*EXPORTER\b/i],
    stopLabels: [/^CONSIGNEE\b/i, /^CONSIGNED TO\b/i, /^\d+\.\s*CONSIGNED TO\b/i, /^INVOICE TO\b/i],
    valueType: "address",
    baseConfidence: 78
  });
}

function extractConsigneeName(document) {
  return extractPartyValue(document, {
    labels: [/^CONSIGNEE\b/i, /^CONSIGNED TO\b/i, /^\d+\.\s*CONSIGNED TO\b/i, /^MESSRS\b/i],
    stopLabels: [/^NOTIFY\b/i, /^INVOICE TO\b/i, /^FORWARDER\b/i, /^SHIPPER\b/i],
    valueType: "name",
    baseConfidence: 84
  });
}

function extractConsigneeAddress(document) {
  return extractPartyValue(document, {
    labels: [/^CONSIGNEE\b/i, /^CONSIGNED TO\b/i, /^\d+\.\s*CONSIGNED TO\b/i, /^MESSRS\b/i],
    stopLabels: [/^NOTIFY\b/i, /^INVOICE TO\b/i, /^FORWARDER\b/i, /^SHIPPER\b/i],
    valueType: "address",
    baseConfidence: 78
  });
}

function extractTotalValueOfGoods(document) {
  return extractValueNearLabels(document, {
    labels: [/INVOICE\s+TOTAL/i, /GRAND\s+TOTAL/i, /TOTAL\s+VALUE/i, /DECLARED\s+VALUE/i],
    rejectLabels: [/SUB\s*TOTAL/i, /FREIGHT/i, /WEIGHT/i, /KGS/i, /CBM/i],
    validator: looksLikeMoney,
    cleanup: parseMoney,
    baseConfidence: 88,
    chooseLastMoney: true
  });
}

function extractValueNearLabels(document, options) {
  const anchors = findAnchors(document, options.labels, options.rejectLabels || []);
  const candidates = [];

  for (const anchor of anchors) {
    const nearbyLines = getNearbyLines(anchor, {
      maxBelow: 3,
      samePageOnly: true,
      sameColumn: options.sameColumn ?? !options.chooseLastMoney
    });
    const searchTexts = [anchor.line.text, ...nearbyLines.map((line) => line.text)];

    for (const text of searchTexts) {
      const rawValues = options.chooseLastMoney ? extractMoneyValues(text).slice(-1) : extractLikelyValuesAfterLabel(text, anchor.match);
      for (const rawValue of rawValues) {
        const cleaned = options.cleanup ? options.cleanup(rawValue) : cleanWhitespace(rawValue);
        if (!options.validator(cleaned)) continue;
        const sourceLine = lineForText(anchor, nearbyLines, rawValue) || anchor.line;
        const words = findWordsForPhrase(sourceLine.page, String(rawValue));
        candidates.push({
          value: cleaned,
          confidence: scoreCandidate(options.baseConfidence, anchor, sourceLine, words),
          page: sourceLine.page,
          sourceText: sourceLine.text,
          words
        });
      }
    }
  }

  return candidates;
}

function extractPartyValue(document, options) {
  const anchors = findAnchors(document, options.labels, []);
  const candidates = [];

  for (const anchor of anchors) {
    const block = collectBlockAfterAnchor(anchor, options.stopLabels);
    if (!block.length) continue;

    const usefulLines = block
      .map(cleanPartyLine)
      .filter((line) => isUsefulPartyLine(line.text));
    if (!usefulLines.length) continue;

    const nameLine = usefulLines.find((line) => looksLikePartyName(line.text));
    const addressLines = usefulLines.filter((line) => line !== nameLine && looksLikeAddressLine(line.text));

    if (options.valueType === "name" && nameLine) {
      candidates.push({
        value: normalizePartyName(nameLine.text),
        confidence: scoreCandidate(options.baseConfidence, anchor, nameLine, nameLine.words),
        page: nameLine.page,
        sourceText: nameLine.text,
        words: nameLine.words
      });
    }

    if (options.valueType === "address" && addressLines.length) {
      const words = addressLines.flatMap((line) => line.words);
      const value = normalizeAddress(addressLines.map((line) => line.text).join(", "));
      if (!isPlausibleAddress(value)) continue;
      candidates.push({
        value,
        confidence: scoreCandidate(options.baseConfidence, anchor, addressLines[0], words),
        page: addressLines[0].page,
        sourceText: addressLines.map((line) => line.text).join(" "),
        words
      });
    }
  }

  return candidates;
}

function extractLineItems(document) {
  const invoiceItems = extractInvoiceTableItems(document);
  if (invoiceItems.length) return invoiceItems;

  const commodityItems = extractCommodityBlockItems(document);
  if (commodityItems.length) return commodityItems;

  return [];
}

function extractInvoiceTableItems(document) {
  const items = [];
  const tableAnchors = findAnchors(document, [/Line\s+#/i, /MODEL\s+NO\./i, /Part\s+number/i], []);

  for (const anchor of tableAnchors) {
    const rows = getNearbyLines(anchor, { maxBelow: 40, samePageOnly: false, sameColumn: false });
    for (let index = 0; index < rows.length; index++) {
      const line = rows[index];
      const next = rows[index + 1];
      const snapOn = line.text.match(/^(\d+)\s+([A-Z0-9-]+)\s+(.+?)\s+([A-Z]{2})\s+(\d{8,12})\s+([0-9.]+)\s+ea\s+([0-9,.]+)\s+([0-9,.]+)/i);
      const brother = line.text.match(/^([A-Z0-9-]{6,})\s+(\d+)\s+([0-9,.]+)\s+\$?\s*([0-9,.]+)/i);

      if (snapOn) {
        items.push({
          id: `${line.pageNumber}-${items.length + 1}`,
          quantity: Number(snapOn[6]),
          description: cleanWhitespace(snapOn[3]),
          value: parseMoney(snapOn[8]),
          htsCode: snapOn[5],
          confidence: 86,
          page: line.pageNumber,
          highlight: combineBoxes(line.words, line.pageNumber)
        });
      } else if (brother && next) {
        items.push({
          id: `${line.pageNumber}-${items.length + 1}`,
          quantity: Number(brother[2]),
          description: cleanWhitespace(next.text),
          value: parseMoney(brother[4]),
          htsCode: "",
          confidence: 80,
          page: line.pageNumber,
          highlight: combineBoxes([...line.words, ...next.words], line.pageNumber)
        });
      }
    }
  }

  return items;
}

function extractCommodityBlockItems(document) {
  const anchors = findAnchors(document, [/DESCRIPTION OF COMMODITIES/i, /DESCRIPTION OF GOODS/i, /PARTICULARS FURNISHED/i], []);
  const items = [];

  for (const anchor of anchors) {
    const lines = getNearbyLines(anchor, { maxBelow: 20, samePageOnly: false, sameColumn: false })
      .filter((line) => !/Carrier has a policy|DECLARED VALUE|FREIGHT RATES|SUBJECT TO CORRECTION/i.test(line.text));
    const descriptionLines = lines.filter((line) => /(FILTROS|PARTES|WATER FILTERS|VEHICLE PARTS|AES ITN|Vehicle Ref|Toyota|Chassis|Engine No)/i.test(line.text));
    if (!descriptionLines.length) continue;

    const quantityLine = lines.find((line) => /\b\d+\s*(?:PCS|vehicles?)\b/i.test(line.text));
    const quantity = quantityLine?.text.match(/\b(\d+)\s*(?:PCS|vehicles?)\b/i)?.[1];
    const words = descriptionLines.flatMap((line) => line.words);

    items.push({
      id: `${anchor.line.pageNumber}-${items.length + 1}`,
      quantity: quantity ? Number(quantity) : null,
      description: normalizeCommodityDescription(descriptionLines.map((line) => line.text).join(" ")),
      value: null,
      htsCode: "",
      confidence: 74,
      page: anchor.line.pageNumber,
      highlight: combineBoxes(words, anchor.line.pageNumber)
    });
  }

  return items;
}

function findAnchors(document, labelPatterns, rejectPatterns) {
  const anchors = [];
  for (const line of document.lines) {
    if (rejectPatterns.some((pattern) => pattern.test(line.text))) continue;
    for (const pattern of labelPatterns) {
      const match = line.text.match(pattern);
      if (match) {
        anchors.push({ line, match, pattern });
        break;
      }
    }
  }
  return anchors;
}

function getNearbyLines(anchor, options) {
  const page = anchor.line.page;
  const sourceLines = options.samePageOnly
    ? page.lines
    : anchor.line.page.documentLines || anchor.line.page.lines;
  const anchorIndex = sourceLines.indexOf(anchor.line);
  const after = sourceLines.slice(anchorIndex + 1, anchorIndex + 1 + options.maxBelow);

  if (!options.sameColumn) return after;

  const anchorCenterX = centerX(anchor.line.box);
  const columnWidth = anchor.line.page.width * 0.34;
  return after.filter((line) => Math.abs(centerX(line.box) - anchorCenterX) < columnWidth || line.box.x < anchor.line.box.x + columnWidth);
}

function collectBlockAfterAnchor(anchor, stopPatterns) {
  const lines = getNearbyLines(anchor, { maxBelow: 10, samePageOnly: true, sameColumn: true });
  const block = [];

  for (const line of lines) {
    if (stopPatterns.some((pattern) => pattern.test(line.text))) break;
    if (/(Page\s+\d|Line\s+#|Marks|Terms of payment|Place of Shipment|Mode of Transportation|EXPORT REFERENCES|POINT \(STATE\)|NOTIFY PARTY|PRE-CARRIAGE|CARRIER \/ VESSEL|FOREIGN PORT|TYPE OF MOVE)/i.test(line.text)) break;
    block.push(line);
  }

  return block;
}

function extractLikelyValuesAfterLabel(text, labelMatch) {
  const afterLabel = text.slice((labelMatch.index || 0) + labelMatch[0].length);
  const search = cleanWhitespace(afterLabel) || cleanWhitespace(text);
  const values = search.match(/\b[A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*\b|\b\d{6,}\b/g) || [];
  return values.filter((value) => !/^(PAGE|NO|NUMBER)$/i.test(value));
}

function findStandaloneValues(document, pattern, validator, confidence) {
  const candidates = [];
  for (const page of document.pages) {
    const values = page.text.match(pattern) || [];
    for (const value of values) {
      const cleaned = cleanDocumentNumber(value);
      if (!validator(cleaned)) continue;
      const words = findWordsForPhrase(page, cleaned);
      candidates.push({
        value: cleaned,
        confidence,
        page,
        sourceText: cleaned,
        words
      });
    }
  }
  return candidates;
}

function scoreCandidate(baseConfidence, anchor, sourceLine, words) {
  let score = baseConfidence;
  if (sourceLine.pageNumber === anchor.line.pageNumber) score += 4;
  if (sourceLine !== anchor.line) score -= Math.min(10, Math.abs(sourceLine.box.y - anchor.line.box.y) / 40);
  if (words?.length) score += 3;
  const wordConfidence = average(words?.map((word) => word.confidence) || []);
  if (wordConfidence && wordConfidence < 65) score -= 10;
  return Math.max(0, Math.min(99, Math.round(score)));
}

function makeField(definition, candidate) {
  return {
    key: definition.key,
    label: definition.label,
    value: candidate.value,
    confidence: candidate.confidence,
    page: candidate.page.page,
    sourceText: cleanWhitespace(candidate.sourceText),
    highlight: candidate.words?.length ? combineBoxes(candidate.words, candidate.page.page) : findHighlight(candidate.page, String(candidate.value))
  };
}

function makeMissingField(definition) {
  return {
    key: definition.key,
    label: definition.label,
    value: "",
    confidence: 0,
    page: null,
    sourceText: "",
    highlight: null
  };
}

function collectWords(data) {
  if (Array.isArray(data.words)) {
    return data.words.map(normalizeWord).filter(Boolean);
  }

  const words = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const normalized = normalizeWord(word);
          if (normalized) words.push(normalized);
        }
      }
    }
  }
  return words;
}

function normalizeWord(word) {
  const text = String(word.text || "").trim();
  const box = word.bbox || {};
  if (!text || box.x0 == null || box.y0 == null || box.x1 == null || box.y1 == null) return null;
  return {
    text,
    confidence: Math.round(word.confidence || 0),
    x: box.x0,
    y: box.y0,
    width: box.x1 - box.x0,
    height: box.y1 - box.y0
  };
}

function groupWordsIntoLines(words) {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];

  for (const word of sorted) {
    const centerY = word.y + word.height / 2;
    let line = lines.find((candidate) => Math.abs(candidate.centerY - centerY) < Math.max(10, word.height * 0.8));
    if (!line) {
      line = { words: [], centerY };
      lines.push(line);
    }
    line.words.push(word);
    line.centerY =
      line.words.reduce((sum, item) => sum + item.y + item.height / 2, 0) / line.words.length;
  }

  return lines
    .map((line) => {
      const lineWords = [...line.words].sort((a, b) => a.x - b.x);
      return {
        words: lineWords,
        text: cleanWhitespace(lineWords.map((word) => word.text).join(" ")),
        confidence: Math.round(lineWords.reduce((sum, word) => sum + word.confidence, 0) / lineWords.length),
        box: combineBoxes(lineWords, null)
      };
    })
    .filter((line) => line.text);
}

function getPngSize(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    return { width: 1105, height: 1563 };
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function findHighlight(page, phrase) {
  const matchedWords = findWordsForPhrase(page, phrase);
  return matchedWords.length ? combineBoxes(matchedWords, page.page) : null;
}

function findWordsForPhrase(page, phrase) {
  const needleWords = cleanWhitespace(phrase)
    .split(/\s+/)
    .map((word) => normalizeToken(word))
    .filter(Boolean)
    .slice(0, 8);

  if (!needleWords.length || !page.words.length) return [];

  for (let index = 0; index < page.words.length; index++) {
    const window = page.words.slice(index, index + needleWords.length);
    const score = window.filter((word, wordIndex) => normalizeToken(word.text) === needleWords[wordIndex]).length;
    if (score >= Math.max(1, Math.ceil(needleWords.length * 0.55))) return window;
  }

  const first = page.words.find((word) => normalizeToken(word.text) === needleWords[0]);
  return first ? [first] : [];
}

function lineForText(anchor, lines, rawValue) {
  return [anchor.line, ...lines].find((line) => line.text.includes(String(rawValue)));
}

function combineBoxes(words, pageNumber) {
  const validWords = words.filter(Boolean);
  const x0 = Math.min(...validWords.map((word) => word.x));
  const y0 = Math.min(...validWords.map((word) => word.y));
  const x1 = Math.max(...validWords.map((word) => word.x + word.width));
  const y1 = Math.max(...validWords.map((word) => word.y + word.height));
  return {
    page: pageNumber,
    x: Math.max(0, x0 - 4),
    y: Math.max(0, y0 - 4),
    width: x1 - x0 + 8,
    height: y1 - y0 + 8
  };
}

function cleanPartyLine(line) {
  return {
    ...line,
    text: cleanWhitespace(line.text)
      .replace(/^(?:\d+\.\s*)?(?:Shipper|Exporter|Consignee|Consigned To|MESSRS)\b\s*/i, "")
      .replace(/\b(?:Invoice number|Page number|Related Party|WMS Order|Invoice date|Shipper's reference).*$/i, "")
      .replace(/\b(?:\d+\.\s*)?EXPORT REFERENCES.*$/i, "")
      .replace(/\b(?:\d+\.\s*)?POINT \(STATE\).*$/i, "")
      .replace(/\b(?:Notify Party|PRE-CARRIAGE|CARRIER \/ VESSEL|FOREIGN PORT|TYPE OF MOVE).*$/i, "")
      .replace(/\b(?:Tel|Phone):.*$/i, "")
      .replace(/^[|:;,\-. ]+|[|:;,\-. ]+$/g, "")
  };
}

function isUsefulPartyLine(text) {
  if (!text || text.length < 3) return false;
  if (/^(same as consignee|notify party|booking|export references|vessel|voyage|port of|page\s+\d|b\/l|scac)$/i.test(text)) return false;
  if (/^(invoice date|shipper's reference|buyer|order no|hazardous material|related party|wms order)$/i.test(text)) return false;
  return true;
}

function looksLikePartyName(text) {
  if (looksLikeAddressLine(text)) return false;
  return /[A-Za-z]{2,}/.test(text) && !/\d{4,}/.test(text);
}

function looksLikeAddressLine(text) {
  return /\d/.test(text) || /\b(road|tower|avenue|ave|street|st\.?|p\.?o\.?|box|floor|calle|zona|km|autopista|miami|florida|gibraltar|honduras|tanzania|costa rica|lake|il|nj|cortes|sula)\b/i.test(text);
}

function isPlausibleAddress(value) {
  if (!value || value.length < 8) return false;
  if (value.length > 220) return false;
  if (/(EXPORT REFERENCES|POINT \(STATE\)|NOTIFY PARTY|PRE-CARRIAGE|CARRIER \/ VESSEL|FOREIGN PORT|TYPE OF MOVE|Invoice number|Page number)/i.test(value)) return false;
  return looksLikeAddressLine(value);
}

function looksLikeDocumentNumber(value) {
  const normalized = String(value || "").trim();
  if (normalized.length < 5) return false;
  if (/^(PAGE|NO|NUMBER|DATE|USD)$/i.test(normalized)) return false;
  return /[0-9]/.test(normalized) && /^[A-Z0-9-]+$/i.test(normalized);
}

function looksLikeMoney(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function extractMoneyValues(text) {
  return cleanWhitespace(text).match(/[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})|[0-9]+\.[0-9]{1,2}/g) || [];
}

function cleanDocumentNumber(value) {
  return cleanWhitespace(value).replace(/[^A-Z0-9-]/gi, "").toUpperCase();
}

function normalizePartyName(value) {
  return cleanWhitespace(value).replace(/\s+/g, " ");
}

function normalizeAddress(value) {
  return cleanWhitespace(value)
    .replace(/\bMIAMI,\s*FL\b/i, "Miami Florida")
    .replace(/\.?\s*United States$/i, "")
    .replace(/\s*,\s*/g, ", ");
}

function normalizeCommodityDescription(value) {
  return cleanWhitespace(value)
    .replace(/"[^"]+"/g, "")
    .replace(/\b(?:KGS?|LBS?|CBM|ft³|m³)\b/gi, "")
    .replace(/\s+/g, " ");
}

function centerX(box) {
  return box.x + box.width / 2;
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0;
}

function cleanWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseMoney(value) {
  const numeric = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : "";
}

module.exports = {
  extractDocument,
  FIELD_DEFINITIONS,
  FIELD_CONFIDENCE_THRESHOLD
};
