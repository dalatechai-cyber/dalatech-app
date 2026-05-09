"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const generateHandler = require("./api/generate");

const app = express();

app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/generate", (req, res) => {
  Promise.resolve(generateHandler(req, res)).catch((err) => {
    console.error("Unhandled handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err?.message || "Internal error" });
    }
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`DalaTech app listening on http://localhost:${port}`);
});
