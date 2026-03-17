// ==================================================
// 進捗管理スプレッドシート連携 GAS (Web App)
// URL提出メッセージ生成アプリから呼び出される
// ==================================================

const SHEET_NAME = '進捗管理';
const HEADER_ROW = 4;
const DATA_START_ROW = 5;

// 列インデックス (0-based)
const COL = {
  KIGAKU_NO: 0,    // A列: 企画No
  TITLE: 1,        // B列: タイトル
  STATUS: 3,       // D列: ステータス
  YOUTUBE_URL: 10, // K列: YouTube 限定公開URL
  MP4_URL: 11,     // L列: MP4
  PROMANAGE_URL: 12 // M列: プロマネ
};

// ステータス変更マッピング
const STATUS_MAP = {
  '制作': '初稿確認中',
  '初稿': '初稿確認中',
  '修正': '修正提出'
};

// スプレッドシートID
const SPREADSHEET_ID = '11Ra6GOEjzvll5TG8OEtxIvvZq4apvmHy1ZtbMtFrWJ4';

// ==================================================
// Web App エンドポイント
// ==================================================

/**
 * CORSプリフライト対応 / 動作確認用
 */
function doGet(e) {
  // ログ記録リクエスト: ?action=log&event=page_view
  if (e && e.parameter && e.parameter.action === 'log') {
    const result = recordUsageLog({
      event: e.parameter.event || '',
      user: e.parameter.user || '',
      input: e.parameter.input || '',
      result: e.parameter.result || '',
      userAgent: e.parameter.userAgent || '',
      note: e.parameter.note || ''
    });
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'GAS Web App is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POSTリクエスト処理
 *
 * リクエストボディ (JSON):
 *
 * ■ スプレッドシート更新:
 * {
 *   "projectName": "プロジェクト名（タイトルで検索）",
 *   "youtubeUrls": ["url1", "url2", ...],
 *   "mp4Url": "MP4のURL",
 *   "promanageUrl": "プロマネのURL",
 *   "workType": "修正" | "制作" | "初稿" | ...
 * }
 *
 * ■ 使用ログ記録:
 * {
 *   "action": "log",
 *   "event": "page_view" | "copy_message" | ...,
 *   "user": "Yutaro",
 *   "input": "https://youtu.be/xxxx",
 *   "result": "success" | "error",
 *   "userAgent": "...",
 *   "note": "任意メモ"
 * }
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // ログ記録リクエストの場合
    if (data.action === 'log') {
      const result = recordUsageLog(data);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 通常のスプレッドシート更新
    const result = updateSpreadsheet(data);

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({
        success: false,
        error: error.message
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==================================================
// 進捗管理シート更新
// ==================================================

/**
 * スプレッドシートを更新する
 */
function updateSpreadsheet(data) {
  const { projectName, youtubeUrls, mp4Url, promanageUrl, workType } = data;

  if (!projectName) {
    return { success: false, error: 'プロジェクト名が指定されていません' };
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    return { success: false, error: `「${SHEET_NAME}」シートが見つかりません` };
  }

  // データ範囲を取得
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) {
    return { success: false, error: 'データが存在しません' };
  }

  const dataRange = sheet.getRange(
    DATA_START_ROW,
    1,
    lastRow - DATA_START_ROW + 1,
    sheet.getLastColumn()
  );
  const values = dataRange.getValues();

  // タイトル（B列）で部分一致検索
  let matchedRowIndex = -1;
  for (let i = 0; i < values.length; i++) {
    const title = String(values[i][COL.TITLE]).trim();
    if (!title) continue;

    // 「projectName が title を含む」または「title が projectName を含む」
    if (projectName.includes(title) || title.includes(projectName)) {
      matchedRowIndex = i;
      break;
    }
  }

  if (matchedRowIndex === -1) {
    return {
      success: false,
      error: `「${projectName}」に一致するプロジェクトが見つかりません`
    };
  }

  const actualRow = DATA_START_ROW + matchedRowIndex;
  const matchedTitle = values[matchedRowIndex][COL.TITLE];

  // YouTube URL を書き込み（改行区切りで複数対応）
  if (youtubeUrls && youtubeUrls.length > 0) {
    const ytUrlText = youtubeUrls.filter(u => u).join('\n');
    if (ytUrlText) {
      sheet.getRange(actualRow, COL.YOUTUBE_URL + 1).setValue(ytUrlText);
    }
  }

  // MP4 URL を書き込み
  if (mp4Url) {
    sheet.getRange(actualRow, COL.MP4_URL + 1).setValue(mp4Url);
  }

  // プロマネ URL を書き込み
  if (promanageUrl) {
    sheet.getRange(actualRow, COL.PROMANAGE_URL + 1).setValue(promanageUrl);
  }

  // ステータスの更新
  const currentStatus = String(values[matchedRowIndex][COL.STATUS]).trim();
  let newStatus = null;

  // 作業種別またはスプレッドシート上の現在のステータスに基づいて判定
  if (workType && STATUS_MAP[workType]) {
    newStatus = STATUS_MAP[workType];
  } else if (STATUS_MAP[currentStatus]) {
    newStatus = STATUS_MAP[currentStatus];
  }

  if (newStatus) {
    sheet.getRange(actualRow, COL.STATUS + 1).setValue(newStatus);
  }

  return {
    success: true,
    message: `「${matchedTitle}」（${actualRow}行目）を更新しました`,
    updatedRow: actualRow,
    matchedTitle: matchedTitle,
    previousStatus: currentStatus,
    newStatus: newStatus || currentStatus
  };
}

// ==================================================
// 使用ログ記録
// ==================================================

const LOG_SHEET_NAME = '使用ログ';

/**
 * 使用ログを「使用ログ」シートに記録する
 * シートが存在しない場合は自動作成
 *
 * data: {
 *   event: "page_view" | "copy_message" | ...,
 *   user: "ユーザー名",
 *   input: "入力値",
 *   result: "success" | "error",
 *   userAgent: "...",
 *   note: "任意メモ"
 * }
 */
function recordUsageLog(data) {
  const { event, user, input, result, userAgent, note } = data;

  if (!event) {
    return { success: false, error: 'イベント種別が指定されていません' };
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let logSheet = ss.getSheetByName(LOG_SHEET_NAME);

  // シートがなければ作成してヘッダーを追加
  if (!logSheet) {
    logSheet = ss.insertSheet(LOG_SHEET_NAME);
    logSheet.appendRow(['日時', 'イベント', 'ユーザー', '入力', '結果', 'UserAgent', 'メモ']);
    logSheet.getRange(1, 1, 1, 7).setFontWeight('bold');
    logSheet.setColumnWidth(1, 180);
    logSheet.setColumnWidth(2, 120);
    logSheet.setColumnWidth(3, 150);
    logSheet.setColumnWidth(4, 250);
    logSheet.setColumnWidth(5, 100);
    logSheet.setColumnWidth(6, 300);
    logSheet.setColumnWidth(7, 250);
  }

  const now = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy/MM/dd HH:mm:ss'
  );
  logSheet.appendRow([now, event, user || '', input || '', result || '', userAgent || '', note || '']);

  return { success: true, message: 'ログを記録しました' };
}
