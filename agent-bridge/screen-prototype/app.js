const stateLabels = {
  idle: 'IDLE',
  listening: 'LISTENING',
  working: 'WORKING',
  waiting_user: 'WAITING',
  done: 'DONE',
  error: 'ERROR',
};

const stateDetails = {
  idle: 'READY FOR INPUT',
  listening: 'MAC INPUT ACTIVE',
  working: 'AGENT IS WORKING',
  waiting_user: 'NEEDS YOUR INPUT',
  done: 'TASK COMPLETE',
  error: 'CHECK BRIDGE LOG',
};

let currentState = 'idle';

const $ = (selector) => document.querySelector(selector);
const messages = $('#messages');
const draftInput = $('#draft-input');
const composer = $('.composer');

function setState(nextState) {
  currentState = nextState;
  document.body.dataset.state = nextState;
  const label = stateLabels[nextState];
  $('#state-label').textContent = label;
  $('#rail-state').textContent = label;
  $('#rail-detail').textContent = stateDetails[nextState];
  $('#composer-status').textContent = nextState === 'listening' ? 'SYNCING' : 'READY';
  $('#active-meta').textContent = `AGENT · ${label}`;
  $('#active-message').textContent = nextState === 'working'
    ? 'I am preparing the next interface pass'
    : nextState === 'error'
      ? 'The bridge needs your attention'
      : nextState === 'waiting_user'
        ? 'I am waiting for your confirmation'
        : nextState === 'done'
          ? 'The latest task is complete'
          : 'I am ready for the next message';
  composer.classList.toggle('listening', nextState === 'listening');
  document.querySelectorAll('[data-state]').forEach((button) => button.classList.toggle('active', button.dataset.state === nextState));
}

function updateMessageCount() {
  $('#message-count').textContent = `${String(messages.children.length).padStart(2, '0')} MSG`;
}

function addMessage(role, text) {
  const bubble = document.createElement('article');
  bubble.className = `bubble bubble-${role}`;
  const meta = role === 'user'
    ? '<div class="bubble-meta"><span>YOU · NOW</span><span class="avatar avatar-user">U</span></div>'
    : '<div class="bubble-meta"><span class="avatar avatar-agent">A</span><span>AGENT · NOW</span></div>';
  bubble.innerHTML = `${meta}<p></p>`;
  bubble.querySelector('p').textContent = text;
  messages.append(bubble);
  while (messages.children.length > 4) messages.firstElementChild.remove();
  updateMessageCount();
}

function syncDraftFromMac(text) {
  draftInput.value = text;
  draftInput.focus();
  draftInput.setSelectionRange(text.length, text.length);
  $('#composer-label').textContent = 'MAC / DOUBAO INPUT DRAFT';
}

document.querySelectorAll('[data-state]').forEach((button) => {
  button.addEventListener('click', () => setState(button.dataset.state));
});

$('#listen-button').addEventListener('click', () => {
  const next = currentState === 'listening' ? 'idle' : 'listening';
  setState(next);
  if (next === 'listening') syncDraftFromMac('Mac / Doubao transcription appears here');
});

$('#backspace-button').addEventListener('click', () => {
  const start = draftInput.selectionStart ?? draftInput.value.length;
  const end = draftInput.selectionEnd ?? start;
  if (start !== end) draftInput.setRangeText('', start, end, 'end');
  else if (start > 0) draftInput.setRangeText('', start - 1, start, 'end');
  draftInput.focus();
});

$('#enter-button').addEventListener('click', () => {
  $('#send-button').click();
});

$('#send-button').addEventListener('click', () => {
  const value = draftInput.value.trim();
  if (!value || value === 'Try saying something to your agent') return;
  addMessage('user', value);
  draftInput.value = '';
  setState('working');
  window.setTimeout(() => {
    addMessage('agent', 'Received. I am working on that now.');
    setState('done');
  }, 650);
});

draftInput.addEventListener('input', () => {
  $('#composer-status').textContent = draftInput.value ? 'DRAFT' : 'READY';
});

setState('idle');
updateMessageCount();
