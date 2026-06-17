/**
 * VIVEKA MASTER DATABASE: VERBATIM SYNC ENGINE
 * 
 * Logs Transcription (Original), Transliteration (Phonetic), and Translation (English).
 */
function doPost(e) {
  var folderId = "12rVaQ__R6lLybaT2iww5bX081qI3YAyc"; 
  
  try {
    var data = JSON.parse(e.postData.contents);
    var folder = DriveApp.getFolderById(folderId);
    
    var fileName = "Viveka AI Master Database";
    var files = folder.getFilesByName(fileName);
    var ss;
    if (files.hasNext()) {
      ss = SpreadsheetApp.open(files.next());
    } else {
      ss = SpreadsheetApp.create(fileName);
      var ssFile = DriveApp.getFileById(ss.getId());
      folder.addFile(ssFile);
      DriveApp.getRootFolder().removeFile(ssFile);
    }
    
    var sheet = ss.getSheets()[0];
    
    // Header Initialization (13 Columns for full high-fidelity mapping)
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Serial", 
        "Timestamp", 
        "Audio Name", 
        "MU_ID", 
        "Speaker", 
        "Transcription (Original)", 
        "Transliteration (Phonetic)", 
        "Translation (English)", 
        "Mechanism Chains (A3)",
        "Hotspots (A5)",
        "Executive Summary", 
        "Strategic Takeaways",
        "Recommendations"
      ]);
      sheet.getRange(1, 1, 1, 13).setFontWeight("bold").setBackground("#0f172a").setFontColor("#ffffff");
      sheet.setFrozenRows(1);
    }
    
    var timestamp = data.metadata.syncedAt || new Date().toLocaleString();
    var filename = data.originalFileName || "Session";
    var summary = data.metadata.summary || "";
    var takeaways = (data.metadata.keyPoints || []).join(" | ");
    
    // Qualitative Artifact Synthesis
    var chains = (data.analysis.artifact3_chains || []).map(c => c.chain_id + ": " + c.impacts).join("\n");
    var hotspots = (data.analysis.artifact5_hotspots || []).map(h => h.vulnerable + " (" + h.drivers + ")").join("\n");
    var recs = (data.analysis.webhookData && data.analysis.webhookData.smart_recs) ? data.analysis.webhookData.smart_recs : "";
    
    if (data.turns && data.turns.length > 0) {
      var rows = [];
      var currentLastRow = sheet.getLastRow();
      
      for (var i = 0; i < data.turns.length; i++) {
        var t = data.turns[i];
        rows.push([
          currentLastRow + i,
          timestamp,
          filename,
          t.mu_id || "N/A",
          t.speaker,
          t.original || "",
          t.transliterated || "",
          t.translated || "",
          i === 0 ? chains : "",
          i === 0 ? hotspots : "",
          i === 0 ? summary : "",
          i === 0 ? takeaways : "",
          i === 0 ? recs : ""
        ]);
      }
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 13).setValues(rows);
      
      // Visual banding for the session block
      var lastRow = sheet.getLastRow();
      sheet.getRange(lastRow - rows.length + 1, 1, rows.length, 13).setBorder(true, null, true, null, null, null, "#e2e8f0", SpreadsheetApp.BorderStyle.SOLID);
    }
    
    return ContentService.createTextOutput("SUCCESS").setMimeType(ContentService.MimeType.TEXT);
    
  } catch (err) {
    return ContentService.createTextOutput("ERROR: " + err.toString()).setMimeType(ContentService.MimeType.TEXT);
  }
}