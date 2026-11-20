const byId = (id) => document.getElementById(id);
const status = byId('setup-status');
const token = new URLSearchParams(location.hash.slice(1)).get('setup');
if (location.hash) history.replaceState(null, '', '/');
const controls = byId('setup-controls');
const setupForm = byId('setup-form');
const urlField = byId('setup-url');
const secret = byId('setup-workspace-key');
controls.hidden = !token;
if (!token) status.textContent = 'Open this setup page from the Vitreign launcher.';

function updateImmichLink() {
  const link = byId('open-immich');
  link.hidden = true;
  try {
    const url = new URL(urlField.value.trim());
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      link.href = url.origin;
      link.hidden = false;
    }
  } catch {
    link.removeAttribute('href');
  }
}
urlField.addEventListener('input', updateImmichLink);
updateImmichLink();

async function finish(body) {
  const buttons = controls.querySelectorAll('button');
  for (const button of buttons) button.disabled = true;
  status.textContent = body.mode === 'immich' ? 'Checking your Immich connection…' : 'Opening the sample library…';
  try {
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    controls.hidden = true;
    byId('setup-key').value = '';
    byId('open-gallery').href = result.gallery;
    byId('workspace-secret').hidden = !result.accessKey;
    secret.value = result.accessKey || '';
    byId('setup-summary').textContent = !result.accessKey ? 'The included photo and video library is ready to explore.'
      : result.empty ? 'Immich connected. Add photos or videos in Immich and they will appear in your gallery.'
      : 'Immich connected. Save the workspace key for future sign-ins.';
    byId('setup-ready').hidden = false;
    status.textContent = '';
    byId('setup-ready-title').focus();
  } catch (error) {
    status.textContent = error instanceof TypeError ? 'Setup is unavailable. Reopen the Vitreign launcher to try again.' : error.message;
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  finish({ mode: 'immich', url: urlField.value, key: byId('setup-key').value });
});
byId('try-library').addEventListener('click', () => finish({ mode: 'sample' }));
byId('copy-workspace-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(secret.value);
    status.textContent = 'Workspace key copied.';
  } catch {
    secret.focus();
    secret.select();
  }
});
