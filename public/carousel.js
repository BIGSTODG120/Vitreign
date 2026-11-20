export function makeCarousel({ stage, previous, next, title, counter, onOpen, icon }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let items = [];
  let cards = [];
  let active = 0;
  let drag = null;
  let offset = 0;
  let blockClickUntil = 0;
  const pad = (n) => String(n).padStart(2, '0');

  function position() {
    if (!cards.length) return;
    const width = stage.clientWidth;
    const spacing = Math.min(232, Math.max(91, width * .187));
    const count = cards.length;
    for (const [index, card] of cards.entries()) {
      const half = Math.floor(count / 2);
      const delta = ((index - active + half + count) % count) - half;
      const shift = delta + offset;
      const distance = Math.abs(shift);
      const onstage = distance <= (width < 510 ? 2.15 : 3.2);
      const x = shift * spacing;
      card.style.setProperty('--x', `${x}px`);
      card.style.setProperty('--z', `${reduce.matches ? 0 : -Math.min(210, distance * 65)}px`);
      card.style.setProperty('--angle', `${reduce.matches ? 0 : Math.max(-51, Math.min(51, shift * -20))}deg`);
      card.style.setProperty('--scale', reduce.matches ? '1' : String(Math.max(.69, 1 - .09 * distance)));
      card.style.setProperty('--opacity', onstage ? String(Math.max(.33, 1 - distance * .17)) : '0');
      card.style.setProperty('--layer', String(30 - Math.round(distance * 6)));
      card.dataset.active = String(index === active);
      card.tabIndex = index === active ? 0 : -1;
      card.setAttribute('aria-hidden', String(!onstage));
    }
  }

  function announce() {
    title.textContent = items[active]?.title ?? '';
    counter.textContent = items.length ? `${pad(active + 1)} / ${pad(items.length)}` : '';
    previous.disabled = next.disabled = items.length < 2;
  }

  function move(index, focus = false) {
    if (!items.length) return;
    active = ((index % items.length) + items.length) % items.length;
    position();
    announce();
    if (focus) cards[active].focus({ preventScroll: true });
  }

  previous.addEventListener('click', () => move(active - 1));
  next.addEventListener('click', () => move(active + 1));
  stage.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: items.length - 1 };
    move(target[event.key], true);
  });
  stage.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || items.length < 2) return;
    drag = { id: event.pointerId, x: event.clientX, active: false };
  });
  stage.addEventListener('pointermove', (event) => {
    if (event.pointerId !== drag?.id) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) < 9 && !drag.active) return;
    if (!drag.active) {
      drag.active = true;
      stage.setPointerCapture(event.pointerId);
      stage.classList.add('is-dragging');
    }
    if (reduce.matches) return;
    offset = Math.min(1.3, Math.max(-1.3, dx / 120));
    position();
  });
  function finish(event) {
    if (event.pointerId !== drag?.id) return;
    const delta = event.clientX - drag.x;
    const wasDrag = drag.active;
    drag = null;
    offset = 0;
    stage.classList.remove('is-dragging');
    if (wasDrag) blockClickUntil = performance.now() + 250;
    const step = wasDrag && event.type === 'pointerup' && Math.abs(delta) > 25 ? -Math.sign(delta) : 0;
    move(active + step);
  }
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
  stage.addEventListener('lostpointercapture', finish);
  stage.addEventListener('pointerleave', (event) => {
    if (event.pointerId === drag?.id && !drag.active) finish(event);
  });
  new ResizeObserver(position).observe(stage);
  reduce.addEventListener('change', position);

  return {
    setItems(nextItems, preferred = 0) {
      items = nextItems.slice(0, 9);
      active = Math.min(preferred, Math.max(0, items.length - 1));
      cards = items.map((item, index) => {
        const button = document.createElement('button');
        button.className = 'slide';
        button.type = 'button';
        button.setAttribute('aria-label', `${item.title}, ${item.type}, ${index + 1} of ${items.length}`);
        button.title = item.title;
        const image = document.createElement('img');
        image.src = item.thumb;
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';
        button.append(image);
        if (item.type === 'video') {
          const mark = document.createElement('span');
          mark.className = 'movie-mark';
          mark.append(icon('play'));
          button.append(mark);
        }
        button.addEventListener('click', () => {
          if (performance.now() < blockClickUntil) return;
          if (active === index) onOpen(items, active);
          else move(index);
        });
        return button;
      });
      stage.replaceChildren(...cards);
      position();
      announce();
    },
  };
}
