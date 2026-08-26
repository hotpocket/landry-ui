---
tags: [session, landry-ui, books, ios, safari, storage, boot]
type: session
date: 2026-08-25
projects: [landry-ui, books]
concern: audiobooks
summary: "books.landry.bot rendered nothing on an iPhone — static footer, empty <main>. Not a syntax level and not a feature: iOS Safari with 'Block All Cookies' throws SecurityError from the localStorage/sessionStorage/caches GETTER, so a line that merely NAMES the identifier is a throw. app.js named sessionStorage on its third executable line and the player named localStorage while constructing the engine. The class is every unguarded evaluation of a storage global on a boot path. Fixed with core/storage.ts in the player and storage(name) in the shell, plus the terminal .catch the shell's one promise chain never had — which converts any future member of the class from a silent blank page into a visible failure. Diagnosed from the photo: only the STATIC footer text was on screen, which is what pinned it to 'app.js never ran' rather than 'the API failed'."
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

There is no WebKit in the gstack Playwright cache, and the global rule
forbids `npx playwright install` as a reflex. Installed to an isolated
`PLAYWRIGHT_BROWSERS_PATH` under the scratchpad, so the existing chromium
cache could not be touched; the two missing system libs (`libwoff1`,
`libmanette-0.2-0`, no sudo available) were `apt-get download`ed, extracted
with `dpkg-deb -x`, and copied into the bundle's own `lib/` — `pw_run.sh`
uses the bundle wrapper's env, so `LD_LIBRARY_PATH` alone does not reach it.

Then six scenarios against production under iPhone emulation. Exactly one
reproduced the photograph:

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

## Not verified

**That this is what the requester's phone was doing.** The reproduction
matches the photograph exactly and is the only one of six that does, but
the device's actual setting was never read, and the AWS SSO window was
expired so CloudFront/CloudWatch could not be asked what that iPhone
requested at 5:36. If the phone still fails after the deploy, the next thing
to look at is what changed on screen — the terminal catch means it should
now say *something*, and that sentence is the next diagnosis.

Related: [[2026-08-24 - the-title-that-sized-the-player]] — the previous
defect that no existing suite could exhibit, for the same structural reason:
the suites modelled a page nobody visits.
