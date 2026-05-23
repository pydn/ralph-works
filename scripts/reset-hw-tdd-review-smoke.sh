#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-$HOME/code/hw}"
TARGET_DIR="${2:-$HOME/code/hw-tdd-review-smoke}"
FEATURE="${FEATURE:-hello}"

case "$TARGET_DIR" in
  "$HOME/code/"*|/tmp/*) ;;
  *)
    echo "Refusing to remove target outside ~/code or /tmp: $TARGET_DIR" >&2
    exit 2
    ;;
esac

SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
TARGET_PARENT="$(dirname "$TARGET_DIR")"
mkdir -p "$TARGET_PARENT"
TARGET_DIR="$(cd "$TARGET_PARENT" && pwd)/$(basename "$TARGET_DIR")"

if [[ "$SOURCE_DIR" == "$TARGET_DIR" ]]; then
  echo "Refusing to overwrite source directory: $SOURCE_DIR" >&2
  exit 2
fi

for required in \
  "$SOURCE_DIR/docs/specs/$FEATURE.md" \
  "$SOURCE_DIR/docs/specs/harden-changelog-$FEATURE.md" \
  "$SOURCE_DIR/docs/security/redteam-findings-$FEATURE.md" \
  "$SOURCE_DIR/docs/specs/todo_$FEATURE.md"; do
  if [[ ! -f "$required" ]]; then
    echo "Missing required source artifact: $required" >&2
    exit 1
  fi
done

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR/docs/specs" "$TARGET_DIR/docs/security"

cp "$SOURCE_DIR/docs/specs/$FEATURE.md" "$TARGET_DIR/docs/specs/$FEATURE.md"
cp "$SOURCE_DIR/docs/specs/harden-changelog-$FEATURE.md" "$TARGET_DIR/docs/specs/harden-changelog-$FEATURE.md"
cp "$SOURCE_DIR/docs/security/redteam-findings-$FEATURE.md" "$TARGET_DIR/docs/security/redteam-findings-$FEATURE.md"
cp "$SOURCE_DIR/docs/specs/todo_$FEATURE.md" "$TARGET_DIR/docs/specs/todo_$FEATURE.md"

python3 - "$SOURCE_DIR" "$TARGET_DIR" "$TARGET_DIR/docs/specs/todo_$FEATURE.md" <<'PY'
import pathlib
import re
import sys
from datetime import datetime, timezone

source = sys.argv[1]
target = sys.argv[2]
todo_path = pathlib.Path(sys.argv[3])
timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

for path in pathlib.Path(target).glob("docs/**/*.md"):
    text = path.read_text(encoding="utf-8").replace(source, target)
    path.write_text(text, encoding="utf-8")

text = todo_path.read_text(encoding="utf-8")
text = re.sub(r"(?m)^- Status: .*$", "- Status: pending", text)
text = re.sub(r"(?m)^- Updated: .*$", f"- Updated: {timestamp}", text)
text = re.sub(r"(?m)^- Completed: .*$", "- Completed: none", text)
text = re.sub(r"\n#### TDD Checklist\n[\s\S]*?(?=\n#### (?:TDD Evidence|Notes)|\Z)", "\n", text)
text = re.sub(r"\n#### TDD Evidence\n[\s\S]*?(?=\n#### Notes|\Z)", "\n", text)
text = text.replace("Status: completed", "Status: pending")
todo_path.write_text(text.rstrip() + "\n", encoding="utf-8")
PY

cat <<EOF
Reset smoke-test workspace:
  $TARGET_DIR

Copied planning artifacts from:
  $SOURCE_DIR

Run this in Pi from the target directory:
  cd $TARGET_DIR
  /reload
  /ralph-works start $FEATURE implement,review --yolo

This skips spec/redteam/harden/tasks generation and starts the task selector from:
  docs/specs/todo_$FEATURE.md
EOF
