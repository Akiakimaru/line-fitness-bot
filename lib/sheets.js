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

/* ============== Users: REST 直読み/直書き ============== */

/** 現在の Users シート名（“Users”“Users ”など揺れ吸収）を取得 */
async function resolveUsersSheetName() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sh = (meta.data.sheets || []).find(
    (s) => s.properties?.title && s.properties.title.toLowerCase().includes("users")
  );
  if (!sh) return "Users";
  return sh.properties.title;
}

/** Users!A2:A を REST で取得（Push対象） */
async function getAllUserIds() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:A`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const ids = (res.data.values || [])
    .map((r) => String((r && r[0]) || "").trim())
    .filter((x) => x.startsWith("U") && x.length > 20);

  // 一応ここでも重複除去
  const uniq = [...new Set(ids)];
  console.log("[getAllUserIds] loaded:", uniq.length, "users");
  return uniq;
}

/** Users への upsert（存在すれば LastActive を更新、無ければ行追加） */
async function registerUser(userId, displayName = "", startDate = null) {
  if (!userId) return;
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();

  // ヘッダ存在チェック＆作成
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties?.title === usersSheet
  );
  const sheetId = sheet?.properties?.sheetId;

  if (!sheet) {
    // 作られていないケース（ほぼ無いが安全策）
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title: "Users" },
            },
          },
        ],
      },
    });
    // ヘッダ行セット
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Users!A1:D1",
      valueInputOption: "RAW",
      requestBody: { values: [["UserId", "DisplayName", "StartDate", "LastActive"]] },
    });
  } else {
    // ヘッダが空ならセット（念のため）
    const head = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!A1:D1`,
    });
    const hv = (head.data.values || [])[0] || [];
    if (!hv.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${usersSheet}!A1:D1`,
        valueInputOption: "RAW",
        requestBody: { values: [["UserId", "DisplayName", "StartDate", "LastActive"]] },
      });
    }
  }

  // 既存行検索（A列）
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
    // 既存: D列（LastActive）だけ更新
    const rowNumber = 2 + idx; // ヘッダ行が1
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!D${rowNumber}:D${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO]] },
    });
    console.log("[registerUser] updated:", userId);
  } else {
    // 新規: 1行追加
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${usersSheet}!A:D`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[userId, displayName || "", start, nowISO]],
      },
    });
    console.log("[registerUser] added:", userId);
  }
}

/** 重複を物理削除してユニーク化（メンテ用） */
async function dedupeUsers() {
  const jwt = getJwt();
  const sheets = google.sheets({ version: "v4", auth: jwt });
  const usersSheet = await resolveUsersSheetName();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${usersSheet}!A2:D`,
  });
  const rows = res.data.values || [];

  const map = new Map(); // userId -> row
  for (const row of rows) {
    const uid = String(row[0] || "").trim();
    if (!uid) continue;
    // 最新 LastActive を優先
    const exist = map.get(uid);
    if (!exist) map.set(uid, row);
    else {
      const a = exist[3] || "";
      const b = row[3] || "";
      map.set(uid, b > a ? row : exist);
    }
  }
  const uniq = Array.from(map.values());

  // シート再書き込み（ヘッダ保持）
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

module.exports = {
  loadMealPlan,
  getAllUserIds,
  registerUser,
  dedupeUsers,
};
