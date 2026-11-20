// tabs.js — phone layout. The view is docked at the top (left in landscape)
// and the panel underneath becomes tabs: "Start" (preset, retrace, exports)
// followed by one tab per section. Desktop keeps the side panel unchanged.
//
// body.tabbed turns the layout on; the open tab's element carries .tabon.

const KEY = 'ff3d.tab';
const QUERY = '(max-width: 720px), (max-height: 500px) and (orientation: landscape)';

export function initPanelTabs({ sidebar, toolbar, panel, onLayout }) {
  const mq = window.matchMedia(QUERY);
  const bar = document.createElement('nav');
  bar.id = 'tabbar';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Panel sections');
  sidebar.insertBefore(bar, toolbar);

  let tabs = [];
  let cur = 0;
  try { const v = +localStorage.getItem(KEY); if (v >= 0) cur = v; } catch { /* storage unavailable */ }

  function select(i, scroll = true) {
    if (!tabs.length) return;
    cur = Math.min(Math.max(0, i), tabs.length - 1);
    tabs.forEach((t, j) => {
      const on = j === cur;
      t.btn.classList.toggle('sel', on);
      t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      t.el.classList.toggle('tabon', on);
      if (on && t.el.tagName === 'DETAILS') t.el.open = true;   // a folded section would be an empty tab
    });
    panel.scrollTop = 0;
    toolbar.scrollTop = 0;
    if (scroll) tabs[cur].btn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    sidebar.dataset.tab = tabs[cur].el === toolbar ? 'start' : 'section';
    try { localStorage.setItem(KEY, String(cur)); } catch { /* storage unavailable */ }
  }

  // The panel rebuilds its sections (e.g. after a preset), so rebuild the tabs too.
  function rebuild() {
    bar.innerHTML = '';
    const items = [{ el: toolbar, name: 'Start' },
      ...[...panel.querySelectorAll(':scope > details.section')].map(d => ({ el: d, name: d.querySelector('summary').textContent.trim() }))];
    tabs = items.map((it, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.textContent = it.name;
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', () => select(i));
      bar.appendChild(btn);
      return { ...it, btn };
    });
    select(cur, false);
  }
  new MutationObserver(rebuild).observe(panel, { childList: true });

  const apply = () => {
    document.body.classList.toggle('tabbed', mq.matches);
    if (mq.matches) document.body.classList.remove('panel-hidden');
    select(cur, false);
    if (onLayout) onLayout();
  };
  if (mq.addEventListener) mq.addEventListener('change', apply); else mq.addListener(apply);
  rebuild();
  apply();
  return { select };
}
