/* =============================================================
 *  SimpleDraft – pdf.js
 *  jsPDF を使った PDF ダウンロード
 *  ・図面線 + 寸法線（延長線＋寸法テキスト）
 *  ・A4 縦 or 横に自動フィット
 * ============================================================= */
(function () {
  'use strict';

  /**
   * textToImage – ブラウザ Canvas で日本語テキストを描画し PNG DataURL を返す
   * @returns {{url:string, w:number, h:number}}  w,h はピクセル
   */
  function textToImage(text, fontSizePx, color) {
    var c = document.createElement('canvas');
    var ctx = c.getContext('2d');
    var font = fontSizePx + 'px sans-serif';
    ctx.font = font;
    var m = ctx.measureText(text);
    c.width  = Math.ceil(m.width) + 4;
    c.height = Math.ceil(fontSizePx * 1.35);
    // Canvas リセット後に再設定
    ctx.font = font;
    ctx.fillStyle = color || '#000';
    ctx.textBaseline = 'top';
    ctx.fillText(text, 2, 2);
    return { url: c.toDataURL('image/png'), w: c.width, h: c.height };
  }

  window.exportPdf = function () {
    if (typeof window.getDraftSnapshot !== 'function') { alert('描画エンジン未初期化'); return; }
    var snap = window.getDraftSnapshot();
    if (!snap.points.length) {
      alert('図面が空です。先に線を描いてください。');
      return;
    }
    if (typeof window.jspdf === 'undefined') {
      alert('PDF ライブラリを読み込めませんでした。\nネット接続を確認してください。');
      return;
    }
    // ローカル参照（以後 snap.xxx で参照）
    var pts = snap.points;
    var segs = snap.segments;
    var fmtMm = snap.fmtMm;
    function findPt(id) { for(var i=0;i<pts.length;i++){if(pts[i].id===id)return pts[i];} return null; }

    /* --- バウンディングボックス --- */
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    var MARGIN_MM = 800;        // mm（図面座標系でのマージン）
    minX -= MARGIN_MM; minY -= MARGIN_MM;
    maxX += MARGIN_MM; maxY += MARGIN_MM;
    var drawW = maxX - minX, drawH = maxY - minY;

    /* --- 用紙設定 --- */
    var landscape = drawW > drawH;
    var pageW = landscape ? 297 : 210;
    var pageH = landscape ? 210 : 297;
    var pm = 15;                // 用紙マージン mm
    var printW = pageW - pm * 2;
    var printH = pageH - pm * 2;

    var scale = Math.min(printW / drawW, printH / drawH);
    var offX  = pm + (printW - drawW * scale) / 2;
    var offY  = pm + (printH - drawH * scale) / 2;

    function tx(x) { return offX + (x - minX) * scale; }
    function ty(y) { return offY + (y - minY) * scale; }

    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({
      orientation: landscape ? 'landscape' : 'portrait',
      unit: 'mm', format: 'a4'
    });

    /* --- タイトル＋縮尺（日本語対応: Canvas→画像） --- */
    var scaleRatio = Math.round(1 / scale);
    var titleText = (snap.projectName || 'SimpleDraft') + '    Scale 1:' + scaleRatio;
    var titleImg = textToImage(titleText, 22, '#555');
    // 画像の用紙上の高さ = 4mm 程度に収める
    var titleH = 4;
    var titleW = titleH * (titleImg.w / titleImg.h);
    doc.addImage(titleImg.url, 'PNG', pm, pm - 6, titleW, titleH);

    /* --- 壁線（太め） --- */
    doc.setDrawColor(50);
    doc.setLineWidth(0.4);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var a = findPt(s.a), b = findPt(s.b);
      if (!a || !b) continue;
      doc.line(tx(a.x), ty(a.y), tx(b.x), ty(b.y));
    }

    /* --- 頂点（小さい丸） --- */
    doc.setFillColor(80);
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      doc.circle(tx(p.x), ty(p.y), 0.5, 'F');
    }

    /* --- 寸法線 --- */
    var DIM_OFF  = 5;  // 寸法線のオフセット（用紙mm）
    var EXT_OVER = 1;  // 延長線のはみ出し
    var TICK     = 0.8; // ティックマークの長さ

    doc.setFontSize(7);
    doc.setTextColor(0);
    doc.setDrawColor(80);
    doc.setLineWidth(0.12);

    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var a = findPt(s.a), b = findPt(s.b);
      if (!a || !b) continue;
      var len = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
      if (len === 0) continue;
      var label = fmtMm(len);
      var horiz = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);

      if (horiz) {
        var y0 = Math.min(ty(a.y), ty(b.y));
        var dimY = y0 - DIM_OFF;
        var lx = tx(a.x), rx = tx(b.x);
        if (lx > rx) { var tmp = lx; lx = rx; rx = tmp; }
        // 延長線
        doc.line(lx, ty(a.y), lx, dimY - EXT_OVER);
        doc.line(rx, ty(b.y), rx, dimY - EXT_OVER);
        // 寸法線
        doc.line(lx, dimY, rx, dimY);
        // ティック
        doc.line(lx, dimY - TICK, lx, dimY + TICK);
        doc.line(rx, dimY - TICK, rx, dimY + TICK);
        // テキスト
        doc.text(label, (lx + rx) / 2, dimY - 1.2, { align: 'center' });
      } else {
        var x0 = Math.max(tx(a.x), tx(b.x));
        var dimX = x0 + DIM_OFF;
        var topy = ty(a.y), boty = ty(b.y);
        if (topy > boty) { var tmp = topy; topy = boty; boty = tmp; }
        // 延長線
        doc.line(tx(a.x), ty(a.y), dimX + EXT_OVER, ty(a.y));
        doc.line(tx(b.x), ty(b.y), dimX + EXT_OVER, ty(b.y));
        // 寸法線
        doc.line(dimX, topy, dimX, boty);
        // ティック
        doc.line(dimX - TICK, topy, dimX + TICK, topy);
        doc.line(dimX - TICK, boty, dimX + TICK, boty);
        // テキスト（90°回転）
        doc.text(label, dimX + 1.8, (topy + boty) / 2, {
          align: 'center', angle: 90
        });
      }
    }

    /* --- 方位記号（左下） --- */
    var nx = pm + 4, ny = pageH - pm - 2;
    doc.setDrawColor(0); doc.setLineWidth(0.3);
    doc.line(nx, ny, nx, ny - 8);                      // 北向き矢印
    doc.line(nx, ny - 8, nx - 1.5, ny - 5.5);         // 左羽
    doc.line(nx, ny - 8, nx + 1.5, ny - 5.5);         // 右羽
    doc.setFontSize(6);
    doc.setTextColor(0);
    doc.text('N', nx, ny - 9, { align: 'center' });

    /* --- ダウンロード --- */
    var now = new Date();
    var pad = function(n){ return ('0'+n).slice(-2); };
    var rawName = snap.projectName || '';
    // ファイル名サニタイズ: OS禁止文字・制御文字を除去、長さ制限
    var safeName = rawName
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')  // 禁止文字除去
      .replace(/[\s.]+$/g, '')                  // 末尾の空白・ドット除去
      .substring(0, 80);                        // 80文字制限
    var prefix = safeName || 'draft';
    var fname = prefix + '_' + now.getFullYear()
      + pad(now.getMonth()+1) + pad(now.getDate()) + '_'
      + pad(now.getHours()) + pad(now.getMinutes()) + '.pdf';
    doc.save(fname);
  };
})();
