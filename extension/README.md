# Page Shooter

Arm a pistol, an AK, a sawn-off or an RPG-7 and shoot the text off any web page.
A Chrome extension port of the gun tool from the nico.ac sandbox.

## Build

```
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and pick the `dist/` folder.

## Packaging for the Chrome Web Store

The store wants a zip whose *root* is `manifest.json`, so zip the contents of
`dist`, not the folder itself. `dist` is flat, so PowerShell's `Compress-Archive`
is safe here — its backslash-separator bug only affects nested directories.

```powershell
npm run build
Compress-Archive -Path "dist\*" -DestinationPath "page-shooter.zip" -Force
```

Bump `version` in `manifest.json` before every upload; the store rejects a
re-upload of an existing version number.

## Use

Click the toolbar icon to arm on the current tab. Click again to holster, or
press `Escape`. Left click shoots: characters inside the blast radius are cut
out of the page and dropped into a physics world, and shots also shove debris
that has already piled up.

**Right click anywhere** racks the next weapon:

| Weapon | Behaviour |
| --- | --- |
| Pistol | One shot per click. |
| AK | Full auto for as long as the button is held. |
| Sawn-off | Thirteen pellets laid out on a sunflower spiral, so the pattern covers the cone evenly instead of clumping. |
| RPG-7 | Fires the round loaded in the tube, which flies to the cursor and goes off there over a much wider radius, leaving a scorch rather than a bullet hole. It cannot fire again until a fresh round has finished loading. |

## How it differs from the site version

- **Nothing is split until a shot lands.** The site wraps every character on the
  page in a span up front, which is fine for 2,400 characters and fatal for
  100,000. Here `elementsFromPoint` samples the blast area, characters are
  measured with a `Range`, and only the ones actually hit get cut out.
- **Debris is drawn to a canvas**, not a DOM node per letter, so a busy page is
  not asked to carry hundreds of extra elements with per-frame transforms.
- **Everything lives in a shadow root** on `<html>`, so the host page's CSS
  cannot reach the overlay and the overlay's CSS cannot leak into the page.
- **`activeTab` only.** Nothing is injected anywhere until you click the icon on
  a specific tab, so there is no host permission prompt at install time.
- **The models ship in the package** and are reached through
  `chrome.runtime.getURL`, rather than being served from the site's `/models`.
- **No beach balls or spray paint.** Only the gun tool was ported; the rest of
  the sandbox stays on the site.

## Known limits

- Single-page apps re-render from their own state and will paint shot text back.
- Iframes are separate documents; each gets its own physics world.
- Closed shadow roots are invisible to the text walk, so web components using
  them are not shootable.
- Text only for now. Images and videos would work as whole rigid bodies via the
  same mechanism, but the debris renderer only paints glyphs today.
