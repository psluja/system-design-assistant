/* Progressive enhancements only — the docs are fully readable without JS. */
(function () {
  'use strict';

  // Copy buttons on code blocks.
  try {
    document.querySelectorAll('pre').forEach(function (pre) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'copy';
      btn.style.cssText =
        'position:absolute;top:8px;right:8px;font:600 11px var(--sans);color:var(--ink-faint);' +
        'background:var(--bg-tint);border:1px solid var(--line);border-radius:7px;padding:3px 8px;cursor:pointer';
      var holder = document.createElement('div');
      holder.style.position = 'relative';
      pre.parentNode.insertBefore(holder, pre);
      holder.appendChild(pre);
      holder.appendChild(btn);
      btn.addEventListener('click', function () {
        var text = pre.innerText;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            btn.textContent = 'copied';
            setTimeout(function () { btn.textContent = 'copy'; }, 1200);
          });
        }
      });
    });
  } catch (e) { /* no-op */ }

  // Highlight the current section in the top nav.
  try {
    var links = {};
    document.querySelectorAll('.topbar nav a[href^="#"]').forEach(function (a) {
      links[a.getAttribute('href').slice(1)] = a;
    });
    var ids = Object.keys(links);
    if (ids.length && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            var a = links[en.target.id];
            if (a && en.isIntersecting) {
              Object.keys(links).forEach(function (k) { links[k].style.color = ''; links[k].style.background = ''; });
              a.style.color = 'var(--accent-deep)';
              a.style.background = 'var(--accent-tint)';
            }
          });
        },
        { rootMargin: '-40% 0px -55% 0px' }
      );
      ids.forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
    }
  } catch (e) { /* no-op */ }
})();
