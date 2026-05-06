const express = require("express");
const path = require("path");

const planFunction = require("./server-functions/plan");
const speakFunction = require("./server-functions/speak");
const statusFunction = require("./server-functions/status");

const app = express();
const port = Number(process.env.PORT || 3000);
const requestTimeoutMs = numberEnv("REQUEST_TIMEOUT_MS", 15 * 60 * 1000);
const bodyLimit = process.env.SILLAGE_BODY_LIMIT || "1mb";

app.use((req, res, next) => {
  req.setTimeout(requestTimeoutMs);
  res.setTimeout(requestTimeoutMs);
  next();
});

app.use(express.json({ limit: bodyLimit }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "sillage-fm" });
});

app.post(["/api/plan", "/plan"], runFunction(planFunction.handler));
app.post(["/api/speak", "/speak"], runFunction(speakFunction.handler));
app.get(["/api/status", "/status"], runFunction(statusFunction.handler));

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Sillage FM API listening on port ${port}`);
});

function runFunction(handler) {
  return async (req, res) => {
    try {
      const result = await handler(toFunctionEvent(req));
      sendFunctionResult(res, result);
    } catch (error) {
      res.status(500).json({
        error: "Erreur serveur.",
        detail: process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  };
}

function toFunctionEvent(req) {
  return {
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: req.query,
    body: req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : "",
  };
}

function sendFunctionResult(res, result) {
  const statusCode = result?.statusCode || 200;
  const headers = result?.headers || {};

  Object.entries(headers).forEach(([key, value]) => {
    if (value !== undefined) {
      res.setHeader(key, value);
    }
  });

  res.status(statusCode);

  if (result?.isBase64Encoded) {
    res.send(Buffer.from(result.body || "", "base64"));
    return;
  }

  res.send(result?.body || "");
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
