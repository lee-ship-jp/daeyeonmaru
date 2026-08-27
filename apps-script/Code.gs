/**
 * 대연마루 카페 — Google Apps Script backend
 * ------------------------------------------------------------------
 * Stores every order as one row in the bound Google Sheet (tab "Orders"):
 *     Column A: id          Column B: json (the full order object)
 *
 * The web app exposes:
 *     GET  ?action=list            → { ok, orders: [...] }
 *     POST { action:"add",    payload: <order> }        → { ok, id }
 *     POST { action:"update", payload: { id, fields } } → { ok }
 *     POST { action:"clear" }                           → { ok }
 *
 * DEPLOY (one time):
 *   1. Open your Google Sheet ▸ Extensions ▸ Apps Script.
 *   2. Delete any sample code, paste THIS file, Save.
 *   3. Deploy ▸ New deployment ▸ type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Deploy ▸ authorize ▸ copy the "/exec" URL.
 *   4. Paste that URL into index.html  →  const APPS_SCRIPT_URL = "...";
 *
 * After changing this script, redeploy with: Deploy ▸ Manage deployments
 *   ▸ (edit) ▸ Version: New version ▸ Deploy   (keeps the same URL).
 */

const SHEET_NAME = 'Orders';

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, 2).setValues([['id', 'json']]);
  }
  return sh;
}

function readAll_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 2).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i][0];
    if (!id) continue;
    try { out.push(JSON.parse(rows[i][1])); } catch (e) { /* skip bad row */ }
  }
  return out;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: true, orders: readAll_() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = req.action;
    const sh = sheet_();

    if (action === 'add') {
      const order = req.payload || {};
      order.id = 'order_' + new Date().getTime() + '_' + Math.floor(Math.random() * 10000);
      if (!order.createdAt) order.createdAt = new Date().toISOString();
      sh.appendRow([order.id, JSON.stringify(order)]);
      return json_({ ok: true, id: order.id });
    }

    if (action === 'update') {
      const p = req.payload || {};
      const id = p.id, fields = p.fields || {};
      const last = sh.getLastRow();
      if (last >= 2) {
        const ids = sh.getRange(2, 1, last - 1, 1).getValues();
        for (let i = 0; i < ids.length; i++) {
          if (ids[i][0] === id) {
            const cell = sh.getRange(i + 2, 2);
            const order = JSON.parse(cell.getValue());
            for (const k in fields) order[k] = fields[k];
            cell.setValue(JSON.stringify(order));
            break;
          }
        }
      }
      return json_({ ok: true });
    }

    if (action === 'clear') {
      const last = sh.getLastRow();
      if (last >= 2) sh.deleteRows(2, last - 1);
      return json_({ ok: true });
    }

    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
