/* ==========================================================================
   family-buddy 项目文档 · 交互脚本
   无依赖，纯原生。所有元素都做存在性判断，同一份脚本用于封面页与文档页。
   ========================================================================== */
(function () {
  'use strict';

  var body = document.body;
  var MOBILE = 900;
  var LS_KEY = 'fb-docs-nav-collapsed';

  function isMobile() { return window.innerWidth <= MOBILE; }
  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------------
     1. 侧栏折叠 / 展开
     ------------------------------------------------------------------ */
  var navToggle = $('navToggle');
  var scrim = $('scrim');

  function setCollapsed(collapsed, persist) {
    body.classList.toggle('nav-collapsed', collapsed);
    if (navToggle) {
      navToggle.setAttribute('aria-expanded', String(!collapsed));
      navToggle.title = collapsed ? '展开目录' : '折叠目录';
    }
    if (persist && !isMobile()) {
      try { localStorage.setItem(LS_KEY, collapsed ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
  }

  // 初始状态：手机端默认收起，桌面端恢复上次选择
  var stored = null;
  try { stored = localStorage.getItem(LS_KEY); } catch (e) { /* 忽略 */ }
  setCollapsed(isMobile() ? true : stored === '1', false);

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      setCollapsed(!body.classList.contains('nav-collapsed'), true);
    });
  }
  if (scrim) {
    scrim.addEventListener('click', function () { setCollapsed(true, false); });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isMobile()) setCollapsed(true, false);
  });
  // 视口从窄变宽时自动展开，避免出现"桌面端侧栏被手机残留状态收起"
  var lastMobile = isMobile();
  window.addEventListener('resize', function () {
    var m = isMobile();
    if (m !== lastMobile) {
      lastMobile = m;
      if (!m) setCollapsed(stored === '1', false);
    }
  });

  /* ------------------------------------------------------------------
     2. 打印 / 返回首页 / 回到顶部
     ------------------------------------------------------------------ */
  var printBtn = $('printBtn');
  if (printBtn) {
    printBtn.addEventListener('click', function () {
      if (isMobile()) setCollapsed(true, false);
      window.print();
    });
  }

  var homeBtn = $('homeBtn');
  if (homeBtn) {
    homeBtn.addEventListener('click', function () { window.location.href = 'index.html'; });
  }

  var toTop = $('toTop');
  if (toTop) {
    toTop.addEventListener('click', function () { scrollToY(0); });
  }

  function scrollToY(y) {
    if ('scrollBehavior' in document.documentElement.style) {
      window.scrollTo({ top: y, behavior: 'smooth' });
    } else {
      window.scrollTo(0, y);
    }
  }

  /* ------------------------------------------------------------------
     3. 进度条 + 目录高亮
     ------------------------------------------------------------------ */
  var progress = $('progress');
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc-page a'));
  var targets = [];

  function buildTargets() {
    targets = tocLinks.map(function (a) {
      var href = a.getAttribute('href') || '';
      var el = href.length > 1 ? document.querySelector(href) : null;
      return el ? { a: a, el: el } : null;
    }).filter(Boolean);
  }

  function scrollSpy() {
    if (!targets.length) return;
    var pos = window.scrollY + 132;
    var current = null;
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].el.offsetTop <= pos) current = targets[i];
    }
    tocLinks.forEach(function (a) { a.classList.remove('active'); });
    if (current) current.a.classList.add('active');
  }

  function onScroll() {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    var pct = h > 0 ? (window.scrollY / h) * 100 : 0;
    if (progress) progress.style.width = pct + '%';
    if (toTop) toTop.classList.toggle('show', window.scrollY > 620);
    scrollSpy();
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  /* ------------------------------------------------------------------
     4. 本页查找（高亮，不修改文档结构以外的任何东西）
     ------------------------------------------------------------------ */
  var q = $('q');
  var qcount = $('qcount');
  var root = document.querySelector('.doc-body') || document.querySelector('.page');
  var pristine = null;
  var timer = null;

  if (q && root) {
    pristine = root.innerHTML;
    q.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 200);
    });
  }

  function clearMarks() {
    if (!pristine) return false;
    if (root.innerHTML === pristine) return false;
    root.innerHTML = pristine;
    return true;
  }

  function runSearch() {
    if (!q || !root) return;
    var term = q.value.trim();

    if (!term) {
      clearMarks();
      if (qcount) qcount.style.display = 'none';
      return;
    }

    clearMarks();

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var tag = node.parentNode.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);

    var lower = term.toLowerCase(), count = 0, first = null;

    nodes.forEach(function (node) {
      var value = node.nodeValue;
      var lv = value.toLowerCase();
      var idx = lv.indexOf(lower);
      if (idx === -1) return;

      var frag = document.createDocumentFragment();
      var last = 0;
      while (idx !== -1) {
        if (idx > last) frag.appendChild(document.createTextNode(value.slice(last, idx)));
        var mark = document.createElement('mark');
        mark.textContent = value.slice(idx, idx + term.length);
        frag.appendChild(mark);
        if (!first) first = mark;
        count++;
        last = idx + term.length;
        idx = lv.indexOf(lower, last);
      }
      if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });

    if (qcount) {
      qcount.style.display = count ? 'inline-block' : 'none';
      qcount.textContent = count ? ('命中 ' + count + ' 处') : '无匹配';
    }
    if (first) {
      var top = first.getBoundingClientRect().top + window.scrollY - 140;
      scrollToY(Math.max(0, top));
    }
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && q) {
      e.preventDefault();
      q.focus();
      q.select();
      return;
    }
    if (e.key === 'Escape' && q && document.activeElement === q) {
      q.value = '';
      runSearch();
      q.blur();
    }
  });

  /* ------------------------------------------------------------------
     5. 表格横滚提示（每页至多一条，不需要时移除）
     ------------------------------------------------------------------ */
  var hintTimer = null;

  function syncTableHints() {
    var hints = document.querySelectorAll('.tw-hint');
    for (var i = 0; i < hints.length; i++) hints[i].parentNode.removeChild(hints[i]);

    var tables = document.querySelectorAll('.tw');
    for (var j = 0; j < tables.length; j++) {
      var el = tables[j];
      if (el.scrollWidth > el.clientWidth + 1) {
        var hint = document.createElement('div');
        hint.className = 'tw-hint';
        hint.textContent = '表格可左右滑动';
        el.parentNode.insertBefore(hint, el.nextSibling);
        return; // 每页只提示一次
      }
    }
  }

  window.addEventListener('resize', function () {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(syncTableHints, 200);
  });

  /* ------------------------------------------------------------------
     6. 初始化
     ------------------------------------------------------------------ */
  buildTargets();
  syncTableHints();
  onScroll();
})();
