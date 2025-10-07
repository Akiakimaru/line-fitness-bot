// lib/sheets.js
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const { withBackoff } = require("../lib/utils");

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const jwt = new JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, jwt);

/* ---------- 共通 ---------- */
async function ensureDoc() {
  if (!doc._infoLoaded) await withBackoff(() => doc.loadInfo());
  return doc;
}

/* ---------- MealPlan ---------- */
async function loadMealPlan() {
  const d = await ensureDoc();
  const sheet = d.sheetsByTitle["MealPlan"];
  if (!sheet) throw new Error("MealPlan sheet not found");
  const rows = await sheet.getRows();
  const H = sheet.headerValues;
  const idx = {};
  H.forEach((h, i) => (idx[h] = i));
  return { sheet, rows, idx, headers: H };
}

/* ---------- Logs ---------- */
async function appendLogs(entry) {
  const d = await ensureDoc();
  let sheet = d.sheetsByTitle["Logs"];
  if (!sheet)
    sheet = await d.addSheet({
      title: "Logs",
      headerValues: ["Date", "Slot", "Kind", "Text", "Calories", "P", "F", "C", "Comment"],
    });
  await sheet.addRow(entry);
}

/* ---------- Users（新規） ---------- */
async function ensureUsersSheet() {
  const d = await ensureDoc();
  let sheet = d.sheetsByTitle["Users"];
  if (!sheet)
    sheet = await d.addSheet({
      title: "Users",
      headerValues: ["UserId", "DisplayName", "StartDate", "LastActive"],
    });
  return sheet;
}

async function registerUser(userId, displayName = "") {
  const sheet = await ensureUsersSheet();
  const rows = await sheet.getRows();
  const exists = rows.find((r) => r.UserId === userId);
  const now = new Date().toISOString();
  if (exists) {
    exists.LastActive = now;
    await exists.save();
    return { updated: true };
  }
  await sheet.addRow({
    UserId: userId,
    DisplayName: displayName,
    StartDate: process.env.START_DATE,
    LastActive: now,
  });
  return { created: true };
}

async function getAllUserIds() {
  const sheet = await ensureUsersSheet();
  const rows = await sheet.getRows();
  return rows.map((r) => r.UserId).filter(Boolean);
}

module.exports = {
  loadMealPlan,
  appendLogs,
  registerUser,
  getAllUserIds,
};
