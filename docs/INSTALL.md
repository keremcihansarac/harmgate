# Install Harmgate

Harmgate is distributed through GitHub rather than the Chrome Web Store, so you install it by hand. It takes about two minutes.

## Install

1. Open the [latest release](https://github.com/keremcihansarac/harmgate/releases/latest) and download `harmgate-x.y.z.zip`.
2. Unzip it. You get a folder named `harmgate`.
3. Move that folder somewhere it can stay, such as your Documents folder. **Do not delete or move it later:** Chrome keeps reading the extension from it.
4. Open `chrome://extensions` in Chrome.
5. Turn on **Developer mode**, at the top right.
6. Click **Load unpacked** and choose the `harmgate` folder. Choose the folder that has `manifest.json` directly inside it.

The Harmgate settings page opens, and the filter is already on.

**Leave Developer mode on.** Chrome turns off extensions installed this way when developer mode is off, and that includes the filter.

To reach the settings later, pin Harmgate from the puzzle-piece menu next to the address bar and click its shield.

## Check that it works

The settings page should say **On** for all three categories under **Core filter**.

To see a block for yourself, add a limit for a harmless site you do not need right now, and open that site. Removing that limit afterwards takes the 5-minute wait, so pick the site with that in mind.

## Cover incognito windows

Chrome does not run extensions in incognito windows by default. To turn it on, open `chrome://extensions`, click **Details** under Harmgate, and enable **Allow in Incognito**.

## Update

Blocklists update by themselves. New versions of Harmgate do not, because Chrome only updates extensions from its own store. The settings page tells you when one is available. Then:

1. Download the new zip from the [latest release](https://github.com/keremcihansarac/harmgate/releases/latest) and unzip it.
2. Replace the contents of your existing `harmgate` folder with the new files. Keep the folder in the same place.
3. In `chrome://extensions`, click the reload icon on the Harmgate card.

Your limits and allowed sites stay. If you remove Harmgate at `chrome://extensions` instead of reloading it, Chrome deletes them.

## Questions

**Chrome warns about developer mode extensions. Is that a problem?** Chrome may warn about any extension installed this way. Harmgate's code is public in this repository, and you can build it yourself.

**Does it work in Edge or Brave?** They use the same engine and have the same "Load unpacked" option, but Harmgate has not been tested in them.

**Can a child turn it off?** The filter has no off switch of its own, but anyone using the browser can remove the extension or turn off developer mode. Harmgate alone is not a lock. The [roadmap](ROADMAP.md) covers what browser policies may add.

**A site is blocked by mistake.** Use **Report on GitHub** on the block page, so the list gets fixed for everyone. To use the site in the meantime, go to **Allowed sites** in settings.
