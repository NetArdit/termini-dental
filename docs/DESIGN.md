# Design system — Termini Dental, as it is

Written 2026-10-11 from the code and from browser captures of every screen (Edge 155, 1366×768 and
390×844, patient, administrator, dentist). It describes what exists so that new screens match it. It is not
a wish list; proposals are at the end and in `design/proposals/`.

## Where things live

- Tokens: `src/web/src/index.css`, the `@theme` block. Tailwind CSS 4 turns each into utilities
  (`bg-brand-700`, `text-ink-soft`).
- Components: `src/web/src/ui.tsx`. Pages do not restyle them; they compose them.
- Typefaces: `src/web/src/fonts`, served by the application (licences in `src/web/public/licenses`).

## Tokens

**Colour.** One brand colour and warm neutrals; semantic colours are used only for their meaning.

- Neutrals: `paper` #f7f5f0 (page), `surface` #ffffff (cards, fields), `line` #e4dfd5, `line-strong`
  #cdc6b8 (field borders), `ink` #17201f, `ink-soft` #4a5654, `ink-faint` #626d6b (the lightest text;
  measures 4.92:1 on paper, 5.36 on white, 4.88 on brand-50).
- Brand teal: `brand-50` #eef6f5 (hover, selected background), `-100`, `-200`, `-500` #1f7a75 (focus
  ring, accents), `-600`, `-700` #0f4c4a (primary buttons, active navigation, headers), `-900` (hover of
  primary).
- Meaning: `ok` (done, accepted), `warn` (needs attention: no-show, stored email, the cancellation notice),
  `danger` (cancelled, failed, destructive), `info` (booked, neutral notices). Each has a background and a
  foreground meant to be used together.

**Type.** Inter for everything functional; Fraunces (`font-display`) for page titles, section titles,
dialog titles and the logo. Sizes in use: 12 (badges, captions), 14 (`text-sm`, secondary lines, buttons),
15 (fields and body in cards), 16–18 (lead text), 20 (section titles), 24–30 (page titles), 36–60 (landing
headline). Weights 400, 500, 600.

**Shape and depth.** Radius 8 px for controls (`rounded-lg`), 12 px for notices and choice cards
(`rounded-xl`), 16 px for cards and dialogs (`rounded-2xl`), full for badges. Two shadows: `shadow-card`
(resting surfaces) and `shadow-pop` (dialogs, toasts). Borders do most of the separating; shadows are faint.

**Motion.** One entrance animation (`animate-rise`, 250 ms) for toasts and the booking confirmation;
colour transitions on hover. All of it is switched off under `prefers-reduced-motion`.

**Focus.** One style everywhere: a 2 px `brand-500` outline, 2 px away from the element.

**Touch.** On touch screens (`pointer: coarse`) every button, field, select, tab and `summary` is at
least 44 px high and every button at least 44 px wide, set once in the base layer. A link that stands on its
own (back to a list, a phone number) gets the class `tap` for the same height. Links inside a sentence stay
text.

## Components (`ui.tsx`)

- `Button`: variants `primary`, `secondary`, `ghost`, `danger`; sizes `sm` 32 px, `md` 40 px, `lg` 48 px
  (44 px minimum on touch); `busy` shows a spinner and disables.
- `Field` with `Input`, `Select`, `Textarea`: a visible label, an error or a hint under the control, wired
  with `aria-invalid` and `aria-describedby`.
- `Card`, `PageHeader` (title, subtitle, actions), `Empty` (dashed box with a sentence), `Loading`,
  `LoadError` (message and a retry button).
- `Badge` and `StatusBadge` (booked, completed, no-show, cancelled), `Notice` (tones as above; `danger`
  is announced as an alert).
- `Modal`: the browser's `<dialog>`, named by its title, focus kept inside, Escape closes, focus returns.
- Toasts: bottom centre, 3.5 s, errors 7 s.
- `useLoad`: loading, error and data for a request, dropping stale answers.

## Patterns

- **Public pages** (booking, patient link, login, sign-up): one centred column, 28–42 rem wide. Booking has
  a teal header with the clinic's name and one card with numbered steps that open one after the other.
- **Staff area**: a fixed sidebar from 1024 px (navigation, the clinic's booking link, the account); below
  that, a header with the logo, "copy link" and "log out", and the six sections as a three-by-two grid.
  Content is one column up to 72 rem.
- **Lists** are cards with divided rows; each row is one button (time or name, a secondary line, badges on
  the right). On a phone the secondary line wraps instead of being cut.
- **Every list has four states**: loading, error with retry, empty with a sentence that says what to do,
  and data.
- **Destructive or irreversible steps** ask first, inside the dialog, in the danger tone, and say what
  cannot be undone.
- **Language**: Albanian, formal "ju", sentences rather than labels where a decision is involved.

## What the captures say (final build, 52 screens)

No page scrolls sideways; nothing sticks out of the viewport; no control without an accessible name; no
text below AA contrast; exactly one `main` and one `h1` per screen; no JavaScript error.
Touch targets under 44 px on a phone, before and after this unit: settings 54 of 54 → 0, reports 12 of 12 →
0, calendar 13 of 16 → 0, outbox 7 of 7 → 0, booking with all steps 20 of 38 → 1 of 30. What remains are
links inside sentences on the public pages.

## Known weak points (not changed; they need a decision)

- The staff calendar is a list of the day. It does not show free time, gaps, or how full the week is.
  Proposal: `design/proposals/calendar.html`.
- The landing page is a headline and six paragraphs: no picture of the product, no price, no contact.
  Proposal: `design/proposals/landing.html`.
- The date field in the calendar is the browser's own and follows the browser's language, so it can show
  10/12/2026 next to "12 tetor 2026".
- No dark mode. Nobody asked for one.
- The booking page is long on a phone (about 2,400 px with every step open); finished steps stay open.

## The two proposals

Mock-ups only: static HTML in `design/proposals/` using these same tokens, rendered to PNG by
`node design/proposals/render.mjs`. Nothing of them is in the product. Current screens for comparison are in
`design/proposals/before/`.

**Calendar as a timetable** (`calendar-desktop.png`, `calendar-mobile.png`).
A week strip on top (each day with its number of appointments and how full it is), then the day as a
timetable: one column per dentist, an hour always the same height, appointments as blocks as long as they
last and coloured by status, breaks hatched, free stretches outlined and clickable to book, a red line at
the current time. On a phone one dentist at a time, switched by two buttons.
Cost: a real component (positions from times, overlaps cannot happen thanks to the database rule) and one
new read (appointments per day for the week strip). The list view could stay as a second view.
Owner's choices: timetable instead of the list, or both with a switch; week strip yes or no.

**Landing page that shows the product** (`landing-desktop.png`, `landing-mobile.png`).
A sharper headline, a phone showing the patient's booking page, "how it works" in three steps, two columns
"for the clinic / for the patient" built from the six existing points, a price section and a real footer.
Owner's choices, all content: the headline; whether "free" and "ready in five minutes" may be promised; the
monthly price and any free period; the contact shown; and that privacy, terms and contact pages do not
exist yet (the mock-up marks these in a dashed box rather than inventing them).

## Built, 2026-10-11

The owner chose both calendar views and accepted the landing structure (`docs/REQUIREMENTS.md` section I).

- **Calendar**: `src/web/src/components/DayTimetable.tsx` and `pages/Calendar.tsx`. A switch "Orari / Lista"
  (the one word is kept in the browser), a week strip with each day's count, the day as a timetable. With a
  mouse a minute is one pixel; on a touch screen one and a half, so a half-hour appointment is 45 px. Known
  limits: an appointment shorter than half an hour is drawn at a minimum height and can cover the start of
  the next one; names longer than a block are cut inside the block (the full text is in its label and in the
  list view); the grid has no table semantics for screen readers; days on which the clocks change were not
  tried. As built: `design/proposals/calendar-built-desktop.png`, `calendar-built-mobile.png`.
- **Landing page**: `pages/Landing.tsx`, as proposed, without a price or a contact (the owner has named
  neither) and without links to pages that do not exist. The second button is "Kam llogari", not "see an
  example page": there is no public example clinic. As built: `landing-built-desktop.png`,
  `landing-built-mobile.png`.
- Rows that hold free text (patient names, email subjects and addresses, a member of staff's email) wrap on
  a phone instead of being cut. This showed only once the browser flows had written longer data than the
  demo seed has.
