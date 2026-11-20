export function makeScreening(byId) {
  const dialog = byId('screening');
  const media = byId('screen-media');
  const toggle = byId('screen-toggle');
  const audio = byId('screen-audio');
  let frames = [];
  let index = 0;
  let running = false;
  let finished = false;
  let muted = true;
  let unavailable = 0;
  let current = null;
  let timer = 0;

  function synchronize() {
    clearTimeout(timer);
    const video = current?.tagName === 'VIDEO';
    toggle.textContent = running ? 'Pause' : finished ? 'Replay reel' : 'Play';
    if (video) {
      if (running) {
        const frame = current;
        frame.play().catch(() => {
          if (current === frame && running) {
            running = false;
            synchronize();
          }
        });
      } else current.pause();
    } else if (running && current?.complete && current.naturalWidth > 0) {
      const seconds = frames[index]?.cue?.seconds;
      timer = window.setTimeout(advance, seconds ? seconds * 1000 : 4200);
    }
  }

  function advance() {
    if (index < frames.length - 1) {
      index++;
      paint();
    } else {
      running = false;
      finished = true;
      synchronize();
    }
  }

  function paint() {
    clearTimeout(timer);
    if (current?.tagName === 'VIDEO') current.pause();
    finished = false;
    const item = frames[index];
    const video = item.type === 'video';
    const frame = document.createElement(video ? 'video' : 'img');
    if (video) {
      frame.playsInline = true;
      frame.muted = muted;
      frame.poster = item.thumb;
      frame.setAttribute('aria-label', item.title);
      frame.addEventListener('ended', () => { if (current === frame && running) advance(); });
    } else {
      frame.alt = item.title;
      frame.addEventListener('load', () => { if (current === frame) synchronize(); });
    }
    frame.addEventListener('error', () => {
      if (current !== frame) return;
      running = false;
      const message = document.createElement('p');
      message.className = 'media-error';
      message.textContent = 'This frame could not load. Try the next frame.';
      current = null;
      media.replaceChildren(message);
      synchronize();
    });
    current = frame;
    frame.src = item.src;
    media.replaceChildren(frame);
    byId('screen-caption').textContent = `${index + 1} / ${frames.length} · ${item.title}${unavailable ? ` · ${unavailable} unavailable` : ''}`;
    const note = byId('screen-cue');
    note.textContent = item.cue?.caption ?? '';
    note.hidden = !note.textContent;
    byId('screen-prev').disabled = index === 0;
    byId('screen-next').disabled = index >= frames.length - 1;
    audio.hidden = !video;
    audio.textContent = muted ? 'Unmute' : 'Mute';
    synchronize();
  }

  function step(delta) {
    if (!frames[index + delta]) return;
    index += delta;
    paint();
  }

  toggle.addEventListener('click', () => {
    if (finished) {
      index = 0;
      running = true;
      paint();
      return;
    }
    running = !running;
    if (!current) paint();
    else synchronize();
  });
  audio.addEventListener('click', () => {
    if (current?.tagName !== 'VIDEO') return;
    muted = !muted;
    current.muted = muted;
    audio.textContent = muted ? 'Unmute' : 'Mute';
  });
  byId('screen-prev').addEventListener('click', () => step(-1));
  byId('screen-next').addEventListener('click', () => step(1));
  dialog.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    step(event.key === 'ArrowLeft' ? -1 : 1);
  });
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    if (current?.tagName === 'VIDEO') current.pause();
    running = false;
    current = null;
    frames = [];
    media.replaceChildren();
  });
  return {
    open(data) {
      frames = data.items;
      unavailable = data.unavailable;
      index = 0;
      muted = true;
      running = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      byId('screen-title').textContent = data.title;
      dialog.showModal();
      paint();
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
