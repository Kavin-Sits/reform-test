const path = require("node:path");
const { createWorker } = require("tesseract.js");

const CACHE_PATH = path.join(__dirname, "..", ".cache", "tesseract");

const FIELD_DEFINITIONS = [
  {
    key: "billOfLadingNumber",
    label: "Bill of lading number",
    patterns: [
      /B\/L\s*No\.?\s*([A-Z0-9-]+)/i,
      /BILL\s+OF\s+LADING[\s\S]{0,140}?([0-9]{6,})/i
    ]
  },
  {
    key: "invoiceNumber",
    label: "Invoice number",
    patterns: [/Invoice\s*(?:No\.?|Number|#)?\s*[:#-]?\s*([A-Z0-9-]+)/i]
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
      /Declared\s+Value[\s\S]{0,50}(?:USD|\$)?\s*([0-9,]+(?:\.[0-9]{2})?)/i
    ],
    transform: parseMoney
  }
];

async function extractDocument(renderedPages) {
  const worker = await createWorker("eng", 1, {
    cachePath: CACHE_PATH,
    gzip: true
  });

  try {
    const pages = [];
    for (const page of renderedPages) {
      const result = await worker.recognize(page.imagePath, {}, { text: true, blocks: true });
      const words = collectWords(result.data);
      pages.push({
        ...page,
        width: result.data.pdf?.width || result.data.imageWidth || 1105,
        height: result.data.pdf?.height || result.data.imageHeight || 1563,
        text: result.data.text || "",
        words
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
    await worker.terminate();
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

function extractField(definition, pages) {
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

function extractShipperName(definition, pages) {
  const page = pages[0];
  const lines = getLines(page.text);
  const index = lines.findIndex((line) => /^shipper\b/i.test(line));
  const value = firstMeaningfulLine(lines.slice(index + 1, index + 5));
  return value ? makeField(definition, value, page, value, 86) : makeMissingField(definition);
}

function extractShipperAddress(definition, pages) {
  const page = pages[0];
  const lines = getLines(page.text);
  const index = lines.findIndex((line) => /^shipper\b/i.test(line));
  const stop = lines.findIndex((line, lineIndex) => lineIndex > index && /^consignee\b/i.test(line));
  const section = lines.slice(index + 1, stop > index ? stop : index + 6).filter(isMeaningfulPartyLine);
  const address = section.slice(1).join(", ");
  return address ? makeField(definition, address, page, section.join(" "), 80) : makeMissingField(definition);
}

function extractConsigneeName(definition, pages) {
  const page = pages[0];
  const section = partySection(page.text, "consignee", ["notify party", "vessel", "port of loading"]);
  const value = firstMeaningfulLine(section);
  return value ? makeField(definition, value, page, value, 83) : makeMissingField(definition);
}

function extractConsigneeAddress(definition, pages) {
  const page = pages[0];
  const section = partySection(page.text, "consignee", ["notify party", "vessel", "port of loading"]).filter(isMeaningfulPartyLine);
  const address = section.slice(1).join(", ");
  return address ? makeField(definition, address, page, section.join(" "), 78) : makeMissingField(definition);
}

function partySection(text, startLabel, endLabels) {
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
  const items = [];

  for (const page of pages) {
    const lines = getLines(page.text);
    const vehicleLines = lines.filter((line) => /Vehicle\s+Ref|Toyota|Land\s+Cruiser|Chassis|Engine\s+No/i.test(line));

    for (let index = 0; index < vehicleLines.length; index += 4) {
      const group = vehicleLines.slice(index, index + 4);
      if (!group.length) continue;
      const description = group.join(" ");
      const quantityMatch = description.match(/\b(\d+)\s+(?:vehicle|vehicles|Container)/i);
      const htsMatch = description.match(/\b\d{4}\.\d{2}(?:\.\d{2})?\b/);
      items.push({
        id: `${page.page}-${items.length + 1}`,
        quantity: quantityMatch ? Number(quantityMatch[1]) : 1,
        description: cleanWhitespace(description),
        value: null,
        htsCode: htsMatch?.[0] || "",
        confidence: htsMatch ? 64 : 58,
        page: page.page,
        highlight: findHighlight(page, group[0] || description)
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

function makeField(definition, value, page, sourceText, confidence) {
  return {
    key: definition.key,
    label: definition.label,
    value,
    confidence,
    page: page.page,
    sourceText: cleanWhitespace(sourceText),
    highlight: findHighlight(page, String(sourceText || value))
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
  const needleWords = cleanWhitespace(phrase)
    .split(/\s+/)
    .map((word) => normalizeToken(word))
    .filter(Boolean)
    .slice(0, 6);

  if (!needleWords.length || !page.words.length) return null;

  for (let index = 0; index < page.words.length; index++) {
    const window = page.words.slice(index, index + needleWords.length);
    const score = window.filter((word, wordIndex) => normalizeToken(word.text) === needleWords[wordIndex]).length;
    if (score >= Math.max(1, Math.ceil(needleWords.length * 0.5))) {
      return combineBoxes(window, page.page);
    }
  }

  const first = page.words.find((word) => normalizeToken(word.text) === needleWords[0]);
  return first ? combineBoxes([first], page.page) : null;
}

function combineBoxes(words, pageNumber) {
  const x0 = Math.min(...words.map((word) => word.x));
  const y0 = Math.min(...words.map((word) => word.y));
  const x1 = Math.max(...words.map((word) => word.x + word.width));
  const y1 = Math.max(...words.map((word) => word.y + word.height));
  return {
    page: pageNumber,
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0
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
  return line && !/^(same as consignee|notify party|booking|export references|vessel|voyage|port of)/i.test(line);
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
