---
tags: [session, landry-ui, books, ios, safari, storage, boot, instruments]
type: session
date: 2026-08-25
projects: [landry-ui, books]
concern: audiobooks
summary: "books.landry.bot rendered nothing on an iPhone — static footer, empty <main>. iOS Safari with 'Block All Cookies' throws SecurityError from the localStorage/sessionStorage/caches GETTER, so a line that merely NAMES the identifier is a throw; app.js named sessionStorage on its third executable line and the player named localStorage while constructing the engine. Fixed with core/storage.ts in the player and storage(name) in the shell, plus the terminal .catch the shell's one promise chain never had. DEPLOYED (shell bd42a34f, live_check 36/36) and confirmed working on the reporter’s phone. The durable output is not the fix: ~/bin/iphone now runs any URL in real WebKit under iPhone emulation with the privacy settings hostile, and ~/.claude/CLAUDE.md carries the standing rule that no web UI is finished until a browser that can REFUSE has seen it. Diagnosed from the photo alone: only the STATIC footer text was on screen, which pins it to 'app.js never ran'."
status: complete
---

# Naming localStorage is not free

## What was reported

One photo of an iPhone, opened from Messages, and "no idea why but on an
iphone books.landry.bot doesn't render". Nothing else — no iOS version, no
console, and the requester was away.

## What the photo actually said

The page was not blank. At the bottom edge, above Safari's address bar, sat
the words *text in, narrated audiobooks out*. That string is **static HTML**
in `index.html`, inside `<footer class="site-foot">`. `<main id="view">`
ships empty and is filled by `app.js`.

So the picture was not "the API failed" and not "the player broke". It was
`app.js` never ran. Everything after that was confirmation.

## The instrument

No instrument on this machine could exhibit the defect, because every browser
here says yes. Diagnosing it needed an engine that can refuse — real WebKit
under iPhone emulation. That setup is now `~/bin/iphone` (see the last section);
this is what it found.

Six scenarios against production. Exactly one reproduced the photograph:

| scenario | `#view` | body text |
|---|---|---|
| baseline | 395 chars | the real shelf |
| **`sessionStorage` getter throws** | **0 chars** | **the footer, alone** |
| `caches` getter throws | 770 chars | skeleton, forever |
| `/api/library` hangs | 770 chars | skeleton, forever |
| `/api/library` 500s | 108 chars | an error page |
| Google GSI blocked | 395 chars | the real shelf |

## The class

**Every unguarded evaluation of a Web Storage or Cache API global on a boot
path.** iOS Safari with Settings → Safari → Advanced → "Block All Cookies"
throws `SecurityError` from the **getter**. Not from `.getItem()` — from
naming the identifier. Which means:

- `sessionStorage.removeItem(...)` is a throw;
- `if (!window.caches)` throws *on its way to deciding*, so the guard that
  exists for this is itself a member of the class;
- `try { localStorage.setItem(...) } catch {}` is fine, which is why the
  one place that already had a try was the one place that survived.

Members found, and what each did:

| where | effect | done |
|---|---|---|
| `books/site/app.js:27` `sessionStorage.removeItem` | whole shell dead, footer only | fixed |
| `books/site/app.js` ×3 `if (!window.caches)` | skeleton forever | fixed |
| `books/site/app.js` nav hint `localStorage` | nothing — already in a try | routed through the helper |
| `landry-ui .../index.tsx` `new PlayerEngine(…, localStorage)` | the mount never happens | fixed |
| `landry-ui .../index.tsx` `diagnostics()` | nothing — already caught | now also via the helper |
| `landry-ui .../engine/player.ts` | nothing — asks `'caches' in window`, which does not invoke the getter | clean |
| `vanilla/feedback.js` `setFlagged()` | a click-time throw, not boot | **named, not fixed** — it ships byte-identical to both players, so editing it is a deliberate act like `sw.js` |
| `vanilla/player.js` | frozen, and books no longer uses it | **named, not fixed** |

## The second finding, which is worth more

The shell is **one promise chain and it had no end**:

```js
cachedLibrary().then(function (stale) { … return load().then(…); });
```

No terminal `.catch`. A throw anywhere in it left `<main>` holding whatever
it held at that instant — a skeleton, or nothing — for the rest of the
page's life. The storage getter was one cause; an `/api/library` that
answers without `books` (which `booksForHandle` dereferences, and which a
half-deployed Lambda can send) is another. All of them arrive at the same
silent blank page on a device with no console.

The catch now ends in the same error view a failed load ends in. It is what
converts the *next* member of the class from "doesn't render" into a
sentence the reader can repeat back.

## What was written

- `landry-ui audiobook/player-src/src/core/storage.ts` — `safeStorage()`,
  covering both shapes: access refused (getter throws) and writes refused
  (quota, older private modes). It shadows reads, so a toggle pressed during
  the session does not snap back a frame later.
- `landry-ui test/core-storage.test.mjs` — 9 assertions. Four mutants run by
  hand; the one that survived (`shadow.delete`, the quota-clears-mid-session
  case) got assertion I written for it and now dies.
- `landry-ui test/storage-blocked.test.mjs` — asserts at `init()`, not at the
  helper, because the helper can be right while the one call site still
  reaches for the raw global. That IS the bug.
- `books tests/shell_storage_blocked.test.mjs` — each global refused
  separately so a failure names the culprit. `mode.library = 'malformed'`
  added to the harness for the terminal-catch case.

Both suites prove their own instrument first: a run whose `defineProperty`
override did not take passes against unfixed code, which would have been a
green suite measuring nothing.

## Verification

- revert-and-watch on all three shell hunks: without the sessionStorage
  guard `<main>` is empty; without the caches guard it holds three skeletons
  forever; with the terminal catch swallowing, the malformed payload leaves
  it empty.
- `parity.sh` 184 assertions green, feature suites green including the new
  `storage-blocked` (6).
- Every books browser suite green (16 suites), `scripts/test.sh` exit 0.
- Real WebKit, iPhone-emulated, against the built shell with all three
  globals refused: the shelf renders, a book opens, the player mounts, zero
  page errors.

## Shipped

Pushed both repos, `sso landry` for credentials, `deploy-site.sh` — which
planned exactly one step, `deploy-content.sh --shell-only`, because the API was
byte-identical. Production runs shell `bd42a34f` (`app.js` 41e78a05e48d,
`player.js` 42e25bb4c0ed). `live_check.mjs` 36 passed, 0 failed. `~/bin/iphone`
against production with all three storage globals refused: output byte-identical
to the normal pass, a book opens, no page errors. **The reporter confirmed it
renders on the phone that could not load it.**

Still not read: that phone's actual Safari setting. "Block All Cookies" is the
theory that fits the evidence, not a reading of the device — the AWS SSO window
was expired at diagnosis time, so CloudFront and CloudWatch were never asked what
it requested. It stopped mattering for this defect, since every member of the
class is fixed either way, but it is the reason the standing check below exists
rather than a single assertion.

## The durable output is the instrument, not the fix

`~/bin/iphone <url>` — real WebKit (Safari's engine) under iPhone emulation, one
pass normal and one with the browser's privacy settings hostile, reporting what
differs and exiting non-zero on divergence. Passes: `no-storage` (the getters
throw), `no-sw`, `offline-3p`. `--selector` says what "rendered" means; one
screenshot per pass.

Three things about it are load-bearing and would otherwise be rediscovered the
hard way:

- **It bootstraps WebKit into `~/.cache/iphone-webkit`, never the shared
  `ms-playwright` cache.** `playwright install` deletes cached browsers *before*
  failing on an unsupported OS, so installing WebKit into the shared cache risks
  losing gstack's chromium. The global conduct file already forbids running that
  command as a reflex; this is how to need it anyway without paying the price.
- **It extracts `libwoff1` and `libmanette-0.2-0` from `.debs`** via `apt-get
  download` + `dpkg-deb -x`, because there is no sudo on this machine. The `.so`s
  must be copied into the bundle's own `minibrowser-*/lib/`: `pw_run.sh` runs the
  bundle wrapper, which does not honour an inherited `LD_LIBRARY_PATH`.
- **It is calibrated, and refuses to pretend otherwise.** Pointed at the pre-fix
  shell it reports `content collapsed vs normal (32 vs 87 chars)` and `The
  operation is insecure.` — 32 chars being the static footer, alone. The
  `no-storage` pass fails outright if the `defineProperty` override did not take,
  because a pass that measures nothing is the exact failure mode the script
  exists to prevent.

`~/.claude/CLAUDE.md` carries the standing rule, "Web UI is not finished until a
browser that REFUSES has seen it". It sits *after* "A defect is a sample" rather
than before it, because that section opens with a back-reference to the
instruments section and an insertion between the two silently breaks it.

It is not version-controlled. Like `filmstrip` and `sso` it lives only in
`~/bin`, which does not survive a machine change — recorded as an open item in
`vault/todos/landry-ui.md`, blocked on which repo should adopt it.

Related: [[2026-08-24 - the-title-that-sized-the-player]] — the previous
defect that no existing suite could exhibit, for the same structural reason:
the suites modelled a page nobody visits.
