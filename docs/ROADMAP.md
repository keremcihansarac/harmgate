# Harmgate roadmap

Harmgate is an open-source Manifest V3 browser extension. It blocks harmful sites by default (pornography, gambling and betting, gore) and lets people set their own limits on distracting sites such as X, Reddit and Instagram. Everything runs locally and no browsing data is collected.

## Decisions

| Topic | Decision |
|---|---|
| Distribution | GitHub Releases only. No Chrome Web Store. |
| Core filter | On by default. Turning it off requires a wait of about 60 seconds. |
| Personal limits | Full block or schedule, with a pause screen: a short wait, then "continue for 10 minutes". A nudge, not a hard barrier. |
| License | GPL-3.0 |
| Blocking method | One `declarativeNetRequest` rule per list using `requestDomains`, redirecting to our own page. Needs `<all_urls>`. |
| Starting lists | StevenBlack gambling + porn, Hagezi NSFW, Hagezi gambling mini, Sinfonietta snuff: 237,910 domains after deduplication and allowlisting. |
| Stack | TypeScript and Vite. No server. |

## Phases

### Phase 0: Spike (done)

Confirmed that full blocklists fit in one rule and that the list can be updated at runtime. Loaded and blocked in a real Chrome install. See [spike results](../spike/RESULTS.md).

### Phase 1: Core filter (built, first GitHub run pending)

- List pipeline in GitHub Actions: download, normalize, deduplicate, apply allowlist, generate rules.
- Check lists against popular sites to catch wrong blocks. Check the licenses of the sources inside each list and record them in a notices file.
- Categories. Gore starts from a 23-domain list last updated in 2023, plus a hand-maintained file, so its coverage is weak.
- Block page in English, passing the blocked host through `regexSubstitution`. This needs a pinned extension ID through the manifest `key`.
- 60-second turn-off, allowlist, wrong-block report.
- Weekly list refresh at runtime, fetched as data only, because GitHub-only installs get no automatic updates.

Done when the filter works right after install and refreshes its list by itself.

### Phase 2: Personal limits

- Presets for X, Reddit, Instagram and TikTok, plus custom sites.
- Full block or schedule, with the pause screen.

Done when someone can set up and manage their own limits.

### Phase 3: Release

- README, install guide with GIF, privacy note, CI, GitHub Releases, new-version notice.
- Signed Firefox build. Firefox allows distribution outside its store with automatic updates; still to be tested from GitHub.

Done when a stranger can install it in a few minutes by following the guide.

### Phase 4: Family mode

- Locked install on Firefox through policies. Chrome force-install on Windows and macOS needs the Web Store, so Chrome relies on family DNS and SafeSearch settings.
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
- An extension covers one browser profile. It does not run in incognito by default, and anyone can remove it unless a policy locks it.
- Putting this many domains in one rule works in testing but is not explicitly guaranteed by Chrome. The fallback is splitting the list across many rules.
