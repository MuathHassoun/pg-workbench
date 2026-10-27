"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const ROOT = path.join(__dirname, "..", "client");
const MAX_BODY = 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_SQL_ROWS = 500;
const ALLOWED_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);
let pool = null;
let connectionInfo = null;

function send(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(payload));
}

function localHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function assertLocalRequest(request) {
  const host = request.headers.host;
  if (!host) throw Object.assign(new Error("Missing Host header."), { status: 400 });
  const requestUrl = new URL(`http://${host}`);
  const parsedHost = requestUrl.hostname.replace(/^\[|\]$/g, "");
  if (!localHost(parsedHost)) throw Object.assign(new Error("This tool only accepts loopback requests."), { status: 403 });
  const origin = request.headers.origin;
  if (origin) {
    let originHost;
    try {
      const originUrl = new URL(origin);
      originHost = originUrl.hostname.replace(/^\[|\]$/g, "");
      if (originUrl.host !== requestUrl.host) {
        throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
      }
    } catch {
      throw Object.assign(new Error("Invalid request origin."), { status: 403 });
    }
    if (!localHost(originHost) || originHost !== parsedHost) {
      throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
    }
  }
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function requirePool() {
  if (!pool) throw Object.assign(new Error("Connect to a local PostgreSQL database first."), { status: 409 });
  return pool;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/status") {
    return send(response, 200, { connected: Boolean(pool), connection: connectionInfo });
  }

  if (request.method === "POST" && url.pathname === "/api/connect") {
    const body = await readJson(request);
    const host = String(body.host || "").trim().toLowerCase();
    const port = Number(body.port);
    const database = String(body.database || "").trim();
    const user = String(body.user || "").trim();
    if (!localHost(host)) throw Object.assign(new Error("Only localhost, 127.0.0.1, or ::1 are allowed."), { status: 400 });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error("Port must be between 1 and 65535."), { status: 400 });
    if (!database || !user || typeof body.password !== "string") {
      throw Object.assign(new Error("Database, username, and password fields are required (the password may be empty)."), { status: 400 });
    }
    const nextPool = new Pool({
      host,
      port,
      database,
      user,
      password: body.password,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      application_name: "Local DB Studio",
    });
    nextPool.on("error", (error) => console.error("PostgreSQL pool error:", error.message));
    let details;
    try {
      const result = await nextPool.query("SELECT current_database() AS database, current_user AS user, version() AS version");
      details = result.rows[0];
    } catch (error) {
      await nextPool.end().catch((closeError) => console.error("Failed to close rejected connection pool:", closeError.message));
      throw Object.assign(new Error(`Could not connect to local PostgreSQL: ${error.message}`), { status: 400 });
    }
    const previousPool = pool;
    pool = nextPool;
    connectionInfo = { database: details.database, user: details.user, version: details.version.split(" ").slice(0, 2).join(" ") };
    if (previousPool) await previousPool.end();
    return send(response, 200, { connected: true, connection: connectionInfo });
  }

  if (request.method === "POST" && url.pathname === "/api/disconnect") {
    const previousPool = pool;
    pool = null;
    connectionInfo = null;
    if (previousPool) await previousPool.end();
    return send(response, 200, { connected: false });
  }

  if (request.method === "GET" && url.pathname === "/api/schemas") {
    const result = await requirePool().query(`
      SELECT n.nspname AS name, COUNT(c.oid)::int AS table_count
      FROM pg_catalog.pg_namespace n
      LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      WHERE n.nspname NOT IN ('information_schema', 'pg_catalog')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp_%'
      GROUP BY n.nspname
      ORDER BY n.nspname
    `);
    return send(response, 200, { schemas: result.rows });
  }

  if (request.method === "GET" && url.pathname === "/api/tables") {
    const schema = url.searchParams.get("schema");
    if (!schema) throw Object.assign(new Error("A schema is required."), { status: 400 });
    const result = await requirePool().query(`
      SELECT c.relname AS name,
             c.relkind AS kind,
             GREATEST(c.reltuples::bigint, 0) AS row_estimate,
             (SELECT COUNT(*)::int FROM information_schema.columns col
              WHERE col.table_schema = n.nspname AND col.table_name = c.relname) AS column_count
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY c.relname
    `, [schema]);
    return send(response, 200, { tables: result.rows });
  }

  if (request.method === "GET" && url.pathname === "/api/table") {
    const schema = url.searchParams.get("schema");
    const table = url.searchParams.get("table");
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    if (!schema || !table) throw Object.assign(new Error("Schema and table are required."), { status: 400 });
    const db = requirePool();
    const metadata = await db.query(`
      SELECT col.column_name, col.data_type, col.udt_name, col.is_nullable,
             col.column_default, col.ordinal_position,
             EXISTS (
               SELECT 1 FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_catalog = kcu.constraint_catalog
                AND tc.constraint_schema = kcu.constraint_schema
                AND tc.constraint_name = kcu.constraint_name
               WHERE tc.constraint_type = 'PRIMARY KEY'
                 AND tc.table_schema = col.table_schema
                 AND tc.table_name = col.table_name
                 AND kcu.column_name = col.column_name
             ) AS is_primary_key
      FROM information_schema.columns col
      WHERE col.table_schema = $1 AND col.table_name = $2
      ORDER BY col.ordinal_position
    `, [schema, table]);
    if (!metadata.rowCount) throw Object.assign(new Error("Table or view not found, or it is not visible to this user."), { status: 404 });
    const objectResult = await db.query(`
      SELECT c.relkind AS kind, GREATEST(c.reltuples::bigint, 0) AS row_estimate
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
    `, [schema, table]);
    const query = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} LIMIT $1 OFFSET $2`;
    const data = await db.query(query, [limit, offset]);
    return send(response, 200, {
      columns: metadata.rows,
      rows: data.rows,
      rowCount: data.rowCount,
      offset,
      limit,
      rowEstimate: Number(objectResult.rows[0]?.row_estimate || 0),
      kind: objectResult.rows[0]?.kind || "r",
    });
  }

  if (request.method === "POST" && url.pathname === "/api/query") {
    const body = await readJson(request);
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!sql) throw Object.assign(new Error("Enter a SQL statement."), { status: 400 });
    if (sql.length > 100000) throw Object.assign(new Error("SQL is limited to 100,000 characters."), { status: 413 });
    const result = await requirePool().query({ text: sql, query_timeout: 30000 });
    const results = (Array.isArray(result) ? result : [result]).map((item) => ({
      command: item.command,
      rowCount: item.rowCount,
      fields: item.fields?.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })) || [],
      rows: (item.rows || []).slice(0, MAX_SQL_ROWS),
      truncated: (item.rows || []).length > MAX_SQL_ROWS,
    }));
    return send(response, 200, { results });
  }

  if (request.method === "POST" && url.pathname === "/api/row") {
    const body = await readJson(request);
    const { schema, table, action, values, original } = body;
    if (!schema || !table || !["insert", "update", "delete"].includes(action) || !values || typeof values !== "object") {
      throw Object.assign(new Error("Invalid row operation."), { status: 400 });
    }
    const db = requirePool();
    const columnResult = await db.query(`
      SELECT col.column_name, col.is_nullable, col.column_default,
             EXISTS (
               SELECT 1 FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_catalog = kcu.constraint_catalog AND tc.constraint_schema = kcu.constraint_schema
                AND tc.constraint_name = kcu.constraint_name
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = col.table_schema
                 AND tc.table_name = col.table_name AND kcu.column_name = col.column_name
             ) AS is_primary_key
      FROM information_schema.columns col
      WHERE col.table_schema = $1 AND col.table_name = $2
      ORDER BY col.ordinal_position
    `, [schema, table]);
    if (!columnResult.rowCount) throw Object.assign(new Error("Table not found."), { status: 404 });
    const columnNames = new Set(columnResult.rows.map((column) => column.column_name));
    const keys = columnResult.rows.filter((column) => column.is_primary_key);
    const quotedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    if (action === "delete" || action === "update") {
      if (!keys.length) throw Object.assign(new Error("This table has no primary key; row editing and deletion are disabled."), { status: 409 });
      if (!original || keys.some((column) => !Object.hasOwn(original, column.column_name))) {
        throw Object.assign(new Error("Primary key values are required to identify the row."), { status: 400 });
      }
      const whereValues = keys.map((column) => original[column.column_name]);
      const whereClause = keys.map((column, index) => `${quoteIdentifier(column.column_name)} IS NOT DISTINCT FROM $${index + 1}`).join(" AND ");
      if (action === "delete") {
        const deleted = await db.query(`DELETE FROM ${quotedTable} WHERE ${whereClause}`, whereValues);
        return send(response, 200, { rowCount: deleted.rowCount });
      }
      const editable = Object.entries(values).filter(([name]) => columnNames.has(name) && !keys.some((key) => key.column_name === name));
      if (!editable.length) throw Object.assign(new Error("No editable column values were provided."), { status: 400 });
      const parameters = editable.map(([, value]) => value);
      const assignments = editable.map(([name], index) => `${quoteIdentifier(name)} = $${index + 1}`);
      const whereParameters = whereValues.map((value) => value);
      const where = keys.map((column, index) => `${quoteIdentifier(column.column_name)} IS NOT DISTINCT FROM $${parameters.length + index + 1}`).join(" AND ");
      const updated = await db.query(`UPDATE ${quotedTable} SET ${assignments.join(", ")} WHERE ${where}`, [...parameters, ...whereParameters]);
      return send(response, 200, { rowCount: updated.rowCount });
    }

    const entries = Object.entries(values).filter(([name]) => columnNames.has(name));
    if (!entries.length) throw Object.assign(new Error("No valid column values were provided."), { status: 400 });
    const params = entries.map(([, value]) => value);
    const columns = entries.map(([name]) => quoteIdentifier(name)).join(", ");
    const placeholders = params.map((_, index) => `$${index + 1}`).join(", ");
    const inserted = await db.query(`INSERT INTO ${quotedTable} (${columns}) VALUES (${placeholders}) RETURNING *`, params);
    return send(response, 200, { rowCount: inserted.rowCount, rows: inserted.rows });
  }

  throw Object.assign(new Error("API route not found."), { status: 404 });
}

async function handle(request, response) {
  try {
    assertLocalRequest(request);
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return send(response, 405, { error: "Method not allowed." });
    }
    const entry = ALLOWED_FILES.get(url.pathname);
    if (!entry) return send(response, 404, { error: "Not found." });
    const [file, contentType] = entry;
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:",
      "Referrer-Policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : fs.readFileSync(path.join(ROOT, file)));
  } catch (error) {
    const status = error.status || (error.code ? 400 : 500);
    if (status >= 500) console.error("Request failed:", error);
    send(response, status, { error: status >= 500 ? "Internal server error." : error.message });
  }
}

const server = http.createServer((request, response) => void handle(request, response));
server.listen(PORT, HOST, () => {
  console.log(`Local DB Studio available at http://${HOST}:${PORT}`);
});
server.on("error", (error) => {
  console.error("Unable to start Local DB Studio:", error.message);
  process.exitCode = 1;
});

async function shutdown(signal) {
  console.log(`${signal} received; closing Local DB Studio.`);
  server.close(async (error) => {
    if (error) {
      console.error("Failed to close the HTTP server cleanly:", error.message);
      process.exitCode = 1;
    }
    if (pool) {
      try {
        await pool.end();
      } catch (closeError) {
        console.error("Failed to close the PostgreSQL pool cleanly:", closeError.message);
        process.exitCode = 1;
      }
    }
  });
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
