"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const generateHandler = require("./api/generate");
const cronHandler = require("./api/cron");
const chatHandler = require("./api/chat");
const telegramHandler = require("./api/telegram");
const choiceHandler = require("./api/choice");

const app = express();

app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

function mount(method, route, handler) {
  app[method](route, (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error(`Unhandled handler error on ${route}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err?.message || "Internal error" });
      }
    });
  });
}

mount("post", "/api/generate", generateHandler);
mount("post", "/api/chat", chatHandler);
mount("options", "/api/chat", chatHandler);
mount("all", "/api/cron", cronHandler);
mount("post", "/api/telegram", telegramHandler);
mount("get", "/api/telegram", telegramHandler);
mount("post", "/api/choice", choiceHandler);
mount("options", "/api/choice", choiceHandler);

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`DalaTech app listening on http://localhost:${port}`);
});
