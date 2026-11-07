import assert from "node:assert/strict";
import test from "node:test";
import { isHandOff, isUploadScript, parsePs, uploadsToStop } from "../src/uploads.js";

test("the release script is told from the shell wrapping it", () => {
  assert.equal(isUploadScript("/bin/bash ./scripts/testflight.sh"), true);
  assert.equal(isUploadScript("/bin/bash /Users/p/dev/vibemachine/ios/scripts/testflight.sh"), true);
  assert.equal(isUploadScript("./scripts/testflight.sh"), true);
  assert.equal(isUploadScript("/bin/zsh -c cd ios && ./scripts/testflight.sh > /tmp/log 2>&1"), false, "the tool's wrapper");
  assert.equal(isUploadScript("/bin/bash ./scripts/adhoc.sh"), false);
  assert.equal(isUploadScript("grep testflight.sh README.md"), false);
});

test("an upload under the session child is found with everything it started, and nothing else", () => {
  const rows = parsePs(`
  100     1 /opt/homebrew/bin/claude -p --input-format stream-json
  200   100 /bin/zsh -c source snap.sh && eval 'cd ios && ./scripts/testflight.sh > /tmp/log 2>&1; tail -3 /tmp/log'
  300   200 /bin/bash ./scripts/testflight.sh
  400   300 xcodebuild -project VibeMachine.xcodeproj archive
  500   400 /usr/bin/swift-frontend -c
  600   100 /bin/zsh -c sleep 5
  700     1 /bin/bash ./scripts/testflight.sh
`);
  const pids = uploadsToStop(rows, 100);
  assert.deepEqual(new Set(pids), new Set([300, 400, 500]));
  assert.equal(pids.at(-1), 300, "the script last, after what it started");
  assert.deepEqual(uploadsToStop(rows, 999), [], "another session's upload (or none) is left alone");
});

test("an upload already handing its build to Apple is left to finish", () => {
  const rows = parsePs(`
  100     1 /opt/homebrew/bin/claude -p
  200   100 /bin/zsh -c cd ios && ./scripts/testflight.sh > /tmp/log 2>&1
  300   200 /bin/bash ./scripts/testflight.sh
  400   300 xcodebuild -exportArchive -archivePath build/TestFlight/VibeMachine-1.xcarchive -exportOptionsPlist build/TestFlight/ExportOptions.plist
`);
  assert.deepEqual(uploadsToStop(rows, 100), []);
  assert.equal(isHandOff("xcodebuild -project VibeMachine.xcodeproj -scheme VibeMachine archive"), false, "the archive is still early");
  assert.equal(isHandOff("/Applications/Xcode-27.1.app/Contents/Developer/usr/bin/xcodebuild -exportArchive -archivePath a"), true);
});
