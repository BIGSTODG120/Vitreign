export function makeRestore(byId) {
  const original = byId('restore-source');
  const restored = byId('restore-copy');
  const compare = byId('restore-start');
  const cancel = byId('restore-cancel');
  const progress = byId('restore-progress');
  const meter = byId('restore-meter');
  const result = byId('restore-result');
  const detail = byId('restore-detail');
  const number = new Intl.NumberFormat();
  let worker;

  function stop() {
    worker?.terminate();
    worker = null;
    original.disabled = restored.disabled = false;
    compare.disabled = !(original.files.length && restored.files.length);
    cancel.hidden = true;
    meter.hidden = true;
  }

  function show(kind, headline, explanation = '') {
    result.dataset.kind = kind;
    result.textContent = headline;
    detail.textContent = explanation;
  }

  function reset() {
    original.value = '';
    restored.value = '';
    stop();
    show('', '');
  }

  for (const field of [original, restored]) field.addEventListener('change', () => {
    stop();
    show('', '');
  });

  cancel.addEventListener('click', () => {
    stop();
    show('', 'Check canceled.');
    compare.focus();
  });

  compare.addEventListener('click', () => {
    const source = original.files[0];
    const copy = restored.files[0];
    if (!source || !copy || worker) return;
    let task;
    try {
      task = new Worker('/restore-worker.js', { type: 'module' });
    } catch {
      show('error', 'File checking is unavailable in this browser.');
      return;
    }
    worker = task;
    original.disabled = restored.disabled = compare.disabled = true;
    cancel.hidden = false;
    meter.hidden = false;
    progress.value = 0;
    show('', 'Comparing files…');
    task.addEventListener('message', ({ data }) => {
      if (worker !== task) return;
      if (data.progress) {
        progress.value = 100 * data.progress.checked / data.progress.size;
        return;
      }
      stop();
      if (data.error) return show('error', data.error);
      const checked = data.result;
      if (checked.kind === 'match') {
        show('match', 'Byte-for-byte match.', `All ${number.format(checked.size)} bytes match across the two selected files.`);
      } else if (checked.kind === 'size') {
        show('difference', 'File sizes differ.', `Original has ${number.format(checked.sourceBytes)} bytes. Restored copy has ${number.format(checked.restoredBytes)} bytes.`);
      } else {
        show('difference', 'File contents differ.', `The first difference is at byte ${number.format(checked.offset + 1)}.`);
      }
    });
    task.addEventListener('error', () => {
      if (worker !== task) return;
      stop();
      show('error', 'The file check could not finish. Try selecting the files again.');
    });
    try {
      task.postMessage({ source, restored: copy });
    } catch {
      stop();
      show('error', 'The browser could not open the selected file pair.');
    }
  });
  return { reset };
}
