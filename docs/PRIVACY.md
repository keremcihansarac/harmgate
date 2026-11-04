# Privacy

Harmgate has no server and no analytics. It does not collect, store or send your browsing history.

## What stays in your browser

Blocking happens inside Chrome, which compares each page address with the lists on your computer. Harmgate's own code does not read the addresses you visit.

Harmgate saves these in Chrome's local extension storage. They do not leave your computer:

- Your limits and their schedules
- The sites you allowed
- Which list version is in use, and when the last check ran

The block page gets the name of the blocked site in its own address, so that it can show it. It does not save or send that name.

## What goes over the network

Once a day, Harmgate downloads these files from this project's GitHub releases:

- Information about the newest blocklists, and the lists themselves when they are newer
- The number of the newest Harmgate version

These requests contain nothing about your browsing. Like any web request, they show GitHub your IP address and that a client asked for these files. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) covers how GitHub handles that.

Downloaded lists are only ever used as lists of domains to block. No code is downloaded.

## Links you can choose to follow

**Report on GitHub**, on the block page, opens a GitHub form with the blocked site's name filled in. Nothing is sent unless you submit it. A report is a public issue, and it shows that site's name next to your GitHub account.

The new-version notice links to GitHub's release page.

## Why it asks for these permissions

| Permission | Why |
|---|---|
| Access to all sites | Chrome requires this to send a blocked site to Harmgate's block page. Harmgate also uses it to reload tabs already open on a site when a limit starts, and to download the lists. It does not read the content of pages. |
| `declarativeNetRequest` | Lets Chrome do the blocking. |
| `storage` | Saves your settings on your computer. |
| `alarms` | Runs the daily check and starts and ends schedules on time. |

## Sites can tell Harmgate is installed

Chrome requires the block page to be reachable from the web for this kind of blocking to work. A website could use that to detect that Harmgate is installed. It learns nothing else from it.

Questions or concerns? Open an [issue](https://github.com/keremcihansarac/harmgate/issues).
