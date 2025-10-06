// lib/sheets.js
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const { withBackoff, nowJST } = require("./utils");

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const jwt = new JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, jwt);

const cell = (row, i) => String((row._rawData && row._rawData[i]) ?? "").trim();

async function loadMealPlan() {
  await withBackoff(() => doc.loadInfo());
  const sheet = doc.sheetsByTitle["MealPlan"];
  if (!sheet) throw new Error("MealPlan sheet not found");
  const rows = await withBackoff(() => sheet.getRows());

  const H = sheet.headerValues; // ["Week","Day","Kind","Slot","Text","Calories","P","F","C","Tips"]
  const idx = {
    Week: H.indexOf("Week"),
    Day: H.indexOf("Day"),
    Kind: H.indexOf("Kind"),
    Slot: H.indexOf("Slot"),
    Text: H.indexOf("Text"),
    Calories: H.indexOf("Calories"),
    P: H.indexOf("P"),
    F: H.indexOf("F"),
    C: H.indexOf("C"),
    Tips: H.indexOf("Tips"),
  };
  Object.entries(idx).forEach(([k, v]) => {
    if (v === -1) throw new Error(`Header "${k}" not found in MealPlan`);
  });

  return { sheet, rows, idx, headers: H };
}

async function ensureLogsSheet() {
  await withBackoff(() => doc.loadInfo());
  let sheet = doc.sheetsByTitle["Logs"];
  if (!sheet) {
    sheet = await withBackoff(() =>
      doc.addSheet({
        title: "Logs",
        headerValues: ["Date", "Kind", "Slot", "Text", "Calories", "P", "F", "C", "Source", "Meta"],
      })
    );
  }
  return sheet;
}

async function appendLogs(rows) {
  const sheet = await ensureLogsSheet();
  await chunkAddRows(sheet, rows);
}

async function getRecentLogs(days = 7) {
  await withBackoff(() => doc.loadInfo());
  const sheet = doc.sheetsByTitle["Logs"];
  if (!sheet) return [];
  const rows = await withBackoff(() => sheet.getRows());
  const since = new Date(nowJST().getTime() - days * 24 * 60 * 60 * 1000);
  return rows
    .filter((r) => {
      const d = new Date(`${cell(r, 0)}T00:00:00+09:00`);
      return d >= since;
    })
    .map((r) => ({
      Date: cell(r, 0),
      Kind: cell(r, 1),
      Slot: cell(r, 2),
      Text: cell(r, 3),
      Calories: cell(r, 4),
      P: cell(r, 5),
      F: cell(r, 6),
      C: cell(r, 7),
      Source: cell(r, 8),
      Meta: cell(r, 9),
    }));
}

async function chunkAddRows(sheet, rows, chunkSize = 50, delayMs = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    await withBackoff(() => sheet.addRows(slice));
    if (i + chunkSize < rows.length) await new Promise((r) => setTimeout(r, delayMs));
  }
}

module.exports = {
  doc,
  cell,
  loadMealPlan,
  ensureLogsSheet,
  appendLogs,
  getRecentLogs,
  chunkAddRows
};
