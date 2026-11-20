import { makeCarousel } from './carousel.js';
import { enterWorkspace, startAirlock } from './airlock.js';
import { makeScreening } from './screening.js';
import { makeRestore } from './restore.js';
import { makeCommands } from './commands.js';

const byId = (id) => document.getElementById(id);
const viewer = byId('viewer');
const panel = byId('panel');
const query = byId('query');
const grid = byId('grid');
const compact = matchMedia('(max-width: 510px)');
const screening = makeScreening(byId);
const restore = makeRestore(byId);
const state = {
  mode: 'sample', locked: false, canLock: false, shares: false, originals: false,
  view: 'library', subset: null, kind: '', from: '', through: '', ordering: false,
  saved: { favorites: [], reels: [] },
  items: [], page: 1, more: false, cursor: null, viewing: [], index: 0,
};
let loadAbort;
let currentShelf = [];
let searchTimer;
let toastTimer;

function el(tag, className = '', value = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function button(label, className = 'outline-button', glyph = '') {
  const node = el('button', className);
  node.type = 'button';
  if (glyph) node.append(icon(glyph));
  node.append(label);
  return node;
}

const carousel = makeCarousel({
  stage: byId('carousel'), previous: byId('prev-frame'), next: byId('next-frame'),
  title: byId('frame-title'), counter: byId('frame-counter'), onOpen: openViewer, icon,
});

async function api(path, { body, signal, auth = true } = {}) {
  const response = await fetch(`/api/${path}`, {
    signal,
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (response.status === 401 && auth) setLocked(true);
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3100);
}

function setLocked(locked) {
  state.locked = locked;
  byId('library-ui').hidden = locked;
  byId('locked').hidden = !locked;
  byId('search').hidden = locked || ['archive', 'restore'].includes(state.view);
  byId('lock').hidden = locked || !state.canLock;
  byId('open-commands').hidden = locked;
  document.querySelector('.side-nav').hidden = locked;
  if (!locked) return;
  loadAbort?.abort();
  if (panel.open) panel.close();
  if (viewer.open) viewer.close();
  screening.close();
  restore.reset();
  commands.close();
  byId('viewer-media').replaceChildren();
  carousel.setItems([]);
  grid.replaceChildren();
  state.saved = { favorites: [], reels: [] };
  state.items = [];
  state.viewing = [];
  currentShelf = [];
  byId('storage-grid').replaceChildren();
  byId('key').focus({ preventScroll: true });
}

function notice(message, retry = false) {
  byId('notice').hidden = !message;
  byId('notice-message').textContent = message;
  byId('retry').hidden = !retry;
}

function closeNav() {
  byId('sidebar').classList.remove('open');
  byId('mobile-menu').setAttribute('aria-expanded', 'false');
  byId('mobile-menu').setAttribute('aria-label', 'Open navigation');
}

function view(name, subset = null, term = '') {
  if (state.view === 'restore' && name !== 'restore') restore.reset();
  state.view = name;
  state.subset = subset;
  state.kind = '';
  state.from = '';
  state.through = '';
  state.ordering = false;
  query.value = term;
  closeNav();
  updateHeading();
  reload();
  enterWorkspace(false);
}

function updateHeading() {
  const names = { library: 'Library', favorites: 'Favorites', reels: 'Reels', albums: 'Immich albums',
    archive: 'Archive', restore: 'Restore Check' };
  const shelf = isShelf();
  const archive = state.view === 'archive';
  const verifying = state.view === 'restore';
  const reel = state.view === 'reels' ? state.subset : null;
  byId('archive').hidden = !archive;
  byId('restore').hidden = !verifying;
  byId('library').hidden = archive || verifying;
  byId('search').hidden = state.locked || archive || verifying;
  if (archive || verifying) byId('hero').hidden = true;
  byId('breadcrumb').textContent = names[state.view];
  byId('library-title').textContent = state.subset?.title ?? (state.view === 'library' ? 'All media' : names[state.view]);
  byId('back').hidden = !state.subset;
  byId('back').querySelector('span').textContent = names[state.view];
  byId('new-reel').hidden = state.view !== 'reels' || !!state.subset;
  byId('remove-reel').hidden = state.view !== 'reels' || !state.subset;
  byId('reel-play').hidden = !reel;
  byId('reel-order').hidden = !reel;
  byId('reel-order').setAttribute('aria-pressed', String(state.ordering));
  byId('reel-order').textContent = state.ordering ? 'Done editing' : 'Edit sequence';
  byId('reel-index').hidden = !reel;
  if (reel) byId('reel-index').href = `/api/reels/${reel.id}/index`;
  byId('date-filter').hidden = shelf;
  byId('date-filter').dataset.set = String(!!(state.from || state.through));
  document.querySelector('.filters').hidden = shelf;
  const searchLabel = shelf ? `Search ${state.view}` : 'Search photos and videos';
  query.placeholder = !shelf && compact.matches ? 'Search media' : searchLabel;
  query.setAttribute('aria-label', searchLabel);
  for (const node of document.querySelectorAll('[data-view]')) {
    if (node.dataset.view === state.view) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
  for (const node of document.querySelectorAll('[data-kind]')) {
    node.setAttribute('aria-pressed', String(node.dataset.kind === state.kind));
  }
}

const isShelf = () => !state.subset && ['reels', 'albums'].includes(state.view);
const jump = (name) => {
  view(name);
  byId('content').focus({ preventScroll: true });
};

function availableCommands(term) {
  const options = [
    { label: 'Open library', icon: 'gallery', alias: 'home photos video', run: () => jump('library') },
    { label: 'Open favorites', icon: 'heart', alias: 'saved', run: () => jump('favorites') },
    { label: 'Open reels', icon: 'reels', alias: 'screenings edit sequence', run: () => jump('reels') },
    { label: 'Open Archive', icon: 'server', alias: 'disk drives NAS storage', run: () => jump('archive') },
    { label: 'Open Restore Check', icon: 'verify', alias: 'compare backup verify files', run: () => jump('restore') },
    { label: 'Return to the airlock', icon: 'gallery', alias: 'intro cinematic opening', run: () => {
      window.scrollTo(0, 0);
      byId('enter-library').focus({ preventScroll: true });
    } },
  ];
  if (state.mode === 'immich') options.splice(3, 0,
    { label: 'Open Immich albums', icon: 'album', alias: 'collections', run: () => jump('albums') });
  if (state.view === 'reels' && state.subset) options.unshift(
    { label: 'Play this reel', icon: 'play', alias: 'screening watch', run: playReel });
  const matches = options.filter(({ label, alias }) => term.toLowerCase().split(/\s+/)
    .every((word) => `${label} ${alias}`.toLowerCase().includes(word)));
  if (term) matches.push({
    label: `Search library for “${term}”`, icon: 'search',
    run: () => { view('library', null, term); query.focus({ preventScroll: true }); },
  });
  return matches;
}

const commands = makeCommands(byId, icon, availableCommands, () =>
  !state.locked && !panel.open && !viewer.open && !byId('screening').open);
if (navigator.platform.startsWith('Mac')) byId('open-commands').querySelector('kbd').textContent = '⌘ K';
const dateLabel = (value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
};

function thumbnail(item) {
  const image = el('img', 'card-photo');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = item.thumb;
  return image;
}

function cardInfo(title, detail) {
  const info = el('span', 'card-info');
  info.append(el('strong', 'card-title', title), el('span', 'card-detail', detail));
  return info;
}

function mediaCard(item, index) {
  const card = el('article', 'media-card');
  const open = button('', 'card-open');
  open.title = item.title;
  const detail = item.collection || dateLabel(item.date) || (item.type === 'video' ? 'Video' : 'Photo');
  open.append(thumbnail(item), cardInfo(item.title, detail));
  open.addEventListener('click', () => openViewer(state.items, index));
  card.append(open);
  if (state.ordering && state.view === 'reels' && state.subset) card.append(frameMovement(item));
  if (item.type === 'video') {
    const duration = el('span', 'duration');
    duration.append(icon('play'), item.duration || 'Video');
    card.append(duration);
  }
  if (state.saved.favorites.includes(item.id)) {
    const mark = el('span', 'card-favorite');
    mark.setAttribute('aria-label', 'Favorited');
    mark.append(icon('heart'));
    card.append(mark);
  }
  return card;
}

function frameMovement(item) {
  const reel = state.saved.reels.find(({ id }) => id === state.subset?.id);
  const ids = reel?.ids ?? [];
  const current = ids.indexOf(item.id);
  const controls = el('div', 'frame-movement');
  controls.dataset.asset = item.id;
  for (const step of [-1, 1]) {
    const move = button('', 'icon-button', 'down');
    move.dataset.step = String(step);
    move.setAttribute('aria-label', `Move ${item.title} ${step === -1 ? 'earlier' : 'later'}`);
    move.disabled = current === -1 || !ids[current + step];
    move.addEventListener('click', async () => {
      for (const node of grid.querySelectorAll('.frame-movement button')) node.disabled = true;
      try {
        await persist('reel-order', { reel: reel.id, asset: item.id, step });
        await reload();
        const selector = `[data-asset="${CSS.escape(item.id)}"] button`;
        grid.querySelector(`${selector}[data-step="${step}"]:enabled`)?.focus({ preventScroll: true });
        if (!grid.contains(document.activeElement)) {
          (grid.querySelector(`${selector}:enabled`) || byId('reel-order')).focus({ preventScroll: true });
        }
        showToast('Reel order saved.');
      } catch (error) {
        showToast(error.message);
        renderGrid();
      }
    });
    controls.append(move);
    if (step === -1) {
      const cue = button(`Cue ${current + 1}`, 'outline-button frame-cue');
      cue.disabled = current < 0;
      cue.setAttribute('aria-label', `Edit cue for ${item.title}`);
      cue.addEventListener('click', () => editCue(reel.id, item, cue));
      controls.append(cue);
    }
  }
  return controls;
}

function shelfCard(item) {
  const open = button('', 'shelf-card');
  open.title = item.title;
  const cover = state.view === 'reels' ? item.ids[0] : null;
  const coverPath = cover ? (state.mode === 'sample' ? `/media/${cover}.webp` : `/api/media/${cover}/thumb`) : item.thumb;
  if (coverPath) open.append(thumbnail({ thumb: coverPath }));
  else {
    const placeholder = el('span', 'shelf-placeholder');
    placeholder.append(icon(state.view === 'reels' ? 'reels' : 'album'));
    open.append(placeholder);
  }
  const count = item.count ?? item.ids.length;
  open.append(cardInfo(item.title, `${count} ${count === 1 ? 'item' : 'items'}`));
  open.addEventListener('click', () => view(state.view, item));
  return open;
}

function renderGrid() {
  const shelf = isShelf();
  const entries = shelf ? currentShelf : state.items;
  grid.replaceChildren(...entries.map(shelf ? shelfCard : mediaCard));
  byId('library-count').textContent = `${entries.length}${state.more ? '+' : ''} ${shelf
    ? state.view === 'reels' ? (entries.length === 1 ? 'reel' : 'reels') : (entries.length === 1 ? 'album' : 'albums')
    : entries.length === 1 ? 'item' : 'items'}`;
  byId('more').hidden = !state.more || shelf;
  let empty = '';
  if (query.value.trim()) empty = 'No matches. Try a different search.';
  else if (state.view === 'favorites') empty = 'Open a photo or video and select Favorite to add it here.';
  else if (state.view === 'reels') empty = state.subset
    ? 'Open an item in Library and choose Reels to add it here.'
    : 'Create a reel to collect photos and videos in one sequence.';
  else if (state.view === 'albums') empty = 'No albums to show.';
  else empty = 'No media matches this view.';
  notice(entries.length ? '' : empty);
}

function renderHero() {
  const isMain = state.view === 'library';
  const visible = (isMain || state.view === 'reels' && state.subset) && !query.value.trim()
    && !state.kind && !state.from && !state.through && !state.ordering && state.items.length > 0;
  byId('hero').hidden = !visible;
  if (!visible) return;
  byId('hero-eyebrow').textContent = isMain ? 'CINEMA VIEW' : 'REEL';
  const headline = byId('hero-title');
  if (isMain) headline.replaceChildren('Your library,', el('br'), el('em', '', 'in motion.'));
  else headline.replaceChildren(el('em', '', state.subset.title));
  byId('hero-description').textContent = isMain
    ? 'A closer look at the photos and films you keep.'
    : 'Browse this reel in the order you added each frame.';
  carousel.setItems(state.items, isMain && state.mode === 'sample' ? 2 : 0);
}

async function reload(append = false) {
  if (state.locked) return;
  loadAbort?.abort();
  const controller = new AbortController();
  loadAbort = controller;
  const signal = controller.signal;
  const nextPage = append ? state.page + 1 : 1;
  const term = query.value.trim();
  if (state.view === 'restore') return;
  if (state.view === 'archive') return loadStorage(signal);
  if (!append) {
    byId('library-count').textContent = 'Loading…';
    byId('more').hidden = true;
  }
  byId('more').disabled = true;
  notice('');
  try {
    if (isShelf()) {
      const source = state.view === 'reels' ? state.saved.reels : await api('albums', { signal });
      if (signal.aborted) return;
      currentShelf = source.filter((item) => item.title.toLowerCase().includes(term.toLowerCase()));
      state.items = [];
      state.more = false;
    } else {
      const params = new URLSearchParams({ page: nextPage, q: term, kind: state.kind });
      if (state.from) params.set('from', state.from);
      if (state.through) params.set('through', state.through);
      if (append && state.cursor) params.set('cursor', state.cursor);
      if (state.view === 'favorites') params.set('favorites', '1');
      if (state.subset) params.set(state.view === 'reels' ? 'reel' : 'album', state.subset.id);
      const data = await api(`library?${params}`, { signal });
      if (signal.aborted) return;
      state.items = append ? [...state.items, ...data.items.filter(({ id }) =>
        !state.items.some((item) => item.id === id))] : data.items;
      state.more = data.more;
      state.cursor = data.cursor;
    }
    state.page = nextPage;
    renderGrid();
    if (!append) renderHero();
  } catch (error) {
    if (!signal.aborted && !state.locked) {
      if (!append) {
        grid.replaceChildren();
        byId('hero').hidden = true;
      }
      byId('library-count').textContent = '';
      notice(error.message, true);
    }
  } finally {
    if (!signal.aborted) byId('more').disabled = false;
  }
}

function renderViewer() {
  const item = state.viewing[state.index];
  if (!item) return;
  byId('viewer-title').textContent = item.title;
  byId('viewer-meta').textContent = [item.type === 'video' ? 'Video' : 'Photo',
    dateLabel(item.date), item.collection].filter(Boolean).join(' · ');
  const media = el(item.type === 'video' ? 'video' : 'img');
  if (item.type === 'video') {
    media.controls = true;
    media.playsInline = true;
    media.preload = 'metadata';
    media.poster = item.thumb;
    media.setAttribute('aria-label', item.title);
  } else {
    media.alt = item.title;
  }
  media.addEventListener('error', () => {
    if (media.isConnected) media.replaceWith(el('p', 'media-error', 'This file could not be displayed.'));
  });
  media.src = item.src;
  byId('viewer-media').replaceChildren(media);
  byId('viewer-prev').disabled = state.index === 0;
  byId('viewer-next').disabled = state.index === state.viewing.length - 1;
  byId('original').hidden = !state.originals;
  if (state.originals) byId('original').href = `/api/original/${encodeURIComponent(item.id)}`;
  updateFavorite();
}

function openViewer(items, index) {
  state.viewing = items;
  state.index = index;
  renderViewer();
  if (!viewer.open) viewer.showModal();
}

function stepViewer(delta) {
  const index = state.index + delta;
  if (!state.viewing[index]) return;
  state.index = index;
  renderViewer();
}

function updateFavorite() {
  const favored = state.saved.favorites.includes(state.viewing[state.index]?.id);
  byId('favorite').setAttribute('aria-pressed', String(favored));
  byId('favorite').lastElementChild.textContent = favored ? 'Favorited' : 'Favorite';
}

function openPanel(title, ...content) {
  byId('panel-title').textContent = title;
  byId('panel-content').replaceChildren(...content);
  if (!panel.open) panel.showModal();
}

async function persist(path, body) {
  state.saved = await api(path, { body });
}

async function editCue(reel, item, control) {
  control.disabled = true;
  try {
    const data = await api(`reels/${reel}/cue/${encodeURIComponent(item.id)}`);
    if (state.locked || state.subset?.id !== reel || !state.ordering) return;
    const form = el('form');
    const captionLabel = el('label', '', 'Screening caption');
    const caption = el('textarea');
    caption.id = 'cue-caption';
    caption.rows = 3;
    caption.maxLength = 180;
    caption.value = data.caption;
    captionLabel.htmlFor = caption.id;
    form.append(captionLabel, caption);
    const seconds = el('input');
    seconds.type = 'number';
    seconds.id = 'cue-seconds';
    seconds.min = '2';
    seconds.max = '30';
    seconds.value = data.seconds || '';
    if (item.type === 'photo') {
      const label = el('label', '', 'Hold time in seconds');
      label.htmlFor = seconds.id;
      form.append(label, seconds, el('p', 'cue-help', 'Choose 2 to 30 seconds. A blank field uses the default.'));
    }
    const save = button('Save cue', 'accent-button');
    save.type = 'submit';
    const error = el('p');
    error.setAttribute('role', 'alert');
    form.append(save, error);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      error.textContent = '';
      try {
        await api('reel-cue', { body: { reel, asset: item.id, caption: caption.value, seconds: Number(seconds.value) } });
        panel.close();
        showToast('Cue saved.');
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        save.disabled = false;
      }
    });
    openPanel('Edit cue', el('p', '', item.title), form);
    caption.focus();
  } catch (error) {
    if (!state.locked) showToast(error.message);
  } finally {
    control.disabled = false;
  }
}

function dateFilter() {
  const form = el('form', 'date-form');
  function dateField(label, id, value) {
    const field = el('input');
    field.type = 'date';
    field.id = id;
    field.value = value;
    const caption = el('label', '', label);
    caption.htmlFor = id;
    form.append(caption, field);
    return field;
  }
  const from = dateField('From', 'date-from', state.from);
  const through = dateField('Through', 'date-through', state.through);
  const apply = button('Apply date range', 'accent-button');
  apply.type = 'submit';
  const clear = button('Clear dates', 'text-button date-clear');
  const error = el('p');
  error.setAttribute('role', 'alert');
  function setDates(start, end) {
    state.from = start;
    state.through = end;
    panel.close();
    updateHeading();
    reload();
  }
  clear.addEventListener('click', () => setDates('', ''));
  form.append(apply, clear, error);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (from.value && through.value && from.value > through.value) {
      error.textContent = 'The end date must be on or after the start date.';
      return;
    }
    setDates(from.value, through.value);
  });
  openPanel('Capture dates', el('p', '', 'Both dates are inclusive and use UTC.'), form);
  from.focus();
}

const storageStates = {
  verified: 'Volume verified', reachable: 'Path reachable', unverified: 'Volume marker missing or different',
  unavailable: 'Unavailable', pending: 'Storage did not respond in time',
};

function formatBytes(bytes) {
  const count = Number(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = count < 1000 ? 0 : Math.min(units.length - 1, Math.floor(Math.log10(count) / 3));
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(count / 1000 ** unit);
  return `${number} ${units[unit]}`;
}

function storageCard(volume) {
  const card = el('article', 'storage-card');
  card.append(el('h3', '', volume.name), el('p', '', storageStates[volume.status]));
  if (volume.total) {
    const progress = el('progress');
    progress.max = 100;
    progress.value = Math.round(100 * (1 - Number(volume.free) / Number(volume.total)));
    progress.setAttribute('aria-label', `Used or reserved space on ${volume.name}`);
    card.append(el('p', 'capacity-free', `${formatBytes(volume.free)} available`),
      el('p', '', `${formatBytes(volume.total)} total · ${progress.value}% used or reserved`), progress);
  }
  return card;
}

async function loadStorage(signal) {
  const status = byId('storage-status');
  const refresh = byId('storage-refresh');
  status.textContent = 'Checking storage…';
  refresh.disabled = true;
  try {
    const data = await api('storage', { signal });
    if (signal.aborted) return;
    const views = data.volumes.map(storageCard);
    byId('storage-grid').replaceChildren(...views);
    status.textContent = views.length
      ? `Checked at ${new Date(data.checkedAt).toLocaleTimeString()}`
      : 'Your operator can add storage roots to this page.';
  } catch (error) {
    if (!signal.aborted) status.textContent = error.message;
  } finally {
    if (!signal.aborted) refresh.disabled = false;
  }
}

async function playReel() {
  const reel = state.subset;
  const control = byId('reel-play');
  if (!reel) return;
  control.disabled = true;
  try {
    const data = await api(`reels/${reel.id}/screen`);
    if (state.subset?.id !== reel.id || state.locked) return;
    if (data.items.length) screening.open(data);
    else showToast('This reel has no available frames.');
  } catch (error) {
    if (!state.locked) showToast(error.message);
  } finally {
    control.disabled = false;
  }
}

function createReel(returnToViewer = false) {
  const form = el('form');
  const label = el('label', '', 'Reel name');
  const input = el('input');
  input.id = 'reel-name';
  input.required = true;
  input.maxLength = 80;
  input.autocomplete = 'off';
  label.htmlFor = input.id;
  const submit = button('Create reel', 'accent-button');
  submit.type = 'submit';
  const error = el('p');
  error.setAttribute('role', 'alert');
  form.append(label, input, submit, error);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await persist('reel', { action: 'create', title: input.value });
      if (returnToViewer) chooseReels();
      else { panel.close(); reload(); }
      showToast('Reel created.');
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      submit.disabled = false;
    }
  });
  openPanel('Create a reel', form);
  input.focus();
}

function chooseReels() {
  const item = state.viewing[state.index];
  if (!item) return;
  const choices = el('div', 'reel-picker');
  for (const reel of state.saved.reels) {
    const included = reel.ids.includes(item.id);
    const option = button(reel.title, 'outline-button reel-option');
    option.setAttribute('aria-pressed', String(included));
    if (included) option.append(icon('check'));
    option.addEventListener('click', async () => {
      option.disabled = true;
      try {
        await persist('frame', { reel: reel.id, asset: item.id, enabled: !included });
        if (state.view === 'reels') reload();
        showToast(included ? 'Removed from reel.' : 'Added to reel.');
      } catch (error) {
        showToast(error.message);
      } finally {
        if (panel.open) {
          chooseReels();
          byId('panel-content').querySelectorAll('.reel-option')[state.saved.reels.findIndex(({ id }) => id === reel.id)]?.focus();
        }
      }
    });
    choices.append(option);
  }
  const add = button('New reel', 'accent-button', 'plus');
  add.addEventListener('click', () => createReel(true));
  openPanel('Save to reels', el('p', '', 'Select a reel to add or remove this item.'), choices, add);
}

function confirmDelete() {
  const reel = state.subset;
  if (!reel) return;
  const remove = button('Delete reel', 'outline-button', 'trash');
  const cancel = button('Cancel');
  cancel.addEventListener('click', () => panel.close());
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await persist('reel', { action: 'delete', id: reel.id });
      panel.close();
      view('reels');
      showToast('Reel deleted.');
    } catch (error) {
      showToast(error.message);
    } finally {
      remove.disabled = false;
    }
  });
  openPanel('Delete this reel?', el('p', '', `Remove “${reel.title}” from Vitreign. The media files stay in your library.`), cancel, remove);
  cancel.focus();
}

function linkField(name, url) {
  const input = el('input');
  input.value = url;
  input.readOnly = true;
  input.setAttribute('aria-label', name);
  const copy = button('Copy link', 'accent-button', 'link');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = 'Copied';
    } catch {
      input.focus();
      input.select();
    }
  });
  return [input, copy];
}

function shareAsset() {
  const item = state.viewing[state.index];
  if (!item) return;
  const url = new URL('/', location.href);
  url.hash = `asset=${item.id}`;
  const content = [el('p', '', state.mode === 'immich'
    ? 'This link opens the item in Vitreign for someone who has access to this workspace.'
    : 'This link opens the item in the sample library on this device.'),
  ...linkField('Vitreign item link', url.href)];
  if (state.shares) {
    const publish = button('Create an Immich guest link');
    publish.addEventListener('click', () => {
      const confirm = button('Create 24-hour link', 'accent-button');
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        try {
          const data = await api('share', { body: { asset: item.id } });
          openPanel('Immich guest link', el('p', '', 'Anyone with this link can view the item for 24 hours. You can revoke it in Immich.'),
            ...linkField('Immich guest link', data.url));
        } catch (error) {
          showToast(error.message);
        } finally {
          confirm.disabled = false;
        }
      });
      openPanel('Create a guest link?', el('p', '', 'Anyone with the link can view this item until it expires. Uploads and original downloads are disabled.'), confirm);
    });
    content.push(publish);
  }
  openPanel('Share this item', ...content);
}

function sourceInfo() {
  if (state.mode === 'immich') {
    openPanel('Immich library', el('p', '', 'Vitreign reads your photos, videos, and albums from the Immich server configured by your workspace operator. Favorites and reels are saved in Vitreign.'));
  } else {
    const details = el('p', '', 'To connect Immich, copy .env.example to .env in the project folder and follow the connection steps in the README.');
    openPanel('Sample library', el('p', '', 'Explore eight synthetic photos and a short sample film. Your favorites and reels are saved on this device.'), details);
  }
}

async function followLink() {
  const id = new URLSearchParams(location.hash.slice(1)).get('asset');
  if (!id || state.locked) return;
  try {
    const item = await api(`asset/${encodeURIComponent(id)}`);
    if (!state.locked) {
      enterWorkspace(false);
      openViewer([item], 0);
    }
  } catch (error) {
    if (!state.locked) showToast(error.message);
  }
}

async function initialize() {
  try {
    const status = await api('status');
    Object.assign(state, status);
    const live = state.mode === 'immich';
    byId('source-title').textContent = live ? 'Immich library' : 'Sample library';
    byId('source-detail').textContent = live ? 'Self-hosted source' : 'On this device';
    byId('top-source-label').textContent = live ? 'Immich source' : 'Sample mode';
    byId('top-source').setAttribute('aria-label', live ? 'Immich source info' : 'Sample mode info');
    document.querySelector('[data-view="albums"]').hidden = !live;
    setLocked(status.locked);
    if (!status.locked) {
      state.saved = await api('state');
      updateHeading();
      await reload();
      await followLink();
    }
  } catch (error) {
    if (state.locked) return;
    byId('hero').hidden = true;
    notice(error.message, true);
  }
}

for (const node of document.querySelectorAll('[data-view]')) {
  node.addEventListener('click', () => view(node.dataset.view));
}
for (const node of document.querySelectorAll('[data-kind]')) {
  node.addEventListener('click', () => { state.kind = node.dataset.kind; updateHeading(); reload(); });
}
for (const node of document.querySelectorAll('[data-close]')) {
  node.addEventListener('click', () => node.closest('dialog').close());
}
for (const dialog of [viewer, panel]) {
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
}
viewer.addEventListener('close', () => byId('viewer-media').replaceChildren());
viewer.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.target.tagName === 'VIDEO') return;
  event.preventDefault();
  stepViewer(event.key === 'ArrowLeft' ? -1 : 1);
});
byId('viewer-prev').addEventListener('click', () => stepViewer(-1));
byId('viewer-next').addEventListener('click', () => stepViewer(1));
byId('favorite').addEventListener('click', async (event) => {
  const control = event.currentTarget;
  const item = state.viewing[state.index];
  if (!item) return;
  control.disabled = true;
  try {
    await persist('favorite', { asset: item.id, enabled: !state.saved.favorites.includes(item.id) });
    updateFavorite();
    if (state.view === 'favorites') reload();
    else renderGrid();
  } catch (error) {
    showToast(error.message);
  } finally {
    control.disabled = false;
  }
});
byId('add-frame').addEventListener('click', chooseReels);
byId('share').addEventListener('click', shareAsset);
byId('new-reel').addEventListener('click', () => createReel());
byId('date-filter').addEventListener('click', dateFilter);
byId('storage-refresh').addEventListener('click', () => reload());
byId('open-restore').addEventListener('click', () => {
  view('restore');
  byId('restore-title').focus({ preventScroll: true });
});
byId('reel-play').addEventListener('click', playReel);
byId('reel-order').addEventListener('click', () => {
  state.ordering = !state.ordering;
  updateHeading();
  renderGrid();
  renderHero();
});
byId('remove-reel').addEventListener('click', confirmDelete);
byId('source-button').addEventListener('click', sourceInfo);
byId('top-source').addEventListener('click', sourceInfo);
byId('back').addEventListener('click', () => view(state.view));
byId('retry').addEventListener('click', initialize);
byId('more').addEventListener('click', () => reload(true));
byId('mobile-menu').addEventListener('click', (event) => {
  const opened = byId('sidebar').classList.toggle('open');
  event.currentTarget.setAttribute('aria-expanded', String(opened));
  event.currentTarget.setAttribute('aria-label', opened ? 'Close navigation' : 'Open navigation');
});
query.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => reload(), 180);
});
byId('search').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  reload();
  byId('library').scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNav();
  if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || state.locked
    || byId('search').hidden || panel.open || viewer.open || byId('screening').open || commands.active()
    || ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
  event.preventDefault();
  query.focus();
});
byId('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const control = form.querySelector('button');
  const input = byId('key');
  control.disabled = true;
  byId('login-error').textContent = '';
  try {
    await api('login', { body: { key: input.value }, auth: false });
    input.value = '';
    await initialize();
  } catch (error) {
    byId('login-error').textContent = error.message;
  } finally {
    control.disabled = false;
  }
});
byId('lock').addEventListener('click', async () => {
  try {
    await api('logout', { body: {} });
    setLocked(true);
  } catch (error) {
    showToast(error.message);
  }
});
window.addEventListener('hashchange', followLink);
compact.addEventListener('change', updateHeading);
startAirlock();

async function begin() {
  const fresh = new URLSearchParams(location.hash.slice(1)).get('welcome');
  if (fresh) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      await api('handoff', { body: { token: fresh }, auth: false });
    } catch {
      // An expired setup link opens the normal workspace unlock screen.
    }
  }
  await initialize();
}
begin();
