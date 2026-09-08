const toggle = document.querySelector('#enabled');
const status = document.querySelector('#status');
const description = document.querySelector('#description');
const error = document.querySelector('#error');
const panel = document.querySelector('main');
const inputStatus = document.querySelector('#input-status');
const allowRegion = document.querySelector('#allow-region');
let current;

function renderInput(value) {
  inputStatus.hidden = !current;
  inputStatus.textContent = {
    ready: 'Region selection monitoring is on.',
    'permission-required': 'Allow macOS Input Monitoring to add selection coordinates. Keystrokes are not stored.',
    unavailable: 'Region monitoring unavailable. Restart Chrome to retry.',
    off: 'Region selection monitoring is off.',
  }[value] ?? 'Companion unavailable. Reopen Chrome after installing it.';
  allowRegion.hidden = !current || value !== 'permission-required';
}

function render(state) {
  if (typeof state?.enabled !== 'boolean') throw new Error('State unavailable');
  current = state.enabled;
  toggle.checked = current;
  status.textContent = current ? 'ON' : 'OFF';
  description.textContent = current ? 'Include a context file when pasting into Codex.' : 'Use your ordinary clipboard without added context.';
  renderInput(state.inputStatus);
}

async function load() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'get-state' }));
    toggle.disabled = false;
  } catch {
    status.textContent = 'UNAVAILABLE';
    error.textContent = 'Reopen this panel to reconnect.';
    error.hidden = false;
    inputStatus.hidden = true;
    allowRegion.hidden = true;
  } finally { panel.setAttribute('aria-busy', 'false'); }
}

toggle.addEventListener('change', async () => {
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
  allowRegion.disabled = true;
  error.hidden = true;
  try { await chrome.runtime.sendMessage({ type: 'request-input-access' }); }
  catch {
    error.textContent = 'Permission request could not be sent. Reopen this panel to retry.';
    error.hidden = false;
  } finally { allowRegion.disabled = false; }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender?.id === chrome.runtime.id && sender.tab === undefined
    && message?.type === 'input-status') renderInput(message.inputStatus);
});

void load();
