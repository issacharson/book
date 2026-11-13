// Booking notifications (lead-desk#209): email careshow-team@ once for each
// demo booked, cancelled or moved on the Issac Harson Demos calendar, so every
// booking lands in the Care Show team's collaborative inbox as a conversation
// the team can assign and complete.
//
// Why this exists: Care Show team is a co-host on every booking page, but
// Calendar sends the invitation to each member by name and never posts to the
// group itself (OBSERVED in a test booking, 13 Nov 2026). People are told; the
// shared inbox isn't.
//
// How it finds changes: a calendar trigger fires on any change to the calendar
// but doesn't say which event changed, so each run lists what changed since the
// last run with a sync token (Calendar advanced service, Events.list). A sweep
// every 15 minutes runs the same code in case a trigger is missed.
//
// What counts: only events whose title is a booking page's title, as Google
// names them, "<page title> (<booker's name>)". Events typed in by hand are
// left alone. The titles below must match LINKS in scripts/build.mjs: a unit
// test checks that.
//
// Lives in issacharson/book with the booking links, independent of the Lead
// Desk: it never reads or writes the register. This project reads the demos
// calendar and sends email, nothing else.

var BN = {
  NOTIFY_TO: 'careshow-team@issacharson.com', // Script property NOTIFY_TO overrides it
  CALENDAR_PROP: 'DEMOS_CALENDAR_ID', // Script property: the Issac Harson Demos calendar's ID
  SYNC_TOKEN: 'BN_SYNC_TOKEN',
  LAST_RUN: 'BN_LAST_RUN',
  LAST_RESULT: 'BN_LAST_RESULT',
  BOOKING: 'BN_BOOKING_', // + event ID: what was last told about that booking
  SWEEP_MINUTES: 15,
  TIME_ZONE: 'Europe/London',
  TEAM_DOMAIN: '@issacharson.com',
  MAX_DETAILS: 1500,
  README: 'https://github.com/issacharson/book#booking-notifications',
  PAGES: ['CareMatchr demo', 'CareMatchr DBS demo', 'Privacy A to Z readiness check'],
};

// Run by both triggers, and from the editor. Emails careshow-team@ for each
// booking change since the last run. Returns what it did, which is also logged
// and kept as the last result. If an email can't be sent it throws, so the run
// shows as failed and Apps Script tells the project's owner; the next run tries
// that booking again, and bookings already told aren't told twice.
function notifyBookings() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: true, skipped: 'another run was in progress' };
  try {
    return run_();
  } finally {
    lock.releaseLock();
  }
}

// Turns the notifications on (run once from the editor, as workspace-admin@).
// Checks the calendar can be read, creates both triggers, and runs once. The
// first run records the bookings already on the calendar and emails nothing.
function startBookingNotify() {
  var id = calendarId_();
  var calendar = Calendar.Calendars.get(id); // throws if this account can't read it
  stopBookingNotify();
  ScriptApp.newTrigger('notifyBookings').forUserCalendar(id).onEventUpdated().create();
  ScriptApp.newTrigger('notifyBookings').timeBased().everyMinutes(BN.SWEEP_MINUTES).create();
  var result = notifyBookings();
  result.calendar = calendar.summary;
  return result;
}

function stopBookingNotify() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'notifyBookings') ScriptApp.deleteTrigger(t);
  });
}

// Proves an email from this account becomes a conversation in the group: run
// from the editor after set-up, then look for it in the careshow-team@
// conversations.
function sendTestNotice() {
  var to = notifyTo_();
  MailApp.sendEmail({
    to: to,
    subject: 'TEST: booking notifications can reach this group',
    body: 'This is a test from Booking notifications (lead-desk#209). Nothing has been booked.\n\n' +
      'It was sent to prove that a booking email would arrive here as a conversation. Mark it No action needed.',
  });
  return { ok: true, to: to };
}

function notifyTo_() {
  return PropertiesService.getScriptProperties().getProperty('NOTIFY_TO') || BN.NOTIFY_TO;
}

function calendarId_() {
  var id = PropertiesService.getScriptProperties().getProperty(BN.CALENDAR_PROP);
  if (!id) {
    throw new Error('Set the Script property ' + BN.CALENDAR_PROP + ' to the Issac Harson Demos calendar ID ' +
      '(Google Calendar › the calendar’s Settings › Integrate calendar › Calendar ID). See ' + BN.README);
  }
  return String(id).trim();
}

function run_() {
  var props = PropertiesService.getScriptProperties();
  var now = new Date();
  var result = { ok: true, at: now.toISOString(), changes: 0, told: [] };
  var lastRun = props.getProperty(BN.LAST_RUN);
  var listed;
  try {
    listed = listChanges_(calendarId_(), props.getProperty(BN.SYNC_TOKEN), now);
  } catch (error) {
    if (!isExpiredToken_(error)) throw error;
    // Google dropped the sync token (it does, now and then): start again from a
    // full list. Bookings made since the last good run are still told.
    props.deleteProperty(BN.SYNC_TOKEN);
    listed = listChanges_(calendarId_(), null, now);
    result.restarted = true;
  }
  result.changes = listed.items.length;
  var problem = null;
  for (var i = 0; i < listed.items.length && !problem; i++) {
    try {
      var told = handle_(listed.items[i], now, listed.full, lastRun);
      if (told) result.told.push(told);
    } catch (error) {
      problem = error;
    }
  }
  result.forgotten = forgetOld_(now);
  if (problem) {
    // Keep the old sync token, so the next run sees these changes again.
    result.ok = false;
    result.error = String((problem && problem.message) || problem);
  } else {
    if (listed.nextSyncToken) props.setProperty(BN.SYNC_TOKEN, listed.nextSyncToken);
    props.setProperty(BN.LAST_RUN, now.toISOString());
    if (listed.full) result.firstRun = !lastRun;
  }
  props.setProperty(BN.LAST_RESULT, JSON.stringify(result));
  console.log('booking notifications: ' + JSON.stringify(result));
  if (problem) {
    throw new Error('Booking notifications could not email ' + notifyTo_() + ' (' + result.error +
      '). The next run tries again. See the last result in Script properties.');
  }
  return result;
}

// Every changed event since the sync token, or, with no token, every event
// from a day ago onwards. The token for next time is on the last page.
function listChanges_(calendarId, syncToken, now) {
  var items = [];
  var pageToken = null;
  var page;
  do {
    var options = { maxResults: 250 };
    if (syncToken) options.syncToken = syncToken;
    else options.timeMin = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    if (pageToken) options.pageToken = pageToken;
    page = Calendar.Events.list(calendarId, options);
    items = items.concat(page.items || []);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { items: items, nextSyncToken: page.nextSyncToken, full: !syncToken };
}

function isExpiredToken_(error) {
  return /\b410\b|full sync is required|sync token is no longer valid/i.test(String((error && error.message) || error));
}

// The booking page an event came from, or '' for any other event.
function pageOf_(title) {
  var t = String(title || '');
  for (var i = 0; i < BN.PAGES.length; i++) {
    var page = BN.PAGES[i];
    if (t === page || t.indexOf(page + ' (') === 0) return page;
  }
  return '';
}

// The booker's name from "<page> (<name>)".
function bookerName_(title, page) {
  var rest = String(title || '').slice(page.length).trim();
  var found = /^\((.*)\)$/.exec(rest);
  return found ? found[1].trim() : '';
}

function startOf_(event) {
  var s = event.start || {};
  return s.dateTime || s.date || '';
}

function endOf_(event) {
  var e = event.end || {};
  return e.dateTime || e.date || '';
}

// What we keep about a booking, so a cancellation (which arrives as an ID
// only) can say what was cancelled, and a booking is never told twice.
function remembered_(id) {
  var raw = PropertiesService.getScriptProperties().getProperty(BN.BOOKING + id);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

function remember_(id, record) {
  PropertiesService.getScriptProperties().setProperty(BN.BOOKING + id, JSON.stringify(record));
}

function forget_(id) {
  PropertiesService.getScriptProperties().deleteProperty(BN.BOOKING + id);
}

// Drop bookings that ended more than a day ago. Returns how many.
function forgetOld_(now) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var dropped = 0;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(BN.BOOKING) !== 0) return;
    var record;
    try { record = JSON.parse(all[key]); } catch (e) { record = null; }
    var end = record && new Date(record.end || record.start);
    if (!record || isNaN(end) || end.getTime() < now.getTime() - 24 * 3600 * 1000) {
      props.deleteProperty(key);
      dropped++;
    }
  });
  return dropped;
}

// One changed event. Emails the group if it's a new, cancelled or moved booking
// and returns what was told; returns '' otherwise. On a full list, a booking is
// only told if it was made after the last good run (so the first run tells
// nobody, and a restart after a dropped token misses nothing).
function handle_(event, now, full, lastRun) {
  var id = event.id;
  if (!id) return '';
  var before = remembered_(id);

  if (event.status === 'cancelled') {
    if (!before) return '';
    send_('cancelled', before);
    forget_(id);
    return 'cancelled ' + id;
  }

  var page = pageOf_(event.summary);
  if (!page) return '';
  var start = startOf_(event);
  if (!start || new Date(endOf_(event) || start).getTime() < now.getTime()) return '';

  var record = {
    page: page,
    name: bookerName_(event.summary, page) || bookerFromGuests_(event).name,
    emails: bookerFromGuests_(event).emails,
    start: start,
    end: endOf_(event),
    meet: event.hangoutLink || '',
    link: event.htmlLink || '',
    details: String(event.description || '').slice(0, BN.MAX_DETAILS),
  };

  if (!before) {
    var isNew = !full || (lastRun && new Date(event.created || 0).getTime() > new Date(lastRun).getTime());
    if (isNew) send_('booked', record);
    remember_(id, record);
    return isNew ? 'booked ' + id : '';
  }
  if (before.start !== start) {
    record.was = before.start;
    send_('moved', record);
    delete record.was;
    remember_(id, record);
    return 'moved ' + id;
  }
  remember_(id, record);
  return '';
}

// The booker: guests outside issacharson.com (the team and the group are
// guests too, as co-hosts).
function bookerFromGuests_(event) {
  var outside = (event.attendees || []).filter(function (a) {
    var email = String(a.email || '').toLowerCase();
    return email && !a.resource && !a.organizer && email.slice(-BN.TEAM_DOMAIN.length) !== BN.TEAM_DOMAIN;
  });
  return {
    emails: outside.map(function (a) { return a.email; }),
    name: outside.length ? String(outside[0].displayName || '') : '',
  };
}

function when_(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return Utilities.formatDate(d, BN.TIME_ZONE, 'EEE d MMM, HH:mm');
}

function whenLong_(start, end) {
  var s = new Date(start);
  if (isNaN(s)) return String(start);
  var text = Utilities.formatDate(s, BN.TIME_ZONE, 'EEEE d MMMM yyyy, HH:mm');
  var e = new Date(end);
  if (!isNaN(e)) text += '–' + Utilities.formatDate(e, BN.TIME_ZONE, 'HH:mm');
  return text + ' (UK time)';
}

function send_(kind, booking) {
  var who = booking.name || 'someone';
  var headline = { booked: 'Demo booked', cancelled: 'Demo cancelled', moved: 'Demo moved' }[kind];
  var subject = headline + ': ' + booking.page + ', ' + when_(booking.start) + ', ' + who;
  var lines = [];
  if (kind === 'booked') lines.push('A demo has been booked on the ' + booking.page + ' booking page.');
  if (kind === 'cancelled') lines.push('This booking on the ' + booking.page + ' page has been cancelled. Nobody needs to join it.');
  if (kind === 'moved') lines.push('This booking on the ' + booking.page + ' page has moved. It was ' + whenLong_(booking.was, '') + '.');
  lines.push('');
  lines.push('When: ' + whenLong_(booking.start, booking.end));
  lines.push('Who: ' + who);
  if (booking.emails && booking.emails.length) lines.push('Email: ' + booking.emails.join(', '));
  if (kind !== 'cancelled' && booking.meet) lines.push('Meet: ' + booking.meet);
  if (kind !== 'cancelled' && booking.link) lines.push('In Calendar: ' + booking.link);
  if (kind !== 'cancelled' && booking.details) {
    lines.push('');
    lines.push('What Google holds for this booking:');
    lines.push(booking.details);
  }
  lines.push('');
  if (kind === 'booked') lines.push('Next: in the Care Show team inbox, choose Assign to me, then confirm the demo with them.');
  if (kind === 'cancelled') lines.push('Next: whoever has the booking may want to offer them another time. Then mark this conversation complete.');
  if (kind === 'moved') lines.push('Next: whoever has the booking checks they can still make the new time.');
  lines.push('');
  lines.push('Sent by Booking notifications (lead-desk#209) for the team only. The booker gets Google\'s own email.');
  MailApp.sendEmail({ to: notifyTo_(), subject: subject, body: lines.join('\n') });
}
