// Shared finite UI effects. No simulation state, network calls, or authentication.
function createUiMotion(gsap) {
  const active = new Set(), layouts = new Set(), cleanup = new Set();
  let scrolling = null, destroyed = false;
  const preference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const enabled = () => Boolean(gsap && !destroyed && !preference?.matches && !document.hidden);
  const nodes = targets => Array.from(targets?.nodeType ? [targets] : targets || []).filter(Boolean);
  function track(animation, group) {
    active.add(animation); group?.add(animation);
    const complete = animation.eventCallback('onComplete');
    const interrupted = animation.eventCallback('onInterrupt');
    const remove = () => { active.delete(animation); group?.delete(animation); };
    animation.eventCallback('onComplete', function() { remove(); complete?.call(this); });
    animation.eventCallback('onInterrupt', function() { remove(); interrupted?.call(this); });
    return animation;
  }
  function finish(group = active) {
    for (const animation of [...group]) { animation.totalProgress(1); animation.kill(); }
  }
  function reveal(targets, {y = 8, duration = .22, stagger = 0} = {}) {
    const elements = nodes(targets);
    if (!enabled() || !elements.length) return;
    gsap.killTweensOf(elements);
    return track(gsap.fromTo(elements, {autoAlpha: 0, y}, {
      autoAlpha: 1, y: 0, duration, stagger, ease: 'power2.out', clearProps: 'opacity,visibility,transform',
    }));
  }
  function hide(element, complete) {
    if (!enabled()) { complete(); return; }
    gsap.killTweensOf(element);
    return track(gsap.to(element, {autoAlpha: 0, y: 8, duration: .18, ease: 'power1.in',
      clearProps: 'opacity,visibility,transform', onComplete: complete}));
  }
  function feedback(targets) {
    if (!enabled()) return;
    const elements = nodes(targets);
    for (const element of elements) {
      gsap.killTweensOf(element, 'backgroundColor');
      gsap.set(element, {clearProps: 'backgroundColor'});
      const original = getComputedStyle(element).backgroundColor;
      const backgroundColor = ['transparent', 'rgba(0, 0, 0, 0)'].includes(original) ? 'rgba(220,234,250,0)' : original;
      track(gsap.fromTo(element, {backgroundColor: '#dceafa'}, {backgroundColor, duration: .65,
        ease: 'power1.out', clearProps: 'backgroundColor'}));
    }
  }
  function layout(targets, change) {
    finish(layouts);
    if (!enabled()) { change(); return; }
    const elements = nodes(targets), before = new Map();
    for (const element of elements) if (element.getClientRects().length) before.set(element, element.getBoundingClientRect());
    change();
    const after = elements.filter(element => element.getClientRects().length)
      .map(element => [element, element.getBoundingClientRect()]);
    const timeline = gsap.timeline({defaults: {duration: .25, ease: 'power2.out', clearProps: 'transform,opacity,visibility'}});
    for (const [element, rect] of after) {
      const previous = before.get(element);
      if (!previous) timeline.fromTo(element, {autoAlpha: 0, y: 6}, {autoAlpha: 1, y: 0}, 0);
      else if (Math.abs(previous.top - rect.top) > .5 || Math.abs(previous.left - rect.left) > .5) {
        timeline.fromTo(element, {x: previous.left - rect.left, y: previous.top - rect.top}, {x: 0, y: 0}, 0);
      }
    }
    if (timeline.duration()) return track(timeline, layouts);
    timeline.kill();
  }
  function reply(article) {
    if (!enabled()) return;
    const lead = [...article.querySelectorAll('.reply-byline,.recommendation')];
    const cards = [...article.querySelectorAll('.route-card')];
    const tail = [...article.querySelectorAll('.comparison-highlights,.result-time')];
    const timeline = gsap.timeline({defaults: {duration: .25, ease: 'power2.out', clearProps: 'opacity,visibility,transform'}});
    if (lead.length) timeline.fromTo(lead, {autoAlpha: 0, y: 6}, {autoAlpha: 1, y: 0, stagger: .035}, 0);
    if (cards.length) timeline.fromTo(cards, {autoAlpha: 0, y: 8}, {autoAlpha: 1, y: 0, stagger: .06}, .08);
    if (tail.length) timeline.fromTo(tail, {autoAlpha: 0, y: 4}, {autoAlpha: 1, y: 0}, .24);
    return track(timeline);
  }
  function camera(view, target, update, duration = .45) {
    if (!enabled()) { Object.assign(view, target); update(); return null; }
    return track(gsap.to(view, {...target, duration, ease: 'power2.inOut', onUpdate: update}));
  }
  function scrollTo(element, complete = () => {}) {
    scrolling?.kill();
    const page = document.scrollingElement || document.documentElement;
    if (!element || !page) { complete(); return null; }
    const rect = element.getBoundingClientRect(), offset = 16, height = window.innerHeight;
    // Sticky maps that are already visible stay in place.
    if (rect.top >= offset - 1 && rect.top + Math.min(rect.height, height - offset * 2) <= height - offset + 1) {
      complete(); return null;
    }
    const target = Math.max(0, Math.min(page.scrollHeight - height, page.scrollTop + rect.top - offset));
    const distance = Math.abs(target - page.scrollTop);
    if (!enabled() || distance < 2) { page.scrollTop = target; complete(); return null; }
    const position = {y: page.scrollTop};
    let tween;
    const dispose = () => {
      if (scrolling === tween) scrolling = null;
      for (const name of ['wheel','touchstart','pointerdown','resize']) window.removeEventListener(name, interrupt);
      window.removeEventListener('keydown', keydown);
    };
    const interrupt = () => tween?.kill();
    const keydown = event => {
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' ','Escape'].includes(event.key)) interrupt();
    };
    for (const name of ['wheel','touchstart','pointerdown','resize']) window.addEventListener(name, interrupt, {passive: true});
    window.addEventListener('keydown', keydown);
    tween = gsap.to(position, {y: target, duration: Math.min(1.1, Math.max(.7, distance / 2400)),
      ease: 'power2.inOut', onUpdate: () => { page.scrollTop = position.y; },
      onComplete: () => { dispose(); complete(); }, onInterrupt: dispose});
    scrolling = track(tween);
    return tween;
  }
  function rotate(element) {
    if (!enabled() || !element) return;
    gsap.killTweensOf(element);
    return track(gsap.fromTo(element, {rotation: 0}, {rotation: 180, duration: .2, ease: 'power2.out', clearProps: 'transform'}));
  }
  function choice(group) {
    if (!gsap || !group) return () => {};
    const indicator = document.createElement('span');
    indicator.className = 'selection-indicator'; indicator.setAttribute('aria-hidden', 'true');
    group.classList.add('has-motion'); group.prepend(indicator);
    let initialized = false;
    function update(animate = true) {
      const selected = group.querySelector('button[aria-pressed="true"]');
      if (!selected) return;
      const target = {x: selected.offsetLeft, y: selected.offsetTop};
      indicator.style.width = selected.offsetWidth + 'px'; indicator.style.height = selected.offsetHeight + 'px';
      gsap.killTweensOf(indicator);
      if (enabled() && initialized && animate) track(gsap.to(indicator, {...target, duration: .16, ease: 'power2.out'}));
      else gsap.set(indicator, target);
      initialized = true;
    }
    const observer = new ResizeObserver(() => update(false)); observer.observe(group);
    cleanup.add(() => observer.disconnect()); update(false);
    return update;
  }
  function stop(target) {
    gsap?.killTweensOf(target);
    if (gsap && target?.nodeType) gsap.set(target, {clearProps: 'transform,opacity,visibility'});
  }
  function settle() { if (preference?.matches || document.hidden) finish(); }
  function destroy(event) {
    if (event?.persisted) return;
    destroyed = true;
    finish(); for (const dispose of cleanup) dispose(); cleanup.clear(); preference?.removeEventListener?.('change', settle);
    document.removeEventListener?.('visibilitychange', settle);
    window.removeEventListener?.('pagehide', destroy);
  }
  preference?.addEventListener?.('change', settle);
  document.addEventListener?.('visibilitychange', settle);
  window.addEventListener?.('pagehide', destroy);
  return {enabled, reveal, hide, feedback, layout, reply, camera, scrollTo, rotate, choice, stop};
}
