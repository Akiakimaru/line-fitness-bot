// index.js
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { getAllUserIds } = require("./lib/sheets"); // ✅ これを忘れずに
const { loadMealPlan } = require("./lib/sheets");
const { getWeekAndDayJST } = require("./lib/utils");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ==================== BASE TEST ==================== */
app.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));
app.get("/debug-week", (_req, res) => {
  try {
    const data = getWeekAndDayJST();
    res.json({ START_DATE: process.env.START_DATE, ...data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ==================== ADMIN ==================== */
app.get("/admin/today", async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY)
    return res.status(401).send("unauthorized");
  try {
    const { sheet, rows } = await loadMealPlan();
    res.json({ ok: true, sheetTitle: sheet.title, rowCount: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ==========================================================
   ✅ デバッグ用エンドポイント: /admin/debug-users
   現在のスプレッドシート内 Users シートの中身を確認
========================================================== */
app.get("/admin/debug-users", async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY)
    return res.status(401).send("unauthorized");

  try {
    const { GoogleSpreadsheet } = require("google-spreadsheet");
    const { JWT } = require("google-auth-library");
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, jwt);
    await doc.loadInfo();

    const usersSheet = doc.sheetsByTitle["Users"];
    if (!usersSheet) {
      return res.json({
        ok: true,
        sheetTitle: doc.title,
        message: "Usersシートが存在しません。",
      });
    }

    const rows = await usersSheet.getRows();
    const userIds = rows
      .map((r) => String(r.UserId || r.userId || "").trim())
      .filter((x) => x.startsWith("U") && x.length > 20);

    res.json({
      ok: true,
      sheetTitle: doc.title,
      usersSheetTitle: usersSheet.title,
      totalRows: rows.length,
      validUserCount: userIds.length,
      validUserIds: userIds,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ==========================================================
   起動
========================================================== */
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
