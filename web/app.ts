type Item = { id: string; title: string; status: 'open' | 'closed'; createdAt: string };
type Activity = { type: 'closed'; occurredAt: string };
type Session = { key: string; abort: AbortController; listVersion: number; historyVersion: number };

class RequestError extends Error {
  constructor(readonly status: number) { super('Request failed'); }
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing element ' + id);
  return value as T;
}

const connectPanel = element('connect-panel');
const workspacePanel = element('workspace-panel');
const scope = element('scope');
const scopeLabel = element('scope-label');
const feedback = element('feedback');
const switchButton = element<HTMLButtonElement>('switch-workspace');
const refreshButton = element<HTMLButtonElement>('refresh');
const connectForm = element<HTMLFormElement>('connect-form');
const createForm = element<HTMLFormElement>('create-form');
const keyInput = element<HTMLInputElement>('key');
const titleInput = element<HTMLInputElement>('title');
const createButton = element<HTMLButtonElement>('create-item');
const emptyItems = element('empty-items');
const itemList = element('items');
const historyItem = element('history-item');
const historyNote = element('history-note');
const events = element('events');
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let session: Session | undefined;

function notice(message: string, error = false): void {
  feedback.textContent = message;
  feedback.dataset.error = String(error);
}

function reset(): void {
  session?.abort.abort();
  session = undefined;
  itemList.replaceChildren();
  events.replaceChildren();
  delete historyItem.dataset.id;
  historyItem.textContent = '';
  historyItem.hidden = true;
  historyNote.textContent = 'Select History on an item to see when it closed.';
  titleInput.value = '';
  createButton.disabled = false;
  keyInput.value = '';
  connectPanel.hidden = false;
  workspacePanel.hidden = true;
  switchButton.hidden = true;
  scope.dataset.connected = 'false';
  scopeLabel.textContent = 'No workspace connected';
  notice('');
}

async function api<T>(current: Session, path = '', method = 'GET', body?: object): Promise<T> {
  const response = await fetch('/v1/items' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + current.key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.any([current.abort.signal, AbortSignal.timeout(7000)]),
  });
  if (!response.ok) throw new RequestError(response.status);
  return response.json() as Promise<T>;
}

function showError(current: Session, error: unknown, fallback: string): void {
  if (session !== current) return;
  if (error instanceof RequestError && error.status === 401) {
    reset();
    notice('That key was not accepted. Check it and try again.', true);
    keyInput.focus();
    return;
  }
  notice(fallback, true);
}

function button(label: string, action: (button: HTMLButtonElement) => Promise<void>): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'quiet';
  control.textContent = label;
  control.addEventListener('click', () => {
    control.disabled = true;
    void action(control).finally(() => { control.disabled = false; });
  });
  return control;
}

function renderItems(current: Session, items: Item[]): void {
  emptyItems.hidden = items.length !== 0;
  itemList.replaceChildren(...items.map((item) => {
    const row = document.createElement('li');
    row.className = 'item';
    const copy = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'item-name';
    title.textContent = item.title;
    const status = document.createElement('span');
    status.className = item.status === 'closed' ? 'badge closed' : 'badge';
    status.textContent = item.status === 'closed' ? 'Closed' : 'Open';
    copy.append(title, status);

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    actions.append(button('History', () => showHistory(current, item)));
    if (item.status === 'open') {
      actions.append(button('Close', async () => {
        try {
          await api<Item>(current, '/' + item.id, 'PATCH', { status: 'closed' });
          await loadItems(current);
          if (session === current) {
            notice('Item closed.');
            refreshButton.focus();
            if (historyItem.dataset.id === item.id) await showHistory(current, item);
          }
        } catch (error) {
          showError(current, error, 'Could not confirm the close. Refresh the list to check its status.');
        }
      }));
    }
    row.append(copy, actions);
    return row;
  }));
}

async function loadItems(current: Session): Promise<void> {
  const version = ++current.listVersion;
  const items = await api<Item[]>(current);
  if (session === current && current.listVersion === version) renderItems(current, items);
}

async function showHistory(current: Session, item: Item): Promise<void> {
  const version = ++current.historyVersion;
  historyItem.dataset.id = item.id;
  historyItem.textContent = item.title;
  historyItem.hidden = false;
  historyNote.textContent = 'Loading history…';
  events.replaceChildren();
  try {
    const entries = await api<Activity[]>(current, '/' + item.id + '/activity');
    if (session !== current || current.historyVersion !== version) return;
    historyNote.textContent = entries.length ? '' : 'No closure recorded for this item.';
    events.replaceChildren(...entries.map((entry) => {
      const event = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = 'Item closed';
      const time = document.createElement('time');
      time.dateTime = entry.occurredAt;
      time.textContent = formatter.format(new Date(entry.occurredAt));
      event.append(label, time);
      return event;
    }));
  } catch (error) {
    if (session !== current || current.historyVersion !== version) return;
    historyNote.textContent = 'Could not load history. Try History again.';
    showError(current, error, 'Could not load this item’s history.');
  }
}

connectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  reset();
  const current: Session = { key, abort: new AbortController(), listVersion: 0, historyVersion: 0 };
  session = current;
  notice('Connecting…');
  void loadItems(current).then(() => {
    if (session !== current) return;
    connectPanel.hidden = true;
    workspacePanel.hidden = false;
    switchButton.hidden = false;
    scope.dataset.connected = 'true';
    scopeLabel.textContent = 'Workspace connected';
    notice('');
    titleInput.focus();
  }).catch((error: unknown) => showError(current, error, 'Could not connect. Check the app and try again.'));
});

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const current = session;
  if (!current || createButton.disabled) return;
  createButton.disabled = true;
  void api<Item>(current, '', 'POST', { title: titleInput.value }).then(async () => {
    if (session !== current) return;
    titleInput.value = '';
    notice('Item created.');
    await loadItems(current);
  }).catch((error: unknown) => {
    showError(current, error, 'Could not confirm the item. Check the title and refresh before retrying.');
  }).finally(() => { if (session === current) createButton.disabled = false; });
});

refreshButton.addEventListener('click', () => {
  const current = session;
  if (!current) return;
  notice('Refreshing…');
  void loadItems(current).then(() => {
    if (session === current) notice('List refreshed.');
  }).catch((error: unknown) => showError(current, error, 'Could not refresh the list. Try again.'));
});

switchButton.addEventListener('click', () => {
  reset();
  keyInput.focus();
});
