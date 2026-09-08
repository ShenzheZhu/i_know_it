const toggle = document.querySelector('#enabled');
const status = document.querySelector('#status');
const description = document.querySelector('#description');
const error = document.querySelector('#error');
const panel = document.querySelector('main');
let current;

function render(state) {
  if (typeof state?.enabled !== 'boolean') throw new Error('State unavailable');
  current = state.enabled;
  toggle.checked = current;
  status.textContent = current ? 'ON' : 'OFF';
  description.textContent = current ? 'Include a context file when pasting into Codex.' : 'Use your ordinary clipboard without added context.';
}

async function load() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'get-state' }));
    toggle.disabled = false;
  } catch {
    status.textContent = 'UNAVAILABLE';
    error.textContent = 'Reopen this panel to reconnect.';
    error.hidden = false;
  } finally { panel.setAttribute('aria-busy', 'false'); }
}

toggle.addEventListener('change', async () => {
  const requested = toggle.checked;
  toggle.disabled = true;
  panel.setAttribute('aria-busy', 'true');
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
    }
    error.hidden = false;
  } finally {
    toggle.disabled = typeof current !== 'boolean';
    panel.setAttribute('aria-busy', 'false');
    if (!toggle.disabled) toggle.focus({ preventScroll: true });
  }
});

void load();
