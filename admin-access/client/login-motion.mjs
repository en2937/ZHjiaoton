/** Decorative, local-only map pan. Authentication is independent of this module. */
export function createLoginMotion({gsap, root = document, view = window} = {}) {
  const plane = root.querySelector('.backdrop-map');
  if (!gsap || !plane) return null;

  let introduced = false, leaving = false, pan = null;
  const media = gsap.matchMedia();
  media.add({
    desktop: '(min-width: 701px)',
    mobile: '(max-width: 700px)',
    reduced: '(prefers-reduced-motion: reduce)',
  }, context => {
    if (context.conditions.reduced) return;

    const shell = root.querySelector('.login-shell');
    if (!introduced && shell && !root.hidden) {
      introduced = true;
      gsap.fromTo(shell, {opacity: 0, y: 8}, {opacity: 1, y: 0, duration: .25,
        ease: 'power2.out', clearProps: 'opacity,transform'});
    }

    // Overscan is defined in CSS. Only translate this one pre-blurred layer.
    pan = gsap.fromTo(plane,
      {xPercent: -3, yPercent: -3},
      {xPercent: 3, yPercent: 3, duration: context.conditions.mobile ? 32 : 25,
        ease: 'sine.inOut', repeat: -1, yoyo: true, paused: true, force3D: true});

    const sync = () => {
      pan.paused(root.hidden || leaving);
      plane.style.willChange = root.hidden ? 'auto' : 'transform';
    };
    root.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      root.removeEventListener('visibilitychange', sync);
      plane.style.removeProperty('will-change');
    };
  });

  const destroy = () => {
    if (!leaving) media.revert();
    view.removeEventListener('pagehide', pagehide);
    view.removeEventListener('pageshow', pageshow);
  };
  // BFCache keeps the document: visibilitychange pauses it and pageshow resumes.
  const pagehide = event => { if (!event.persisted) destroy(); };
  const pageshow = event => {
    if (event.persisted && leaving) { view.location.replace('/'); return; }
    root.dispatchEvent(new Event('visibilitychange'));
  };
  view.addEventListener('pagehide', pagehide);
  view.addEventListener('pageshow', pageshow);
  const leave = createLoginDeparture({gsap, root, view, stopPan: () => {
    leaving = true; pan?.pause(); plane.style.willChange = 'transform,filter';
  }});
  return {destroy, leave};
}
