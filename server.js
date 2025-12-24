const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { randomUUID } = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const APP_TZ = process.env.APP_TZ || "Europe/Kyiv";
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const INSTANT_FILE = path.join(DATA_DIR, "events-instant.ndjson");
const BATCH_FILE = path.join(DATA_DIR, "events-batch.ndjson");
const MAX_BODY_SIZE = 2 * 1024 * 1024;
const MAX_BATCH_EVENTS = 5000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

let timeFormatter;
try {
  timeFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: APP_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
} catch (error) {
  timeFormatter = new Intl.DateTimeFormat("sv-SE", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLocalTime(date) {
  return timeFormatter.format(date);
}

function getServerTime() {
  const now = new Date();
  return {
    serverTime: now.toISOString(),
    serverTimeLocal: formatLocalTime(now),
    serverTimeZone: APP_TZ,
    serverTimeMs: now.getTime(),
  };
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(INSTANT_FILE)) {
    fs.writeFileSync(INSTANT_FILE, "", "utf8");
  }

  if (!fs.existsSync(BATCH_FILE)) {
    fs.writeFileSync(BATCH_FILE, "", "utf8");
  }
}

function loadEvents(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch (error) {
      continue;
    }
  }
  return items;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendNotFound(res) {
  sendText(res, 404, "Not found");
}

function sendServerError(res) {
  sendText(res, 500, "Internal server error");
}

function sendMethodNotAllowed(res, allow) {
  res.writeHead(405, {
    "Content-Type": "text/plain; charset=utf-8",
    Allow: allow,
  });
  res.end("Method Not Allowed");
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeSeq(value, fallback) {
  const seq = Number(value);
  if (Number.isInteger(seq) && seq >= 1) {
    return seq;
  }
  return fallback;
}

function buildInstantEvent(payload, fallbackSeq) {
  const message = normalizeString(payload.message);
  if (!message) {
    return { error: "message is required" };
  }
  const seq = normalizeSeq(payload.seq, fallbackSeq);
  const eventType = normalizeString(payload.eventType) || null;
  const clientTime = normalizeString(payload.clientTime) || null;
  const meta =
    payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
      ? payload.meta
      : null;
  const time = getServerTime();
  return {
    event: {
      id: randomUUID(),
      seq,
      message,
      eventType,
      clientTime,
      meta,
      ...time,
    },
  };
}

function buildBatchEvents(payload, fallbackStartSeq) {
  const list = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(payload.items)
      ? payload.items
      : null;
  if (!list) {
    return { error: "events must be an array" };
  }
  if (list.length === 0) {
    return { error: "events array is empty" };
  }
  if (list.length > MAX_BATCH_EVENTS) {
    return { error: `events array exceeds ${MAX_BATCH_EVENTS}` };
  }
  const batchId = randomUUID();
  const time = getServerTime();
  const items = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i] || {};
    const message = normalizeString(entry.message);
    if (!message) {
      return { error: `events[${i}] message is required` };
    }
    const seq = normalizeSeq(entry.seq, fallbackStartSeq + i);
    const eventType = normalizeString(entry.eventType) || null;
    const localTime =
      normalizeString(entry.localTime) || normalizeString(entry.clientTime) || null;
    const extra =
      entry.extra && typeof entry.extra === "object" && !Array.isArray(entry.extra)
        ? entry.extra
        : null;
    items.push({
      id: randomUUID(),
      batchId,
      seq,
      message,
      eventType,
      localTime,
      extra,
      ...time,
    });
  }
  return { batchId, items };
}

const writeQueues = {
  instant: Promise.resolve(),
  batch: Promise.resolve(),
};

function queueAppendLine(file, key, line) {
  const next = writeQueues[key].then(() => fs.promises.appendFile(file, line, "utf8"));
  writeQueues[key] = next.catch(() => {});
  return next;
}

function queueAppendEvent(file, key, payload) {
  return queueAppendLine(file, key, `${JSON.stringify(payload)}\n`);
}

async function parseJsonBody(req, res) {
  try {
    const body = await readRequestBody(req);
    if (!body) {
      return {};
    }
    try {
      return JSON.parse(body);
    } catch (error) {
      sendJson(res, 400, { error: "Invalid JSON payload" });
      return null;
    }
  } catch (error) {
    if (error && error.message === "Request body too large") {
      sendJson(res, 413, { error: "Payload too large" });
      return null;
    }
    sendServerError(res);
    return null;
  }
}

async function handleApi(req, res, url, store) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/")) {
    return false;
  }

  if (req.method === "GET") {
    if (pathname === "/api/events") {
      sendJson(res, 200, {
        instant: store.instant,
        batch: store.batch,
        counts: {
          instant: store.instant.length,
          batch: store.batch.length,
        },
        updatedAt: new Date().toISOString(),
      });
      return true;
    }
    if (pathname === "/api/events/instant") {
      sendJson(res, 200, { items: store.instant });
      return true;
    }
    if (pathname === "/api/events/batch") {
      sendJson(res, 200, { items: store.batch });
      return true;
    }
    if (pathname === "/api/health") {
      sendJson(res, 200, { status: "ok" });
      return true;
    }
    sendNotFound(res);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/events/instant") {
    const payload = await parseJsonBody(req, res);
    if (!payload) {
      return true;
    }
    const built = buildInstantEvent(payload, store.instant.length + 1);
    if (built.error) {
      sendJson(res, 400, { error: built.error });
      return true;
    }
    try {
      await queueAppendEvent(INSTANT_FILE, "instant", built.event);
      store.instant.push(built.event);
    } catch (error) {
      sendServerError(res);
      return true;
    }
    sendJson(res, 201, { ok: true, event: built.event });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/events/batch") {
    const payload = await parseJsonBody(req, res);
    if (!payload) {
      return true;
    }
    const built = buildBatchEvents(payload, store.batch.length + 1);
    if (built.error) {
      sendJson(res, 400, { error: built.error });
      return true;
    }
    const lines = `${built.items.map((item) => JSON.stringify(item)).join("\n")}\n`;
    try {
      await queueAppendLine(BATCH_FILE, "batch", lines);
      store.batch.push(...built.items);
    } catch (error) {
      sendServerError(res);
      return true;
    }
    sendJson(res, 201, {
      ok: true,
      batchId: built.batchId,
      stored: built.items.length,
    });
    return true;
  }

  if (req.method === "DELETE" && pathname === "/api/events") {
    store.instant.length = 0;
    store.batch.length = 0;
    try {
      await fs.promises.writeFile(INSTANT_FILE, "", "utf8");
      await fs.promises.writeFile(BATCH_FILE, "", "utf8");
    } catch (error) {
      sendServerError(res);
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname.startsWith("/api/")) {
    sendMethodNotAllowed(res, "GET, POST, DELETE");
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return;
  }
  let pathname = url.pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const safePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    sendNotFound(res);
    return;
  }
  fs.stat(safePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      sendNotFound(res);
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(safePath);
    stream.pipe(res);
    stream.on("error", () => sendServerError(res));
  });
}

ensureDataFiles();

const store = {
  instant: loadEvents(INSTANT_FILE),
  batch: loadEvents(BATCH_FILE),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handled = await handleApi(req, res, url, store);
  if (handled) {
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Server is running at http://${HOST}:${PORT}`);
});
