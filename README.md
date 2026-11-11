# vibemachine

The daemon for [Vibe Machine](https://getvibemachine.com), an iPhone cockpit
for Claude Code. It runs on your Mac, starts Claude Code sessions when your
phone asks, and streams each one to the app: the replies, the tool calls,
the permission prompts you answer from the phone, the commits and builds,
and screenshots of what changed.

![Vibe Machine on an iPhone Duo: the stream on the left, where Claude waits for permission to run a build command, and a before-and-after of the app on the right](https://getvibemachine.com/img/shots/cockpit-waiting.webp)

Just curious what your Claude Code sessions have cost? This needs no phone
and no setup, and sends nothing anywhere:

```bash
npx vibemachine-daemon stats week    # or today, month, year, all
```

Vibe Machine is independent and is not affiliated with, endorsed by or
sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## What you need

- A Mac with **Node 24 or newer** (`brew install node`, or nodejs.org).
- **Claude Code**, installed and signed in with your own account: run
  `claude` once in a terminal and sign in. The daemon runs that same,
  unmodified `claude`; it never sees, stores or forwards your credentials.
- Your repos in one folder (`~/dev` by default; `PROJECTS_DIR` changes it).
- Optional: **Tailscale** on the Mac and the phone, to reach the Mac away
  from home. Without it the phone finds the Mac on the same Wi-Fi.
- Optional: **Xcode** and a simulator, for before-and-after screenshots of
  the iOS apps you work on.
- Optional: **ffmpeg** (`brew install ffmpeg`), so a video sent from the
  phone, a screen recording say, reaches Claude as sheets of its frames.

## Install

```bash
npm install -g vibemachine-daemon
vibemachine setup
```

`setup` writes your settings to `~/Library/Application Support/VibeMachine/.env`,
installs a LaunchAgent so the daemon starts at login, fronts it with
Tailscale Serve when Tailscale is connected (or serves the Wi-Fi when it
isn't), and prints a QR code. Open Vibe Machine on the phone and scan it, or
point the iPhone's Camera at it.

Tailscale on the Mac but not on the iPhone? A tailnet address is one the
phone can't reach. `setup` notices when no iPhone is on your tailnet and
serves the Wi-Fi as well, with the Wi-Fi address in the code; `vibemachine
setup --wifi` asks for that outright.

```bash
vibemachine doctor      # checks everything the phone needs; each ✗ comes with a fix
vibemachine pair        # a fresh pairing code, if the first one expired
vibemachine update      # the newest release; restarts once no turn is running (--now: at once)
vibemachine uninstall   # removes the LaunchAgent; --purge removes the data too
vibemachine help        # every command, including sessions, stats and allow/deny from the terminal
```

### From source

```bash
git clone https://github.com/pnlazzaro-png/vibemachine-daemon.git
cd vibemachine-daemon
scripts/install-launchd.sh   # npm install, build, then `vibemachine setup`
```

A clone updates itself with `git pull` when you run `bin/vibemachine update`,
and also has `bin/vm`, the same command run from the TypeScript source.
`npm test` runs the tests.

## How it reaches the phone

- **On the same Wi-Fi:** HTTPS on port 3006 at the Mac's Bonjour name
  (`<name>.local`), under a certificate made on your Mac. The QR code
  carries its fingerprint and the app accepts that certificate and no other.
- **Away from home:** your tailnet, through `tailscale serve`.
- Every request after pairing is signed by a key the phone made in its
  Secure Enclave and enrolled with the pairing code. Ten wrong codes from
  one address lock pairing for ten minutes.

The daemon listens on `127.0.0.1:3005` on the Mac itself.

## Pushes

Notifications and the turn's Live Activity need Apple's push service. A
daemon without an APNs key of its own sends them through the Vibe Machine
push relay (`PUSH_RELAY`), which adds Apple's signature and forwards each
one immediately. It keeps nothing and logs nothing about them.
`vibemachine doctor` says which way yours go.

## What it keeps, and where

Everything lives in `~/Library/Application Support/VibeMachine`, readable
only by you: the sessions and their streams (SQLite), screenshots,
attachments sent from the phone, the Mac's keys and the logs. Streaming
fragments go after a day, attachments and crash reports after thirty days,
and logs roll at 10 MB. Screenshots Claude reads are kept as pictures, not
as bytes in the stream, and the database gives its free space back between
turns. The Stats page reads the usage figures in every
Claude Code transcript on the Mac (`~/.claude/projects`), from the terminal,
the desktop app and Vibe Machine alike; those figures stay on the Mac and
the phone.

## Settings

The `.env` file (copied from `.env.example` by `setup`) has comments on
each. The ones people change:

| Setting | What it does |
|---|---|
| `PROJECTS_DIR` | The folder whose repos the phone can start a session in. Sessions can't start anywhere else. |
| `PERMISSION_MODE` | The mode new sessions start in. `default` sends every permission prompt to the phone. |
| `DEFAULT_MODEL` | Empty for Claude Code's own default. |
| `IDLE_MINUTES` | An idle session's process stops after this long; the next prompt resumes it. |
| `LAN`, `LAN_PORT` | The Wi-Fi listener. `setup` turns it on when Tailscale isn't serving, or serves a tailnet with no iPhone on it. |
| `CLAUDE_BIN` | Where `claude` is, if the daemon can't find it. |
| `ANTHROPIC_API_KEY` | Bill sessions to an API key instead of your sign-in. |

## Screenshots of your iOS app

Add a `.vibemachine.json` at a project's root and the daemon installs each
new build in the simulator, opens the screens you name with their launch
arguments, and shows before and after in the app's right pane:

```json
{
  "preview": {
    "simulator": "iPhone 17 Pro",
    "bundle_id": "com.example.app",
    "app": "build/DerivedData/Build/Products/Debug-iphonesimulator/App.app",
    "settle_ms": 3000,
    "screens": [
      { "name": "Home", "args": [] },
      { "name": "Settings", "args": ["-openSettings", "YES"] }
    ],
    "web": "http://localhost:5173"
  }
}
```

`web` shows a live page in the pane instead, or as well.

## Security notes

The daemon runs Claude Code as you, in your repos, with the permission mode
you choose; the phone can switch a session's mode, including to one that
asks for nothing. Anything else running as your user on the Mac could reach
the daemon on loopback and use the `vibemachine` command's own key, the same
way it could run `claude` itself. Pair only phones you own, and forget a
phone you no longer have (Settings in the app, or `vibemachine devices` and
`vibemachine forget <id>`).

Only start sessions in repos you trust. In a terminal, Claude Code asks
whether you trust a folder the first time you open it there. Started from
the phone it runs without a terminal and that question is skipped (its own
help says of this mode: "Only use this in directories you trust"). So a
repo's own Claude Code settings take effect with nobody asked: the hooks in
its `.claude/settings.json` run, and the MCP servers in its `.mcp.json` are
started, as soon as a session begins there, before any prompt reaches the
phone. Its allow rules are the exception: Claude Code ignores them until
you have opened that folder with `claude` in a terminal and accepted the
trust question once, and from then on a command they cover runs without
asking the phone. (Checked with Claude Code 2.1.321.) Read those two files
in a repo you didn't write before you start a session in it.

## Support

https://getvibemachine.com/support, or support@getvibemachine.com. Include
`vibemachine doctor`'s output.

## Licence

MIT. See `LICENSE`.
