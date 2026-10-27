"use strict";

const $ = (selector) => document.querySelector(selector);
const MAX_RESULT_ROWS = 500;
const state = {
  connected: false,
  connection: null,
  schemas: [],
  schema: null,
  table: null,
  columns: [],
  rows: [],
  offset: 0,
  limit: 50,
  estimate: 0,
  kind: "r",
  tab: "data",
  activity: [],
  resultSets: [],
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("#toast-region").append(element);
  window.setTimeout(() => element.remove(), 3500);
}

function logActivity(action, detail, icon = "⌘") {
  state.activity.unshift({ action, detail, icon, time: "Just now" });
  state.activity = state.activity.slice(0, 100);
  renderActivity();
}

function renderSchemas() {
  const host = $("#schema-list");
  if (!state.schemas.length) {
    host.innerHTML = `<p class="sidebar-empty">${state.connected ? "No visible schemas." : "Connect to a local database to browse schemas."}</p>`;
    return;
  }
  host.innerHTML = state.schemas.map((schema) => `
    <div class="schema-group">
      <button class="schema-toggle ${schema.name === state.schema ? "" : "collapsed"}" data-schema="${escapeHtml(schema.name)}">
        <span class="chevron">${schema.name === state.schema ? "⌄" : "›"}</span>
        <span class="schema-cube">◇</span><strong>${escapeHtml(schema.name)}</strong>
        <span class="table-count">${schema.table_count}</span>
      </button>
      <div class="table-tree ${schema.name === state.schema ? "" : "hidden"}" data-schema-tables="${escapeHtml(schema.name)}"></div>
    </div>`).join("");
  host.querySelectorAll("[data-schema]").forEach((button) => {
    button.addEventListener("click", () => void selectSchema(button.dataset.schema));
  });
}

async function selectSchema(schemaName) {
  if (!state.connected) return;
  if (state.schema === schemaName) {
    const list = document.querySelector(`[data-schema-tables="${CSS.escape(schemaName)}"]`);
    const toggle = document.querySelector(`[data-schema="${CSS.escape(schemaName)}"]`);
    if (list && toggle) {
      list.classList.toggle("hidden");
      toggle.classList.toggle("collapsed");
      toggle.querySelector(".chevron").textContent = list.classList.contains("hidden") ? "›" : "⌄";
    }
    return;
  }
  state.schema = schemaName;
  state.table = null;
  state.columns = [];
  state.rows = [];
  document.querySelectorAll("[data-schema]").forEach((button) => {
    const selected = button.dataset.schema === schemaName;
    button.classList.toggle("collapsed", !selected);
    button.querySelector(".chevron").textContent = selected ? "⌄" : "›";
    document.querySelector(`[data-schema-tables="${CSS.escape(button.dataset.schema)}"]`)?.classList.toggle("hidden", !selected);
  });
  renderCurrentTable();
  try {
    const { tables } = await api(`/api/tables?schema=${encodeURIComponent(schemaName)}`);
    const list = document.querySelector(`[data-schema-tables="${CSS.escape(schemaName)}"]`);
    list.innerHTML = tables.map((table) => `
      <button class="tree-item" data-table="${escapeHtml(table.name)}">
        <span class="tree-icon">▤</span><span>${escapeHtml(table.name)}</span>
        <span class="tree-count">${Number(table.row_estimate).toLocaleString()}</span>
      </button>`).join("") || `<p class="sidebar-empty">No tables in this schema.</p>`;
    list.querySelectorAll("[data-table]").forEach((button) => {
      button.addEventListener("click", () => void selectTable(schemaName, button.dataset.table));
    });
    if (tables.length) {
      state.table = tables[0].name;
      list.querySelector(`[data-table="${CSS.escape(state.table)}"]`)?.classList.add("selected");
      await loadTable();
      renderCurrentTable();
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function selectTable(schemaName, tableName) {
  state.schema = schemaName;
  state.table = tableName;
  state.offset = 0;
  state.tab = "data";
  document.querySelectorAll(".panel-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "data"));
  document.querySelectorAll(".tree-item").forEach((button) => button.classList.toggle("selected", button.dataset.table === tableName));
  try {
    await loadTable();
    renderCurrentTable();
    logActivity("Opened table", `${schemaName}.${tableName}`, "▦");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadTable() {
  if (!state.connected || !state.table) return;
  const params = new URLSearchParams({
    schema: state.schema,
    table: state.table,
    offset: String(state.offset),
    limit: String(state.limit),
  });
  const result = await api(`/api/table?${params}`);
  state.columns = result.columns;
  state.rows = result.rows;
  state.estimate = result.rowEstimate;
  state.kind = result.kind;
}

function formatCell(value) {
  if (value === null) return `<span class="null-value">NULL</span>`;
  if (typeof value === "object") return `<code class="json-value">${escapeHtml(JSON.stringify(value))}</code>`;
  if (typeof value === "boolean") return `<span class="status-badge ${value ? "" : "status-inactive"}">${value ? "TRUE" : "FALSE"}</span>`;
  return `<span>${escapeHtml(value)}</span>`;
}

function renderCurrentTable() {
  const tableContainer = $("#table-container");
  if (!state.table) {
    tableContainer.innerHTML = `<div class="empty-panel">${state.connected ? "Select a table to view its data." : "Connect to a local database to browse tables."}</div>`;
    $("#schema-name").textContent = state.schema || "—";
    $("#table-title").textContent = "Select a table";
    $("#table-description").textContent = "Browse tables and live data in your local database.";
    $("#record-count").textContent = "—";
    $("#column-count").textContent = "—";
    $("#loaded-count").textContent = "—";
    $("#object-type").textContent = "—";
    $("#shown-count").textContent = "No table selected";
    $("#pagination-label").textContent = state.connected ? "Select a table to view its data." : "Connect to a local database to browse tables";
    $("#table-toolbar").classList.add("hidden");
    $(".pagination").classList.add("hidden");
    $("#add-row-button").disabled = true;
    return;
  }
  $("#table-toolbar").classList.remove("hidden");
  $(".pagination").classList.remove("hidden");
  $("#add-row-button").disabled = false;
  $("#table-title").textContent = state.table;
  $("#table-description").textContent = `${state.schema}.${state.table}`;
  $("#schema-name").textContent = state.schema;
  $("#breadcrumb-current").textContent = `${state.schema}.${state.table}`;
  $("#record-count").textContent = state.estimate.toLocaleString();
  $("#column-count").textContent = state.columns.length;
  $("#loaded-count").textContent = state.rows.length;
  $("#object-type").textContent = state.kind === "v" ? "View" : state.kind === "m" ? "Materialized view" : state.kind === "f" ? "Foreign table" : "Table";
  $("#tab-row-count").textContent = state.estimate.toLocaleString();
  $("#shown-count").textContent = `Showing ${state.rows.length} rows · ${state.estimate.toLocaleString()} estimated total`;
  $("#pagination-label").textContent = `Page ${Math.floor(state.offset / state.limit) + 1}`;
  $("#page-number").textContent = String(Math.floor(state.offset / state.limit) + 1);
  $("#page-back").disabled = state.offset === 0;
  $("#previous-page").disabled = state.offset === 0;
  $("#page-forward").disabled = state.rows.length < state.limit;
  $("#next-page").disabled = state.rows.length < state.limit;
  if (state.tab === "structure") {
    const rows = state.columns.map((column) => `<tr>
      <td class="mono">${escapeHtml(column.column_name)}</td><td>${escapeHtml(column.data_type)}${column.udt_name && column.data_type === "USER-DEFINED" ? ` (${escapeHtml(column.udt_name)})` : ""}</td>
      <td>${column.is_nullable === "YES" ? "Yes" : "No"}</td><td>${column.is_primary_key ? "PRIMARY KEY" : "—"}</td><td class="mono">${escapeHtml(column.column_default || "—")}</td>
    </tr>`).join("");
    tableContainer.innerHTML = `<table class="data-table"><thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Key</th><th>Default</th></tr></thead><tbody>${rows}</tbody></table>`;
    return;
  }
  const headers = state.columns.map((column) => `<th>${escapeHtml(column.column_name)} <small>${escapeHtml(column.data_type)}</small></th>`).join("");
  const rows = state.rows.map((row, index) => `<tr>
    ${state.columns.map((column) => `<td>${formatCell(row[column.column_name])}</td>`).join("")}
    <td><div class="row-actions"><button data-edit-row="${index}" aria-label="Edit row">✎</button><button data-delete-row="${index}" aria-label="Delete row">⌫</button></div></td>
  </tr>`).join("");
  tableContainer.innerHTML = `<table class="data-table"><thead><tr>${headers}<th></th></tr></thead><tbody>${rows || `<tr><td class="empty-state" colspan="${state.columns.length + 1}">No rows on this page.</td></tr>`}</tbody></table>`;
  tableContainer.querySelectorAll("[data-edit-row]").forEach((button) => button.addEventListener("click", () => openRowDialog(Number(button.dataset.editRow))));
  tableContainer.querySelectorAll("[data-delete-row]").forEach((button) => button.addEventListener("click", () => void deleteRow(Number(button.dataset.deleteRow))));
}

function renderResultSets() {
  const host = $("#query-result-table");
  if (!state.resultSets.length) {
    host.classList.add("hidden");
    $("#results-placeholder").classList.remove("hidden");
    return;
  }
  $("#results-placeholder").classList.add("hidden");
  host.classList.remove("hidden");
  host.innerHTML = state.resultSets.map((result, index) => {
    if (!result.fields.length) return `<p class="query-command">${escapeHtml(result.command || "Query")} · ${result.rowCount ?? 0} rows affected</p>`;
    const fields = result.fields;
    const rows = result.rows.map((row) => `<tr>${fields.map((field) => `<td>${formatCell(row[field.name])}</td>`).join("")}</tr>`).join("");
    const truncated = result.truncated ? `<p class="query-command">Showing first ${MAX_RESULT_ROWS} rows from this result set.</p>` : "";
    return `${index ? '<hr class="result-separator">' : ""}${truncated}<table class="data-table"><thead><tr>${fields.map((field) => `<th>${escapeHtml(field.name)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td class="empty-state" colspan="${fields.length}">No rows returned.</td></tr>`}</tbody></table>`;
  }).join("");
}

function renderActivity() {
  $("#activity-list").innerHTML = state.activity.map((item) => `<div class="activity-item"><span class="activity-icon">${item.icon}</span><div class="activity-copy"><strong>${escapeHtml(item.action)}</strong><small>${escapeHtml(item.detail)}</small></div><span class="activity-time">${escapeHtml(item.time)}</span></div>`).join("") || `<div class="activity-item"><span class="activity-copy">No activity to display.</span></div>`;
}

function showView(id) {
  document.querySelectorAll(".view-section").forEach((section) => section.classList.toggle("hidden", section.id !== id));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === id));
  $("#breadcrumb-current").textContent = id === "table-view"
    ? (state.table ? `${state.schema}.${state.table}` : "Database")
    : id === "sql-view" ? "SQL" : "Activity log";
}

async function connect(event) {
  event.preventDefault();
  const button = $("#connect-submit");
  button.disabled = true;
  button.textContent = "Connecting...";
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const result = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({
        host: values.host,
        port: values.port,
        database: values.database,
        user: values.user,
        password: values.password,
      }),
    });
    state.connected = true;
    state.connection = result.connection;
    state.schemas = (await api("/api/schemas")).schemas;
    state.schema = null;
    state.table = null;
    state.columns = [];
    state.rows = [];
    $("#connection-dialog").close();
    $("#db-password").value = "";
    $("#connection-name").textContent = result.connection.database;
    $("#connection-status").textContent = `PostgreSQL · ${result.connection.user}`;
    $("#editor-database").textContent = result.connection.database;
    $("#footer-status").textContent = `${result.connection.version} · Connected`;
    renderSchemas();
    renderCurrentTable();
    toast("Connected to local database.");
    logActivity("Connected to database", `${result.connection.database} · ${result.connection.user}`);
    if (state.schemas.length) await selectSchema(state.schemas[0].name);
  } catch (error) {
    toast(error.message || "Check the credentials and ensure PostgreSQL is running.", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
}

async function disconnect() {
  if (!state.connected || !window.confirm("Disconnect from the current database?")) return;
  try {
    await api("/api/disconnect", { method: "POST", body: "{}" });
    state.connected = false;
    state.connection = null;
    state.schemas = [];
    state.schema = null;
    state.table = null;
    state.columns = [];
    state.rows = [];
    $("#connection-name").textContent = "Not connected";
    $("#connection-status").textContent = "PostgreSQL · Disconnected";
    $("#editor-database").textContent = "Not connected";
    $("#footer-status").textContent = "Disconnected · Loopback only";
    renderSchemas();
    renderCurrentTable();
    toast("Disconnected.");
    logActivity("Disconnected", "PostgreSQL");
  } catch (error) {
    toast(error.message, "error");
  }
}

function openRowDialog(index = null) {
  const row = index === null ? null : state.rows[index];
  const keys = state.columns.filter((column) => column.is_primary_key);
  if (index !== null && !keys.length) {
    toast("A primary key is required to edit or delete rows.", "error");
    return;
  }
  $("#dialog-title").textContent = index === null ? "Insert row" : "Edit row";
  $("#dialog-description").textContent = `${state.schema}.${state.table}`;
  $("#save-row").textContent = index === null ? "Insert row" : "Save changes";
  $("#form-fields").innerHTML = state.columns.filter((column) => index === null
    ? !column.column_default && !column.is_primary_key
    : !column.is_primary_key).map((column) => {
    const name = column.column_name;
    const value = row?.[name];
    const isBool = column.data_type.toLowerCase() === "boolean";
    const isJson = column.data_type.toLowerCase() === "json" || column.data_type.toLowerCase() === "jsonb";
    const input = isBool
      ? `<select name="${escapeHtml(name)}"><option value="true" ${value === true ? "selected" : ""}>TRUE</option><option value="false" ${value === false ? "selected" : ""}>FALSE</option><option value="null" ${value === null ? "selected" : ""}>NULL</option></select>`
      : isJson
        ? `<textarea name="${escapeHtml(name)}" rows="3" placeholder="Leave empty">${escapeHtml(value === null || value === undefined ? "" : JSON.stringify(value))}</textarea>`
        : `<input name="${escapeHtml(name)}" type="text" value="${escapeHtml(value === null || value === undefined ? "" : value)}" placeholder="Leave empty">`;
    return `<div class="field-group"><label>${escapeHtml(name)} <small>${escapeHtml(column.data_type)}</small></label>${input}</div>`;
  }).join("");
  if (!$("#form-fields").children.length) {
    toast("This table has no insertable columns.", "error");
    return;
  }
  $("#row-form").dataset.rowIndex = index === null ? "" : String(index);
  $("#row-dialog").showModal();
}

function normalizeFormValue(value, column) {
  if (value === "" && column.is_nullable === "YES") return null;
  if (value === "null" && column.data_type === "boolean") return null;
  if (column.data_type === "boolean") return value === "true";
  if ((column.data_type === "json" || column.data_type === "jsonb") && value !== "") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Invalid JSON value for ${column.column_name}.`);
    }
  }
  return value;
}

async function saveRow(event) {
  event.preventDefault();
  const indexValue = $("#row-form").dataset.rowIndex;
  const editing = indexValue !== "";
  const index = Number(indexValue);
  const original = editing ? state.rows[index] : null;
  try {
    const formValues = Object.fromEntries(new FormData($("#row-form")).entries());
    const values = Object.fromEntries(Object.entries(formValues).map(([name, value]) => [
      name,
      normalizeFormValue(value, state.columns.find((column) => column.column_name === name)),
    ]));
    const result = await api("/api/row", {
      method: "POST",
      body: JSON.stringify({ schema: state.schema, table: state.table, action: editing ? "update" : "insert", values, original }),
    });
    $("#row-dialog").close();
    await loadTable();
    renderCurrentTable();
    logActivity(editing ? "Updated row" : "Inserted row", `${state.schema}.${state.table}`);
    toast(editing ? "Row updated." : "Row inserted.");
    if (result.rowCount === 0) toast("No changes were made.", "error");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteRow(index) {
  if (!window.confirm(`Delete this row from ${state.schema}.${state.table}?`)) return;
  const row = state.rows[index];
  try {
    const result = await api("/api/row", {
      method: "POST",
      body: JSON.stringify({ schema: state.schema, table: state.table, action: "delete", values: {}, original: row }),
    });
    if (!result.rowCount) return toast("No changes were made.", "error");
    await loadTable();
    renderCurrentTable();
    logActivity("Deleted row", `${state.schema}.${state.table}`);
    toast("Row deleted.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runQuery() {
  if (!state.connected) return toast("Connect to a local database first.", "error");
  const sql = $("#sql-editor").value.trim();
  if (!sql) return toast("Enter a SQL statement first.", "error");
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COMMENT|VACUUM|REFRESH|CALL|DO)\b/i.test(sql)
    && !window.confirm("This SQL may modify database data or structure. Execute it?")) return;
  $("#query-status").textContent = "Running query...";
  $("#results-placeholder").classList.add("hidden");
  try {
    const response = await api("/api/query", { method: "POST", body: JSON.stringify({ sql }) });
    state.resultSets = response.results;
    renderResultSets();
    const totalRows = response.results.reduce((sum, result) => sum + (result.rowCount || 0), 0);
    const selected = response.results.some((result) => result.fields.length > 0);
    $("#query-status").textContent = selected
      ? `${totalRows.toLocaleString()} rows · PostgreSQL`
      : "Executed successfully; no rows returned.";
    logActivity("Executed SQL", sql.replace(/\s+/g, " ").slice(0, 100), "⌘");
  } catch (error) {
    state.resultSets = [];
    renderResultSets();
    $("#results-placeholder").classList.remove("hidden");
    $("#query-status").textContent = error.message;
    toast(error.message, "error");
  }
}

function exportRows() {
  if (!state.columns.length || !state.rows.length) return toast("No rows to export.", "error");
  const csv = [state.columns.map((column) => column.column_name), ...state.rows.map((row) => state.columns.map((column) => {
    const value = row[column.column_name];
    return value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : value;
  }))].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.href = objectUrl;
  link.download = `${state.schema}-${state.table}-${state.offset}.csv`;
  link.click();
  URL.revokeObjectURL(objectUrl);
  toast("Current page exported.");
}

function updateLineNumbers() {
  const count = $("#sql-editor").value.split("\n").length;
  $("#line-numbers").innerHTML = Array.from({ length: count }, (_, index) => index + 1).join("<br>");
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll(".panel-tab").forEach((button) => button.addEventListener("click", () => {
  state.tab = button.dataset.tab;
  document.querySelectorAll(".panel-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  renderCurrentTable();
}));
$("#open-connection").addEventListener("click", () => $("#connection-dialog").showModal());
$("#connection-form").addEventListener("submit", (event) => void connect(event));
$("#close-connection-dialog").addEventListener("click", () => $("#connection-dialog").close());
$("#cancel-connection").addEventListener("click", () => $("#connection-dialog").close());
$("#disconnect-button").addEventListener("click", () => void disconnect());
$("#refresh-button").addEventListener("click", async () => {
  try {
    state.schemas = (await api("/api/schemas")).schemas;
    renderSchemas();
    if (state.table) await loadTable();
    renderCurrentTable();
    logActivity("Refreshed data", state.table ? `${state.schema}.${state.table}` : "");
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#export-button").addEventListener("click", exportRows);
$("#add-row-button").addEventListener("click", () => openRowDialog());
$("#row-form").addEventListener("submit", (event) => void saveRow(event));
$("#close-dialog").addEventListener("click", () => $("#row-dialog").close());
$("#cancel-dialog").addEventListener("click", () => $("#row-dialog").close());
$("#run-query").addEventListener("click", () => void runQuery());
$("#sql-editor").addEventListener("input", updateLineNumbers);
$("#sql-editor").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void runQuery();
  }
  if (event.key === "Tab") {
    event.preventDefault();
    event.target.setRangeText("  ", event.target.selectionStart, event.target.selectionEnd, "end");
    updateLineNumbers();
  }
});
$("#format-query").addEventListener("click", () => {
  const editor = $("#sql-editor");
  editor.value = editor.value.replace(/\s+(FROM|WHERE|ORDER BY|GROUP BY|LIMIT|RETURNING|SET|VALUES|JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN)\b/gi, "\n$1");
  updateLineNumbers();
});
$("#copy-results").addEventListener("click", async () => {
  const text = $("#query-result-table").innerText;
  if (!text || $("#query-result-table").classList.contains("hidden")) return toast("There are no results to copy.", "error");
  try {
    await navigator.clipboard.writeText(text);
    toast("Results copied.");
  } catch {
    toast("Could not copy results. Check browser permissions.", "error");
  }
});
$("#clear-activity").addEventListener("click", () => {
  state.activity = [];
  renderActivity();
});
$("#page-size").addEventListener("change", async (event) => {
  state.limit = Math.min(100, Number(event.target.value));
  state.offset = 0;
  try {
    await loadTable();
    renderCurrentTable();
  } catch (error) {
    toast(error.message, "error");
  }
});
async function movePage(direction) {
  if (!state.table) return;
  state.offset = Math.max(0, state.offset + direction * state.limit);
  try {
    await loadTable();
    renderCurrentTable();
  } catch (error) {
    state.offset = Math.max(0, state.offset - direction * state.limit);
    toast(error.message, "error");
  }
}
$("#page-back").addEventListener("click", () => void movePage(-1));
$("#previous-page").addEventListener("click", () => void movePage(-1));
$("#page-forward").addEventListener("click", () => void movePage(1));
$("#next-page").addEventListener("click", () => void movePage(1));
$("#table-search").addEventListener("input", () => {
  const term = $("#table-search").value.toLowerCase();
  $("#table-container").querySelectorAll("tbody tr").forEach((row) => {
    row.classList.toggle("filtered-out", !row.innerText.toLowerCase().includes(term));
  });
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    showView("sql-view");
    $("#sql-editor").focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !$("#table-view").classList.contains("hidden")) {
    event.preventDefault();
    $("#table-search").focus();
  }
});

async function initialize() {
  renderSchemas();
  renderCurrentTable();
  try {
    const status = await api("/api/status");
    if (status.connected) {
      state.connected = true;
      state.connection = status.connection;
      state.schemas = (await api("/api/schemas")).schemas;
      renderSchemas();
      $("#connection-name").textContent = status.connection.database;
      $("#connection-status").textContent = `PostgreSQL · ${status.connection.user}`;
      $("#editor-database").textContent = status.connection.database;
      $("#footer-status").textContent = `${status.connection.version} · Connected`;
      if (state.schemas.length) await selectSchema(state.schemas[0].name);
    } else {
      $("#connection-dialog").showModal();
    }
  } catch (error) {
    toast(error.message, "error");
    $("#connection-dialog").showModal();
  }
}

initialize();
