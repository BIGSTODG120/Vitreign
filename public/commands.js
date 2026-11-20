export function makeCommands(byId, icon, getCommands, canOpen) {
  const dialog = byId('commands');
  const input = byId('command-query');
  const list = byId('command-results');
  let active = 0;
  let options = [];
  let rows = [];
  let previousFocus;

  function highlight(index, scroll = false) {
    if (!rows.length) return;
    active = (index + rows.length) % rows.length;
    for (const [position, row] of rows.entries()) row.setAttribute('aria-selected', String(position === active));
    input.setAttribute('aria-activedescendant', rows[active].id);
    if (scroll) rows[active].scrollIntoView({ block: 'nearest' });
  }

  function run(index) {
    const action = options[index];
    if (!action || !canOpen()) return;
    dialog.close('run');
    action.run();
  }

  function render() {
    options = getCommands(input.value.trim());
    rows = options.map((action, index) => {
      const row = document.createElement('button');
      row.id = `command-option-${index}`;
      row.type = 'button';
      row.tabIndex = -1;
      row.setAttribute('role', 'option');
      row.append(icon(action.icon), action.label);
      row.addEventListener('click', () => run(index));
      return row;
    });
    list.replaceChildren(...rows);
    if (!rows.length) input.removeAttribute('aria-activedescendant');
    highlight(0);
  }

  function open() {
    if (dialog.open || !canOpen()) return;
    previousFocus = document.activeElement;
    dialog.returnValue = '';
    input.value = '';
    render();
    dialog.showModal();
    input.setAttribute('aria-expanded', 'true');
    input.focus();
  }

  byId('open-commands').addEventListener('click', open);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || !rows.length) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(active + (event.key === 'ArrowDown' ? 1 : -1), true);
    }
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    input.setAttribute('aria-expanded', 'false');
    if (dialog.returnValue !== 'run' && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || event.key.toLowerCase() !== 'k' || event.altKey
      || !(event.ctrlKey || event.metaKey) || (!dialog.open && !canOpen())) return;
    event.preventDefault();
    if (dialog.open) dialog.close();
    else open();
  });
  return { close: () => { if (dialog.open) dialog.close(); }, active: () => dialog.open };
}
