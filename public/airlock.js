export function enterWorkspace(focus = true) {
  document.getElementById('workspace-shell').scrollIntoView({ block: 'start' });
  if (focus) {
    const destination = document.getElementById('locked').hidden ? 'content' : 'key';
    document.getElementById(destination).focus({ preventScroll: true });
  }
}

export function startAirlock() {
  const intro = document.getElementById('airlock');
  const stage = intro.firstElementChild;
  const hint = stage.querySelector('.airlock-entry p');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  const clamp = (number) => Math.max(0, Math.min(1, number));
  const smooth = (number) => number * number * (3 - 2 * number);

  function paint() {
    raf = 0;
    if (reduced.matches) {
      stage.removeAttribute('style');
      return;
    }
    const distance = Math.max(1, intro.offsetHeight - stage.offsetHeight);
    const progress = clamp(-intro.getBoundingClientRect().top / distance);
    const swing = smooth(clamp((progress - .10) / .48));
    const dolly = smooth(clamp((progress - .34) / .64));
    const reveal = smooth(clamp((progress - .68) / .24));
    const message = progress > .70 ? 'Keep scrolling to the library' : 'Scroll to open the hatch';
    if (hint.textContent !== message) hint.textContent = message;
    stage.style.setProperty('--progress', progress);
    stage.style.setProperty('--swing', `${swing * -113}deg`);
    stage.style.setProperty('--slide-hatch', `${swing * -9}%`);
    stage.style.setProperty('--door-light', 1 - .48 * swing);
    stage.style.setProperty('--door-opacity', 1 - smooth(clamp((progress - .47) / .16)));
    stage.style.setProperty('--art-scale', 1 + dolly * 2.1);
    stage.style.setProperty('--art-y', `${dolly * -11}vh`);
    stage.style.setProperty('--title-opacity', 1 - smooth(clamp(progress / .28)));
    stage.style.setProperty('--reveal-opacity', reveal);
  }

  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  reduced.addEventListener('change', schedule);
  document.getElementById('enter-library').addEventListener('click', (event) => {
    event.preventDefault();
    enterWorkspace();
  });
  // A link to a single asset bypasses the introduction.
  if (location.hash === '#workspace-shell' || new URLSearchParams(location.hash.slice(1)).has('asset')) {
    requestAnimationFrame(() => enterWorkspace(false));
  }
  paint();
}
