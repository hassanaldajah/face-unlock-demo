/**
 * eventlog.js: a tiny SOC-style security event log.
 *
 * Every security-relevant thing the app does (enrollment, match, mismatch,
 * liveness pass/fail, unlock, lockout, setting changes) becomes one event.
 * Events are kept in memory only (they vanish when the tab closes) and can be
 * exported as JSON shaped like the Elastic Common Schema (ECS), the format
 * many SIEMs ingest, so the export reads like a real authentication log.
 *
 * No images and no face descriptors ever go into the log, only numbers like
 * the match distance.
 */

/** Level -> label + icon. A colour is never the only signal. */
const LEVELS = {
  info:    { label: 'INFO',  icon: 'i' },
  success: { label: 'OK',    icon: '✓' },
  warn:    { label: 'WARN',  icon: '!' },
  alert:   { label: 'ALERT', icon: '▲' },
};

export class EventLog {
  /**
   * @param {HTMLElement} list   the <ol> rows are rendered into
   * @param {HTMLElement} empty  "no events yet" placeholder
   * @param {number} max         oldest events are dropped past this
   */
  constructor(list, empty, max = 300) {
    this.list = list;
    this.empty = empty;
    this.max = max;
    this.events = [];
  }

  /**
   * Record one event.
   * @param {string} action   short machine name, e.g. "face_match"
   * @param {object} opts     { level, outcome, message, fields }
   */
  add(action, { level = 'info', outcome, message = '', fields = {} } = {}) {
    const event = { time: new Date(), action, level, outcome, message, fields };
    this.events.push(event);
    if (this.events.length > this.max) {
      this.events.shift();
      this.list.lastElementChild?.remove();
    }
    this.render(event);
    return event;
  }

  /** Prepend one row (newest on top). textContent only: no HTML injection. */
  render(event) {
    const { label, icon } = LEVELS[event.level] ?? LEVELS.info;
    const li = document.createElement('li');
    li.className = `ev ev-${event.level}`;

    const time = document.createElement('time');
    time.dateTime = event.time.toISOString();
    time.textContent = event.time.toLocaleTimeString([], { hour12: false });

    const badge = document.createElement('span');
    badge.className = 'ev-badge';
    const iconEl = document.createElement('i');
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = icon;
    badge.append(iconEl, label);

    const action = document.createElement('code');
    action.className = 'ev-action';
    action.textContent = event.action;

    const msg = document.createElement('span');
    msg.className = 'ev-msg';
    msg.textContent = event.message;

    li.append(time, badge, action, msg);
    this.list.prepend(li);
    this.empty.hidden = true;
  }

  clear() {
    this.events = [];
    this.list.replaceChildren();
    this.empty.hidden = false;
  }

  /** The log as ECS-style documents. */
  toECS() {
    return this.events.map((e) => ({
      '@timestamp': e.time.toISOString(),
      'event.kind': e.level === 'alert' ? 'alert' : 'event',
      'event.category': ['authentication'],
      'event.action': e.action,
      ...(e.outcome && { 'event.outcome': e.outcome }),
      'log.level': e.level,
      message: e.message,
      ...Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [`face_unlock.${k}`, v])),
      'observer.product': 'face-unlock-demo',
      'user_agent.original': navigator.userAgent,
    }));
  }

  /** Download the log as a JSON file (built in the browser, nothing is sent). */
  download() {
    const blob = new Blob([JSON.stringify(this.toECS(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `face-unlock-events-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
