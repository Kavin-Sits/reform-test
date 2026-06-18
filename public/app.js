const state = {
  documents: [],
  activeId: null,
  activeHighlight: null
};

const elements = {
  fileInput: document.querySelector("#file-input"),
  uploadStatus: document.querySelector("#upload-status"),
  documentList: document.querySelector("#document-list"),
  activeTitle: document.querySelector("#active-title"),
  activeSubtitle: document.querySelector("#active-subtitle"),
  pdfLink: document.querySelector("#pdf-link"),
  pages: document.querySelector("#pages"),
  fields: document.querySelector("#fields"),
  confidenceSummary: document.querySelector("#confidence-summary"),
  lineItems: document.querySelector("#line-items")
};

elements.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  await uploadFile(file);
  event.target.value = "";
});

async function loadDocuments() {
  const response = await fetch("/api/documents");
  state.documents = await response.json();
  state.activeId = state.activeId || state.documents[0]?.id || null;
  render();
}

async function uploadFile(file) {
  elements.uploadStatus.textContent = "Processing OCR...";
  const body = new FormData();
  body.append("file", file);

  try {
    const response = await fetch("/api/documents", { method: "POST", body });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Upload failed");
    state.documents.unshift(payload);
    state.activeId = payload.id;
    elements.uploadStatus.textContent = "Ready";
    render();
  } catch (error) {
    elements.uploadStatus.textContent = error.message;
  }
}

async function deleteDocument(id) {
  const response = await fetch(`/api/documents/${id}`, { method: "DELETE" });
  if (!response.ok) {
    elements.uploadStatus.textContent = "Delete failed";
    return;
  }

  state.documents = state.documents.filter((doc) => doc.id !== id);
  if (state.activeId === id) {
    state.activeId = state.documents[0]?.id || null;
    state.activeHighlight = null;
  }
  elements.uploadStatus.textContent = "Removed";
  render();
}

function render() {
  const active = state.documents.find((doc) => doc.id === state.activeId);
  renderDocumentList();
  renderActiveDocument(active);
}

function renderDocumentList() {
  elements.documentList.innerHTML = "";

  if (!state.documents.length) {
    elements.documentList.innerHTML = '<p class="empty-note">No uploaded documents yet.</p>';
    return;
  }

  for (const doc of state.documents) {
    const button = document.createElement("button");
    button.className = `document-button ${doc.id === state.activeId ? "active" : ""}`;
    button.innerHTML = `
      <span class="document-row">
        <span class="document-name">${escapeHtml(doc.fileName)}</span>
        <span class="remove-document" title="Remove uploaded file">Remove</span>
      </span>
      <span class="document-meta">${formatDate(doc.uploadedAt)} · ${escapeHtml(doc.status)}</span>
    `;
    button.addEventListener("click", async (event) => {
      if (event.target.classList.contains("remove-document")) {
        event.stopPropagation();
        await deleteDocument(doc.id);
        return;
      }
      state.activeId = doc.id;
      state.activeHighlight = null;
      render();
    });
    elements.documentList.appendChild(button);
  }
}

function renderActiveDocument(doc) {
  if (!doc) {
    elements.activeTitle.textContent = "No document selected";
    elements.activeSubtitle.textContent = "Upload a PDF to extract shipment data.";
    elements.pdfLink.hidden = true;
    elements.pages.className = "pages empty-state";
    elements.pages.innerHTML = "<p>PDF pages and extraction highlights will appear here.</p>";
    elements.fields.innerHTML = "";
    elements.lineItems.innerHTML = "";
    setConfidence(elements.confidenceSummary, null);
    return;
  }

  elements.activeTitle.textContent = doc.fileName;
  elements.activeSubtitle.textContent = `${doc.pages.length} pages · ${doc.summary.needsReview ? "Needs review" : "Ready"}`;
  elements.pdfLink.href = doc.pdfUrl;
  elements.pdfLink.hidden = false;
  setConfidence(elements.confidenceSummary, doc.summary.averageConfidence);
  renderPages(doc);
  renderFields(doc.fields || []);
  renderLineItems(doc.lineItems || []);
}

function renderPages(doc) {
  elements.pages.className = "pages";
  elements.pages.innerHTML = "";

  for (const page of doc.pages) {
    const shell = document.createElement("div");
    shell.className = "page-shell";
    shell.dataset.page = page.page;
    shell.innerHTML = `<img src="${page.imageUrl}" alt="Page ${page.page}" />`;
    elements.pages.appendChild(shell);
  }

  showHighlight(state.activeHighlight);
}

function renderFields(fields) {
  elements.fields.innerHTML = "";

  for (const field of fields) {
    const button = document.createElement("button");
    button.className = "field-button";
    button.disabled = !field.highlight;
    button.innerHTML = `
      <span class="field-topline">
        <span class="field-label">${escapeHtml(field.label)}</span>
        <span class="confidence ${confidenceClass(field.confidence)}">${field.confidence || 0}%</span>
      </span>
      <span class="field-value">${escapeHtml(String(field.value || "Needs review"))}</span>
      <span class="field-source">${field.page ? `Page ${field.page}` : "No source found"}</span>
    `;
    button.addEventListener("click", () => showHighlight(field.highlight));
    elements.fields.appendChild(button);
  }
}

function renderLineItems(items) {
  elements.lineItems.innerHTML = "";

  if (!items.length) {
    elements.lineItems.innerHTML = '<p class="empty-note">No line items found.</p>';
    return;
  }

  for (const item of items) {
    const node = document.createElement("button");
    node.className = "field-button";
    node.innerHTML = `
      <span class="field-topline">
        <span class="field-label">Line item</span>
        <span class="confidence ${confidenceClass(item.confidence)}">${item.confidence}%</span>
      </span>
      <span class="field-value">${escapeHtml(item.description || "Needs review")}</span>
      <span class="line-grid">
        <span>Qty: ${escapeHtml(item.quantity ?? "--")}</span>
        <span>Value: ${escapeHtml(item.value ?? "--")}</span>
        <span>HTS: ${escapeHtml(item.htsCode || "--")}</span>
      </span>
    `;
    node.addEventListener("click", () => showHighlight(item.highlight));
    elements.lineItems.appendChild(node);
  }
}

function showHighlight(highlight) {
  state.activeHighlight = highlight;
  document.querySelectorAll(".highlight").forEach((node) => node.remove());
  if (!highlight) return;

  const page = document.querySelector(`.page-shell[data-page="${highlight.page}"]`);
  if (!page) return;

  const activeDoc = state.documents.find((doc) => doc.id === state.activeId);
  const pageData = activeDoc?.pages.find((item) => item.page === highlight.page);
  if (!pageData) return;

  const marker = document.createElement("div");
  marker.className = "highlight visible";
  marker.style.left = `${(highlight.x / pageData.width) * 100}%`;
  marker.style.top = `${(highlight.y / pageData.height) * 100}%`;
  marker.style.width = `${(highlight.width / pageData.width) * 100}%`;
  marker.style.height = `${(highlight.height / pageData.height) * 100}%`;
  page.appendChild(marker);
  page.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setConfidence(node, value) {
  node.textContent = value == null ? "--" : `${value}%`;
  node.className = `confidence ${confidenceClass(value)}`;
}

function confidenceClass(value) {
  if (value == null) return "neutral";
  if (value >= 80) return "high";
  if (value >= 55) return "medium";
  return "low";
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadDocuments();
