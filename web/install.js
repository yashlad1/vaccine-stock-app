// Reads install-config.js, which scripts/deploy-web.sh generates at deploy time
// (it holds the build link, so it is never committed). If it is missing or the
// link is past its expiry, the page says so rather than offering a dead download.
(function () {
  var c = window.INSTALL_CONFIG;
  var live = c && c.url && Date.parse(c.expires) > Date.now();
  var show = function (id) { document.getElementById(id).hidden = false; };
  if (!live) { show('expired'); return; }
  var a = document.getElementById('download');
  a.href = c.url;
  show('download');
  var d = new Date(c.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  var v = document.getElementById('version');
  v.textContent = 'Version ' + c.version + ', ' + d;
  v.hidden = false;
})();
