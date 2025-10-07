// lib/sheets.js
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/* ================= 認証共通 ================= */
function getServiceAccount() {
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}
function getJwt() {
  const creds = getServiceAccount();
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}
async function getDoc() {
  const jwt = getJwt();
  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
  await doc.loadInfo();
  return doc;
}

/* ================= MealPlan ================= */
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

/* ================= Users（作成/登録/取得） ================= */
async function getUserSheet() {
  const doc = await getDoc();
  let sheet = doc.sheetsByTitle["Users"];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: "Users",
      headerValues: ["UserId", "DisplayName", "StartDate", "LastActive"],
    });
  }
  return sheet;
}

/** ✅ REST直読みで UserId 一覧を確実に取得 */
async function getAllUserIds() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });

  // A列（UserId）をそのまま取得
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Users!A2:A",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const values = res.data.values || [];
  const ids = values
    .map((r) => String((r && r[0]) || "").trim())
    .filter((x) => x.startsWith("U") && x.length > 20);

  console.log("[getAllUserIds] loaded:", ids.length, "users");
  return ids;
}

/** 受信時に Users へ登録（google-spreadsheetでOK） */
async function registerUser(userId, displayName = "", startDate = null) {
  if (!userId) return;
  const sheet = await getUserSheet();
  const rows = await sheet.getRows();

  const hit = rows.find(
    (r) => String(r.UserId || "").trim() === String(userId).trim()
  );
  if (hit) {
    hit.LastActive = new Date().toISOString();
    await hit.save();
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

module.exports = {
  loadMealPlan,
  getAllUserIds,
  registerUser,
};
