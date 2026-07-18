const summary = document.querySelector('#summary');
const state = document.querySelector('#state');
const result = document.querySelector('#result');
const prepare = document.querySelector('#prepare');

async function load() {
  const response = await browser.runtime.sendMessage({ type: 'rollback/status' });
  const current = response?.record?.state ?? 'unknown';
  state.textContent = current;
  if (current === 'ready-for-final') {
    summary.textContent = 'Legacy Settings is running and the profile passed the rollback checks.';
    prepare.hidden = false;
  } else if (current === 'blocked-corrupt') {
    summary.textContent =
      'Rollback is blocked because a native Settings operation could not be proved complete. Keep this transition build installed for recovery.';
  } else {
    summary.textContent = 'The transition build has not reached its final installation gate.';
  }
}

prepare.addEventListener('click', async () => {
  prepare.disabled = true;
  result.textContent = 'Checking the profile…';
  const response = await browser.runtime.sendMessage({
    type: 'rollback/prepare-final',
    confirm: true,
  });
  if (response?.ok && response.prepared) {
    result.textContent =
      'Profile prepared. Shut down Bento now, then install the staged final rollback build.';
    prepare.hidden = true;
    state.textContent = 'prepared-for-final';
    return;
  }
  prepare.disabled = false;
  result.textContent = `Preparation failed: ${response?.error ?? 'unknown error'}`;
});

void load().catch((error) => {
  summary.textContent = 'The rollback status could not be read.';
  result.textContent = String(error);
});
