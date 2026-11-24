# GazeCast

**Control your Android phone with your eyes, from a Windows tablet.** Big dwell-click buttons, a live phone picture, every app one look away. Free, runs only on your own computer.

[**Watch the 20-second demo**](docs/gazecast-demo.mp4)

**Download:** press the green **Code** button above, then **Download ZIP**. Unzip it, then double-click **Install-GazeCast.bat** to put GazeCast on your desktop. (Needs Windows 10 or 11, a Google Pixel and a USB cable for the first connection.)

GazeCast puts your Google Pixel on your Surface Pro screen, in landscape, with very large buttons around it. It is made for eye-gaze control: look at a button, a ring fills, and the button is pressed. A mouse, touch or a Tobii click works too.

Everything runs on your own computer. Nothing is sent to the internet and the page can only be opened from this Surface.

---

## 1. Install (once)

1. Copy the whole GazeCast folder onto the Surface (for example into Documents).
2. Double-click **start.bat**.
3. The first time, it downloads three free tools into the `tools` folder (about 60 MB, needs the internet once):
   - **scrcpy** – the open-source phone mirroring engine (from github.com/Genymobile/scrcpy)
   - **Android platform-tools (adb)** – Google's tool for talking to the phone (from dl.google.com)
   - **Node.js** – runs the small helper program (from nodejs.org; skipped if you already have it)

   Each download is checked (checksum or Google's digital signature) before it is used.
4. GazeCast opens full screen in Chrome (or Edge if Chrome is not installed).

If Windows shows a blue "Windows protected your PC" box for start.bat, choose **More info → Run anyway**.

To run the downloads by hand: right-click `setup.ps1` → **Run with PowerShell**.

**Just want to look around?** Double-click **start-demo.bat**. It shows a pretend phone so you can try every button safely.

---

## 2. Get the phone ready (once)

GazeCast shows this as a step-by-step guide the first time. In short, on the Pixel:

1. **Settings → About phone**. Tap **Build number** seven times. Enter the PIN. It says "You are now a developer".
2. **Settings → System → Developer options**.
3. Switch on **USB debugging**.
4. Switch on **Wireless debugging** (the phone must be on Wi-Fi).

## 3. Connect

Choose one on the connection screen. GazeCast remembers the phone and reconnects by itself afterwards.

### USB cable (simplest)
Plug the phone in. Unlock it. When it asks **Allow USB debugging?**, tick **Always allow from this computer** and tap **Allow**. Done.

### Home Wi-Fi (no cable)
1. On the phone: **Developer options → Wireless debugging → Pair device with pairing code**.
2. The phone shows a six-digit code and an address such as `192.168.1.23:37251`.
3. In GazeCast choose **Home Wi-Fi**, enter the address, the port (the number after the colon) and the code using the big number pad. Press **Pair and connect**.
4. If it then asks for a port, use the one shown under **IP address & Port** on the Wireless debugging screen (it is a different number).

Tip: for a rock-solid wireless link, plug in the cable once, open **USB cable** and press **Also set up cable-free use**. The phone then listens on a fixed port (5555) until it is restarted.

### Phone hotspot (away from home)
Wireless debugging normally switches off while the phone is a hotspot, so there is a one-time cable step:
1. Plug the phone in. Choose **Phone hotspot → Prepare phone**.
2. Unplug. Turn on the phone's **Hotspot**. On the Surface, join that hotspot in the Wi-Fi list.
3. Press **Connect over hotspot**.

After the phone is restarted, do step 1 again.

**Warning shown by GazeCast:** when you are linked through the hotspot (or Wi-Fi) and open the Hotspot (or Wi-Fi) settings tile, GazeCast asks first, because switching it off cuts the link and someone must turn it back on at the phone.

---

## 4. Daily use

| Area | What it does |
|---|---|
| **Phone picture** | Click or dwell = tap. Click and drag = swipe. Mouse wheel = scroll. |
| **Arrows** (blue) | **Swipe mode**: scroll and change pages. **D-pad mode**: move the highlight; OK selects. The top-left button switches mode. One look = one step; look away and back for the next. |
| **Phone buttons** (teal) | Back, Home, Recents, Alerts (notifications), Quick settings, Volume, Mute, Wake, Power. |
| **Pause gaze** (pink) | Freezes every button so you can watch something without pressing anything. Look at **Resume** (a longer look) to carry on. |
| **Zoom** (pink) | Look at a spot to zoom in. Arrows move the view, plus and minus change the zoom. Press **Done** and taps work on the enlarged picture. |
| **Top menu** | Opens when you look at it: **Apps**, **Phone settings**, **Keyboard**, **Connection**, **Options**. |

- **Apps**: every app on the phone as big tiles. Search by typing, pin favourites with **Edit favourites**.
- **Phone settings**: Settings, Wi-Fi, Bluetooth, Hotspot, Cast, Display, Sound, Accessibility, Battery, Quick settings, Notifications, and the Auto-rotate / Landscape lock switch.
- **Keyboard**: a large on-screen keyboard that types on the phone. A real keyboard works too (Esc = Back, Ctrl+V pastes).
- **Options**: dwell time, button size, dark/light theme, swap sides, layout, sounds, picture quality and more. Saved automatically.
- **Mute** only silences the Surface. Phone sound plays on the Surface while GazeCast is running.

### How dwell works: one look, one press

Look at a button and a ring runs round its edge. When the ring is full the button is pressed **once**, the ring closes, and nothing more happens while you keep looking at it.

To press the same button again, **look away and then look back**. A small wobble of the eyes does not count, even if it crosses the edge of the button for a moment; you need to be clearly off the button (about a finger-width away, or off it for a third of a second). The same goes for the phone picture: one look taps a spot once, and you tap again by looking somewhere else first.

Anything that appears under your gaze (a panel opening, a keyboard page changing) also waits until you have looked away, so a single look can never press two things.

If you would rather have the arrows and volume keep stepping while you hold your gaze on them, switch on **Options → Hold to repeat**. It is off by default.

A real mouse click or touch always works straight away.

### Window buttons (top-right corner)

Three buttons are always visible in the top-right corner, on every screen and above every panel:

| Button | What it does |
|---|---|
| **Minimise** (dash) | Hides GazeCast to the taskbar. |
| **Restore / Full screen** (squares) | Switches between full screen and an ordinary window. |
| **Close** (red X) | Asks "Close GazeCast?" first. **Stay** is the safe, highlighted choice; **Close** stops GazeCast and closes the window. |

**Coming back after Minimise:** a minimised window cannot be looked at, so use Windows to bring it back: select the **GazeCast icon on the taskbar** (with your eye-gaze software's taskbar or mouse mode, or Windows Eye Control), or press **Alt+Tab** on a keyboard. GazeCast returns exactly as you left it and the phone stays connected meanwhile.

The window buttons rest while **Pause gaze** is on, like every other button.

Keyboard equivalents: **F11** full screen on/off, **Alt+F4** close. If you started GazeCast with `--kiosk`, Restore cannot leave kiosk mode; use Close.

GazeCast locks the phone to landscape and keeps the screen awake while charging. To give the phone back its normal behaviour, choose **Phone settings → Auto-rotate** before closing.

---

## 5. Troubleshooting

| Problem | Try this |
|---|---|
| "Looking for your phone" never ends | Cable: unlock the phone and tap **Allow**. Try another cable (some only charge). Wi-Fi: both devices on the same network? Wireless debugging still on? |
| "Phone found. Tap Allow on it" | Unlock the phone and tap **Allow** on the message. |
| Picture says "Snapshot mode" | Live video failed three times, so GazeCast is showing slow still pictures. Open **Connection**, disconnect and reconnect, or restart GazeCast. Sound is not available in this mode. |
| No sound | Click once anywhere with a real mouse click (browsers need this once). Check **Options → Phone sound on this computer** and the **Mute** button. Needs Android 11 or newer. |
| Wireless stopped after phone restart | The Wireless debugging port changes. Pair again, or use the cable once and **Also set up cable-free use**. |
| Some apps stay sideways or look squeezed | Turn off **Options → Keep every app in landscape**. |
| Buttons press by themselves | Raise **Options → Dwell time**, or use **Pause gaze** while reading. If your eye tracker already clicks for you, turn **Dwell click** off. |
| A button keeps pressing again and again | Check **Options → Hold to repeat** is off. With it off, each look presses once. |
| A button will not press a second time | Look clearly away from it, then back. |
| Window buttons say the window could not be found | They need GazeCast to be started with start.bat (Chrome or Edge). Use F11 and Alt+F4 instead. |
| Minimised and cannot get back | Choose the GazeCast icon on the Windows taskbar, or press Alt+Tab. |
| "GazeCast has stopped" | The helper window was closed. Double-click start.bat again. |
| Not full screen | Press **F11**. |
| Start over | Delete the `data` folder (settings, saved phones) and start again. |

Manual fallback: `tools\scrcpy\scrcpy.exe` is the ordinary scrcpy program and can mirror the phone in its own window if GazeCast ever fails.

---

## 6. How it works (for the curious)

```
Pixel  <--adb (USB or Wi-Fi)-->  bridge (Node.js, 127.0.0.1 only)  <--WebSocket-->  page in Chrome
 scrcpy-server                    relays H.264 + Opus, sends input                  WebCodecs + canvas
```

- **Video**: the bridge pushes `scrcpy-server` (v5.0.1) to the phone and starts it with `adb shell app_process`. The phone encodes its screen as **H.264**; the bridge reads it through an `adb forward` socket and relays each packet over a local WebSocket. Chrome decodes it with **WebCodecs `VideoDecoder`** and draws to a canvas. This is real-time hardware-encoded video, the same engine scrcpy itself uses, with no re-encoding on the Surface.
- **Audio**: scrcpy's audio forwarding (**Opus**, Android 11+) is relayed the same way, decoded with `AudioDecoder` and played with Web Audio using a small buffer to keep delay low.
- **Control**: taps, swipes, keys, text and the notification/quick-settings panels go through scrcpy's low-latency **control socket**. Non-English text is pasted through the clipboard. If the control socket is unavailable, the bridge falls back to `adb shell input ...` and `cmd statusbar ...`.
- **Fallback video**: if live video cannot start three times in a row, the bridge polls `adb exec-out screencap -p` and shows PNG snapshots (slow, no sound, but dependable).
- **Apps**: package/activity list from `cmd package query-activities`, real app names from scrcpy-server's app list. Launched with `am start -n` (falls back to `monkey`). App icons are coloured letter tiles; pulling real icons would need each APK to be copied and unpacked, which is slow over Wi-Fi.
- **Phone settings applied on connect**: `accelerometer_rotation 0`, `user_rotation 1`, `wm set-ignore-orientation-request true` (optional), `stay_on_while_plugged_in 7`.
- **Security**: the bridge listens on 127.0.0.1 only, rejects requests with a foreign Host or Origin header, runs adb with argument lists (no Windows shell), validates addresses and package names, and quotes anything that reaches the phone shell. No passwords or pairing codes are stored; only the phone's address and name are saved in `data\config.json`.
- **No npm packages**: the WebSocket server is a small built-in file, so there is nothing else to install.

### Folder layout
```
start.bat / start-demo.bat   double-click launchers
setup.ps1                    downloads and verifies the tools
bridge\                      server.js, phone.js, scrcpy.js, adb.js, demo.js, ws.js, window.js + window.ps1 (window buttons)
web\                         index.html, css\app.css, js\ (app, gaze, player, demo, net, icons)
tools\                       scrcpy, platform-tools, node (created by setup.ps1)
data\                        settings, saved phones, app list cache, browser profile (created on first run)
```

### Command line
```
tools\node\node.exe bridge\server.js [--demo] [--open] [--kiosk] [--windowed] [--port 8765]
```
The demo runs on port 8766 and keeps its own settings. `http://127.0.0.1:PORT/api/log` shows the list of commands sent to the phone.

### Credits
scrcpy by Genymobile (Apache 2.0). Android platform-tools by Google. Manrope typeface by Mikhail Sharanda (OFL), loaded from Google Fonts with a system-font fallback when offline.

## Install on the desktop
1. Double-click **Install-GazeCast.bat**.
2. Wait for "Done. GazeCast is on your desktop."
3. From now on, double-click the **GazeCast** icon on the desktop (it is also in the Start menu).

To remove the shortcuts, double-click **Uninstall-GazeCast.bat**. It does not delete your files or phone settings.
