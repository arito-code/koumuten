/* =============================================================
 *  SimpleDraft – app.js
 *  描画エンジン（グリッド / スナップ / 直交線 / ドラッグ編集
 *                Undo・Redo / LocalStorage / プレビュー）
 * ============================================================= */
(function () {
  'use strict';

  /* ─── 定数 ─── */
  var GRID       = 100;       // mm
  var HIT_R_PX   = 22;        // 点をタップ判定する画面px
  var TAP_THR_PX = 8;         // これ以下の移動はタップ判定
  var SCALES = [
    { label: '1:100', vw: 15000 },
    { label: '1:50',  vw: 8000  },
    { label: '1:25',  vw: 4000  },
    { label: '1:10',  vw: 1500  }
  ];
  var DEF_SCALE = 1;          // 初期 1:50

  /* ─── 状態 ─── */
  var state = {
    points   : [],             // {id, x, y}  x,y = mm
    segments : [],             // {id, a, b}  a,b = pointId
    nextId   : 1,
    activeId : null,           // 描画中ポリラインの先端 pointId
    scaleIdx : DEF_SCALE,
    panX     : 4000,
    panY     : 3000,
    undoStack: [],
    redoStack: [],
    projectName: '',
    orthoMode: true,
    mode: 'draw'               // 'draw' | 'dim' | 'delete'
  };

  /* ─── ポインタ操作用（保存しない） ─── */
  var ptr = reset_ptr();
  function reset_ptr() {
    return {
      down: false, sx: 0, sy: 0, svgX: 0, svgY: 0,
      moved: false, target: null,
      origX: 0, origY: 0,           // ドラッグ開始時の点座標
      panSX: 0, panSY: 0            // パン開始時の panX/Y
    };
  }

  /* ─── DOM ─── */
  var svg          = document.getElementById('drawing');
  var segLayer     = document.getElementById('segmentLayer');
  var dimLayer     = document.getElementById('dimLayer');
  var ptLayer      = document.getElementById('pointLayer');
  var prevLayer    = document.getElementById('previewLayer');
  var scaleLbl     = document.getElementById('scaleLabel');
  var gridDot      = document.getElementById('gridDot');

  /* ═══════════════════════════════════════════
   *  座標変換
   * ═══════════════════════════════════════════ */
  function screen2svg(sx, sy) {
    var p = svg.createSVGPoint();
    p.x = sx; p.y = sy;
    var ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    var s = p.matrixTransform(ctm.inverse());
    return { x: s.x, y: s.y };
  }

  /* ═══════════════════════════════════════════
   *  ビュー（viewBox / ズーム）
   * ═══════════════════════════════════════════ */
  function viewW() { return SCALES[state.scaleIdx].vw; }

  function updateViewBox() {
    var vw = viewW();
    var r  = svg.getBoundingClientRect();
    if (r.width === 0) return;
    var aspect = r.height / r.width;
    var vh = vw * aspect;
    svg.setAttribute('viewBox',
      (state.panX - vw / 2) + ' ' +
      (state.panY - vh / 2) + ' ' + vw + ' ' + vh);
    // グリッドドット：画面上で約2.5px に見える半径
    gridDot.setAttribute('r', vw / r.width * 2.5);
    scaleLbl.textContent = SCALES[state.scaleIdx].label;
  }

  /* ═══════════════════════════════════════════
   *  スナップ & 直交制約
   * ═══════════════════════════════════════════ */
  function snap(x, y) {
    return { x: Math.round(x / GRID) * GRID,
             y: Math.round(y / GRID) * GRID };
  }

  function ortho(from, tx, ty) {
    var dx = Math.abs(tx - from.x);
    var dy = Math.abs(ty - from.y);
    return dx >= dy
      ? { x: tx, y: from.y }   // 水平
      : { x: from.x, y: ty };  // 垂直
  }


  /* ═══════════════════════════════════════════
   *  データ ヘルパー
   * ═══════════════════════════════════════════ */
  function id()       { return state.nextId++; }
  function pt(pid)    { return state.points.find(function(p){ return p.id === pid; }); }
  function nearPt(sx, sy) {
    var vw = viewW(), r = svg.getBoundingClientRect();
    var hit = vw / r.width * HIT_R_PX;
    var best = null, bd = hit;
    for (var i = 0; i < state.points.length; i++) {
      var p = state.points[i];
      var d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /* ═══════════════════════════════════════════
   *  Undo / Redo
   * ═══════════════════════════════════════════ */
  function pushUndo(act) {
    state.undoStack.push(act);
    state.redoStack = [];
    updUndoBtn(); save();
  }
  function undo() {
    if (!state.undoStack.length) return;
    var a = state.undoStack.pop(); state.redoStack.push(a);
    applyAct(a, true); updUndoBtn(); save(); render();
  }
  function redo() {
    if (!state.redoStack.length) return;
    var a = state.redoStack.pop(); state.undoStack.push(a);
    applyAct(a, false); updUndoBtn(); save(); render();
  }
  function applyAct(a, inv) {
    if (a.type === 'add') {
      if (inv) {
        if (a.seg) state.segments = state.segments.filter(function(s){ return s.id !== a.seg.id; });
        state.points = state.points.filter(function(p){ return p.id !== a.pt.id; });
        state.activeId = a.prevActive;
      } else {
        state.points.push(clone(a.pt));
        if (a.seg) state.segments.push(clone(a.seg));
        state.activeId = a.pt.id;
      }
    } else if (a.type === 'connect') {
      if (inv) {
        state.segments = state.segments.filter(function(s){ return s.id !== a.seg.id; });
        state.activeId = a.prevActive;
      } else {
        state.segments.push(clone(a.seg));
        state.activeId = null;
      }
    } else if (a.type === 'move') {
      var p = pt(a.pid);
      if (p) { p.x = inv ? a.ox : a.nx; p.y = inv ? a.oy : a.ny; }
    } else if (a.type === 'deleteBatch') {
      if (inv) {
        // Undo: 削除した点・線を復元
        for (var i = 0; i < a.pts.length; i++) state.points.push(clone(a.pts[i]));
        for (var i = 0; i < a.segs.length; i++) state.segments.push(clone(a.segs[i]));
      } else {
        // Redo: 再度削除
        var pidSet = {}; for (var i = 0; i < a.pts.length; i++) pidSet[a.pts[i].id] = true;
        var sidSet = {}; for (var i = 0; i < a.segs.length; i++) sidSet[a.segs[i].id] = true;
        state.points = state.points.filter(function(p){ return !pidSet[p.id]; });
        state.segments = state.segments.filter(function(s){ return !sidSet[s.id]; });
      }
    }
  }
  function updUndoBtn() {
    document.getElementById('btnUndo').disabled = !state.undoStack.length;
    document.getElementById('btnRedo').disabled = !state.redoStack.length;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ═══════════════════════════════════════════
   *  描画操作
   * ═══════════════════════════════════════════ */
  function addPoint(sx, sy) {
    var sn = snap(sx, sy);
    var from = state.activeId ? pt(state.activeId) : null;
    if (from) {
      if (state.orthoMode) sn = ortho(from, sn.x, sn.y);
      if (sn.x === from.x && sn.y === from.y) return;
    }
    // 既存点に近ければ接続
    var np = nearPt(sn.x, sn.y);
    if (np && from && np.id !== from.id) {
      var sg = { id: id(), a: from.id, b: np.id };
      state.segments.push(sg);
      pushUndo({ type:'connect', seg: clone(sg), prevActive: state.activeId });
      state.activeId = null;
      render(); return;
    }
    var p = { id: id(), x: sn.x, y: sn.y };
    var seg = from ? { id: id(), a: from.id, b: p.id } : null;
    state.points.push(p);
    if (seg) state.segments.push(seg);
    pushUndo({ type:'add', pt: clone(p), seg: seg ? clone(seg) : null, prevActive: state.activeId });
    state.activeId = p.id;
    render();
  }

  /* ═══════════════════════════════════════════
   *  描画サイズヘルパー（画面px → SVG単位）
   * ═══════════════════════════════════════════ */
  function px2svg(px) {
    var r = svg.getBoundingClientRect();
    return r.width ? viewW() / r.width * px : 1;
  }
  function strokeW()  { return px2svg(2); }
  function fontSize() { return px2svg(13); }

  /* ═══════════════════════════════════════════
   *  レンダリング
   * ═══════════════════════════════════════════ */
  function render() {
    renderSegs();
    renderDims();
    renderPts();
    prevLayer.innerHTML = '';
  }

  /* --- 線分 --- */
  function renderSegs() {
    segLayer.innerHTML = '';
    var sw = strokeW();
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      var a = pt(s.a), b = pt(s.b);
      if (!a || !b) continue;
      var l = makeSVG('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: '#444', 'stroke-width': sw, 'stroke-linecap': 'round'
      });
      segLayer.appendChild(l);
    }
  }

  /* --- 重心（外側配置判定用） --- */
  function centroid() {
    var cx = 0, cy = 0, n = state.points.length;
    if (!n) return { x: 0, y: 0 };
    for (var i = 0; i < n; i++) { cx += state.points[i].x; cy += state.points[i].y; }
    return { x: cx / n, y: cy / n };
  }

  /* --- 寸法（外側配置＋タップ編集対応） --- */
  function renderDims() {
    dimLayer.innerHTML = '';
    if (!state.points.length) return;
    var fs  = fontSize();
    var off = fs * 2.2;
    var cen = centroid();

    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      var a = pt(s.a), b = pt(s.b);
      if (!a || !b) continue;
      var len = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
      if (len === 0) continue;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var horiz = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);
      var label = fmtMm(len);
      var tw = label.length * fs * 0.62;
      var th = fs * 1.3;
      var g  = makeSVG('g', {
        'data-seg-id': s.id,
        cursor: 'pointer', 'pointer-events': 'all'
      });

      if (horiz) {
        // 重心が下→上に配置（dir=-1）、重心が上→下に配置（dir=+1）
        var dir = (cen.y > my) ? -1 : 1;
        var ry = my + dir * off - th / 2;
        var rx = mx - tw / 2;
        g.appendChild(makeSVG('rect', {
          x: rx, y: ry, width: tw, height: th,
          fill: '#fff', rx: fs * 0.15, opacity: 0.9
        }));
        g.appendChild(makeSVG('text', {
          x: mx, y: ry + th * 0.76,
          'text-anchor': 'middle', 'font-size': fs,
          'font-family': 'sans-serif', fill: '#333'
        }, label));
      } else {
        // 重心が左→右に配置（dir=+1）、重心が右→左に配置（dir=-1）
        var dir = (cen.x < mx) ? 1 : -1;
        // JIS: 垂直寸法は右から読む → rotate(-90)
        var ig = makeSVG('g', {
          transform: 'translate(' + (mx + dir * off) + ',' + my + ') rotate(-90)'
        });
        ig.appendChild(makeSVG('rect', {
          x: -tw / 2, y: -th / 2, width: tw, height: th,
          fill: '#fff', rx: fs * 0.15, opacity: 0.9
        }));
        ig.appendChild(makeSVG('text', {
          x: 0, y: th * 0.26,
          'text-anchor': 'middle', 'font-size': fs,
          'font-family': 'sans-serif', fill: '#333'
        }, label));
        g.appendChild(ig);
      }
      dimLayer.appendChild(g);
    }
  }

  /* --- 頂点 --- */
  function renderPts() {
    ptLayer.innerHTML = '';
    var r  = px2svg(5);
    var sw = px2svg(1);
    for (var i = 0; i < state.points.length; i++) {
      var p = state.points[i];
      var isActive = p.id === state.activeId;
      ptLayer.appendChild(makeSVG('circle', {
        cx: p.x, cy: p.y, r: r,
        fill: isActive ? '#1e88e5' : '#666',
        stroke: isActive ? '#0d47a1' : '#333',
        'stroke-width': sw
      }));
    }
  }

  /* --- プレビュー（十字カーソル＋吸着リング＋予測線） --- */
  function showPreview(ex, ey) {
    prevLayer.innerHTML = '';

    /* ── スナップ先を計算 ── */
    var sn   = snap(ex, ey);
    var from = state.activeId ? pt(state.activeId) : null;
    var tgt  = (from && state.orthoMode) ? ortho(from, sn.x, sn.y) : sn;

    /* ── 既存点への吸着判定 ── */
    var nearP = nearPt(tgt.x, tgt.y);
    if (nearP && from && nearP.id === from.id) nearP = null;
    var cursor = nearP ? { x: nearP.x, y: nearP.y } : tgt;

    /* ── 1) 十字カーソル（常時表示） ── */
    var chLen = px2svg(30);
    var chW   = px2svg(0.8);
    prevLayer.appendChild(makeSVG('line', {
      x1: cursor.x - chLen, y1: cursor.y,
      x2: cursor.x + chLen, y2: cursor.y,
      stroke: '#1e88e5', 'stroke-width': chW, opacity: 0.55
    }));
    prevLayer.appendChild(makeSVG('line', {
      x1: cursor.x, y1: cursor.y - chLen,
      x2: cursor.x, y2: cursor.y + chLen,
      stroke: '#1e88e5', 'stroke-width': chW, opacity: 0.55
    }));

    /* ── 2) 吸着リング（既存点に近い時だけ） ── */
    if (nearP) {
      var ringR = px2svg(12);
      var ringW = px2svg(2);
      var dash  = px2svg(3) + ' ' + px2svg(2);
      prevLayer.appendChild(makeSVG('circle', {
        cx: nearP.x, cy: nearP.y, r: ringR,
        fill: 'none', stroke: '#4caf50',
        'stroke-width': ringW, 'stroke-dasharray': dash, opacity: 0.85
      }));
    }

    /* ── 4) プレビュー線＋寸法（描画中のみ） ── */
    if (from) {
      var lx = cursor.x, ly = cursor.y;
      if (lx === from.x && ly === from.y) return;
      var sw = strokeW();
      prevLayer.appendChild(makeSVG('line', {
        x1: from.x, y1: from.y, x2: lx, y2: ly,
        stroke: '#1e88e5', 'stroke-width': sw,
        'stroke-dasharray': (sw * 4) + ' ' + (sw * 2)
      }));
      var len = Math.round(Math.hypot(lx - from.x, ly - from.y));
      if (len > 0) {
        var fs = fontSize();
        prevLayer.appendChild(makeSVG('text', {
          x: (from.x + lx) / 2, y: (from.y + ly) / 2 - fs * 1.2,
          'text-anchor': 'middle', 'font-size': fs,
          'font-family': 'sans-serif', fill: '#1e88e5'
        }, fmtMm(len)));
      }
    }
  }

  /* ═══════════════════════════════════════════
   *  ポインタイベント（モード分岐）
   * ═══════════════════════════════════════════ */
  function onDown(e) {
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    var sv = screen2svg(e.clientX, e.clientY);
    var np = (state.mode === 'draw') ? nearPt(sv.x, sv.y) : null;
    ptr = {
      down: true, sx: e.clientX, sy: e.clientY,
      svgX: sv.x, svgY: sv.y, moved: false,
      target: np ? { type: 'point', id: np.id } : { type: 'pending' },
      origX: np ? np.x : 0, origY: np ? np.y : 0,
      panSX: state.panX, panSY: state.panY
    };
  }

  function onMove(e) {
    /* ── ホバー（描画モードのみプレビュー） ── */
    if (!ptr.down) {
      if (state.mode === 'draw') {
        var sv = screen2svg(e.clientX, e.clientY);
        showPreview(sv.x, sv.y);
      }
      return;
    }
    e.preventDefault();
    var dx = e.clientX - ptr.sx, dy = e.clientY - ptr.sy;
    if (Math.hypot(dx, dy) > TAP_THR_PX) ptr.moved = true;
    if (!ptr.moved) return;

    /* ── 描画モード ── */
    if (state.mode === 'draw') {
      if (ptr.target.type === 'point') {
        var sv2 = screen2svg(e.clientX, e.clientY);
        var sn  = snap(sv2.x, sv2.y);
        var p   = pt(ptr.target.id);
        if (p) { p.x = sn.x; p.y = sn.y; render(); showPreview(sn.x, sn.y); }
      } else {
        if (ptr.target.type === 'pending') ptr.target = { type: 'pan' };
        var sc = viewW() / svg.getBoundingClientRect().width;
        state.panX = ptr.panSX - dx * sc;
        state.panY = ptr.panSY - dy * sc;
        updateViewBox();
      }
    }

    /* ── 削除モード：矩形選択プレビュー ── */
    if (state.mode === 'delete') {
      var curSvg = screen2svg(e.clientX, e.clientY);
      drawDeleteRect(ptr.svgX, ptr.svgY, curSvg.x, curSvg.y);
    }
  }

  function onUp(e) {
    if (!ptr.down) return;
    e.preventDefault();

    /* ── 描画モード ── */
    if (state.mode === 'draw') {
      if (!ptr.moved) {
        if (ptr.target.type === 'point') {
          var tp = pt(ptr.target.id);
          if (state.activeId && tp && tp.id !== state.activeId) {
            var sg = { id: id(), a: state.activeId, b: tp.id };
            state.segments.push(sg);
            pushUndo({ type:'connect', seg: clone(sg), prevActive: state.activeId });
            state.activeId = null;
            render();
          } else if (!state.activeId) {
            state.activeId = tp.id;
            render();
          }
        } else {
          var sv = screen2svg(e.clientX, e.clientY);
          addPoint(sv.x, sv.y);
        }
      } else {
        if (ptr.target.type === 'point') {
          var p2 = pt(ptr.target.id);
          if (p2 && (p2.x !== ptr.origX || p2.y !== ptr.origY)) {
            pushUndo({ type:'move', pid: ptr.target.id,
                       ox: ptr.origX, oy: ptr.origY,
                       nx: p2.x, ny: p2.y });
          }
        }
      }
    }

    /* ── 寸法変更モード（タップのみ、dimLayer側で処理済み） ── */
    // dimLayer の pointerdown ハンドラが処理するため、ここでは何もしない

    /* ── 削除モード：矩形選択確定 ── */
    if (state.mode === 'delete' && ptr.moved) {
      var curSvg = screen2svg(e.clientX, e.clientY);
      executeDelete(ptr.svgX, ptr.svgY, curSvg.x, curSvg.y);
    }

    prevLayer.innerHTML = '';
    ptr = reset_ptr();
  }

  /* ═══════════════════════════════════════════
   *  削除モード：矩形描画＋ハイライト
   * ═══════════════════════════════════════════ */
  function drawDeleteRect(x1, y1, x2, y2) {
    prevLayer.innerHTML = '';
    var leftToRight = x2 > x1;
    var rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    var rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    var sw = px2svg(1.2);
    // 左→右=青実線（完全包含）、右→左=緑破線（交差）
    var col = leftToRight ? '#1565c0' : '#2e7d32';
    var dashAttr = leftToRight ? 'none' : (sw * 5) + ' ' + (sw * 3);
    var fillOp = leftToRight ? 0.08 : 0.12;
    prevLayer.appendChild(makeSVG('rect', {
      x: rx, y: ry, width: rw, height: rh,
      fill: col, 'fill-opacity': fillOp,
      stroke: col, 'stroke-width': sw,
      'stroke-dasharray': dashAttr
    }));
    // 選択対象の点をハイライト
    var hits = getDeleteTargets(x1, y1, x2, y2);
    var hr = px2svg(6);
    for (var i = 0; i < hits.pts.length; i++) {
      var p = hits.pts[i];
      prevLayer.appendChild(makeSVG('circle', {
        cx: p.x, cy: p.y, r: hr,
        fill: '#f44336', 'fill-opacity': 0.5, stroke: 'none'
      }));
    }
  }

  /* ── 選択対象の判定 ── */
  function getDeleteTargets(x1, y1, x2, y2) {
    var leftToRight = x2 > x1;
    var rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    var rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    var rx2 = rx + rw, ry2 = ry + rh;

    var hitPts = [];
    var hitPtIds = {};

    if (leftToRight) {
      // 完全包含: 矩形内に完全に入っている点のみ
      for (var i = 0; i < state.points.length; i++) {
        var p = state.points[i];
        if (p.x >= rx && p.x <= rx2 && p.y >= ry && p.y <= ry2) {
          hitPts.push(p); hitPtIds[p.id] = true;
        }
      }
    } else {
      // 交差: 矩形に触れる線分の端点も含む
      for (var i = 0; i < state.points.length; i++) {
        var p = state.points[i];
        if (p.x >= rx && p.x <= rx2 && p.y >= ry && p.y <= ry2) {
          hitPts.push(p); hitPtIds[p.id] = true;
        }
      }
      // さらに、線分が矩形と交差する場合その両端点も対象
      for (var i = 0; i < state.segments.length; i++) {
        var s = state.segments[i];
        var a = pt(s.a), b = pt(s.b);
        if (!a || !b) continue;
        if (lineIntersectsRect(a.x, a.y, b.x, b.y, rx, ry, rx2, ry2)) {
          if (!hitPtIds[a.id]) { hitPts.push(a); hitPtIds[a.id] = true; }
          if (!hitPtIds[b.id]) { hitPts.push(b); hitPtIds[b.id] = true; }
        }
      }
    }
    // 削除対象のセグメント: 両端いずれかが対象点に含まれるもの
    var hitSegs = [];
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      if (hitPtIds[s.a] || hitPtIds[s.b]) hitSegs.push(s);
    }
    return { pts: hitPts, segs: hitSegs };
  }

  /* ── 線分と矩形の交差判定 ── */
  function lineIntersectsRect(ax, ay, bx, by, rx, ry, rx2, ry2) {
    // 端点が矩形内なら交差
    if ((ax >= rx && ax <= rx2 && ay >= ry && ay <= ry2) ||
        (bx >= rx && bx <= rx2 && by >= ry && by <= ry2)) return true;
    // 矩形の4辺と線分の交差判定
    return segIntersect(ax,ay,bx,by, rx,ry,rx2,ry) ||
           segIntersect(ax,ay,bx,by, rx2,ry,rx2,ry2) ||
           segIntersect(ax,ay,bx,by, rx,ry2,rx2,ry2) ||
           segIntersect(ax,ay,bx,by, rx,ry,rx,ry2);
  }
  function segIntersect(ax,ay,bx,by, cx,cy,dx,dy) {
    var d1 = cross(cx,cy,dx,dy,ax,ay);
    var d2 = cross(cx,cy,dx,dy,bx,by);
    var d3 = cross(ax,ay,bx,by,cx,cy);
    var d4 = cross(ax,ay,bx,by,dx,dy);
    if (((d1>0&&d2<0)||(d1<0&&d2>0)) && ((d3>0&&d4<0)||(d3<0&&d4>0))) return true;
    return false;
  }
  function cross(ax,ay,bx,by,cx,cy) { return (bx-ax)*(cy-ay)-(by-ay)*(cx-ax); }

  /* ── 削除実行 ── */
  function executeDelete(x1, y1, x2, y2) {
    var hits = getDeleteTargets(x1, y1, x2, y2);
    if (!hits.pts.length && !hits.segs.length) return;
    var msg = hits.pts.length + '個の点と' + hits.segs.length + '本の線を削除しますか？';
    if (!confirm(msg)) return;
    // Undo 用にクローン保存
    var act = {
      type: 'deleteBatch',
      pts: hits.pts.map(function(p){ return clone(p); }),
      segs: hits.segs.map(function(s){ return clone(s); })
    };
    // 削除実行
    var pidSet = {}; for (var i = 0; i < hits.pts.length; i++) pidSet[hits.pts[i].id] = true;
    var sidSet = {}; for (var i = 0; i < hits.segs.length; i++) sidSet[hits.segs[i].id] = true;
    state.points = state.points.filter(function(p){ return !pidSet[p.id]; });
    state.segments = state.segments.filter(function(s){ return !sidSet[s.id]; });
    if (state.activeId && pidSet[state.activeId]) state.activeId = null;
    pushUndo(act);
    render();
  }

  /* ═══════════════════════════════════════════
   *  LocalStorage
   * ═══════════════════════════════════════════ */
  var SKEY = 'simpleDraft_v1';
  function save() {
    try {
      localStorage.setItem(SKEY, JSON.stringify({
        points: state.points, segments: state.segments,
        nextId: state.nextId, activeId: state.activeId,
        panX: state.panX, panY: state.panY,
        scaleIdx: state.scaleIdx,
        projectName: state.projectName,
        orthoMode: state.orthoMode
      }));
    } catch(e){}
  }
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(SKEY));
      if (!d) return;
      state.points   = d.points   || [];
      state.segments = d.segments || [];
      state.nextId   = d.nextId   || 1;
      state.activeId = d.activeId || null;
      state.panX     = d.panX     != null ? d.panX : 4000;
      state.panY     = d.panY     != null ? d.panY : 3000;
      state.scaleIdx = d.scaleIdx != null ? d.scaleIdx : DEF_SCALE;
      state.projectName = d.projectName || '';
      state.orthoMode = d.orthoMode != null ? d.orthoMode : true;
    } catch(e){}
  }

  /* ═══════════════════════════════════════════
   *  ツールバーハンドラ
   * ═══════════════════════════════════════════ */
  function onNew() {
    if (state.points.length && !confirm('図面をクリアしますか？')) return;
    state.points = []; state.segments = [];
    state.nextId = 1; state.activeId = null;
    state.undoStack = []; state.redoStack = [];
    state.projectName = '';
    document.getElementById('projectName').value = '';
    updUndoBtn(); save(); render();
  }
  function onFinish() { state.activeId = null; render(); }
  function onZoomIn() {
    if (state.scaleIdx < SCALES.length - 1) {
      state.scaleIdx++; updateViewBox(); render(); save();
    }
  }
  function onZoomOut() {
    if (state.scaleIdx > 0) {
      state.scaleIdx--; updateViewBox(); render(); save();
    }
  }

  /* ═══════════════════════════════════════════
   *  ユーティリティ
   * ═══════════════════════════════════════════ */
  function makeSVG(tag, attrs, text) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  }
  function fmtMm(mm) { return mm.toLocaleString('ja-JP'); }

  /* ═══════════════════════════════════════════
   *  寸法タッチ編集
   * ═══════════════════════════════════════════ */
  function editDimension(segId) {
    var seg = state.segments.find(function(s){ return s.id === segId; });
    if (!seg) return;
    var a = pt(seg.a), b = pt(seg.b);
    if (!a || !b) return;
    var curLen = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
    var input = prompt('寸法 (mm) を入力してください', curLen);
    if (input === null) return;
    var newLen = parseInt(input, 10);
    if (isNaN(newLen) || newLen <= 0) return;
    // スナップ: GRID の倍数に丸める
    newLen = Math.round(newLen / GRID) * GRID;
    if (newLen <= 0) newLen = GRID;
    if (newLen === curLen) return;
    // 端点B を方向を維持して伸縮
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.hypot(dx, dy);
    var oldBx = b.x, oldBy = b.y;
    b.x = a.x + dx / dist * newLen;
    b.y = a.y + dy / dist * newLen;
    // 直交線の場合はスナップ補正
    b.x = Math.round(b.x / GRID) * GRID;
    b.y = Math.round(b.y / GRID) * GRID;
    pushUndo({ type:'move', pid: seg.b, ox: oldBx, oy: oldBy, nx: b.x, ny: b.y });
    render();
  }

  /* ═══════════════════════════════════════════
   *  初期化
   * ═══════════════════════════════════════════ */
  function init() {
    load();
    updateViewBox();
    render();
    updUndoBtn();

    // 寸法タップ編集（寸法変更モード時のみ有効）
    dimLayer.addEventListener('pointerdown', function(e) {
      if (state.mode !== 'dim') return;
      var g = e.target.closest('[data-seg-id]');
      if (!g) return;
      e.stopPropagation();
      var segId = parseInt(g.getAttribute('data-seg-id'), 10);
      if (segId) editDimension(segId);
    });

    // モード切替
    var modeBtns = {
      draw:   document.getElementById('btnModeDraw'),
      dim:    document.getElementById('btnModeDim'),
      'delete': document.getElementById('btnModeDelete')
    };
    function setMode(m) {
      state.mode = m;
      for (var k in modeBtns) {
        modeBtns[k].classList.toggle('mode-active', k === m);
      }
      // カーソル連動
      svg.className.baseVal = m !== 'draw' ? 'mode-' + m : '';
      // 描画モード以外ではアクティブ点を解除
      if (m !== 'draw' && state.activeId) { state.activeId = null; render(); }
    }
    for (var k in modeBtns) {
      (function(mode) {
        modeBtns[mode].addEventListener('click', function(){ setMode(mode); });
      })(k);
    }

    // ポインタイベント
    svg.addEventListener('pointerdown',   onDown);
    svg.addEventListener('pointermove',   onMove);
    svg.addEventListener('pointerup',     onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('contextmenu', function(e){ e.preventDefault(); });
    svg.addEventListener('touchstart',  function(e){ e.preventDefault(); }, { passive: false });

    // 案件名入力
    var nameInput = document.getElementById('projectName');
    nameInput.value = state.projectName;
    nameInput.addEventListener('input', function() {
      state.projectName = nameInput.value;
      save();
    });
    // 入力中はキャンバスへのキーイベントを止める
    nameInput.addEventListener('keydown', function(e){ e.stopPropagation(); });

    // 直交トグル
    var orthoBtn = document.getElementById('btnOrtho');
    function syncOrthoBtn() {
      orthoBtn.className = state.orthoMode ? 'toggle-on' : 'toggle-off';
    }
    syncOrthoBtn();
    orthoBtn.addEventListener('click', function() {
      state.orthoMode = !state.orthoMode;
      syncOrthoBtn();
      save();
    });

    // ツールバー
    document.getElementById('btnNew').addEventListener('click', onNew);
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnRedo').addEventListener('click', redo);
    document.getElementById('btnZoomIn').addEventListener('click', onZoomIn);
    document.getElementById('btnZoomOut').addEventListener('click', onZoomOut);
    document.getElementById('btnFinish').addEventListener('click', onFinish);
    document.getElementById('btnPdf').addEventListener('click', function(){
      if (typeof window.exportPdf === 'function') window.exportPdf();
    });

    // キーボード
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape') onFinish();
    });

    // リサイズ
    window.addEventListener('resize', function(){ updateViewBox(); render(); });
  }

  // pdf.js から参照できるように最小限の読み取り専用スナップショットを公開
  window.getDraftSnapshot = function () {
    return {
      points: JSON.parse(JSON.stringify(state.points)),
      segments: JSON.parse(JSON.stringify(state.segments)),
      projectName: state.projectName,
      fmtMm: fmtMm
    };
  };

  init();
})();
