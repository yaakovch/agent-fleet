"""Drive actual hover/Ctrl-click in the task-owned Code window on reserved 9857."""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

report = Path(sys.argv[1])


def wait(fn, message, seconds=20):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = fn()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError(message)


def command(action, **values):
    ack = report / "command-done.json"
    ack.unlink(missing_ok=True)
    temp = report / "command.new"
    temp.write_text(json.dumps({"action": action, **values}))
    temp.replace(report / "command.json")
    wait(ack.exists, "Code did not acknowledge " + action)


wait((report / "ready.json").exists, "Code review extension did not start")
cases = json.loads((report / "ready.json").read_text())["cases"]
receipts = []
with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9857")
    page = browser.contexts[0].pages[0]
    for fixture in cases:
        command("case", name=fixture["name"])
        for row in range(2):
            page.wait_for_timeout(300)
            point = page.evaluate("""({row,col}) => {
                const s=document.querySelector('.xterm-screen').getBoundingClientRect();
                const cell=document.querySelector('.xterm-helper-textarea').getBoundingClientRect();
                return {x:s.x+(col+.5)*cell.width,y:s.y+(row+.5)*cell.height};
            }""", {"row": row, "col": 9 if row == 0 else 3})
            page.keyboard.down("Control")
            page.mouse.move(point["x"], point["y"])
            page.wait_for_timeout(900)
            assert "Preview file from this managed session" in page.locator("body").inner_text().replace("\u00a0", " "), "Companion hover was not shown"
            page.screenshot(path=str(report / f"{fixture['name']}-hover-{row}.png"))
            page.mouse.click(point["x"], point["y"])
            page.keyboard.up("Control")

            def rendered():
                for frame in page.frames:
                    try:
                        content = frame.locator("#content")
                        if content.count() and fixture["body"] in content.inner_text():
                            return frame
                    except Exception:
                        pass
                return None

            frame = wait(rendered, "Full host file was not displayed after actual Ctrl-click")
            assert "origin-host" in frame.locator("#title").inner_text()
            page.screenshot(path=str(report / f"{fixture['name']}-preview-{row}.png"))
            receipts.append({"case": fixture["name"], "row": row, "target": fixture["target"], "host": "origin-host", "project": "/verified-project", "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "interaction": "mouse hover and Control-click", "displayed": fixture["body"]})
            command("close")
    (report / "ui-receipt.json").write_text(json.dumps({"status": "passed", "steps": receipts, "limitations": ["Actual Code UI, asynchronous production provider, and production preview; deterministic lookup/host fixture."]}, indent=2) + "\n")
    command("done")
print(json.dumps({"status": "passed", "actualCtrlClicks": len(receipts), "report": str(report)}))
