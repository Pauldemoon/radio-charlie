const express = require("express");
const path = require("path");

const planFunction = require("./netlify/functions/plan");
const speakFunction = require("./netlify/functions/speak");
const statusFunction = require("./netlify/functions/status");

const app = express();
const port = Number(process.env.PORT || 3000);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 15 * 60 * 1000);

app.use((req, res, next) => {
  req.setTimeout(requestTimeoutMs);
  res.setTimeout(requestTimeoutMs);
  next();
});

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post(["/plan", "/.netlify/functions/plan"], runFunction(planFunction.handler));
app.post(["/speak", "/.netlify/functions/speak"], runFunction(speakFunction.handler));
app.get(["/status", "/.netlify/functions/status"], runFunction(statusFunction.handler));

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Radio Charlie API listening on port ${port}`);
});

function runFunction(handler) {
  return async (req, res) => {
    try {
      const result = await handler(toNetlifyEvent(req));
      sendFunctionResult(res, result);
    } catch (error) {
      res.status(500).json({
        error: "Erreur serveur.",
        detail: process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  };
}

function toNetlifyEvent(req) {
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
