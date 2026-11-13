# book.issacharson.com

Branded booking links for Issac Harson, and [Booking notifications](#booking-notifications), which tells the Care Show team inbox about each booking. Each one forwards to the matching **fixed link** in [lead-desk](https://github.com/issacharson/lead-desk), which forwards to the Google Calendar booking page listed in lead-desk's `booking-pages.json` ([lead-desk#184](https://github.com/issacharson/lead-desk/issues/184)).

| Link to share | Forwards to |
|---|---|
| https://book.issacharson.com/carematchr/ | https://issacharson.github.io/lead-desk/book/carematchr/ |
| https://book.issacharson.com/carematchr-dbs/ | https://issacharson.github.io/lead-desk/book/carematchr-dbs/ |
| https://book.issacharson.com/privacy-a-to-z/ | https://issacharson.github.io/lead-desk/book/privacy-a-to-z/ |

**Replacing a booking page needs no change here.** Change `booking-pages.json` in lead-desk; these links keep pointing at lead-desk's fixed links.

## How it works

- `scripts/build.mjs` writes `site/` (the forwarding pages, `CNAME` and an index). Run `node scripts/build.mjs`, commit `site/`. The workflow fails if `site/` is out of date.
- `.github/workflows/pages.yml` runs the tests and publishes `site/` to GitHub Pages from `main`.
- **DNS:** `book.issacharson.com` is a CNAME to `issacharson.github.io` on the hosting DNS page (DevOne, SupremeDNS). The TXT record `_github-pages-challenge-issacharson.issacharson.com` verifies issacharson.com for the organisation, so only issacharson repositories can publish to it. Keep both.
- **Adding a product:** add it to `LINKS` in `scripts/build.mjs` and add the same name as a fixed link in lead-desk.

## Booking notifications

Care Show team is a co-host on every booking page, but Google Calendar sends each booking to the members one by one and never posts it to the group. So nothing reaches the careshow-team@ inbox (test booking, 13 November 2026, [lead-desk#209](https://github.com/issacharson/lead-desk/issues/209)). **Booking notifications** fills that gap. It's an Apps Script project, [`booking-notify/Code.gs`](booking-notify/Code.gs), run as workspace-admin@, which emails careshow-team@ once for each demo:

| On the calendar | Email to careshow-team@ |
|---|---|
| A booking made on one of the three pages | **Demo booked:** page, time, the booker's name and email, the Meet link, what Google holds for the booking, and "Assign to me" as the next step |
| That booking cancelled | **Demo cancelled:** page, time, booker |
| That booking moved to another time | **Demo moved:** the new time and the old one |

- **Anyone can book.** The pages are public, so a booking from someone the team has never met is told the same way as one from a known lead.
- **Independent of the Lead Desk.** It never reads or writes the Leads register or the Follow-up Desk.
- **What counts:** events whose title is a booking page's title, as Google names them: "CareMatchr demo (their name)". Events typed in by hand, and anything before the job was switched on, are left alone. The titles must match `LINKS` in `scripts/build.mjs`; a unit test checks that.
- **How it finds changes:** a calendar trigger on Issac Harson Demos, and a sweep every 15 minutes in case a trigger is missed. Each run asks Google what changed since the last one (a sync token).
- **Never twice:** each booking is remembered until a day after it ends. If an email can't be sent, the run fails (Apps Script tells workspace-admin@), and the next run sends it without repeating the ones that went.
- **Personal data:** the email carries the same details as Google's invitation, which every member already gets. It stays in the group's conversations.
- **Tests:** `node --test scripts/*.test.mjs`, with fakes of Calendar, MailApp and the rest. The workflow runs them on every pull request. `booking-notify/` isn't published: Pages serves `site/` only.

### Why it lives here, not in the Lead Desk

CTO decision, 13 November 2026: Booking notifications is independent of the Lead Desk, so it lives here, beside the booking links it serves.

- **The booking pages belong to the company, not the Lead Desk.** They're public: a prospect from the website, an email signature, a social post or a Care Show conversation can book, whether or not they're a lead in the register. Telling the team about a booking doesn't depend on the register, so the code shouldn't either.
- **Its job is to notify, not to record.** It reads the demos calendar and emails the team. It never reads or writes the Leads register or the Follow-up Desk. Adding bookings to the register is a separate, optional piece of Lead Desk work ([lead-desk#206](https://github.com/issacharson/lead-desk/issues/206)).
- **One place for booking.** This repo already owns the branded links everyone hands out, so the booking pages' titles (`LINKS` in `scripts/build.mjs`) and the job that watches them sit side by side, with a test keeping them in step.
- **Each part can change on its own.** A Lead Desk change can't break booking notifications, and a change here needs no Lead Desk release.

It started in lead-desk ([lead-desk#209](https://github.com/issacharson/lead-desk/issues/209), [PR #210](https://github.com/issacharson/lead-desk/pull/210)) and moved here the same day, before anyone relied on it. The live Apps Script project didn't change; only its home in Git did.

### Set up Booking notifications (once)

- **Purpose:** every demo booking lands in the careshow-team@ inbox as a conversation the team can assign and complete.
- **Preconditions:** workspace-admin@ can see event details on Issac Harson Demos (it can, as a member of careshow-team@, which has "See all event details"). careshow-team@ accepts mail from workspace-admin@.
- **Access required:** signed in as workspace-admin@issacharson.com, which owns this job as it does the reply checker and the Booking pages check (CTO decision, 11 November 2026). A trigger runs as whoever created it, so it must be created from that account.
- **Steps:**
  1. Find the calendar ID: in Google Calendar, **Issac Harson Demos › Settings and sharing › Integrate calendar › Calendar ID**. It ends `@group.calendar.google.com`.
  2. Go to <https://script.google.com>, choose **New project** and name it **Booking notifications**.
  3. Replace `Code.gs` with [`booking-notify/Code.gs`](booking-notify/Code.gs).
  4. **Project Settings ›** tick **Show "appsscript.json" manifest file in editor**, then replace `appsscript.json` with [`booking-notify/appsscript.json`](booking-notify/appsscript.json). Save. **Services** then shows **Calendar**.
  5. **Project Settings › Script properties ›** add `DEMOS_CALENDAR_ID` with the ID from step 1.
  6. Run **`sendTestNotice`** and approve the permissions when asked: see your calendars, send email as you, and manage this project's triggers. It has no access to Gmail, Drive or the register, and can't change a calendar.
  7. Run **`startBookingNotify`**. It checks the calendar can be read, creates both triggers, and runs once.
- **Expected result:** `startBookingNotify` returns `ok: true`, `calendar: "Issac Harson Demos"` and `firstRun: true`, and emails nobody. **Triggers** shows two `notifyBookings` triggers: one **From calendar**, one **Time-driven, every 15 minutes**.
- **Verification:**
  1. "TEST: booking notifications can reach this group" is a conversation in the [careshow-team@ inbox](https://groups.google.com/a/issacharson.com/g/careshow-team). Mark it No action needed.
  2. Book a slot from an address outside issacharson.com through a link above. Within 15 minutes, "Demo booked: …" is a conversation in the group.
  3. Cancel it from the booker's confirmation. "Demo cancelled: …" follows.
- **Settings:** `NOTIFY_TO` sends to another address instead of careshow-team@. The last run's result is in Script properties under `BN_LAST_RESULT`.
- **When a change is merged:** paste the new `Code.gs` into the project and save. There is no deployment. When a page title changes, change `LINKS` in `scripts/build.mjs` and `BN.PAGES` together.
- **Rollback:** run `stopBookingNotify`, then revoke **Booking notifications** at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). Nothing else depends on it.
- **Automation opportunity:** push the script from Git with the Apps Script API, so a merged change needs no paste.

## Rollback

Remove the custom domain under **Settings › Pages**, then delete the `book` CNAME row on the hosting DNS page. Keep the TXT row.

_Generated by Toye-Akande and [Claude Code](https://claude.ai/code)_
