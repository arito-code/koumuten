/* CDN フォールバック: メイン CDN が読み込めなかった場合に unpkg から取得 */
(function () {
  if (typeof window.jspdf !== 'undefined') return;
  var s = document.createElement('script');
  s.src = 'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js';
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
})();
