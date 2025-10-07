// lib/sheets.js
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/* ======================================================
   Google Sheets 認証と共通ユーティリティ
====================================================== */
async function getDoc() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
  await doc.loadInfo();
  return doc;
}

/* ======================================================
   MealPlan 読み込み
====================================================== */
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

/* ======================================================
   Users シート操作
====================================================== */
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

/* ======================================================
   全ユーザーID取得（Push対象）
====================================================== */
async function getAllUserIds() {
  const sheet = await getUserSheet();

  // ✅ キャッシュクリア対策：常に最新状態を再読み込み
  await sheet.loadHeaderRow();
  await sheet.loadCells(); // header + 内容を同期
  const rows = await sheet.getRows();

  // 列名の揺れ対応
  const headers = (sheet.headerValues || []).map((h) => h.toLowerCase());
  const idKey = headers.find((h) => h.includes("userid")) || "userid";

  const ids = rows
    .map((r) => {
      const val = r.UserId || r.userId || r.userid || r[idKey] || "";
      return String(val).trim();
    })
    .filter((x) => x.startsWith("U") && x.length > 20);

  console.log("[getAllUserIds] loaded:", ids.length, "users");
  return ids;
}

/* ======================================================
   ユーザー登録 or 更新
====================================================== */
async function registerUser(userId, displayName = "", startDate = null) {
  if (!userId) return;

  const sheet = await getUserSheet();
  await sheet.loadHeaderRow();
  await sheet.loadCells();
  const rows = await sheet.getRows();

  const exists = rows.some(
    (r) => String(r.UserId || "").trim() === String(userId).trim()
  );

  if (exists) {
    // 既存ユーザー → LastActive更新
    const target = rows.find(
      (r) => String(r.UserId || "").trim() === String(userId).trim()
    );
    target.LastActive = new Date().toISOString();
    await target.save();
    console.log("[registerUser] updated:", userId);
    return;
  }

  // 新規登録
  await sheet.addRow({
    UserId: userId,
    DisplayName: displayName || "",
    StartDate: startDate || new Date().toISOString().slice(0, 10),
    LastActive: new Date().toISOString(),
  });
  console.log("[registerUser] added:", userId);
}

/* ======================================================
   Logs 追記（将来拡張）
====================================================== */
async function appendLogs(data) {
  const doc = await getDoc();
  let sheet = doc.sheetsByTitle["Logs"];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: "Logs",
      headerValues: ["Date", "Slot", "Summary", "Calories", "Note"],
    });
  }
  await sheet.addRow(data);
  console.log("[appendLogs] row added:", data);
}

/* ======================================================
   古い週のアーカイブ（4週以上前を退避）
====================================================== */
async function archiveOldWeeksBatch() {
  const doc = await getDoc();
  const mealSheet = doc.sheetsByTitle["MealPlan"];
  if (!mealSheet) return;

  const rows = await mealSheet.getRows();
  const nowWeek = Math.max(
    ...rows.map((r) => parseInt(r.Week || "0", 10)).filter((x) => !isNaN(x))
  );
  const archiveWeek = nowWeek - 4;
  if (archiveWeek < 1) return;

  const archiveTitle = `Archive_${new Date()
    .toISOString()
    .slice(0, 7)
    .replace("-", "")}`;
  let archiveSheet = doc.sheetsByTitle[archiveTitle];
  if (!archiveSheet) {
    archiveSheet = await doc.addSheet({
      title: archiveTitle,
      headerValues: mealSheet.headerValues,
    });
  }

  const oldRows = rows.filter((r) => parseInt(r.Week) <= archiveWeek);
  for (const r of oldRows) {
    await archiveSheet.addRow(r._rawData);
    await r.delete();
  }

  console.log(
    `[archiveOldWeeksBatch] moved ${oldRows.length} rows to ${archiveTitle}`
  );
}

/* ======================================================
   Export
====================================================== */
module.exports = {
  loadMealPlan,
  getAllUserIds,
  registerUser,
  appendLogs,
  archiveOldWeeksBatch,
};
