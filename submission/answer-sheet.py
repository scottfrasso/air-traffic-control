"""Print the form answers from FORM_DRAFT.md as plain text, one "===== Field =====" block per form field, ready to paste.

Usage: python3 -I submission/answer-sheet.py [path/to/FORM_DRAFT.md]
Team fields (names, emails, location) are not printed: they are personal and stay out of the repo.
"""

import re
import sys
from pathlib import Path

draft = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("FORM_DRAFT.md")).read_text()


def block(name: str) -> str:
    m = re.search(rf"<!-- {name}:start -->\n(.*?)\n<!-- {name}:end -->", draft, re.S)
    if not m:
        sys.exit(f"missing block {name}")
    return m.group(1).strip()


fields = [
    ("Project name (160)", re.search(r"## Project name.*?\n\n(.+?)\n", draft, re.S).group(1).strip()),
    ("Project vision (2000)", block("vision")),
    ("How you used Cloudflare (2000)", block("cloudflare")),
    ("Open source repository URL (2048)", "https://github.com/scottfrasso/air-traffic-control"),
    ("Instructions to run your project (4000)", block("instructions")),
]

for label, text in fields:
    limit = int(re.search(r"\((\d+)\)", label).group(1))
    status = "OK" if len(text) <= limit else "OVER LIMIT"
    print(f"===== {label} ({len(text)} chars, {status}) =====\n{text}\n")

if "<PUBLIC_REPLAY_URL>" in draft:
    print("WARNING: <PUBLIC_REPLAY_URL> is still a placeholder in FORM_DRAFT.md", file=sys.stderr)
