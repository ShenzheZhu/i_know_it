const toggle = document.querySelector('#enabled');
const status = document.querySelector('#status');
const description = document.querySelector('#description');
const error = document.querySelector('#error');
const panel = document.querySelector('main');
const inputStatus = document.querySelector('#input-status');
const allowRegion = document.querySelector('#allow-region');
let current;
let inputRevision = 0;

function renderInput(value) {
  inputRevision++;
  inputStatus.hidden = !current;
  inputStatus.textContent = {
    ready: 'Region selection monitoring is on.',
    'permission-required': 'Allow macOS Input Monitoring to enhance Chrome screenshots. Keystrokes are not stored.',
    unavailable: 'Region monitoring unavailable. Restart Chrome to retry.',
    off: 'Region selection monitoring is off.',
  }[value] ?? 'Companion unavailable. Reopen Chrome after installing it.';
  allowRegion.hidden = !current || value !== 'permission-required';
  allowRegion.disabled = toggle.disabled;
}

function render(state) {
  if (typeof state?.enabled !== 'boolean') throw new Error('State unavailable');
  current = state.enabled;
  toggle.checked = current;
  status.textContent = current ? 'ON' : 'OFF';
  description.textContent = current ? 'Add context to Chrome screenshots pasted into Codex.' : 'Use your ordinary clipboard without added context.';
  renderInput(state.inputStatus);
}

async function load() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'get-state' }));
    toggle.disabled = false;
    allowRegion.disabled = false;
  } catch {
    status.textContent = 'UNAVAILABLE';
    error.textContent = 'Reopen this panel to reconnect.';
    error.hidden = false;
    inputStatus.hidden = true;
    allowRegion.hidden = true;
  } finally { panel.setAttribute('aria-busy', 'false'); }
}

toggle.addEventListener('change', async () => {
  inputRevision++;
  const requested = toggle.checked;
  toggle.disabled = true;
  panel.setAttribute('aria-busy', 'true');
  allowRegion.disabled = true;
  error.hidden = true;
  try {
    render(await chrome.runtime.sendMessage({ type: 'set-enabled', enabled: requested }));
  } catch {
    try {
      render(await chrome.runtime.sendMessage({ type: 'get-state' }));
      error.textContent = 'Connection interrupted. Check the setting and try again.';
    } catch {
      current = undefined;
      status.textContent = 'UNAVAILABLE';
      error.textContent = 'Reopen this panel to reconnect.';
      inputStatus.hidden = true;
      allowRegion.hidden = true;
    }
    error.hidden = false;
  } finally {
    toggle.disabled = typeof current !== 'boolean';
    allowRegion.disabled = false;
    panel.setAttribute('aria-busy', 'false');
    if (!toggle.disabled) toggle.focus({ preventScroll: true });
  }
});

allowRegion.addEventListener('click', async () => {
  let revision = ++inputRevision;
  allowRegion.disabled = true;
  error.hidden = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'request-input-access' });
    if (revision !== inputRevision || !current) return;
    render(reply);
    revision = inputRevision;
    if (!current || reply.inputStatus !== 'permission-required') return;
    inputStatus.textContent = reply.permissionRequestSent === true
      ? 'If no macOS dialog appears, open System Settings > Privacy & Security > Input Monitoring, allow the entry shown by macOS, then return to Chrome.'
      : reply.permissionRequestSent === false
        ? 'Permission request could not be sent. Reopen this panel to retry.'
        : 'Could not confirm the permission request. Reopen this panel to retry.';
  }
  catch {
    if (revision === inputRevision && current) {
      inputStatus.textContent = 'Could not confirm the permission request. Reopen this panel to retry.';
    }
  } finally { if (revision === inputRevision) allowRegion.disabled = toggle.disabled; }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender?.id === chrome.runtime.id && sender.tab === undefined
    && message?.type === 'input-status') renderInput(message.inputStatus);
});

void load();
