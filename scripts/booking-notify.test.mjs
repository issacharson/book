// Booking notifications (booking-notify/Code.gs) in Node, with fakes of the
// Calendar advanced service, MailApp and the rest (lead-desk#209). It emails
// careshow-team@ for each demo booked, cancelled or moved. Whether Google's
// calendar trigger and the group's inbox behave as these fakes do is what the
// live check after set-up finds out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { LINKS } from "./build.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE = fs.readFileSync(path.join(root, "booking-notify", "Code.gs"), "utf8");
const CAL = "demos@group.calendar.google.com";
const NOW = new Date("2026-11-13T14:00:00Z");

// A booking as Google's Events.list returns it. Made-up people only.
const booking = (id, { page = "CareMatchr demo", name = "Ada Example", start = "2026-11-16T10:00:00Z", end = "2026-11-16T10:30:00Z", created = "2026-11-13T13:59:00Z", email = "ada@example.org" } = {}) => ({
  id, status: "confirmed", summary: `${page} (${name})`, created,
  start: { dateTime: start }, end: { dateTime: end },
  hangoutLink: "https://meet.google.com/aaa-bbbb-ccc", htmlLink: `https://calendar.example/${id}`,
  description: "<b>Booked by</b>\nAda Example\nada@example.org\n<br><b>Organisation</b>\nExample Care &amp; Co Ltd\n<br>A 30-minute demo.",
  organizer: { email: CAL, self: false },
  attendees: [
    { email: "toye.akande@issacharson.com", organizer: false },
    { email: "careshow-team@issacharson.com" },
    { email, displayName: name },
  ],
});

// `changes` is what each call to Events.list returns in turn: a list of pages
// ({ items, nextPageToken?, nextSyncToken? }) or an Error to throw.
function setup({ props = {}, changes = [], mailFails = 0, calendarMissing = false } = {}) {
  const store = { DEMOS_CALENDAR_ID: CAL, ...props };
  const sent = [];
  const listed = [];
  const triggers = [];
  let failures = mailFails;
  let call = 0;
  let pageInCall = 0;
  const ctx = {
    console: { log: () => {}, error: () => {} }, JSON, Math, Object, Array, String, Number, RegExp, Error, isNaN,
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW.getTime(); } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => store[k] ?? null,
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; },
      getProperties: () => ({ ...store }),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: (d, tz, fmt) => `${d.toISOString()}|${fmt}` },
    MailApp: { sendEmail: (mail) => { if (failures > 0) { failures--; throw new Error("Service invoked too many times"); } sent.push(mail); } },
    Calendar: {
      Calendars: { get: (id) => { if (calendarMissing) throw new Error("Not Found"); return { id, summary: "Issac Harson Demos" }; } },
      Events: { list: (id, options) => {
        listed.push({ id, options: { ...options } });
        const answer = changes[call];
        if (answer instanceof Error) { call++; throw answer; }
        const pages = answer || [{ items: [], nextSyncToken: `token-${call + 1}` }];
        const page = pages[pageInCall] || { items: [] };
        if (page.nextPageToken) pageInCall++; else { pageInCall = 0; call++; }
        return page;
      } },
    },
    ScriptApp: {
      newTrigger: (fn) => ({
        forUserCalendar: (calendarId) => ({ onEventUpdated: () => ({ create: () => triggers.push({ fn, calendarId }) }) }),
        timeBased: () => ({ everyMinutes: (minutes) => ({ create: () => triggers.push({ fn, minutes }) }) }),
      }),
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, t })),
      deleteTrigger: (handle) => triggers.splice(triggers.indexOf(handle.t), 1),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${CODE}\nthis.BN = BN;`, ctx);
  return { ctx, store, sent, listed, triggers };
}

const SEEN = { BN_SYNC_TOKEN: "token-0", BN_LAST_RUN: "2026-11-13T13:45:00.000Z" };

test("the page titles are the booking links' titles in scripts/build.mjs", () => {
  const { ctx } = setup();
  assert.deepEqual([...ctx.BN.PAGES].sort(), LINKS.map((l) => l.title).sort());
});

test("its scopes are reading calendars, sending email and its own triggers, with the Calendar advanced service", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "booking-notify", "appsscript.json"), "utf8"));
  assert.deepEqual(manifest.oauthScopes.sort(), [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/script.send_mail",
  ]);
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: "Calendar", serviceId: "calendar", version: "v3" }]);
  assert.equal(manifest.timeZone, "Europe/London");
});

test("the first run records the bookings already there and emails nobody", () => {
  const { ctx, sent, store, listed } = setup({ changes: [[{ items: [booking("e1"), booking("e2")], nextSyncToken: "token-1" }]] });
  const result = ctx.notifyBookings();
  assert.equal(sent.length, 0);
  assert.equal(result.firstRun, true);
  assert.equal(store.BN_SYNC_TOKEN, "token-1");
  assert.ok(store.BN_BOOKING_e1 && store.BN_BOOKING_e2);
  assert.equal(listed[0].id, CAL);
  assert.equal(listed[0].options.syncToken, undefined);
  assert.equal(listed[0].options.timeMin, "2026-11-12T14:00:00.000Z");
});

test("a new booking sends one email to careshow-team@ with the page, time, booker and Meet link", () => {
  const { ctx, sent, store, listed } = setup({ props: SEEN, changes: [[{ items: [booking("e1")], nextSyncToken: "token-1" }]] });
  const result = ctx.notifyBookings();
  assert.equal(listed[0].options.syncToken, "token-0");
  assert.equal(sent.length, 1);
  const mail = sent[0];
  assert.equal(mail.to, "careshow-team@issacharson.com");
  assert.match(mail.subject, /^Demo booked: CareMatchr demo, 2026-11-16T10:00:00\.000Z\|EEE d MMM, HH:mm, Ada Example$/);
  assert.match(mail.body, /booked on the CareMatchr demo booking page/);
  assert.match(mail.body, /Email: ada@example\.org\n/);
  assert.doesNotMatch(mail.body, /Email: .*issacharson\.com/, "the team and the group aren't the booker");
  assert.match(mail.body, /Meet: https:\/\/meet\.google\.com\/aaa-bbbb-ccc/);
  assert.match(mail.body, /Booked by\nAda Example\nada@example\.org\n\nOrganisation\nExample Care & Co Ltd\n\nA 30-minute demo\./, "Google's HTML details read as plain text");
  assert.doesNotMatch(mail.body, /<\/?b>|<br>|&amp;/);
  assert.match(mail.body, /Assign to me/);
  assert.deepEqual([...result.told], ["booked e1"]);
  assert.equal(store.BN_SYNC_TOKEN, "token-1");
});

test("the group can be changed with the NOTIFY_TO property", () => {
  const { ctx, sent } = setup({ props: { ...SEEN, NOTIFY_TO: "platform-admin@issacharson.com" }, changes: [[{ items: [booking("e1")], nextSyncToken: "t" }]] });
  ctx.notifyBookings();
  assert.equal(sent[0].to, "platform-admin@issacharson.com");
});

test("the same booking seen again sends nothing more", () => {
  const { ctx, sent } = setup({ props: SEEN, changes: [
    [{ items: [booking("e1")], nextSyncToken: "token-1" }],
    [{ items: [booking("e1")], nextSyncToken: "token-2" }],
  ] });
  ctx.notifyBookings();
  ctx.notifyBookings();
  assert.equal(sent.length, 1);
});

test("a cancellation, which arrives as an ID only, says what was cancelled and is told once", () => {
  const { ctx, sent, store } = setup({ props: SEEN, changes: [
    [{ items: [booking("e1")], nextSyncToken: "token-1" }],
    [{ items: [{ id: "e1", status: "cancelled" }], nextSyncToken: "token-2" }],
    [{ items: [{ id: "e1", status: "cancelled" }], nextSyncToken: "token-3" }],
  ] });
  ctx.notifyBookings();
  ctx.notifyBookings();
  ctx.notifyBookings();
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /^Demo cancelled: CareMatchr demo, .*, Ada Example$/);
  assert.match(sent[1].body, /has been cancelled/);
  assert.doesNotMatch(sent[1].body, /Meet:/);
  assert.equal(store.BN_BOOKING_e1, undefined);
});

test("a booking moved to another time says both times", () => {
  const moved = booking("e1", { start: "2026-11-17T11:00:00Z", end: "2026-11-17T11:30:00Z" });
  const { ctx, sent } = setup({ props: SEEN, changes: [
    [{ items: [booking("e1")], nextSyncToken: "token-1" }],
    [{ items: [moved], nextSyncToken: "token-2" }],
  ] });
  ctx.notifyBookings();
  ctx.notifyBookings();
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /^Demo moved: CareMatchr demo, 2026-11-17T11:00:00\.000Z/);
  assert.match(sent[1].body, /It was 2026-11-16T10:00:00\.000Z/);
});

test("events that aren't from a booking page, or a cancellation of one, are left alone", () => {
  const typedIn = { ...booking("e2"), summary: "Team stand-up" };
  const lookalike = { ...booking("e3"), summary: "CareMatchr demo prep" };
  const { ctx, sent } = setup({ props: SEEN, changes: [[{ items: [typedIn, lookalike, { id: "e9", status: "cancelled" }], nextSyncToken: "t" }]] });
  const result = ctx.notifyBookings();
  assert.equal(sent.length, 0);
  assert.equal(result.changes, 3);
});

test("each booking page is recognised, the DBS page as DBS, not CareMatchr", () => {
  const { ctx, sent } = setup({ props: SEEN, changes: [[{ items: [
    booking("e1", { page: "CareMatchr DBS demo" }),
    booking("e2", { page: "Privacy A to Z readiness check", name: "Bea Example" }),
  ], nextSyncToken: "t" }]] });
  ctx.notifyBookings();
  assert.deepEqual(sent.map((m) => m.subject.split(",")[0]), ["Demo booked: CareMatchr DBS demo", "Demo booked: Privacy A to Z readiness check"]);
});

test("a booking that has already ended isn't told", () => {
  const old = booking("e1", { start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" });
  const { ctx, sent } = setup({ props: SEEN, changes: [[{ items: [old], nextSyncToken: "t" }]] });
  ctx.notifyBookings();
  assert.equal(sent.length, 0);
});

test("changes over several pages are all read, and the token comes from the last page", () => {
  const { ctx, sent, store, listed } = setup({ props: SEEN, changes: [[
    { items: [booking("e1")], nextPageToken: "p2" },
    { items: [booking("e2", { name: "Bea Example" })], nextSyncToken: "token-1" },
  ]] });
  ctx.notifyBookings();
  assert.equal(sent.length, 2);
  assert.equal(listed[1].options.pageToken, "p2");
  assert.equal(listed[1].options.syncToken, "token-0");
  assert.equal(store.BN_SYNC_TOKEN, "token-1");
});

test("when Google drops the sync token, it starts again and still tells bookings made since the last run", () => {
  const sinceLastRun = booking("e2", { created: "2026-11-13T13:50:00Z", name: "Bea Example" });
  const before = booking("e1", { created: "2026-11-13T09:00:00Z" });
  const { ctx, sent, store, listed } = setup({ props: SEEN, changes: [
    new Error("API call to calendar.events.list failed with error: Sync token is no longer valid, a full sync is required."),
    [{ items: [before, sinceLastRun], nextSyncToken: "token-new" }],
  ] });
  const result = ctx.notifyBookings();
  assert.equal(result.restarted, true);
  assert.equal(listed[1].options.syncToken, undefined);
  assert.deepEqual(sent.map((m) => m.subject.split(", ").pop()), ["Bea Example"]);
  assert.equal(store.BN_SYNC_TOKEN, "token-new");
});

test("any other Calendar error fails the run and keeps the old token", () => {
  const { ctx, store } = setup({ props: SEEN, changes: [new Error("Not Found")] });
  assert.throws(() => ctx.notifyBookings(), /Not Found/);
  assert.equal(store.BN_SYNC_TOKEN, "token-0");
});

test("if an email fails, the run fails, and the next run sends it without repeating the ones that went", () => {
  const items = [booking("e1"), booking("e2", { name: "Bea Example" })];
  const { ctx, sent, store } = setup({ props: SEEN, mailFails: 0, changes: [
    [{ items, nextSyncToken: "token-1" }],
    [{ items, nextSyncToken: "token-1" }],
  ] });
  // The first email goes; the second fails.
  let calls = 0;
  const realSend = ctx.MailApp.sendEmail;
  ctx.MailApp.sendEmail = (mail) => { calls++; if (calls === 2) throw new Error("Service invoked too many times"); realSend(mail); };
  assert.throws(() => ctx.notifyBookings(), /could not email careshow-team@issacharson\.com/);
  assert.equal(store.BN_SYNC_TOKEN, "token-0", "the token isn't moved on, so the change is seen again");
  assert.equal(JSON.parse(store.BN_LAST_RESULT).ok, false);
  ctx.notifyBookings();
  assert.deepEqual(sent.map((m) => m.subject.split(", ").pop()), ["Ada Example", "Bea Example"]);
  assert.equal(store.BN_SYNC_TOKEN, "token-1");
});

test("bookings that ended over a day ago are forgotten", () => {
  const { ctx, store } = setup({ props: { ...SEEN, BN_BOOKING_old: JSON.stringify({ start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" }), BN_BOOKING_soon: JSON.stringify({ start: "2026-11-16T10:00:00Z", end: "2026-11-16T10:30:00Z" }) } });
  const result = ctx.notifyBookings();
  assert.equal(result.forgotten, 1);
  assert.equal(store.BN_BOOKING_old, undefined);
  assert.ok(store.BN_BOOKING_soon);
});

test("a run already in progress means this one does nothing", () => {
  const { ctx, sent, listed } = setup({ props: SEEN, changes: [[{ items: [booking("e1")], nextSyncToken: "t" }]] });
  ctx.LockService.getScriptLock = () => ({ tryLock: () => false, releaseLock: () => {} });
  const result = ctx.notifyBookings();
  assert.match(result.skipped, /in progress/);
  assert.equal(listed.length, 0);
  assert.equal(sent.length, 0);
});

test("without the calendar ID it says which property to set and where to find it", () => {
  const { ctx } = setup({ props: { DEMOS_CALENDAR_ID: "" } });
  assert.throws(() => ctx.notifyBookings(), /DEMOS_CALENDAR_ID.*Integrate calendar/);
});

test("startBookingNotify checks the calendar can be read, sets one calendar trigger and one 15-minute sweep, and runs once", () => {
  const { ctx, triggers, sent } = setup({ changes: [[{ items: [booking("e1")], nextSyncToken: "token-1" }]] });
  const result = ctx.startBookingNotify();
  assert.deepEqual(JSON.parse(JSON.stringify(triggers)), [{ fn: "notifyBookings", calendarId: CAL }, { fn: "notifyBookings", minutes: 15 }]);
  assert.equal(result.calendar, "Issac Harson Demos");
  assert.equal(result.firstRun, true);
  assert.equal(sent.length, 0);
  ctx.startBookingNotify();
  assert.equal(triggers.length, 2, "running it again replaces the triggers");
  ctx.stopBookingNotify();
  assert.equal(triggers.length, 0);
});

test("startBookingNotify stops if this account can't read the calendar, and creates no trigger", () => {
  const { ctx, triggers } = setup({ calendarMissing: true });
  assert.throws(() => ctx.startBookingNotify(), /Not Found/);
  assert.equal(triggers.length, 0);
});

test("sendTestNotice emails the group so set-up can see it arrive", () => {
  const { ctx, sent } = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.sendTestNotice())), { ok: true, to: "careshow-team@issacharson.com" });
  assert.match(sent[0].subject, /^TEST: booking notifications/);
});
