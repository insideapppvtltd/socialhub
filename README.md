# Social Hub

Social Hub is an Electron desktop shell for using independent web app and website accounts. Choose from the built-in app catalog or add any HTTPS website. Each account receives a permanent UUID and its own persistent Chromium storage partition (`persist:account-<uuid>`). Hub does not automate, scrape, or send messages.

## Requirements

- Node.js 22.12 or newer and npm
- Windows 10+ or macOS 12+
- A working internet connection; selected websites and accounts are provided by their respective services

## Setup and run

```sh
npm install
npm run dev
```

On first launch, Hub creates a Personal WhatsApp account. Select **Add an account** to choose an app or add a custom HTTPS website, then sign in. The catalog includes 60+ services across messaging and social, email and meetings, marketing and analytics, CRM and customer support, productivity and collaboration, design and websites, commerce and payments, and developer tools. Sessions persist independently across app restarts. Right-click an account to rename, mute, reload, clear only its cache, or permanently remove its session data.

### Firebase Google sign-in

The optional Firebase Authentication integration signs users in with Google. It does not sync account data or use Firestore.

1. Copy `.env.example` to `.env.local`.
2. The Firebase Web app configuration for `social-hub-32839` is already filled in in `.env.example`.
3. In Google Cloud Console, create an OAuth 2.0 client ID of type **Desktop app** and set `VITE_GOOGLE_OAUTH_CLIENT_ID` in `.env.local`. The app uses the system browser and PKCE; do not add a client secret.
4. Run `npm run dev`. The sidebar's Google sign-in button signs in to Firebase; signing out is available in the same place.

Keep `.env.local` out of version control. The Firebase client configuration and OAuth client ID are public client identifiers; never put service-account keys or other private credentials in the desktop app.

## Build and package

```sh
npm run build
npm run dist:win
npm run dist:mac
```

Windows creates an x64 NSIS installer. macOS creates a universal (arm64 + x64) DMG. Build each platform on its matching operating system for the most reliable native packaging.

### Signing and notarization

For Windows distribution, configure a trusted code-signing certificate with electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables. For macOS, configure `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` (or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`) before packaging. The macOS app is configured for hardened runtime and uses `resources/entitlements.mac.plist`. Apple notarization also requires valid developer credentials and a network connection; verify the final DMG with Gatekeeper on a clean Mac.

Camera and microphone usage descriptions are included in the generated Info.plist. Website permissions are limited to the configured site origin. macOS screen-recording consent is controlled by macOS on first capture; users may need to enable Social Hub in **System Settings → Privacy & Security → Screen Recording**, then restart the app.

### Auto-updates

Packaged builds use `electron-updater` with the `insideapppvtltd/socialhub` GitHub repository. Publish versioned GitHub releases with the generated update metadata to make updates available. Updates are checked only for packaged builds.

## Behaviors and permissions

- Account views stay alive when switched out, allowing websites to keep receiving updates.
- Web notifications use Chromium's native OS notification support; clicking one opens the app on that account. Account mute and Do Not Disturb suppress notification permission for that account.
- Downloads go to the system Downloads folder. Click a download notification to reveal the file.
- Closing to tray and launch-at-startup preferences are available in the sidebar. Ctrl/Cmd+1..9 switches accounts, Ctrl/Cmd+R reloads the focused account, and Ctrl/Cmd+N adds an account.
- Media, notifications, clipboard, fullscreen, and display-capture permissions are limited to each account's configured site origin. Screen sharing presents a native source picker. Feature availability depends on the selected website.

## Manual test checklist

- [ ] Add an app-catalog account and a custom HTTPS website; confirm each gets a separate login session.
- [ ] Restart Hub and confirm both sessions remain logged in without scanning again.
- [ ] Remove one account and confirm the other account remains logged in and usable.
- [ ] Trigger a notification on a supported website; confirm it appears natively, opens the correct account when clicked, and is suppressed by mute and Do Not Disturb.
- [ ] Download a file from a website; confirm it is saved in Downloads and its notification reveals it.
- [ ] Test microphone and camera access on a supported website.
- [ ] Test screen sharing and choose both a screen and a window in the source picker.
- [ ] Verify account switching, reload, tray menu, close-to-tray, unread badges, and light/dark system themes.
