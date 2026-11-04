# Harmgate roadmap

Harmgate is an open-source Manifest V3 browser extension. It blocks harmful sites by default (pornography, gambling and betting, gore) and lets people set their own limits on distracting sites such as X, Reddit and Instagram. Everything runs locally and no browsing data is collected.

## Decisions

| Topic | Decision |
|---|---|
| Distribution | GitHub Releases only. No Chrome Web Store. |
| Core filter | Always on, with no way to turn a category off, including dating sites that the lists class as adult. Allowing a single site blocked by mistake takes a 5-minute wait with the tab open and in front, then a sentence typed by hand. The block page offers no route to settings. |
| Personal limits | All or nothing: while a limit applies, the site is closed, with no way through from the block page. All the time or on a schedule, off by default, set in settings. Adding a limit or making it stricter is instant. Removing or loosening one takes the same wait and typed sentence as the core filter, with encouraging sentences shown during the wait. |
| License | GPL-3.0 |
| Blocking method | One `declarativeNetRequest` rule per list using `requestDomains`, redirecting to our own page. Needs `<all_urls>`. |
| Starting lists | StevenBlack gambling + porn, Hagezi NSFW, Hagezi gambling mini, Sinfonietta snuff: 237,910 domains after deduplication and allowlisting. |
| Stack | TypeScript and Vite. No server. |

## Phases

### Phase 0: Spike (done)

Confirmed that full blocklists fit in one rule and that the list can be updated at runtime. Loaded and blocked in a real Chrome install. See [spike results](../spike/RESULTS.md).

### Phase 1: Core filter (done)

- List pipeline in GitHub Actions: download, normalize, deduplicate, apply allowlist, generate rules.
- Check lists against popular sites to catch wrong blocks. Check the licenses of the sources inside each list and record them in a notices file.
- Categories. Gore starts from a 23-domain list last updated in 2023, plus a hand-maintained file, so its coverage is weak.
- Block page in English, passing the blocked host through `regexSubstitution`. This needs a pinned extension ID through the manifest `key`.
- Filter that cannot be turned off, hard-to-pass allowlist in settings, wrong-block report.
- Weekly list refresh at runtime, fetched as data only, because GitHub-only installs get no automatic updates.

Done when the filter works right after install and refreshes its list by itself.

### Phase 2: Personal limits (done)

- Presets for X, Reddit, Instagram and TikTok, plus custom sites.
- All the time or on a schedule.
- Removing a limit, or changing a schedule so the site is open at more times, goes through the wait.
- Tabs already open on a limited site are closed off too when a limit starts.

Done when someone can set up and manage their own limits.

### Phase 3: Release (done for Chrome)

- README, install guide, privacy note, CI, GitHub Releases, new-version notice.

Done when a stranger can install it in a few minutes by following the guide.

### Phase 4: Family mode for Chrome (on hold until there is demand)

What Chromium's source and policy definitions say:

- Installing from outside the Web Store by policy needs a managed computer (MDM, a domain or Chrome Enterprise Core), so a home computer cannot force-install Harmgate or stop it being removed.
- Harmgate depends on developer mode, because Chrome turns off unpacked extensions without it. Disallowing developer mode by policy would therefore turn the filter off.
- `IncognitoModeAvailability` and `URLBlocklist` for `chrome://extensions` worked in a test on a home Mac with no device management: macOS 26.3 and Chrome 156, using a manually installed configuration profile. Incognito would not open and the extensions page was blocked. `BrowserGuestModeEnabled` and `BrowserAddPersonEnabled` were in the same profile but not checked. Chromium warns that blocking internal pages can be worked around.
- With those policies on, Harmgate could still be removed from Chrome's toolbar menu.

If this is picked up, it needs a setup guide that is honest about what stays open, a test of whether a child account can undo the setup, and a Windows test before claiming support there.

### On hold

- Firefox. Mozilla allows signed distribution outside its store; compatibility and signing are untested.
- Safari. A free install from GitHub is not practical: Apple's "Allow unsigned extensions" setting resets when Safari quits. A Mac app signed with Developer ID needs a paid Apple membership, and iPhone needs the App Store.

### Phase 5: Growth

- Interface in English, German and Turkish.
- List contribution process.
- Local heuristics for unlisted sites.

## Known limits

- Domain blocking cannot catch content inside sites like X or Reddit; they can only be blocked whole.
- No list is complete, and some harmless sites will be blocked by mistake.
- The gore category covers very few sites so far.
- Sites can detect that Harmgate is installed, because the block page must be reachable from the web for redirects to work.
- An extension covers one browser profile. It does not run in incognito by default. Chrome lets anyone remove an extension, or turn off the developer mode it depends on, and no code inside the extension can prevent that.
- Putting this many domains in one rule works in testing but is not explicitly guaranteed by Chrome. The fallback is splitting the list across many rules.
