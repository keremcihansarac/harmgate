# Phase 0 spike results

Date: 2026-11-03. Engine: Playwright Chromium 156, headless, on macOS. One run per scenario.

**Question:** Can one `declarativeNetRequest` rule hold entire blocklists, given Chrome guarantees only 30,000 static rules?

**Answer:** Yes in this test. A single rule with `requestDomains` held 749,711 domains, as both a static and a dynamic rule. A rule counts as one against the quota regardless of its domain count. No per-rule domain limit is documented that we found, so this behaviour could change. The fallback is splitting the list across many rules.

## List sizes

After removing duplicates and subdomains already covered by a listed parent domain.

| Combination | Domains | Rule JSON |
|---|---:|---:|
| StevenBlack gambling + porn | 52,027 | 0.91 MB |
| + Hagezi NSFW + gambling mini | 237,938 | 4.50 MB |
| + Hagezi NSFW + gambling medium | 304,442 | 5.85 MB |
| + Hagezi NSFW + gambling full | 749,711 | 14.47 MB |

## Static rule

| Domains | Indexed size | First block after launch | After restart | Browser process memory, first launch / restart |
|---:|---:|---:|---:|---:|
| 0 (baseline) | - | - | - | 210 MB / - |
| 52,027 | 1.31 MB | 527 ms | 503 ms | 228 / 225 MB |
| 237,938 | 6.28 MB | 637 ms | 595 ms | 243 / 239 MB |
| 304,442 | 8.13 MB | 660 ms | 665 ms | 230 / 244 MB |
| 749,711 | 20.07 MB | 1097 ms | 934 ms | 212 / 284 MB |

Memory is noisy: the same list differs by up to 72 MB between launches, so treat these numbers as rough. Median navigation time to a local page stayed at 10 to 11 ms against a 10 ms baseline, for every size. That measures requests that do not match a rule.

## Dynamic rule, list fetched at runtime

| Domains | Fetch + parse | `updateDynamicRules` | Survives restart |
|---:|---:|---:|---|
| 52,027 | 13 ms | 78 ms | yes |
| 237,938 | 76 ms | 367 ms | yes |
| 304,442 | 36 ms | 454 ms | yes |
| 749,711 | 231 ms | 1060 ms | yes |

The list came from a local server standing in for GitHub.

## Matching

At every size, synthetic domains at the start, middle and end of the list were blocked, as was a subdomain. An unlisted control was allowed. A sample of 40 real listed domains matched through `testMatchOutcome`, which sends no network request.

## Permissions

| Rule | Host permission | Result |
|---|---|---|
| Redirect to block page | `<all_urls>` | works |
| Redirect to block page | none | does not block; request proceeds |
| Plain block | none | blocks with an error page |

A custom block page therefore needs `<all_urls>`.

## Passing the blocked site to the block page

`regexFilter` combined with `requestDomains` and `regexSubstitution` works, using a pinned extension ID through the manifest `key`. The filter must match the whole URL (`.*$`), otherwise the unmatched remainder is appended to the redirect.

## Not tested

- A real Chrome install: Chrome removed `--load-extension`, so this needs a manual load.
- Firefox, Edge and Brave.
- A real download from GitHub.
- List quality and false positives. All sizes fit, so list choice is now a quality decision, not a capacity one.
