const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const rateBuckets = new Map();

loadEnv();

const PORT = Number(process.env.PORT || 8890);
const HOST = process.env.HOST || (isHostedRuntime() ? "0.0.0.0" : "127.0.0.1");
const BODY_LIMIT_BYTES = numberEnv("RADIO_CHARLIE_BODY_LIMIT_BYTES", 64 * 1024);

const planHandler = require("./server-functions/plan.js").handler;
const speakHandler = require("./server-functions/speak.js").handler;
const statusHandler = require("./server-functions/status.js").handler;

const functions = {
  "/api/plan": planHandler,
  "/api/speak": speakHandler,
  "/api/status": statusHandler,
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    const host = request.headers.host || `${HOST}:${PORT}`;
    const url = new URL(request.url, `http://${host}`);

    if (functions[url.pathname]) {
      const originCheck = checkApiOrigin(request);
      if (originCheck) {
        sendJson(response, originCheck.statusCode, originCheck.body, originCheck.headers);
        return;
      }

      const rateLimit = checkRateLimit(url.pathname, request);
      if (rateLimit) {
        sendJson(response, rateLimit.statusCode, rateLimit.body, rateLimit.headers);
        return;
      }

      const result = await functions[url.pathname]({
        httpMethod: request.method,
        headers: request.headers,
        body: await readBody(request),
        clientIp: getClientIp(request),
      });

      response.writeHead(result.statusCode || 200, result.headers || {});
      response.end(
        result.isBase64Encoded
          ? Buffer.from(result.body || "", "base64")
          : result.body || "",
      );
      return;
    }

    serveStaticFile(url.pathname, response);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(statusCode === 500 ? error.stack || String(error) : error.message);
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Le port ${PORT} est déjà utilisé. Relance avec PORT=8891 node server.js.`);
    process.exit(1);
  }

  if (error.code === "EACCES" || error.code === "EPERM") {
    console.error(`Impossible d’ouvrir ${HOST}:${PORT}. Vérifie les autorisations réseau locales.`);
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://127.0.0.1:${PORT}`;
  const boundUrl = `http://${HOST}:${PORT}`;
  console.log(
    HOST === "0.0.0.0"
      ? `Sillage FM écoute sur ${boundUrl} (${localUrl} en local)`
      : `Sillage FM tourne sur ${boundUrl}`,
  );
});

function isHostedRuntime() {
  return Boolean(process.env.PORT || isRailway());
}

function isRailway() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID,
  );
}

function serveStaticFile(pathname, response) {
  let relativePath;

  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Chemin invalide.");
    return;
  }

  const filePath = path.resolve(root, relativePath);
  const safeRelativePath = path.relative(root, filePath);

  if (
    relativePath.includes("\0") ||
    safeRelativePath.startsWith("..") ||
    path.isAbsolute(safeRelativePath)
  ) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Accès interdit.");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Fichier introuvable.");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(data);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let isTooLarge = false;

    request.on("data", (chunk) => {
      size += chunk.length;

      if (size > BODY_LIMIT_BYTES) {
        isTooLarge = true;
        chunks.length = 0;
        return;
      }

      if (!isTooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (isTooLarge) {
        const error = new Error("Requête trop volumineuse.");
        error.statusCode = 413;
        reject(error);
        return;
      }

      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function checkApiOrigin(request) {
  if (request.method === "OPTIONS") {
    return null;
  }

  const origin = request.headers.origin;

  if (!origin) {
    return null;
  }

  const allowedOrigins = getAllowedOrigins(request);

  if (allowedOrigins.has(origin)) {
    return null;
  }

  return {
    statusCode: 403,
    body: { error: "Origine non autorisée." },
  };
}

function getAllowedOrigins(request) {
  const origins = new Set(
    String(process.env.RADIO_CHARLIE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const host = request.headers.host;

  if (host) {
    const protocol = isHostedRuntime() ? "https" : "http";
    origins.add(`${protocol}://${host}`);
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }

  return origins;
}

function checkRateLimit(pathname, request) {
  if (request.method === "OPTIONS") {
    return null;
  }

  const config = getRateLimitConfig(pathname);

  if (!config.limit || !config.windowMs) {
    return null;
  }

  const now = Date.now();
  const key = `${pathname}:${getClientIp(request)}`;
  const existing = rateBuckets.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : {
          count: 0,
          resetAt: now + config.windowMs,
        };

  if (bucket.count >= config.limit) {
    return {
      statusCode: 429,
      headers: {
        "Retry-After": String(Math.ceil((bucket.resetAt - now) / 1000)),
      },
      body: { error: "Trop de requêtes. Réessaie dans quelques minutes." },
    };
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);
  cleanupRateBuckets(now);
  return null;
}

function getRateLimitConfig(pathname) {
  if (pathname === "/api/plan") {
    return {
      limit: numberEnv("RADIO_CHARLIE_PLAN_RATE_LIMIT", 12),
      windowMs: numberEnv("RADIO_CHARLIE_PLAN_RATE_WINDOW_MS", 10 * 60 * 1000),
    };
  }

  if (pathname === "/api/speak") {
    return {
      limit: numberEnv("RADIO_CHARLIE_SPEAK_RATE_LIMIT", 80),
      windowMs: numberEnv("RADIO_CHARLIE_SPEAK_RATE_WINDOW_MS", 10 * 60 * 1000),
    };
  }

  return {
    limit: numberEnv("RADIO_CHARLIE_STATUS_RATE_LIMIT", 120),
    windowMs: numberEnv("RADIO_CHARLIE_STATUS_RATE_WINDOW_MS", 10 * 60 * 1000),
  };
}

function cleanupRateBuckets(now) {
  if (rateBuckets.size < 1000) {
    return;
  }

  rateBuckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) {
      rateBuckets.delete(key);
    }
  });
}

function getClientIp(request) {
  const forwardedFor = String(request.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return (
    forwardedFor[0] ||
    request.headers["x-real-ip"] ||
    request.socket?.remoteAddress ||
    "unknown"
  );
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function loadEnv() {
  const envPath = path.join(root, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);

    if (!match || process.env[match[1]]) {
      continue;
    }

    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
