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
    circles  : [],             // {id, center, r, fullCircle, startAngle, endAngle}  angles=deg
    nextId   : 1,
    activeId : null,           // 描画中ポリラインの先端 pointId
    scaleIdx : DEF_SCALE,
    panX     : 4000,
    panY     : 3000,
    undoStack: [],
    redoStack: [],
    projectName: '',
    orthoMode: true,
    mode: 'draw',              // 'draw' | 'dim' | 'delete' | 'move'
    drawTool: 'line'           // 'line' | 'circle'
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

  /* ─── 2本指パン用（保存しない / pointerイベントで実装） ─── */
  var touchPan = {
    active: false,
    pointers: {},   // pointerId -> {x,y}
    startCx: 0, startCy: 0,
    panSX: 0, panSY: 0
  };
  function countObjKeys(o) { var n = 0; for (var k in o) if (o.hasOwnProperty(k)) n++; return n; }
  function touchCentroid() {
    var sx = 0, sy = 0, n = 0;
    for (var k in touchPan.pointers) {
      if (!touchPan.pointers.hasOwnProperty(k)) continue;
      sx += touchPan.pointers[k].x;
      sy += touchPan.pointers[k].y;
      n++;
    }
    return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
  }

  /* ─── DOM ─── */
  var svg          = document.getElementById('drawing');
  var circleLayer  = document.getElementById('circleLayer');
  var segLayer     = document.getElementById('segmentLayer');
  var dimLayer     = document.getElementById('dimLayer');
  var ptLayer      = document.getElementById('pointLayer');
  var prevLayer    = document.getElementById('previewLayer');
  var scaleLbl     = document.getElementById('scaleLabel');
  var gridDot      = document.getElementById('gridDot');
  var floatUndo    = document.getElementById('floatUndo');
  var floatZoom    = document.getElementById('floatZoom');
  var modeIndicator = document.getElementById('modeIndicator');
  // 円UIモーダル
  var radiusModal = document.getElementById('radiusModal');
  var radiusInput = document.getElementById('radiusInput');
  var radiusOkBtn = document.getElementById('radiusOk');
  var radiusCancelBtn = document.getElementById('radiusCancel');
  var radiusCloseBtn = document.getElementById('radiusClose');
  var circleTypeModal = document.getElementById('circleTypeModal');
  var circleTypeCancelBtn = document.getElementById('circleTypeCancel');
  var circleTypeCloseBtn = document.getElementById('circleTypeClose');
  function updateModeIndicator() {
    if (!modeIndicator) return;
    if (state.mode !== 'draw') {
      modeIndicator.textContent =
        (state.mode === 'dim') ? '寸法' :
        (state.mode === 'move') ? '移動' : '削除';
      return;
    }
    if (state.drawTool === 'circle' && circleDraft) {
      modeIndicator.textContent = (circleDraft.stage === 'pickEnd') ? '円: 終了点をタップ' : '円: 開始点をタップ';
      return;
    }
    modeIndicator.textContent = '描画';
  }

  function hideFloats() {
    if (floatUndo) floatUndo.classList.add('is-hidden');
    if (floatZoom) floatZoom.classList.add('is-hidden');
  }
  function showFloats() {
    if (floatUndo) floatUndo.classList.remove('is-hidden');
    if (floatZoom) floatZoom.classList.remove('is-hidden');
  }

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
    } else if (a.type === 'addCircle') {
      if (inv) {
        state.circles = state.circles.filter(function(c){ return c.id !== a.circle.id; });
        if (a.centerPt) state.points = state.points.filter(function(p){ return p.id !== a.centerPt.id; });
        state.activeId = a.prevActive;
      } else {
        if (a.centerPt) state.points.push(clone(a.centerPt));
        state.circles.push(clone(a.circle));
        state.activeId = null;
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
        for (var i = 0; i < (a.circles || []).length; i++) state.circles.push(clone(a.circles[i]));
      } else {
        // Redo: 再度削除
        var pidSet = {}; for (var i = 0; i < a.pts.length; i++) pidSet[a.pts[i].id] = true;
        var sidSet = {}; for (var i = 0; i < a.segs.length; i++) sidSet[a.segs[i].id] = true;
        var cidSet = {}; for (var i = 0; i < (a.circles || []).length; i++) cidSet[a.circles[i].id] = true;
        state.points = state.points.filter(function(p){ return !pidSet[p.id]; });
        state.segments = state.segments.filter(function(s){ return !sidSet[s.id]; });
        state.circles = state.circles.filter(function(c){ return !cidSet[c.id] && !pidSet[c.center]; });
      }
    } else if (a.type === 'moveBatch') {
      if (inv) {
        // Undo: 参照を戻す → 座標を戻す → 複製点を削除
        for (var i = 0; i < (a.segUpdates || []).length; i++) {
          var u = a.segUpdates[i];
          var s = state.segments.find(function(x){ return x.id === u.sid; });
          if (s) { s.a = u.oa; s.b = u.ob; }
        }
        for (var i = 0; i < (a.circleUpdates || []).length; i++) {
          var u = a.circleUpdates[i];
          var c = state.circles.find(function(x){ return x.id === u.cid; });
          if (c) c.center = u.ocenter;
        }
        for (var i = 0; i < (a.moves || []).length; i++) {
          var m = a.moves[i];
          var p = pt(m.pid);
          if (p) { p.x = m.ox; p.y = m.oy; }
        }
        if (a.createdPts && a.createdPts.length) {
          var cidSet = {};
          for (var i = 0; i < a.createdPts.length; i++) cidSet[a.createdPts[i].id] = true;
          state.points = state.points.filter(function(p){ return !cidSet[p.id]; });
        }
      } else {
        // Redo: 複製点を追加 → 参照を更新 → 座標を更新
        for (var i = 0; i < (a.createdPts || []).length; i++) {
          var cp = a.createdPts[i];
          if (!pt(cp.id)) state.points.push(clone(cp));
        }
        for (var i = 0; i < (a.segUpdates || []).length; i++) {
          var u = a.segUpdates[i];
          var s = state.segments.find(function(x){ return x.id === u.sid; });
          if (s) { s.a = u.na; s.b = u.nb; }
        }
        for (var i = 0; i < (a.circleUpdates || []).length; i++) {
          var u = a.circleUpdates[i];
          var c = state.circles.find(function(x){ return x.id === u.cid; });
          if (c) c.center = u.ncenter;
        }
        for (var i = 0; i < (a.moves || []).length; i++) {
          var m = a.moves[i];
          var p = pt(m.pid);
          if (p) { p.x = m.nx; p.y = m.ny; }
        }
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

  function normAngleDeg(a) {
    var x = a % 360;
    if (x < 0) x += 360;
    return x;
  }
  function ccwDeltaDeg(a0, a1) {
    a0 = normAngleDeg(a0);
    a1 = normAngleDeg(a1);
    return (a1 >= a0) ? (a1 - a0) : (a1 + 360 - a0);
  }
  function parseNumPrompt(msg, defVal) {
    var s = prompt(msg, defVal != null ? String(defVal) : '');
    if (s === null) return null;
    var v = parseFloat(String(s).replace(/,/g, ''));
    if (!isFinite(v)) return null;
    return v;
  }

  var radiusModalCb = null;
  function closeRadiusModal(val) {
    if (radiusModal) radiusModal.classList.remove('is-open');
    var cb = radiusModalCb;
    radiusModalCb = null;
    if (typeof cb === 'function') cb(val);
  }
  function showRadiusModal(defaultVal, cb) {
    if (!radiusModal || !radiusInput) { if (typeof cb === 'function') cb(null); return; }
    radiusModalCb = cb;
    radiusInput.value = (defaultVal != null) ? String(defaultVal) : '';
    radiusModal.classList.add('is-open');
    setTimeout(function () {
      try { radiusInput.focus(); radiusInput.select(); } catch(e) {}
    }, 0);
  }

  var circleTypeModalCb = null;
  function closeCircleTypeModal(kind) {
    if (circleTypeModal) circleTypeModal.classList.remove('is-open');
    var cb = circleTypeModalCb;
    circleTypeModalCb = null;
    if (typeof cb === 'function') cb(kind);
  }
  function showCircleTypeModal(cb) {
    if (!circleTypeModal) { if (typeof cb === 'function') cb(null); return; }
    circleTypeModalCb = cb;
    circleTypeModal.classList.add('is-open');
  }

  // 円ツールの途中入力（保存しない）
  var circleDraft = null;
  // { stage:'pickStart'|'pickEnd', centerPt, createdCenter:boolean, r, kind, startAngle:number|null }

  // 移動モードの選択状態（保存しない）
  var moveSelection = {
    segIds: {},
    circleIds: {},
    ptIds: {}
  };
  function clearMoveSelection() {
    moveSelection = { segIds: {}, circleIds: {}, ptIds: {} };
  }
  function hasMoveSelection() {
    for (var k in moveSelection.segIds) return true;
    for (var k in moveSelection.circleIds) return true;
    return false;
  }
  function recalcMoveSelectionPtIds() {
    var ptIds = {};
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      if (!moveSelection.segIds[s.id]) continue;
      ptIds[s.a] = true;
      ptIds[s.b] = true;
    }
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      if (!moveSelection.circleIds[c.id]) continue;
      ptIds[c.center] = true;
    }
    moveSelection.ptIds = ptIds;
  }
  function setMoveSelectionSingleSeg(segId) {
    moveSelection = { segIds: {}, circleIds: {}, ptIds: {} };
    if (segId) moveSelection.segIds[segId] = true;
    recalcMoveSelectionPtIds();
  }
  function setMoveSelectionSingleCircle(circleId) {
    moveSelection = { segIds: {}, circleIds: {}, ptIds: {} };
    if (circleId) moveSelection.circleIds[circleId] = true;
    recalcMoveSelectionPtIds();
  }
  function setMoveSelectionFromTargets(segs, circles) {
    moveSelection = { segIds: {}, circleIds: {}, ptIds: {} };
    for (var i = 0; i < (segs || []).length; i++) moveSelection.segIds[segs[i].id] = true;
    for (var i = 0; i < (circles || []).length; i++) moveSelection.circleIds[circles[i].id] = true;
    recalcMoveSelectionPtIds();
  }

  function findSegById(sid) {
    return state.segments.find(function (s) { return s.id === sid; }) || null;
  }
  function findCircleById(cid) {
    return state.circles.find(function (c) { return c.id === cid; }) || null;
  }

  function commitMoveSelection(dx, dy) {
    if (!hasMoveSelection()) return;
    if (!dx && !dy) return;

    // 選択図形の参照点を収集
    var usedPtIds = {};
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      if (!moveSelection.segIds[s.id]) continue;
      usedPtIds[s.a] = true;
      usedPtIds[s.b] = true;
    }
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      if (!moveSelection.circleIds[c.id]) continue;
      usedPtIds[c.center] = true;
    }

    // 選択外の図形と共有している点を検出 → 複製して切り離す
    var sharedPtIds = {};
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      if (moveSelection.segIds[s.id]) continue;
      if (usedPtIds[s.a]) sharedPtIds[s.a] = true;
      if (usedPtIds[s.b]) sharedPtIds[s.b] = true;
    }
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      if (moveSelection.circleIds[c.id]) continue;
      if (usedPtIds[c.center]) sharedPtIds[c.center] = true;
    }

    var cloneMap = {};     // oldPid -> newPid
    var createdPts = [];   // [{id,x,y}, ...]
    for (var pidStr in sharedPtIds) {
      var pid = parseInt(pidStr, 10);
      var op = pt(pid);
      if (!op) continue;
      var np = { id: id(), x: op.x, y: op.y };
      cloneMap[pid] = np.id;
      state.points.push(np);
      createdPts.push(clone(np));
    }

    var segUpdates = [];     // {sid, oa, ob, na, nb}
    var circleUpdates = [];  // {cid, ocenter, ncenter}

    // 選択セグメントの参照点を差し替え
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      if (!moveSelection.segIds[s.id]) continue;
      var oa = s.a, ob = s.b;
      var na = cloneMap[oa] || oa;
      var nb = cloneMap[ob] || ob;
      if (na !== oa || nb !== ob) {
        segUpdates.push({ sid: s.id, oa: oa, ob: ob, na: na, nb: nb });
        s.a = na; s.b = nb;
      }
    }

    // 選択円の参照点を差し替え
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      if (!moveSelection.circleIds[c.id]) continue;
      var oc = c.center;
      var nc = cloneMap[oc] || oc;
      if (nc !== oc) {
        circleUpdates.push({ cid: c.id, ocenter: oc, ncenter: nc });
        c.center = nc;
      }
    }

    // 移動する点（差し替え後の参照点）を収集
    var movePtIds = {};
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      if (!moveSelection.segIds[s.id]) continue;
      movePtIds[s.a] = true;
      movePtIds[s.b] = true;
    }
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      if (!moveSelection.circleIds[c.id]) continue;
      movePtIds[c.center] = true;
    }

    var moves = []; // {pid, ox, oy, nx, ny}
    for (var pidStr in movePtIds) {
      var pid = parseInt(pidStr, 10);
      var p = pt(pid);
      if (!p) continue;
      var ox = p.x, oy = p.y;
      var nx = Math.round((ox + dx) / GRID) * GRID;
      var ny = Math.round((oy + dy) / GRID) * GRID;
      if (nx === ox && ny === oy) continue;
      p.x = nx; p.y = ny;
      moves.push({ pid: pid, ox: ox, oy: oy, nx: nx, ny: ny });
    }

    if (!moves.length && !segUpdates.length && !circleUpdates.length && !createdPts.length) return;

    pushUndo({
      type: 'moveBatch',
      moves: moves,
      createdPts: createdPts,
      segUpdates: segUpdates,
      circleUpdates: circleUpdates
    });

    recalcMoveSelectionPtIds();
  }

  function angleFromCenter(center, x, y) {
    var dx = x - center.x;
    var dy = y - center.y;
    var ang = Math.atan2(-dy, dx) * 180 / Math.PI; // 0=右, 90=上
    if (ang < 0) ang += 360;
    return ang;
  }

  function addCircleAt(centerPointOrNull, sx, sy) {
    var centerPt = centerPointOrNull;
    if (!centerPt) {
      var sn = snap(sx, sy);
      var np = nearPt(sn.x, sn.y);
      centerPt = np || { id: id(), x: sn.x, y: sn.y };
    }

    showRadiusModal(GRID * 5, function (rawR) {
      if (rawR == null) return;
      var r = Math.round(rawR / GRID) * GRID;
      if (!(r > 0)) return;

      showCircleTypeModal(function (kind) {
        if (kind == null) return;
        kind = String(kind).trim();

        var createdCenter = false;
        if (!state.points.some(function(p){ return p.id === centerPt.id; })) {
          state.points.push(centerPt);
          createdCenter = true;
        }

        if (kind === '1' || kind === '') {
          var c = { id: id(), center: centerPt.id, r: r, fullCircle: true, startAngle: 0, endAngle: 0 };
          state.circles.push(c);
          pushUndo({
            type: 'addCircle',
            circle: clone(c),
            centerPt: createdCenter ? clone(centerPt) : null,
            prevActive: state.activeId
          });
          state.activeId = null;
          render();
          return;
        }

        // 円弧はクリックで開始/終了を指定（プロンプト最小化）
        circleDraft = {
          stage: 'pickStart',
          centerPt: centerPt,
          createdCenter: createdCenter,
          r: r,
          kind: kind,
          startAngle: null
        };
        state.activeId = null;
        render();
      });
    });
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
    renderCircles();
    renderSegs();
    renderDims();
    renderPts();
    prevLayer.innerHTML = '';
    updateModeIndicator();
  }

  /* --- 円/円弧 --- */
  function renderCircles() {
    if (!circleLayer) return;
    circleLayer.innerHTML = '';
    var sw = strokeW();
    var fs = fontSize();
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      var cp = pt(c.center);
      if (!cp || !(c.r > 0)) continue;
      var isSel = (state.mode === 'move' && moveSelection.circleIds[c.id]);
      if (c.fullCircle) {
        circleLayer.appendChild(makeSVG('circle', {
          cx: cp.x, cy: cp.y, r: c.r,
          fill: 'none',
          stroke: isSel ? '#1e88e5' : '#444',
          opacity: isSel ? 0.95 : 1,
          'stroke-width': isSel ? (sw * 2.1) : sw
        }));
      } else {
        var a0 = normAngleDeg(c.startAngle);
        var a1 = normAngleDeg(c.endAngle);
        var d  = ccwDeltaDeg(a0, a1);
        if (d === 0) continue;
        var largeArc = d > 180 ? 1 : 0;
        // 角度は数学標準（0°=右,反時計回り）なので、SVG座標への変換で y を反転
        var p0x = cp.x + c.r * Math.cos(a0 * Math.PI / 180);
        var p0y = cp.y - c.r * Math.sin(a0 * Math.PI / 180);
        var p1x = cp.x + c.r * Math.cos(a1 * Math.PI / 180);
        var p1y = cp.y - c.r * Math.sin(a1 * Math.PI / 180);
        // SVGのsweep-flag: 0で反時計回り（y下向き座標系のため）
        var sweep = 0;
        var dStr = 'M ' + p0x + ' ' + p0y + ' A ' + c.r + ' ' + c.r + ' 0 ' + largeArc + ' ' + sweep + ' ' + p1x + ' ' + p1y;
        circleLayer.appendChild(makeSVG('path', {
          d: dStr,
          fill: 'none',
          stroke: isSel ? '#1e88e5' : '#444',
          opacity: isSel ? 0.95 : 1,
          'stroke-width': isSel ? (sw * 2.1) : sw,
          'stroke-linecap': 'round'
        }));
      }

      // 半径ラベル
      var label = 'R' + fmtMm(Math.round(c.r));
      circleLayer.appendChild(makeSVG('text', {
        x: cp.x + c.r + fs * 0.4,
        y: cp.y - fs * 0.2,
        'font-size': fs,
        'font-family': 'sans-serif',
        fill: isSel ? '#1565c0' : '#333'
      }, label));
    }
  }

  /* --- 線分 --- */
  function renderSegs() {
    segLayer.innerHTML = '';
    var sw = strokeW();
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      var a = pt(s.a), b = pt(s.b);
      if (!a || !b) continue;
      var isSel = (state.mode === 'move' && moveSelection.segIds[s.id]);
      var l = makeSVG('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: isSel ? '#1e88e5' : '#444',
        opacity: isSel ? 0.95 : 1,
        'stroke-width': isSel ? (sw * 2.4) : sw,
        'stroke-linecap': 'round'
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

    /* ── 円弧作成中プレビュー ── */
    if (state.mode === 'draw' && state.drawTool === 'circle' && circleDraft && circleDraft.centerPt && circleDraft.r > 0) {
      var cpt = circleDraft.centerPt;
      var r = circleDraft.r;

      // 中心点
      prevLayer.appendChild(makeSVG('circle', {
        cx: cpt.x, cy: cpt.y, r: px2svg(4),
        fill: '#1e88e5', opacity: 0.55
      }));

      // 仮円（破線）
      var dash = px2svg(6) + ' ' + px2svg(5);
      prevLayer.appendChild(makeSVG('circle', {
        cx: cpt.x, cy: cpt.y, r: r,
        fill: 'none',
        stroke: '#1e88e5', opacity: 0.6,
        'stroke-width': px2svg(2),
        'stroke-dasharray': dash
      }));

      // 現在角度（円周上に投影）
      var curAng = angleFromCenter(cpt, cursor.x, cursor.y);
      var endX = cpt.x + r * Math.cos(curAng * Math.PI / 180);
      var endY = cpt.y - r * Math.sin(curAng * Math.PI / 180);

      // 現在点マーカー
      prevLayer.appendChild(makeSVG('circle', {
        cx: endX, cy: endY, r: px2svg(6),
        fill: 'none',
        stroke: '#1e88e5', opacity: 0.8,
        'stroke-width': px2svg(2)
      }));

      // 開始点・仮円弧（終了点待ち）
      if (circleDraft.stage === 'pickEnd' && circleDraft.startAngle != null) {
        var stAng = normAngleDeg(circleDraft.startAngle);
        var stX = cpt.x + r * Math.cos(stAng * Math.PI / 180);
        var stY = cpt.y - r * Math.sin(stAng * Math.PI / 180);

        // 開始点マーカー
        prevLayer.appendChild(makeSVG('circle', {
          cx: stX, cy: stY, r: px2svg(5),
          fill: '#4caf50', opacity: 0.7, stroke: 'none'
        }));

        // 円弧プレビュー（破線）
        var d = ccwDeltaDeg(stAng, curAng);
        if (d > 0) {
          var largeArc = d > 180 ? 1 : 0;
          var sweep = 0; // 反時計回り（y下向き座標系のため0）
          var dStr = 'M ' + stX + ' ' + stY + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' ' + sweep + ' ' + endX + ' ' + endY;
          prevLayer.appendChild(makeSVG('path', {
            d: dStr,
            fill: 'none',
            stroke: '#1e88e5', opacity: 0.85,
            'stroke-width': px2svg(2.2),
            'stroke-dasharray': dash,
            'stroke-linecap': 'round'
          }));
        }
      }
      return;
    }

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
        var mx = (from.x + lx) / 2;
        var my = (from.y + ly) / 2;
        prevLayer.appendChild(makeSVG('text', {
          x: mx, y: my - fs * 1.2,
          'text-anchor': 'middle', 'font-size': fs,
          'font-family': 'sans-serif', fill: '#1e88e5'
        }, fmtMm(len)));

        // 角度表示（0°=右、反時計回り、Y軸反転を考慮）
        var ang = Math.atan2(-(ly - from.y), (lx - from.x)) * 180 / Math.PI;
        if (ang < 0) ang += 360;
        prevLayer.appendChild(makeSVG('text', {
          x: mx, y: my + fs * 0.2,
          'text-anchor': 'middle', 'font-size': fs,
          'font-family': 'sans-serif', fill: '#1e88e5'
        }, Math.round(ang) + '°'));
      }
    }
  }

  /* ═══════════════════════════════════════════
   *  ポインタイベント（モード分岐）
   * ═══════════════════════════════════════════ */
  function onDown(e) {
    // 右ボタンは無視（コンテキストメニューは別で抑止）
    if (e.button === 2) return;
    e.preventDefault();

    // 2本指パン準備（2本揃ったらパン開始）
    if (e.pointerType === 'touch') {
      touchPan.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (!touchPan.active && countObjKeys(touchPan.pointers) >= 2) {
        touchPan.active = true;
        var c = touchCentroid();
        touchPan.startCx = c.x; touchPan.startCy = c.y;
        touchPan.panSX = state.panX; touchPan.panSY = state.panY;
        prevLayer.innerHTML = '';
        ptr = reset_ptr();
        hideFloats();
        return;
      }
    }

    // PC: 中ボタンドラッグは全モード共通パン
    if (e.pointerType === 'mouse' && e.button === 1) {
      ptr = {
        down: true, sx: e.clientX, sy: e.clientY,
        svgX: 0, svgY: 0, moved: false,
        target: { type: 'pan' },
        origX: 0, origY: 0,
        panSX: state.panX, panSY: state.panY,
        pointerType: e.pointerType
      };
      hideFloats();
      return;
    }

    // 左ボタン以外は何もしない（中ボタンは上で処理済み）
    if (e.button != null && e.button !== 0) return;

    var sv = screen2svg(e.clientX, e.clientY);
    if (state.mode === 'move') {
      var hs = hitSegment(sv.x, sv.y);
      var hc = hitCircleEx(sv.x, sv.y);
      var hit = null;
      if (hs && hc) hit = (hc.d <= hs.d) ? { type: 'circle', id: hc.circle.id } : { type: 'seg', id: hs.seg.id };
      else if (hc) hit = { type: 'circle', id: hc.circle.id };
      else if (hs) hit = { type: 'seg', id: hs.seg.id };
      ptr = {
        down: true, sx: e.clientX, sy: e.clientY,
        svgX: sv.x, svgY: sv.y, moved: false,
        target: hit ? { type: 'moveShape', shapeType: hit.type, id: hit.id } : { type: 'moveRect' },
        origX: 0, origY: 0,
        panSX: state.panX, panSY: state.panY,
        pointerType: e.pointerType
      };
      hideFloats();
      return;
    }
    // 円弧の開始/終了点指定中は、点ドラッグよりタップ操作を優先
    var np = (state.mode === 'draw' && !circleDraft) ? nearPt(sv.x, sv.y) : null;
    ptr = {
      down: true, sx: e.clientX, sy: e.clientY,
      svgX: sv.x, svgY: sv.y, moved: false,
      target: np ? { type: 'point', id: np.id } : { type: 'pending' },
      origX: np ? np.x : 0, origY: np ? np.y : 0,
      panSX: state.panX, panSY: state.panY,
      pointerType: e.pointerType
    };
    if (state.activeId) hideFloats();
  }

  function onMove(e) {
    // 2本指パン中は常にパン
    if (touchPan.active) {
      if (e.pointerType === 'touch') touchPan.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var c = touchCentroid();
      var dx = c.x - touchPan.startCx;
      var dy = c.y - touchPan.startCy;
      var sc = viewW() / svg.getBoundingClientRect().width;
      state.panX = touchPan.panSX - dx * sc;
      state.panY = touchPan.panSY - dy * sc;
      updateViewBox();
      e.preventDefault();
      return;
    }

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
    var wasMoved = ptr.moved;
    var thr = (ptr.pointerType === 'touch') ? 16 : TAP_THR_PX;
    if (Math.hypot(dx, dy) > thr) ptr.moved = true;
    if (!wasMoved && ptr.moved) hideFloats();
    if (!ptr.moved) return;

    // 中ボタンパン（全モード共通）
    if (ptr.target && ptr.target.type === 'pan') {
      var sc = viewW() / svg.getBoundingClientRect().width;
      state.panX = ptr.panSX - dx * sc;
      state.panY = ptr.panSY - dy * sc;
      updateViewBox();
      return;
    }

    /* ── 移動モード ── */
    if (state.mode === 'move') {
      var curSvg = screen2svg(e.clientX, e.clientY);
      if (ptr.target && ptr.target.type === 'moveRect') {
        drawMoveRect(ptr.svgX, ptr.svgY, curSvg.x, curSvg.y);
      } else if (ptr.target && ptr.target.type === 'moveShape') {
        // 選択が無い/別の図形からドラッグ開始した場合は単独選択にする
        if (ptr.target.shapeType === 'seg' && !moveSelection.segIds[ptr.target.id]) {
          setMoveSelectionSingleSeg(ptr.target.id);
          render();
        }
        if (ptr.target.shapeType === 'circle' && !moveSelection.circleIds[ptr.target.id]) {
          setMoveSelectionSingleCircle(ptr.target.id);
          render();
        }
        var sc3 = viewW() / svg.getBoundingClientRect().width;
        var dxSvg = Math.round((dx * sc3) / GRID) * GRID;
        var dySvg = Math.round((dy * sc3) / GRID) * GRID;
        ptr.moveDx = dxSvg;
        ptr.moveDy = dySvg;
        drawMovePreview(dxSvg, dySvg);
      }
      return;
    }

    /* ── 描画モード ── */
    if (state.mode === 'draw') {
      if (ptr.target.type === 'point') {
        var sv2 = screen2svg(e.clientX, e.clientY);
        var sn  = snap(sv2.x, sv2.y);
        var p   = pt(ptr.target.id);
        if (p) { p.x = sn.x; p.y = sn.y; render(); showPreview(sn.x, sn.y); }
      } else {
        if (ptr.target.type === 'pending') ptr.target = { type: 'pan' };
        var sc2 = viewW() / svg.getBoundingClientRect().width;
        state.panX = ptr.panSX - dx * sc2;
        state.panY = ptr.panSY - dy * sc2;
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
    // タッチポインタの追跡をクリーンアップ（2本指パン中のみ、ここで操作を完結させる）
    if (e.pointerType === 'touch' && touchPan.pointers[e.pointerId]) {
      delete touchPan.pointers[e.pointerId];
      if (touchPan.active && countObjKeys(touchPan.pointers) < 2) {
        touchPan.active = false;
        touchPan.pointers = {};
        prevLayer.innerHTML = '';
        showFloats();
        ptr = reset_ptr();
      }
      // 2本指パン中は通常のタップ処理を行わない
      if (touchPan.active) {
        e.preventDefault();
        return;
      }
      // 1本指タッチの pointerup はここで return しない（点打ち/削除が動くようにする）
    }

    // タッチがキャンセルされた場合も安全に終了させる
    if (e.type === 'pointercancel' && e.pointerType === 'touch') {
      if (touchPan.active) {
        touchPan.active = false;
        touchPan.pointers = {};
        prevLayer.innerHTML = '';
        showFloats();
        ptr = reset_ptr();
        e.preventDefault();
        return;
      }
    }

    if (!ptr.down) return;
    e.preventDefault();

    // 中ボタンパンの終了
    if (ptr.target && ptr.target.type === 'pan') {
      showFloats();
      prevLayer.innerHTML = '';
      ptr = reset_ptr();
      return;
    }

    /* ── 描画モード ── */
    if (state.mode === 'draw') {
      if (!ptr.moved) {
        if (state.drawTool === 'circle') {
          var sv = screen2svg(e.clientX, e.clientY);
          var p = snap(sv.x, sv.y);
          if (circleDraft) {
            var cpt = circleDraft.centerPt;
            if (!cpt) { circleDraft = null; render(); }
            var ang = angleFromCenter(cpt, p.x, p.y);
            if (circleDraft.stage === 'pickStart') {
              circleDraft.startAngle = normAngleDeg(ang);
              if (circleDraft.kind === '2') {
                // 半円: 開始点のみ
                var c = {
                  id: id(),
                  center: cpt.id,
                  r: circleDraft.r,
                  fullCircle: false,
                  startAngle: circleDraft.startAngle,
                  endAngle: normAngleDeg(circleDraft.startAngle + 180)
                };
                state.circles.push(c);
                pushUndo({
                  type: 'addCircle',
                  circle: clone(c),
                  centerPt: circleDraft.createdCenter ? clone(cpt) : null,
                  prevActive: state.activeId
                });
                circleDraft = null;
                render();
              } else if (circleDraft.kind === '3') {
                // 1/4円: 開始点のみ
                var c = {
                  id: id(),
                  center: cpt.id,
                  r: circleDraft.r,
                  fullCircle: false,
                  startAngle: circleDraft.startAngle,
                  endAngle: normAngleDeg(circleDraft.startAngle + 90)
                };
                state.circles.push(c);
                pushUndo({
                  type: 'addCircle',
                  circle: clone(c),
                  centerPt: circleDraft.createdCenter ? clone(cpt) : null,
                  prevActive: state.activeId
                });
                circleDraft = null;
                render();
              } else {
                // 任意円弧: 次のタップで終了点
                circleDraft.stage = 'pickEnd';
                render();
              }
            } else if (circleDraft.stage === 'pickEnd') {
              var endAngle = normAngleDeg(ang);
              if (ccwDeltaDeg(circleDraft.startAngle, endAngle) === 0) {
                circleDraft = null;
                render();
              } else {
                var c = {
                  id: id(),
                  center: cpt.id,
                  r: circleDraft.r,
                  fullCircle: false,
                  startAngle: circleDraft.startAngle,
                  endAngle: endAngle
                };
                state.circles.push(c);
                pushUndo({
                  type: 'addCircle',
                  circle: clone(c),
                  centerPt: circleDraft.createdCenter ? clone(cpt) : null,
                  prevActive: state.activeId
                });
                circleDraft = null;
                render();
              }
            }
          } else {
            addCircleAt(null, p.x, p.y);
          }
        } else if (ptr.target.type === 'point') {
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
    if (state.mode === 'delete' && !ptr.moved) {
      // タップで円を選択（中心点を囲わなくてOK）
      var sv = screen2svg(e.clientX, e.clientY);
      var c = hitCircle(sv.x, sv.y);
      if (c) {
        var act = { type: 'deleteBatch', pts: [], segs: [], circles: [ clone(c) ] };
        if (!confirm('円を削除しますか？')) {
          // no-op
        } else {
          var cidSet = {}; cidSet[c.id] = true;
          state.circles = state.circles.filter(function(x){ return !cidSet[x.id]; });
          pushUndo(act);
          render();
        }
      }
    }

    /* ── 移動モード ── */
    if (state.mode === 'move') {
      var sv = screen2svg(e.clientX, e.clientY);
      if (!ptr.moved) {
        var hs = hitSegment(sv.x, sv.y);
        var hc = hitCircleEx(sv.x, sv.y);
        var hit = null;
        if (hs && hc) hit = (hc.d <= hs.d) ? { type: 'circle', id: hc.circle.id } : { type: 'seg', id: hs.seg.id };
        else if (hc) hit = { type: 'circle', id: hc.circle.id };
        else if (hs) hit = { type: 'seg', id: hs.seg.id };
        if (!hit) clearMoveSelection();
        else if (hit.type === 'seg') setMoveSelectionSingleSeg(hit.id);
        else setMoveSelectionSingleCircle(hit.id);
        render();
      } else {
        if (ptr.target && ptr.target.type === 'moveRect') {
          var hits = getSelectTargets(ptr.svgX, ptr.svgY, sv.x, sv.y);
          setMoveSelectionFromTargets(hits.segs, hits.circles);
          render();
        } else if (ptr.target && ptr.target.type === 'moveShape') {
          var dxSvg = ptr.moveDx || 0;
          var dySvg = ptr.moveDy || 0;
          commitMoveSelection(dxSvg, dySvg);
          render();
        }
      }
    }

    showFloats();
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
    // 円をハイライト（線のみ）
    for (var i = 0; i < (hits.circles || []).length; i++) {
      var c = hits.circles[i];
      var cp = pt(c.center);
      if (!cp || !(c.r > 0)) continue;
      prevLayer.appendChild(makeSVG('circle', {
        cx: cp.x, cy: cp.y, r: c.r,
        fill: 'none',
        stroke: '#f44336', 'stroke-width': px2svg(2),
        'stroke-dasharray': px2svg(6) + ' ' + px2svg(4),
        'stroke-linecap': 'round',
        opacity: 0.85
      }));
    }
  }

  /* ═══════════════════════════════════════════
   *  移動モード：矩形選択プレビュー / 移動プレビュー
   * ═══════════════════════════════════════════ */
  function drawMoveRect(x1, y1, x2, y2) {
    prevLayer.innerHTML = '';
    var leftToRight = x2 > x1;
    var rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    var rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    var sw = px2svg(1.2);
    // 左→右=青実線（完全包含）、右→左=緑破線（交差）
    var col = leftToRight ? '#1565c0' : '#2e7d32';
    var dashAttr = leftToRight ? 'none' : (sw * 5) + ' ' + (sw * 3);
    var fillOp = leftToRight ? 0.06 : 0.1;
    prevLayer.appendChild(makeSVG('rect', {
      x: rx, y: ry, width: rw, height: rh,
      fill: col, 'fill-opacity': fillOp,
      stroke: col, 'stroke-width': sw,
      'stroke-dasharray': dashAttr
    }));

    var hits = getSelectTargets(x1, y1, x2, y2);
    var hsw = px2svg(4);

    // 線分ハイライト
    for (var i = 0; i < (hits.segs || []).length; i++) {
      var s = hits.segs[i];
      var a = pt(s.a), b = pt(s.b);
      if (!a || !b) continue;
      prevLayer.appendChild(makeSVG('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: col, opacity: 0.55,
        'stroke-width': hsw, 'stroke-linecap': 'round'
      }));
    }

    // 円/円弧ハイライト
    for (var i = 0; i < (hits.circles || []).length; i++) {
      var c = hits.circles[i];
      var cp = pt(c.center);
      if (!cp || !(c.r > 0)) continue;
      if (c.fullCircle) {
        prevLayer.appendChild(makeSVG('circle', {
          cx: cp.x, cy: cp.y, r: c.r,
          fill: 'none',
          stroke: col, opacity: 0.55,
          'stroke-width': hsw
        }));
      } else {
        var a0 = normAngleDeg(c.startAngle);
        var a1 = normAngleDeg(c.endAngle);
        var d  = ccwDeltaDeg(a0, a1);
        if (d === 0) continue;
        var largeArc = d > 180 ? 1 : 0;
        var p0x = cp.x + c.r * Math.cos(a0 * Math.PI / 180);
        var p0y = cp.y - c.r * Math.sin(a0 * Math.PI / 180);
        var p1x = cp.x + c.r * Math.cos(a1 * Math.PI / 180);
        var p1y = cp.y - c.r * Math.sin(a1 * Math.PI / 180);
        var sweep = 0;
        var dStr = 'M ' + p0x + ' ' + p0y + ' A ' + c.r + ' ' + c.r + ' 0 ' + largeArc + ' ' + sweep + ' ' + p1x + ' ' + p1y;
        prevLayer.appendChild(makeSVG('path', {
          d: dStr,
          fill: 'none',
          stroke: col, opacity: 0.55,
          'stroke-width': hsw, 'stroke-linecap': 'round'
        }));
      }
    }
  }

  function drawMovePreview(dx, dy) {
    prevLayer.innerHTML = '';
    if (!hasMoveSelection()) return;
    if (!dx && !dy) return;

    var sw = strokeW();
    var dash = px2svg(6) + ' ' + px2svg(4);

    // 線分
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      if (!moveSelection.segIds[s.id]) continue;
      var a = pt(s.a), b = pt(s.b);
      if (!a || !b) continue;
      prevLayer.appendChild(makeSVG('line', {
        x1: a.x + dx, y1: a.y + dy,
        x2: b.x + dx, y2: b.y + dy,
        stroke: '#1e88e5', opacity: 0.85,
        'stroke-width': sw,
        'stroke-dasharray': dash,
        'stroke-linecap': 'round'
      }));
    }

    // 円/円弧
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      if (!moveSelection.circleIds[c.id]) continue;
      var cp = pt(c.center);
      if (!cp || !(c.r > 0)) continue;
      var cx = cp.x + dx, cy = cp.y + dy;
      if (c.fullCircle) {
        prevLayer.appendChild(makeSVG('circle', {
          cx: cx, cy: cy, r: c.r,
          fill: 'none',
          stroke: '#1e88e5', opacity: 0.85,
          'stroke-width': sw,
          'stroke-dasharray': dash
        }));
      } else {
        var a0 = normAngleDeg(c.startAngle);
        var a1 = normAngleDeg(c.endAngle);
        var d  = ccwDeltaDeg(a0, a1);
        if (d === 0) continue;
        var largeArc = d > 180 ? 1 : 0;
        var p0x = cx + c.r * Math.cos(a0 * Math.PI / 180);
        var p0y = cy - c.r * Math.sin(a0 * Math.PI / 180);
        var p1x = cx + c.r * Math.cos(a1 * Math.PI / 180);
        var p1y = cy - c.r * Math.sin(a1 * Math.PI / 180);
        var sweep = 0;
        var dStr = 'M ' + p0x + ' ' + p0y + ' A ' + c.r + ' ' + c.r + ' 0 ' + largeArc + ' ' + sweep + ' ' + p1x + ' ' + p1y;
        prevLayer.appendChild(makeSVG('path', {
          d: dStr,
          fill: 'none',
          stroke: '#1e88e5', opacity: 0.85,
          'stroke-width': sw,
          'stroke-dasharray': dash,
          'stroke-linecap': 'round'
        }));
      }
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
    // 削除対象の円
    var hitCircles = [];
    if (leftToRight) {
      // 完全包含: 円の外接矩形が矩形内に完全に入る
      for (var i = 0; i < state.circles.length; i++) {
        var c = state.circles[i];
        var cp = pt(c.center);
        if (!cp || !(c.r > 0)) continue;
        if (cp.x - c.r >= rx && cp.x + c.r <= rx2 && cp.y - c.r >= ry && cp.y + c.r <= ry2) hitCircles.push(c);
      }
    } else {
      // 交差: 矩形が円と重なる（なぞるだけでOK）
      for (var i = 0; i < state.circles.length; i++) {
        var c = state.circles[i];
        if (circleIntersectsRect(c, rx, ry, rx2, ry2)) hitCircles.push(c);
      }
    }
    return { pts: hitPts, segs: hitSegs, circles: hitCircles };
  }

  function getSelectTargets(x1, y1, x2, y2) {
    var hits = getDeleteTargets(x1, y1, x2, y2);
    return { segs: hits.segs || [], circles: hits.circles || [] };
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
    if (!hits.pts.length && !hits.segs.length && !hits.circles.length) return;
    var msg = hits.pts.length + '個の点と' + hits.segs.length + '本の線と' + hits.circles.length + '個の円を削除しますか？';
    if (!confirm(msg)) return;
    // Undo 用にクローン保存
    var act = {
      type: 'deleteBatch',
      pts: hits.pts.map(function(p){ return clone(p); }),
      segs: hits.segs.map(function(s){ return clone(s); }),
      circles: hits.circles.map(function(c){ return clone(c); })
    };
    // 削除実行
    var pidSet = {}; for (var i = 0; i < hits.pts.length; i++) pidSet[hits.pts[i].id] = true;
    var sidSet = {}; for (var i = 0; i < hits.segs.length; i++) sidSet[hits.segs[i].id] = true;
    var cidSet = {}; for (var i = 0; i < hits.circles.length; i++) cidSet[hits.circles[i].id] = true;
    state.points = state.points.filter(function(p){ return !pidSet[p.id]; });
    state.segments = state.segments.filter(function(s){ return !sidSet[s.id]; });
    state.circles = state.circles.filter(function(c){ return !cidSet[c.id] && !pidSet[c.center]; });
    if (state.activeId && pidSet[state.activeId]) state.activeId = null;
    pushUndo(act);
    render();
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function circleHitsStroke(circle, x, y) {
    var cp = pt(circle.center);
    if (!cp || !(circle.r > 0)) return false;
    var d = Math.abs(Math.hypot(x - cp.x, y - cp.y) - circle.r);
    return d <= px2svg(12);
  }
  function hitCircle(x, y) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      var cp = pt(c.center);
      if (!cp || !(c.r > 0)) continue;
      var d = Math.abs(Math.hypot(x - cp.x, y - cp.y) - c.r);
      if (d < bestD) { bestD = d; best = c; }
    }
    return (best && bestD <= px2svg(14)) ? best : null;
  }
  function hitCircleEx(x, y) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < state.circles.length; i++) {
      var c = state.circles[i];
      var cp = pt(c.center);
      if (!cp || !(c.r > 0)) continue;
      var d = Math.abs(Math.hypot(x - cp.x, y - cp.y) - c.r);
      if (d < bestD) { bestD = d; best = c; }
    }
    return (best && bestD <= px2svg(14)) ? { circle: best, d: bestD } : null;
  }

  function distPointToSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var wx = px - ax, wy = py - ay;
    var c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(px - ax, py - ay);
    var c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(px - bx, py - by);
    var t = c1 / c2;
    var projX = ax + t * vx;
    var projY = ay + t * vy;
    return Math.hypot(px - projX, py - projY);
  }

  function hitSegment(x, y) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < state.segments.length; i++) {
      var s = state.segments[i];
      var a = pt(s.a), b = pt(s.b);
      if (!a || !b) continue;
      var d = distPointToSegment(x, y, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return (best && bestD <= px2svg(14)) ? { seg: best, d: bestD } : null;
  }
  function circleIntersectsRect(circle, rx, ry, rx2, ry2) {
    var cp = pt(circle.center);
    if (!cp || !(circle.r > 0)) return false;
    var cx = cp.x, cy = cp.y, r = circle.r;
    var nx = clamp(cx, rx, rx2);
    var ny = clamp(cy, ry, ry2);
    var dist = Math.hypot(cx - nx, cy - ny);
    return dist <= r;
  }

  /* ═══════════════════════════════════════════
   *  LocalStorage
   * ═══════════════════════════════════════════ */
  var SKEY = 'simpleDraft_v1';
  function save() {
    try {
      localStorage.setItem(SKEY, JSON.stringify({
        points: state.points, segments: state.segments,
        circles: state.circles,
        nextId: state.nextId, activeId: state.activeId,
        panX: state.panX, panY: state.panY,
        scaleIdx: state.scaleIdx,
        projectName: state.projectName,
        orthoMode: state.orthoMode,
        drawTool: state.drawTool
      }));
    } catch(e){}
  }
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(SKEY));
      if (!d) return;
      state.points   = d.points   || [];
      state.segments = d.segments || [];
      state.circles  = d.circles  || [];
      state.nextId   = d.nextId   || 1;
      state.activeId = d.activeId || null;
      state.panX     = d.panX     != null ? d.panX : 4000;
      state.panY     = d.panY     != null ? d.panY : 3000;
      state.scaleIdx = d.scaleIdx != null ? d.scaleIdx : DEF_SCALE;
      state.projectName = d.projectName || '';
      state.orthoMode = d.orthoMode != null ? d.orthoMode : true;
      state.drawTool = d.drawTool || 'line';
    } catch(e){}
  }

  /* ═══════════════════════════════════════════
   *  ツールバーハンドラ
   * ═══════════════════════════════════════════ */
  function onNew() {
    if (state.points.length && !confirm('図面をクリアしますか？')) return;
    state.points = []; state.segments = [];
    state.circles = [];
    state.nextId = 1; state.activeId = null;
    circleDraft = null;
    clearMoveSelection();
    state.undoStack = []; state.redoStack = [];
    state.projectName = '';
    document.getElementById('projectName').value = '';
    updUndoBtn(); save(); render();
  }
  function onFinish() {
    state.activeId = null;
    circleDraft = null;
    render();
  }
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

    // 円: 半径入力モーダル / 種類選択モーダル
    function parseRadiusInputVal() {
      if (!radiusInput) return null;
      var v = parseFloat(String(radiusInput.value).replace(/,/g, ''));
      if (!isFinite(v)) return null;
      return v;
    }
    if (radiusModal) {
      if (radiusOkBtn) radiusOkBtn.addEventListener('click', function () {
        var v = parseRadiusInputVal();
        if (!(v > 0)) return;
        closeRadiusModal(v);
      });
      if (radiusCancelBtn) radiusCancelBtn.addEventListener('click', function () { closeRadiusModal(null); });
      if (radiusCloseBtn) radiusCloseBtn.addEventListener('click', function () { closeRadiusModal(null); });
      if (radiusInput) radiusInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var v = parseRadiusInputVal();
          if (!(v > 0)) return;
          closeRadiusModal(v);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeRadiusModal(null);
        }
      });
      radiusModal.addEventListener('click', function (e) {
        if (e.target === radiusModal) closeRadiusModal(null);
      });
    }

    if (circleTypeModal) {
      circleTypeModal.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-kind]') : null;
        if (btn) { closeCircleTypeModal(btn.getAttribute('data-kind')); return; }
        if (e.target === circleTypeModal) closeCircleTypeModal(null);
      });
      if (circleTypeCancelBtn) circleTypeCancelBtn.addEventListener('click', function () { closeCircleTypeModal(null); });
      if (circleTypeCloseBtn) circleTypeCloseBtn.addEventListener('click', function () { closeCircleTypeModal(null); });
    }

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
      'delete': document.getElementById('btnModeDelete'),
      move:   document.getElementById('btnModeMove')
    };
    function setMode(m) {
      state.mode = m;
      for (var k in modeBtns) {
        modeBtns[k].classList.toggle('mode-active', k === m);
      }
      // 描画サブツールは描画モード時のみ表示
      var drawTools = document.getElementById('drawTools');
      if (drawTools) drawTools.classList.toggle('is-hidden', m !== 'draw');
      if (m !== 'draw') circleDraft = null;
      if (m !== 'move') clearMoveSelection();
      // カーソル連動
      svg.className.baseVal = m !== 'draw' ? 'mode-' + m : '';
      updateModeIndicator();
      // 描画モード以外ではアクティブ点を解除
      if (m !== 'draw' && state.activeId) state.activeId = null;
      render();
    }
    for (var k in modeBtns) {
      (function(mode) {
        modeBtns[mode].addEventListener('click', function(){ setMode(mode); });
      })(k);
    }
    setMode(state.mode);

    // 描画サブツール切替（直線/円）
    var toolBtns = {
      line: document.getElementById('btnToolLine'),
      circle: document.getElementById('btnToolCircle')
    };
    function setDrawTool(t) {
      state.drawTool = t;
      for (var k in toolBtns) {
        if (!toolBtns[k]) continue;
        toolBtns[k].classList.toggle('tool-active', k === t);
      }
      // 円ツールに切り替えたら、直線のアクティブ点は解除
      if (t !== 'line' && state.activeId) { state.activeId = null; render(); }
      if (t !== 'circle') circleDraft = null;
      save();
    }
    if (toolBtns.line) toolBtns.line.addEventListener('click', function(){ setDrawTool('line'); });
    if (toolBtns.circle) toolBtns.circle.addEventListener('click', function(){ setDrawTool('circle'); });
    setDrawTool(state.drawTool || 'line');

    // ポインタイベント
    svg.addEventListener('pointerdown',   onDown);
    svg.addEventListener('pointermove',   onMove);
    svg.addEventListener('pointerup',     onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('contextmenu', function(e){ e.preventDefault(); });
    // touch-action は CSS で制御する（iPadOS の Pointer Events と競合させない）

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

    // 右上メニュー（ホバー + タップ）
    var menuWrap = document.getElementById('menuWrap');
    var btnMenu  = document.getElementById('btnMenu');
    function closeMenu() {
      if (menuWrap) menuWrap.classList.remove('is-open');
    }
    if (menuWrap && btnMenu) {
      btnMenu.addEventListener('click', function(e) {
        e.stopPropagation();
        menuWrap.classList.toggle('is-open');
      });
      menuWrap.addEventListener('click', function(e) {
        var t = e.target;
        if (!t) return;
        if (t.id === 'btnNew' || t.id === 'btnHistory' || t.id === 'btnPdf') {
          closeMenu();
        }
      });
      document.addEventListener('click', function(e) {
        if (!menuWrap.contains(e.target)) closeMenu();
      });
    }

    // キーボード
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape' && radiusModal && radiusModal.classList.contains('is-open')) {
        e.preventDefault();
        closeRadiusModal(null);
        return;
      }
      if (e.key === 'Escape' && circleTypeModal && circleTypeModal.classList.contains('is-open')) {
        e.preventDefault();
        closeCircleTypeModal(null);
        return;
      }
      if (e.key === 'Escape' && menuWrap && menuWrap.classList.contains('is-open')) {
        e.preventDefault();
        closeMenu();
        return;
      }
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
      circles: JSON.parse(JSON.stringify(state.circles)),
      projectName: state.projectName,
      fmtMm: fmtMm
    };
  };

  init();
})();
