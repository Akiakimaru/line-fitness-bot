// lib/sheets.js
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/* ============== 認証共通 ============== */
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

/* ============== MealPlan ============== */
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

/* ============== Users ============== */

async function resolveUsersSheetName() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sh = (meta.data.sheets || []).find(
    (s) => s.properties?.title && s.properties.title.toLowerCase().includes("users")
  );
  return sh ? sh.properties.title : "Users";
}

async function getAllUserIds() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:A`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const ids = (res.data.values || [])
    .map((r) => String((r && r[0]) || "").trim())
    .filter((x) => x.startsWith("U") && x.length > 20);

  return [...new Set(ids)];
}

async function registerUser(userId, displayName = "", startDate = null) {
  if (!userId) return;
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();

  // 現状一覧
  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:A`,
  });
  const list = (cur.data.values || []).map((r) => String(r[0] || "").trim());
  const idx = list.findIndex((v) => v === userId);
  const nowISO = new Date().toISOString();
  const start = startDate || new Date().toISOString().slice(0, 10);

  if (idx >= 0) {
    const row = 2 + idx;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!D${row}:D${row}`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!A:D`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[userId, displayName || "", start, nowISO]] },
    });
  }
}

/* ============== Logs 追記（新スキーマ） ==============
 * ヘッダー: DateTime | UserId | Kind(Meal|Gym|...) | Text | MetaJSON
 * 例:
 *  2025-10-07T07:10:00+09:00, Uxxxx, "Meal", "鶏むね・ヨーグルト", {"time":"07:10"}
 *  2025-10-07T08:00:00+09:00, Uxxxx, "Gym", "ベンチ 50*10…", {"parsed":[...]}
 */
async function ensureLogsHeader(sheetsApi) {
  const head = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Logs!A1:E1`,
  });
  const hv = (head.data.values || [])[0] || [];
  if (hv.length === 0) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Logs!A1:E1`,
      valueInputOption: "RAW",
      requestBody: { values: [["DateTime", "UserId", "Kind", "Text", "MetaJSON"]] },
    });
  }
}

async function appendLogRecord(record) {
  const jwt = getJwt();
  const sheetsApi = google.sheets({ version: "v4", auth: jwt });

  // シートが無ければ作成
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const hasLogs = (meta.data.sheets || []).some(
    (s) => s.properties?.title === "Logs"
  );
  if (!hasLogs) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: "Logs" } } }] },
    });
  }
  await ensureLogsHeader(sheetsApi);

  const row = [
    record.DateTime,
    record.UserId,
    record.Kind,
    record.Text,
    record.MetaJSON || "",
  ];
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `Logs!A:E`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

module.exports = {
  loadMealPlan,
  getAllUserIds,
  registerUser,
  appendLogRecord,
};
