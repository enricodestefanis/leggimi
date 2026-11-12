# Leggimi privacy policy

_Last updated: 6 November 2026_

Leggimi is a Markdown viewer and editor for Windows, published by Enrico De Stefanis and
released as open source under the MIT License. This policy describes what the app does with
your data. The short version: **Leggimi does not collect, store or transmit any personal
data, and it never connects to the internet.**

## No data collection

- Leggimi has **no telemetry, analytics, crash reporting or advertising**.
- Leggimi has **no accounts** and asks for no personal information.
- Leggimi makes **no network connections**. Everything it needs (rendering engine, diagram and
  formula libraries, fonts) ships inside the app. Its content security policy forbids any
  remote request, so even a document that references an online image cannot make the app
  fetch it.

## What stays on your computer

Leggimi only touches the files and folders you open, and it modifies a file only when you
save it explicitly. It reads the clipboard only when you paste into it (Ctrl+V, the start
page's **Paste from clipboard** button or the command palette's paste command), and what it
reads stays on your computer: it is never sent anywhere. To work as a desktop app it keeps a
small amount of information locally, on your machine only:

- **Preferences** such as text size, font, theme and panel layout, stored in the app's local
  storage.
- **Recent documents, reading positions and recovery drafts**: the files you opened lately,
  where you stopped reading in each, and a copy of edits not saved yet (text pasted from the
  clipboard and then changed included), so that they can be restored if the app closes
  unexpectedly. A draft is deleted once its edits are saved or discarded. All of this is kept in
  the app's local storage too.
- **Window size and position**, restored on the next launch.
- **Windows Recent items and the taskbar jump list**, which Windows maintains for the files you
  open so that you can reopen them quickly. These are standard Windows features that you can
  clear from Windows itself.

None of this information leaves your computer, and uninstalling Leggimi removes the app's own
data.

## Links

When you click a web link inside a document, or a link in the app's help dialog, Leggimi asks
Windows to open it in your default browser. From that point on the browser's and the website's
own privacy policies apply.

## Children

Leggimi does not collect data from anyone, including children.

## Changes to this policy

If a future version of Leggimi ever changes any of the above, this page and the app's
changelog will say so before the change ships.

## Contact

Questions about this policy can be raised on the project's GitHub repository:
<https://github.com/enricodestefanis/leggimi/issues>.
