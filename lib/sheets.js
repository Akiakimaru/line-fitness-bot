// lib/sheets.js
// Google Sheets access helpers (v4 REST + google-spreadsheet for MealPlan reads)

const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/* ================= Auth (shared) ================= */
function getServiceAccount() {
  // GOOGLE_SERVICE_ACCOUNT_JSON must be a full JSON string
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

/* ================= MealPlan (read via google-spreadsheet) ================= */
async function loadMealPlan() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle["MealPlan"];
  if (!sheet) throw new Error("MealPlan sheet not found");
  const rows = await sheet.getRows();
  const headers = sheet.headerValues || [];
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));
  // minimal header validation
  ["Week", "Day", "Kind", "Slot", "Text", "Calories", "P", "F", "C", "Tips"].forEach((h) => {
    if (typeof idx[h] !== "number") {
      throw new Error(`Header "${h}" not found in MealPlan`);
    }
  });
  return { sheet, rows, idx, headers };
}

/* ================= Users (REST API, deterministic upsert) ================= */
async function resolveUsersSheetName() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sh = (meta.data.sheets || []).find(
    (s) => s.properties?.title && s.properties.title.toLowerCase().includes("users")
  );
  return sh ? sh.properties.title : "Users";
}

async function ensureUsersHeader(sheetsApi, title) {
  // Create sheet if missing, then ensure A1:D1 header
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SHEET_ID });
  let found = (meta.data.sheets || []).find((s) => s.properties?.title === title);
  if (!found) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    found = { properties: { title } };
  }
  const head = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${title}!A1:D1`,
  });
  const hv = (head.data.values || [])[0] || [];
  if (!hv.length) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${title}!A1:D1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["UserId", "DisplayName", "StartDate", "LastActive"]],
      },
    });
  }
}

async function registerUser(userId, displayName = "", startDate = null) {
  if (!userId) return;
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();
  await ensureUsersHeader(sheets, usersSheet);

  // current ids (A2:A)
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:A`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const list = (current.data.values || []).map((r) => String(r[0] || "").trim());
  const idx = list.findIndex((v) => v === userId);

  const nowISO = new Date().toISOString();
  const start = startDate || new Date().toISOString().slice(0, 10);

  if (idx >= 0) {
    const row = 2 + idx;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!D${row}:D${row}`, // LastActive
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO]] },
    });
    console.log("[registerUser] updated:", userId);
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!A:D`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[userId, displayName || "", start, nowISO]] },
    });
    console.log("[registerUser] added:", userId);
  }
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

  // unique
  const uniq = [...new Set(ids)];
  console.log("[getAllUserIds] loaded:", uniq.length, "users");
  return uniq;
}

/** Read Users sheet with details (UserId, DisplayName, StartDate, LastActive) */
async function readUsersDetailed() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:D`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = res.data.values || [];
  return rows
    .map((r) => ({
      UserId: String((r && r[0]) || ""),
      DisplayName: String((r && r[1]) || ""),
      StartDate: String((r && r[2]) || ""),
      LastActive: String((r && r[3]) || ""),
    }))
    .filter((u) => u.UserId);
}

/** Optional: physically dedupe Users by UserId (keep latest LastActive) */
async function dedupeUsers() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();
  await ensureUsersHeader(sheets, usersSheet);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:D`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = res.data.values || [];

  const map = new Map(); // userId -> row
  for (const row of rows) {
    const uid = String(row[0] || "").trim();
    if (!uid) continue;
    const exist = map.get(uid);
    if (!exist) map.set(uid, row);
    else {
      const a = exist[3] || "";
      const b = row[3] || "";
      map.set(uid, b > a ? row : exist);
    }
  }
  const uniq = Array.from(map.values());

  // clear and write back
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:D`,
  });
  if (uniq.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!A2`,
      valueInputOption: "RAW",
      requestBody: { values: uniq },
    });
  }
  console.log(`[dedupeUsers] kept ${uniq.length} unique rows (from ${rows.length})`);
}

/* ================= Logs (REST API) =================
 * Schema: Logs!A:E
 *   DateTime | UserId | Kind | Text | MetaJSON
 */
async function ensureLogsHeader(sheetsApi) {
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
  const head = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Logs!A1:E1`,
  });
  const hv = (head.data.values || [])[0] || [];
  if (!hv.length) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Logs!A1:E1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["DateTime", "UserId", "Kind", "Text", "MetaJSON"]],
      },
    });
  }
}

async function appendLogRecord(record) {
  // record: { DateTime, UserId, Kind, Text, MetaJSON? }
  const jwt = getJwt();
  const sheetsApi = google.sheets({ version: "v4", auth: jwt });
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

/** Read recent logs within N days (default 7) */
async function readRecentLogs(days = 7) {
  const jwt = getJwt();
  const sheetsApi = google.sheets({ version: "v4", auth: jwt });

  // If Logs missing, return empty
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const hasLogs = (meta.data.sheets || []).some(
    (s) => s.properties?.title === "Logs"
  );
  if (!hasLogs) return [];

  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Logs!A2:E`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const rows = res.data.values || [];
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const out = [];
  for (const r of rows) {
    const dt = r[0] || "";
    if (!dt) continue;
    const t = new Date(dt);
    if (Number.isNaN(t.getTime()) || t < since) continue;

    let metaObj = {};
    try {
      metaObj = r[4] ? JSON.parse(r[4]) : {};
    } catch (_) {
      metaObj = {};
    }
    out.push({
      DateTime: t.toISOString(),
      UserId: String(r[1] || ""),
      Kind: String(r[2] || ""),
      Text: String(r[3] || ""),
      Meta: metaObj,
    });
  }
  return out;
}

module.exports = {
  // MealPlan
  loadMealPlan,

  // Users
  resolveUsersSheetName,
  registerUser,
  getAllUserIds,
  dedupeUsers,

  // Logs
  appendLogRecord,
  readRecentLogs,
};
