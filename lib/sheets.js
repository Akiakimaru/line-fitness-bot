// lib/sheets.js
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/* ===================== 共通認証 ===================== */
async function getJwt() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getDoc() {
  const jwt = await getJwt();
  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
  await doc.loadInfo();
  return doc;
}

/* ===================== MealPlan ===================== */
async function loadMealPlan() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle["MealPlan"];
  if (!sheet) throw new Error("MealPlan シートが存在しません");
  const rows = await sheet.getRows();
  const headers = sheet.headerValues;
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));
  return { sheet, rows, idx, headers };
}

/* ===================== Users ===================== */
async function getUserSheet() {
  const doc = await getDoc();
  let sheet = doc.sheetsByTitle["Users"];
  if (!sheet) {
    console.log("[Users] シートが存在しないため新規作成");
    sheet = await doc.addSheet({
      title: "Users",
      headerValues: ["UserId", "DisplayName", "StartDate", "LastActive"],
    });
  }
  return sheet;
}

/* =======================================================
   ✅ 修正版: Google Sheets API (v4) で直接UserIdを読む
======================================================= */
async function getAllUserIds() {
  const jwt = await getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });

  const range = "Users!A2:A"; // UserId 列
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const values = res.data.values || [];
  const ids = values
    .map((r) => String(r[0] || "").trim())
    .filter((x) => x.startsWith("U") && x.length > 20);

  console.log("[getAllUserIds] loaded:", ids.length, "users");
  return ids;
}

/* =======================================================
   ユーザー登録
======================================================= */
async function registerUser(userId, displayName = "", startDate = null) {
  if (!userId) return;

  const sheet = await getUserSheet();
  const rows = await sheet.getRows();

  const exists = rows.some(
    (r) => String(r.UserId || "").trim() === String(userId).trim()
  );
  if (exists) {
    const target = rows.find(
      (r) => String(r.UserId || "").trim() === String(userId).trim()
    );
    target.LastActive = new Date().toISOString();
    await target.save();
    console.log("[registerUser] updated:", userId);
    return;
  }

  await sheet.addRow({
    UserId: userId,
    DisplayName: displayName || "",
    StartDate: startDate || new Date().toISOString().slice(0, 10),
    LastActive: new Date().toISOString(),
  });
  console.log("[registerUser] added:", userId);
}

/* =======================================================
   Export
======================================================= */
module.exports = {
  loadMealPlan,
  getAllUserIds,
  registerUser,
};
