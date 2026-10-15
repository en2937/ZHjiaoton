// One-shot visual handoff. Contains only the existing static map and its bounds.
const LOGIN_PORTAL_KEY = 'campus-login-portal-v1';
const LOGIN_PORTAL_MAP = '/assets/Map.png';
function portalImageRect(rect, ratio = 3875 / 3379) {
  const width = Math.max(rect.width, rect.height * ratio), height = width / ratio;
  return {x: rect.left + (rect.width - width) / 2, y: rect.top + (rect.height - height) / 2, width, height};
}
function consumeLoginPortal(storage, now, viewport) {
  try {
    const raw = storage.getItem(LOGIN_PORTAL_KEY); storage.removeItem(LOGIN_PORTAL_KEY);
    if (!raw || raw.length > 4096) return null;
    const data = JSON.parse(raw), rect = data.rect;
    if (data.version !== 2 || !Number.isFinite(data.expires) || data.expires < now || data.expires > now + 15000 ||
        data.image !== LOGIN_PORTAL_MAP ||
        !rect || !['x','y','width','height'].every(key => Number.isFinite(rect[key])) ||
        rect.width <= 0 || rect.height <= 0 || rect.width > 20000 || rect.height > 20000 || Math.abs(rect.x) > 20000 || Math.abs(rect.y) > 20000 ||
        Math.abs(data.viewport.width - viewport.width) > 2 || Math.abs(data.viewport.height - viewport.height) > 2) return null;
    return data;
  } catch { return null; }
}
// Only requested after successful authentication. Never enlarge the login thumbnail.
function loadPortalMap(view, image = new view.Image()) {
  return new Promise(resolve => {
    let done = false, decoding = false;
    const finish = value => {
      if (done) return; done = true; view.clearTimeout(timer);
      image.onload = image.onerror = null; resolve(value);
    };
    const decode = () => {
      if (done || decoding) return;
      if (!image.naturalWidth || !image.naturalHeight) { finish(null); return; }
      decoding = true;
      try { Promise.resolve(image.decode?.()).then(() => finish(image), () => finish(null)); }
      catch { finish(null); }
    };
    const timer = view.setTimeout(() => finish(null), 1800);
    image.onload = decode; image.onerror = () => finish(null);
    image.decoding = 'async'; image.src = LOGIN_PORTAL_MAP;
    if (image.complete) decode();
  });
}
function createLoginDeparture({gsap, root, view, stopPan}) {
  let leaving = null;
  return () => {
    if (leaving) return leaving;
    const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
    try { view.sessionStorage.removeItem(LOGIN_PORTAL_KEY); } catch {}
    if (!gsap || reduced.matches || root.hidden) return Promise.resolve();
    const plane = root.querySelector('.backdrop-map'), shell = root.querySelector('.login-shell');
    if (!plane || !shell) return Promise.resolve();
    // Check storage before hiding the form; a blocked store gets an ordinary login.
    try { view.sessionStorage.setItem(LOGIN_PORTAL_KEY, ''); view.sessionStorage.removeItem(LOGIN_PORTAL_KEY); }
    catch { return Promise.resolve(); }
    for (const href of ['/app.mjs','/engine.mjs','/route.mjs','/shared-client.mjs']) {
      const link = root.createElement('link'); link.rel = 'modulepreload'; link.href = href; root.head.append(link);
    }
    leaving = (async () => {
      const map = await loadPortalMap(view);
      if (!map || reduced.matches || root.hidden) return;
      map.alt = ''; map.className = 'login-portal-source'; map.draggable = false;
      map.style.cssText = 'display:block;width:100%;height:100%;max-width:none;object-fit:cover';
      plane.append(map);
      stopPan(); shell.inert = true;
      const backdrop = root.querySelector('.login-backdrop');
      const foreground = [shell, root.querySelector('footer')].filter(Boolean);
      await new Promise(resolve => {
        let done = false, timer, timeline;
        const finish = () => {
          if (done) return; done = true; view.clearTimeout(timer);
          root.removeEventListener('visibilitychange', changed); reduced.removeEventListener('change', changed);
          timeline?.progress(1).kill();
          try {
            if (!reduced.matches && !root.hidden) view.sessionStorage.setItem(LOGIN_PORTAL_KEY, JSON.stringify({
              version: 2, expires: Date.now() + 12000, image: LOGIN_PORTAL_MAP,
              rect: portalImageRect(plane.getBoundingClientRect(), map.naturalWidth / map.naturalHeight),
              viewport: {width: view.innerWidth, height: view.innerHeight},
            }));
          } catch { /* Navigation remains independent of storage. */ }
          resolve();
        };
        const changed = () => { if (root.hidden || reduced.matches) finish(); };
        root.addEventListener('visibilitychange', changed); reduced.addEventListener('change', changed);
        timeline = gsap.timeline({onComplete: finish});
        timeline.to(foreground, {opacity: 0, duration: .34, ease: 'power1.out'}, 0)
          .to(backdrop, {'--veil-opacity': 0, duration: .65, ease: 'power1.inOut'}, .08)
          .to(plane, {filter: 'blur(0px) saturate(1) contrast(1.03)', opacity: 1, duration: .85, ease: 'power1.inOut'}, .08)
          .to(plane, {scale: 1.65, xPercent: 0, yPercent: 0, duration: 1.18, ease: 'power2.inOut', force3D: false}, 0)
          .set(plane, {filter: 'none', willChange: 'transform'}, .93);
        timer = view.setTimeout(finish, 1700);
      });
    })();
    return leaving;
  };
}
function createAdminArrival({gsap, root = document, view = window} = {}) {
  if (!root.querySelector?.('#adminLogout')) return null;
  let data;
  try { data = consumeLoginPortal(view.sessionStorage, Date.now(), {width: view.innerWidth, height: view.innerHeight}); }
  catch { return null; }
  if (!data || !gsap) return null;
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches || root.hidden) return null;
  const overlay = root.createElement('div'), image = root.createElement('img'), shell = root.querySelector('.shell');
  overlay.className = 'login-arrival'; overlay.setAttribute('aria-hidden', 'true');
  image.className = 'login-arrival-map'; image.alt = ''; image.draggable = false;
  image.style.maxWidth = 'none';
  image.style.width = data.rect.width + 'px'; image.style.height = data.rect.height + 'px';
  overlay.append(image); root.body.append(overlay);
  const previousInert = shell?.inert || false; if (shell) shell.inert = true;
  gsap.set(image, {x: data.rect.x, y: data.rect.y, transformOrigin: '0 0'});
  let started = false, done = false, decoded = false, target = null, timeline;
  const finish = () => {
    if (done) return; done = true; view.clearTimeout(timer); timeline?.kill(); overlay.remove();
    if (shell) shell.inert = previousInert;
    view.removeEventListener('resize', finish); view.removeEventListener('pagehide', finish);
    root.removeEventListener('visibilitychange', changed); root.removeEventListener('keydown', escape);
    reduced.removeEventListener('change', changed);
  };
  const changed = () => { if (root.hidden || reduced.matches) finish(); };
  const escape = event => { if (event.key === 'Escape') finish(); };
  const timer = view.setTimeout(finish, 3500);
  view.addEventListener('resize', finish); view.addEventListener('pagehide', finish);
  root.addEventListener('visibilitychange', changed); root.addEventListener('keydown', escape);
  reduced.addEventListener('change', changed);
  const start = () => {
    if (done || started || !decoded || !target) return;
    started = true;
    timeline = gsap.timeline({onComplete: finish});
    timeline.to(image, {x: target.x, y: target.y, scale: target.width / data.rect.width, duration: 1.05, ease: 'power3.inOut'}, 0)
      .to(overlay, {backgroundColor: 'rgba(229,237,243,0)', duration: .5, ease: 'power1.inOut'}, .3)
      .to(image, {opacity: 0, duration: .22, ease: 'power1.in'}, .88);
  };
  loadPortalMap(view, image).then(map => {
    if (!map) { finish(); return; }
    decoded = true; start();
  });
  return {finish, ready(rect) {
    if (done || started || rect.width <= 0 || rect.height <= 0) return;
    target = rect; start();
  }};
}
