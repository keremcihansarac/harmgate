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

### Phase 3: Release

- README, install guide, privacy note, CI, GitHub Releases, new-version notice.
- Signed Firefox build. Firefox allows distribution outside its store with automatic updates; still to be tested from GitHub.

Done when a stranger can install it in a few minutes by following the guide.

### Phase 4: Family mode

- Locked install on Firefox through policies. Chrome force-install on Windows and macOS needs the Web Store, so Chrome relies on family DNS and SafeSearch settings.
- Policies that also shut the remaining exits, such as blocking `chrome://extensions` and incognito windows.
- Setup scripts and a guide. These policy routes are untested on home computers and need testing here.

Done when the filter cannot easily be disabled from a child account by following the guide.

### Phase 5: Growth

- Interface in English, German and Turkish.
- List contribution process.
- Local heuristics for unlisted sites.

## Known limits

- Domain blocking cannot catch content inside sites like X or Reddit; they can only be blocked whole.
- No list is complete, and some harmless sites will be blocked by mistake.
- The gore category covers very few sites so far.
- Sites can detect that Harmgate is installed, because the block page must be reachable from the web for redirects to work.
- An extension covers one browser profile. It does not run in incognito by default. Chrome lets anyone remove an extension from `chrome://extensions`, and no code inside the extension can prevent that; only a browser policy can.
- Putting this many domains in one rule works in testing but is not explicitly guaranteed by Chrome. The fallback is splitting the list across many rules.
