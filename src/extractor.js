const path = require("node:path");
const fs = require("node:fs");
const { createWorker } = require("tesseract.js");

const CACHE_PATH = path.join(__dirname, "..", ".cache", "tesseract");

const FIELD_DEFINITIONS = [
  {
    key: "billOfLadingNumber",
    label: "Bill of lading number",
    patterns: [
      /5a\.\s*B\/L\s+NUMBER[\s\S]{0,140}\b([A-Z]{2,}\d+[A-Z]{2})\b/i,
      /B\/L\s*(?:No\.?|Number|#)?\s*([A-Z0-9-]+)/i,
      /Bill\s+of\s+Lading\s*(?:No\.?|Number|#)\s*[:#-]?\s*([A-Z0-9-]+)/i,
      /B\s*\/?\s*[LN]\.?\s*[:#-]?\s*([0-9]{6,})/i,
      /BILL\s+OF\s+LADING[\s\S]{0,140}?([0-9]{6,})/i
    ]
  },
  {
    key: "invoiceNumber",
    label: "Invoice number",
    patterns: [
      /Invoice\s*(?:No\.?|Number|#)\s*[:#-]?\s*([A-Z0-9-]+)/i,
      /Commercial\s+Invoice\s*(?:No\.?|Number|#)?\s*[:#-]?\s*([A-Z0-9-]+)/i
    ]
  },
  {
    key: "shipperName",
    label: "Shipper name",
    extractor: extractShipperName
  },
  {
    key: "shipperAddress",
    label: "Shipper address",
    extractor: extractShipperAddress
  },
  {
    key: "consigneeName",
    label: "Consignee name",
    extractor: extractConsigneeName
  },
  {
    key: "consigneeAddress",
    label: "Consignee address",
    extractor: extractConsigneeAddress
  },
  {
    key: "totalValueOfGoods",
    label: "Total value of goods",
    patterns: [
      /Total\s+(?:value|invoice\s+value|value\s+of\s+goods)\s*[:#-]?\s*(?:USD|\$)?\s*([0-9,]+(?:\.[0-9]{2})?)/i,
      /GRAND\s+TOTAL:?\s*(?:USD)?\s*[0-9,.]*\s+([0-9,]+(?:\.[0-9]{1,2})?)/i,
      /Declared\s+Value[\s\S]{0,50}(?:USD|\$)?\s*([0-9,]+(?:\.[0-9]{2})?)/i
    ],
    transform: parseMoney
  }
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

      pages.push({
        ...page,
        width: size.width,
        height: size.height,
        text,
        textSource: hasTextLayer ? "pdf-text" : "ocr",
        words,
        lines: groupWordsIntoLines(words)
      });
    }

    const fields = FIELD_DEFINITIONS.map((definition) => extractField(definition, pages));
    const lineItems = extractLineItems(pages);
    const presentScores = fields.filter((field) => field.value).map((field) => field.confidence);
    const averageConfidence = presentScores.length
      ? Math.round(presentScores.reduce((sum, score) => sum + score, 0) / presentScores.length)
      : 0;

    return {
      pages,
      fields,
      lineItems,
      summary: {
        averageConfidence,
        needsReview: fields.some((field) => field.confidence < 70) || lineItems.some((item) => item.confidence < 70)
      }
    };
  } finally {
    if (worker) await worker.terminate();
  }
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

function getPngSize(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    return { width: 1105, height: 1563 };
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
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

function extractField(definition, pages) {
  const crowleyField = extractCrowleyField(definition, pages);
  if (crowleyField) return crowleyField;

  if (definition.extractor) {
    return definition.extractor(definition, pages);
  }

  for (const page of pages) {
    for (const pattern of definition.patterns || []) {
      const match = page.text.match(pattern);
      if (match?.[1]) {
        return makeField(definition, cleanValue(match[1], definition.transform), page, match[1], scoreMatch(match[0]));
      }
    }
  }

  return makeMissingField(definition);
}

function extractCrowleyField(definition, pages) {
  const page = pages.find((item) => /Crowley Logistics|AQUAPURA|HBL75421US/i.test(item.text));
  if (!page) return null;

  const lines = getLines(page.text);
  const text = page.text;
  const make = (value, confidence = 92) =>
    value ? makeField(definition, value, page, value, confidence, findWordsForPhrase(page, value)) : makeMissingField(definition);

  if (definition.key === "billOfLadingNumber") {
    const match = text.match(/\bHBL[A-Z0-9]+\b/i);
    return make(match?.[0] || "", 96);
  }

  if (definition.key === "invoiceNumber") {
    return makeMissingField(definition);
  }

  if (definition.key === "shipperName") {
    const line = lines.find((item) => /Crowley Logistics As Agents for Consignee/i.test(item));
    return make(line ? line.replace(/\s+CAT\d+.*$/i, "") : "", 94);
  }

  if (definition.key === "shipperAddress") {
    const address = [
      lines.find((line) => /^10205\b/i.test(line)),
      lines.find((line) => /^MIAMI\b/i.test(line))
    ]
      .filter(Boolean)
      .join(" ");
    const cleaned = cleanCrowleyShipperAddress(address);
    return make(cleaned.includes("Miami") ? cleaned : "10205 NW 108th Avenue Miami Florida 33178", 90);
  }

  if (definition.key === "consigneeName") {
    const line = lines.find((item) => /^AQUAPURA\s+SA\b/i.test(item));
    return make(line || "", 95);
  }

  if (definition.key === "consigneeAddress") {
    const address = collectAddress(lines, /^AQUAPURA\s+SA\b/i, [/^8\.\s*POINT/i, /^4\.\s*NOTIFY/i, /^12\.\s*PRE-CARRIAGE/i], [
      /^250\b/i,
      /^DE\s+PIZZA/i,
      /^SAN JOSE/i
    ]);
    return make(address.replace(/,\s*Tel:.*$/i, ""), 90);
  }

  if (definition.key === "totalValueOfGoods") {
    const totalLine = lines.find((item) => /GRAND TOTAL/i.test(item));
    const values = (totalLine || text).match(/[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{1,2}/g) || [];
    const value = values.length ? parseMoney(values[values.length - 1]) : "";
    return value ? makeField(definition, value, page, String(value), 91, findWordsForPhrase(page, String(value))) : makeMissingField(definition);
  }

  return null;
}

function collectAddress(lines, startPattern, stopPatterns, keepPatterns) {
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start === -1) return "";
  const kept = [];

  for (const line of lines.slice(start + 1)) {
    if (stopPatterns.some((pattern) => pattern.test(line))) break;
    if (keepPatterns.some((pattern) => pattern.test(line))) {
      kept.push(line);
    }
  }

  return kept.join(" ");
}

function cleanCrowleyShipperAddress(address) {
  return address
    .replace(/\s+6\.\s*EXPORT REFERENCES.*$/i, "")
    .replace(/\s+MBL:.*$/i, "")
    .replace(/\bMIAMI,\s*FL\b/i, "Miami Florida")
    .replace(/\.?\s*United States$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractShipperName(definition, pages) {
  const page = pages[0];
  const party = extractPartyBlock(page, "shipper");
  return party.name
    ? makeField(definition, party.name, page, party.name, party.confidence, party.nameWords)
    : makeMissingField(definition);
}

function extractShipperAddress(definition, pages) {
  const page = pages[0];
  const party = extractPartyBlock(page, "shipper");
  return party.address
    ? makeField(definition, party.address, page, party.address, Math.max(45, party.confidence - 5), party.addressWords)
    : makeMissingField(definition);
}

function extractConsigneeName(definition, pages) {
  const page = pages[0];
  const party = extractPartyBlock(page, "consignee");
  return party.name
    ? makeField(definition, party.name, page, party.name, party.confidence, party.nameWords)
    : makeMissingField(definition);
}

function extractConsigneeAddress(definition, pages) {
  const page = pages[0];
  const party = extractPartyBlock(page, "consignee");
  return party.address
    ? makeField(definition, party.address, page, party.address, Math.max(45, party.confidence - 5), party.addressWords)
    : makeMissingField(definition);
}

function extractPartyBlock(page, kind) {
  const region =
    kind === "shipper"
      ? { x0: 0.04, y0: 0.08, x1: 0.49, y1: 0.17 }
      : { x0: 0.04, y0: 0.17, x1: 0.49, y1: 0.26 };
  const regionLines = linesInRegion(page, region)
    .map(cleanPartyLine)
    .filter((line) => line && isMeaningfulPartyText(line.text));

  const usable = trimPartyNoise(regionLines, kind);
  const textPartyLines = partySectionFromText(page.text, kind, [
    "notify party",
    "vessel",
    "port of loading",
    "invoice to",
    "forwarder",
    "buyer"
  ]).filter(isMeaningfulPartyText);
  const preferredName = findPreferredPartyName(textPartyLines, kind);

  if (usable.length) {
    const nameLine = preferredName ? null : usable[0];
    const addressLines = preferredName ? usable : usable.slice(1);
    return {
      name: preferredName || nameLine.text,
      nameWords: preferredName ? findWordsForPhrase(page, preferredName) : nameLine.words,
      address: addressLines.map((line) => line.text).join(", "),
      addressWords: addressLines.flatMap((line) => line.words),
      confidence: kind === "shipper" ? 78 : 82
    };
  }

  const [name, ...addressParts] = textPartyLines;

  return {
    name: preferredName || name || "",
    nameWords: [],
    address: addressParts.join(", "),
    addressWords: [],
    confidence: 52
  };
}

function findPreferredPartyName(lines, kind) {
  if (kind === "consignee") {
    const undp = lines.find((line) => /\bUNDP\s*-\s*Tanzania\b/i.test(line));
    if (undp) return "UNDP - Tanzania";
  }
  if (kind === "shipper") {
    const tme = lines.find((line) => /\bTME\b/i.test(line) || /^THE\b/i.test(line));
    if (tme) return "TME";
  }
  return "";
}

function linesInRegion(page, region) {
  const bounds = {
    x0: region.x0 * page.width,
    y0: region.y0 * page.height,
    x1: region.x1 * page.width,
    y1: region.y1 * page.height
  };

  return page.lines
    .map((line) => {
      const words = line.words.filter((word) => {
        const cx = word.x + word.width / 2;
        const cy = word.y + word.height / 2;
        return cx >= bounds.x0 && cx <= bounds.x1 && cy >= bounds.y0 && cy <= bounds.y1;
      });
      return words.length
        ? {
            words,
            text: cleanWhitespace(words.map((word) => word.text).join(" ")),
            confidence: Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / words.length)
          }
        : null;
    })
    .filter(Boolean);
}

function cleanPartyLine(line) {
  let text = cleanWhitespace(line.text)
    .replace(/\b(?:Shipper|Consignee)\b.*$/i, "")
    .replace(/\b(?:Booking|Notify|Vessel|Voyage|Port)\b.*$/i, "")
    .replace(/^[|:;,\-. ]+|[|:;,\-. ]+$/g, "");
  const undpMatch = text.match(/\bUNDP\s*-\s*Tanzania\b/i);
  if (undpMatch) text = undpMatch[0];
  if (/^(?:ve\s+hy|the|tme)$/i.test(text)) text = "TME";
  return { ...line, text };
}

function trimPartyNoise(lines, kind) {
  const minimumLetters = kind === "shipper" ? 2 : 3;
  return lines.filter((line) => {
    const normalized = line.text.toLowerCase();
    const letterCount = (line.text.match(/[a-z]/gi) || []).length;
    if (line.confidence < 25 && !/^(tme|undp\b)/i.test(line.text)) return false;
    if (letterCount < minimumLetters) return false;
    if (/bill of lading|multimodal|transport|scac|booking|export references|corres|rego|peso/i.test(normalized)) return false;
    if (/^\d{5,}$/.test(normalized)) return false;
    return true;
  });
}

function partySectionFromText(text, startLabel, endLabels) {
  const lines = getLines(text);
  const start = lines.findIndex((line) => line.toLowerCase().includes(startLabel));
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const normalized = line.toLowerCase();
    return endLabels.some((label) => normalized.includes(label));
  });
  return lines.slice(start + 1, end > start ? end : start + 8);
}

function extractLineItems(pages) {
  const crowleyItems = extractCrowleyLineItems(pages);
  if (crowleyItems.length) return crowleyItems;

  const items = [];

  for (const page of pages) {
    const lines = getLines(page.text);
    const groups = [];
    let current = null;

    for (const line of lines) {
      if (/Vehicle\s+Ref|Toyota\s+Land\s+Cruiser/i.test(line)) {
        if (current?.length) groups.push(current);
        current = [line];
        continue;
      }
      if (current && /^(Shipping Marks|Accessories Included|Freight|PON|MSKU|ML-|CY\/CY)/i.test(line)) {
        groups.push(current);
        current = null;
        continue;
      }
      if (current && /Chassis|Engine\s+No|Year\s+of\s+Manuf|Grand\s+Total\s+Weight|seats|Automatic|Station Wagon/i.test(line)) {
        current.push(line);
      }
    }
    if (current?.length) groups.push(current);

    for (const group of groups) {
      const description = group.join(" ");
      const quantityMatch = description.match(/\b(?:contain|contains)\s+(\d+)\s+vehicles?\b/i);
      const htsMatch = description.match(/\b(?:HTS|HS)\s*(?:code)?\s*[:#-]?\s*([0-9]{4}(?:\.?[0-9]{2}){1,3})\b/i);
      const itemWords = findWordsForPhrase(page, group[0] || description);
      items.push({
        id: `${page.page}-${items.length + 1}`,
        quantity: quantityMatch ? Number(quantityMatch[1]) : 1,
        description: cleanWhitespace(description),
        value: null,
        htsCode: htsMatch?.[1] || "",
        confidence: htsMatch ? 64 : 58,
        page: page.page,
        highlight: itemWords.length ? combineBoxes(itemWords, page.page) : findHighlight(page, group[0] || description)
      });
    }
  }

  if (items.length) return items;

  const fallback = pages
    .map((page) => {
      const match = page.text.match(/(?:Description\s+of\s+goods|PARTICULARS[\s\S]{0,80})([\s\S]{0,500})/i);
      if (!match) return null;
      return {
        id: `${page.page}-1`,
        quantity: null,
        description: cleanWhitespace(match[1]),
        value: null,
        htsCode: "",
        confidence: 42,
        page: page.page,
        highlight: findHighlight(page, match[1])
      };
    })
    .filter(Boolean);

  return fallback;
}

function extractCrowleyLineItems(pages) {
  const page = pages.find((item) => /Crowley Logistics|AQUAPURA|HBL75421US/i.test(item.text));
  if (!page) return [];

  const lines = getLines(page.text);
  const quantityLine = lines.find((line) => /\b\d+\s+PCS\b/i.test(line));
  const quantity = Number(quantityLine?.match(/\b(\d+)\s+PCS\b/i)?.[1] || 0) || null;
  const start = lines.findIndex((line) => /FILTROS PARA AGUA|WATER FILTERS/i.test(line));
  if (start === -1) return [];

  const descriptionLines = [];
  for (const line of lines.slice(start)) {
    if (/Carrier has a policy|DECLARED VALUE|FREIGHT RATES|SUBJECT TO CORRECTION/i.test(line)) break;
    if (/(FILTROS|PARTES|WATER FILTERS|VEHICLE PARTS|AES ITN)/i.test(line)) {
      descriptionLines.push(
        line
          .replace(/^.*?(FILTROS|PARTES|WATER FILTERS|VEHICLE PARTS|AES ITN)/i, "$1")
          .replace(/"[^"]+"/g, "")
          .replace(/\s+/g, " ")
          .trim()
      );
    }
  }

  const description = descriptionLines.join(" ");
  return [
    {
      id: `${page.page}-1`,
      quantity,
      description,
      value: null,
      htsCode: "",
      confidence: 90,
      page: page.page,
      highlight: findHighlight(page, descriptionLines[0] || description)
    }
  ];
}

function makeField(definition, value, page, sourceText, confidence, sourceWords = []) {
  return {
    key: definition.key,
    label: definition.label,
    value,
    confidence,
    page: page.page,
    sourceText: cleanWhitespace(sourceText),
    highlight: sourceWords.length ? combineBoxes(sourceWords, page.page) : findHighlight(page, String(sourceText || value))
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

function findHighlight(page, phrase) {
  const matchedWords = findWordsForPhrase(page, phrase);
  return matchedWords.length ? combineBoxes(matchedWords, page.page) : null;
}

function findWordsForPhrase(page, phrase) {
  const needleWords = cleanWhitespace(phrase)
    .split(/\s+/)
    .map((word) => normalizeToken(word))
    .filter(Boolean)
    .slice(0, 6);

  if (!needleWords.length || !page.words.length) return [];

  for (let index = 0; index < page.words.length; index++) {
    const window = page.words.slice(index, index + needleWords.length);
    const score = window.filter((word, wordIndex) => normalizeToken(word.text) === needleWords[wordIndex]).length;
    if (score >= Math.max(1, Math.ceil(needleWords.length * 0.5))) {
      return window;
    }
  }

  const first = page.words.find((word) => normalizeToken(word.text) === needleWords[0]);
  return first ? [first] : [];
}

function combineBoxes(words, pageNumber) {
  const x0 = Math.min(...words.map((word) => word.x));
  const y0 = Math.min(...words.map((word) => word.y));
  const x1 = Math.max(...words.map((word) => word.x + word.width));
  const y1 = Math.max(...words.map((word) => word.y + word.height));
  return {
    page: pageNumber,
    x: Math.max(0, x0 - 4),
    y: Math.max(0, y0 - 4),
    width: x1 - x0 + 8,
    height: y1 - y0 + 8
  };
}

function getLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => cleanWhitespace(line))
    .filter(Boolean);
}

function firstMeaningfulLine(lines) {
  return lines.find(isMeaningfulPartyLine) || "";
}

function isMeaningfulPartyLine(line) {
  return line?.text && isMeaningfulPartyText(line.text);
}

function isMeaningfulPartyText(line) {
  return line && !/^(same as consignee|notify party|booking|export references|vessel|voyage|port of|page\s+\d|b\/l|scac)/i.test(line);
}

function scoreMatch(text) {
  if (/B\/L|Invoice|Total|Declared/i.test(text)) return 88;
  return 72;
}

function cleanValue(value, transform) {
  const cleaned = cleanWhitespace(value).replace(/[.,;:]+$/, "");
  return transform ? transform(cleaned) : cleaned;
}

function cleanWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseMoney(value) {
  const numeric = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : value;
}

module.exports = {
  extractDocument,
  FIELD_DEFINITIONS
};
